# Explore「复制链接解析」— QA 验收测试计划（v0.1）

- 需求期：2026-09 第二期（dev-team 协作，planning-with-files 驱动）
- 计划：`.planning/2026-09-02-explore-paste-link-parse/`（@carreer-ops）
- 状态：v0.2 —— P0/P1 验收通过（QA 实跑，2026-09-02），P2 设计中（UI spec 已出，待实现）
  - T-P0-01/T-P0-02、T-P1-01~05 全部 ✅；缺陷 D-001/D-002 已修复并复验关闭（见 defect-log）
  - P2 注意：@design-agent UI spec 提议 linkedOffers 独立数组（不混入 scan offers）——T-P2 系列按该契约验收
  - placeholder 语言（中文 vs 英文）待 @user 拍板
- 基线：HEAD `298093c` + BOSS 来源改动（未提交）+ 本期改动（未提交）

## 1. 验收目标

第三种输入方式：粘贴 zhaopin/boss 岗位链接 → 解析为 `DiscoveredOffer` 卡片 → 进入结果列表并可入库。
验收红线（沿用上期，不重述）追加两条：**zhaopin + Scan/AI 既有路径回归失败 = 不通过**；
**解析结果必须能回填 pipeline 既有去重链路（按 url），不得产生孤儿/重复卡片**。

## 2. 验收矩阵（对齐计划 P0–P3 与四条口径）

### P0 recon 产物验收（静态，依赖 findings.md）
| 编号 | 检查点 | 通过标准 |
|---|---|---|
| T-P0-01 | Z1 zhaopin 详情数据载体结论 | URL 形态 + 匿名 SSR 载体 + 字段映射证据（A/B 级） |
| T-P0-02 | Z2 boss 详情 `jobDetail` 字段 | 明文 salary 可读、normalize 映射复用性、需登录的边界说明 |

### P1 后端 /api/explore/parse-link
| 编号 | 检查点 | 通过标准 |
|---|---|---|
| T-P1-01 | 域名白名单 | 仅 zhaopin.com/zhipin.com（含子域），其他域名/非 http(s) 拒绝，返回明确 error |
| T-P1-02 | zhaopin 解析 | 真实链接 → 完整 DiscoveredOffer（url/company/title/location/salary/postedAt 契约） |
| T-P1-03 | boss 解析 | 真实链接 → 完整 DiscoveredOffer；未登录态 → 明确「需登录」提示，不崩溃 |
| T-P1-04 | 纯函数单测 | URL 分流/白名单/zhaopin 解析/boss normalize 全绿 |
| T-P1-05 | API 契约 | curl 两种链接各返回 200 + 完整卡片；畸形 URL → 4xx + error 文案 |

### P2 UI 粘贴入口（按 DesignAgent D1 结论：Scan 视图内联粘贴框，非第三 mode）
| 编号 | 检查点 | 通过标准 |
|---|---|---|
| T-P2-01 | 粘贴栏出现 | Scan 视图顶部粘贴栏（placeholder 提示粘贴智联/BOSS 岗位链接）+ 解析按钮 |
| T-P2-02 | zhaopin 粘贴渲染 | 粘贴 zhaopin 链接 → 解析 → 结果列表顶部出现正确卡片（source 徽章） |
| T-P2-03 | boss 粘贴渲染 | 同上（含需登录提示态） |
| T-P2-04 | 错误态 | 非法域名/非岗位链接/解析失败 → inline 错误，不停默、不崩 UI |
| T-P2-05 | mode/回归 | 未新增 ExploreMode；Scan/AI toggle 与 `?ls=` 深链行为不变 |

### P3 入库/测试/移交
| 编号 | 检查点 | 通过标准 |
|---|---|---|
| T-P3-01 | 入库链路 | 卡片走 addOffersToPipeline，与既有 offer 同链路，url 去重正确（重复粘贴不产生重复行） |
| T-P3-02 | 回归单测 | `node test-all.mjs` 全绿（新增用例覆盖）；web typecheck/lint 过 |
| T-P3-03 | 移交物 | handoff：改动清单/证据/已知限制/复现步骤 |

## 3. 未决/待定输入
- D1：DesignAgent 已定「内联粘贴框不做第三 mode」——**task_plan.md 的 D1 状态需同步更新**（QA 复核计划文件与实际一致）；
- D2（boss 解析会话策略）：QA 倾向 **每次解析独立短会话**（复用同 profile 登录态 + 优雅关闭 + 单页单次），
  **不做常驻 sidecar**——web UI 并发触发时须串行/节流，防多 Chrome 同 profile 冲突；待 @carreer-ops 定案后对齐。
- boss 匿名即墙 → 解析依赖登录态：验收需用已落盘的 boss-profile 会话（无登录态场景只验错误提示）。

## 4. 环境与证据纪律
同上期：每条结论绑命令输出/日志/截图；只报不修；无法核实记「未执行」。
