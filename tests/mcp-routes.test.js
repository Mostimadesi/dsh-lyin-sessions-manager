// v0.5.5：MCP 服务器开关路由的回归（/mcp/rows 与 /mcp/toggle）。
// 与 tests/meta-routes.test.js 同款 boot（legacy 世代假 ctx + owner connection），
// 但 profile 目录指向临时目录，因此不会碰到用户真实的 cordis.patch.yml。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
// 本机真实环境里有 DSH_PROFILE=desktop：只删 DSH_PROFILE_DIR 时 resolveProfileDir
// 会回退到 ~/.dsh/profiles/desktop 并命中真实文件，503 用例就测不到分支了。
const savedProfile = process.env.DSH_PROFILE ?? null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PATCH = [
  '- id: mcp-active',
  '  name: dsh-mcp-client',
  '  config:',
  '    serverName: active',
  '    transport: stdio',
  "    command: 'D:\\\\nodejs\\\\node.exe'",
  '',
  '# ---',
  '# - insert:',
  '    #OFF#     - id: mcp-sleepy',
  "    #OFF#       name: '@deepseek-ai/dsh-mcp-client'",
  '    #OFF#       config:',
  '    #OFF#         serverName: sleepy',
  '    #OFF#         transport: stdio',
  "    #OFF#         command: 'D:\\\\nodejs\\\\node.exe'",
  '',
].join('\n')

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'dsm-mcp-routes-'))
  const profile = join(root, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), PATCH, 'utf8')
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, 'trash'), { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await mkdir(join(root, 'pending'), { recursive: true })

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
  const { apply } = await import(`../src/index.js?mcp-routes=${Date.now()}-${Math.random()}`)
  apply(ctx)
  const call = async (path, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += v || '' } }
    await routes.get(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  return { root, profile, call }
}

async function cleanup(b) {
  delete process.env.DSH_PROFILE_DIR
  if (savedProfile === null) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && e.code === 'ENOTEMPTY') { await sleep(50); continue } throw e }
  }
}

test('mcp routes: 列表 → 启用注释块 → 备份 → 未知 id / 坏参数', async () => {
  const b = await boot()
  try {
    let r = await b.call('/archived-sessions/mcp/rows')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.profile, b.profile)
    assert.equal(r.body.needsRestart, true)
    const byId = Object.fromEntries(r.body.rows.map((x) => [x.id, x]))
    assert.equal(byId['mcp-active'].enabled, true)
    assert.equal(byId['mcp-sleepy'].enabled, false)
    assert.equal(byId['mcp-sleepy'].commented, true)

    // 启用：剥 #OFF# + 恢复块头 + 落 .bak-mcpui-* 备份
    r = await b.call('/archived-sessions/mcp/toggle', { id: 'mcp-sleepy', enabled: true })
    assert.equal(r.status, 200)
    assert.equal(r.body.changed, true)
    assert.ok(r.body.backup && r.body.backup.includes('.bak-mcpui-'), '应生成备份文件')
    assert.ok(existsSync(r.body.backup))
    const text = await readFile(join(b.profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(!text.includes('#OFF#'), '不该残留 #OFF#')
    assert.ok(readdirSync(b.profile).some((f) => f.includes('.bak-mcpui-')))

    // 读回
    r = await b.call('/archived-sessions/mcp/rows')
    assert.equal(r.body.rows.find((x) => x.id === 'mcp-sleepy').enabled, true)

    // 再启用一次 = 幂等（不写文件、不产生新备份）
    const before = readdirSync(b.profile).length
    r = await b.call('/archived-sessions/mcp/toggle', { id: 'mcp-sleepy', enabled: true })
    assert.equal(r.body.changed, false)
    assert.equal(readdirSync(b.profile).length, before)

    // 停用启用中的行 = 末尾覆盖行
    r = await b.call('/archived-sessions/mcp/toggle', { id: 'mcp-active', enabled: false })
    assert.equal(r.body.changed, true)
    const text2 = await readFile(join(b.profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(text2.includes('- id: mcp-active\n  disabled: true'))
    assert.equal(r.body.rows.find((x) => x.id === 'mcp-active').enabled, false)

    // 未知 id / 坏参数
    r = await b.call('/archived-sessions/mcp/toggle', { id: 'mcp-nope', enabled: true })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_MCP_UNKNOWN_ROW')

    r = await b.call('/archived-sessions/mcp/toggle', { id: 'mcp-active' })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_MCP_BAD_INPUT')
  } finally {
    await cleanup(b)
  }
})

test('mcp routes: 找不到 profile 目录时 503', async () => {
  const b = await boot()
  try {
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    const r = await b.call('/archived-sessions/mcp/rows')
    assert.equal(r.status, 503)
    assert.equal(r.body.code, 'DSM_MCP_NO_PROFILE')
  } finally {
    await cleanup(b)
  }
})
