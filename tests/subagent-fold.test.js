// v0.4.1（任务2）：子代理折叠回归。
// 目标：子代理不再作为独立行出现（避免多行同名会话），而是折叠进父行计数。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldSubagentRows } from '../src/client/logic.js'

const lineageOf = (map) => new Map(Object.entries(map))

test('子代理折叠进父行：只留父行 + 计数', () => {
  const rows = [
    { sessionId: 'p1', state: 'running', title: '父会话' },
    { sessionId: 'c1', state: 'running', title: '父会话' },
    { sessionId: 'c2', state: 'running', title: '父会话' },
    { sessionId: 'x1', state: 'done', title: '其它会话' },
  ]
  const lineage = lineageOf({
    c1: { origin: 'subagent', parentSession: 'p1' },
    c2: { origin: 'subagent', parentSession: 'p1' },
  })
  const out = foldSubagentRows(rows, lineage, () => '父会话')
  assert.equal(out.length, 2)
  const parent = out.find((r) => r.sessionId === 'p1')
  assert.equal(parent.subagentCount, 2)
  assert.equal(out.some((r) => r.sessionId === 'c1'), false, '子代理不再单独成行')
  assert.equal(out.some((r) => r.sessionId === 'c2'), false)
})

test('父会话不在关注态时合成父行，状态取子代理里最需关注的', () => {
  const rows = [
    { sessionId: 'c1', state: 'running', title: '同名' },
    { sessionId: 'c2', state: 'error', title: '同名' },
  ]
  const lineage = lineageOf({
    c1: { origin: 'subagent', parentSession: 'p9' },
    c2: { origin: 'subagent', parentSession: 'p9' },
  })
  const out = foldSubagentRows(rows, lineage, (id) => (id === 'p9' ? '父标题' : ''))
  assert.equal(out.length, 1)
  assert.equal(out[0].sessionId, 'p9')
  assert.equal(out[0].synthetic, true)
  assert.equal(out[0].subagentCount, 2)
  assert.equal(out[0].state, 'error', 'error 优先于 running')
  assert.equal(out[0].title, '父标题')
})

test('优先级排序 manual > error > feedback > running > done', () => {
  const cases = [
    [['manual', 'error'], 'manual'],
    [['error', 'feedback'], 'error'],
    [['feedback', 'running'], 'feedback'],
    [['running', 'done'], 'running'],
    [['done'], 'done'],
  ]
  for (const [states, expected] of cases) {
    const rows = states.map((s, i) => ({ sessionId: 'k' + i, state: s }))
    const lineage = lineageOf(Object.fromEntries(rows.map((r) => [r.sessionId, { origin: 'subagent', parentSession: 'P' }])))
    const out = foldSubagentRows(rows, lineage, () => 'P')
    assert.equal(out[0].state, expected, states.join('+'))
  }
})

test('非子代理行一律原样保留（含多级父）', () => {
  const rows = [
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'done' },
  ]
  const out = foldSubagentRows(rows, lineageOf({}), () => '')
  assert.deepEqual(out.map((r) => r.sessionId), ['a', 'b'])
  assert.equal(out[0].subagentCount, undefined)
})

test('宽容：无 lineage / 空表 / 脏行都不抛错', () => {
  const rows = [{ sessionId: 'a', state: 'running' }, null, { state: 'done' }]
  assert.doesNotThrow(() => foldSubagentRows(rows, null, () => ''))
  assert.doesNotThrow(() => foldSubagentRows([], new Map(), () => ''))
  assert.doesNotThrow(() => foldSubagentRows(null, new Map(), () => ''))
  assert.deepEqual(foldSubagentRows(null, null), [])
})

test('血缘用普通对象（非 Map）也能识别', () => {
  const rows = [{ sessionId: 'c', state: 'running' }]
  const out = foldSubagentRows(rows, { c: { origin: 'subagent', parentSession: 'p' } }, () => 'P')
  assert.equal(out.length, 1)
  assert.equal(out[0].sessionId, 'p')
  assert.equal(out[0].subagentCount, 1)
})
