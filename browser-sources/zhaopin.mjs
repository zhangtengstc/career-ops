// @ts-check
/**
 * browser-sources/zhaopin.mjs — 智联招聘 (zhaopin.com) login-state source.
 *
 * zhaopin.com's search (sou.zhaopin.com → www.zhaopin.com/jobs) is a Vue SSR
 * app behind Tencent Cloud EdgeOne bot protection: headless browsers are served
 * a "正在验证连接安全性" checkbox challenge, so this source forces HEADED mode
 * (`headless: false`). The job list is hydrated into `window.__INITIAL_STATE__`
 * — position objects carry `name`/`positionURL`/`companyName`/`salaryReal`/
 * `publishTime`, which is far more robust than DOM selectors and leaks the real
 * salary even when the DOM renders it masked (`**-**元`).
 *
 * Anonymous access returns ~20 positions per keyword; a logged-in session
 * (via `--login`) lifts the `job-list-login-gate` blur and turns the list into
 * an infinite scroll: scrolling the window to the bottom fires
 * `fe-api.zhaopin.com/c/i/search/positions` (20 more rows per call, same
 * object shape as `positionList`), which `extract()` intercepts and accumulates
 * until `hasMore` turns false or the max-rounds cap is hit. The `?p=N` URL
 * param is ignored, so pagination is client-side only.
 *
 * Verify / tune: `node scan-browser-source.mjs zhaopin --login` once, then
 * `… zhaopin --keyword java --debug --dry-run` (HTML → output/debug-zhaopin.html).
 *
 * Known city codes (jl=): 北京 530 · 上海 538 · 天津 531 · 深圳 765 ·
 * 广州 763 · 杭州 653 · 苏州 639 · 南京 635 · 武汉 736 · 长沙 749 · 重庆 551.
 */

import { BrowserSource } from '../lib/browser-source.mjs';

const DEFAULT_CITY_CODE = '489'; // 489 = nationwide (jl=489)

/** zhaopin `jl` city codes (see the module doc note for the known list). */
const CITY_CODES = {
  北京: '530', 上海: '538', 天津: '531', 深圳: '765', 广州: '763',
  杭州: '653', 苏州: '639', 南京: '635', 武汉: '736', 长沙: '749', 重庆: '551',
  Beijing: '530', Shanghai: '538', Tianjin: '531', Shenzhen: '765', Guangzhou: '763',
  Hangzhou: '653', Suzhou: '639', Nanjing: '635', Wuhan: '736', Changsha: '749', Chongqing: '551',
};

/**
 * Resolve a single search-region `jl` code from a location `allow` list, so the
 * search itself can be narrowed instead of fetching nationwide then post-filtering.
 * Returns the code ONLY when every `allow` entry maps to the SAME known city
 * (e.g. ["上海"] or ["上海","Shanghai"] → "538"); otherwise `null` → search
 * nationwide (489) and let `buildLocationFilter` post-filter. Any entry that is
 * not a known city ("Remote", "远程", an unknown city) forces nationwide, and so
 * does a multi-city allow list. Pure — exported for tests.
 * @param {string[]} allow
 * @returns {string|null}
 */
export function resolveCityCode(allow) {
  if (!Array.isArray(allow) || allow.length === 0) return null;
  const codes = new Set();
  for (const raw of allow) {
    const code = CITY_CODES[String(raw).trim()];
    if (!code) return null;
    codes.add(code);
  }
  return codes.size === 1 ? [...codes][0] : null;
}

// ── semantic search-condition → zhaopin codes ──────────────────────
// The AI-search layer emits SEMANTIC values (e.g. "本科", "3-5年", "15-25K",
// "全职", "国企", "1000人以上"); this module maps them to zhaopin's URL codes
// so the mapping stays next to the source that owns those codes (and stays
// unit-testable). Unknown/empty values are dropped — the search stays BROAD
// rather than wrongly narrowed. Full code table: skill references/zhaopin-search-query.md.

export const EDUCATION_CODES = {
  '不限': '-1', '初中及以下': '9', '初中': '9', '高中': '7',
  '中专': '12', '中技': '12', '大专': '5', '本科': '4',
  '硕士': '3', '研究生': '3', 'MBA': '10', 'EMBA': '10', '博士': '1',
};

export const EXPERIENCE_CODES = {
  '不限': '-1', '经验不限': '-1', '应届': '0001', '1年以下': '0001', '1年以内': '0001',
  '1-3年': '0103', '1到3年': '0103', '1~3年': '0103',
  '3-5年': '0305', '3到5年': '0305', '3~5年': '0305',
  '5-10年': '0510', '5到10年': '0510', '5~10年': '0510',
  '10年以上': '1099', '10年及以上': '1099', '十年以上': '1099',
};

export const JOB_STATUS_CODES = {
  '不限': '-1', '全职': '2', '兼职': '1', '临时': '1', '实习': '4', '校园': '5',
};

export const COMPANY_TYPE_CODES = {
  '不限': '', '国企': '1', '国有企业': '1', '央企': '1',
  '外企': '2;3', '外资': '2;3', '外商': '2;3',
  '合资': '4', '民营': '5', '私企': '5', '民营企业': '5',
  '上市公司': '9', '股份制': '8', '事业单位': '6;10',
};

export const COMPANY_SIZE_CODES = {
  '不限': '-1', '20人以下': '1', '20人以内': '1',
  '20-99人': '2', '20到99人': '2',
  '100-299人': '3', '100到299人': '3',
  '300-499人': '8', '500-999人': '4',
  '1000-9999人': '5', '1000到9999人': '5',
  '1000人以上': '6', '10000人以上': '6', '万人以上': '6',
};

/** 薪资档位标签 → zhaopin `sl` 区间码。LLM 被要求只输出这些标签之一。 */
export const SALARY_CODES = {
  '4K以下': '0000,4000', '4K以内': '0000,4000', '4K及以下': '0000,4000',
  '4-6K': '4001,6000', '4K-6K': '4001,6000', '4到6K': '4001,6000',
  '6-8K': '6001,8000', '6K-8K': '6001,8000', '6到8K': '6001,8000',
  '8-10K': '8001,10000', '8K-10K': '8001,10000', '8到10K': '8001,10000',
  '10-15K': '10001,15000', '10K-15K': '10001,15000', '10到15K': '10001,15000',
  '15-25K': '15001,25000', '15K-25K': '15001,25000', '15到25K': '15001,25000',
  '25-35K': '25001,35000', '25K-35K': '25001,35000', '25到35K': '25001,35000',
  '35-50K': '35001,50000', '35K-50K': '35001,50000', '35到50K': '35001,50000',
  '50K以上': '50001,9999999', '50K及以上': '50001,9999999',
};

/** Normalize a salary label ("15K-25K", "15-25K", "15000-25000元/月") → its
 *  zhaopin `sl` code, or null (unknown / 不限 / 面议 → leave salary unbounded). */
export function resolveSalaryCode(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '不限' || s === '面议') return null;
  const norm = s
    .replace(/元\s*\/\s*月/g, '')
    .replace(/元/g, '')
    .replace(/\/\s*月/g, '')
    .replace(/\s+/g, '')
    .replace(/k/g, 'K');
  return SALARY_CODES[norm] ?? null;
}

/**
 * Map a semantic search-conditions object (from the AI-search intent layer) +
 * a location `allow` list into zhaopin's URL query params. Pure — exported for
 * tests. Unknown/empty values are dropped, so a partial intent (only keyword +
 * city) still narrows just `jl` and leaves every other dimension broad.
 * @param {object} [searchParams] keys: salary/education/experience/jobStatus/companyType/companySize (semantic values)
 * @param {string[]} [allow] location `allow` list (maps to `jl` via resolveCityCode)
 * @returns {{jl:string} & Record<string,string>}
 */
export function mapSearchParams(searchParams = {}, allow = []) {
  const sp = searchParams || {};
  const out = { jl: resolveCityCode(allow) || DEFAULT_CITY_CODE };
  const salary = resolveSalaryCode(sp.salary);
  if (salary) out.sl = salary;
  const pick = (map, key, val) => {
    const code = map[String(val ?? '').trim()];
    if (code) out[key] = code;
  };
  pick(EDUCATION_CODES, 'el', sp.education);
  pick(EXPERIENCE_CODES, 'we', sp.experience);
  pick(JOB_STATUS_CODES, 'et', sp.jobStatus);
  pick(COMPANY_TYPE_CODES, 'ct', sp.companyType);
  pick(COMPANY_SIZE_CODES, 'cs', sp.companySize);
  return out;
}

const PAGE_SIZE = 20; // zhaopin serves 20 rows per page (SSR + each load-more call)

/**
 * Build the www.zhaopin.com/jobs search URL. Pure — exported for tests.
 * The `page` arg is accepted for engine symmetry but intentionally unused:
 * zhaopin paginates client-side and ignores a `?p=N` URL param (verified live).
 * @param {string} keyword
 * @param {number} [page]
 * @param {string} [cityCode] zhaopin city code (default 489 = nationwide)
 * @returns {string}
 */
export function buildSearchUrl(keyword, page = 1, params = DEFAULT_CITY_CODE) {
  const q = new URLSearchParams({ jl: DEFAULT_CITY_CODE, kw: keyword, kt: '3' });
  // Accept the historical `cityCode` string (jl only) OR a full params object
  // { jl, sl?, el?, we?, et?, ct?, cs? } from mapSearchParams. Unknown keys are
  // ignored; empty/absent values are never emitted (stay broad, not wrongly
  // narrowed).
  if (typeof params === 'string') {
    if (params) q.set('jl', params);
  } else if (params && typeof params === 'object') {
    if (params.jl) q.set('jl', String(params.jl));
    for (const k of ['sl', 'el', 'we', 'et', 'ct', 'cs']) {
      if (params[k] != null && params[k] !== '') q.set(k, String(params[k]));
    }
  }
  return `https://www.zhaopin.com/jobs?${q.toString()}`;
}

/** Parse zhaopin's "YYYY-MM-DD HH:MM:SS" (local) → epoch ms. NaN-safe. */
function parsePublishTime(value) {
  const iso = String(value || '').trim().replace(' ', 'T');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse a salary range string ("9001-12000", "9000-12000元") into the
 * pipeline's compensation contract ({min, max, currency}) so it renders in the
 * 5th pipeline column. Zhaopin reports monthly CNY; a plain number is kept as a
 * single-sided bound, anything else ("面议") yields null.
 * @param {unknown} value
 * @returns {{min:number,max:number,currency:string}|null}
 */
export function parseSalary(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const range = s.match(/^(\d+)\s*-\s*(\d+)/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (min > 0 && max > 0) return { min, max, currency: 'CNY' };
  }
  const single = s.match(/^(\d+)/);
  if (single) {
    const n = Number(single[1]);
    if (n > 0) return { min: n, max: n, currency: 'CNY' };
  }
  return null;
}

/**
 * Extract the raw position objects from the page's hydration state.
 * @param {import('playwright').Page} page
 * @returns {Promise<object[]>}
 */
export async function extractRows(page) {
  const state = await page.evaluate(() => window.__INITIAL_STATE__).catch(() => null);
  const list = Array.isArray(state?.positionList) ? state.positionList : [];
  return list.filter((p) => p && (p.name || p.positionURL || p.positionUrl));
}

/**
 * Normalize a raw position object into a Job. Pure — exported for tests.
 * @param {object} raw
 * @returns {{title:string,url:string,company:string,location:string,salary?:string,postedAt?:number}|null}
 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.name || '').trim();
  const url = String(raw.positionURL || raw.positionUrl || '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;

  const company = String(raw.companyName || '').trim();
  const location = [raw.workCity, raw.cityDistrict, raw.streetName]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');
  // salary60 is the display form ("9000-12000元"); salaryReal is the numeric range.
  const salary = parseSalary(raw.salaryReal ?? raw.salary60);
  const postedAt = parsePublishTime(raw.publishTime);

  return {
    title,
    url: url.replace(/^http:\/\//i, 'https://'),
    company,
    location,
    ...(salary ? { salary } : {}),
    ...(postedAt ? { postedAt } : {}),
  };
}

/** @type {BrowserSource} */
export default new (class ZhaopinSource extends BrowserSource {
  constructor() {
    super({
      id: 'zhaopin',
      label: '智联招聘 (zhaopin.com)',
      loginUrl: 'https://www.zhaopin.com/jobs',
      defaultKeywords: ['java', '前端开发', '数据分析'],
      configSection: 'zhaopin_searches',
      headless: false, // Tencent EdgeOne challenges headless browsers
      maxPages: 10, // max load-more scroll rounds (×~20 rows each)
      pageSizeHint: PAGE_SIZE,
      resultsSelector: '.job-card',
      locale: 'zh-CN',
      postLoadDelayMs: 2500,
    });
    /** @type {object[]} rows accumulated from the search/positions API. */
    this._apiRows = [];
    this._listenerAttached = false;
    this._searchRegion = null; // set by run() via resolveSearchRegion; null = nationwide
    this._searchParams = null; // set by run() via resolveSearchParams; null = jl-only
  }

  searchUrl(keyword, page) {
    // Full search-conditions object (jl + sl/el/we/et/ct/cs) when
    // resolveSearchParams produced one; otherwise fall back to city-only
    // _searchRegion (the pre-filter-dimensions behaviour).
    return buildSearchUrl(keyword, page, this._searchParams ?? this._searchRegion);
  }

  resolveSearchRegion(portals) {
    const allow = portals?.location_filter?.allow;
    return resolveCityCode(allow);
  }

  resolveSearchParams(portals) {
    return mapSearchParams(portals?.search_params, portals?.location_filter?.allow);
  }

  /** Attach the one-time response listener that accumulates the infinite-scroll
   *  API's `data.list` rows (the client-side paging endpoint). */
  _attachListener(page) {
    if (this._listenerAttached) return;
    this._listenerAttached = true;
    page.on('response', async (res) => {
      if (!/fe-api\.zhaopin\.com\/c\/i\/search\/positions/i.test(res.url())) return;
      try {
        const j = await res.json();
        const list = j?.data?.list;
        if (Array.isArray(list)) this._apiRows.push(...list);
      } catch {
        /* ignore non-JSON / partial bodies */
      }
    });
  }

  /**
   * Extract the SSR first page, then drive the infinite scroll to fetch the
   * rest. Returns SSR + every load-more page merged and deduped by job URL —
   * a single call, so the engine's nextPage loop has nothing left to page.
   */
  async extract(page) {
    this._attachListener(page);
    this._apiRows = []; // reset per keyword (extract runs once per keyword)

    const ssr = await extractRows(page);

    // Anonymous (or stale login): the login gate caps the list at ~PAGE_SIZE
    // with no infinite scroll, so there is nothing to load — stop after page 1.
    const loginGated = !!(await page.$('.job-list-login-gate'));
    if (loginGated) {
      if (!this._notedAnonymousCap) {
        this._notedAnonymousCap = true;
        console.warn(
          `  ⚠️  ${this.id}: login gate present (no/stale login state) — capturing only the first page (~${PAGE_SIZE} jobs). Run \`node scan-browser-source.mjs ${this.id} --login\` to unlock infinite scroll.`,
        );
      }
      return ssr;
    }

    // Logged in: scroll the window to the bottom. Each scroll fires
    // fe-api.zhaopin.com/c/i/search/positions (appends the next ~20 rows to
    // this._apiRows). `window.scrollTo` is far more reliable than mouse.wheel
    // here — wheel deltas ratchet against the page's own scroll handling and
    // stall for several rounds. Stop when hasMore turns false, nothing new
    // arrives for a few rounds, or the maxPages cap is reached.
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2)).catch(() => {});
    let stall = 0;
    for (let round = 0; round < this.maxPages; round++) {
      const hasMore = await page.evaluate(() => window.__INITIAL_STATE__?.hasMore).catch(() => null);
      if (hasMore === false) break;
      const before = this._apiRows.length;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
      await page.waitForTimeout(1600);
      if (this._apiRows.length === before) {
        // scrollTo occasionally misses; a real wheel usually re-triggers it.
        await page.mouse.wheel(0, 3000).catch(() => {});
        await page.waitForTimeout(1200);
      }
      if (this._apiRows.length === before) {
        if (++stall >= 3) break; // no new rows 3 rounds in a row → done
      } else {
        stall = 0;
      }
    }

    // Merge SSR + accumulated API rows, dedup by job URL (the engine also
    // dedups on job.url, so this only avoids re-processing near-dupes).
    const seen = new Set();
    const merged = [];
    for (const row of [...ssr, ...this._apiRows]) {
      const key = row?.positionURL ?? row?.positionUrl ?? row?.number;
      if (key != null) {
        if (seen.has(String(key))) continue;
        seen.add(String(key));
      }
      merged.push(row);
    }
    return merged;
  }

  normalizeJob(raw) {
    return normalizeJob(raw);
  }

  async verifyPage(page) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (body.includes('正在验证连接安全性') || body.includes('Protected by')) {
      return { ok: false, reason: 'Tencent EdgeOne challenge — must run headed (headless: false)' };
    }
    return { ok: true };
  }
})();
