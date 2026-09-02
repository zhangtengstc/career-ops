// Tests for the login-source AI-search intent helpers (#web explore ai-search).
// Imports directly from login-intent.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Background: keyword/city extraction is LLM-ONLY — a regex tokenizer fallback
// turned "去智联找一些fde相关的职位,要求岗位在上海" into ["去", "一些fde", "要求"].
// The module therefore only ROUTES (detectLoginSource) and parses LLM output
// (parseZhilianQuery / cleanKeyword); the route 404s without a CLI.
//
// Run:  node --test tests/lib/login-intent.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectLoginSource,
  cleanKeyword,
  normalizeZhilianQuery,
  parseZhilianQuery,
} from "../../src/lib/login-intent.mjs";

// ── detectLoginSource: routing only, no tokenizing ──────────────────────────

test("routes a query naming 智联招聘 to zhaopin", () => {
  assert.deepEqual(detectLoginSource("去智联找一些fde相关的职位,要求岗位在上海"), {
    id: "zhaopin",
    label: "智联招聘",
  });
});

test("routes the english source name case-insensitively", () => {
  assert.equal(detectLoginSource("search Zhaopin for java jobs")?.id, "zhaopin");
});

test("returns null when no login source is named", () => {
  assert.equal(detectLoginSource("找一份上海的远程工作"), null);
  assert.equal(detectLoginSource(""), null);
});

// ── cleanKeyword: LLM keyword safety net ────────────────────────────────────

test("strips modifier words the LLM drags along", () => {
  assert.equal(cleanKeyword("客户成功相关岗位"), "客户成功");
  assert.equal(cleanKeyword("Java开发工程师"), "Java开发工程师");
});

test("strips the trailing 的 a modifier strip leaves behind", () => {
  // "FDE相关的职位" → modifier strip leaves "FDE的" → edge strip → "FDE".
  assert.equal(cleanKeyword("FDE相关的职位"), "FDE");
  assert.equal(cleanKeyword("找产品经理的工作"), "产品经理");
});

test("never touches a 的 inside the keyword", () => {
  assert.equal(cleanKeyword("我的前半生"), "我的前半生");
});

test("empty-after-clean and null input both yield null", () => {
  assert.equal(cleanKeyword("相关岗位"), null);
  assert.equal(cleanKeyword(null), null);
  assert.equal(cleanKeyword("  "), null);
});

// ── normalizeZhilianQuery ───────────────────────────────────────────────────

test("requires a keyword", () => {
  assert.equal(normalizeZhilianQuery({ city: "上海" }), null);
  assert.equal(normalizeZhilianQuery(null), null);
  assert.equal(normalizeZhilianQuery("string"), null);
});

test("validates city against the known list — an unknown city is dropped, not trusted", () => {
  const q = normalizeZhilianQuery({ keyword: "FDE", city: "亚特兰蒂斯" });
  assert.equal(q?.keyword, "FDE");
  assert.equal(q?.city, null);
});

test("keeps semantic condition values verbatim (codes are mapped downstream)", () => {
  const q = normalizeZhilianQuery({
    keyword: "客户成功",
    city: "上海",
    salary: "15-25K",
    education: "本科",
  });
  assert.equal(q?.city, "上海");
  assert.equal(q?.salary, "15-25K");
  assert.equal(q?.education, "本科");
});

// ── parseZhilianQuery: noisy CLI output ─────────────────────────────────────

test("parses a compact single-object output", () => {
  const q = parseZhilianQuery('{"keyword":"FDE","city":"上海","salary":null}');
  assert.equal(q?.keyword, "FDE");
  assert.equal(q?.city, "上海");
});

test("the LAST json line wins amid banner/exec-log noise (codex transcript)", () => {
  const noisy = [
    "codex-cli v1.2.3",
    'exec echo {"keyword":" echoed","city":null}',
    "thinking…",
    '{"keyword":"客户成功","city":"上海","salary":"15-25K","education":"本科","experience":null,"jobStatus":null,"companyType":null,"companySize":null}',
  ].join("\n");
  const q = parseZhilianQuery(noisy);
  assert.equal(q?.keyword, "客户成功");
  assert.equal(q?.city, "上海");
});

test("returns null when nothing parseable carries a keyword", () => {
  assert.equal(parseZhilianQuery("no json here at all"), null);
  assert.equal(parseZhilianQuery('{"city":"上海"}'), null);
  assert.equal(parseZhilianQuery("{not json}"), null);
});

test("the reported query shape: keyword survives without 切词 damage", () => {
  // What the LLM should emit for "去智联找一些fde相关的职位,要求岗位在上海".
  const q = parseZhilianQuery('{"keyword":"FDE","city":"上海","salary":null,"education":null,"experience":null,"jobStatus":null,"companyType":null,"companySize":null}');
  assert.equal(q?.keyword, "FDE");
  assert.equal(q?.city, "上海");
});
