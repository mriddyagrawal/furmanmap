#!/usr/bin/env python3
"""Convert data/campus.osm.json into the GeoJSON the app actually loads.

Emits three files into data/:
  buildings.geojson  polygons  (tags kept: name, building, addr:*)
  paths.geojson      linestrings, each carrying `nodes` = the OSM node ids it
                     runs through. Those shared ids ARE the routing graph's
                     junctions — no coordinate fuzzy-matching needed.
  entrances.geojson  points

Stdlib only, so CI needs no install step.
"""
import datetime, json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "campus.osm.json")

# Ways a person can walk along. Everything else (motorway, raceway...) is kept
# in the file but flagged walkable=False so we can still draw roads.
#
# Type is only half the question: OSM records access on a separate axis, so a
# perfectly ordinary service road can be someone's private drive. Routing over
# those sends people through places they may not walk.
BLOCKED_ACCESS = {"private", "no", "customers", "permit"}

WALKABLE = {
    "footway", "path", "steps", "pedestrian", "cycleway", "track", "corridor",
    "service", "residential", "living_street", "unclassified", "tertiary",
    "secondary", "primary", "road",
}
# Tags worth shipping to the browser; the rest is noise that bloats the payload.
# healthcare, leisure, tourism and man_made carry the categories that make a
# campus legible — a health centre, a sports hall, the bell tower — and none of
# them fit under `amenity`. Keeping them means a tag added in OSM shows up here
# on the next refresh with no code change.
KEEP = ("name", "alt_name", "short_name", "old_name", "building", "amenity",
        "healthcare", "leisure", "tourism", "man_made", "historic", "highway",
        "surface", "wheelchair", "entrance", "access", "foot", "ref",
        "addr:housenumber", "addr:street", "operator", "incline",
        "handrail", "step_count", "covered", "tunnel", "bridge", "layer")


def ring_area_m2(ring):
    """Rough planar area. Only used to rank labels, so precision is irrelevant —
    what matters is that Duke Library outranks a shed."""
    if len(ring) < 4:
        return 0.0
    lat = sum(c[1] for c in ring) / len(ring)
    kx = 111320.0 * math.cos(math.radians(lat))
    ky = 110540.0
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[i + 1][0] * kx, ring[i + 1][1] * ky
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def keep_tags(tags):
    return {k: v for k, v in tags.items() if k in KEEP}


def is_walkable(tags):
    """Only the type decides walkability. Permission is graded, not binary."""
    return tags.get("highway") in WALKABLE


def restriction(tags):
    """How discouraged is this way on foot?

    `foot=no` is a genuine ban and the router must not use it. `access=private`
    without a `foot` tag is ambiguous on a campus, where it usually means "no
    public vehicles" rather than "no pedestrians" — excluding those outright
    stranded 145 nodes people plainly do walk to. They are penalised instead, so
    a route avoids them when an alternative exists and still exists when none
    does, which is the same treatment stairs get.
    """
    foot = tags.get("foot")
    if foot in ("no", "private"):
        return "banned"
    if foot in ("yes", "designated", "permissive"):
        return None                       # explicit foot access settles it
    if tags.get("access") in BLOCKED_ACCESS:
        return "discouraged"
    return None


def rings_from_members(members, role):
    """Stitch a multipolygon relation's member ways into closed rings.

    A relation's outline is often split across several ways that only join end
    to end, in arbitrary order and direction — so they have to be chained, not
    concatenated. Buildings mapped this way (a courtyard, a complex sharing an
    outline) are invisible to any query that looks only at ways, which is how
    Trone, Daniel Dining, Timmons, Hartness and Plyler were all reported as
    "missing from OSM" when they were mapped the whole time.
    """
    segs = [[[g["lon"], g["lat"]] for g in (m.get("geometry") or [])]
            for m in members
            if m.get("type") == "way" and m.get("role") == role]
    segs = [s for s in segs if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        joined = True
        while ring[0] != ring[-1] and joined:
            joined = False
            for i, seg in enumerate(segs):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = seg[:0:-1] + ring
                else:
                    continue
                segs.pop(i)
                joined = True
                break
        if ring[0] != ring[-1]:
            ring.append(ring[0])          # unclosed in OSM; close it rather than drop it
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def contains(ring, pt):
    """Ray-cast point-in-ring, to attach each hole to the right outer ring."""
    x, y = pt
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) / (y2 - y1) * (x2 - x1):
            inside = not inside
    return inside


def polygon_from_relation(rel):
    outers = rings_from_members(rel.get("members") or [], "outer")
    inners = rings_from_members(rel.get("members") or [], "inner")
    if not outers:
        return None
    parts = [[o] for o in outers]
    for hole in inners:
        for part in parts:
            if contains(part[0], hole[0]):
                part.append(hole)
                break
    if len(parts) == 1:
        return {"type": "Polygon", "coordinates": parts[0]}
    return {"type": "MultiPolygon", "coordinates": parts}


def main():
    if not os.path.exists(SRC):
        sys.exit("missing %s — run scripts/fetch-osm.sh first" % SRC)
    with open(SRC) as fh:
        elements = json.load(fh)["elements"]

    # Standalone tagged nodes only — ways carry their own inline geometry now.
    nodes = {e["id"]: (e["lon"], e["lat"])
             for e in elements if e["type"] == "node" and "lat" in e}

    # Campus outline, used to mark what is on campus. Features are never
    # dropped by it — the app and the audit decide what to do with the flag.
    boundary = None
    for e in elements:
        t = e.get("tags") or {}
        if e["type"] == "relation" and t.get("amenity") == "university" \
           and t.get("name") == "Furman University":
            geom = polygon_from_relation(e)
            if geom:
                boundary = ([geom["coordinates"][0]] if geom["type"] == "Polygon"
                            else [p[0] for p in geom["coordinates"]])
                with open(os.path.join(ROOT, "data", "boundary.geojson"), "w") as fh:
                    json.dump({"type": "FeatureCollection", "features": [{
                        "type": "Feature", "properties": {"name": "Furman University"},
                        "geometry": geom}]}, fh)
    if boundary is None:
        print("!! campus boundary not found — on_campus flags will all be true")

    def on_campus(pts):
        if boundary is None:
            return True
        return any(any(contains(r, pt) for r in boundary) for pt in pts)
    buildings, paths, entrances = [], [], []

    for e in elements:
        tags = e.get("tags") or {}

        if e["type"] == "node" and "entrance" in tags:
            entrances.append({
                "type": "Feature",
                "id": "n%d" % e["id"],
                "properties": dict(keep_tags(tags),
                                   on_campus=on_campus([nodes[e["id"]]])),
                "geometry": {"type": "Point", "coordinates": list(nodes[e["id"]])},
            })

        if e["type"] == "relation" and tags.get("amenity") == "university":
            continue

        if e["type"] == "relation" and tags.get("building"):
            geom = polygon_from_relation(e)
            if geom:
                buildings.append({
                    "type": "Feature",
                    "id": "r%d" % e["id"],
                    "properties": dict(keep_tags(tags),
                                       on_campus=on_campus(geom["coordinates"][0]
                                                           if geom["type"] == "Polygon"
                                                           else geom["coordinates"][0][0]),
                                       area=round(ring_area_m2(
                                           geom["coordinates"][0] if geom["type"] == "Polygon"
                                           else geom["coordinates"][0][0]))),
                    "geometry": geom,
                })
            continue

        if e["type"] != "way":
            continue
        # `out geom` gives coordinates inline; `nodes` stays the id list that
        # makes shared-vertex junction detection exact.
        refs = e.get("nodes") or []
        coords = [[g["lon"], g["lat"]] for g in (e.get("geometry") or []) if g]
        if len(coords) < 2:
            continue

        if "building" in tags:
            ring = coords if coords[0] == coords[-1] else coords + [coords[0]]
            if len(ring) < 4:
                continue
            buildings.append({
                "type": "Feature",
                "id": "w%d" % e["id"],
                "properties": dict(keep_tags(tags), on_campus=on_campus(ring),
                                   area=round(ring_area_m2(ring))),
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })
        elif "highway" in tags:
            paths.append({
                "type": "Feature",
                "id": "w%d" % e["id"],
                "properties": dict(keep_tags(tags),
                                   walkable=is_walkable(tags),
                                   restriction=restriction(tags),
                                   on_campus=on_campus(coords),
                                   nodes=refs),
                "geometry": {"type": "LineString", "coordinates": coords},
            })

    # A tiny file the app can read to say how fresh the map is. The date that
    # matters to someone using it is when the OSM data was pulled, not when the
    # code was built — the map is only as current as its last refresh.
    meta = {
        "generated": datetime.datetime.now(datetime.timezone.utc)
                             .strftime("%Y-%m-%d"),
        "buildings": len(buildings), "paths": len(paths),
        "entrances": len(entrances),
    }
    with open(os.path.join(ROOT, "data", "meta.json"), "w") as fh:
        json.dump(meta, fh)
    print("%-20s %s" % ("meta.json", meta["generated"]))

    for name, feats in (("buildings", buildings), ("paths", paths),
                        ("entrances", entrances)):
        dest = os.path.join(ROOT, "data", name + ".geojson")
        with open(dest, "w") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh)
        print("%-20s %5d features  %6.1f KB" %
              (name + ".geojson", len(feats), os.path.getsize(dest) / 1024.0))


if __name__ == "__main__":
    main()
