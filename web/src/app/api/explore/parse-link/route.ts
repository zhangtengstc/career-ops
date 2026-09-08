import { NextRequest } from "next/server";
import path from "node:path";
import { spawn } from "node:child_process";
import { careerOpsRoot } from "@/lib/career-ops";
import { detectSource, parseZhaopinDetail, parseBossMeta, FETCH_UA } from "@/lib/parse-link.mjs";
import { resolvePythonExecutable } from "@/lib/python-env.mjs";

// Paste-a-link parse (第三入口). One-shot JSON: a single DiscoveredOffer or an
// error. zhaopin is zero-auth (fetch + SSR parse, in-process); boss needs a
// JS-running browser → spawned through browser-sources/boss.py (nodriver).
export const runtime = "nodejs";
export const maxDuration = 180; // boss spawns a headful Chrome (single page)
export const dynamic = "force-dynamic";

// D2: boss parses are serialized — each spawns its own nodriver Chrome against
// the shared boss-profile dir, so concurrent runs would contend for the profile
// lock. A module-level promise chain is the in-process mutex.
let bossQueue: Promise<unknown> = Promise.resolve();

type BossParseResult =
  | { documentTitle?: string; metaDesc?: string; locationEl?: string }
  | { loginRequired: true }
  | { browserNotRunning: true }
  | { error: string };

function spawnBossParse(pythonExe: string, url: string): Promise<BossParseResult | null> {
  return new Promise((resolve) => {
    const py = path.join(careerOpsRoot(), "browser-sources", "boss.py");
    const child = spawn(pythonExe, [py, "--parse-link", url], {
      cwd: careerOpsRoot(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let out = "";
    let errTail = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf-8")));
    // Keep a stderr tail for diagnostics — boss.py is contracted to always
    // print one JSON line on stdout, so an unparseable stdout means a crash
    // whose only evidence lives on stderr. Never silently discard it.
    child.stderr.on("data", (d: Buffer) => (errTail = (errTail + d.toString("utf-8")).slice(-2000)));
    child.on("error", (e) => {
      console.error("[parse-link] boss.py spawn failed:", e.message);
      resolve(null);
    });
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(out.trim());
        if (parsed && typeof parsed === "object" && parsed.loginRequired === true) {
          resolve({ loginRequired: true } as BossParseResult);
          return;
        }
        resolve(parsed as BossParseResult);
      } catch {
        console.error(`[parse-link] boss.py non-JSON stdout (exit ${code}). stderr tail: ${errTail.trim() || "(empty)"}`);
        resolve(null);
      }
    });
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const source = detectSource(url);
  if (!url || !source) {
    return Response.json({ error: "只支持智联招聘或 BOSS直聘 的岗位链接" }, { status: 400 });
  }

  if (source === "zhaopin") {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": FETCH_UA, Accept: "text/html" },
        redirect: "follow",
      });
      if (!res.ok) {
        return Response.json({ error: `智联链接抓取失败（HTTP ${res.status}）` }, { status: 502 });
      }
      const html = await res.text();
      const canonical = res.url || url;
      const offer = parseZhaopinDetail(html, canonical);
      if (!offer) {
        return Response.json({ error: "无法从该链接解析出岗位信息" }, { status: 502 });
      }
      return Response.json({ offer });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "智联解析失败" }, { status: 502 });
    }
  }

  // boss — serialize against the shared profile lock. Resolve the interpreter
  // explicitly (D-006): ambient PATH can point at a venv without nodriver,
  // which used to surface as the generic parse error instead of the real state.
  const pythonExe = resolvePythonExecutable({ requireModule: "nodriver" });
  if (!pythonExe) {
    return Response.json(
      { error: "未找到带 nodriver 的 Python 环境——请设置 CAREER_OPS_PYTHON 指向 boss.py 所用解释器" },
      { status: 502 },
    );
  }
  const run = bossQueue.then(() => spawnBossParse(pythonExe, url));
  bossQueue = run.then(
    () => undefined,
    () => undefined,
  );
  const data = await run;
  if (!data) {
    return Response.json(
      { error: "无法从该链接解析出岗位信息（BOSS 详情页需浏览器渲染，可能被风控拦截或需登录）" },
      { status: 502 },
    );
  }
  if ("browserNotRunning" in data && data.browserNotRunning) {
    return Response.json({ browserNotRunning: true, source: "boss" });
  }
  if ("loginRequired" in data && data.loginRequired) {
    return Response.json({ loginRequired: true, source: "boss" });
  }
  // Structured sidecar failure (e.g. tab died mid-navigation) — surface the
  // real reason instead of guessing "页面结构可能已变更".
  if ("error" in data && typeof data.error === "string" && data.error) {
    return Response.json(
      { error: `BOSS 浏览器解析失败：${data.error.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const { documentTitle = "", metaDesc = "", locationEl = "" } = data as {
    documentTitle?: string;
    metaDesc?: string;
    locationEl?: string;
  };
  const { title, company, location } = parseBossMeta(documentTitle, metaDesc, locationEl);
  if (!title || !company) {
    return Response.json({ error: "无法从该链接解析出岗位信息（BOSS 页面结构可能已变更）" }, { status: 502 });
  }
  return Response.json({
    offer: {
      url,
      company,
      title,
      location,
      postedAt: "",
      ats: "boss",
      source: "boss",
    },
  });
}
