import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANNOUNCE_MODES,
  DEFAULT_COOLDOWN,
  DEFAULT_NEVER_SWITCH,
  RouterError,
  STRATEGIES,
  TIERS,
  addRoute,
  addSubagentCandidate,
  appendRouterCandidates,
  applyLlmOp,
  applySubagentOp,
  candidateLabel,
  crossCheck,
  formatRoute,
  moveCandidate,
  moveSubagentCandidate,
  normalizeLlmRoute,
  normalizeLlmSettings,
  normalizeSubagentCandidate,
  normalizeSubagentSettings,
  parseCandidate,
  parseSubagentCandidate,
  removeRoute,
  removeSubagentCandidate,
  setEnabled,
  setAnnounce,
  setSubagentNote,
  updateRoute,
  updateSubagentCandidate,
} from '../src/router-core.js'

const base = () => normalizeLlmSettings({
  routes: [
    { id: 'fast', name: 'Fast', chain: ['alpha/m1', 'beta/m2'], strategy: 'fallback' },
    { id: 'deep', name: 'Deep', chain: ['gamma/m3'], announce: 'always' },
  ],
})

// ---------------------------------------------------------------- 常量镜像
test('router-core: 常量与两个路由插件逐字一致', () => {
  // 这些值一旦与插件分叉，面板写出去的表就会被它们再修一遍。
  assert.deepEqual([...STRATEGIES], ['fallback', 'round-robin'])
  assert.deepEqual([...ANNOUNCE_MODES], ['off', 'switch', 'always'])
  assert.deepEqual([...TIERS], ['light', 'heavy'])
  assert.deepEqual([...DEFAULT_NEVER_SWITCH], ['ABORTED', 'INVALID_REQUEST', 'INVALID_ARGS', 'INVALID_PREPARED_CALL'])
  assert.deepEqual({ ...DEFAULT_COOLDOWN }, { shortMs: 5000, rateLimitMs: 60000, maxMs: 1800000 })
})

// ---------------------------------------------------------------- 候选解析
test('parseCandidate: 三种写法、@effort、拒绝嵌套路由组', () => {
  assert.deepEqual(parseCandidate('a/m'), { provider: 'a', model: 'm' })
  assert.deepEqual(parseCandidate(' a / m '), { provider: 'a', model: 'm' })
  assert.deepEqual(parseCandidate('a/m@high'), { provider: 'a', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(parseCandidate({ provider: 'a', model: 'm', reasoningEffort: 'low' }), { provider: 'a', model: 'm', reasoningEffort: 'low' })
  assert.deepEqual(parseCandidate({ provider: 'a', model: 'm', reasoningEffort: '  ' }), { provider: 'a', model: 'm' })
  // 路由组不能当候选，否则会无限递归。
  assert.equal(parseCandidate('llm-router/fast'), undefined)
  assert.equal(parseCandidate({ provider: 'llm-router', model: 'fast' }), undefined)
  // 脏输入。注意 `a/m@` 在插件里不算错：`at < model.length - 1` 为假，
  // 它把整段当 model 原样收下（我们照抄，不另外加严）。
  assert.deepEqual(parseCandidate('a/m@'), { provider: 'a', model: 'm@' })
  for (const bad of ['', 'noslash', '/m', 'a/', 'a/m@high@low', 'a/m@h i', null, undefined, 42, []]) {
    assert.equal(parseCandidate(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`)
  }
})

test('candidateLabel: 可直接粘回输入框', () => {
  assert.equal(candidateLabel({ provider: 'a', model: 'm' }), 'a/m')
  assert.equal(candidateLabel({ provider: 'a', model: 'm', reasoningEffort: 'high' }), 'a/m@high')
  assert.equal(candidateLabel(undefined), '')
})

// ---------------------------------------------------------------- 路由规范化
test('normalizeLlmRoute: id 白名单、链去重、空链丢弃', () => {
  assert.equal(normalizeLlmRoute({ id: 'has space', chain: ['a/m'] }, 0), undefined)
  assert.equal(normalizeLlmRoute({ id: 'ok', chain: [] }, 0), undefined)
  assert.equal(normalizeLlmRoute({ id: 'ok', chain: ['llm-router/x'] }, 0), undefined)
  const route = normalizeLlmRoute({ id: 'ok', chain: ['a/m', 'a/m', 'b/n'] }, 0)
  assert.equal(route.chain.length, 2)
  // name 缺失时回落 id
  assert.equal(route.name, 'ok')
  // stickyLimit 夹逼到 1..100
  assert.equal(normalizeLlmRoute({ id: 'x', chain: ['a/m'], stickyLimit: 0 }, 0).stickyLimit, 1)
  assert.equal(normalizeLlmRoute({ id: 'x', chain: ['a/m'], stickyLimit: 999 }, 0).stickyLimit, 100)
  assert.equal(normalizeLlmRoute({ id: 'x', chain: ['a/m'], stickyLimit: 3.7 }, 0).stickyLimit, 4)
  // 未知 strategy / announce 整条丢弃而不是报错（与插件一致）
  const kept = normalizeLlmRoute({ id: 'x', chain: ['a/m'], strategy: 'magic', announce: 'loud' }, 0)
  assert.equal(kept.strategy, undefined)
  assert.equal(kept.announce, undefined)
})

test('normalizeLlmSettings: 空/脏输入给可用默认表，永不抛', () => {
  for (const bad of [null, undefined, {}, [], 'junk', 42, true]) {
    const s = normalizeLlmSettings(bad)
    assert.equal(s.enabled, true)
    assert.equal(s.displayName, 'LLM Router')
    assert.equal(s.defaultStrategy, 'fallback')
    assert.equal(s.stickyLimit, 1)
    assert.equal(s.announce, 'switch')
    assert.deepEqual(s.routes, [])
    assert.deepEqual({ ...s.cooldown }, { ...DEFAULT_COOLDOWN })
  }
  // neverSwitchOnCodes 始终并入默认四码，用户只能往上加
  const s = normalizeLlmSettings({ neverSwitchOnCodes: ['MY_CODE'] })
  assert.ok(s.neverSwitchOnCodes.includes('ABORTED'))
  assert.ok(s.neverSwitchOnCodes.includes('MY_CODE'))
  // 重复 id 只留第一条
  const dup = normalizeLlmSettings({ routes: [{ id: 'a', chain: ['p/1'] }, { id: 'a', chain: ['q/2'] }] })
  assert.equal(dup.routes.length, 1)
  assert.equal(dup.routes[0].chain[0].provider, 'p')
  // order 按出现顺序重排
  const ordered = normalizeLlmSettings({ routes: [{ id: 'a', chain: ['p/1'] }, { id: 'b', chain: ['q/2'] }] })
  assert.deepEqual(ordered.routes.map((r) => r.order), [0, 1])
})

test('normalizeLlmSettings: cooldown 越界夹逼', () => {
  const s = normalizeLlmSettings({ cooldown: { shortMs: -5, rateLimitMs: 9e9, maxMs: 12.6 } })
  assert.equal(s.cooldown.shortMs, 0)
  assert.equal(s.cooldown.rateLimitMs, 3600000)
  assert.equal(s.cooldown.maxMs, 13)
})

// ---------------------------------------------------------------- 路由编辑
test('formatRoute: 链 + 覆盖项，与插件输出的形状一致', () => {
  const s = base()
  assert.equal(formatRoute(s.routes[0]), 'fast: alpha/m1 → beta/m2  [fallback, sticky 1]')
  assert.equal(formatRoute(s.routes[1]), 'deep: gamma/m3  [sticky 1, announce always]')
})

test('addRoute: 新增、重名拒绝、坏链拒绝', () => {
  const s = base()
  const out = addRoute(s, { id: 'new', chain: ['x/a', 'y/b'] })
  assert.equal(out.settings.routes.length, 3)
  assert.equal(out.route.order, 2)
  assert.throws(() => addRoute(s, { id: 'fast', chain: ['x/a'] }), /已经有 "fast"/)
  assert.throws(() => addRoute(s, { id: 'x', chain: [] }), /至少要有一个候选/)
  assert.throws(() => addRoute(s, { id: 'x', chain: ['noslash'] }), /读不出 "noslash"/)
  assert.throws(() => addRoute(s, { id: 'x', chain: ['llm-router/fast'] }), /读不出/)
})

test('updateRoute: 改链/改名/清空 description，strategy 传空串回到全局默认', () => {
  const s = base()
  const out = updateRoute(s, 'fast', { chain: ['z/z9@high'], name: 'Renamed', description: '' })
  assert.equal(out.route.name, 'Renamed')
  assert.equal(out.route.description, undefined)
  assert.equal(out.route.chain.length, 1)
  assert.equal(out.route.chain[0].reasoningEffort, 'high')
  const back = updateRoute(out.settings, 'fast', { strategy: '' })
  assert.equal(back.route.strategy, undefined)
  assert.throws(() => updateRoute(s, 'nope', { name: 'x' }), /没有 "nope"/)
  assert.throws(() => updateRoute(s, 'fast', { name: '  ' }), /名称不能为空/)
  assert.throws(() => updateRoute(s, 'fast', { stickyLimit: 2.5 }), /得是整数/)
})

test('removeRoute: 删除并返回被删的', () => {
  const s = base()
  const out = removeRoute(s, 'fast')
  assert.equal(out.route.id, 'fast')
  assert.deepEqual(out.settings.routes.map((r) => r.id), ['deep'])
  assert.throws(() => removeRoute(s, 'ghost'), /没有 "ghost"/)
})

test('moveCandidate: 1 起序号、非整数拒绝、越界拒绝', () => {
  const s = base()
  const down = moveCandidate(s, 'fast', 1, 2)
  assert.deepEqual(down.route.chain.map(candidateLabel), ['beta/m2', 'alpha/m1'])
  const same = moveCandidate(s, 'fast', 2, 2)
  assert.deepEqual(same.route.chain.map(candidateLabel), ['alpha/m1', 'beta/m2'])
  assert.throws(() => moveCandidate(s, 'fast', 1, 3), /第 3 个不在链上/)
  assert.throws(() => moveCandidate(s, 'fast', 0, 1), /第 0 个不在链上/)
  assert.throws(() => moveCandidate(s, 'fast', 1.5, 1), /得是整数/)
  assert.throws(() => moveCandidate(s, 'fast', 'a', 1), /得是数字/)
})

test('setEnabled / setAnnounce: 幂等，值没变就不算改', () => {
  const s = base()
  const off = setEnabled(s, false)
  assert.equal(off.changed, true)
  assert.equal(off.settings.enabled, false)
  assert.equal(setEnabled(off.settings, false).changed, false)
  // 只认 === true，字符串不生效
  assert.equal(setEnabled(off.settings, 'true').settings.enabled, false)
  assert.equal(setAnnounce(s, 'always').changed, true)
  assert.equal(setAnnounce(s, 'always').settings.announce, 'always')
  assert.equal(setAnnounce(s, 'switch').changed, false)
  assert.throws(() => setAnnounce(s, 'loud'), /announce 只能是/)
})

// ---------------------------------------------------------------- 操作分发
test('applyLlmOp: 分发表覆盖全部动作，未知动作 400', () => {
  const s = base()
  assert.equal(applyLlmOp(s, { action: 'set-enabled', enabled: false }).settings.enabled, false)
  assert.equal(applyLlmOp(s, { action: 'set-announce', mode: 'off' }).settings.announce, 'off')
  assert.equal(applyLlmOp(s, { action: 'set-default-strategy', strategy: 'round-robin' }).settings.defaultStrategy, 'round-robin')
  assert.equal(applyLlmOp(s, { action: 'set-global-sticky', stickyLimit: 4 }).settings.stickyLimit, 4)
  assert.equal(applyLlmOp(s, { action: 'add-route', id: 'n', chain: ['a/b'] }).settings.routes.length, 3)
  assert.equal(applyLlmOp(s, { action: 'remove-route', id: 'fast' }).settings.routes.length, 1)
  assert.equal(applyLlmOp(s, { action: 'set-chain', id: 'fast', chain: ['q/q'] }).detail.chain.length, 1)
  const moved = applyLlmOp(s, { action: 'move-candidate', id: 'fast', from: 1, to: 2 })
  assert.deepEqual(moved.detail.chain.map(candidateLabel), ['beta/m2', 'alpha/m1'])
  assert.throws(() => applyLlmOp(s, { action: 'nope' }), (e) => e instanceof RouterError && e.status === 400 && e.code === 'DSM_ROUTER_BAD_ACTION')
  assert.throws(() => applyLlmOp(s, {}), /未知的 LLM 路由操作/)
})

// ---------------------------------------------------------------- 子代理
test('parseSubagentCandidate / normalizeSubagentCandidate: tier 回落 light', () => {
  assert.deepEqual(parseSubagentCandidate('llm-router/GLM5.3'), { provider: 'llm-router', model: 'GLM5.3', tier: 'light' })
  assert.deepEqual(parseSubagentCandidate({ provider: 'a', model: 'm', tier: 'heavy', label: 'L' }), { provider: 'a', model: 'm', tier: 'heavy', label: 'L' })
  // 不认识的 tier 退到 light（安全侧：便宜的那个也答得出）
  assert.equal(normalizeSubagentCandidate({ provider: 'a', model: 'm', tier: 'medium' }).tier, 'light')
  for (const bad of ['', 'noslash', '/m', 'a/', null, 42, [], { provider: 'a' }, { provider: 'a b', model: 'm' }]) {
    assert.equal(parseSubagentCandidate(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`)
  }
})

test('normalizeSubagentSettings: 空清单回落出厂候选，note 截到 400', () => {
  const s = normalizeSubagentSettings({})
  assert.equal(s.candidates.length, 5)
  assert.equal(s.enabled, true)
  assert.equal(s.guidance, true)
  assert.equal(s.guidanceOrder, 2810)
  assert.equal(s.note, '')
  const long = normalizeSubagentSettings({ note: 'x'.repeat(500) })
  assert.equal(long.note.length, 401) // 400 + 省略号
  // 重复候选只留第一份
  const dup = normalizeSubagentSettings({ candidates: ['a/m', 'a/m', { provider: 'a', model: 'm', tier: 'heavy' }] })
  assert.equal(dup.candidates.length, 1)
  assert.equal(dup.candidates[0].tier, 'light')
})

test('子代理候选增删改挪', () => {
  const s = normalizeSubagentSettings({ candidates: ['a/m', 'b/n', 'c/o'] })
  const added = addSubagentCandidate(s, { provider: 'd', model: 'p', tier: 'heavy' })
  assert.equal(added.settings.candidates.length, 4)
  assert.throws(() => addSubagentCandidate(s, { provider: 'a', model: 'm' }), /已经有 a\/m/)
  assert.throws(() => addSubagentCandidate(s, { provider: '', model: 'm' }), /要有 provider 与 model/)

  const tiered = updateSubagentCandidate(s, 'a', 'm', { tier: 'heavy', label: ' Alpha ' })
  assert.equal(tiered.candidate.tier, 'heavy')
  assert.equal(tiered.candidate.label, 'Alpha')
  const cleared = updateSubagentCandidate(tiered.settings, 'a', 'm', { label: '' })
  assert.equal(cleared.candidate.label, undefined)
  assert.throws(() => updateSubagentCandidate(s, 'a', 'm', { tier: 'medium' }), /tier 只能是/)
  assert.throws(() => updateSubagentCandidate(s, 'x', 'y', { tier: 'light' }), /候选里没有 x\/y/)

  const removed = removeSubagentCandidate(s, 'b', 'n')
  assert.deepEqual(removed.settings.candidates.map((c) => c.model), ['m', 'o'])
  // 删到空会被插件回落到出厂清单 —— 直接拒绝，别让用户以为删掉了
  const one = normalizeSubagentSettings({ candidates: ['a/m'] })
  assert.throws(() => removeSubagentCandidate(one, 'a', 'm'), /至少留一个候选/)

  const moved = moveSubagentCandidate(s, 1, 3)
  assert.deepEqual(moved.settings.candidates.map((c) => c.model), ['n', 'o', 'm'])
  assert.throws(() => moveSubagentCandidate(s, 1, 9), /第 9 个不在清单里/)
  assert.throws(() => moveSubagentCandidate(s, 1.5, 2), /得是整数/)
})

test('setSubagentNote: 截断 + 幂等', () => {
  const s = normalizeSubagentSettings({ candidates: ['a/m'] })
  const out = setSubagentNote(s, '  hello  ')
  assert.equal(out.note, 'hello')
  assert.equal(setSubagentNote(out.settings, 'hello').changed, false)
  assert.equal(setSubagentNote(s, 'y'.repeat(500)).note.length, 400)
})

test('appendRouterCandidates: 只加不改，已存在的不覆盖', () => {
  const llm = normalizeLlmSettings({ routes: [
    { id: 'A', name: 'Alpha', chain: ['p/1'] },
    { id: 'B', name: 'Beta', chain: ['q/2'] },
  ] })
  const sub = normalizeSubagentSettings({ candidates: [{ provider: 'llm-router', model: 'A', tier: 'heavy', label: '手调的' }] })
  const out = appendRouterCandidates(sub, llm)
  assert.equal(out.changed, true)
  assert.deepEqual(out.added.map((c) => c.model), ['B'])
  const a = out.settings.candidates.find((c) => c.model === 'A')
  // 手调过的 tier / label 保留
  assert.equal(a.tier, 'heavy')
  assert.equal(a.label, '手调的')
  // 借来的一律 light（路由表没有 tier 列）
  assert.equal(out.settings.candidates.find((c) => c.model === 'B').tier, 'light')
  // 再跑一次没有新增
  assert.equal(appendRouterCandidates(out.settings, llm).changed, false)
})

test('applySubagentOp: reload-from-router 无 llm 表时也安全', () => {
  const s = normalizeSubagentSettings({ candidates: ['a/m'] })
  // 空路由表里没有路由组可借 → 没有新增。关键是不能抛。
  const out = applySubagentOp(s, { action: 'reload-from-router' }, undefined)
  assert.equal(out.changed, false)
  assert.deepEqual(out.detail, [])
  assert.throws(() => applySubagentOp(s, { action: 'nope' }), /未知的子代理路由操作/)
})

// ---------------------------------------------------------------- 一致性
test('crossCheck: 悬空候选与没被用到的路由组', () => {
  const llm = normalizeLlmSettings({ routes: [{ id: 'A', chain: ['p/1'] }, { id: 'B', chain: ['q/2'] }] })
  const sub = normalizeSubagentSettings({ candidates: ['llm-router/A', 'llm-router/GONE', 'other/x'] })
  const out = crossCheck(llm, sub)
  assert.deepEqual(out.dangling, ['llm-router/GONE'])
  assert.deepEqual(out.unusedRoutes, ['B'])
  // 空表：出厂子代理候选引用的是出厂路由组 id，而空路由表里一个都没有
  // → 全部判为悬空。这不是 bug，是「另一侧读不到」时宁可报多的行为。
  assert.equal(crossCheck(normalizeLlmSettings(undefined), normalizeSubagentSettings(undefined)).dangling.length, 5)
})
