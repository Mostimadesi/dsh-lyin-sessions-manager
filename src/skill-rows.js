// skill-rows（v0.6.1）—— 扫描本机 skill 根、读 frontmatter、三态开关、导入导出。
//
// 设计边界（刻意的最小实现）：
//   * 不实现 skill 的执行/加载语义；宿主的 @deepseek-ai/dsh-skill-filesystem 负责扫描，
//     我们只改文件。改完由宿主的 chokidar 监听触发 invalidateCache()，
//     **下一次 agent step 即生效，不需要重启 DSH**。
//   * skill 在 cordis.patch.yml 里没有配置行，所以不能用 MCP 那种「注释配置行」的做法。
//     开关只落在 SKILL.md 的 frontmatter 两个布尔键上：
//       disable-model-invocation: true  → 模型看不到、也调不了
//       user-invocable: false           → 模型仍可见，但 /<name> 失效
//     两个都写 = 完全停用。旧键 modelInvocable 会被宿主报错拒绝，这里只写新键。
//   * 只处理「目录 + SKILL.md」形态（宿主的扁平 .md 形态可读不可开关，见 flatSkills）。
//   * 坏目录（无 SKILL.md、frontmatter 缺 name/description）静默跳过，不进列表。
//   * 文本手术：只在闭合 --- 之前插入/删除我们自己写的那几行，其余字节不动。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readZip, writeZip } from './zip-lite.js'

export const SKILL_FILE = 'SKILL.md'
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_BYTES = 512 * 1024
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
export const MAX_IMPORT_FILES = 400
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
export const SKIP_COPY_NAMES = new Set(['.', '..', '.system', '.git', 'node_modules', '__MACOSX', '.DS_Store', '.dsh'])

// 我们自己的三个状态。顺序即 UI 上的顺序。
export const SKILL_MODES = ['on', 'clipboard', 'off']
export const SKILL_MODE_LABEL = {
  on: '启用',
  clipboard: '仅 / 调用',
  off: '停用',
}

const KEY_MODEL = 'disable-model-invocation'
const KEY_USER = 'user-invocable'

// ── frontmatter 文本手术 ──────────────────────────────────────────────

/** 把 SKILL.md 拆成 { frontmatter: string[]|null, body: string[], closeIndex } */
export function splitSkillFile(text) {
  const lines = String(text ?? '').split('\n')
  if (lines.length === 0 || lines[0].replace(/\r$/, '') !== '---') return { lines, frontmatter: null, closeIndex: -1 }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') return { lines, frontmatter: lines.slice(1, i), closeIndex: i }
  }
  return { lines, frontmatter: null, closeIndex: -1 }
}

/** 极简 frontmatter 读取：只取顶层的 key: value（不引 YAML 库，保持零依赖）。 */
export function readFrontmatterField(frontmatter, key) {
  if (!Array.isArray(frontmatter)) return ''
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.*)$')
  for (const line of frontmatter) {
    const m = re.exec(line.replace(/\r$/, ''))
    if (!m) continue
    let v = m[1].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1)
    return v
  }
  return ''
}

function frontmatterBoolean(frontmatter, key) {
  const raw = readFrontmatterField(frontmatter, key)
  if (raw === '') return null
  const v = raw.toLowerCase()
  if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
  if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
  return null
}

/** 从 frontmatter 推出三态。 */
export function modeOf(frontmatter) {
  const noModel = frontmatterBoolean(frontmatter, KEY_MODEL)
  const noUser = frontmatterBoolean(frontmatter, KEY_USER)
  const modelInvocable = noModel !== true
  const userInvocable = noUser !== false
  if (!modelInvocable && !userInvocable) return 'off'
  if (!modelInvocable) return 'clipboard'
  // 只禁了 / 调用但模型可见 → 仍算启用（对我们来说"能用"）
  return 'on'
}

/**
 * 把 frontmatter 改写成目标三态。
 * on        → 两个键都删掉（回到默认）
 * clipboard → disable-model-invocation: true
 * off       → disable-model-invocation: true + user-invocable: false
 * 返回新文本；已是目标状态则原样返回（幂等，不产生 diff）。
 */
export function setMode(text, mode) {
  if (!SKILL_MODE_LABEL[mode]) throw new Error(`unknown skill mode: ${mode}`)
  const { lines, frontmatter, closeIndex } = splitSkillFile(text)
  if (!frontmatter) throw new Error('SKILL.md has no YAML frontmatter')

  const wantModel = mode === 'clipboard' || mode === 'off'
  const wantUser = mode === 'off'

  const kept = []
  let hadModel = false
  let hadUser = false
  for (const line of frontmatter) {
    const bare = line.replace(/\r$/, '')
    if (new RegExp('^' + KEY_MODEL + ':').test(bare)) {
      hadModel = true
      if (wantModel) kept.push(`${KEY_MODEL}: true`)
      continue
    }
    if (new RegExp('^' + KEY_USER + ':').test(bare)) {
      hadUser = true
      if (wantUser) kept.push(`${KEY_USER}: false`)
      continue
    }
    kept.push(line)
  }
  if (wantModel && !hadModel) kept.push(`${KEY_MODEL}: true`)
  if (wantUser && !hadUser) kept.push(`${KEY_USER}: false`)

  const head = lines.slice(0, 1)
  const tail = lines.slice(closeIndex)
  const next = [...head, ...kept, ...tail]
  const out = next.join('\n')
  if (out === text) return text
  return out
}

// ── 扫描 ──────────────────────────────────────────────────────────────

export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** 候选根。rank 越小越优先（同名 skill 取 rank 小的）。 */
export function skillRoots({ cwd = process.cwd(), env = process.env, home = homedir(), projectRoot = null } = {}) {
  const root = projectRoot || findProjectRoot(cwd)
  const out = []
  if (root) {
    out.push({ path: join(root, '.dsh', 'skills'), scope: 'project', label: '项目 .dsh/skills', rank: 10 })
    out.push({ path: join(root, '.agents', 'skills'), scope: 'project', label: '项目 .agents/skills', rank: 20 })
  }
  out.push({ path: join(dshHome(env), 'skills'), scope: 'user', label: '$DSH_HOME/skills', rank: 30 })
  out.push({ path: join(home, '.agents', 'skills'), scope: 'user', label: '~/.agents/skills', rank: 40 })
  const bundled = (env.DSH_BUNDLED_SKILL_DIR || '').trim()
  if (bundled) out.push({ path: bundled, scope: 'bundled', label: '内置 skills', rank: 600 })
  return out
}

export function findProjectRoot(start) {
  let dir = resolve(start || process.cwd())
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function isSafeRel(p) {
  if (typeof p !== 'string' || !p) return false
  if (isAbsolute(p)) return false
  const norm = p.replace(/\\/g, '/')
  if (norm.startsWith('/') || norm.includes('..')) return false
  return true
}

/** 读一个 skill 目录，失败返回 null（调用方静默跳过）。 */
export function readSkillDir(dir, { rootLabel = '', scope = '', rank = 999 } = {}) {
  const file = join(dir, SKILL_FILE)
  try {
    if (!statSync(dir).isDirectory()) return null
    if (!existsSync(file)) return null
    const st = statSync(file)
    if (st.size > MAX_SKILL_BYTES) return null
    const text = readFileSync(file, 'utf8')
    const { frontmatter } = splitSkillFile(text)
    if (!frontmatter) return null
    const name = readFrontmatterField(frontmatter, 'name')
    const description = readFrontmatterField(frontmatter, 'description')
    if (!name || !description) return null
    if (!SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME) return null
    return {
      name,
      description,
      whenToUse: readFrontmatterField(frontmatter, 'whenToUse') || '',
      dir,
      file,
      dirName: basename(dir),
      mode: modeOf(frontmatter),
      modelInvocable: frontmatterBoolean(frontmatter, KEY_MODEL) !== true,
      userInvocable: frontmatterBoolean(frontmatter, KEY_USER) !== false,
      scope,
      rootLabel,
      rank,
      writable: scope !== 'bundled',
      sizeBytes: st.size,
      mtime: st.mtimeMs,
    }
  } catch {
    return null
  }
}

/** 列出所有可用 skill（同名跨根去重：rank 小者胜出；被遮蔽的记在 shadowed 里）。 */
export function listSkills({ cwd = process.cwd(), env = process.env, home = homedir(), projectRoot = null } = {}) {
  const roots = skillRoots({ cwd, env, home, projectRoot })
  const found = []
  for (const r of roots) {
    if (!existsSync(r.path)) continue
    let entries
    try {
      entries = readdirSync(r.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (SKIP_COPY_NAMES.has(e.name)) continue
      if (!e.isDirectory()) continue
      const skill = readSkillDir(join(r.path, e.name), { rootLabel: r.label, scope: r.scope, rank: r.rank })
      if (skill) found.push(skill)
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  const byName = new Map()
  const shadowed = []
  for (const s of found) {
    if (byName.has(s.name)) {
      shadowed.push({ name: s.name, dir: s.dir, rootLabel: s.rootLabel, hiddenBy: byName.get(s.name).dir })
      continue
    }
    byName.set(s.name, s)
  }
  return { skills: [...byName.values()], shadowed, roots: roots.map((r) => ({ ...r, exists: existsSync(r.path) })) }
}

/**
 * 列出「坏目录」——有子目录但没有可用的 SKILL.md。
 * 用户要求这类目录静默丢弃（不显示在列表里），这里只作为诊断接口保留。
 */
export function listBrokenDirs({ cwd = process.cwd(), env = process.env, home = homedir(), projectRoot = null } = {}) {
  const roots = skillRoots({ cwd, env, home, projectRoot })
  const out = []
  for (const r of roots) {
    if (!existsSync(r.path)) continue
    let entries
    try {
      entries = readdirSync(r.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (SKIP_COPY_NAMES.has(e.name) || !e.isDirectory()) continue
      const dir = join(r.path, e.name)
      if (readSkillDir(dir, { rootLabel: r.label, scope: r.scope, rank: r.rank })) continue
      let reason = '缺少 SKILL.md'
      if (existsSync(join(dir, SKILL_FILE))) reason = 'frontmatter 缺失或 name/description 不合法'
      out.push({ dir, rootLabel: r.label, reason })
    }
  }
  return out
}

// ── 写 ────────────────────────────────────────────────────────────────

// 备份名带毫秒 + 冲突自增：同一秒内连续切两次（自动化/测试）不会撞车。
let backupSeq = 0
function backupOf(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 19)
  for (let i = 0; i < 100; i++) {
    const suffix = i === 0 ? `${stamp}` : `${stamp}-${i}`
    const candidate = `${file}.bak-skill-${suffix}`
    if (!existsSync(candidate)) return candidate
  }
  backupSeq += 1
  return `${file}.bak-skill-${stamp}-${process.pid}-${backupSeq}`
}

/** 原子写：先备份，再 tmp + rename。返回备份路径。 */
export function writeSkillFileAtomically(file, text) {
  const backup = backupOf(file)
  writeFileSync(backup, readFileSync(file), { flag: 'wx' })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw e
  }
  return backup
}

/** 切换一个 skill 的三态。no-op 时不写盘、不备份。 */
export function setSkillMode(dir, mode, { expectName = '' } = {}) {
  if (!SKILL_MODE_LABEL[mode]) throw new Error(`unknown skill mode: ${mode}`)
  const file = join(dir, SKILL_FILE)
  if (!existsSync(file)) throw new Error(`SKILL.md not found in ${dir}`)
  const text = readFileSync(file, 'utf8')
  const { frontmatter } = splitSkillFile(text)
  if (!frontmatter) throw new Error('SKILL.md has no YAML frontmatter')
  const name = readFrontmatterField(frontmatter, 'name')
  if (expectName && name !== expectName) {
    throw new Error(`skill name mismatch: expected ${expectName}, found ${name || '(empty)'}`)
  }
  const before = modeOf(frontmatter)
  const next = setMode(text, mode)
  if (next === text && before === mode) return { changed: false, mode, name, backup: null }
  const backup = writeSkillFileAtomically(file, next)
  const after = modeOf(splitSkillFile(next).frontmatter)
  return { changed: true, mode: after, name, backup }
}

// ── 导入 / 导出 ───────────────────────────────────────────────────────

/** 递归收集一个 skill 目录下的文件（相对路径 → Buffer），带体积与数量上限。 */
export function collectSkillFiles(dir, { maxFiles = MAX_IMPORT_FILES, maxBytes = MAX_UNPACKED_BYTES } = {}) {
  const out = []
  let bytes = 0
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true })
    for (const e of entries) {
      if (SKIP_COPY_NAMES.has(e.name)) continue
      const childAbs = join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!e.isFile()) continue
      const st = statSync(childAbs)
      bytes += st.size
      if (out.length >= maxFiles) throw new Error(`too many files (limit ${maxFiles})`)
      if (bytes > maxBytes) throw new Error(`unpacked size exceeds ${maxBytes} bytes`)
      out.push({ name: childRel, data: readFileSync(childAbs) })
    }
  }
  walk(dir, '')
  return out
}

/** 把一个 skill 目录打成 zip：<dirName>/SKILL.md + 其余文件。 */
export function exportSkillZip(dir, { dirName = basename(dir) } = {}) {
  const files = collectSkillFiles(dir)
  if (!files.some((f) => f.name === SKILL_FILE)) throw new Error(`SKILL.md not found at the top of ${dir}`)
  return writeZip(files.map((f) => ({ name: `${dirName}/${f.name}`, data: f.data })))
}

function safeJoin(base, rel) {
  const target = resolve(base, rel)
  const baseResolved = resolve(base)
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) {
    throw new Error(`unsafe archive entry: ${rel}`)
  }
  return target
}

/**
 * 从 zip 导入一个 skill 到 rootDir。
 * zip 里可以有一个顶层目录（skill 目录），也可以直接是 SKILL.md + 其它文件。
 */
export function importSkillZip(buf, rootDir, { overwrite = false } = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error('importSkillZip expects a Buffer')
  if (buf.length > MAX_ARCHIVE_BYTES) throw new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  const entries = readZip(buf).filter((e) => !e.dir)

  const skillEntry = entries.find((e) => e.name === SKILL_FILE || e.name.endsWith('/' + SKILL_FILE))
  if (!skillEntry) throw new Error('archive has no SKILL.md')
  const prefix = skillEntry.name.slice(0, skillEntry.name.length - SKILL_FILE.length)
  const scoped = entries.filter((e) => e.name.startsWith(prefix))

  const text = skillEntry.data.toString('utf8')
  const { frontmatter } = splitSkillFile(text)
  if (!frontmatter) throw new Error('SKILL.md in archive has no YAML frontmatter')
  const name = readFrontmatterField(frontmatter, 'name')
  if (!name || !SKILL_NAME_RE.test(name) || name.length > MAX_SKILL_NAME) {
    throw new Error(`archive SKILL.md has an invalid name: ${JSON.stringify(name)}`)
  }
  if (!readFrontmatterField(frontmatter, 'description')) {
    throw new Error('archive SKILL.md has no description')
  }

  const dest = join(rootDir, name)
  if (existsSync(dest) && !overwrite) throw new Error(`skill "${name}" already exists`)
  mkdirSync(rootDir, { recursive: true })
  const staging = join(rootDir, `.import-${name}-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(staging, { recursive: true })
    let bytes = 0
    for (const e of scoped) {
      const rel = e.name.slice(prefix.length)
      if (!isSafeRel(rel)) throw new Error(`unsafe archive entry: ${e.name}`)
      bytes += e.data.length
      if (bytes > MAX_UNPACKED_BYTES) throw new Error(`unpacked size exceeds ${MAX_UNPACKED_BYTES} bytes`)
      const target = safeJoin(staging, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, e.data)
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(staging, dest)
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {}
    throw e
  }
  const skill = readSkillDir(dest)
  return { name, dir: dest, skill }
}

/**
 * 从本机目录导入（复制 SKILL.md 所在目录）。
 * 拒绝从目标根自身（或其子目录）导入，避免自我复制。
 */
export function importSkillDir(srcDir, rootDir, { overwrite = false } = {}) {
  const src = resolve(srcDir)
  const srcResolved = (() => {
    try {
      return statSync(src).isDirectory() ? src : dirname(src)
    } catch {
      throw new Error(`source not found: ${srcDir}`)
    }
  })()
  const skill = readSkillDir(srcResolved)
  if (!skill) throw new Error('source directory is not a valid skill (SKILL.md with name + description)')
  const rootResolved = resolve(rootDir)
  if (srcResolved === rootResolved || srcResolved.startsWith(rootResolved + sep)) {
    throw new Error('不能从目标 skills 目录自身（或其子目录）导入，请换一个源目录')
  }
  const dest = join(rootResolved, skill.name)
  if (existsSync(dest) && !overwrite) throw new Error(`skill "${skill.name}" already exists`)
  const files = collectSkillFiles(srcResolved)
  const staging = join(rootResolved, `.import-${skill.name}-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(staging, { recursive: true })
    for (const f of files) {
      const target = safeJoin(staging, f.name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {}
    throw e
  }
  return { name: skill.name, dir: dest, skill: readSkillDir(dest) }
}

/** 删除一个 skill 目录（先做一次内容摘要，返回给调用方展示）。 */
export function deleteSkillDir(dir) {
  const abs = resolve(dir)
  const skill = readSkillDir(abs)
  if (!skill) throw new Error('not a valid skill directory')
  const files = collectSkillFiles(abs).map((f) => f.name).sort()
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  rmSync(abs, { recursive: true, force: true })
  return { name: skill.name, dir: abs, files: files.length, digest }
}

export default {
  SKILL_MODES,
  SKILL_MODE_LABEL,
  splitSkillFile,
  readFrontmatterField,
  modeOf,
  setMode,
  skillRoots,
  findProjectRoot,
  readSkillDir,
  listSkills,
  listBrokenDirs,
  setSkillMode,
  exportSkillZip,
  importSkillZip,
  importSkillDir,
  deleteSkillDir,
  collectSkillFiles,
}
