#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
browser-sources/boss.py — BOSS直聘 (zhipin.com) login-state source, nodriver sidecar.

The BROWSER half of the boss source. The Node wrapper (`browser-sources/boss.mjs`)
spawns this script and applies title/location filters + dedup + pipeline writes
in JS (reusing scan.mjs's pure functions), so the two halves stay byte-compatible
with the zhaopin source. This script only: login handoff, search, extract the
Vue `jobList` state (plaintext salary — the DOM renders salary with a custom
obfuscation font, but the underlying Vue data is plain), and emit raw jobs as
NDJSON.

Why nodriver and not Playwright: BOSS risk control rejects Playwright/CDP-driven
browsers (even headed real Chrome, with a valid session) — about:blank + reload
loop / window.close(). nodriver drives real Chrome without exposing automation
fingerprints (navigator.webdriver=False). See docs/dev-team/carreer-ops/recon-report.md.

Hard discipline (QA acceptance, mandatory):
  - single page at a time, no auto-retry;
  - page cap (--max-pages, default 5);
  - abort on risk signature (login wall / reload loop), never silent 0;
  - graceful close (Browser.close) so the session persists in the profile.

Usage:
  python boss.py --login                                   # handoff: sign in once
  python boss.py --jsonl --keywords 数据分析,BI --max-pages 5
      # NDJSON: {keyword, rawJobs:[...], errors:[...], done, total} per keyword,
      # then {done:true, source:"boss", total}
"""
import argparse, asyncio, json, os, pathlib, subprocess, sys, time, urllib.request
import nodriver as uc
from nodriver.cdp import browser as cdp_browser

# ── single authoritative path resolution ─────────────────────────────────
# This script lives at <repo-root>/browser-sources/boss.py (a FIXED, documented
# location), so repo root = parents[1]. Env override for portability/tests.
ROOT = pathlib.Path(os.environ.get("CAREER_OPS_ROOT", pathlib.Path(__file__).resolve().parent.parent))
PROFILE = pathlib.Path(os.environ.get("BOSS_PROFILE", ROOT / "config" / "browser-state" / "boss-profile"))
CHROME_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
]
DEFAULT_CITY = "101020100"  # 上海
PAGE_SIZE = 15
BASE_URL = "https://www.zhipin.com/web/geek/job"

def val(x):
    return getattr(x, "value", x)

def find_chrome():
    for p in CHROME_CANDIDATES:
        if pathlib.Path(p).exists():
            return p
    return None

# ── single browser lifecycle (the shared :9222 debug Chrome) ──────────────
# Every boss flow — parse-link, scan, login handoff — attaches to ONE Chrome
# instance on a fixed debug port, reusing the boss-profile dir. Nodriver's
# `uc.start(user_data_dir=…)` would otherwise spawn a SECOND Chrome on the
# same profile; two Chromes cannot share a profile dir (singleton lock), so
# parse-link's :9222 instance and a scan's fresh instance collided. Launching
# goes through spawn_debug_chrome() here (idempotent — attaches when :9222 is
# already up), mirroring web/src/lib/boss-chrome.ts's getChromeCdpUrl().
DEBUG_PORT = 9222
LANDING_URL = f"{BASE_URL}?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city={DEFAULT_CITY}"


def chrome_cdp_ready():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1.0) as r:
            return r.status == 200
    except Exception:
        return False


def spawn_debug_chrome():
    chrome = find_chrome()
    if not chrome:
        return False
    args = [
        chrome,
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--user-data-dir={PROFILE}",
        "--start-maximized",
        LANDING_URL,
    ]
    try:
        subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
    except Exception:
        return False
    for _ in range(40):  # up to ~20s for the DevTools port to come up
        if chrome_cdp_ready():
            return True
        time.sleep(0.5)
    return False


async def ensure_browser():
    """Attach to the shared :9222 debug Chrome, launching it first if needed.
    Returns the nodriver Browser, or None when Chrome is unavailable."""
    if not chrome_cdp_ready():
        if not spawn_debug_chrome():
            return None
    try:
        return await uc.start(host="127.0.0.1", port=DEBUG_PORT)
    except Exception:
        return None

def write_marker():
    """Touch config/browser-state/boss.json so the web Explorer's fail-fast
    login-state check (loginStatePath) passes, and record the profile path."""
    marker = ROOT / "config" / "browser-state" / "boss.json"
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"profile": str(PROFILE), "updated": time.time()}), encoding="utf-8")
    except Exception:
        pass

async def nav_count(tab):
    v = val(await tab.evaluate("performance.getEntriesByType('navigation').length", return_by_value=True))
    try:
        return int(v)
    except Exception:
        return 0

def risk_reason(url):
    if not url:
        return "no URL"
    if "passport" in url or "verify" in url or "security" in url or "captcha" in url:
        return f"risk wall: {url[:80]}"
    if url.startswith("about:blank"):
        return "about:blank (reload-loop signature)"
    return None

def logged_in(url):
    return url and "passport" not in url and "verify" not in url and "/web/user/" not in url and "/web/geek" in url

async def read_state(tab):
    """Read the search page's Vue jobList (plaintext) + pagination flags."""
    js = r"""
    (function(){
      var cards = document.querySelectorAll('[class*=job-card]');
      var list = [];
      if (cards.length) {
        var v = cards[0].__vue__;
        var node = v, depth = 0;
        while (node && depth < 8) {
          var d = node.$data || node._data || {};
          if (Array.isArray(d.jobList)) { list = d.jobList; return JSON.stringify({
            jobList: list, hasMore: !!d.hasMore, page: (d.pageVo||{}).page, pageSize: (d.pageVo||{}).pageSize
          }); }
          node = node.$parent; depth++;
        }
      }
      return JSON.stringify({jobList: [], hasMore: false, page: null, pageSize: null, noState: true});
    })()
    """
    raw = val(await tab.evaluate(js, return_by_value=True)) or "{}"
    try:
        return json.loads(raw)
    except Exception:
        return {"jobList": [], "hasMore": False, "page": None, "pageSize": None, "parseError": True}

def normalize(raw):
    """raw Vue job object -> raw job dict (salary stays a string; JS parses it)."""
    if not raw or not isinstance(raw, dict):
        return None
    title = str(raw.get("jobName") or "").strip()
    eid = str(raw.get("encryptJobId") or "").strip()
    if not title or not eid:
        return None
    loc = " ".join(x for x in (raw.get("cityName"), raw.get("areaDistrict"), raw.get("businessDistrict"))
                   if isinstance(x, str) and x.strip())
    return {
        "title": title,
        "url": f"https://www.zhipin.com/job_detail/{eid}.html",
        "company": str(raw.get("brandName") or "").strip(),
        "location": loc,
        "salaryDesc": str(raw.get("salaryDesc") or "").strip(),
        "experience": str(raw.get("jobExperience") or "").strip(),
        "degree": str(raw.get("jobDegree") or "").strip(),
    }

async def scan_keyword(tab, kw, max_pages):
    """Load a keyword's results and collect raw jobs across up to max_pages
    scroll rounds. Returns (jobs, error)."""
    url = f"{BASE_URL}?query={kw}&city={DEFAULT_CITY}"
    jobs = []
    seen = set()
    try:
        await tab.get(url)
        await tab.sleep(6)
        # reload-loop detection (hard discipline): >2 navigations in the next
        # 7s = risk signature → abort, never silently 0.
        n0 = await nav_count(tab)
        await tab.sleep(7)
        n1 = await nav_count(tab)
        cur = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        rrisk = risk_reason(cur)
        if rrisk:
            return [], rrisk
        if n1 - n0 > 2:
            return [], f"reload-loop signature ({n1 - n0} navigations/7s) — aborting"
        for page in range(max_pages):
            state = await read_state(tab)
            if state.get("noState") or state.get("parseError"):
                if not jobs:
                    return [], "Vue state not found (page structure changed?) — inspect live page"
                break
            for raw in state.get("jobList") or []:
                j = normalize(raw)
                if j and j["url"] not in seen:
                    seen.add(j["url"])
                    jobs.append(j)
            if not state.get("hasMore"):
                break
            # load more: scroll to bottom (BOSS search page scrolls to load).
            await tab.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
            await tab.sleep(3)
        return jobs, None
    except Exception as e:
        return jobs, f"{type(e).__name__}: {e}"

async def login_handoff():
    browser = await ensure_browser()
    if browser is None:
        print("BROWSER_FAILED: 无法启动 BOSS 调试浏览器（未找到 Chrome 或启动失败）", flush=True)
        return
    try:
        tab = await browser.get(LANDING_URL)
        print("[boss] 请在弹出的 Chrome 窗口完成 BOSS直聘 登录；登录成功跳回职位页后自动保存。", flush=True)
        deadline = time.time() + 12 * 60
        while time.time() < deadline:
            await tab.sleep(4)
            url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
            if logged_in(url):
                write_marker()
                print("LOGIN_SAVED " + str(PROFILE), flush=True)
                break
        else:
            print("LOGIN_TIMEOUT", flush=True)
    finally:
        try:
            await browser.stop()
        except Exception:
            pass
        try:
            await browser.aclose()
        except Exception:
            pass

async def run_scan(keywords, max_pages):
    browser = await ensure_browser()
    if browser is None:
        print(json.dumps({"done": True, "source": "boss", "total": 0, "errors": ["browser unavailable — Chrome not found or failed to start"]}, ensure_ascii=True), flush=True)
        return
    total = 0
    try:
        tab = await browser.get("about:blank", new_tab=True)
        for i, kw in enumerate(keywords):
            url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
            if not logged_in(url):
                # fresh profile: prompt login via the search URL so the user can sign in
                await tab.get(f"{BASE_URL}?query={kw}&city={DEFAULT_CITY}")
                await tab.sleep(3)
                url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
                if not logged_in(url):
                    print(json.dumps({"keyword": kw, "rawJobs": [], "errors": ["not logged in — run `node scan-browser-source.mjs boss --login` first"], "done": i + 1, "total": len(keywords)}), flush=True)
                    continue
            jobs, err = await scan_keyword(tab, kw, max_pages)
            total += len(jobs)
            print(json.dumps({"keyword": kw, "rawJobs": jobs, "errors": [err] if err else [], "done": i + 1, "total": len(keywords)}), flush=True)
        write_marker()
        print(json.dumps({"done": True, "source": "boss", "total": total}), flush=True)
    finally:
        try:
            await browser.stop()
        except Exception:
            pass
        try:
            await browser.aclose()
        except Exception:
            pass

async def parse_link(url):
    """Attach to the shared :9222 debug Chrome (launching it if needed) and
    evaluate the BOSS job_detail page in a throwaway tab. Returns a structured
    browserNotRunning only when the browser can't be started at all.

    Contract: this function ALWAYS prints exactly one JSON line —
    {documentTitle,metaDesc,locationEl} | {loginRequired:true} |
    {browserNotRunning:true} | {error:msg}. The web route keys off these."""
    browser = await ensure_browser()
    if browser is None:
        print(json.dumps({"browserNotRunning": True, "error": "Chrome 未在 :9222 运行且自动启动失败"}, ensure_ascii=True), flush=True)
        return
    tab = None
    try:
        # new_tab=True is mandatory in attach mode: bare browser.get() REUSES
        # the browser's first tab, and tab.close() below would then close the
        # user's own tab — closing their last tab kills the whole shared
        # Chrome (observed: browser gone after one parse).
        tab = await browser.get(url, new_tab=True)
        await tab.sleep(10)
        js = r"""
        (function(){
          var desc = (document.querySelector('meta[name=description]') || {}).content || '';
          var el = document.querySelector('.company-location');
          return JSON.stringify({
            documentTitle: document.title || '',
            metaDesc: desc,
            locationEl: el ? el.textContent.trim() : ''
          });
        })()
        """
        raw = val(await tab.evaluate(js, return_by_value=True)) or "{}"
        try:
            data = json.loads(raw)
        except Exception:
            data = {"title": "", "company": "", "location": "", "error": "parse failed"}
        login_js = r"""
        (function(){
          // Match the PATH, not the full href: job_detail links legitimately
          // carry ?securityId=… in the query, and matching 'security' against
          // the whole URL false-positives every shared link as a login wall
          // even when the detail page rendered fine (observed 2026-09-08).
          var p = (location.pathname || '').toLowerCase();
          var t = (document.title || '').toLowerCase();
          var wall = /login|security|passport|register|verify|captcha/.test(p) || /登录|注册/.test(t);
          var body = (document.body && document.body.innerText) ? document.body.innerText.slice(0,120) : '';
          if (!wall) wall = /登录|注册/.test(body) && !/(数据分析|产品|工程师|助理|专员|经理|主管|运营|市场|销售|财务|人力|行政|设计|开发|java|python|前端|后端|算法|数据)/.test(body);
          return JSON.stringify({ loginRequired: !!wall, url: location.href, title: document.title || '' });
        })()
        """
        login_raw = val(await tab.evaluate(login_js, return_by_value=True)) or "{}"
        try:
            login_info = json.loads(login_raw)
        except Exception:
            login_info = {}
        if login_info.get("loginRequired"):
            print(json.dumps({"loginRequired": True, "url": login_info.get("url", ""), "title": login_info.get("title", "")}, ensure_ascii=True), flush=True)
        else:
            print(json.dumps(data, ensure_ascii=True), flush=True)
    except Exception as e:
        # browser.get/evaluate failures (dead target, navigation abort, …) must
        # still surface as structured JSON — a bare traceback leaves stdout
        # empty and the web route can only show a misleading generic error.
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=True), flush=True)
    finally:
        if tab is not None:
            try:
                await tab.close()
            except Exception:
                pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--jsonl", action="store_true")
    ap.add_argument("--keywords", default="")
    ap.add_argument("--max-pages", type=int, default=5)
    ap.add_argument("--parse-link", default="")
    args = ap.parse_args()

    if args.login:
        asyncio.run(login_handoff())
        return
    if args.parse_link:
        # Last-resort guard: stdout must always carry exactly one JSON line,
        # even if the event loop itself blows up (RuntimeError at teardown…).
        try:
            asyncio.run(parse_link(args.parse_link))
        except Exception as e:
            print(json.dumps({"error": f"parse-link crashed: {type(e).__name__}: {e}"}, ensure_ascii=True), flush=True)
        return

    kws = [k.strip() for k in args.keywords.split(",") if k.strip()] if args.keywords else ["数据分析", "BI", "用户运营"]
    asyncio.run(run_scan(kws, args.max_pages))

if __name__ == "__main__":
    main()
