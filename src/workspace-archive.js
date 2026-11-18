// Durable "archived workspaces" (schema v1) — visibility only.
//
// Archiving a workspace here does NOT touch any conversation's own archive
// state. It stores nothing but the workspace path, so the sidebar can drop the
// whole group and the panel can drop its rows; un-archiving gives everything
// back exactly as it was. That is a deliberate difference from the reference
// implementation (hkkz9522's dsh-session-manager), which archives every member
// conversation and therefore pollutes the "已归档" view with them.
//
// The pure part (path folding, coercion, predicates) lives in
// src/workspace-archive-core.js so the browser half can bundle it unchanged;
// this file owns only the file I/O. It deliberately mirrors src/auto-archive.js:
// explicit schema version, defensive coercion of whatever is on disk, atomic
// write (tmp + rename) and a single chained mutation queue.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_ARCHIVE_SCHEMA_VERSION,
  normalizeWorkspaceArchiveStore,
  normalizeWorkspaceArchiveRecord,
  workspaceKeyOf,
} from './workspace-archive-core.js'

const DEFAULT_DIR = join(homedir(), '.dsh', 'sessions-manager')

/**
 * Open the workspace archive store.
 * @param {object} [options]
 * @param {string} [options.dir] - Directory holding the index (tests inject a temp dir).
 * @param {string} [options.indexPath] - Full index path, overriding `dir`.
 */
export function createWorkspaceArchiveStore(options = {}) {
  // 目录优先级与仓库里其它 store 一致：显式参数 > 本 store 专属 env >
  // 共享状态目录 env（`DSH_SESSIONS_MANAGER_STAR_DIR`，测试用它把整批 store
  // 重定向到临时目录）> 真实的 `~/.dsh/sessions-manager`。
  // 少了第三级，测试会把索引写进用户真实的状态目录。
  const dir = options.dir || process.env.DSH_SESSIONS_MANAGER_WORKSPACE_ARCHIVE_DIR || process.env.DSH_SESSIONS_MANAGER_STAR_DIR || DEFAULT_DIR
  const indexPath = options.indexPath || join(dir, `workspace-archives.v${WORKSPACE_ARCHIVE_SCHEMA_VERSION}.json`)
  let mutation = Promise.resolve()

  async function read() {
    try {
      return normalizeWorkspaceArchiveStore(JSON.parse(readFileSync(indexPath, 'utf8')))
    } catch {
      return normalizeWorkspaceArchiveStore(null)
    }
  }

  async function write(store) {
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.workspace-archives-${process.pid}-${Date.now()}.tmp`)
    await writeFile(tmp, JSON.stringify(normalizeWorkspaceArchiveStore(store), null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, indexPath)
  }

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

  /** The whole archive as a plain list, newest first. */
  async function list() {
    const store = await read()
    return Object.values(store.archives).sort((a, b) => b.archivedAt - a.archivedAt)
  }

  /**
   * Archive one workspace. Idempotent: re-archiving keeps the original
   * `archivedAt` so the list does not reshuffle on a double click.
   * @param {string} rawPath
   * @param {{title?: string}} [meta]
   */
  function archive(rawPath, meta = {}) {
    const key = workspaceKeyOf(rawPath)
    if (!key) {
      const error = new Error('workspace path is empty')
      error.status = 400
      return Promise.reject(error)
    }
    return mutate((store) => {
      const existing = store.archives[key]
      store.archives[key] = normalizeWorkspaceArchiveRecord({
        key,
        path: rawPath,
        title: meta.title || (existing && existing.title) || '',
        // Re-archiving must not reshuffle the list on a double click.
        archivedAt: existing ? existing.archivedAt : Date.now(),
      })
      return store.archives[key]
    })
  }

  /** Un-archive one workspace. Returns true when a record was actually removed. */
  function unarchive(rawPath) {
    const key = workspaceKeyOf(rawPath)
    if (!key) return Promise.resolve(false)
    return mutate((store) => {
      if (!Object.prototype.hasOwnProperty.call(store.archives, key)) return false
      delete store.archives[key]
      return true
    })
  }

  /** Drop every record (the "全部恢复" button). Returns how many were removed. */
  function clear() {
    return mutate((store) => {
      const count = Object.keys(store.archives).length
      store.archives = {}
      return count
    })
  }

  return { read, write, mutate, list, archive, unarchive, clear, indexPath, dir }
}
