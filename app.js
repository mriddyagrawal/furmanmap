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

const BUILD = '2026-08-25 · tags';

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

/* OSM tag values are a controlled vocabulary — lowercase, underscored,
 * machine-readable — and are not meant to be shown to anyone. "university" is
 * the correct tag for an academic building and changing it upstream would be
 * wrong data that every other consumer of OSM would inherit.
 *
 * So the translation belongs here, once per category rather than once per
 * building: every building carrying a tag gets its label automatically,
 * including the ones the GIS club adds next year. Anything unmapped falls back
 * to title case, so a new tag reads as "Sports Centre" rather than vanishing.
 */
const CATEGORY = {
  university: 'Academic Building',
  college: 'Academic Building',
  school: 'Academic Building',
  dormitory: 'Residence Hall',
  residential: 'Residence Hall',
  apartments: 'Apartments',
  house: 'House',
  library: 'Library',
  chapel: 'Chapel',
  place_of_worship: 'Chapel',
  cathedral: 'Chapel',
  sports_centre: 'Athletics',
  stadium: 'Athletics',
  sports_hall: 'Athletics',
  restaurant: 'Dining',
  cafe: 'Café',
  fast_food: 'Dining',
  food_court: 'Dining',
  theatre: 'Theatre',
  arts_centre: 'Arts',
  museum: 'Museum',
  parking: 'Parking',
  hospital: 'Hospital',
  clinic: 'Health Center',
  doctors: 'Health Center',
  centre: 'Health Center',
  pharmacy: 'Pharmacy',
  conference_centre: 'Conference Center',
  guardhouse: 'Guardhouse',
  tower: 'Landmark',
  monument: 'Landmark',
  attraction: 'Landmark',
  civic: 'Civic Building',
  public: 'Civic Building',
  bandstand: 'Performance',
  music_school: 'Music',
  studio: 'Studio',
  post_office: 'Post Office',
  bank: 'Bank',
  bar: 'Dining',
  pub: 'Dining',
  ice_cream: 'Dining',
  bicycle_parking: 'Bike Parking',
  toilets: 'Restrooms',
  fuel: 'Fuel',
  kindergarten: 'Childcare',
  childcare: 'Childcare',
  office: 'Offices',
  retail: 'Shop',
  commercial: 'Shop',
  service: 'Service Building',
  greenhouse: 'Greenhouse',
  roof: 'Shelter',
  shed: 'Outbuilding',
  garage: 'Garage',
  yes: 'Building',
};

const titleCase = v => String(v).replace(/_/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

/* amenity is more specific than building, so it wins: a library tagged
   building=university should read "Library", not "Academic Building". */
function categoryOf(props) {
  for (const key of ['amenity', 'healthcare', 'tourism', 'leisure', 'man_made', 'building']) {
    const v = props[key];
    if (!v || v === 'yes') continue;
    return CATEGORY[v] || titleCase(v);
  }
  return CATEGORY[props.building] || 'Building';
}

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
  const [buildings, paths, entrances, boundary, meta] = await Promise.all([
    ...['buildings', 'paths', 'entrances', 'boundary']
      .map(n => fetch(`data/${n}.geojson`).then(r => r.json())),
    fetch('data/meta.json').then(r => r.json()).catch(() => null)
  ]);
  state.meta = meta;

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
    // Credits belong in the attribution bar. It is where a map's provenance is
    // conventionally read, so a byline there is professional rather than a
    // signature stuck on the artwork.
    attributionControl: false,
    hash: true
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
  // Collapsed to an (i), which is what Google and Mapbox both do. The ODbL
  // requires the OpenStreetMap credit to be reachable, not to be permanently
  // spread across the map — one tap satisfies it. The byline moves to the sheet
  // where it can be read without competing with the credits.
  const attribution = new maplibregl.AttributionControl({ compact: true });
  map.addControl(attribution, 'bottom-left');
  map.once('idle', () => {
    const details = document.querySelector('.maplibregl-ctrl-attrib');
    if (details) details.removeAttribute('open');
  });

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
    recolourBasemap(map);
    addLayers(map, buildings, boundary);
    flushPending();
    highlight([state.from, state.to]);
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
    // What a visitor wants to know is how current the map is. The build id
    // still matters for telling a stale cache from a real bug, so it moves to
    // the tooltip and the console rather than disappearing.
    const when = state.meta && state.meta.generated;
    const updated = when
      ? `Last updated ${new Date(when + 'T00:00:00Z').toLocaleDateString(undefined,
          { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
      : 'Last updated — unknown';
    $('build').innerHTML =
      `<a href="https://github.com/mriddyagrawal/furmanmap" target="_blank" rel="noopener">`
      + `Made by Mridul</a> · ${updated}`;
    const stamp = `${BUILD} · ${state.places.length} places · `
                + `${state.graph.size.toLocaleString()} path nodes`;
    $('build').title = stamp;
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

/* Light up whole buildings rather than dropping a dot on them: the shape is
   what you are walking to, and at campus zoom it reads instantly. */
function highlight(features) {
  const ids = features.filter(f => f && f.id).map(f => f.id);
  for (const layer of ['buildings-selected', 'buildings-selected-line']) {
    if (state.map && state.map.getLayer && state.map.getLayer(layer)) {
      state.map.setFilter(layer, ['in', ['get', 'fid'], ['literal', ids]]);
    }
  }
  state.highlighted = ids;
}

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

/* Categories are separated by perceptual difference (CIE deltaE), not by
 * luminance contrast. WCAG contrast measures lightness alone, so it scores a
 * light green against a light beige at 1.07:1 and calls them identical when
 * they read as obviously different — deltaE puts that same pair at 18.7. Every
 * adjacent pair here clears deltaE 8, which is noticeable at a glance.
 *
 * Positron is CARTO's data-visualisation basemap: deliberately desaturated so
 * thematic overlays dominate it. That is a principled design — Imhof's rule
 * that base colours stay light and neutral, with saturation reserved for small
 * areas of emphasis — but it is built for choropleths, not for walking.
 *
 * Measured on the shipped style, it renders building and residential land at
 * 1.00:1 against each other (identical), park against land at 1.02:1, and the
 * lake at 4% saturation, i.e. grey. On a wayfinding map those are landmarks a
 * walker navigates by, so they have to be distinguishable.
 *
 * This keeps the base light — the purple route still clears 4.6:1 against the
 * strongest of these — while pushing adjacent categories at least 1.12:1 apart
 * and giving water an actual blue.
 */
const PALETTE = [
  [/water|lake|ocean|sea|reservoir/, '#9ed3ef'],
  [/waterway|river|stream|canal/,    '#9ed3ef'],
  [/wood|forest/,                    '#bfdcac'],
  [/park|cemetery|pitch|playground/, '#d8ecc6'],
  [/grass|meadow|farmland|scrub/,    '#ecf7e2'],
  [/sand|beach/,                     '#f2e9d2'],
  [/building/,                       '#ddd6cc'],
  [/residential|landuse/,            '#f0ede7'],
];

function recolourBasemap(map) {
  for (const layer of map.getStyle().layers) {
    const id = layer.id.toLowerCase();
    // Never touch our own layers, labels, or roads: roads carry their own
    // hierarchy by width and shade, and relighting them would flatten it.
    if (id.startsWith('buildings-') || id.startsWith('route') || id.startsWith('boundary')
        || layer.type === 'symbol' || /road|highway|bridge|tunnel|transit|rail|aero/.test(id)) continue;
    const hit = PALETTE.find(([re]) => re.test(id));
    if (!hit) continue;
    const prop = layer.type === 'fill' ? 'fill-color'
               : layer.type === 'line' ? 'line-color'
               : layer.type === 'background' ? 'background-color' : null;
    if (!prop) continue;
    try { map.setPaintProperty(layer.id, prop, hit[1]); } catch (e) { /* layer opted out */ }
  }
}

function addLayers(map, buildings, boundary) {
  // The boundary is still needed as geometry — it is what the veil is cut
  // from — but it is no longer drawn. A dashed outline and a veil were saying
  // the same thing twice, and the veil says it without adding a line to read.
  map.addSource('boundary', { type: 'geojson', data: boundary });

  // Everything beyond the campus outline is veiled: a world-covering polygon
  // with the boundary punched out of it. Off-campus detail still reads for
  // orientation, but stops competing with the place the map is actually about.
  // Added first, so every campus layer draws over it.
  // Both maps worth copying — UCSD's Esri build and CU Boulder's Concept3D one
  // — tint the whole campus as a single area. That is what makes a campus read
  // as a place rather than as a scatter of separate buildings, and it does more
  // for legibility than any amount of colouring the buildings themselves.
  // It has to sit at landuse level, underneath water and roads. Added on top —
  // which is what a plain addLayer does — it painted straight over Furman Lake
  // and every footpath, which is the opposite of helping someone navigate.
  const firstWater = (map.getStyle().layers.find(l => /water/.test(l.id)) || {}).id;
  // Pale purple, not green. The first attempt tinted campus a pale green that
  // measured deltaE 2.5 against off-campus grass — the same colour to the eye —
  // so it read as "more grass" rather than as "this is Furman". One hue, one
  // meaning: green is vegetation everywhere on this map, so the campus wash has
  // to be something else, and the brand colour is the obvious something else.
  map.addLayer({ id: 'campus-tint', type: 'fill', source: 'boundary',
    paint: { 'fill-color': '#efeaf3', 'fill-opacity': .85 } }, firstWater);

  try {
    map.addSource('offcampus', { type: 'geojson', data: turf.mask(boundary.features[0]) });
    map.addLayer({ id: 'offcampus-veil', type: 'fill', source: 'offcampus',
      paint: { 'fill-color': '#f7f6f3', 'fill-opacity': .55 } });
  } catch (e) { console.warn('no campus boundary to veil against', e); }
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

  // Buildings are deliberately quiet. Painting all five hundred of them in
  // Furman purple left nothing able to stand out — the reference maps both keep
  // buildings neutral and spend colour on area and emphasis instead. The purple
  // is still there, drained most of the way to grey, so a selected building and
  // the route have somewhere to be loud against.
  map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings',
    paint: { 'fill-color': ['case', ['has', 'name'], '#b7abc0', '#cfc9d2'],
             'fill-opacity': .95 } });
  map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings',
    paint: { 'line-color': '#9d8fab', 'line-width': .6, 'line-opacity': .7 } });
  // Selection is drawn as its own filtered pass over the same source, rather
  // than by mutating the data. Setting a filter is cheap; re-uploading the
  // whole building collection on every tap is not.
  map.addLayer({ id: 'buildings-selected', type: 'fill', source: 'buildings',
    filter: ['in', ['get', 'fid'], ['literal', []]],
    paint: { 'fill-color': '#582C83', 'fill-opacity': .72 } });
  map.addLayer({ id: 'buildings-selected-line', type: 'line', source: 'buildings',
    filter: ['in', ['get', 'fid'], ['literal', []]],
    paint: { 'line-color': '#3d1d5c', 'line-width': 2.2 } });

  // Every label the same size is why the map reads flat. Footprint area is a
  // decent proxy for how much a building matters: Timmons Arena and Duke
  // Library are the biggest on campus, the guardhouses the smallest. Big ones
  // appear earlier and larger, so zooming out leaves the landmarks behind
  // rather than an even wash of names.
  map.addLayer({ id: 'buildings-label-major', type: 'symbol', source: 'buildings',
    filter: ['all', ['has', 'name'], ['>=', ['get', 'area'], 1800]], minzoom: 14.6,
    layout: { 'text-field': ['get', 'name'], 'text-max-width': 8,
              'text-font': ['Noto Sans Bold'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11, 17, 13.5, 19, 15] },
    paint: { 'text-color': '#38215c', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'buildings-label-minor', type: 'symbol', source: 'buildings',
    filter: ['all', ['has', 'name'], ['<', ['get', 'area'], 1800]], minzoom: 16.2,
    layout: { 'text-field': ['get', 'name'], 'text-max-width': 8,
              'text-font': ['Noto Sans Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 16.2, 10, 19, 12] },
    paint: { 'text-color': '#4b3a63', 'text-halo-color': '#fff', 'text-halo-width': 1.4 } });

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
  $('q-clear').onclick = () => clearSelection({ focus: true });

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
  //
  // It shows only while the field is empty. Once someone is typing a name they
  // have said what they are looking for, and leaving it pinned above the
  // matches makes it a permanent misfire target at the top of the list.
  const here = picking && !term
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
    return `<li role="option" data-id="${h.item.id}">${p.name}
      <span class="sub">${categoryOf(p)}</span></li>`;
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

/* The cross undoes the whole search: the text, the selected place, its
   highlight and any route it produced. Clearing only the text would leave the
   map showing a selection the search bar no longer names. */
function clearSelection(opts) {
  state.to = null;
  state.route = null;
  highlight([]);
  setSource('route', empty());
  setSource('route-done', empty());
  setSource('leader', empty());
  tidySearch('');
  setMode('browse');
  // Only pull focus into the field when the user cleared from the field. Doing
  // it from the sheet would raise the keyboard over the map they just revealed.
  if (opts && opts.focus) $('q').focus();
}

/* ---------- place ---------- */

function selectPlace(feature, { fly }) {
  state.to = feature;
  if (!state.from && state.here) useMyLocationAsStart();
  $('p-name').textContent = nameOf(feature);
  $('p-kind').textContent = categoryOf(feature.properties);
  setMode('place');
  showPlaceEta();
  // Keep the search bar in step with the map, however the place was chosen.
  $('q').value = nameOf(feature) || '';
  $('q-clear').hidden = !$('q').value;
  highlight([feature]);
  const c = centroid(feature.geometry);
  if (fly && state.map.loaded()) state.map.flyTo({ center: c, zoom: 17, duration: 700 });
}

/* Distance and time straight away if we know where the user is; a dash if not,
   which is the honest answer rather than a guess. */
function showPlaceEta() {
  const r = state.here && state.to ? computeRoute() : null;
  // With no fix there is nothing honest to show, so show nothing. The prompt
  // that used to sit here asked for location before anyone had said they wanted
  // directions, which is the wrong moment to ask.
  $('p-eta').hidden = !r;
  if (r) $('p-eta').innerHTML =
    `<strong>${fmtMins(r.metres)}</strong><span>${fmtDist(r.metres)} away</span>`;

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
  const notes = [];
  if ($('stepfree').checked && r.usesSteps) {
    notes.push('No fully step-free route exists — this one still uses stairs.');
  }
  if (r.restrictedMetres > 20) {
    notes.push(`Uses about ${Math.round(r.restrictedMetres)} m of private roadway.`);
  }
  $('d-note').textContent = notes.join(' ');
  $('d-go').disabled = false;

  setSource('route', state.route.line);
  setSource('leader', { type: 'FeatureCollection', features: [
    leg(r.a.point, r.line[0]), leg(r.line[r.line.length - 1], r.b.point)] });
  highlight([state.from, state.to]);

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
  $('p-close').onclick = clearSelection;
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
