#!/usr/bin/env node
// @ts-check
/**
 * recon-boss-login.mjs (v3) — B0 recon step 1: capture BOSS直聘 login state.
 *
 * v3 (route A, per user decision): REAL Chrome channel + stealth hardening +
 * dedicated persistent profile. Rationale (recon-report R5, A-grade evidence):
 * Playwright's bundled chromium is fingerprinted by BOSS even headed →
 * about:blank + infinite self-refresh. Real Chrome with the automation flag
 * disabled is substantially less detectable; the dedicated user-data-dir keeps
 * this session out of the user's daily Chrome profile while still giving the
 * profile a "lived-in" persistence BOSS's risk control can't distinguish from
 * a normal install.
 *
 * Hard rules: ONE window, NO auto-retry, NO navigation loop — the script only
 * waits (poll) and saves state when the browser lands back on a real geek
 * page. Cooldown buffer before the window opens (configurable, default 150 s).
 *
 * Usage: node recon-boss-login.mjs [cooldownSeconds]
 * Exit prints one of: LOGIN_SAVED <path> signedIn=yes|no | LOGIN_TIMEOUT | LOGIN_ABORT
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url))); // scripts/ → repo root
const STATE_DIR = path.join(ROOT, 'config', 'browser-state');
const STATE_PATH = path.join(STATE_DIR, 'boss.json');
const PROFILE_DIR = path.join(STATE_DIR, 'boss-profile'); // dedicated persistent profile
const START_URL = 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100';
const POLL_MS = 2500;
const MAX_MS = 12 * 60 * 1000;
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
].filter(Boolean);

const AUTH_COOKIE_RE = /wt2|zp_passport|zp_token|last_login|geek/i;
const REAL_PAGE_RE = /zhipin\.com\/web\/geek\/jobs|zhipin\.com\/web\/geek\/job_detail|zhipin\.com\/web\/geek\/recommend/i;
const AUTH_WALL_RE = /passport|verify|security|captcha|about:blank/i;

const cooldownS = Number(process.argv[2] ?? 150);
let lastUrl = '';
let lastCookies = [];
let saved = false;

function saveState(context, why) {
  if (saved) return;
  const signedIn = lastCookies.some((c) => AUTH_COOKIE_RE.test(c.name));
  mkdirSync(STATE_DIR, { recursive: true });
  context.storageState({ path: STATE_PATH }).then(() => {
    saved = true;
    console.log(`LOGIN_SAVED ${STATE_PATH} signedIn=${signedIn ? 'yes' : 'no'} (${why})`);
    console.log(`[diag] lastUrl=${lastUrl}`);
    console.log(`[diag] cookieNames=${lastCookies.map((c) => c.name).join(',') || '(none)'}`);
  }).catch((e) => console.log(`LOGIN_ABORT save failed: ${e.message}`)).finally(() => process.exit(0));
}

mkdirSync(STATE_DIR, { recursive: true });

// Cooldown buffer — the R5 incident was minutes ago; do not hit BOSS again
// before the buffer elapses (anti account-risk discipline).
if (cooldownS > 0) {
  console.log(`[info] 冷却缓冲 ${cooldownS}s 后弹出 Chrome 窗口…`);
  await new Promise((r) => setTimeout(r, cooldownS * 1000));
}

const launchOpts = {
  channel: 'chrome',
  headless: false,
  locale: 'zh-CN',
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
};
if (!existsSync(CHROME_PATHS[0])) {
  // channel resolution normally finds Chrome; keep an explicit fallback.
  const exe = CHROME_PATHS.find((p) => existsSync(p));
  if (exe) {
    delete launchOpts.channel;
    launchOpts.executablePath = exe;
  }
}

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  // Stealth: drop the automation flag before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  context.on('close', () => {
    if (!saved && REAL_PAGE_RE.test(lastUrl)) {
      saveState(context, 'window-closed-after-real-page');
    } else if (!saved) {
      console.log('LOGIN_ABORT window closed before reaching a real geek page (user action or crash).');
      process.exit(0);
    }
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  context.on('page', (p) => {
    if (p !== page) console.log(`[diag] extra page opened: ${p.url()}`);
  });

  console.log(`[diag] opening ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`[diag] initial goto issue: ${e.message}`));
  console.log(`[diag] landed on: ${page.url()}`);
  console.log('[info] 真实 Chrome 窗口已弹出：请完成 BOSS直聘 登录（扫码或验证码）。登录成功跳回职位列表页后脚本自动保存并退出；直接关窗也会尽力保存。不会自动刷新/重试。');

  const deadline = Date.now() + MAX_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    try {
      lastUrl = page.url();
      lastCookies = await context.cookies();
    } catch {
      break; // context gone — the close handler takes over
    }
    if (REAL_PAGE_RE.test(lastUrl) && !AUTH_WALL_RE.test(lastUrl)) {
      await saveState(context, 'reached-real-geek-page');
      break;
    }
    const elapsed = Math.round((Date.now() - deadline + MAX_MS) / 1000);
    if (elapsed % 25 < POLL_MS / 1000) {
      console.log(`[diag] ${elapsed}s url=${lastUrl} cookieNames=${lastCookies.map((c) => c.name).join(',') || '(none)'}`);
    }
  }
  if (!saved) {
    console.log('LOGIN_TIMEOUT — 12 分钟内未检测到登录完成。');
    process.exit(0);
  }
} catch (err) {
  console.log(`LOGIN_ABORT ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
