# BOSS直聘 登录态来源 — QA 验收测试计划

- 需求期：2026-09 新一期（dev-team 协作）
- 作者：@qa（验收侧）
- 被验收对象：@carreer-ops 交付（架构文档 v1.0 + 任务拆分 B0–B5）
- 基线：HEAD `298093c`（魔改）；`787fa68` = zhaopin 登录态来源先例
- 状态：✅ v0.3 —— nodriver 路线 PASS（2026-09-02）：`navigator.webdriver=False`、登录成功、
  `/web/geek/jobs?_security_check=1_…`、卡片 61、无 reload 循环。BOSS 自动化扫描可行。
  - 关键变量：**自动化指纹**是决定性变量（Playwright 同 profile 同会话 17 reload → 0 卡片；nodriver 同会话 PASS）。
  - 合规边界：@user 已授权变更（允许 nodriver 规避自动化指纹；本人账号/本地/低频/不外发/不自动过验证码，
    接受账号残余风险）。授权 + 残余风险须如实写入 SUPPORTED_JOB_BOARDS.md / recon-report，QA 复核留痕。
  - 架构变更：boss 源 = Python sidecar（nodriver）+ `--jsonl` 契约，web/CLI 入口不变；
    原「引擎零改动（丢 .mjs）」假设作废，B1/B2 结构与 T-B2 验收按 sidecar 口径重写。
  - 抽取设计（R1/R3 更正）：BOSS 薪资数字字体混淆（私有区字形）→ 主源 = 拦截列表 XHR
    `/wapi/zpgeek/search/joblist.json`（页面已签名的明文响应，zhaopin 同款先例，未扩合规面），
    DOM 仅兜底；parseSalary/normalizeJob 须同时覆盖 XHR JSON 字段形态（B1 抓包钉死）。
  - 风险事件记录：v7 会话曾被 Playwright persist 测试（17 reload）烧掉 → 服务端强制登出（账号级残余风险实锤）；
    扫描器须硬性低频率纪律（页数/reload 上限 + 异常即停），列入验收红线。

---

## 1. 验收目标与红线

**目标**：验证「BOSS直聘作为有状态来源」的功能补齐是否达到 zhaopin 先例同等能力面，
且不破坏既有来源。

**红线（一票否决）**：
1. zhaopin 全链路回归失败 → 需求不通过（对齐 dev B5 红线）；
2. 合规边界越线（非本人登录态/外发数据/规模化抓取/对抗反爬）→ 不通过；
3. 证据缺失的验收项一律记「未执行/受阻」，不脑补通过。

## 2. 被测对象与范围

| 变更面 | 文件 | 说明 |
|---|---|---|
| 新增 | `browser-sources/boss.mjs` | BOSS 来源扫描器（核心被测） |
| 扩展 | `tests/browser-source.test.mjs` | boss 纯函数单测 |
| 改动 | `portals.yml`（未入库） | `boss_searches:` 关键词块 |
| 改动 | `docs/SUPPORTED_JOB_BOARDS.md` | 登录态来源 + 风控记录 |
| 改动 | `web/src/lib/explore.ts` | LoginSource 联合类型 + LOGIN_SOURCES + LOGIN_LABEL |
| 改动 | `web/src/lib/login-intent.mjs` | LOGIN_SOURCE_PATTERNS + schema 泛化 |
| 改动 | `web/src/app/api/explore/ai/route.ts` | intentPrompt 泛化（视需） |
| 改动 | `web/tests/lib/login-intent.test.mjs` | boss 路由用例 |
| 新增文档 | `docs/dev-team/carreer-ops/recon-report.md` | P0 取证报告 |
| 交付物 | `docs/dev-team/carreer-ops/handoff-qa.md` | 移交清单 |

**范围外**：设计 UI 改动（DesignAgent 判定无，若 recon 后有筛选面板需求另行评审）；
providers/、插件注册表（合规边界，架构 §2-6）。

## 3. 验收矩阵（对 B0–B5 逐条映射）

### 3.1 B0 recon 报告验收（静态，依赖 recon-report.md）
| QA-编号 | 检查点 | 通过标准 | 证据 |
|---|---|---|---|
| T-B0-01 | R1–R6 逐项结论 | 每项有结论 + 证据分级（A/B/C）+ 证据路径 | recon-report.md 行引用 |
| T-B0-02 | 反爬基线记录 | robots 原文引用 + 合规决策留痕 | 文档截图 |
| T-B0-03 | 证据真实性 | 抽查 A 级证据可复现（debug HTML/抓包） | 复核命令输出 |

### 3.2 B1 扫描器单测与静态（交付后执行）
| QA-编号 | 检查点 | 通过标准 |
|---|---|---|
| T-B1-01 | `node test-all.mjs --only browser-source` | 全绿，含 boss 用例 |
| T-B1-02 | buildSearchUrl 编码 | query/city/page 参数 URL 编码正确（中文关键词） |
| T-B1-03 | mapSearchParams | 语义值→BOSS 码；**未知值丢弃保 broad** |
| T-B1-04 | parseSalary | `15-20K` / `20-30K·13薪` → `{min,max,currency:'CNY'}` 月薪语义，单测断言 |
| T-B1-05 | normalizeJob | Job 契约：title/url 必填；salary/postedAt 缺失容忍符合契约 |
| T-B1-06 | lint | `npm run lint`（根）无新增错误 |
| T-B1-07 | CLI 注册 | `node scan-browser-source.mjs boss`（无登录态）列出来源 + 基类告警不崩溃 |

### 3.3 B2 CLI 真机链路（依赖用户登录态）
| QA-编号 | 检查点 | 通过标准 |
|---|---|---|
| T-B2-01 | `--login` 落盘 | `config/browser-state/boss.json` 存在且 gitignored（`git check-ignore`） |
| T-B2-02 | dry-run 抽取 | `--keyword 数据分析 --dry-run --debug` 抽 ≥1 条真实岗位，title/url/company/location 前四字段完整 |
| T-B2-03 | dry-run 不入库 | `data/pipeline.md` 无新增行（diff 前后） |
| T-B2-04 | 真实运行 | pipeline.md 出现 boss 行、scan-history.tsv 记 added |
| T-B2-05 | title_filter 生效 | 抽取结果 title 均命中 portals.yml positive 语义（对照关键词） |
| T-B2-06 | 风控 fail-closed | 触发风控时（模拟/实际）verifyPage 识别并中文提示，不静默产出 0 结果 |
| T-B2-07 | 无登录态告警 | 删/移 boss.json 场景 → 基类告警（验证后恢复原文件） |

### 3.4 B3 web Explore 接入（依赖 B2 + dev server）
| QA-编号 | 检查点 | 通过标准 |
|---|---|---|
| T-B3-01 | 芯片出现 | Explore 筛选栏「登录态来源」出现 BOSS直聘 芯片 |
| T-B3-02 | URL codec | `?ls=boss` 往返不丢（刷新/分享链接） |
| T-B3-03 | 单选 boss 扫描 | 仅选 boss 可发起登录态扫描，`--jsonl` 流式按关键词渲染真实输出 |
| T-B3-04 | 无登录态 UI 提示 | 无 boss.json 时 fail-fast 文案合理（验证后恢复） |
| T-B3-05 | zhaopin 共存 | 双芯片并存，`?ls=zhaopin` 与 `?ls=boss` 互不干扰 |
| T-B3-06 | typecheck/lint | `npm run lint`、`npm run typecheck`（web）过 |

### 3.5 B4 AI-search 路由
| QA-编号 | 检查点 | 通过标准 |
|---|---|---|
| T-B4-01 | boss 意图识别 | 「在 BOSS 直聘上找数据分析，上海，本科」→ id=boss、keyword=数据分析、条件进 search_params |
| T-B4-02 | zhaopin 回归 | 「在智联招聘上找…」仍路由 zhaopin（两条并存） |
| T-B4-03 | schema 泛化 | `SearchIntentQuery` 改名后引用面一致、无遗漏 `ZhilianQuery` 硬引用破坏 |
| T-B4-04 | 单测 | `web/tests/lib/login-intent.test.mjs` 全绿 |

### 3.6 B5 回归与移交
| QA-编号 | 检查点 | 通过标准 |
|---|---|---|
| T-B5-01 | 全量单测 | `node test-all.mjs` 全绿 |
| T-B5-02 | zhaopin CLI 冒烟 | `node scan-browser-source.mjs zhaopin --keyword 数据分析 --dry-run` 正常（1 关键词） |
| T-B5-03 | 改动面核对 | git diff 文件清单 ⊆ 架构 §4.1 声明文件 |
| T-B5-04 | 移交物齐全 | handoff-qa.md：改动清单 + 自测证据路径 + 已知限制 + 复现步骤（含登录态获取） |

## 4. 环境与证据纪律

- **环境**：本机 career-ops 仓库（Windows）；web dev server 本地；BOSS/zhaopin 登录态用用户本人账号，仅本地，测试后不扩散。
- **证据**：每条结论绑定 命令输出/日志行号/HTML 落盘/截图，路径写入 `docs/dev-team/qa/evidence/` 索引。
- **只读铁律**：验收不修 bug；发现的缺陷按 P0–P3 记入 `defect-log.md`，仅给复现步骤与建议。
- **受阻处理**：需要用户配合的（登录、删文件验证、headed 浏览器）先 @user 请求，阻塞项记「受阻+原因」，不跳过、不脑补。

## 5. 交付物（本目录 docs/dev-team/qa/）
1. 本测试计划（test-plan-boss-zhipin.md）
2. 缺陷登记表 defect-log.md（按需创建）
3. 验收报告 acceptance-report.md（开发移交后出具）
4. evidence/ 证据子目录（按需）

## 6. 暂无法核实项（初稿阶段）
- B0 recon 的实际取证结果（R1–R6）——开发进行中；
- boss 真实登录态下的数据载体/分页/风控阈值——依赖用户一次登录配合；
- web UI 双来源共存的实际渲染——依赖 B3 交付。
