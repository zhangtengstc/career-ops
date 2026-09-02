# BOSS直聘 登录态来源 — QA 验收报告（acceptance-report）

- 验收方：@qa ｜ 交付方：@carreer-ops ｜ 需求期：2026-09 ｜ 日期：2026-09-02
- 基线：HEAD `298093c` + BOSS 来源改动（未提交）
- 关联：`handoff-qa.md`、`recon-report.md`、`architecture-boss-zhipin-source.md`（docs/dev-team/carreer-ops/）
- 配套：`test-plan-boss-zhipin.md`（docs/dev-team/qa/）

---

## 0. 总评

**结论：通过（PASS）**，附 2 条 P3 观察项与 3 条未实弹项（详见 §4–5）。

BOSS直聘作为有状态来源的功能补齐达到验收口径：静态/单测/功能/异常/回归五类抽查全过，
**未发现 P0/P1/P2 缺陷**。zhaopin 全链路回归未破坏（红线 1 通过）；合规边界按 @user 授权
执行并如实留痕（红线 2 通过）；证据不足项全部如实标注（红线 3 通过）。

---

## 1. 静态验收（对照架构 §4 清单与移交 §1）

| 检查点 | 结果 | 证据 |
|---|---|---|
| boss.py sidecar：路径单一权威解析 | ✅ | L35-39 `CAREER_OPS_ROOT`/`BOSS_PROFILE` env 覆盖 + 固定位置注释，无 parents[N] 魔法 |
| boss.py 优雅关闭 | ✅ | L190/L218 `cdp_browser.close()` + `aclose()` |
| boss.py reload-loop 检测 | ✅ | L143-151：7s 窗口 >2 navigations 即 abort |
| boss.py 风控/空态 fail-closed | ✅ | L74-81 risk_reason（passport/verify/security/about:blank）；L156 「Vue state not found」显式告警非静默 0 |
| boss.py 登录态判别 | ✅ | L84 logged_in + `_PAGE` token 判据（recon 记录） |
| boss.mjs 过滤/去重复用 scan.mjs | ✅ | L23-28 import；L179-207 与 zhaopin 同语义 |
| 改动面 = 架构 §4.1 声明 | ✅ | git diff：6 tracked + 2 untracked（boss.mjs/boss.py），与 handoff §1 一致；scan.ts 零改动（未出现在 diff） |
| 合规留痕 | ✅ | SUPPORTED_JOB_BOARDS.md BOSS 行：nodriver 访问模型 + @user 授权 + 残余风险 + 硬限制原文在案；.gitignore 加 recon-logs |

## 2. 自动化测试（QA 实跑，非引用开发数据）

| 套件 | 命令 | 结果 | 证据 |
|---|---|---|---|
| browser-source 单测（含 6 boss） | `node test-all.mjs --only browser-source` | **40 passed / 0 failed** | 实测输出 Results: 40 passed |
| login-intent 单测（含 2 boss） | `node --test web/tests/lib/login-intent.test.mjs` | **16 passed / 0 failed** | 实测输出 pass 16 fail 0 |
| 根 lint | `npm run lint` | 601 .mjs 通过 | 实测输出 |
| web typecheck | `npm run typecheck` | tsc 无错误 | 实测输出 |

## 3. 功能/异常/回归验收（QA 实跑）

| 编号 | 场景 | 结果 | 证据 |
|---|---|---|---|
| T-B2-02 | boss dry-run 真机抽取 | ✅ 真实岗位多条（滴滴/携程/Shopee/合合信息/卡方科技…，全部上海，title 命中数据分析语义） | QA 实跑输出（tail 25 行，见会话记录）；计数以 dev 自测 75 条为准（QA 遵守硬纪律未二次跑全量） |
| T-B2-03 | dry-run 不入库 | ✅ pipeline.md 含 boss/zhipin 行数 = 0；mtime 仍为 9月1日（本次会话前） | 实测 grep + ls |
| T-B2-01 | 登录态载体 | ✅ `config/browser-state/boss-profile/` 新鲜会话（mtime 16:09 即 QA 运行时刻，复用未重登）；`boss.json` 标记存在且 gitignored | 实测 ls + cat + 此前 git check-ignore |
| T-B2-07 | 无登录态告警（CLI 路径） | ✅ 代码路径存在：boss.py 未登录输出错误帧「not logged in — run --login first」（L209） | 代码阅读；UI 触发未实弹（见 §5-2） |
| T-B3-01 | Explore 双芯片 | ✅ 智联招聘 + BOSS直聘 芯片同屏渲染 | 浏览器实测 DOM：两 button 均存在 |
| T-B3-02 | `?ls=boss` 往返 | ✅ 载入后 BOSS 高亮（`border-brand/40 bg-brand-soft text-brand`）、智联 muted；href/search 保持 `?ls=boss` | browser_console className 实测 |
| T-B4-01/02 | AI 意图路由 | ✅ 单测覆盖「在BOSS直聘上找数据分析，上海」→ boss、zhaopin 路由并存 | 单测 16 passed（2 boss 用例实跑） |
| T-B5-02 | zhaopin CLI 冒烟 | ✅ `zhaopin --keyword java --dry-run` 正常完成（220 found，0 new，exit 0，无崩溃） | QA 实跑输出 |
| 异常（硬纪律） | reload-loop abort / 风控即停 | ✅ 代码内置（§1） | 静态验收；触发场景需真实风控，无法安全复现，如实标注 |

## 4. 观察项（P3，不阻断）

1. **O1（P3）Explore 芯片多选不写回 URL**：载入 `?ls=boss` 后点击智联芯片→双选，URL 仍为 `?ls=boss`（内存态与 URL 脱钩，刷新丢额外选择）。若 URL 定位为「初始深链」则属设计属性；若期望分享链接携带完整选择，需写回 codec。建议 @design-agent/@carreer-ops 确认语义并（如需）补文档或写回。
2. **O2（P3）CLI 无登录态时仍弹 Chrome**：`boss.mjs run()` 未先查 boss.json 标记，无登录态调用会 spawn sidecar 弹 headed 窗口后才报 not-logged-in。建议在 spawn 前 fail-fast 检查标记（与 web 同款），省窗口、省一次无谓启动。
3. **O3（P3）「30K以上」薪资映射为 `{min:30000,max:30000}`**：单值同时充任上下界，丢失「以上」语义，下游若按 max 评估可能失真。建议开发确认契约口径（如 max=null 或 min 单值语义），补注释或调整。

## 5. 未能核实项（如实标注，不脑补）

1. **T-B3-03（web UI 发起 boss 扫描的端到端渲染）未实弹**：CLI 同引擎已实弹验证 + 芯片/选择状态已验；为避免在验收中触发第二次真实 BOSS 扫描（硬纪律/最小间隔），未从 UI 点击 Scan 全流程。
2. **T-B3-04（无登录态 UI 提示文案）仅代码路径验证**：临时移走 boss.json 后页面未现内联提示（可能仅在点击 Scan 时触发）；为防误触发真实扫描未继续深挖，标记已恢复原状（mtime/内容核对一致）。建议开发补充该 fail-fast 的 UI 触发点说明或单测。
3. **reload-loop/风控触发实况**：真实风控场景需刻意触发（违背纪律且有账号风险），仅静态验证代码路径 + 引用 recon 期 R7/17-reload 事件记录。

## 6. 数据卫生与合规复核（QA 实跑）

- `git grep`（仅受版本控制文件）：`74458113 / 3Pkptvp8 / 223.166.60` 零残留 ✅
- 原始证据（recon-logs/）含未脱敏 token 但目录 gitignore、不入库；分享前须脱敏 ⚠️ 已记核查项
- 合规授权 + 残余风险 + 硬纪律：SUPPORTED_JOB_BOARDS.md 原文在案 ✅
- 本次验收全部操作只读或限于 `docs/dev-team/qa/` 报告目录与临时标记文件（已恢复）

## 7. 建议的移交动作

- @carreer-ops 对 O1–O3 三项 P3 作语义确认或注释补强（不阻断本轮验收）；
- @user 若需提交代码（git commit）可执行；QA 无提交权限亦不代为提交；
- 后续 web UI 全流程（UI 发起扫描）可在低峰期补一轮 E2E 作为增补验收。

---

✅ 自检：本次验收未修改任何被测项目源码/配置/数据文件；临时移动的 `boss.json` 已原样恢复（mtime/内容核对一致）；新增文件仅 `docs/dev-team/qa/` 下测试文档（用户指定目录）。
