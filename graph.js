/* Routing core — pure functions, no DOM.
 *
 * Split out of app.js so it can be exercised headlessly in Node: the router is
 * the only part of this app with real logic, and a browser-only router is a
 * router nobody tests. Loads as a plain <script> in the browser and via
 * require() in tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

// A multiplier, not a ban: stairs stay usable as a last resort, so "avoid
// stairs" degrades to a longer route rather than stranding someone with none.
const STEP_PENALTY = 12;

/* ---------- geometry ---------- */

// lat/lon are angles on a sphere: you cannot subtract them and get metres.
function metres(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const p1 = a[1] * rad, p2 = b[1] * rad;
  const dp = p2 - p1, dl = (b[0] - a[0]) * rad;
  const h = Math.sin(dp / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function ringOf(geom) {
  return geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
}

function centroid(geom) {
  const r = ringOf(geom);
  let x = 0, y = 0;
  for (const c of r) { x += c[0]; y += c[1]; }
  return [x / r.length, y / r.length];
}

function inRing(ring, pt) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    if ((y1 > pt[1]) !== (y2 > pt[1]) &&
        pt[0] < x1 + (pt[1] - y1) / (y2 - y1) * (x2 - x1)) inside = !inside;
  }
  return inside;
}

/* ---------- routing graph ---------- */

// Two ways are connected when they share an OSM node id — not when their
// coordinates happen to be close. That is why paths.geojson keeps `nodes`.
function buildGraph(paths) {
  const adj = new Map(), coord = new Map();
  const edge = (a, b, w, steps) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w, steps });
  };

  for (const f of paths) {
    const ids = f.properties.nodes, cs = f.geometry.coordinates;
    if (!ids || ids.length !== cs.length) continue;   // refs fell outside the bbox
    const steps = f.properties.highway === 'steps';
    for (let i = 0; i < ids.length; i++) coord.set(ids[i], cs[i]);
    for (let i = 0; i < ids.length - 1; i++) {
      const w = metres(cs[i], cs[i + 1]);
      edge(ids[i], ids[i + 1], w, steps);
      edge(ids[i + 1], ids[i], w, steps);
    }
  }

  // Keep only the largest connected component, or orphan path islands produce
  // destinations that exist on the map but can never be routed to.
  let best = new Set();
  const seen = new Set();
  for (const start of coord.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set([start]), stack = [start];
    seen.add(start);
    while (stack.length) {
      for (const e of adj.get(stack.pop()) || []) {
        if (!seen.has(e.to)) { seen.add(e.to); comp.add(e.to); stack.push(e.to); }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  for (const id of coord.keys()) if (!best.has(id)) coord.delete(id);

  return { adj, coord, size: best.size };
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    this.a.push(node);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].f <= this.a[i].f) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p;
    }
  }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.a.length && this.a[l].f < this.a[m].f) m = l;
        if (r < this.a.length && this.a[r].f < this.a[m].f) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i = m;
      }
    }
    return top;
  }
}

function aStar(graph, start, goal, avoidSteps) {
  const { adj, coord } = graph;
  if (!coord.has(start) || !coord.has(goal)) return null;
  const gTo = coord.get(goal);
  // Heuristic must never overestimate, or A* silently returns a non-optimal
  // route. Straight-line metres cannot exceed a path made of metres.
  const h = id => metres(coord.get(id), gTo);

  const g = new Map([[start, 0]]), came = new Map(), done = new Set();
  const open = new Heap();
  open.push({ id: start, f: h(start) });

  while (open.size) {
    const cur = open.pop();
    if (cur.id === goal) break;
    if (done.has(cur.id)) continue;
    done.add(cur.id);
    for (const e of adj.get(cur.id) || []) {
      if (!coord.has(e.to)) continue;
      const cost = e.w * (avoidSteps && e.steps ? STEP_PENALTY : 1);
      const ng = g.get(cur.id) + cost;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng); came.set(e.to, cur.id);
        open.push({ id: e.to, f: ng + h(e.to) });
      }
    }
  }
  if (!came.has(goal) && start !== goal) return null;

  const ids = [goal];
  while (ids[0] !== start) ids.unshift(came.get(ids[0]));
  const line = ids.map(id => coord.get(id));
  let len = 0, steps = false;
  for (let i = 0; i < ids.length - 1; i++) {
    len += metres(line[i], line[i + 1]);
    const e = (adj.get(ids[i]) || []).find(x => x.to === ids[i + 1]);
    if (e && e.steps) steps = true;
  }
  return { line, metres: len, usesSteps: steps };
}

  return { metres, ringOf, centroid, inRing, buildGraph, Heap, aStar,
           STEP_PENALTY };
});
