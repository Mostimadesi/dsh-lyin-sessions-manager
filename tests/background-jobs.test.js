import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_JOB_STATUSES,
  JOB_BADGE_MAX_ROWS,
  activeJobRows,
  collectBackgroundJobs,
  isActiveJob,
  jobBadgeText,
  jobDurationLabel,
  normalizeJobRow,
  sessionIdsOf,
} from '../src/background-jobs.js'

// ---- normalizeJobRow ------------------------------------------------------

test('normalizeJobRow: 保留 id/label/kind/status/startedAt', () => {
  const row = normalizeJobRow({ id: 'job-1', label: 'npm test', kind: 'bash', status: 'running', startedAt: 1700 })
  assert.deepEqual(row, { id: 'job-1', label: 'npm test', kind: 'bash', status: 'running', startedAt: 1700 })
})

test('normalizeJobRow: 没有 id 的一律丢弃', () => {
  assert.equal(normalizeJobRow(null), null)
  assert.equal(normalizeJobRow(undefined), null)
  assert.equal(normalizeJobRow('junk'), null)
  assert.equal(normalizeJobRow(42), null)
  assert.equal(normalizeJobRow([]), null)
  assert.equal(normalizeJobRow({}), null)
  assert.equal(normalizeJobRow({ id: '' }), null)
  assert.equal(normalizeJobRow({ id: '   ' }), null)
})

test('normalizeJobRow: label 空时回落 kind，再回落短 id（宁可显示 bash 也不显示空行）', () => {
  assert.equal(normalizeJobRow({ id: 'abc12345', kind: 'bash' }).label, 'bash')
  assert.equal(normalizeJobRow({ id: 'abcdefgh12345' }).label, 'abcdefgh')
  assert.equal(normalizeJobRow({ id: 'a', label: '  ', kind: '' }).label, 'a')
})

test('normalizeJobRow: startedAt 非法一律归零（不编时间）', () => {
  assert.equal(normalizeJobRow({ id: 'j' }).startedAt, 0)
  assert.equal(normalizeJobRow({ id: 'j', startedAt: 'not-a-number' }).startedAt, 0)
  assert.equal(normalizeJobRow({ id: 'j', startedAt: -5 }).startedAt, 0)
  assert.equal(normalizeJobRow({ id: 'j', startedAt: NaN }).startedAt, 0)
  // 数值字符串是宿主序列化后常见的形态，要认。
  assert.equal(normalizeJobRow({ id: 'j', startedAt: '1700' }).startedAt, 1700)
})

// ---- isActiveJob ----------------------------------------------------------

test('isActiveJob: 只有 running / stopping 算活', () => {
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['running', 'stopping'])
  for (const status of ['running', 'stopping']) assert.equal(isActiveJob({ status }), true)
  for (const status of ['succeeded', 'failed', 'cancelled', 'stopped', '', 'unknown']) {
    assert.equal(isActiveJob({ status }), false, status)
  }
})

test('isActiveJob: 脏输入与缺 status 一律不当活（避免假忙徽标永挂）', () => {
  assert.equal(isActiveJob(null), false)
  assert.equal(isActiveJob(undefined), false)
  assert.equal(isActiveJob('running'), false)
  assert.equal(isActiveJob({}), false)
})

// ---- activeJobRows --------------------------------------------------------

test('activeJobRows: 过滤终态、按 startedAt 升序（先起的在上）', () => {
  const rows = activeJobRows([
    { id: 'c', status: 'running', startedAt: 300 },
    { id: 'a', status: 'running', startedAt: 100 },
    { id: 'done', status: 'succeeded', startedAt: 50 },
    { id: 'b', status: 'stopping', startedAt: 200 },
  ])
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c'])
})

test('activeJobRows: 同一 id 只留第一条，脏条目跳过', () => {
  const rows = activeJobRows([
    null,
    'junk',
    { id: 'dup', status: 'running', startedAt: 100, label: 'first' },
    { id: 'dup', status: 'running', startedAt: 100, label: 'second' },
    { status: 'running' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'first')
})

test('activeJobRows: startedAt 相同时按 id 稳定排序（不随宿主顺序抖动）', () => {
  const a = activeJobRows([{ id: 'y', status: 'running', startedAt: 5 }, { id: 'x', status: 'running', startedAt: 5 }])
  const b = activeJobRows([{ id: 'x', status: 'running', startedAt: 5 }, { id: 'y', status: 'running', startedAt: 5 }])
  assert.deepEqual(a.map((r) => r.id), ['x', 'y'])
  assert.deepEqual(b.map((r) => r.id), ['x', 'y'])
})

test('activeJobRows: 非数组返回空', () => {
  for (const bad of [null, undefined, {}, 'x', 42]) assert.deepEqual(activeJobRows(bad), [])
})

// ---- sessionIdsOf ---------------------------------------------------------

test('sessionIdsOf: 取 agent.id 去重，跳过无 id 的条目', () => {
  assert.deepEqual(sessionIdsOf([{ id: 's1' }, { id: 's2' }, { id: 's1' }, null, {}, { id: '  ' }]), ['s1', 's2'])
  assert.deepEqual(sessionIdsOf(null), [])
  assert.deepEqual(sessionIdsOf('junk'), [])
})

// ---- collectBackgroundJobs ------------------------------------------------

test('collectBackgroundJobs: 枚举 live agent，只要本会话自己的活作业', () => {
  const agents = { list: () => [{ id: 's1' }, { id: 's2' }] }
  const jobs = {
    list: (sid) => {
      if (sid === 's1') {
        return [
          { id: 'j1', owner: 's1', status: 'running', startedAt: 10, label: 'build' },
          { id: 'j2', owner: 's1', status: 'succeeded', startedAt: 5 },
        ]
      }
      return [{ id: 'j3', owner: 's2', status: 'stopping', startedAt: 20 }]
    },
  }
  const map = collectBackgroundJobs(agents, jobs)
  assert.deepEqual(Object.keys(map).sort(), ['s1', 's2'])
  assert.deepEqual(map.s1.map((r) => r.id), ['j1'])
  assert.deepEqual(map.s2.map((r) => r.id), ['j3'])
})

test('collectBackgroundJobs: 过滤 owner 不匹配的条目（list 会把 unowned 一并回）', () => {
  const agents = { list: () => [{ id: 's1' }] }
  const jobs = {
    list: () => [
      { id: 'unowned', status: 'running', startedAt: 1 },
      { id: 'other', owner: 's9', status: 'running', startedAt: 1 },
      { id: 'mine', owner: 's1', status: 'running', startedAt: 1 },
    ],
  }
  const map = collectBackgroundJobs(agents, jobs)
  assert.deepEqual(map.s1.map((r) => r.id), ['mine'])
})

test('collectBackgroundJobs: 只有终态作业的会话不出现在结果里', () => {
  const agents = { list: () => [{ id: 's1' }] }
  const jobs = { list: () => [{ id: 'j', owner: 's1', status: 'failed', startedAt: 1 }] }
  assert.deepEqual(collectBackgroundJobs(agents, jobs), {})
})

test('collectBackgroundJobs: 服务缺失 / 方法不全 / 抛错 → 空对象，绝不抛给调用方', () => {
  const good = { list: () => [{ id: 's1' }] }
  assert.deepEqual(collectBackgroundJobs(null, good), {})
  assert.deepEqual(collectBackgroundJobs(undefined, good), {})
  assert.deepEqual(collectBackgroundJobs({}, good), {})
  assert.deepEqual(collectBackgroundJobs(good, null), {})
  assert.deepEqual(collectBackgroundJobs(good, {}), {})
  const throwingAgents = { list: () => { throw new Error('boom') } }
  assert.deepEqual(collectBackgroundJobs(throwingAgents, good), {})
})

test('collectBackgroundJobs: 单个会话查询失败不影响其它会话', () => {
  const agents = { list: () => [{ id: 'bad' }, { id: 'ok' }] }
  const jobs = {
    list: (sid) => {
      if (sid === 'bad') throw new Error('scoped layer gone')
      return [{ id: 'j', owner: 'ok', status: 'running', startedAt: 1 }]
    },
  }
  const map = collectBackgroundJobs(agents, jobs)
  assert.deepEqual(Object.keys(map), ['ok'])
})

// ---- jobDurationLabel -----------------------------------------------------

test('jobDurationLabel: 秒/分/时/天，只保留最高一级单位', () => {
  assert.equal(jobDurationLabel(0), '不足 1 秒')
  assert.equal(jobDurationLabel(999), '不足 1 秒')
  assert.equal(jobDurationLabel(1000), '1 秒')
  assert.equal(jobDurationLabel(59_000), '59 秒')
  assert.equal(jobDurationLabel(60_000), '1 分钟')
  assert.equal(jobDurationLabel(45 * 60_000), '45 分钟')
  // 90 分钟跨过小时门槛后只保留最高一级单位——侧栏一行放不下「1 小时 30 分钟」。
  assert.equal(jobDurationLabel(90 * 60_000), '1 小时')
  assert.equal(jobDurationLabel(60 * 60_000), '1 小时')
  assert.equal(jobDurationLabel(25 * 60 * 60_000), '1 天')
  assert.equal(jobDurationLabel(50 * 60 * 60_000), '2 天')
})

test('jobDurationLabel: 非法输入返回空串而不是 NaN 分钟', () => {
  for (const bad of [NaN, Infinity, -1, null, undefined, 'x']) assert.equal(jobDurationLabel(bad), '')
})

// ---- jobBadgeText ---------------------------------------------------------

test('jobBadgeText: 三角 + 条数，展开时朝下，0 条给空串（不占位）', () => {
  assert.equal(jobBadgeText(0, false), '')
  assert.equal(jobBadgeText(0, true), '')
  assert.equal(jobBadgeText(2, false), '▸ 2')
  assert.equal(jobBadgeText(2, true), '▾ 2')
  assert.equal(jobBadgeText(null, false), '')
  assert.equal(jobBadgeText('3', false), '▸ 3')
  assert.equal(jobBadgeText(-1, false), '')
})

test('JOB_BADGE_MAX_ROWS 是正整数（同步函数据此截断，0 会让展开区永远空）', () => {
  assert.equal(Number.isInteger(JOB_BADGE_MAX_ROWS), true)
  assert.ok(JOB_BADGE_MAX_ROWS > 0)
})
