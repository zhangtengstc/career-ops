# 缺陷登记表 — Explore「复制链接解析」验收（defect-log）

- 维护：@qa ｜ 状态说明：只报不修；修复由 @carreer-ops 落地，QA 复验。

---

## D-001（P2，修复中/自曝）
【标题】boss `--parse-link` 的 company 选择器首匹配命中「代招方」而非实际招聘方
【环境】P1 交付，boss.py `--parse-link`；实例岗位：拼多多集团-PDD 数据分析师-正式批
【复现步骤】
1. 取一「代招/RPO」boss 岗位详情链接（招聘方 拼多多集团-PDD，代招方 上海从鲸信息技术）；
2. 运行 boss.py `--parse-link <url>`；
3. 观察返回 company 字段。
【期望行为】company = 实际招聘方（拼多多集团-PDD，与列表态 brandName 一致）
【实际行为】company = 上海从鲸信息技术（`.company-name` 选择器首匹配命中代招方实例）
【证据】@carreer-ops P1 交付自曝（2026-09-02，群记录）
【影响范围】代招/RPO 类 boss 岗位卡片 company 字段错误；直招岗位不受影响；title/location 正确
【建议】精化选择器定位招聘方节点（区分招聘方 vs 代招/RPO 的 DOM 结构），并补含多 `.company-name` 实例的 fixture 单测
【验收回归】修复后 T-P1-03 增加断言：代招类真实链接 company = 招聘方；直招类链接 company 不回归

## D-002（P2，待定因 — 复验受阻）
【标题】boss `--parse-link` API 返回 502 误导错误；直接跑 boss.py 同 URL 成功 —— 路由 spawn 环境疑缺陷
【环境】`/api/explore/parse-link` route.ts（spawn boss.py --parse-link）；dev server :3000（PID 14392，非 @qa 启动）
【复现步骤】
1. 直接 shell：`python browser-sources/boss.py --parse-link <拼多多实链>` → 成功返回 documentTitle/metaDesc ✓（复验 2 次）；
2. POST /api/explore/parse-link 同 URL → 502「BOSS 页面结构可能已变更」×2（间隔 90s 冷却后仍复现）。
【期望行为】API 与直接调用结果一致，返回 offer
【实际行为】route spawn 的 boss.py 返回了 JSON（非 spawn 失败——错误文案是「结构可能已变更」分支而非「风控/需登录」分支），但 title/company 解析为空
【证据】QA 实跑输出（群记录）：zhaopin API 200 ✓ 对照；boss 直跑 ✓ / API 502 ×2
【根因假设（未证实）】route.ts spawn **未设 `PYTHONIOENCODING=utf-8`**（boss.mjs spawnSidecar 有设），且裸 `python` 依赖 PATH——若 dev server 非 UTF-8 环境启动，子进程 stdout 走 cp936，Node 按 utf-8 解码致中文乱码 → parseBossMeta 正则失配 → 空 title → 误导性错误。编码核对：本 shell env PYTHONUTF8=1/PYTHONIOENCODING=utf-8，python stdout=utf-8 ✓；但 :3000 服务进程 env 未知、非本会话启动。
【影响范围】boss 链接解析在特定 server 启动环境下全失败且报错误导；zhaopin 不受影响（进程内 fetch）
【建议】route spawn 与 boss.mjs 对齐：显式 `env: { ...process.env, PYTHONIOENCODING: 'utf-8' }` + python 解析路径可配置；@carreer-ops 修后 QA 复验
【复验受阻】需重启 :3000 dev server（PID 14392 非 QA 启动，杀进程需 @user 授权或由 dev 侧自测复现）

## D-003（P2，修复中 — @carreer-ops 排查）
【标题】boss.py --parse-link 在 Chrome/profile 争用下 teardown 崩溃：Event loop is closed、exit 1、stdout 空
【环境】boss.py `--parse-link <job_detail/25f29d76….html>`（canonical 去参 URL）；存在 10 个 chrome 进程（部分疑似 nodriver 残留）
【复现步骤】
1. 有 nodriver/Chrome 实例占用 boss-profile（或刚有实例关闭）时运行 parse-link；
2. 连续两次：exit 1、stdout 空，stderr `RuntimeError: Event loop is closed`（asyncio base_subprocess close 时序）。
【期望行为】正常返回 documentTitle/metaDesc JSON 或明确错误帧
【实际行为】teardown 崩溃、无输出 → API 层空输出被映射为误导性「风控拦截或需登录」502
【证据】QA 实跑 stderr traceback（2026-09-02）；exit=1/stdout 空 ×2
【影响范围】boss 链接解析在高负载/残留实例场景全失败且错误文案误导；疑似也是 @user 贴 `25f29d76…` 链接失败的根因
【建议】隔离 teardown（`browser.send(cdp_browser.close())`/`aclose()` 加 try/超时/事件循环守卫），崩溃时不静默 exit 1，输出错误帧；顺带核 profile 锁竞态
【验收回归】修复后：无残留 Chrome 场景 parse-link 稳定；有残留实例场景给出明确错误而非误导文案

---

## 登记中（Open，非缺陷，验收前瞻）
- P3 前瞻：parse-link 卡片无 salary，pipeline 入库需确认 salary 列可空（见 test-plan T-P3-01）
- P3 前瞻：boss 卡片 url 建议 canonical 去参（securityId/ka 为会话签名，同一岗位多次贴会因参数不同被 url 去重误判为两条）
