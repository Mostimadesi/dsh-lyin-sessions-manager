// v3.15.0：模型路由面板的 HTTP 层回归（/router/snapshot 与 /router/apply）。
// 与 tests/mcp-routes.test.js 同款 boot（假 ctx + owner connection）；
// DSH_HOME 指向临时目录，不碰用户真实的 ~/.dsh/llm-router。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
const savedHome = process.env.DSH_HOME ?? null
const savedProfile = process.env.DSH_PROFILE ?? null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot({ seedLlm, seedSub } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-router-routes-'))
  process.env.DSH_HOME = root
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, 'trash'), { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })

  const llmPath = join(root, 'llm-router', 'settings.json')
  const subPath = join(root, 'subagent-router', 'settings.json')
  if (seedLlm) {
    await mkdir(join(root, 'llm-router'), { recursive: true })
    await writeFile(llmPath, JSON.stringify(seedLlm, null, 2))
  }
  if (seedSub) {
    await mkdir(join(root, 'subagent-router'), { recursive: true })
    await writeFile(subPath, JSON.stringify(seedSub, null, 2))
  }

  const routes = new Map()
  const domainState = { archivedSessionIds: [] }
  const ctx = {
    workspaceRegistry: { list: () => [], state: domainState, archiveSession: async () => {} },
    sessionPersistence: { list: async () => [], locate: () => ({ path: join(root, 'none') }), readFrom: async () => ({ meta: { id: 'x', cwd: root, createdAt: 1 }, events: [] }) },
    sessionQuery: { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id: String(id), cwd: root, createdAt: 1 }, title: { title: String(id) } } })) },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async (v) => { domainState.archivedSessionIds = (v && v.archivedSessionIds) || [] } } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: () => null,
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?router=${Date.now()}-${Math.random()}`)
  apply(ctx)
  const call = async (path, body) => {
    const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = body === undefined ? 'GET' : 'POST'
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
    const handler = routes.get(path)
    if (!handler) throw new Error(`route not registered: ${path}`)
    await handler(req, res)
    return { status, body: JSON.parse(text) }
  }
  return { root, call, llmPath, subPath }
}

async function cleanup(b) {
  if (savedHome === null) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedProfile === null) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && (e.code === 'ENOTEMPTY' || e.code === 'EBUSY')) { await sleep(50); continue } throw e }
  }
}

const LLM_SEED = {
  version: 1,
  enabled: true,
  announce: 'switch',
  routes: [
    { id: 'alpha', name: 'Alpha', chain: ['p/one', 'q/two'] },
    { id: 'beta', name: 'Beta', chain: ['r/three'] },
  ],
}

test('router/snapshot：两个表 + 一致性检查，且恒 needsRestart=false', async () => {
  const b = await boot({ seedLlm: LLM_SEED, seedSub: { version: 1, candidates: ['llm-router/alpha'] } })
  try {
    const r = await b.call('/archived-sessions/router/snapshot', {})
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    // 与 MCP / profile 那类必须重启的改动不同：两个插件是 5 秒指纹轮询。
    assert.equal(r.body.needsRestart, false)
    assert.deepEqual(r.body.llm.routes.map((x) => x.id), ['alpha', 'beta'])
    assert.equal(r.body.llm.missing, false)
    assert.equal(r.body.subagent.candidates.length, 1)
    assert.deepEqual(r.body.check.dangling, [])
    assert.deepEqual(r.body.check.unusedRoutes, ['beta'])
  } finally { await cleanup(b) }
})

test('router/apply：改 announce 落盘，返回最新 snapshot', async () => {
  const b = await boot({ seedLlm: LLM_SEED })
  try {
    const r = await b.call('/archived-sessions/router/apply', { target: 'llm', op: { action: 'set-announce', mode: 'always' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.changed, true)
    assert.equal(r.body.needsRestart, false)
    assert.equal(r.body.snapshot.llm.announce, 'always')
    const disk = JSON.parse(await readFile(b.llmPath, 'utf8'))
    assert.equal(disk.announce, 'always')
  } finally { await cleanup(b) }
})

test('router/apply：幂等编辑 changed=false，且不重写文件', async () => {
  const b = await boot({ seedLlm: LLM_SEED })
  try {
    const before = await readFile(b.llmPath, 'utf8')
    const r = await b.call('/archived-sessions/router/apply', { target: 'llm', op: { action: 'set-announce', mode: 'switch' } })
    assert.equal(r.body.changed, false)
    assert.equal(await readFile(b.llmPath, 'utf8'), before)
  } finally { await cleanup(b) }
})

test('router/apply：坏输入回 400（不是 500），文件不动', async () => {
  const b = await boot({ seedLlm: LLM_SEED })
  try {
    const before = await readFile(b.llmPath, 'utf8')
    const bad = await b.call('/archived-sessions/router/apply', { target: 'llm', op: { action: 'add-route', id: 'has space', chain: ['a/b'] } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    assert.equal(bad.body.code, 'DSM_ROUTER_BAD_EDIT')
    assert.match(bad.body.error, /不能当路由 id/)
    // 未知 target 也是 400（形状问题），不是 500
    const badTarget = await b.call('/archived-sessions/router/apply', { target: 'nope', op: { action: 'set-enabled', enabled: true } })
    assert.equal(badTarget.status, 400)
    assert.equal(badTarget.body.code, 'DSM_ROUTER_BAD_INPUT')
    // 未知 action
    const badAction = await b.call('/archived-sessions/router/apply', { target: 'llm', op: { action: 'nope' } })
    assert.equal(badAction.status, 400)
    assert.equal(badAction.body.code, 'DSM_ROUTER_BAD_ACTION')
    assert.equal(await readFile(b.llmPath, 'utf8'), before)
  } finally { await cleanup(b) }
})

test('router/apply：子代理侧增删改，落盘到自己的文件', async () => {
  const b = await boot({ seedLlm: LLM_SEED, seedSub: { version: 1, candidates: ['llm-router/alpha'] } })
  try {
    const add = await b.call('/archived-sessions/router/apply', {
      target: 'subagent',
      op: { action: 'add-candidate', provider: 'other', model: 'x', tier: 'heavy', label: 'Other' },
    })
    assert.equal(add.status, 200)
    assert.deepEqual(add.body.snapshot.subagent.candidates.map((c) => `${c.provider}/${c.model}`), ['llm-router/alpha', 'other/x'])
    const disk = JSON.parse(await readFile(b.subPath, 'utf8'))
    assert.equal(disk.candidates[1].tier, 'heavy')

    const reload = await b.call('/archived-sessions/router/apply', { target: 'subagent', op: { action: 'reload-from-router' } })
    assert.equal(reload.body.changed, true)
    // beta 还没被借用 → 补进来，且 tier 落 light（路由表没有 tier 列）
    const beta = reload.body.snapshot.subagent.candidates.find((c) => c.model === 'beta')
    assert.equal(beta.tier, 'light')

    const move = await b.call('/archived-sessions/router/apply', { target: 'subagent', op: { action: 'move-candidate', from: 3, to: 1 } })
    assert.equal(move.body.snapshot.subagent.candidates[0].model, 'beta')
  } finally { await cleanup(b) }
})

test('router/snapshot：宿主没有这两个插件时给空表而不是 500', async () => {
  const b = await boot({})
  try {
    const r = await b.call('/archived-sessions/router/snapshot', {})
    assert.equal(r.status, 200)
    assert.equal(r.body.llm.missing, true)
    assert.deepEqual(r.body.llm.routes, [])
    assert.equal(r.body.subagent.missing, true)
    // 出厂候选还在（它们是真默认值，不是「读不到」的占位）
    assert.equal(r.body.subagent.candidates.length, 5)
  } finally { await cleanup(b) }
})
