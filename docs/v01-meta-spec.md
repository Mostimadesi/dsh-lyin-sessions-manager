# v0.1 元数据层接口规格（dsh-lyin-sessions-manager）

本文件是 v0.1 阶段 host 侧与 client 侧并行实现的**协调契约**。两侧各自实现，最终由主线集成。
背景与嫁接点证据见 `../research/子代理A-TOBYCAI源码报告.md` §8 与 `../research/基座评估报告.md`。

## 0. 基线注意（必读）

- 本机（Windows）已知的**环境性既有失败**：`tests/move-notices.test.js` 3 处、`tests/saved-filters.test.js` 3 处（0o600 权限断言与临时目录锁在 Windows 上的上游既有问题）。**你的改动不得使失败数增加、不得新增失败文件。**
- 构建命令：`npm run build`（esbuild 双产物到 lib/）。集成阶段由主线统一重建 lib/，你本地构建仅用于自检。
- **禁止 git commit**；只改文件。

## 1. 存储层：`src/session-meta-index.js`（host 侧新建）

完全复刻 `src/star-index.js` 的模式（schemaVersion + 防御 normalize + tmp→rename 原子写 0o600 + Promise 链式串行 mutator + GC）：

- 文件路径：`~/.dsh/sessions-manager/session-meta.json`（STATE_DIR 已有常量，src/index.js:47）。
- schema：`{ schemaVersion: 'meta-v1', entries: { [sessionId]: { priority, note, review } } }`。
- 字段规则（校验失败抛带 `code: 'DSM_META_INVALID'` 的错误，参照 hkkz9522 `normalizeAnnotationPatch` 的严格性——**拒绝而非截断**，防静默丢数据）：
  - `priority`：整数 1–5，或 `null`（显式清除）；缺省=未设置（存储中省略字段）。
  - `note`：字符串，trim 后 ≤2000 字符，超限拒绝；`''` = 清除（存储中省略）。
  - `review`：布尔；`false` = 清除（存储中省略）。
- API（同 star-index 的导出风格）：`readMetaIndex()`、`setMeta(sessionIds, patch)`（批量、部分语义见 §2）、`clearReview(sessionIds)`、`metaOf(sessionId)`、`gcMeta(validIds)`（照抄 gcStars 的清理语义）。

## 2. Host 路由（src/index.js，插在 2075–2972 的路由注册区）

单一新路由（保留原 repo 风格 exact + readJsonBody + json() 工具）：

- `POST /archived-sessions/meta/set`
  - body：`{ sessionId?: string, sessionIds?: string[], patch: { priority?: 1|2|3|4|5|null, note?: string, review?: boolean } }`
  - ids 解析照抄 star/set 的 `parseIds(body)` + `sessionId` 回退（src/index.js:2386-2392 的既有形状）；逐 id 过 `isSafeSessionId`。
  - patch 语义：**省略的键 = 保持不变**；`priority: null` = 清除优先级；`note: ''` = 清除备注；`review: false` = 清除待回看。空 patch 拒绝（400 `DSM_META_INVALID`）。
  - 返回：`{ ok: true, updated: string[] }`；未知 sessionId 不报错（元数据允许先于会话存在？**不允许**：与 star/set 一致——star 对未知 id 的处理以现有实现为准，保持同型）。
- 不新增 meta/list：列表数据经 §3 挂载带出。

## 3. 列表挂载 + GC（src/index.js）

- `allSessionItemsDetailed`（挂载点 src/index.js:1648-1656）：在 `it.starred` / `it.tags` 同型位置加挂：
  `it.priority = meta.priority ?? null; it.note = meta.note ?? ''; it.review = meta.review ?? false;`
- GC：与 `gcStars` / `gcTags`（src/index.js:1654-1655）并列加 `gcMeta(ids)` 调用。

## 4. 标签规则对齐（src/tag-index.js + 相关路由）

- 单会话标签上限 10 → **20**（找到现有上限常量/校验并修改，含错误提示文案）。
- 标签赋值时**大小写不敏感去重**（若现有实现已去重则仅确认；若按精确字符串去重，改为 case-insensitive 归并——合并进已存在的同名（忽略大小写）标签）。
- 标签名规则保持现有实现（≤32 字符等，若现有上限更严格则放宽到 32 对齐 hkkz9522）。

## 5. 认证门（host 侧新建 `src/api-auth.js`）

从 hkkz9522 仓库移植（源码在 `../research/dsh-session-manager/lib/index.js:2448-2502`，可直接读取参考）：

- `authenticateApiRequest(ctx, req, res)`：`ctx.connection.admit(req)` → 检查 `admission.rejection`（非空即 401/403 语义）→ Owner-only `peer.principal.kind === 'owner'` → connection 服务缺失时 **fail-closed 503**。
- 接入点：src/index.js:2064 的集中注册处——为 41 条路由的 handler 包一层 `withAuth(handler)`，**不逐条复制代码**。
- hkkz9522 原实现里 `requestRejection()` 并未被调用（已证伪），移植时以 admit() + rejection 字段检查为准。
- 注意：`connection` 需加入 host 的 inject 列表（src/index.js:40-41 附近），并在 capabilities/路由 403 响应里带上 `forbidden: owner-only` 语义文案。

## 6. client 逻辑层（src/client/logic.js）

- `SAVED_VIEWS`（logic.js:447）追加 `'review'`（待回看视图，语义=review===true）；**同步两端白名单** `filterSnapshotOf`（:456-463）与 `filterShapeFromSaved`（:472-484），否则旧存筛选静默降级。
- `SAVED_SORTS`（logic.js:448）追加 `'priority'`：比较器 null→3 归一后升序（1 最高在前）。
- 纯函数：`reviewOf(item)`（同 `starredOf` 的形状，logic.js:98-100）、`priorityOf(item)`（?? 3 归一）。
- 现有标签筛选预设（tag 字段）不动——「标签+优先级」双筛由视图+排序组合天然承载，v0.1 不加独立 priority 筛选器。

## 7. client UI（src/client/index.jsx）

- **行内控件**（会话行，参照现有行内星标按钮的挂载方式）：优先级下拉（1最高/2高/3正常/4低/5最低/未设置）+ 待回看开关；改动即时乐观更新、失败回滚（沿用星标的乐观更新纪律）。
- **详情面板**：备注 textarea（≤2000 校验、保存按钮、`meta/set` 提交）；显示优先级/待回看状态。
- **批量标注 sheet**：完全仿批量移动 sheet（index.jsx:2163-2210）的容器与交互；动作集：
  - 设优先级（1-5/清除）→ `meta/set {priority}`
  - 标记/清除待回看 → `meta/set {review}`
  - 批量加标签 / 清除标签 → 复用现有 tags/set 路由逐 id 执行（客户端循环，单条失败不阻断）
- **批量结果对话框**（从 hkkz9522 移植语义，样式贴合本 repo 既有 sheet/对话框风格）：Success / Failed / Skipped 三组 + **Retry failed**（把失败 ids 重新挂回选择集并重跑）；替换/增强现有批量操作的结果合并行。
- 调用契约：fetch `/archived-sessions/meta/set`，错误码 `DSM_META_INVALID` 需用户可读提示。

## 8. 测试要求（node --test，临时目录隔离，照抄 tests/star-index.test.js 的纪律）

- host：`tests/session-meta-index.test.js`（schema/原子写/校验拒绝/GC/批量语义：省略键保持、null 清除、'' 清除）、`tests/api-auth.test.js`（admit 拒绝/owner-only/fail-closed 503，mock connection）。
- client：`tests/meta-views.test.js`（SAVED_VIEWS/SAVED_SORTS 白名单夹逼、reviewOf/priorityOf、priority 比较器含 null 归一）。
- **文件名不得与既有 tests/ 冲突**；全量 `npm test` 后对照 §0 基线核对失败数。

## 9. 验收标准

1. `npm run build` 通过；`npm run check`（若存在）通过。
2. 全量 `npm test` 失败数 = 基线（6 环境性），无新增。
3. 元数据三字段在列表/详情/批量路径全链路可读写；重启后持久（存储纪律）。
