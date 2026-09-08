// Resolve a usable Python interpreter for the boss.py sidecar.
//
// Why this exists (D-006): the web dev server can be started from an
// Explorer/cmd context whose PATH resolves `python` to a venv WITHOUT the
// sidecar's deps (e.g. ~/.agent-reach-venv, no nodriver). boss.py then dies on
// import with an empty stdout, which surfaced as the generic parse error
// instead of the real loginRequired/browserNotRunning state. Never trust
// ambient PATH — probe candidates and verify the required module imports.
//
// Pure ESM + node builtins so both Next route handlers (web/) and root-level
// .mjs scripts (browser-sources/boss.mjs) can import it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Interpreter candidates, in priority order:
//  1. CAREER_OPS_PYTHON env override (explicit ops choice).
//  2. `python` on PATH (only accepted if it passes the module probe).
//  3. The Hermes agent venv — known-good on this machine (nodriver installed).
export function pythonCandidates() {
  const out = [];
  if (process.env.CAREER_OPS_PYTHON) out.push(process.env.CAREER_OPS_PYTHON);
  out.push("python");
  const local = process.env.LOCALAPPDATA;
  if (local) {
    out.push(path.join(local, "hermes", "hermes-agent", "venv", "Scripts", "python.exe"));
  }
  return out;
}

function probe(exe, requireModule) {
  const args = requireModule ? ["-c", `import ${requireModule}`] : ["--version"];
  const r = spawnSync(exe, args, { stdio: "ignore", windowsHide: true, timeout: 15000 });
  return !r.error && r.status === 0;
}

let cache = new Map();

// First candidate that runs AND can import `requireModule` (when given);
// null when nothing qualifies. Result is cached per module for the process.
export function resolvePythonExecutable({ requireModule } = {}) {
  const key = requireModule || "";
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const cand of pythonCandidates()) {
    if (!cand) continue;
    // Absolute/relative paths must exist; a bare command name is left to PATH.
    if (cand !== path.basename(cand) && !fs.existsSync(cand)) continue;
    if (probe(cand, requireModule)) {
      found = cand;
      break;
    }
  }
  cache.set(key, found);
  return found;
}
