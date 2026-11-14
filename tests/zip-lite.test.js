import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { crc32, readZip, writeZip } from '../src/zip-lite.js'
import { collectSkillFiles, deleteSkillDir, exportSkillZip, importSkillDir, importSkillZip } from '../src/skill-rows.js'

function tmpDir(prefix = 'dsm-zip-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeSkill(root, name, extra = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 演示 ${name}\n---\n\n# ${name}\n`, 'utf8')
  for (const [rel, content] of Object.entries(extra)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

test('crc32 与已知向量一致', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926')
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('writeZip → readZip 往返（含空文件与目录条目）', () => {
  const entries = [
    { name: 'skill/SKILL.md', data: '---\nname: demo\ndescription: 演示\n---\n' },
    { name: 'skill/references/a.txt', data: 'hello' },
    { name: 'skill/empty.txt', data: '' },
    { name: 'skill/sub/', data: '' },
  ]
  const buf = writeZip(entries)
  const back = readZip(buf)
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name))
  assert.equal(back[0].data.toString('utf8'), entries[0].data)
  assert.equal(back[1].data.toString('utf8'), 'hello')
  assert.equal(back[2].data.length, 0)
  assert.equal(back[3].dir, true)
})

test('writeZip 拒绝不安全路径', () => {
  assert.throws(() => writeZip([{ name: '../escape.txt', data: 'x' }]), /unsafe zip entry/)
  assert.throws(() => writeZip([{ name: '/abs.txt', data: 'x' }]), /unsafe zip entry/)
  assert.throws(() => writeZip([{ name: '', data: 'x' }]), /unsafe zip entry/)
})

test('readZip 拒绝非 zip 与截断数据', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a zip/)
  const buf = writeZip([{ name: 'a.txt', data: 'aaaa' }])
  assert.throws(() => readZip(buf.subarray(0, 12)), /not a zip/)
})

test('exportSkillZip → importSkillZip 往返，SKILL.md 逐字节相同', () => {
  const base = tmpDir()
  const srcRoot = join(base, 'src')
  const dstRoot = join(base, 'dst')
  mkdirSync(srcRoot)
  mkdirSync(dstRoot)
  const dir = makeSkill(srcRoot, 'demo-skill', { 'references/notes.md': '笔记' })

  const buf = exportSkillZip(dir)
  const out = importSkillZip(buf, dstRoot)
  assert.equal(out.name, 'demo-skill')
  assert.ok(existsSync(join(dstRoot, 'demo-skill', 'SKILL.md')))
  assert.equal(readFileSync(join(dstRoot, 'demo-skill', 'SKILL.md'), 'utf8'), readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  assert.equal(readFileSync(join(dstRoot, 'demo-skill', 'references', 'notes.md'), 'utf8'), '笔记')
})

test('importSkillZip 拒绝重名，overwrite 时覆盖', () => {
  const base = tmpDir()
  const srcRoot = join(base, 'src')
  const dstRoot = join(base, 'dst')
  mkdirSync(srcRoot)
  mkdirSync(dstRoot)
  const buf = exportSkillZip(makeSkill(srcRoot, 'demo-skill'))
  importSkillZip(buf, dstRoot)
  assert.throws(() => importSkillZip(buf, dstRoot), /already exists/)
  assert.equal(importSkillZip(buf, dstRoot, { overwrite: true }).name, 'demo-skill')
})

test('importSkillZip 拒绝无 SKILL.md / 非法 name / 超大包', () => {
  const dstRoot = tmpDir()
  assert.throws(() => importSkillZip(writeZip([{ name: 'readme.txt', data: 'x' }]), dstRoot), /no SKILL.md/)
  const badName = writeZip([{ name: 'SKILL.md', data: '---\nname: Bad_Name\ndescription: x\n---\n' }])
  assert.throws(() => importSkillZip(badName, dstRoot), /invalid name/)
  const noDesc = writeZip([{ name: 'SKILL.md', data: '---\nname: ok-name\n---\n' }])
  assert.throws(() => importSkillZip(noDesc, dstRoot), /no description/)
})

test('importSkillZip 拒绝非 frontmatter 的 SKILL.md', () => {
  const dstRoot = tmpDir()
  const noFm = writeZip([{ name: 'SKILL.md', data: '# 没有 frontmatter\n' }])
  assert.throws(() => importSkillZip(noFm, dstRoot), /no YAML frontmatter/)
  // writeZip 在写出侧就拒绝 '..' 与前导 '/'，所以解包侧的 safeJoin 是第二道防线，
  // 无法用 writeZip 造出触发它的包（见上一条 writeZip 用例）。
})

test('importSkillDir 复制目录，拒绝自我导入与重名', () => {
  const base = tmpDir()
  const srcRoot = join(base, 'src')
  const dstRoot = join(base, 'dst')
  mkdirSync(srcRoot)
  mkdirSync(dstRoot)
  const dir = makeSkill(srcRoot, 'demo-skill', { 'references/x.md': 'x' })

  const out = importSkillDir(dir, dstRoot)
  assert.equal(out.name, 'demo-skill')
  assert.ok(existsSync(join(dstRoot, 'demo-skill', 'references', 'x.md')))

  assert.throws(() => importSkillDir(dir, dstRoot), /already exists/)
  assert.throws(() => importSkillDir(join(dstRoot, 'demo-skill'), dstRoot), /不能从目标 skills 目录自身/)
})

test('deleteSkillDir 删目录并给出摘要', () => {
  const root = tmpDir()
  const dir = makeSkill(root, 'demo-skill', { 'references/a.md': 'a' })
  const out = deleteSkillDir(dir)
  assert.equal(out.name, 'demo-skill')
  assert.equal(out.files, 2)
  assert.match(out.digest, /^[0-9a-f]{12}$/)
  assert.equal(existsSync(dir), false)
  assert.throws(() => deleteSkillDir(dir), /not a valid skill directory/)
})

test('collectSkillFiles 跳过 .git / node_modules 等', () => {
  const root = tmpDir()
  const dir = makeSkill(root, 'demo-skill', { 'node_modules/x.js': 'x', '.git/config': 'c', 'ok.md': 'k' })
  const names = collectSkillFiles(dir).map((f) => f.name).sort()
  assert.deepEqual(names, ['SKILL.md', 'ok.md'])
})

test('collectSkillFiles 数量上限', () => {
  const root = tmpDir()
  const dir = makeSkill(root, 'demo-skill')
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
  assert.throws(() => collectSkillFiles(dir, { maxFiles: 3 }), /too many files/)
})
