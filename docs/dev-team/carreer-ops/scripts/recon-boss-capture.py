#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-capture.py — B1 packet capture (single page load, hard-discipline
compliant: one navigation, no reload, no pagination click).

Captures, into recon-logs/:
  1. every XHR/fetch response whose URL mentions wapi/joblist/search (to identify
     the list JSON endpoint + its plaintext schema incl. real salary numbers),
  2. the first job card's outerHTML (selector + font-obfuscation class evidence),
  3. the filter bar HTML (R4 semantic→code mapping source),
  4. pagination control presence (R2).

Verdict: CAPTURE_OK (n responses captured) | CAPTURE_EMPTY | CAPTURE_BLOCKED
"""
import asyncio, json, pathlib, sys
import nodriver as uc
import nodriver.cdp.network as network

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100"
LOG = pathlib.Path(__file__).resolve().parents[1] / "recon-logs"

captured = []

def val(x):
    return getattr(x, "value", x)

async def on_response(event):
    try:
        url = getattr(event, "url", None) or (event.get("response", {}).get("url") if isinstance(event, dict) else None)
        rid = getattr(event, "request_id", None) or (event.get("requestId") if isinstance(event, dict) else None)
        if not url:
            return
        if not any(k in url for k in ("wapi", "joblist", "search", "geek")):
            return
        # avoid duplicates
        if any(c["url"] == url for c in captured):
            return
        body = ""
        try:
            r = await event_target.send(network.get_response_body(request_id=rid))
            body = r.get("body", "") if isinstance(r, dict) else ""
        except Exception:
            body = ""
        captured.append({"url": url, "body": body[:20000]})
    except Exception:
        pass

async def main():
    global event_target
    browser = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN", browser_executable_path=CHROME)
    try:
        tab = await browser.get(SEARCH_URL)
        event_target = tab
        await tab.send(network.enable())
        tab.add_handler(network.ResponseReceived, on_response)

        await tab.sleep(18)  # let the list XHR fire + render

        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText : ''", return_by_value=True)) or ""
        card_html = val(await tab.evaluate(
            "(function(){var el=document.querySelector('[class*=job]'); return el ? el.outerHTML.slice(0,3000) : '';})()",
            return_by_value=True)) or ""
        filter_html = val(await tab.evaluate(
            "(function(){var els=[].slice.call(document.querySelectorAll('[class*=filter],[class*=condition],[class*=search-option]')); return els.slice(0,3).map(e=>e.outerHTML.slice(0,1500)).join('\\n---\\n');})()",
            return_by_value=True)) or ""
        pager_html = val(await tab.evaluate(
            "(function(){var p=document.querySelector('[class*=pagination],[class*=pager]'); if(!p){var t=document.body.innerText; return t.includes('下一页')||t.includes('上一页') ? 'PAGER_TEXT_PRESENT' : '';} return p.outerHTML.slice(0,2000);})()",
            return_by_value=True)) or ""

        LOG.mkdir(parents=True, exist_ok=True)
        (LOG / "capture-responses.json").write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
        (LOG / "capture-card.html").write_text(card_html, encoding="utf-8")
        (LOG / "capture-filter.html").write_text(filter_html, encoding="utf-8")
        (LOG / "capture-pager.txt").write_text(pager_html, encoding="utf-8")
        (LOG / "capture-body.txt").write_text(body, encoding="utf-8")

        risk = "passport" in url or "verify" in url or "滑块" in body or "访问过于频繁" in body or not body.strip()
        print(f"URL={url}")
        print(f"captured={len(captured)} responses; urls=")
        for c in captured:
            print(f"  - {c['url'][:120]}  bodyLen={len(c['body'])}")
        if captured:
            c0 = captured[0]
            print(f"first-captured body head: {c0['body'][:400]}")
        print(f"cardHtmlLen={len(card_html)} filterHtmlLen={len(filter_html)} pager={pager_html[:120]!r}")
        if risk:
            print("CAPTURE_BLOCKED risk-signature")
        elif captured:
            print("CAPTURE_OK")
        else:
            print("CAPTURE_EMPTY (no wapi/joblist/search XHR captured)")
    finally:
        await browser.aclose()
        browser.stop()
        await asyncio.sleep(0.5)

asyncio.run(main())
