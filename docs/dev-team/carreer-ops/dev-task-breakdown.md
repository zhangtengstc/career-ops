# BOSS直聘 来源开发 — 任务拆分与验收标准

- 配套架构文档：`architecture-boss-zhipin-source.md`（同目录）
- 验收/评审：@qa；基线同上。每个任务标注 **验收标准**（QA 静态/功能验收可逐条对照）。
- 任务编号 B0–B5；P0 recon 结果会回流修正 B1–B2 的细节，任务体不变。

---

## B0 — P0 recon：BOSS 直聘现场取证（登录态）

**目标**：回答架构文档 §3 的 R1–R6，产出 `docs/dev-team/carreer-ops/recon-report.md`
（证据分级：A=实拍输出/页面抓包，B=参考文档交叉验证，C=推断待验证）。

步骤：
1. 运行 `node scan-browser-source.mjs boss --login`（B1 未写前先用临时脚本/playwright
   直启，headed 打开 geek 搜索页）——**需要用户完成一次登录**（手机验证码/微信扫码）。
2. 登录态下 goto `https://www.zhipin.com/web/geek/job?query=数据分析&city=101020100`：
   - R2 分页：直接 goto `&page=2`/`&page=3`，看是否返回第 2/3 页数据还是被风控；
   - R1 数据载体：查 hydration JSON（`window.__INITIAL_STATE__`/`__NEXT_DATA__`/`window.__pinia`…）、
     卡片 DOM 类名、Network 里的列表 XHR（是否明文 JSON）；
   - R3 字段：单卡内容 → title/薪资原文/公司/城市区/经验学历标签/时间/详情 URL；
   - R5 风控：连续翻 5–10 页观察是否出现滑块/验证/“操作频繁”，记录阈值；
   - R4 码表：从搜索页筛选栏（学历/经验/薪资/城市下拉）抓语义→code 映射。
3. 用 `output/debug-boss.html` 落 HTML 证据。
4. **验收**：R1–R6 每项有结论 + 证据路径；recon-report.md 写入 docs/dev-team/carreer-ops/。

**前置**：用户 BOSS 账号可登录（扫二维码/收验证码）。无账号或拒绝登录 → 任务阻塞，
回退方案 B0'（匿名 DOM 可行性探测）记录在报告中，由 @user 决策是否继续。

---

## B1 — browser-sources/boss.mjs 扫描器 + 纯函数单测

**目标**：新增 BOSS 登录态来源，三个必覆写 + 可选钩子按 recon 结论实现。

文件：
- 新 `browser-sources/boss.mjs`（结构镜像 zhaopin.mjs：模块头注释含站点事实与 recon 日期；
  码表/选择器常量置顶；导出纯函数供单测）
- 扩 `tests/browser-source.test.mjs`

纯函数（全部导出、单测覆盖）：
- `buildSearchUrl(keyword, page, params)` —— 含城市码（默认上海 101020100 或 recon 定全国码）
  与条件参数；URL 编码正确
- 码表 + `mapSearchParams(searchParams, allow)` —— 语义值→BOSS 码，未知值丢弃保持 broad
- `parseSalary`（BOSS 形态：`15-20K`、`20-30K·13薪` → `{min,max,currency:'CNY'}` 月薪语义）
- `normalizeJob(raw)` —— Job 契约（title/url 必填；company/location/salary/postedAt/source）
- `resolveCityCode(allow)`（若城市码单值收敛策略与 zhaopin 相同）

类实现要点：
- def 按 recon 校准（headless:false、pageSizeHint、postLoadDelayMs、maxPages 保守值）
- `verifyPage` 识别风控页 → fail-closed + 中文可操作提示。**必识别签名（QA
  T-B2-06 定项，recon R5 实锤）**：URL 含 `passport|verify|security|captcha`；
  页面变 `about:blank`；短窗口 reload 计数异常（>2 次/10s）；DOM 含滑块/"访问
  过于频繁"文案。命中任一 → 报"风控拦截"，绝不静默当 0 结果
- 分页按 recon R2 结果选 A（URL nextPage）/ B（自包含 extract）
- **验收**：`node test-all.mjs --only browser-source` 全绿；`npm run lint` 过；
  CLI 冒烟 `node scan-browser-source.mjs boss` 能列出来源（此时尚无登录态，仅验注册）。

---

## B2 — CLI 侧接线与配置文档

文件：
- `portals.yml`（未入库，直接改）：注释块示例 + 激活 `boss_searches: [数据分析, BI, 用户运营]`
- `docs/SUPPORTED_JOB_BOARDS.md`：Login-state sources 表格加 boss 行；"Evaluated, not
  supported" 补 BOSS 风控记录（robots 原文 + 决策）
- `config/profile.example.yml`（视需）：如 profile 有来源级节则同步示例

步骤/验收：
- **boss.mjs 覆写 `login()`（v4 流程，QA T-B2-01 已同步）**：`node scan-browser-source.mjs
  boss --login` → OS 原生 Chrome 弹出（无自动化参数）→ 用户纯手工登录 → 轮询 CDP
  出现登录 cookie → `config/browser-state/boss.json` 落盘（gitignored）；窗口不
  自动关闭、无时限
- `node scan-browser-source.mjs boss --keyword 数据分析 --dry-run --debug`：HTML 落
  output/，抽取 ≥1 条真实岗位，字段完整（title/url/company/location 至少前四）
- 无登录态运行时给出基类既有告警文案（不崩溃）
- dry-run 不入 pipeline（校验 `data/pipeline.md` 无新增行）
- 真实运行一次（非 dry-run）→ pipeline.md 出现 boss 行、scan-history.tsv 记 added

---

## B3 — web Explore「登录态来源」分组接入 boss

文件（预期最小面，全部数组驱动）：
- `web/src/lib/explore.ts`：`LoginSource` 联合 + `LOGIN_SOURCES` + `LOGIN_LABEL` 加 `"boss"`
- `web/src/lib/core/scan.ts`：只读确认 runLoginSources/`loginStatePath` 已按 id 泛化（预期零改动）

验收（`npm run dev` 实测 + web/tests）：
- Explore 筛选栏「登录态来源」组出现 BOSS直聘 芯片，`?ls=boss` URL 往返不丢
- 仅选 boss（不选 ATS）可发起登录态扫描（沿用“四处一致”旧改动，回归验证不破）
- 无 boss 登录态时 UI 提示（现有 fail-fast 逻辑自动生效，验证文案合理）
- 选择 boss 扫描 → `--jsonl` 流式按关键词渲染结果（复用 zhaopin 通路，验证真实输出）

---

## B4 — AI-search 意图路由 + 语义 schema 泛化

文件：
- `web/src/lib/login-intent.mjs`：`LOGIN_SOURCE_PATTERNS` 加
  `{ id:"boss", label:"BOSS直聘", re:/boss|直聘|zhipin/i }`；`CITY_NAMES` 若需补
  boss 特有城市别名（语义城市名不变则零改动）
- `web/src/lib/login-intent.mjs`（或 route）：`ZhilianQuery` → 泛化命名
  `SearchIntentQuery`（保留 `ZhilianQuery = SearchIntentQuery` 别名或全量改名，
  改动前 grep 引用面，选低风险方案）；注释去掉“仅 zhaopin”措辞
- `web/src/app/api/explore/ai/route.ts`：intentPrompt 若有 zhaopin 专属举例/措辞则泛化；
  `streamLoginSourceSearch` 已按 id 泛化则零改动
- `web/tests/lib/login-intent.test.mjs`：加 boss 路由用例（"在BOSS直聘上找数据分析，上海" → id=boss）
  + cleanKeyword 回归

验收：
- AI 搜索框输入"在 BOSS 直聘上找数据分析相关岗位，上海，本科" → 路由到 boss 扫描器，
  关键词 = 数据分析（cleanKeyword 生效），city=上海 → 码表，条件进 search_params
- "在智联招聘上找…"回归不破（两条路由并存）
- 单测全绿；web lint/typecheck（`npm run lint`）过

---

## B5 — 全量自测 + 移交

自测矩阵（开发侧证据，逐条截图/输出存档于本目录）：
1. 单测：`node test-all.mjs`（含 browser-source、login-intent）
2. lint：`npm run lint`（根 + web 各自脚本）
3. CLI 真机：boss `--login` → 全关键词真实扫描（dry-run 先行）→ 结果抽样核对
   （title 匹配 title_filter、location 过滤语义、URL 可去重、薪资字段落第 5 列）
4. web E2E：Explore 双来源共存（zhaopin + boss 芯片）；AI 路由双来源意图
5. 回归：zhaopin CLI 冒烟 1 关键词；确认 boss 改动未触碰 zhaopin 文件

**移交物**（给 @qa）：
- 移交清单 `handoff-qa.md`：改动文件清单 + 自测证据路径 + 已知限制（如相对时间无
  postedAt、风控保守页数）+ 复现步骤（含登录态获取）
- recon-report.md、架构文档、本任务文档齐全

**验收红线**：zhaopin 全链路回归失败 = 本需求不通过，先修回归再谈 boss。
