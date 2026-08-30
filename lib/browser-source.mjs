// @ts-check
/**
 * lib/browser-source.mjs — base class + generic scan engine for login-state
 * job sources.
 *
 * Some job boards (智联招聘, BOSS直聘, 猎聘, …) put their listings behind a
 * login wall and/or anti-bot page: there is no zero-auth JSON API, so they
 * cannot be a `providers/*.mjs` module (that layer is zero-auth HTTP by
 * contract — see providers/README.md). This module is the generalized sibling
 * of `scan-interamt.mjs`: instead of one bespoke root script per board, a board
 * subclasses `BrowserSource`, overrides three per-site methods, and inherits a
 * complete scan engine that behaves byte-for-byte like the existing sources:
 *
 *   • same output shape → `data/pipeline.md` via scan.mjs's `appendToPipeline`
 *   • same filters        → portals.yml `title_filter` / `location_filter`
 *   • same dedup          → scan.mjs's `loadSeenUrls`
 *   • same scan history   → scan.mjs's `appendToScanHistory`
 *
 * These sources are opt-in: they are run through the dedicated
 * `node scan-browser-source.mjs <id>` entry, NEVER through `node scan.mjs`
 * (which only loads the zero-auth provider layer).
 *
 * ── Subclass contract ──────────────────────────────────────────────
 * A subclass must set, via the constructor `def`, or override:
 *   id / label                 — stable machine id + human label
 *   loginUrl                   — page `--login` opens for the user to sign in
 *   defaultKeywords            — fallback keywords when portals.yml has none
 *   configSection              — portals.yml key holding per-source keywords
 *   searchUrl(keyword, page)   — URL of one search-results page
 *   async extract(page)        — raw rows from a loaded results page
 *   normalizeJob(raw)          — raw row → Job ({title,url,company,location,…})
 *
 * Optional overrides: maxPages, pageSizeHint, resultsSelector, verifyPage,
 * locale, timeoutMs, postLoadDelayMs.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  buildLocationFilter,
} from '../scan.mjs';
import { localToday } from './local-today.mjs';

/** Repo root (lib/ is one level down). `new URL('..', import.meta.url)` already
 *  lands on the root; `path.resolve` normalizes away the trailing separator.
 *  (An extra `path.dirname` here would climb one directory too high — the
 *  `..` already accounts for the lib/ level.) */
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const STATE_DIR = path.join(ROOT, 'config', 'browser-state');

/**
 * @typedef {object} Job
 * @property {string} title
 * @property {string} url
 * @property {string} [company]
 * @property {string} [location]
 * @property {string} [description]
 * @property {number} [postedAt]
 * @property {string} [source]
 */

/**
 * @typedef {object} BrowserSourceDef
 * @property {string} id
 * @property {string} label
 * @property {string} loginUrl
 * @property {string[]} defaultKeywords
 * @property {string} configSection
 */

/** Read portals.yml tolerantly — a missing/unparseable file yields {}. An
 *  ephemeral file set via CAREER_OPS_PORTALS (the Explorer's per-search filter
 *  file) takes precedence, so a browser-source scan honours the same ad-hoc
 *  filters as the ATS scanner instead of the user's curated portals.yml. */
function loadPortals() {
  const portalPath = process.env.CAREER_OPS_PORTALS || PORTALS_PATH;
  if (!existsSync(portalPath)) return {};
  try {
    const doc = yaml.load(readFileSync(portalPath, 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

/** Build the title filter predicate from portals.yml's title_filter (positive
 *  = substring include (OR), negative = substring reject). Mirrors scan-interamt.
 *  Exported so the framework's filter semantics are unit-testable. */
export function buildTitleFilter(titleFilter) {
  const tf = titleFilter || {};
  const positive = (tf.positive || []).map((k) => String(k).toLowerCase());
  const negative = (tf.negative || []).map((k) => String(k).toLowerCase());
  return (/** @type {string} */ title) => {
    const lower = String(title || '').toLowerCase();
    if (negative.some((k) => lower.includes(k))) return false;
    if (positive.length === 0) return true;
    return positive.some((k) => lower.includes(k));
  };
}

/** Block for a line of stdin (used by --login to wait for the user). */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve(undefined);
    });
  });
}

export class BrowserSource {
  /**
   * @param {BrowserSourceDef} def
   */
  constructor(def) {
    this.def = def;
  }

  // ── Identity (from def) ──────────────────────────────────────────
  get id() {
    return this.def.id;
  }
  get label() {
    return this.def.label;
  }
  get loginUrl() {
    return this.def.loginUrl;
  }
  get defaultKeywords() {
    return this.def.defaultKeywords || [];
  }
  get configSection() {
    return this.def.configSection || `${this.id}_searches`;
  }
  get storageStatePath() {
    return this.def.storageStatePath || path.join(STATE_DIR, `${this.id}.json`);
  }

  // ── Per-site knobs (override as needed) ──────────────────────────
  /** Max result pages per keyword. */
  get maxPages() {
    return this.def.maxPages ?? 10;
  }
  /** Rows per page, when known — a shorter final page ends the loop early. */
  get pageSizeHint() {
    return this.def.pageSizeHint ?? 0;
  }
  /** A results-container selector, used to tell "no results" from "selector stale". */
  get resultsSelector() {
    return this.def.resultsSelector ?? null;
  }
  get locale() {
    return this.def.locale ?? 'zh-CN';
  }
  get timeoutMs() {
    return this.def.timeoutMs ?? 30000;
  }
  get postLoadDelayMs() {
    return this.def.postLoadDelayMs ?? 1200;
  }
  /** Whether the scan launches a headless browser. Some boards (zhaopin's
   *  Tencent EdgeOne) detect headless and serve a challenge page, so a source
   *  can override to `false` to always run headed. */
  get headless() {
    return this.def.headless ?? true;
  }

  // ── Per-site methods (MUST override) ─────────────────────────────
  /** @returns {string} URL for one search-results page. */
  searchUrl(/* keyword, page */) {
    throw new Error(`${this.id}: searchUrl() not implemented`);
  }
  /** @returns {Promise<object[]>} raw rows parsed from a loaded page. */
  async extract(/* page */) {
    throw new Error(`${this.id}: extract() not implemented`);
  }
  /** @returns {Job|null} one raw row → normalized job, or null to drop it. */
  normalizeJob(/* raw */) {
    throw new Error(`${this.id}: normalizeJob() not implemented`);
  }
  /** Optional post-load sanity check (fail-closed). Default: always healthy. */
  async verifyPage(/* page */) {
    return { ok: true };
  }

  /**
   * Optional: derive a search-region code for the search URL from the portals
   * `location_filter` (e.g. zhaopin's `jl` city code). Default `null` = no
   * narrowing — the source searches its full range and `buildLocationFilter`
   * post-filters by location. A source with server-side region narrowing
   * overrides this to return its code, and reads `this._searchRegion` (set by
   * `run()` once before the keyword loop) inside `searchUrl()`.
   * @param {object} portals parsed portals.yml (or the ephemeral Explorer file)
   * @returns {string|null}
   */
  resolveSearchRegion(/* portals */) {
    return null;
  }

  /**
   * Optional: derive the full set of server-side search-query params from the
   * portals config (e.g. zhaopin's `jl` + `sl/el/we/et/ct/cs`). Default `null`
   * = no extra params — the source searches with `searchUrl()`'s own defaults
   * and post-filters by title/location. A source with server-side condition
   * narrowing overrides this to return a params object (keys are that source's
   * URL param names) and reads `this._searchParams` (set by `run()` once before
   * the keyword loop) inside `searchUrl()`.
   * @param {object} portals parsed portals.yml (or the ephemeral Explorer file)
   * @returns {object|null}
   */
  resolveSearchParams(/* portals */) {
    return null;
  }

  /**
   * Advance to the next page of results — the source's own pagination. The
   * default returns false (single page). A source overrides this to click a
   * "next" control, scroll-to-load, or even `page.goto(this.searchUrl(kw, pageNum))`
   * for URL-based pagination, and returns true when a new page is loaded, false
   * when there are no more pages.
   * @param {import('playwright').Page} page the live browser page.
   * @param {number} pageNum 1-based page we're advancing TO (2, 3, …).
   * @returns {Promise<boolean>}
   */
  async nextPage(/* page, pageNum */) {
    return false;
  }

  // ── Keywords resolution ──────────────────────────────────────────
  /**
   * Precedence: an explicit CLI keyword, then portals.yml's <configSection>
   * (plain strings or {kw}/{was} objects), then defaultKeywords.
   * @param {object} portals
   * @param {string|null} cliKeyword
   * @returns {string[]}
   */
  resolveKeywords(portals, cliKeyword) {
    if (cliKeyword) return [cliKeyword];
    const section = portals[this.configSection];
    if (Array.isArray(section) && section.length) {
      const out = section
        .map((entry) => (typeof entry === 'string' ? entry : entry?.kw ?? entry?.was))
        .filter((k) => typeof k === 'string' && k.trim());
      if (out.length) return out;
    }
    return this.defaultKeywords;
  }

  // ── Engine ───────────────────────────────────────────────────────
  /**
   * Run the full scan: launch chromium, load login state (when present), loop
   * keywords → pages → extract → filter → dedup, then write pipeline +
   * scan-history exactly like the core sources.
   *
   * @param {{dryRun?: boolean, debug?: boolean, keyword?: string|null, keywords?: string[]|null, json?: boolean, onKeyword?: ((kw: string, batch: {offers: object[], errors: {keyword: string, error: string}[], done: number, total: number}) => void|Promise<void>)|null}} [opts]
   */
  async run({ dryRun = false, debug = false, keyword = null, keywords = null, json = false, onKeyword = null } = {}) {
    const portals = loadPortals();
    // An explicit keywords list (the Explorer passes the user's roles) wins over
    // CLI keyword → portals.yml configSection → defaultKeywords resolution.
    const kwList = (Array.isArray(keywords) && keywords.length) ? keywords : this.resolveKeywords(portals, keyword);
    const matchesTitle = buildTitleFilter(portals.title_filter);
    const matchesLocation = buildLocationFilter(portals.location_filter);
    // Resolve any server-side region narrowing (e.g. zhaopin's `jl`) once, before
    // the keyword loop, so `searchUrl()` can read it without re-reading portals.
    this._searchRegion = this.resolveSearchRegion(portals);
    // Same for the full condition-params set (jl + sl/el/we/et/ct/cs).
    this._searchParams = this.resolveSearchParams(portals);
    const { seen } = loadSeenUrls();
    const date = localToday();

    if (!existsSync(this.storageStatePath)) {
      console.warn(
        `⚠️  ${this.id}: no login state at ${this.storageStatePath} — run \`node scan-browser-source.mjs ${this.id} --login\` first (results may be limited without it).`,
      );
    }

    const newOffers = [];
    const titleSkipped = [];
    const locationSkipped = [];
    const dupeSkipped = [];
    const errors = [];

    const browser = await chromium.launch({ headless: this.headless && !debug });
    const context = await browser.newContext({
      locale: this.locale,
      ...(existsSync(this.storageStatePath) ? { storageState: this.storageStatePath } : {}),
    });
    const page = await context.newPage();

    try {
      for (let i = 0; i < kwList.length; i++) {
        const kw = kwList[i];
        if (!json) process.stdout.write(`  Searching "${kw}"... `);
        const kwOffers = [];
        const kwErrors = [];
        try {
          const rows = await this.searchAndExtract(page, kw, debug);
          let kept = 0;
          for (const raw of rows) {
            const job = this.normalizeJob(raw);
            if (!job || !job.title || !/^https?:\/\//i.test(job.url || '')) continue;
            job.source = this.id;
            if (!matchesTitle(job.title)) {
              seen.add(job.url);
              titleSkipped.push(job);
              continue;
            }
            if (!matchesLocation(job.location, job.url, job.title)) {
              seen.add(job.url);
              locationSkipped.push(job);
              continue;
            }
            if (seen.has(job.url)) {
              dupeSkipped.push(job);
              continue;
            }
            seen.add(job.url);
            newOffers.push(job);
            kwOffers.push(job);
            kept++;
          }
          if (!json) process.stdout.write(`${rows.length} found, ${kept} new\n`);
        } catch (err) {
          if (!json) process.stdout.write('ERROR\n');
          const e = { keyword: kw, error: err instanceof Error ? err.message : String(err) };
          errors.push(e);
          kwErrors.push(e);
        }
        // Stream one keyword's fresh offers the moment it's swept, so a CLI host
        // (or the web Explorer) can show incremental results instead of waiting
        // for the whole keyword list to finish.
        if (onKeyword) await onKeyword(kw, { offers: kwOffers, errors: kwErrors, done: i + 1, total: kwList.length });
      }
    } finally {
      await context.close();
      await browser.close();
    }

    if (!dryRun) {
      if (newOffers.length) await appendToPipeline(newOffers);
      if (newOffers.length) await appendToScanHistory(newOffers, date, 'added');
      if (titleSkipped.length) await appendToScanHistory(titleSkipped, date, 'skipped_title');
      if (locationSkipped.length) await appendToScanHistory(locationSkipped, date, 'skipped_location');
      if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
    }

    return { newOffers, titleSkipped, locationSkipped, dupeSkipped, errors, keywords: kwList, date };
  }

  /**
   * Page the search results for one keyword, stopping on an empty page (or a
   * short final page when pageSizeHint is set). Warns — rather than failing —
   * when page 1 is empty so a stale-selector case surfaces without aborting the
   * rest of the run (the per-keyword try/catch in run() does the aborting only
   * when extract() throws).
   */
  async searchAndExtract(page, keyword, debug) {
    const rows = [];

    // Page 1.
    await page.goto(this.searchUrl(keyword, 1), { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    await page.waitForTimeout(this.postLoadDelayMs);

    if (debug) {
      mkdirSync(path.join(ROOT, 'output'), { recursive: true });
      writeFileSync(path.join(ROOT, 'output', `debug-${this.id}.html`), await page.content(), 'utf8');
      console.log(`  [debug] page 1 HTML → output/debug-${this.id}.html  (url: ${page.url()})`);
    }

    const health = await this.verifyPage(page);
    if (!health.ok && health.reason) console.warn(`  ⚠️  ${this.id}: ${health.reason}`);

    let pageRows = await this.extract(page);
    if (!pageRows.length && this.resultsSelector) {
      const hasContainer = !!(await page.$(this.resultsSelector));
      if (hasContainer) {
        console.warn(
          `  ⚠️  ${this.id}: page 1 rendered the results container but parsed 0 rows — selectors may be stale (run with --debug to dump the HTML).`,
        );
      }
    }
    rows.push(...pageRows);

    // Pages 2+ — advanced by nextPage() (client-side pagination). The base
    // nextPage() returns false, so a source that doesn't override it reads page
    // 1 only. A source that paginates by URL can override nextPage() to
    // `page.goto(this.searchUrl(keyword, page))` and return true.
    for (let p = 2; p <= this.maxPages; p++) {
      if (!pageRows.length) break;
      if (this.pageSizeHint > 0 && pageRows.length < this.pageSizeHint) break;
      const advanced = await this.nextPage(page, p);
      if (!advanced) break;
      pageRows = await this.extract(page);
      rows.push(...pageRows);
    }

    return rows;
  }

  /** Open a headed browser, let the user log in, and persist the session. */
  async login() {
    mkdirSync(STATE_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ locale: this.locale });
    const page = await context.newPage();
    try {
      await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log(`\n  Log in to ${this.label} in the browser window, then press Enter here…`);
      await waitForEnter();
      await context.storageState({ path: this.storageStatePath });
      console.log(`✅  Login state saved → ${this.storageStatePath}`);
    } finally {
      await browser.close();
    }
  }
}
