import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApiAuth } from '../src/api-auth.js'

// The gate must behave identically whether reached through `check` (unit) or
// `wrap` (route shape): wrap runs the check BEFORE the handler and never
// invokes the handler on rejection.

function fakeRes() {
  const res = {
    status: null,
    body: null,
    writeHead(status) { res.status = status },
    end(body) { res.body = body },
  }
  return res
}

function ownerConnection(overrides = {}) {
  return {
    admit(req) {
      if (overrides.throw) throw overrides.throw
      if ('admission' in overrides) return overrides.admission
      return { peer: { principal: { kind: 'owner' } } }
    },
  }
}

async function verdict(ctx, req = {}) {
  const auth = createApiAuth(ctx, { bypass: false })
  const res = fakeRes()
  let handlerRan = false
  const wrapped = auth.wrap(async () => { handlerRan = true })
  await wrapped(req, res)
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null, handlerRan }
}

test('missing connection service is fail-closed 503', async () => {
  const v = await verdict({})
  assert.equal(v.status, 503)
  assert.equal(v.body.code, 'auth-unavailable')
  assert.equal(v.handlerRan, false)
})

test('connection without admit() is fail-closed 503', async () => {
  const v = await verdict({ connection: {} })
  assert.equal(v.status, 503)
  assert.equal(v.handlerRan, false)
})

test('admit() returning null/undefined is 401', async () => {
  for (const admission of [null, undefined]) {
    const v = await verdict({ connection: ownerConnection({ admission }) })
    assert.equal(v.status, 401)
    assert.equal(v.body.code, 'unauthorized')
    assert.equal(v.handlerRan, false)
  }
})

test('admission.rejection 401/403 map to their statuses', async () => {
  const v401 = await verdict({ connection: ownerConnection({ admission: { rejection: 401 } }) })
  assert.equal(v401.status, 401)
  assert.equal(v401.body.code, 'unauthorized')
  const v403 = await verdict({ connection: ownerConnection({ admission: { rejection: 403 } }) })
  assert.equal(v403.status, 403)
  assert.equal(v403.body.code, 'forbidden')
  // Non-numeric rejection falls back to 401.
  const vDef = await verdict({ connection: ownerConnection({ admission: { rejection: 'nope' } }) })
  assert.equal(vDef.status, 401)
})

test('missing peer is 401; non-owner principal is 403', async () => {
  const noPeer = await verdict({ connection: ownerConnection({ admission: {} }) })
  assert.equal(noPeer.status, 401)
  const agent = await verdict({ connection: ownerConnection({ admission: { peer: { principal: { kind: 'agent' } } } }) })
  assert.equal(agent.status, 403)
  assert.equal(agent.body.code, 'forbidden')
})

test('owner passes and the handler runs', async () => {
  const v = await verdict({ connection: ownerConnection() })
  assert.equal(v.status, null)
  assert.equal(v.handlerRan, true)
})

test('admit() throwing is 403 auth-error, never a pass', async () => {
  const v = await verdict({ connection: ownerConnection({ throw: new Error('boom') }) })
  assert.equal(v.status, 403)
  assert.equal(v.body.code, 'auth-error')
  assert.equal(v.handlerRan, false)
})

test('the env escape hatch opens the gate; explicit bypass:false wins back', async () => {
  process.env.DSH_SESSIONS_MANAGER_NO_AUTH = '1'
  try {
    // Env set, no connection: gate opens.
    const opened = createApiAuth({})
    const res = fakeRes()
    let ran = false
    await opened.wrap(async () => { ran = true })({}, res)
    assert.equal(ran, true)
    assert.equal(res.status, null)

    // Explicit bypass:false re-closes the gate even with the env set.
    const v = await verdict({})
    assert.equal(v.status, 503)
    assert.equal(v.handlerRan, false)
  } finally {
    delete process.env.DSH_SESSIONS_MANAGER_NO_AUTH
  }
})
