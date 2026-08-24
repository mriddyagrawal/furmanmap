# Furman Wayfinder — stack cheat-sheet

_Survey phase, Aug 2026. Architecture: static single-page app, no backend for v0. Routing runs client-side._

## Frontend

| Piece | Pick | Alternatives | Why |
|---|---|---|---|
| Map engine | MapLibre GL JS | Leaflet (simpler, raster-y); OpenLayers (heavier API) | Open Mapbox-GL fork; world→campus zoom, rotation, vector styling |
| UI | Vanilla JS or Svelte | React (only if collaborators prefer) | It's one page — a framework is optional weight |
| Search | Fuse.js | MiniSearch | Fuzzy match + alias table ("DH" → Daniel Dining Hall) over ~60 names |
| Geometry | Turf.js | hand-rolled haversine | lat/lon are angles, not meters: distance, nearest-point, bbox |
| Blue dot | Browser Geolocation API | — | Free, GPS-grade outdoors, needs HTTPS |

**MapLibre is a renderer only.** It ships with zero geography. Content comes from two places:
1. **World background = tiles.** Earth's roads/rivers/labels is a ~90 GB dataset, pre-chopped into millions of squares per zoom level. MapLibre streams only the on-screen squares from a tile server. OpenFreeMap runs that server for free — that's why "zoom out and see the world" works with no backend of ours.
2. **Campus layer = one GeoJSON file.** A text file of shapes (building polygons, path lines, entrance points, each with `name` etc.). A campus's worth is a few hundred KB, sitting next to `index.html`.

## Backend

| Piece | Pick | Alternatives | Why |
|---|---|---|---|
| v0 backend | **None** — GitHub Pages | Cloudflare Pages, Netlify | Free, HTTPS, zero ops |
| Tiles | OpenFreeMap | MapTiler/Stadia free keys; self-host OpenMapTiles + Martin | No API key, no view limits, production-proven since 2024 |
| Routing server (only if outgrown) | openrouteservice hosted API | self-host OSRM (lightest) / Valhalla (elevation, multimodal) | Free quota, foot-walking + wheelchair profiles |
| Dynamic features (later) | PocketBase or Supabase | FastAPI + SQLite | Only needed for user-generated content that must persist between visitors (blocked-path reports, events, reviews). v0 has none. |

## Data

- **Source of truth: OpenStreetMap.** Audit 2026-08-18, campus bbox `34.912,-82.457,34.938,-82.421`: **510** building footprints, **75** named, **320** footway segments, **4** steps, **11** entrance nodes.
- **Extract:** Overpass API → GeoJSON (osmtogeojson). Alt: Geofabrik SC extract + osmium.
- **Edit:** iD (browser), StreetComplete (phone, gamified), JOSM (power tool).
- **Phase-1 fixes:** name Trone Student Center, Daniel Dining Hall, Timmons Arena, Hartness Pavilion, PAC, Plyler Hall (as its own name within the Townes complex); add entrance nodes to top ~30 buildings; map staircases; check path connectivity.
- **Team model:** Mridul builds the app; GIS club contributes field data *into OSM* (entrances, stairs, names, path gaps — no building access needed, StreetComplete/iD); the app continuously re-pulls from OSM. Classrooms = indoor phase (needs floor plans + Simple Indoor Tagging), deferred.
- **Indoor later:** Simple Indoor Tagging + indoorequal.

## Algorithms (all client-side in v0)

- **Nodes are not declared and are not one-per-meter.** OSM already stores each path as an ordered list of coordinates — a point at every bend, and a *shared* point where two paths meet. Those existing vertices *are* the nodes. Furman ≈ a few thousand vertices, a few hundred real junctions. Buildings are not nodes; they get snapped.
- **Graph build:** walk each way's vertex list, emit an edge per consecutive pair, weight = haversine meters; junctions emerge where ways share a vertex; **keep only the largest connected component** (two sidewalks drawn crossing without a shared vertex look disconnected → "no route found"). ~50 LOC, runs at page load in milliseconds — or free via `geojson-path-finder` (GeoJSON in → routes out).
- **Routing: `ngraph.path` A\*** (16 KB browser build), with our OSM-node-id graph, a straight-line-metres heuristic, and a weight function. Chosen over `geojson-path-finder` after measuring both: they agree to within 0.00 m on real campus routes, but path-finder keys vertices by rounded *coordinate* rather than node id and ships no browser build. **Accessible mode** = a ×12 weight on `highway=steps` edges — a penalty, not a ban, so a stairs-only destination still routes with a warning instead of stranding someone.
- **Snapping:** destination building → its entrance node if mapped, else nearest graph node to centroid; blue dot → nearest graph node; dashed leader line for the last few meters to the door.
- **Walk time:** distance ÷ ~80 m/min.
- **QA tool (not part of the app):** OSMnx (Python, peer-reviewed) — pull Furman's walk network, detect disconnected islands / dead ends *before* building, fix in OSM, re-run. Also the citable methodology reference for fellowship applications.

**v0 dependencies:** MapLibre + Turf + Fuse + ngraph.graph/ngraph.path, all as CDN UMD bundles — no bundler, no build step. Our own code is the OSM-node-id graph build, component filtering, snapping, and UI. $0 running cost.

## The whole build in one sentence

Fetch Furman's buildings + paths from OSM as GeoJSON → render on MapLibre over OpenFreeMap tiles → build a graph from the path vertices (keep largest connected component) → snap start/end (entrance or centroid; blue dot) → A* with a stairs filter → Fuse search → distance ÷ 80 m/min → ship as static files to GitHub Pages.

## Prior art & community (researched 2026-08-23)

- **NavigaTUM** — [github.com/TUM-Dev/navigatum](https://github.com/TUM-Dev/navigatum), live at nav.tum.de. Open-source campus navigation that replaced TUM's official Roomfinder. Built by a student **club** (OpenSource @ TUM e.V.), not an individual. Stack: Vue + TypeScript, Rust REST API, PostgreSQL, dedicated typo-tolerant search server, Python data pipeline, MapLibre + self-hosted tiles (Planetiler + Martin), Valhalla routing, Nominatim geocoding, Docker. **Why heavier than ours:** their core problem is server-side room search over tens of thousands of rooms across multiple Munich campuses from official TUM data; ours is single-campus browser-scale geometry. Their stack ≈ what ours grows into if it becomes official. Lesson: long-term maintenance took an organization → plan eventual GIS-club ownership.
- **campus-map-tech** — [github.com/springmeyer/campus-map-tech](https://github.com/springmeyer/campus-map-tech), curated list of university interactive maps and the tech behind each.
- **OSMnx** — [github.com/gboeing/osmnx](https://github.com/gboeing/osmnx), JOSS 2017 + 2025 reference paper. See QA tool above.
- **Community:** YouthMappers (student mapping chapters; OSM US charter project since Dec 2025); community.openstreetmap.org; OSM US Slack; MapLibre GitHub discussions.
- No map/GIS Claude skill exists in the registry as of Aug 2026; consider writing a project skill post-v0.

## Funding paths (researched 2026-08-23)

- **YouthMappers itself = network, training, recognition — not money.** Its USAID-funded fellowships are closed/paused (USAID dissolved 2025; YouthMappers now under OSM US). Don't budget on it.
- **OSM US Microgrants** — active, rolling: up to $200 single event / $500 recurring / $500 education / $500 travel; requires OSM US membership. Right-sized to fund a Furman **mapathon** (data sprint), not development.
- **Strongest lane: Furman internal.** The Shi Institute already funded a fellowship for this exact idea (Walking & Mapping, Vanessa Amasi); plus Furman summer research fellowships and student-government tech funds. A working v0 + faculty sponsor = strong application. Software and hosting cost $0 — funding buys time.
