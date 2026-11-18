// tests/debug-log.test.js —— debug.log 轮转与上限（v0.7.0）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendDebugLog,
  debugLogPath,
  formatDebugLines,
  normalizeDebugLines,
  rotatedDebugLogPath,
  rotateDebugLog,
  shouldRotate,
  DEBUG_LOG_KEEP,
  DEBUG_LOG_MAX_BYTES,
  DEBUG_LOG_MAX_LINE_CHARS,
  DEBUG_LOG_MAX_LINES,
} from '../src/debug-log.js'

async function tempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `dsm-dbglog-${label}-`))
  return dir
}

async function exists(p) {
  return stat(p).then(() => true).catch(() => false)
}

test('formatDebugLines prefixes an ISO stamp and normalises newlines', () => {
  const text = formatDebugLines(['a\nb', 'c\r\nd'], new Date('2026-11-18T00:00:00.000Z'))
  assert.equal(text, '[2026-11-18T00:00:00.000Z] a\\nb\n[2026-11-18T00:00:00.000Z] c\\nd\n')
  assert.equal(formatDebugLines([]), '')
  assert.equal(formatDebugLines(null), '')
})

test('formatDebugLines truncates an oversized single line and marks the loss', () => {
  const long = 'x'.repeat(DEBUG_LOG_MAX_LINE_CHARS + 25)
  const text = formatDebugLines([long], 'T')
  const body = text.slice('[T] '.length).trimEnd()
  assert.ok(body.startsWith('x'.repeat(DEBUG_LOG_MAX_LINE_CHARS)))
  assert.ok(body.endsWith('…(+25ch)'))
})

test('normalizeDebugLines caps the count, stringifies, never throws', () => {
  const many = Array.from({ length: DEBUG_LOG_MAX_LINES + 10 }, (_, i) => `l${i}`)
  assert.equal(normalizeDebugLines({ lines: many }).length, DEBUG_LOG_MAX_LINES)
  assert.deepEqual(normalizeDebugLines({ lines: [1, null, 'x'] }), ['1', '', 'x'])
  // 非数组 / 缺 body 一律空，不抛。
  assert.deepEqual(normalizeDebugLines(undefined), [])
  assert.deepEqual(normalizeDebugLines({ lines: 'not-an-array' }), [])
})

test('shouldRotate only when the existing file is non-empty and the write overflows', () => {
  assert.equal(shouldRotate(0, 100, 1000), false, 'first write must not create an empty .1')
  assert.equal(shouldRotate(100, 0, 1000), false)
  assert.equal(shouldRotate(900, 101, 1000), true)
  assert.equal(shouldRotate(900, 100, 1000), false, 'exactly at the cap is still fine')
  assert.equal(shouldRotate(500, 500, 0), false, 'a non-positive cap disables rotation')
  assert.equal(shouldRotate(NaN, 500, 1000), false)
})

test('rotateDebugLog shifts debug.log -> .1 and discards the oldest slot', async () => {
  const dir = await tempDir('rot')
  try {
    const file = debugLogPath(dir)
    await writeFile(file, 'current\n')
    await writeFile(rotatedDebugLogPath(file, 1), 'one\n')
    await writeFile(rotatedDebugLogPath(file, 2), 'two\n')
    const ok = await rotateDebugLog(file, 3)
    assert.equal(ok, true)
    assert.equal(await readFile(rotatedDebugLogPath(file, 1), 'utf8'), 'current\n')
    assert.equal(await readFile(rotatedDebugLogPath(file, 2), 'utf8'), 'one\n')
    assert.equal(await readFile(rotatedDebugLogPath(file, 3), 'utf8'), 'two\n')
    assert.equal(await exists(file), false, 'the live file is moved away, not copied')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotateDebugLog drops the oldest generation when keep is reached', async () => {
  const dir = await tempDir('keep')
  try {
    const file = debugLogPath(dir)
    await writeFile(file, 'current\n')
    for (let i = 1; i <= 3; i += 1) await writeFile(rotatedDebugLogPath(file, i), `gen${i}\n`)
    await rotateDebugLog(file, 3)
    assert.equal(await readFile(rotatedDebugLogPath(file, 1), 'utf8'), 'current\n')
    assert.equal(await readFile(rotatedDebugLogPath(file, 2), 'utf8'), 'gen1\n')
    assert.equal(await readFile(rotatedDebugLogPath(file, 3), 'utf8'), 'gen2\n')
    // gen3 被删掉：只有 4 个文件（现役已移走 + 3 份历史）。
    assert.equal((await readdir(dir)).filter((n) => n.startsWith('debug.log')).length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotateDebugLog tolerates a missing live file (first ever write)', async () => {
  const dir = await tempDir('fresh')
  try {
    const file = debugLogPath(dir)
    assert.equal(await rotateDebugLog(file, 2), true)
    assert.equal(await exists(rotatedDebugLogPath(file, 1)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendDebugLog creates the directory and appends one line per entry', async () => {
  const dir = await tempDir('append')
  const nested = join(dir, 'nested', 'state')
  try {
    const out = await appendDebugLog(nested, ['a', 'b'], { now: 'T' })
    assert.equal(out.rotated, false)
    const text = await readFile(debugLogPath(nested), 'utf8')
    assert.equal(text, '[T] a\n[T] b\n')
    assert.equal(out.bytes, Buffer.byteLength('[T] a\n[T] b\n', 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendDebugLog rotates before the write that would overflow maxBytes', async () => {
  const dir = await tempDir('overflow')
  try {
    const file = debugLogPath(dir)
    await writeFile(file, 'x'.repeat(120))
    const out = await appendDebugLog(dir, ['y'.repeat(120)], { maxBytes: 200, keep: 2, now: 'T' })
    assert.equal(out.rotated, true)
    assert.equal((await readFile(rotatedDebugLogPath(file, 1), 'utf8')).length, 120)
    assert.equal(await readFile(file, 'utf8'), `[T] ${'y'.repeat(120)}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendDebugLog keeps appending while under the cap', async () => {
  const dir = await tempDir('under')
  try {
    const file = debugLogPath(dir)
    await writeFile(file, 'x'.repeat(50))
    const out = await appendDebugLog(dir, ['ok'], { maxBytes: 200, keep: 2, now: 'T' })
    assert.equal(out.rotated, false)
    assert.equal(await exists(rotatedDebugLogPath(file, 1)), false)
    assert.ok((await readFile(file, 'utf8')).endsWith('[T] ok\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('appendDebugLog with no lines writes nothing at all', async () => {
  const dir = await tempDir('empty')
  try {
    const out = await appendDebugLog(dir, [], { now: 'T' })
    assert.equal(out.bytes, 0)
    assert.equal(await exists(debugLogPath(dir)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the defaults leave a bounded footprint', () => {
  // 4 MiB × (1 现役 + 3 历史) = 16 MiB；这条断言防的是有人把 MAX_BYTES 改成 Infinity。
  assert.equal(DEBUG_LOG_MAX_BYTES, 4 * 1024 * 1024)
  assert.equal(DEBUG_LOG_KEEP, 3)
  assert.ok(DEBUG_LOG_MAX_BYTES * (DEBUG_LOG_KEEP + 1) <= 16 * 1024 * 1024)
})
