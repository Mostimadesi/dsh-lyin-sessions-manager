import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markUnreadLabel, menuChannelOf, moveCapabilityOf, moveTargets } from '../src/client/logic.js'

// ---- v3.16.0：会话右键菜单的动作规划 ---------------------------------------
// 这四条判定被两条渲染通道共用（官方 contextMenus 数据注册 / 旧宿主 DOM 注入）。
// 之前两处各写一份，宿主把菜单换成 portal 渲染后新通道整个没接，三项静默消失
// 且没人发现——所以把「该出什么」抽成纯函数并钉住。

test('markUnreadLabel flips with the manual flag', () => {
  assert.equal(markUnreadLabel(true), '标记已读')
  assert.equal(markUnreadLabel(false), '标记未读')
  // 脏输入：localStorage 里读出来的可能不是布尔
  assert.equal(markUnreadLabel(undefined), '标记未读')
  assert.equal(markUnreadLabel(0), '标记未读')
  assert.equal(markUnreadLabel('x'), '标记已读')
})

test('moveCapabilityOf reads the host probe, prefers relocateSession, falls back to move', () => {
  assert.deepEqual(
    moveCapabilityOf({ actions: { relocateSession: { available: true } } }),
    { available: true, reason: null },
  )
  // 老 host 只有 move
  assert.deepEqual(
    moveCapabilityOf({ actions: { move: { available: true } } }),
    { available: true, reason: null },
  )
  // 不可用时把原因带出来，界面直接显示
  assert.deepEqual(
    moveCapabilityOf({ actions: { move: { available: false, reason: '需要 0.1.7+' } } }),
    { available: false, reason: '需要 0.1.7+' },
  )
  // 探针缺失一律按不可用：宁可灰着，也不要点了报「已移动」却没动
  assert.equal(moveCapabilityOf(null).available, false)
  assert.equal(moveCapabilityOf({}).available, false)
  assert.equal(moveCapabilityOf(undefined).reason, '正在检查当前版本的移动能力')
})

test('moveTargets marks the current workspace and drops pathless entries', () => {
  const ws = [
    { path: 'D:/a', title: '甲' },
    { path: 'D:/b' },
    { path: 'D:/c', workspaceId: 'wid-c' },
    { title: '没有 path' },
    null,
  ]
  const out = moveTargets(ws, 'D:/a')
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { path: 'D:/a', label: '甲（当前）', current: true })
  // 没 title 时取路径末段（比 workspaceId 更像人话），不是整条路径
  assert.deepEqual(out[1], { path: 'D:/b', label: 'b', current: false })
  assert.deepEqual(out[2], { path: 'D:/c', label: 'c', current: false })
  // 没有当前路径 → 谁都不标当前
  assert.equal(moveTargets(ws, null).every((t) => !t.current), true)
})

test('moveTargets survives dirty input without throwing', () => {
  for (const bad of [null, undefined, {}, [], 'junk', 42, true]) {
    assert.deepEqual(moveTargets(bad, null), [])
  }
})

test('menuChannelOf reports which renderer actually took over', () => {
  assert.equal(menuChannelOf(true, false), 'contextMenus')
  // 两者都成立时以官方通道为准
  assert.equal(menuChannelOf(true, true), 'contextMenus')
  assert.equal(menuChannelOf(false, true), 'dom')
  // 都没有 = 尚未判定，不能报成 dom（那会把「两条路都不通」伪装成正常兜底）
  assert.equal(menuChannelOf(false, false), null)
})
