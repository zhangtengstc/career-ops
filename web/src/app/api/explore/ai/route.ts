import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, rootScript } from "@/lib/career-ops";
import { writeTempPortals, cleanupTempPortals } from "@/lib/core/portals";
import { assembleDedupContext } from "@/lib/core/discover";

// AI search orchestrates modes/web-hunt.md by running the USER'S configured CLI
// headless (CLI-agnostic, like the assistant). Web hunting is slow → generous
// budget. The agent is a PROPOSER: Write/Edit/Bash are disabled so it structurally
// cannot persist; the only writes happen when the user later ADDs a candidate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type CodexCapabilityCacheEntry = {
  mtimeMs: number;
  size: number;
  probe: Promise<boolean>;
};

const codexCapabilityCache = new Map<string, CodexCapabilityCacheEntry>();

function readCodexHelp(binPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (output: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(output);
    };

    const appendBounded = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-64_000);

    const child = spawnHeadlessCli(binPath, args, {
      env: { ...process.env, NO_COLOR: "1" },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", () => finish(""));
    child.on("close", () => finish(`${stdout}
${stderr}`));

    timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort capability-probe cleanup */
      }
      finish("");
    }, 5_000);
  });
}

function supportsSafeCodexExec(binPath: string): Promise<boolean> {
  let mtimeMs: number;
  let size: number;

  try {
    ({ mtimeMs, size } = fs.statSync(binPath));
  } catch {
    return Promise.resolve(false);
  }

  const cached = codexCapabilityCache.get(binPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.probe;
  }

  let entry: CodexCapabilityCacheEntry;
  const probe = Promise.all([
    readCodexHelp(binPath, ["--help"]),
    readCodexHelp(binPath, ["exec", "--help"]),
  ])
    // Deliberately fail closed: help/flag drift means "unsupported", never a
    // weaker Codex invocation that could bypass the required safety contract.
    .then(([globalHelp, execHelp]) =>
      globalHelp.includes("--ask-for-approval") &&
      globalHelp.includes("--search") &&
      execHelp.includes("--sandbox") &&
      execHelp.includes("read-only") &&
      execHelp.includes("--strict-config") &&
      execHelp.includes("--ignore-user-config") &&
      execHelp.includes("--ephemeral") &&
      execHelp.includes("--skip-git-repo-check") &&
      execHelp.includes("--output-last-message"),
    )
    .catch(() => false)
    .then((supported) => {
      // Only successes stay cached. A transient/negative probe retries next time,
      // but must not delete a newer entry installed after the binary changed.
      if (!supported && codexCapabilityCache.get(binPath) === entry) {
        codexCapabilityCache.delete(binPath);
      }
      return supported;
    });

  // Concurrent cold requests share the same in-flight probe. mtime+size makes a
  // Codex upgrade at the same path invalidate a previously successful result.
  entry = { mtimeMs, size, probe };
  codexCapabilityCache.set(binPath, entry);
  return probe;
}

const OUTPUT_CONTRACT = `

--- OUTPUT CONTRACT (the career-ops WEB is parsing your stream) ---
Follow modes/web-hunt.md exactly. You are running headless for the web:
- You are a PROPOSER — never write a file (Write/Edit/Bash are disabled).
- Emit each candidate as ONE line, never inside a code fence:
  <<offer:{"url":"…","title":"…","company":"…","location":"…","source":"ai-search","why":"…","postedHint":"…","ats":"…","verification":"unconfirmed"}>>
  Valid JSON, one per line, the moment you're confident — stream them as you go.
- Between envelopes, narrate briefly (plain text) what you're searching — shown live as your reasoning.
- Be frugal (~3–6 searches, stop at a strong set). EVERY candidate is UNVERIFIED.
- Be a GENEROUS FINDER, not a judge: when a constraint (location, seniority, stage) can't be confirmed from the shallow signal, INCLUDE + flag the uncertainty in "why" — don't discard. NEVER score or judge fit; the A–F evaluation does that later, with the full JD.
- DEDUP: skip anything already known below; don't re-propose the user's existing companies.
`;

/** A login-gated source (智联招聘, …) the user named explicitly in their query. */
type LoginSourceIntent = {
  id: string;
  label: string;
  keywords: string[];
  city: string | null;
  /** Semantic search conditions (salary/education/…) the source maps to its own
   *  URL codes. Empty when only heuristic parsing ran; populated by the LLM
   *  intent-recognition pass. */
  searchParams: Record<string, string>;
};

// Login-gated sources the AI-search entry can route to directly (reusing the
// BrowserSource scanners) instead of asking the agent to hunt the open web.
// BOSS直聘 / 猎聘 are intentionally NOT here yet — only zhaopin has a source.
const LOGIN_SOURCE_PATTERNS: { id: string; label: string; re: RegExp }[] = [
  { id: "zhaopin", label: "智联招聘", re: /智联|zhaopin/i },
];

// City names (CN + EN) the search can narrow to. Matched FIRST so a place name is
// extracted as a LOCATION condition, never mistaken for a job keyword. Keep in
// sync with browser-sources/zhaopin.mjs CITY_CODES.
const CITY_NAMES = [
  "北京", "上海", "天津", "深圳", "广州", "杭州", "苏州", "南京", "武汉", "长沙", "重庆",
  "Beijing", "Shanghai", "Tianjin", "Shenzhen", "Guangzhou", "Hangzhou", "Suzhou", "Nanjing", "Wuhan", "Changsha", "Chongqing",
];

// Strip request verbs / modifiers / fillers so the surviving tokens are the
// actual job keywords. Longest alternation FIRST ("寻找" before "找", "工作地点"
// before "地点") so a word is never half-replaced. Single-char CONNECTIVES (在/上/
// 里/的/和…) are NOT here — they're dropped per-token in SINGLE_JUNK_RE so they
// can't damage a keyword that merely contains them ("用户" is never touched).
const NOISE_RE = /帮我|请|麻烦|一下|看看|看一下|寻找|搜索|查找|查询|有没有|有哪些|工作地点|相关的|相关|职位|岗位|工作|机会|招聘|方向|方面|城市|地点|搜|找|查|寻/g;
const SINGLE_JUNK_RE = /^(的|了|呢|吗|啊|呀|用|在|上|里|和|与|或|都|也|还|就|把|被|给|为|从|对|请|要|想|及)$/;

function detectLoginSourceIntent(query: string): LoginSourceIntent | null {
  for (const { id, label, re } of LOGIN_SOURCE_PATTERNS) {
    if (!re.test(query)) continue;

    // 1. Extract a location (city) FIRST, so "上海" becomes a condition, not a keyword.
    let city: string | null = null;
    let rest = query;
    for (const name of CITY_NAMES) {
      if (rest.includes(name)) {
        city = name;
        rest = rest.split(name).join(" ");
        break;
      }
    }

    // 2. Extract the job keywords from what remains.
    const keywords = rest
      .replace(re, " ")
      .replace(NOISE_RE, " ")
      .split(/[\s,，、/;；]+/)
      .map((k) => k.trim())
      .filter((k) => k && !SINGLE_JUNK_RE.test(k));

    if (!keywords.length) return null;
    return { id, label, keywords, city, searchParams: {} };
  }
  return null;
}

// ── LLM intent recognition (natural language → structured search conditions) ──
// The heuristic parse above only finds a source + keyword + city. For the FULL
// condition surface (salary / education / experience / job status / company type /
// company size) the user's own CLI is asked to map the query to a fixed JSON
// schema — the "关键条件参数" the source then narrows on. See skill
// references/zhaopin-search-query.md for the code table this feeds.

/** Structured search conditions the LLM emits (semantic values, NOT codes). */
type ZhilianQuery = {
  keyword: string | null;
  city: string | null;
  salary: string | null;
  education: string | null;
  experience: string | null;
  jobStatus: string | null;
  companyType: string | null;
  companySize: string | null;
};

const INTENT_TIMEOUT_MS = 120_000;

function intentPrompt(query: string): string {
  return `你是搜索条件解析器。把下面的自然语言搜索需求转换成智联招聘的搜索条件，只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。

JSON 字段（没有提到的字段填 null）：
- keyword: 职位/岗位核心关键词（string，只填职位名称本身，去掉"相关/岗位/工作/招聘/方向"等修饰词；如"客户成功"而非"客户成功相关岗位"、"Java开发工程师"而非"Java相关"）
- city: 城市中文名（只能填：北京、上海、天津、深圳、广州、杭州、苏州、南京、武汉、长沙、重庆 之一，否则 null）
- salary: 薪资档位（只能填：4K以下、4-6K、6-8K、8-10K、10-15K、15-25K、25-35K、35-50K、50K以上 之一，否则 null）
- education: 学历（只能填：初中及以下、高中、中专、大专、本科、硕士、MBA、博士 之一，否则 null）
- experience: 经验（只能填：应届、1年以下、1-3年、3-5年、5-10年、10年以上 之一，否则 null）
- jobStatus: 工作性质（只能填：全职、兼职、实习、校园 之一，否则 null）
- companyType: 公司性质（只能填：国企、外企、合资、民营、上市公司、股份制、事业单位 之一，否则 null）
- companySize: 公司规模（只能填：20人以下、20-99人、100-299人、300-499人、500-999人、1000-9999人、10000人以上 之一，否则 null）

搜索需求：「${query}」`;
}

// Strip the modifier/filler words an LLM tends to drag along with a keyword
// ("客户成功相关", "客户成功岗位", "找客户成功的工作") → the bare role name, so both
// zhaopin `kw` and the title filter get a clean term. Mirrors the heuristic
// NOISE_RE above; keep the two lists in sync.
const KEYWORD_MODIFIER_RE = /相关|职位|岗位|工作|机会|招聘|方向|方面|行业/g;

function cleanKeyword(k: string | null): string | null {
  if (!k) return null;
  const cleaned = k.replace(KEYWORD_MODIFIER_RE, "").trim();
  return cleaned || null;
}

function normalizeZhilianQuery(obj: unknown): ZhilianQuery | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const q: ZhilianQuery = {
    keyword: cleanKeyword(str("keyword")),
    city: str("city"),
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

/** Pull the JSON object out of the CLI's (possibly noisy) final output. */
function parseZhilianQuery(text: string): ZhilianQuery | null {
  const candidates: string[] = [];
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

/** Ask the user's CLI to convert the query into structured conditions. */
function runIntentRecognition(
  cliId: string,
  binPath: string,
  argsFor: (p: string) => string[],
  query: string,
): Promise<ZhilianQuery | null> {
  const prompt = intentPrompt(query);
  const isCodex = cliId === "codex";

  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let tmpDir: string | undefined;
    let resultFile: string | undefined;

    const finish = (q: ZhilianQuery | null) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }
      resolve(q);
    };

    // codex: run in an EMPTY temp cwd (so it never loads this repo's skill tree
    // and starts exploring) and read its final message from --output-last-message
    // — its stdout is a noisy transcript (banner, exec logs, echoed file reads).
    let cwd: string | undefined;
    let args: string[];
    if (isCodex) {
      try {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-intent-"));
      } catch {
        resolve(null);
        return;
      }
      cwd = tmpDir;
      resultFile = path.join(tmpDir, "intent.txt");
      args = ["--ask-for-approval", "never", "exec", "--skip-git-repo-check", "--output-last-message", resultFile, prompt];
    } else {
      args = argsFor(prompt);
    }

    const child = spawnHeadlessCli(binPath, args, { cwd, env: { ...process.env, NO_COLOR: "1" } });
    child.stdout.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-64_000);
    });
    child.stderr.on("data", () => {
      /* ignore */
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      if (isCodex && resultFile) {
        let text = "";
        try {
          // The path is an OS-temp final-message file created for this one CLI
          // run, not a project asset. Prevent Turbopack from tracing the whole
          // checkout (which may contain gitignored user data such as cv.md).
          text = fs.readFileSync(/* turbopackIgnore: true */ resultFile, "utf8");
        } catch {
          /* no final-message file */
        }
        finish(parseZhilianQuery(text));
      } else {
        finish(parseZhilianQuery(out));
      }
    });
    killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish(null);
    }, INTENT_TIMEOUT_MS);
  });
}

const COND_LABELS: Record<string, string> = {
  salary: "薪资",
  education: "学历",
  experience: "经验",
  jobStatus: "工作性质",
  companyType: "公司性质",
  companySize: "公司规模",
};

/** Human-readable summary of the resolved conditions for the live narration. */
function conditionsLabel(city: string | null, searchParams: Record<string, string>): string {
  const parts = [
    city ? `城市:${city}` : null,
    ...Object.entries(searchParams).map(([k, v]) => `${COND_LABELS[k] ?? k}:${v}`),
  ].filter((p): p is string => Boolean(p));
  return parts.length ? `（${parts.join("，")}）` : "";
}

/**
 * Stream a login-gated source's results as `<<offer:…>>` envelopes — the SAME
 * grammar the AI-search agent emits — so the client's makeAiStreamParser parses
 * them unchanged. Spawns the BrowserSource scanner (`--jsonl`), no agent CLI.
 */
function streamLoginSourceSearch(intent: LoginSourceIntent): Response {
  const { id, label, keywords, city, searchParams } = intent;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* stream closed */
        }
      };
      const loginState = path.join(careerOpsRoot(), "config", "browser-state", `${id}.json`);
      if (!fs.existsSync(loginState)) {
        send(`[未找到${label}登录态 — 请先在项目目录运行 \`node scan-browser-source.mjs ${id} --login\` 登录后再试]\n`);
        controller.close();
        return;
      }
      send(`正在${label}搜索「${keywords.join("、")}」${conditionsLabel(city, searchParams)}…\n`);
      // The extracted keyword is BOTH the search term (zhaopin `kw`) AND the
      // title filter. zhaopin's `kw` is FUZZY — "客户成功" also returns 200+
      // "客户经理"/"大客户销售" that merely share "客户" — so title_filter.positive
      // keeps the list to postings whose TITLE actually contains the keyword.
      // The keyword reaches here NORMALIZED (modifier-free: "客户成功相关" →
      // "客户成功"), so the title filter narrows instead of over-dropping. City
      // narrows via `allow` → zhaopin's `jl`; semantic conditions ride in
      // `searchParams`.
      const tempPortals = writeTempPortals({
        positive: keywords,
        negative: [],
        allow: city ? [city] : [],
        block: [],
        alwaysAllow: [],
        blockHard: [],
        searchParams,
      });
      const args = [rootScript("scan-browser-source"), id, "--dry-run", "--jsonl", "--keywords", keywords.join(",")];
      const child = spawn(process.execPath, args, {
        cwd: careerOpsRoot(),
        env: { ...process.env, CAREER_OPS_PORTALS: tempPortals },
      });
      let buf = "";
      let offers = 0;
      let finished = false;
      const finish = (message: string) => {
        if (finished) return;
        finished = true;
        cleanupTempPortals(tempPortals);
        send(message);
        try {
          controller.close();
        } catch {
          /* client already closed the stream */
        }
      };
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let j: { done?: boolean; keyword?: string; offers?: { url?: string; title?: string; company?: string; location?: string; postedAt?: string }[] };
          try {
            j = JSON.parse(t);
          } catch {
            continue;
          }
          if (j.done === true) continue;
          for (const o of Array.isArray(j.offers) ? j.offers : []) {
            offers++;
            send(`<<offer:${JSON.stringify({
              url: o.url,
              title: o.title,
              company: o.company,
              location: o.location,
              source: "ai-search",
              ats: id,
              verification: "unconfirmed",
              why: `来自${label}登录态扫描`,
              postedHint: o.postedAt || "",
            })}>>\n`);
          }
          const n = Array.isArray(j.offers) ? j.offers.length : 0;
          send(`[${label}「${j.keyword ?? ""}」已扫，本词新增 ${n} 条]\n`);
        }
      });
      child.on("error", (e) => {
        finish(`[${label}搜索启动失败: ${e instanceof Error ? e.message : String(e)}]\n`);
      });
      child.on("close", (code) => {
        if (code !== 0) finish(`[${label}扫描出错 (exit ${code ?? "unknown"})]\n`);
        else if (offers) finish(`_(共找到 ${offers} 条候选，来自${label})_\n`);
        else finish(`_(${label}未找到匹配的职位)_\n`);
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  let body: { query?: string; cliId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  const cliId = body.cliId;
  if (!query) return Response.json({ error: "query required" }, { status: 400 });

  // Login-gated source intent (智联招聘…) routes straight to the BrowserSource
  // scanner. When a CLI is configured, ask it to parse the query into structured
  // conditions (keyword + city + salary/education/…) FIRST — the "关键条件参数"
  // requirement — and fall back to the heuristic parse when the CLI is absent or
  // returns nothing usable. The SAME <<offer>> stream grammar either way.
  const loginIntent = detectLoginSourceIntent(query);
  if (loginIntent) {
    const resolved = cliId ? resolveCli(cliId) : null;
    if (resolved) {
      const { spec, binPath } = resolved;
      const llm = await runIntentRecognition(cliId!, binPath, spec.args, query);
      if (llm && llm.keyword) {
        loginIntent.keywords = [llm.keyword];
        // LLM null city falls back to the heuristic city (double coverage).
        loginIntent.city = llm.city ?? loginIntent.city;
        loginIntent.searchParams = {
          ...(llm.salary ? { salary: llm.salary } : {}),
          ...(llm.education ? { education: llm.education } : {}),
          ...(llm.experience ? { experience: llm.experience } : {}),
          ...(llm.jobStatus ? { jobStatus: llm.jobStatus } : {}),
          ...(llm.companyType ? { companyType: llm.companyType } : {}),
          ...(llm.companySize ? { companySize: llm.companySize } : {}),
        };
      }
    }
    return streamLoginSourceSearch(loginIntent);
  }

  // No cliId → let resolveCli 404 so the client shows the "needs a CLI" panel
  // (a login-source intent above already routed — heuristic parse needs no CLI).
  const resolved = cliId ? resolveCli(cliId) : null;
  if (!resolved) return Response.json({ error: `CLI '${cliId || ""}' not found on this machine` }, { status: 404 });
  const { spec, binPath } = resolved;

  // Read the CANONICAL mode at request time — single source of truth, never a
  // homegrown prompt. Missing (older core) → graceful 400 so the Scan tab stays usable.
  let mode: string;
  try {
    mode = fs.readFileSync(path.join(careerOpsRoot(), "modes", "web-hunt.md"), "utf8");
  } catch {
    return Response.json({ code: "MODE_MISSING", error: "AI search needs a newer career-ops — update to enable it." }, { status: 400 });
  }

  const { lines } = assembleDedupContext();
  const memory = readMemory();
  const memoryLine = memory.trim() ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory):\n${memory.trim()}` : "";
  const knownBlock = lines.length ? `\n\n--- ALREADY KNOWN (dedup — do NOT propose these) ---\n${lines.join("\n")}` : "";
  const prompt = `${mode}${OUTPUT_CONTRACT}${memoryLine}${knownBlock}\n\n--- USER INTENT ---\n${query}\n`;

  const isClaude = cliId === "claude";
  const isCodex = cliId === "codex";

  if (isCodex && !(await supportsSafeCodexExec(binPath))) {
    return Response.json(
      {
        code: "CODEX_UNSUPPORTED",
        error:
          "Codex CLI does not support the required read-only execution flags. Update Codex and try again.",
      },
      { status: 400 },
    );
  }

  // The complete mode, memory and dedup context are embedded in `prompt`.
  // Codex runs in an empty temporary cwd and writes only its final assistant
  // response to a dedicated file. Its normal console transcript includes the
  // full prompt and must never be forwarded to the Web UI.
  let childCwd: string;

  if (isCodex) {
    try {
      childCwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "career-ops-codex-"),
      );
    } catch {
      return Response.json(
        {
          code: "CODEX_TEMP_DIR_FAILED",
          error: "AI search could not create an isolated Codex workspace.",
        },
        { status: 400 },
      );
    }
  } else {
    childCwd = careerOpsRoot();
  }

  const codexResultFile = isCodex
    ? path.join(childCwd, "final-response.txt")
    : undefined;

  const args = isClaude
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,WebFetch,WebSearch,Glob,Grep", // WebSearch ADDED vs the read-only assistant
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit,Task", // proposer-not-writer, by construction
      ]
    : isCodex
      ? [
          "--ask-for-approval",
          "never",
          "--search",
          "exec",
          "--strict-config",
          "--ignore-user-config",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--skip-git-repo-check",
          "--output-last-message",
          codexResultFile!,
          prompt,
        ]
      : spec.args(prompt);

  // POSIX detached children become process-group leaders. Keeping stdio
  // piped means Node still tracks the Codex process normally.
  const useCodexProcessGroup =
    isCodex && process.platform !== "win32";

  const child = spawnHeadlessCli(binPath, args, {
    cwd: childCwd,
    env: process.env,
    detached: useCodexProcessGroup,
  });

  const cleanupChildCwd = () => {
    if (!isCodex) return;
    try {
      fs.rmSync(childCwd, { recursive: true, force: true });
    } catch {
      /* best-effort temporary-directory cleanup */
    }
  };

  const encoder = new TextEncoder();
  // `closed` + kill timer in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;

  const isCodexProcessGroupAlive = () => {
    if (!useCodexProcessGroup || !child.pid) return false;

    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const clearTerminationTimers = () => {
    if (killer) {
      clearTimeout(killer);
      killer = undefined;
    }

    // If the group leader exited but a descendant ignored SIGTERM, retain the
    // SIGKILL fallback until the remaining process group is gone.
    if (forceKill && !isCodexProcessGroupAlive()) {
      clearTimeout(forceKill);
      forceKill = undefined;
    }
  };

  const signalChild = (signal: NodeJS.Signals): boolean => {
    if (useCodexProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        /* group may already be gone; fall back to the direct child */
      }
    }

    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const terminateChild = () => {
    const termSent = signalChild("SIGTERM");

    if (!isCodex || !termSent || forceKill) return;

    forceKill = setTimeout(() => {
      signalChild("SIGKILL");
      forceKill = undefined;
    }, 5_000);

    forceKill.unref?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      let codexStderr = "";
      killer = setTimeout(() => {
        terminateChild();
      }, 480_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          clearTerminationTimers();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true; // controller already closed underneath us — stop, never crash
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;

        // Codex's authoritative response is read from codexResultFile after
        // process completion. Drain but do not forward its console transcript.
        if (isCodex) return;

        if (!isClaude) {
          emit(d.toString());
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
            /* partial / non-json line — skip */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();

        if (isCodex) {
          // Normal Codex stderr contains session metadata and the complete
          // prompt. Retain only a bounded private diagnostic signal and never
          // stream it during a successful request.
          codexStderr = (codexStderr + s).slice(-16_000);
          return;
        }

        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e) => {
        safeEnqueue(`
[error launching ${spec.name}: ${e.message}]`);
        cleanupChildCwd();
        safeClose();
      });

      child.on("close", (code) => {
        clearTerminationTimers();

        if (closed) {
          cleanupChildCwd();
          return;
        }

        if (isCodex) {
          let finalText = "";

          try {
            if (codexResultFile && fs.existsSync(codexResultFile)) {
              finalText = fs.readFileSync(codexResultFile, "utf8").trim();
            }
          } catch {
            /* handled below as missing final output */
          }

          if (finalText) {
            emit(finalText);
          } else if (code !== 0) {
            const diagnosticText = codexStderr.trim();
            const diagnosticsCaptured = diagnosticText.length > 0;

            if (diagnosticsCaptured) {
              const lowerDiagnostics = diagnosticText.toLowerCase();
              const diagnosticMarkers = [
                "error",
                "fatal",
                "failed",
                "denied",
                "not found",
                "invalid",
                "unsupported",
              ].filter((marker) => lowerDiagnostics.includes(marker));

              // Codex stderr may contain the complete user prompt. Log only
              // bounded metadata and marker categories, never its contents.
              console.error("[Codex AI search exited without a final response]", {
                exitCode: code ?? "unknown",
                stderrBytes: Buffer.byteLength(diagnosticText, "utf8"),
                stderrLines: diagnosticText.split(/\r?\n/).length,
                diagnosticMarkers,
              });
            }

            safeEnqueue(
              `
[Codex exited with code ${code ?? "unknown"}${
                diagnosticsCaptured ? "; diagnostic output captured" : ""
              }]
`,
            );
          } else if (!emitted) {
            safeEnqueue("_(no final output from Codex)_");
          }

          cleanupChildCwd();
          safeClose();
          return;
        }

        if (!emitted) safeEnqueue("_(no output — is the CLI authenticated?)_");
        safeClose();
      });
    },
    cancel() {
      closed = true;

      if (killer) {
        clearTimeout(killer);
        killer = undefined;
      }

      terminateChild();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
