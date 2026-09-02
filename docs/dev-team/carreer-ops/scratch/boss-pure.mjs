#!/usr/bin/env node
// @ts-check
/**
 * scratch/boss-pure.mjs — BOSS直聘 pure helpers, drafted during the R5 cooldown
 * (zero network). Structure mirrors browser-sources/zhaopin.mjs exports so the
 * helpers can be promoted into browser-sources/boss.mjs (B1) without reshaping.
 *
 * PENDING markers = values that recon (R1–R4) must confirm before promotion:
 *   - BOSS city codes beyond 上海 101020100 (R4)
 *   - filter-bar 学历/经验/薪资档位 语义→码 (R4)
 *   - list-card field → Job mapping (R3)
 *   - search-result page size / pagination param (R2)
 *
 * What is SAFE to draft now (public, stable BOSS conventions):
 *   - search URL shape: /web/geek/job?query=<kw>&city=<code> (page param: R2)
 *   - list-card salary display formats: "15-20K", "20-30K·13薪", "30-50K·14薪"
 *     → monthly {min,max,currency:'CNY'} (13薪 = monthly × 13, but the listed
 *     K-range IS the monthly range — the ·N薪 suffix is an annual bonus note,
 *     so salary parsing takes the K-range only; single "15K以上" also seen)
 *   - Job normalizer skeleton (field mapping PENDING R3)
 */
import assert from 'node:assert/strict';

/** Known city codes — 上海 confirmed; others are placeholders pending R4.
 *  zhipin city codes are 9-digit (101020100 = 上海). */
export const CITY_CODES = {
  // 上海: '101020100', // confirmed
  // 北京: '101010100', // PENDING R4
  // ...
};
export const DEFAULT_CITY_CODE = '101020100'; // 上海 (user base) — R4 pending nationwide code

/**
 * Build the zhipin geek search URL. Pure — exported for tests.
 * @param {string} keyword
 * @param {number} [page]
 * @param {string} [cityCode] default 上海 101020100
 * @returns {string}
 */
export function buildSearchUrl(keyword, page = 1, cityCode = DEFAULT_CITY_CODE) {
  const q = new URLSearchParams({ query: keyword, city: cityCode });
  if (page > 1) q.set('page', String(page)); // R2 pending: does ?page=N work logged-in?
  return `https://www.zhipin.com/web/geek/job?${q.toString()}`;
}

/**
 * Parse a BOSS list-card salary display into the pipeline compensation
 * contract. Formats observed on zhipin cards (public convention):
 *   "15-20K", "15-20K·13薪", "30-50K·14薪", "20-30K·13薪·1-3年"? (no — the
 *   ·suffix is 月薪倍数 bonus; the K range is the MONTHLY range)
 *   "15K以上", "面议"
 * The ·N薪 bonus suffix does not change the monthly min/max — dropped.
 * @param {unknown} value
 * @returns {{min:number,max:number,currency:string}|null}
 */
export function parseSalary(value) {
  const s = String(value ?? '').trim();
  if (!s || s === '面议' || s === '薪资面议') return null;
  const norm = s
    .replace(/·\s*\d+\s*薪/g, '') // 13薪/14薪 suffix — bonus note, monthly range unchanged
    .replace(/k/g, 'K')
    .replace(/\s+/g, '');
  const range = norm.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)K$/);
  if (range) {
    const min = Math.round(Number(range[1]) * 1000);
    const max = Math.round(Number(range[2]) * 1000);
    if (min > 0 && max >= min) return { min, max, currency: 'CNY' };
  }
  const single = norm.match(/^(\d+(?:\.\d+)?)K以上/);
  if (single) {
    const min = Math.round(Number(single[1]) * 1000);
    if (min > 0) return { min, max: min, currency: 'CNY' };
  }
  const plain = norm.match(/^(\d+(?:\.\d+)?)K$/);
  if (plain) {
    const n = Math.round(Number(plain[1]) * 1000);
    if (n > 0) return { min: n, max: n, currency: 'CNY' };
  }
  return null; // unknown shape → leave salary unset (broad, not wrong)
}

/**
 * Normalize a raw job-card object into a Job. Field mapping PENDING R3 —
 * this skeleton documents the intended shape only; DO NOT promote until recon
 * confirms the actual card payload (DOM or data object) fields.
 * @param {object} raw
 * @returns {{title:string,url:string,company:string,location:string,salary?:object,postedAt?:number}|null}
 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? raw.jobName ?? '').trim(); // PENDING R3
  const url = String(raw.url ?? raw.jobUrl ?? '').trim(); // PENDING R3
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const company = String(raw.company ?? raw.brandName ?? '').trim(); // PENDING R3
  const location = String(raw.location ?? raw.areaDistrict ?? '').trim(); // PENDING R3
  const salary = parseSalary(raw.salary ?? raw.salaryDesc);
  const out = { title, url: url.replace(/^http:\/\//i, 'https://'), company, location };
  if (salary) out.salary = salary;
  return out;
}

// ── quick self-check (node scratch/boss-pure.mjs) ──────────────────────
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  assert.equal(parseSalary('15-20K').min, 15000);
  assert.equal(parseSalary('15-20K').max, 20000);
  assert.equal(parseSalary('20-30K·13薪').min, 20000);
  assert.equal(parseSalary('20-30K·13薪').max, 30000);
  assert.equal(parseSalary('30-50K·14薪').max, 50000);
  assert.equal(parseSalary('15K以上').min, 15000);
  assert.equal(parseSalary('面议'), null);
  assert.equal(parseSalary(''), null);
  assert.equal(parseSalary('15-20K·13薪·上海'), null); // trailing junk → unknown
  const u = buildSearchUrl('数据分析', 1, '101020100');
  assert.ok(u.includes('query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90'));
  assert.ok(u.includes('city=101020100'));
  assert.ok(!u.includes('page='));
  assert.ok(buildSearchUrl('数据分析', 3).includes('page=3'));
  assert.equal(normalizeJob(null), null);
  console.log('✅ boss-pure self-check passed');
}
