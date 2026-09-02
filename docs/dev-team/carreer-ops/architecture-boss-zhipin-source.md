# BOSS直聘 登录态来源 — 架构方案与开发任务

- 需求期：2026-09 新一期（dev-team 协作）
- 作者：@carreer-ops（开发侧）
- 评审/验收：@qa（验收侧，口径见其测试计划）
- 基线：HEAD `298093c`（魔改）；上一提交 `787fa68` 引入 Explore 登录态来源（zhaopin 先例）
- 状态：✅ 架构已细化（v1.0）→ P0 recon 进行中 → 开发待启动

---

## 1. 需求与目标

**需求**：全面支持 BOSS直聘（zhipin.com）作为**有状态来源**（登录态），功能补齐。
"补齐"的参照物 = 智联招聘（zhaopin）登录态来源已经打通的完整能力面：

| 能力面 | zhaopin（先例，已有） | boss（本次目标） |
|---|---|---|
| CLI 扫描器 `browser-sources/<id>.mjs` | ✅ zhaopin.mjs | 新增 boss.mjs |
| `--login` 保存登录态 `config/browser-state/<id>.json` | ✅ | 新增，但**不走基类流程**——boss.mjs 覆写 `login()`：OS 原生 Chrome + 手工登录 + CDP 只读导出（v2/v3 实锤：自动化登录即被风控识别，见 recon-report R5/R6） |
| 结果落 `data/pipeline.md` + `scan-history.tsv`（过滤/去重语义一致） | ✅（继承 BrowserSource 引擎） | 继承，零改动 |
| portals.yml 关键词块 + `search_params` 语义条件 | ✅ `zhaopin_searches` | 新增 `boss_searches` |
| web Explore「登录态来源」独立分组 | ✅ | `LoginSource` 联合类型加 `"boss"` |
| AI-search 意图直连（"在BOSS上找…"） | ✅ `智联\|zhaopin` 路由 | `detectLoginSource` 加 boss 模式 |
| 语义搜索条件（城市/薪资/学历/经验/性质…）→ 站点码表 | ✅ mapSearchParams + 码表 | boss 自有码表（需 recon） |
| 单元测试（纯函数）+ 回归 | ✅ | 扩展 |

目标岗位背景：数据分析 / BI / 用户运营，base 上海 —— 搜索关键词与 zhaopin 共用
`title_filter.positive`（portals.yml 已配），新增 boss 关键词列表并保持同一过滤链路。

---

## 2. 现状盘点：可复用资产与接线点（已核实源码）

登录态来源的完整链路（本次只加"站点"这一环，其余已泛化）：

```
browser-sources/*.mjs ──动态装载──▶ scan-browser-source.mjs (CLI)
        │  BrowserSource 子类（lib/browser-source.mjs 基类引擎：登录态/关键词/
        │  过滤/去重/落库/--jsonl 流式，均继承）
        ▼
web Explore「登录态来源」组：web/src/lib/core/scan.ts runLoginSources(id) ─ spawn CLI
        │  loginStatePath(id) 预检 → CAREER_OPS_PORTALS 临时过滤文件
        ▼
web/src/lib/explore.ts：LoginSource 联合类型 + LOGIN_SOURCES/LABEL（硬编码数组）
        ▼
AI-search：web/src/lib/login-intent.mjs detectLoginSource() 路由
        │  意图 LLM → 语义条件 → portals search_params → 扫描器 mapSearchParams
```

**关键架构事实（本次设计的地基）**：

1. **CLI 零注册表**：`scan-browser-source.mjs` 按字母序动态装载 `browser-sources/*.mjs`，
   新来源 = 丢一个文件进去，CLI 侧无需任何注册改动。
2. **web Explore 扫描侧已按 id 泛化**：`runLoginSources` 接收 id 参数，唯一
   耦合点是 `loginStatePath(id)` 与 `CAREER_OPS_PORTALS`，**scan.ts 预期零改动**。
3. **web Explore UI 侧是硬编码联合类型**：`web/src/lib/explore.ts` `LoginSource = "zhaopin"`、
   `LOGIN_SOURCES = ["zhaopin"]`、`LOGIN_LABEL` —— 加 boss = 扩这三处；filter-builder /
   URL codec（`?ls=`）/ 状态芯片由该数组驱动，自动跟随。
4. **AI-search 语义层已与站点码表解耦**：意图 LLM 只吐**语义值**（"本科"/"3-5年"/"15-25K"…），
   经 `portals-serialize.mjs` 写进临时 portals 的 `search_params:`；**站点码表归属各
   来源模块**（zhaopin 在 zhaopin.mjs 的 `mapSearchParams`/`resolveSalaryCode` 等）。
   boss 只需在自己的模块里放一套 BOSS 码表并实现 `mapSearchParams` —— **web 语义
   schema（ZhilianQuery 的字段集）对 boss 同样适用，无需拆 schema**。命名上
   ZhilianQuery 已偏 zhaopin，本轮可顺手泛化为 `SearchIntentQuery`（类型别名兼容），
   属低风险改名，见任务 B4。
5. **列表页免详情页纪律**（zhaopin 先例）：列表 payload 免费携带的字段直接收，
   不为单条岗位做详情页请求（BOSS 详情页反爬更强、请求量翻倍、风险更高）。
6. **合规边界已定**（沿用先例）：登录态来源不进 `providers/`、不进插件注册表、
   `config/browser-state/` gitignore，仅限用户本人求职用途本地运行。

---

## 3. BOSS直聘站点事实与反爬基线（含本次匿名探测证据）

来自技能参考文档（2026-08 验证）+ 本次 2026-09-02 匿名 curl 复测：

| 探测 | 结果 |
|---|---|
| robots.txt（本次复测） | 明确 `Disallow: /*?query=*` `/*?ka=*` `/*?sid=*` `/job_detail/l*.html` `*?city=*` `*?salary=*` `*?degree=*` 等 —— 搜索查询参数路径全部禁爬 |
| 桌面站匿名 curl（本次） | `www.zhipin.com/web/geek/job?query=…&city=101020100` → HTTP 200 但 body 0 字节（纯 JS 壳，无 SSR 内容） |
| 移动站匿名 curl（本次） | `m.zhipin.com/c101020100/?query=…` → 302 到 `/web/passport/zp/verify.html`（登录/验证墙） |
| 历史基线（参考文档） | 匿名一律转 security.html 滑块风控；无零认证 API；mcp-jobs 等第三方只能做 DOM 抓取参考 |

**结论**：BOSS 无匿名路径，且比 zhaopin 更严 —— robots 显式禁查询路径、桌面站连空壳
都不给匿名者、移动站直接踢到验证墙。**唯一可行路线 = 用户本人的登录态浏览器会话**
（headed + storageState），与 zhaopin 同一框架，但风控烈度更高，需更保守的节奏参数。

**仍属 P0 recon 必须现场验证的未知点**（写代码前逐项取证，产出 recon-report.md）：
- R1 登录态下桌面搜索页的**数据载体**：hydration JSON？DOM 卡片？列表 XHR？
  （BOSS 的 wapi 请求以加密参数闻名 —— 若列表走加密 XHR，则改走"DOM/SSR 优先"策略）
- R2 **分页机制**：`?page=N` URL 分页是否可用（浏览器内直连）；BOSS geek 搜索结果页
  历史上有"下一页"按钮 + URL page 参数，需实测登录态下直接 goto page=2/3 是否放行
- R3 **字段映射**：卡片 DOM / 数据对象字段 → 薪资（如 `20-30K·13薪` 形态）、城市区、
  经验/学历标签、发布时间（BOSS 卡片常见"发布职位 XX 天前"——相对时间，可能缺精确
  日期 → postedAt 允许缺失，与 Job 契约一致）、job 详情 URL（`job_detail/<加密id>.html`，
  URL 直接可用即可去重）
- R4 **城市码表**：上海 `101020100` 已确认；北京 `101010100` 等其余城市、以及
  BOSS 的学历/经验/薪资档位下拉的**语义→码值**（从筛选栏 DOM 或前端 bundle 取，
  流程同 zhaopin 的 base/data API 发现法）
- R5 **风控触发阈值**：连续 N 页/关键词、headless vs headed、CDP 指纹 —— 用登录态
  会话实测，定出安全的 maxPages / postLoadDelayMs / 关键词间隔
- R6 **登录方式**：BOSS geek 登录 = 手机验证码 / 微信扫码 —— `--login` 交互流程
  直接复用基类（headed 打开 loginUrl，人工登录后 Enter 落盘），无需新代码

---

## 4. 目标架构（v1.0）

### 4.1 新增文件

| 文件 | 内容 |
|---|---|
| `browser-sources/boss.mjs` | BOSS 来源（唯一新增的运行时文件，详见 4.2） |
| `tests/browser-source.test.mjs`（扩展） | boss 纯函数测试：URL 构建、语义→码表映射、薪资解析、normalizeJob |
| `docs/SUPPORTED_JOB_BOARDS.md`（改） | "Login-state sources" 加一行；"Evaluated, not supported" 区补 BOSS 风控记录 |
| `portals.yml`（改，gitignore） | 注释块 `boss_searches:` + 激活关键词（与 zhaopin 相同的 数据分析/BI/用户运营） |
| `docs/dev-team/carreer-ops/recon-report.md` | P0 现场取证报告（证据分级，逐条来源） |
| `web/src/lib/explore.ts`（改） | LoginSource 联合类型 + LOGIN_SOURCES + LOGIN_LABEL 加 `"boss"`/BOSS直聘 |
| `web/src/lib/login-intent.mjs`（改） | `LOGIN_SOURCE_PATTERNS` 加 `{ id:"boss", label:"BOSS直聘", re:/boss|直聘\|zhipin/i }` |
| `web/tests/lib/login-intent.test.mjs`（扩展） | boss 路由识别用例 |
| `web/src/app/api/explore/ai/route.ts`（改，小） | 视 recon 需要泛化 intentPrompt 的站点指引用语；schema 名泛化 |
| `web/src/lib/explore-ai.ts`（视需） | 登录源 → CLI 的映射若含站点白名单则扩展 |

### 4.2 `browser-sources/boss.mjs` 设计

```js
// def（构造参数）：
{ id: 'boss', label: 'BOSS直聘 (zhipin.com)',
  loginUrl: 'https://www.zhipin.com/web/geek/job',   // 登录着陆页（recon 后定）
  defaultKeywords: ['数据分析', 'BI', '用户运营'],     // 与 zhaopin 对齐
  configSection: 'boss_searches',
  headless: false,            // 风控：必 headed（recon R5 确认）
  maxPages: 8,                // 比 zhaopin 保守（风控烈度更高，recon R5 校准）
  pageSizeHint: 30,           // BOSS 每页 30 条（recon R2 确认）
  resultsSelector: <recon 后定>,   // 空结果 vs 选择器失效 判别
  postLoadDelayMs: <recon 后定>,   // 真人节奏，防触发风控
}
```

- **三个必覆写**：`searchUrl(keyword, page)`（`www.zhipin.com/web/geek/job?query=<kw>&city=<code>[&page=N]`）、
  `extract(page)`、`normalizeJob(raw)`；`resolveSearchParams` 读 `search_params`
  + `location_filter.allow` → BOSS 码表（同 zhaopin 结构，BOSS 值另测）。
- **login() 覆写（v4 设计，QA T-B2-01 已同步）**：不复用基类 headed-playwright 登录
  （会被风控识别）。boss 的 `login()` = `child_process` 原生拉起系统 Chrome
  （`--remote-debugging-port=<随机>` + 独立 `user-data-dir`，无任何自动化参数）→
  打开 geek 搜索页 → 控制台提示人工登录 → 轮询 CDP 直到出现登录 cookie →
  `storageState` 导出 `config/browser-state/boss.json`。窗口不自动关闭、无时限。
- **分页策略 A/B（recon 后二选一，架构上都支持）**：
  - A（首选，若 R2 通过）：URL 分页 —— 基类 `nextPage(page, pageNum)` 覆写为
    `page.goto(searchUrl(kw, pageNum))`，引擎逐页抽；
  - B（若 R2 被风控挡）：单页自包含 —— `extract` 内 DOM 翻页/滚动收集全量（zhaopin 无限滚动同款），
    `nextPage` 返回 false。
- **verifyPage 覆写**：识别风控页特征（滑块/“访问过于频繁”/验证码 DOM 或 URL 含
  `verify`）→ fail-closed 并给出可操作提示（等多久/重登）。
- **薪资解析**：BOSS 列表形态 `15-20K`、`20-30K·13薪`（乘 13 薪月份=年薪？——契约
  是月薪 {min,max,currency:'CNY'}，按 recon 实测的显示语义解析；`·13薪` 等后缀忽略或
  折算，写进单测）。参考 zhaopin `parseSalary` 同款导出纯函数。
- **postedAt**：BOSS 卡片多为相对时间（"3天前"）→ 解析为近似日期或省略（契约允许缺失），
  按 recon 实测定。

### 4.3 web 改动（最小面）

- Explore 分组：`explore.ts` 三处扩 `"boss"` 后，UI 芯片/`?ls=boss` codec/扫描传参
  自动生效（数组驱动，先验证再动其他文件）。
- AI-search 路由：`login-intent.mjs` 加 pattern 即路由成功；意图 schema 字段复用
  （语义层与站点解耦，见 §2-4）；若 intentPrompt 里有"仅智联可用"之类措辞则泛化。
- 扫描时长预算：zhaopin 全关键词 ≈ 11 min；boss 若走 URL 分页会快得多；仍按
  `web-explore-login-sources.md` 的 timeout 纪律核算 spawn 超时与 maxDuration。

---

## 5. 风险登记表

| # | 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|---|
| 1 | BOSS 风控（滑块/验证/限流）拦截登录态扫描 | 全链失败 | **已实锤（2026-09-02 A 级证据，recon-report R5）**：headed Playwright 内置 chromium 被识别 → about:blank + 无限自刷新。缓解：真实 Chrome 通道 + 指纹清理 + 独立 user-data-dir + 冷却 ≥10min + verifyPage 识别风控签名（fail-closed 不静默 0 结果）+ 保守节奏 | P0 实锤，v3 方案验证中 |
| 2 | 列表走加密 XHR，无明文 hydration | 抽取方案失效 | 策略 B：DOM 卡片为源（第三方抓取器已证明 DOM 可行）；绝不解密对抗 | P0 验证中 |
| 3 | 账号被风控（短期封禁/需重验证） | 用户求职账号受损 | 文档明示风险；频次限制（每日 1 轮、页数保守）；异常即停并提示 | 预案 |
| 4 | 字段/schema drift（站点改版） | 0 结果或字段缺失 | 选择器常量集中在文件头；verifyPage + 空结果告警（基类已有）；--debug 一键取证 | 预案 |
| 5 | 城市/条件码表错配（上海之外） | 搜索范围错 | mapSearchParams 未知值丢弃保持 broad（zhaopin 同款纪律）；码表 recon 取证 | P0 |
| 6 | web 侧漏改（联合类型/路由单点） | boss 不在 UI 出现或路由 404 | 全链路核对清单（任务 B3/B4 验收点含 UI 出现 + AI 路由 E2E） | 规划 |
| 7 | 合规（robots 显式禁查询路径） | 项目合规红线 | 维持 zhaopin 先例边界：用户本人登录态、本地、非商用；文档记录 robots 原文与决策 | 已定 |

**合规决策**（与先例一致并在文档留痕）：BOSS robots.txt 对搜索查询参数显式禁爬。
zhaopin（同款登录态来源）已确立的项目边界为——个人求职者以**本人账号登录态**、本地
运行、结果仅入个人 pipeline、不发布不传播。BOSS 沿用同一边界；任何超出（共享会话、
规模化抓取、数据外发）不在本需求范围。

---

## 6. 验收口径映射（对齐 @qa 四条）

| @qa 验收项 | 本方案对应交付/证据 |
|---|---|
| 1 静态验收（与架构一致） | §4 清单逐一核对；recon-report.md 逐条证据 |
| 2 功能验收（登录态全链路） | boss 扫描器 `--login` → `--dry-run --keyword 数据分析`；web 分组 + AI 路由 E2E |
| 3 异常验收（风控/空结果/会话过期） | verifyPage 风控识别；0 结果告警；storageState 失效重登提示（基类已有） |
| 4 回归验收（zhaopin 不破坏） | `node test-all.mjs` + zhaopin CLI dry-run 冒烟 + web 两来源共存检查 |

---

## 7. 开发任务总览（详见 dev-task-breakdown.md）

P0 recon（现场取证）→ P1 boss.mjs 扫描器 + 单测 → P2 CLI/配置/文档 → P3 web 接线 +
AI 路由 → P4 全量自测 + 移交清单。任务粒度见拆分文档，每项含文件路径与验收标准。
