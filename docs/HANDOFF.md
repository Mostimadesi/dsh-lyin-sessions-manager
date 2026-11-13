# 交接文档：dsh-lyin-sessions-manager

> 写给「接手后续维护的新会话 / 新维护者」。目标是让你在不读 5000 行源码的前提下，
> 20 分钟内能改一行、构建、验证、回滚。
>
> 最后更新：2026-11-13（v0.5.4 / package 3.8.0）

---

## 0. 一分钟上手

| 项 | 值 |
| --- | --- |
| 本机仓库路径 | `D:\DeepSeek Harness\workspace\plugins_helper\session-manager-unified\dsh-lyin-sessions-manager` |
| 分支 | `lyin/main`（上游用 `main`；本仓库 `origin` = 用户 GitHub，`upstream` = TOBYCAI） |
| 插件包名 | `dsh-lyin-sessions-manager`（**改包名要同时改** `build.mjs` 的 ModuleLoader banner） |
| package 版本 | `3.8.0`（上游 3.7.10 → 本分支因新增面板能力升 minor） |
| 目标宿主 | DSH **0.2.2-rc.1**（`D:\DeepSeek Harness`，nightly 通道） |
| 构建 | `npm run build` → 产出 `lib/index.js` + `lib/client.js`（**产物要提交**） |
| 测试 | `npm test`（= `node scripts/run-tests.mjs`，43 个测试文件） |
| 产物一致性 | `npm run check:dist`（**必须先 commit 再跑**，它用 `git diff --exit-code -- lib` 判定） |
| 生效方式 | 纯 `lib/client.js` 改动：**刷新浏览器页面**即可；`lib/index.js`（host）改动：重启 DSH |

三条最常用的命令：

```bash
cd "D:/DeepSeek Harness/workspace/plugins_helper/session-manager-unified/dsh-lyin-sessions-manager"
npm run build                      # 构建，末尾打印 build stamp
node --test tests/panel-sections.test.js   # 单跑某个测试文件
git commit -am "..." && npm run check:dist # 提交后再校验产物一致
```

---

## 1. 项目来历（读这段能避免走回头路）

- 上游：[TOBYCAI/dsh-sessions-manager](https://github.com/TOBYCAI/dsh-sessions-manager)（会话管理插件：回收站、跨工作区移动、血缘折叠、标签、双格式导出、预设、自动归档）。
- 本仓库是**个人分支**：fork 后只改插件身份（`package.json` 的 name、`cordis.patch.yml` 的 id、`src/index.js` 的 `export const name`），**刻意保留**了路由前缀 `/archived-sessions`、`STATE_DIR`、`data-dsm-*` 类名、slot id —— 目的是让上游 rebase 尽量少冲突（见 §12）。
- 另一个同类实现 `hkkz9522/dsh-session-manager` 只在 v0.1 调研阶段对照过（元数据层设计借鉴了它：标签 20/会话、优先级 1-5、备注 2000 字、待回看、API 认证门 fail-closed），**代码没有合并**。
- 版本号有两套，别混：
  - `package.json` 的 `3.8.0`：给 npm / 插件市场看。
  - commit message 里的 `v0.1` … `v0.5.4`：本分支的开发里程碑，只在 git log 里有意义。

---

## 2. 目录与模块地图

```
src/
  index.js              host 侧（3117 行）：42 处 registerRoute、存储、自动归档、meta/turn-kind/debug-log 路由
  client/
    index.jsx           客户端全部 UI（5601 行，纯手写 React，无 jsx 构建，esbuild 直出）
    logic.js            纯函数层（1013 行）：所有可单测的逻辑都放这里，UI 只做渲染
  api-auth.js           owner-only 认证门（createApiAuth → { check, wrap }）
  session-meta-index.js 元数据存储 meta-v1（priority/note/review）
  session-meta-cache.js meta 的内存缓存/批量读
  tag-index.js          标签存储（20 个/会话，名称 ≤32 码点）
  handle-era-ops.js     SessionHandle 世代的操作适配（删除/恢复/移动）
  lineage.js            子代理血缘（origin === 'subagent' && parentSession）
  auto-archive.js       自动归档（本机因缺活动时间实际不生效，见 §10）
  compat/persistence.js 存储格式世代适配
  zstd-frame.js         直接解码压缩日志帧（turn-kind 用）
scripts/
  run-tests.mjs         测试入口（预置 DSH_SESSIONS_MANAGER_NO_AUTH=1）
  compat-smoke.mjs      真实 cordis + 假服务，断言 41 条路由注册 + 认证门放行 owner
  rescue-smoke.mjs      复制真实 v4 日志到临时目录，跑 32 项破坏性矩阵
  check-session-health.mjs / check-upstream-contract.mjs / compat-runtime.mjs
tests/                  43 个 *.test.js（node:test）
docs/
  v01-meta-spec.md      v0.1 元数据层规格
  v01-交付与验证报告.md   四层验证栈的记录
  HANDOFF.md            本文件
lib/                    构建产物（已提交，别手改）
build.mjs               esbuild 双产物 + BUILD_STAMP 注入
cordis.patch.yml        插件对宿主的 patch 层（bundle.patch 指向它）
```

数据流（简版）：

```
宿主会话商店 (uiSession.sessions.list)  ──┐
宿主路由 /archived-sessions/sessions ─────┼─→ dsmActivityItems()/dsmMetaCache ─→ 选择器(纯函数) ─→ React 渲染
宿主 uiSession.sessionStatus ──────────────┘        (groupQuickAccess / recentActiveRows / markedRows / foldActivityItems)
```

---

## 3. 构建与产物

- `build.mjs` 用 esbuild 打两份：
  - `src/index.js` → `lib/index.js`（ESM host）
  - `src/client/index.jsx` → `lib/client.js`（CJS，外层包 `window.__ModuleLoader__.load({ id: 'dsh-lyin-sessions-manager', factory … })`）
- `__BUILD_STAMP__` 注入为 `${pkg.version}+${srcFingerprint}`，`lib/index.js` 里会出现一行
  `var BUILD_STAMP = true ? "3.8.0+xxxxxxxx" : "dev";` —— **这是正常的**，每次 build 都会改这一行，提交它。
- **历史事故**：`build.mjs` 的 ModuleLoader banner 里曾硬编码旧包名 `dsh-sessions-manager`，导致组合树按新名加载不到插件（`loaded without registering …`）。`check:dist` 抓不到这类问题，只有真实 web boot 能暴露。改包名时三处一起改：`package.json.name`、`cordis.patch.yml` 的 id、`build.mjs` banner。
- `lib/` 必须提交：本机安装用 `link:`，宿主直接读工作树里的 `lib/`，不提交也不影响本机，但会让别人拿到跑不起来的包。

---

## 4. 宿主契约（改 UI 前必读）

### 4.1 服务接入姿势

统一用 `ctx.inject(['服务名'], scope => …)`，**不要**在 apply 里直接 `ctx.get()`（服务常未就绪 → 拿到 undefined → 整块注册被静默跳过）。这是 v0.3.0–v0.3.3 反复「没反应 / 卡片时有时无」的根因。

```js
ctx.inject(['sidebarRightTabs'], (scope) => {
  const tabs = scope.sidebarRightTabs
  tabs.register({ id: RAIL_ID, kind: RAIL_KIND, priority: 'extension', title, guide: [{ id: 'attention', order: 25, … }] })
  scope.slots.inject('sidebar.right.pane.tab', () =>
    scope.slots.register({ name: 'sidebar.right.pane.tab', key: RAIL_ID }, () => <DsmQuickAccessPanel compact />))
})
```

要点：
- 注册表 API 是 **`tabs.register({...})`**，**没有** `define`。
- `guide` 数组决定右栏 guide 卡片（卡片点击 `open(kind)`，不走 commandId）。
- `sidebar.right.pane.tab` 是 `kind: "keyed", scope: "session"`：**标签必须挂在某个会话的右栏里**，所以代码里用 `dsmRailTarget()` 去找目标 sessionId。未匹配的 body 会渲染宿主兜底文案「这类内容还没有可用的查看方式。」（= `tab.unavailable`），看到这句通常是 slot key 写错。
- 主入口用 `sidebar.panellist` + `main` 全局面板（`DsmQuickAccessPanel`，非 compact）；`compact` 版给右栏。
- 侧栏 footer 按钮已按用户要求移除（全局面板是唯一入口）。

### 4.2 状态源

| 需求 | 来源 | 说明 |
| --- | --- | --- |
| running / pendingInteraction / completionUnread | `uiSession.sessionStatus`（`{ getSnapshot(), subscribe() }`） | 权威、响应式，覆盖全部会话（含折叠组） |
| 会话标题 / 备注 / 优先级 / 待回看 / 收藏 / 工作区 | `POST /archived-sessions/sessions` | 15s 节流，`dsmMetaCache` 存整行 |
| 活动时间（最近活跃） | `uiSession.sessions.list` 的 `updatedAt`（**数值**） | 见 §10，**不要**再用宿主列表的 updatedAt |
| 出错/中断归类 | `POST /archived-sessions/turn-kind`（读日志最后一条 `turn/end` 的 `reason.kind`） | 惰性、串行 ≤4/次，面板可见才跑 |

### 4.3 路由与认证门

- 42 处 `registerRoute(...)`；其中 41 条 `/archived-sessions/*` 由 compat-smoke 断言全部注册成功。
- 所有路由包 `createApiAuth(ctx).wrap`：owner-only、fail-closed（无 `connection` 服务时 503、非 owner 401）。
- 新增能力时**必须**走 `registerRoute`，否则绕过认证门。
- 测试里为了免认证会设 `DSH_SESSIONS_MANAGER_NO_AUTH=1`（`scripts/run-tests.mjs` 预置）；`tests/meta-routes.test.js` 会自己删掉这个变量以走真实门。

### 4.4 宿主事实与坑

- 宿主列表（`/archived-sessions/sessions`）在 SessionHandle 世代**没有 updatedAt**（根因：`src/index.js` 的 `collectUsage` 对 `entry.revision` 为字符串的分支提前 `return`，永不填 `mtimeById`）→ 「最近活跃」必须走 `sessions.list`。
- `--dsh-alias-*` 之类主题令牌存在于宿主 DOM（`--dsw-alias-bg-layer-1/3` 等），但没有稳定文档；需底色时**运行时实测祖先 backgroundColor**（`dsmFitPanel` 就是干这个的）。
- 宿主每 500ms stat 插件文件，经 `/plugins/events` SSE 推 `rebuilt` → 客户端换 fiber。所以**纯 client 改动刷新页面即可**。
- Web GUI 端口每次重启都变（曾 62333 / 50892 / … / 38471），URL 带一次性 token；token 无法程序化取得（见 §10 的 ego 记录）。

---

## 5. 客户端关键函数清单（改逻辑先找这里）

| 函数 | 位置 | 职责 |
| --- | --- | --- |
| `stateFromSessionStatus(status, {manualUnread, turnKind})` | logic.js | 宿主状态 → 面板状态（running/done/error/manual/feedback） |
| `groupQuickAccess(rows)` | logic.js | 关注区四组：进行中 / 待你处理 / 出错 / 刚完成·未读 |
| `foldSubagentRows(rows, lineage, titleOf)` | logic.js | **关注区**折叠：子代理收进父行，父行带 `▸ N 子代理` |
| `summaryCounts(rows)` | logic.js | 顶部摘要条计数 |
| `recentActiveRows(items, {windowMs=12h, limit=8, exclude})` | logic.js | 最近活跃区（默认 8 条） |
| `markedRows(items, {limit=6, exclude})` | logic.js | 已标记区（收藏/待回看/P1-P2 合并去重） |
| `foldActivityItems(items, lineage, titleOf)` | logic.js | **次级区**折叠（数据层合并：时间取子树最大、优先级取最紧急、计数累加） |
| `mergeActivityItems(storeRows, metaById)` | logic.js | 商店快照 + meta 缓存 → 统一行 |
| `agoLabel(ts, now)` | logic.js | 相对时间（未来/无效值返回空串） |
| `markBadges(item)` | logic.js | 徽标（★ / 待回看 / P1-P2） |
| `normalizeCollapsed(input)` | logic.js | 收起状态清洗（只认 `{key:true}`） |
| `dsmActivityItems()` | index.jsx | 商店快照 → 折叠 → 行数组（含 meta 合并） |
| `dsmEnsureHostTitles(force)` | index.jsx | 拉 `/sessions` 填 `dsmMetaCache`；`force` 绕过 15s 节流（面板打开时用） |
| `dsmRailTarget()` | index.jsx | 找右栏目标 sessionId（uiWorkspace 快照 → uiSession.current → 4 个 DOM 选择器 → 面板首行兜底） |
| `dsmFitPanel(el)` | index.jsx | 实测可用高度写 `max-height`；实测宿主底色写 `--dsmqa-head-bg` |
| `dsmProbeScroll(el)` | index.jsx | 落盘 7 层祖先的 `oy/ch/sh`（滚动排查） |
| `dsmDebugLog(channel, msg)` | index.jsx | POST `/archived-sessions/debug-log` → `~/.dsh/sessions-manager/debug.log` |

`logic.js` 里的函数全是纯函数，改它们要同步 `tests/*.test.js`（尤其 `tests/panel-sections.test.js`、`tests/quick-access.test.js`、`tests/subagent-fold.test.js`）。

---

## 6. 开发循环与调试（最重要的一节）

### 6.1 循环

1. 改 `src/client/*`（或 `src/index.js`）。
2. `npm run build`（必须；宿主读的是 `lib/`）。
3. 纯 client 改动 → **刷新浏览器页面**。host 改动 → 重启 DSH（或切换插件开关）。
4. 打开面板，读日志确认。

### 6.2 调试通道：GUI 没有 console，一切靠落盘

客户端 `dsmDebugLog(channel, msg)` → `POST /archived-sessions/debug-log` → 追加到：

```
C:\Users\<用户名>\.dsh\sessions-manager\debug.log
```

常用埋点（`grep` 这几个词就能定位问题）：

| 埋点 | 含义 |
| --- | --- |
| `session-list:store-ready` / `store-missing` | 是否拿到 `uiSession.sessions.list`（每次加载一行，长期保留） |
| `host-list:loaded items=… withUpdatedAt=… keys=[…]` | `/sessions` 载荷形状（首次一次，长期保留） |
| `panel:fit avail=… anc=… head-bg=…` | 面板实测高度与吸顶底色（每页面加载一次） |
| `panel:scroll 0:div.dsm-qa-main oy=… ch=… sh=… \| 1:…` | 滚动诊断：`ch > sh` 且 `oy` 可滚才算真能滚 |
| `api:exposed openSession=function` | `window.__dshSessionsManager` 已挂载 |
| `uiSession:ready` / `rail:probe2 tabs=true sr=true` | 服务就绪、右栏注册成功 |
| `rail:open-fail {id, via, tried}` | 「在右栏打开」失败原因 |
| `rail:body-rendered compact=true/false` | 右栏 tab 体在渲染 |

读日志示例（PowerShell）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\sessions-manager\debug.log" -Tail 40
Select-String -Path "$env:USERPROFILE\.dsh\sessions-manager\debug.log" -Pattern "panel:fit|rail:open-fail" | Select-Object -Last 10
```

### 6.3 真机 UI 验证

- 桌面 GUI 可用 `mcp__wincu__*`（`list_windows` → `find` → `screenshot`/`ocr`）。注意：**改代码热重载不会重挂载面板**，`panel:fit` 只有用户打开面板时才出现；要触发就请用户刷新/点开，或用 `find` 点「进行中的会话」按钮。
- OCR 中文偶有误识别，先 `find`（UIA）再 OCR 兜底。
- **不要**为了「让面板重挂载」去坐标点击导航：2026-11-11 这样做点偏过，切换了用户当前会话（仅视图，无数据改动），随后被用户 Esc 中止。用户明确要求过：不要自动操控鼠标键盘。
- ego 浏览器直驱（CLI）在当前机器**打不开 DSH GUI**：需要带 token 的 URL，而 token 只打印在 dsh web 启动输出里。详见 §10。

---

## 7. 测试与验证基线

### 7.1 命令

```bash
npm test                         # 全量（43 文件，约 413 项）
node --test tests/xxx.test.js    # 单文件
node scripts/compat-smoke.mjs 0.2.2-rc.1   # 真实 cordis 加载 41 条路由
node scripts/rescue-smoke.mjs              # 破坏性矩阵（需真实 ~/.dsh/sessions）
npm run check:dist               # 提交后校验 lib 与源码一致
npm run check:sessions           # 会话日志健康检查
```

### 7.2 本机基线（重要）

Windows 环境下有 **5 处既有失败**，与改动无关（在 pristine HEAD 上同样失败）：

1. `store: append/list/ack` 幂等类（临时目录 EBUSY）
2. `atomic write: 0o600` ×2（MSYS 下 stat 报 0o666/438）
3. `lineage-tree never decodes on the request path` / `cold cache returns null titles` ×2

判定规则：**失败集 ⊆ 基线集** 即通过。基线对照方法：

```bash
git stash push -u -q && npm test ; git stash pop   # 在 pristine 状态跑一遍
```

用户环境重启后如果失败数量变化，先确认是不是新增，再动手。

### 7.3 最近一次全绿记录

- build stamp `3.7.10+e4a8878a`（v0.5.4）
- 413 项 / 408 通过 / 5 基线失败
- `check:dist` exit 0
- 真机：摘要条 / 筛选框 / 折叠徽标 / 可收起分组 / 吸顶 生效（`panel:fit` 待用户下次开面板确认高度值）

---

## 8. 安装 / 生效 / 卸载（本机）

本机安装方式 = **link 到工作树**（改完就能用，不用重新安装）：

```powershell
# 路径含空格，必须用 8.3 短路径，否则 cmd 会拆参数
dsh plugin --profile desktop add "link:<短路径>"
# 实际登记结果（profiles/desktop/package.json）：
#   "dsh-lyin-sessions-manager": "link:D:/DEEPSE~1/WORKSP~1/PLUGIN~1/SESSIO~1/DSH-LY~1"
# node_modules 下有同名 symlink 指向工作树
```

- 插件由宿主按 profile 的 dependencies 加载（`dsh` 块声明 `bundle.patch` 与 `client.platform: "web"`）。
- **不要**用 `dsh --profile desktop --dump-config`：被 Electron 独占管理拒绝，属预期行为。
- 卸载：`dsh plugin --profile desktop remove dsh-lyin-sessions-manager`（或从 package.json 删依赖再 `npm install`）。
- 生效矩阵：
  - 只改 `lib/client.js` → 刷新页面（宿主 SSE `rebuilt`）。
  - 改 `lib/index.js` / 新增路由 → 重启 DSH（或插件开关切一次）。
  - 改 `cordis.patch.yml` / `package.json` 的 `dsh` 块 → 重启。

---

## 9. 存储与数据

宿主目录：`~/.dsh/sessions-manager/`（`C:\Users\<用户名>\.dsh\sessions-manager`）

| 文件 | 内容 | 写入方 |
| --- | --- | --- |
| `star.json` | 收藏集合（上游格式，v3） | 上游代码 |
| `tags.json` | 标签（v4，20 个/会话，名称 ≤32 码点） | 上游代码 |
| `session-meta.json` | **本分支新增**：`{ schemaVersion: "meta-v1", entries: { <sid>: {priority, note, review, …} } }` | `src/session-meta-index.js` |
| `saved-filters.json` | 管理面板预设视图 | 上游代码 |
| `pending-moves.json` | 排队中的跨工作区移动 | 上游代码 |
| `auto-archive.json` | 自动归档设置 | 上游代码 |
| `debug.log` | 客户端诊断日志（本分支） | `POST /archived-sessions/debug-log` |

`meta-v1` 语义（`setMeta`）：
- 省略某个键 = 保持原值；传 `null` / `''` / `false` = 清除。
- 校验是**拒绝式**：非法值抛 `code: 'DSM_META_INVALID'`，不会半存。
- 写盘纪律：tmp → rename，0o600，链式串行（与上游 star-index 同型）。

localStorage（浏览器侧）：
- `dsm-qa-style-v1`：外观预设 + 4 个细参数（宽/圆角/模糊/不透明度）
- `dsm-qa-collapsed-v1`：分组收起状态（`{ "group:running": true }`）

---

## 10. 已知限制与踩坑清单（省你几个小时）

### 宿主 / 数据

1. **宿主列表没有 updatedAt**（SessionHandle 世代）。别再指望 `/sessions` 带活动时间；「最近活跃」用 `uiSession.sessions.list`。
2. **自动归档在本机不生效**：`pickInactiveCandidates` 需要 `usage.hasActivityData`，而 `collectUsage` 的 handle 分支永不填 `mtimeById` → 恒返回 `skipped: 'no-activity-data'`。因此「收藏 = 豁免自动归档」这条语义在本机**观察不到**。
3. **收藏 / 待回看 / 优先级目前在行为上等价**（都只是标记），差别只在管理面板的视图（`SAVED_VIEWS` 里有独立的 `starred` / `review`）。「已标记」区只是三者合并视图。
4. 折叠工作区组内的会话行不渲染 → 也进不了旧 DOM registry（v0.4.0 起步进 uiSession，已解决；但 DOM 兜底路径仍有此限制）。

### CSS / 渲染

5. `max-height: 100%` 在百分比链断开时解析为 `none`（本机主面板紧邻父是 0 高 auto div）→ 必须用 `dsmFitPanel` 实测像素高度。
6. `.dsm-qa-sticky` 用负外边距铺满容器内边距，**数值必须与容器 padding 一致**（main 18/22，rail 10/12），否则内容从空隙露出。
7. 吸顶底色：`--dsmqa-head-bg`（运行时实测）> `--dsmqa-solid`（预设不透明兜底）> `#18181A`。旧的 `--dsmqa-bg/-radius/-blur/-border` 只被**已停用**的旧弹层消费，现役面板基本不读它们——改预设外观时别指望它们生效。

### 工具 / 环境

8. **asar 取证**：`D:\DeepSeek Harness\workspace\plugins_helper\everos-session-shim\asar-context.cjs`（`node asar-context.cjs <app.asar> <needle...>`）。haystack 按 **latin1** 解码 → **中文 needle 永远命不中**，只能用 ASCII 标识符；`app.asar` 是文件不是目录，别对它跑 grep。
9. **apply_patch 的转义坑**：要往文件里写 `\"`，`new_text` 必须传 `\\\"`；否则落成裸 `"`，package.json 直接变非法 JSON（`ERR_INVALID_PACKAGE_CONFIG … position 413`）。
10. **write 工具的 `\0` 坑**：源码里写 `\0` 会落成真实 NUL 字节，文件被判 binary；写 JSON 解析用的 `\x00` 要写成 `\\x00`。
11. **pwsh 不支持 `<` 重定向**（`RedirectionNotSupported`）：用 `Get-Content -Raw x | node …`。
12. **Node ≥18.20 拒绝无 shell 执行 `.cmd`**（`spawnSync npm.cmd EINVAL`）：Windows 下 `shell: true`，npm 用 `npm.cmd`。
13. **pwsh 管道会破坏多字节字符**：给 node 脚本喂中文可能触发 `SyntaxError: Missing catch or finally after try`；脚本里中文写 `'\uXXXX'` 或干脆纯 ASCII。
14. **ego 浏览器直驱**（`node <ego-browser.mjs> nodejs` 从 stdin 读脚本）在本机能跑起来，但打开 DSH GUI 会停在 `dsh web authentication required`：token 只打印在 dsh web 启动输出里，文件系统里找不到。别在这上面耗时间，改用 wincu 桌面工具或请用户操作。
15. **check:dist 未提交时必失败**（它对比 `git diff -- lib`），先 commit 再跑。
16. 认证门会挡掉一切非 owner 请求：用 curl 调路由看到 401/503 是**正常**的，不是 bug。

---

## 11. 待办 / 开放问题

| 序号 | 事项 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | 「收藏 / 待回看 / 优先级」在「已标记」区是否拆成三小行 / 改名「我标注过的」/ 保持合并 | 三个方案已给用户，**用户未选** | 先别动，等用户拍板 |
| 2 | 右栏（侧边栏）形态的滚动/高度是否真的生效 | 已加 `dsmFitPanel`，但用户当时会话数不够没测到；`panel:fit` 日志待下次打开面板确认 | 看 `avail` 与 `ch/sh` 是否合理 |
| 3 | 工作区归档 / 可见性（上游有、本分支未移植） | v0.2 就决定推迟 | 若用户要，参考上游 `hkkz9522` 版实现 |
| 4 | `window.__dshSessionsManager.version` 已同步为 `3.8.0` | 已改 | 以后升 package 版本时顺手同步这一行（`src/client/index.jsx` 的 `version:` 字段） |
| 5 | `dsmFitPanel` 无单测（依赖 DOM） | 靠日志验证 | 若要测，抽纯函数算 `avail` 再测 |
| 6 | 上游若有新版格式 | 未跟踪 | 见 §12 |

---

## 12. 上游同步（rebase 指南）

```bash
git fetch upstream
git log --oneline upstream/main -20        # 看上游动了什么
git rebase upstream/main                   # 冲突热区见下
npm run build && npm test                  # 失败集必须 ⊆ 基线
npm run check:dist
```

冲突热区与处置：

| 文件 | 冲突原因 | 处置 |
| --- | --- | --- |
| `src/index.js` | 我们把 41 处路由注册包了 `apiAuth.wrap`、加了 meta/turn-kind/debug-log 路由、inject 加 `connection` | 保留我们的包装；新路由也要包 |
| `src/client/index.jsx` | 5601 行，几乎整文件重写过 | 以上游为准重建冲突段，再重放我们的区块（v0.4/v0.5 标记清楚） |
| `package.json` | name / version / description / repository / deps | 保留我们的 name 与 version，采纳上游依赖升级 |
| `build.mjs` | banner 里的包名 | 保持 `dsh-lyin-sessions-manager` |
| `cordis.patch.yml` | id 列表 | 保持我们的 id |
| `README*.md` | 分支说明横幅 | 保留横幅，采纳上游正文更新 |

**必须保持稳定的对外契约**（改了会断别处）：
- 路由前缀 `/archived-sessions`
- `window.__dshSessionsManager.openSession(id) -> boolean`（`dsh-netease-lyrics` 的提醒跳转依赖它）
- 右栏 `RAIL_KIND = 'dsm-quick-access'`、`RAIL_ID = 'dsm-lyin-sessions-manager/quick-access'`
- localStorage 键 `dsm-qa-style-v1` / `dsm-qa-collapsed-v1`
- `data-dsm-*` 类名（CSS 与用户视觉习惯）

---

## 13. 给接手会话的第一天

1. 读本文件 + `git log --oneline -15`，确认最后一条提交是 `90ce0bb` 之后的版本号提交。
2. `npm run build && npm test`，把失败数与 §7.2 的 5 处基线对齐。若多于 5，先查是不是本机环境变了（`git stash` 对照）。
3. 打开面板，看 `debug.log` 里 `session-list:store-ready` / `panel:fit` / `host-list:loaded` 三行是否正常。
4. 要改 UI 前，先确认改的是现役选择器（`.dsm-qa-main` / `.dsm-qa-rail`），别改已停用的 `.dsm-qa-panel`。
5. 不要替用户做「拆三行 / 改名」这类产品决定；把方案摆出来让用户选。
6. 每次提交都跑 `check:dist`，并且把 `lib/` 一起提交。

---

## 附录 A：常用命令

```powershell
# 构建 + 全量测试
npm run build; npm test

# 只跑面板相关
node --test tests/panel-sections.test.js tests/quick-access.test.js tests/subagent-fold.test.js tests/ui-session-state.test.js

# 看客户端日志最近 40 行
Get-Content "$env:USERPROFILE\.dsh\sessions-manager\debug.log" -Tail 40

# 清掉调试日志（无害）
Remove-Item "$env:USERPROFILE\.dsh\sessions-manager\debug.log"

# 看插件是否被宿主加载（端口会变，取当前 Web GUI URL）
# 浏览器里打开面板 → 日志出现 session-list:store-ready 即已加载

# 查某条路由有没有包认证门
Select-String -Path src\index.js -Pattern "registerRoute\(" | Measure-Object | Select-Object Count
```

## 附录 B：术语

- **DSH**：DeepSeek Harness（本机为 Desktop 版 0.2.2-rc.1）。
- **host / client**：插件分两半，host（`lib/index.js`，Node 侧，跑路由与存储）与 client（`lib/client.js`，浏览器侧，跑 UI）。
- **slot**：宿主 UI 的挂载点（`sidebar.panellist`、`main`、`sidebar.right.pane.tab`…）。
- **uiSession**：宿主客户端服务，提供 `sessions.list`（会话商店）与 `sessionStatus`（运行状态）。
- **meta-v1**：本分支的元数据 schema（priority / note / review）。
- **关注区 / 次级区**：面板上方「进行中 / 待你处理 / 出错 / 刚完成·未读」为关注区；下方「最近活跃 / 已标记」为次级区。
- **build stamp**：`<version>+<hash>`，每次 build 变，位于 `lib/index.js` 的 `BUILD_STAMP`。
