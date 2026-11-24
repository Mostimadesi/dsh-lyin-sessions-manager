// 两个路由插件的落盘适配层（v3.15.0）。
//
// 这里只做文件 I/O：读 → 判定层（router-core.js）→ 原子写回。所有校验规则都在
// 判定层，所以 host 路由、测试、以及将来的其它入口跑的是同一套逻辑。
//
// 为什么要照它们的姿势写：
//   * 两个插件都用 `temp + rename` 原子写，读端（含它们自己 5 秒一次的
//     mtime/size 轮询）永远不会看到半截文件。我们照抄，否则它们可能读到
//     半个 JSON 并把「上一次的好表」当成现状。
//   * 写回的是 normalize() 之后的表，不是磁盘原文。这与两个插件自己的
//     `write()` 完全一致（它们也这么干），所以不会出现「面板写一次就把
//     `_examples` 弄丢、而 `/router` 写一次又弄丢别的东西」这种不一致。
//   * mode 0o600 在 NTFS 上不生效（它们的 README 也承认），照写不误。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  normalizeLlmSettings,
  normalizeSubagentSettings,
  applyLlmOp,
  applySubagentOp,
  crossCheck,
} from './router-core.js'

const LLM_DIR = 'llm-router'
const SUBAGENT_DIR = 'subagent-router'
const FILE_NAME = 'settings.json'

/** 与两个插件一致：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveDshHome({ env = process.env, home = homedir() } = {}) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(home, '.dsh')
}

export function llmSettingsPath(opts = {}) {
  if (opts.llmPath) return opts.llmPath
  return join(resolveDshHome(opts), LLM_DIR, FILE_NAME)
}

export function subagentSettingsPath(opts = {}) {
  if (opts.subagentPath) return opts.subagentPath
  return join(resolveDshHome(opts), SUBAGENT_DIR, FILE_NAME)
}

function fingerprintOf(file) {
  try {
    const info = statSync(file)
    return `${info.mtimeMs}:${info.size}`
  } catch (e) {
    return ''
  }
}

/**
 * 缓存一层指纹：面板一次打开会连发几个请求，没必要每个都重新 parse 一次
 * 几百行的 JSON。指纹只用来省 I/O，正确性靠「每次都 stat」。
 */
function makeCachedReader(file, normalize) {
  let cache = { fingerprint: '', value: undefined }
  return () => {
    const mark = fingerprintOf(file)
    if (cache.value !== undefined && cache.fingerprint === mark) {
      return { settings: cache.value, fingerprint: mark, missing: mark === '' }
    }
    let parsed
    let missing = false
    if (mark === '') {
      missing = true
      parsed = undefined
    } else {
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        // 文件在但读不动（手改坏了 / 写到一半断电）：交给 normalizer 收敛成
        // 默认表，**不要**沿用上次缓存——那样面板会显示一份并不存在的配置。
        parsed = undefined
      }
    }
    const settings = normalize(parsed)
    cache = { fingerprint: mark, value: settings }
    return { settings, fingerprint: mark, missing }
  }
}

/**
 * 原子写：旁边落 tmp 再 rename。失败时清掉 tmp，不留垃圾。
 * `backup` 为真时先落一份 `.bak-routerui-<时间戳>`，与 MCP 开关那边的做法一致。
 */
function writeAtomic(file, settings, { backup = true, now = () => new Date() } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let backupPath = null
  if (backup && existsSync(file)) {
    backupPath = `${file}.bak-routerui-${now().toISOString().replace(/[:.]/g, '-')}`
    try {
      writeFileSync(backupPath, readFileSync(file), { flag: 'wx' })
    } catch (e) {
      // 备份撞名（同一毫秒两次写）不该拦住真正的写。
      backupPath = null
    }
  }
  const temp = `${file}.tmp-routerui-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch (e) {
    try { unlinkSync(temp) } catch (e2) { /* ignore */ }
    throw e
  }
  return { backup: backupPath }
}

/**
 * 建一对读写器。`needsRestart` 恒为 false：两个插件都是指纹轮询，改完最多
 * 5 秒就自己重载了 —— 这一点和 MCP / profile 那类改动完全不同，界面文案要
 * 说清楚，否则用户会跑去重启。
 */
export function createRouterStore(options = {}) {
  const llmFile = llmSettingsPath(options)
  const subFile = subagentSettingsPath(options)
  const now = options.now || (() => new Date())
  const log = options.log || (() => {})

  const readLlmCached = makeCachedReader(llmFile, normalizeLlmSettings)
  const readSubCached = makeCachedReader(subFile, normalizeSubagentSettings)

  const readLlm = () => {
    const out = readLlmCached()
    return { ...out, file: llmFile }
  }
  const readSub = () => {
    const out = readSubCached()
    return { ...out, file: subFile }
  }

  const writeLlm = (settings) => {
    const normalized = normalizeLlmSettings(settings)
    const out = writeAtomic(llmFile, normalized, { now })
    if (out.backup) log(`router: wrote ${llmFile} (backup ${out.backup})`)
    return { settings: normalized, ...out, file: llmFile }
  }

  const writeSub = (settings) => {
    const normalized = normalizeSubagentSettings(settings)
    const out = writeAtomic(subFile, normalized, { now })
    if (out.backup) log(`router: wrote ${subFile} (backup ${out.backup})`)
    return { settings: normalized, ...out, file: subFile }
  }

  /** 一次调用同时给出两个表 + 跨文件一致性检查，面板打开时只发一个请求。 */
  const snapshot = () => {
    const llm = readLlm()
    const sub = readSub()
    return {
      llm: { ...llm.settings, file: llmFile, missing: llm.missing },
      subagent: { ...sub.settings, file: subFile, missing: sub.missing },
      check: crossCheck(llm.settings, sub.settings),
      needsRestart: false,
    }
  }

  /**
   * 执行一个编辑并落盘。`target` 是 'llm' 或 'subagent'。
   * 抛 RouterError（来自判定层）= 用户输入有问题，路由层翻成 400。
   */
  const apply = (target, op) => {
    if (target === 'llm') {
      const before = readLlm().settings
      const out = applyLlmOp(before, op)
      if (!out.changed) {
        return { target, changed: false, settings: before, file: llmFile, needsRestart: false }
      }
      const written = writeLlm(out.settings)
      return { target, changed: true, settings: written.settings, file: llmFile, backup: written.backup, needsRestart: false }
    }
    if (target === 'subagent') {
      const before = readSub().settings
      // reload-from-router 要拿 llm 的当前表，所以这里先读一次（有指纹缓存，便宜）。
      const llm = readLlm().settings
      const out = applySubagentOp(before, op, llm)
      if (!out.changed) {
        return { target, changed: false, settings: before, file: subFile, needsRestart: false }
      }
      const written = writeSub(out.settings)
      return { target, changed: true, settings: written.settings, file: subFile, backup: written.backup, needsRestart: false }
    }
    const error = new Error(`unknown router target: ${target}`)
    error.code = 'DSM_ROUTER_BAD_TARGET'
    throw error
  }

  return { llmFile, subFile, readLlm, readSub, writeLlm, writeSub, snapshot, apply }
}
