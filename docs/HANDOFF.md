# 交接文档：dsh-lyin-sessions-manager

> 写给「接手后续维护的新会话 / 新维护者」。目标是让你在不读 5000 行源码的前提下，
> 20 分钟内能改一行、构建、验证、回滚。
>
> 最后更新：2026-11-24（v3.15.0：模型路由面板（维护栏右侧第三个按钮，`mv-sheet` 两个分区），读写本机两个路由插件的 `settings.json`：`~/.dsh/llm-router/settings.json`（跨 provider 的候选链）与 `~/.dsh/subagent-router/settings.json`（派给子代理的候选清单 + tier）。两者都靠 mtime/size 指纹 5 秒轮询，所以改完最多 5 秒自生效，`needsRestart` 恒为 false —— 与隔壁两个按钮（MCP 改 profile、Skill 改 SKILL.md）语义完全不同。校验层 `src/router-core.js` 是那两个插件 normalizer 的逐条镜像（候选解析、id 白名单、tier 回落 light、写回走 normalize 所以未知键会被丢掉），编辑拒绝统一抛 `RouterError`（status 400，界面直接显示原文）。原入口 `/router`、`llm_router` 工具、`/subagent-router` 全部保留，三边写同一个文件。`src/router-store.js` 只做文件 I/O：读带指纹缓存、写走 `temp + rename` 原子替换并在改前落 `.bak-routerui-<时间戳>`。v3.14.3：把 v3.14.2 给 `.dsm-qa-main` / `.dsm-qa-rail` 加的 `width:100%` 删掉——它解决了「被内容顶宽」，却把面板变成「永远铺满」，用户 m03562 反馈不自然。改回 `min-width:0` + `max-width` + `margin:0 auto`，块级默认行为接管；v3.14.2：面板里的小三角改成和侧栏同款——之前是浏览器给 button 的默认灰底方框，和侧栏的橙色 ▸ 不是一个东西；同时给展开列表补 min-width:0 / max-width:100% / overflow:hidden，长任务名不再把整个面板横向撑开。v3.14.1：后台任务从侧栏 DOM 挪进「进行中的会话」面板——v3.14.0 挂错了地方，用户日常看的是插件自己的面板，侧栏会话行里有三角而面板里没有；面板行因此由 button 改为 div role=button，好让行内的三角是真正可聚焦的 button；v3.14.0：侧栏加「后台任务」—— 回合结束后会话留下的 job 可能还在跑，此时那一行看起来什么都没干。现在给这样的会话在状态点后挂一个「▸ N」小三角，点开就地列出任务名与运行时长；并且只要作业没收尾，即便用户已经点进会话「已读」，该会话仍留在「刚完成」里（否则就回到用户抱怨的那个局面：找不到是谁在后台占资源）。数据取自宿主 `jobs` + `agents` 两个服务，宿主没有它们时整个特性静默不存在；v3.13.3：修掉「修了但空隙还在」——`dsmFitPanel` 里负 margin 一旦生效，`el.top - ar.top` 恒为 0，每次重算都把自己抹平；改为先加回上次已吃掉的 `--dsmqa-gap-top` 得到自然位置再决定吃多少（幂等）。同时跟随态把面板的 `padding-top` 归零、吸顶条的负 `margin-top` 归零，顶条直接贴住面板上沿。v3.13.2：筛选框搬进吸顶条内部一起吸顶、顶部那截空隙用 `--dsmqa-gap-top` 负 margin 吃掉（顺带增强 `panel:fit` 日志：`pt=/st=/stTop=/sh=/chh=/stv=`）；v3.13.1：修正胶囊材质的「应用范围」——吸顶条不再是实色深条、面板铺满整块可用区域而不是只包住内容、跟随态默认默认铺满宽度而非 760px 窄卡；v3.13.0 是快捷面板外观可以「跟随歌词胶囊」——读 netease-lyrics 的 localStorage 与事件，把它的 7 种胶囊样式映射成本插件的 CSS 变量；v3.12.0 是 debug.log 轮转、已标记拆三小行、工作区筛选哨兵、工作区归档（只做可见性）、`check:schema` 上游格式哨兵，并手工卸载了 `dsh-mcp-manager`。能力范围 = v0.5.5 MCP 开关 + v0.6.1 skill 管理 + v0.6.2/v0.6.3 缺陷修复 + v3.12.0 工作区归档 + v3.13.0/3.13.1/3.13.2/3.13.3 胶囊联动）

---

## 0. 一分钟上手

| 项 | 值 |
| --- | --- |
| 本机仓库路径 | `D:\DeepSeek Harness\workspace\plugins_helper\session-manager-unified\dsh-lyin-sessions-manager` |
| 分支 / 远程 | `main`；`origin` = https://github.com/Mostimadesi/dsh-lyin-sessions-manager（公开），`upstream` = TOBYCAI/dsh-sessions-manager |
| 插件包名 | `dsh-lyin-sessions-manager`（**改包名要同时改** `build.mjs` 的 ModuleLoader banner） |
| package 版本 | `3.15.0`（上游 3.7.10 → 3.8.0 面板能力 → 3.9.0 加 MCP 开关 → 3.10.0 加 skill 管理 → 3.10.1 维护栏分组 → 3.10.2 评审加固 → 3.10.3 全量自审修复 → 3.11.0 debug.log 轮转 + 已标记拆三行 + 工作区筛选哨兵 → 3.12.0 工作区归档 + `check:schema` → 3.13.0 面板外观跟随歌词胶囊 → 3.13.1 材质铺满面板 + 吸顶条去实色 + 默认铺满宽度 → 3.13.2 筛选框进吸顶条 + 顶部空隙用负 margin 吃掉 → 3.13.3 负 margin 幂等化（否则重算即抹平）+ 顶条贴住面板上沿 → 3.14.0 侧栏「后台任务」小三角 + 就地展开 → 3.14.1 后台任务挪进「进行中的会话」面板 → 3.14.2 三角外观对齐侧栏 + 长任务名不再撑宽面板 → 3.14.3 面板不再强制铺满（删 width:100%） → 3.15.0 模型路由面板） |
| 目标宿主 | DSH **0.2.2-rc.1**（`D:\DeepSeek Harness`，nightly 通道） |
| 构建 | `npm run build` → 产出 `lib/index.js` + `lib/client.js`（**产物要提交**） |
| 测试 | `npm test`（= `node scripts/run-tests.mjs`，58 个测试文件 / 601 项，Windows 基线 5 项失败见 §7.2） |
| 产物一致性 | `npm run check:dist`（**必须先 commit 再跑**，它用 `git diff --exit-code -- lib` 判定） |
| 上游格式哨兵 | `npm run check:schema`（把每份落盘索引的 schemaVersion 钉成表，与 `upstream/main` 逐个比对） |
| 生效方式 | 纯 `lib/client.js` 改动：**刷新浏览器页面**即可；`lib/index.js`（host）改动：重启 DSH |
| 已交付能力 | 会话管理面板（标签/优先级/备注/待回看/血缘折叠/批量标注/导出）、「进行中的会话」面板（摘要条 + 最近活跃 + 已标记 + 可收起分组 + 吸顶 + 右栏标签页）、`meta-v1` 存储、owner-only 认证门（50 条路由）、MCP 服务器开关（`cordis.patch.yml` 文本手术）、skill 三态开关 + zip 导入导出 |

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
  - `package.json` 的 `3.12.0`：给 npm / 插件市场看。
  - commit message 里的 `v0.1` … `v0.5.4`：本分支的开发里程碑，只在 git log 里有意义。

---

## 2. 目录与模块地图

```
src/
  index.js              host 侧（3375 行）：50 处 registerRoute、存储、自动归档、meta/turn-kind/debug-log/mcp/skills 路由
  client/
    index.jsx           客户端全部 UI（5930 行，纯手写 React，无 jsx 构建，esbuild 直出）
    logic.js            纯函数层（1013 行）：所有可单测的逻辑都放这里，UI 只做渲染
  api-auth.js           owner-only 认证门（createApiAuth → { check, wrap }）
  session-meta-index.js 元数据存储 meta-v1（priority/note/review）
  session-meta-cache.js meta 的内存缓存/批量读
  mcp-rows.js           cordis.patch.yml 的 MCP 行解析与开关（文本手术，不引 YAML 库）
  skill-rows.js         skill 扫描 / 三态 frontmatter 开关 / 导入导出 / 删除（566 行，同样文本手术）
  zip-lite.js           零依赖 zip 读写（197 行，只依赖 node:zlib），导入导出用
  tag-index.js          标签存储（20 个/会话，名称 ≤32 码点）
  handle-era-ops.js     SessionHandle 世代的操作适配（删除/恢复/移动）
  lineage.js            子代理血缘（origin === 'subagent' && parentSession）
  auto-archive.js       自动归档（本机因缺活动时间实际不生效，见 §10）
  background-jobs.js    后台任务的只读投影（纯逻辑，无 node: 导入）：normalizeJobRow / isActiveJob / activeJobRows / sessionIdsOf / collectBackgroundJobs / jobDurationLabel / jobBadgeText；host 与 client 共用
  router-core.js        模型路由的纯判定层（v3.15.0，无 node: 导入）：两个路由插件 normalizer 的镜像 +
                        add/update/remove/move + applyLlmOp/applySubagentOp 分发表 + crossCheck
  router-store.js       两个 settings.json 的读写（v3.15.0）：指纹缓存、temp+rename 原子写、改前备份
  debug-log.js          debug.log 轮转与上限（v3.11.0：4 MiB × 4 = 16 MiB 足迹）
  workspace-archive-core.js 工作区归档纯逻辑（无 node: 导入，客户端也打包它）
  workspace-archive.js  工作区归档的文件 I/O（workspace-archives.v1.json，tmp+rename 原子写）
  client/capsule-link.js 胶囊联动的纯判定层（v3.13.0）：读 netease-lyrics 快照 → 12 个 --dsmqa-* 变量，无 DOM / 无 localStorage
  compat/persistence.js 存储格式世代适配
  zstd-frame.js         直接解码压缩日志帧（turn-kind 用）
scripts/
  run-tests.mjs         测试入口（预置 DSH_SESSIONS_MANAGER_NO_AUTH=1）
  compat-smoke.mjs      真实 cordis + 假服务，断言路由注册 + 认证门放行 owner
  rescue-smoke.mjs      复制真实 v4 日志到临时目录，跑 32 项破坏性矩阵
  check-schema.mjs      上游落盘 schema 哨兵（npm run check:schema，见 §12.1）
  check-session-health.mjs / check-upstream-contract.mjs / compat-runtime.mjs
tests/                  58 个 *.test.js（node:test），全量 601 项
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
  `var BUILD_STAMP = true ? "3.12.0+xxxxxxxx" : "dev";` —— **这是正常的**，每次 build 都会改这一行，提交它。
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

- 50 处 `registerRoute(...)`；其中 41 条 `/archived-sessions/*` 由 compat-smoke 断言全部注册成功（新增的 mcp/skills 路由由各自的 routes 测试覆盖）。
- 所有路由包 `createApiAuth(ctx).wrap`：owner-only、fail-closed（无 `connection` 服务时 503、非 owner 401）。
- 新增能力时**必须**走 `registerRoute`，否则绕过认证门。
- 测试里为了免认证会设 `DSH_SESSIONS_MANAGER_NO_AUTH=1`（`scripts/run-tests.mjs` 预置）；`tests/meta-routes.test.js` 会自己删掉这个变量以走真实门。
- MCP 两条：`GET /archived-sessions/mcp/rows`（列出现有 MCP 行）与 `POST /archived-sessions/mcp/toggle`（`{ id, enabled }`）。写文件前落 `.bak-mcpui-<ts>` 备份，返回 `{ ok, changed, reason, backup, needsRestart, rows }`。
- skill 六条：`GET|POST /archived-sessions/skills/list`、`POST /archived-sessions/skills/mode`（`{ dir, mode, name? }`，三态 `on|clipboard|off`）、`GET /archived-sessions/skills/export?dir=`、`POST /archived-sessions/skills/import?root=&overwrite=1`（body 为 zip 二进制）、`POST /archived-sessions/skills/import-dir`、`POST /archived-sessions/skills/delete`。三条会写盘的路由都先落 `.bak-skill-<毫秒时间戳>`（同毫秒冲突自动 `-1..-99` 递增）。**skill 开关不需要重启**（宿主 chokidar 监听，下次 agent step 生效），所以返回值恒为 `needsRestart: false`。
- **skill 不是 patch 行**：它在 `cordis.patch.yml` 里没有任何条目，发现完全靠文件系统扫描（`skillRoots()`：项目 `.dsh/skills` → 项目 `.agents/skills` → `$DSH_HOME/skills` → `~/.agents/skills` → bundled）。所以别照抄 MCP 的 `#OFF#` 行手术。
- skill 三态语义：两个键都不写=`on`；只写 `disable-model-invocation: true`=`clipboard`（模型不可见、`/名称` 仍可用）；再写 `user-invocable: false`=`off`。旧键 `modelInvocable` 会被宿主**报错拒绝**，别写。
- `tests/skill-routes.test.js` 的假 req 必须带 `req.url`：`/skills/import` 与 `/skills/export` 从 `new URL(req.url)` 取 `root`/`dir`，不设 `req.url` 就取到空串 → 400 `DSM_SKILL_BAD_ROOT`。另外 `callRaw` 的响应可能是 JSON（错误）也可能是 zip（成功），只按首字节 `{` 判断再解析。
- skill 写路由现在**服务端自己判只读**：`/skills/mode` 与 `/skills/delete` 会先查 `known.writable === false` → 400 `DSM_SKILL_READONLY`；删目录时 `name` 必填（缺失 → 400 `DSM_SKILL_BAD_INPUT`）；`/skills/import-dir` 要求 `srcDir` 落在某个已扫描根内，否则 400 `DSM_SKILL_BAD_SRC`。**别只靠客户端禁用按钮**——那是 UI，绕过 UI 直接发请求就能改宿主包里的官方 skill（这正是 v0.6.2 修掉的缺陷 1）。
- **`tests/mcp-routes.test.js` 的 503 用例必须同时删 `DSH_PROFILE_DIR` 与 `DSH_PROFILE`**：本机真实环境有 `DSH_PROFILE=desktop`，只删前者会让 `resolveProfileDir` 回退到 `~/.dsh/profiles/desktop` 并命中真实文件，用例就测不到 503 分支。

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
| `markedRows(items, {limit=6, exclude})` | logic.js | 已标记区（合并去重；v3.11.0 起 UI 改走 `markedRowsByKind`，这个保留给旧测试） |
| `markedRowsByKind(items, {now, limit, exclude})` | logic.js | 已标记区三小行（star / review / priority，每通道独立 limit 与 total；一个会话只归第一个命中类） |
| `markKindOf(item)` | logic.js | 判定一个会话属于哪个标记通道（收藏 → 待回看 → 优先级，P3 不算） |
| `shouldHideEmptyGroup(aliveCount, containsCurrent)` | logic.js | 空组判定（**当前会话在组内时绝不藏组**，吸收上游 f010392） |
| `matchWorkspaceFilter(item, workspaceFilter)` | logic.js | 工作区筛选（含 `__ungrouped__` / `__workspace_gone__` 两个哨兵，吸收上游 cefd98f） |
| `workspaceKeyOf(rawPath)` | workspace-archive-core.js | 工作区折叠键（分隔符/大小写折叠、保 UNC 前缀） |
| `visibleItemsAfterWorkspaceFold(items, keys, peekPath)` | workspace-archive-core.js | 已归档工作区的会话过滤（`peekPath` = 下拉显式点名时放行） |
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
| `readCapsuleSnapshot()` | index.jsx | 读 netease-lyrics 的三个 localStorage 键成一个快照（缺失/坏 JSON → null） |
| `normalizeCapsuleConfig(input)` | capsule-link.js | 三子对象 → 归一化配置（数值夹逼 + 颜色校验，任何输入都给可用默认值） |
| `qaVarsFromCapsule(config, detail)` | capsule-link.js | 胶囊配置 + 面板滑杆 → 12 个 `--dsmqa-*` 变量（detail 覆盖胶囊） |
| `capsuleFollowInfo(config)` | capsule-link.js | 当前胶囊样式的中文名 + 是否已正式移植 + 未移植时的近似回落 |

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
npm test                         # 全量（58 文件，约 601 项）
node --test tests/xxx.test.js    # 单文件
node scripts/compat-smoke.mjs 0.2.2-rc.1   # 真实 cordis 加载 41 条路由
node scripts/rescue-smoke.mjs              # 破坏性矩阵（需真实 ~/.dsh/sessions）
npm run check:dist               # 提交后校验 lib 与源码一致
npm run check:sessions           # 会话日志健康检查
```

### 7.2 本机基线（重要）

Windows 环境下有 **5 项既有失败**（数量在 4–5 之间浮动，取决于临时目录竞争），与改动无关（在 pristine HEAD 上同样失败）：

| 测试 | 报错 |
| --- | --- |
| `tests/move-notices.test.js` 的 `atomic write: 0o600, no temp leftovers, corrupt file self-heals` | `AssertionError: 438 !== 384`（MSYS 下 stat 报 0o666，权限位断言失败） |
| `tests/saved-filters.test.js` 的 `atomic write: 0o600 mode, …` | 同上，权限位 |
| `tests/tag-index.test.js` 的 `store: append/list/ack 幂等，坏数据宽容，TTL 过期不投递` | 同上，权限位 |
| `tests/warm-tristate.test.js` 的 `lineage-tree never decodes on the request path; titles appear after warm` | `EBUSY: resource busy or locked, rmdir …\trash` |
| 同文件相邻的另一项冷缓存断言 | 同上，EBUSY 连锁 |

**按测试名判定，不要按行号**——这几处行号会随相邻改动漂移（v3.12.0 就从 `:42/:118/:227/:269` 漂到了 `:19/:114/:223/:269`）。

单独跑某个文件时同类断言会连锁多失败几项（例如 `tests/warm-tristate.test.js` 单独跑会因 EBUSY 连锁失败 10 项），全量跑只失败 4–5 项——这是 Windows 临时目录竞争，不是代码问题。

判定规则：**失败集 ⊆ 基线集** 即通过。基线对照方法：

```bash
git stash push -u -q && npm test ; git stash pop   # 在 pristine 状态跑一遍
```

用户环境重启后如果失败数量变化，先确认是不是新增，再动手。

**CI 的 `check:dist` 与本机不同源（2026-11-25 实测）**：`compat.yml` 的 `git diff --exit-code -- lib` 跑在 GitHub 的 Linux runner 上，工作树是 **LF**；本机 `core.autocrlf=true`，检出的是 **CRLF**。`build.mjs` 的指纹直接哈希 `src/` 的**原始字节**（第 43–49 行），所以两边哈希必然不同 —— 本地 `check:dist` 绿、CI 红是**正常现象**，不是产物有问题。要复现 CI：`git -c core.autocrlf=false clone` 到临时目录再 `npm run build`。判据是「换行符差异」，不是「谁忘了重建 lib」。

历史遗留：`5dfb2b0` 及更早的提交里，`lib/client.js.map` 的 `sourcesContent` 与仓库 blob 的换行符不一致（`src/client/logic.js` 混合 CRLF/LF，`crlf=1002 / lf=1013`），这类提交会让 CI 永久红。只有推送新 HEAD 才会让 CI 跑到新提交上（`a8abec7` 起 CI 全绿）。

### 7.3 最近一次全绿记录

- build stamp `3.15.0+47fc506e`（v3.15.0 模型路由面板；v3.14.3 见 `b486448`，v3.14.2 见 `902c53d`，v3.14.1 见 `fe684f5`，v3.14.0 见 `13809ee`，v3.13.3 见 `46d5c8d`）
- 上一版：build stamp `3.13.3+6ccf65f3`（v3.13.3 负 margin 幂等化 + 顶条贴住面板上沿；v3.13.2 见 `7bd48b3`，v3.13.1 见 `8fd002f`）
- **601 项 / 595–596 通过 / 5–6 失败**（失败集都在 §7.2 那 5 项 Windows 基线里，按测试名对照；第 6 项是基线里偶尔多跑出来的一条）
- v3.15.0 新增 `tests/router-core.test.js` 20 项、`tests/router-store.test.js` 14 项、`tests/router-routes.test.js` 6 项——**无新增回归**
- v3.14.0 新增单测：`tests/background-jobs.test.js` 20 项（owner 过滤、未知状态不当活、排序去重、时长分级、徽标文本）、`tests/background-jobs-routes.test.js` 4 项（分组下发、无服务时不出字段的向后兼容断言、两个服务的异常隔离），全绿
- v3.13.3 记录：**537 项 / 533–534 通过 / 3–4 失败**
- v3.13.0 新增单测：`tests/capsule-link.test.js` 17 项（7 种胶囊样式映射、数值夹逼、颜色校验、面板滑杆优先级、未移植样式的近似回落），全绿；v3.13.1 / v3.13.2 都是纯 CSS/UI 调整，无新增用例
- 上一版记录：build stamp `3.12.0+ac22b075`（v3.12.0 工作区归档 + `check:schema`，含 `3084ab3` 的路由修复），**520 项 / 515–517 通过 / 3–5 失败**
- 路由级新增 `tests/workspace-archive-routes.test.js` 3 项（提交 `3084ab3`）：空读→归档→幂等→恢复→清空、工作区列表带 `archived` 标记、损坏索引自愈。修掉两个真 bug：`changed` 曾把 store 的异构返回值（记录/布尔/计数）直接透给前端；`createWorkspaceArchiveStore` 曾不认 `DSH_SESSIONS_MANAGER_STAR_DIR`，导致测试写进用户真实状态目录。
- 再上一版：build stamp `3.11.0+6806b74d`（v3.11.0 debug.log 轮转 + 已标记拆三行 + 工作区筛选哨兵），**488 项 / 484 通过 / 4 失败**
- 更早：build stamp `3.10.3+5fc28754`（v0.6.3 全量自审），**468 项 / 463–464 通过 / 4–5 基线失败**
- **2026-11-18 接手复测**（pristine `5dfb2b0`，无源码改动）：`npm run build` 正常，`npm test` **469 项 / 465 通过 / 4 失败**，失败集恰为基线四项。
- `check:dist` exit 0（记得先 commit）
- `check:schema` exit 0（11 份索引与 `upstream/main` 一致，2 份 local-only）
- skill + MCP 子系统单测 **56 项全绿**：`tests/skill-rows.test.js` 21 + `tests/zip-lite.test.js` 15 + `tests/skill-routes.test.js` 5 + `tests/mcp-rows.test.js` 13 + `tests/mcp-routes.test.js` 2
- 真机：摘要条 / 筛选框 / 折叠徽标 / 可收起分组 / 吸顶 / MCP 4 行 生效；skill 三态待重启后验；工作区归档三处（维护栏按钮 / 侧栏整组折叠 / 面板列表过滤）待真机验；v3.13.0 胶囊联动已真机确认材质能跟随切换，v3.13.1 修正了三处应用范围（吸顶条实色 / 材质只包内容 / 760px 窄卡）；v3.13.2 修筛选框被吸顶条盖掉、面板顶部留缝；v3.13.3 修「修了但空隙还在」（负 margin 被自己抹平），待用户看过新版截图；v3.14.0 后台任务三角已真机确认（侧栏会话行里能看到），但用户指出落点不对；v3.14.1 把它做进「进行中的会话」面板，纯客户端改动，刷新页面即可验

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
| `debug.log` | 客户端诊断日志（本分支），**v3.11.0 起自动轮转**：单文件上限 4 MiB，保留 3 个副本（`debug.log.1..3`），合计上限 16 MiB，可在 `GET /archived-sessions/capabilities` 的 `debugLog` 字段核对运行时值 | `POST /archived-sessions/debug-log` → `src/debug-log.js` |
| `workspace-archives.v1.json` | **本分支新增（v3.12.0）**：`{ schemaVersion: 1, archives: { <折叠后的工作区路径>: {key, path, title, archivedAt} } }`。语义 A = 只做可见性，不动会话归档状态 | `src/workspace-archive.js` |

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
7. 吸顶底色：`--dsmqa-head-bg`（运行时实测）> `--dsmqa-solid`（预设不透明兜底）> `#18181A`。
   **v3.13.0 起要分两种情况**：普通预设下 `--dsmqa-bg/-radius/-blur/-border` 仍只被**已停用**的旧弹层消费（现役 main/rail 由宿主供背景）；只有 `preset === FOLLOW_PRESET` 时 `:root[data-dsmqa-follow="1"]` 那组规则才让面板自己上材质（bg + border + blur + saturate + glow，wash/grain 并进 `background-image` 两层；v3.13.1 起 `min-height: var(--dsmqa-avail)` 铺满可用高度，吸顶条取 `color-mix(... 62%, transparent)` 的同色淡版；v3.13.2 起再用 `margin-top: calc(-1 * var(--dsmqa-gap-top, 0px))` 吃掉面板顶到宿主容器顶的那截空隙，并把等量高度加回 `--dsmqa-avail`）。加新变量时记得同时登记到 `QA_STYLE_VAR_KEYS`，否则从跟随切回普通预设会把它留在 `:root` 上。

### 工具 / 环境

8. **asar 取证**：`D:\DeepSeek Harness\workspace\plugins_helper\dsh-debug-tools\asar-context.cjs`（`node asar-context.cjs <app.asar> <needle...>`）。haystack 按 **latin1** 解码 → **中文 needle 永远命不中**，只能用 ASCII 标识符；`app.asar` 是文件不是目录，别对它跑 grep。
9. **apply_patch 的转义坑**：要往文件里写 `\"`，`new_text` 必须传 `\\\"`；否则落成裸 `"`，package.json 直接变非法 JSON（`ERR_INVALID_PACKAGE_CONFIG … position 413`）。
10. **write 工具的 `\0` 坑**：源码里写 `\0` 会落成真实 NUL 字节，文件被判 binary；写 JSON 解析用的 `\x00` 要写成 `\\x00`。
11. **pwsh 不支持 `<` 重定向**（`RedirectionNotSupported`）：用 `Get-Content -Raw x | node …`。
12. **Node ≥18.20 拒绝无 shell 执行 `.cmd`**（`spawnSync npm.cmd EINVAL`）：Windows 下 `shell: true`，npm 用 `npm.cmd`。
13. **pwsh 管道会破坏多字节字符**：给 node 脚本喂中文可能触发 `SyntaxError: Missing catch or finally after try`；脚本里中文写 `'\uXXXX'` 或干脆纯 ASCII。
14. **ego 浏览器直驱**（`node <ego-browser.mjs> nodejs` 从 stdin 读脚本）在本机能跑起来，但打开 DSH GUI 会停在 `dsh web authentication required`：token 只打印在 dsh web 启动输出里，文件系统里找不到。别在这上面耗时间，改用 wincu 桌面工具或请用户操作。
15. **check:dist 未提交时必失败**（它对比 `git diff -- lib`），先 commit 再跑。
16. 认证门会挡掉一切非 owner 请求：用 curl 调路由看到 401/503 是**正常**的，不是 bug。

### skill 子系统（v0.6.2 评审踩出来的，都已有回归测试）

17. **解压前必须拦体积**：`readZip(buf, { maxTotalBytes })` 先用中央目录声明的 `uncompSize` 预判，再给 `inflateRawSync` 传 `maxOutputLength`。只判"解压后"是没用的——40 MB 的 0 压完只有 40 KB，`readBinaryBody` 的 32 MiB 上限拦不住，inflate 时内存已经吃进去了。
18. **`setMode` 必须对每个态都是不动点**：`modeOf(frontmatter) === mode` 时直接返回原文。否则「只有 `user-invocable: false`」（语义上算 `on`）会被"启用"按钮删掉那行，等于偷偷重开 `/` 调用。
19. **重复 frontmatter 键要收敛成一条**：`readFrontmatterField` 取第一个匹配，而早期 `setMode` 重写全部 → 读到的和写下的不是同一件事。
20. **行尾注释要剥掉再判布尔**：`disable-model-invocation: true # 临时停用` 若不剥注释会被当成"没有这个键"→ 默认 `on` → 点启用把那行删了，被停用的 skill 复活。`stripInlineComment` 只在 `#` 前是空白时才当注释（`a#b` 是普通字符）。
21. **换行符跟随原文件**：`splitSkillFile` 按 `\n` 切，CRLF 文件的行尾会留 `\r`。重写时用 `eol = /\r$/.test(lines[0]) ? '\r\n' : '\n'`，并给每行 `bare()` 去掉残留 `\r`，否则一次开关就把整份文件变成混合换行（`on → off → on` 也就回不到逐字节相同）。
22. **备份与 staging 不能进导出 zip**：`collectSkillFiles` 要按 `isOurArtifact()` 排除 `.bak-skill-*` 与 `.import-*`，否则每开关一次就多一份历史，导出→导入不断增殖，最后撞 `too many files (limit 400)`，原本能导出的 skill 反而导不出。
23. **覆盖导入不能 `rmSync`**：改成把旧目录改名成 `<name>.replaced-<stamp>`。用户丢一个同名 zip 不该连带删掉目录里的历史备份与非 skill 文件。客户端也要先 `window.confirm`，别硬编码 `&overwrite=1`。
24. **zip 内同名条目要拒绝**：`entries.find` 找到的那份被校验，落盘时却被同名条目顶掉 → 校验的和落地的不一定是同一个文件。
25. **客户端的 `writable` 只是 UI**：服务端必须自己 `assertWritableDir()`（拒绝 bundled 根与任何扫描根之外的目录）。这是 v0.6.2 修的最严重一条。
26. **`/skills/import-dir` 的 `srcDir` 必须落在扫描根内**：不加约束它就是个"把任意本地目录复制进 skill 根"的原语，而客户端根本没用到这条路由。
27. **`deleteSkillDir` 会进回收站**：传 `trashDir` 就 `renameSync` 到那儿（可恢复），不传才 `rmSync`。**别把回收站放在 skills 根里面**（例如 `<dir>.deleted-<stamp>`）——宿主下次扫描会把它当成另一个同名 skill 重新列出来，等于没删。路由用的是 `join(TRASH_DIR, 'skills')`。
28. **MCP 写 profile 前必须回读校验**：`togglePatchRow` 改完先 `parsePatchRows(out.text).rows.find(r => r.id === id)` 确认 `enabled` 真的变成了想要的值，不一致就 500 且**不写盘**。写的时候走 tmp + `rename` 原子替换；`writeFile(file, ...)` 中途失败会在用户的 profile 里留半份 YAML，宿主会判「非法的配置文件」。
29. **`dsmMetaCache` 要整表替换**：只 `set` 不 `delete` 的话，被删/被移走的会话永远留在面板里，「共 N 个会话」只增不减，已标记/最近活跃还会列出已删除的会话。
30. **侧栏增强的 `setInterval` 要能被卸载**：`apply()` 里 60s 兜底刷新的 timer 必须挂到 `dsmSidebarCleanup`，由 `dsmTeardownSidebarAug()` 清算。没有它，停用插件或 HMR 后旧闭包会活到页面关闭，还在后台打 `/archived-sessions/sessions`。

### 工作区归档 / debug.log（v3.11.0–v3.12.0 踩出来的）

31. **`debug.log` 首次写不要轮转**：`shouldRotate(cur, inc, max)` 里 `cur <= 0 || inc <= 0` 直接返回 `false`。否则新装用户的第一次写就会先转出一个空的 `debug.log.1`，日志目录平白多一份空文件。
32. **读文件的归一化函数必须是纯函数**：`normalizeArchivedAt` 对缺失/非法的时间戳返回 **0** 而不是 `Date.now()`。返回 `Date.now()` 会让「读同一份文件」产生不同结果，每次读都重排列表顺序（`list()` 按 `archivedAt` 倒序）。时间戳只能由写入方显式盖章。
33. **坏记录一律丢弃，不要补默认值**：`normalizeWorkspaceArchiveStore` 对没有 `path` 的记录直接跳过。丢一条记录只会「把这个工作区重新显示出来」，永远比「误藏一个工作区」安全。
34. **「已归档工作区」的会话要在所有派生集合里一起过滤**：面板的 `archivedAll` / `activeAll` / `starredAll` / `reviewAll` / `emptyAll` / `totalTopCount` 全部改成从 `visibleSessions` 派生，而不是只过滤最终列表。只过滤列表的后果是「看不到却能全选」「计数比列表长」。
35. **下拉显式点名已归档工作区时要放行**：`visibleItemsAfterWorkspaceFold` 的 `peekPath` 参数就是干这个的。不放行的话，用户在工作区下拉里选中一个已归档工作区，看到的是空列表——看着像数据丢了。同时下拉本身要标注「（已归档）」，让用户事先知道。
36. **`workspaceKeyOf` 要保 UNC 前缀**：`\\server\share` 直接 `replace(/\/{2,}/g,'/')` 会折叠成 `\server\share`，两个不同的网络路径就成了同一个键。折叠前先记下 `startsWith('//')`，折叠后补回一个 `/`。

### 胶囊联动（v3.13.0 踩出来的）

37. **跨插件读 localStorage 一律当「可能没有」**：netease-lyrics 没装、没写过偏好、JSON 坏了、键改名了——四种都可能。`readCapsuleSnapshot()` 任一键读失败都返回 `null`，跟随态据此回落默认胶囊；**绝不能让面板因为隔壁插件的数据坏掉而变白板**。
38. **清理变量要按「全集」清，不能按某一个预设的键清**：原先是 `Object.keys(QA_STYLE_PRESETS['dark-glass'].vars)`，跟随态写进去的 `--dsmqa-wash/-grain/-glow/-sat` 不在那张表里 → 从跟随切回普通预设后 wash/grain 还留在 `:root` 上，面板一直带罩染。改成遍历 `QA_STYLE_VAR_KEYS`。
39. **面板自己的滑杆必须盖过胶囊快照**：`qaVarsFromCapsule(config, detail)` 的 `detail` 优先级高于 config。反过来做的话，用户在跟随模式下拖圆角滑杆毫无反应（每次重算都被胶囊值盖掉）。
40. **跟随态要监听三个自定义事件 + `storage`**：`dsh-netease-lyrics-display` / `-notice` / `-colors`（同页写入走这些），加 `storage`（跨标签页写入只有它）。四个都在 `window` 上收；用同一个 `AbortController` 一次性摘除，并挂 `ctx.effect`，否则 HMR 后旧监听器活到页面关闭。
41. **`FOLLOW_PRESET` 不是 `QA_STYLE_PRESETS` 的键**：`readQaStyle` 里那句 `QA_STYLE_PRESETS[raw.preset] ? raw.preset : 'dark-glass'` 会把跟随打回默认，必须显式 `raw.preset === FOLLOW_PRESET || ...` 放行。同类坑见经验卡 `插件-偏好select写入集合与读取白名单同一来源`。
42. **材质层不能挂在滚动容器的绝对定位伪元素上**：`.dsm-qa-main` / `.dsm-qa-rail` 都是 `overflow-y:auto`。`::before { position:absolute; inset:0 }` 覆盖的是「内容盒」的高度，滚动后伪元素跟着内容走，下半截面板就变成裸背景；两个伪元素还会互相遮盖（`::after` 盖住 `::before`）。正确姿势是把 wash 与 grain 并进元素自己的 `background-image` 多层（grain 放最前、wash 在后），随元素固定、不随内容滚动，也不需要 `isolation`/`z-index`。
43. **颗粒浓度当 alpha 用时先降权**：`--dsmqa-grain` 在 0–1，直接 `rgb(255 255 255 / var(--dsmqa-grain))` 在 0.5 时是半点阵、整块发白。用 `calc(var(--dsmqa-grain) * .34)` 压到纹理级别；同时点阵改用 `repeating-radial-gradient` 而非 `repeating-linear-gradient`，避免出摩尔纹。
44. **吸顶条不能用不透明的 `--dsmqa-solid`**：那在半透明材质顶上盖一条实色深条，与下方明显分层（用户看截图直接指出）。跟随态改成 `color-mix(in srgb, var(--dsmqa-bg) 62%, transparent)` + 同参数 `backdrop-filter`；**不要用全透明**：`backdrop-filter` 嵌套时未必生效，失效就成文字叠字。另外吸顶条要补 `border-radius: <半径> <半径> 0 0`，否则它铺满面板顶边时会切掉面板自己的圆角。
45. **「铺满整块区域」要靠 `min-height` 而不是 `height`**：面板原先只包住内容高度，内容短时材质只覆盖上半截、下面露出宿主底色。`dsmFitPanel` 已经把可用高度算出来了，顺手写成 `--dsmqa-avail`；跟随态 `min-height: var(--dsmqa-avail, auto)` + `box-sizing: border-box`。用 `min-height` 而不用 `height`：内容比可用高度还长时仍由 `max-height` + `overflow` 接管，不会截断。
46. **跟随态的默认宽度是「铺满」，不是预设的 760px**：`--dsmqa-width` 在普通预设里是 `max-width`，跟随态若不改写就会是宽屏居中的窄卡。`applyQaStyle` 里显式 `vars['--dsmqa-width'] = prefs.width != null ? prefs.width + 'px' : 'none'`；UI 上宽度滑杆在 `prefs.width == null` 时显示「铺满整区」并给一个「改回铺满整区」按钮，否则用户看到一个 760 的数字会以为那就是当前值。
47. **别让筛选框当吸顶条的兄弟节点**：`position:sticky` 只固定自己那一块，兄弟节点照常滚。筛选框原本就在吸顶条后面，面板一滚动它就滑到吸顶条底下被盖掉（用户截图：「吸顶条会挡住搜索栏位」）。做法是把筛选框搬进 `.dsm-qa-sticky` **内部**，让它们一起吸顶；搬进去后要给吸顶条补 `padding-bottom` 收口，并给 `.dsm-qa-sticky .dsm-qa-search` 归零 `margin-bottom`，否则那截外边距落在吸顶条外面，滚动时内容会从缝里露出来。
48. **「顶部那截空隙」量出来再用负 margin 吃掉，别写死数字**：面板顶到宿主容器顶的距离不是常数（视口高度、宿主 tabBody 的内边距都会变），`dsmFitPanel` 里 `el.getBoundingClientRect().top - anc.getBoundingClientRect().top` 就是它，写成 `--dsmqa-gap-top`（夹在 0–40px），跟随态用 `margin-top: calc(-1 * var(--dsmqa-gap-top,0px))`。**抬高多少，`max-height` 就要加回多少**，否则底边会空出同样一截。
49. **吸顶条的 `top` 保持 0，别用负值**：`top:-18px` 这类写法的效果是「滚过 18px 之后吸顶条才真正贴住容器顶」，那 18px 里内容会从缝隙里露出来。要消掉容器内边距造成的空隙，用面板的负 `margin-top`（见第 48 条），不要动吸顶条的 `top`。
50. **量出来的空隙要「幂等」地吃，别每次重算都把自己抹平**：负 `margin-top` 一旦生效，`el.getBoundingClientRect().top - anc.getBoundingClientRect().top` 就恒为 0；如果每次都拿它当 `gapTop` 写回，第二次调用就把 `--dsmqa-gap-top` 归零、面板弹回原位 —— 用户看到的是「修了但空隙还在」。正确做法是先读回上次已写下的 `--dsmqa-gap-top` 加回去，得到未被 margin 干预的**自然位置**，再据此决定这次吃多少（`appliedGap` / `naturalTop` 两个量）。同理 `avail` 也要减 `offset + appliedGap`，否则高度会跟着漂。
51. **面板的 `padding-top` 被吸顶条负 `margin-top` 抵掉后，跟随态要显式归零**：`.dsm-qa-sticky` 的 `margin:-18px -22px 0`（rail `-10px -12px 0`）本来是抵掉面板 `padding-top` 的；可跟随态的容器规则又给面板加了 `margin-top: calc(-1 * var(--dsmqa-gap-top))`，两条负外边距叠加后几何关系变了，`stTop` 会停在 11–19px 不再归零（实测日志 `stTop=11` / `stTop=19`）。做法是跟随态同时写 `padding-top: 0`（面板）与 `margin-top: 0`（吸顶条），让顶条直接贴住面板上沿、面板直接贴住容器顶。


---

52. **后台任务要按 owner 过滤，`list()` 会把 unowned 一起回。** `ctx.jobs.list(caller)` 的实现是 `filter((job) => job.owner === void 0 || job.owner.id === caller)`——`owner === undefined` 的作业不属于任何会话，直接挂到某一行上只会误导。`collectBackgroundJobs` 里那句 `job.owner === sid` 不能省。

53. **跨会话枚举作业只能「枚举 agent 再逐个问」。** `JobRegistry` 没有「列出所有 owner」的公开口（`store` 是私有 Map），但 `AgentRegistry.list()` 给出所有 live agent，且安装时断言 `agent.id === agent.session.id`。于是 `agents.list()` → 逐 id `jobs.list(sid)` 是唯一可行路径。作业归属 agent 生命周期（agent 销毁时 `disposeOwned()` 会先取消作业），所以「作业还活着」必然意味着「agent 还活着」——但**不代表回合还在跑**，这正是本特性要区分的两件事。

54. **装饰性字段绝不能让 sidebar-state 变 500。** `backgroundJobsField()` 整块 try/catch 吞掉，服务缺失 / 方法不全 / 抛错一律返回 `{}`——字段不下发比整份响应挂掉好得多（后者会连标题、回收站、血缘一起丢）。同理 `collectBackgroundJobs` 里单会话查询失败只跳过该会话，其余照常。

55. **「有后台任务」必须是「刚完成」的独立依据，不能只靠 `dsmRunSeen`。** 用户点进会话会把 `dsmRunSeen` 清掉（视为已读），此时「那个会话干完了但后台还在跑」就再也看不见了——正是用户要解决的那个局面。所以 `qaState` 多一个 `else if (hasBgJobs) qaState = 'done'` 分支。另外展开区的签名里要带「算到某一分钟为止的时长」，否则快照不变时签名恒定、时长永远冻在第一次渲染的那个值上。

56. **徽标要挂在用户真正在看的那个列表上。** v3.14.0 把后台任务三角做进了侧栏 DOM 注入层（`paint()`），但用户日常看的是插件自己的「进行中的会话」面板，结果「侧栏有、面板没有」。v3.14.1 补在面板里：`renderSec` 与 `shownGroups` 两处行渲染都插 `renderJobsBadge` / `renderJobList`。教训：同一个能力做在哪里，先问「用户的眼睛在哪」，不要默认「能和会话行对齐的 DOM 就是对的落点」。
57. **面板行原本是 `<button>`，行内不能再塞按钮。** `.dsm-qa-row` 是 `<button>` 时，行内的「展开后台任务」三角只能是 `<span role="button" tabIndex={0}>`，而这在浏览器里既不合 HTML 内容模型、键盘也真的聚焦不到（`<button>` 内部的可聚焦后代不会进入 tab 序列）。改法：行本身改成 `<div role="button" tabIndex={0} onKeyDown={Enter/Space → jump(row)}>`，三角改成真 `<button type="button">`，并补 `.dsm-qa-row:focus-visible` 的 outline——不然把 button 换成 div 之后键盘用户就失去焦点了。

58. **面板里的控件要和侧栏那套「同一个样子」。** v3.14.1 的三角用 `<button>`，但只写了颜色没写 `appearance:none;border:none;background:transparent`，浏览器就给它画了默认的灰底圆角方框，和侧栏注入的那个橙色纯文字 `▸ 1` 一眼能看出是两个东西（用户拿两张截图并排比出来的）。教训：跨两套渲染器做同一个控件时，把样式规则整条抄过去，别只抄颜色。
59. **横排里的长文本要把链条上每一环都设成可收缩。** 任务名把面板横向撑开，是因为 flex 子项的 `min-width` 默认是 `auto`（不低于内容宽度）：`.dsm-qa-job-name` 不写 `min-width:0`、`.dsm-qa-jobs` 不写 `max-width:100%`、行本身不写 `min-width:0;box-sizing:border-box`、容器 `.dsm-qa-main/-rail` 不写 `width:100%;box-sizing:border-box`——缺哪一环，`text-overflow:ellipsis` 都不生效，整块被内容顶宽。
60. **`width:100%` 与 `min-width:0` 解决的是两个相反的问题，别混用**。v3.14.2 想解决「长任务名把面板顶宽」，给 `.dsm-qa-main` / `.dsm-qa-rail` 加了 `width:100%`；结果变成「无论内容多少都铺满整块区域」，用户 m03562 反馈不自然。正确分工：**防被内容顶宽** → 链路上每一环 `min-width:0` + `overflow:hidden`；**防强制占满** → 容器不要写 `width:100%`，用 `max-width` + `margin:0 auto` 让块级默认行为接管。
61. **从宿主 asar 里找 hash 类名的宽度规则是死路**。`D:/DeepSeek Harness/resources/app.asar` 里能解出 12 个 `.css`，但 `_mainPanel_` / `_centerCol_` 这些 hash 类名 0 命中——它们来自 JS 注入的样式串，不在独立 CSS 文件里。要么在 asar 的 JS 里按 utf8 搜，要么直接实测 `getBoundingClientRect()` 打日志，别再解 CSS。

62. **写别人的配置文件时，normalize 规则必须逐条镜像，不能"差不多"**：`llm-router` / `subagent-router` 读回时都会再跑一遍自己的 `normalizeSettings()`，任何我们写出去、它不认识的键会被静默丢掉。镜像不精确的症状是"改了又弹回去"——尤其容易漏的三处：`neverSwitchOnCodes` 的默认四码是**始终并入**的（用户只能往上加，不能删），`parseCandidate` 拒绝 `provider === 'llm-router'`（路由组不能当自己的候选），`tier` 不认识时回落 `light` 而不是报错。写这层之前先把对方的 `lib/settings.js` 从头读一遍。

63. **`needsRestart` 是这套 UI 里最容易被误读的一个字段**：MCP 与 Skill 两个 sheet 都写"重启后生效"，模型路由紧挨着它们，但它是纯文件轮询（5 秒）。把 `needsRestart: false` 连同解释一起写进响应体与弹层底部文案，否则用户会去重启一次什么都不用重启的进程。

64. **读不到 ≠ 空**：两个插件的 settings.json 都可能根本不存在（没装 / 没写过）。`snapshot` 里带 `missing: true` 让界面能说"没读到，新建会创建它"，而不是显示一张空表让用户以为配置被清了。附带一条：**只读不要顺手 mkdir**——那会让"没装插件"看起来像"装了但空的"。

65. **整表替换 + 无并发保护＝别两边同时改**：两个插件都是"读全表 → 改 → 写全表"，我们的面板也一样。所以 `/router add` 与面板同时操作会后写覆盖前者。缓解手段是每次写前落 `.bak-routerui-<时间戳>`（本次实现如此），以及在弹层底部写清这一点；真正的锁不在本仓库能力范围内。

66. **纯逻辑层要连"脏输入下仍能出可用默认值"一起测**：`router-core.js` 的 20 项里有 6 项是喂 `null / undefined / {} / [] / 'junk' / 42 / true`。这类函数的调用方是用户手改过的文件，能抛异常就等于把面板关死了。

67. **会话右键菜单在 0.2.2（含本机 rc.1）上已经改走官方 `contextMenus`，fiber 上溯这条路取不到 sessionId（2026-11-25 在 asar 里逐行核实）**：本机 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的会话行用 `getTriggerProps({ kind: 'session', value: { sessionId, displayTitle } })` 开菜单，`openSessionMenu()` 调的是 `ctx.contextMenus.open({ kind: 'session', value: { sessionId, displayTitle } }, point)`；菜单由 `@deepseek-ai/dsh-client-ui-context-menu` 以 `portal: true` 渲染进 `shell.overlay`。**portal 出去的是独立 React 树，祖先链里没有 `SessionNodeItem`，`props.node.id` 永远取不到** —— 这正是上游 `f010392` 修 issue #28 的原因，我们的 `sessionInfoFromMenu()`（`src/client/index.jsx:4948`）走的是同一条死路。判据：菜单里「标记未读 / 移动会话 / 删除会话」三项不出现，而侧栏圆点、拖拽、分组折叠都正常（那是另一条 fiber 路径，仍在同一棵树里，没坏）。
68. **`contextMenus` 不是 0.2.2 才有的新东西**：本机 rc.1 的 `dsh-client-ui-context-menu` 就已经 `ctx.provide('contextMenus', …)`，并且是 `dsh-web-app` 的默认依赖（已核实 `package.json` 里有 `0.2.2-rc.1`）。所以「等升级到 0.2.2 再说」是错误判断 —— 现在就能用，而且**现在不用就已经在退化**。API 签名：`register({ id, target, order, resolve(targetValue, signal), observe? })`，`resolve` 返回 action 数组；`afterContent` 决定排进 `footer` 还是主体，`danger` / `disabled` / `children`（子菜单）/ `separatorBefore` 全部支持。`resolutionTimeoutMs` 默认 **1000ms**，超时的 provider 会被 abort 并给出失败反馈 —— 所以 `resolve` 里**不能现拉网络**，要像上游那样预热快照（它用 30s 缓存，`84cc522` 里为 rc.3 改成同步解析）。重复注册同一个 `(target, id)` 会 **throw**，HMR 下必须把 register 的返回值挂 `ctx.effect`。

## 11. 待办 / 开放问题

| 序号 | 事项 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | 「收藏 / 待回看 / 优先级」在「已标记」区是否拆成三小行 | **v3.11.0 已拆**：用户拍板「可以拆成三小行」。`logic.markedRowsByKind` 按 star → review → priority 分通道（一个会话只归第一个命中类，`badges` 仍显示全部标记），折叠键是 `sec:marked:star` / `sec:marked:review` / `sec:marked:priority` | 已闭合；改口径先看 `tests/panel-sections.test.js` 的 4 项断言 |
| 2 | 右栏（侧边栏）形态的滚动/高度是否真的生效 | **2026-11-18 已验证生效**：`panel:fit avail=738 anc=div.acoR2W_tabBody ch=744`，`panel:scroll 0:div.dsm-qa-rail oy=auto ch=351 sh=351`（rail 内容不溢出，故无需滚动）；主面板侧 `0:div.dsm-qa-main oy=auto ch=487 sh=487` 同样不溢出 | 若日后内容变多，复查 `ch > sh` 且 `oy` 可滚即可，无需再改代码 |
| 3 | 工作区归档 / 可见性 | **v3.12.0 已移植**（用户选语义 A = 只做可见性）：`src/workspace-archive-core.js` 纯逻辑 + `src/workspace-archive.js` 文件 I/O + 路由 `/archived-sessions/workspace-archives` + 维护栏「工作区归档」sheet + 侧栏 `setGroupHidden` 整组折叠 + 面板 `visibleItemsAfterWorkspaceFold` 过滤。**不动会话归档状态**，所以「已归档」视图保持干净 | 已闭合；语义若要改成「同时归档会话」，改 host 路由的 archive 分支即可，UI 不用动 |
| 4 | `window.__dshSessionsManager.version` | **v3.15.0 已同步**（现为 `3.15.0`） | 升 package 版本时要同步 5 处：`package.json`、`package-lock.json`（2 处）、`README.md` 的 badge、`src/client/index.jsx` 的 `version:` 字段 |
| 5 | `dsmFitPanel` 无单测（依赖 DOM） | 靠日志验证 | 若要测，抽纯函数算 `avail` 再测 |
| 6 | 上游若有新版格式（落盘 schema 漂移） | **v3.12.0 已加哨兵**：`npm run check:schema` 把 11 份落盘索引的 schemaVersion 钉成表，与 `upstream/main` 逐文件比对；`tests/check-schema.test.js` 3 项自检防止哨兵本身失效（常量改名、新增 store 忘了登记都会红） | 每次 rebase 前跑一次；上游改了版本号就按 §12 末尾的「schema 漂移处置」走 |
| 7 | MCP 服务器开关（`/archived-sessions/mcp/*` + 维护栏 sheet） | 已实现并通过单测（`tests/mcp-rows.test.js` 13 项 + `tests/mcp-routes.test.js` 2 项） | 真机点一遍；确认重启后 MCP 连接按新开关状态建立 |
| 9 | skill 列表管理（`/archived-sessions/skills/*` + 维护栏 sheet） | 已实现；单测 `tests/skill-rows.test.js` 21 项 + `tests/zip-lite.test.js` 15 项 + `tests/skill-routes.test.js` 5 项全绿 | 真机点一遍三态；确认切换后下一次对话里模型看到的目录随之变化 |
| 11 | skill 子系统的评审 16 条 | 全部处理完毕（v0.6.2）：服务端只读校验、解压炸弹、重复条目、重复键、行内注释、CRLF、`on` 不动点、tmp 撞名、客户端导出校验、覆盖备份、`import-dir` 的 srcDir 白名单、delete 强制 name、以及 4 处测试缺口 | 若再改 skill 子系统，先读 §10 的 17–26 条 |
| 12 | v0.6.3 全量自审修复的 4 项（MCP 原子写+回读校验、skill 删除进回收站、`dsmMetaCache` 整表替换、侧栏 interval 可卸载） | 全部已修并有回归测试（v0.6.3，§10 第 27–30 条） | 改这几处前先读 §10 第 27–30 条，别把「回收站放进 skills 根」这类坑再踩一遍 |
| 13 | `debug.log` 轮转 | **v3.11.0 已实现**：`src/debug-log.js`，单文件 4 MiB、保留 3 个副本（`debug.log.1..3`）、总足迹 16 MiB；写入前判定、超限先轮转；`tests/debug-log.test.js` 12 项 | 已闭合；上限常量在 `src/debug-log.js` 顶部，改完记得同步 `/capabilities` 的 `debugLog` 字段断言 |
| 10 | skill 导入导出的 license 边界 | `dsh-purge` 是**商业闭源**许可（禁止复制/修改/再分发），所以 zip 读写是自研的 `src/zip-lite.js`，未复制其任何代码 | 若日后要引入其实现，必须先取得授权 |
| 8 | `dsh-mcp-manager` 是否删除 | **2026-11-18 已手工卸载完成**（见 §16）：补丁 `insert` 块、`package.json` 依赖、`pnpm-lock.yaml` 三段、`node_modules` 目录、`node_modules/.modules.yaml` 的 hoistedLocations、`.dsh-market/state.json` 的 disabled 项全部清理 | 重启 DSH 后复查 `/dsh-market/installed` 的 `disabled` 不再含它 |
| 14 | **上游已前进 12 个提交**（`upstream/main` 最新 `cf9a5bb`，版本 3.8.1；我们停在 merge-base `ad04522` 之后的 `a8abec7`，**已推送**） | **2026-11-18 用户明确暂不升级 rc.3**。已吸收两项纯逻辑改动（v3.11.0）：`cefd98f` 的工作区筛选哨兵（`WS_UNGROUPED` / `WS_GONE` / `matchWorkspaceFilter`）与 `f010392` 的 `shouldHideEmptyGroup`（当前会话在组内时绝不整组隐藏）。**2026-11-25 复核**：上游这 12 个提交没有新功能，全是 0.2.2 兼容修补（`84cc522` rc.3 适配、`0d72015` 图标 slot、`e514e51`+`a05ad7e` projection cache 冷标题；`cf9a5bb` 只是定时任务改 `runtime-last-seen.json`）。仍暂不吸收：`84cc522` rc.3 适配、`e514e51`+`a05ad7e`（改造面大、收益仅冷启动） | 若日后跟进 rc.3，再按 §12 的冲突热区表逐步重放；`src/projection-hints.js` 未移植 |

| 15 | 胶囊联动里 `arknights`（方舟观测）/ `persona`（月相引路）两种样式 | **v3.13.0 只做了近似**：`arknights` → 扫描线 + 框角 + `akAccent`；`persona` → 右侧月相环 + 蓝光。用户在 m01857 明确「先做 5 种常用映射，这两种以后再补」 | 正式移植要对齐 `dsh-netease-lyrics` 的 `clip-path` 切角（`polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)`）与 `persona` 的月相环渐变；改 `src/client/capsule-link.js` 的 `capsuleStyle()` 分支 + `CAPSULE_FOLLOW_READY` 即可，UI 会自动把「暂未移植」提示去掉 |

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

### 12.1 schema 漂移处置（v3.12.0 加的哨兵）

本仓库与上游共用 `STATE_DIR` 与同一批文件名（`star.json` / `tags.json` / `session-meta.json` / `auto-archive.json` …）。上游若改了某份索引的 `schemaVersion` 或字段语义，本分支升级后会读到陌生数据；而两边都做「坏数据宽容」，症状是**安静地丢记录**而不是崩溃——所以必须靠主动检查。

```bash
npm run check:schema            # 与 upstream/main 逐文件比对
npm run check:schema -- --local # 没有 upstream 分支时只看本地常量是否与表一致
```

输出每行一个落盘文件，结论是这五种之一：

| 结论 | 含义 | 处理 |
| --- | --- | --- |
| `same` | 与上游同版本 | 无需动作 |
| `local-only` | 本分支独有的索引（`session-meta.json`、`workspace-archives.v1.json`） | 无需动作 |
| `LOCAL-MISMATCH` | 表里写的版本 ≠ 源码常量 | 改表或改常量，二者必须一致（否则哨兵已失效） |
| `UPSTREAM-GONE` | 上游删了这份索引或改了文件名 | 检查上游是否换了存储方式；本分支的旧文件会变成孤儿 |
| `DRIFT` | 上游改了版本号 | **必须处理**，见下 |

遇到 `DRIFT` 二选一：
1. **写迁移**：按上游新 schema 升本分支常量，并在读取路径里兼容旧版本（参考 `src/auto-archive.js` 的 `normalizeAutoArchiveStore` 全量收敛写法），然后把 `TABLE` 里的 `version` 改成新值。
2. **显式拒绝**：确认本分支不消费上游那份数据（或上游那份数据纯属上游自用）后，在本节记录「已知漂移，不兼容旧版本」，并把 `TABLE` 该行标成 `local-only`。

改完都要跑 `npm run check:schema` 与 `node --test tests/check-schema.test.js`（3 项自检：常量能扫到、本地自洽、新增 store 已登记）。

---

## 13. 给接手会话的第一天

1. 读本文件 + `git log --oneline -15`。最近一条应为 v3.15.0（模型路由面板）或其后；`main` 与 `origin/main` 可能差若干条未推送提交，见 §14。
2. `npm run build && npm test && npm run check:schema`，把失败数与 §7.2 的基线对齐（本机 4–5 项，按测试名对照）。若明显超出，先查是不是本机环境变了（`git stash -u` 对照 pristine 再 `git stash pop`）。
3. 打开面板，看 `debug.log` 里 `session-list:store-ready` / `panel:fit` / `host-list:loaded` 三行是否正常。
4. 要改 UI 前，先确认改的是现役选择器（`.dsm-qa-main` / `.dsm-qa-rail`），别改已停用的 `.dsm-qa-panel`。
5. 不要替用户做「拆三行 / 改名」这类产品决定；把方案摆出来让用户选。
6. 每次提交都跑 `check:dist`，并且把 `lib/` 一起提交。
7. 改 skill / MCP 子系统前先读 §10 的 17–30 条——那十四条全是评审与自审实测出来的真缺陷，且都有回归测试兜着，改的时候别把它们改回去。改工作区归档或 debug.log 前读 §10 的 31–36 条；改面板外观 / 胶囊联动前读 37–51 条；改后台任务前读 52–61 条；改模型路由前读 62–66 条。
8. `edit` 工具写 `src/client/index.jsx` 会产出 **CRLF**。改完用 `git diff --stat` 看行数，异常就用 node `.replace(/\r\n/g,'\n')` 归一化后再 `commit --amend`；长文件优先用 python/node 脚本改而不是 `edit`。

---

## 14. 远程与推送（本机特有）

- `origin` = `https://github.com/Mostimadesi/dsh-lyin-sessions-manager.git`（公开仓库，2026-11-13 由 API 创建，无初始提交，直接 push 的 `main`）。
- 认证：本机没装 `gh`；SSH 无可用 key（`Permission denied (publickey)`）；可用的是 **Git Credential Manager 里存的 GitHub token**（login `Mostimadesi`，scopes 含 `repo`）。
- **关键坑：bash 里的 `git` 不是 Git for Windows。** niubash 的 `git` 是 `2.56.0.windows.4.niugit`，没有 system `credential.helper`，所以
  `printf "protocol=https\nhost=github.com\n\n" | git credential fill` 会报
  `fatal: could not read Username for https://github.com: terminal prompts disabled`。
  改用 **`D:\Git\cmd\git.exe`** 才有 GCM：

  ```powershell
  :GCM_INTERACTIVE='never'; :GIT_TERMINAL_PROMPT='0'
  & 'D:Gitcmdgit.exe' push -u origin main
  ```

- 建仓（若仓库被删后要重建）走 API：`POST /user/repos`，body 里 `name: dsh-lyin-sessions-manager`、`private: false`；令牌用
  `& 'D:Gitcmdgit.exe' credential fill` 取（脚本见提交历史 / 请求上下文里的 `dsh_gh_create_repo.mjs`）。
- 不要在命令里回显 token；CC Safety Net 也会拦 `~/.git-credentials`、`~/.ssh` 的读取。
- 推送体积：`git count-objects -vH` 约 5.6 MiB（`lib/` 已提交、`node_modules` 忽略），常见网络下 push 可能要 30s 以上，别用 30s 超时的前台命令。

## 15. 最近几代改了什么（v0.6.1 → v3.15.0）

新会话不必回看 git log 的全部细节，这一节就是浓缩版；每条都能在 §10 找到对应的坑与纪律。最近新增的是 v3.11.0 / v3.12.0 / v3.13.0 / v3.13.1 / v3.13.2 / v3.13.3 / v3.14.0 / v3.14.1 / v3.14.2 / v3.14.3 / v3.15.0 十一节。

### v0.6.1 — skill 管理（`1223c46`）
- 新增 `src/skill-rows.js`（扫描宿主 skill 根、读/写 SKILL.md frontmatter、三态映射、导入导出、删除）与 `src/zip-lite.js`（零依赖 zip，只用 `node:zlib`）。
- `src/index.js` 加 6 条 `/archived-sessions/skills/*` 路由（list / mode / export / import / import-dir / delete），全部走 `registerRoute` 因此都在认证门内。
- 客户端维护栏加「Skill 列表」按钮 + sheet（三态分段控件 / 导出 / 导入 / 删除 / 已忽略目录）。
- **为什么不用 MCP 那套 `#OFF#` 注释行手术**：skill 在 `cordis.patch.yml` 里根本没有行，发现完全靠文件系统扫描；开关只能落在 frontmatter。

### v0.6.2 — 按只读评审的 16 条加固（`bb7f588`）
- 服务端开始校验 `writable`（`DSM_SKILL_READONLY`）、`delete` 强制 `name`、`import-dir` 的 `srcDir` 必须落在扫描根内（`DSM_SKILL_BAD_SRC`）。
- `readZip` 加 `maxTotalBytes` 并给 `inflateRawSync` 传 `maxOutputLength`（压缩炸弹：40 MB 的 0 压完只有 40 KB，靠 32 MiB 的请求体上限拦不住）。
- `setMode` 变成三态的不动点、重复键收敛成一行、剥行尾注释、沿用原文件换行符；导出不再打包自己的 `.bak-skill-*` / `.import-*`；覆盖导入改成把旧目录改名成 `<name>.replaced-<stamp>` 保留。
- 客户端导出改成 `fetch` + 校验 `content-type` + `createObjectURL`（裸 `<a download>` 会把错误 JSON 存成 .zip）；导入的 `overwrite` 不再写死，改成 `window.confirm`。

### v0.6.3 — 全量自审又抓到 4 个（`38029dc`）
- MCP 写 profile 改为「先回读校验 → tmp + rename」（`DSM_MCP_UNVERIFIED`），避免留下半份 YAML 让宿主判「非法的配置文件」。
- `deleteSkillDir` 默认移进 `~/.dsh/sessions-manager-trash/skills`（返回 `trashed`），不再硬删。
- `dsmMetaCache` 改整表替换（被删/被移走的会话不再常驻面板）。
- 侧栏 60s 兜底刷新的 `setInterval` 挂到 `dsmSidebarCleanup`，由 `dsmTeardownSidebarAug()` 清算。

### v3.11.0 — 日志轮转 + 已标记拆三行 + 上游筛选哨兵（`41113e7` + `f4802da`）
- 新增 `src/debug-log.js`：`debug.log` 单文件 4 MiB、保留 3 个副本（`debug.log.1..3`）、总足迹 16 MiB。写入前用 `shouldRotate()` 判定（`cur<=0` 或 `inc<=0` 直接不轮转，避免首次写就造空 `.1`），超限先 `rotateDebugLog()` 再 append。`/archived-sessions/debug-log` 的响应多回 `bytes` / `rotated`，`/capabilities` 多回 `debugLog: {maxBytes, keep}` 便于确认运行时是不是这份构建。
- `src/client/logic.js` 加 `QA_MARKED_KINDS` / `QA_MARKED_KIND_LABEL` / `QA_MARKED_KIND_HINT` / `markKindOf` / `markedRowsByKind`：把「已标记」按 star → review → priority 拆成三小行（一个会话只归第一个命中类，`badges` 仍显示全部标记），折叠键 `sec:marked:star` 等。原 `markedRows` / `markBadges` 保留未删（旧测试仍在用）。
- 吸收上游 `cefd98f` 的工作区筛选哨兵：`WS_UNGROUPED='__ungrouped__'` / `WS_GONE='__workspace_gone__'` / `isWorkspaceSentinel` / `matchWorkspaceFilter`，下拉里多出「未分组（没有工作区）」「工作区已删」两项；兜底 option 要排除哨兵值，否则渲染成「已删工作区 · ?」。
- 吸收上游 `f010392` 的 `shouldHideEmptyGroup(aliveCount, containsCurrent)`：**当前会话在组内时绝不藏组**。上游只渲染「当前会话」那一条 blank 行，插件又把 blank 行一律隐藏，组内可见数为 0；按 `aliveSessionCount === 0` 判空会把用户正在用的工作区连标题和「+」一起藏掉。

### v3.12.0 — 工作区归档 + 上游格式哨兵
- 新增 `src/workspace-archive-core.js`（纯逻辑，无 `node:` 导入，客户端也打包它）：`WORKSPACE_ARCHIVE_SCHEMA_VERSION = 1`、`workspaceKeyOf`（折叠分隔符与大小写、保 UNC 前缀、去尾斜杠）、`normalizeWorkspaceArchiveRecord` / `normalizeWorkspaceArchiveStore`（坏记录丢弃——丢记录只会「显示工作区」，永不「误藏」）、`archivedWorkspaceKeys` / `isWorkspaceArchived` / `pickArchivedWorkspaceItems` / `storeFromKeys` / `visibleItemsAfterWorkspaceFold`。
- `normalizeArchivedAt` **刻意返回 0 而不是 `Date.now()`**：读文件必须是字节的纯函数，否则每次读都会重排列表顺序；时间戳由写入方显式盖章。
- 新增 `src/workspace-archive.js`（只做文件 I/O，照 `src/auto-archive.js` 骨架）：`createWorkspaceArchiveStore({dir, indexPath})`，落盘 `workspace-archives.v1.json`，tmp + rename 原子写、`mode: 0o600`、单链 `mutate` 队列。**没照抄参考实现的锁文件**——本插件没有跨进程写者，锁是多余复杂度。
- 新路由 `/archived-sessions/workspace-archives`（POST `archive` / `unarchive` / `clear`，GET 纯读）：`archive` 时先在 `listWorkspaces()` 里按折叠键找条目，**找不到回 404**（防止自由路径把「碰巧同形」的工作区藏掉）。
- **语义 A（用户 m01112 拍板）= 只做可见性**：隐藏侧栏该工作区分组 + 面板会话列表过滤掉它的会话；**不动会话自身归档状态**，所以「已归档」视图保持干净；一键恢复即全部回来。
- 客户端：维护栏「工作区归档：N 个」按钮 + `mv-sheet` 弹层（逐工作区归档/恢复 + 全部恢复）；会话列表先过 `visibleItemsAfterWorkspaceFold`（`peekPath` 例外：用户在下拉里显式点名已归档工作区时不折叠，否则选中后一片空白）；五个派生集合的数据源从 `sessions` 全改成 `visibleSessions`，保证计数、搜索、全选、批量操作与列表口径一致；侧栏 `dsmSyncEmptyGroups` 里按 `group.cwd` 的折叠键 `setGroupHidden(scope, true)` 整组藏。
- 新增 `scripts/check-schema.mjs`（`npm run check:schema`）+ `tests/check-schema.test.js` 3 项自检，见 §12.1。
- **路由级测试补上后抓到两个真 bug（`3084ab3`）**：① `/archived-sessions/workspace-archives` 的 `changed` 曾把 store 的异构返回值（`archive()` 返回记录、`unarchive()` 返回布尔、`clear()` 返回计数）直接透给前端，前端 `if (r.changed)` 对记录对象恒真；改成「前后归档数量差」判布尔，`removed` 单独回计数。② `createWorkspaceArchiveStore` 曾不认 `DSH_SESSIONS_MANAGER_STAR_DIR`，测试写盘会落到用户真实的 `~/.dsh/sessions-manager/`；目录优先级补上这一级（与 `saved-filters.js` / `pending-moves.js` / `move-notices.js` 一致）。

### v3.13.0 — 快捷面板外观「跟随歌词胶囊」（`dsh-netease-lyrics` 联动）
- 新增 `src/client/capsule-link.js`（257 行，纯判定层，无 DOM / 无 localStorage，浏览器与 `node --test` 都能跑）：把 netease-lyrics 的 7 种胶囊样式（`default` / `frosted` / `wishes` / `ember` / `arknights` / `persona` / `solid`）映射成 12 个 `--dsmqa-*` 变量。核心是 `normalizeCapsuleConfig(input)`（数值夹逼 + 颜色校验，任何脏输入都算得出可用默认值）、`qaVarsFromCapsule(config, detail)`（`detail` 里的面板滑杆优先级**高于**胶囊快照）、`capsuleFollowInfo(config)`（中文名 + 是否已正式移植 + 未移植时的近似回落）。
- 数据来源是三个 localStorage 键（`dsh.netease-lyrics.display.v1` 的 `capsuleStyle` / `panelOpacity`、`…notice.v1` 的 `glassGrain/glassTint/glassAccent/glassRing/ember*/akAccent`、`…colors.v1` 的 `active`），读法与事件名都逐字镜像对方源码；`readCapsuleSnapshot()` 任一键读失败都返回 `null` → 跟随态回落默认胶囊，**不能让面板因为隔壁插件数据坏掉而变白板**。
- 面板外观下拉最前面加 `<option value={FOLLOW_PRESET}>跟随歌词胶囊（netease-lyrics）</option>`：`FOLLOW_PRESET = 'follow-capsule'` 不在 `QA_STYLE_PRESETS` 里，`readQaStyle` 要显式放行，否则刷新就被打回 `dark-glass`。跟随态下列表下方显示「当前胶囊：<中文名>」；`arknights` / `persona` 显示「本插件暂按 <近似> 近似，正式移植待后续」。
- `applyQaStyle()` 改成两条路径：跟随态走 `qaVarsFromCapsule`，普通预设仍走 v0.2.2 的老逻辑。**变量清理表从「某一个预设的键」换成 `QA_STYLE_VAR_KEYS`**——跟随态会写 `--dsmqa-wash/-grain/-glow/-sat`，只清普通预设的键会把这些留在 `:root` 上，切回去后一直带罩染。
- 面板本体上材质用属性开关：`applyQaStyle()` 写 `document.documentElement.dataset.dsmqaFollow = '1'`，CSS 里 `:root[data-dsmqa-follow="1"] .dsm-qa-main / .dsm-qa-rail` 才吃 `background-color / background-image / border / backdrop-filter / box-shadow`。wash 与 grain 并进 `background-image` 两层（grain 在最前、`calc(var(--dsmqa-grain) * .34)` 降权），**不能用绝对定位伪元素**——两个形态都是 `overflow-y:auto`，`inset:0` 的伪元素会随内容滚走、下半截面板变裸背景，且两个伪元素互相遮盖（`7ce03e9` 修的）。**普通预设视觉与 v3.12.0 完全一致**（老用户升级不突变）。
- 事件监听：`dsh-netease-lyrics-display` / `-notice` / `-colors` 三个 CustomEvent + `window` 的 `storage`，同一个 `AbortController` 挂在 `ctx.effect` 上；回调先判 `readQaStyle().preset !== FOLLOW_PRESET` 就早退，非联动用户零开销。
- `tests/capsule-link.test.js` 17 项：三键三事件逐字镜像、7 样式映射齐全、`QA_STYLE_VAR_KEYS` 覆盖所有样式输出（防漏登记）、数值夹逼、颜色校验、面板滑杆优先级、`solid` 忽略胶囊 opacity 但仍认滑杆、`arknights` 用 `akAccent`、歌词高亮色成为面板强调色。

### v3.13.1 — 胶囊材质只包住内容，用户看截图指出三处范围问题
- 用户 m02223 发两张截图：主面板吸顶条是**不透明深色横条**、与下方半透明材质分层；右栏列表只到「待回看」就断，**下面一大片只露宿主底色**；主面板宽屏时仍是 **760px 居中窄卡**。
- 三处分别对应：① `.dsm-qa-sticky` 在跟随态取了 `--dsmqa-solid`（不透明）；② 面板只包住内容高度（`panel:scroll` 日志实测内容 321px），材质只画在那块盒子上；③ `--dsmqa-width` 仍是预设的 760px，`margin:0 auto` 居中。
- 修法：① 吸顶条改 `color-mix(in srgb, var(--dsmqa-bg) 62%, transparent)` + 同参数 `backdrop-filter`（**不用全透明**：`backdrop-filter` 嵌套时未必生效，失效就成文字叠字），并补 `border-radius: <半径> <半径> 0 0` 让顶边跟着面板圆角；② `dsmFitPanel` 把已算出的可用高度顺手写成 `--dsmqa-avail`，跟随态用 `min-height: var(--dsmqa-avail, auto)` + `box-sizing: border-box`（用 `min-height` 不用 `height`：内容超长时仍由 `max-height` + `overflow` 接管）；③ 跟随态默认 `vars['--dsmqa-width'] = prefs.width != null ? prefs.width + 'px' : 'none'`，只有用户显式拖过宽度滑杆才用那个值。
- UI 配套：宽度滑杆在 `prefs.width == null` 时标签显示「铺满整区」（而不是一个会误导的 760 数字），并给一个「改回铺满整区」按钮把 `width` 重置回 `null`。
- 新增 §10 第 44–46 条记录这三处。

---

### v3.13.2 — 吸顶条挡住搜索框、面板顶部留缝

- 用户 m02368 发右栏截图：吸顶条（深紫、含标题与四色统计）**压住筛选输入框的上半截**，只剩 placeholder 的下半行；同时吸顶条上沿与侧栏顶部导航之间还**留着一截宿主底色**。
- 截图逐行采样（446×175）确认：顶部 16px 宿主底色 → 吸顶条到 y≈120 → y≈124 起就是被裁掉一半的搜索框。
- 根因一：搜索框是吸顶条的**兄弟节点**，跟着正常文档流滚；面板一滚动它就滑到吸顶条底下。`position:sticky` 只固定自己那一块，不会替兄弟节点让位。
- 根因二：面板顶到宿主容器顶的距离不是常数（视口高度、宿主 tabBody 内边距都会变），跟随态又没吃这截距离，于是材质卡片顶边下方露出宿主底色。
- 修法：① 把 `<input className="dsm-qa-search">` 移进 `.dsm-qa-sticky` 内部一起吸顶；吸顶条 `padding` 尾值 `0` → `12px` 收口，并新增 `.dsm-qa-sticky .dsm-qa-search{margin-bottom:0}`；② `dsmFitPanel` 量出 `gapTop = clamp(el.top - anc.top, 0, 40)` 写成 `--dsmqa-gap-top`，跟随态 `margin-top:calc(-1 * var(--dsmqa-gap-top,0px))`，并把多吃的这截距离加回 `max-height` / `--dsmqa-avail`（不加回去底边会空出同样一截）；③ 吸顶条 `top` 保持 `0`，不写负值。
- 顺带增强 `panel:fit` 日志：追加 `pt=`（面板顶到容器顶）、`st=`（吸顶条高度）、`stTop=`（吸顶条顶相对面板顶）、`sh=` / `chh=` / `stv=`，下次判断「空隙在面板外还是面板内」不用猜。
- 新增 §10 第 47–49 条记录这三处。

---

### v3.13.3 — 「修了但空隙还在」

- 用户 m02606 复查后发截图：v3.13.2 之后「与侧栏顶部导航之间的一截空隙」**仍然存在**。
- 读日志定位（`panel:fit ... pt=0 st=101 stTop=11` / 全屏 `pt=0 st=133 stTop=19`）：面板顶已经贴住容器顶（`pt=0`），但吸顶条顶相对面板顶仍有 11–19px —— 空隙不在面板外，在**面板内**。
- 根因一（真凶）：`gapTop` 依据 `el.getBoundingClientRect().top - ar.top` 计算，而负 `margin-top` 一旦生效这个差值恒为 0；`dsmFitPanel` 每次（resize / 1200ms 补测 / 滚动探针）重算都会把 `--dsmqa-gap-top` 写回 0，面板于是弹回原位。**修法是让这件事幂等**：先读回上次写下的 `--dsmqa-gap-top` 加回去得到「自然位置」，再据此决定这次吃多少；`avail` 同步减 `offset + appliedGap`。
- 根因二：面板自己的 `padding-top`（rail 10px / main 18px）把吸顶条往下推，吸顶条原有负 `margin` 本应抵掉，但跟随态面板又加了负 `margin-top`，两条叠加后几何关系变了。修法是跟随态显式 `padding-top: 0`（面板）+ `margin-top: 0`（吸顶条）。
- 新增 §10 第 50–51 条。

---

### v3.14.0 — 侧栏「后台任务」

用户痛点原话：「尽管会话已经结束，但会话留下的后台任务仍然在进行，此时用户难以确定是哪个会话还有后台任务」。

形态由用户拍板：不做新的面板分区，只在侧栏会话行前挂一个小三角（`▸ N`），点开就地列出「任务名 + 运行时长」；并且**有后台任务的会话即使已读也保持「刚完成」**。

- 新增 `src/background-jobs.js`（纯逻辑，host/client 共用）。host 侧 `sidebarAuthority()` 通过 `backgroundJobsField()` 下发 `backgroundJobs: { <sessionId>: [{id,label,kind,status,startedAt}] }`，没有活作业就不下发该字段。
- 客户端复用子代理列表那套幂等容器（`dsmSyncJobList` / `dsmDropJobList` / 签名比对），但数据不走 fetch——快照随 sidebar-state 一起来，展开只是把当下的 Map 画出来。
- 轮询节拍：`cadence` 在 `dsmJobMap.size` 非空时收紧到每拍（4s），否则作业结算后三角要卡 32s 才消失，会让人以为那活儿一直没完。
- 测试：`tests/background-jobs.test.js` 20 项、`tests/background-jobs-routes.test.js` 4 项（含「宿主没有 jobs/agents 时载荷形状与 3.13.x 一致」这条向后兼容断言）。

### v3.14.1 — 后台任务挪进「进行中的会话」面板

v3.14.0 把三角做在了侧栏 DOM 注入层，用户反馈「左侧工作区树里有下拉栏，但侧边栏『进行中的会话』里反而没有」——真正的落点应该是插件自己的面板。

- `SessionPanel` 里新增 `jobsOf` / `toggleJobsOf` / `renderJobsBadge` / `renderJobList` 四个渲染 helper，`renderSec` 与 `shownGroups` 两处行渲染都插进去（关注区与次级区一视同仁）。展开态仍用模块级 `dsmJobsOpen`（与侧栏那套共用同一个 localStorage 键 `dsm-jobs-open-v1`），配一个 `setJobsVer` 计数器强制重渲染。
- 面板行从 `<button>` 改成 `<div role="button" tabIndex={0}>`——行内要放一个真按钮，`<button>` 里嵌可聚焦元素在键盘上够不到。补 `.dsm-qa-row:focus-visible` 的 outline 兜住失去的按钮语义。
- `dsmRowsFromUiSession()` 增加「回合结束 + 已读 + 仍有活作业 → 仍算 `done`」这一支，面板才留得住这一行。
- 侧栏那套（`paint()` 里的 `dsm-jobs-badge`）暂时保留：宿主会话列表里也能看出「这行还有活儿」，两处共用同一个展开态。若日后只想留一处，删 `paint()` 那个分支与 `dsmSyncJobList` 即可，面板侧不受影响。


### v3.14.2 — 三角外观对齐侧栏 + 长任务名不再撑宽面板

用户并排贴了两张截图（面板 vs 工作区树）指出三角不一样，并发现展开后台任务列表后长任务名会把整个面板横向拉长。两处都是 CSS 问题，逻辑没动。

- 三角：`.dsm-qa-jobs-t` 之前只有 `color` / `font-size`，浏览器把 `<button>` 的默认可视样式全画出来了（灰底、圆角、内边距）。现在补齐 `appearance:none` / `border:none` / `background:transparent` / `font:inherit` / `border-radius:6px` / `line-height:15px`，与侧栏 `SIDEBAR_AUG_CSS` 里的 `.dsm-jobs-badge` 逐条对齐。
- 不撑宽：flex 子项的 `min-width` 默认 `auto`，`text-overflow:ellipsis` 要生效必须让链条上每一环都能收缩——`.dsm-qa-job-name{flex:1;min-width:0}`、`.dsm-qa-jobs{min-width:0;max-width:100%;overflow:hidden}`、`.dsm-qa-row{min-width:0;box-sizing:border-box}`、`.dsm-qa-group{min-width:0}`、`.dsm-qa-main/-rail{width:100%;box-sizing:border-box}`。对应 §10 第 58 / 59 条。
- 纯 CSS，无新增用例（`npm test` 仍是 561 项，基线 4–5 项 Windows 失败）。
## v3.14.3 面板宽度回归

为什么：v3.14.2 为了让长任务名不把面板撑宽，给 `.dsm-qa-main` 和 `.dsm-qa-rail` 都加了 `width:100%`。这解决了「被内容顶宽」，但也把面板变成「永远铺满整块区域」——用户 m03562 反馈「现在面板默认就是被撑宽的状态，看起来不太自然」。这两件事不是一回事：内容不该决定宽度，面板自己也不该强制占满。

改法：
- `.dsm-qa-main`：删掉 `width:100%`，保留 `min-width:0`、`max-width:var(--dsmqa-width,760px)`、`margin:0 auto`。宽度回到块级默认（跟随父容器），再由 `max-width` 封顶、`margin:0 auto` 居中。
- `.dsm-qa-rail`：`width:100%` + `max-width:none` 改为 `min-width:0` + `max-width:100%`。侧栏本来就是窄栏，靠父容器给宽即可。

保留 v3.14.2 的下游收缩链（`.dsm-qa-jobs` / `.dsm-qa-job-name` / `.dsm-qa-row` / `.dsm-qa-group` 的 `min-width:0` + overflow），那是防「被内容顶宽」，与本条不冲突。


### v3.15.0 — 模型路由面板

用户 m03631 提的：「本机实现了模型路由（llm-router 和 subagent-router），你能将"模型路由"也加入到管理范围里吗」；m03726 拍板范围：第 2 层（常用编辑）、两个插件做成同一弹层的两个分区、尽量全功能、**保留原入口**。用户还纠正了一句语气：「你说"这个面板会是它第一份图形界面"，但你应该修改/添加的是自身的适配」——这个面板是本插件的适配层，不是给 llm-router 做 UI。

可行性来自两边都是纯 JSON + 指纹轮询：改文件 5 秒生效，不需要调用任何内部 API，也不需要重启。

- `src/router-core.js`：两个插件 normalizer 的镜像（纯逻辑，无 `node:` 导入）。`parseCandidate` / `normalizeLlmRoute` / `normalizeLlmSettings` / `addRoute` / `updateRoute` / `removeRoute` / `moveCandidate` / `formatRoute`，子代理侧 `normalizeSubagentCandidate` / `normalizeSubagentSettings` / `addSubagentCandidate` / `updateSubagentCandidate` / `removeSubagentCandidate` / `moveSubagentCandidate` / `appendRouterCandidates`（对应 `/subagent-router reload`，只加不改），加 `applyLlmOp` / `applySubagentOp` 两张分发表与 `crossCheck`（悬空候选 + 没被借用的路由组）。`RouterError` 带 `status: 400`，界面直接显示它的中文原文。
- `src/router-store.js`：文件 I/O。`resolveDshHome()` 与插件一致（`DSH_HOME` 优先）；读带 `mtimeMs:size` 指纹缓存；写走 `temp + rename`，改前落 `.bak-routerui-<时间戳>`；`snapshot()` 一次给出两个表 + `check` + `needsRestart: false`。
- host 侧两条路由：`POST /archived-sessions/router/snapshot` 与 `POST /archived-sessions/router/apply`（body `{ target: 'llm'|'subagent', op }`）。apply 的响应里直接带最新 `snapshot`，所以客户端不用二次请求。
- 客户端：维护栏右侧第三个按钮「模型路由（N）」，`mv-sheet` 里 `mv-seg` 两个分区。LLM 分区：总开关 / 提示方式 / 默认策略 / 全局粘性、每条路由的链（`↑↓` 逐跳挪）、编辑（显示名 + 一行一个候选的 textarea）、删除、新建。子代理分区：总开关 / 引导开关 / 「从 LLM 路由补全」、每条候选的 `↑↓` / 轻⇄重切换 / 删除，悬空候选标红「路由组已不存在」。
- 测试：`tests/router-core.test.js` 20 项、`tests/router-store.test.js` 14 项、`tests/router-routes.test.js` 6 项。全量 55 → 58 个文件、561 → 601 项。

一处刻意的取舍：编辑链用「一行一个候选的 textarea」而不是逐个加/删的小控件。因为候选的合法形状（`provider/model`、`@effort`、拒绝嵌套路由组）本来就只能靠文本表达，做成结构化控件反而要复刻一遍解析规则；textarea 让 host 侧的 `parseCandidate` 成为唯一裁判，报错原文也能直接贴给用户。


## 16. 手工卸载 `dsh-mcp-manager`（2026-11-18 实录）

背景：本插件的 MCP 开关能力不依赖 `dsh-mcp-manager`，用户要把它彻底移除，但市场（`dshmarket`）两条路都走不通。这节记录为什么以及怎么手工做完的，第二次遇到同类问题时照抄。

### 16.1 两道关卡

**关卡一：`cordis.patch.yml` 的 `insert` 引用**
市场在 `node_modules/dshmarket/lib/patch.js:181` 有 `export function userPatchPackageReferences(patchPath, packageName)`：解析补丁文本，收集所有 `insert` 行里的 `name`，命中即返回清单。返回非空数组 → **市场拒绝卸载且不可 force**；返回 `null`（补丁无法解析）→ 属「不可判定」，可以 `force` 绕过。
报错文案在 `node_modules/dshmarket/lib/routes.js:6197`（不是 app.asar —— 在 asar 里搜中文永远 0 命中，别浪费时间）。

**关卡二：`removeBundle` 的 `not-removable`**
宿主 `app.asar` 里：
```js
const bundle = (await this.listBundles()).find((item) => item.name === name);
if (bundle === void 0 || !bundle.removable) throw new ManagementFailure("not-removable");
```
`readBundles()` 的名字来源是 `dsh.profile.bundles` ∪ `manifest.dependencies` ∪ 已安装记录 ∪ 目录扫描，所以「在 dependencies 里、不在 bundles 里」**不会**导致 `bundle === void 0`。真正的拦路者往往是 409 `agentsBusy`（`routes.js:6205`，「有 agent 正在运行」），关掉/等完所有会话即可。

### 16.2 手工卸载步骤（按顺序）

目标目录：`C:\Users\<用户名>\.dsh\profiles\desktop\`。**每一步前先备份**。

1. **补丁块**：删 `cordis.patch.yml` 里 `- insert:` 及其下的 `- id: mcp-manager` / `name: dsh-mcp-manager`，同时删 `- id: mcp-manager` + `disabled: true` 覆盖行。**如果改用注释而不是删除，必须把 `- insert:` 一起注释掉**——只注内容会让 YAML 解析出 `insert: null`，宿主判整个 profile 非法。
2. **`package.json`**：从 `dependencies` 删该行。`dsh.profile.bundles` 本来就不含它（已 unbundle），不用动。
3. **`pnpm-lock.yaml`**：删三段 —— importers 里的 `      dsh-mcp-manager:\n        specifier: …\n        version: …`、`packages:` 下的 `  dsh-mcp-manager@0.6.0:` 及其 `resolution:`、`snapshots:` 下的 `  dsh-mcp-manager@0.6.0: {}`。**不要跑 `pnpm install --fix-lockfile`**（会重解析整张图）；本机 lockfile 另有 `billion-context` 版本漂移，跑 install 会先撞 `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`。手写手术时先 `split(chunk).length-1 === 1` 断言唯一匹配再 replace，删完用 `node_modules/js-yaml` 解析验证。
4. **`node_modules/dsh-mcp-manager`**：先 `lstat` 确认不是符号链接、`realpath` 等于自身、父目录是 `node_modules`，再 `fs.rmSync(dir, {recursive:true, force:true})`。
5. **`node_modules/.modules.yaml`**：删 `hoistedLocations` 里 `"dsh-mcp-manager@0.6.0": [...]` 那一行（pnpm 元数据，留着无害但下次 install 才自愈）。
6. **`.dsh-market/state.json`**：从 `disabled` 数组里去掉该包。**这个文件是单行压缩 JSON、无缩进、无尾换行**（市场自己的 `writeMarketState` 就是 `JSON.stringify({...})`，字段顺序 `disabled, groups, groupOrder, favorites?, blocked?, updateExempt?, notes?, …`），用 `JSON.stringify(s, null, 2)` 写回虽然语义等价，但形态就与市场不一致了。
7. **重启 DSH**，然后 `GET /dsh-market/installed` 复查：`present` / `bundles` / `unbundled` 都不含它，`activation` 里没有该 key，`disabled` 也不再含它。

### 16.3 不该做的事

- **不要在 app.asar 里搜中文报错文案**：`无法卸载` / `仍通过 insert 引用` / `桌面端自己管理` / `市场不能移除它` 全部 0 命中。中文文案在 `node_modules/dshmarket/lib/*.js` 里；asar 里只有逻辑和 zod 枚举字面量。
- **不要为了卸载一个包跑 `--fix-lockfile`**：会把整张依赖图重解析，牵连到无关包。
- **不要相信「bundles 里没有 → bundle === void 0」这个推断**：`readBundles()` 会把 `dependencies` 里的每个名字都产出一条。

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
