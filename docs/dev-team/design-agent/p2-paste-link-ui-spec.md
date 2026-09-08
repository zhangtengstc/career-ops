# P2 粘贴链接解析 — UI 设计规格（PasteLinkBar）

> 设计：@design-agent ｜ 日期：2026-09-02 ｜ 对应计划：`.planning/2026-09-02-explore-paste-link-parse/` P2
> 决策依据：D1 定案「Scan 视图内联粘贴框，不做第三 mode」（理由：mode toggle 语义=成本选择；`?mode=link` 无分享价值；改动面最小）。

## 1. 组件与位置

新组件 `web/src/components/explore/paste-link-bar.tsx`（`PasteLinkBar`），渲染在 **Scan 视图 header 正下方、其余内容之上**——`explorer-view.tsx` 的 `isAi ? … : (<>…</>)` 分支内、`{isResults ? Refine折叠条 : FilterBuilder卡片}` 之前。常驻可见（空态/结果态都在），不随 phase 切换消失，避免「粘贴入口在结果页找不到」。

```
Explore  [Scan | AI search]
─────────────────────────────────
[🔗 PasteLinkBar]          ← 新增，常驻
┌ FilterBuilder + DiscoverBar ┐  (空态)
  或 Refine search 折叠条        (结果态)
ResultsList …
```

## 2. 形态与样式（对齐现有 token 体系）

单行 slim bar，视觉权重低于 Discover 主按钮（它是辅助入口，不是主 CTA）：

```tsx
<div className="mb-5 flex items-center gap-2 rounded-xl border border-border bg-surface/30 px-3 py-2">
  <Link2 className="size-4 shrink-0 text-faint" />            {/* lucide Link2 */}
  <input
    type="url"
    placeholder="粘贴智联招聘 / BOSS直聘 岗位链接，回车解析…"
    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint max-sm:min-h-[44px]"
  />
  <button className="inline-flex items-center gap-1.5 rounded-lg bg-surface-hover px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]">
    解析 <CostBadge kind="free-network" size="xs" />           {/* 沿用成本诚实：free */}
  </button>
</div>
```

要点：
- 用 `bg-surface-hover`（次级按钮）而非 `bg-brand`（主按钮），与 Discover 主 CTA 拉开层级；
- `CostBadge kind="free-network"` 延续 explore-mode-toggle 的「成本诚实」设计意图：解析免费、零 token；
- 文案中英混排与产品现状一致（UI 主体英文，但来源名为中文品牌词；placeholder 用中文是因为目标用户操作场景是粘贴中文站链接——若产品坚持全英文 UI，改为 `Paste a Zhaopin / BOSS job link, Enter to parse…`，二选一由 @user 定）。

## 3. 交互与状态机

| 状态 | 触发 | 表现 |
|---|---|---|
| idle | 初始 | 输入框可编辑，按钮 disabled（空输入） |
| parsing | 点击解析 / 回车 / 粘贴合法 URL | 按钮变 `Loader2 animate-spin` + 文案 `解析中…`；输入框锁定；**boss 链接额外显示提示行**：`BOSS 链接需启动浏览器，最长约 1 分钟`（route maxDuration=180，spawning headful Chrome，必须管理预期，否则用户以为卡死） |
| success | 200 + offer | 解析出的 offer **插入结果列表顶部**（`co-rise` 入场动画，复用现有类），来源徽章显示 `智联招聘`/`BOSS直聘`（`SOURCE_LABEL` 已有）；输入框清空，显示一次性成功反馈（按钮短暂变 `✓ 已添加`，1.5s 后还原） |
| error | 400/502 | 输入框下方 inline 错误行：`AlertCircle size-3.5` + `text-[12px] text-amber-600 dark:text-amber-300`，直接透传 API 的 error 文案（API 已返回中文错误，如「只支持智联招聘或 BOSS直聘 的岗位链接」） |

交互细节：
- **粘贴即解析**：onPaste 事件里若文本匹配 zhaopin/boss 域名，直接触发解析（免点按钮）；不匹配则留在输入框等用户确认；
- **去重**：解析成功前检查 `offers` 里是否已存在同 URL，已存在则不高亮新增，仅滚动定位到既有卡片 + 轻提示 `该岗位已在列表中`；
- **空结果态语义**：当前无任何扫描结果时解析成功，卡片单独成列表渲染（phase 不必切到 results——建议 provider 增加一个 `linkedOffers` 独立数组，与 scan 结果分离，避免污染「Scanned N companies」的语义；渲染时 linkedOffers 排在 scan offers 之前）。这点需要 explore-provider 配合改动，已标注为 P2 的 provider 契约变更；
- 移动端所有可点元素保持 `max-sm:min-h-[44px]`（现有规范）。

## 4. boss 卡片外链登录提示（用户实测痛点）

`discovery-card.tsx` 的 ExternalLink（L76-85）：当 `offer.ats === "boss"` 时：

- `title` / `aria-label` 改为 `在浏览器打开（需登录 BOSS直聘 查看完整详情）`；
- 徽章行追加一个轻提示 chip：`<span className="text-faint" title="…">· 详情需登录</span>`，仅在 boss 来源显示；
- zhaopin 不加（匿名可看完整详情，QA 已实测 200 + 完整 SSR）。

## 5. 给实现侧（@carreer-ops）的契约清单

1. 新组件 `paste-link-bar.tsx`，props 只需接 provider 暴露的 `parseLink(url)` / `parsing` / `linkError`；
2. explore-provider 新增：`linkedOffers: DiscoveredOffer[]`（独立于 scan offers）、`parseLink()` 调 `/api/explore/parse-link`、成功 unshift 进 linkedOffers、`linkError` 字符串态；
3. ResultsList 渲染顺序：linkedOffers（带「链接解析」分组小标题可选）→ scan offers；
4. discovery-card 按 §4 加 boss 外链提示；
5. 错误文案直接透传 API，前端不二次包装（保持单一事实源）。

## 6. 验收映射（供 @qa）

- T-P2 粘贴栏在空态/结果态均可见可用；boss 解析中状态有预期管理提示；
- 成功卡片插入列表顶部、来源徽章正确（智联/BOSS）、重复 URL 不重复添加；
- 400/502 错误 inline 展示且不透出技术细节以外的内容；
- boss 卡片外链带「需登录查看完整详情」提示，zhaopin 不带。
