#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recon-boss-vue-probe.py — dump the Vue component state behind each job card,
the real card selector, and the @font-face CSS (for salary de-obfuscation).

Session already persists in the canonical boss-profile, so no login is expected.
Single page load, graceful close. Evidence → recon-logs/vue-probe-*.json.
"""
import asyncio, json, pathlib, sys
import nodriver as uc
from nodriver.cdp import browser as cdp_browser

PROFILE = str(pathlib.Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss-profile")
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100"
LOG = pathlib.Path(__file__).resolve().parents[1] / "recon-logs"

def val(x):
    return getattr(x, "value", x)

JS = r"""
(function(){
  var out = {};
  // candidate card selectors + counts
  var sels = ['[class*=job-card]','[class*=job-item]','.job-list-box ul li','.job-list li','[class*=card-wrapper]','.job-primary','.job-card-wrapper'];
  out.selectorCounts = sels.map(function(s){ return [s, document.querySelectorAll(s).length]; });
  // first matching card: its __vue__ data (job object), sanitized to JSON
  var card = null;
  for (var i=0;i<sels.length;i++){ var els=document.querySelectorAll(sels[i]); if(els.length){ card=els[0]; out.cardSelector=sels[i]; break; } }
  if (card) {
    out.cardOuterHTML = card.outerHTML.slice(0, 6000);
    var v = card.__vue__;
    if (v) {
      // walk up a few levels to find a component holding job-ish data
      var node = v, found = null, depth = 0;
      while (node && depth < 8) {
        var d = node.$data || node._data || {};
        var keys = Object.keys(d);
        var hasJob = keys.some(function(k){ return /job|salary|brand|position/i.test(k); });
        if (hasJob) { found = {depth: depth, keys: keys, data: d}; break; }
        node = node.$parent;
        depth++;
      }
      out.vueState = found ? found : {note: 'no job-ish data within 8 levels', rootKeys: Object.keys(v.$data||{})};
      // try stringify the found data (strip functions/circular)
      try {
        out.vueStateJson = JSON.stringify(found ? found.data : null, function(k,v){
          if (typeof v === 'function') return undefined;
          return v;
        }, 2);
      } catch(e){ out.vueStateJson = 'JSON.stringify failed: '+e.message; }
    } else {
      out.vueMissing = 'card has no __vue__';
    }
  }
  // @font-face css (salary digit obfuscation font)
  var fonts = [];
  try {
    var sheets = document.styleSheets;
    for (var s=0;s<sheets.length;s++){
      var rules; try { rules = sheets[s].cssRules || sheets[s].rules; } catch(e){ continue; }
      if (!rules) continue;
      for (var r=0;r<rules.length;r++){
        var txt = rules[r].cssText || '';
        if (/@font-face/i.test(txt) || /src:/i.test(txt)) fonts.push(txt.slice(0,300));
      }
    }
  } catch(e){}
  out.fontFaces = fonts.slice(0, 12);
  return JSON.stringify(out);
})()
"""

async def main():
    browser = await uc.start(user_data_dir=PROFILE, headless=False, lang="zh-CN", browser_executable_path=CHROME)
    try:
        tab = await browser.get(SEARCH_URL)
        await tab.sleep(14)
        url = val(await tab.evaluate("location.href", return_by_value=True)) or ""
        body = val(await tab.evaluate("document.body ? document.body.innerText.slice(0,200) : ''", return_by_value=True)) or ""
        if "/web/user/" in url or "passport" in url:
            print("NOT_LOGGED_IN url=" + url)
            return
        raw = val(await tab.evaluate(JS, return_by_value=True)) or "{}"
        LOG.mkdir(parents=True, exist_ok=True)
        (LOG / "vue-probe.json").write_text(raw, encoding="utf-8")
        try:
            obj = json.loads(raw)
        except Exception:
            obj = {"raw": raw[:2000]}
        print("URL=" + url)
        print("selectorCounts=" + json.dumps(obj.get("selectorCounts"), ensure_ascii=False))
        print("cardSelector=" + json.dumps(obj.get("cardSelector"), ensure_ascii=False))
        print("vueState keys=" + json.dumps(obj.get("vueState", {}).get("keys", obj.get("vueState", {}).get("note", "?")), ensure_ascii=False))
        print("vueStateJson head=" + (obj.get("vueStateJson") or "")[:1200])
        print("fontFaces count=" + str(len(obj.get("fontFaces") or [])))
        for f in (obj.get("fontFaces") or [])[:4]:
            print("  FONT: " + f)
        print("PROBE_DONE")
    finally:
        try:
            await browser.send(cdp_browser.close()); await asyncio.sleep(3)
        except Exception: pass
        await browser.aclose()

asyncio.run(main())
