/* Furman Wayfinder — UI layer.
 *
 * Routing, geometry and progress maths live in graph.js so they stay testable
 * under `node --test`. This file is the map, the modes and the DOM.
 *
 * The interface is deliberately modelled on Google Maps: search at the top, a
 * bottom sheet that rises with a place, endpoints stacked in the header once
 * directions are open. Freshmen already know those gestures, so copying them
 * means nothing new has to be learned.
 */

const BUILD = '2026-08-24 · maps-ui';

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const CENTER = [-82.4392, 34.9245];
const WALK_M_PER_MIN = 80;          // still unvalidated in the field
const ARRIVED_M = 15;
const OFF_ROUTE_M = 40;
const HEADING_SMOOTH_MS = 250;

const $ = id => document.getElementById(id);
const state = { mode: 'browse', editing: 'to' };

/* ---------- formatting ---------- */

const fmtDist = m =>
  m == null ? '—' : m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
const fmtMins = m =>
  m == null ? '—' : `${Math.max(1, Math.round(m / WALK_M_PER_MIN))} min`;
const nameOf = f => f && (f.name || (f.properties && f.properties.name)) || null;

/* ---------- modes ---------- */

/* One mode at a time, declared on <body>. CSS decides what is visible, so no
   handler has to remember to hide something a different handler showed. */
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  if (mode !== 'browse') hideSuggestions();
  measureSheet();
}

function measureSheet() {
  // Float the FABs above the sheet rather than under it.
  const h = state.mode === 'browse' ? 0 : $('sheet').offsetHeight;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}

/* ---------- boot ---------- */

async function main() {
  const [buildings, paths, entrances, boundary] = await Promise.all(
    ['buildings', 'paths', 'entrances', 'boundary']
      .map(n => fetch(`data/${n}.geojson`).then(r => r.json())));

  const onCampus = f => f.properties.on_campus;
  state.places = buildings.features.filter(f => onCampus(f) && f.properties.name);
  state.graph = buildGraph(paths.features.filter(f => onCampus(f) && f.properties.walkable));

  state.nodeIndex = turf.featureCollection(
    [...state.graph.coord].map(([id, c]) => turf.point(c, { id })));

  // A door is worth routing to; a building's geometric middle usually is not.
  state.doors = new Map();
  for (const b of state.places) {
    const ring = ringOf(b.geometry);
    state.doors.set(b.id, entrances.features
      .filter(e => inRing(ring, e.geometry.coordinates))
      .filter(e => !['service', 'emergency'].includes(e.properties.entrance))
      .map(e => e.geometry.coordinates));
  }

  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: CENTER, zoom: 15.3,
    attributionControl: { compact: true }, hash: true
  });
  state.map = map;

  state.geo = new maplibregl.GeolocateControl({
    positionOptions: {
      enableHighAccuracy: true,   // 5 m precision decides which footpath we snap to
      maximumAge: 20000,          // show an existing fix at once; the watch refines it
      timeout: 12000              // surface failure instead of hanging forever
    },
    trackUserLocation: true, showUserLocation: true, showAccuracyCircle: true
  });
  map.addControl(state.geo);

  // trigger() is a TOGGLE — calling it while active switches tracking OFF and
  // clears the dot. Follow the real state so we only ever turn it on.
  state.geo.on('trackuserlocationstart', () => {
    state.tracking = true; $('fab-locate').classList.add('tracking');
  });
  state.geo.on('trackuserlocationend', () => {
    state.tracking = false; $('fab-locate').classList.remove('tracking');
  });
  state.geo.on('geolocate', pos => {
    state.here = [pos.coords.longitude, pos.coords.latitude];
    state.gpsHeading = pos.coords.heading;
    moveCone();
    if (state.mode === 'nav') return navTick();
    if (state.usingMyLocation !== false) refreshEndpoints();
    if (state.mode === 'place') showPlaceEta();
    if (state.mode === 'directions') route();
  });

  map.on('load', () => {
    addLayers(map, buildings, boundary);
    map.on('click', 'buildings-fill', e => {
      const f = state.places.find(b => b.id === e.features[0].id);
      if (f) selectPlace(f, { fly: false });
    });
    map.on('mouseenter', 'buildings-fill', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'buildings-fill', () => map.getCanvas().style.cursor = '');
    const stamp = `${BUILD} · ${state.places.length} places · `
                + `${state.graph.size.toLocaleString()} path nodes`;
    $('build').textContent = stamp;
    $('searchbar').title = stamp;
    console.info(`Furman Wayfinder — ${stamp}`);
  });

  wireSearch();
  wireControls();
  setMode('browse');
  if (window.ResizeObserver) new ResizeObserver(measureSheet).observe($('sheet'));
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission !== 'function') startCompass();
}

const empty = () => ({ type: 'FeatureCollection', features: [] });

function addLayers(map, buildings, boundary) {
  map.addSource('boundary', { type: 'geojson', data: boundary });
  map.addSource('buildings', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: buildings.features.filter(f => f.properties.on_campus) }
  });
  map.addSource('route', { type: 'geojson', data: empty() });
  map.addSource('leader', { type: 'geojson', data: empty() });
  map.addSource('pin', { type: 'geojson', data: empty() });

  map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
    paint: { 'line-color': '#582C83', 'line-width': 1.4, 'line-opacity': .3, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings',
    paint: { 'fill-color': '#582C83', 'fill-opacity': ['case', ['has', 'name'], .22, .1] } });
  map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings',
    paint: { 'line-color': '#582C83', 'line-width': .7, 'line-opacity': .45 } });
  map.addLayer({ id: 'buildings-label', type: 'symbol', source: 'buildings',
    filter: ['has', 'name'], minzoom: 15.4,
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-max-width': 8,
              'text-font': ['Noto Sans Regular'] },
    paint: { 'text-color': '#3d1d5c', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });

  map.addLayer({ id: 'leader-line', type: 'line', source: 'leader',
    paint: { 'line-color': '#582C83', 'line-width': 2.5, 'line-dasharray': [1, 1.6], 'line-opacity': .75 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 10, 'line-opacity': .95 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#582C83', 'line-width': 5.5 } });
  map.addLayer({ id: 'pin-dot', type: 'circle', source: 'pin',
    paint: { 'circle-radius': 7, 'circle-color': '#582C83',
             'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
}

/* ---------- search ---------- */

function wireSearch() {
  state.fuse = new Fuse(state.places, {
    keys: ['properties.name', 'properties.alt_name', 'properties.short_name'],
    threshold: .4, ignoreLocation: true
  });
  const q = $('q');
  q.addEventListener('input', () => {
    $('q-clear').hidden = !q.value;
    showSuggestions(q.value.trim());
  });
  q.addEventListener('focus', () => { if (q.value.trim()) showSuggestions(q.value.trim()); });
  $('q-clear').onclick = () => { q.value = ''; $('q-clear').hidden = true; hideSuggestions(); q.focus(); };
}

function showSuggestions(term) {
  const list = $('suggest');
  if (!term) return hideSuggestions();
  const hits = state.fuse.search(term, { limit: 8 });
  if (!hits.length) return hideSuggestions();
  list.innerHTML = hits.map(h => {
    const p = h.item.properties;
    const kind = p.amenity || (p.building && p.building !== 'yes' ? p.building : 'building');
    return `<li role="option" data-id="${h.item.id}">${p.name}
      <span class="sub">${String(kind).replace(/_/g, ' ')}</span></li>`;
  }).join('');
  list.hidden = false;
  list.querySelectorAll('li').forEach(li => li.onclick = () => {
    const f = state.places.find(x => x.id === li.dataset.id);
    if (!f) return;
    if (state.mode === 'directions') setEndpoint(state.editing, f);
    else selectPlace(f, { fly: true });
    $('q').value = ''; $('q-clear').hidden = true; hideSuggestions(); $('q').blur();
  });
}
const hideSuggestions = () => { $('suggest').hidden = true; };

/* ---------- place ---------- */

function selectPlace(feature, { fly }) {
  state.to = feature;
  if (!state.from && state.here) useMyLocationAsStart();
  $('p-name').textContent = nameOf(feature);
  const p = feature.properties;
  const kind = p.amenity || (p.building && p.building !== 'yes' ? p.building : 'building');
  $('p-kind').textContent = String(kind).replace(/_/g, ' ');
  const c = centroid(feature.geometry);
  state.map.getSource('pin').setData(turf.point(c));
  if (fly) state.map.flyTo({ center: c, zoom: 17, duration: 700 });
  setMode('place');
  showPlaceEta();
}

/* Distance and time straight away if we know where the user is; a dash if not,
   which is the honest answer rather than a guess. */
function showPlaceEta() {
  const r = state.here && state.to ? computeRoute() : null;
  $('p-eta').innerHTML = r
    ? `<strong>${fmtMins(r.metres)}</strong><span>${fmtDist(r.metres)} away</span>`
    : `<strong>—</strong><span>tap the locate button to measure from here</span>`;
}

/* ---------- directions ---------- */

function openDirections() {
  if (state.here && !state.from) useMyLocationAsStart();
  setMode('directions');
  refreshEndpoints();
  route();
}

function useMyLocationAsStart() {
  state.from = { name: 'Your location', point: state.here };
  state.usingMyLocation = true;
}

function setEndpoint(which, feature) {
  state[which] = feature;
  if (which === 'from') state.usingMyLocation = false;
  refreshEndpoints();
  route();
}

function refreshEndpoints() {
  if (state.usingMyLocation && state.here) state.from = { name: 'Your location', point: state.here };
  $('f-from').querySelector('span').textContent = nameOf(state.from) || 'Choose starting point';
  $('f-to').querySelector('span').textContent = nameOf(state.to) || 'Choose destination';
  for (const w of ['from', 'to']) {
    $(`f-${w}`).dataset.editing = String(state.editing === w && state.mode === 'directions');
  }
}

/* Both endpoints expand into candidate doors and every pair is routed, keeping
   the shortest — a building with four entrances has four answers, and which is
   right depends on where you are coming from. Routing costs under a millisecond,
   so exhaustive beats guessing. */
function endpointsFor(end) {
  if (!end) return [];
  if (end.point) return [{ node: nearestNode(end.point), point: end.point }];
  const doors = state.doors.get(end.id) || [];
  const pts = doors.length ? doors : [centroid(end.geometry)];
  return pts.map(p => ({ node: nearestNode(p), point: p }));
}

const nearestNode = pt => turf.nearestPoint(turf.point(pt), state.nodeIndex).properties.id;

function computeRoute() {
  const froms = endpointsFor(state.from), tos = endpointsFor(state.to);
  if (!froms.length || !tos.length) return null;
  const avoid = $('stepfree').checked;
  let best = null;
  for (const f of froms) for (const t of tos) {
    const r = aStar(state.graph, f.node, t.node, avoid);
    if (r && (!best || r.metres < best.metres)) best = Object.assign({ a: f, b: t }, r);
  }
  return best;
}

function route() {
  const map = state.map;
  const r = state.from && state.to ? computeRoute() : null;
  state.route = r ? { line: turf.lineString(r.line), total: r.metres, to: nameOf(state.to) } : null;

  if (!r) {
    map.getSource('route').setData(empty());
    map.getSource('leader').setData(empty());
    $('d-eta').innerHTML = '<strong>—</strong><span>pick both ends</span>';
    $('d-note').textContent = '';
    $('d-go').disabled = true;
    return;
  }
  $('d-eta').innerHTML = `<strong>${fmtMins(r.metres)}</strong><span>${fmtDist(r.metres)}</span>`;
  $('d-note').textContent = $('stepfree').checked && r.usesSteps
    ? 'No fully step-free route exists — this one still uses stairs.' : '';
  $('d-go').disabled = false;

  map.getSource('route').setData(state.route.line);
  map.getSource('leader').setData({ type: 'FeatureCollection', features: [
    leg(r.a.point, r.line[0]), leg(r.line[r.line.length - 1], r.b.point)] });
  map.getSource('pin').setData(empty());

  const bb = r.line.concat([r.a.point, r.b.point])
    .reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(r.a.point, r.a.point));
  map.fitBounds(bb, {
    padding: { top: 150, bottom: Math.max(160, $('sheet').offsetHeight + 30), left: 40, right: 40 },
    maxZoom: 17.5, duration: 700
  });
}

const leg = (p, q) => turf.lineString([p, q]);

/* ---------- navigating ---------- */

function startNav() {
  if (!state.route) return;
  if (!window.isSecureContext) return note('Navigation needs an https:// address.');
  setMode('nav');
  state.following = true;
  $('n-to').textContent = `to ${state.route.to}`;
  if (!state.tracking) state.geo.trigger();
  startCompass();
  if (state.here) navTick();
}

function stopNav() {
  state.mapCenter = null;
  state.following = false;
  setMode('directions');
  state.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500 });
  route();
}

function navTick() {
  if (state.mode !== 'nav' || !state.route || !state.here) return;
  const { along, offBy, left } = progressAlong(state.route.line, state.route.total, state.here);
  const done = left < ARRIVED_M;
  $('n-eta').innerHTML = done
    ? '<strong>Arrived</strong><span></span>'
    : `<strong>${fmtMins(left)}</strong><span>${fmtDist(left)} left</span>`;
  $('n-note').textContent = offBy > OFF_ROUTE_M
    ? `About ${Math.round(offBy)} m off the route.` : '';

  if (state.headingTarget == null) {
    state.headingTarget = Number.isFinite(state.gpsHeading) ? state.gpsHeading
      : bearingAlongRoute(state.route.line, state.route.total, along);
    if (state.heading == null) state.heading = state.headingTarget;
  }
  startCameraLoop();
}

/* ---------- compass ---------- */

/* Read the sensor directly rather than using maplibre-gl-compass: that package
 * is a map *control* that sets bearing itself, which would fight the camera
 * during navigation, and it exposes no heading value to blend with the route. */
function startCompass() {
  if (state.compassOn) return;
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;
  const listen = () => {
    state.compassOn = true;
    addEventListener('deviceorientationabsolute', onOrientation, true);
    addEventListener('deviceorientation', onOrientation, true);
  };
  // iOS gates the sensor behind a prompt that must come from a user gesture.
  if (typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then(r => { if (r === 'granted') listen(); }).catch(() => {});
  } else listen();
}

function onOrientation(e) {
  let deg = null;
  if (typeof e.webkitCompassHeading === 'number') deg = e.webkitCompassHeading;  // iOS
  else if (e.absolute && typeof e.alpha === 'number') deg = 360 - e.alpha;       // Android
  if (deg == null || isNaN(deg)) return;
  // Record only. This fires ~60x a second; touching the camera here is what made
  // rotation choppy, since each animation was interrupted by the next.
  state.headingTarget = deg;
  if (state.heading == null) state.heading = deg;
  $('fab-compass').classList.add('live');
  startCameraLoop();
}

/* ---------- camera ---------- */

/* One update per display frame, easing toward whatever the sensors last
   reported, applied with jumpTo — we are already interpolating, so a second
   animation on top of it only fights this one. */
function startCameraLoop() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = null;
    let busy = false;

    if (state.headingTarget != null) {
      state.heading = smoothHeading(state.heading, state.headingTarget);
      if (angleGap(state.heading, state.headingTarget) > 0.4) busy = true;
    }

    if (state.mode === 'nav' && state.following && state.here) {
      const c = state.mapCenter || state.here;
      const k = 0.18;                                  // catches up over ~10 frames
      state.mapCenter = [c[0] + (state.here[0] - c[0]) * k, c[1] + (state.here[1] - c[1]) * k];
      state.map.jumpTo({
        center: state.mapCenter, zoom: 18, pitch: 55,
        bearing: state.heading ?? state.map.getBearing(),
        // Big top padding puts the dot low on screen, so most of the view is
        // the path ahead rather than the path already walked.
        padding: { top: Math.round(innerHeight * 0.42), bottom: 0, left: 0, right: 0 }
      });
      if (metres(state.mapCenter, state.here) > 0.5) busy = true;
    }
    moveCone();
    if (busy) startCameraLoop();
  });
}

const angleGap = (a, b) => { const d = Math.abs((a - b) % 360); return d > 180 ? 360 - d : d; };

/* The cone rides the dot in every mode: it used to move only when an
   orientation event fired, so walking with a steady phone left it behind. */
function moveCone() {
  if (!state.here || state.heading == null) {
    if (state.cone) { state.cone.remove(); state.cone = null; }
    return;
  }
  if (!state.cone) {
    const el = document.createElement('div');
    el.className = 'heading-cone';
    state.cone = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat(state.here).addTo(state.map);
  }
  state.cone.setLngLat(state.here).setRotation(state.heading);
  const arrow = $('fab-arrow');
  if (arrow) arrow.style.transform = `rotate(${state.heading - state.map.getBearing()}deg)`;
}

/* ---------- controls ---------- */

const note = msg => { $('d-note').textContent = msg; };

function wireControls() {
  $('p-directions').onclick = openDirections;
  $('d-go').onclick = startNav;
  $('n-stop').onclick = stopNav;
  $('stepfree').onchange = () => { route(); if (state.mode === 'place') showPlaceEta(); };

  $('dir-back').onclick = () => {
    if (state.mode === 'nav') return stopNav();
    state.map.getSource('route').setData(empty());
    state.map.getSource('leader').setData(empty());
    setMode(state.to ? 'place' : 'browse');
    if (state.to) selectPlace(state.to, { fly: false });
  };

  $('dir-swap').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    state.usingMyLocation = false;
    refreshEndpoints(); route();
  };

  for (const w of ['from', 'to']) {
    $(`f-${w}`).onclick = () => {
      state.editing = w;
      refreshEndpoints();
      // Reuse the one search box: swap the header back and aim it at this field.
      document.body.dataset.mode = 'browse';
      $('q').placeholder = w === 'from' ? 'Choose starting point' : 'Choose destination';
      $('q').focus();
      state.returnToDirections = true;
    };
  }

  $('q').addEventListener('blur', () => {
    // Coming back from picking an endpoint, restore the directions header.
    if (state.returnToDirections && !$('q').value) {
      state.returnToDirections = false;
      $('q').placeholder = 'Search Furman';
      setMode('directions'); refreshEndpoints();
    }
  });

  $('fab-locate').onclick = () => {
    if (!window.isSecureContext) return note('Location needs an https:// address.');
    if (!state.tracking) state.geo.trigger();
    state.usingMyLocation = true;
    if (state.here) { useMyLocationAsStart(); refreshEndpoints(); }
    if (state.mode === 'nav') { state.following = true; startCameraLoop(); }
    if (state.mode === 'place') showPlaceEta();
    if (state.mode === 'directions') route();
  };

  $('fab-compass').onclick = startCompass;

  // A deliberate pan drops out of follow mode; a camera that fights you while
  // you are trying to look at something is the worst part of most nav UIs.
  for (const ev of ['dragstart', 'rotatestart', 'zoomstart', 'pitchstart']) {
    state.map.on(ev, e => {
      if (state.mode !== 'nav' || !e.originalEvent) return;
      state.following = false;
    });
  }
}

main().catch(e => {
  $('p-name').textContent = 'Could not load campus data';
  setMode('place');
  console.error(e);
});
