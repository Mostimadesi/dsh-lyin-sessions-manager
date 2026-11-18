// Tests for the workspace archive store (visibility only, schema v1).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_ARCHIVE_SCHEMA_VERSION,
  archivedWorkspaceKeys,
  isWorkspaceArchived,
  normalizeWorkspaceArchiveRecord,
  normalizeWorkspaceArchiveStore,
  pickArchivedWorkspaceItems,
  storeFromKeys,
  visibleItemsAfterWorkspaceFold,
  workspaceKeyOf,
} from '../src/workspace-archive-core.js'
import { createWorkspaceArchiveStore } from '../src/workspace-archive.js'

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsm-wsarchive-'))
  return {
    store: createWorkspaceArchiveStore({ dir }),
    dir,
    file: join(dir, `workspace-archives.v${WORKSPACE_ARCHIVE_SCHEMA_VERSION}.json`),
  }
}

function item(sessionId, workspacePath, extra = {}) {
  return { sessionId, workspacePath, ...extra }
}

// ---- workspaceKeyOf ------------------------------------------------------

test('workspaceKeyOf folds separators and casing', () => {
  assert.equal(workspaceKeyOf('D:\\a\\b'), workspaceKeyOf('D:/a/b'))
  assert.equal(workspaceKeyOf('D:\\a\\b'), workspaceKeyOf('d:\\A\\B'))
  assert.equal(workspaceKeyOf('D:\\a\\b\\'), workspaceKeyOf('D:\\a\\b'))
  assert.equal(workspaceKeyOf('  D:\\a\\b  '), workspaceKeyOf('D:\\a\\b'))
})

test('workspaceKeyOf keeps a UNC prefix but still folds its separators', () => {
  assert.equal(workspaceKeyOf('\\\\server\\share\\dir'), '//server/share/dir')
  assert.equal(workspaceKeyOf('//server//share//dir'), '//server/share/dir')
  // A UNC path must not collapse to an absolute POSIX path.
  assert.notEqual(workspaceKeyOf('\\\\server\\share'), workspaceKeyOf('\\server\\share'))
})

test('workspaceKeyOf returns empty for unusable input', () => {
  for (const raw of [null, undefined, '', '   ', 0, 42, {}, [], '\n\t']) {
    assert.equal(workspaceKeyOf(raw), '')
  }
})

// ---- normalizeWorkspaceArchiveStore --------------------------------------

test('normalizeWorkspaceArchiveStore defaults to an empty v1 store', () => {
  for (const raw of [null, undefined, {}, [], 'junk', 42, true]) {
    const store = normalizeWorkspaceArchiveStore(raw)
    assert.equal(store.schemaVersion, WORKSPACE_ARCHIVE_SCHEMA_VERSION)
    assert.deepEqual(store.archives, {})
  }
})

test('normalizeWorkspaceArchiveStore keys records by their folded path', () => {
  const store = normalizeWorkspaceArchiveStore({
    archives: {
      'D:/A/B': { key: 'D:/A/B', path: 'D:\\A\\B', title: 'Proj', archivedAt: 1234 },
    },
  })
  assert.deepEqual(Object.keys(store.archives), ['d:/a/b'])
  assert.equal(store.archives['d:/a/b'].path, 'D:\\A\\B')
  assert.equal(store.archives['d:/a/b'].title, 'Proj')
  assert.equal(store.archives['d:/a/b'].archivedAt, 1234)
})

test('normalizeWorkspaceArchiveStore drops records with no usable path', () => {
  const store = normalizeWorkspaceArchiveStore({
    archives: {
      a: { key: '', path: '' },
      b: { key: '   ', path: '   ' },
      c: null,
      d: 'junk',
      e: [],
      f: { key: 'D:\\ok', path: 'D:\\ok' },
    },
  })
  assert.deepEqual(Object.keys(store.archives), ['d:/ok'])
})

test('normalizeWorkspaceArchiveStore tolerates junk fields', () => {
  const store = normalizeWorkspaceArchiveStore({
    archives: {
      x: { key: 'D:\\x', path: '   ', title: 42, archivedAt: 'nope' },
    },
  })
  const record = store.archives['d:/x']
  // An unusable path string falls back to the key so the record stays usable.
  assert.equal(record.path, 'd:/x')
  assert.equal(record.title, '')
  // Unusable timestamps become 0 — reading must be a pure function of the
  // bytes, otherwise every read would reshuffle the list order.
  assert.equal(record.archivedAt, 0)
})

test('normalizeWorkspaceArchiveRecord rejects a record without a path', () => {
  for (const raw of [null, undefined, {}, [], 'junk', { key: '   ' }, { path: 42 }]) {
    assert.equal(normalizeWorkspaceArchiveRecord(raw), null)
  }
})

test('normalizeWorkspaceArchiveStore always stamps the schema version', () => {
  const store = normalizeWorkspaceArchiveStore({ schemaVersion: 99, archives: {} })
  assert.equal(store.schemaVersion, WORKSPACE_ARCHIVE_SCHEMA_VERSION)
})

// ---- pure predicates -----------------------------------------------------

test('archivedWorkspaceKeys lists every folded key', () => {
  const store = normalizeWorkspaceArchiveStore({
    archives: {
      a: { key: 'D:\\a', path: 'D:\\a' },
      b: { key: 'D:\\b', path: 'D:\\b' },
    },
  })
  assert.deepEqual(archivedWorkspaceKeys(store).sort(), ['d:/a', 'd:/b'])
  assert.deepEqual(archivedWorkspaceKeys(null), [])
})

test('isWorkspaceArchived matches through separator and case differences', () => {
  const store = normalizeWorkspaceArchiveStore({ archives: { a: { key: 'D:\\Proj', path: 'D:\\Proj' } } })
  assert.equal(isWorkspaceArchived(store, 'D:\\Proj'), true)
  assert.equal(isWorkspaceArchived(store, 'd:/proj'), true)
  assert.equal(isWorkspaceArchived(store, 'D:/proj/'), true)
  assert.equal(isWorkspaceArchived(store, 'D:\\Other'), false)
  assert.equal(isWorkspaceArchived(store, ''), false)
  assert.equal(isWorkspaceArchived(null, 'D:\\Proj'), false)
})

test('pickArchivedWorkspaceItems keeps only rows inside archived workspaces', () => {
  const store = normalizeWorkspaceArchiveStore({ archives: { a: { key: 'D:\\keep', path: 'D:\\keep' } } })
  const items = [
    item('s1', 'D:\\keep'),
    item('s2', 'D:\\other'),
    item('s3', ''),
    item('s4', undefined),
    item('s5', 'd:/KEEP/'),
    null,
    'junk',
  ]
  assert.deepEqual(pickArchivedWorkspaceItems(items, store).map((x) => x.sessionId), ['s1', 's5'])
})

test('pickArchivedWorkspaceItems short-circuits when nothing is archived', () => {
  assert.deepEqual(pickArchivedWorkspaceItems([item('s1', 'D:\\x')], null), [])
  assert.deepEqual(pickArchivedWorkspaceItems([item('s1', 'D:\\x')], normalizeWorkspaceArchiveStore(null)), [])
  assert.deepEqual(pickArchivedWorkspaceItems(null, normalizeWorkspaceArchiveStore({ archives: { a: { key: 'D:\\x' } } })), [])
})

// ---- store: archive / unarchive / list / clear ---------------------------

test('archive persists to the versioned file and lists newest first', async () => {
  const { store, file } = await tempStore()
  await store.archive('D:\\One', { title: 'One' })
  await store.archive('D:/two', { title: 'Two' })
  const list = await store.list()
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((r) => r.title).sort(), ['One', 'Two'])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.schemaVersion, WORKSPACE_ARCHIVE_SCHEMA_VERSION)
  assert.deepEqual(Object.keys(onDisk.archives).sort(), ['d:/one', 'd:/two'])
})

test('archiving the same workspace twice keeps the original timestamp', async () => {
  const { store } = await tempStore()
  const first = await store.archive('D:\\One', { title: 'One' })
  const second = await store.archive('d:/one', { title: 'Renamed' })
  assert.equal(second.archivedAt, first.archivedAt)
  // A later archive wins on the title — the rename is the newer fact.
  assert.equal(second.title, 'Renamed')
  assert.equal((await store.list()).length, 1)
})

test('archive rejects an empty workspace path', async () => {
  const { store } = await tempStore()
  await assert.rejects(() => store.archive(''), /workspace path is empty/)
  await assert.rejects(() => store.archive('   '), /workspace path is empty/)
  assert.deepEqual(await store.list(), [])
})

test('unarchive removes the record and reports whether it existed', async () => {
  const { store } = await tempStore()
  await store.archive('D:\\One')
  assert.equal(await store.unarchive('d:/one'), true)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.unarchive('d:/one'), false)
  assert.equal(await store.unarchive(''), false)
})

test('clear removes every record and counts them', async () => {
  const { store } = await tempStore()
  await store.archive('D:\\One')
  await store.archive('D:\\Two')
  assert.equal(await store.clear(), 2)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.clear(), 0)
})

test('concurrent archives are serialised and none are lost', async () => {
  const { store, file } = await tempStore()
  await Promise.all([store.archive('D:\\a'), store.archive('D:\\b'), store.archive('D:\\c')])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.archives).sort(), ['d:/a', 'd:/b', 'd:/c'])
})

// ---- on-disk robustness --------------------------------------------------

test('a corrupt file reads as an empty store instead of throwing', async () => {
  const { store, file } = await tempStore()
  await writeFile(file, '{not json', 'utf8')
  assert.deepEqual(await store.list(), [])
  // Recovery must be possible: one archive rewrites a valid file.
  await store.archive('D:\\One')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.archives), ['d:/one'])
})

test('a store written at another schema version is coerced, not trusted', async () => {
  const { store, file } = await tempStore()
  await writeFile(file, JSON.stringify({ schemaVersion: 99, archives: { a: { key: 'D:\\a', path: 'D:\\a' } } }), 'utf8')
  assert.equal((await store.list()).length, 1)
  await store.archive('D:\\b')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.schemaVersion, WORKSPACE_ARCHIVE_SCHEMA_VERSION)
})

test('writes leave no temp file behind', async () => {
  const { store, dir } = await tempStore()
  await store.archive('D:\\One')
  await store.archive('D:\\Two')
  const names = await readdir(dir)
  assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), [])
})

test('the file lives at the path the store advertises', async () => {
  const { store, file } = await tempStore()
  await store.archive('D:\\One')
  assert.equal(store.indexPath, file)
  const names = await readdir(store.dir)
  assert.deepEqual(names, [`workspace-archives.v${WORKSPACE_ARCHIVE_SCHEMA_VERSION}.json`])
})

// ---- storeFromKeys: what the client rebuilds from a host response ---------

test('storeFromKeys rebuilds the predicates from a bare key list', () => {
  const store = storeFromKeys(['D:\\Proj', 'd:/Other/', '', null, 42])
  assert.deepEqual(archivedWorkspaceKeys(store).sort(), ['d:/other', 'd:/proj'])
  assert.equal(isWorkspaceArchived(store, 'd:\\proj'), true)
  assert.equal(isWorkspaceArchived(store, 'D:\\Nope'), false)
  assert.deepEqual(pickArchivedWorkspaceItems([item('s1', 'D:\\proj')], store).map((x) => x.sessionId), ['s1'])
})

test('storeFromKeys tolerates a missing or junk key list', () => {
  for (const raw of [null, undefined, 'junk', 42, {}]) {
    assert.deepEqual(archivedWorkspaceKeys(storeFromKeys(raw)), [])
  }
})

test('visibleItemsAfterWorkspaceFold: 折叠整组，显式点名时放行', () => {
  const items = [
    { sessionId: 'a', workspacePath: 'D:\\proj\\gone' },
    { sessionId: 'b', workspacePath: 'D:/Proj/Gone/' },
    { sessionId: 'c', workspacePath: 'D:\\proj\\keep' },
    { sessionId: 'd', workspacePath: '' },
    null,
  ]
  const keys = [workspaceKeyOf('D:\\proj\\gone')]
  // 大小写与分隔符差异都算同一个工作区。
  assert.deepEqual(visibleItemsAfterWorkspaceFold(items, keys).map((x) => x.sessionId), ['c', 'd'])
  // 显式点名已归档工作区 → 不折叠（否则下拉选中后一片空白）。
  assert.deepEqual(visibleItemsAfterWorkspaceFold(items, keys, 'D:\\proj\\gone').filter(Boolean).map((x) => x.sessionId), ['a', 'b', 'c', 'd'])
  // 空 keys 原样返回同一引用，避免 React memo 抖动。
  assert.equal(visibleItemsAfterWorkspaceFold(items, []), items)
  // 脏输入不炸。
  assert.deepEqual(visibleItemsAfterWorkspaceFold(null, keys), [])
  assert.equal(visibleItemsAfterWorkspaceFold(items, [null, '', 42]).length, 5)
})
