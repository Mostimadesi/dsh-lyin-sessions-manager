import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SKIP_COPY_NAMES as SKIP_COPY_NAMES,
  listBrokenDirs,
  listSkills,
  modeOf,
  readFrontmatterField,
  setMode,
  setSkillMode,
  splitSkillFile,
} from '../src/skill-rows.js'

const SKILL_OK = ['---', 'name: demo-skill', 'description: 一个演示用的 skill', '---', '', '# 正文', '内容一行', ''].join('\n')

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

  const first = setSkillMode(dir, 'off', { expectName: 'demo-skill' })
  assert.equal(first.changed, true)
  assert.equal(first.mode, 'off')
  assert.ok(first.backup && first.backup.includes('.bak-skill-'))
  assert.match(readFileSync(file, 'utf8'), /user-invocable: false/)

  const second = setSkillMode(dir, 'off', { expectName: 'demo-skill' })
  assert.equal(second.changed, false)
  assert.equal(second.backup, null)

  const backups = readdirSync(dir).filter((f) => f.includes('.bak-skill-'))
  assert.equal(backups.length, 1, 'no-op 不应新增备份')
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), SKILL_OK, '备份是改动前的原文')

  const back = setSkillMode(dir, 'on', { expectName: 'demo-skill' })
  assert.equal(back.changed, true)
  assert.equal(readFileSync(file, 'utf8'), SKILL_OK)
})

test('setSkillMode 连续两次同一秒不撞备份名', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  setSkillMode(dir, 'clipboard')
  setSkillMode(dir, 'off')
  const backups = readdirSync(dir).filter((f) => f.includes('.bak-skill-'))
  assert.equal(backups.length, 2, '两次改动应产生两个互不覆盖的备份')
})

test('setSkillMode 拒绝 name 不匹配与非 skill 目录', () => {
  const { base, root } = tmpRoot()
  const dir = writeSkill(root, 'demo-skill')
  assert.throws(() => setSkillMode(dir, 'off', { expectName: 'other-skill' }), /skill name mismatch/)
  const empty = join(root, 'empty-dir')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => setSkillMode(empty, 'off'), /SKILL.md not found/)
})
