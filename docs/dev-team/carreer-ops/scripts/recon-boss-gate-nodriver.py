#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-gate-nodriver.py — nodriver control (user-authorized 2026-09-02):
drive the SAME trusted boss-profile with nodriver (no Playwright fingerprints)
and load one BOSS search page. Decides whether the automated scan route is
viable with a stealth driver.

Verdicts: ND_PASS | ND_BLOCKED <reason> | ND_INCONCLUSIVE
"""
import asyncio, pathlib, sys
import nodriver as uc

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100"
LOG = pathlib.Path(__file__).resolve().parents[1] / "recon-logs" / "nodriver-gate-body.txt"

def val(x):
    return getattr(x, "value", x)

async def main():
    browser = await uc.start(
        user_data_dir=PROFILE, headless=False, lang="zh-CN",
        browser_executable_path=CHROME,
    )
    try:
        tab = await browser.get(SEARCH_URL)
        await tab.sleep(18)
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        webdriver = val(await tab.evaluate("navigator.webdriver", return_by_value=True))
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        counts = val(await tab.evaluate(
            "JSON.stringify(['[class*=job]','[class*=card]','[class*=item]','li'].map(s=>[s,document.querySelectorAll(s).length]))",
            return_by_value=True))
        LOG.parent.mkdir(parents=True, exist_ok=True)
        LOG.write_text(body, encoding="utf-8")

        print(f"URL={url}")
        print(f"navigator.webdriver={webdriver}")
        print(f"counts={counts}")
        print(f"bodyHead={body[:260]!r}")
        print(f"bodyLen={len(body)} evidence={LOG}")

        risk = ("passport" in url or "verify" in url or "captcha" in url
                or "滑块" in body or "访问过于频繁" in body or "安全验证" in body
                or (not body.strip()))
        # BOSS job rows render list items with a "沟通" CTA and salary "·" patterns;
        # use presence of job-list markers as the pass signal.
        has_list = ("沟通" in body or ("K" in body and "·" in body) or "在招" in body or "刚刚活跃" in body or "半年前活跃" in body or "今天活跃" in body)

        if risk:
            print("ND_BLOCKED " + ("auth-wall-url" if "passport" in url or "verify" in url else "") + ("risk-text" if "滑块" in body or "访问过于频繁" in body else "") + ("empty" if not body.strip() else ""))
        elif has_list:
            print("ND_PASS (job list markers present, no risk signature)")
        else:
            print("ND_INCONCLUSIVE (no job list, no risk signature — inspect evidence)")
    finally:
        await browser.aclose()
        browser.stop()
        await asyncio.sleep(0.5)

asyncio.run(main())
