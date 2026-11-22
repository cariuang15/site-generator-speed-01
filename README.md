[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/cariuang15/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/cariuang15/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01

A faster drop-in for make.fun's own `makefun-site` 1.0.0, for the make.fun
bounty **"Build a static site faster, 22 November 2026"**
(`site-generator-speed-01-run-20261122`, $100 over 10 places).

`run(input)` in `solve.js` returns exactly what makefun-site 1.0.0's `build`
returns for the same input — the output tree (each page's `index.html`, the
index and tag pages, `build-report.txt`, each static file) as a JSON object
of path -> text, byte for byte — but faster. `main.ts` is the harness driver
(the house baseline's, unchanged): it reads `/input/cases.json`, answers
each case with `run`, and writes `/output/answers.json`.

## How it is faster

`makefun-site`'s own dialect is reimplemented from its README (front matter,
template dialect, Markdown subset, slug rule, report), with the reference
code as the authority wherever they differ. The speed comes from exact,
behaviour-preserving changes only:

- **Templates compiled**: each parsed template is compiled once per build
  into a small generated function (`new Function`); a template the compiler
  cannot cover falls back to the tree-walking renderer, which is the
  reference algorithm verbatim. Scopes are null-prototype objects linked by
  prototype, so a first-name lookup finds the nearest binding exactly as
  the reference's own-property walk does; later path segments still use
  `Object.hasOwn`.
- **`slugify`**: an ASCII fast path (NFKD + combining-mark stripping are the
  identity on ASCII) plus a per-build cache; tag names and respelled titles
  repeat a lot.
- **Markdown `lex`**: the same regular expressions, each only tried when
  the line's first character could match it.
- **Markdown `inline`**: plain runs are sliced and escaped once per run
  instead of one character at a time (HTML escaping is per-character, so
  the result is identical).
- **`wordsOf`**: word runs counted by a scan over exactly JavaScript's
  `\s` set, instead of building the `/\S+/g` match array.
- **Tags**: each tag name slugified once instead of three times; tag
  validation by `indexOf` instead of a regex.

Nothing is cached from one case to the next: every cache and every compiled
template is created fresh inside one `run(input)` call.

## Test results (prep, 22 Nov 2026)

- Practice set (kit): **3/3 cases byte-identical** to the reference and to
  `practice/reference/expected.json`.
- 4 extra sets drawn with the kit's own generator from other seeds:
  **12/12 cases byte-identical** to the reference.
- Kit `grade-local --driver process`: `passed: 1`, `cases_passed: 3/3`,
  L1 regrade reproduced byte for byte.
- Speed (build only, warmed medians): **1.82–2.17x** faster than the house
  baseline on the practice set. Cold end-to-end (`node main.ts`, fresh
  process, all 3 practice cases): median 813 ms vs baseline 1068 ms.

Repo size is ~40 KB, far under the 4 MiB cap. No dependencies, no network,
no WebAssembly, no native code.
