// Tests for the Explore "paste a link" parse helpers (web/src/lib/parse-link.mjs).
// Pure logic only — no network. The zhaopin SSR parse is exercised against an
// inline __INITIAL_STATE__ fixture; detectSource against the domain whitelist.
// Run:  node --test tests/lib/parse-link.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource, parseZhaopinDetail, parseBossMeta } from "../../src/lib/parse-link.mjs";

// ── detectSource: domain whitelist ─────────────────────────────────────────

test("routes zhaopin domains (www + subdomains)", () => {
  assert.equal(detectSource("https://www.zhaopin.com/jobdetail/CC526889630J40887050909.htm"), "zhaopin");
  assert.equal(detectSource("https://jobs.zhaopin.com/CC526889630J40887050909.htm"), "zhaopin");
});

test("routes zhipin domains", () => {
  assert.equal(detectSource("https://www.zhipin.com/job_detail/abc.html"), "boss");
});

test("rejects other domains, non-http, and malformed input", () => {
  assert.equal(detectSource("https://evil.com/job_detail/abc.html"), null);
  assert.equal(detectSource("ftp://www.zhaopin.com/x"), null);
  assert.equal(detectSource("not a url"), null);
  assert.equal(detectSource(""), null);
});

// ── parseZhaopinDetail: __INITIAL_STATE__.jobDetail.detailedPosition ────────

const FIXTURE = (extra = "") => `
<script>__INITIAL_STATE__={"jobNumber":"CC1J1","jobDetail":{"taskId":1,"detailedCompany":{"companyName":"拼多多集团-PDD"},
"detailedPosition":{"name":"数据分析师","positionName":"数据分析师","companyName":"拼多多集团-PDD",
"workCity":"上海","cityDistrict":"徐汇区","salary":"20000-30000元","publishTime":"2026-08-31 10:43:19",
"workingExp":"3-5年","education":"本科","positionUrl":"http://jobs.zhaopin.com/CC1J1.htm",
"cardCustomJson":"{\\"address\\":\\"上海 徐汇区\\",\\"braceInString\\":\\"}\\"}"}}${extra}};</script>
`;

test("parses title/company/location/postedAt from detailedPosition", () => {
  const offer = parseZhaopinDetail(FIXTURE(), "https://www.zhaopin.com/jobdetail/CC1J1.htm");
  assert.ok(offer);
  assert.equal(offer.title, "数据分析师");
  assert.equal(offer.company, "拼多多集团-PDD");
  assert.equal(offer.location, "上海 徐汇区");
  assert.equal(offer.postedAt, "2026-08-31");
  assert.equal(offer.ats, "zhaopin");
  assert.equal(offer.url, "https://www.zhaopin.com/jobdetail/CC1J1.htm");
});

test("skips braces inside string values (cardCustomJson) — balance stays intact", () => {
  // The fixture already embeds a `}` inside cardCustomJson; a naive depth
  // counter would terminate early and JSON.parse would fail. It must parse.
  const offer = parseZhaopinDetail(FIXTURE(), "https://www.zhaopin.com/jobdetail/CC1J1.htm");
  assert.ok(offer, "string-embedded brace broke the balance scan");
});

test("returns null on missing/empty __INITIAL_STATE__ or jobDetail", () => {
  assert.equal(parseZhaopinDetail("<html>no state</html>", "https://www.zhaopin.com/x"), null);
  assert.equal(parseZhaopinDetail('__INITIAL_STATE__={"jobDetail":{"taskId":1}}', "https://www.zhaopin.com/x"), null); // no detailedPosition
});

test("returns null when title or company is empty", () => {
  const noTitle = FIXTURE().replace('"name":"数据分析师","positionName":"数据分析师","companyName":"拼多多集团-PDD"', '"name":"","positionName":"","companyName":""');
  assert.equal(parseZhaopinDetail(noTitle, "https://www.zhaopin.com/x"), null);
});

// ── parseBossMeta: D-001 (招聘方 vs 代招方) ─────────────────────────────────

test("D-001: company = 招聘方 (display employer), not the 代招/RPO company", () => {
  // 代招 job: the DOM has many `.company-name` (代招方 上海从鲸信息技术, 营业执照
  // 上海寻梦…), but document.title carries the DISPLAY employer 拼多多集团-PDD.
  const r = parseBossMeta(
    "「数据分析师-正式批招聘」_拼多多集团-PDD招聘-BOSS直聘",
    "拼多多集团-PDD数据分析师-正式批招聘，薪资：，地点：上海，要求：在校/应届，学历：本科，研发工程师刚刚在线。",
    "上海",
  );
  assert.equal(r.company, "拼多多集团-PDD");
  assert.equal(r.title, "数据分析师-正式批");
  assert.equal(r.location, "上海");
});

test("parseBossMeta: 直招 job parses cleanly", () => {
  const r = parseBossMeta(
    "「产品经理招聘」_某科技有限公司招聘-BOSS直聘",
    "某科技有限公司产品经理招聘，薪资：，地点：北京，要求：3-5年，学历：本科。",
  );
  assert.equal(r.title, "产品经理");
  assert.equal(r.company, "某科技有限公司");
  assert.equal(r.location, "北京");
});

test("parseBossMeta: falls back to locationEl when meta lacks 地点", () => {
  const r = parseBossMeta("「产品经理招聘」_某科技招聘-BOSS直聘", "某科技产品经理招聘，薪资：。", "北京");
  assert.equal(r.location, "北京");
});

test("parseBossMeta: job title containing 招聘 still parses", () => {
  const r = parseBossMeta("「招聘专员招聘」_某科技招聘-BOSS直聘", "某科技招聘专员招聘，薪资：，地点：上海。");
  assert.equal(r.title, "招聘专员");
  assert.equal(r.company, "某科技");
});
