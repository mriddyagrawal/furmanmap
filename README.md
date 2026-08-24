# Mapping Furman

A walking wayfinder for Furman University — search a building, get a walking route
with distance and time, with a step-free mode for accessible routing.

**Live: https://mriddyagrawal.github.io/furmanmap/**

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

## How it fits together

- [`plans/masterplan.md`](plans/masterplan.md) — phases, exit criteria, test strategy
- [`docs/survey.md`](docs/survey.md) — the research this was built from
- [`CLAUDE.md`](CLAUDE.md) — conventions and the invariants worth not breaking
