---
name: career-ops
description: Use when developing in the career-ops job-search pipeline.
version: 1.0.0
author: hermes
license: MIT
---

# career-ops development

## When to Use

- The user asks to modify, extend, or debug the `career-ops` project (or refers to
  it by name, its web UI, or "add a job source / 招聘来源").
- Adding or repairing a job source (provider, ATS scan, or login-state browser source).
- Navigating its scan pipelines, `portals.yml` config, or the `providers/` / `web/` layers.
- Attaching to a persistent BOSS Chrome instance via CDP, or changing the
  login-state browser harness for `browser-sources/boss.{py,mjs}`.

Fork of `santifer/career-ops` at `D:/Agent/hermesAgent/workspace/career-ops`. Plain
ESM JavaScript, **no build step**; `.mjs` scripts live flat at the repo root
("one script = one job" is a deliberate convention). `playwright@1.62.1` is a
dependency (chromium installed via `postinstall`). The web UI is a Next.js app
under `web/`. BOSS 相关自动化走 **persistent Chrome + CDP attach** 架构：用一个带
`--remote-debugging-port=9222` 的独立 Chrome 实例承载登录态，parse/login 只 attach
不关窗，只在内部开 throwaway tab。旧版 nodriver 即用即弃改为 attach 模式；详情页
parse 当前也优先走这条路径。

## Web dev server & VSCode debugging

`web/` = Next.js 16 (Turbopack dev) + React 19 + TS; `npm run dev` → :3000,
node >= 22. VSCode debugging of `.tsx` / route handlers is set up in
`.vscode/launch.json` (Full Stack config = dev server + Node attach + Chrome
attach in one F5). See `references/web-vscode-debugging.md` for the config,
the verified startup pattern, the ~14s first-request compile, and the Windows
gotcha: killing the `npm run dev` wrapper leaves the `next dev` child holding
:3000 — kill the PID found via `netstat -ano | grep ':3000'` with PowerShell
`Stop-Process` (`taskkill //PID` breaks under git-bash MSYS conversion). A known-good
copy of the launch config is at `templates/launch.json` (strict JSON — no comments).
If the tree is locked by a stale dev server, start a second dev server on an
alternate port instead of trying to reuse the same working directory.

## Architecture — the two scan pipelines (don't confuse them)

1. **Reverse ATS discovery** — `scan-ats-full.mjs`. Walks company *directories*
   (Greenhouse / Lever / Ashby / Workday / iCIMS) fetched from an external
   `job-board-aggregator` dataset, hitting each company's public ATS API. The
   web Explore "Scan" mode and its "Sources" filter (`web/src/lib/explore.ts`
   `AtsSource`) call ONLY this pipeline; the web exposes 4 ATS (not iCIMS).
2. **Zero-auth portal scan** — `scan.mjs` + `portals.yml`. Loads every
   `providers/*.mjs`, auto-detects each `tracked_companies` entry by
   `careers_url` or an explicit `provider:` field. ~80+ boards here.

Results from either land in `data/pipeline.md`, dedup against
`data/scan-history.tsv`.

## Web UI state semantics

Explore results, Pipeline inbox rows, browser Shortlist items, evaluations, and
tracker applications are separate states with different persistence and costs.
Before explaining or changing these flows, read
`references/web-pipeline-triage-semantics.md`; it maps the complete UI → provider →
API → core-writer chain, undo/dedup consequences, and the current raw-Inbox detail-link gap.

## Provider contract (providers/)

Each `providers/*.mjs` default-exports `{ id, detect(entry)?, fetch(entry, ctx) → Job[] }`.
`_`-prefixed files are shared helpers, never loaded. **Zero-auth HTTP ONLY** —
`providers/README.md` states auth-gated / login-required sources do NOT belong in
core. `_registry.mjs` loads files alphabetically (deterministic detect priority);
routing is explicit `provider:` → local-parser → `detect()` in load order.

Job shape: `title` + `url` required; `company`/`location` optional; `description`
only when the list payload carries it for free (no per-job fetch); `postedAt`
epoch ms; `salary` renders as the pipeline's 5th (compensation) column.
**`salary` MUST be `{min, max, currency}` (numbers + string currency) — a plain
string is silently dropped** by `formatCompensation`, so parse board salary text
into that shape (e.g. zhaopin's `parseSalary("9001-12000")` → `{min:9001, max:12000, currency:'CNY'}`).

## Login-gated sources (the exception path)

Boards behind a login wall / anti-bot page (智联招聘 / BOSS直聘 / 猎聘) have no
zero-auth API, so they CANNOT be `providers/` modules — the project also rejects
login-scraping from core (`CONTRIBUTING.md`). They are built as **standalone
browser-source scanners** (precedent: `scan-interamt.mjs`) through a `BrowserSource`
framework added in 2026-08. See
`references/login-state-browser-sources.md` for the full how-to (base class
contract incl. the `nextPage` pagination hook and the infinite-scroll
XHR-interception `extract` pattern, adding a source, selector verification, CLI,
the anti-bot landscape, and the account-safety login-capture discipline for
risk-controlled boards — with a ready async capture script at
`templates/login-capture.mjs` (real-Chrome stealth login, no stdin wait)). The
web Explore UI surfaces these as a SEPARATE
"登录态来源" group (方案A: scan ATS AND spawn `scan-browser-source.mjs --jsonl`, merging
results streamed per keyword) — see `references/web-explore-login-sources.md` for the
machine contract, the login-only flow, and the timeout-scaling pitfall. The
AI-search entry routes natural-language intents that name a login source (e.g.
"在智联招聘上找…") straight to the scanner, with keywords/conditions extracted by
the user's configured CLI via LLM intent recognition ONLY (the regex tokenizer
fallback was removed — it mangled Chinese request phrasing; no `cliId` → 404,
unparseable LLM output → loud 502) — see the AI-search section of
`references/web-explore-login-sources.md`, and `references/zhaopin-search-query.md`
for the full zhaopin search-condition schema (dimensions → URL params → value
encodings) + how to rediscover it for BOSS直聘/猎聘.

**BOSS直聘 is NOT a Playwright source** — its risk control rejects every
Playwright/CDP flavor (headed real Chrome included, with or without a valid
session) and will force-logout the account on a sustained reload loop. It needs
a **nodriver** sidecar instead (drives real Chrome with `navigator.webdriver=
False`), plus the font-obfuscation XHR-extraction and the v20-cookie/graceful-
close pitfalls. Full recon + approach: `references/boss-zhipin-nodriver.md`.

## Explore paste-link parse (third entry) + planning workflow

Third discovery entry (paste a zhaopin/boss job-detail link → `DiscoveredOffer`
card). `DiscoveredOffer` has **no salary field** (salary is out of scope for the
card), zhaopin detail is `__INITIAL_STATE__.jobDetail.detailedPosition` (nested),
boss detail is SSR + anonymous-renders card fields. See
`references/explore-paste-link-parse.md`.

**New requirement phases run through planning-with-files** (user's standing
preference, stated 2026-09): init an isolated plan
(`/pwf <name>` → `.planning/YYYY-MM-DD-<slug>/`) BEFORE coding, keep
`task_plan.md`/`findings.md`/`progress.md` updated as decisions and recon land.

## Reusable scan.mjs exports (reuse, don't reimplement)

- `appendToPipeline(offers, {pipelinePath})` — writes `- [ ] URL | company | title | location` rows
- `appendToScanHistory(offers, date, status)` — TSV row per offer
- `loadSeenUrls()` → `{ seen: Set[url] }` — dedup
- `buildLocationFilter(locFilter)` → `(location, url, title) => boolean` — full tier semantics (block_hard > always_allow > block > allow)
- `formatPipelineOffer(offer)` — Job → pipeline line; salary OPTIONAL (5th col = compensation only when present; a no-salary offer → valid 4-col `url|company|title|location` row, 3-col if location empty too)
- `formatCompensation(salary)` — `{min,max,currency}` → "9000-12000 CNY"; returns '' for a non-object

`scan.mjs` is safe to `import` (main is `isMainModule`-guarded) — `scan-interamt.mjs`,
`plugins.mjs`, and browser-source scanners all import from it.

## Retargeting the user's target roles (job-focus change)

When the user states their current job focus (e.g. "我最近关注的岗位：数据分析，BI,用户运营"),
that is a retarget signal — move the whole chain together, not one file:

1. `portals.yml` → `title_filter.positive` — replace with the new role keyword
   groups (English + Chinese variants). 2-3 letter keywords (e.g. `BI`) auto-match
   on WORD BOUNDARIES: `BI` hits "Power BI" but NOT "BIOS"/"BIM" (verified against
   the real matcher). Longer keywords are plain case-insensitive substrings
   (`数据分析` covers 数据分析师/专员/经理/总监).
2. `portals.yml` → `<source>_searches` (e.g. `zhaopin_searches`) — uncomment/update
   the browser-source keyword lists. While commented out, the source silently falls
   back to its constructor `defaultKeywords` (zhaopin: `['java','前端开发','数据分析']`).
   Chinese boards: prefer full Chinese keywords — a bare `BI` on 智联 is full-text
   search noise (title_filter still post-filters it, but search recall suffers;
   `商业智能` is the cleaner keyword).
3. `data/pipeline.md` Pending rows from the OLD focus are noise — clear them. They
   came from old-role scans; `scan-history.tsv` keeps URL dedup so nothing resurrects.
   Old-role rows linger otherwise and mislead triage.

Verify, don't eyeball:
- `portals.yml` and `data/` are NOT git-tracked — `git diff` is silent on them;
  confirm via direct read / YAML parse.
- js-yaml v5 is ESM with NAMED exports only: `import * as yaml from 'js-yaml'`
  (scan.mjs's own style). `(await import('js-yaml')).default` is undefined.
- Test the real matcher against a case matrix: `buildTitleFilter` lives in
  `title-keywords.mjs` (re-exported by scan.mjs). Ready probe:
  `node scripts/verify-title-filter.mjs <repo-root>` (from this skill's `scripts/`)
  — per-title pass/fail, non-zero exit on any mismatch. Extend its case list when
  the user's roles change again.

## Test & lint conventions

- Tests: `tests/**/*.test.mjs`, auto-discovered by `test-all.mjs` (no registration).
- Assert via `pass(msg)` / `fail(msg)` from `tests/helpers.mjs`; load the module
  under test with `await import(pathToFileURL(join(ROOT, ...)).href)` (use `ROOT`
  from helpers). **Do NOT call `finish()`** in a discovered suite (test-all.mjs is
  the host). No `process.exit()`.
- Run one suite: `node test-all.mjs --only <path-fragment>`.
- Lint: `npm run lint` = `node scripts/check-syntax.mjs` (syntax check of all `.mjs`).
- Export pure parser/URL/normalize functions from a source module so the suite can
  test them without a browser.

## Compliance gates (before proposing/adding any source)

- `CONTRIBUTING.md` "Source Indexing Policy" (5 rules) + `docs/SOURCE_INDEXING_LOG.md`.
- A `robots.txt` entry naming a crawler (or `ClaudeBot`-class blocks) is treated as
  the site owner's intent, not a UA string to route around.
- `docs/SUPPORTED_JOB_BOARDS.md` has an "Evaluated, not supported" section
  (Glassdoor / Dice / EchoJobs) recording boards rejected for bot-protection.
- Login-scraping / authenticated-access sources are **not shipped in core or in the
  bundled plugin registry** (`docs/PLUGIN_REVIEW.md`) — local-only at most.

## Adding a source — decision tree

1. Public zero-auth API / RSS / server-rendered page → add `providers/<id>.mjs`
   + `tests/providers/<id>.test.mjs` + a row in `docs/SUPPORTED_JOB_BOARDS.md`.
2. Login-walled / anti-bot page → add `browser-sources/<id>.mjs` (BrowserSource
   subclass) — see the reference. Do NOT touch `providers/`. **Exception:
   BOSS直聘 needs a nodriver (Python) sidecar, not a Playwright subclass** — see
   `references/boss-zhipin-nodriver.md`.
3. Web Explore "Sources" chip = reverse-ATS only (a board-wide marketplace is NOT
   an ATS and does not fit there); a login-state source is surfaced as the
   separate "登录态来源" group instead — see `references/web-explore-login-sources.md`.
4. If the source's primary failure mode is "works only with the user's real
   browser/session", prefer attaching to a persistent debug Chrome instance over
   launching ephemeral browsers. The persistent Chrome contract lives in
   `references/boss-chrome-cdp.md`.

## React hook ordering (TS strictness)

Hooks must be declared before any callback that closes over them. If you move a
`useState`/`useRef` below a `useCallback`, TypeScript reports the closed-over
variable as "used before its declaration" (`TS2448`). Fix by reordering, not by
removing `useCallback`.

## BOSS login-wall UI (PasteLinkBar)

Do not render BOSS login walls as red/amber errors. Use a neutral info row
(`text-muted` + Lock icon + "该岗位需登录 BOSS 后查看") with a brand action
button. On login-start, switch the button to `Loader2` + "等待登录完成…".
When auto-retrying after login, go straight to parsing; only fall back to the
error row if the retry itself fails.

If `/api/explore/login-intent` fails, return a `debug` object containing the last
chunks of `stdout`/`stderr` from `boss.py --login` or the most recent CDP attach
failure from the persistent Chrome harness.

## Windows Python sidecar encoding

When a Python sidecar emits Chinese JSON over stdout on Windows, write JSON with
`ensure_ascii=True` AND set the spawn env to `PYTHONIOENCODING=utf-8`. Either one
alone can be insufficient if parent process encoding is not UTF-8.

## Nodriver teardown isolation

A nodriver browser teardown must be wrapped in try/except for BOTH browser stop
paths (`browser.stop()` and `browser.aclose()`); do NOT unconditionally chain them
if the first one already closed the process. The verified Windows pattern is:
`browser.stop()` first, then `browser.aclose()`, each guarded. A tight
`await asyncio.sleep(...)` is not required and can race the event loop on Windows.
If a login handoff completes successfully but `browser.aclose()` raises
`AttributeError: 'NoneType' object has no attribute 'wait_closed'`, treat the
session as saved anyway — the marker/profile write already happened before teardown.

## Persistent Chrome for BOSS (current default)

For BOSS, prefer a **persistent Chrome instance** over per-request launches.
Launch it once with `--remote-debugging-port=9222` + a dedicated `user-data-dir`,
then reuse it for parse/login flows. The persistent instance must NOT be closed
by automation — use throwaway tabs for parsing/scanning. When changing Chrome
launch/attach logic, read `references/boss-chrome-cdp.md` for the Windows
launch, attach, tab ownership, and failure-recovery rules.

## Failure-recovery rule for BOSS login/parse UI

If a BOSS login or parse action fails before the user has taken visible action,
clean up the visible state instead of leaving the UI permanently stuck. The
verified pattern is: on startup failure, reset the button/label to the original
neutral state so the user can retry without reloading the page. Do not leave a
loader/in-progress state as the final surface state on failure.

## planning-with-files cadence

Keep `.planning/<slug>/progress.md` updated after every substantive turn. When a
planned phase becomes effectively complete, mark it complete and state the
artifact/evidence (command outputs, test counts). If concurrent agents may edit
the same planning file, read it first and append only the new entries; do not
blindly overwrite another agent's concurrent update.
