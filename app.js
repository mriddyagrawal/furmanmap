/* Furman Wayfinder — outdoor walking routes over OpenStreetMap data.
 *
 * Everything runs in the browser. The basemap streams from OpenFreeMap's tile
 * servers; the campus layer is the static GeoJSON in data/, built by the
 * scripts in scripts/. There is no backend.
 */

// Bumped whenever something user-visible changes. GitHub Pages caches for ten
// minutes, so "it is not there" and "you are looking at an old copy" are easy
// to confuse — this makes the running version checkable at a glance.
const BUILD = '2026-08-24 · fast-fix';

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
  state.nodeIndex = turf.featureCollection(
    [...state.graph.coord].map(([id, c]) => turf.point(c, { id }))
  );

  // A door is worth routing to; a building's geometric middle usually isn't.
  for (const b of named) {
    const ring = ringOf(b.geometry);
    const doors = entrances.features
      .filter(e => inRing(ring, e.geometry.coordinates))
      .map(e => ({ at: e.geometry.coordinates, kind: e.properties.entrance }));
    state.entrancesFor.set(b.id, doors);
  }

  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: CENTER, zoom: 15.4,
    hash: true                      // URL keeps the view, so links are shareable
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  // One source of location for the whole app. The panel's button triggers this
  // control rather than calling navigator.geolocation separately, so the blue
  // dot and the route origin can never disagree about where you are.
  state.geo = new maplibregl.GeolocateControl({
    positionOptions: {
      // enableHighAccuracy forces the GPS chip instead of fast wifi/cell
      // triangulation — right for walking, but slow to a first fix.
      enableHighAccuracy: true,
      // These two are the reason the dot took seconds to appear. Passing
      // positionOptions replaces MapLibre's defaults wholesale rather than
      // merging, so omitting them left maximumAge at the browser default of 0
      // — "reject any cached position" — which forces a cold GPS fix every
      // time. Accepting a fix up to 20s old shows the dot immediately; the
      // watch then refines it within a second or two.
      maximumAge: 20000,
      timeout: 12000
    },
    trackUserLocation: true, showUserLocation: true, showAccuracyCircle: true
  });
  map.addControl(state.geo, 'bottom-right');
  // GeolocateControl.trigger() is a TOGGLE: calling it while tracking is
  // already active switches it OFF, clearing the watch and the blue dot. Track
  // the real state so we only ever turn it on.
  state.geo.on('trackuserlocationstart', () => { state.tracking = true; });
  state.geo.on('trackuserlocationend', () => { state.tracking = false; });

  state.geo.on('geolocate', pos => {
    state.here = [pos.coords.longitude, pos.coords.latitude];
    // trackUserLocation fires this on every GPS update, not just when asked.
    // Only adopt it as the route origin if the user actually requested that,
    // or a position tick a second later silently overwrites a chosen A -> B.
    if (state.navigating) return navUpdate(state.here, pos.coords.heading);
    if (!state.followMe) return;
    state.from = { name: 'My location', point: state.here };
    hint('');
    draw();
  });
  state.geo.on('error', err => {
    hint(err && err.code === 1
      ? 'Location permission denied — allow it in your browser’s site settings.'
      : 'Location unavailable. On a phone this needs HTTPS, not a plain http:// address.',
      true);
  });

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

    hint(`Tap a building, then another, to route.`);
    $('build').textContent = BUILD;
    $('build').title = `${named.length} buildings · `
      + `${state.graph.size.toLocaleString()} path nodes`;
    console.info(`Furman Wayfinder build ${BUILD}`);
  });

  state.map = map;
  wireSearch(named);
  wireControls();
  setEditing('to');
  $('start').disabled = true;
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

function hint(text, warn) {
  $('hint').innerHTML = warn ? `<span class="warn">${text}</span>` : text;
}

/* Snap a building to the graph: its mapped doors if it has any, else the nearest
   node to its centroid. Returns candidate {node, point} pairs — routing picks
   between them, because a building with four entrances has four answers and the
   right one depends on where you are coming from. */
function snapCandidates(feature) {
  const doors = (state.entrancesFor.get(feature.id) || [])
    // Service and emergency doors are mapped but not usable as a destination.
    .filter(d => !['service', 'emergency'].includes(d.kind));
  const pts = doors.length ? doors.map(d => d.at) : [centroid(feature.geometry)];
  return pts.map(p => ({ node: nearestNode(p), point: p }));
}

// Turf's nearestPoint over a collection built once at load, rather than a
// linear scan written by hand each time.
function nearestNode(pt) {
  const hit = turf.nearestPoint(turf.point(pt), state.nodeIndex);
  return hit.properties.id;
}

/* Tapping buildings on the map chains: the previous destination becomes the
   start. Searching does NOT chain — it fills whichever end you are editing,
   which is what every map app does and what the chips above make visible. */
function pick(feature) {
  if (state.to && state.to.id !== feature.id) {
    state.from = state.to;
    state.followMe = false;      // an explicit origin wins over GPS tracking
  }
  state.to = feature;
  draw();
}

function setDestination(feature) {
  state.to = feature;
  // A destination with no start is half a question. Default to where you are.
  if (!state.from && state.here) {
    state.from = { name: 'My location', point: state.here };
    state.followMe = true;
  }
  draw();
}

function setEditing(which) {
  state.editing = which;
  for (const id of ['from', 'to']) $(id).dataset.editing = String(id === which);
  $('q').placeholder = which === 'from' ? 'Search a starting point…'
                                        : 'Search a building…';
}

/* Let the user say "start here" for the currently selected building, so an
   A -> B route does not depend on remembering to tap in the right order. */
function setOrigin(feature) {
  state.from = feature;
  state.followMe = false;
  draw();
}

function draw() {
  const map = state.map;
  const label = f => f ? (f.name || f.properties.name) : '—';
  $('from').textContent = label(state.from);
  $('to').textContent = label(state.to);
  // Show the panel as soon as either end exists, so the chips are reachable
  // while the route is still half-specified.
  $('route').hidden = !(state.from || state.to);
  $('eta-row').hidden = !(state.from && state.to);
  $('stepfree-row').hidden = !(state.from && state.to);
  if (!(state.from && state.to)) {
    // Half a route is still progress — say what is missing instead of nothing.
    if (state.from) hint(`From ${label(state.from)} — now pick a destination.`);
    else if (state.to) hint(`To ${label(state.to)} — tap another building, or ◎ for your location.`);
    return;
  }
  hint('');

  const froms = state.from.geometry ? snapCandidates(state.from)
    : [{ node: nearestNode(state.from.point), point: state.from.point }];
  const tos = snapCandidates(state.to);
  const avoid = $('stepfree').checked;

  // Try every door pair and keep the shortest. A route costs well under a
  // millisecond, so exhaustive beats guessing which entrance you want.
  let a = froms[0], b = tos[0], r = null;
  for (const f of froms) for (const t of tos) {
    const cand = aStar(state.graph, f.node, t.node, avoid);
    if (cand && (!r || cand.metres < r.metres)) { r = cand; a = f; b = t; }
  }

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

  state.route = {
    line: turf.lineString(r.line),
    total: r.metres,
    to: label(state.to)
  };
  $('start').disabled = false;
  map.getSource('route').setData(state.route.line);
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
      const f = named.find(x => x.id === li.dataset.id);
      if (state.editing === 'from') setOrigin(f); else setDestination(f);
      q.value = ''; list.hidden = true;
      setEditing('to');
    });
  });
}

/* ---------- compass ---------- */

/* Read the device compass ourselves rather than using maplibre-gl-compass:
 * that package is a map *control* that sets the bearing itself, which would
 * fight the camera during navigation. We need the heading as a value to blend
 * with the route direction, which it does not expose.
 *
 * The messy parts it does handle, and so must we: iOS uses a non-standard
 * webkitCompassHeading and demands permission from a user gesture, Android
 * uses deviceorientationabsolute, and raw readings jitter by several degrees.
 */
function startCompass() {
  if (state.compassOn) return;
  state.compassAsked = true;
  const listen = () => {
    state.compassOn = true;
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
  };
  // iOS 13+ gates the sensor behind an explicit prompt from a user gesture.
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    DOE.requestPermission()
      .then(r => { if (r === 'granted') listen(); })
      .catch(() => {});
  } else if (DOE) {
    listen();
  }
}

function onOrientation(e) {
  let deg = null;
  if (typeof e.webkitCompassHeading === 'number') {
    deg = e.webkitCompassHeading;                 // iOS: already degrees from north
  } else if (e.absolute && typeof e.alpha === 'number') {
    deg = 360 - e.alpha;                          // Android: alpha counts the other way
  }
  if (deg === null || isNaN(deg)) return;
  // Record only. deviceorientation fires ~60x a second; touching the camera
  // here is what made rotation choppy — each easeTo was interrupted by the
  // next one about 6% of the way through. The rAF loop below drives the map.
  state.headingTarget = deg;
  if (state.heading == null) state.heading = deg;
  updateCompassUI();
  startCameraLoop();
}

/* One camera update per display frame, easing toward whatever the sensors last
   reported. jumpTo, not easeTo: we are already interpolating, so a second
   animation on top of it just fights this one. */
function startCameraLoop() {
  if (state.cameraLoop) return;
  const step = () => {
    state.cameraLoop = null;
    let busy = false;

    if (state.headingTarget != null) {
      state.heading = smoothHeading(state.heading, state.headingTarget);
      if (angleGap(state.heading, state.headingTarget) > 0.3) busy = true;
    }

    if (state.navigating && state.following && state.here) {
      const c = state.mapCenter || state.here;
      const k = 0.18;                       // centre catches up over ~10 frames
      state.mapCenter = [c[0] + (state.here[0] - c[0]) * k,
                         c[1] + (state.here[1] - c[1]) * k];
      state.map.jumpTo({
        center: state.mapCenter,
        zoom: 18, pitch: 55,
        bearing: state.heading ?? state.map.getBearing(),
        padding: { top: Math.round(window.innerHeight * 0.45), bottom: 0, left: 0, right: 0 }
      });
      if (metres(state.mapCenter, state.here) > 0.5) busy = true;
    } else if (state.heading != null) {
      updateHeadingMarker();
    }
    updateCompassUI();
    if (busy) startCameraLoop();
  };
  state.cameraLoop = requestAnimationFrame(step);
}

const angleGap = (a, b) => {
  const d = Math.abs((a - b) % 360);
  return d > 180 ? 360 - d : d;
};

/* A cone on the blue dot showing which way you face, and an arrow in the panel
   that works whether or not the map is rotated. */
function updateHeadingMarker() {
  if (state.heading == null || !state.here) return;
  if (!state.headingMarker) {
    const el = document.createElement('div');
    el.className = 'heading-cone';
    state.headingMarker = new maplibregl.Marker({
      element: el, rotationAlignment: 'map', pitchAlignment: 'map'
    }).setLngLat(state.here).addTo(state.map);
  }
  state.headingMarker.setLngLat(state.here).setRotation(state.heading);
}

function updateCompassUI() {
  const arrow = $('compass-arrow');
  if (!arrow) return;
  if (state.heading == null) { $('compass').hidden = false; return; }
  $('compass').hidden = false;
  $('compass').classList.add('live');
  // Point where the user faces, relative to whichever way the map is turned.
  arrow.style.transform = `rotate(${state.heading - state.map.getBearing()}deg)`;
  $('compass').title = `Facing ${Math.round(state.heading)}\u00B0`;
  updateHeadingMarker();
}

/* ---------- follow mode ---------- */

const ARRIVED_M = 15;        // close enough to call it arrived
const OFF_ROUTE_M = 40;      // far enough to say so, without rerouting

function startWalking() {
  if (!state.route) return;
  if (!window.isSecureContext) {
    return hint('Walking mode needs an https:// address.', true);
  }
  state.navigating = true;
  state.following = true;
  $('route').hidden = true;
  $('hint').hidden = true;
  $('nav').hidden = false;
  $('nav-to').textContent = `to ${state.route.to}`;
  if (!state.tracking) state.geo.trigger();   // only turn it ON, never off
  startCompass();
  if (state.here) navUpdate(state.here);
}

function stopWalking() {
  state.navigating = false;
  state.mapCenter = null;
  $('nav').hidden = true;
  $('hint').hidden = false;
  $('nav').classList.remove('arrived');
  $('route').hidden = !(state.from || state.to);
  state.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 },
                     duration: 600 });
}

/* Where along the route are we, and which way are we heading? */
function navUpdate(here, gpsHeading) {
  if (!state.navigating || !state.route) return;
  const { along, offBy, left } = progressAlong(state.route.line, state.route.total, here);

  const mins = Math.max(1, Math.round(left / WALK_M_PER_MIN));
  $('nav-mins').textContent = left < ARRIVED_M ? 'Arrived' : `${mins} min`;
  $('nav-dist').textContent = left < ARRIVED_M ? '' : `${Math.round(left)} m left`;
  $('nav').classList.toggle('arrived', left < ARRIVED_M);
  $('nav-note').textContent = offBy > OFF_ROUTE_M
    ? `You are about ${Math.round(offBy)} m off the route — Stop and pick a new one.`
    : '';

  if (!state.following) return;

  // GPS heading is null standing still and noisy at walking pace, so fall back
  // to the direction the route goes next. Facing your destination beats
  // spinning with sensor noise.
  // With no compass, fall back to GPS course, then to the direction the route
  // runs next. The camera loop applies whichever we end up with.
  if (state.headingTarget == null) {
    state.headingTarget = (typeof gpsHeading === 'number' && !isNaN(gpsHeading))
      ? gpsHeading
      : bearingAlongRoute(state.route.line, state.route.total, along);
    if (state.heading == null) state.heading = state.headingTarget;
  }
  startCameraLoop();
}

function wireControls() {
  $('stepfree').onchange = draw;
  $('clear').onclick = () => {
    state.from = state.to = null;
    $('route').hidden = true;
    state.map.getSource('route').setData(empty());
    state.map.getSource('leader').setData(empty());
    state.route = null;
    $('start').disabled = true;
  };
  $('locate').onclick = () => {
    if (!window.isSecureContext) {
      return hint('Location needs a secure page: use localhost or an https:// address.', true);
    }
    state.followMe = true;
    if (state.here) {             // already tracking — no need to wait for a fix
      state.from = { name: 'My location', point: state.here };
      return draw();
    }
    hint('Finding you…');
    if (!state.tracking) state.geo.trigger();   // same control that draws the dot
  };

  // Android can start listening immediately; iOS needs the tap below.
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission !== 'function') startCompass();
  $('compass').onclick = () => {
    if (state.compassOn) return;
    startCompass();
    hint('Compass enabled.');
  };

  $('start').onclick = startWalking;
  $('stop').onclick = stopWalking;
  $('recenter').onclick = () => {
    state.following = true;
    $('recenter').hidden = true;
    if (state.here) navUpdate(state.here);
  };

  // Any deliberate pan, zoom or rotate drops out of follow mode. Fighting the
  // camera while trying to look at something is the worst part of nav UIs.
  for (const ev of ['dragstart', 'rotatestart', 'zoomstart', 'pitchstart']) {
    state.map.on(ev, e => {
      if (!state.navigating || !e.originalEvent || !state.following) return;
      state.following = false;
      $('recenter').hidden = false;
    });
  }

  $('from').onclick = () => { setEditing('from'); $('q').focus(); };
  $('to').onclick = () => { setEditing('to'); $('q').focus(); };

  // Swap the two ends, which is the fastest fix when the order came out wrong.
  $('swap').onclick = () => {
    if (!(state.from && state.to)) return;
    [state.from, state.to] = [state.to, state.from];
    state.followMe = false;
    draw();
  };
}

main().catch(e => {
  hint('Could not load campus data.', true);
  console.error(e);
});
