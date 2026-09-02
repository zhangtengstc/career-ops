// Login-source AI-search intent parsing — pure helpers, no Node/TS imports, so
// the Next.js route (web/src/app/api/explore/ai/route.ts) and the node --test
// suite (web/tests/lib/login-intent.test.mjs) share ONE implementation. Modeled
// on stream-parse.mjs: parsing bugs here silently turn a natural-language query
// into garbage zhaopin keywords, so every rule is pinned by a test.
//
// Design note: keyword/city/condition extraction is LLM-ONLY by decision — a
// regex "切词" fallback was tried and produced garbage ("去智联找一些fde相关的
// 职位,要求岗位在上海" → ["去", "一些fde", "要求"]) because Chinese request
// phrasing is an unbounded junk-word list. The route therefore REQUIRES a
// configured CLI for login-source search (404 → the needs-a-CLI panel, same as
// the open-web path) and fails loudly when the LLM pass yields nothing.

/**
 * Login-gated sources the AI-search entry can route to directly (reusing the
 * BrowserSource scanners) instead of asking the agent to hunt the open web.
 * BOSS直聘 / 猎聘 are intentionally NOT here yet — only zhaopin has a source.
 * This is pure ROUTING (does the query name the source?) — the keywords and
 * conditions come from the LLM, never from tokenizing the query.
 */
export const LOGIN_SOURCE_PATTERNS = [
  { id: "zhaopin", label: "智联招聘", re: /智联|zhaopin/i },
];

/**
 * Does the query name a login-gated source? Returns { id, label } or null.
 * @param {string} query
 * @returns {{ id: string, label: string } | null}
 */
export function detectLoginSource(query) {
  for (const { id, label, re } of LOGIN_SOURCE_PATTERNS) {
    if (re.test(query)) return { id, label };
  }
  return null;
}

// City names (CN + EN) the search can narrow to. The LLM is TOLD to pick from
// this list (see intentPrompt in the route); this export validates its answer —
// an LLM city outside the list is dropped to null, never trusted blindly.
// Keep in sync with browser-sources/zhaopin.mjs CITY_CODES.
export const CITY_NAMES = [
  "北京", "上海", "天津", "深圳", "广州", "杭州", "苏州", "南京", "武汉", "长沙", "重庆",
  "Beijing", "Shanghai", "Tianjin", "Shenzhen", "Guangzhou", "Hangzhou", "Suzhou", "Nanjing", "Wuhan", "Changsha", "Chongqing",
];

// Strip the modifier/filler words an LLM tends to drag along with a keyword
// ("客户成功相关", "客户成功岗位") → the bare role name, so both zhaopin `kw`
// and the title filter get a clean term. The LLM is already instructed to emit
// the bare name; this is the safety net for when it doesn't.
const KEYWORD_MODIFIER_RE = /相关|职位|岗位|工作|机会|招聘|方向|方面|行业/g;

// Leading/trailing connectives a modifier strip leaves behind ("FDE相关的职位"
// → "FDE的" without this). The LEADING class also drops request verbs ("找产品
// 经理的工作" → "找产品经理" → "产品经理"). Char-class, boundary-only — never
// touches the middle of a keyword ("目的" keeps its 的).
const KEYWORD_EDGE_RE = /^[的了和与或及找去请帮想\s]+|[的了和与或及\s]+$/g;

/**
 * Normalize an LLM-emitted keyword to the bare role name.
 * @param {string|null} k
 * @returns {string|null}
 */
export function cleanKeyword(k) {
  if (!k) return null;
  const cleaned = k.replace(KEYWORD_MODIFIER_RE, "").replace(KEYWORD_EDGE_RE, "").trim();
  return cleaned || null;
}

/**
 * @typedef {Object} ZhilianQuery
 * @property {string|null} keyword
 * @property {string|null} city
 * @property {string|null} salary
 * @property {string|null} education
 * @property {string|null} experience
 * @property {string|null} jobStatus
 * @property {string|null} companyType
 * @property {string|null} companySize
 */

/**
 * Coerce a parsed JSON object into a ZhilianQuery, or null when it carries no
 * usable keyword.
 * @param {unknown} obj
 * @returns {ZhilianQuery|null}
 */
export function normalizeZhilianQuery(obj) {
  if (!obj || typeof obj !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const str = (k) => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const city = str("city");
  const q = {
    keyword: cleanKeyword(str("keyword")),
    city: city && CITY_NAMES.includes(city) ? city : null,
    salary: str("salary"),
    education: str("education"),
    experience: str("experience"),
    jobStatus: str("jobStatus"),
    companyType: str("companyType"),
    companySize: str("companySize"),
  };
  if (!q.keyword) return null;
  return q;
}

/**
 * Pull the JSON object out of the CLI's (possibly noisy) final output.
 * @param {string} text
 * @returns {ZhilianQuery|null}
 */
export function parseZhilianQuery(text) {
  const candidates = [];
  // Whole-text { … } — compact single-object output (claude -p, gemini, …).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  // Per-line { … } — the final message usually sits on its own line amid a
  // banner / exec logs / echoed file contents (codex does all three).
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) candidates.push(t);
  }
  // Last candidate wins (the final message is authoritative).
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const q = normalizeZhilianQuery(JSON.parse(candidates[i]));
      if (q) return q;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
