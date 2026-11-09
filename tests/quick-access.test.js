// v0.2 快捷访问的分组纯逻辑回归。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupQuickAccess } from '../src/client/logic.js'

test('groupQuickAccess groups the four attention states and counts them', () => {
  const rows = [
    { sessionId: 'r1', state: 'running' },
    { sessionId: 'r2', state: 'running' },
    { sessionId: 'f1', state: 'feedback' },
    { sessionId: 'e1', state: 'error' },
    { sessionId: 'd1', state: 'done' },
    { sessionId: 'm1', state: 'manual' }, // 手动未读并入「刚完成·未读」组
  ]
  const g = groupQuickAccess(rows)
  assert.deepEqual(g.running.map((x) => x.sessionId), ['r1', 'r2'])
  assert.deepEqual(g.feedback.map((x) => x.sessionId), ['f1'])
  assert.deepEqual(g.error.map((x) => x.sessionId), ['e1'])
  assert.deepEqual(g.done.map((x) => x.sessionId), ['d1', 'm1'])
  assert.equal(g.count, 6)
})

test('groupQuickAccess drops null/unknown states (the no-attention majority)', () => {
  const g = groupQuickAccess([
    { sessionId: 'idle1', state: null },
    { sessionId: 'idle2', state: 'done-read' }, // 未知态不归类
    { sessionId: 'ok' }, // 缺 state
    [],
  ])
  assert.equal(g.count, 0)
  assert.equal(g.running.length, 0)
})

test('groupQuickAccess tolerates junk input without throwing', () => {
  for (const junk of [null, undefined, 'nope', 42, [null, {}, 'str', 7]]) {
    const g = groupQuickAccess(junk)
    assert.equal(g.count, 0)
    assert.deepEqual(g.running, [])
  }
})
