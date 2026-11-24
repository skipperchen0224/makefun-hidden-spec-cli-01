# makefun-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skipperchen0224/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skipperchen0224/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` — one patch tool for every AI edit format, built for the
[hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on [make.fun](https://make.fun). AI coding tools all emit edits in
different shapes; `mend` takes any of them and applies them to your
files, the same way, every time.

`main.ts` is the whole tool (Node 22, standard library only, no
dependencies, no model calls, no API key); `runner.ts` is the kit's
runner, which hands trials over to `main.ts` when `MAKEFUN_ENV_URL`
is set.

## What it does

One command, four patch formats:

- **Unified diff** — classic `---`/`+++` hunks.
- **SEARCH/REPLACE** — search block in, replacement block out.
- **V4A** — the `*** Begin Patch` / `*** Update File:` format.
- **JSON edits** — structured edits to JSON files.

Every edit is applied with three matching tiers, tried in order:

1. **Exact match** — the patch's context matches the file byte for byte.
2. **Trailing-whitespace-insensitive** — same text, ignoring trailing
   whitespace differences.
3. **Leading-and-trailing-whitespace-insensitive** — same text,
   ignoring whitespace at both ends, with the replacement
   automatically re-indented to the file's indentation.

And it is all-or-nothing: either every edit in a patch applies, or
nothing is written. Successful writes are atomic, so a file is never
left half-patched.

## Verification

Against the kit's practice set: **100/100, practice score 1000**
(unified diff 30, SEARCH/REPLACE 20, V4A 20, JSON edits 15, CLI 15).

## Run it

```sh
node main.ts <argv>
```

Run it in a directory holding the files to patch, with the patch on
standard input (or as the arguments the check specifies). To verify
locally, run the kit's `check.ts` against the practice set — it runs
`main.ts` on each practice check the same way the harness does and
reports the score.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
