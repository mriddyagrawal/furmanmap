# Mapping Furman

A walking wayfinder for Furman University — search a building, get a walking route
with distance and time, with a step-free mode for accessible routing.

**Live: https://acrossfurman.com**

Also at https://mriddyagrawal.github.io/furmanmap/ — the GitHub Pages address the
custom domain points at. The intended home is a Furman subdomain; this is the
signpost until then.

Built on OpenStreetMap data. Static site, no backend: the basemap streams from
[OpenFreeMap](https://openfreemap.org/), and routing runs in your browser.

## Running it locally

```bash
npm install        # Turf + ngraph, for the tests
npm run serve      # http://localhost:8765
npm test           # router tests
npm run data       # re-pull from OpenStreetMap, rebuild, re-audit
```

The page fetches `data/*.geojson`, so opening `index.html` directly with `file://`
will not work — it needs a server.

## Improving the map

The map is only as good as the OpenStreetMap data behind it, and **anyone can improve
that**. [`data/audit.md`](data/audit.md) is a live punch list of what is missing —
unnamed buildings, uncategorised buildings, path gaps — each with a link straight to
the spot in OSM.

- **Android** → [StreetComplete](https://streetcomplete.app/)
- **iPhone** → [Every Door](https://everydoor.app/) or Go Map!!
- **Laptop** → the "Edit" button on [openstreetmap.org](https://www.openstreetmap.org)

Edits appear here within a week — sooner if the refresh job is run by hand. Never copy
from Google Maps or Furman's PDF map; that is a copyright violation.

## Usage counts

Off by default. To switch them on, create a free [Umami Cloud](https://umami.is)
account, add this site, and paste the site id into the commented-out script tag
in `index.html`. Nothing loads and nothing is sent until you do.

What it records, and nothing else:

| Event | Answers |
|---|---|
| `place` | which buildings people look for |
| `directions` | how many go on to want a route |
| `walk_start` | how many actually set off, and whether step-free was on |
| `walk_arrived` | how many got there, and roughly how long it took |
| `walk_abandoned` | and how many gave up |

`walk_arrived / walk_start` is the completion rate — the number worth quoting.

**No coordinates are ever sent.** This app knows exactly where someone is
standing, and that stays on the phone: distances are bucketed rather than exact,
and a test drives the whole flow asserting that nothing resembling a Furman
coordinate appears in any payload. No cookies, no accounts, no fingerprinting,
so no consent banner is required.

## How it fits together

- [`plans/masterplan.md`](plans/masterplan.md) — phases, exit criteria, test strategy
- [`docs/survey.md`](docs/survey.md) — the research this was built from
- [`CLAUDE.md`](CLAUDE.md) — conventions and the invariants worth not breaking
