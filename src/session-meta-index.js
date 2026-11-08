// Durable per-session metadata index (schema meta-v1): priority / note / review-later.
//
// Deliberately mirrors the star index in src/star-index.js: version field,
// per-entry defensive normalize (dirty data is dropped, never repaired by
// guessing), atomic write (tmp + rename at 0o600) and a single chained
// mutation queue so two concurrent requests can never clobber each other.
// Like stars/tags this is pure user metadata: it never touches a session.
// Validation discipline follows hkkz9522/dsh-session-manager's
// normalizeAnnotationPatch: REJECT invalid input instead of truncating it, so
// silent data loss is impossible (a too-long note is a 400, not a silent cut).
// Extracted from the host bundle so it can be unit-tested directly — pass
// `dir` to point the index at a temp directory.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 'meta-v1' (string, not a bare number) so this document can never be confused
// with the recycle bin's v1/v2, star v3 or tag v4 documents even if a file is
// copied between them.
export const META_SCHEMA_VERSION = 'meta-v1'

// Priority is 1 (highest) … 5 (lowest); absence in the entry means "unset".
// The client renders unset as 3 (Normal) — mirroring hkkz9522's null-to-3
// rule — but the STORE keeps the distinction: unset is not explicitly 3, so a
// future "sort by changed priority" is not fooled by normalized defaults.
export const MIN_PRIORITY = 1
export const MAX_PRIORITY = 5
export const MAX_NOTE = 2000

// Same state directory (and same env override) as the star/tag/saved-filter
// stores: all plugin-owned user marks live together in ~/.dsh/sessions-manager.
const DEFAULT_META_DIR = join(homedir(), '.dsh', 'sessions-manager')

function isSafeSessionId(value) {
  // Same predicate as star-index.js: reject separators (backslash, forward
  // slash) and the NUL byte (written as an escape so this file stays ASCII).
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\\/\x00]/.test(value) && value !== '.' && value !== '..'
}

function metaError(message, status, code) {
  const error = new Error(message)
  error.status = status
  if (code) error.code = code
  throw error
}

// Trim + validate one patch. Only keys actually PRESENT on the patch object
// are applied ("省略的键 = 保持不变"); the clear-values are the falsy ends of
// each field's range (priority: null, note: '', review: false). Invalid values
// are rejected with 400 DSM_META_INVALID — never coerced, never truncated.
export function normalizeMetaPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    metaError('patch 必须是对象', 400, 'DSM_META_INVALID')
  }
  const out = {}
  let keys = 0
  if ('priority' in patch) {
    keys++
    const p = patch.priority
    if (p !== null && !Number.isInteger(p)) metaError('priority 必须是 1-5 的整数或 null', 400, 'DSM_META_INVALID')
    if (p !== null && (p < MIN_PRIORITY || p > MAX_PRIORITY)) metaError(`priority 必须在 ${MIN_PRIORITY}-${MAX_PRIORITY} 之间`, 400, 'DSM_META_INVALID')
    out.priority = p
  }
  if ('note' in patch) {
    keys++
    const n = patch.note
    if (typeof n !== 'string') metaError('note 必须是字符串', 400, 'DSM_META_INVALID')
    // Array.from counts code points: one CJK char (or surrogate pair) is 1,
    // so the 2000 limit is honest for Chinese notes.
    if (Array.from(n.trim()).length > MAX_NOTE) metaError(`备注过长（上限 ${MAX_NOTE} 字符）`, 400, 'DSM_META_INVALID')
    out.note = n.trim()
  }
  if ('review' in patch) {
    keys++
    if (typeof patch.review !== 'boolean') metaError('review 必须是布尔值', 400, 'DSM_META_INVALID')
    out.review = patch.review
  }
  if (keys === 0) metaError('patch 为空（至少提供一个字段）', 400, 'DSM_META_INVALID')
  return out
}

// Apply one normalized patch to a single entry object; delete the entry
// entirely when every field ends up cleared (no tombstones in the store).
function applyPatchToEntry(entry, patch) {
  const next = { ...entry }
  if ('priority' in patch) {
    if (patch.priority === null) delete next.priority
    else next.priority = patch.priority
  }
  if ('note' in patch) {
    if (patch.note === '') delete next.note
    else next.note = patch.note
  }
  if ('review' in patch) {
    if (patch.review === false) delete next.review
    else next.review = true
  }
  return next
}

/**
 * Coerce anything on disk (or nothing at all) into a valid meta-v1 store.
 * Every entry is defended individually: a bad field is dropped, an entry with
 * no surviving fields is dropped entirely.
 */
export function normalizeSessionMetaStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const rawEntries = source && source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
    ? source.entries
    : null
  const entries = {}
  if (rawEntries) {
    for (const [sid, value] of Object.entries(rawEntries)) {
      if (!isSafeSessionId(sid) || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = {}
      if (Number.isInteger(value.priority) && value.priority >= MIN_PRIORITY && value.priority <= MAX_PRIORITY) entry.priority = value.priority
      if (typeof value.note === 'string' && value.note && Array.from(value.note).length <= MAX_NOTE) entry.note = value.note
      if (value.review === true) entry.review = true
      if (Object.keys(entry).length) entries[sid] = entry
    }
  }
  return { schemaVersion: META_SCHEMA_VERSION, entries }
}

/**
 * Open the session-meta index.
 * @param {object} [options]
 * @param {string} [options.dir] - Directory holding the index (tests inject a temp dir).
 * @param {string} [options.indexPath] - Full index path, overriding `dir`.
 */
export function createSessionMetaIndex(options = {}) {
  const dir = options.dir || process.env.DSH_SESSIONS_MANAGER_STAR_DIR || DEFAULT_META_DIR
  const indexPath = options.indexPath || join(dir, 'session-meta.json')
  let mutation = Promise.resolve()

  async function read() {
    try {
      return normalizeSessionMetaStore(JSON.parse(readFileSync(indexPath, 'utf8')))
    } catch {
      return normalizeSessionMetaStore(null)
    }
  }

  async function write(store) {
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.meta-${process.pid}-${Date.now()}.tmp`)
    await writeFile(tmp, JSON.stringify(normalizeSessionMetaStore(store), null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, indexPath)
  }

  // Serialize read-modify-write cycles (same discipline as star/tag indexes):
  // every mutator sees the store as left by the previous one; a rejected
  // mutator still keeps the chain alive (and writes nothing — validation
  // throws before `write` is reached).
  function mutate(mutator) {
    const operation = mutation.then(async () => {
      const store = await read()
      const result = await mutator(store)
      await write(store)
      return result
    })
    mutation = operation.catch(() => {})
    return operation
  }

  /**
   * Apply one patch to many sessions ("省略的键 = 保持不变" semantics).
   * @param {string[]} ids
   * @param {object} patch - { priority?, note?, review? } as raw user input.
   * @returns {Promise<{updated: string[]}>}
   * @throws 400 DSM_META_INVALID | 400 DSM_META_SESSION_INVALID
   */
  async function setMeta(ids, patch) {
    const normalized = normalizeMetaPatch(patch)
    const wanted = (Array.isArray(ids) ? ids : []).filter(isSafeSessionId).map(String)
    if (!wanted.length) metaError('缺少有效的 sessionId', 400, 'DSM_META_SESSION_INVALID')
    return mutate((store) => {
      for (const id of wanted) {
        const next = applyPatchToEntry(store.entries[id] || {}, normalized)
        if (Object.keys(next).length) store.entries[id] = next
        else delete store.entries[id]
      }
      return { updated: wanted }
    })
  }

  // Drop entries once their session is gone (purged / deleted), otherwise the
  // index would grow forever with ids that can never be listed again.
  function removeIds(ids) {
    const wanted = (Array.isArray(ids) ? ids : []).filter(isSafeSessionId)
    return mutate((store) => {
      for (const sid of wanted) delete store.entries[sid]
      return store.entries
    })
  }

  return { read, write, mutate, setMeta, removeIds, indexPath, dir }
}
