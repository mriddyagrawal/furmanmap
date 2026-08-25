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

const BUILD = '2026-08-25 · sticky-search';

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
  if (mode !== 'browse' && mode !== 'picking') hideSuggestions();
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
    flushPending();
    map.on('click', 'buildings-fill', e => {
      const fid = e.features[0].properties.fid;
      const f = state.places.find(b => b.id === fid);
      if (f) selectPlace(f, { fly: false });
    });
    // Only named buildings do anything when tapped, so only they should look
    // tappable.
    map.on('mousemove', 'buildings-fill', e => {
      const named = !!e.features[0].properties.name;
      map.getCanvas().style.cursor = named ? 'pointer' : '';
    });
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

/* Sources exist only after the map's `load` event. Writing to one before then
   throws, and an exception mid-handler silently abandons everything after it —
   which is how tapping a search result during load did nothing at all. */
function setSource(name, data) {
  const src = state.map && state.map.getSource && state.map.getSource(name);
  if (src) src.setData(data);
  else (state.pending ||= new Map()).set(name, data);   // replay once loaded
}

function flushPending() {
  if (!state.pending) return;
  for (const [name, data] of state.pending) setSource(name, data);
  state.pending = null;
}

function addLayers(map, buildings, boundary) {
  map.addSource('boundary', { type: 'geojson', data: boundary });
  // MapLibre coerces a non-numeric GeoJSON feature id to 0 when it builds its
  // internal tiles, so e.features[0].id came back as 0 for every building and
  // the click handler's lookup never matched. Carrying the id in properties as
  // well is what makes tap-to-select work at all.
  map.addSource('buildings', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: buildings.features.filter(f => f.properties.on_campus)
        .map(f => ({ ...f, properties: { ...f.properties, fid: f.id } }))
    }
  });
  map.addSource('route', { type: 'geojson', data: empty() });
  map.addSource('route-done', { type: 'geojson', data: empty() });
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
  // Drawn first so the live route paints over it where they meet.
  map.addLayer({ id: 'route-done-line', type: 'line', source: 'route-done',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#9a94a8', 'line-width': 5, 'line-opacity': .55 } });
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
  $('q-clear').onclick = clearSelection;

  // Focusing a box that already holds a place selects it, so typing replaces
  // the name rather than appending to it.
  q.addEventListener('focus', () => { if (q.value) q.select(); });
}

function showSuggestions(term) {
  const list = $('suggest');
  const picking = state.mode === 'picking';
  // Offer the user's own position as a first-class choice. Without it the only
  // way to start a route from where you are is to guess that the locate button
  // must be pressed first, which is not a thing anyone should have to know.
  const here = picking
    ? `<li role="option" class="here" data-here="1"><i class="pip"></i>Your location</li>` : '';
  if (!term) {
    if (!here) return hideSuggestions();
    list.innerHTML = here;
    list.hidden = false;
    return bindSuggestions();
  }
  const hits = state.fuse.search(term, { limit: 8 });
  if (!hits.length && !here) return hideSuggestions();
  list.innerHTML = here + hits.map(h => {
    const p = h.item.properties;
    const kind = p.amenity || (p.building && p.building !== 'yes' ? p.building : 'building');
    return `<li role="option" data-id="${h.item.id}">${p.name}
      <span class="sub">${String(kind).replace(/_/g, ' ')}</span></li>`;
  }).join('');
  list.hidden = false;
  bindSuggestions();
}

function bindSuggestions() {
  $('suggest').querySelectorAll('li').forEach(li => li.onclick = () => {
    const picking = state.mode === 'picking';
    if (li.dataset.here) {
      chooseMyLocation(state.editing);
    } else {
      const f = state.places.find(x => x.id === li.dataset.id);
      if (!f) return;
      if (picking) setEndpoint(state.editing, f);
      else return selectPlace(f, { fly: true }), tidySearch(f.properties.name);
    }
    tidySearch();
    if (picking) { setMode('directions'); refreshEndpoints(); route(); }
  });
}

/* After a selection the box keeps the chosen place, the way every maps app
   does — it is the answer to "what am I looking at", and the cross beside it is
   how you put the map back. Endpoint picking passes nothing, because there the
   endpoint fields already show the value. */
function tidySearch(keep) {
  const q = $('q');
  q.value = keep || '';
  $('q-clear').hidden = !q.value;
  hideSuggestions();
  q.blur();
  q.placeholder = 'Search Furman';
}

/* Picking "Your location" asks for a fix if we do not have one, rather than
   failing quietly and leaving the field empty. */
function chooseMyLocation(which) {
  if (which === 'to') {
    state.to = state.here ? { name: 'Your location', point: state.here } : null;
  } else {
    state.usingMyLocation = true;
    if (state.here) useMyLocationAsStart();
  }
  if (!state.here) {
    if (window.isSecureContext && !state.tracking) state.geo.trigger();
    note('Finding your location…');
  }
}
const hideSuggestions = () => { $('suggest').hidden = true; };

/* The cross undoes the whole search: the text, the selected place, the pin and
   any route it produced. Clearing only the text would leave the map showing a
   selection the search bar no longer names. */
function clearSelection() {
  state.to = null;
  state.route = null;
  setSource('pin', empty());
  setSource('route', empty());
  setSource('route-done', empty());
  setSource('leader', empty());
  tidySearch('');
  setMode('browse');
  $('q').focus();
}

/* ---------- place ---------- */

function selectPlace(feature, { fly }) {
  state.to = feature;
  if (!state.from && state.here) useMyLocationAsStart();
  $('p-name').textContent = nameOf(feature);
  const p = feature.properties;
  const kind = p.amenity || (p.building && p.building !== 'yes' ? p.building : 'building');
  $('p-kind').textContent = String(kind).replace(/_/g, ' ');
  setMode('place');
  showPlaceEta();
  // Keep the search bar in step with the map, however the place was chosen.
  $('q').value = nameOf(feature) || '';
  $('q-clear').hidden = !$('q').value;
  const c = centroid(feature.geometry);
  setSource('pin', turf.point(c));
  if (fly && state.map.loaded()) state.map.flyTo({ center: c, zoom: 17, duration: 700 });
}

/* Distance and time straight away if we know where the user is; a dash if not,
   which is the honest answer rather than a guess. */
function showPlaceEta() {
  const r = state.here && state.to ? computeRoute() : null;
  $('p-eta').innerHTML = r
    ? `<strong>${fmtMins(r.metres)}</strong><span>${fmtDist(r.metres)} away</span>`
    : `<strong>—</strong><span>tap the locate button to measure from here</span>`;

  // A usable route is a state, not the end of a sequence. If one exists, Go is
  // offered here too rather than only after stepping through the directions
  // screen — Directions stays available for changing either end.
  if (r) {
    state.route = { line: turf.lineString(r.line), total: r.metres, to: nameOf(state.to) };
    setSource('route', state.route.line);
    setSource('leader', { type: 'FeatureCollection', features: [
      leg(r.a.point, r.line[0]), leg(r.line[r.line.length - 1], r.b.point)] });
  } else {
    state.route = null;
    setSource('route', empty());
    setSource('leader', empty());
  }
  $('p-go').hidden = !r;
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
    setSource('route', empty());
    setSource('leader', empty());
    const missing = !state.from && !state.to ? 'pick a start and a destination'
                  : !state.from ? 'choose a starting point'
                  : 'choose a destination';
    $('d-eta').innerHTML = `<strong>—</strong><span>${missing}</span>`;
    $('d-note').textContent = '';
    $('d-go').disabled = true;
    return;
  }
  $('d-eta').innerHTML = `<strong>${fmtMins(r.metres)}</strong><span>${fmtDist(r.metres)}</span>`;
  $('d-note').textContent = $('stepfree').checked && r.usesSteps
    ? 'No fully step-free route exists — this one still uses stairs.' : '';
  $('d-go').disabled = false;

  setSource('route', state.route.line);
  setSource('leader', { type: 'FeatureCollection', features: [
    leg(r.a.point, r.line[0]), leg(r.line[r.line.length - 1], r.b.point)] });
  setSource('pin', empty());

  const bb = r.line.concat([r.a.point, r.b.point])
    .reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(r.a.point, r.a.point));
  if (map.loaded()) map.fitBounds(bb, {
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
  state.cam = null;              // re-seed from the map's current pose
  $('n-to').textContent = `to ${state.route.to}`;
  if (!state.tracking) state.geo.trigger();
  startCompass();
  if (state.here) navTick();
}

function stopNav() {
  setSource('route-done', empty());
  state.cam = null;
  state.following = false;
  $('fab-locate').classList.remove('recenter');
  setMode('directions');
  state.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500 });
  route();
}

function navTick() {
  if (state.mode !== 'nav' || !state.route || !state.here) return;
  const { along, offBy, left } = progressAlong(state.route.line, state.route.total, state.here);
  const done = left < ARRIVED_M;
  paintProgress(along);
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

/* Split the drawn route at the walked point: grey behind, purple ahead. Without
   this the line looks identical after ten minutes of walking, which gives no
   sense of progress at all. */
function paintProgress(along) {
  const { line, total } = state.route;
  const head = Math.max(0, Math.min(along, total));
  setSource('route-done', head > 1
    ? turf.lineSliceAlong(line, 0, head, { units: 'meters' }) : empty());
  setSource('route', head < total - 1
    ? turf.lineSliceAlong(line, head, total, { units: 'meters' }) : empty());
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

/* One update per display frame.
 *
 * Every camera property is interpolated — centre, zoom, pitch, bearing and
 * padding. The previous version eased only centre and bearing and passed zoom
 * and pitch as constants, so entering navigation slammed from a flat overview
 * to a 55-degree tilt in one frame. The tilt arrived correctly and looked like
 * a snap, which is exactly what was reported.
 *
 * jumpTo, not easeTo: we are already interpolating, and a second animation on
 * top of this one only fights it.
 */
// Two rates, because one number cannot serve both jobs. A big move — entering
// navigation, or re-centring after a pan — should read as a deliberate sweep,
// so it eases slowly. Once the camera is on station, following the dot wants to
// be brisk or it lags behind you.
//
// Both are expressed per 60fps frame and then converted against the real time
// elapsed. Applying a per-frame fraction directly ties the animation's duration
// to the frame rate: at 15fps the same sweep takes four times as long in
// wall-clock terms, which on a weak GPU is the difference between a 1.2s move
// and a five-second crawl.
const CAM_EASE_SWEEP = 0.045;          // large change: roughly 1.2s at 60fps
const CAM_EASE_FOLLOW = 0.16;
const FRAME_MS = 1000 / 60;

/* Convert a per-frame easing fraction into one for the time actually elapsed. */
function easeFor(rate, dt) {
  return 1 - Math.pow(1 - rate, Math.min(dt, 100) / FRAME_MS);
}
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => {
  let d = ((b - a) % 360 + 540) % 360 - 180;   // shortest way round
  return (a + d * k + 360) % 360;
};

/* Where the camera wants to be, or null when the map is the user's to drive. */
function cameraTarget() {
  if (state.mode !== 'nav' || !state.following || !state.here) return null;
  return {
    center: state.here, zoom: 18, pitch: 55,
    bearing: state.heading ?? state.map.getBearing(),
    // Big top padding puts the dot low on screen, so most of the view is the
    // path ahead rather than the path already walked.
    padTop: Math.round(innerHeight * 0.42)
  };
}

function startCameraLoop() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(now => {
    state.raf = null;
    const dt = state.lastFrame ? now - state.lastFrame : FRAME_MS;
    state.lastFrame = now;
    let busy = false;

    if (state.headingTarget != null) {
      state.heading = smoothHeading(state.heading, state.headingTarget);
      if (angleGap(state.heading, state.headingTarget) > 0.4) busy = true;
    }

    const t = cameraTarget();
    if (t) {
      // Start from wherever the map actually is, so the first frame of a
      // transition continues from the overview rather than teleporting.
      const c = state.cam || (state.cam = {
        center: state.map.getCenter().toArray(), zoom: state.map.getZoom(),
        pitch: state.map.getPitch(), bearing: state.map.getBearing(), padTop: 0
      });
      const far = metres(c.center, t.center) > 25 || Math.abs(c.pitch - t.pitch) > 6
               || Math.abs(c.zoom - t.zoom) > 0.6 || Math.abs(c.padTop - t.padTop) > 40;
      const k = easeFor(far ? CAM_EASE_SWEEP : CAM_EASE_FOLLOW, dt);

      c.center = [lerp(c.center[0], t.center[0], k), lerp(c.center[1], t.center[1], k)];
      c.zoom    = lerp(c.zoom, t.zoom, k);
      c.pitch   = lerp(c.pitch, t.pitch, k);
      c.padTop  = lerp(c.padTop, t.padTop, k);
      c.bearing = lerpAngle(c.bearing, t.bearing, k);

      state.map.jumpTo({
        center: c.center, zoom: c.zoom, pitch: c.pitch, bearing: c.bearing,
        padding: { top: Math.round(c.padTop), bottom: 0, left: 0, right: 0 }
      });

      if (metres(c.center, t.center) > 0.5 || Math.abs(c.zoom - t.zoom) > 0.01 ||
          Math.abs(c.pitch - t.pitch) > 0.2 || Math.abs(c.padTop - t.padTop) > 1 ||
          angleGap(c.bearing, t.bearing) > 0.4) busy = true;
    }

    moveCone();
    if (busy) startCameraLoop();
    else state.lastFrame = null;      // next start measures from its own first frame
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
  $('p-go').onclick = startNav;
  $('d-go').onclick = startNav;
  $('n-stop').onclick = stopNav;
  $('stepfree').onchange = () => { route(); if (state.mode === 'place') showPlaceEta(); };

  $('dir-back').onclick = () => {
    if (state.mode === 'nav') return stopNav();
    setSource('route', empty());
    setSource('leader', empty());
    if (state.to) selectPlace(state.to, { fly: false });
    else clearSelection();
  };

  $('dir-swap').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    state.usingMyLocation = false;
    refreshEndpoints(); route();
  };

  for (const w of ['from', 'to']) {
    $(`f-${w}`).onclick = () => {
      state.editing = w;
      setMode('picking');
      refreshEndpoints();
      $('q').value = '';
      $('q').placeholder = w === 'from' ? 'Choose starting point' : 'Choose destination';
      $('q').focus();
      showSuggestions('');          // offers "Your location" straight away
    };
  }

  $('dir-back').addEventListener('click', () => { $('q').placeholder = 'Search Furman'; });

  $('fab-locate').onclick = () => {
    if (!window.isSecureContext) return note('Location needs an https:// address.');
    if (!state.tracking) state.geo.trigger();
    state.usingMyLocation = true;
    if (state.here) { useMyLocationAsStart(); refreshEndpoints(); }
    if (state.mode === 'nav') {
      state.following = true; state.cam = null;
      $('fab-locate').classList.remove('recenter');
      startCameraLoop();
    }
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
      $('fab-locate').classList.add('recenter');
    });
  }
}

// Test hook. The site is static and public, so there is nothing to protect
// here, and asserting on real map sources beats scraping pixels.
window.__wayfinder = state;

main().catch(e => {
  $('p-name').textContent = 'Could not load campus data';
  setMode('place');
  console.error(e);
});
