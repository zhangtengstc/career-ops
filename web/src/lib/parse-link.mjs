// @ts-check
/**
 * web/src/lib/parse-link.mjs — pure helpers for the Explore "paste a link" parse
 * feature (第三入口). zhaopin is zero-auth (SSR `__INITIAL_STATE__`); boss is
 * handled by browser-sources/boss.py (nodriver), spawned by the route — so only
 * zhaopin parsing + URL dispatch live here (pure, node-testable).
 *
 * The returned shape is a `DiscoveredOffer` (web/src/lib/explore.ts) MINUS salary
 * — DiscoveredOffer has no salary field and discovery-card.tsx renders none.
 */

/** Which board a pasted URL belongs to (domain whitelist — everything else null). */
/**
 * @param {string} url
 * @returns {'zhaopin' | 'boss' | null}
 */
export function detectSource(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'zhaopin.com' || host.endsWith('.zhaopin.com')) return 'zhaopin';
  if (host === 'zhipin.com' || host.endsWith('.zhipin.com')) return 'boss';
  return null;
}

/**
 * Parse a zhaopin job-detail page's SSR `__INITIAL_STATE__` into a
 * DiscoveredOffer. Anchored to the top-level `jobDetail` object (the page
 * carries many unrelated `name`/`companyName` instances — e.g. 营业执照信息 —
 * so a full-text first-match is wrong).
 * @param {string} html
 * @param {string} url
 * @returns {import('./explore').DiscoveredOffer | null}
 */
export function parseZhaopinDetail(html, url) {
  const i = html.indexOf('__INITIAL_STATE__=');
  if (i === -1) return null;
  const start = html.indexOf('{', i);
  if (start === -1) return null;
  // Brace-balanced scan that skips braces INSIDE string values (the blob
  // carries JSON-encoded sub-fields like cardCustomJson whose braces would
  // otherwise break a naive depth counter and truncate the parse).
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  if (end === -1) return null;
  let state;
  try {
    state = JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
  const jd = state && state.jobDetail;
  if (!jd || typeof jd !== 'object') return null;
  // The detail page nests the job under jobDetail.detailedPosition (company
  // under jobDetail.detailedCompany) — NOT a flat job object. Anchor there.
  const dp = jd.detailedPosition;
  if (!dp || typeof dp !== 'object') return null;

  const title = String(dp.name ?? dp.positionName ?? '').trim();
  const company = String(dp.companyName ?? jd.detailedCompany?.companyName ?? '').trim();
  const location = [dp.workCity, dp.cityDistrict, dp.streetName]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');
  const publish = typeof dp.publishTime === 'string' ? dp.publishTime : (typeof dp.positionPublishTime === 'string' ? dp.positionPublishTime : '');
  const postedAt = /^\d{4}-\d{2}-\d{2}/.test(publish) ? publish.slice(0, 10) : '';

  if (!title || !company) return null;
  return {
    url,
    company,
    title,
    location,
    postedAt,
    ats: 'zhaopin',
    source: 'zhaopin',
  };
}

/** Chrome UA for the zhaopin fetch (zhaopin serves full SSR HTML to curl/UA). */
export const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Parse BOSS job-detail page SEO sources (document.title + meta description)
 * into {title, company, location}. This is the DISPLAY employer (招聘方) — the
 * DOM `.company-name` class is unreliable (it matches similar-job cards and the
 * 营业执照 legal name, not the brand shown in 公司基本信息). D-001 fix.
 * @param {string} documentTitle
 * @param {string} metaDesc
 * @param {string} [locationEl] fallback from `.company-location`
 * @returns {{title:string,company:string,location:string}}
 */
export function parseBossMeta(documentTitle, metaDesc, locationEl = '') {
  const m = /「(.+?)招聘」_(.+?)招聘-BOSS直聘/.exec(String(documentTitle || ''));
  const title = m ? m[1].trim() : '';
  const company = m ? m[2].trim() : '';
  let location = ((String(metaDesc || '').match(/地点：([^，,]+)/) || [])[1] || '').trim();
  if (!location) location = String(locationEl || '').trim();
  return { title, company, location };
}
