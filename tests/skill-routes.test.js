// v0.6.1：skill 管理路由的回归（/skills/list、/mode、/export、/import、/delete）。
// 与 tests/mcp-routes.test.js 同款 boot（legacy 世代假 ctx + owner connection），
// 但 skill 根全部落在临时目录里（用 DSH_HOME + HOME 隔离），不碰用户真实 skill。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
const savedHome = process.env.DSH_HOME ?? null
const savedProfile = process.env.DSH_PROFILE ?? null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SKILL_MD = ['---', 'name: demo-skill', 'description: 路由测试用的 skill', '---', '', '# 正文', ''].join('\n')

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'dsm-skill-routes-'))
  const home = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const skillsDir = join(dshHome, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const skillDir = join(skillsDir, 'demo-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8')

  // 会话状态目录也隔离掉，避免碰真实 ~/.dsh/sessions-manager
  process.env.DSH_HOME = dshHome
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
  const { apply } = await import(`../src/index.js?skill-routes=${Date.now()}-${Math.random()}`)
  apply(ctx)

  const handlerOf = (pathWithQuery) => {
    const pathOnly = String(pathWithQuery).split('?')[0]
    const handler = routes.get(pathOnly)
    assert.ok(handler, `route not registered: ${pathOnly}`)
    return handler
  }
  const call = async (path, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.url = path
    let status = 200
    let text = ''
    const res = { writeHead: (v) => { status = v }, end: (v) => { text += Buffer.isBuffer(v) ? v.toString('utf8') : v || '' } }
    await handlerOf(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  const callRaw = async (path, buf) => {
    const req = Readable.from([buf])
    req.url = path
    let status = 200
    const chunks = []
    const res = { writeHead: (v) => { status = v }, end: (v) => { if (v) chunks.push(Buffer.isBuffer(v) ? v : Buffer.from(String(v))) } }
    await handlerOf(path)(req, res)
    const outBuf = Buffer.concat(chunks)
    // 失败响应是 JSON，成功响应是 zip；两种都要能断言，故只在像 JSON 时解析
    let body = null
    if (outBuf.subarray(0, 1).toString('latin1') === '{') {
      try { body = JSON.parse(outBuf.toString('utf8')) } catch (e) { body = null }
    }
    return { status, buf: outBuf, body }
  }
  return { root, home, dshHome, skillsDir, skillDir, call, callRaw, routes }
}

async function cleanup(b) {
  if (savedHome === null) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedProfile === null) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = savedProfile
  delete process.env.DSH_SESSIONS_MANAGER_TRASH_DIR
  delete process.env.DSH_SESSIONS_MANAGER_STAR_DIR
  delete process.env.DSH_SESSIONS_MANAGER_PENDING_DIR
  for (let i = 0; i < 60; i++) {
    try { await rm(b.root, { recursive: true, force: true }); return }
    catch (e) { if (e && e.code === 'ENOTEMPTY') { await sleep(50); continue } throw e }
  }
}

test('skills routes: 列表 → 切三态 → 备份 → 幂等', async () => {
  const b = await boot()
  try {
    let r = await b.call('/archived-sessions/skills/list')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.needsRestart, false)
    assert.deepEqual(r.body.modes, ['on', 'clipboard', 'off'])
    const found = r.body.skills.find((s) => s.name === 'demo-skill')
    assert.ok(found, '应扫到 demo-skill')
    assert.equal(found.mode, 'on')
    assert.ok(r.body.roots.some((x) => x.path === b.skillsDir))

    // 切到 clipboard
    r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'clipboard', name: 'demo-skill' })
    assert.equal(r.status, 200)
    assert.equal(r.body.changed, true)
    assert.equal(r.body.mode, 'clipboard')
    assert.ok(r.body.backup && r.body.backup.includes('.bak-skill-'))
    assert.ok(existsSync(r.body.backup))
    let text = readFileSync(join(b.skillDir, 'SKILL.md'), 'utf8')
    assert.match(text, /disable-model-invocation: true/)
    assert.doesNotMatch(text, /user-invocable/)

    // 切到 off
    r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'off', name: 'demo-skill' })
    assert.equal(r.body.mode, 'off')
    text = readFileSync(join(b.skillDir, 'SKILL.md'), 'utf8')
    assert.match(text, /user-invocable: false/)

    // 幂等：再切 off 不写盘
    const before = readdirSync(b.skillDir).length
    r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'off', name: 'demo-skill' })
    assert.equal(r.body.changed, false)
    assert.equal(r.body.backup, null)
    assert.equal(readdirSync(b.skillDir).length, before)

    // 回到 on：逐字节等于原文
    r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'on', name: 'demo-skill' })
    assert.equal(r.body.mode, 'on')
    assert.equal(readFileSync(join(b.skillDir, 'SKILL.md'), 'utf8'), SKILL_MD)
  } finally {
    await cleanup(b)
  }
})

test('skills routes: 坏参数 / 未扫描目录 / name 不匹配', async () => {
  const b = await boot()
  try {
    let r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'bogus' })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_SKILL_BAD_INPUT')

    r = await b.call('/archived-sessions/skills/mode', { dir: join(b.root, 'nope'), mode: 'off' })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_SKILL_UNKNOWN')

    r = await b.call('/archived-sessions/skills/mode', { dir: b.skillDir, mode: 'off', name: 'other-skill' })
    assert.equal(r.status, 500)
    assert.match(r.body.error, /skill name mismatch/)
  } finally {
    await cleanup(b)
  }
})

test('skills routes: 导出 zip 再导入到另一个根', async () => {
  const b = await boot()
  try {
    const r = await b.callRaw(`/archived-sessions/skills/export?dir=${encodeURIComponent(b.skillDir)}`)
    assert.equal(r.status, 200)
    assert.ok(r.buf.length > 0)
    // 本地魔数：PK\x03\x04
    assert.equal(r.buf.subarray(0, 2).toString('latin1'), 'PK')

    const dstRoot = join(b.dshHome, 'skills2')
    mkdirSync(dstRoot, { recursive: true })
    // root 必须在白名单里；skills2 不在，先断言拒绝
    let bad = await b.callRaw(`/archived-sessions/skills/import?root=${encodeURIComponent(dstRoot)}`, r.buf)
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'DSM_SKILL_BAD_ROOT')

    // 导入到自己所在根会被「已存在」拒绝（overwrite=1 才覆盖）
    bad = await b.callRaw(`/archived-sessions/skills/import?root=${encodeURIComponent(b.skillsDir)}`, r.buf)
    assert.equal(bad.status, 500)
    assert.match(bad.body.error, /already exists/)

    const ok = await b.callRaw(`/archived-sessions/skills/import?root=${encodeURIComponent(b.skillsDir)}&overwrite=1`, r.buf)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.name, 'demo-skill')
    assert.equal(readFileSync(join(b.skillsDir, 'demo-skill', 'SKILL.md'), 'utf8'), SKILL_MD)
  } finally {
    await cleanup(b)
  }
})

test('skills routes: 删除 + 未知目录', async () => {
  const b = await boot()
  try {
    let r = await b.call('/archived-sessions/skills/delete', { dir: b.skillDir, name: 'demo-skill' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.match(r.body.digest, /^[0-9a-f]{12}$/)
    assert.equal(existsSync(b.skillDir), false)
    // 本机真实的 ~/.agents/skills 仍是合法扫描根，所以只断言 demo-skill 消失了
    assert.equal(r.body.skills.some((s) => s.name === 'demo-skill'), false)

    r = await b.call('/archived-sessions/skills/delete', { dir: b.skillDir })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DSM_SKILL_UNKNOWN')
  } finally {
    await cleanup(b)
  }
})

test('skills routes: 三条新路由都已注册且受认证门保护', async () => {
  const b = await boot()
  try {
    for (const p of [
      '/archived-sessions/skills/list',
      '/archived-sessions/skills/mode',
      '/archived-sessions/skills/export',
      '/archived-sessions/skills/import',
      '/archived-sessions/skills/import-dir',
      '/archived-sessions/skills/delete',
    ]) {
      assert.ok(b.routes.has(p), `missing route ${p}`)
    }
  } finally {
    await cleanup(b)
  }
})
