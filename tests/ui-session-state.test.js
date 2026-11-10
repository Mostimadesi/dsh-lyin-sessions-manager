// v0.4.0：uiSession 状态 → 快捷面板状态的映射回归。
// 依据 app.asar 实证：@deepseek-ai/dsh-client-ui-session 的 statusSnapshot
// 条目形状为 { running, pendingInteraction, completionUnread }。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stateFromSessionStatus } from '../src/client/logic.js'

test('运行中 → running', () => {
  assert.equal(stateFromSessionStatus({ running: true, completionUnread: false }), 'running')
})

test('等待交互（审批/计划审阅/提问）→ feedback，且优先于 running', () => {
  assert.equal(stateFromSessionStatus({ running: true, pendingInteraction: { kind: 'question' } }), 'feedback')
  assert.equal(stateFromSessionStatus({ running: false, pendingInteraction: { kind: 'approval' } }), 'feedback')
})

test('完成未读 → done；失败类 turnKind → error', () => {
  const done = { running: false, completionUnread: true }
  assert.equal(stateFromSessionStatus(done), 'done')
  assert.equal(stateFromSessionStatus(done, { turnKind: 'completed' }), 'done')
  assert.equal(stateFromSessionStatus(done, { turnKind: 'max-tokens' }), 'done')
  assert.equal(stateFromSessionStatus(done, { turnKind: 'error' }), 'error')
  assert.equal(stateFromSessionStatus(done, { turnKind: 'aborted' }), 'error')
  assert.equal(stateFromSessionStatus(done, { turnKind: 'interrupted' }), 'error')
})

test('手动未读优先级最高', () => {
  assert.equal(stateFromSessionStatus({ running: true }, { manualUnread: true }), 'manual')
  assert.equal(stateFromSessionStatus(null, { manualUnread: true }), 'manual')
})

test('空闲 / 脏数据 → null（不进面板）', () => {
  assert.equal(stateFromSessionStatus({ running: false, completionUnread: false }), null)
  assert.equal(stateFromSessionStatus(null), null)
  assert.equal(stateFromSessionStatus(undefined), null)
  assert.equal(stateFromSessionStatus('junk'), null)
  assert.equal(stateFromSessionStatus(42), null)
})

test('turnKind 为 pending/未知时按 done 处理（不误报出错）', () => {
  const done = { running: false, completionUnread: true }
  assert.equal(stateFromSessionStatus(done, { turnKind: 'pending' }), 'done')
  assert.equal(stateFromSessionStatus(done, { turnKind: null }), 'done')
})
