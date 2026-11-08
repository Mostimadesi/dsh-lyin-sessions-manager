// v0.1 meta/set 的路由级回归（复核建议 3）。
// 与 tests/tags-routes.test.js 同款 boot（legacy 世代假 ctx），但刻意在模块顶
// 删除 DSH_SESSIONS_MANAGER_NO_AUTH 并给假 ctx 注入 owner connection——本文件
// 因此无论经 npm test（全局 bypass=1）还是直接 node --test 运行，都走**真实
// 认证门**的放行路径；末尾再用一个无 connection 的 ctx 锁 fail-closed 503。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-meta-routes-'))
  const trashDir = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = trashDir
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(trashDir, { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })

  const ids = opts.ids || ['s1', 's2']
  const sessionsDir = join(root, 'logs')
  const headerOf = (id) => ({ id, cwd: root, createdAt: 1 })
  const logPath = (id) => join(sessionsDir, `${id}.jsonl.zstd`)
  for (const id of ids) {
    await mkdir(dirname(logPath(id)), { recursive: true })
    await writeFile(logPath(id), 'x'.repeat(10))
  }
  const routes = new Map()
  const domainState = { archivedSessionIds: [] }
  const ctx = {
    workspaceRegistry: { list: () => [], state: domainState, archiveSession: async () => {} },
    sessionPersistence: {
      list: async () => ids.filter((id) => existsSync(logPath(id))).map(headerOf),
      locate: (h) => ({ path: logPath(h.id) }),
      readFrom: async (id) => ({ meta: headerOf(id), events: [] }),
    },
    sessionQuery: {
      readTitleSnapshots: async (reqIds) => reqIds.map((id) => ({
        status: 'fulfilled', value: { session: headerOf(String(id)), title: { title: `T-${id}` } },
      })),
    },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async (v) => { domainState.archivedSessionIds = (v && v.archivedSessionIds) || [] } } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    // 认证门放行身份：owner。拒绝矩阵在 tests/api-auth.test.js。
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: () => null,
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?meta-routes=${Date.now()}-${Math.random()}`)
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
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && e.code === 'ENOTEMPTY') { await sleep(50); continue } throw e }
  }
}

test('meta/set routes: owner-gated round-trip, batch ids, clear semantics, error codes', async () => {
  const b = await boot()
  try {
    // 放行路径：owner connection 下正常 200（本文件删除了全局 bypass）。
    let r = await b.call('/archived-sessions/meta/set', { sessionId: 's1', patch: { priority: 1, note: '路由级', review: true } })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.updated, ['s1'])

    // /sessions 挂载读回。
    r = await b.call('/archived-sessions/sessions', {})
    const byId = Object.fromEntries((r.body.items || []).map((it) => [it.sessionId, it]))
    assert.equal(byId.s1.priority, 1)
    assert.equal(byId.s1.note, '路由级')
    assert.equal(byId.s1.review, true)

    // 批量 sessionIds 形状（parseIds 路径）。
    r = await b.call('/archived-sessions/meta/set', { sessionIds: ['s1', 's2'], patch: { review: true } })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.updated, ['s1', 's2'])
    r = await b.call('/archived-sessions/sessions', {})
    assert.ok((r.body.items || []).every((it) => it.review === true))

    // 清除语义走完整路由：review:false 后 priority/note 保留。
    r = await b.call('/archived-sessions/meta/set', { sessionId: 's1', patch: { review: false } })
    assert.equal(r.status, 200)
    r = await b.call('/archived-sessions/sessions', {})
    const after = Object.fromEntries((r.body.items || []).map((it) => [it.sessionId, it]))
    assert.equal(after.s1.review, false)
    assert.equal(after.s1.priority, 1)
    assert.equal(after.s1.note, '路由级')

    // 错误码矩阵（与 star/set 同型的 400 形状）。
    r = await b.call('/archived-sessions/meta/set', { patch: { review: true } })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_META_SESSION_INVALID')
    r = await b.call('/archived-sessions/meta/set', { sessionId: 's1', patch: {} })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_META_INVALID')
    r = await b.call('/archived-sessions/meta/set', { sessionId: 's1', patch: { priority: 9 } })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_META_INVALID')
    r = await b.call('/archived-sessions/meta/set', { sessionId: 's1', patch: { note: 'x'.repeat(2001) } })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_META_INVALID')
    r = await b.call('/archived-sessions/meta/set', { sessionIds: ['../bad'], patch: { review: true } })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_META_SESSION_INVALID')

    // 错误请求不落盘：三字段保持最后一次合法写入。
    r = await b.call('/archived-sessions/sessions', {})
    const kept = Object.fromEntries((r.body.items || []).map((it) => [it.sessionId, it]))
    assert.equal(kept.s1.priority, 1)
    assert.equal(kept.s1.note, '路由级')
  } finally { await cleanup(b) }
})

test('meta/set route is fail-closed without a connection service (real gate, no bypass)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsm-meta-gate-'))
  try {
    process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
    process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
    process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
    const routes = new Map()
    const ctx = {
      workspaceRegistry: { list: () => [], state: { archivedSessionIds: [] }, archiveSession: async () => {} },
      sessionPersistence: { list: async () => [], locate: () => null, readFrom: async () => ({ meta: {}, events: [] }) },
      sessionQuery: { readTitleSnapshots: async (r) => r.map(() => ({ status: 'fulfilled', value: { session: {}, title: {} } })) },
      storageDomain: { get: () => ({ global: { get: () => ({ archivedSessionIds: [] }), set: async () => {} } }) },
      webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
      // 无 connection：认证门必须 503 fail-closed。
      get: () => null,
      effect: (fn) => fn(),
    }
    const fresh = await import(`../src/index.js?meta-gate=${Date.now()}-${Math.random()}`)
    fresh.apply(ctx)
    const req = Readable.from([Buffer.from('{}')])
    let status = 200
    const res = { writeHead: (v) => { status = v }, end: () => {} }
    await routes.get('/archived-sessions/sessions')(req, res)
    assert.equal(status, 503)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
