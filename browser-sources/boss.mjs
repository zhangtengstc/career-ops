// @ts-check
/**
 * browser-sources/boss.mjs — BOSS直聘 (zhipin.com) login-state source.
 *
 * The NODE half of the boss source. The browser work (login handoff + search +
 * extraction) is done by the nodriver Python sidecar `browser-sources/boss.py`
 * — BOSS risk control rejects Playwright/CDP-driven browsers, so the base
 * `BrowserSource` engine (Playwright) cannot be used here. This module keeps
 * the SAME contract as every other source (id / label / run / login), spawns
 * the sidecar, and applies title/location filter + dedup + pipeline writes in
 * JS by reusing scan.mjs's pure functions — so output is byte-identical to the
 * zhaopin source.
 *
 * See docs/dev-team/carreer-ops/recon-report.md for the full recon trail
 * (nodriver rationale, Vue `jobList` plaintext schema, R4 code table, hard
 * discipline, account-residual-risk history).
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  loadSeenUrls,
  buildLocationFilter,
} from '../scan.mjs';
import { buildTitleFilter } from '../lib/browser-source.mjs';
import { localToday } from '../lib/local-today.mjs';
import { resolvePythonExecutable } from '../web/src/lib/python-env.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const BOSS_PY = path.join(ROOT, 'browser-sources', 'boss.py');
const DEFAULT_CITY = '101020100'; // 上海

// ── pure helpers (exported for tests, mirror zhaopin.mjs) ────────────────

/**
 * Build the zhipin geek search URL. BOSS paginates client-side (pageVo.page +
 * hasMore); the `page` URL param is accepted but the SPA drives paging itself.
 * @param {string} keyword
 * @param {number} [page]
 * @param {string} [cityCode]
 * @returns {string}
 */
export function buildSearchUrl(keyword, page = 1, cityCode = DEFAULT_CITY) {
  const q = new URLSearchParams({ query: keyword, city: cityCode });
  if (page > 1) q.set('page', String(page));
  return `https://www.zhipin.com/web/geek/job?${q.toString()}`;
}

/**
 * Parse a BOSS salary display ("18-35K", "18-35K·13薪", "30K以上") into the
 * pipeline compensation contract. The ·N薪 bonus suffix does not change the
 * monthly range. Unknown shapes → null (drop the field, stay broad).
 * @param {unknown} value
 * @returns {{min:number,max:number,currency:string}|null}
 */
export function parseSalary(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '面议' || s === '薪资面议') return null;
  const norm = s
    .replace(/·\s*\d+\s*薪/g, '')
    .replace(/k/g, 'K')
    .replace(/\s+/g, '');
  const range = norm.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)K$/);
  if (range) {
    const min = Math.round(Number(range[1]) * 1000);
    const max = Math.round(Number(range[2]) * 1000);
    if (min > 0 && max >= min) return { min, max, currency: 'CNY' };
  }
  const above = norm.match(/^(\d+(?:\.\d+)?)K以上$/);
  if (above) {
    const min = Math.round(Number(above[1]) * 1000);
    // "以上" is open-ended; collapsed to min=max (no invented upper bound) —
    // consistent with zhaopin's parseSalary single-number convention.
    if (min > 0) return { min, max: min, currency: 'CNY' };
  }
  const single = norm.match(/^(\d+(?:\.\d+)?)K$/);
  if (single) {
    const n = Math.round(Number(single[1]) * 1000);
    if (n > 0) return { min: n, max: n, currency: 'CNY' };
  }
  return null;
}

/**
 * Normalize a raw Vue job object (from boss.py) into the pipeline Job shape.
 * Pure — exported for tests.
 * @param {object} raw
 * @returns {{title:string,url:string,company:string,location:string,salary?:{min:number,max:number,currency:string}}|null}
 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? '').trim();
  const url = String(raw.url ?? '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const out = {
    title,
    url: url.replace(/^http:\/\//i, 'https://'),
    company: String(raw.company ?? '').trim(),
    location: String(raw.location ?? '').trim(),
  };
  const salary = parseSalary(raw.salaryDesc);
  if (salary) out.salary = salary;
  return out;
}

/** Load portals.yml (or the ephemeral CAREER_OPS_PORTALS) tolerantly. */
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

// ── sidecar bridge ───────────────────────────────────────────────────────

/**
 * Spawn the Python sidecar and stream its NDJSON stdout lines to `onLine`.
 * @param {string[]} args
 * @param {(line: string) => void} onLine
 * @returns {Promise<{code: number|null, stderr: string}>}
 */
function spawnSidecar(args, onLine) {
  return new Promise((resolve) => {
    // Resolve the interpreter explicitly (D-006): an Explorer/cmd-started
    // parent can have a PATH whose `python` lacks nodriver (e.g. the
    // agent-reach venv), killing boss.py on import with no stdout.
    const pythonExe = resolvePythonExecutable({ requireModule: 'nodriver' });
    if (!pythonExe) {
      resolve({ code: 1, stderr: 'no python with nodriver found — set CAREER_OPS_PYTHON to the boss.py interpreter' });
      return;
    }
    const child = spawn(pythonExe, [BOSS_PY, ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** @type {import('../lib/browser-source.mjs').BrowserSource & object} */
const boss = {
  id: 'boss',
  label: 'BOSS直聘 (zhipin.com)',
  loginUrl: 'https://www.zhipin.com/web/geek/job',
  defaultKeywords: ['数据分析', 'BI', '用户运营'],
  configSection: 'boss_searches',

  /** Open a nodriver Chrome window for the user to sign in (handoff). */
  async login() {
    const { code, stderr } = await spawnSidecar(['--login'], () => {});
    if (code !== 0) console.error(`boss --login exited ${code}: ${stderr}`);
  },

  /**
   * Run the scan: spawn the sidecar per keyword stream, filter + dedup in JS,
   * emit the same NDJSON the web Explorer expects, and write pipeline/history.
   */
  async run({ dryRun = false, keyword = null, keywords = null, json = false, onKeyword = null, maxPages = 5 } = {}) {
    const portals = loadPortals();
    const section = portals[this.configSection];
    const kwList = (Array.isArray(keywords) && keywords.length)
      ? keywords
      : (keyword ? [keyword]
        : (Array.isArray(section) && section.length
          ? section.map((e) => (typeof e === 'string' ? e : e?.kw ?? e?.was)).filter((k) => typeof k === 'string' && k.trim())
          : this.defaultKeywords));

    const matchesTitle = buildTitleFilter(portals.title_filter);
    const matchesLocation = buildLocationFilter(portals.location_filter);
    const { seen } = loadSeenUrls();
    const date = localToday();

    const newOffers = [];
    const titleSkipped = [];
    const locationSkipped = [];
    const dupeSkipped = [];
    const errors = [];

    const handleLine = (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.done === true && frame.source === 'boss') return; // terminal frame
      const kw = frame.keyword ?? '';
      const rawJobs = Array.isArray(frame.rawJobs) ? frame.rawJobs : [];
      const kwErrors = Array.isArray(frame.errors) ? frame.errors : [];
      const kwOffers = [];
      for (const raw of rawJobs) {
        const job = normalizeJob(raw);
        if (!job) continue;
        job.source = this.id;
        if (!matchesTitle(job.title)) { seen.add(job.url); titleSkipped.push(job); continue; }
        if (!matchesLocation(job.location, job.url, job.title)) { seen.add(job.url); locationSkipped.push(job); continue; }
        if (seen.has(job.url)) { dupeSkipped.push(job); continue; }
        seen.add(job.url);
        newOffers.push(job);
        kwOffers.push(job);
      }
      for (const e of kwErrors) errors.push({ keyword: kw, error: e });
      if (onKeyword) onKeyword(kw, { offers: kwOffers, errors: kwErrors.map((e) => ({ keyword: kw, error: e })), done: frame.done, total: frame.total });
    };

    // O2 fail-fast (matches the web loginStatePath check): without the marker
    // written by boss.py on a successful login/scan, spawn nothing — a headed
    // window would just report "not logged in" after a pointless browser start.
    const markerPath = path.join(ROOT, 'config', 'browser-state', 'boss.json');
    if (!existsSync(markerPath)) {
      const err = `未找到登录态，请先运行 node scan-browser-source.mjs boss --login 登录后重试`;
      if (onKeyword) onKeyword(kwList[0] ?? '', { offers: [], errors: [{ keyword: kwList[0] ?? '', error: err }], done: 0, total: kwList.length });
      errors.push({ keyword: '', error: err });
      return { newOffers: [], titleSkipped: [], locationSkipped: [], dupeSkipped: [], errors, keywords: kwList, date };
    }

    const { code, stderr } = await spawnSidecar(
      ['--jsonl', '--keywords', kwList.join(','), '--max-pages', String(maxPages)],
      handleLine,
    );
    if (code !== 0 && stderr) console.error(`boss sidecar stderr: ${stderr}`);

    if (!dryRun) {
      if (newOffers.length) await appendToPipeline(newOffers);
      if (newOffers.length) await appendToScanHistory(newOffers, date, 'added');
      if (titleSkipped.length) await appendToScanHistory(titleSkipped, date, 'skipped_title');
      if (locationSkipped.length) await appendToScanHistory(locationSkipped, date, 'skipped_location');
      if (dupeSkipped.length) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
    }

    return { newOffers, titleSkipped, locationSkipped, dupeSkipped, errors, keywords: kwList, date };
  },
};

export default boss;
