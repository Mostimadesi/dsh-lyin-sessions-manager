// Pure core of the workspace archive: path folding, store coercion and the
// derived predicates. No node: imports — the browser half bundles this file
// too, so the client and the host can never disagree about which workspace a
// record refers to.
//
// Kept separate from src/workspace-archive.js (which owns the file I/O) for the
// same reason src/client/logic.js exists: the interesting part must be testable
// and shareable without dragging a filesystem in.

// v1: the workspace archive is a new store, so it starts its own numbering.
// (Recycle bin uses v1/v2, the star index v3, auto-archive v4.)
export const WORKSPACE_ARCHIVE_SCHEMA_VERSION = 1

/**
 * Canonical comparison key for a workspace path.
 *
 * Hosts report the same workspace with different separators and casing
 * (`D:\a\b` vs `D:/a/b`, `C:\Users\X` vs `c:\users\x`), so the key folds both.
 * Returns '' for anything unusable — callers must treat '' as "no workspace"
 * and never archive it.
 */
export function workspaceKeyOf(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let key = trimmed.replace(/\\/g, '/')
  // Collapse duplicate separators but keep a UNC prefix ("//server/share").
  const unc = key.startsWith('//')
  key = key.replace(/\/{2,}/g, '/')
  if (unc) key = '/' + key
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  return key.toLowerCase()
}

function normalizeTitle(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
}

// Unusable timestamps become 0, never "now": reading the file must be a pure
// function of its bytes, otherwise every read would reshuffle the list order.
// The writer stamps Date.now() explicitly when a record is created.
function normalizeArchivedAt(raw) {
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Coerce one record. Used by the writer so a stale field can never leak onto
 * disk, and by the reader through normalizeWorkspaceArchiveStore below.
 */
export function normalizeWorkspaceArchiveRecord(record) {
  const it = record && typeof record === 'object' && !Array.isArray(record) ? record : {}
  const key = workspaceKeyOf(it.key || it.path)
  if (!key) return null
  return {
    key,
    path: typeof it.path === 'string' && it.path.trim() ? it.path.trim() : key,
    title: normalizeTitle(it.title),
    archivedAt: normalizeArchivedAt(it.archivedAt),
  }
}

/**
 * Coerce anything on disk (or nothing at all) into a valid v1 store.
 *
 * Entries with an unusable path are dropped instead of throwing: one corrupt
 * record must not make the whole archive unreadable, and a dropped record can
 * only ever reveal a workspace, never hide one.
 */
export function normalizeWorkspaceArchiveStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const records = source.archives && typeof source.archives === 'object' && !Array.isArray(source.archives)
    ? source.archives
    : {}
  const archives = {}
  for (const value of Object.values(records)) {
    const record = normalizeWorkspaceArchiveRecord(value)
    if (!record) continue
    archives[record.key] = record
  }
  return { schemaVersion: WORKSPACE_ARCHIVE_SCHEMA_VERSION, archives }
}

/** Every archived key, for `=== has` lookups in the client and the host. */
export function archivedWorkspaceKeys(store) {
  const archives = store && store.archives && typeof store.archives === 'object' ? store.archives : {}
  return Object.keys(archives)
}

/** Is this workspace path archived? Pure — accepts a raw store from disk. */
export function isWorkspaceArchived(store, rawPath) {
  const key = workspaceKeyOf(rawPath)
  if (!key) return false
  const archives = store && store.archives && typeof store.archives === 'object' ? store.archives : {}
  return Object.prototype.hasOwnProperty.call(archives, key)
}

/**
 * Which of these session items live in an archived workspace? Pure.
 *
 * Returns the items whose `workspacePath` is archived, in input order. An item
 * with no workspace is never matched (there is nothing to archive it under).
 */
export function pickArchivedWorkspaceItems(items, store) {
  const keys = new Set(archivedWorkspaceKeys(store))
  if (keys.size === 0) return []
  const list = Array.isArray(items) ? items : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const key = workspaceKeyOf(item.workspacePath)
    if (key && keys.has(key)) out.push(item)
  }
  return out
}

/**
 * Build a store-shaped object from the key list the host sends with each list
 * response, so the client can reuse the predicates without any file access.
 */
export function storeFromKeys(keys) {
  const archives = {}
  const list = Array.isArray(keys) ? keys : []
  for (const raw of list) {
    const key = workspaceKeyOf(raw)
    if (!key) continue
    archives[key] = { key, path: key, title: '', archivedAt: 0 }
  }
  return { schemaVersion: WORKSPACE_ARCHIVE_SCHEMA_VERSION, archives }
}

/**
 * Filter out items that belong to a folded workspace.
 *
 * Semantic A (visibility only): archiving a workspace never touches the
 * session's own archive flag, it just hides the whole workspace from the
 * sidebar group and the panel list. `peekPath` is the "I explicitly asked for
 * this workspace in the dropdown" escape hatch — without it, selecting an
 * archived workspace would render an empty list and look like data loss.
 *
 * Returns the input array unchanged (same reference) when nothing is folded, so
 * React memo dependencies stay stable on the common path.
 */
export function visibleItemsAfterWorkspaceFold(items, keys, peekPath = '') {
  const list = Array.isArray(items) ? items : []
  const folded = new Set()
  for (const raw of Array.isArray(keys) ? keys : []) {
    const key = workspaceKeyOf(raw)
    if (key) folded.add(key)
  }
  if (peekPath) folded.delete(workspaceKeyOf(peekPath))
  if (folded.size === 0) return list
  return list.filter((item) => item && typeof item === 'object' && !folded.has(workspaceKeyOf(item.workspacePath)))
}
