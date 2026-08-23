# Furman Wayfinder — Master Plan

_Written 2026-08-23. Living document: update the Status column as phases close._

| Phase | What it is | Status |
|---|---|---|
| **0** | Data pipeline — extract, convert, audit, auto-refresh | **Complete** |
| **1** | Data sprint — fix OSM so routing can work | In progress — connectivity criteria already met; entrances + stairs remain |
| **2** | v0 outdoor wayfinder — the app | Not started |
| **3** | Adoption — get freshmen actually using it | Not started |
| **4** | Indoor pilot — 2–3 buildings | Not started |
| **5** | Institutional decision — hand off or pitch procurement | Not started |

---

## Ground rules (decided — don't relitigate mid-build)

1. **OpenStreetMap is the single source of truth.** No private shapefile, no hand-drawn GeoJSON that drifts. Everything the map knows, it knows from OSM.
2. **No backend in v0.** Static files on GitHub Pages. Routing runs in the visitor's browser.
3. **Data refresh is a build-time step, never a runtime one.** The page ships a committed snapshot; a scheduled job pulls new OSM data and commits it behind a guardrail. Overpass is too slow and too rate-limited to sit in the user's page load.
4. **Mridul builds the app; the GIS club feeds OSM.** The club never edits this repo. Their work arrives through OSM and the refresh job. This is what makes a one-person team survivable.
5. **Scope discipline:** outdoor walking only in v0. No parking, no transit, no indoor, no accounts, no user-generated content. Each of those is a later phase or a deliberate never.
6. **Accessibility is a feature, not a checkbox.** The "avoid stairs" route is a first-class mode from day one of Phase 2, because it's the thing a purchased vendor product would charge for and the thing that most justifies the project existing.

## Two data paths (a recurring confusion — worth stating plainly)

The map draws from two independent sources, and only one of them involves a
tile server:

1. **The world basemap** — streamed from **OpenFreeMap's** tile servers straight
   to MapLibre in the browser. We absolutely depend on this; it is what makes
   zooming out to the whole world work. We just don't *run* it.
2. **Our campus overlay** — `data/*.geojson`, a static file served from GitHub
   Pages and handed to MapLibre as a source. No tiling, no server logic, no API.

So: **we need OpenFreeMap; we do not need a tiling engine of our own.** Tiling our
own data would only become relevant if the campus overlay grew far beyond its
current ~0.8 MB, which is not on any horizon.

## What "done" means for v0

A freshman standing on the mall, on their own phone, with no app install:

- opens a URL, sees Furman with their blue dot on it
- types "plyler" (or "DH", or a typo) and finds the right building
- taps Directions and gets a drawn walking route with a distance and a minutes estimate
- can flip on "avoid stairs" and get a different, step-free route
- all of it in under 3 seconds on campus wifi, and it still works if OSM/Overpass is down

If that works reliably, v0 is done — regardless of how much else is unbuilt.

---

## Phase 0 — Data pipeline

**Goal:** a repeatable, unattended path from OSM to the exact files the app loads, plus an honest picture of how bad the data currently is.

### Steps

| # | Step | Artifact | Status |
|---|---|---|---|
| 0.1 | Overpass extract for the campus bbox, with mirror fallback + retries | `scripts/fetch-osm.sh` → `data/campus.osm.json` | Written, first successful run pending (Overpass has been busy) |
| 0.2 | Convert to app-ready GeoJSON, preserving OSM node IDs on paths | `scripts/build-geojson.py` → `data/{buildings,paths,entrances}.geojson` | Written, unrun |
| 0.3 | Connectivity + completeness audit | `scripts/audit.py` → `data/audit.md`, `data/audit.json` | Written, unrun |
| 0.4 | Scheduled refresh with anti-vandalism guardrail | `.github/workflows/refresh-osm.yml` | Written, untested in CI |
| 0.5 | Clip to Furman's OSM campus boundary; flag features `on_campus` | `data/boundary.geojson` | Done — boundary already existed as an OSM relation |
| 0.6 | Turn the audit's gap list into the Phase 1 punch list | `data/audit.md` | Done — audit.md *is* the punch list |

**Why node IDs matter:** two paths are connected when they *share an OSM node ID*, not when their coordinates happen to be close. Preserving the IDs makes the graph exact and makes "these two sidewalks look joined but aren't" a detectable bug rather than an invisible one.

### Testing Phase 0

- **Extract sanity:** the fetch script only accepts a response containing `"elements"`; anything else falls through to the next mirror. Verify by pointing `BBOX` at a 100 m box and confirming a small, valid file.
- **Converter round-trip:** for 5 hand-picked OSM ways (look them up on osm.org), assert the emitted GeoJSON has the same coordinate count and that the `nodes` array length matches the coordinate array length. A mismatch means refs fell outside the bbox and that way must be dropped from the graph, not silently truncated.
- **Geometry validity:** every building polygon's ring is closed (first point == last point) and has ≥4 points. Assert in the converter, not by eye.
- **Audit correctness — the one test that actually matters:** build a tiny synthetic fixture (`tests/fixtures/toy-network.geojson`) of 6 ways with a *known* answer — two blobs, one 3 m near-miss gap, one true junction — and assert `audit.py` reports exactly 2 components and exactly 1 near-miss. Without this, a silent bug in the audit makes the campus look healthy when it isn't.
- **Guardrail:** run the workflow's guardrail block against a deliberately gutted `audit.json` (halve `buildings`) and confirm it exits non-zero. Test the failure path, not the happy path — the happy path tests itself every Monday.
- **CI dry run:** trigger the workflow manually once via **Run workflow** before trusting the cron.

**Exit criteria:** `data/audit.md` exists, is believable, and the workflow has completed one successful manual run.

---

## Phase 1 — Data sprint

**Goal:** make the OSM data good enough that routing is honest. This is field work by humans; no amount of code substitutes for it.

### Steps

| # | Step | Owner | Notes |
|---|---|---|---|
| 1.1 | ~~Name the missing buildings~~ | — | **Dissolved.** Trone, Daniel Dining, Timmons, Hartness and Plyler were mapped and named all along, as multipolygon *relations*. The survey's Overpass query counted only ways, so they were invisible to it. |
| 1.1b | Fix the Plyler Hall spelling | Mridul, 2 min in iD | OSM has "John L **Pyler** Hall". The only genuine naming defect found. |
| 1.2 | Close near-miss gaps from `audit.md` | Mridul, iD, desk work | **2 remaining on campus** (was 6). Two near McAlister already fixed 2026-08-23 and confirmed via re-pull. |
| 1.2b | Tag building categories | Mridul, desk work | Only 16 campus buildings carry `building=university` and 20 carry any `amenity`. Without this there is no "show me academic buildings" filter. |
| 1.3 | Entrance nodes on the top ~30 buildings | GIS club, on foot | `entrance=main` / `entrance=yes`; this is what turns "walk to the middle of the building" into "walk to the door" |
| 1.4 | Map staircases | GIS club, on foot | `highway=steps`, plus `handrail`, `step_count`, `incline` where obvious. **The accessible-route mode does not exist until this is done.** |
| 1.5 | Add aliases | Mridul | `short_name=DH`, `alt_name`, building codes (RLY, TSC, FUR) so search matches what students actually type |
| 1.6 | Name North Village blocks properly | Either | Currently single letters A–K |
| 1.7 | Ask Shi Institute / GIS club whether the Walking & Mapping sidewalk data can be donated to OSM | Mridul | Licence-check first; don't import anything without permission |

### Tooling for the club (matters — get this right in the ask)

- **Android → StreetComplete.** Gamified, quest-based, hard to misuse.
- **iPhone → Every Door** (best for entrances) or **Go Map!!**. StreetComplete has no iOS release.
- **Laptop → iD** (the "Edit" button on openstreetmap.org). Required for drawing missing paths; the phone apps mostly answer questions about things that already exist.
- Everyone makes their own OSM account. Everyone writes a real changeset comment ("adding entrances, Furman University campus"). Nobody imports anything from Google Maps or a Furman PDF — that's a copyright violation that can get the whole club's edits reverted.

### Testing Phase 1

Phase 1 is tested by **re-running `scripts/audit.py` and watching the numbers move.** That's the whole point of building it first. Specifically, the sprint is done when:

All measured **on campus** (`on_campus` scope), not over the query bbox — the
bbox figure is dominated by off-campus fringe and means nothing here.

| Criterion | Target | Measured 2026-08-23 | |
|---|---|---|---|
| `largest_component_pct` | ≥ 97% | **97.1%** | met |
| `near_miss_gaps` | ≤ 3 | **2** | met |
| `phase1_buildings_still_unnamed` | empty | 1 (Plyler typo) | trivial |
| `entrances` | ≥ 30 | **12** | field work |
| `steps_ways` | ≥ 15 | **4** | field work |

The path network is in better shape than the survey suggested. What is missing is
exactly the data that only exists if someone walks campus — entrances and stairs.
That is the entire remaining case for the GIS club, and it is also why **Phase 2
is not blocked**: routing works today, it just ends at building centroids and
cannot yet offer a step-free mode.
- **Ground truth spot-check:** pick 10 random buildings, stand in front of each, confirm the name and entrance in OSM match reality. Data that's self-consistent but wrong passes every automated check.

---

## Phase 2 — v0 outdoor wayfinder

**Goal:** the app. Build in this order; each step is independently demoable, so a stall never leaves nothing working.

| # | Step | Done when |
|---|---|---|
| 2.1 | Static page + MapLibre + OpenFreeMap basemap, centred on campus | The world renders, zooms, rotates |
| 2.2 | Campus overlay — buildings styled Furman purple, labels, click-to-select | Tapping a building shows its name |
| 2.3 | Graph build from `paths.geojson` at page load; keep largest connected component | Console reports node/edge counts matching `audit.json` |
| 2.4 | A* routing, building-to-building, drawn as a line | Riley → Plyler draws a sane path |
| 2.5 | Snapping — entrance node if mapped, else nearest graph node to centroid; dashed leader line for the last few metres | Routes end at doors, not centroids |
| 2.6 | Distance + walk time (÷ 80 m/min) | "310 m · 4 min" |
| 2.7 | Fuse.js search over names + alias table | "DH", "plyer" (typo), "riley" all resolve |
| 2.8 | Blue dot + "route from my location" | Works on a phone, over HTTPS |
| 2.9 | Accessible mode — filter/penalise `highway=steps` | Toggle produces a visibly different route where stairs exist |
| 2.10 | Mobile layout, share-a-link URL state, offline-tolerant load | Usable one-handed outdoors in sunlight |
| 2.11 | Ship to GitHub Pages | Public HTTPS URL |

### Testing Phase 2 — this is the part to be precise about

**Layer 1 — Unit tests (Vitest). The router is the only part with real logic; test it hard.**
- Toy fixture graph with hand-computed distances: assert A* returns the known-shortest path and the known length (±0.5 m).
- Assert A* result equals Dijkstra result on the same fixture (A* heuristic must never make it wrong — an inadmissible heuristic silently returns non-optimal routes, which no one notices by eye).
- Symmetry: route(A→B) length == route(B→A) length.
- Unreachable target returns a clean "no route" — not a crash, not an infinite loop, not `undefined`.
- Accessible mode on a fixture where the only short path is stairs: assert it returns the longer step-free path, and that a stairs-only destination reports "no step-free route" rather than silently routing over steps.
- Haversine against 3 published lat/lon pairs with known distances.

**Layer 2 — Golden routes.** `tests/golden-routes.json`: ~15 real campus pairs students actually walk (Riley→Plyler, North Village→DH, library→Trone, dorm→Timmons). Each records expected distance and step count. CI asserts within ±10%. When OSM data changes and a golden route moves more than that, **the test failing is the desired behaviour** — it's how you find out a club edit broke something. Review, then re-baseline deliberately.

**Layer 3 — Field validation.** Walk 5 golden routes with a stopwatch. Compare real minutes to the ÷80 m/min estimate. If it's consistently off, tune the constant — Furman has hills, and an ETA that lies is worse than no ETA.

**Layer 4 — E2E (Playwright), one smoke test, mobile viewport:** load page → type "plyler" → click first result → click Directions → assert a route line exists on the map, ETA text is non-empty, and no console errors. Use Playwright's geolocation mocking (`setGeolocation` + `grantPermissions`) to fake standing on the mall for the blue-dot path.

**Layer 5 — Real devices.** iOS Safari specifically: geolocation permission flow, `100vh` behaviour, WebGL. Plus one cheap Android. Emulators lie about both.

**Layer 6 — Budgets, asserted in CI:**
- total payload < 1.5 MB gzipped (if `paths.geojson` blows this, drop the `nodes` arrays after graph build or simplify geometry)
- graph build < 150 ms
- route computation < 50 ms
- first meaningful paint < 2 s on simulated 4G

**Layer 7 — Accessibility:** axe-core in the Playwright run; keyboard-only operation of search and Directions; visible focus states; contrast checked against Furman purple, which is dark enough to be a real risk on dark map backgrounds.

**Layer 8 — Data-resilience (the one people skip):** run the app against a *deliberately broken* copy of the data — empty `paths.geojson`, a building with no name, an entrance node with no matching building. The page must degrade, not white-screen. This is guaranteed to happen eventually, because the data is a public wiki.

---

## Phase 3 — Adoption

| # | Step |
|---|---|
| 3.1 | QR codes on building signage + orientation packets |
| 3.2 | Ship to 10 freshmen; watch them use it without helping. Task: "get from your dorm to your 9am." Record where they hesitate |
| 3.3 | Feedback link (mailto or a form — still no backend) |
| 3.4 | POI layers: bell tower, lake trail, dining hours |
| 3.5 | Announce to the GIS club and OSM community; invite mappers |

**Testing:** the freshman test *is* the test. Metric: ≥8 of 10 complete the task unaided in under 60 seconds. Any confusion two or more people hit is a bug, not a user error.

---

## Phase 4 — Indoor pilot

**Decision: indoor stays in OpenStreetMap. No second system, no vendor, no separate
database.** Indoor data uses OSM's Simple Indoor Tagging schema, is edited with the
same accounts and etiquette as everything else, and comes out through the *same*
extraction pipeline — just additionally filtered by `level`. This keeps ground rule 1
intact all the way to room level.

### The data model

Every indoor feature carries a `level=*` (0, 1, 2 …). On top of that: rooms are
`indoor=room`, hallways `indoor=corridor`, doors `door=*`, and stairs and elevators
are tagged so they span the levels they connect — which is what lets a route move
between floors. Room numbers and names ride along as ordinary tags, and that is
precisely what makes **"Plyler 126"** searchable later.

> Transcribed from a planning conversation whose tag list was partly obscured.
> **Verify the exact keys against the [Simple Indoor Tagging wiki](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging)
> before briefing the club** — getting the schema wrong at the start means re-surveying
> buildings, which is the one cost here that is genuinely expensive to undo.

### Club workflow

| Step | Tool |
|---|---|
| Map | **JOSM with the indoorhelper plugin** — iD is fine for simple cases |
| Verify | **[indoorequal.com](https://indoorequal.com)** renders live OSM indoor data with a floor picker, so mappers see their own work immediately |
| Extract | the existing pipeline, filtered by `level` — no new tooling |

### Steps

| # | Step |
|---|---|
| 4.1 | Ask Facilities for floor plans — and see the copyright caveat below; this ask is also the real conversation-starter with the university |
| 4.2 | Simple Indoor Tagging for Duke Library, Trone, Townes |
| 4.3 | Level picker in the app (indoorequal-style) |
| 4.4 | Make the routing graph level-aware: stair and elevator edges connecting levels |
| 4.5 | Indoor↔outdoor route stitching through entrance nodes |

### Two caveats, both manageable

**Copyright.** Furman's official floor-plan PDFs **cannot be traced into OSM without
permission.** Either get Facilities' explicit blessing, or survey by walking the
buildings with sketches and a laser measure — which is how most indoor OSM is actually
made and is entirely legitimate. This is the same rule as never importing from Google
Maps, and violating it can get the whole club's edits reverted.

**The graph becomes level-aware.** Indoor routing means nodes carry a level, and stairs
and elevators become the edges between them. That is already scoped as 4.3–4.4 — new
work, but not a new architecture.

### Testing

Route from a room in Duke Library to a room in Trone and confirm the path exits through
a real door, crosses outdoors, and re-enters through a real door. Validate 20 room
labels against the actual doors. Assert that a step-free indoor route uses an elevator
edge and never a stair edge. Expect indoor geolocation to be poor — **do not promise a
blue dot indoors**; that is what vendors sell beacon hardware for.

---

## Phase 5 — Institutional decision

Either hand maintenance to the GIS club (the NavigaTUM lesson: an organisation outlives a student), or use the working app as leverage in a MazeMap / Concept3D / ArcGIS Indoors procurement conversation. Walking into that meeting with something students already use is the strongest possible position — and the OSM data stays valuable either way, because MazeMap consumes OSM outdoors too.

---

## Risk register

| Risk | Mitigation |
|---|---|
| OSM edit breaks the map | Refresh guardrail + golden-route tests fail loudly |
| Overpass down on refresh day | Three mirrors, retries, and last good snapshot stays committed |
| GIS club interest fades | The app works with today's data; club work makes it better, not possible |
| Mridul graduates / gets busy | Phase 5 handoff; keep the codebase small and the README honest |
| Someone imports Google/Furman PDF data into OSM | Brief the club explicitly — this can get all their edits reverted |
| ETA is wrong because of hills | Field-validate the m/min constant; consider elevation later |
| Furman IT objects to an unofficial map | Find the campusmap.furman.edu owner early; frame as complement, not replacement |

## Time estimate (honest)

Phase 0: hours. Phase 1: a weekend of desk edits + a club mapathon for the field work. Phase 2: a good weekend for 2.1–2.7, another for 2.8–2.11 plus tests. Phases 3–5: semester-scale, driven by other people's calendars, not yours.
