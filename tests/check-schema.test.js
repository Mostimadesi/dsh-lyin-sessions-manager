// check:schema 的自检。
//
// 这个脚本本身不写文件、只读源码 + git，但它是「上游改了落盘格式」的唯一
// 自动哨兵——哨兵自己失准比没有哨兵更危险。这里钉住三件事：
//  ① 表里每一行的版本常量都能在它指向的源码里真的扫到（防止改名后静默失效）；
//  ② 本地表与源码一致（--local 必须通过，不依赖网络或 upstream 分支）；
//  ③ 表覆盖了所有会落盘的索引文件名（新增 store 忘了登记就在这里红）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-schema.mjs')

function runScript(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
  }
}

test('check:schema 本地自洽（--local 必须通过）', () => {
  const r = runScript(['--local'])
  assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /schema 检查通过/)
})

test('check:schema 表里每一行都能扫到版本常量', () => {
  // 常量名写错 / 常量被改名时，扫描会静默返回 null，脚本照样报「通过」。
  // 这里反向确认：表里列出的每一份文件都在本地存在且能扫到非 null 值。
  const source = readFileSync(SCRIPT, 'utf8')
  const rows = [...source.matchAll(/\{ file: '([^']+)', version: ([^,]+), source: \['([^']+)', '([^']+)'\]/g)]
  assert.ok(rows.length >= 10, `期望至少 10 行对照，实际 ${rows.length}`)
  for (const [, file, , srcPath, constName] of rows) {
    const text = readFileSync(join(ROOT, srcPath), 'utf8')
    const re = new RegExp(`^\\s*(?:export\\s+)?const\\s+${constName}\\s*=`, 'm')
    assert.match(text, re, `${srcPath} 里找不到 const ${constName}（对照表 ${file} 这一行已失效）`)
  }
})

test('check:schema 的对照表覆盖所有落盘索引文件', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const listed = new Set([...source.matchAll(/file: '([^']+)'/g)].map((m) => m[1].replace(/^<TRASH>\//, '').replace(/\.v\d+\.json$/, '.json')))
  // 直接扫 src/ 里 `join(dir, 'xxx.json')` / `join(STATE_DIR, 'xxx.json')` 的默认文件名。
  const found = new Set()
  for (const name of readdirSync(join(ROOT, 'src'))) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(ROOT, 'src', name), 'utf8')
    for (const m of text.matchAll(/join\((?:dir|STATE_DIR),\s*'([a-z0-9.-]+\.json)'\)/g)) {
      found.add(m[1].replace(/\.v\d+\.json$/, '.json'))
    }
  }
  const missing = [...found].filter((f) => !listed.has(f))
  assert.deepEqual(missing, [], `这些落盘索引没登记到 check-schema 对照表：${missing.join(', ')}`)
})
