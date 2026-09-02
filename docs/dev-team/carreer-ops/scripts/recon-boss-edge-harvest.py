#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recon-boss-edge-harvest.py — v6: offline harvest of the user's EXISTING Edge
BOSS直聘 session into config/browser-state/boss.json (Playwright storageState).

Why: recon R5 (A-grade) — three fresh dedicated profiles were treated as bots
by BOSS risk control (refresh loop / window.close), while the user's daily
Edge opens zhipin.com and auto-logs-in fine. The trusted session already lives
in Edge's cookie DB; no browser is launched, no CDP, no automation at all.

Scope guardrail (QA): reads ONLY host_key LIKE '%zhipin.com' cookies from the
Edge cookie database; nothing else is read, written, or persisted. The Edge
cookie DB is copied to a temp file first (Edge must be fully closed so the
copy is consistent) and the copy is deleted afterwards.

Requirements: python 3.11 + cryptography/pycryptodome (present on this host),
Edge fully closed.
Usage: python recon-boss-edge-harvest.py
Prints: OK <boss.json path> (<n> zhipin cookies, <k> auth-ish) | ERR <reason>
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

EDGE_UD = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Edge" / "User Data"
LOCAL_STATE = EDGE_UD / "Local State"
COOKIES_DB = EDGE_UD / "Default" / "Network" / "Cookies"
OUT_PATH = Path(__file__).resolve().parents[4] / "config" / "browser-state" / "boss.json"
AUTH_COOKIE_RE = ("wt2", "zp_token", "zp_passport", "last_login", "zp_seo")

# ── DPAPI (ctypes, no pywin32 needed) ────────────────────────────────────
class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

def dpapi_unprotect(blob: bytes) -> bytes:
    """CryptUnprotectData for the CURRENT Windows user (Edge runs as this user)."""
    inblob = DATA_BLOB(len(blob), ctypes.cast(ctypes.create_string_buffer(blob), ctypes.POINTER(ctypes.c_char)))
    outblob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(inblob), None, None, None, None, 0, ctypes.byref(outblob)
    ):
        raise RuntimeError(f"CryptUnprotectData failed (err {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(outblob.pbData, outblob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(outblob.pbData)

def edge_running() -> bool:
    try:
        # Binary compare — tasklist output is locale-encoded (GBK on zh-CN
        # Windows); decoding it as UTF-8 crashes the reader thread.
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq msedge.exe", "/NH"],
                             capture_output=True, timeout=15)
        return b"msedge.exe" in out.stdout
    except Exception:
        return True  # fail closed: assume running

def main() -> int:
    if not (LOCAL_STATE.exists() and COOKIES_DB.exists()):
        print(f"ERR Edge profile not found under {EDGE_UD}")
        return 1
    if edge_running():
        print("ERR Edge is still running — please fully close Edge (all windows) and re-run.")
        return 1

    # 1. Master key: Local State → os_crypt.encrypted_key → DPAPI unwrap.
    state = json.loads(LOCAL_STATE.read_text(encoding="utf-8"))
    enc_key = base64.b64decode(state["os_crypt"]["encrypted_key"])
    assert enc_key.startswith(b"DPAPI"), "unexpected encrypted_key prefix"
    master_key = dpapi_unprotect(enc_key[5:])

    # 2. Copy the cookie DB to a temp location (Edge is closed → consistent).
    tmp = Path(tempfile.mkdtemp(prefix="boss-harvest-"))
    db_copy = tmp / "Cookies"
    try:
        shutil.copy2(COOKIES_DB, db_copy)
    except Exception as e:
        print(f"ERR cookie DB copy failed: {e}")
        return 1

    try:
        con = sqlite3.connect(db_copy)
        con.text_factory = bytes
        # ── scope evidence (QA compliance item) — zhipin.com domain ONLY ──
        SQL_FILTER = "host_key LIKE '%zhipin.com'"
        print(f"[scope] Edge cookie DB read: {COOKIES_DB}")
        print(f"[scope] domain filter (SQL): {SQL_FILTER} — no other host read")
        # SameSite column name differs across Chromium schema versions
        # (same_site → samesite → firstpartyonly historically). text_factory
        # is bytes, so decode the PRAGMA names.
        cols = [r[1].decode() if isinstance(r[1], bytes) else str(r[1])
                for r in con.execute("PRAGMA table_info(cookies)")]
        ss_col = next((c for c in ("samesite", "same_site", "firstpartyonly") if c in cols), None)
        if ss_col is None:
            print(f"ERR unknown cookies schema (columns: {','.join(cols)})")
            return 1
        rows = con.execute(
            "SELECT host_key, name, path, expires_utc, is_secure, is_httponly, "
            f"encrypted_value, {ss_col} FROM cookies WHERE {SQL_FILTER}"
        ).fetchall()
        con.close()
        print(f"[scope] rows read: {len(rows)} (all zhipin.com domain)")

        v20_hit = False
        cookies = []
        for host_key, name, path, expires_utc, is_secure, is_httponly, enc_value, same_site in rows:
            if not enc_value:
                continue
            # Chromium "v10": 3-byte prefix + 12-byte nonce + AES-256-GCM payload.
            # "v20" (app-bound, Edge/Chrome 127+) cannot be unwrapped with plain DPAPI.
            if enc_value.startswith(b"v20"):
                v20_hit = True
                continue
            if not enc_value.startswith(b"v10"):
                continue
            try:
                nonce, ct = enc_value[3:15], enc_value[15:]
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                plain = AESGCM(master_key).decrypt(nonce, ct, None)
            except Exception:
                continue  # undecryptable row — skip, keep the rest
            expires = int(expires_utc / 1_000_000 - 11644473600)  # 1601→1970
            # Chromium same-site ints: 0=Unspecified 1=Lax 2=Strict 3=NoRestriction
            same = {1: "Lax", 2: "Strict", 3: "None"}.get(same_site, "None")
            cookies.append({
                "name": name.decode(),
                "value": plain.decode(),
                "domain": host_key.decode().lstrip("."),
                "path": path.decode(),
                "expires": max(expires, 0) if expires > 0 else -1,
                "httpOnly": bool(is_httponly),
                "secure": bool(is_secure),
                "sameSite": same,
            })

        if not cookies:
            print("ERR no decryptable zhipin cookies found" + (" (v20 app-bound encryption hit — need the CDP fallback route)" if v20_hit else " (no zhipin session in this profile?)"))
            return 1

        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps({"cookies": cookies, "origins": []}, ensure_ascii=False), encoding="utf-8")
        auth = [c["name"] for c in cookies if any(a in c["name"].lower() for a in AUTH_COOKIE_RE)]
        print(f"[scope] single write target: {OUT_PATH} (no other file written)")
        print(f"OK {OUT_PATH} ({len(cookies)} zhipin cookies; auth-ish: {','.join(auth) or 'none'})" + ("; NOTE v20 rows skipped — CDP fallback may be needed for full session" if v20_hit else ""))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
