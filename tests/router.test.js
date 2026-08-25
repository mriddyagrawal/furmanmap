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
  //
  // Both must minimise the SAME quantity. The router optimises comfort-weighted
  // cost, not raw metres — a footway is preferred to a parallel service drive —
  // so a Dijkstra run on raw length disagrees by design and proves nothing.
  const dijkstra = (start, goal) => {
    const dist = new Map([[start, 0]]), done = new Set();
    const q = [[0, start]];
    while (q.length) {
      q.sort((a, b) => a[0] - b[0]);
      const [d, id] = q.shift();
      if (done.has(id)) continue;
      done.add(id);
      if (id === goal) return d;
      graph.graph.forEachLinkedNode(id, (other, link) => {
        if (!graph.coord.has(other.id)) return;
        const nd = d + link.data.cost;
        if (nd < (dist.get(other.id) ?? Infinity)) { dist.set(other.id, nd); q.push([nd, other.id]); }
      });
    }
    return null;
  };
  for (const [a, b] of [['riley', 'duke'], ['trone', 'daniel chapel']]) {
    const from = nodeFor(a), to = nodeFor(b);
    const r = aStar(graph, from, to, false);
    const best = dijkstra(from, to);
    assert.ok(r && best, `${a} -> ${b} routes`);
    assert.ok(Math.abs(r.cost - best) < 1,
      `${a}->${b}: A* cost ${r.cost} vs Dijkstra cost ${best}`);
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

/* ---------- follow mode: progress along a route ---------- */

const { progressAlong, bearingAlongRoute, turf } = require('../graph.js');

test('walking a real campus route counts down to zero', () => {
  const route = aStar(graph, nodeFor('riley'), nodeFor('duke'), false);
  const line = turf.lineString(route.line);
  const total = route.metres;

  // Simulate walking it: sample positions along the line every 10 m.
  let prevLeft = Infinity;
  for (let d = 0; d <= total; d += 10) {
    const at = turf.along(line, d, { units: 'meters' }).geometry.coordinates;
    const p = progressAlong(line, total, at);
    assert.ok(p.offBy < 1, `on the line, off by ${p.offBy.toFixed(1)} m`);
    assert.ok(p.left <= prevLeft + 0.5, 'remaining distance never grows while walking forward');
    assert.ok(Math.abs(p.along - d) < 1.5, `at ${d} m the position reads ${p.along.toFixed(1)} m`);
    prevLeft = p.left;
  }
  const end = progressAlong(line, total, route.line[route.line.length - 1]);
  assert.ok(end.left < 1, `arriving leaves ${end.left.toFixed(1)} m, expected ~0`);
});

test('off-route distance is metres, not kilometres', () => {
  // Turf's nearestPointOnLine defaults to KILOMETRES. If that default leaked
  // through, a 50 m detour would report as 0.05 and the off-route warning could
  // never fire. This test exists for that one digit.
  //
  // It deliberately asserts only a lower bound. nearestPointOnLine measures to
  // the whole line, and campus paths wind enough that a point 50 m to one side
  // can be genuinely close to another stretch of the same route — an earlier
  // version of this test asserted an upper bound and broke on an OSM edit that
  // reshaped the path, which told us nothing about units.
  const route = aStar(graph, nodeFor('riley'), nodeFor('duke'), false);
  const line = turf.lineString(route.line);
  const half = route.metres / 2;
  const mid = turf.along(line, half, { units: 'meters' });

  const onLine = progressAlong(line, route.metres, mid.geometry.coordinates);
  assert.ok(onLine.offBy < 1, `a point on the line reads ${onLine.offBy.toFixed(2)} off`);

  const perpendicular = bearingAlongRoute(line, route.metres, half) + 90;
  const aside = turf.destination(mid, 50, perpendicular, { units: 'meters' }).geometry.coordinates;
  const off = progressAlong(line, route.metres, aside).offBy;
  assert.ok(off > 10, `50 m aside reads as ${off.toFixed(2)} — kilometres would give ~0.05`);
  assert.ok(off < 200, `${off.toFixed(1)} is implausibly large for a 50 m step`);
});

test('route bearing points forward, and is stable near the end', () => {
  const route = aStar(graph, nodeFor('riley'), nodeFor('trone'), false);
  const line = turf.lineString(route.line);
  const total = route.metres;
  for (const at of [0, total / 2, total - 5, total]) {
    const b = bearingAlongRoute(line, total, at);
    assert.ok(Number.isFinite(b), `bearing at ${at.toFixed(0)} m is ${b}`);
    assert.ok(b >= -180 && b <= 180, `bearing ${b} is a valid compass value`);
  }
});

/* ---------- compass heading smoothing ---------- */

const { smoothHeading } = require('../graph.js');

test('smoothing crosses the 359/0 boundary without spinning the map', () => {
  // Naive averaging of 350 and 10 gives 180 — the map would swing right round.
  const h = smoothHeading(350, 10);
  assert.ok(h > 350 || h < 20, `350 -> 10 smoothed to ${h.toFixed(1)}, expected near north`);
  const back = smoothHeading(10, 350);
  assert.ok(back > 350 || back < 20, `10 -> 350 smoothed to ${back.toFixed(1)}`);
});

test('smoothing stays in range, starts clean, and converges', () => {
  assert.strictEqual(smoothHeading(undefined, 90), 90, 'first reading is taken as-is');
  assert.strictEqual(smoothHeading(null, 42), 42);
  let h = 0;
  for (let i = 0; i < 60; i++) {
    h = smoothHeading(h, 270);
    assert.ok(h >= 0 && h < 360, `heading ${h} left the valid range`);
  }
  assert.ok(Math.abs(h - 270) < 1, `converged to ${h.toFixed(1)}, expected 270`);
});

test('smoothing damps jitter rather than following it', () => {
  // A single spurious 90-degree spike must not swing the map 90 degrees.
  const moved = Math.abs(smoothHeading(0, 90) - 0);
  assert.ok(moved < 45, `one noisy reading moved the map ${moved.toFixed(1)} degrees`);
});

/* ---------- access and surface preference ---------- */

test('routes prefer a footway over a road running beside it', () => {
  // Furman maps sidewalks as separate ways alongside their roads, so without a
  // preference the router sends people down the middle of service drives.
  const A = [0, 0], B = [0, 0.0018];                 // ~200 m apart
  const mid = [0, 0.0009];
  const net = [
    { properties: { nodes: ['a', 'r', 'b'], highway: 'service', walkable: true },
      geometry: { type: 'LineString', coordinates: [A, mid, B] } },
    // A footway that is deliberately LONGER, via a slight dogleg.
    { properties: { nodes: ['a', 'f', 'b'], highway: 'footway', walkable: true },
      geometry: { type: 'LineString', coordinates: [A, [0.00012, 0.0009], B] } },
  ];
  const g = buildGraph(net);
  const r = aStar(g, 'a', 'b', false);
  assert.ok(r, 'a route exists');
  assert.deepStrictEqual(r.line[1], [0.00012, 0.0009],
    'took the longer footway rather than the shorter road');
});

test('a way banned to pedestrians is not routed over at all', () => {
  const A = [0, 0], B = [0, 0.0018];
  const g = buildGraph([
    { properties: { nodes: ['a', 'b'], highway: 'footway', walkable: true, restriction: 'banned' },
      geometry: { type: 'LineString', coordinates: [A, B] } },
  ]);
  assert.strictEqual(aStar(g, 'a', 'b', false), null, 'foot=no is a ban, not a preference');
});

test('a discouraged way is avoided but still available as a last resort', () => {
  // access=private with no foot tag is ambiguous on a campus. Excluding those
  // outright stranded 145 nodes people plainly do walk to.
  const A = [0, 0], B = [0, 0.0018];
  const only = buildGraph([
    { properties: { nodes: ['a', 'b'], highway: 'service', walkable: true, restriction: 'discouraged' },
      geometry: { type: 'LineString', coordinates: [A, B] } },
  ]);
  assert.ok(aStar(only, 'a', 'b', false), 'still reachable when it is the only way');

  const both = buildGraph([
    { properties: { nodes: ['a', 'b'], highway: 'service', walkable: true, restriction: 'discouraged' },
      geometry: { type: 'LineString', coordinates: [A, B] } },
    { properties: { nodes: ['a', 'd', 'b'], highway: 'footway', walkable: true },
      geometry: { type: 'LineString', coordinates: [A, [0.0004, 0.0009], B] } },
  ]);
  const r = aStar(both, 'a', 'b', false);
  assert.strictEqual(r.line.length, 3, 'took the long way round rather than the private drive');
});
