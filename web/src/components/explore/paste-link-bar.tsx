"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, AlertCircle, Check, Lock } from "lucide-react";
import { CostBadge } from "@/components/cost/cost-badge";
import { detectSource } from "@/lib/parse-link.mjs";
import { useExplore } from "./explore-provider";

// Slim paste bar for the "copy a link" third entry (explore/paste-link-parse).
// Lives at the top of the Scan view, always visible (empty + results). A pasted
// URL that matches a known board auto-parses; anything else stays in the field
// for the user to confirm (the server's whitelist rejects unknown domains with
// a clear Chinese error, surfaced inline here — single source of truth).
export function PasteLinkBar() {
  const { parseLink, parsing, linkError, bossLoginRequired, bossLoginBusy, bossBrowserNotRunning, bossAwaitingLogin, loginBossForParse, launchBossBrowser, retryBossParse } = useExplore();
  const [value, setValue] = useState("");
  const [feedback, setFeedback] = useState<"added" | "duplicate" | "">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = async (raw: string) => {
    if (parsing) return;
    const u = raw.trim();
    if (!u) return;
    setFeedback("");
    const res = await parseLink(u);
    if (res.ok) {
      setValue("");
      setFeedback("added");
      timer.current = setTimeout(() => setFeedback(""), 1500);
    } else if (res.duplicate) {
      setFeedback("duplicate");
      timer.current = setTimeout(() => setFeedback(""), 2000);
    }
    // non-ok, non-duplicate → provider's linkError shows inline below
  };

  const isBoss = detectSource(value) === "boss";

  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/30 px-3 py-2">
        <Link2 className="size-4 shrink-0 text-faint" />
        <input
          type="url"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setFeedback("");
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (detectSource(t)) {
              e.preventDefault();
              setValue(t.trim());
              void run(t.trim());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run(value);
          }}
          placeholder="粘贴智联招聘 / BOSS直聘 岗位链接，回车解析…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint max-sm:min-h-[44px]"
        />
        <button
          type="button"
          disabled={parsing || !value.trim()}
          onClick={() => void run(value)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-surface-hover px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {parsing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> 解析中…
            </>
          ) : feedback === "added" ? (
            <>
              <Check className="size-3.5 text-emerald-500" /> 已添加
            </>
          ) : (
            <>
              解析 <CostBadge kind="free-network" size="xs" />
            </>
          )}
        </button>
      </div>

      {parsing && isBoss && (
        <p className="mt-1.5 text-[12px] text-faint">BOSS 链接需启动浏览器，最长约 1 分钟，请稍候…</p>
      )}
      {bossBrowserNotRunning && !parsing && !bossAwaitingLogin && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/30 px-3 py-2">
          <Lock className="size-3.5 shrink-0 text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-muted">BOSS 浏览器未在运行</p>
          <button
            type="button"
            disabled={bossLoginBusy}
            onClick={() => void launchBossBrowser()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand-soft/80 disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {bossLoginBusy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> 启动中…
              </>
            ) : (
              <>启动 BOSS 浏览器</>
            )}
          </button>
        </div>
      )}
      {bossLoginRequired && !parsing && !bossBrowserNotRunning && !bossAwaitingLogin && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/30 px-3 py-2">
          <Lock className="size-3.5 shrink-0 text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-muted">该岗位需登录 BOSS直聘 后查看，点击打开登录页</p>
          <button
            type="button"
            disabled={bossLoginBusy}
            onClick={() => void loginBossForParse()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand-soft/80 disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {bossLoginBusy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> 正在打开…
              </>
            ) : (
              <>打开 BOSS 浏览器登录</>
            )}
          </button>
        </div>
      )}
      {bossAwaitingLogin && !parsing && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface/30 px-3 py-2">
          <Lock className="size-3.5 shrink-0 text-muted" />
          <p className="min-w-0 flex-1 text-[13px] text-muted">已在浏览器中打开 BOSS 登录页，完成登录后点击重试</p>
          <button
            type="button"
            disabled={bossLoginBusy}
            onClick={() => void retryBossParse()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand-soft/80 disabled:opacity-50 max-sm:min-h-[44px]"
          >
            我已完成登录，重试解析
          </button>
        </div>
      )}
      {feedback === "duplicate" && !parsing && <p className="mt-1.5 text-[12px] text-faint">该岗位已在列表中</p>}
      {linkError && !parsing && !bossLoginRequired && !bossBrowserNotRunning && !bossAwaitingLogin && (
        <p className="mt-1.5 flex items-start gap-1 text-[12px] text-amber-600 dark:text-amber-300">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {linkError}
        </p>
      )}
    </div>
  );
}
