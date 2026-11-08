#!/usr/bin/env node
/**
 * compat-smoke.mjs — 对指定 runtime 版本做真实依赖冒烟。
 *
 * 用法：node scripts/compat-smoke.mjs <runtime-version>
 *
 * 插件 host 不直接 import @deepseek-ai/*（走 cordis 注入），client 对上游的
 * 直接依赖只有 react——所以真正的兼容风险是「真实 cordis 的 DI 契约」与
 * 「peer 包在该 runtime 版本下真实可解析」。本脚本：
 *
 *   1. 校验 @deepseek-ai/dsh@<V> 在 npm 上真实存在，并从它的 dependencies
 *      读出各 host peer 包在该版本闭包中的实际版本；
 *   2. 在临时目录按这些版本真实安装（--ignore-scripts，不跑原生脚本）；
 *   3. 用临时目录里的真实 cordis provide 假服务、apply 插件，
 *      断言全部 /archived-sessions/* 路由注册成功。
 *
 * 任何一步失败即退出码非 0。CI 每次 runtime 新版本 / 每日 cron 调用。
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const RUNTIME = process.argv[2]
if (!RUNTIME || RUNTIME.startsWith('-')) {
  console.error('用法: node scripts/compat-smoke.mjs <@deepseek-ai/dsh 版本，如 0.1.2-alpha.1>')
  process.exit(2)
}

// 与 src/index.js 的 inject 列表保持一致（外加 plugin get() 需要的 'sessions'）。
// v0.1：api-auth.js 认证门要求 connection 服务（owner-only、fail-closed）。
const HOST_INJECT = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery', 'storageDomain', 'connection']
const PKG_OF = {
  webServer: '@deepseek-ai/dsh-host-webserver',
  workspaceRegistry: '@deepseek-ai/dsh-workspace',
  sessionPersistence: '@deepseek-ai/dsh-session-persistence-jsonl',
  sessionQuery: '@deepseek-ai/dsh-session-query',
  storageDomain: '@deepseek-ai/dsh-storage-domain',
}
// （历史：曾用于整包安装清单；现 host peers 走假服务，该常量已无引用。
//  v0.1 起 HOST_INJECT 含 'connection'，其宿主提供包未在 PKG_OF 映射——若日后
//  恢复整包安装需先补全映射，故直接删除防止 undefined 混入。）

// Windows 下 npm 是 npm.cmd，spawnSync 不走 shell 解析不到。
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npm(...args) {
  // 强制官方 registry：本地 .npmrc 常配 npmmirror 镜像，新发布的 alpha/rc 版本镜像可能查不到。
  // win32 走 shell：Node ≥18.20 拒绝无 shell 直接执行 .cmd（EINVAL）。
  return execFileSync(NPM_BIN, ['--registry', 'https://registry.npmjs.org', ...args],
    { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 16 << 20, shell: process.platform === 'win32' })
}

function step(msg) { console.log(`\n→ ${msg}`) }

// ---- 1. runtime 版本存在性 + peer 版本闭包 -------------------------------
step(`查询 @deepseek-ai/dsh@${RUNTIME} 的依赖闭包`)
npm('view', `@deepseek-ai/dsh@${RUNTIME}`, 'version') // 存在性校验，404 即抛
let runtimeDeps = {}
try {
  runtimeDeps = JSON.parse(npm('view', `@deepseek-ai/dsh@${RUNTIME}`, 'dependencies', '--json') || '{}')
} catch { /* 无 dependencies 字段时按全 latest 处理 */ }

// 环境硬上限（2026-08 实测）：DSH 上游 peer 包（dsh-host-webserver 等）的依赖闭包
// 引用了 npm 上不存在的 @deepseek-ai/dsh-type-meta，裸 npm 装不齐——真实环境由壳内
// node_modules 供给。因此 CI 冒烟只装可独立安装的 cordis，host peers 走假服务。
const installs = []
const cordisPinned = runtimeDeps['@deepseek-ai/cordis']
installs.push(cordisPinned ? `@deepseek-ai/cordis@${cordisPinned}` : '@deepseek-ai/cordis')
console.log(`    @deepseek-ai/cordis@${cordisPinned ?? 'latest'}（其余 peer 裸 npm 装不齐，走假服务）`)

// ---- 2. 临时目录真实安装 -------------------------------------------------
const tmp = await mkdtemp(join(tmpdir(), 'dsm-compat-'))
let ok = false
try {
  step(`真实安装 ${installs.length} 个包 → ${tmp}`)
  execFileSync(NPM_BIN, ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--ignore-scripts',
    '--no-save', ...installs], { encoding: 'utf8', cwd: tmp, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })

  // ---- 3. 真实 cordis apply 插件 ----------------------------------------
  step('用真实 cordis 应用插件（DI 契约冒烟）')
  const tmpRequire = createRequire(join(tmp, 'noop.js'))
  const cordisEntry = tmpRequire.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisEntry))

  const domainState = { archivedSessionIds: [] }
  const routes = new Map()
  const fakeCtx = {
    workspaceRegistry: {
      list: () => [], state: domainState, archiveSession: async () => {},
    },
    sessionPersistence: {
      list: async () => [], locate: () => null, readFrom: async () => ({ meta: {}, events: [] }),
    },
    sessionQuery: {
      readTitleSnapshot: async () => ({ session: {}, title: {} }),
      readTitleSnapshots: async (ids) => ids.map(() => ({ status: 'fulfilled', value: { session: {}, title: {} } })),
    },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async () => {} } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    // v0.1 认证门：owner 冒烟身份。门本身的拒绝矩阵在 tests/api-auth.test.js。
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: (name) => name === 'sessions' ? { get: () => null, list: () => [], flush: async () => true, store: new Map() } : null,
    effect: (fn) => fn(),
  }

  const plugin = await import(pathToFileURL(join(REPO_ROOT, 'src', 'index.js')))
  const ctx = new Context(() => {}, { name: 'compat-smoke' })
  for (const name of HOST_INJECT) ctx.provide(name, fakeCtx[name])
  ctx.provide('sessions', fakeCtx.get('sessions'))
  await ctx.plugin(plugin)

  const expected = ['/archived-sessions/sessions', '/archived-sessions/trash/list', '/archived-sessions/move', '/archived-sessions/sidebar-state']
  for (const path of expected) {
    if (!routes.has(path)) throw new Error(`路由未注册: ${path}（cordis DI 契约可能已破坏）`)
  }
  console.log(`    ✓ ${routes.size} 条 /archived-sessions/* 路由全部注册成功`)

  // v0.1：认证门放行 owner 请求（用 capabilities 路由做最小冒烟）。
  const fakeRes = { status: 0, writeHead(code) { this.status = code }, end() {} }
  await routes.get('/archived-sessions/capabilities')({}, fakeRes)
  if (fakeRes.status !== 200) throw new Error(`认证门误拦 owner 冒烟请求（capabilities 返回 ${fakeRes.status}）`)
  console.log('    ✓ 认证门放行 owner 冒烟请求（capabilities → 200）')
  ok = true
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log(`\n✓ compat smoke PASS：runtime @deepseek-ai/dsh@${RUNTIME} 下 host DI 契约成立`)
if (!ok) process.exit(1)
