import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRouterStore, llmSettingsPath, subagentSettingsPath, resolveDshHome } from '../src/router-store.js'

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-router-'))
  try {
    const llmPath = join(root, 'llm-router', 'settings.json')
    const subPath = join(root, 'subagent-router', 'settings.json')
    const store = createRouterStore({ llmPath, subagentPath: subPath, log: () => {} })
    await run({ store, root, llmPath, subPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const seedLlm = (path) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: 1,
    enabled: true,
    announce: 'switch',
    // 未知键：写回时应当被丢掉（与插件自己的 write() 一致）
    _examples: { note: 'should vanish' },
    routes: [
      { id: 'A', name: 'Alpha', chain: ['p/one', 'q/two'] },
      { id: 'B', name: 'Beta', chain: ['r/three'] },
    ],
  }, null, 2))
}

test('resolveDshHome: DSH_HOME 优先于 ~', () => {
  assert.equal(resolveDshHome({ env: { DSH_HOME: ' D:/x ' }, home: 'C:/home/u' }), 'D:/x')
  assert.equal(resolveDshHome({ env: { DSH_HOME: '   ' }, home: 'C:/home/u' }).replace(/\\/g, '/'), 'C:/home/u/.dsh')
  assert.equal(resolveDshHome({ env: {}, home: 'C:/home/u' }).replace(/\\/g, '/'), 'C:/home/u/.dsh')
})

test('llmSettingsPath / subagentSettingsPath: 默认落在 $DSH_HOME 下', () => {
  const env = { DSH_HOME: 'D:/dsh' }
  assert.equal(llmSettingsPath({ env }).replace(/\\/g, '/'), 'D:/dsh/llm-router/settings.json')
  assert.equal(subagentSettingsPath({ env }).replace(/\\/g, '/'), 'D:/dsh/subagent-router/settings.json')
  // 显式路径优先（测试与将来的自定义部署）
  assert.equal(llmSettingsPath({ env, llmPath: 'X:/a.json' }), 'X:/a.json')
})

test('snapshot: 文件不存在时给可用默认值，标 missing', async () => {
  await withStore(async ({ store }) => {
    const snap = store.snapshot()
    assert.equal(snap.needsRestart, false)
    assert.equal(snap.llm.missing, true)
    assert.equal(snap.llm.enabled, true)
    assert.deepEqual(snap.llm.routes, [])
    assert.equal(snap.subagent.missing, true)
    assert.equal(snap.subagent.candidates.length, 5)
    // 出厂候选引用的路由组在空表里一个都没有 → 5 条悬空
    assert.equal(snap.check.dangling.length, 5)
    // 读不该顺手建文件（那会让「没装插件」看起来像「装了但空」）：
    // 目录本身都不应该存在。
    assert.equal(existsSync(join(store.llmFile, '..')), false)
    assert.equal(existsSync(join(store.subFile, '..')), false)
  })
})

test('写回是规范化后的表：未知键被丢掉，字节形态与插件一致', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    const out = store.apply('llm', { action: 'set-announce', mode: 'always' })
    assert.equal(out.changed, true)
    const parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    assert.equal(parsed.announce, 'always')
    // 未知键不再存在
    assert.equal('_examples' in parsed, false)
    // 插件写的是 2 空格缩进 + 尾部换行
    const raw = readFileSync(llmPath, 'utf8')
    assert.ok(raw.endsWith('\n'))
    assert.ok(raw.includes('\n  "version": 1,'))
  })
})

test('幂等操作不写盘（mtime 不变、不产生备份）', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    const before = readFileSync(llmPath, 'utf8')
    const out = store.apply('llm', { action: 'set-announce', mode: 'switch' })
    assert.equal(out.changed, false)
    assert.equal(readFileSync(llmPath, 'utf8'), before)
    // 只有 settings.json 一个文件，没有 .bak / .tmp 残留
    assert.deepEqual(readdirSync(join(llmPath, '..')), ['settings.json'])
  })
})

test('写前落备份，写后无 tmp 残留', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    const out = store.apply('llm', { action: 'set-enabled', enabled: false })
    assert.equal(out.changed, true)
    assert.ok(out.backup && out.backup.includes('.bak-routerui-'))
    const files = readdirSync(join(llmPath, '..'))
    assert.equal(files.filter((f) => f.includes('.tmp-routerui-')).length, 0)
    assert.equal(files.filter((f) => f.includes('.bak-routerui-')).length, 1)
    // 备份就是改动前的内容
    assert.equal(JSON.parse(readFileSync(out.backup, 'utf8')).enabled, true)
  })
})

test('整条链换掉 + 挪候选 + 删路由，逐次落盘', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    store.apply('llm', { action: 'set-chain', id: 'A', chain: ['z/nine@high', 'y/eight'] })
    let parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    assert.equal(parsed.routes[0].chain.length, 2)
    assert.equal(parsed.routes[0].chain[0].reasoningEffort, 'high')

    store.apply('llm', { action: 'move-candidate', id: 'A', from: 1, to: 2 })
    parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    assert.equal(parsed.routes[0].chain[0].provider, 'y')

    store.apply('llm', { action: 'remove-route', id: 'B' })
    parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    assert.deepEqual(parsed.routes.map((r) => r.id), ['A'])
  })
})

test('坏 JSON 不会沿用旧缓存：读成默认表并能在下次写时自愈', async () => {
  await withStore(async ({ store, llmPath }) => {
    mkdirSync(join(llmPath, '..'), { recursive: true })
    writeFileSync(llmPath, '{ this is not json')
    const snap = store.snapshot()
    // missing 为 false（文件在），但内容读不动 → 默认表
    assert.equal(snap.llm.missing, false)
    assert.deepEqual(snap.llm.routes, [])
    const out = store.apply('llm', { action: 'add-route', id: 'N', chain: ['a/b'] })
    assert.equal(out.changed, true)
    const parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    assert.deepEqual(parsed.routes.map((r) => r.id), ['N'])
  })
})

test('子代理侧：增删改 + reload-from-router 借路由组', async () => {
  await withStore(async ({ store, llmPath, subPath }) => {
    seedLlm(llmPath)
    mkdirSync(join(subPath, '..'), { recursive: true })
    writeFileSync(subPath, JSON.stringify({ version: 1, candidates: ['llm-router/A'] }))

    const added = store.apply('subagent', { action: 'add-candidate', provider: 'other', model: 'x', tier: 'heavy' })
    assert.equal(added.changed, true)
    let parsed = JSON.parse(readFileSync(subPath, 'utf8'))
    assert.deepEqual(parsed.candidates.map((c) => `${c.provider}/${c.model}`), ['llm-router/A', 'other/x'])

    // B 还没被借用 → reload 会补进来
    const reload = store.apply('subagent', { action: 'reload-from-router' })
    assert.equal(reload.changed, true)
    parsed = JSON.parse(readFileSync(subPath, 'utf8'))
    assert.deepEqual(parsed.candidates.map((c) => `${c.provider}/${c.model}`), ['llm-router/A', 'other/x', 'llm-router/B'])

    // 再 reload 一次没有新增
    assert.equal(store.apply('subagent', { action: 'reload-from-router' }).changed, false)

    store.apply('subagent', { action: 'update-candidate', provider: 'llm-router', model: 'B', patch: { tier: 'heavy', label: ' Beta ' } })
    parsed = JSON.parse(readFileSync(subPath, 'utf8'))
    const b = parsed.candidates.find((c) => c.model === 'B')
    assert.equal(b.tier, 'heavy')
    assert.equal(b.label, 'Beta')
  })
})

test('子代理侧：删到空被拒绝，文件不变', async () => {
  await withStore(async ({ store, subPath }) => {
    mkdirSync(join(subPath, '..'), { recursive: true })
    writeFileSync(subPath, JSON.stringify({ version: 1, candidates: ['a/only'] }))
    const before = readFileSync(subPath, 'utf8')
    assert.throws(() => store.apply('subagent', { action: 'remove-candidate', provider: 'a', model: 'only' }), /至少留一个候选/)
    assert.equal(readFileSync(subPath, 'utf8'), before)
  })
})

test('apply: 未知名 target 报 DSM_ROUTER_BAD_TARGET', async () => {
  await withStore(async ({ store }) => {
    assert.throws(() => store.apply('nope', { action: 'set-enabled', enabled: true }), (e) => e.code === 'DSM_ROUTER_BAD_TARGET')
  })
})

test('snapshot 带跨文件检查：悬空候选 + 没被借用的路由组', async () => {
  await withStore(async ({ store, llmPath, subPath }) => {
    seedLlm(llmPath)
    mkdirSync(join(subPath, '..'), { recursive: true })
    writeFileSync(subPath, JSON.stringify({ version: 1, candidates: ['llm-router/A', 'llm-router/ZZZ'] }))
    const snap = store.snapshot()
    assert.deepEqual(snap.check.dangling, ['llm-router/ZZZ'])
    assert.deepEqual(snap.check.unusedRoutes, ['B'])
  })
})

test('编辑被拒时抛 RouterError（带 status 400），不改文件', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    const before = readFileSync(llmPath, 'utf8')
    assert.throws(
      () => store.apply('llm', { action: 'add-route', id: 'has space', chain: ['a/b'] }),
      (e) => e.name === 'RouterError' && e.status === 400,
    )
    assert.equal(readFileSync(llmPath, 'utf8'), before)
  })
})

test('指纹缓存：同一毫秒内重复读不重新解析，文件变了会重读', async () => {
  await withStore(async ({ store, llmPath }) => {
    seedLlm(llmPath)
    const first = store.readLlm()
    const second = store.readLlm()
    // 同一对象（缓存命中）
    assert.equal(first.settings, second.settings)
    // 手工改文件（模拟 `/router add`）后必须读到新内容
    const parsed = JSON.parse(readFileSync(llmPath, 'utf8'))
    parsed.routes.push({ id: 'C', chain: ['s/four'] })
    writeFileSync(llmPath, JSON.stringify(parsed, null, 2))
    // mtime 可能同毫秒，size 会变 → 指纹变化
    const third = store.readLlm()
    assert.deepEqual(third.settings.routes.map((r) => r.id), ['A', 'B', 'C'])
  })
})
