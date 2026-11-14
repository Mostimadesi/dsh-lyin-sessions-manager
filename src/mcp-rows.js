// MCP 服务器行（v0.6.0）—— 从 profile 的 cordis.patch.yml 里识别「MCP 服务器」
// 行，并支持原地开关。
//
// 设计边界（刻意的最小实现）：
//   * 不做 MCP 协议，不连接、不探测、不持有子进程；真正的连接由 DSH 自带的
//     @deepseek-ai/dsh-mcp-client 行在启动时完成。
//   * 因此开关只改配置，**需要重启 DSH 才生效**（Web 面的 patch 热重载是关闭的，
//     实测改完 6 秒内 /mcp-manager/* 仍是 404）。
//   * 只做行级文本手术：识别 - id: <id> 行与 - insert: 块，禁用时在文件末尾追加
//     「- id: <id> / disabled: true」覆盖行（不改动原块的任何字节），启用时删掉
//     覆盖行；若原块被「#OFF# 」整块注释掉，启用时只剥掉这些前缀。
//
// 解析是防御式的：认不出的文件结构一律返回空列表（绝不猜、绝不重排），
// 调用方据此只读展示或直接报错。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MCP_ROW_ID_PREFIX = 'mcp-'
export const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'
export const PATCH_FILE_NAME = 'cordis.patch.yml'

const SEP_RE = /^#\s*-{4,}\s*$/
const ROW_RE = /^- id:\s*(.+?)\s*$/
// 块头允许前导缩进：本机真实的 MCP 块是 `    # - insert:`（缩进 4）与
// `  # - insert:`（缩进 2），早期版本只认第 0 列，导致三个块全部漏识别。
const BLOCK_HDR_RE = /^([ \t]*)(#\s*)?- insert:\s*$/
// 「#OFF# 」前缀：缩进 + '#OFF#' + 一个空格（也可能是行尾）。
const OFF_PREFIX_RE = /^(\s*)#OFF# ?/

function unquote(v) {
  const s = String(v || '').trim()
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1)
  return s
}

// 从一个元素体的正文行里取 key: value（兼容 '#OFF# ' 前缀）。
function bodyValue(lines, from, to, key) {
  const re = new RegExp('^\\s*(?:#OFF#\\s*)?' + key + ':\\s*(.+?)\\s*$')
  for (let i = from; i < to; i++) {
    const m = re.exec(lines[i])
    if (m) return unquote(m[1])
  }
  return ''
}

function idOfLine(line) {
  const m = /^(\s*)(?:#OFF#\s*)?- id:\s*(.+?)\s*$/.exec(line)
  if (!m) return null
  return { indent: m[1].length, off: /^\s*#OFF#/.test(line), id: unquote(m[2]) }
}

// 顶层覆盖行：'- id: X' 后面紧跟缩进 2 的行里出现 'disabled: true'。
// 返回 [{ id, start, end }]，end 为不含。
function collectOverrideRows(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i])
    if (!m) continue
    let j = i + 1
    let disabled = false
    while (j < lines.length && /^\s{2}\S/.test(lines[j]) && !ROW_RE.test(lines[j]) && !BLOCK_HDR_RE.test(lines[j])) {
      if (/^\s{2}disabled:\s*true\s*$/.test(lines[j])) disabled = true
      j++
    }
    if (disabled) out.push({ id: unquote(m[1]), start: i, end: j })
  }
  return out
}

// 找出一个 insert 块的结束下标（不含）：遇到分隔注释、下一个顶层行、下一个块头
// 就停。块内部的行一定是缩进的，或带 '#OFF# ' 前缀。
function blockEndOf(lines, start) {
  const depth = (/^([ \t]*)/.exec(lines[start]) || [, ''])[1].length
  let j = start + 1
  while (j < lines.length) {
    const L = lines[j]
    if (SEP_RE.test(L)) break
    if (ROW_RE.test(L)) break
    const hdr = BLOCK_HDR_RE.exec(L)
    if (hdr && (hdr[1] || '').length <= depth) break
    if (L.trim() === '' || /^\s/.test(L) || /^#/.test(L)) { j++; continue }
    break
  }
  return j
}

function collectBlockRows(lines, overrideIds) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const hdr = BLOCK_HDR_RE.exec(lines[i])
    if (!hdr) continue
    const end = blockEndOf(lines, i)
    const commented = !!hdr[2]
    const insertIndent = hdr[1] || ''
    let cur = null
    for (let k = i + 1; k < end; k++) {
      const info = idOfLine(lines[k])
      if (info) {
        if (cur) out.push(cur)
        cur = { id: info.id, lineStart: k, blockStart: i, blockEnd: end, commented, off: info.off, insertIndent }
        continue
      }
      if (cur && cur.off === undefined) cur.off = /^\s*#OFF#/.test(lines[k])
    }
    if (cur) out.push(cur)
    i = end - 1
  }
  // 只留 MCP 行（id 前缀 mcp-，或 name 是 dsh-mcp-client）；排除管理类插件本身。
  const kept = []
  for (const r of out) {
    const name = bodyValue(lines, r.lineStart + 1, nextRowLine(lines, r.lineStart, r.blockEnd), 'name')
    const isMcp = r.id.startsWith(MCP_ROW_ID_PREFIX) || name === MCP_CLIENT_NAME
    if (!isMcp || isManagerRow(r.id, name)) continue
    kept.push({ ...r, name, serverName: bodyValue(lines, r.lineStart + 1, nextRowLine(lines, r.lineStart, r.blockEnd), 'serverName') })
  }
  for (const r of kept) r.override = overrideIds.has(r.id)
  return kept
}

function nextRowLine(lines, from, end) {
  for (let i = from + 1; i < end; i++) if (idOfLine(lines[i])) return i
  return end
}

function collectTopRows(lines, overrideIds) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i])
    if (!m) continue
    const id = unquote(m[1])
    if (!id.startsWith(MCP_ROW_ID_PREFIX)) continue
    let j = i + 1
    while (j < lines.length && /^\s{2}\S/.test(lines[j]) && !ROW_RE.test(lines[j])) j++
    const name = bodyValue(lines, i + 1, j, 'name')
    const isMcp = name === MCP_CLIENT_NAME || /^dsh-|mcp/.test(name || '') || id.startsWith(MCP_ROW_ID_PREFIX)
    if (!isMcp || isManagerRow(id, name)) continue
    out.push({
      id,
      name,
      serverName: bodyValue(lines, i + 1, j, 'serverName'),
      lineStart: i,
      blockStart: i,
      blockEnd: j,
      commented: false,
      off: false,
      override: overrideIds.has(id),
    })
  }
  return out
}

// 管理界面类插件（mcp-manager 自己）不是 MCP 服务器，不该出现在开关列表里。
function isManagerRow(id, name) {
  return id === 'mcp-manager' || /(^|[/-])mcp-manager$/i.test(String(name || ''))
}

// 公开入口：text -> { rows }
// row: { id, serverName, transport, target, enabled, commented, overridden }
export function parsePatchRows(text) {
  if (typeof text !== 'string' || !text) return { rows: [] }
  const lines = text.split('\n')
  const overrides = collectOverrideRows(lines)
  const overrideIds = new Set(overrides.map((o) => o.id))
  const raw = [...collectBlockRows(lines, overrideIds), ...collectTopRows(lines, overrideIds)]
  const seen = new Set()
  const rows = []
  for (const r of raw) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const end = nextRowLine(lines, r.lineStart, r.blockEnd)
    const serverName = r.serverName || bodyValue(lines, r.lineStart + 1, end, 'serverName') || r.id.replace(/^mcp-/, '')
    const transport = bodyValue(lines, r.lineStart + 1, end, 'transport')
    const command = bodyValue(lines, r.lineStart + 1, end, 'command')
    const url = bodyValue(lines, r.lineStart + 1, end, 'url')
    rows.push({
      id: r.id,
      serverName,
      transport,
      target: command ? basenameOf(command) : url || command || '',
      // 三层都要看：块头是否被注释、本条目是否带 #OFF#、是否有覆盖行。
      // 块头被注释 => 整块失效，条目上的 #OFF# 只是装饰，这种情况 commented。
      enabled: !r.commented && !r.off && !r.override,
      commented: !!r.commented,
      off: !!r.off,
      overridden: !!r.override,
      inBlock: r.blockStart !== r.lineStart,
    })
  }
  return { rows }
}

function basenameOf(p) {
  const parts = String(p || '').replace(/\\+/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

// 开关一行：返回 { text, changed, reason? }。
//
// 两条路径，因为 profile 里 MCP 有两种写法：
//
//   (A) `- insert:` 块内的条目（本机 3 个 MCP 都是这种）。
//       启用 = 剥掉 `#OFF# ` 前缀，并把 `- insert:` **顶格到第 0 列**；
//       停用 = 给条目每一行加 `#OFF# `，并在块内**没有其他启用条目**时把
//       `- insert:` 一起注释掉。
//       为什么必须注释块头：只剩 `- insert:` 而下面全是注释时，YAML 解析出
//       `insert: null`，宿主会把整个 profile 判成非法（插件市场报「非法的
//       配置文件」）。所以「条目全关」与「块头注释」必须成对发生。
//
//   (B) 顶层行（`- id: xxx` 在第 0 列，例如 dsh-computer-use-win）。
//       停用 = 追加末尾覆盖行 `- id: X / disabled: true`（profile 原生写法，
//       dsh-pet 就是这么关的），原行字节不动；启用 = 删掉覆盖行。
//
// 幂等：目标状态已达成时 changed=false。
export function togglePatchRow(text, { id, enabled }) {
  if (typeof text !== 'string' || typeof id !== 'string' || !id) return { text, changed: false, reason: 'bad-input' }
  const lines = text.split('\n')
  const overrides = collectOverrideRows(lines)
  const overrideIds = new Set(overrides.map((o) => o.id))
  const raw = [...collectBlockRows(lines, overrideIds), ...collectTopRows(lines, overrideIds)]
  const target = raw.find((r) => r.id === id)
  if (!target) return { text, changed: false, reason: 'not-found' }
  const want = !!enabled
  const inBlock = target.blockStart !== target.lineStart
  const nowEnabled = !target.commented && !target.off && !target.override
  if (nowEnabled === want) return { text, changed: false, reason: 'unchanged' }

  if (want) {
    const out = lines.slice()
    if (inBlock && target.commented) {
      for (let i = target.lineStart; i < itemEndLine(out, target.lineStart, target.blockEnd); i++) {
        out[i] = out[i].replace(OFF_PREFIX_RE, '$1')
      }
      // 块头必须顶格：留在缩进里会被解析成上一条目的 config 子键。
      out[target.blockStart] = '- insert:'
    } else if (inBlock) {
      for (let i = target.lineStart; i < itemEndLine(out, target.lineStart, target.blockEnd); i++) {
        out[i] = out[i].replace(OFF_PREFIX_RE, '$1')
      }
    }
    const again = collectOverrideRows(out).find((o) => o.id === id)
    if (again) out.splice(again.start, again.end - again.start)
    return { text: out.join('\n'), changed: true, action: 'enable' }
  }

  if (!inBlock) {
    // 顶层行：追加覆盖行，原行不动。
    let t = text
    if (!t.endsWith('\n')) t += '\n'
    if (!t.endsWith('\n\n')) t += '\n'
    t += '# 由「会话管理 → MCP 服务器」关闭（回滚 = 删掉下面两行）\n- id: ' + id + '\n  disabled: true\n'
    return { text: t, changed: true, action: 'disable-override' }
  }

  // 块内条目：加 #OFF# 前缀；若块内再无启用条目，连块头一起注释。
  const out = lines.slice()
  const end = itemEndLine(out, target.lineStart, target.blockEnd)
  for (let i = target.lineStart; i < end; i++) {
    if (out[i].trim() === '' || /^\s*#(?!OFF#)/.test(out[i])) continue
    const m = /^(\s*)(.*)$/.exec(out[i])
    out[i] = m[1] + '#OFF# ' + m[2]
  }
  // 重新统计块内还有没有启用的条目（用块头 + 新文本统计，不重新解析整份文件）。
  if (!blockHasEnabledItem(out, target.blockStart, target.blockEnd)) {
    const head = out[target.blockStart]
    if (!/^\s*#/.test(head)) out[target.blockStart] = (/^(\s*)/.exec(head)[1]) + '# - insert:'
  }
  return { text: out.join('\n'), changed: true, action: 'disable-comment' }
}

// 条目体的结束行（不含）：下一条 `- id:` 或块尾。
function itemEndLine(lines, from, blockEnd) {
  for (let i = from + 1; i < blockEnd; i++) if (idOfLine(lines[i])) return i
  return blockEnd
}

// 块内是否还有启用的条目：块头未注释，且存在一个未带 `#OFF#` 的 `- id:` 行。
function blockHasEnabledItem(lines, blockStart, blockEnd) {
  if (/^\s*#/.test(lines[blockStart])) return false
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const info = idOfLine(lines[i])
    if (info && !info.off) return true
  }
  return false
}

// 解析当前 DSH 的 profile 目录：宿主进程 argv 里带着「.../profiles/<name>」。
// 依次尝试：DSH_PROFILE_DIR 环境变量 -> argv 里带 cordis.patch.yml 的 profiles 路径
// -> DSH_PROFILE 指定的名字。都不成立时返回 null（调用方只读展示提示）。
export function resolveProfileDir({ argv = process.argv, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const hasPatch = (dir) => {
    try { return exists(join(dir, PATCH_FILE_NAME)) } catch { return false }
  }
  if (env && env.DSH_PROFILE_DIR && hasPatch(env.DSH_PROFILE_DIR)) return env.DSH_PROFILE_DIR
  for (const a of argv || []) {
    if (typeof a !== 'string') continue
    if (!/[\\/]profiles[\\/][^\\/]+$/.test(a)) continue
    if (hasPatch(a)) return a
  }
  if (env && env.DSH_PROFILE && hasPatch(join(home, '.dsh', 'profiles', env.DSH_PROFILE))) {
    return join(home, '.dsh', 'profiles', env.DSH_PROFILE)
  }
  return null
}

export default { parsePatchRows, togglePatchRow, resolveProfileDir }
