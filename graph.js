/* Routing core — pure functions, no DOM.
 *
 * Runs in the browser (UMD globals loaded from a CDN by index.html) and under
 * `node --test` (npm dependencies). Same file, same code path, both places.
 *
 * The heavy lifting is other people's: Turf for geodesy, ngraph.path for A*.
 * What stays hand-written is only what no library does for us — building the
 * graph from OSM node ids, and discarding orphan components.
 */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const deps = node
    ? { turf: require('@turf/turf'),
        createGraph: require('ngraph.graph'),
        ngraphPath: require('ngraph.path') }
    : { turf: root.turf, createGraph: root.createGraph, ngraphPath: root.ngraphPath };
  const api = factory(deps);
  if (node) module.exports = api; else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function ({ turf, createGraph, ngraphPath }) {

// A multiplier, not a ban: stairs stay usable as a last resort, so "avoid
// stairs" degrades to a longer route rather than stranding someone with none.
const STEP_PENALTY = 12;

/* ---------- geometry (Turf) ---------- */

const metres = (a, b) => turf.distance(a, b, { units: 'meters' });
const ringOf = geom =>
  geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
const centroid = geom => turf.centroid({ type: 'Feature', properties: {}, geometry: geom })
  .geometry.coordinates;
const inRing = (ring, pt) =>
  turf.booleanPointInPolygon(pt, turf.polygon([ring]));

/* ---------- routing graph ---------- */

// Two ways are connected when they share an OSM node id — not when their
// coordinates happen to be close. That is why paths.geojson keeps `nodes`,
// and it is the one thing a coordinate-keyed router could not give us.
function buildGraph(paths) {
  const graph = createGraph();
  const coord = new Map();

  for (const f of paths) {
    const ids = f.properties.nodes, cs = f.geometry.coordinates;
    if (!ids || ids.length !== cs.length) continue;   // refs fell outside the bbox
    const steps = f.properties.highway === 'steps';
    for (let i = 0; i < ids.length; i++) {
      coord.set(ids[i], cs[i]);
      graph.addNode(ids[i], { c: cs[i] });
    }
    for (let i = 0; i < ids.length - 1; i++) {
      graph.addLink(ids[i], ids[i + 1],
                    { w: metres(cs[i], cs[i + 1]), steps });
    }
  }

  // Keep only the largest connected component, or orphan path islands produce
  // destinations that are visible on the map but can never be routed to.
  // No routing library does this for us; it is the reason this function exists.
  let best = new Set();
  const seen = new Set();
  graph.forEachNode(n => {
    if (seen.has(n.id)) return;
    const comp = new Set([n.id]), stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      graph.forEachLinkedNode(stack.pop(), other => {
        if (!seen.has(other.id)) { seen.add(other.id); comp.add(other.id); stack.push(other.id); }
      });
    }
    if (comp.size > best.size) best = comp;
  });
  for (const id of [...coord.keys()]) {
    if (!best.has(id)) { coord.delete(id); graph.removeNode(id); }
  }

  return { graph, coord, size: best.size };
}

function finderFor(graph, avoidSteps) {
  return ngraphPath.aStar(graph, {
    // Straight-line metres can never exceed a path measured in metres, so the
    // heuristic is admissible and A* stays optimal.
    heuristic: (a, b) => metres(a.data.c, b.data.c),
    distance: (a, b, link) =>
      link.data.w * (avoidSteps && link.data.steps ? STEP_PENALTY : 1),
    oriented: false
  });
}

function aStar(g, start, goal, avoidSteps) {
  if (!g.coord.has(start) || !g.coord.has(goal)) return null;
  let nodes;
  try { nodes = finderFor(g.graph, avoidSteps).find(start, goal); }
  catch (e) { return null; }
  if (!nodes || !nodes.length) return null;

  // ngraph returns the path goal-first; orient it start-first.
  if (nodes[0].id !== start) nodes = nodes.slice().reverse();

  const line = nodes.map(n => n.data.c);
  let len = 0, steps = false;
  for (let i = 0; i < nodes.length - 1; i++) {
    len += metres(line[i], line[i + 1]);
    g.graph.forEachLinkedNode(nodes[i].id, (other, link) => {
      if (other.id === nodes[i + 1].id && link.data.steps) steps = true;
    });
  }
  return { line, metres: len, usesSteps: steps };
}

/* ---------- heading ---------- */

const HEADING_SMOOTHING = 0.25;      // 0 = frozen, 1 = raw and jumpy

/* Averaging angles naively spins the map at the 359 -> 0 boundary, so smooth
   the unit vector instead of the number. */
function smoothHeading(prev, next) {
  if (prev === undefined || prev === null) return next;
  const r = Math.PI / 180;
  const x = Math.cos(prev * r) * (1 - HEADING_SMOOTHING) + Math.cos(next * r) * HEADING_SMOOTHING;
  const y = Math.sin(prev * r) * (1 - HEADING_SMOOTHING) + Math.sin(next * r) * HEADING_SMOOTHING;
  return (Math.atan2(y, x) / r + 360) % 360;
}

/* ---------- progress along a route ---------- */

/* Where along `line` is `here`, how far is left, and how far off-route are we?
 * Kept here rather than in app.js so a unit mistake — metres vs kilometres is
 * the classic one with Turf — fails a test instead of quietly halving an ETA.
 */
function progressAlong(line, totalMetres, here) {
  const snapped = turf.nearestPointOnLine(line, turf.point(here), { units: 'meters' });
  const along = snapped.properties.location;
  return {
    along,
    offBy: snapped.properties.dist,
    left: Math.max(0, totalMetres - along)
  };
}

/* Direction the route runs from this point onward — used to orient the map when
 * GPS gives no heading, which is always the case standing still. */
function bearingAlongRoute(line, totalMetres, along) {
  const a = turf.along(line, Math.max(0, Math.min(along, totalMetres - 1)), { units: 'meters' });
  const b = turf.along(line, Math.min(along + 25, totalMetres), { units: 'meters' });
  return turf.bearing(a, b);
}

  return { metres, ringOf, centroid, inRing, buildGraph, aStar, STEP_PENALTY,
           progressAlong, bearingAlongRoute, smoothHeading,
           HEADING_SMOOTHING, turf };
});
