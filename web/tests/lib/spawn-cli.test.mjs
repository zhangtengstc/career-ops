// Tests for spawnHeadlessCli() using Node's built-in test runner.
// Imports directly from spawn-cli.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/spawn-cli.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnHeadlessCli, unwrapNpmShim } from "../../src/lib/spawn-cli.mjs";

// Fixture: a fake npm global dir with the .cmd + extensionless sh shim pair npm
// generates, and the node_modules entry js they wrap.
function makeShimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cli-shim-"));
  const js = path.join(dir, "node_modules", "fake-cli", "bin", "cli.js");
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, 'console.log("cli-js-ok", process.argv.slice(2).join("|"));\n');
  fs.writeFileSync(
    path.join(dir, "fake.cmd"),
    `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\fake-cli\\bin\\cli.js" %*\r\n`,
  );
  fs.writeFileSync(
    path.join(dir, "fake"),
    `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/fake-cli/bin/cli.js" "$@"\n`,
  );
  fs.writeFileSync(path.join(dir, "real.exe"), "MZ not really an exe");
  return dir;
}

test("unwrapNpmShim unwraps the .cmd npm shim to its node entry js", () => {
  const dir = makeShimDir();
  const unwrapped = unwrapNpmShim(path.join(dir, "fake.cmd"), "win32");
  assert.ok(unwrapped?.endsWith(path.join("node_modules", "fake-cli", "bin", "cli.js")));
});

test("unwrapNpmShim unwraps the extensionless sh shim too", () => {
  const dir = makeShimDir();
  const unwrapped = unwrapNpmShim(path.join(dir, "fake"), "win32");
  assert.ok(unwrapped?.endsWith(path.join("node_modules", "fake-cli", "bin", "cli.js")));
});

test("unwrapNpmShim passes real binaries and non-windows platforms through", () => {
  const dir = makeShimDir();
  assert.equal(unwrapNpmShim(path.join(dir, "real.exe"), "win32"), null);
  assert.equal(unwrapNpmShim(path.join(dir, "fake.cmd"), "linux"), null);
  assert.equal(unwrapNpmShim(path.join(dir, "fake.cmd"), "darwin"), null);
  // A .cmd that wraps NO node entry (missing js on disk) must not be unwrapped.
  const orphan = path.join(dir, "orphan.cmd");
  fs.writeFileSync(orphan, `@ECHO off\r\nnode "%~dp0\\node_modules\\gone\\cli.js" %*\r\n`);
  assert.equal(unwrapNpmShim(orphan, "win32"), null);
});

// The win32-only end-to-end (spawn through an unwrapped shim) runs where the
// shim semantics exist; elsewhere unwrapNpmShim returns null by contract.
test("spawnHeadlessCli runs an unwrapped npm shim with clean argv", { skip: process.platform !== "win32" }, async () => {
  const dir = makeShimDir();
  const child = spawnHeadlessCli(path.join(dir, "fake.cmd"), ["a b", "c"], { cwd: dir });
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0);
  // argv survives verbatim (space in "a b" intact) — no cmd.exe quoting layer.
  assert.equal(stdout.trim(), "cli-js-ok a b|c");
});

test("spawnHeadlessCli converts a synchronous spawn throw into the async contract", async () => {
  // A .cmd that is NOT a node shim: spawn throws EINVAL synchronously on win32;
  // callers only listen for async 'error'/'close'. (On POSIX this .cmd simply
  // fails async — either way the contract is error-or-nonzero, never a hang.)
  const dir = makeShimDir();
  const bad = path.join(dir, "native.cmd");
  fs.writeFileSync(bad, "@ECHO off\r\necho hi\r\n");
  const child = spawnHeadlessCli(bad, [], { cwd: dir });
  const result = await new Promise((resolve) => {
    child.once("error", (e) => resolve({ error: String(e) }));
    child.once("close", (code) => resolve({ code }));
  });
  assert.ok("error" in result || result.code !== 0);
});

test("spawnHeadlessCli closes stdin so a headless CLI can start", async () => {
  // Given: a child that only speaks once its stdin has reached EOF — a stand-in
  // for `codex exec`, which waits on an open stdin pipe for more prompt input
  // and so produces no stdout at all until it is closed (#2085).
  const script = [
    'process.stdin.on("end", () => process.stdout.write("READY"));',
    "process.stdin.resume();",
  ].join("");

  // When: it is spawned through the shared headless spawner.
  const child = spawnHeadlessCli(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: process.env,
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });

  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // If stdin regressed and stayed open, fail fast with a clear message instead
  // of hanging until the test runner's own timeout.
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("child did not close — stdin may not have been closed")), 3000);
  });

  const code = await Promise.race([closed, timedOut]);
  clearTimeout(timer); // don't keep node --test alive 3s after a clean close

  // Then: it saw EOF, spoke, and exited cleanly.
  assert.equal(code, 0);
  assert.equal(stdout, "READY");
});

test("spawnHeadlessCli tolerates a caller that passes stdio itself", async () => {
  // Given: no call site spells stdio today — the typed options omit it so
  // stdout/stderr stay non-null pipes. But an untyped or future caller could
  // pass stdio: ["ignore", …], which makes child.stdin null, and a hard
  // .end() would then throw. This pins the optional call that prevents it.
  const child = spawnHeadlessCli(process.execPath, ["-e", 'process.stdout.write("OK")'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // When: the child runs to completion.
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  // Then: no stdin pipe existed, and the run still succeeded.
  assert.equal(child.stdin, null);
  assert.equal(code, 0);
  assert.equal(stdout, "OK");
});
