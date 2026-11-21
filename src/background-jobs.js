// 后台任务（background jobs）— 只读投影。
//
// 要解决的场景：会话的回合已经结束（侧栏显示「已完成」），但它留下的后台作业
// 还在跑（`run_in_background` 的 bash、被超时提升到后台的命令等）。此刻侧栏
// 上这一行看起来「什么都没在干」，用户找不到是哪个会话在占资源。
//
// 事实来源（实证 DSH 0.2.2-rc.1 的 asar）：
//   · `@deepseek-ai/dsh-jobs` 的 `JobRegistry.list(caller)` 只回
//     `job.owner === undefined || job.owner.id === caller` 的条目——**按 owner
//     隔离，没有跨会话枚举口**（`store` 是私有字段）。
//   · `@deepseek-ai/dsh-agent` 的 `AgentRegistry.list()` 给出所有 live agent，
//     且安装时断言 `agent.id === agent.session.id`，所以 agent id 就是 session id。
//   · 因此「跨会话找活作业」= 枚举 live agent id，再逐个 `list(id)`，并各自过滤
//     `owner === 该 id`（`list` 会顺带把 unowned 作业也带回来，那不是任何会话的）。
//
// 归属语义（不夸大成「这个会话在跑」）：owner 是 agent 生命周期，agent 被销毁时
// `disposeOwned()` 会先取消它的作业再丢弃，所以「作业还活着」必然意味着「agent
// 还活着」——但**不代表回合还在跑**（正是本投影要区分的两件事）。
//
// 本文件不 import 任何 `node:` 模块：客户端也要它（徽标文案 / 时长格式化）。
// 服务对象按「形状可用」而非 instanceof 判定——宿主给的是 Service 实例，单测
// 给的是几行的假对象。

/** 仍在消耗资源的作业状态。终态（succeeded/failed/cancelled/…）不算「还在跑」。 */
export const ACTIVE_JOB_STATUSES = Object.freeze(['running', 'stopping'])

/** 侧栏徽标最多展示的作业条数（更多时折叠成「+N」）。 */
export const JOB_BADGE_MAX_ROWS = 6

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 一条作业的展示投影。只留侧栏要用的字段：id（去重/定位）、label（任务名）、
 * startedAt（算运行时长）。label 为空时回落成 kind，再不行回落成短 id——宁可
 * 显示 `bash` 也不显示一个空行。
 * @param {unknown} raw
 * @returns {{id: string, label: string, kind: string, status: string, startedAt: number} | null}
 */
export function normalizeJobRow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = asString(raw.id).trim()
  if (!id) return null
  const kind = asString(raw.kind).trim()
  const label = asString(raw.label).trim() || kind || id.slice(0, 8)
  const status = asString(raw.status).trim()
  const startedAt = Number.isFinite(Number(raw.startedAt)) && Number(raw.startedAt) > 0 ? Number(raw.startedAt) : 0
  return { id, label, kind, status, startedAt }
}

/**
 * 是否「还在跑」。未知状态一律不当活——宁可漏报一个正在收尾的作业，也不能让
 * 侧栏挂着一个永远不消失的徽标（那种「假忙」没法自愈）。
 * @param {{status?: string}} job
 */
export function isActiveJob(job) {
  if (!job || typeof job !== 'object') return false
  return ACTIVE_JOB_STATUSES.includes(asString(job.status).trim())
}

/**
 * 把「一个 owner 的作业列表」收敛成展示行：只要活着的、按开始时间升序（先起的
 * 在上，与用户对「排队」的直觉一致）、同一 id 只留第一条。
 * @param {unknown} list
 * @returns {ReturnType<typeof normalizeJobRow>[]}
 */
export function activeJobRows(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (!isActiveJob(raw)) continue
    const row = normalizeJobRow(raw)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  out.sort((a, b) => (a.startedAt - b.startedAt) || a.id.localeCompare(b.id))
  return out
}

/** 从 agent 列表投影出 session id（`agent.id` 与 `agent.session.id` 恒相同）。 */
export function sessionIdsOf(agents) {
  if (!Array.isArray(agents)) return []
  const seen = new Set()
  const out = []
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue
    const id = asString(agent.id).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 汇总「哪些会话还有后台任务」。
 *
 * 入参是**服务对象本身**（可为 undefined/null，表示宿主没装 jobs 或 agents 插件）：
 * 缺失时返回空对象，调用方不必分情况——这一整个特性在旧宿主上静默降级为「没有
 * 后台任务」，绝不会让 sidebar-state 报错。
 *
 * @param {{list?: () => unknown[]} | null | undefined} agentsSvc `ctx.get('agents')`
 * @param {{list?: (caller: string) => unknown[]} | null | undefined} jobsSvc `ctx.get('jobs')`
 * @returns {Record<string, ReturnType<typeof normalizeJobRow>[]>} session id → 活作业行
 */
export function collectBackgroundJobs(agentsSvc, jobsSvc) {
  const out = {}
  if (!agentsSvc || typeof agentsSvc.list !== 'function') return out
  if (!jobsSvc || typeof jobsSvc.list !== 'function') return out
  let agents = null
  try { agents = agentsSvc.list() } catch (e) { return out }
  for (const sid of sessionIdsOf(agents)) {
    let list = null
    // 单个 owner 查询失败不能拖垮整份侧栏数据：跳过它，其余照常。
    try { list = jobsSvc.list(sid) } catch (e) { list = null }
    if (!Array.isArray(list)) continue
    // `list(caller)` 会把 unowned 作业一并回（owner === undefined）；那不是任何一个
    // 会话留下的，挂到某一行上只会误导。只认明确归属本会话的。
    const owned = list.filter((job) => job && typeof job === 'object' && job.owner === sid)
    const rows = activeJobRows(owned)
    if (rows.length) out[sid] = rows
  }
  return out
}

/**
 * 运行时长的人读文案。刻意与 `logic.js` 的 `agoLabel`（「3 分钟前」）区分：这里
 * 说的是**已经跑了多久**，不是多久以前。跨过小时之后只保留最高一级单位——
 * 侧栏一行放不下「1 小时 23 分钟」，而精度对「这活儿是不是卡住了」没有帮助。
 * @param {number} ms
 */
export function jobDurationLabel(ms) {
  // 只认真正的数字：`null` 会被 Number() 折成 0，从而渲染成「不足 1 秒」——那是在
  // 编一个没量到的时间。缺数据就该空着。
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return '不足 1 秒'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时`
  return `${Math.floor(hr / 24)} 天`
}

/** 徽标上的三角 + 条数（`▸ 2`）；展开时换成朝下的三角。 */
export function jobBadgeText(count, open) {
  const n = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0
  if (!n) return ''
  return (open ? '▾ ' : '▸ ') + n
}
