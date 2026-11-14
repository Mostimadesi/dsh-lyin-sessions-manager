// zip-lite（v0.6.1）—— 只够用的 zip 读写，零依赖（node:zlib 提供 deflate）。
//
// 设计边界：
//   * 只支持 store(0) 与 deflate(8) 两种压缩方式，不支持加密、zip64、多卷。
//   * 不支持 zip64（遇到 0xFFFFFFFF 的尺寸/偏移直接报错，绝不猜）。
//   * 路径一律按 UTF-8 处理，写入时置 general purpose bit 11。
//
// 之所以自己写而不是引第三方：本插件零运行时依赖，且 dsh-purge 的
// lib/zip-extract.js 是商业闭源许可（禁止复制/修改/再分发），不能拿来用。

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const CEN_SIZE = 46
const LOC_SIZE = 30
const EOCD_SIZE = 22
const U32_MAX = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - (EOCD_SIZE + 0xffff))
  for (let i = buf.length - EOCD_SIZE; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 读 zip。返回 [{ name, data: Buffer, dir: boolean }]，顺序同中央目录。
 * 目录条目（名字以 / 结尾）保留但 data 为空。
 */
export function readZip(buf, { maxTotalBytes = 0 } = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error('readZip expects a Buffer')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('not a zip: end of central directory not found')
  const total = buf.readUInt16LE(eocd + 10)
  const cenOffset = buf.readUInt32LE(eocd + 16)
  if (cenOffset === U32_MAX) throw new Error('zip64 archives are not supported')

  const out = []
  let inflated = 0
  let p = cenOffset
  for (let i = 0; i < total; i++) {
    if (p + CEN_SIZE > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`)
    }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + CEN_SIZE, p + CEN_SIZE + nameLen)
    const next = p + CEN_SIZE + nameLen + extraLen + commentLen

    if (compSize === U32_MAX || uncompSize === U32_MAX || localOffset === U32_MAX) {
      throw new Error('zip64 entries are not supported')
    }
    if (name.endsWith('/')) {
      out.push({ name, data: Buffer.alloc(0), dir: true })
      p = next
      continue
    }

    if (localOffset + LOC_SIZE > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`corrupt local header for ${name}`)
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + LOC_SIZE + lNameLen + lExtraLen
    // 解压前先按中央目录声明的原始大小预判：压缩比极高的条目（32MB 的 zip
    // 能膨胀到几十 GB）如果等到 inflate 之后再判体积就晚了——那次分配已经发生。
    if (maxTotalBytes && uncompSize > maxTotalBytes) {
      throw new Error(`entry ${name} declares ${uncompSize} bytes, over the ${maxTotalBytes} byte limit`)
    }
    if (maxTotalBytes) {
      inflated += uncompSize
      if (inflated > maxTotalBytes) throw new Error(`archive inflates past the ${maxTotalBytes} byte limit`)
    }
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    // maxOutputLength 是真正的兜底：中央目录里的 uncompSize 是攻击者可写的，
    // 声明 100 字节、实际解出 4 GB 的条目只有这一层能拦住。
    else if (method === 8) data = maxTotalBytes ? inflateRawSync(raw, { maxOutputLength: maxTotalBytes }) : inflateRawSync(raw)
    else throw new Error(`unsupported compression method ${method} for ${name}`)
    if (uncompSize !== 0 && data.length !== uncompSize) {
      throw new Error(`size mismatch for ${name}: ${data.length} != ${uncompSize}`)
    }
    out.push({ name, data, dir: false })
    p = next
  }
  return out
}

function dosDateTime(date) {
  const year = date.getFullYear()
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff }
}

/**
 * 写 zip。entries: [{ name, data: Buffer|string }]。
 * 空目录用 name 以 / 结尾 + 空 data 表示。
 */
export function writeZip(entries, { date = new Date() } = {}) {
  const { dosDate, dosTime } = dosDateTime(date)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = String(entry.name || '').replace(/\\/g, '/')
    if (!name || name.startsWith('/') || name.includes('..')) {
      throw new Error(`unsafe zip entry name: ${JSON.stringify(name)}`)
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const deflated = data.length > 0 ? deflateRawSync(data, { level: 9 }) : Buffer.alloc(0)
    const useDeflate = deflated.length > 0 && deflated.length < data.length
    const method = useDeflate ? 8 : 0
    const body = useDeflate ? deflated : data

    const loc = Buffer.alloc(LOC_SIZE + nameBuf.length)
    loc.writeUInt32LE(LOC_SIG, 0)
    loc.writeUInt16LE(20, 4)
    loc.writeUInt16LE(0x0800, 6) // UTF-8 name
    loc.writeUInt16LE(method, 8)
    loc.writeUInt16LE(dosTime, 10)
    loc.writeUInt16LE(dosDate, 12)
    loc.writeUInt32LE(crc, 14)
    loc.writeUInt32LE(body.length, 18)
    loc.writeUInt32LE(data.length, 22)
    loc.writeUInt16LE(nameBuf.length, 26)
    loc.writeUInt16LE(0, 28)
    nameBuf.copy(loc, LOC_SIZE)

    const cen = Buffer.alloc(CEN_SIZE + nameBuf.length)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(dosTime, 12)
    cen.writeUInt16LE(dosDate, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    nameBuf.copy(cen, CEN_SIZE)

    locals.push(loc, body)
    centrals.push(cen)
    offset += loc.length + body.length
  }

  const cenBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(EOCD_SIZE)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cenBuf, eocd])
}

export default { crc32, readZip, writeZip }
