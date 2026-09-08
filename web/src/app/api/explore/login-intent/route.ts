import { NextRequest } from "next/server";
import { getChromeCdpUrl } from "@/lib/boss-chrome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BOSS_TAB_URL = "https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE%E5%88%86%E6%9E%90&city=101020100";

type CdpTarget = { id?: string; type?: string; url?: string };

// Open (or focus) the shared BOSS debug browser so the user can log in with
// their own session. getChromeCdpUrl() reuses the running :9222 instance when
// CDP-ready and only spawns Chrome otherwise.
export async function POST(_req: NextRequest) {
  const baseUrl = await getChromeCdpUrl();

  let list: CdpTarget[] = [];
  try {
    const r = await fetch(`${baseUrl}/json`);
    const j: unknown = await r.json();
    if (Array.isArray(j)) list = j as CdpTarget[];
  } catch {
    // CDP not reachable even after launch attempt — report honestly.
    return Response.json({ ok: false, error: "BOSS 浏览器启动后 CDP 仍不可达，请检查 Chrome 是否被拦截" }, { status: 502 });
  }

  const existing = list.find((t) => t.type === "page" && /zhipin\.com/.test(t.url || ""));
  if (existing?.id) {
    try {
      await fetch(`${baseUrl}/json/activate/${existing.id}`, { method: "PUT" });
    } catch {
      // best-effort activate
    }
    return Response.json({ ok: true, cdpBaseUrl: baseUrl, target: existing });
  }

  // No BOSS tab yet — open one. Chrome's /json/new takes the target URL
  // VERBATIM after '?'; percent-encoding it lands on about:blank.
  try {
    const r = await fetch(`${baseUrl}/json/new?${BOSS_TAB_URL}`, { method: "PUT" });
    const target: unknown = await r.json().catch(() => null);
    return Response.json({ ok: true, cdpBaseUrl: baseUrl, target });
  } catch {
    return Response.json({ ok: true, cdpBaseUrl: baseUrl });
  }
}
