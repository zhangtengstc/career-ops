#!/usr/bin/env node
// @ts-check
/**
 * recon-boss-harvest.mjs (v4 watchdog) — harvest BOSS直聘 login state from an
 * ORGANIC Chrome session the user logged into by hand.
 *
 * Flow (zero automation during login — BOSS risk control closed Playwright-
 * attached Chrome twice, even headed real Chrome; recon-report R5 v2):
 *   1. Chrome is launched by the OS (plain chrome.exe, debug port 9333) — no
 *      Playwright, no automation flags. The user logs in manually.
 *   2. THIS script attaches over CDP (localhost) ONLY to read cookies —
 *      no navigation, no page script, nothing the site can observe.
 *   3. When a zhipin auth cookie appears → export storageState → exit.
 *
 * Usage: node recon-boss-harvest.mjs [port] [timeoutMinutes]
 * Prints: LOGIN_SAVED <path> signedIn=yes | HARVEST_TIMEOUT (window left open)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const STATE_PATH = path.join(ROOT, 'config', 'browser-state', 'boss.json');
const PORT = Number(process.argv[2] ?? 9333);
const MAX_MS = (Number(process.argv[3] ?? 25)) * 60 * 1000;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// Login session cookies BOSS has used across versions. We ALSO treat a large
// zhipin cookie set (>=10 distinct zhipin-domain cookies) as signed-in, since
// anonymous sessions carry only a handful of tracking cookies.
const AUTH_COOKIE_RE = /wt2|zp_token|zp_passport|zp_seo|last_login/i;

mkdirSync(path.dirname(STATE_PATH), { recursive: true });

async function waitForChrome() {
  // Chrome may take a few seconds to open the debug port after launch.
  for (let i = 0; i < 20; i++) {
    try {
      return await chromium.connectOverCDP(ENDPOINT);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`no CDP endpoint at ${ENDPOINT} after 20s — is Chrome running with --remote-debugging-port=${PORT}?`);
}

const browser = await waitForChrome();
console.log('[info] 已附加到 Chrome（仅读取 cookie，不注入/不导航）。等待你在窗口里完成登录…');
const deadline = Date.now() + MAX_MS;
let sawZhipinCookies = false;
try {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const ctxs = browser.contexts();
    let cookies = [];
    for (const ctx of ctxs) {
      try { cookies.push(...(await ctx.cookies())); } catch { /* context closed */ }
    }
    const zhipin = cookies.filter((c) => /zhipin\.com$/.test(c.domain) || c.domain.endsWith('.zhipin.com'));
    if (zhipin.length > 3) sawZhipinCookies = true;
    const signedIn = zhipin.some((c) => AUTH_COOKIE_RE.test(c.name)) || zhipin.length >= 10;
    if (signedIn) {
      const ctx = ctxs[0];
      await ctx.storageState({ path: STATE_PATH });
      console.log(`LOGIN_SAVED ${STATE_PATH} signedIn=yes`);
      console.log(`[diag] zhipin cookies=${zhipin.length} names=${zhipin.map((c) => c.name).slice(0, 25).join(',')}`);
      process.exit(0);
    }
    const elapsed = Math.round((Date.now() - deadline + MAX_MS) / 1000);
    if (elapsed % 30 < 8) {
      console.log(`[diag] ${elapsed}s waiting… zhipin cookies=${zhipin.length} (${zhipin.map((c) => c.name).join(',') || 'none'})`);
    }
  }
  console.log(`HARVEST_TIMEOUT — ${Math.round(MAX_MS / 60000)} 分钟未检测到登录。窗口未关闭，你随时完成登录后重跑本脚本即可。`);
} finally {
  await browser.close().catch(() => {}); // detach only — the Chrome window stays open
  process.exit(0);
}
