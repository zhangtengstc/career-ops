// python-env.mjs — interpreter resolution (D-006).
import test from "node:test";
import assert from "node:assert/strict";
import { pythonCandidates, resolvePythonExecutable } from "../../src/lib/python-env.mjs";

test("pythonCandidates: CAREER_OPS_PYTHON override comes first, bare python on PATH included", () => {
  const prev = process.env.CAREER_OPS_PYTHON;
  process.env.CAREER_OPS_PYTHON = "D:/custom/python.exe";
  try {
    const c = pythonCandidates();
    assert.equal(c[0], "D:/custom/python.exe");
    assert.ok(c.includes("python"));
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_PYTHON;
    else process.env.CAREER_OPS_PYTHON = prev;
  }
});

test("resolvePythonExecutable: finds an interpreter that can import nodriver", () => {
  const exe = resolvePythonExecutable({ requireModule: "nodriver" });
  assert.ok(exe, "expected a python with nodriver (set CAREER_OPS_PYTHON if missing)");
});

test("resolvePythonExecutable: bogus module resolves to null, never a bare PATH python", () => {
  const exe = resolvePythonExecutable({ requireModule: "no_such_module_xyz_123" });
  assert.equal(exe, null);
});
