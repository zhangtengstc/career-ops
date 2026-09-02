#!/usr/bin/env node
// @ts-check
/**
 * recon-boss-edge-cdp-harvest.mjs — v6 CDP fallback (user-consented 2026-09-02):
 * read the BOSS直聘 session out of the user's daily Edge profile.
 *
 * Edge is launched by the OS with --remote-debugging-port on the DEFAULT
 * profile (no other flags). This script attaches over CDP and exports ONLY
 * zhipin.com-domain cookies into config/browser-state/boss.json. Nothing is
 * injected, navigated, or modified; after export the caller closes Edge and
 * the user resumes normal browsing (session untouched — read-only).
 *
 * Usage: node recon-boss-edge-cdp-harvest.mjs [port]
 * Prints: OK <path> (<n> zhipin cookies; auth-ish: …) | ERR <reason>
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const STATE_PATH = path.join(ROOT, 'config', 'browser-state', 'boss.json');
const PORT = Number(process.argv[2] ?? 9334);
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const AUTH_COOKIE_RE = /wt2|zp_token|zp_passport|zp_seo|last_login/i;

async function waitForEdge() {
  for (let i = 0; i < 30; i++) {
    try {
      return await chromium.connectOverCDP(ENDPOINT);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`no CDP endpoint at ${ENDPOINT} after 30s`);
}

const browser = await waitForEdge();
try {
  const contexts = browser.contexts();
  let all = [];
  for (const ctx of contexts) {
    try { all.push(...(await ctx.cookies())); } catch { /* skip */ }
  }
  console.log(`[scope] CDP endpoint: ${ENDPOINT} (user-consented profile, read-only)`);
  const zhipin = all.filter((c) => /(^|\.)zhipin\.com$/.test(c.domain ?? ''));
  console.log(`[scope] domain filter: host ends with .zhipin.com — other hosts ignored (${all.length} total, ${zhipin.length} kept)`);
  if (!zhipin.length) {
    console.log('ERR no zhipin.com cookies in the connected Edge profile');
    process.exit(1);
  }
  const cookies = zhipin.map((c) => ({
    name: c.name,
    value: c.value,
    domain: String(c.domain).replace(/^\./, ''),
    path: c.path || '/',
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'None',
  }));
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ cookies, origins: [] }, null, 2), 'utf8');
  const auth = cookies.filter((c) => AUTH_COOKIE_RE.test(c.name)).map((c) => c.name);
  console.log(`[scope] single write target: ${STATE_PATH} (no other file written)`);
  console.log(`OK ${STATE_PATH} (${cookies.length} zhipin cookies; auth-ish: ${auth.join(',') || 'none'})`);
} finally {
  await browser.close().catch(() => {}); // detach only — Edge stays running until caller closes it
}
