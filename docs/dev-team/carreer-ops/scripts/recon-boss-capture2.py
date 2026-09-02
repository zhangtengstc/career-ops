#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-capture2.py — B1 packet capture with login handoff + GRACEFUL close.

Fixes two things found during recon:
  1. nodriver's stop() force-terminates Chrome → the login session's cookie
     writes are lost between runs. Here we close GRACEFULLY via the CDP
     Browser.close command (flushes state) so the session PERSISTS in
     boss-profile for the real source.
  2. If the profile is not logged in, waits for the user to sign in (login
     handoff) before capturing.

Single navigation, no reload, no pagination click (hard discipline).

Captures into recon-logs/: XHR responses (wapi/joblist/search), first job-card
outerHTML, filter-bar HTML, pagination presence, page body text.

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
_target = None

def val(x):
    return getattr(x, "value", x)

def logged_in(url, body):
    if not url or "passport" in url or "verify" in url or "/web/user/" in url:
        return False
    return "/web/geek" in url or ("简历" in body and "消息" in body)

async def on_response(event):
    try:
        url = event.response.url if hasattr(event, "response") else event.get("response", {}).get("url", "")
        rid = getattr(event, "request_id", None) or event.get("requestId")
        if not url or not any(k in url for k in ("wapi", "joblist", "search", "geek")):
            return
        if any(c["url"] == url for c in captured):
            return
        body = ""
        try:
            r = await _target.send(network.get_response_body(request_id=rid))
            body = r.get("body", "") if isinstance(r, dict) else ""
        except Exception:
            body = ""
        captured.append({"url": url, "body": body[:30000]})
    except Exception:
        pass

async def main():
    global _target
    browser = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN", browser_executable_path=CHROME)
    try:
        tab = await browser.get(SEARCH_URL)
        _target = tab
        await tab.send(network.enable())
        tab.add_handler(network.ResponseReceived, on_response)

        # Login handoff if needed.
        deadline = time.time() + LOGIN_WAIT_S
        while time.time() < deadline:
            await tab.sleep(4)
            url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
            body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
            if logged_in(url, body):
                print(f"[c2] logged in @ {url[:70]}")
                break
            if time.time() % 30 < 4:
                print(f"[c2] waiting login… url={url[:60]}")
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        if not logged_in(url, body):
            print("TIMEOUT_NO_LOGIN")
            return

        await tab.sleep(10)  # let list XHR + render settle
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        card_html = val(await tab.evaluate(
            "(function(){var el=document.querySelector('[class*=job]'); return el ? el.outerHTML.slice(0,4000) : '';})()",
            return_by_value=True)) or ""
        filter_html = val(await tab.evaluate(
            "(function(){var els=[].slice.call(document.querySelectorAll('[class*=filter],[class*=condition],[class*=search-option]')); return els.slice(0,3).map(e=>e.outerHTML.slice(0,2000)).join('\\n---\\n');})()",
            return_by_value=True)) or ""
        pager = val(await tab.evaluate(
            "(function(){var p=document.querySelector('[class*=pagination],[class*=pager]'); return p ? p.outerHTML.slice(0,2000) : (document.body.innerText.includes('下一页')?'PAGER_TEXT_PRESENT':'');})()",
            return_by_value=True)) or ""

        LOG.mkdir(parents=True, exist_ok=True)
        (LOG / "capture-responses.json").write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
        (LOG / "capture-card.html").write_text(card_html, encoding="utf-8")
        (LOG / "capture-filter.html").write_text(filter_html, encoding="utf-8")
        (LOG / "capture-pager.txt").write_text(pager, encoding="utf-8")
        (LOG / "capture-body.txt").write_text(body, encoding="utf-8")

        risk = "passport" in url or "verify" in url or "滑块" in body or "访问过于频繁" in body or not body.strip()
        print(f"URL={url}")
        print(f"captured={len(captured)}")
        for c in captured:
            print(f"  - {c['url'][:130]} bodyLen={len(c['body'])}")
        if captured:
            print(f"first body head: {captured[0]['body'][:400]}")
        print(f"cardHtmlLen={len(card_html)} filterHtmlLen={len(filter_html)} pager={pager[:120]!r}")
        if risk:
            print("CAPTURE_BLOCKED")
        elif captured:
            print("CAPTURE_OK")
        else:
            print("CAPTURE_EMPTY")
    finally:
        # GRACEFUL close so the session persists (nodriver.stop() force-kills).
        try:
            await browser.send(cdp_browser.close())
            await asyncio.sleep(3)
        except Exception:
            pass
        await browser.aclose()

asyncio.run(main())
