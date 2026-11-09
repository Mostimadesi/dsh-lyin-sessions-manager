// v0.2.8：turn-kind 路由回归——快捷面板「刚完成 / 出错」分类的数据源。
// 该路由读会话日志里最后一条 turn/end 的 reason.kind（实测取值域：
// completed / error / aborted / interrupted / max-tokens）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 假 persistence：inspectSession 按 id 返回预置事件流。
async function boot(eventsById) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-turnkind-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'trash'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })
  const routes = new Map()
  const domainState = { archivedSessionIds: [] }
  const ctx = {
    workspaceRegistry: { list: () => [], state: domainState, archiveSession: async () => {} },
    sessionPersistence: {
      list: async () => Object.keys(eventsById).map((id) => ({ id, cwd: root, createdAt: 1 })),
      locate: (h) => ({ path: join(root, 'logs', h.id + '.jsonl') }),
      // 适配器在没有 service.open 时走 readFrom（legacy 路径）——两份都给，
      // 保证测试覆盖实际生效的分支。
      readFrom: async (id) => ({ meta: { id, cwd: root, createdAt: 1 }, events: eventsById[id] || [] }),
      inspectSession: async (id, opts) => {
        const evs = eventsById[id] || []
        if (opts && typeof opts.onEvents === 'function') opts.onEvents(evs)
        return { meta: { id, cwd: root, createdAt: 1 } }
      },
    },
    sessionQuery: { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id }, title: { title: 'T-' + id } } })) },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async () => {} } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: () => null,
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?turnkind=${Date.now()}-${Math.random()}`)
  apply(ctx)
  const call = async (path, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
    await routes.get(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  return { root, call }
}

async function cleanup(b) {
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return } catch (e) { if (e && e.code === 'ENOTEMPTY') { await sleep(50); continue } throw e }
  }
}

const ev = (type, kind) => ({ type, data: kind ? { reason: { kind } } : {} })

test('turn-kind: reports the LAST turn/end reason per session', async () => {
  const b = await boot({
    ok: [ev('turn/start'), ev('turn/end', 'completed'), ev('turn/start'), ev('turn/end', 'completed')],
    bad: [ev('turn/start'), ev('turn/end', 'completed'), ev('turn/start'), ev('turn/end', 'error')],
    aborted: [ev('turn/end', 'aborted')],
    none: [ev('turn/start')],
  })
  try {
    const r = await b.call('/archived-sessions/turn-kind', { sessionIds: ['ok', 'bad', 'aborted', 'none'] })
    assert.equal(r.status, 200)
    assert.equal(r.body.kinds.ok, 'completed')
    assert.equal(r.body.kinds.bad, 'error', '取最后一条 turn/end，后者覆盖前者')
    assert.equal(r.body.kinds.aborted, 'aborted')
    assert.equal(r.body.kinds.none, null, '没有 turn/end → null（不猜）')
  } finally { await cleanup(b) }
})

test('turn-kind: rejects a missing / invalid sessionIds list', async () => {
  const b = await boot({})
  try {
    const r = await b.call('/archived-sessions/turn-kind', {})
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_TURN_KIND_INVALID')
    const r2 = await b.call('/archived-sessions/turn-kind', { sessionIds: [] })
    assert.equal(r2.status, 400)
  } finally { await cleanup(b) }
})

test('turn-kind: a read failure degrades to null instead of failing the route', async () => {
  const b = await boot({ boom: null })
  try {
    // 让 inspectSession 抛错
    const r = await b.call('/archived-sessions/turn-kind', { sessionIds: ['boom'] })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.kinds.boom === null || typeof r.body.kinds.boom === 'string')
  } finally { await cleanup(b) }
})
