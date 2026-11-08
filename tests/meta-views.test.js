// v0.1 元数据层的 client 纯逻辑回归：
// - reviewOf / priorityOf / ascPriority 的判定与归一
// - SAVED_VIEWS/SAVED_SORTS 两端夹逼接受 'review' / 'priority'
//   （filterSnapshotOf 与 filterShapeFromSaved 白名单失同步会让旧存筛选
//   静默降级，这是 v0.1 规格 §6 明确要求锁住的回归点）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewOf, priorityOf, ascPriority, filterSnapshotOf, filterShapeFromSaved } from '../src/client/logic.js'

// ---- reviewOf -------------------------------------------------------------

test('reviewOf filters on the review flag and tolerates junk rows', () => {
  const items = [
    { sessionId: 'a', review: true },
    { sessionId: 'b', review: false },
    { sessionId: 'c' },
    null,
    // 宽松真值判（host 保证字段恒为布尔，但缓存/旧快照行缺字段不抛错）：
    // truthy 的 review:1 也算已标记。
    { sessionId: 'd', review: 1 },
  ]
  assert.deepEqual(reviewOf(items).map((x) => x.sessionId), ['a', 'd'])
  assert.deepEqual(reviewOf(null), [])
  assert.deepEqual(reviewOf(undefined), [])
  assert.deepEqual(reviewOf('junk'), [])
})

// ---- priorityOf -----------------------------------------------------------

test('priorityOf normalizes unset and out-of-range to 3', () => {
  assert.equal(priorityOf({ priority: 1 }), 1)
  assert.equal(priorityOf({ priority: 5 }), 5)
  assert.equal(priorityOf({}), 3)
  assert.equal(priorityOf({ priority: null }), 3)
  assert.equal(priorityOf({ priority: 0 }), 3)
  assert.equal(priorityOf({ priority: 6 }), 3)
  assert.equal(priorityOf({ priority: '2' }), 3)
  assert.equal(priorityOf({ priority: 2.5 }), 3)
  assert.equal(priorityOf(null), 3)
})

// ---- ascPriority ----------------------------------------------------------

test('ascPriority sorts 1 first and falls back to newest within a tier', () => {
  const mk = (id, priority, createdAt) => ({ sessionId: id, priority, createdAt })
  const list = [
    mk('low', 4, 100),
    mk('high', 1, 50),
    mk('unset-new', null, 300),
    mk('unset-old', undefined, 10),
    mk('p3-new', 3, 90),
    mk('p3-old', 3, 20),
  ]
  const sorted = [...list].sort(ascPriority)
  // 1 最高在前；同优先级（含未设置按 3）组内创建时间新者在前。
  assert.deepEqual(sorted.map((x) => x.sessionId), ['high', 'unset-new', 'p3-new', 'p3-old', 'unset-old', 'low'])
})

test('ascPriority tolerates malformed rows without throwing', () => {
  assert.doesNotThrow(() => {
    const out = [null, {}, { sessionId: 'x', priority: 2 }].sort(ascPriority)
    assert.equal(out.length, 3)
  })
})

// ---- 两端夹逼（saved-filter 白名单） --------------------------------------

test('filterSnapshotOf round-trips review/priority; junk still falls back', () => {
  const snap = filterSnapshotOf({ filter: 'review', workspaceFilter: '/ws/x', sortBy: 'priority', tagFilter: 't_1' })
  assert.deepEqual(snap, { view: 'review', workspace: '/ws/x', sort: 'priority', tag: 't_1' })

  // 非法值回落默认（老纪律不变）。
  assert.deepEqual(filterSnapshotOf({ filter: 'nope', sortBy: 'nope' }), { view: 'all', workspace: 'all', sort: 'newest', tag: '' })
})

test('filterShapeFromSaved restores review/priority without degradation', () => {
  const shape = filterShapeFromSaved({ filters: { view: 'review', workspace: '/ws/x', sort: 'priority', tag: '' } })
  assert.equal(shape.view, 'review')
  assert.equal(shape.sort, 'priority')
  assert.deepEqual(shape.degraded, [])
})

test('filterShapeFromSaved flags unknown view/sort as degraded, not silently', () => {
  const shape = filterShapeFromSaved({ filters: { view: 'future-thing', sort: 'priority-2', tag: 't_1' } })
  assert.equal(shape.view, 'all')
  assert.equal(shape.sort, 'newest')
  assert.ok(shape.degraded.includes('view'))
  assert.ok(shape.degraded.includes('sort'))
  assert.equal(shape.tag, 't_1')
})
