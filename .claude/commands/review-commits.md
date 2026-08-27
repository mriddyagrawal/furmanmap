---
description: Review every unreviewed commit into comments.md
---

Act as this repository's commit reviewer.

1. Run `./scripts/review-pending.sh` to get the list of unreviewed commits. If it
   reports nothing to review, say so and stop — do not invent work.
2. Read [`docs/reviewing.md`](../../docs/reviewing.md) and follow it. It is the
   method, including the severity scale and the entry format.
3. Read [`CLAUDE.md`](../../CLAUDE.md) for the architecture invariants, and
   [`plans/masterplan.md`](../../plans/masterplan.md) for the phase the work sits in.
4. Review each pending commit, oldest first. **Verify every finding before you write
   it** — query the data, drive a browser, block a request, run `npm run test:all`.
   An unverified claim goes under "Note", labelled as unverified.
5. Prepend the entries to `comments.md`, newest first, above the existing ones and
   below the header. Update the **Standing items** table: add anything that now spans
   more than one commit, and close anything a commit has fixed.
6. Commit `comments.md` on the current branch with `docs: review <shas>`.

Arguments, if given, narrow the scope: `$ARGUMENTS` may be a SHA, a range, or a
branch. With no arguments, review everything pending.

Constraints:

- Review commits, not the working tree. Uncommitted changes go under "In flight",
  clearly marked as not-a-review.
- Do not fix the code you are reviewing. Report it and let the author decide.
- Commit only `comments.md`. Other instances may have work in progress in the same
  tree — never `git add -A`, never `git commit -a`.
- Say what each commit got right, first and genuinely.
