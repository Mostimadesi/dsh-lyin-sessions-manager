// v3.14.0：后台任务并入 /archived-sessions/sidebar-state 的回归。
//
// 覆盖面（这三条是这段代码最容易悄悄坏掉的地方）：
//   ① 宿主有 jobs/agents 服务 → 活作业按会话下发，终态作业不下发；
//   ② 宿主没有这两个服务 → 载荷里根本不出现 backgroundJobs 字段（旧宿主
//      上的响应与 3.13.x 逐字节一致，客户端不会因为多了个字段改变行为）；
//   ③ 服务自己抛错 → sidebar-state 仍然 200，其余字段照常（后台任务只是装
//      饰，不能把标题/回收站/血缘一起拖下水）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
const savedProfile = process.env.DSH_PROFILE ?? null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot({ agents = null, jobs = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-bgjobs-routes-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, 'trash'), { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })

  const routes = new Map()
  const domainState = { archivedSessionIds: [] }
  const liveSessions = new Map()
  const ctx = {
    workspaceRegistry: { list: () => [], state: domainState, archiveSession: async () => {} },
    sessionPersistence: { list: async () => [], locate: () => ({ path: join(root, 'none') }), readFrom: async () => ({ meta: { id: 'x', cwd: root, createdAt: 1 }, events: [] }) },
    sessionQuery: { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id: String(id), cwd: root, createdAt: 1 }, title: { title: String(id) } } })) },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async (v) => { domainState.archivedSessionIds = (v && v.archivedSessionIds) || [] } } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: (name) => {
      if (name === 'jobs') return jobs
      if (name === 'agents') return agents
      return null
    },
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?bgjobs=${Date.now()}-${Math.random()}`)
  apply(ctx)
  const call = async (path, body) => {
    const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = body === undefined ? 'GET' : 'POST'
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
    await routes.get(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  return { root, call, liveSessions }
}

async function cleanup(b) {
  if (savedProfile === null) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && (e.code === 'ENOTEMPTY' || e.code === 'EBUSY')) { await sleep(50); continue } throw e }
  }
}

test('sidebar-state: 有 jobs/agents 时只下发活作业，按会话分组', async () => {
  const agents = { list: () => [{ id: 'sess-a' }, { id: 'sess-b' }] }
  const jobs = {
    list: (sid) => (sid === 'sess-a'
      ? [
        { id: 'job-1', owner: 'sess-a', kind: 'bash', label: 'npm run dev', status: 'running', startedAt: 100 },
        { id: 'job-2', owner: 'sess-a', kind: 'bash', label: 'old', status: 'succeeded', startedAt: 50 },
      ]
      : [{ id: 'job-3', owner: 'sess-b', kind: 'bash', label: 'tail -f', status: 'stopping', startedAt: 200 }]),
  }
  const b = await boot({ agents, jobs })
  try {
    const r = await b.call('/archived-sessions/sidebar-state')
    assert.equal(r.status, 200)
    assert.ok(r.body.backgroundJobs, '应该带上 backgroundJobs')
    assert.deepEqual(Object.keys(r.body.backgroundJobs).sort(), ['sess-a', 'sess-b'])
    assert.deepEqual(r.body.backgroundJobs['sess-a'].map((j) => j.id), ['job-1'])
    assert.equal(r.body.backgroundJobs['sess-a'][0].label, 'npm run dev')
    // 终态作业不下发：它已经收尾了，挂个三角只会让人白点一次
    assert.equal(r.body.backgroundJobs['sess-a'].length, 1)
    assert.deepEqual(r.body.backgroundJobs['sess-b'].map((j) => j.id), ['job-3'])
    // 既有字段照旧
    assert.ok(Array.isArray(r.body.trashedSessionIds))
    assert.equal(typeof r.body.titles, 'object')
  } finally { await cleanup(b) }
})

test('sidebar-state: 宿主没有 jobs/agents → 载荷里没有 backgroundJobs 字段', async () => {
  const b = await boot({ agents: null, jobs: null })
  try {
    const r = await b.call('/archived-sessions/sidebar-state')
    assert.equal(r.status, 200)
    assert.equal('backgroundJobs' in r.body, false, '旧宿主的响应形状必须保持不变')
    // 其余字段仍齐
    assert.ok(Array.isArray(r.body.trashedSessionIds))
    assert.ok(r.body.lineage && typeof r.body.lineage === 'object')
  } finally { await cleanup(b) }
})

test('sidebar-state: jobs 服务抛错 → 仍然 200，且不带 backgroundJobs', async () => {
  const agents = { list: () => [{ id: 'sess-x' }] }
  const jobs = { list: () => { throw new Error('scoped layer disposed') } }
  const b = await boot({ agents, jobs })
  try {
    const r = await b.call('/archived-sessions/sidebar-state')
    assert.equal(r.status, 200)
    assert.equal('backgroundJobs' in r.body, false)
  } finally { await cleanup(b) }
})

test('sidebar-state: agents.list 抛错 → 仍然 200（装饰坏掉不拖垮侧栏）', async () => {
  const agents = { list: () => { throw new Error('agent registry gone') } }
  const jobs = { list: () => [{ id: 'j', owner: 'sess-x', status: 'running', startedAt: 1 }] }
  const b = await boot({ agents, jobs })
  try {
    const r = await b.call('/archived-sessions/sidebar-state')
    assert.equal(r.status, 200)
    assert.equal('backgroundJobs' in r.body, false)
    assert.ok(Array.isArray(r.body.trashedSessionIds))
  } finally { await cleanup(b) }
})
