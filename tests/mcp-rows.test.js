// mcp-rows 单测：解析 / 开关 / profile 目录解析。
// 用合成的小 fixture（不读用户真实 profile），覆盖围绕「#OFF# 块 + 覆盖行」的
// 四种状态组合。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePatchRows, togglePatchRow, resolveProfileDir } from '../src/mcp-rows.js'

const ACTIVE_ROW = [
  '- id: mcp-win',
  '  name: dsh-computer-use-win',
  '  config:',
  '    mode: full',
].join('\n')

const OFF_BLOCK = [
  '# ---',
  '# 说明注释',
  '# ---',
  '# - insert:',
  '    #OFF#     - id: mcp-photo',
  "    #OFF#       name: '@deepseek-ai/dsh-mcp-client'",
  '    #OFF#       config:',
  '    #OFF#         serverName: photo',
  '    #OFF#         transport: stdio',
  "    #OFF#         command: 'D:\\\\nodejs\\\\node.exe'",
  '# ---',
  '- id: dsh-ops',
  '  disabled: true',
].join('\n')

const OVERRIDDEN = [
  '- insert:',
  '    - id: mcp-cad',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: cad',
  '        transport: stdio',
].join('\n') + '\n- id: mcp-cad\n  disabled: true\n'

test('解析：注释块 / 覆盖行 / 普通行三种状态', () => {
  const text = [ACTIVE_ROW, OFF_BLOCK, OVERRIDDEN].join('\n\n')
  const { rows } = parsePatchRows(text)
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))

  assert.equal(byId['mcp-win'].enabled, true)
  assert.equal(byId['mcp-win'].commented, false)

  assert.equal(byId['mcp-photo'].enabled, false)
  assert.equal(byId['mcp-photo'].commented, true)
  assert.equal(byId['mcp-photo'].serverName, 'photo')
  assert.equal(byId['mcp-photo'].transport, 'stdio')
  assert.equal(byId['mcp-photo'].target, 'node.exe')

  assert.equal(byId['mcp-cad'].enabled, false)
  assert.equal(byId['mcp-cad'].commented, false)
  assert.equal(byId['mcp-cad'].overridden, true)

  // 非 MCP 行（dsh-ops）与管理类插件都不该出现。
  assert.equal(byId['dsh-ops'], undefined)
})

test('解析：mcp-manager 这类管理插件被排除', () => {
  const text = [
    '- insert:',
    '    - id: mcp-manager',
    '      name: dsh-mcp-manager',
    '- id: mcp-manager',
    '  disabled: true',
  ].join('\n')
  assert.deepEqual(parsePatchRows(text).rows, [])
})

test('解析：空文本/非字符串返回空列表', () => {
  assert.deepEqual(parsePatchRows('').rows, [])
  assert.deepEqual(parsePatchRows(null).rows, [])
  assert.deepEqual(parsePatchRows(undefined).rows, [])
})

test('开关：启用被 #OFF# 注释的块 = 剥前缀 + 拆块头', () => {
  const text = [ACTIVE_ROW, OFF_BLOCK].join('\n\n')
  const out = togglePatchRow(text, { id: 'mcp-photo', enabled: true })
  assert.equal(out.changed, true)
  assert.equal(out.action, 'enable')
  assert.ok(!out.text.includes('#OFF#'), '不该残留 #OFF# 前缀')
  assert.ok(out.text.includes('\n- insert:\n'), '块头应恢复为真 YAML')
  assert.ok(out.text.includes("    - id: mcp-photo"))
  const row = parsePatchRows(out.text).rows.find((r) => r.id === 'mcp-photo')
  assert.equal(row.enabled, true)
  assert.equal(row.commented, false)
  // 幂等
  const again = togglePatchRow(out.text, { id: 'mcp-photo', enabled: true })
  assert.equal(again.changed, false)
  assert.equal(again.reason, 'unchanged')
})

test('开关：启用被覆盖行关掉的块 = 删掉覆盖行', () => {
  const out = togglePatchRow(OVERRIDDEN, { id: 'mcp-cad', enabled: true })
  assert.equal(out.changed, true)
  assert.ok(!/^- id: mcp-cad$/m.test(out.text), '覆盖行应删除')
  const row = parsePatchRows(out.text).rows.find((r) => r.id === 'mcp-cad')
  assert.equal(row.enabled, true)
  assert.equal(row.overridden, false)
})

test('开关：关闭启用中的行 = 末尾追加覆盖行，不动原块', () => {
  const out = togglePatchRow(ACTIVE_ROW, { id: 'mcp-win', enabled: false })
  assert.equal(out.changed, true)
  assert.equal(out.action, 'disable-override')
  assert.ok(out.text.startsWith(ACTIVE_ROW), '原行必须字节不变')
  assert.ok(out.text.includes('- id: mcp-win\n  disabled: true'))
  const row = parsePatchRows(out.text).rows.find((r) => r.id === 'mcp-win')
  assert.equal(row.enabled, false)
  assert.equal(row.overridden, true)
  // 幂等
  const again = togglePatchRow(out.text, { id: 'mcp-win', enabled: false })
  assert.equal(again.changed, false)
})

test('开关：已注释的块再关闭 = 无变化', () => {
  const out = togglePatchRow(OFF_BLOCK, { id: 'mcp-photo', enabled: false })
  assert.equal(out.changed, false)
  assert.equal(out.reason, 'unchanged')
  assert.equal(out.text, OFF_BLOCK)
})

test('开关：未知 id / 坏参数', () => {
  const a = togglePatchRow(OFF_BLOCK, { id: 'mcp-nope', enabled: true })
  assert.equal(a.changed, false)
  assert.equal(a.reason, 'not-found')
  assert.equal(a.text, OFF_BLOCK)

  const b = togglePatchRow(null, { id: 'mcp-photo', enabled: true })
  assert.equal(b.changed, false)
  assert.equal(b.reason, 'bad-input')
})

test('resolveProfileDir：argv 里的 profiles 路径', () => {
  const dir = process.platform === 'win32' ? 'C:\\Users\\x\\.dsh\\profiles\\desktop' : '/home/x/.dsh/profiles/desktop'
  const got = resolveProfileDir({
    argv: ['node', 'host.js', dir],
    env: {},
    home: '/home/x',
    exists: (p) => String(p).endsWith('cordis.patch.yml'),
  })
  assert.equal(got, dir)
})

test('resolveProfileDir：环境变量优先，缺失时回退 null', () => {
  const virtual = process.platform === 'win32' ? 'C:\\tmp\\p' : '/tmp/p'
  const got = resolveProfileDir({
    argv: ['node', 'host.js'],
    env: { DSH_PROFILE_DIR: virtual },
    home: '/home/x',
    exists: (p) => String(p).includes('p') && String(p).endsWith('cordis.patch.yml'),
  })
  assert.equal(got, virtual)

  const none = resolveProfileDir({ argv: ['node'], env: {}, home: '/home/x', exists: () => false })
  assert.equal(none, null)
})

// ---------------------------------------------------------------------------
// v0.6.1：块内条目的关闭必须连 `- insert:` 一起注释。
// 背景：只注释条目、留下 `- insert:` 时 YAML 解析出 insert: null，宿主会把
// 整个 profile 判成非法（插件市场报「非法的配置文件」）。
// ---------------------------------------------------------------------------

const LIVE_BLOCK = [
  '# ---',
  '- insert:',
  '    - id: mcp-photo',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: photo',
  '        transport: stdio',
  "#        command: 'D:\\\\nodejs\\\\node.exe'",
  '# ---',
].join('\n')

test('关闭块内条目：条目加 #OFF#，且 - insert: 一并注释', () => {
  const out = togglePatchRow(LIVE_BLOCK, { id: 'mcp-photo', enabled: false })
  assert.equal(out.changed, true)
  assert.equal(out.action, 'disable-comment')
  assert.ok(/\n# - insert:\n/.test(out.text), '- insert: 必须变成注释')
  assert.ok(!/^- insert:$/m.test(out.text), '不该留下裸的 - insert:')
  assert.ok(out.text.includes('#OFF# - id: mcp-photo'), '条目要被 #OFF# 注释')
  // 纯注释行不该变成 `# #OFF#`（双井号）
  assert.ok(out.text.includes("#        command:"), '既有注释行保持单井号')
  const row = parsePatchRows(out.text).rows.find((r) => r.id === 'mcp-photo')
  assert.equal(row.enabled, false)
  assert.equal(row.commented, true)
  // 幂等
  assert.equal(togglePatchRow(out.text, { id: 'mcp-photo', enabled: false }).changed, false)
})

test('关闭块内条目后整块零个启用条目 = 块头必须注释（防 insert: null）', () => {
  const out = togglePatchRow(LIVE_BLOCK, { id: 'mcp-photo', enabled: false })
  const lines = out.text.split('\n')
  const head = lines.find((l) => /- insert:/.test(l))
  assert.ok(/^\s*#/.test(head), '唯一条目关掉后块头必须注释：' + JSON.stringify(head))
  // 再启用回来：块头回到第 0 列，条目剥掉 #OFF#
  const back = togglePatchRow(out.text, { id: 'mcp-photo', enabled: true })
  assert.equal(back.changed, true)
  const backLines = back.text.split('\n')
  assert.ok(backLines.includes('- insert:'), '- insert: 必须顶格在第 0 列')
  assert.ok(!backLines.some((l) => /^\s+- insert:$/.test(l)), '不该留缩进的 - insert:')
  assert.equal(parsePatchRows(back.text).rows.find((r) => r.id === 'mcp-photo').enabled, true)
})

test('块内多条目：只关一个时块头保持启用', () => {
  const two = [
    '- insert:',
    '    - id: mcp-a',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: a',
    '    - id: mcp-b',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: b',
  ].join('\n')
  const out = togglePatchRow(two, { id: 'mcp-a', enabled: false })
  assert.ok(out.text.split('\n').includes('- insert:'), '还有一个启用条目，块头不能注释')
  const rows = parsePatchRows(out.text).rows
  assert.equal(rows.find((r) => r.id === 'mcp-a').enabled, false)
  assert.equal(rows.find((r) => r.id === 'mcp-b').enabled, true)
})
