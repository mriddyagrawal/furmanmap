# Commit review log

Every commit on this repo gets read by a reviewer before it is built on. This file
is that record — newest first, one section per commit, with the verdict and the
reasoning that produced it.

**Why it exists.** This is a one-person repo where most of the code is written by
AI instances working from `CLAUDE.md`. That arrangement is fast and it drifts:
each instance sees its own change and not the invariant three commits ago that the
change quietly undoes. The reviewer's job is to be the thing with the longer
memory, and to say so in writing where the next instance will read it.

**How a review is done.** Findings are only recorded once they have been *checked* —
against the data, in a browser, or by running the suite. A claim that cannot be
demonstrated is not a finding, it is a hunch, and hunches are labelled as such. The
rubric is in [`docs/reviewing.md`](docs/reviewing.md).

**Severity.**

| | |
|---|---|
| **Blocker** | Ship this and something breaks, silently loses data, or misleads a user. Fix before building further. |
| **Major** | Real defect or a broken guarantee. Fix soon; it will cost more later. |
| **Minor** | Worth fixing, no urgency. |
| **Note** | Observation, question, or a risk to write down rather than act on. |

**Unreviewed commits:** `./scripts/review-pending.sh`

---

## `10f2da7` — app: draw our own paths, and stop the fetch dying on one bad part

*Mridul Agrawal · 2026-08-27 · merged to `main` as `28cd618` (PR #46) during this review*

**Verdict: request changes.** The path-drawing diagnosis is exactly right and the
fix is the cheap one. But it ships a filter that recreates the same class of bug it
set out to kill, and the fetch half of it does not run at all in the place it was
written for.

**Good.** Finding that way 303491780 was routed along while being invisible is real
debugging, and the fix — draw the geometry already downloaded for routing — is the
minimum that could work. Hiding the basemap's path layers rather than restyling
them is the correct call, and the commit says why.

### Blocker — the drawn paths are not the routed paths

[`app.js:504`](app.js#L504) filters on `walkable` alone. The routing graph at
[`app.js:173`](app.js#L173) filters on `on_campus && walkable`.

```
walkable total      : 1159      <- drawn
walkable on_campus  :  593      <- routable
walkable OFF campus :  566      <- drawn, never routable
```

Confirmed in a browser: at an off-campus footway, `queryRenderedFeatures` on
`paths-line` returns 11 features, all 11 `on_campus: false`. Half the paths now on
screen cannot be routed on.

This is the commit's own bug with the sign flipped. Before, the router knew about
paths the map did not draw; now the map draws paths the router refuses. A visitor
who walks to a drawn path expecting it to be routable gets nothing, and there is no
message explaining why — which is worse than the invisible-footway case, because at
least that one still produced a working route.

It also undoes the off-campus veil. `offcampus-veil` is added before the campus
layers and `paths-line` after them, so the
paths paint over it — verified via layer order. The veil exists to stop off-campus
detail competing for attention, and this draws 566 bright new lines across it.

Fix: `paths.features.filter(f => f.properties.on_campus && f.properties.walkable)`,
matching line 173. Better still, filter once into a named binding and hand the same
array to both, so the two cannot drift again.

### Major — the part cache never exists in CI, which is the only place it matters

The commit's rationale is a 429 on `boundary` discarding three good fetches during
a refresh. That refresh is [`refresh-osm.yml`](.github/workflows/refresh-osm.yml),
which starts from `actions/checkout@v4`. `data/.parts/` is untracked and
newly-gitignored (`git ls-files data/.parts` → empty), so on a CI runner the cache
directory is *always absent* at the moment a part fails.

[`fetch-osm.sh:117`](scripts/fetch-osm.sh#L117) therefore falls straight through to
`return 1`, `set -e` aborts, and the job fails exactly as it did before. The fix
works only on the maintainer's laptop.

Fix: add an `actions/cache@v4` step for `data/.parts` in the refresh workflow, or
commit the parts. The cache step is the smaller change and keeps the intermediate
untracked, consistent with how `campus.osm.json` is handled.

### Major — reusing a cached part stops the stale-mirror guard from ratcheting

`2e24856` established that a refresh never goes backwards: every mirror response is
refused if its `timestamp_osm_base` is older than the committed snapshot's, read
from `meta.json` into `HAVE` at [`fetch-osm.sh:32`](scripts/fetch-osm.sh#L32).

The reuse path at [`fetch-osm.sh:118`](scripts/fetch-osm.sh#L118) copies a cached
response into the merge without that check. The merged `osm_base` is the *minimum*
across parts, and `build-geojson.py:163` writes it back to `meta.json` — which is
next run's `HAVE`.

So if `boundary` keeps failing and keeps being reused, `HAVE` freezes at that cached
part's age while the rest of the data advances. The floor stops rising. The guard
that was added to stop `private.coffee` serving 2014 data gets more permissive every
week it is relied on, and nothing says so.

The commit is aware the reused part is older — it takes the minimum deliberately,
and the comment argues that is the honest number. It is, for the *snapshot*. It is
the wrong number to reuse as a *floor*.

Fix: keep the honest minimum in `campus.osm.json`, but let `HAVE` be the highest
`osm_base` ever recorded rather than the last one, or re-check the cached part's
base against `HAVE` before reusing it and refuse a cache that has fallen behind.

### Minor — the cache is not keyed by bbox, and `CLAUDE.md` tells people to change the bbox

`CACHE="$DIR/.parts"` has no bbox in it, and every success overwrites it. `CLAUDE.md`
documents `BBOX=34.924,-82.440,34.925,-82.439 ./scripts/fetch-osm.sh` as the way to
test the pipeline. Run that, then run a real refresh where one part fails, and the
100-metre test box gets merged into the campus snapshot.

CI's guardrail would catch the resulting collapse; a local `npm run data` would not,
and would write the geojson the site serves. Fix: key the cache on the bbox, e.g.
`CACHE="$DIR/.parts/$(printf %s "$BBOX" | shasum | cut -c1-8)"`.

### Minor — 137 KB of routing metadata is uploaded to the renderer

The drawn source carries `properties.nodes` — 137 KB of 644 KB, 21%. Those arrays
exist so the graph can key on OSM node ids; MapLibre has no use for them. Strip
them in the map source (`graph.js` still gets the full features).

### Minor — atomic commits

The summary line contains "and". `CLAUDE.md` is unambiguous: *"If the summary line
needs an 'and', it is two commits."* This is four, plus a stray:

1. `app.js` — draw our own paths
2. `fetch-osm.sh` — the `|| true` errexit fix
3. `fetch-osm.sh` + `.gitignore` — per-part caching
4. `data/meta.json` — a data refresh, which is its own `data:` area
5. `comments.md` — an empty file, unmentioned in the message

Each is independently revertable and 2 and 3 have different risk profiles: one is a
one-word bug fix, the other is new behaviour with the guard interaction above. They
should not share a revert.

### Note

- The new test is in [`a11y.spec.js`](tests/e2e/a11y.spec.js) but tests rendering,
  not accessibility or a budget. `flow.spec.js` is where it belongs; that file's
  header says it covers exactly this.
- It would not have caught the blocker above — it asserts *some* paths are painted,
  never that they are the routable ones. `expect(paintedOffCampus).toBe(0)` would.
- The hardcoded `[-82.43880, 34.92320]` has no comment saying what is there or why
  more than 5 paths are expected. When OSM changes around it, that fails opaquely.
- `emphasisePaths()` now hides paths. The name has outlived the behaviour.

---

## `38ff69e` — chore: point the site at its own domain

*Mridul Agrawal · 2026-08-27*

**Verdict: approve.** Small, atomic, correct, and the message explains the one
non-obvious thing — that GitHub Pages reads `CNAME` from the published branch, so it
has to be a file rather than a settings field. Keeping the github.io address
documented rather than deleted is the right call for links already in circulation.

### Note — this puts every future QR code behind a domain registration

Phase 3 of the master plan is *"QR codes on building signage + orientation packets"*.
Once `CNAME` is set, GitHub Pages 301s the github.io address to `acrossfurman.com`,
so both the printed URL and the fallback now depend on that registration being
renewed. A lapsed domain breaks signage that is physically bolted to buildings, and
the master plan's risk register already tracks *"Mridul graduates / gets busy"*.

Not a code change — a line in the risk register, and a calendar reminder. Worth
deciding before anything gets printed, since that is the point it stops being cheap.

### Minor — nothing pins the deployed domain

`CNAME`, the README, and the live site can drift apart silently. The e2e suite
already asserts the manifest's icons are actually served; one more assertion that
`CNAME` matches the README's advertised URL would catch a typo before DNS does.

### Minor — confirm "Enforce HTTPS" before sharing the new address

[`app.js`](app.js) gates both location and navigation on `window.isSecureContext`.
A custom domain serves plain HTTP until Pages finishes provisioning its certificate,
and in that window the app loads, looks fine, and silently refuses to find anyone —
`"Location needs an https:// address."` is the only clue. Deploy check, not a defect.

---

## `501e98a` — app: state plainly that this is not Furman's

*Mridul Agrawal · 2026-08-27*

**Verdict: approve with a fix.** The right change for the right reason, and the
distinction drawn between "affiliated" and "endorsed" is the correct one. Moving the
date into the sheet rather than dropping it keeps an honest answer to a real
question. One defect, which matters because of what this text is *for*.

### Major — the disclaimer does not render if the basemap fails to load

[`app.js:270`](app.js#L270) writes `#build` inside the `map.on('load', …)` handler
opened at [`app.js:239`](app.js#L239). MapLibre fires `load` only after the style
resolves; if OpenFreeMap is unreachable it fires `error` instead and the handler
never runs.

Demonstrated by aborting requests to `tiles.openfreemap.org`:

```json
{ "buildText": "", "updatedText": "", "mapLoaded": false, "searchVisible": true }
```

The page still presents itself — search bar, chrome, campus data all loaded — with
no disclaimer anywhere on it. That is the failure mode the disclaimer exists to
prevent, and it happens precisely when the site looks most like a broken official
product.

The master plan's Layer 8 makes this the standing rule: *"The page must degrade, not
white-screen."* A legal notice that is conditional on a third-party tile server is
not a notice.

Fix: put the text in [`index.html:114`](index.html#L114) as static markup. It never
changes and it needs no data. `map.on('load')` can keep the tooltip and the console
line, which genuinely do depend on loaded state.

### Major — `#build` is the one element the contrast scan cannot see

[`a11y.spec.js:18`](tests/e2e/a11y.spec.js#L18) scans `#top`, `#sheet` and `#fabs`.
`#build` is at [`index.html:114`](index.html#L114), outside all three.

So the element now carrying the legally meaningful sentence — and the only one
styled with hand-written hex instead of theme tokens (`6c3cf4b`) — is invisible to
the rule that file's own header calls out as having caught a 1.04:1 chip. `#updated`
went into `#sheet` and *is* covered, which makes the gap easy to miss: the date is
checked, the disclaimer is not.

Fix: `.include('#build')`. If axe objects to scanning an element over a canvas,
assert the computed colour pair directly, but do not leave it unscanned.

### Minor — the date shows during navigation

`#updated` sits in `#sheet` outside the pane divs, so it is visible in `place`,
`directions` *and* `nav`. "Last updated 27 August 2026" under a live walking ETA is
noise at the moment the screen should be at its quietest. Scope it to the modes
where it answers a question the user is actually asking.

---

## `6c3cf4b` — fix: style the byline as a map label, not as interface

*Mridul Agrawal · 2026-08-26*

**Verdict: approve.** Correct diagnosis of a genuinely subtle bug — the basemap is
light in both themes, so an element over it must not follow the interface theme —
and the general rule in the message ("theme tokens are for things that sit on
`--paper`") is worth more than the fix itself. That is the kind of note that stops
the next instance reintroducing it.

### Major — the fix has no regression test

The bug was *light-grey text in a near-black halo on a pale map, in dark mode*. The
test touching this area asserts the byline is present and in the viewport. Neither
is about legibility, and both passed while the bug was shipping.

Combined with the `#build` scan gap above, dark-mode legibility here is currently
guarded by nothing at all. The suite runs `emulateMedia({ colorScheme: 'dark' })`
already, so the missing piece is only that `#build` is out of scope — fixing that
one finding closes both.

### Minor — hardcoded hex outside the token system

`#4b4458` at [`style.css:230`](style.css#L230) and `#3d2a55` at
[`style.css:237`](style.css#L237). The reasoning is sound and documented, so this is
not a request to revert — but these are now the only colours in the file that no
token governs and no test checks. A `--map-label` / `--map-label-halo` pair under
the same comment would make the intent enforceable rather than remembered.

---

## `b38c726` — app: count usage anonymously, so the pitch can quote a number

*Mridul Agrawal · 2026-08-26*

**Verdict: approve with changes.** The privacy engineering is the good part and it
is genuinely good — bucketing distances because a metre-accurate length beside a
building name describes a person's movement is a subtle call, made correctly and
explained. The vendor comparison in the message is real analysis. The changes below
are about the numbers being *right*, since their whole purpose is to be quoted.

### Major — `place` counts internal navigation as searches

[`app.js:679`](app.js#L679) fires `track('place')` at the top of `selectPlace()`,
which is called from four places: a suggestion click, a map tap, `dir-back`
returning to the current place, and `p-close`. Backing out of directions therefore
re-counts a building already counted.

"Which buildings people look for" is the event's stated question, and the answer will
be inflated by however often people press Back — unevenly, since the buildings people
plan routes to are exactly the ones that get re-selected. Fix: fire it where the
intent is, in the suggestion handler and the map-click handler, not in the shared
setter.

### Major — the README claims more than the test proves

The README says a test asserts *"nothing resembling a Furman coordinate appears in
any payload"*. [`a11y.spec.js:365`](tests/e2e/a11y.spec.js#L365) replaces
`window.umami` with a local stub, so it inspects the props this app passes and
nothing else. Umami's real script also sends the URL, referrer, screen size and
language, and derives a visitor identifier server-side from IP and user-agent.

Our props are clean — the test shows that, and it is worth having. But "any payload"
is the wrong scope for it, and "no fingerprinting" is a claim about a third-party
script's behaviour that this repo does not verify and cannot control. Narrow the
README to what is true and checked: *no coordinates are ever passed to the analytics
script by this app*. The consent question is a separate judgement and should not
rest on a sentence the test does not support.

### Minor — the coordinate guard needs one more decimal than an attacker would

[`a11y.spec.js:373`](tests/e2e/a11y.spec.js#L373) matches `/34\.9\d{3}/`. A
coordinate rounded to two places — `34.92`, `-82.44`, still locating someone inside
a few hundred metres — passes. Tighten to `/34\.9\d/` and `/-82\.4\d/`; nothing
legitimate in these payloads has that shape.

### Minor — `walk_abandoned` cannot see the way people actually give up

[`app.js:843`](app.js#L843) fires only from `stopNav()`, i.e. an explicit Stop tap.
Someone who gives up mid-walk pockets the phone or closes the tab, and neither sends
anything. The README's *"how many gave up"* overstates it by an unknown margin.

`walk_arrived / walk_start` is unaffected and remains the honest headline — the
message is right about that. But relabel the event, or add a `visibilitychange`
handler, before anyone subtracts one number from another in a pitch.

### Note

- The whole subsystem is inert in production: the script tag in
  [`index.html`](index.html) is commented out, so `track()` returns at its first
  line everywhere. Deliberate and documented — noted so it is not mistaken for
  working instrumentation later.
- `walk_arrived`'s `minutes` is wall-clock since `startNav`, so backgrounding the
  app inflates it. Fine for "roughly how long"; not a number to quote precisely.
- The blocked-analytics test is the right instinct and the kind of test most
  projects skip.

---

## In flight — uncommitted, branch `fix/fetch-hardening`

Not a review; commits get reviewed, working trees do not. Recorded so the next
reader does not re-report findings already being fixed, and so the work is not
silently lost if the branch is abandoned.

At review time another instance had uncommitted changes to `scripts/fetch-osm.sh`
and `app.js` that address two findings above:

- **A cached part is now checked against `HAVE` before reuse**, with a `MAX_CACHE_DAYS`
  ceiling and a guard against caching an empty-but-valid 200. It also catches
  something this review missed: the cache is gitignored and survives a branch switch
  while `meta.json` is committed and does not, so a refresh on one branch could
  restore older data under a higher floor. Good catch — that is the stale-mirror bug
  arriving by a side door.
- **The footer date now reads `osm_base` rather than `generated`**, which is the
  right call and closes the freshness half of the ratchet finding. `generated` is
  when the build ran, which is today even when every part fell back to cache and
  nothing moved.

Two things to carry into that commit when it lands:

1. The `find … -printf ''` in the age check contributes nothing. Verified: its stdout
   is empty on both BSD (unsupported primary, suppressed) and GNU (`-printf ''`
   prints nothing), and the number comes entirely from the `python3` call after it.
   The comment above it says the age is obtained "via find, which behaves the same on
   both", which will mislead the next reader. Drop the `find`, or drop the comment.
2. Refusing a stale cache with `return 1` reinstates the whole-refresh abort that
   `10f2da7` set out to remove — correctly, since bad data is worse than no refresh,
   but it means the CI gap in **Major — the part cache never exists in CI** is now
   the only thing standing between a flaky `boundary` and a failed weekly job. That
   finding gets more important, not less.

**The blocker is still open.** `app.js:504` is untouched and is now on `main`.

---

## Standing items

Things spanning more than one commit, carried forward until closed.

| # | Item | Raised | Status |
|---|---|---|---|
| 1 | `#build` is outside the axe scan, so the disclaimer and the only hardcoded colours in the codebase are unchecked | `501e98a`, `6c3cf4b` | open |
| 2 | Map and router disagree about which paths exist — twice now, in both directions | `10f2da7` | open |
| 3 | The refresh job's resilience work is untested in CI, where the failures it targets happen | `10f2da7` | open |
| 4 | Commit atomicity is slipping; `CLAUDE.md`'s "no *and* in the summary" rule is the tripwire | `10f2da7` | open |
| 5 | QR codes in Phase 3 will depend on a renewed domain registration | `38ff69e` | for the risk register |

## Verification

Everything above was checked, not inferred. Run at review time, on `10f2da7`:

- `npm test` — 18 passed
- `npx playwright test` — 54 passed (phone + desktop)
- Off-campus path count measured against `data/paths.geojson`, then confirmed in a
  browser via `queryRenderedFeatures` and style layer order
- Basemap-outage behaviour reproduced by aborting `tiles.openfreemap.org`
- `git ls-files data/.parts` confirmed empty; `refresh-osm.yml` confirmed to have no
  cache-restore step
- `build-geojson.py:163` confirmed to write the merged `osm_base` into `meta.json`

A green suite is what makes these findings worth writing down: none of them is a
test that failed. They are all things the tests do not yet ask.
