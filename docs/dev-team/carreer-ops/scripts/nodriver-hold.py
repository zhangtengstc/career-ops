import asyncio, pathlib, sys
import nodriver as uc
PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
async def main():
    b = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN", browser_executable_path=CHROME)
    print(f"HOLD config.user_data_dir={b.config.user_data_dir}", flush=True)
    t = await b.get("data:text/html,<title>hold</title>")
    await t.sleep(600)
asyncio.run(main())
