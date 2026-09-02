#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-nodriver-login.py — nodriver login handoff + gate (user-authorized).

The v7 session in boss-profile was invalidated server-side by the earlier
Playwright persist test (17-reload loop → BOSS force-logout); the wt2 cookie is
still present client-side but no longer honoured. nodriver reaches the NORMAL
login page (no security wall, navigator.webdriver=False), so: re-login once in
the nodriver window, then run the search gate.

Verdicts: ND_LOGIN_OK_AND_PASS | ND_LOGIN_OK_AND_BLOCKED | ND_LOGIN_OK_INCONCLUSIVE
          | ND_TIMEOUT_NO_LOGIN
"""
import asyncio, pathlib, sys, time
import nodriver as uc

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100"
LOGIN_WAIT_S = 12 * 60
LOG = pathlib.Path(__file__).resolve().parents[1] / "recon-logs" / "nodriver-login-body.txt"

def val(x):
    return getattr(x, "value", x)

def logged_in(url, body):
    if not url or "passport" in url or "verify" in url:
        return False
    if "/web/user/" in url:
        return False
    # Back on a geek app route (search/recommend/job_detail) OR the logged-in
    # header ("简历"/"消息") is present.
    if "/web/geek" in url or "/web/expect" in url:
        return True
    return "简历" in body and "消息" in body

async def main():
    browser = await uc.start(
        user_data_dir=PROFILE, headless=False, lang="zh-CN",
        browser_executable_path=CHROME,
    )
    try:
        tab = await browser.get(SEARCH_URL)
        print("[nd] 请在弹出的 Chrome 窗口中完成 BOSS直聘 登录（扫码/验证码）。登录成功跳回职位页后自动继续。")
        deadline = time.time() + LOGIN_WAIT_S
        while time.time() < deadline:
            await tab.sleep(4)
            url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
            body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
            if logged_in(url, body):
                print(f"[nd] logged in @ {url[:80]}")
                break
            if time.time() % 30 < 4:
                print(f"[nd] waiting login… url={url[:60]}")

        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        if not logged_in(url, body):
            print("ND_TIMEOUT_NO_LOGIN")
            return

        # Give the job list a few seconds to render, then judge.
        await tab.sleep(8)
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        counts = val(await tab.evaluate(
            "JSON.stringify(['[class*=job]','[class*=card]','[class*=item]','li'].map(s=>[s,document.querySelectorAll(s).length]))",
            return_by_value=True))
        LOG.parent.mkdir(parents=True, exist_ok=True)
        LOG.write_text(body, encoding="utf-8")

        print(f"URL={url}")
        print(f"counts={counts}")
        print(f"bodyLen={len(body)} bodyHead={body[:240]!r} evidence={LOG}")

        risk = ("passport" in url or "verify" in url or "滑块" in body or "访问过于频繁" in body or not body.strip())
        has_list = ("在招" in body or "刚刚活跃" in body or "今天活跃" in body or "半年前活跃" in body
                    or ("K" in body and "·" in body and "沟通" in body))
        if risk:
            print("ND_LOGIN_OK_AND_BLOCKED risk-signature")
        elif has_list:
            print("ND_LOGIN_OK_AND_PASS")
        else:
            print("ND_LOGIN_OK_INCONCLUSIVE")
    finally:
        await browser.aclose()
        browser.stop()
        await asyncio.sleep(0.5)

asyncio.run(main())
