// 模型路由的纯判定层（v3.15.0）。
//
// 本机有两个插件把「模型路由」落成两个独立 JSON 文件：
//   ~/.dsh/llm-router/settings.json        —— 跨 provider 的候选链（路由组）
//   ~/.dsh/subagent-router/settings.json   —— 派给子代理的候选清单 + tier
// 两者都用 mtime/size 指纹 5 秒轮询，改文件即生效，因此本插件只需要「读到
// 一台规范化后的表 → 改 → 原样写回」，不需要调用它们的任何内部 API。
//
// 这个文件是那两个插件 normalizer 的镜像：**规则必须与它们一致**，否则它们
// 读回时会把我们写的东西再修一遍，界面上就会出现「改了又弹回去」。
// 对应源码：
//   MCP/llm-router/lib/settings.js   （parseCandidate / normalizeRoute / normalizeSettings）
//   MCP/llm-router/lib/routes.js     （addRoute / updateRoute / removeRoute / moveCandidate / setEnabled / setAnnounce）
//   MCP/subagent-router/lib/settings.js（parseCandidate / normalizeCandidate / normalizeSettings / readRouterCandidates）
//
// 无 `node:` 导入：host 与浏览器各打包一份，两边跑同一套判定。

/** 路由插件注册给 ctx.llm 的 provider id；它不能出现在自己的候选链里。 */
export const ROUTER_PROVIDER = 'llm-router'

export const LLM_SETTINGS_VERSION = 1
export const SUBAGENT_SETTINGS_VERSION = 1

export const STRATEGIES = Object.freeze(['fallback', 'round-robin'])
export const ANNOUNCE_MODES = Object.freeze(['off', 'switch', 'always'])
export const TIERS = Object.freeze(['light', 'heavy'])

/** 路由 id：不含空白、斜杠、反斜杠、?#%，最长 64。与插件内 regex 逐字一致。 */
export const ROUTE_ID_RE = /^[^\s/\\?#%]{1,64}$/u

/** 不该触发换候选的错误码（换了也没用）。 */
export const DEFAULT_NEVER_SWITCH = Object.freeze(['ABORTED', 'INVALID_REQUEST', 'INVALID_ARGS', 'INVALID_PREPARED_CALL'])

export const DEFAULT_COOLDOWN = Object.freeze({ shortMs: 5000, rateLimitMs: 60000, maxMs: 1800000 })

export const DEFAULT_LLM_SETTINGS = Object.freeze({
  version: LLM_SETTINGS_VERSION,
  enabled: true,
  displayName: 'LLM Router',
  defaultStrategy: 'fallback',
  stickyLimit: 1,
  neverSwitchOnCodes: DEFAULT_NEVER_SWITCH,
  switchOnCodes: [],
  announce: 'switch',
  cooldown: DEFAULT_COOLDOWN,
  routes: [],
})

/** 子代理候选的出厂清单（与 subagent-router 的 DEFAULT_CANDIDATES 一致）。 */
export const DEFAULT_SUBAGENT_CANDIDATES = Object.freeze([
  { provider: 'llm-router', model: 'DSV41flash', label: 'DeepSeek V4.1 Flash', tier: 'light' },
  { provider: 'llm-router', model: 'GLM5.3flash', label: 'GLM 5.3 Flash', tier: 'light' },
  { provider: 'llm-router', model: 'MiniMax', label: 'MiniMax M3.1 Flash', tier: 'light' },
  { provider: 'llm-router', model: 'GLM5.3', label: 'GLM 5.3', tier: 'heavy' },
  { provider: 'llm-router', model: 'Heavygroup', label: 'Heavy group', tier: 'heavy' },
])

export const DEFAULT_SUBAGENT_SETTINGS = Object.freeze({
  version: SUBAGENT_SETTINGS_VERSION,
  enabled: true,
  guidance: true,
  guidanceOrder: 2810,
  note: '',
  candidates: DEFAULT_SUBAGENT_CANDIDATES,
})

/** 编辑被拒（消息直接给用户看）。status 400：这些都是用户输入问题。 */
export class RouterError extends Error {
  constructor(message, code = 'DSM_ROUTER_BAD_EDIT') {
    super(message)
    this.name = 'RouterError'
    this.code = code
    this.status = 400
  }
}

// ---------------------------------------------------------------- 小工具

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.round(Math.min(Math.max(number, min), max))
}

function stringList(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
}

function asObject(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

// ---------------------------------------------------------------- llm-router

/**
 * `"provider/model"` / `"provider/model@effort"` / `{provider, model, reasoningEffort}`。
 * `provider === 'llm-router'` 一律拒绝：路由组不能把自己当候选（会无限递归）。
 */
export function parseCandidate(raw) {
  if (typeof raw === 'string') {
    const value = raw.trim()
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) return undefined
    const provider = value.slice(0, slash).trim()
    let model = value.slice(slash + 1).trim()
    if (!provider || !model) return undefined
    if (provider === ROUTER_PROVIDER) return undefined
    const at = model.lastIndexOf('@')
    if (at > 0 && at < model.length - 1) {
      const effort = model.slice(at + 1).trim()
      const rest = model.slice(0, at).trim()
      // `a/m@high@low` 有歧义：拒绝，而不是猜哪段是 effort。
      if (!/^[^\s@/]{1,32}$/u.test(effort) || rest.includes('@') || rest === '') return undefined
      return { provider, model: rest, reasoningEffort: effort }
    }
    return { provider, model }
  }
  const source = asObject(raw)
  const provider = text(source.provider)
  const model = text(source.model)
  if (!provider || !model) return undefined
  if (provider === ROUTER_PROVIDER) return undefined
  const effort = text(source.reasoningEffort)
  return effort === '' ? { provider, model } : { provider, model, reasoningEffort: effort }
}

/** 候选的唯一键（同一条链里重复的候选按它去重）。 */
export function candidateKey(candidate) {
  return `${candidate.provider}/${candidate.model}`
}

/** 链上候选的展示文本：`provider/model[@effort]`，可直接粘回输入框。 */
export function candidateLabel(candidate) {
  if (!candidate) return ''
  const base = `${candidate.provider}/${candidate.model}`
  return candidate.reasoningEffort === undefined ? base : `${base}@${candidate.reasoningEffort}`
}

export function normalizeLlmRoute(raw, index) {
  const source = asObject(raw)
  const id = text(source.id)
  if (id === '' || !ROUTE_ID_RE.test(id)) return undefined
  const chain = []
  const seen = new Set()
  for (const entry of Array.isArray(source.chain) ? source.chain : []) {
    const candidate = parseCandidate(entry)
    if (!candidate) continue
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(candidate)
  }
  if (chain.length === 0) return undefined
  const strategy = STRATEGIES.includes(source.strategy) ? source.strategy : undefined
  const effort = text(source.reasoningEffort)
  const announce = ANNOUNCE_MODES.includes(source.announce) ? source.announce : undefined
  const name = text(source.name)
  const description = text(source.description)
  return {
    id,
    name: name === '' ? id : name,
    ...(description === '' ? {} : { description }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(effort === '' ? {} : { reasoningEffort: effort }),
    ...(announce === undefined ? {} : { announce }),
    stickyLimit: clampInt(source.stickyLimit, 1, 1, 100),
    order: index,
    chain,
  }
}

/**
 * 把磁盘上的东西收敛成可用的表。永不抛。
 *
 * 与插件一致：**只保留已知键**，`_examples` 之类会被丢掉。写回时同样走这里，
 * 所以面板写出来的文件与 `/router` 命令写出来的字节形态一致。
 */
export function normalizeLlmSettings(raw) {
  const source = asObject(raw)
  const routes = []
  const ids = new Set()
  for (const entry of Array.isArray(source.routes) ? source.routes : []) {
    const route = normalizeLlmRoute(entry, routes.length)
    if (!route || ids.has(route.id)) continue
    ids.add(route.id)
    routes.push(route)
  }
  const cooldown = asObject(source.cooldown)
  const displayName = text(source.displayName)
  return {
    version: LLM_SETTINGS_VERSION,
    enabled: source.enabled !== false,
    displayName: displayName === '' ? DEFAULT_LLM_SETTINGS.displayName : displayName,
    defaultStrategy: STRATEGIES.includes(source.defaultStrategy) ? source.defaultStrategy : DEFAULT_LLM_SETTINGS.defaultStrategy,
    stickyLimit: clampInt(source.stickyLimit, DEFAULT_LLM_SETTINGS.stickyLimit, 1, 100),
    // 与插件一致：默认永不换的那几个始终并入，用户只能往上加。
    neverSwitchOnCodes: [...new Set([...DEFAULT_NEVER_SWITCH, ...stringList(source.neverSwitchOnCodes)])],
    switchOnCodes: [...new Set(stringList(source.switchOnCodes))],
    announce: ANNOUNCE_MODES.includes(source.announce) ? source.announce : DEFAULT_LLM_SETTINGS.announce,
    cooldown: {
      shortMs: clampInt(cooldown.shortMs, DEFAULT_COOLDOWN.shortMs, 0, 600000),
      rateLimitMs: clampInt(cooldown.rateLimitMs, DEFAULT_COOLDOWN.rateLimitMs, 0, 3600000),
      maxMs: clampInt(cooldown.maxMs, DEFAULT_COOLDOWN.maxMs, 0, 21600000),
    },
    routes,
  }
}

function requireRouteId(raw) {
  const id = text(raw)
  if (id === '') throw new RouterError('路由 id 不能为空')
  if (!ROUTE_ID_RE.test(id)) throw new RouterError(`"${id}" 不能当路由 id：不能有空格、斜杠、?#%，最长 64 个字符`)
  return id
}

function requireChain(raw) {
  const list = Array.isArray(raw) ? raw : []
  if (list.length === 0) throw new RouterError('一条路由至少要有一个候选，形如 provider/model')
  const chain = []
  const seen = new Set()
  const rejected = []
  for (const item of list) {
    const candidate = parseCandidate(item)
    if (candidate === undefined) {
      rejected.push(String(item))
      continue
    }
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(candidate)
  }
  if (rejected.length > 0) {
    throw new RouterError(`读不出 ${rejected.map((item) => `"${item}"`).join('、')}：候选要写成 provider/model（路由组不能当候选）`)
  }
  return chain
}

function requireStrategy(raw) {
  const value = text(raw)
  if (!STRATEGIES.includes(value)) throw new RouterError(`strategy 只能是 ${STRATEGIES.join(' / ')}`)
  return value
}

function requireAnnounce(raw) {
  const value = text(raw)
  if (!ANNOUNCE_MODES.includes(value)) throw new RouterError(`announce 只能是 ${ANNOUNCE_MODES.join(' / ')}`)
  return value
}

function requireInteger(raw, min, max, name) {
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new RouterError(`${name} 得是数字`)
  // 把 1.5 四舍五入成 2 等于存了一个用户没要的值，宁可报错。
  if (!Number.isInteger(value)) throw new RouterError(`${name} 得是整数`)
  if (value < min || value > max) throw new RouterError(`${name} 得在 ${min}..${max} 之间`)
  return value
}

function requireExistingRoute(settings, rawId) {
  const id = requireRouteId(rawId)
  const index = settings.routes.findIndex((route) => route.id === id)
  if (index < 0) {
    const known = settings.routes.map((route) => route.id).join('、')
    throw new RouterError(`没有 "${id}" 这条路由；现有：${known === '' ? '（无）' : known}`)
  }
  return index
}

/** 一条路由的展示文本：`id: a/x → b/y  [strategy, sticky N, announce x]`。 */
export function formatRoute(route) {
  const chain = route.chain.map(candidateLabel).join(' → ')
  const extras = [
    route.strategy,
    route.stickyLimit === undefined ? undefined : `sticky ${route.stickyLimit}`,
    route.announce === undefined ? undefined : `announce ${route.announce}`,
  ].filter(Boolean).join(', ')
  return `${route.id}: ${chain}${extras === '' ? '' : `  [${extras}]`}`
}

export function addRoute(settings, spec) {
  const source = asObject(spec)
  const id = requireRouteId(source.id)
  if (settings.routes.some((route) => route.id === id)) {
    throw new RouterError(`已经有 "${id}" 了；改它请用「编辑」或直接改链`)
  }
  const name = text(source.name)
  const description = text(source.description)
  const route = {
    id,
    name: name === '' ? id : name,
    ...(description === '' ? {} : { description }),
    ...(source.strategy === undefined ? {} : { strategy: requireStrategy(source.strategy) }),
    ...(source.announce === undefined ? {} : { announce: requireAnnounce(source.announce) }),
    // 新路由继承全局 sticky，这样手写的链与磁盘上读出来的读起来一致。
    stickyLimit: source.stickyLimit === undefined ? settings.stickyLimit : requireInteger(source.stickyLimit, 1, 100, 'stickyLimit'),
    order: settings.routes.length,
    chain: requireChain(source.chain),
  }
  return { settings: { ...settings, routes: [...settings.routes, route] }, route }
}

export function updateRoute(settings, rawId, patch) {
  const index = requireExistingRoute(settings, rawId)
  const previous = settings.routes[index]
  const source = asObject(patch)
  const next = { ...previous }
  if (source.chain !== undefined) next.chain = requireChain(source.chain)
  if (source.name !== undefined) {
    const name = text(source.name)
    if (name === '') throw new RouterError('名称不能为空')
    next.name = name
  }
  if (source.description !== undefined) {
    const description = text(source.description)
    if (description === '') delete next.description
    else next.description = description
  }
  if (source.strategy !== undefined) {
    // 传空串等于「回到全局默认」，所以先删掉覆盖再决定。
    if (text(source.strategy) === '') delete next.strategy
    else next.strategy = requireStrategy(source.strategy)
  }
  if (source.announce !== undefined) {
    if (text(source.announce) === '' || text(source.announce) === 'inherit') delete next.announce
    else next.announce = requireAnnounce(source.announce)
  }
  if (source.stickyLimit !== undefined) next.stickyLimit = requireInteger(source.stickyLimit, 1, 100, 'stickyLimit')
  const routes = [...settings.routes]
  routes[index] = next
  return { settings: { ...settings, routes }, route: next, previous }
}

export function removeRoute(settings, rawId) {
  const index = requireExistingRoute(settings, rawId)
  const removed = settings.routes[index]
  return { settings: { ...settings, routes: settings.routes.filter((_, at) => at !== index) }, route: removed }
}

/** 链内挪一个候选；`from` / `to` 是 1 起的序号（给人看的）。 */
export function moveCandidate(settings, rawId, from, to) {
  const index = requireExistingRoute(settings, rawId)
  const route = settings.routes[index]
  const size = route.chain.length
  const source = Number(from)
  const target = Number(to)
  if (!Number.isFinite(source) || !Number.isFinite(target)) throw new RouterError('位置得是数字')
  if (!Number.isInteger(source) || !Number.isInteger(target)) throw new RouterError('位置得是整数')
  if (source < 1 || source > size) throw new RouterError(`第 ${source} 个不在链上（1..${size}）`)
  if (target < 1 || target > size) throw new RouterError(`第 ${target} 个不在链上（1..${size}）`)
  const chain = [...route.chain]
  const [moved] = chain.splice(source - 1, 1)
  chain.splice(target - 1, 0, moved)
  const routes = [...settings.routes]
  routes[index] = { ...route, chain }
  return { settings: { ...settings, routes }, route: routes[index] }
}

/** 整个路由开关：坏链可以先停掉，不用删。幂等（值没变就不算改）。 */
export function setEnabled(settings, enabled) {
  const next = enabled === true
  if (settings.enabled === next) return { settings, enabled: next, changed: false }
  return { settings: { ...settings, enabled: next }, enabled: next, changed: true }
}

export function setAnnounce(settings, mode) {
  const announce = requireAnnounce(mode)
  if (settings.announce === announce) return { settings, announce, changed: false }
  return { settings: { ...settings, announce }, announce, changed: true }
}

export function setDefaultStrategy(settings, raw) {
  const strategy = requireStrategy(raw)
  if (settings.defaultStrategy === strategy) return { settings, strategy, changed: false }
  return { settings: { ...settings, defaultStrategy: strategy }, strategy, changed: true }
}

export function setGlobalSticky(settings, raw) {
  const stickyLimit = requireInteger(raw, 1, 100, 'stickyLimit')
  if (settings.stickyLimit === stickyLimit) return { settings, stickyLimit, changed: false }
  return { settings: { ...settings, stickyLimit }, stickyLimit, changed: true }
}

// ---------------------------------------------------------------- subagent-router

/** 子代理候选：`"provider/model"` 或 `{provider, model, label?, tier?}`。 */
export function parseSubagentCandidate(raw) {
  if (typeof raw === 'string') {
    const value = raw.trim()
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) return undefined
    return normalizeSubagentCandidate({ provider: value.slice(0, slash), model: value.slice(slash + 1) })
  }
  if (Array.isArray(raw)) return undefined
  return normalizeSubagentCandidate(raw)
}

export function normalizeSubagentCandidate(raw) {
  const source = asObject(raw)
  const provider = text(source.provider).slice(0, 64)
  const model = text(source.model).slice(0, 128)
  if (provider === '' || model === '') return undefined
  if (!ROUTE_ID_RE.test(provider)) return undefined
  // tier 只喂引导文案；遇到不认识的值退到 light 是安全侧（便宜的那个也答得出）。
  const tier = TIERS.includes(source.tier) ? source.tier : 'light'
  const candidate = { provider, model, tier }
  const label = text(source.label).slice(0, 64)
  if (label !== '') candidate.label = label
  return candidate
}

export function subagentCandidateId(candidate) {
  return `${candidate.provider}/${candidate.model}`
}

export function normalizeSubagentSettings(raw) {
  const source = asObject(raw)
  const seen = new Set()
  const candidates = []
  for (const entry of Array.isArray(source.candidates) ? source.candidates : []) {
    const candidate = parseSubagentCandidate(entry)
    if (candidate === undefined) continue
    const id = subagentCandidateId(candidate)
    if (seen.has(id)) continue
    seen.add(id)
    candidates.push(candidate)
  }
  const note = text(source.note)
  return {
    version: SUBAGENT_SETTINGS_VERSION,
    enabled: source.enabled !== false,
    // 手改坏的文件丢了清单也得能用：回落到出厂候选。
    candidates: candidates.length > 0 ? candidates : DEFAULT_SUBAGENT_CANDIDATES.map((entry) => ({ ...entry })),
    guidance: source.guidance !== false,
    guidanceOrder: Number.isFinite(source.guidanceOrder) ? source.guidanceOrder : 2810,
    note: note.length > 400 ? `${note.slice(0, 400)}…` : note,
  }
}

function requireExistingCandidate(settings, rawProvider, rawModel) {
  const provider = text(rawProvider)
  const model = text(rawModel)
  const index = settings.candidates.findIndex((item) => item.provider === provider && item.model === model)
  if (index < 0) throw new RouterError(`候选里没有 ${provider}/${model}`)
  return index
}

export function addSubagentCandidate(settings, spec) {
  const source = asObject(spec)
  const candidate = normalizeSubagentCandidate({
    provider: source.provider,
    model: source.model,
    label: source.label,
    tier: source.tier,
  })
  if (candidate === undefined) throw new RouterError('候选要有 provider 与 model，形如 llm-router/GLM5.3')
  const id = subagentCandidateId(candidate)
  if (settings.candidates.some((item) => subagentCandidateId(item) === id)) {
    throw new RouterError(`候选里已经有 ${id} 了`)
  }
  return { settings: { ...settings, candidates: [...settings.candidates, candidate] }, candidate }
}

export function updateSubagentCandidate(settings, rawProvider, rawModel, patch) {
  const index = requireExistingCandidate(settings, rawProvider, rawModel)
  const previous = settings.candidates[index]
  const source = asObject(patch)
  const next = { ...previous }
  if (source.tier !== undefined) {
    const tier = text(source.tier)
    if (!TIERS.includes(tier)) throw new RouterError(`tier 只能是 ${TIERS.join(' / ')}`)
    next.tier = tier
  }
  if (source.label !== undefined) {
    const label = text(source.label).slice(0, 64)
    if (label === '') delete next.label
    else next.label = label
  }
  const candidates = [...settings.candidates]
  candidates[index] = next
  return { settings: { ...settings, candidates }, candidate: next, previous }
}

export function removeSubagentCandidate(settings, rawProvider, rawModel) {
  const index = requireExistingCandidate(settings, rawProvider, rawModel)
  const removed = settings.candidates[index]
  const candidates = settings.candidates.filter((_, at) => at !== index)
  if (candidates.length === 0) {
    // 空清单会被 normalizer 回落到出厂候选，等于「删了又全回来」。直说。
    throw new RouterError('至少留一个候选：全删光会被插件回落到出厂清单')
  }
  return { settings: { ...settings, candidates }, candidate: removed }
}

export function moveSubagentCandidate(settings, from, to) {
  const size = settings.candidates.length
  const source = Number(from)
  const target = Number(to)
  if (!Number.isFinite(source) || !Number.isFinite(target)) throw new RouterError('位置得是数字')
  if (!Number.isInteger(source) || !Number.isInteger(target)) throw new RouterError('位置得是整数')
  if (source < 1 || source > size) throw new RouterError(`第 ${source} 个不在清单里（1..${size}）`)
  if (target < 1 || target > size) throw new RouterError(`第 ${target} 个不在清单里（1..${size}）`)
  const candidates = [...settings.candidates]
  const [moved] = candidates.splice(source - 1, 1)
  candidates.splice(target - 1, 0, moved)
  return { settings: { ...settings, candidates }, candidate: moved }
}

export function setSubagentEnabled(settings, enabled) {
  const next = enabled === true
  if (settings.enabled === next) return { settings, enabled: next, changed: false }
  return { settings: { ...settings, enabled: next }, enabled: next, changed: true }
}

export function setGuidance(settings, guidance) {
  const next = guidance !== false
  if (settings.guidance === next) return { settings, guidance: next, changed: false }
  return { settings: { ...settings, guidance: next }, guidance: next, changed: true }
}

export function setGuidanceOrder(settings, raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new RouterError('guidanceOrder 得是整数')
  if (settings.guidanceOrder === value) return { settings, guidanceOrder: value, changed: false }
  return { settings: { ...settings, guidanceOrder: value }, guidanceOrder: value, changed: true }
}

export function setSubagentNote(settings, raw) {
  const note = text(raw).slice(0, 400)
  if (settings.note === note) return { settings, note, changed: false }
  return { settings: { ...settings, note }, note, changed: true }
}

/**
 * 把 llm-router 当前的路由组**追加**进候选（只加不改），对应 `/subagent-router reload`。
 * 已存在的同名候选不动——用户手工调过的 tier/label 不该被覆盖。
 */
export function appendRouterCandidates(subagentSettings, llmSettings) {
  const existing = new Set(subagentSettings.candidates.map(subagentCandidateId))
  const added = []
  for (const route of llmSettings.routes) {
    if (route.enabled === false) continue
    if (!Array.isArray(route.chain) || route.chain.length === 0) continue
    const candidate = {
      provider: ROUTER_PROVIDER,
      model: route.id,
      label: route.name || route.id,
      // 路由表没有 tier 列（它的 normalizer 会丢掉未知键），借来的一律 light。
      tier: 'light',
    }
    const id = subagentCandidateId(candidate)
    if (existing.has(id)) continue
    existing.add(id)
    added.push(candidate)
  }
  if (added.length === 0) return { settings: subagentSettings, added, changed: false }
  return { settings: { ...subagentSettings, candidates: [...subagentSettings.candidates, ...added] }, added, changed: true }
}

// ---------------------------------------------------------------- 操作分发
//
// host 路由与测试共用这一个入口：`op` 是 `{ action, ... }`，返回
// `{ settings, changed, detail? }`。抛 RouterError 表示用户输入有问题。

export function applyLlmOp(settings, op) {
  const source = asObject(op)
  const action = text(source.action)
  switch (action) {
    case 'set-enabled': {
      const out = setEnabled(settings, source.enabled)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-announce': {
      const out = setAnnounce(settings, source.mode)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-default-strategy': {
      const out = setDefaultStrategy(settings, source.strategy)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-global-sticky': {
      const out = setGlobalSticky(settings, source.stickyLimit)
      return { settings: out.settings, changed: out.changed }
    }
    case 'add-route': {
      const out = addRoute(settings, source)
      return { settings: out.settings, changed: true, detail: out.route }
    }
    case 'update-route': {
      const out = updateRoute(settings, source.id, source.patch)
      return { settings: out.settings, changed: true, detail: out.route }
    }
    case 'remove-route': {
      const out = removeRoute(settings, source.id)
      return { settings: out.settings, changed: true, detail: out.route }
    }
    case 'move-candidate': {
      const out = moveCandidate(settings, source.id, source.from, source.to)
      return { settings: out.settings, changed: true, detail: out.route }
    }
    case 'set-chain': {
      // 「整条链换掉」是为了让界面能用「一行一个候选」的文本框编辑，
      // 语义等同 update-route 只传 chain。
      const out = updateRoute(settings, source.id, { chain: source.chain })
      return { settings: out.settings, changed: true, detail: out.route }
    }
    default:
      throw new RouterError(`未知的 LLM 路由操作：${action === '' ? '（空）' : action}`, 'DSM_ROUTER_BAD_ACTION')
  }
}

export function applySubagentOp(settings, op, llmSettings) {
  const source = asObject(op)
  const action = text(source.action)
  switch (action) {
    case 'set-enabled': {
      const out = setSubagentEnabled(settings, source.enabled)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-guidance': {
      const out = setGuidance(settings, source.guidance)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-guidance-order': {
      const out = setGuidanceOrder(settings, source.guidanceOrder)
      return { settings: out.settings, changed: out.changed }
    }
    case 'set-note': {
      const out = setSubagentNote(settings, source.note)
      return { settings: out.settings, changed: out.changed }
    }
    case 'add-candidate': {
      const out = addSubagentCandidate(settings, source)
      return { settings: out.settings, changed: true, detail: out.candidate }
    }
    case 'update-candidate': {
      const out = updateSubagentCandidate(settings, source.provider, source.model, source.patch)
      return { settings: out.settings, changed: true, detail: out.candidate }
    }
    case 'remove-candidate': {
      const out = removeSubagentCandidate(settings, source.provider, source.model)
      return { settings: out.settings, changed: true, detail: out.candidate }
    }
    case 'move-candidate': {
      const out = moveSubagentCandidate(settings, source.from, source.to)
      return { settings: out.settings, changed: true, detail: out.candidate }
    }
    case 'reload-from-router': {
      const out = appendRouterCandidates(settings, llmSettings || normalizeLlmSettings(undefined))
      return { settings: out.settings, changed: out.changed, detail: out.added }
    }
    default:
      throw new RouterError(`未知的子代理路由操作：${action === '' ? '（空）' : action}`, 'DSM_ROUTER_BAD_ACTION')
  }
}

// ---------------------------------------------------------------- 一致性检查
//
// 只做「跨文件」的那两项（插件自己不管这些）：子代理候选引用的路由组是否存在、
// 链上是否还有候选被两个插件同时需要但已被删。纯本地比较，不联网。

export function crossCheck(llmSettings, subagentSettings) {
  const routeIds = new Set(llmSettings.routes.map((route) => route.id))
  const dangling = []
  for (const candidate of subagentSettings.candidates) {
    if (candidate.provider !== ROUTER_PROVIDER) continue
    if (!routeIds.has(candidate.model)) dangling.push(subagentCandidateId(candidate))
  }
  const usedGroups = new Set(
    subagentSettings.candidates.filter((item) => item.provider === ROUTER_PROVIDER).map((item) => item.model),
  )
  const unusedRoutes = llmSettings.routes
    .filter((route) => !usedGroups.has(route.id))
    .map((route) => route.id)
  return { dangling, unusedRoutes }
}
