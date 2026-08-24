# CLAUDE.md

Orientation for Claude Code (and any new human contributor) working in this repo.

## What this project is

A student-built walking wayfinder for Furman University's campus — search a building,
get a walking route with distance and ETA, with a step-free mode for accessible routing.
Static site, no backend, data from OpenStreetMap.

**Read [plans/masterplan.md](plans/masterplan.md) before proposing work.** It holds the
phase plan (0–5), the exit criteria for each phase, and the test strategy. `docs/` holds
the research that produced those decisions — read it when you want to know *why*, not *what*.

## Commands

```bash
./scripts/fetch-osm.sh              # Overpass -> data/campus.osm.json (3 mirrors, 3 attempts)
python3 scripts/build-geojson.py    # -> data/{buildings,paths,entrances}.geojson
python3 scripts/audit.py            # -> data/audit.md (mapper punch list) + data/audit.json (CI gate)
BBOX=34.924,-82.440,34.925,-82.439 ./scripts/fetch-osm.sh   # small box, for testing the pipeline
```

```bash
npm install                          # once — Turf + ngraph, plus Playwright
npx playwright install chromium      # once — the browser the E2E tests drive
npm test                             # router unit tests (graph.js)
npm run test:e2e                     # browser tests (app.js): flow, a11y, budgets
npm run test:all                     # both
npm run serve                        # http://localhost:8765 — the app fetches
                                     # data/*.geojson, so file:// will not work
npm run data                         # fetch + build + audit in one go
```

**What each layer is for.** `tests/*.test.js` covers `graph.js` under Node — routing,
geometry, progress, heading. `tests/e2e/` drives a real browser against the real site,
because every UI bug this project has shipped lived in `app.js`: invisible dark-mode
text, an unreachable button, a vanishing blue dot. If you change `app.js`, the browser
tests are the ones that matter.

The data scripts are stdlib-only Python 3 and bash. There is **no build step** — the
browser loads MapLibre, Fuse, Turf and ngraph as UMD bundles straight from a CDN, and
`graph.js` resolves those same libraries through `require()` under Node. Same file,
both environments, no bundler. Keep it that way unless there is a reason that
survives being written down.

## Prefer a library over writing it

If a maintained library does the job, use it. Other people have already found the
edge cases, and reviewed code beats clever code. Turf does the geodesy; ngraph.path
does A*; Fuse does fuzzy search; MapLibre draws.

Write it by hand only when the library genuinely does not fit, and then say why in
the commit. Two things here meet that bar and are worth knowing before you try to
replace them:

- **Graph construction is keyed on OSM node ids.** `geojson-path-finder` keys
  vertices by rounded coordinate string, which quietly merges nodes that are near
  each other but genuinely unconnected, and hides the near-miss gaps `audit.py`
  exists to report. It also ships no browser build, so it would force in a bundler.
- **Largest-connected-component filtering.** No routing library does it, and without
  it orphan path islands become destinations that are visible but unroutable.

## Where the code lives

- `graph.js` — routing core: graph build, A*, geometry. Pure functions, no DOM,
  so it runs in the browser *and* under `node --test`. Put logic here.
- `app.js` — map, layers, search, UI wiring. DOM-dependent, untested by design.
- `index.html` / `style.css` — one page.

If you are tempted to put routing logic in `app.js`, don't: that is how the router
becomes untestable.

## Architecture invariants

Violating any of these breaks the design, not just the code:

1. **OpenStreetMap is the only source of truth.** No hand-drawn GeoJSON, no private
   shapefile, no data typed into this repo by hand. If the map should know something,
   it goes into OSM first and arrives here through `fetch-osm.sh`.
2. **No backend.** Static files on GitHub Pages. Routing runs in the visitor's browser.
   If a feature seems to need a server, it belongs in a later phase — or nowhere.
3. **Data refresh is build-time, never runtime.** The page loads committed GeoJSON.
   Never fetch Overpass from the browser: it is slow, rate-limited, and frequently
   returns dispatcher-busy errors. A refresh job commits new data; users get a snapshot.
4. **Paths carry their OSM node IDs.** Two ways are connected when they *share a node ID*,
   not when their coordinates are close. Keep the `nodes` property in `paths.geojson`;
   it is what makes the routing graph exact and makes "looks joined but isn't" detectable.
5. **Always keep only the largest connected component** when building the graph. Orphan
   path islands are the cause of "no route found."
6. **Accessible routing is first-class.** `highway=steps` edges are filtered/penalised,
   not ignored. Don't ship a change that makes step-free routing an afterthought.

## Conventions

- The GIS club contributes **through OSM**, never through this repo. Nobody but the
  maintainer commits here. That constraint is what makes a one-person team survivable.
- Generated data in `data/` **is committed** — that snapshot is what the site serves.
  The exception is `data/campus.osm.json`, the raw Overpass response: it is a build
  intermediate the app never loads, and committing 2 MB of it on every weekly
  refresh would add ~100 MB of history a year. Regenerate with `npm run data`.
- Keep the app small and readable. This gets handed to a student club eventually;
  cleverness that needs explaining is a liability.

## Git workflow (not optional)

**Atomic commits.** One logical change per commit — never a grab-bag. If the summary
line needs an "and", it is two commits. Message format is `area: imperative summary`
(areas: `docs`, `scripts`, `ci`, `plans`, `data`, `app`, `chore`), followed by a body
explaining *why* the change is shaped this way. The diff already says what changed;
the body is for the reasoning that would otherwise be lost.

**Branch for anything even slightly major.** Direct commits to `main` are reserved for
genuinely trivial edits — a typo, a comment, a link fix. Everything else gets a branch
and a PR: a new script, a behaviour change, a dependency, a data-pipeline change, an app
feature, a plan revision. When in doubt, branch; the cost is one command and the benefit
is a reviewable, revertable unit.

Branch names: `phase0/…`, `feat/…`, `fix/…`, `data/…`, `docs/…`.

Never force-push `main`. Never rewrite history that has been pushed.

## Gotchas that will cost you time

- **Overpass is often busy.** Dispatcher timeouts are normal, not a bug in the query.
  The fetch script retries 3 mirrors × 3 attempts. Don't "fix" it by simplifying the query
  before confirming the servers are actually up with a tiny test query.
- **Piping the fetch script through `tee`/`tail` masks its exit code.** Run it directly,
  or set `-o pipefail`, or you'll think a total failure succeeded.
- **StreetComplete is Android-only.** When writing instructions for mappers, iPhone users
  need Every Door or Go Map!! — telling a club "just use StreetComplete" strands half of them.
- **Never import from Google Maps or Furman's PDF map into OSM.** It's a copyright
  violation and can get every edit from that account reverted.
- **A golden-route test failing after a data refresh is working as intended.** It means an
  OSM edit changed a real route. Review the change, then re-baseline deliberately.

## Not in scope for v0

Parking, transit, indoor/room-level navigation, user accounts, and anything that stores
user-generated content. Each is a later phase in the master plan or a deliberate never.
