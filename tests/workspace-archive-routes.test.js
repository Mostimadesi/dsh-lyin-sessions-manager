// v3.12.0：工作区归档路由的回归（/workspace-archives 的读 / 归档 / 恢复 / 清空）。
// 与 tests/mcp-routes.test.js 同款 boot（假 ctx + owner connection），
// 状态目录指向临时目录，不碰用户真实的 workspace-archives.v1.json。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
const savedProfile = process.env.DSH_PROFILE ?? null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(workspaces) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-wsarch-routes-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, 'trash'), { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })

  const routes = new Map()
  const domainState = { archivedSessionIds: [] }
  const ctx = {
    workspaceRegistry: { list: () => workspaces, state: domainState, archiveSession: async () => {} },
    sessionPersistence: { list: async () => [], locate: () => ({ path: join(root, 'none') }), readFrom: async () => ({ meta: { id: 'x', cwd: root, createdAt: 1 }, events: [] }) },
    sessionQuery: { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id: String(id), cwd: root, createdAt: 1 }, title: { title: String(id) } } })) },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async (v) => { domainState.archivedSessionIds = (v && v.archivedSessionIds) || [] } } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: () => null,
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?wsarch=${Date.now()}-${Math.random()}`)
  apply(ctx)
  const call = async (path, body) => {
    const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
    // 路由用 req.method 区分「纯读」与「写」：不给动词，archive 会被当成 list。
    req.method = body === undefined ? 'GET' : 'POST'
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
    await routes.get(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  return { root, call, indexPath: join(root, 'state', 'workspace-archives.v1.json') }
}

async function cleanup(b) {
  if (savedProfile === null) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && (e.code === 'ENOTEMPTY' || e.code === 'EBUSY')) { await sleep(50); continue } throw e }
  }
}

const WS = [
  { id: 'ws-1', title: 'Project One', path: 'D:\\proj\\one' },
  { id: 'ws-2', title: 'Project Two', path: 'D:\\proj\\two' },
]

test('workspace-archives: 空读 → 归档 → 幂等 → 恢复 → 清空', async () => {
  const b = await boot(WS)
  try {
    // 空读：没有文件也要回 200 与空列表
    let r = await b.call('/archived-sessions/workspace-archives')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items, [])
    assert.deepEqual(r.body.keys, [])
    assert.equal(r.body.schemaVersion, 1)
    assert.equal(r.body.action, 'list')
    assert.equal(existsSync(b.indexPath), false, '纯读不该创建文件')

    // 归档：只做可见性，不碰会话归档状态
    r = await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\one' })
    assert.equal(r.status, 200)
    assert.equal(r.body.changed, true)
    assert.equal(r.body.keys.length, 1)
    assert.equal(r.body.items[0].path, 'D:\\proj\\one')
    assert.equal(r.body.items[0].title, 'Project One', '标题取自宿主工作区列表')
    assert.ok(r.body.items[0].archivedAt > 0)
    const onDisk = JSON.parse(await readFile(b.indexPath, 'utf8'))
    assert.equal(onDisk.schemaVersion, 1)
    assert.equal(Object.keys(onDisk.archives).length, 1)

    // 路径大小写/分隔符差异视为同一个工作区，且重复归档不产生第二条
    r = await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'd:/PROJ/one/' })
    assert.equal(r.status, 200)
    assert.equal(r.body.keys.length, 1, '折叠键应去重')

    // 未注册的路径必须 404：不接受自由路径，避免把「碰巧同形」的工作区藏掉
    r = await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\nope' })
    assert.equal(r.status, 404)
    assert.equal(r.body.ok, false)

    // 未知 action 400
    r = await b.call('/archived-sessions/workspace-archives', { action: 'explode' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, '未知操作')

    // 恢复
    r = await b.call('/archived-sessions/workspace-archives', { action: 'unarchive', path: 'D:\\proj\\one' })
    assert.equal(r.status, 200)
    assert.equal(r.body.changed, true)
    assert.deepEqual(r.body.keys, [])
    // 幂等：再恢复一次没有变化
    r = await b.call('/archived-sessions/workspace-archives', { action: 'unarchive', path: 'D:\\proj\\one' })
    assert.equal(r.body.changed, false)

    // 清空（先归档两个）
    await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\one' })
    await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\two' })
    r = await b.call('/archived-sessions/workspace-archives')
    assert.equal(r.body.keys.length, 2)
    r = await b.call('/archived-sessions/workspace-archives', { action: 'clear' })
    assert.equal(r.body.changed, true)
    assert.equal(r.body.removed, 2)
    assert.deepEqual(r.body.keys, [])
  } finally {
    await cleanup(b)
  }
})

test('workspace-archives: 工作区列表带 archived 标记', async () => {
  const b = await boot(WS)
  try {
    await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\two' })
    const r = await b.call('/archived-sessions/workspaces')
    const byId = Object.fromEntries(r.body.items.map((x) => [x.workspaceId, x]))
    assert.equal(byId['ws-1'].archived, false)
    assert.equal(byId['ws-2'].archived, true)
    // 原有字段不能丢：移动选择器还靠它们
    assert.equal(byId['ws-1'].title, 'Project One')
    assert.equal(byId['ws-1'].path, 'D:\\proj\\one')
  } finally {
    await cleanup(b)
  }
})

test('workspace-archives: 损坏的索引文件读成空列表而不是报错', async () => {
  const b = await boot(WS)
  try {
    await mkdir(join(b.root, 'state'), { recursive: true })
    await writeFile(b.indexPath, '{ this is not json', 'utf8')
    const r = await b.call('/archived-sessions/workspace-archives')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.items, [])
    // 坏文件不该挡住写入：归档后应恢复正常
    const w = await b.call('/archived-sessions/workspace-archives', { action: 'archive', path: 'D:\\proj\\one' })
    assert.equal(w.status, 200)
    assert.equal(w.body.keys.length, 1)
    const onDisk = JSON.parse(await readFile(b.indexPath, 'utf8'))
    assert.equal(onDisk.schemaVersion, 1)
  } finally {
    await cleanup(b)
  }
})
