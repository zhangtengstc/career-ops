import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Plain .mjs (same pattern as tracker-table.mjs/clean-chips.mjs) so
// tests/lib/spawn-cli.test.mjs can import it directly under Node. Import it with the
// .mjs extension included (e.g. "@/lib/spawn-cli.mjs") — unlike .ts files,
// which TypeScript resolves without an extension, ESM specifiers for plain
// JS modules must be fully specified.

/**
 * Windows npm/pip shims are NOT directly spawnable:
 *  - an extensionless sibling (npm's POSIX sh shim) is a bash script —
 *    CreateProcess rejects it (async ENOENT, and every CLI route died silently);
 *  - a `.cmd`/`.bat` twin is blocked by Node without `shell: true`
 *    (CVE-2024-27980 EINVAL), and `shell: true` mangles prompts containing
 *    quotes/newlines through cmd.exe.
 *
 * Both shim flavors wrap the same thing: `node "<shimDir>/node_modules/<…>.js"`.
 * Unwrap that entry point and the caller spawns REAL node with clean argv — no
 * cmd.exe quoting surface at all. Returns the absolute .js path, or null when
 * the file isn't a node shim (a real .exe, a non-node wrapper, non-Windows).
 *
 * `platform` is injectable so the test suite can exercise the win32 branch on
 * any CI host.
 *
 * @param {string} binPath
 * @param {string} [platform]
 * @returns {string|null}
 */
export function unwrapNpmShim(binPath, platform = process.platform) {
  if (platform !== "win32") return null;
  const base = path.basename(binPath).toLowerCase();
  if (base.endsWith(".exe") || base.endsWith(".com")) return null; // real binary
  const isCmdShim = base.endsWith(".cmd") || base.endsWith(".bat");
  const isExtensionless = !base.includes(".");
  if (!isCmdShim && !isExtensionless) return null;

  let text;
  try {
    text = fs.readFileSync(binPath, "utf8");
  } catch {
    return null;
  }
  // cmd flavor: node "%~dp0\node_modules\<…>.js" %*  ·  sh flavor (MSYS):
  // exec node "$basedir/node_modules/<…>.js" "$@" — the node_modules tail is
  // the same relative path in both, resolved against the shim's own directory.
  const m = text.match(/node_modules[\\/][^"'\r\n]+?\.js/i);
  if (!m) return null;
  const js = path.join(path.dirname(binPath), m[0]);
  try {
    fs.accessSync(js);
  } catch {
    return null;
  }
  return js;
}

/** A child that has already failed — preserves the async error contract for
 *  callers when spawn itself throws synchronously (e.g. a non-node .cmd). */
function failedChild(message) {
  const child = spawn(process.execPath, ["-e", `console.error(${JSON.stringify(message)}); process.exit(1)`]);
  child.stdin?.end();
  return child;
}

/**
 * Spawn a headless agent CLI with stdin closed.
 *
 * CLIs such as `codex exec` read additional prompt text from stdin when a pipe
 * is left open. A web request never supplies that extra input, so leaving the
 * default pipe open makes Codex wait forever without producing stdout. This is
 * the ONLY spawn path for CLI-invoking routes — every call site should use it
 * instead of `node:child_process`'s `spawn` directly, so the fix can't drift.
 *
 * It also replaces the `stdio: ["ignore", ...]` the apply planners used to spell
 * for the same reason — one mechanism means one place for this to be right.
 * The options type omits `stdio` on purpose: stdout/stderr must stay pipes for
 * every caller's stream handlers, and TypeScript keeps `child.stdout` non-null
 * only under that contract. `stdin` is still optional-chained so an untyped
 * caller passing `stdio` anyway degrades safely (null stdin) instead of throwing.
 *
 * @param {string} binPath
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptionsWithoutStdio} options
 */
export function spawnHeadlessCli(binPath, args, options) {
  const shimJs = unwrapNpmShim(binPath);
  let child;
  try {
    child = shimJs
      ? spawn(process.execPath, [shimJs, ...args], options)
      : spawn(binPath, args, options);
  } catch (e) {
    // spawn() throws SYNCHRONOUSLY for a .cmd/.bat it can't unwrap (EINVAL) —
    // callers only listen for the async 'error' event, so convert.
    child = failedChild(`spawn ${binPath} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  child.stdin?.end();
  return child;
}
