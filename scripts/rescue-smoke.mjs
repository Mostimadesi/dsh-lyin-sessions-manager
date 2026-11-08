#!/usr/bin/env node
/**
 * rescue-smoke.mjs — v0.1 上真机（desktop profile）前的最后一道闸。
 *
 * 用户验证策略（基座评估报告 §四）：rescue 隔离验证——真实会话数据必须在
 * 副本上操作，源 ~/.dsh/sessions 全程只读。
 *
 * 做法：
 *   1. 从 ~/.dsh/sessions 挑 2 个最小的真实 session.v4.jsonl.zstd 复制到
 *      临时目录（源只读，复制后校验源指纹不变）；
 *   2. 用 tests/tags-routes.test.js 同款 legacy 世代假 ctx 启动完整 host
 *      （真实路由、真实回收站/元数据/标签存储——只是 persistence 读副本）；
 *   3. 跑破坏性操作矩阵：meta 全语义、删除→回收站→恢复→彻底清理、归档/
 *      恢复、移动（含能力探测降级的诚实上报）、认证门 fail-closed；
 *   4. 每步打印 PASS/FAIL，任一 FAIL 退出码非 0。
 *
 * 用法：node scripts/rescue-smoke.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const REAL_SESSIONS = join(homedir(), '.dsh', 'sessions')

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function section(title) { console.log(`\n== ${title} ==`) }

// ---- 1. 选样 + 复制（源只读） ---------------------------------------------

const candidates = []
for (const ws of readdirSync(REAL_SESSIONS)) {
  const wsDir = join(REAL_SESSIONS, ws)
  let sids
  try { sids = readdirSync(wsDir) } catch { continue }
  for (const sid of sids) {
    const f = join(wsDir, sid, 'session.v4.jsonl.zstd')
    try {
      const st = statSync(f)
      if (st.size > 0) candidates.push({ ws, sid, file: f, size: st.size })
    } catch { /* 非常规布局跳过 */ }
  }
}
candidates.sort((a, b) => a.size - b.size)
if (candidates.length < 2) {
  console.error('真实会话样本不足（<2），rescue 冒烟无法进行')
  process.exit(1)
}
const picked = [candidates[0], candidates[1]]
console.log(`真实会话总数 ${candidates.length}，取样 2 个最小文件：`)
for (const p of picked) console.log(`  ${p.ws}/${p.sid}/session.v4.jsonl.zstd (${p.size} bytes)`)

// 源指纹（复制前）
const before = new Map()
for (const p of picked) {
  const st = statSync(p.file)
  before.set(p.file, `${st.size}:${st.mtimeMs}:${createHash('sha256').update(readFileSync(p.file)).digest('hex').slice(0, 16)}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsm-rescue-'))
const logsDir = join(root, 'logs')
process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
process.env.DSH_SESSIONS_MANAGER_NO_AUTH = '1' // 先放行跑主矩阵；末段单独验证门
await mkdir(process.env.DSH_SESSIONS_MANAGER_TRASH_DIR, { recursive: true })
await mkdir(join(root, 'state'), { recursive: true })
await mkdir(join(root, 'pending'), { recursive: true })

// 复制进一个假工作区（保持 <ws>/<sid>/session.v4.jsonl.zstd 层级）
const WS_A = 'rescue-ws-a'
const WS_B = 'rescue-ws-b'
const ids = []
for (const p of picked) {
  const dest = join(logsDir, WS_A, p.sid)
  await mkdir(dest, { recursive: true })
  await cp(p.file, join(dest, 'session.v4.jsonl.zstd'))
  ids.push(p.sid)
}

// ---- 2. legacy 世代假 ctx（tags-routes 同款，locate 指向真实副本） --------

const logDirOf = (id) => join(logsDir, WS_A, id)
const logPathOf = (id) => join(logDirOf(id), 'session.v4.jsonl.zstd')
const headerOf = (id) => ({ id, cwd: join(root, WS_A), createdAt: 1 })

const routes = new Map()
// 可写的共享 storageDomain 状态：归档/恢复要真实反映回列表（读磁盘现状纪律）。
const domainState = { archivedSessionIds: [] }
const ctx = {
  // archiveOne 把持久化职责委托给官方 w.archiveSession（{ next: null } 不自写
  // 状态，见 src/index.js archiveOne 注释）；restoreOne 则走 mutateArchived 自写。
  // 假 ctx 里官方语义 = 真实改 domainState，归档/恢复的往返才闭环。
  workspaceRegistry: {
    list: () => [],
    state: domainState,
    archiveSession: async (sid) => { if (!domainState.archivedSessionIds.includes(sid)) domainState.archivedSessionIds.push(sid) },
  },
  sessionPersistence: {
    list: async () => ids.filter((id) => existsSync(logPathOf(id))).map(headerOf),
    locate: (h) => ({ path: logPathOf(h.id) }),
    readFrom: async (id) => ({ meta: headerOf(id), events: [] }),
  },
  sessionQuery: {
    readTitleSnapshots: async (reqIds) => reqIds.map((id) => ({
      status: 'fulfilled', value: { session: headerOf(String(id)), title: { title: `真实副本-${String(id).slice(0, 8)}` } },
    })),
  },
  storageDomain: {
    get: () => ({ global: { get: () => domainState, set: async (v) => { domainState.archivedSessionIds = (v && v.archivedSessionIds) || [] } } }),
  },
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
  get: () => null,
  effect: (fn) => fn(),
}

const { apply } = await import(`../src/index.js?rescue=${Date.now()}-${Math.random()}`)
apply(ctx)

const call = async (path, body = {}) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  let status = 200
  let text = ''
  const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
  await routes.get(path)(req, res)
  return { status, body: JSON.parse(text) }
}

// ---- 3. 破坏性操作矩阵 -----------------------------------------------------

section('会话列表挂载（v0.1 三字段）')
{
  const r = await call('/archived-sessions/sessions', {})
  const items = r.body.items || []
  report('列表返回 200 且包含取样会话', r.status === 200 && items.length >= 2)
  const withFields = items.every((it) => 'priority' in it && 'note' in it && 'review' in it)
  report('每个 item 挂载 priority/note/review', withFields)
  // 冷启动纪律：首拍标题为空、后台经 sessionQuery 预热——轮询至多 3 秒。
  let warmed = false
  for (let i = 0; i < 30 && !warmed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const rr = await call('/archived-sessions/sessions', {})
    warmed = (rr.body.items || []).length > 0 && (rr.body.items || []).every((it) => String(it.title || '').startsWith('真实副本-'))
  }
  report('标题后台预热后来自真实副本（sessionQuery 命中）', warmed)
}

section('meta/set 全语义矩阵（新增核心）')
{
  const a = ids[0]
  let r = await call('/archived-sessions/meta/set', { sessionId: a, patch: { priority: 1, note: '重要会话', review: true } })
  report('单条设置三字段', r.status === 200 && r.body.ok === true)
  r = await call('/archived-sessions/sessions', {})
  const it = (r.body.items || []).find((x) => x.sessionId === a)
  report('列表读回三字段', it && it.priority === 1 && it.note === '重要会话' && it.review === true, JSON.stringify(it && { priority: it.priority, review: it.review }))

  r = await call('/archived-sessions/meta/set', { sessionId: a, patch: { review: false } })
  report('省略键保持：review=false 后 priority/note 不动', r.status === 200)
  r = await call('/archived-sessions/sessions', {})
  const it2 = (r.body.items || []).find((x) => x.sessionId === a)
  report('清除语义正确（review 消失，priority=1 保留）', it2 && it2.review === false && it2.priority === 1)

  r = await call('/archived-sessions/meta/set', { sessionId: a, patch: { priority: null, note: '' } })
  report('null / 空串 清除 priority 与 note', r.status === 200)
  r = await call('/archived-sessions/sessions', {})
  const it3 = (r.body.items || []).find((x) => x.sessionId === a)
  report('清除后回落默认（priority=null, note=\'\'）', it3 && it3.priority === null && it3.note === '' && it3.review === false)

  r = await call('/archived-sessions/meta/set', { sessionIds: ids, patch: { review: true } })
  report('批量 ids 形状', r.status === 200 && (r.body.updated || []).length === 2)
  r = await call('/archived-sessions/sessions', {})
  report('批量生效于全部两条', (r.body.items || []).every((x) => x.review === true))

  r = await call('/archived-sessions/meta/set', { sessionId: a, patch: { priority: 9 } })
  report('非法 priority 拒绝（400 + DSM_META_INVALID）', r.status === 400 && r.body.code === 'DSM_META_INVALID')
  r = await call('/archived-sessions/meta/set', { sessionId: a, patch: { note: 'x'.repeat(2001) } })
  report('超长 note 拒绝', r.status === 400 && r.body.code === 'DSM_META_INVALID')
  r = await call('/archived-sessions/meta/set', { sessionId: a, patch: {} })
  report('空 patch 拒绝', r.status === 400 && r.body.code === 'DSM_META_INVALID')
  r = await call('/archived-sessions/meta/set', { patch: { review: true } })
  report('缺 sessionId 拒绝（DSM_META_SESSION_INVALID）', r.status === 400 && r.body.code === 'DSM_META_SESSION_INVALID')
}

section('持久化（真实落盘 + 重启读回）')
{
  const a = ids[0]
  await call('/archived-sessions/meta/set', { sessionId: a, patch: { priority: 2, note: '重启不丢' } })
  const raw = JSON.parse(await readFile(join(root, 'state', 'session-meta.json'), 'utf8'))
  report('session-meta.json 落盘且 schema=meta-v1', raw.schemaVersion === 'meta-v1' && raw.entries[a] && raw.entries[a].note === '重启不丢')
  report('落盘无临时文件残留', (await readdir(join(root, 'state'))).every((f) => !f.includes('.tmp')))
}

section('删除 → 回收站 → 恢复 → 彻底清理（文件级）')
{
  const a = ids[0]
  let r = await call('/archived-sessions/delete', { sessionId: a })
  report('软删除返回 ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body))
  report('日志文件原地保留（回收站语义）', existsSync(logPathOf(a)))

  r = await call('/archived-sessions/trash/list', {})
  const entry = (r.body.items || []).find((e) => String(e.sessionId) === a)
  report('回收站列表有条目', !!entry)

  r = await call('/archived-sessions/trash/restore', { sessionId: a })
  report('恢复返回 ok', r.status === 200 && r.body.ok === true)
  report('恢复后文件仍在且列表可见', existsSync(logPathOf(a)) && ((await call('/archived-sessions/sessions', {})).body.items || []).some((x) => x.sessionId === a))
  r = await call('/archived-sessions/trash/list', {})
  report('回收站条目已清除', !((r.body.items || []).some((e) => String(e.sessionId) === a)))

  await call('/archived-sessions/delete', { sessionId: a })
  r = await call('/archived-sessions/trash/purge', { sessionId: a })
  report('彻底清理返回 ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body))
  report('彻底清理后文件消失', !existsSync(logPathOf(a)))
  r = await call('/archived-sessions/sessions', {})
  report('清理后列表只剩 1 条', ((r.body.items || []).filter((x) => x.sessionId === a)).length === 0)
}

section('归档 / 恢复')
{
  const b = ids[1]
  let r = await call('/archived-sessions/archive', { sessionId: b })
  report('归档 ok', r.status === 200)
  r = await call('/archived-sessions/sessions', {})
  const it = (r.body.items || []).find((x) => x.sessionId === b)
  report('列表标记 archived', it && it.archived === true)
  r = await call('/archived-sessions/restore', { sessionId: b })
  report('恢复归档 ok', r.status === 200)
}

section('移动（能力探测诚实上报）')
{
  const b = ids[1]
  const r = await call('/archived-sessions/move', { sessionId: b, targetPath: join(root, WS_B) })
  // legacy 假 ctx 无真实注册表/写所有权，能力门可能拒绝（409）——拒绝也算通过
  // （fail-closed 优于假成功）；真移动成功也算通过。只不允许 500 崩溃。
  const acceptable = r.status === 200 || (r.status >= 400 && r.status < 500)
  report('移动路径不崩溃且结果可信（200 或 4xx fail-closed）', acceptable, `status=${r.status} code=${r.body && r.body.code}`)
}

section('认证门 fail-closed（放行语义已由 compat-smoke 验证）')
{
  // 关掉逃生开关后重新 apply 一份插件实例：fake ctx 无 connection → 全部路由应 503。
  delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
  const routes2 = new Map()
  const ctx2 = { ...ctx, webServer: { register: (route) => { routes2.set(route.path, route.handler); return () => {} } } }
  const fresh = await import(`../src/index.js?gate=${Date.now()}-${Math.random()}`)
  fresh.apply(ctx2)
  const req = Readable.from([Buffer.from('{}')])
  let status = 200
  const res = { writeHead: (v) => { status = v }, end: () => {} }
  await routes2.get('/archived-sessions/sessions')(req, res)
  report('无 connection 服务时路由 fail-closed 503', status === 503, `status=${status}`)
}

// ---- 4. 源完整性校验 -------------------------------------------------------

section('源数据完整性（全程只读）')
{
  let allOk = true
  for (const p of picked) {
    const st = statSync(p.file)
    const digest = `${st.size}:${st.mtimeMs}:${createHash('sha256').update(readFileSync(p.file)).digest('hex').slice(0, 16)}`
    if (digest !== before.get(p.file)) { allOk = false; report(`源被改动！${p.sid}`, false) }
  }
  report('两个源会话文件 size/mtime/sha256 零变化', allOk)
}

// ---- 5. 收尾 ----------------------------------------------------------------

await rm(root, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✓ rescue smoke PASS' : `✖ rescue smoke FAIL（${failed.length} 项）`}: ${results.filter((r) => r.ok).length}/${results.length} 项通过`)
if (failed.length) {
  for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
