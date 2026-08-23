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
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "campus.osm.json")

# Ways a person can walk along. Everything else (motorway, raceway...) is kept
# in the file but flagged walkable=False so we can still draw roads.
WALKABLE = {
    "footway", "path", "steps", "pedestrian", "cycleway", "track", "corridor",
    "service", "residential", "living_street", "unclassified", "tertiary",
    "secondary", "primary", "road",
}
# Tags worth shipping to the browser; the rest is noise that bloats the payload.
KEEP = ("name", "alt_name", "short_name", "building", "amenity", "highway",
        "surface", "wheelchair", "entrance", "access", "foot", "ref",
        "addr:housenumber", "addr:street", "operator", "incline",
        "handrail", "step_count", "covered", "tunnel", "bridge", "layer")


def keep_tags(tags):
    return {k: v for k, v in tags.items() if k in KEEP}


def main():
    if not os.path.exists(SRC):
        sys.exit("missing %s — run scripts/fetch-osm.sh first" % SRC)
    with open(SRC) as fh:
        elements = json.load(fh)["elements"]

    # Standalone tagged nodes only — ways carry their own inline geometry now.
    nodes = {e["id"]: (e["lon"], e["lat"])
             for e in elements if e["type"] == "node" and "lat" in e}
    buildings, paths, entrances = [], [], []

    for e in elements:
        tags = e.get("tags") or {}

        if e["type"] == "node" and "entrance" in tags:
            entrances.append({
                "type": "Feature",
                "id": "n%d" % e["id"],
                "properties": keep_tags(tags),
                "geometry": {"type": "Point", "coordinates": list(nodes[e["id"]])},
            })

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
                "properties": keep_tags(tags),
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })
        elif "highway" in tags:
            paths.append({
                "type": "Feature",
                "id": "w%d" % e["id"],
                "properties": dict(keep_tags(tags),
                                   walkable=tags["highway"] in WALKABLE,
                                   nodes=refs),
                "geometry": {"type": "LineString", "coordinates": coords},
            })

    for name, feats in (("buildings", buildings), ("paths", paths),
                        ("entrances", entrances)):
        dest = os.path.join(ROOT, "data", name + ".geojson")
        with open(dest, "w") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh)
        print("%-20s %5d features  %6.1f KB" %
              (name + ".geojson", len(feats), os.path.getsize(dest) / 1024.0))


if __name__ == "__main__":
    main()
