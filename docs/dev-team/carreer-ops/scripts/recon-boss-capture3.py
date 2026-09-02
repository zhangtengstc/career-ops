#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-capture3.py — B1 list-JSON capture, FIXED.

Fixes vs capture2:
  1. PROFILE path now resolves to the REPO ROOT (parents[4]), so the session
     persists in the canonical config/browser-state/boss-profile (the capture2
     scripts wrongly used parents[3] = docs/).
  2. Response bodies are captured on network.LoadingFinished (getResponseBody
     on ResponseReceived returns empty — the body isn't buffered yet).
  3. Login handoff if the profile is not signed in; graceful close (Browser.close)
     so the session persists for the real source.

Verdicts: CAPTURE_OK | CAPTURE_EMPTY | CAPTURE_BLOCKED | TIMEOUT_NO_LOGIN
"""
import asyncio, json, pathlib, sys, time
import nodriver as uc
import nodriver.cdp.network as network
from nodriver.cdp import browser as cdp_browser

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100"
LOG = pathlib.Path(__file__).resolve().parents[1] / "recon-logs"
LOGIN_WAIT_S = 12 * 60

captured = []
pending = {}
_target = None

def val(x):
    return getattr(x, "value", x)

def logged_in(url, body):
    if not url or "passport" in url or "verify" in url or "/web/user/" in url:
        return False
    return "/web/geek" in url or ("简历" in body and "消息" in body)

async def on_response(event):
    try:
        pending[event.request_id] = event.response.url
    except Exception:
        pass

async def on_loading_finished(event):
    try:
        url = pending.get(event.request_id)
        if not url or not any(k in url for k in ("wapi", "joblist", "search", "geek")):
            return
        if any(c["url"] == url for c in captured):
            return
        r = await _target.send(network.get_response_body(request_id=event.request_id))
        body = r.get("body", "") if isinstance(r, dict) else ""
        if body:
            captured.append({"url": url, "body": body[:50000]})
    except Exception:
        pass

async def main():
    global _target
    browser = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN", browser_executable_path=CHROME)
    try:
        tab = await browser.get(SEARCH_URL)
        _target = tab
        await tab.send(network.enable(max_resource_buffer_size=100_000_000, max_total_buffer_size=200_000_000))
        tab.add_handler(network.ResponseReceived, on_response)
        tab.add_handler(network.LoadingFinished, on_loading_finished)

        deadline = time.time() + LOGIN_WAIT_S
        while time.time() < deadline:
            await tab.sleep(4)
            url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
            body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
            if logged_in(url, body):
                print(f"[c3] logged in @ {url[:70]}")
                break
            if time.time() % 30 < 4:
                print(f"[c3] waiting login… url={url[:60]}")
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        if not logged_in(url, body):
            print("TIMEOUT_NO_LOGIN")
            return

        await tab.sleep(12)  # let list XHR fire + LoadingFinished bodies land
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""

        LOG.mkdir(parents=True, exist_ok=True)
        (LOG / "capture3-responses.json").write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
        (LOG / "capture3-body.txt").write_text(body, encoding="utf-8")

        risk = "passport" in url or "verify" in url or "滑块" in body or "访问过于频繁" in body or not body.strip()
        print(f"URL={url}")
        nz = [c for c in captured if c["body"].strip()]
        print(f"captured={len(captured)} nonZeroBodies={len(nz)}")
        for c in nz:
            print(f"  - {c['url'][:110]} bodyLen={len(c['body'])}")
        if nz:
            print(f"first non-zero body head: {nz[0]['body'][:500]}")
        if risk:
            print("CAPTURE_BLOCKED")
        elif nz:
            print("CAPTURE_OK")
        else:
            print("CAPTURE_EMPTY")
    finally:
        try:
            await browser.send(cdp_browser.close())
            await asyncio.sleep(3)
        except Exception:
            pass
        await browser.aclose()

asyncio.run(main())
