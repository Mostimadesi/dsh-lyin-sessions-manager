import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionMetaIndex, normalizeSessionMetaStore, normalizeMetaPatch, META_SCHEMA_VERSION, MAX_NOTE } from '../src/session-meta-index.js'

async function tempIndex() {
  const dir = await mkdtemp(join(tmpdir(), 'dsm-meta-'))
  return { index: createSessionMetaIndex({ dir }), dir, file: join(dir, 'session-meta.json') }
}

// ---- normalizeSessionMetaStore -------------------------------------------

test('normalizeSessionMetaStore fabricates a valid store from nothing', () => {
  assert.deepEqual(normalizeSessionMetaStore(null), { schemaVersion: META_SCHEMA_VERSION, entries: {} })
  assert.deepEqual(normalizeSessionMetaStore(undefined), { schemaVersion: META_SCHEMA_VERSION, entries: {} })
  assert.deepEqual(normalizeSessionMetaStore({ junk: 1 }), { schemaVersion: META_SCHEMA_VERSION, entries: {} })
  assert.deepEqual(normalizeSessionMetaStore([]), { schemaVersion: META_SCHEMA_VERSION, entries: {} })
})

test('normalizeSessionMetaStore drops unsafe ids, bad fields and empty entries', () => {
  const store = normalizeSessionMetaStore({
    schemaVersion: 'meta-v1',
    entries: {
      'good-1': { priority: 2, note: '备注', review: true },
      'bad/../id': { priority: 1 },
      '.': { priority: 1 },
      '..': { priority: 1 },
      42: { priority: 1 },
      'junk-fields': { priority: 9, note: 123, review: 'yes' },
      'partial-junk': { priority: 4, note: 42, review: 'no' },
      'empty-after-drop': { priority: 0 },
    },
  })
  assert.deepEqual(store.entries['good-1'], { priority: 2, note: '备注', review: true })
  assert.equal(store.entries['bad/../id'], undefined)
  assert.equal(store.entries['.'], undefined)
  assert.equal(store.entries['..'], undefined)
  // A numeric-looking STRING id ("42") is a legitimate session id.
  assert.deepEqual(store.entries['42'], { priority: 1 })
  assert.equal(store.entries['junk-fields'], undefined)
  assert.deepEqual(store.entries['partial-junk'], { priority: 4 })
  assert.equal(store.entries['empty-after-drop'], undefined)
})

// ---- read / write round-trip ----------------------------------------------

test('read returns an empty store when the file is absent', async () => {
  const { index } = await tempIndex()
  assert.deepEqual(await index.read(), { schemaVersion: META_SCHEMA_VERSION, entries: {} })
})

test('setMeta then read round-trips and leaves no temp files', async () => {
  const { index, dir } = await tempIndex()
  await index.setMeta(['s1', 's2'], { priority: 1, note: '重要', review: true })
  const store = await index.read()
  assert.deepEqual(store.entries.s1, { priority: 1, note: '重要', review: true })
  assert.deepEqual(store.entries.s2, { priority: 1, note: '重要', review: true })
  const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

// ---- patch semantics -------------------------------------------------------

test('omitted keys are preserved; falsy ends clear their field', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['s1'], { priority: 2, note: 'keep me', review: true })
  // Only review changes: priority and note must survive.
  await index.setMeta(['s1'], { review: false })
  assert.deepEqual((await index.read()).entries.s1, { priority: 2, note: 'keep me' })
  // priority: null clears only priority.
  await index.setMeta(['s1'], { priority: null })
  assert.deepEqual((await index.read()).entries.s1, { note: 'keep me' })
  // note: '' clears only note; the entry is fully gone afterwards.
  await index.setMeta(['s1'], { note: '' })
  assert.deepEqual((await index.read()).entries, {})
})

test('a fully cleared entry leaves no tombstone; re-set recreates it', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['s1'], { review: true })
  await index.setMeta(['s1'], { review: false })
  assert.deepEqual((await index.read()).entries, {})
  await index.setMeta(['s1'], { priority: 5 })
  assert.deepEqual((await index.read()).entries.s1, { priority: 5 })
})

test('setMeta applies one patch to many sessions', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['a', 'b', 'c'], { review: true })
  const store = await index.read()
  assert.equal(store.entries.a.review, true)
  assert.equal(store.entries.b.review, true)
  assert.equal(store.entries.c.review, true)
})

test('setMeta overwrites a previous note', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['s1'], { note: '第一版' })
  await index.setMeta(['s1'], { note: '第二版' })
  assert.deepEqual((await index.read()).entries.s1, { note: '第二版' })
})

// ---- validation rejects ----------------------------------------------------

test('invalid patches are rejected with 400 DSM_META_INVALID and write nothing', async () => {
  const { index, file } = await tempIndex()
  await index.setMeta(['s1'], { priority: 2 })
  const bad = [
    { patch: null },
    { patch: 'nope' },
    { patch: {} },
    { patch: { priority: 0 } },
    { patch: { priority: 6 } },
    { patch: { priority: 2.5 } },
    { patch: { priority: '1' } },
    { patch: { note: 42 } },
    { patch: { review: 'yes' } },
  ]
  for (const { patch } of bad) {
    await assert.rejects(
      () => index.setMeta(['s1'], patch),
      (e) => e.status === 400 && e.code === 'DSM_META_INVALID',
    )
  }
  // Nothing was written: the file still holds only the original priority 2.
  assert.deepEqual((await index.read()).entries.s1, { priority: 2 })
  assert.equal(await readFile(file, 'utf8').then(Boolean), true)
})

test('note limit counts code points, not UTF-16 units', async () => {
  const { index } = await tempIndex()
  // 2000 CJK chars = 2000 code points → accepted (each is 2 UTF-16 units).
  const okNote = '汉'.repeat(MAX_NOTE)
  await index.setMeta(['s1'], { note: okNote })
  // 2001 CJK chars = 2001 code points → rejected.
  await assert.rejects(
    () => index.setMeta(['s1'], { note: '汉'.repeat(MAX_NOTE + 1) }),
    (e) => e.status === 400 && e.code === 'DSM_META_INVALID',
  )
  assert.equal(Array.from((await index.read()).entries.s1.note).length, MAX_NOTE)
})

test('note is trimmed on save', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['s1'], { note: '  有空格  ' })
  assert.deepEqual((await index.read()).entries.s1, { note: '有空格' })
})

// ---- ids & GC --------------------------------------------------------------

test('unsafe or missing session ids are rejected', async () => {
  const { index } = await tempIndex()
  await assert.rejects(() => index.setMeta([], { review: true }), (e) => e.code === 'DSM_META_SESSION_INVALID')
  await assert.rejects(() => index.setMeta(['../escape'], { review: true }), (e) => e.code === 'DSM_META_SESSION_INVALID')
  await assert.rejects(() => index.setMeta('not-an-array', { review: true }), (e) => e.code === 'DSM_META_SESSION_INVALID')
})

test('removeIds drops the named entries only', async () => {
  const { index } = await tempIndex()
  await index.setMeta(['a', 'b'], { priority: 3 })
  await index.removeIds(['a', 'ghost'])
  const store = await index.read()
  assert.equal(store.entries.a, undefined)
  assert.deepEqual(store.entries.b, { priority: 3 })
})

test('normalizeMetaPatch returns only the present keys', () => {
  assert.deepEqual(normalizeMetaPatch({ priority: 3 }), { priority: 3 })
  assert.deepEqual(normalizeMetaPatch({ priority: null }), { priority: null })
  assert.deepEqual(normalizeMetaPatch({ note: '  x ' }), { note: 'x' })
  assert.deepEqual(normalizeMetaPatch({ review: true }), { review: true })
  assert.deepEqual(normalizeMetaPatch({ priority: 1, review: false }), { priority: 1, review: false })
})
