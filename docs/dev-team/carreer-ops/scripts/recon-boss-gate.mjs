#!/usr/bin/env node
// @ts-check
/**
 * recon-boss-gate.mjs — R7 go/no-go gate (QA spec, 2026-09-02).
 *
 * Decides whether the AUTOMATED scan path (BrowserSource engine style) works
 * against BOSS直聘 with a real harvested session:
 *   launch: headed REAL Chrome (channel:'chrome') — the anti-bot landscape
 *           proved headed-only for zhaopin, and Playwright-bundled chromium is
 *           fingerprinted by BOSS (recon R5)
 *   context: fresh context + storageState from config/browser-state/boss.json
 *            (exactly what the engine does — boss-profile itself is NOT used,
 *            because BrowserSource has no persistent-context support)
 *   load:    ONE geek search page (the real deep link with ?query=)
 *   wait:    ~15 s, watching for risk signatures (passport/verify redirect,
 *            about:blank, reload loop, slider text, zero job rows)
 *
 * Verdicts:
 *   GATE_PASS      — search page rendered job rows, no risk signature →
 *                    automated scan route is viable → proceed B0 R1–R4.
 *   GATE_BLOCKED   — any risk signature → desktop automation route is dead →
 *                    stop trying windows; back to @user for a downgrade.
 * Single page, single load, aborts on anomaly. Evidence: screenshot + HTML
 * dump into docs/dev-team/carreer-ops/recon-logs/.
 *
 * Usage: node recon-boss-gate.mjs
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const STATE_PATH = path.join(ROOT, 'config', 'browser-state', 'boss.json');
const LOG_DIR = path.join(ROOT, 'docs', 'dev-team', 'carreer-ops', 'recon-logs');
const SEARCH_URL = 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100';

if (!existsSync(STATE_PATH)) {
  console.log('ERR boss.json missing — run the CDP harvest first.');
  process.exit(1);
}
mkdirSync(LOG_DIR, { recursive: true });

const RISK_URL_RE = /passport|verify|security|captcha/i;

const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const context = await browser.newContext({ locale: 'zh-CN', storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  let reloads = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) reloads++;
  });

  console.log(`[gate] loading ${SEARCH_URL}`);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`[gate] goto issue: ${e.message}`));
  console.log(`[gate] waiting 15s for render / risk signature…`);
  await page.waitForTimeout(15000);

  const finalUrl = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
  const jobCardCount = await page.evaluate(() => {
    const sels = ['[class*="job-card"]', '[class*="job-list"]', '[class*="job-title"]', '[class*="card-wrapper"]'];
    return sels.map((s) => [s, document.querySelectorAll(s).length]);
  }).catch(() => []);
  const cookieNames = (await context.cookies()).filter((c) => /zhipin\.com$/.test(c.domain)).map((c) => c.name);

  // Evidence dump.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(path.join(LOG_DIR, `gate-${ts}.html`), await page.content().catch(() => ''), 'utf8');
  await page.screenshot({ path: path.join(LOG_DIR, `gate-${ts}.png`) }).catch(() => {});
  console.log(`[gate] evidence → recon-logs/gate-${ts}.html|.png`);

  // Verdict.
  const blockedUrl = RISK_URL_RE.test(finalUrl);
  const blank = /^about:blank/.test(finalUrl);
  const reloadLoop = reloads > 4;
  const sliderish = /滑块|验证|访问过于频繁|安全验证|verify/i.test(bodyText);
  const jobRows = jobCardCount.some(([, n]) => n > 0);
  const loginModal = /登录|扫码/i.test(bodyText) && !jobRows;

  console.log(`[gate] finalUrl=${finalUrl}`);
  console.log(`[gate] reloads=${reloads} bodyHead="${bodyText.replace(/\n/g, ' ').slice(0, 200)}"`);
  console.log(`[gate] selector counts: ${JSON.stringify(jobCardCount)}`);
  console.log(`[gate] zhipin cookies in ctx: ${cookieNames.join(',') || '(none)'}`);

  if (blockedUrl || blank || reloadLoop || sliderish) {
    console.log('GATE_BLOCKED (risk signature: ' + [blockedUrl && 'auth-wall-url', blank && 'about:blank', reloadLoop && `reload-loop(${reloads})`, sliderish && 'slider/verify-text'].filter(Boolean).join(', ') + ')');
  } else if (jobRows) {
    console.log('GATE_PASS (job rows rendered, no risk signature)');
  } else if (loginModal) {
    console.log('GATE_BLOCKED (page shows login wall — session not honoured by automated context)');
  } else {
    console.log('GATE_INCONCLUSIVE (no job rows, no risk signature — inspect evidence dump)');
  }
} finally {
  await browser.close().catch(() => {});
}
