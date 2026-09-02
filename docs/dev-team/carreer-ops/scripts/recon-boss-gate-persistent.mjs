#!/usr/bin/env node
// @ts-check
/**
 * recon-boss-gate-persistent.mjs — the CHEAP control experiment (QA 2026-09-02):
 * Playwright + the SAME trusted boss-profile (v7 hand-login session) — no
 * nodriver, no Python sidecar, no compliance change.
 *
 * Isolates ONE variable: with a trusted profile + real session, does BOSS still
 * block Playwright's driver fingerprint? If this passes → the original
 * "engine-unchanged" architecture is viable (launchPersistentContext in
 * boss.mjs) and the nodriver route is unnecessary.
 *
 * Usage: node recon-boss-gate-persistent.mjs
 * Verdicts: PERSIST_PASS | PERSIST_BLOCKED (reason) | PERSIST_INCONCLUSIVE
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const PROFILE = path.join(ROOT, 'config', 'browser-state', 'boss-profile');
const LOG_DIR = path.join(ROOT, 'docs', 'dev-team', 'carreer-ops', 'recon-logs');
const SEARCH_URL = 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100';
const RISK_URL_RE = /passport|verify|security|captcha/i;
mkdirSync(LOG_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  locale: 'zh-CN',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  let reloads = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads++; });

  console.log(`[persist] loading ${SEARCH_URL} on boss-profile (persistent)`);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`[persist] goto issue: ${e.message}`));
  console.log('[persist] waiting 15s…');
  await page.waitForTimeout(15000);

  const finalUrl = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
  const counts = await page.evaluate(() => {
    const sels = ['[class*="job-card"]', '[class*="job-list"]', '[class*="job-title"]', '[class*="card-wrapper"]', '[class*="job-primary"]'];
    return sels.map((s) => [s, document.querySelectorAll(s).length]);
  }).catch(() => []);
  const cookieNames = (await context.cookies()).filter((c) => /zhipin\.com$/.test(c.domain)).map((c) => c.name);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(path.join(LOG_DIR, `persist-${ts}.html`), await page.content().catch(() => ''), 'utf8');
  await page.screenshot({ path: path.join(LOG_DIR, `persist-${ts}.png`) }).catch(() => {});

  const blocked = RISK_URL_RE.test(finalUrl) || /^about:blank/.test(finalUrl) || reloads > 4 || /滑块|验证|访问过于频繁|安全验证/i.test(bodyText);
  const jobRows = counts.some(([, n]) => n > 0);

  console.log(`[persist] finalUrl=${finalUrl} reloads=${reloads}`);
  console.log(`[persist] counts=${JSON.stringify(counts)} cookies=${cookieNames.join(',') || '(none)'}`);
  console.log(`[persist] bodyHead="${bodyText.replace(/\n/g, ' ').slice(0, 160)}"`);
  console.log(`[persist] evidence → recon-logs/persist-${ts}.html|.png`);

  if (blocked) console.log(`PERSIST_BLOCKED (${RISK_URL_RE.test(finalUrl) ? 'auth-wall-url' : ''}${/^about:blank/.test(finalUrl) ? 'about:blank' : ''}${reloads > 4 ? `reload-loop(${reloads})` : ''})`);
  else if (jobRows) console.log('PERSIST_PASS (job rows rendered, no risk signature)');
  else console.log('PERSIST_INCONCLUSIVE (no job rows, no risk signature)');
} finally {
  await context.close().catch(() => {});
}
