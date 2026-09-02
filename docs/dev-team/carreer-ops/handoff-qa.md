# BOSS直聘 来源 — 开发侧移交清单（handoff-qa）

- 移交方：@carreer-ops ｜ 接收方：@qa
- 日期：2026-09-02 ｜ 需求：全面支持 BOSS直聘 作为有状态来源
- 关联文档：`architecture-boss-zhipin-source.md`、`dev-task-breakdown.md`、`recon-report.md`（同目录）

## 1. 改动文件清单

| 文件 | 改动 |
|---|---|
| `browser-sources/boss.py` | 新增：nodriver sidecar（登录 handoff / 搜索 / Vue `jobList` 明文抽取 / 分页 / reload-loop abort / 优雅关闭 / boss.json 标记） |
| `browser-sources/boss.mjs` | 新增：Node 包装（spawn sidecar + normalize + title/location 过滤 + 去重 + `--jsonl` 契约，复用 scan.mjs） |
| `web/src/lib/explore.ts` | `LoginSource` 联合 + `LOGIN_SOURCES` + `LOGIN_LABEL` 加 `"boss"` |
| `web/src/lib/login-intent.mjs` | `LOGIN_SOURCE_PATTERNS` 加 `{id:"boss", re:/boss|直聘|zhipin/i}` |
| `portals.yml` | 新增 `boss_searches:`（数据分析/BI/用户运营） |
| `tests/browser-source.test.mjs` | 加 6 条 boss 纯函数用例 |
| `web/tests/lib/login-intent.test.mjs` | 加 2 条 boss 路由用例 |
| `docs/SUPPORTED_JOB_BOARDS.md` | 加 BOSS直聘 行（nodriver + 合规授权 + 残余风险 + 硬限制） |
| `.gitignore` | 加 `docs/dev-team/**/recon-logs/` |

## 2. 自测证据（开发侧）

- `node test-all.mjs --only browser-source` → **40 passed / 0 failed**（含 6 boss）；
- `node --test web/tests/lib/login-intent.test.mjs` → **16 passed / 0 failed**（含 2 boss）；
- `npm run lint`（根）→ 601 .mjs 语法通过；
- `npm run typecheck`（web）→ tsc 无错误；
- 真机 dry-run：`node scan-browser-source.mjs boss --keyword 数据分析 --dry-run` →
  **75 条真实岗位**（5 页 × 15，分页生效），title/location 过滤与去重 0 误伤，
  未写 `data/pipeline.md`（dry-run 不污染，QA 已抽查确认）。

## 3. 已知限制 / 风险（QA 需纳入验收口径）

1. **薪资主源 = Vue 内存态**（`jobList[].salaryDesc` 明文），非 DOM（DOM 数字被字体
   混淆）。**若 BOSS 前端 Vue 树结构变更 → `read_state` 返回空 + 明确告警**
   （"Vue state not found"），**绝不停默 0**——与"真·空结果"区分（复用基类空结果/
   改版告警纪律）。
2. **postedAt 缺失**：BOSS 列表无发布时间字段，Job 不带 postedAt（契约允许）。
3. **账号残余风险**：开发期一次 17-reload 循环触发过服务端强制登出（已记录）。硬纪律
   已内置：单页单次、页数上限（默认 5）、reload >2 次/7s 即 abort、风控墙/空白即停、
   优雅关闭持久会话。**验收勿提高 max-pages 激进测试**。
4. **登录态载体是 profile 目录**（`config/browser-state/boss-profile/`），非单文件；
   `boss.json` 是 web fail-fast 用的标记文件（boss.py 登录/扫描后写入）。
5. **nodriver 合规边界**：用户已授权（规避自动化指纹、本人账号、本地、低频、不外发、
   不自动过验证码），已写入 SUPPORTED_JOB_BOARDS.md + recon-report 合规段。

## 4. 复现步骤（QA 功能验收用）

```bash
# 首次（一次）：登录 handoff，弹 nodriver Chrome 窗口 → 扫码/验证码 → 自动落盘
node scan-browser-source.mjs boss --login

# 单关键词 dry-run（不写库）
node scan-browser-source.mjs boss --keyword 数据分析 --dry-run

# 机器可读流（web 同款）
node scan-browser-source.mjs boss --keywords 数据分析,BI --dry-run --jsonl
```

## 5. 验收口径映射（对齐 QA 四条）

| QA 口径 | 对应 |
|---|---|
| 静态验收 | §1 清单 + recon-report R1–R4 证据 |
| 功能验收 | §4 复现 + 75 条 dry-run 证据 + web 分组/AI 路由 |
| 异常验收 | 无登录态告警、reload-loop abort、风控墙即停、Vue 树变更告警 |
| 回归验收 | zhaopin 单测 + CLI 冒烟（boss 未触碰 zhaopin.mjs/引擎） |
