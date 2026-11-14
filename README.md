# dsh-lyin-sessions-manager

![version](https://img.shields.io/badge/version-3.9.0-facc15?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe?style=flat-square)

**[TOBYCAI/dsh-sessions-manager](https://github.com/TOBYCAI/dsh-sessions-manager) 的个人分支。** 上游的会话管理能力全都在，另外加了一个「进行中的会话」快捷面板。装哪个自己判断：要稳就用上游，要这个面板就用这里。

DSH 的会话一多，能做的事就只剩「翻侧栏」和「忘掉它曾经存在过」。这个插件把散在侧栏与设置里的会话操作收拢成两个入口：**设置 → 会话管理**做批量与危险操作，**主页侧栏的 ⋯ 菜单**做高频的单条操作，不用打开设置面板。

```
浏览器半 (React)        宿主半 (Node)
  侧栏 ⋯ 菜单         -->  /archived-sessions/*        归档 · 回收站 · 移动 · 标签
  设置面板            -->  /archived-sessions/*        存储占用 · 自动归档 · 批量操作
  快捷访问面板        -->  /archived-sessions/sessions 快捷面板主数据（不新增请求）
                          （能力按 Runtime 实测探测；删除与移动走守卫式路径推导）
```

装完就有的能力：归档 / 恢复 / 跨工作区移动 / 回收站（可恢复、可批量清空、可 7–30–90 天自动清理）/ 子代理折叠 / 分支标记 / 空白会话清理 / 标签与筛选预设 / 存储占用分析 / 自动归档 / Markdown 导出。

![主页侧栏的 ⋯ 菜单：标记未读、重命名、分叉、归档、移动会话（悬浮子菜单列出工作区）、删除](assets/screenshot-session-submenu.png)

**Contents:** [为什么有这个分支](#为什么有这个分支) · [前置条件](#前置条件) · [安装](#安装) · [快速上手](#快速上手) · [功能](#功能) · [截图](#截图) · [设计取舍](#设计取舍) · [配置](#配置) · [故障排查](#故障排查) · [已知边界](#已知边界) · [开发与测试](#开发与测试) · [来源与许可](#来源与许可)

## 为什么有这个分支

上游的侧栏管理够用，但缺一个「现在有哪些会话在动」的全局视图——只能一个个工作区展开看。这个分支补的就是这块：一个常驻面板，把**进行中 / 待反馈 / 出错 / 刚完成**四类会话摊在一屏里，点一下就跳过去。

除此之外没有改动上游的行为。所有上游的能力、路由、数据格式、降级策略都原样保留，上游发版时本分支按 `docs/HANDOFF.md` 的 rebase 指南跟进。

如果你只想要会话管理，不要额外面板，装上游即可。

## 前置条件

| 项 | 要求 |
| --- | --- |
| 宿主 | DSH Desktop 或 `dsh web` 均可，同一套 host + client |
| 系统 | 跨平台（macOS / Windows / Linux）——DSH 能跑的地方就能跑 |
| Node | 约 `^22.19` 或 `>=24`（宿主侧只用标准库与 `zstd` 解码；`package.json` 未声明 `engines`，以实测版本为准） |
| 构建 | 只想用的话不需要：`lib/` 已预构建；改源码才要 `esbuild` |

插件通过 DSH 官方的 `ctx.storageDomain`、`snapshot` / `SessionHandle`、`uiWorkspace.openSession` 等公共契约工作，**不读 DSH 内部私有模块**。唯一的例外是删除与跨目录移动——官方没开放这两个 API，见[设计取舍](#设计取舍)。

## 安装

```sh
# 方式一：Git 依赖直装（推荐，无需 clone，重启 DSH 生效）
dsh plugin --profile desktop add "github:Mostimadesi/dsh-lyin-sessions-manager"

# web 端（若你也用 dsh web）
dsh plugin --profile web add "github:Mostimadesi/dsh-lyin-sessions-manager"

# 方式二：本地 link（开发调试）
git clone https://github.com/Mostimadesi/dsh-lyin-sessions-manager.git
dsh plugin --profile desktop add link:/path/to/dsh-lyin-sessions-manager
```

卸载：

```sh
dsh plugin --profile desktop remove dsh-lyin-sessions-manager
```

> 装完**重启 DSH**（web 端刷新页面重新加载 bundle），然后去 设置 → 会话管理，或者把鼠标移到侧栏任意会话上点 `⋯`。

## 快速上手

三个动作覆盖日常九成需求：

1. **归档**——侧栏 `⋯ → 归档会话`，会话从列表消失，随时可在 设置 → 会话管理 → 已归档 里恢复。
2. **删除**——`⋯ → 删除会话` 只是**移入回收站**，日志还在磁盘上；真删要去回收站里点「彻底删除」。
3. **移动**——`⋯ → 移动会话` 悬浮列出所有工作区，选一个就移过去；当前工作区标「当前」并置灰。

要紧的一条：**顺手删掉的东西不会真的消失。** 这是设计，不是 bug——回收站是唯一会物理删除日志的地方，而且它还要过三层路径校验才肯动手。

## 功能

### 设置面板：会话管理

一个页面装下所有批量操作：归档 / 恢复 / 移动 / 删除 / 全选。

- **血缘分组**（默认视图）：分支会话聚拢在父会话下的「来源：」组头里，子代理会话不占顶层行。子代理不计入「全部 / 活动 / 已归档 / 空白」的计数、不参与全选——它们是父行的「N 子代理」。
- **未归属的子代理会话**：父会话已被删/归档/筛掉的子代理，统一收进列表末尾这张卡片（默认收起，搜索命中自动展开），不会以「(无标题)」行铺满列表。
- **平铺视图**：与 DSH 原生一致，子代理逐行并列、可单独勾选。
- **标记**：分支会话带绿色「⑂ 分支」，悬停显示来源父会话；空白会话带灰标，可进「空白」视图统一清理。
- **批量多选**：勾选后操作栏**吸顶**钉在面板顶部。全选只覆盖当前列表里真正占一行、可单独勾选者的会话——折叠中的子代理、聚拢的分支成员、「来源：」组头都不参与。
- **导出**：详情面板底部两个入口——「下载原始日志 (ZIP)」直接走官方 `session.export`（含子会话与附件，后端不支持时自动隐藏）；「导出 Markdown」把会话渲染成人类可读对话记录（front matter + 按轮分节 + 工具调用摘要，流式增量不重复）。
- **存储占用分析**：按工作区聚合日志磁盘占用（占比条 + 会话数），列出 Top 10。纯只读，**默认收起、展开才统计**，不拖慢列表加载。
- **自动归档**：可把 30 / 60 / 90 天未活跃的会话自动收进「已归档」，**默认关闭**。当前会话与已收藏会话（该保护可关）永不自动归档；只标记不删数据。打开面板时惰性触发，每天最多一次，也可点「立即检查」。
- **标签与筛选预设**：标签支持新建 / 重命名 / 并入 / 删除 / 给会话批量设置；筛选预设最多 20 个。

### 侧边栏：⋯ 菜单增强

- **标记未读**：菜单顶部切换「标记未读 / 标记已读」；也可直接点会话左侧状态圆点。进入该会话后自动清除。
- **移动会话**：右侧悬浮子菜单列出工作区名称，选一个即移动；当前工作区标「当前」并置灰。
- **删除会话**：先移入回收站，不是立即物理删除。

### 侧边栏：子代理折叠与分支标记

上游侧栏按设计不渲染子代理行。插件按官方血缘字段（`origin: 'subagent'` / `parentSession` / `delegationDepth`）把子代理行**就地注入**父会话之下：「▸ N 子代理」徽标在该行被选中或悬停时出现，点开是缩进的子代理行，行内点击即通过官方 API 打开。子代理被删除后折叠列表同步收敛。

分支会话在选中或悬停时显示绿色「⑂ 分支」chip。空白会话在 0.1.3+ 上游本就不进侧栏，插件侧同步隐藏并把管理入口收敛到设置面板的「空白」视图。

![侧栏子代理折叠：「▸ 4 子代理」徽标 + 就地展开，父行带「⑂ 分支」标记](assets/screenshot-session-subagent.png)

### 侧边栏：状态圆点

插件隐藏 DSH 原生状态点，按下表重新渲染，避免两个点并存。

| 颜色 | 状态 | 说明 |
| --- | --- | --- |
| 🔵 蓝 | 手动标记未读 | 通过 ⋯ 菜单或点击圆点标记；进入会话后自动清除 |
| 🟡 黄 | 工作中 | 会话正在运行（新版 `ongoing`，兼容旧版 `running`） |
| 🟠 琥珀 | 等待反馈 | 会话有追问，需要用户输入或确认（`warning`） |
| 🟢 绿 | 完成后未读 | 会话已完成（`done`）但还没重新打开；看过一次即消失 |
| 🔴 红 | 出错 / 需关注 | 会话遇到错误（`error`） |
| 无圆点 | 完成后已读 / 空闲 | — |

### 回收站

独立视图，显示待清理数量与删除时间。正常删除先进入回收站，**不会立即从磁盘移除**，也不会被归到「未分组」。

- 单条可**恢复**（回原工作区）或**彻底删除**（物理清理日志）；支持一键清空。
- 保留策略：永久保留，或 7 / 30 / 90 天自动清理；可校验日志完整性。
- **删父连带子**：默认把整棵子代理子树一起移入回收站（确认框可取消勾选保留）。恢复或彻底删除父会话时同样级联，不会在回收站留下无父孤儿。用户单独删掉的子代理不会被父会话重新认领。
- 索引用版本化 schema、串行变更、原子写入；旧版数组索引自动迁移。
- 彻底删除会先写后端墓碑，再等 live Session 与持久化控制器退出、移除日志、重建工作区索引。即使重连或宿主仍有旧索引，也不会重新出现或生成空的「未分组」。

### 移动活跃会话（排队移动）

DSH 0.1.5 起每个会话日志有**单写者锁**：会话一旦被打开（包括只是选中），写所有权就被 agent-loop 持有。官方没有「关闭会话 / 释放所有权」的入口——**所有权只在 DSH 进程退出时释放**（切换会话不释放，实测空闲等待也不释放）。此时强行搬运会在旧路径重建空壳目录。

所以被占用的会话走**排队延迟移动**：

- 命中占用**不报失败**，登记进待移动队列（`~/.dsh/sessions-manager/pending-moves.json`），并如实提示「已排队」——绝不会没搬就报「已移动」。
- 自动执行时机：**插件启动后密集重试**（0 / 1 / 3 / 6 / 12 / 30 秒，抢在浏览器打开会话之前）、之后每 2 分钟轻量兜底、以及宿主释放会话时。
- 队列最多 50 条；同一条连续 5 次因**非占用原因**失败会被放弃并记日志（启动 30 秒内的失败不计入，避免启动竞态丢队列）。
- **结果不静默**：后台完成或最终放弃会落成通知，下次打开页面时弹出（放弃类附原因）。通知在服务端保留到确认展示（最多 20 条、最长 7 天），没弹就不会丢。

> 真要搬走一个活跃会话：先发起移动（进队列），再**重启 DSH 并先别打开那个会话**——启动后几秒内自动完成。未完成项跨重启保留。

### 快捷访问面板（本分支新增）

侧栏入口 + 右栏标签页两个形态，共用同一份数据（复用面板已经在拉的 `/archived-sessions/sessions` 载荷，**不新增请求**）。

- **关注区**：按「进行中 / 待反馈 / 出错 / 刚完成」四组分列，每组可收起；顶部摘要条一行给出四组计数与「共 N 个会话」。
- **最近活跃**：时间维度——「我刚才在忙什么」。取宿主列表的 `updatedAt`（= 日志文件 mtime），窗口 12 小时，最多 8 行。
- **已标记**：标记维度——「我自己标过要看的」。★收藏 / 待回看 / 优先级 ≤2 三者合并去重，P1 在前，最多 6 行。
- 关注区已列出的会话在两个次级区里一律排除，同一个会话不会出现两次。
- **不重复、不猜数字**：没有可信时间戳（或时间戳在未来，时钟漂移）时时间副标留空，宁可什么都不写，也不显示「-3 分钟前」。
- 子代理在次级区同样折叠进父会话，`updatedAt` 取子树最大值——子代理刚动过，父会话也算最近活跃。
- 标题条 + 摘要条**一起吸顶**，列表再长也不用滑回顶部；搜索框按标题 / 状态 / 工作区筛选；「在右栏打开」可与会话并列查看。

### MCP 服务器开关（本分支新增）

设置 → 会话管理 → 维护栏 →「MCP 服务器」，列出当前 profile 的 `cordis.patch.yml` 里所有 MCP 行并就地开关。

- **只改 profile 文件，不引入第二份配置。** 与 `dsh-mcp-manager` 那类「另存一份 `mcp-servers.json`」的插件不同，这里读写的始终是 DSH 真正加载的那份 `cordis.patch.yml`，不存在两套配置打架。
- **关掉一个 `- insert:` 块内条目时，块头会一起被注释。** 这是关键：只注释条目、留着 `- insert:` 会让 YAML 解析出 `insert: null`，插件市场随即报「非法的配置文件」。块里还剩别的启用条目时，块头保持不动。
- **开启时块头会被顶格到第 0 列。** 手写文件里块头常带缩进（本机是 4 与 2 空格），带缩进的 `- insert:` 会嵌进上一条目的 `config:` 里，同样是非法结构。
- 顶层行（不在 `- insert:` 块里）关掉时不注释，改为在文件末尾追加 `- id: X` + `disabled: true`——profile 原生就这么关插件，语义最稳。
- 每次写入前落 `.bak-mcpui-<时间戳>` 备份，改完**重启 DSH 生效**。
- 只识别、只开关；不新增、不删除、不编辑 command / args。要加新的 MCP 服务器仍然手写 `cordis.patch.yml`。

## 截图

<table>
<tr>
<td width="50%"><img src="assets/screenshot-session-settings.png" alt="设置面板「会话管理」：血缘分组 / 空白视图 / 筛选收纳"><br><sub>设置面板：血缘分组、空白视图、筛选</sub></td>
<td width="50%"><img src="assets/screenshot-session-multimove.png" alt="批量移动面板与吸顶批量操作栏"><br><sub>批量移动与吸顶操作栏</sub></td>
</tr>
<tr>
<td><img src="assets/screenshot-session-trash.png" alt="回收站：可恢复、可彻底删除、支持自动清理"><br><sub>回收站</sub></td>
<td><img src="assets/screenshot-session-details.png" alt="会话详情：磁盘占用 / 统计 / 工具使用"><br><sub>会话详情</sub></td>
</tr>
<tr>
<td><img src="assets/screenshot-session-empty.png" alt="空白会话视图（事件类型法识别）"><br><sub>空白会话视图</sub></td>
<td><img src="assets/screenshot-session-starred.png" alt="已收藏（星标）视图"><br><sub>已收藏视图</sub></td>
</tr>
<tr>
<td><img src="assets/screenshot-session-autoarch.png" alt="自动归档面板（维护栏内联展开）"><br><sub>自动归档</sub></td>
<td><img src="assets/screenshot-session-storage.png" alt="存储占用分析（维护栏内联展开）"><br><sub>存储占用分析</sub></td>
</tr>
</table>

<sub>截图来自作者的实机 DSH 0.2.x，深色 / 浅色主题下都会跟宿主令牌走，不写死颜色。</sub>

## 设计取舍

这一节解释几处看起来「多此一举」的地方——它们都是为了不假装成功。

### 能力按 Runtime 实测开放，不按方法名猜

插件同时识别旧式 header 列表 / `readFrom` 与新版 snapshot / `SessionHandle`，按当前 Runtime 的**实际能力**启用操作。删除与迁移的路径必须可验证才会开放；无法验证时在界面与 Host 端**同步禁用**，避免按钮亮着但点了没反应。未来 Runtime 默认只开放能识别的安全能力——不会用「方法存在」冒充「行为兼容」。

### 删除：三层守卫式路径推导

官方公共契约没有删除 API。插件走的是半官方路线：从后端实例的存储根目录字段出发做**三层校验**（根目录 → 会话目录结构 → 会话 ID 归属校验），通过后整目录删除，并以官方 `stat` 复核。

- 存在活跃写入的会话直接拒绝（409）。
- 推导失败（比如无法确认存储根目录）时**自动禁用并说明原因，绝不盲删**。
- 恢复前三级判定会话是否还在：已不存在 `DSM_SESSION_MISSING`、已被彻底删除 `DSM_SESSION_PURGED`、索引在但日志没了 `DSM_SESSION_LOG_MISSING`。无法核验日志位置时如实标 `unverified`，不假装校验通过。

### 移动：整目录搬运，不拼字节

主路径是官方 `create` + `append` 事件重放：写所有权探测会拒绝被 DSH 占用写权限的会话，revision 前后校验防并发写入，失败有备份回滚。后端存在同 ID 幽灵记录时回退到 frame0 cwd 改写搬运（帧数与内容逐位校验）。

Runtime 0.1.5 起日志**多代共存**（`session.jsonl.zstd` + `session.v2.jsonl.zstd` + `session.v3.jsonl.zstd`），而官方按「同一 ID 只能落在一个项目目录」校验——所以移动是**整目录搬运**：先把源目录整体移开（对官方扫描彻底不可见），目标侧重放校验成功后再删源目录；顺带回收其它项目目录里被取代的旧代副本，避免同一会话永久卡在「跨目录重复」。移动后自动重建工作区分组索引，无需重启。

### 空白会话：事件类型法，不是体积阈值

0.1.3 起日志头部扩容，且创建时恒写一帧生命周期元数据（`permission/preset` / `sandbox/mode` / `approval/policy`），旧的体积阈值法失效。现在的判定是：对压缩体积 ≤8KB 的候选走**官方解码精判**，头部之外没有任何内容事件才判空白；解码失败按非空兜底。

两条容易踩的细节：**插件注入的上下文不算内容**（`agent/inbox/spliced` 只插入 `source.kind` 以 `plugin:` 开头或 `form: 'instructions'` 的消息、且未删除任何消息时，该会话仍判空白）；**3.7.0 起精判完全移出数据返回路径**——侧栏数据首拍即回，空白与否先按「未知」处理（未知一律不隐藏、不计入空白分类），后台小队列逐条判定、结论落盘跨重启复用。

### 元数据缓存：区分「没有标题」和「读取失败」

判断日志有没有变化，新 Runtime 用官方快照的 `revision`（仅同一进程内可比，绝不写进跨重启的缓存文件），旧 Runtime 用 `(mtime, size)` 指纹。列表的目录 / 创建时间直接来自快照会话头，不读日志；标题不在页面加载时现读——缓存没有就先留空，后台分批补齐后自动刷出。

**读取失败不写入任何缓存**，稍后自动重试（该会话日志一变就立刻再试），偶发一次失败不会让会话永久显示「（无标题）」。

### 自动归档：证明不了就跳过

新 Runtime 不提供可靠的「最后活跃时间」，无法证明会话闲置时检查直接跳过（`no-activity-data`），绝不基于猜测归档。

### 侧栏注入：识别不了就整体停用

DOM / React fiber 识别收敛为可版本化的 adapter。上游侧栏结构不被识别时**整体安全停用**，不影响官方侧栏本身。识别正常时以 MutationObserver 增量驱动为主，只保留低频兜底。

### 活跃会话判定：客户端心跳

0.1.7 起 host 侧不再有「当前会话」访问器（三个历史探测全部落空），改由**客户端每 15 秒上报**当前会话 id，host 只在 45 秒新鲜期内采信。这条用于「移动正在看的会话」（409 / 排队）与「自动归档跳过当前会话」两处保护。心跳停止（面板关闭、标签页隐藏、进程退出）即视为无法证明活跃，**放行移动**而不是把会话永久锁死。

## 配置

插件没有配置文件，所有开关都在 设置 → 会话管理 的面板里，状态落在 `~/.dsh/sessions-manager/`：

| 文件 | 内容 |
| --- | --- |
| `trash.json` | 回收站索引（版本化 schema、原子写入） |
| `auto-archive.json` | 自动归档设置（schema v4） |
| `pending-moves.json` | 待移动队列（≤50 条，跨重启保留） |
| `meta-cache.json` | 会话元数据缓存（标题 / 时间，指纹校验） |
| `empty-scan.json` | 空白精判结论（跨重启复用，指纹 + TTL 双闸门） |
| `stars.json` / `tags.json` / `filters.json` | 收藏、标签、筛选预设 |

删掉任何一个文件都是安全的：对应的只是缓存或设置，会在下次写入时按默认值重建。

## 故障排查

先看这三处，八成问题能定位：

1. **面板空 / 按钮灰**：功能按 Runtime 能力开放。看面板顶部的提示文案，它会说明当前后端支持到哪一步。
2. **删除按钮不可点**：存储根目录推导失败。这通常会同时给出原因——是保护机制，不是 bug。
3. **移动后提示「已排队」**：会话正被 DSH 打开，写所有权未释放。重启 DSH 且先不打开该会话，几秒内会自动完成。

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 侧栏没有 ⋯ 菜单 | 插件未加载，或侧栏结构未被识别 | 刷新页面；仍不行则重启 DSH。识别失败时插件会整体停用而不是半残 |
| 子代理行不出现 | 上游不渲染子代理，插件按血缘注入 | 悬停或选中父行，出现「▸ N 子代理」后点击展开 |
| 会话显示「（无标题）」 | 标题仍在后台补齐 | 等一会儿自动刷出；持续不消失说明读取一直失败，看宿主日志 |
| 删除后会话又回来了 | 物理删除被运行时缓存挡下 | 已彻底删除的会话由前端永久隐藏；若仍出现，确认回收站里那条是否真的「彻底删除」成功 |
| 归档状态重启后丢失 | 存储域写入失败 | 面板会提示；检查 `~/.dsh` 是否可写 |
| 移动报 `SessionFormatError` | 日志含未知事件或已损坏，官方拒绝迁移 | 插件无法代修。先确认该会话是否真的异常，再决定保留或删除 |
| 想回滚 runtime 版本 | 迁移单向、不支持降级读取 | 回滚前先备份 `~/.dsh/sessions`；已被新版本打开过的会话回滚后读不了 |
| MCP 面板说「没有 MCP 行」 | 当前 profile 的 `cordis.patch.yml` 里确实没有 | 确认 `DSH_PROFILE_DIR` 指向的 profile 是你在用的那个 |
| 改了 MCP 开关但没变化 | 开关只写文件 | 重启 DSH；插件不负责热加载 MCP 连接 |

## 已知边界

- **删除与移动依赖半官方路径推导。** 官方没开放这两个 API，插件从存储根目录字段反推。DSH 改内部结构时这两项会先失效——失效时自动禁用并提示，不会误删。
- **活跃会话无法立即移动。** 写所有权只在 DSH 进程退出时释放，只能排队等重启。
- **空白判定有精度上限。** 超过 8KB 压缩体积的候选不进精判（按非空处理），宁可不判空白也不误判。
- **子代理不能单独跨越父会话移动**，血缘关系由官方头部字段决定，插件不改。
- **侧栏增强依附上游 DOM。** 上游侧栏重构会导致注入失效，需要更新 adapter；设置面板部分不受影响。
- **标签 / 筛选预设有上限**：筛选预设 ≤20，标签名 ≤200 字符。
- **「未经验证的未来 Runtime」只开放能识别的能力。** 新版本 DSH 出来时，插件会保守地少给功能，而不是冒险放行。
- **只有回收站里的「彻底删除」会碰磁盘。** 其余所有「删除」都是标记。
- **MCP 开关是文本手术，不是 YAML 重写。** 保留手写注释与排版，代价是块头缩进会被归一化（开启时顶格），因此开关一轮后文件不会与原文件逐字节相同。

## 开发与测试

```sh
cd dsh-lyin-sessions-manager
npm run build                      # esbuild 产出 lib/index.js + lib/client.js（产物要提交）
npm test                           # 43 个测试文件
npm run check:dist                 # 重建并与仓库产物比对（先 commit 再跑）
npm run check:sessions             # 扫描本机会话健康度
npm run check:runtime              # 真栈兼容性冒烟（需 DSH_RUNTIME 或 ~/.dsh/runtime）
```

`lib/` 已预构建，clone 下来直接用，不需要 esbuild。改源码后 `npm run build`，提交前用 `npm run check:dist`——它跑 `git diff --exit-code -- lib`，构建指纹可复现为 `vX.Y.Z+源码哈希`，正是为了让这道比对精确可靠。**改版本号后务必一并重建。**

单跑某个测试：`node --test tests/panel-sections.test.js`。

生效方式：只改 `lib/client.js` → 刷新浏览器页面；改 `lib/index.js`（host）→ 重启 DSH。

### 目录

```
package.json               npm 元数据 + dsh.bundle.patch + dsh.client（浏览器半注册）
cordis.patch.yml           向 profile bundle 插入本插件行
src/index.js               host 入口（/archived-sessions/* JSON 路由）
src/api-auth.js            每条路由的属主校验（fail-closed）
src/client/index.jsx       client 源码（React：settings.section + 侧栏 DOM 增强 + 快捷面板）
src/client/logic.js        客户端纯函数（分组、次级区、时间文案，全部可测）
src/active-session.js      活跃会话心跳（客户端 15s 上报 / host 45s 内采信）
src/auto-archive.js        自动归档设置（schema v4）+ 候选判定
src/storage-stats.js       存储占用聚合（按工作区 / Top N）
src/lineage.js             血缘分类与空白会话判定
src/empty-scan-index.js    空白精判结论的磁盘缓存
src/path-guard.js          守卫式路径推导（删除 / 移动共用）
src/pending-moves.js       排队移动队列（≤50 条，跨重启保留）
src/move-notices.js        排队移动的后台终局通知（未确认最长 7 天）
src/handle-era-*.js        SessionHandle 世代的读写与路径
src/zstd-frame.js          zstd 帧读写（日志多代共存）
src/markdown.js            会话日志 → Markdown（纯函数，无 I/O）
src/session-meta-cache.js  元数据内存缓存（按日志指纹校验）
src/session-meta-index.js  优先级 / 备注 / 待回看的磁盘索引（meta-v1）
src/title-persist-index.js 标题磁盘小索引（解决「无标题」反复重读）
src/star-index.js          收藏索引（schema v3）
src/tag-index.js           标签索引（schema v4）
src/saved-filters.js       筛选预设（schema v1）
src/state-temp-sweep.js    原子写入遗留临时文件的扫除
src/compat/                Runtime 能力探测与降级
build.mjs                  esbuild 构建脚本
scripts/                   构建外工具：跑测试、会话健康度、真栈兼容、上游契约
lib/                       预构建产物（index.js + client.js）
tests/                     43 个测试文件
docs/HANDOFF.md            交接文档：本机环境、调试通道、rebase 指南、踩坑清单
assets/                    README 用截图
```

### 宿主路由

全部 42 条挂在 `/archived-sessions/*` 下，POST 为主（GET 只有会话清单与 Markdown 导出）。表里把同族路由合并成一行，实际注册的每个路径都在。

| 方法 | 路由 | 作用 |
| --- | --- | --- |
| GET | `/list` | 列出归档会话（跳过已删除/不存在者） |
| POST | `/archive` · `/archive-many` | 归档（隐藏）单个 / 批量 |
| POST | `/restore` · `/restore-many` | 取消归档单个 / 批量 |
| POST | `/delete` · `/delete-many` | **移入回收站**（非物理删除）；默认连带整棵子代理子树（`cascadeSubagents: false` 可保留），返回 `cascaded` / `cascadedIds` |
| POST | `/trash/list` · `/trash/restore` | 回收站列表 / 从回收站恢复（连带恢复当初一起回收的子代理） |
| POST | `/trash/purge` · `/trash/purge-many` | 彻底删除单条 / 清空回收站（按父会话级联） |
| POST | `/trash/settings` · `/trash/verify` | 自动清理策略 `{ retentionDays }` / 校验日志是否仍存在 |
| POST | `/workspaces` | 列出可选目标工作区 |
| POST | `/move` · `/move-many` | 跨工作区移动；目标被占用时返回 `{ queued: true }` 并登记排队。批量单条失败不阻断，失败明细逐条回报 |
| POST | `/pending-moves` · `/pending-moves/cancel` · `/pending-moves/notices/ack` | 查看队列 / 取消排队 / 确认终局通知（未确认最长保留 7 天） |
| POST | `/details` | 会话详情（磁盘 / 统计 / 工具 / fetch / 文件 / 血缘） |
| POST | `/sidebar-state` | 侧栏权威标题、回收站 ID、永久删除墓碑、血缘分层（子代理 / 分支 / 空白）、`warmPending` / `refinePending`（标题预热、空白精判两条后台队列是否在途）、`moveNotices` |
| POST | `/lineage-tree` | 递归子代理树（面板血缘分组与侧栏折叠的数据源），已过滤回收站与墓碑 |
| POST | `/star/set` | 收藏 / 取消收藏 |
| POST | `/tags/list` · `/tags/create` · `/tags/rename` · `/tags/merge` · `/tags/delete` · `/tags/set` | 标签定义与映射（合并去重；删标签只删定义与映射，不碰会话） |
| POST | `/filters/list` · `/filters/save` · `/filters/delete` | 筛选预设（≤20，filters 为不透明载荷） |
| GET | `/export-md?sessionId=` | 单会话 Markdown 导出 |
| POST | `/storage` | 存储占用聚合（按工作区排行 + 最大的会话）`{ topN }` |
| POST | `/auto-archive/settings` · `/auto-archive/run` | 自动归档策略读取/更新（读取时惰性触发每日检查）/ 立即执行（忽略每日节流） |
| POST | `/capabilities` | 当前持久化代际及读取、归档、回收站、永久删除、跨工作区移动能力 |
| POST | `/sessions` | 会话主数据载荷（`allSessionItems({ usage: true })` + 标题预热），设置面板、快捷访问面板与「移动会话」列表都读它 |
| POST | `/active-session` | 客户端心跳上报当前正在看的会话 `{ clientId, sessionId }`；0.1.7+ 起宿主无从得知 UI 选中项，只在此心跳的新鲜期内采信，用于拦住「移动 / 自动归档正在看的会话」 |
| POST | `/meta/set` | 优先级、备注、待回看（`patch` 里省略的键保持不变，`null` / `''` / `false` 为清除）。纯用户元数据，不碰会话本体 |
| POST | `/turn-kind` | 批量查最近一次 `turn/end` 的 `reason.kind`（一次最多 20 个），快捷访问面板据此区分「出错」与「刚完成」 |
| POST | `/debug-log` | 排障通道：客户端把注册与渲染过程写到 `<状态目录>/debug.log`（最多 60 行），GUI 里看不到 console 时用 |

### 兼容性

已实测的 Runtime 版本：

| Runtime | 会话格式 | 行为 |
| --- | --- | --- |
| `0.1.2-rc.1` | v0 / v2 | 读取、归档、回收站、永久删除、跨工作区移动全部可用 |
| `0.1.3-alpha.1` | v2 | 支持 snapshot 列表与 `SessionHandle` 只读流程；删除与移动经守卫式推导 + 写所有权探测开放 |
| `0.1.5-rc.2` | v3 | 按最高代读取；跨工作区移动改整目录搬运并回收旧代副本；被打开的会话改排队移动 |
| `0.1.7-rc.2` | v4 | 格式版本目录拆到独立包；移动时自动按后端当前格式重采样会话头（旧格式会话可正常移动） |
| `0.2.0-rc.2` | v4 | `ctx.sessions` 退化为数据流服务，打开会话改走 `uiWorkspace.openSession`；存储域为领域数据形式，写入经 schema 校验 |
| `0.2.1-rc.2` | v4 | 持久化后端改为 cordis 插件形态（双形态都能挂载）；侧栏行外层多一层 wrapper；折叠分组计数改由 `sessionCount` 校准 |
| `0.2.2-rc.1` | v4 | 当前目标宿主，全绿 |

未经验证的未来 Runtime 默认只开放能识别的安全能力。

## 来源与许可

本仓库 fork 自 [TOBYCAI/dsh-sessions-manager](https://github.com/TOBYCAI/dsh-sessions-manager)，上游代码与文档版权归原作者，MIT 许可。本分支的增量（快捷访问面板、收起分组与吸顶标题、次级区维度）同样以 MIT 发布。

交接文档 [docs/HANDOFF.md](./docs/HANDOFF.md) 记录本机环境、调试通道、上游 rebase 指南与踩坑清单，接手维护前请先读它。

[MIT](./LICENSE)
