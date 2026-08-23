#!/usr/bin/env python3
"""Connectivity + completeness audit of the OSM campus extract.

Answers the two questions that decide whether the router works:
  1. Is the footpath network one connected blob, or islands?
  2. Where does a path dead-end within a few metres of another path it should
     join? (Those are the phantom disconnections that cause "no route found".)

Writes data/audit.md (punch list for mappers) and data/audit.json (CI guardrail).
Stdlib only.
"""
import json, math, os, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda *p: os.path.join(ROOT, "data", *p)
NEAR_MISS_M = 8.0          # dead-end this close to a foreign path = suspect
PHASE1_BUILDINGS = ["Trone", "Daniel Dining", "Timmons", "Hartness", "Plyler"]


def load(name):
    with open(D(name)) as fh:
        return json.load(fh)["features"]


def meters(a, b):
    """Haversine. lon/lat in degrees."""
    R = 6371008.8
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def point_seg_m(p, a, b):
    """Approx distance point→segment, flat-earth at campus scale."""
    kx = 111320.0 * math.cos(math.radians(p[1]))
    ky = 110540.0
    px, py = p[0] * kx, p[1] * ky
    ax, ay = a[0] * kx, a[1] * ky
    bx, by = b[0] * kx, b[1] * ky
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


class DSU:
    def __init__(self): self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb: self.p[ra] = rb


def main():
    paths = [f for f in load("paths.geojson") if f["properties"].get("walkable")]
    buildings = load("buildings.geojson")
    entrances = load("entrances.geojson")

    # --- graph ------------------------------------------------------------
    coord, deg, dsu = {}, defaultdict(int), DSU()
    edges = 0
    total_m = 0.0
    for f in paths:
        ids, cs = f["properties"]["nodes"], f["geometry"]["coordinates"]
        if len(ids) != len(cs):        # a ref fell outside the bbox
            continue
        for nid, c in zip(ids, cs):
            coord[nid] = c
        for i in range(len(ids) - 1):
            a, b = ids[i], ids[i + 1]
            dsu.union(a, b)
            deg[a] += 1; deg[b] += 1
            total_m += meters(cs[i], cs[i + 1])
            edges += 1

    comps = defaultdict(list)
    for nid in coord:
        comps[dsu.find(nid)].append(nid)
    sizes = sorted(comps.values(), key=len, reverse=True)
    main_comp = set(sizes[0]) if sizes else set()

    # --- near-miss dead ends ---------------------------------------------
    dead = [n for n in coord if deg[n] == 1]
    segs = []
    for f in paths:
        ids, cs = f["properties"]["nodes"], f["geometry"]["coordinates"]
        if len(ids) != len(cs):
            continue
        for i in range(len(cs) - 1):
            segs.append((ids[i], ids[i + 1], cs[i], cs[i + 1]))

    near = []
    for n in dead:
        p, cn = coord[n], dsu.find(n)
        best = None
        for a, b, ca, cb in segs:
            if a == n or b == n or dsu.find(a) == cn:   # same blob: not a gap
                continue
            if abs(ca[0] - p[0]) > 0.0002 or abs(ca[1] - p[1]) > 0.0002:
                continue                                # cheap bbox reject
            d = point_seg_m(p, ca, cb)
            if d <= NEAR_MISS_M and (best is None or d < best[0]):
                best = (d, a)
        if best:
            near.append({"node": n, "gap_m": round(best[0], 1),
                         "lat": p[1], "lon": p[0]})
    near.sort(key=lambda x: x["gap_m"])

    # --- completeness -----------------------------------------------------
    named = [f for f in buildings if f["properties"].get("name")]
    steps = [f for f in paths if f["properties"].get("highway") == "steps"]
    names_lower = " | ".join(f["properties"]["name"].lower() for f in named)
    missing = [b for b in PHASE1_BUILDINGS if b.lower() not in names_lower]
    isolated = [c for c in sizes[1:]]

    stats = {
        "buildings": len(buildings), "buildings_named": len(named),
        "entrances": len(entrances), "steps_ways": len(steps),
        "walkable_ways": len(paths), "graph_nodes": len(coord),
        "graph_edges": edges, "network_km": round(total_m / 1000.0, 2),
        "junctions": sum(1 for n in coord if deg[n] > 2),
        "dead_ends": len(dead), "components": len(sizes),
        "largest_component_nodes": len(main_comp),
        "largest_component_pct": round(100.0 * len(main_comp) / max(1, len(coord)), 1),
        "orphan_islands": len(isolated),
        "orphan_nodes": sum(len(c) for c in isolated),
        "near_miss_gaps": len(near),
        "phase1_buildings_still_unnamed": missing,
    }
    with open(D("audit.json"), "w") as fh:
        json.dump({"stats": stats, "gaps": near[:60]}, fh, indent=2)

    # --- punch list -------------------------------------------------------
    L = []
    w = L.append
    w("# OSM campus data audit\n")
    w("_Generated by `scripts/audit.py` from the current Overpass extract._\n")
    w("## Network\n")
    w("| Metric | Value |")
    w("|---|---|")
    for k in ("walkable_ways", "network_km", "graph_nodes", "graph_edges",
              "junctions", "dead_ends", "components",
              "largest_component_nodes", "largest_component_pct",
              "orphan_islands", "orphan_nodes", "near_miss_gaps"):
        w("| %s | %s |" % (k.replace("_", " "), stats[k]))
    w("\n## Completeness\n")
    w("| Metric | Value |")
    w("|---|---|")
    for k in ("buildings", "buildings_named", "entrances", "steps_ways"):
        w("| %s | %s |" % (k.replace("_", " "), stats[k]))
    if missing:
        w("\n**Still unnamed in OSM (Phase 1):** " + ", ".join(missing))

    if isolated:
        w("\n## Orphan path islands (%d)\n" % len(isolated))
        w("Routing drops these — a path here can't be reached from the rest of campus.\n")
        w("| Nodes | Go look |")
        w("|---|---|")
        for c in isolated[:25]:
            lon, lat = coord[c[0]]
            w("| %d | [%.5f, %.5f](https://www.openstreetmap.org/#map=19/%.5f/%.5f) |"
              % (len(c), lat, lon, lat, lon))

    if near:
        w("\n## Near-miss gaps (%d) — highest-value fixes\n" % len(near))
        w("A path dead-ends within %.0f m of a path it never joins. Almost always a"
          " missing shared node; each fix can reconnect a whole island.\n" % NEAR_MISS_M)
        w("| Gap | Go look |")
        w("|---|---|")
        for g in near[:30]:
            w("| %.1f m | [%.5f, %.5f](https://www.openstreetmap.org/#map=20/%.5f/%.5f) |"
              % (g["gap_m"], g["lat"], g["lon"], g["lat"], g["lon"]))

    with open(D("audit.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")

    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
