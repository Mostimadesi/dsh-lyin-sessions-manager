// 上游落盘格式（schema）对照检查。
//
// 背景：本仓库是 TOBYCAI/dsh-sessions-manager 的个人分支，共用同一个
// STATE_DIR（~/.dsh/sessions-manager/）与同一批文件名。上游若把某份索引的
// schemaVersion 或字段语义改掉，本分支升级时会读到不兼容数据——而两边都
// 做「坏数据宽容」，症状是安静地丢记录，不是崩溃。所以这里把每个索引的
// 版本号钉成一张表，与 upstream 分支逐个比对。
//
// 用法：
//   node scripts/check-schema.mjs              # 对照 upstream/main
//   node scripts/check-schema.mjs origin/main  # 对照别的 ref
//   node scripts/check-schema.mjs --local      # 只核对本地（无上游也能跑）
//
// 退出码：0 = 一致；1 = 有漂移或本地表与源码不符。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const localOnly = args.includes('--local')
const upstreamRef = args.find((a) => !a.startsWith('--')) || 'upstream/main'

// 表里每一项就是一次「上游改了我就会读到陌生数据」的机会：
//   file     —— 落盘文件名（相对 STATE_DIR；<TRASH> 表示回收站子目录）
//   version  —— 期望的 schemaVersion（字符串或数字）
//   source   —— 版本常量的来源文件与常量名（本地源码扫描用）
//   upstream —— 上游是否有对应的同版本常量；null 表示本分支独有
const TABLE = [
  { file: 'star.json', version: 3, source: ['src/star-index.js', 'STAR_SCHEMA_VERSION'], upstream: true },
  { file: 'tags.json', version: 4, source: ['src/tag-index.js', 'TAG_SCHEMA_VERSION'], upstream: true },
  { file: 'saved-filters.json', version: 1, source: ['src/saved-filters.js', 'FILTER_SCHEMA_VERSION'], upstream: true },
  { file: 'auto-archive.json', version: 4, source: ['src/auto-archive.js', 'AUTO_ARCHIVE_SCHEMA_VERSION'], upstream: true },
  { file: 'pending-moves.json', version: 1, source: ['src/pending-moves.js', 'SCHEMA_VERSION'], upstream: true },
  { file: 'move-notices.json', version: 1, source: ['src/move-notices.js', 'SCHEMA_VERSION'], upstream: true },
  { file: 'empty-scan.json', version: 1, source: ['src/empty-scan-index.js', 'EMPTY_SCAN_SCHEMA_VERSION'], upstream: true },
  { file: 'title-index.json', version: 2, source: ['src/title-persist-index.js', 'TITLE_INDEX_SCHEMA_VERSION'], upstream: true },
  { file: 'session-meta.json', version: 'meta-v1', source: ['src/session-meta-index.js', 'META_SCHEMA_VERSION'], upstream: false },
  { file: '<TRASH>/index.json', version: 2, source: ['src/index.js', 'TRASH_SCHEMA_VERSION'], upstream: true },
  { file: 'workspace-archives.v1.json', version: 1, source: ['src/workspace-archive-core.js', 'WORKSPACE_ARCHIVE_SCHEMA_VERSION'], upstream: false },
]

function readLocal(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function readUpstream(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    return null
  }
}

function scanConstant(text, name) {
  // 只认 `const NAME = <字面量>` / `export const NAME = <字面量>`，避免误抓注释。
  const re = new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\\d+)`, 'm')
  const hit = text.match(re)
  if (!hit) return null
  const raw = hit[1]
  if (/^['"]/.test(raw)) return raw.slice(1, -1)
  return Number(raw)
}

const rows = []
let drift = 0

for (const entry of TABLE) {
  const [srcPath, constName] = entry.source
  const local = scanConstant(readLocal(srcPath), constName)
  const localOk = local === entry.version
  let upstreamValue = null
  let upstreamState = 'n/a'
  if (!localOnly) {
    const upstreamText = readUpstream(upstreamRef, srcPath)
    if (upstreamText === null) upstreamState = 'missing'
    else {
      upstreamValue = scanConstant(upstreamText, constName)
      upstreamState = upstreamValue === null ? 'no-const' : String(upstreamValue)
    }
  }
  // 本分支独有的索引没有上游对照物，不算漂移；上游真的缺文件才算漂移
  // （那意味着上游把这份索引删了/改文件名了，本分支下次 rebase 会读到孤儿文件）。
  // --local 模式完全不看上游，只能核对本地常量。
  let verdict
  if (!localOk) verdict = 'LOCAL-MISMATCH'
  else if (localOnly) verdict = 'local-only'
  else if (!entry.upstream) verdict = 'local-only'
  else if (upstreamState === 'missing') verdict = 'UPSTREAM-GONE'
  else if (upstreamValue !== entry.version) verdict = 'DRIFT'
  else verdict = 'same'
  if (verdict !== 'same' && verdict !== 'local-only') drift++
  rows.push({
    file: entry.file,
    expected: entry.version,
    local,
    localOk,
    upstream: localOnly ? '-' : entry.upstream ? upstreamState : '-',
    verdict,
  })
}

// 中文字符占两列，按显示宽度补空格，避免表格在终端里错位。
const width = (s) => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 127 ? 2 : 1), 0)
const pad = (v, n) => String(v) + ' '.repeat(Math.max(0, n - width(v)))
console.log(`schema 对照表（本地源码 vs ${localOnly ? '仅本地' : upstreamRef}）`)
console.log(`${pad('落盘文件', 28)}${pad('期望', 10)}${pad('本地', 10)}${pad('上游', 12)}结论`)
for (const r of rows) {
  console.log(`${pad(r.file, 28)}${pad(r.expected, 10)}${pad(r.local === null ? '(缺失)' : r.local, 10)}${pad(r.upstream, 12)}${r.verdict}`)
}

if (drift) {
  console.error(`\nschema 检查失败：${drift} 处不一致。`)
  console.error('本分支与上游共用 STATE_DIR 与文件名；上游版本号一变，升级后读到的就是陌生数据。')
  console.error('处理方式二选一：① 迁移本分支数据并升常量；② 在 HANDOFF §12 记录并显式兼容旧版本。')
  process.exit(1)
}
console.log('\nschema 检查通过：' + rows.length + ' 份索引' + (localOnly ? '的本地常量与对照表一致（未比对上游）。' : '与上游一致（标记 local-only 的为本分支独有）。'))
