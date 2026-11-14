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
    let v = stripInlineComment(m[1]).trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1)
    return v
  }
  return ''
}

// YAML 允许行尾注释（`key: true # 说明`）。不剥掉的话布尔解析会失败、
// 值退回默认，然后 setMode 把这行删掉——被"停用"的 skill 就悄悄复活了。
function stripInlineComment(value) {
  const v = String(value == null ? '' : value)
  let quote = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      if (i === 0 || /\s/.test(v[i - 1])) quote = c
      continue
    }
    // 只有前面是空白时 `#` 才算注释开始（`a#b` 是普通字符）
    if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i)
  }
  return v
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

  // 已经是目标态就原样返回：'on' 对「只写了 user-invocable: false」的 frontmatter
  // 也成立，若继续走重写循环会把这行删掉，等于偷偷改了用户的意图。
  if (modeOf(frontmatter) === mode) return text

  const wantModel = mode === 'clipboard' || mode === 'off'
  const wantUser = mode === 'off'

  // 沿用文件自己的换行符：CRLF 文件里只改几行，不能把整份文件变成混合换行。
  // splitSkillFile 是按 '\n' 切的，所以 CRLF 文件的行尾会留一个 '\r'。
  const eol = /\r$/.test(lines[0] || '') ? '\r\n' : '\n'
  const bare = (line) => line.replace(/\r$/, '')

  const kept = []
  let wroteModel = false
  let wroteUser = false
  for (const line of frontmatter) {
    const stripped = bare(line)
    if (new RegExp('^' + KEY_MODEL + ':').test(stripped)) {
      // 重复键只保留一处规范行，否则读（取第一个）与写（全都改）对不上。
      if (wantModel && !wroteModel) {
        kept.push(`${KEY_MODEL}: true`)
        wroteModel = true
      }
      continue
    }
    if (new RegExp('^' + KEY_USER + ':').test(stripped)) {
      if (wantUser && !wroteUser) {
        kept.push(`${KEY_USER}: false`)
        wroteUser = true
      }
      continue
    }
    kept.push(bare(line))
  }
  if (wantModel && !wroteModel) kept.push(`${KEY_MODEL}: true`)
  if (wantUser && !wroteUser) kept.push(`${KEY_USER}: false`)

  const head = lines.slice(0, 1).map(bare)
  const tail = lines.slice(closeIndex).map(bare)
  const out = [...head, ...kept, ...tail].join(eol)
  return out === text ? text : out
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
let tmpSeq = 0
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
  tmpSeq += 1
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpSeq}`
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
// 只允许改动「可写根」里的 skill（bundled 目录属于宿主包，改了下一次升级就被覆盖）。
function assertWritableDir(dir, rootsOpts = {}) {
  const abs = resolve(dir)
  const root = skillRoots(rootsOpts).find((r) => abs === r.path || abs.startsWith(r.path + sep))
  if (!root) throw new Error(`skill directory is outside every known skill root: ${dir}`)
  if (root.scope === 'bundled') throw new Error(`bundled skills are read-only: ${dir}`)
  return abs
}

export function setSkillMode(dir, mode, { expectName = '', cwd = process.cwd(), env = process.env, projectRoot = null } = {}) {
  if (!SKILL_MODE_LABEL[mode]) throw new Error(`unknown skill mode: ${mode}`)
  assertWritableDir(dir, { cwd, env, projectRoot })
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
// 我们自己写的备份（SKILL.md.bak-skill-…）与导入 staging 不算 skill 内容：
// 不排除的话每次导出都会把整段历史备份塞进 zip，导入回来还会多出一堆垃圾。
function isOurArtifact(name) {
  return name.includes('.bak-skill-') || name.startsWith('.import-')
}

export function collectSkillFiles(dir, { maxFiles = MAX_IMPORT_FILES, maxBytes = MAX_UNPACKED_BYTES } = {}) {
  const out = []
  let bytes = 0
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true })
    for (const e of entries) {
      if (SKIP_COPY_NAMES.has(e.name) || isOurArtifact(e.name)) continue
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
  const entries = readZip(buf, { maxTotalBytes: MAX_UNPACKED_BYTES }).filter((e) => !e.dir)

  const skillEntry = entries.find((e) => e.name === SKILL_FILE || e.name.endsWith('/' + SKILL_FILE))
  if (!skillEntry) throw new Error('archive has no SKILL.md')
  const prefix = skillEntry.name.slice(0, skillEntry.name.length - SKILL_FILE.length)
  const scoped = entries.filter((e) => e.name.startsWith(prefix))
  // 同名条目会「后写覆盖前写」：校验用的是 entries.find 找到的那份，
  // 落盘时却被同名条目顶掉 —— 等于校验和落地不是同一个文件。
  const seen = new Set()
  for (const e of scoped) {
    if (seen.has(e.name)) throw new Error(`duplicate archive entry: ${e.name}`)
    seen.add(e.name)
  }

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
    // 覆盖时把旧目录改名留着，而不是 rmSync：用户丢一个同名 zip 不该
    // 连带删掉目录里的历史备份与非 skill 文件。
    if (existsSync(dest)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 19)
      let retired = `${dest}.replaced-${stamp}`
      for (let i = 1; existsSync(retired) && i < 100; i++) retired = `${dest}.replaced-${stamp}-${i}`
      renameSync(dest, retired)
    }
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
// 删除 skill 目录。给了 trashDir 就**移进回收站**（可恢复），否则才真删。
// 为什么不能就地改名成 `<dir>.deleted-<stamp>`：那还留在 skills 根里，宿主下次
// 扫描会把它当成另一个同名 skill 重新列出来。所以回收站必须在根之外。
export function deleteSkillDir(dir, { cwd = process.cwd(), env = process.env, projectRoot = null, trashDir = null } = {}) {
  const abs = assertWritableDir(dir, { cwd, env, projectRoot })
  const skill = readSkillDir(abs)
  if (!skill) throw new Error('not a valid skill directory')
  const files = collectSkillFiles(abs).map((f) => f.name).sort()
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  let trashed = null
  if (trashDir) {
    mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 19)
    let target = join(trashDir, `${skill.name}-${stamp}`)
    for (let i = 1; existsSync(target) && i < 100; i++) target = join(trashDir, `${skill.name}-${stamp}-${i}`)
    renameSync(abs, target)
    trashed = target
  } else {
    rmSync(abs, { recursive: true, force: true })
  }
  return { name: skill.name, dir: abs, files: files.length, digest, trashed }
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
