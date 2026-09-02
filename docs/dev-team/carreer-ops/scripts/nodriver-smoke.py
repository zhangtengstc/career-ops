#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nodriver smoke test — data: URL only, no network target. Verifies nodriver
launches real Chrome via CDP without Playwright's automation fingerprints."""
import asyncio, os, pathlib, sys
import nodriver as uc

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")

async def main():
    browser = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN")
    try:
        tab = await browser.get("data:text/html,<title>nodriver-ok</title>")
        await tab.sleep(2)
        title = await tab.evaluate("document.title", return_by_value=True)
        title = getattr(title, "value", title)
        webdriver_flag = await tab.evaluate("navigator.webdriver", return_by_value=True)
        webdriver_flag = getattr(webdriver_flag, "value", webdriver_flag)
        print(f"SMOKE_OK title={title!r} navigator.webdriver={webdriver_flag!r}")
    finally:
        await browser.aclose()
        browser.stop()
        await asyncio.sleep(0.5)

asyncio.run(main())
