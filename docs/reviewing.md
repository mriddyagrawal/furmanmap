# How commits get reviewed here

The review log is [`comments.md`](../comments.md). This file is the method that
produces it, so that a review done by one instance looks like a review done by
another, and so a reviewer can be argued with rather than merely trusted.

## Why this exists

Most of the code here is written by AI instances working from `CLAUDE.md`. Each one
sees its own change clearly and the surrounding three months not at all. The
recurring failure is not bad code — it is a change that quietly undoes an invariant
established earlier, with a commit message that is confident and well-written and
wrong about the wider effect.

So the reviewer's job is narrow: **be the thing with the longer memory.** Check the
change against what the repo already decided, and write it down where the next
instance will read it.

## The rule that makes this worth reading

**A finding is only a finding once it has been checked.** Run the query, open the
browser, execute the suite. If it cannot be demonstrated it is a hunch, and hunches
go in the "Note" bucket labelled as such.

This matters more than usual here. The commit messages in this repo are unusually
good — detailed, reasoned, honest about tradeoffs. That is exactly what makes them
persuasive when they are incomplete, and a reviewer who reads the message instead of
the diff will approve confident prose rather than working code.

## Passes

Work through these in order. Stop early only if the change is genuinely trivial.

**1. What did it claim, and is the claim true?**
Read the message, then verify the mechanism it describes. When it says a footway was
invisible, find the footway. When it says a guard prevents something, construct the
case it should prevent.

**2. What did it change that the message does not mention?**
`git show --stat` first. Stray files, bundled concerns, a data refresh riding along
with an app change. This is where atomicity violations and accidental commits live.

**3. Does it hold the architecture invariants?**
`CLAUDE.md` lists six. They are not style preferences; violating one breaks the
design rather than the code. The ones most often broken by accident:

- OSM is the only source of truth — no data enters except through `fetch-osm.sh`
- Data refresh is build-time, never runtime
- Paths carry OSM node IDs; connectivity is by shared id, never by proximity
- Always keep only the largest connected component
- Step-free routing is first-class, not an afterthought

**4. Do the map and the router still agree?**
A recurring defect class in this repo, in both directions. Any change touching
`paths`, filters, or layers: confirm the drawn set and the routed set are the same
set, and say which line proves it.

**5. Does it degrade, or does it white-screen?**
The master plan's Layer 8. The data is a public wiki and the basemap is someone
else's server. Ask what happens when the tile host is down, the geojson is empty, a
building has no name. Test it by blocking the request rather than reasoning about it.

**6. Would the tests have caught the bug it fixes?**
A fix without a regression test is a fix that ships twice. Check specifically that
the *new* test fails against the *old* code — a test asserting something already
true is decoration.

**7. Is the change inside the test's reach at all?**
Scope gaps are the quietest defect here. `a11y.spec.js` scans `#top`, `#sheet` and
`#fabs`; anything outside those is unchecked no matter how many tests pass. Before
crediting a test for covering something, confirm the selector actually reaches it.

**8. Does the documentation now claim more than the code does?**
README and commit messages get written from intent. Compare each user-facing claim
against what is actually asserted somewhere — especially claims about privacy,
freshness, and what a test proves.

**9. Run it.** `npm run test:all`. A green suite does not mean the change is right;
it means the findings you have are things the tests do not ask about, which is worth
saying explicitly in the review.

## Severity

| | |
|---|---|
| **Blocker** | Ship this and something breaks, silently loses data, or misleads a user. |
| **Major** | Real defect or a broken guarantee. Fix soon; it costs more later. |
| **Minor** | Worth fixing, no urgency. |
| **Note** | Observation, question, or a risk to write down rather than act on. |

Severity is about consequence, not about how much code it takes to fix. A one-word
filter that puts 566 unroutable paths on screen is a blocker; a 40-line refactor
that changes nothing observable is a note.

## Writing the entry

Newest first in `comments.md`. Per commit: SHA, author, date, a one-line verdict,
what the change got *right*, then findings worst-first.

Each finding needs three things and is not finished without them:

1. **Where** — `file:line`, linked.
2. **What goes wrong** — the concrete failure, with the evidence that it does.
3. **What to do instead** — a specific fix, not "consider revisiting this".

Say what the commit got right, genuinely and first. A review that only lists faults
gets read as noise and then gets ignored, which helps nobody. Most commits in this
repo are good work with a gap in them, and the review should read that way.

Close with a **Verification** section listing what was actually run. It is what
separates this from an opinion.

## What not to do

- Do not review the working tree as though it were a commit. Uncommitted work
  belongs under "In flight", clearly marked, so it is neither reviewed nor lost.
- Do not re-report a finding already open in Standing items. Reference it.
- Do not rewrite someone else's code mid-review. Report it; let the author decide.
- Do not soften a blocker because the commit message is persuasive.

## Setup

The pending-commit check is a plain script and needs nothing:

```bash
./scripts/review-pending.sh          # what is unreviewed?
DEPTH=200 ./scripts/review-pending.sh   # look further back
```

The post-commit nudge needs hooks pointed at the tracked directory once per clone,
because git does not version `.git/hooks`:

```bash
git config core.hooksPath .githooks
```

It only ever prints. A hook that can fail a commit is a hook that gets deleted.
