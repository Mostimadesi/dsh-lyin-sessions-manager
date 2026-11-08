// Owner-only, fail-closed gate for every /archived-sessions/* route.
//
// TOBYCAI upstream registers its /archived-sessions/* routes with no
// authentication middleware: any
// process that can reach the host port can read titles, move or delete
// sessions. hkkz9522/dsh-session-manager (MIT) solved this with
// authenticateApiRequest (connection.admit → rejection check → owner-only
// peer); this module ports those semantics onto the route-registration point
// of THIS plugin, so every route is wrapped exactly once.
//
// Discipline (all fail-closed):
// - connection service missing / admit not a function → 503 (never "allow")
// - admission falsy or non-object     → 401
// - admission.rejection present       → its status (401/403 semantics)
// - peer / peer.principal missing     → 401
// - peer.principal.kind !== 'owner'   → 403 (session management is privileged)
// - admit() throws                    → 403
//
// Escape hatch for unit tests and emergencies: DSH_SESSIONS_MANAGER_NO_AUTH=1
// bypasses the gate. It must be set BEFORE the host process starts.
//
// NOTE (fidelity to the ported original): hkkz9522's README mentions a
// requestRejection() call that does not actually exist in their code — the
// real mechanism is admit() + the `rejection` field, which is what we port.

function reply(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function safeErrorMessage(err) {
  try {
    return String((err && err.message) || err)
  } catch {
    return 'unknown error'
  }
}

/**
 * Build the route gate against a cordis-like context.
 * @param {object} ctx - plugin context; `ctx.connection` is the DSH connection service.
 * @param {object} [options]
 * @param {boolean} [options.bypass] - force-disable the gate (tests).
 */
export function createApiAuth(ctx, options = {}) {
  // Explicit `bypass` wins over the env escape hatch, so gate-specific tests
  // can exercise the real check even when the global test runner sets the env.
  const bypass = typeof options.bypass === 'boolean'
    ? options.bypass
    : process.env.DSH_SESSIONS_MANAGER_NO_AUTH === '1'

  function check(req) {
    if (bypass) return { ok: true }
    const connection = ctx && ctx.connection
    if (!connection || typeof connection.admit !== 'function') {
      return {
        ok: false,
        status: 503,
        code: 'auth-unavailable',
        error: 'DSH 认证服务未就绪或不可用，为保护数据安全已拒绝请求',
      }
    }
    try {
      const admission = connection.admit(req)
      if (!admission || typeof admission !== 'object') {
        return { ok: false, status: 401, code: 'unauthorized', error: '未授权：需要有效的 DSH 会话凭证' }
      }
      if ('rejection' in admission) {
        const status = typeof admission.rejection === 'number' ? admission.rejection : 401
        const error = status === 403
          ? '禁止访问：请求未通过 DSH 信任检查或跨站防护'
          : '未授权：需要有效的 DSH 会话凭证'
        return { ok: false, status, code: status === 403 ? 'forbidden' : 'unauthorized', error }
      }
      const peer = admission.peer
      if (!peer || typeof peer !== 'object') {
        return { ok: false, status: 401, code: 'unauthorized', error: '未授权：缺少有效 Peer 凭证' }
      }
      const principalKind = peer.principal && peer.principal.kind
      if (principalKind !== 'owner') {
        return { ok: false, status: 403, code: 'forbidden', error: '禁止访问：会话管理属于特权操作，需要 owner 权限' }
      }
      return { ok: true, peer }
    } catch (err) {
      return { ok: false, status: 403, code: 'auth-error', error: '认证检查失败: ' + safeErrorMessage(err) }
    }
  }

  /**
   * Wrap one route handler. The auth check runs BEFORE the handler touches
   * the request body (same order as the ported original).
   */
  function wrap(handler) {
    return async (req, res) => {
      const verdict = check(req)
      if (!verdict.ok) {
        reply(res, { ok: false, code: verdict.code, error: verdict.error }, verdict.status)
        return
      }
      return handler(req, res)
    }
  }

  return { check, wrap }
}
