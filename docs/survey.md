# Making Furman Walkable
## Survey & plan for a Bond-style interactive campus map

_Prepared August 18, 2026 · "Mapping Furman" project · Survey/planning phase — no build yet._

---

## 1. What Bond University actually has (verified hands-on)

Bond's map at [bond.edu.au/contact/campus-map](https://bond.edu.au/contact/campus-map) is not something Bond built — it's an embedded iframe of **[MazeMap](https://www.mazemap.com/)** (`use.mazemap.com`, Bond is campus #388). MazeMap is a Norwegian indoor-mapping company out of NTNU Trondheim that sells campus wayfinding as a subscription to universities, hospitals, and offices.

What the product does: search indexes every room down to identifiers like `BLD09_2_38`. A floor selector switches the whole campus between levels 1–8, redrawing every interior — rooms, corridors, stairs, elevators, toilets, even printers and water bubblers. Click any room → Directions. Arch Building → Student Centre returned 3 minutes: "Exit building → Walk 67 m → Enter building → Walk 116 m", a blue line flowing from indoor corridors through outdoor paths and back indoors, turn-by-turn instructions, walk/bike/drive/transit modes, and an **"Avoid stairs and obstacles"** toggle. With location enabled, a live blue dot.

**How the trick works — and why zooming out shows the whole world.** The renderer is Mapbox GL (the map carries a "© mapbox" attribution), a WebGL vector-tile engine. The base layer is a *global* map — MazeMap's FAQ says they "integrate with OpenStreetMap" for all outdoor areas — so the world is simply *there* when you zoom out. The hyper-detailed Bond overlay is a separate set of layers from `api.mazemap.com` that render only at campus zooms. That overlay is generated from the university's own **CAD floor plans (.dwg)**, which MazeMap ingests — that's the entire onboarding requirement. So: Bond's facilities team handed architectural drawings to a SaaS vendor and pays an annual quote-based license (no free tier, no public pricing). Bond's library separately runs [LibCal maps](https://bond.edu.au/library/library-news/blog/find-your-way-bond-librarys-interactive-maps) for bookable study rooms — "the campus map" at a real university is usually several systems.

**Nothing about it is magic:** a global OSM-based vector basemap + a campus data overlay + a routing graph + a polished UI. Every piece exists in open source.

## 2. What Furman has today

**[campusmap.furman.edu](https://campusmap.furman.edu/)** exists — a Google Maps API mashup: styled basemap, purple pin markers by category (Buildings, Student Housing, Athletic Facilities, Visitor Parking, Entrances, Emergency Kits), and a search box. Markers identify Riley Hall (RLY), James B. Duke Library, Trone Student Center (TSC), Furman Hall (FUR). But **no routing, no walking paths, no indoor anything, no blue dot**. It answers "where is Riley Hall?" but not "how do I get there from here?" — exactly the freshman-week problem. There's also the static [PDF campus map](https://www.furman.edu/wp-content/uploads/sites/174/2020/03/Campus-Map.pdf).

**Someone at Furman already wants this map.** The Shi Institute ran a fellowship project, ["Walking & Mapping: Reimagine Furman's Campus with a New Map"](https://www.furman.edu/shi-institute/walking-mapping-reimagine-furmans-campus-with-a-new-map/), led by sustainability student Vanessa Amasi, explicitly aiming for a map that can "calculate distances, find convenient routes to take, and direct you to different places around Furman." They field-mapped trails and sidewalks and processed the data in GIS with a newly formed **GIS club**. Furman also has an active ArcGIS Online presence — Esri licenses and GIS-literate people are on campus. Natural allies, and a possible source of already-collected sidewalk data.

## 3. Data audit — OpenStreetMap already has most of the campus

| What | Count in campus bbox |
|---|---|
| Building footprints | **510** |
| Buildings with names | **75** (~60 on campus proper; rest are fringe — Walmart, churches across US-276) |
| Footway segments | **320** |
| Steps (staircases) | 4 |
| Building entrance nodes | 11 |

Already named: Riley Hall, James Buchanan Duke Library, Townes Center for Science, the Bell Tower, Daniel Chapel, Daniel Music Building, Roe Art Building, McAlister Auditorium, Younts Conference Center, Alester G Furman Administration, Farmer Hall, Estridge Commons, Cherrydale House, Furman Theatre, Place of Peace, Thoreau Cabin, Cliffs Cottage, Herring Center, the South Housing halls (Blackwell, Poteat, Geer, Manly, McGlothlin, Judson, Chiles, Gambrell, Ramsay, Haynsworth, McBee, Townes, Furman Hall, Johns Hall), Montague Village, The Woodlands, Mickel Tennis Center, North Village blocks A–K. The footpath network is dense — the mall, the lake trail, the Swamp Rabbit Trail connection, and most sidewalks are traced.

**Gaps (all fixable in a weekend of OSM editing):**
- **Missing names on key buildings:** Trone Student Center, Daniel Dining Hall, Timmons Arena, Hartness Pavilion, the PAC (footprints likely exist, unnamed). **Plyler Hall** isn't individually labeled — it's part of the Townes complex and needs its own name so "route me to Plyler" works.
- **Entrances barely mapped** (11 campus-wide). Entrance nodes are what make "walk to the door" feel right vs. "walk to the centroid."
- **Steps almost unmapped** (4). Mapping staircases is what makes an "avoid stairs" toggle possible.
- North Village blocks named only by letter; could carry full names/aliases for search.

Fixing this in OSM (iD in-browser, or StreetComplete while literally walking campus) is free, needs no permission from anyone, immediately improves Apple Maps and every OSM consumer, and gives the map a permanently maintained public data home. Highest-leverage prep work there is.

## 4. The options

### Option A — Buy it like Bond did (commercial SaaS)

| Vendor | Notes |
|---|---|
| [MazeMap](https://www.mazemap.com/industries/educational-institutions) | What Bond uses. Education-native (timetable/room-booking integrations). Input: CAD .dwg. Quote-based, no free tier. |
| [Concept3D](https://concept3d.com/use-cases/higher-education/interactive-campus-maps/) | US higher-ed incumbent (maps + 3D + virtual tours). Starter (2D) / Professional (wayfinding) / Advanced (interiors, API). Quote-based. |
| [Mappedin](https://www.mappedin.com/resources/blog/best-campus-wayfinding-software/) / MapsIndoors / Pointr | Indoor vendors that also serve campuses; Pointr is beacon-hardware-heavy and premium. |
| [ArcGIS Indoors](https://www.esri.com/en-us/arcgis/products/arcgis-indoors/overview) | Esri's floor-aware stack. Relevant since Furman has Esri licensing — but facilities-management flavored, heavy GIS lift. |

This is the path to *institutional* indoor wayfinding — a procurement decision by Facilities/IT with a real annual budget, not something a student ships. Treat Option A as the end state to **pitch**, not the starting point.

### Option B — Build on open source (recommended for v0)

- **Renderer: [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)** — BSD-3 community fork of Mapbox GL JS, same engine class MazeMap renders with. v5.24.0 shipped April 2026; 11k+ stars.
- **Basemap: [OpenFreeMap](https://github.com/hyperknot/openfreemap)** — free hosted OSM vector tiles, **no API key, no view limits**, donation-funded, self-hostable. (Alts: MapTiler/Stadia free keys; self-host [OpenMapTiles](https://openmaptiles.org/).)
- **Campus layer:** Furman buildings/names/paths from OSM via Overpass as GeoJSON, styled Furman purple with our labels, popups, photos.
- **Routing, in order of effort:**
  1. **Client-side A\*** over the footpath network — ~100 lines of our own graph code, or [geojson-path-finder](https://github.com/perliedman/geojson-path-finder). At ~320 segments this is instant, needs **zero servers**, works offline. Delivers the core ask: Riley → Plyler, highlighted path, distance + walk time.
  2. **[openrouteservice](https://openrouteservice.org/)** — free hosted API (HeiGIT Heidelberg) with `foot-walking` **and `wheelchair`** profiles, generous daily quota, real turn-by-turn text.
  3. **Self-hosted [OSRM](https://en.wikipedia.org/wiki/Open_Source_Routing_Machine)/Valhalla/GraphHopper** — industrial strength; an SC-extract OSRM runs on a tiny VM. Overkill until 1 and 2 are outgrown.
- **Blue dot:** browser Geolocation API — free, GPS-accurate outdoors, no SDK. Requires HTTPS (GitHub/Cloudflare Pages give it free).
- **Indoor, later:** OSM [Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging) + [indoorequal](https://github.com/indoorequal/indoorequal.org) to pilot 2–3 buildings with no vendor. ([OpenIndoorMaps](https://github.com/openindoormaps/openindoormaps) is promising but pre-alpha — watch, don't depend.)

**Running cost: $0.** The real spend is hours: OSM cleanup, then the build.

### Should we skip frameworks and code it from scratch?

For the **rendering engine** — no. MapLibre embodies a decade-plus of work (tile protocols, WebGL pipelines, label collision, projections); rebuilding it means months for a worse result, and it's the layer nobody sees as "ours." For the **campus logic** — partially yes: the building directory, path graph, routing UI, and visual identity are small, fun, and worth owning as plain code (the router can be hand-written A* if we want it dependency-free). Framework for the plumbing, from-scratch for the parts that make it Furman's.

## 5. Recommended path

- **Phase 1 — Data sprint (now, ~a weekend + walks).** Fix the OSM gaps: name Trone/Dining Hall/Timmons/Hartness/PAC/Plyler, add main-entrance nodes to the top ~30 buildings, map staircases, sanity-check path connectivity. Ping the Shi Institute / GIS club — their field-collected sidewalk data may be donatable to OSM, and they're future co-maintainers.
- **Phase 2 — Outdoor wayfinder v0 (the deferred build).** Single-page MapLibre app: OpenFreeMap basemap (world-zoomable like Bond's), Furman-purple building overlay with search, tap-any-building destination picking, client-side A* routes with distance/minutes, geolocation blue dot, "route from my location." Free HTTPS hosting. Feature-parity with Bond's *outdoor* experience.
- **Phase 3 — Adoption.** QR codes on building signs and in orientation packets, freshman feedback, "avoid stairs" toggle once steps are mapped, event/POI layers (bell tower, lake trail, dining hours). Parking deferred by design.
- **Phase 4 — Indoor pilot.** Simple Indoor Tagging for Duke Library, Trone, and Townes; indoorequal-style level picker. The moment to request floor plans from Facilities — which doubles as the conversation-starter with the university.
- **Phase 5 — Institutional decision.** If Furman wants official all-building indoor wayfinding, that's a MazeMap/Concept3D/ArcGIS Indoors procurement — and walking into that meeting with a working, student-built, student-loved map is the strongest possible pitch and negotiating position.

## 6. Risks & footnotes

OSM edits are live public data — map accurately, follow community norms. OpenFreeMap explicitly allows unlimited production use, but never point production traffic at raw openstreetmap.org tiles. Browser geolocation is great outdoors, poor indoors (that's what vendors sell beacons for) — fine for our walkable-outdoor scope. campusmap.furman.edu implies someone in Furman IT holds Google Maps API keys today — worth discovering who, both as an ally and to avoid stepping on toes. If the map becomes official-looking, loop in university marketing on branding.

---

## Appendix A — Bond/MazeMap feature checklist (parity targets)

Observed directly: room-level search with building/floor identifiers · floor selector redrawing all interiors (levels 1–8) · click-anything → Directions · continuous indoor↔outdoor routes ("Exit building → Walk 67 m → Enter building") · time + distance estimates · turn-by-turn list · walk/bike/drive/transit modes · "Avoid stairs and obstacles" accessible routing · live blue dot · 2D/3D toggle · shareable deep links (URL encodes campus, floor, POI) · POI layers (toilets, elevators, printers, water bubblers, smoking areas, info points, parking incl. disability bays) · world-map zoom-out on a global OSM/Mapbox basemap. **Phase 2 targets the subset that doesn't require indoor data.**

## Appendix B — OSM named buildings in the campus bbox (75)

Furman University Bell Tower, Jade Express, Townes Center for Science, Furman Hall, D, James Buchanan Duke Library, McGlothlin Hall, Richard W Riley Hall, Hipp Hall, H, Younts Conference Center, Marshall and Vera Lea Rinker Hall, Ramsay Hall, Furman Athletics, McBee Hall, John E Johns Hall, Poteat Hall, I, Chiles Hall, Cherrydale House, E, Gambrell Hall, Estridge Commons, Minor Herndon Mickel Tennis Center, Haynsworth Hall, Charles E Daniel Chapel, Judson Hall, J, Roe Art Building, Geer Hall, Daniel Music Building, Townes Hall, F, Manly Hall, Alester G Furman Administration, A, G, Montague Village, Thomas Spann Farmer Hall, Guardhouse, Guardhouse, Place of Peace, Furman Theatre, B, C, K, Cliffs Cottage, Herring Center for Continuing Education, Thoreau Cabin, McDonald's\*, McAlister Auditorium, Prisma Health Pediatric\*, Walmart Neighborhood Market\*, Bank of Travelers Rest\*, 7-Eleven\*, The Woodlands at Furman (+ Buildings 1–7), University Inn, Paris Mountain Baptist Church\*, Mount Sinai Baptist Church\*, Duncan Chapel Fire Department\*, Redeemer Presbyterian Church\*, Walmart\*, Choice Hills Baptist Church\*, 7-Eleven\*, 7-11\*, Blackwell Hall, Furman University Child Development Center, ModWash\*.

_\* = off-campus fringe inside the query box. Single letters = North Village blocks._

**Notable absences to fix in Phase 1:** Trone Student Center, Daniel Dining Hall, Timmons Arena, Hartness Pavilion, PAC, Plyler Hall (as a labeled part of Townes), named North Village blocks.

## Sources

- Bond/MazeMap: [bond.edu.au/contact/campus-map](https://bond.edu.au/contact/campus-map) · [use.mazemap.com](https://use.mazemap.com/) (campus 388, inspected live) · [MazeMap FAQs](https://www.mazemap.com/about-us/faqs) · [MazeMap for education](https://www.mazemap.com/industries/educational-institutions) · [Bond library LibCal maps](https://bond.edu.au/library/library-news/blog/find-your-way-bond-librarys-interactive-maps)
- Furman today: [campusmap.furman.edu](https://campusmap.furman.edu/) · [Shi Institute Walking & Mapping](https://www.furman.edu/shi-institute/walking-mapping-reimagine-furmans-campus-with-a-new-map/) · [Furman maps & directions](https://www.furman.edu/admissions-aid/visit-furman/maps-and-directions/)
- Data: [OpenStreetMap](https://www.openstreetmap.org/#map=16/34.9245/-82.4392) · Overpass counts via [overpass-turbo.eu](https://overpass-turbo.eu/) (run live, Aug 18 2026)
- Open stack: [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) · [OpenFreeMap](https://github.com/hyperknot/openfreemap) · [OpenMapTiles](https://openmaptiles.org/) · [geojson-path-finder](https://github.com/perliedman/geojson-path-finder) · [openrouteservice](https://openrouteservice.org/) · [Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging) · [indoorequal](https://github.com/indoorequal/indoorequal.org) · [OpenIndoorMaps](https://github.com/openindoormaps/openindoormaps)
- Commercial: [Concept3D higher-ed maps](https://concept3d.com/use-cases/higher-education/interactive-campus-maps/) · [Concept3D pricing](https://concept3d.com/interactive-virtual-experiences/pricing/) · [Mappedin overview](https://www.mappedin.com/resources/blog/best-campus-wayfinding-software/) · [ArcGIS Indoors](https://www.esri.com/en-us/arcgis/products/arcgis-indoors/overview)
