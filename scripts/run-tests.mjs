// Test runner: node --test with the API-auth escape hatch pre-set.
//
// Unit tests build fake plugin contexts that have no DSH connection service;
// the (correct, fail-closed) auth gate would 503 every route-test. The gate's
// own behavior is covered by tests/api-auth.test.js with explicit
// `bypass:false` — which wins over this env var by design.
//
// Test files are enumerated here (instead of relying on shell globs) so the
// runner behaves identically on cmd.exe and POSIX shells.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_SESSIONS_MANAGER_NO_AUTH = '1'

const testDir = join(process.cwd(), 'tests')
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDir, name))

if (!files.length) {
  console.error('no *.test.js files found under tests/')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: process.env,
})
process.exitCode = result.status ?? 1
