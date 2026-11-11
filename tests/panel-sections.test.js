// v0.5.0：面板次级区（顶部摘要条 / 最近活跃 / 已标记）回归。
//
// 目标：面板空闲时不再空白——补的是**另外两个维度**（时间维度、标记维度），
// 而不是更多同质条目；同时保证「已在上方关注区列出的会话不会重复出现」。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agoLabel,
  foldActivityItems,
  markBadges,
  markedRows,
  mergeActivityItems,
  QA_RECENT_LIMIT,
  QA_SECTION_LIMIT,
  recentActiveRows,
  summaryCounts,
} from '../src/client/logic.js'

const NOW = 1700000000000
const MIN = 60 * 1000
const HOUR = 60 * MIN

// —— 顶部摘要条 ————————————————————————————————————————————————

test('摘要条：四组计数 + 手动未读归入刚完成', () => {
  const rows = [
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'running' },
    { sessionId: 'c', state: 'feedback' },
    { sessionId: 'd', state: 'error' },
    { sessionId: 'e', state: 'done' },
    { sessionId: 'f', state: 'manual' },
  ]
  const s = summaryCounts(rows)
  assert.deepEqual(s, { running: 2, feedback: 1, error: 1, done: 2, attention: 6 })
})

test('摘要条：空输入与脏行不炸，未知识别为 0', () => {
  assert.deepEqual(summaryCounts(null), { running: 0, feedback: 0, error: 0, done: 0, attention: 0 })
  assert.deepEqual(summaryCounts([null, {}, { sessionId: 'x', state: 'nope' }]), {
    running: 0, feedback: 0, error: 0, done: 0, attention: 0,
  })
})

// —— 相对时间 ————————————————————————————————————————————————

test('agoLabel：刚刚 / 分钟 / 小时 / 天 / 月', () => {
  assert.equal(agoLabel(NOW - 10 * 1000, NOW), '刚刚')
  assert.equal(agoLabel(NOW - 5 * MIN, NOW), '5 分钟前')
  assert.equal(agoLabel(NOW - 3 * HOUR, NOW), '3 小时前')
  assert.equal(agoLabel(NOW - 50 * HOUR, NOW), '2 天前')
  assert.equal(agoLabel(NOW - 60 * 24 * HOUR, NOW), '2 个月前')
})

test('agoLabel：未来时间戳与无效值一律返回空串（不写自相矛盾的文案）', () => {
  assert.equal(agoLabel(NOW + 5 * MIN, NOW), '')
  assert.equal(agoLabel(0, NOW), '')
  assert.equal(agoLabel(null, NOW), '')
  assert.equal(agoLabel('abc', NOW), '')
  assert.equal(agoLabel(NOW - MIN, 'abc'), '')
})

// —— 最近活跃 ————————————————————————————————————————————————

test('最近活跃：按 updatedAt 倒序，窗口外的行被排除', () => {
  const items = [
    { sessionId: 'old', title: '很久以前', updatedAt: NOW - 30 * HOUR },
    { sessionId: 'mid', title: '三小时前', updatedAt: NOW - 3 * HOUR },
    { sessionId: 'new', title: '刚刚', updatedAt: NOW - 10 * 1000 },
  ]
  const { rows, total } = recentActiveRows(items, { now: NOW })
  assert.deepEqual(rows.map((r) => r.sessionId), ['new', 'mid'])
  assert.equal(total, 2, 'total 是窗口内的总数')
  assert.equal(rows[1].ago, '3 小时前')
})

test('最近活跃：exclude 排除已在上方关注区列出的会话（Set 与数组都接受）', () => {
  const items = [
    { sessionId: 'a', title: 'A', updatedAt: NOW - MIN },
    { sessionId: 'b', title: 'B', updatedAt: NOW - 2 * MIN },
    { sessionId: 'c', title: 'C', updatedAt: NOW - 3 * MIN },
  ]
  assert.deepEqual(recentActiveRows(items, { now: NOW, exclude: new Set(['a']) }).rows.map((r) => r.sessionId), ['b', 'c'])
  assert.deepEqual(recentActiveRows(items, { now: NOW, exclude: ['b', 'c'] }).rows.map((r) => r.sessionId), ['a'])
  assert.deepEqual(recentActiveRows(items, { now: NOW, exclude: 'a' }).rows.map((r) => r.sessionId), ['b', 'c'])
})

test('最近活跃：缺 updatedAt 的行跳过，截断时 total 保留真实条数', () => {
  const items = [{ sessionId: 'no-ts', title: '没有时间戳' }]
  for (let i = 0; i < 10; i += 1) {
    items.push({ sessionId: 's' + i, title: 'T' + i, updatedAt: NOW - i * MIN })
  }
  const { rows, total } = recentActiveRows(items, { now: NOW, limit: 3 })
  assert.equal(rows.length, 3)
  assert.equal(total, 10, '截断前共 10 个（另有 7 个未显示）')
  assert.deepEqual(rows.map((r) => r.sessionId), ['s0', 's1', 's2'])
})

test('最近活跃：limit 缺省为 8（v0.5.2 按用户反馈从 6 放宽），脏输入返回空集', () => {
  const items = []
  for (let i = 0; i < 20; i += 1) items.push({ sessionId: 's' + i, updatedAt: NOW - i * MIN })
  assert.equal(QA_RECENT_LIMIT, 8)
  assert.equal(recentActiveRows(items, { now: NOW }).rows.length, QA_RECENT_LIMIT)
  assert.equal(recentActiveRows(items, { now: NOW }).rows.length, 8)
  assert.deepEqual(recentActiveRows(null, { now: NOW }), { rows: [], total: 0 })
  assert.deepEqual(recentActiveRows([null, {}, { sessionId: null, updatedAt: NOW }], { now: NOW }), { rows: [], total: 0 })
})

// —— 已标记 ————————————————————————————————————————————————

test('markBadges：★收藏 / 待回看 / 仅 P1-P2 出徽标', () => {
  assert.deepEqual(markBadges({ starred: true }), ['★'])
  assert.deepEqual(markBadges({ review: true }), ['待回看'])
  assert.deepEqual(markBadges({ starred: true, review: true, priority: 1 }), ['★', '待回看', 'P1'])
  assert.deepEqual(markBadges({ priority: 2 }), ['P2'])
  assert.deepEqual(markBadges({ priority: 3 }), [], 'P3 是默认值，不算标记')
  assert.deepEqual(markBadges({ priority: null }), [])
  assert.deepEqual(markBadges(null), [])
})

test('已标记：三源合并去重，P1 在前、无优先级排最后', () => {
  const items = [
    { sessionId: 'star', title: '收藏的', starred: true, updatedAt: NOW - 5 * MIN },
    { sessionId: 'review', title: '待回看', review: true, updatedAt: NOW - MIN },
    { sessionId: 'p1', title: '最高优先', priority: 1, updatedAt: NOW - 9 * HOUR },
    { sessionId: 'p2', title: '次高', priority: 2, updatedAt: NOW - 2 * HOUR },
    { sessionId: 'both', title: '又收藏又待回看', starred: true, review: true, updatedAt: NOW - 4 * MIN },
    { sessionId: 'plain', title: '没标记', updatedAt: NOW },
  ]
  const { rows, total } = markedRows(items, { now: NOW })
  assert.equal(total, 5, '没标记的会话不进这一区')
  assert.deepEqual(rows.map((r) => r.sessionId), ['p1', 'p2', 'review', 'both', 'star'])
  assert.deepEqual(rows[3].badges, ['★', '待回看'])
})

test('已标记：同一会话只出现一次（三源命中不重复）', () => {
  const items = [{ sessionId: 'one', title: '全中', starred: true, review: true, priority: 1, updatedAt: NOW }]
  const { rows } = markedRows(items, { now: NOW })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].badges, ['★', '待回看', 'P1'])
})

test('已标记：exclude 生效（含刚在「最近活跃」里出现过的）', () => {
  const items = [
    { sessionId: 'a', title: 'A', starred: true, updatedAt: NOW },
    { sessionId: 'b', title: 'B', priority: 2, updatedAt: NOW },
  ]
  const out = markedRows(items, { now: NOW, exclude: new Set(['a']) })
  assert.deepEqual(out.rows.map((r) => r.sessionId), ['b'])
})

test('已标记：脏行容错，limit 截断保留 total', () => {
  assert.equal(QA_SECTION_LIMIT, 6, '已标记区仍为 6 行（放宽的只有最近活跃）')
  assert.deepEqual(markedRows(null).rows, [])
  assert.deepEqual(markedRows([null, {}, { sessionId: 'x' }]).rows, [])
  const items = []
  for (let i = 0; i < 9; i += 1) items.push({ sessionId: 's' + i, starred: true, updatedAt: NOW - i * MIN })
  const { rows, total } = markedRows(items, { now: NOW, limit: 2 })
  assert.equal(rows.length, 2)
  assert.equal(total, 9)
})

// v0.5.1：次级区数据源修正。宿主列表项在 SessionHandle 世代**没有 updatedAt**
// （真机实测 455 项 withUpdatedAt=0；根因 src/index.js:593 提前 return，永不填
// mtimeById），时间戳只能来自客户端会话商店（uiSession.sessions.list 快照，行字段
// {id,displayTitle,title,blank,updatedAt}）。mergeActivityItems 负责把
// 「商店行（时间 + 标题）」与「宿主载荷（标注字段 / 工作区）」合成次级区条目。
test('合成：商店行给时间与标题，宿主载荷给标注字段', () => {
  const store = [
    { id: 'a', displayTitle: '商店标题 A', updatedAt: NOW - MIN },
    { id: 'b', title: '商店标题 B', updatedAt: NOW - 2 * MIN },
  ]
  const meta = new Map([
    ['a', { title: '宿主标题 A', workspaceTitle: 'WS', starred: true, priority: 1, review: true, tags: ['t1'] }],
  ])
  const out = mergeActivityItems(store, meta)
  assert.deepEqual(out.map((r) => r.sessionId), ['a', 'b'])
  assert.equal(out[0].title, '商店标题 A') // 商店标题优先（与核心侧栏一致）
  assert.equal(out[0].workspaceTitle, 'WS')
  assert.equal(out[0].starred, true)
  assert.equal(out[0].priority, 1)
  assert.equal(out[0].review, true)
  assert.equal(out[0].updatedAt, NOW - MIN)
  // b 没有宿主载荷 → 标注为空，标题仍来自商店，时间照常带出
  assert.equal(out[1].title, '商店标题 B')
  assert.equal(out[1].starred, undefined)
  assert.equal(out[1].updatedAt, NOW - 2 * MIN)
})

test('合成：blank / 无 id / 脏值容错，标题兜底到宿主', () => {
  const out = mergeActivityItems(
    [{ id: 'blank', blank: true, updatedAt: NOW }, { displayTitle: 'no id' }, null, { id: 'c' }],
    { c: { title: '宿主兜底' } },
  )
  assert.deepEqual(out.map((r) => r.sessionId), ['c'])
  assert.equal(out[0].title, '宿主兜底')
  assert.equal(out[0].updatedAt, undefined)
  // 非字符串标题（真机上出现过非预期类型）不写进 DOM；非数值时间等于没有时间
  const weird = mergeActivityItems([{ id: 'd', displayTitle: 42, updatedAt: 'soon' }], null)
  assert.equal(weird[0].title, '')
  assert.equal(weird[0].updatedAt, undefined)
  assert.deepEqual(mergeActivityItems(null, null), [])
})

test('合成：接入次级区——商店时间进最近活跃，宿主标记进已标记', () => {
  const store = [
    { id: 'fresh', displayTitle: '刚聊过', updatedAt: NOW - 3 * MIN },
    { id: 'old', displayTitle: '很久以前', updatedAt: NOW - 30 * 60 * MIN },
  ]
  const items = mergeActivityItems(store, { old: { starred: true, priority: 2 } })
  const recent = recentActiveRows(items, { now: NOW })
  assert.deepEqual(recent.rows.map((r) => r.sessionId), ['fresh'])
  const marked = markedRows(items, {
    now: NOW,
    exclude: new Set(recent.rows.map((r) => r.sessionId)),
  })
  assert.deepEqual(marked.rows.map((r) => r.sessionId), ['old'])
  assert.deepEqual(marked.rows[0].badges, ['★', 'P2'])
})

// v0.5.2：次级区折叠（用户反馈：最近活跃里会冒出子代理）。规则与关注区一致——
// 子代理不单独成行；但这两区是「数据列表」，所以合并的是时间与标记本身。
test('折叠：子代理归并到父会话，时间取最新、标记向上合并', () => {
  const items = [
    { sessionId: 'p', title: '父会话', updatedAt: NOW - 3 * HOUR },
    { sessionId: 'k1', title: '子代理一', updatedAt: NOW - MIN, starred: true },
    { sessionId: 'k2', title: '子代理二', updatedAt: NOW - 2 * HOUR, priority: 2, workspaceTitle: 'WS' },
  ]
  const lineage = new Map([
    ['p', { origin: 'main' }],
    ['k1', { origin: 'subagent', parentSession: 'p' }],
    ['k2', { origin: 'subagent', parentSession: 'p' }],
  ])
  const out = foldActivityItems(items, lineage, () => '')
  assert.deepEqual(out.map((r) => r.sessionId), ['p'], '子代理不再单独成行')
  assert.equal(out[0].title, '父会话')
  assert.equal(out[0].updatedAt, NOW - MIN, '时间取子树最新')
  assert.equal(out[0].subagentCount, 2)
  assert.equal(out[0].starred, true, '标记向上合并：★')
  assert.equal(out[0].priority, 2)
  assert.equal(out[0].workspaceTitle, 'WS', '工作区名从子行补上')
})

test('折叠：父会话不在列表时合成一行，多级子代理落到同一个父', () => {
  const items = [
    { sessionId: 'k', title: '子代理', updatedAt: NOW - MIN },
    { sessionId: 'gk', title: '孙代理', updatedAt: NOW - 2 * MIN },
  ]
  const lineage = new Map([
    ['k', { origin: 'subagent', parentSession: 'p' }],
    ['gk', { origin: 'subagent', parentSession: 'k' }],
  ])
  const out = foldActivityItems(items, lineage, (id) => (id === 'p' ? '父标题（血缘）' : ''))
  assert.deepEqual(out.map((r) => r.sessionId), ['p'])
  assert.equal(out[0].title, '父标题（血缘）', '合成父行用 titleOf 取标题')
  assert.equal(out[0].subagentCount, 2)
  assert.equal(out[0].updatedAt, NOW - MIN)
})

test('折叠：非子代理原样保留，缺血缘 / 成环 / 脏输入不炸', () => {
  assert.deepEqual(foldActivityItems(null, null, null), [])
  assert.deepEqual(foldActivityItems([], new Map(), null), [])
  const plain = [{ sessionId: 'a', title: 'A', updatedAt: NOW }, { sessionId: 'b', title: 'B' }]
  assert.deepEqual(
    foldActivityItems(plain, new Map(), null).map((r) => r.sessionId),
    ['a', 'b'],
    '没有血缘信息就不折叠',
  )
  // 成环（互相当父）：放弃折叠，两行都留在顶层，绝不丢会话
  const cyc = new Map([
    ['a', { origin: 'subagent', parentSession: 'b' }],
    ['b', { origin: 'subagent', parentSession: 'a' }],
  ])
  const out = foldActivityItems([{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }], cyc, null)
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((r) => r.sessionId), ['a', 'b'])
})

test('折叠接入次级区：只出现父行，子代理的标记随父行进已标记', () => {
  const items = [
    { sessionId: 'p', title: '父会话', updatedAt: NOW - MIN },
    { sessionId: 'k', title: '子代理', updatedAt: NOW - 10 * 1000, priority: 1 },
  ]
  const lineage = new Map([['k', { origin: 'subagent', parentSession: 'p' }]])
  const folded = foldActivityItems(items, lineage, () => '')
  const recent = recentActiveRows(folded, { now: NOW })
  assert.deepEqual(recent.rows.map((r) => r.sessionId), ['p'])
  assert.equal(recent.rows[0].subagentCount, 1, '子代理数透传到次级区行')
  const marked = markedRows(folded, { now: NOW, exclude: new Set(['p']) })
  assert.deepEqual(marked.rows, [], '父行被排除后，子代理自己不会再冒出来')
  const markedAll = markedRows(folded, { now: NOW })
  assert.deepEqual(markedAll.rows.map((r) => r.sessionId), ['p'])
  assert.deepEqual(markedAll.rows[0].badges, ['P1'])
  assert.equal(markedAll.rows[0].subagentCount, 1)
})
