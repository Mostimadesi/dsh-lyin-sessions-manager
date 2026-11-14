import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { crc32 } from '../src/zip-lite.js'
import {
  SKIP_COPY_NAMES as SKIP_COPY_NAMES,
  deleteSkillDir,
  importSkillZip,
  listBrokenDirs,
  listSkills,
  modeOf,
  readFrontmatterField,
  setMode,
  setSkillMode,
  splitSkillFile,
} from '../src/skill-rows.js'

const SKILL_OK = ['---', 'name: demo-skill', 'description: 一个演示用的 skill', '---', '', '# 正文', '内容一行', ''].join('\n')

// 手写一个 store（method 0，不压缩）的 zip：writeZip 会拒绝不安全名，
// 所以测读侧守卫只能自己拼字节。
function makeZipWithName(name, content) {
  return makeZip([[name, content]])
}

function makeZip(pairs) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of pairs) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    const chunk = Buffer.concat([local, nameBuf, data])
    locals.push(chunk)
    centrals.push(Buffer.concat([cen, nameBuf]))
    offset += chunk.length
  }
  const body = Buffer.concat(locals)
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(pairs.length, 8)
  eocd.writeUInt16LE(pairs.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, central, eocd])
}


function skillText(name) {
  return ['---', 'name: ' + name, 'description: 演示 ' + name, '---', '', '# 正文', '内容一行', ''].join('\n')
}

// 扫描根是 <projectRoot>/.dsh/skills，所以测试把 base 当 projectRoot。
function tmpRoot() {
  const base = mkdtempSync(join(tmpdir(), 'dsm-skill-'))
  const root = join(base, '.dsh', 'skills')
  mkdirSync(root, { recursive: true })
  return { base, root }
}

// 目录名与 frontmatter 里的 name 分开给：宿主认的是 frontmatter 的 name。
function writeSkill(root, dirName, text = SKILL_OK) {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  return dir
}

test('splitSkillFile 认出 frontmatter 与闭合行', () => {
  const { lines, frontmatter, closeIndex } = splitSkillFile(SKILL_OK)
  assert.equal(lines.length, 8)
  assert.deepEqual(frontmatter, ['name: demo-skill', 'description: 一个演示用的 skill'])
  assert.equal(closeIndex, 3)
})

test('splitSkillFile 拒绝没有 frontmatter / 未闭合的文件', () => {
  assert.equal(splitSkillFile('# 没有 frontmatter').frontmatter, null)
  assert.equal(splitSkillFile('---\nname: x\n').frontmatter, null)
  assert.equal(splitSkillFile('').frontmatter, null)
})

test('readFrontmatterField 去引号、容忍 CRLF', () => {
  const fm = ['name: "quoted-name"', "description: '单引号'", 'whenToUse: 用在测试里\r']
  assert.equal(readFrontmatterField(fm, 'name'), 'quoted-name')
  assert.equal(readFrontmatterField(fm, 'description'), '单引号')
  assert.equal(readFrontmatterField(fm, 'whenToUse'), '用在测试里')
  assert.equal(readFrontmatterField(fm, 'missing'), '')
})

test('modeOf 三态：默认 on、只禁模型=clipboard、两个都禁=off', () => {
  assert.equal(modeOf(['name: a', 'description: b']), 'on')
  assert.equal(modeOf(['name: a', 'disable-model-invocation: true']), 'clipboard')
  assert.equal(modeOf(['name: a', 'disable-model-invocation: true', 'user-invocable: false']), 'off')
  // 只写 user-invocable: false（模型仍可见）算 on
  assert.equal(modeOf(['name: a', 'user-invocable: false']), 'on')
  // 布尔写法兼容
  assert.equal(modeOf(['disable-model-invocation: 1', 'user-invocable: 0']), 'off')
})

test('setMode 三态往返，最终能回到逐字节相同', () => {
  const viaClipboard = setMode(SKILL_OK, 'clipboard')
  assert.match(viaClipboard, /^disable-model-invocation: true$/m)
  assert.doesNotMatch(viaClipboard, /user-invocable/)

  const viaOff = setMode(viaClipboard, 'off')
  assert.match(viaOff, /^disable-model-invocation: true$/m)
  assert.match(viaOff, /^user-invocable: false$/m)

  assert.equal(setMode(viaOff, 'on'), SKILL_OK)
})

test('setMode 幂等：目标态已达成时原样返回', () => {
  const off = setMode(SKILL_OK, 'off')
  assert.equal(setMode(off, 'off'), off)
  assert.equal(setMode(SKILL_OK, 'on'), SKILL_OK)
})

test('setMode 不改动正文，只动 frontmatter 内的键', () => {
  const off = setMode(SKILL_OK, 'off')
  const before = splitSkillFile(SKILL_OK).lines.slice(4)
  const after = splitSkillFile(off).lines.slice(splitSkillFile(off).closeIndex + 1)
  assert.deepEqual(after, before)
})

test('setMode 无 frontmatter 时报错', () => {
  assert.throws(() => setMode('# 纯正文\n', 'off'), /no YAML frontmatter/)
  assert.throws(() => setMode(SKILL_OK, 'bogus'), /unknown skill mode/)
})

test('listSkills 扫描根、按 rank 去重并给出 shadowed', () => {
  const { base, root } = tmpRoot()
  const agents = join(base, '.agents', 'skills')
  mkdirSync(agents, { recursive: true })
  writeSkill(root, 'dir-a', skillText('same-name'))
  writeSkill(agents, 'dir-b', skillText('same-name'))
  writeSkill(root, 'dir-c', skillText('only-here'))

  const out = listSkills({ cwd: base, projectRoot: base, env: { DSH_HOME: join(base, '.dsh-home') }, home: join(base, 'home') })
  const names = out.skills.map((s) => s.name).sort()
  assert.deepEqual(names, ['only-here', 'same-name'])
  assert.equal(out.shadowed.length, 1, '项目根与 ~/.agents 同名，rank 小的胜出，另一个进 shadowed')
  assert.ok(out.shadowed[0].hiddenBy.includes('.dsh'))
})

test('listSkills 跳过 .system / node_modules 等目录', () => {
  const { base, root } = tmpRoot()
  writeSkill(root, '.system', skillText('hidden-one'))
  writeSkill(root, 'node_modules', skillText('hidden-two'))
  writeSkill(root, 'visible', skillText('visible-one'))
  const out = listSkills({ cwd: base, projectRoot: base, env: { DSH_HOME: join(base, '.dsh-home') }, home: join(base, 'home') })
  assert.deepEqual(out.skills.map((s) => s.name), ['visible-one'])
  assert.ok(SKIP_COPY_NAMES.has('.system'))
})

test('listSkills 跳过坏目录（无 SKILL.md / 缺 name / 非法 name）', () => {
  const { base, root } = tmpRoot()
  mkdirSync(join(root, 'no-skill-file'), { recursive: true })
  writeSkill(root, 'no-name', '---\ndescription: 只有描述\n---\n\n正文\n')
  writeSkill(root, 'bad-name', '---\nname: Bad_Name\ndescription: 大写不行\n---\n\n正文\n')
  writeSkill(root, 'good', skillText('good'))
  const out = listSkills({ cwd: base, projectRoot: base, env: { DSH_HOME: join(base, '.dsh-home') }, home: join(base, 'home') })
  assert.deepEqual(out.skills.map((s) => s.name), ['good'])
  const broken = listBrokenDirs({ cwd: base, projectRoot: base, env: { DSH_HOME: join(base, '.dsh-home') }, home: base + '/home' })
  assert.equal(broken.length, 3)
  assert.ok(broken.every((b) => b.reason))
})

test('setSkillMode 写盘 + 备份 + 幂等（no-op 不写不备份）', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  const file = join(dir, 'SKILL.md')
  // 测试根是 <base>/.dsh/skills，只有把 base 当 projectRoot 才会被认成可写根
  // （生产里这正是「项目 .dsh/skills」那条根）。
  const opts = { projectRoot: base }

  const first = setSkillMode(dir, 'off', { ...opts, expectName: 'demo-skill' })
  assert.equal(first.changed, true)
  assert.equal(first.mode, 'off')
  assert.ok(first.backup && first.backup.includes('.bak-skill-'))
  assert.match(readFileSync(file, 'utf8'), /user-invocable: false/)

  const second = setSkillMode(dir, 'off', { ...opts, expectName: 'demo-skill' })
  assert.equal(second.changed, false)
  assert.equal(second.backup, null)

  const backups = readdirSync(dir).filter((f) => f.includes('.bak-skill-'))
  assert.equal(backups.length, 1, 'no-op 不应新增备份')
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), SKILL_OK, '备份是改动前的原文')

  const back = setSkillMode(dir, 'on', { ...opts, expectName: 'demo-skill' })
  assert.equal(back.changed, true)
  assert.equal(readFileSync(file, 'utf8'), SKILL_OK)
})

test('setSkillMode 连续两次同一秒不撞备份名', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  const opts = { projectRoot: base }
  setSkillMode(dir, 'clipboard', opts)
  setSkillMode(dir, 'off', opts)
  const backups = readdirSync(dir).filter((f) => f.includes('.bak-skill-'))
  assert.equal(backups.length, 2, '两次改动应产生两个互不覆盖的备份')
})

test('setSkillMode 拒绝 name 不匹配与非 skill 目录', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  const opts = { projectRoot: base }
  assert.throws(() => setSkillMode(dir, 'off', { ...opts, expectName: 'other-skill' }), /skill name mismatch/)
  const empty = join(root, 'empty-dir')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => setSkillMode(empty, 'off', opts), /SKILL.md not found/)
  // 不在任何扫描根下的目录一律拒绝（否则一条 owner 请求就能改宿主包里的官方 skill）。
  const outside = mkdtempSync(join(tmpdir(), 'dsm-outside-'))
  const loose = join(outside, 'loose-skill')
  mkdirSync(loose, { recursive: true })
  writeFileSync(join(loose, 'SKILL.md'), SKILL_OK, 'utf8')
  assert.throws(() => setSkillMode(loose, 'off', opts), /outside every known skill root/)
  assert.throws(() => deleteSkillDir(loose, opts), /outside every known skill root/)
})

test('bundled 根里的 skill 只读：拒绝开关与删除，文件原样保留', () => {
  const { base } = tmpRoot()
  const bundled = mkdtempSync(join(tmpdir(), 'dsm-bundled-'))
  const dir = writeSkill(bundled, 'official-skill')
  const opts = { projectRoot: base, env: { ...process.env, DSH_BUNDLED_SKILL_DIR: bundled } }
  assert.throws(() => setSkillMode(dir, 'off', opts), /bundled skills are read-only/)
  assert.throws(() => deleteSkillDir(dir, opts), /bundled skills are read-only/)
  assert.equal(existsSync(join(dir, 'SKILL.md')), true, '被拒绝时文件必须原样还在')
})

test('deleteSkillDir 进回收站：目录被移走而不是删掉，且不在 skills 根里', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  const trash = join(base, 'trash', 'skills')
  const out = deleteSkillDir(dir, { projectRoot: base, trashDir: trash })
  assert.equal(out.name, 'demo-skill')
  assert.equal(existsSync(dir), false, '原目录应已移走')
  assert.ok(out.trashed, '应返回回收站路径')
  assert.equal(out.trashed.startsWith(trash), true)
  assert.equal(existsSync(join(out.trashed, 'SKILL.md')), true, '回收站里应保留原文，可恢复')
  // 回收站绝不能落在 skills 根内：否则宿主下次扫描会把它当成另一个同名 skill。
  assert.equal(out.trashed.startsWith(root), false)
  assert.equal(listSkills({ projectRoot: base, env: {} }).skills.some((s2) => s2.name === 'demo-skill'), false)
})

// ── review 反馈回归（setMode 的读写一致性）──────────────────────────
const FM = (lines, body = ['', '# 正文', '']) => ['---', ...lines, '---', ...body].join('\n')

test('setMode 是幂等的：已是目标态就不改字节（on 的不动点）', () => {
  // 只写了 user-invocable: false —— 语义上仍是 on，早期实现会把这一行删掉，
  // 等于用户点"启用"反而偷偷开了 / 调用。
  const text = FM(['name: a', 'description: b', 'user-invocable: false'])
  assert.equal(modeOf(splitSkillFile(text).frontmatter), 'on')
  assert.equal(setMode(text, 'on'), text)

  const off = FM(['name: a', 'description: b', 'disable-model-invocation: true', 'user-invocable: false'])
  assert.equal(modeOf(splitSkillFile(off).frontmatter), 'off')
  assert.equal(setMode(off, 'off'), off)

  const clip = FM(['name: a', 'description: b', 'disable-model-invocation: true'])
  assert.equal(modeOf(splitSkillFile(clip).frontmatter), 'clipboard')
  assert.equal(setMode(clip, 'clipboard'), clip)
})

test('setMode 把重复键收敛成一行（读第一个、写全部会自相矛盾）', () => {
  const text = FM(['name: a', 'description: b', 'disable-model-invocation: false', 'disable-model-invocation: false'])
  const out = setMode(text, 'clipboard')
  const hits = out.split('\n').filter((l) => l.startsWith('disable-model-invocation:'))
  assert.equal(hits.length, 1, '重复键必须收敛成一条')
  assert.equal(hits[0], 'disable-model-invocation: true')
  // 收敛之后读出来的就是真值，不会出现「写 true 却读到 false」
  assert.equal(modeOf(splitSkillFile(out).frontmatter), 'clipboard')
})

test('setMode 认得行尾注释（否则停用的 skill 会被"启用"按钮复活）', () => {
  const text = FM(['name: a', 'description: b', 'disable-model-invocation: true # 临时停用'])
  assert.equal(modeOf(splitSkillFile(text).frontmatter), 'clipboard', '注释不该让布尔解析失败')
  assert.equal(setMode(text, 'clipboard'), text, '已命中目标态就不动它，注释也不丢')
  const off = setMode(text, 'off')
  assert.match(off, /user-invocable: false/)
  assert.match(off, /disable-model-invocation: true/)
})

test('setMode 沿用原文件的 CRLF 换行', () => {
  const text = FM(['name: a', 'description: b']).replace(/\n/g, '\r\n')
  const out = setMode(text, 'off')
  assert.equal(/[^\r]\n/.test(out), false, 'CRLF 文件里不许出现裸 LF')
  assert.match(out, /disable-model-invocation: true\r\n/)
  assert.match(out, /user-invocable: false\r\n/)
  // 回到 on 应该逐字节还原
  assert.equal(setMode(out, 'on'), text)
})

test('safeJoin 挡住 zip 相对路径穿越（isSafeRel 是第一道防线）', () => {
  // 经 importSkillZip 走真实路径：手工造一个带 .. 的 zip（writeZip 会拒绝，
  // 所以这里直接拼字节，确保测的是读侧守卫而不是写出侧）。
  // 前缀合法（demo/）但另一条目用 .. 想跳出 staging 目录。
  const evil = makeZip([['demo/SKILL.md', SKILL_OK], ['demo/../../escape.txt', 'pwn']])
  const base = mkdtempSync(join(tmpdir(), 'dsm-slip-'))
  const root = join(base, '.dsh', 'skills')
  mkdirSync(root, { recursive: true })
  assert.throws(() => importSkillZip(evil, root), /unsafe archive entry|has no SKILL\.md/)
  assert.equal(existsSync(join(base, 'escape')), false, '没有文件被写到根外')
})
