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
import argparse, asyncio, json, os, pathlib, sys, time
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
    chrome = find_chrome() or "chrome"
    browser = await uc.start(user_data_dir=str(PROFILE), headless=False, lang="zh-CN", browser_executable_path=chrome)
    try:
        tab = await browser.get("https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100")
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
            await browser.send(cdp_browser.close()); await asyncio.sleep(3)
        except Exception:
            pass
        await browser.aclose()

async def run_scan(keywords, max_pages):
    chrome = find_chrome() or "chrome"
    browser = await uc.start(user_data_dir=str(PROFILE), headless=False, lang="zh-CN", browser_executable_path=chrome)
    total = 0
    try:
        tab = await browser.get("about:blank")
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
            await browser.send(cdp_browser.close()); await asyncio.sleep(3)
        except Exception:
            pass
        await browser.aclose()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--jsonl", action="store_true")
    ap.add_argument("--keywords", default="")
    ap.add_argument("--max-pages", type=int, default=5)
    args = ap.parse_args()

    if args.login:
        asyncio.run(login_handoff())
        return

    kws = [k.strip() for k in args.keywords.split(",") if k.strip()] if args.keywords else ["数据分析", "BI", "用户运营"]
    asyncio.run(run_scan(kws, args.max_pages))

if __name__ == "__main__":
    main()
