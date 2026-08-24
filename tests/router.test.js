/* Router tests. Run: node --test tests/
 *
 * Node's built-in runner, so the repo still needs no install step.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { metres, buildGraph, aStar, inRing, centroid } = require('../graph.js');

const D = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f)));

/* ---------- a toy network with a hand-computed answer ----------
 *
 * The point of a fixture is that a bug in the graph code cannot hide behind
 * plausible-looking output. These distances are checkable by hand.
 *
 *   A ---- B ---- C        top route:  A-B-C, two 100 m hops
 *   |             |        detour:     A-D-E-C, three ~100 m hops
 *   D ---- E ------        the A-B-C hop via B is stairs
 */
const M = 0.0009;                       // ~100 m of latitude
const toy = (stairsOnTop) => [
  way(['A', 'B'], [[0, 0], [0, M]], stairsOnTop ? 'steps' : 'footway'),
  way(['B', 'C'], [[0, M], [0, 2 * M]], stairsOnTop ? 'steps' : 'footway'),
  way(['A', 'D'], [[0, 0], [M, 0]]),
  way(['D', 'E'], [[M, 0], [M, M]]),
  way(['E', 'C'], [[M, M], [0, 2 * M]]),
];
function way(nodes, coordinates, highway = 'footway') {
  return { properties: { nodes, highway, walkable: true },
           geometry: { type: 'LineString', coordinates } };
}

test('toy: finds the two-hop route and its length', () => {
  const g = buildGraph(toy(false));
  const r = aStar(g, 'A', 'C', false);
  assert.ok(r, 'a route exists');
  assert.deepStrictEqual(r.line.length, 3, 'A-B-C is three points');
  const expected = metres([0, 0], [0, M]) + metres([0, M], [0, 2 * M]);
  assert.ok(Math.abs(r.metres - expected) < 0.5, `${r.metres} ~= ${expected}`);
});

test('toy: step-free mode takes the longer stair-free detour', () => {
  const g = buildGraph(toy(true));
  const direct = aStar(g, 'A', 'C', false);
  const free = aStar(g, 'A', 'C', true);
  assert.ok(direct.usesSteps, 'the short way is stairs');
  assert.ok(!free.usesSteps, 'step-free route avoids them');
  assert.ok(free.metres > direct.metres, 'and pays for it in distance');
});

test('toy: a stairs-only destination still routes, flagged', () => {
  // Avoid must degrade, never strand: STEP_PENALTY is a multiplier, not a ban.
  const g = buildGraph([way(['A', 'B'], [[0, 0], [0, M]], 'steps')]);
  const r = aStar(g, 'A', 'B', true);
  assert.ok(r && r.usesSteps, 'route returned and honestly flagged');
});

test('unreachable target returns null, does not throw', () => {
  const g = buildGraph([way(['A', 'B'], [[0, 0], [0, M]])]);
  assert.strictEqual(aStar(g, 'A', 'ZZ', false), null);
});

test('haversine matches the spherical model it promises', () => {
  // A degree of latitude is 111195 m on a sphere of radius 6371008.8 m, and
  // 110574 m on the WGS84 ellipsoid. We use the sphere deliberately: the 0.56%
  // overestimate is 1.7 m across a 300 m campus walk, well inside the error of
  // the walking-speed constant it feeds. Assert the model we actually use, not
  // the one that sounds more precise.
  assert.ok(Math.abs(metres([0, 0], [0, 1]) - 111195) < 50);
  assert.strictEqual(Math.round(metres([0, 0], [0, 0])), 0);

  // Greenville SC -> Columbia SC, ~154 km by great circle.
  const d = metres([-82.394, 34.852], [-81.035, 34.001]) / 1000;
  assert.ok(d > 148 && d < 160, `${d.toFixed(1)} km`);
});

/* ---------- against the real campus extract ---------- */

const paths = D('paths.geojson').features
  .filter(f => f.properties.on_campus && f.properties.walkable);
const buildings = D('buildings.geojson').features
  .filter(f => f.properties.on_campus && f.properties.name);
const graph = buildGraph(paths);

const nearest = pt => {
  let best = null, bd = Infinity;
  for (const [id, c] of graph.coord) {
    const d = metres(pt, c);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
};
const nodeFor = name => {
  const b = buildings.find(f => f.properties.name.toLowerCase().includes(name));
  assert.ok(b, `building "${name}" is in the extract`);
  return nearest(centroid(b.geometry));
};

test('campus graph is one connected component', () => {
  assert.ok(graph.size > 3000, `largest component has ${graph.size} nodes`);
});

test('A* is optimal — matches Dijkstra on real campus pairs', () => {
  // An inadmissible heuristic silently returns non-optimal routes that look
  // perfectly reasonable on a map. This is the only test that catches that.
  const dijkstra = (start, goal) => {
    const dist = new Map([[start, 0]]), done = new Set();
    const q = [[0, start]];
    while (q.length) {
      q.sort((a, b) => a[0] - b[0]);
      const [d, id] = q.shift();
      if (done.has(id)) continue;
      done.add(id);
      if (id === goal) return d;
      for (const e of graph.adj.get(id) || []) {
        if (!graph.coord.has(e.to)) continue;
        const nd = d + e.w;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); q.push([nd, e.to]); }
      }
    }
    return null;
  };
  for (const [a, b] of [['riley', 'duke'], ['trone', 'daniel chapel']]) {
    const r = aStar(graph, nodeFor(a), nodeFor(b), false);
    const d = dijkstra(nodeFor(a), nodeFor(b));
    assert.ok(r && d, `${a} -> ${b} routes`);
    assert.ok(Math.abs(r.metres - d) < 1, `${a}->${b}: A* ${r.metres} vs Dijkstra ${d}`);
  }
});

test('routes are symmetric', () => {
  const a = nodeFor('riley'), b = nodeFor('trone');
  const ab = aStar(graph, a, b, false), ba = aStar(graph, b, a, false);
  assert.ok(Math.abs(ab.metres - ba.metres) < 1);
});

test('golden routes stay plausible for a walkable campus', () => {
  // Not exact distances — those get baselined once the data settles. This
  // catches the failure that matters now: a route that silently goes absurd.
  for (const [a, b] of [['riley', 'duke'], ['trone', 'timmons'], ['duke', 'daniel chapel']]) {
    const r = aStar(graph, nodeFor(a), nodeFor(b), false);
    assert.ok(r, `${a} -> ${b} has a route`);
    assert.ok(r.metres > 20 && r.metres < 3000, `${a} -> ${b} is ${Math.round(r.metres)} m`);
  }
});
