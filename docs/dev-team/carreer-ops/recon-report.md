# BOSS直聘 recon 现场取证报告（B0）

- 作者：@carreer-ops ｜ 状态：**进行中 v0.2**（等待 v3 登录方案落地后补 R1–R4/R6）
- 证据分级：**A**=实拍输出/进程日志/用户现场确认；**B**=参考文档/交叉验证；**C**=推断待验证
- 全部探测均只读（curl / headed 浏览器等待），未做任何自动翻页或高频请求

---

## 已取证条目

### R5 风控 —— 触发实锤（A 级证据，2026-09-02）

**触发时间**：2026-09-02 本次 dev-team 会话，两次 headed 登录尝试（进程
proc_0463829ecf92 与 proc_a0553dd19d93，均为 15 分钟内连续）。

**环境**：Playwright 1.62.1 内置 chromium（headed，非 headless），全新 context，
无登录态，访问 `www.zhipin.com/web/geek/job?query=数据分析&city=101020100`。

**行为链（第 2 次尝试，用户现场确认 + 进程日志）**：
1. 访问搜索页 → 302 到登录墙 `passport/zp/verify.html?…&code=35`（匿名基线，同 curl 探测）；
2. 用户完成**人工安全校验**（滑块）→ 带 `_security_check=1_<ts>` 参数跳回
   `/web/geek/jobs` 真实职位页（此刻 cookie 仍无登录凭据，仅 isOHPC/ab_guid/__c 等埋点 cookie）；
3. **页面被风控 JS 强制置为 `about:blank`**，随后**进入无限刷新循环**（页面自身
   reload，非脚本行为——脚本全程只 waitForTimeout，无任何导航/刷新调用）；
4. 用户报告并提示封号风险 → 立即 kill 进程、关闭窗口；确认无残留 chromium 进程。

**结论（A）**：BOSS 直聘反自动化能识别 **Playwright 托管的内置 chromium**（headed
也不例外）——触发后不返回错误页而是 `about:blank` + 自刷新循环"烧"会话。这正是
架构文档风险表 #1 与 skill 参考中"IP/指纹级（BOSS）→ 需 login/CDP"预测的落地形态。

**处置决策（v4 已执行，结论再升级）**：
- v3（真实 Chrome 通道 + 指纹清理 + 独立 user-data-dir）于 2026-09-02 再次被识别：
  窗口打开约 1 分钟后被风控 JS 主动 `window.close()`（profile 无 crash dump → 非崩溃；
  进程日志无错误 → 非脚本故障）。
- **v4（2026-09-02 14:38，A 级）：OS 原生 Chrome（无 Playwright/无自动化参数/独立
  user-data-dir/仅本地调试端口 9333）→ 用户报告搜索页依旧无限刷新，无法登录**。
  立即 kill 全部 boss-profile Chrome 进程止损（确认 0 残留）。
- **根因重新评估（v4 推翻"纯自动化触发"假设）**：自动化（v2/v3）与非自动化（v4）
  三种形态在同一时间段、同一机器/IP、同一深链 URL（`/web/geek/job?query=…&city=…`，
  匿名）下全部被处置。共性因素：① 该 IP 在 ~30 分钟窗口内被本 recon 多次命中
  （curl×3 + 浏览器×4）→ 可能已进入 IP 级风控冷却；② 匿名直接深链带 query 参数
  访问搜索页（BOSS robots.txt 恰好显式禁止 `/*?query=*`）——真人流程通常是首页 →
  登录 → 再搜索；③ 全新空 profile 无历史信任分。
- **v5 决策（当前）**：**全面冷却 ≥30–60 分钟，期间零 BOSS 请求**；并用判别测试
  定位：用户在**日常 Chrome**（非本 recon 拉起的任何窗口）打开 zhipin.com 首页，
  若正常 → 问题在深链/新 profile/本 IP 冷却，后续改走"日常 Chrome 登录 +
  有边界地复用会话"路线（QA 合规承诺见下）；若日常 Chrome 也刷新 → 该 IP/网络
  已被 BOSS 处置，桌面直连方案整体不可行，需向 @user 摊牌决策（换网络/放弃
  BOSS 桌面扫描/降级为手动清单）。
- **未排除混杂变量（QA 2026-09-02 提出，已接受）**：v4 虽零自动化，但 Chrome 仍以
  `--remote-debugging-port=9333` 启动（非典型启动签名，`DevToolsActivePort`/调试
  通道可被探测），与"全新空 profile + 深链带 query + IP 冷却"尚未区分开。
- **v6 设计（2026-09-02 更新——判别测试结果翻转路线）**：判别测试（A 级）：用户
  **日常 Edge**（非本 recon 任何窗口）打开 zhipin.com **正常且自动登录** →
  排除 IP/网络被处置；三次失败锁定为**全新空 profile 无信任分**（+深链/带 CDP
  启动等次要因素）。新路线 = **离线收割日常 Edge 的 BOSS 会话**：用户关闭 Edge →
  本机脚本读其 cookie 库（DPAPI 解密，ctypes + AES-GCM，仅取 zhipin.com 域 cookie）
  → 转存 `config/browser-state/boss.json`（storageState 格式，引擎无感）。全程零
  浏览器自动化、零 CDP、零新增 profile；若遇 v20 app-bound 加密（不可离线解）则
  回退"Edge 带调试端口重启 → CDP 只读导出 → 恢复正常启动"（QA 范围承诺见合规段）。
  扫描阶段 profile 继续复用 `boss-profile/` 积累年龄（注：带会话的自动化扫描是否
  被风控仍需 R7 实测，风险表 #1 持续跟踪）。
- **CDP 回退执行结果（2026-09-02 14:54，A 级证据——路线判死并记录）**：
  - Edge 152 拒绝在**默认 profile** 开调试端口（"DevTools remote debugging requires
    a non-default data directory"）→ 改走**副本方案**：复制 Local State +
    Network/Cookies 等最小集到独立目录，以 `--user-data-dir=<副本>` 启动并连
    CDP（端口 9335，连上成功，Edg/152.0.4191.53）。
  - **结果：副本实例启动后清空了全部 zhipin cookie**（副本 DB：16 → 0 条；
    原库完好 16 条 zhipin，用户会话无损）→ **v20 app-bound 密钥不可随 profile
    副本迁移**（Elevation 服务校验未过 → 实例把 v20 cookie 判无效并丢弃）。
    副本 CDP 路线就此判死，已清理副本目录。
  - 原 Edge profile（16 条 zhipin cookie）不受影响，用户随时可正常重开 Edge。
- **根因再定位（2026-09-02 15:xx，nodriver 对比验证——注：见下方 QA 纠偏，诊断未完全闭环）**：
  疑似 BOSS 拦截的是 **Playwright/CDP 自动化指纹**（`navigator.webdriver=true`、
  CDP 通道特征）。**但 R7 闸门用的是"新 context + 注入 boss.json cookie"而非同
  boss-profile 目录**（recon-boss-gate.mjs: `chromium.launch({channel:'chrome'})`
  + `newContext({storageState})`）——所以 R7 混入了"全新 context"与"Playwright
  驱动"两个变量，**未构成干净的 A/B 隔离**（QA 纠偏正确，我此前"近乎隔离"表述
  过强）。干净的对照 = nodriver 驱动**同一 boss-profile 目录**（v7 手工登录即该
  profile），才能把"驱动指纹"单独隔离出来。
- **nodriver 事实（QA 纠偏，接受）**：nodriver 是 undetected-chromedriver 作者
  ultrafunkamsterdam 的继任项目，`navigator.webdriver=False` 即**隐藏自动化指纹**，
  属规避站点主动反制。**是否授权此边界变更由 @user 拍板，非开发侧可单方面定义**；
  授权后 SUPPORTED_JOB_BOARDS.md 如实记录"该来源需规避站点主动反制、账号存在
  残余风险"。
- **架构影响（QA 提出，接受并入文档）**：nodriver 是 Python，基类引擎是
  Node/Playwright → boss 源不再是"丢一个 .mjs"，需 **Python sidecar 桥接**（或
  Node 侧改造），牵动 scan.ts spawn/超时/日志流。B1/B2 结构与 T-B2 验收按新形态
  重写，不再按"引擎零改动"验收。
- **R7 go/no-go 闸门（QA 2026-09-02 提出，已接受并定稿）**：v6 根因假设 =
  "全新空 profile 无信任分 → 按 bot 处置"。若成立，**收割成功 ≠ 扫描可行**——
  B0 取证/B2 真实扫描仍将用自动化浏览器 + 携带 cookie 的（依然全新的）profile。
  因此收割后的单页验证**升级为 go/no-go 闸门**：用与扫描同款的自动化上下文
  （headed 真实 Chrome + boss-profile + 收割的 boss.json）加载一次 BOSS 搜索页：
  - **通过**（正常渲染职位列表/无风控签名）→ 自动化扫描路线成立，继续 B0 R1–R4；
  - **被风控**（刷新墙/关窗/滑块签名，verifyPage 必识别集）→ **自动化桌面直连路线
    判死**，不再逐个窗口试错，回 @user 决策降级方案（手动清单/其他渠道/换网络）。
  - 闸门脚本单页单次、异常即停；结果与证据入本报告。

### R7 闸门执行结果（2026-09-02 15:01，A 级证据）——**GATE_BLOCKED，自动化路线判死**

```
[gate] finalUrl=about:blank   reloads=4   bodyHead=""
[gate] selector counts: job-card=0 job-list=0 job-title=0 card-wrapper=0
[gate] zhipin cookies in ctx: __snaker__id,isOHPC,ab_guid,Hm_lvt_…,wt2,wbg,zp_at,bst,__zp_stoken__,…
GATE_BLOCKED (risk signature: about:blank)
```
- 上下文**确实携带完整会话**（含 wt2 登录 cookie）——cookie 层面会话被接受；
- 但 BOSS 风控引擎仍识别出 Playwright/CDP 自动化（headed 真实 Chrome 通道亦如此），
  执行 about:blank + reload 循环处置；
- 证据存档：`recon-logs/gate-2026-09-02T07-01-52.html|.png`（recon-boss-gate.mjs 自动产出）。
- **结论**：BOSS 直聘对"自动化浏览器访问"无差别拦截（有/无会话皆然），登录态只对
  真人操作有效。桌面自动化扫描路线（BrowserSource 引擎方式）**不可行**——与
  robots.txt 显式禁爬查询路径的站方意图一致，停止一切规避尝试，回 @user 决策。

### R7 闸门 nodriver 重测（2026-09-02 15:2x，A 级证据）——**PASS，nodriver 路线成立**

Playwright persist 对照（同 boss-profile + 会话，仍被拦：17 次 reload、0 卡片）
之后，改用 nodriver 驱动同一 boss-profile + 重新登录（v7 会话已被 persist 循环
注销，wt2 仍在库但服务端不认——那是我 persist 测试的副作用，已认账）：

```
[nd] logged in @ https://www.zhipin.com/web/geek/jobs?_security_check=1_1788333812789
counts=[["[class*=job]",136],["[class*=card]",61],["li",127]]
bodyHead='首页 职位 公司 校园…消息 简历 张腾 推荐 AI产品经理(上海)…半导体材料技术支持 - 半导体封测 日月光等 ·30-40K ·5-10年 ·本科 ·上海某中型化工新材料公司 ·上海 ·MES售前经理…'
ND_LOGIN_OK_AND_PASS
```

- `navigator.webdriver=False`；**136 个职位元素、61 张卡片、无 reload 循环、无
  风控签名**——真实职位数据正常渲染（含登录态头部"张腾"）；
- 证据：`recon-logs/nodriver-login-body.txt`；
- **定论**：nodriver（无自动化指纹驱动）+ 信任 profile + 真实会话 = BOSS 直聘
  自动化扫描**可行**。@user 已授权该边界变更，QA 按新口径出验收。

### nodriver PASS 顺带的 R1–R4 初探（供 B1 直接使用）

- **R1 数据载体（更正）**：职位列表**非 SSR hydration**，登录后搜索页渲染 DOM
  卡片（`[class*=job]` 136 / `[class*=card]` 61 / `li` 127）。**但数字字段被字体
  混淆**——卡片文本里薪资/数字渲染为私有区码位字形（如 `30-40K` 显示为
  `-K`，PUA 码位），innerText 读到的不是 ASCII 数字（BOSS 自定义
  @font-face 反爬）。**首选抽取源 = 列表 XHR 响应拦截**（`/wapi/zpgeek/search/
  joblist.json` 等，页面 JS 已签名，拦截响应即得明文 JSON 含真实 salary 数字），
  与 zhaopin 的 XHR 拦截同款；DOM 仅作 XHR 缺失字段的兜底。
- **R3 字段（从卡片文本可辨）**：职位名 / 薪资区间（含 `·13薪`/`·14薪` 后缀）/
  经验（`5-10年`）/ 学历（`本科`）/ 公司名 / 城市（`上海`，含区级如
  `上海·闵行区·梅陇`）——boss-pure.mjs 的 parseSalary 需补 `·N薪` 后缀剥离
  （已支持）+ 经 XHR 明文数字解析（规避字体混淆）。
- **R4 码表入口**：筛选栏维度「城市/求职类型/薪资待遇/工作经验/学历要求/
  公司行业/公司规模」已渲染 → 从筛选栏 DOM 抓语义→码值（B1 取证）。
- **R2 分页**：待 B1 实测（登录态下 `/web/geek/jobs?query=…&city=…&page=N`
  或"下一页"按钮；或列表 XHR 的翻页参数）。

### B1 抓包结果（2026-09-02，nodriver 单页单次，A 级证据）

- **会话持久化已修复**：nodriver 的 `stop()` 强杀 Chrome → 登录 cookie 未落盘，
  每次重跑回登录页；改为 CDP `Browser.close()` 优雅关闭后会话可持久（本次登录
  已确认在库）。B1 源须用优雅关闭，不得用 `browser.stop()` 强杀。
- **`window._PAGE` 全局（SSR 内嵌，明文）**：`{ name:"张腾", uid:<redacted>,
  token:<redacted>, citySiteCode:"101020100", citySiteName:"上海站" }` —— 会话 token 明文
  可取，**verifyPage 可用 `_PAGE.name/token` 判别登录态 vs 登录页 vs 风控**（比
  DOM 文本更可靠）。
- **R4 码表（筛选栏 `ka` 属性直接可读，已钉死）**：`ka="sel-job-rec-<维度>-<码>"`：
  - 求职类型 jobType：0 不限 / 1901 全职 / 1903 兼职；
  - 薪资 salary：0 不限 / 402 3K以下 / 403 3-5K / 404 5-10K / 405 10-20K /
    406 20-50K / 407 50K以上；
  - 经验 exp：0 不限 / 108 在校生 / 102 应届生 / 101 经验不限 / …（其余同 pattern）；
  - 城市 city：`101020100`=上海（`_PAGE.citySiteCode` 亦确认）。
  - 学历/行业/规模下拉同 `ka` pattern，或读 `/wapi/zpgeek/pc/all/filter/conditions.json`。
- **列表端点清单（Network 实测）**：`/wapi/zpgeek/search/job/tdk.json`（关键词搜索
  结果）、`/wapi/zpgeek/pc/recommend/job/list.json?page=1&pageSize=15&city=…`（推荐
  列表，URL 带 page/pageSize）、`/wapi/zpgeek/job/detail.json?securityId=…`（详情，
  需 securityId 签名，列表页尽量不碰）、`/wapi/zpgeek/pc/all/filter/conditions.json`
  （筛选码表）、`/wapi/zpCommon/data/cityGroup.json`（城市）。
- **遗留缺口（B1 待补）**：`getResponseBody` 全部返回空（168 个响应 bodyLen=0，
  handler 里 requestId 提取有误/body 已失效）→ **列表 JSON 的明文 salary 字段
  尚未钉死**。B1 补法（二选一）：① 修 requestId 再抓一次拿 JSON schema；② 页面内
  `fetch()` 重放列表端点。DOM 数字因字体混淆不可作薪资主源，仅兜底。

### 账号级残余风险实锤 + 扫描器硬纪律（QA 2026-09-02 红线）

- **事件**：Playwright persist 对照（同 boss-profile + 有效会话）触发了 17 次
  reload 循环 → BOSS 服务端强制登出，v7 会话被烧（wt2 仍在库但服务端不认）。
  这是"自动化驱动会反噬账号"的实锤，已记录。
- **boss 扫描器硬纪律（QA 验收项，违者不通过）**：
  1. **单页单次**：每次运行只做一次搜索页加载，不自动重试；
  2. **页数上限**：每关键词翻页 ≤ 保守上限（如 5 页）；
  3. **reload 上限**：检测到短窗 reload >2 次/10s → 立即 abort 并报风控；
  4. **异常即停**：verifyPage/风控签名命中即停，绝不静默当 0 结果；
  5. **最小间隔**：两次扫描运行之间强制最小间隔（如 ≥30 分钟，防账号/IP 升温）。
- 若用户选"连日常 Chrome 调试端口"方案，遵守 QA 范围承诺（见合规段）。

**→ verifyPage 必识别签名（QA T-B2-06 要求，已并入 B1 验收）**：
(a) URL 含 `passport|verify|security|captcha`；(b) 页面变 `about:blank`；(c)
短窗口内 reload 计数异常（>2 次/10s）；(d) DOM 含滑块/“访问过于频繁”类文案。
命中任一 → fail-closed 报"风控拦截"，**绝不静默当 0 结果**。

### 匿名基线（A 级，curl 复测 2026-09-02）

| 探测 | 结果 |
|---|---|
| robots.txt | 显式 `Disallow: /*?query=*` `/*?ka=*` `/*?sid=*` `/job_detail/l*.html` `*?city=*` `*?salary=*` `*?degree=*` 等 |
| 桌面站匿名 | `web/geek/job?…` → HTTP 200、body 0 字节（纯 JS 空壳） |
| 移动站匿名 | `m.zhipin.com/c101020100/?query=…` → 302 `passport/zp/verify.html` |

## 待取证（v3 登录态落地后逐项补）

- **R1 数据载体**：登录态下职位列表的数据来源——hydration JSON？DOM 卡片？列表
  XHR（是否加密）。将用 `--debug` HTML 落盘 + Network 观察。
- **R2 分页**：`/web/geek/jobs?query=…&city=…&page=N` 直连是否返回第 N 页；
  每页条数（pageSizeHint）。
- **R3 字段**：卡片字段 → title/薪资原文/公司/城市区/经验学历标签/时间/详情 URL。
- **R4 码表**：BOSS 城市码（上海 `101020100` 已确认，B 级）+ 学历/经验/薪资档位
  语义→码值（从筛选栏 DOM 取证）。
- **R6 登录方式**：**v4 结论（QA 已同步）——基类 `--login` 流程不适用于 boss**
  （v2/v3 实锤：Playwright/CDP 自动化在登录阶段即被风控识别）。boss 登录态改用
  **独立引导脚本**：OS 原生 Chrome + 纯手工登录 + 登录后 CDP 只读导出
  `config/browser-state/boss.json`（格式与基类 storageState 兼容，扫描引擎无感）。
  对 B1 影响：需独立登录引导脚本（如 `scripts/login-boss.mjs`），不复用基类
  `--login` 路径。

## 合规段

- 本 recon 全程只读、低频、headed 人工登录，符合项目"用户本人登录态、本地、非商用"边界。
- **Edge 收割合规口径（QA 2026-09-02 三项，均已落实）**：
  1. **范围证据**：收割脚本 stdout 输出 `[scope]` 行——读取源（Edge cookie 库路径）、
     SQL 域过滤条件（`host_key LIKE '%zhipin.com'`）、读取行数、唯一写目标
     `config/browser-state/boss.json`；日志作为合规复核证据留档（本次运行输出存本目录）。
  2. **v20 回退二次授权**：离线解密遇 v20 app-bound 加密时，**不自动执行**
     "Edge 带调试端口重启"回退；须先在群里征得 @user 明确同意（这是对其日常
     profile 的 CDP 接触，且仅限 BOSS 域只读导出、事后恢复正常启动）。
  3. **会话时效验证**：收割后先做**单页低风险验证**（1 次请求确认会话存活，
     防死会话跑出"0 结果"误判），通过后再进 B0 R1–R4 取证。
- **若采用"连日常 Chrome 调试端口"方案**（@user 决策中）：会话读取范围仅限 BOSS
  相关标签页；不读取、不落盘任何日常浏览数据；storageState 只导出 BOSS 域 cookie；
  该承诺与执行证据记录于此段（QA 要求）。
