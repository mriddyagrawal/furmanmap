/* Furman Wayfinder — outdoor walking routes over OpenStreetMap data.
 *
 * Everything runs in the browser. The basemap streams from OpenFreeMap's tile
 * servers; the campus layer is the static GeoJSON in data/, built by the
 * scripts in scripts/. There is no backend.
 */

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const CENTER = [-82.4392, 34.9245];
const WALK_M_PER_MIN = 80;          // field-validate this; Furman has hills

/* ---------- app ---------- */

const state = { from: null, to: null, graph: null, entrancesFor: new Map() };
const $ = id => document.getElementById(id);

async function main() {
  const [buildings, paths, entrances, boundary] = await Promise.all(
    ['buildings', 'paths', 'entrances', 'boundary']
      .map(n => fetch(`data/${n}.geojson`).then(r => r.json()))
  );

  const campus = f => f.properties.on_campus;
  const named = buildings.features.filter(f => campus(f) && f.properties.name);
  const walk = paths.features.filter(f => campus(f) && f.properties.walkable);

  state.graph = buildGraph(walk);

  // A door is worth routing to; a building's geometric middle usually isn't.
  for (const b of named) {
    const ring = ringOf(b.geometry);
    const doors = entrances.features
      .filter(e => inRing(ring, e.geometry.coordinates))
      .map(e => e.geometry.coordinates);
    state.entrancesFor.set(b.id, doors);
  }

  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: CENTER, zoom: 15.4,
    hash: true                      // URL keeps the view, so links are shareable
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true }, trackUserLocation: true
  }), 'bottom-right');

  map.on('load', () => {
    map.addSource('boundary', { type: 'geojson', data: boundary });
    map.addSource('buildings', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: buildings.features.filter(campus) }
    });
    map.addSource('route', { type: 'geojson', data: empty() });
    map.addSource('leader', { type: 'geojson', data: empty() });

    map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
      paint: { 'line-color': '#582C83', 'line-width': 1.5, 'line-opacity': .35,
               'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'building-fill', type: 'fill', source: 'buildings',
      paint: { 'fill-color': '#582C83',
               'fill-opacity': ['case', ['boolean', ['feature-state', 'active'], false], .55,
                                ['has', 'name'], .28, .12] } });
    map.addLayer({ id: 'building-line', type: 'line', source: 'buildings',
      paint: { 'line-color': '#582C83', 'line-width': .8, 'line-opacity': .5 } });
    map.addLayer({ id: 'building-label', type: 'symbol', source: 'buildings',
      filter: ['has', 'name'], minzoom: 15.5,
      layout: { 'text-field': ['get', 'name'], 'text-size': 11,
                'text-font': ['Noto Sans Regular'], 'text-max-width': 8,
                'text-allow-overlap': false },
      paint: { 'text-color': '#3d1d5c', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });

    map.addLayer({ id: 'leader-line', type: 'line', source: 'leader',
      paint: { 'line-color': '#582C83', 'line-width': 2.5, 'line-dasharray': [1, 1.6],
               'line-opacity': .8 } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': .9 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#582C83', 'line-width': 5 } });

    map.on('click', 'building-fill', e => {
      const f = named.find(b => b.id === e.features[0].id) ||
                buildings.features.find(b => b.id === e.features[0].id);
      if (f && f.properties.name) pick(f);
    });
    map.on('mouseenter', 'building-fill', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'building-fill', () => map.getCanvas().style.cursor = '');

    $('hint').textContent =
      `${named.length} buildings · ${(state.graph.size).toLocaleString()} path nodes ready`;
  });

  state.map = map;
  wireSearch(named);
  wireControls();
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

/* Snap a building to the graph: its mapped door if there is one, else the
   nearest node to its centroid. Returns the node plus the real-world point so
   the last few metres can be drawn as a dashed leader. */
function snap(feature) {
  const doors = state.entrancesFor.get(feature.id) || [];
  const target = doors.length ? doors[0] : centroid(feature.geometry);
  return { node: nearestNode(target), point: target };
}

function nearestNode(pt) {
  let best = null, bd = Infinity;
  for (const [id, c] of state.graph.coord) {
    const d = metres(pt, c);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

function pick(feature) {
  if (state.to && state.to.id !== feature.id) state.from = state.to;
  state.to = feature;
  draw();
}

function draw() {
  const map = state.map;
  const label = f => f ? (f.name || f.properties.name) : '—';
  $('from').textContent = label(state.from);
  $('to').textContent = label(state.to);
  $('route').hidden = !(state.from && state.to);
  if (!(state.from && state.to)) return;

  const a = state.from.geometry ? snap(state.from)
                                : { node: nearestNode(state.from.point), point: state.from.point };
  const b = snap(state.to);
  const avoid = $('stepfree').checked;
  const r = aStar(state.graph, a.node, b.node, avoid);

  if (!r) {
    $('mins').textContent = '—';
    $('dist').innerHTML = '<span class="warn">No walking route found.</span>';
    map.getSource('route').setData(empty());
    map.getSource('leader').setData(empty());
    return;
  }

  const mins = Math.max(1, Math.round(r.metres / WALK_M_PER_MIN));
  $('mins').textContent = `${mins} min`;
  $('dist').textContent = `${Math.round(r.metres)} m` +
    (avoid && r.usesSteps ? ' · no step-free route available' : '');

  map.getSource('route').setData({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: r.line }
  });
  map.getSource('leader').setData({
    type: 'FeatureCollection', features: [
      leg(a.point, r.line[0]), leg(r.line[r.line.length - 1], b.point)
    ]
  });

  const bounds = r.line.concat([a.point, b.point])
    .reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(a.point, a.point));
  map.fitBounds(bounds, { padding: { top: 180, bottom: 60, left: 60, right: 60 }, maxZoom: 18 });
}

const leg = (p, q) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'LineString', coordinates: [p, q] }
});

function wireSearch(named) {
  const fuse = new Fuse(named, {
    keys: ['properties.name', 'properties.alt_name', 'properties.short_name'],
    threshold: .4, ignoreLocation: true
  });
  const q = $('q'), list = $('results');

  q.addEventListener('input', () => {
    const term = q.value.trim();
    if (!term) { list.hidden = true; list.innerHTML = ''; return; }
    const hits = fuse.search(term, { limit: 7 });
    list.innerHTML = hits.map(h => {
      const p = h.item.properties;
      return `<li role="option" data-id="${h.item.id}">${p.name}
        <div class="kind">${p.building && p.building !== 'yes' ? p.building.replace(/_/g, ' ') : 'building'}</div></li>`;
    }).join('');
    list.hidden = !hits.length;
    list.querySelectorAll('li').forEach(li => li.onclick = () => {
      pick(named.find(f => f.id === li.dataset.id));
      q.value = ''; list.hidden = true;
    });
  });
}

function wireControls() {
  $('stepfree').onchange = draw;
  $('clear').onclick = () => {
    state.from = state.to = null;
    $('route').hidden = true;
    state.map.getSource('route').setData(empty());
    state.map.getSource('leader').setData(empty());
  };
  $('locate').onclick = () => {
    if (!navigator.geolocation) return;
    $('hint').textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(pos => {
      state.from = { name: 'My location', point: [pos.coords.longitude, pos.coords.latitude] };
      $('hint').textContent = '';
      draw();
    }, () => { $('hint').innerHTML = '<span class="warn">Location unavailable.</span>'; },
       { enableHighAccuracy: true, timeout: 8000 });
  };
}

main().catch(e => {
  $('hint').innerHTML = '<span class="warn">Could not load campus data.</span>';
  console.error(e);
});
