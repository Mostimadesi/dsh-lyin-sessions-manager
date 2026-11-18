// Client debug log with size-bounded rotation (v0.7.0).
//
// 背景：GUI 里看不到 console，客户端把关键埋点 POST 到
// /archived-sessions/debug-log，host 追加写 <STATE_DIR>/debug.log。原实现
// 直接 appendFile，**没有任何上限**——长期使用后单文件持续增长（2026-11-18
// 实测 174 KB / 2262 行），且 debug.log 落在 ~/.dsh/sessions-manager 里，
// 会被用户当作状态文件一起备份。
//
// 这里补两层边界：
//   1. 单次写入先夹紧：最多 60 行、每行最多 2000 字符（客户端是自家代码，
//      但仍然按不可信输入处理，避免一次误发的巨串把文件顶爆）；
//   2. 追加前预判大小：超过 maxBytes 就把 debug.log → debug.log.1 滚动，
//      依次后移，最多保留 keep 份（默认 4 MB × 3 份 + 现役 = 16 MB 上限）。
//
// 轮转用 rename（同目录、同盘，原子），失败一律降级为「不轮转，继续追加」：
// 诊断日志写不进去不该让任何正常功能报错。
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const DEBUG_LOG_NAME = 'debug.log'
// 4 MiB：约等于 5 万行埋点，足够定位一次会话周期的问题，又不会让目录失控。
export const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024
// 保留 3 份历史（debug.log.1 ~ .3），合计上限 16 MiB。
export const DEBUG_LOG_KEEP = 3
// 单次请求最多接受的行数（与原实现的 slice(0, 60) 保持一致）。
export const DEBUG_LOG_MAX_LINES = 60
// 单行长度上限：超过就截断并标注，避免把整份 payload 塞进日志。
export const DEBUG_LOG_MAX_LINE_CHARS = 2000

export function debugLogPath(dir) {
  return join(dir, DEBUG_LOG_NAME)
}

// debug.log.1 / .2 / .3：序号越大越旧。
export function rotatedDebugLogPath(path, index) {
  return `${path}.${index}`
}

// 单次写入文本：每行前缀 ISO 时间戳，统一 LF 结尾。
export function formatDebugLines(lines, now = new Date()) {
  const stamp = now instanceof Date ? now.toISOString() : String(now)
  const out = []
  for (const raw of Array.isArray(lines) ? lines : []) {
    let s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw)
    // 客户端可能把 JSON 连行发上来：换行会破坏「一行一条」的可读性。
    s = s.replace(/\r\n?/g, '\\n').replace(/\n/g, '\\n')
    if (s.length > DEBUG_LOG_MAX_LINE_CHARS) {
      s = s.slice(0, DEBUG_LOG_MAX_LINE_CHARS) + `…(+${s.length - DEBUG_LOG_MAX_LINE_CHARS}ch)`
    }
    out.push('[' + stamp + '] ' + s)
  }
  return out.length ? out.join('\n') + '\n' : ''
}

// 请求体 → 合规行数组。非数组、非字符串项一律丢弃，不抛。
export function normalizeDebugLines(body) {
  const raw = body && Array.isArray(body.lines) ? body.lines : []
  return raw
    .slice(0, DEBUG_LOG_MAX_LINES)
    .map((l) => (typeof l === 'string' ? l : String(l == null ? '' : l)))
}

// 纯判定：当前大小 + 本次写入是否越界。currentBytes <= 0 或本次空写不轮转
// （否则第一次写入就白白造出一个空的 debug.log.1）。
export function shouldRotate(currentBytes, incomingBytes, maxBytes = DEBUG_LOG_MAX_BYTES) {
  const cur = Number(currentBytes)
  const inc = Number(incomingBytes)
  const max = Number(maxBytes)
  if (!Number.isFinite(max) || max <= 0) return false
  if (!Number.isFinite(cur) || cur <= 0) return false
  if (!Number.isFinite(inc) || inc <= 0) return false
  return cur + inc > max
}

// 滚动：删最旧的，其余依次后移一位，现役转成 .1。任一步失败即停止（保留现场）。
export async function rotateDebugLog(file, keep = DEBUG_LOG_KEEP) {
  const slots = Math.max(1, Math.floor(Number(keep) || 0) || DEBUG_LOG_KEEP)
  try { await rm(rotatedDebugLogPath(file, slots), { force: true }) } catch (e) { /* 不存在即目标状态 */ }
  for (let i = slots - 1; i >= 1; i -= 1) {
    const from = rotatedDebugLogPath(file, i)
    const to = rotatedDebugLogPath(file, i + 1)
    try { await rename(from, to) } catch (e) {
      if (!(e && e.code === 'ENOENT')) return false
    }
  }
  try { await rename(file, rotatedDebugLogPath(file, 1)) } catch (e) {
    // 现役文件不存在（第一次写）→ 直接进入追加即可。
    return !!(e && e.code === 'ENOENT')
  }
  return true
}

/**
 * 追加一批埋点行，必要时先轮转。
 * @param {string} dir 状态目录（通常 ~/.dsh/sessions-manager）
 * @param {Array<string>} lines 已归一化的行
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep]
 * @param {Date|string} [options.now] 注入时钟，便于测试
 * @returns {Promise<{ path: string, bytes: number, rotated: boolean }>}
 */
export async function appendDebugLog(dir, lines, options = {}) {
  const list = Array.isArray(lines) ? lines : []
  const text = formatDebugLines(list, options.now instanceof Date || typeof options.now === 'string' ? options.now : new Date())
  const path = debugLogPath(dir)
  if (!text) return { path, bytes: 0, rotated: false }
  const bytes = Buffer.byteLength(text, 'utf8')
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEBUG_LOG_MAX_BYTES
  const keep = Number.isFinite(options.keep) && options.keep >= 1 ? Math.floor(options.keep) : DEBUG_LOG_KEEP
  let current = 0
  try {
    const info = await stat(path)
    if (info.isFile()) current = info.size
  } catch (e) { current = 0 }
  let rotated = false
  if (shouldRotate(current, bytes, maxBytes)) {
    try { rotated = await rotateDebugLog(path, keep) } catch (e) { rotated = false }
  }
  await mkdir(dir, { recursive: true })
  await appendFile(path, text, 'utf8')
  return { path, bytes, rotated }
}
