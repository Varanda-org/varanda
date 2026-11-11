'use strict'

// src/usePhoneGate.js without React, on the pattern of useAgeMemory.test.js:
// 'react' is replaced with a stub that forwards to a small hook runtime kept
// in globalThis.__phoneReact (state, refs and effects with dependencies, a
// render after every state change), and './account' with a stub forwarding
// to globalThis.__phoneAccount, so each test scripts the service.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const hooks = `
const react = 'const R = () => globalThis.__phoneReact; export const useState = (v) => R().useState(v); export const useRef = (v) => R().useRef(v); export const useEffect = (f, d) => R().useEffect(f, d); export const useCallback = (f, d) => R().useCallback(f, d)'
const account = 'const A = () => globalThis.__phoneAccount; export const phonePolicy = (...a) => A().phonePolicy(...a); export const phoneSince = (...a) => A().phoneSince(...a); export const phoneStart = (...a) => A().phoneStart(...a); export const phoneStatus = (...a) => A().phoneStatus(...a); export const phoneSend = (...a) => A().phoneSend(...a); export const phoneCheck = (...a) => A().phoneCheck(...a)'
const ui = 'export const errorText = (e) => (e && e.message) || "erro"'
const installation = 'export const installationOrigin = () => globalThis.__phoneOriginPin !== undefined ? globalThis.__phoneOriginPin : globalThis.__phoneOrigin'
export async function resolve (specifier, context, next) {
  if (specifier === 'react') return { url: 'data:text/javascript,' + encodeURIComponent(react), shortCircuit: true }
  if (specifier === './account' && context.parentURL && context.parentURL.includes('/src/')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(account), shortCircuit: true }
  }
  if (specifier === './installation' && context.parentURL && context.parentURL.includes('/src/')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(installation), shortCircuit: true }
  }
  if (specifier === './ui' && context.parentURL && context.parentURL.includes('/src/')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(ui), shortCircuit: true }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = () => import('../src/usePhoneGate.js')
const loadVerify = () => import('../src/usePhoneVerify.js')

const M = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ORIGIN = 'https://varanda.example.test'
const DATE = '2026-11-11T12:00:00.000Z'
const PROOF = { v: 1, kind: 'phone-verified', sig: 'x' }
const SINCE = { v: 1, kind: 'phone-since', sig: 'y' }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function deferred () {
  let settle, fail
  const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject })
  return { promise, resolve: settle, reject: fail }
}

// Enough of React for one hook: slots by call order, effects run after the
// render when their dependencies changed (cleanup first), and a state change
// renders again, synchronously unless a render is under way.
function runtime (hook) {
  const slots = []
  let i = 0
  let queue = []
  let rendering = false
  let dirty = false
  let props = null
  let out = null
  let alive = true
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, j) => Object.is(x, b[j]))
  const render = () => {
    if (!alive) return
    if (rendering) { dirty = true; return }
    rendering = true
    try {
      do {
        dirty = false
        i = 0
        queue = []
        out = hook(props)
        for (const e of queue) {
          const slot = slots[e.idx]
          if (slot && typeof slot.cleanup === 'function') slot.cleanup()
          slots[e.idx] = { deps: e.deps, cleanup: undefined }
          slots[e.idx].cleanup = e.f()
        }
      } while (dirty)
    } finally {
      rendering = false
    }
  }
  const api = {
    useState (init) {
      const idx = i++
      if (!slots[idx]) slots[idx] = { value: typeof init === 'function' ? init() : init }
      const slot = slots[idx]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        render()
      }]
    },
    useRef (init) {
      const idx = i++
      if (!slots[idx]) slots[idx] = { current: init }
      return slots[idx]
    },
    useCallback (f, deps) {
      const idx = i++
      if (!slots[idx] || !same(slots[idx].deps, deps)) slots[idx] = { f, deps }
      return slots[idx].f
    },
    useEffect (f, deps) {
      const idx = i++
      const slot = slots[idx]
      if (!slot || !Array.isArray(deps) || !same(slot.deps, deps)) queue.push({ idx, f, deps })
    }
  }
  return {
    api,
    rerender (next) {
      props = { ...props, ...next }
      globalThis.__phoneReact = api
      render()
      return out
    },
    get out () { return out },
    unmount () {
      alive = false
      for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup()
    }
  }
}

// The account service, scripted per test. Anything not set never settles,
// except phoneSince, which answers null by default (nothing to store).
function fakeAccount (over = {}) {
  const calls = []
  let nonces = 0
  const never = () => new Promise(() => {})
  const pick = (name, fallback) => (...a) => {
    calls.push([name, ...a])
    return typeof over[name] === 'function' ? over[name](...a) : fallback(...a)
  }
  globalThis.__phoneAccount = {
    phonePolicy: pick('phonePolicy', never),
    phoneSince: pick('phoneSince', async () => null),
    phoneStart: pick('phoneStart', async () => ({ nonce: 'n' + (++nonces) })),
    phoneStatus: pick('phoneStatus', never),
    phoneSend: pick('phoneSend', never),
    phoneCheck: pick('phoneCheck', never)
  }
  return calls
}

// proofFails: how many phone.proof calls with `verified` the node refuses.
function fakeNode ({ proofFails = 0 } = {}) {
  const calls = []
  let fails = proofFails
  const node = {
    online: true,
    request: async (method, params) => {
      calls.push([method, params])
      if (method === 'phone.sign') return { signature: 's' }
      if (method === 'phone.proof' && 'verified' in params && fails > 0) {
        fails--
        throw new Error('nó ocupado')
      }
      return {}
    }
  }
  return { node, calls }
}

async function mount (t, account, props = {}, nodeOpts = {}) {
  const { usePhoneGate } = await load()
  const calls = fakeAccount(account)
  const { node, calls: nodeCalls } = fakeNode(nodeOpts)
  let afterProof = 0
  // The installation the calls go to follows the rendered origin, unless a
  // test pins it (__phoneOriginPin) to play an installation switch under way.
  const r = runtime((p) => {
    globalThis.__phoneOrigin = p.origin
    return usePhoneGate(p)
  })
  t.teardown(() => r.unmount())
  r.rerender({
    node,
    info: null,
    hosted: true,
    ready: true,
    termsOk: true,
    locked: false,
    member: M,
    origin: ORIGIN,
    generation: 1,
    afterProof: () => { afterProof++ },
    ...props
  })
  await tick()
  return { r, calls, nodeCalls, afterProofs: () => afterProof, node }
}

const proofsSent = (nodeCalls) => nodeCalls.filter(([m]) => m === 'phone.proof').map(([, p]) => p)

test('phoneProofs: only canonical dates in node.info about this member count', async (t) => {
  const { phoneProofs, isIsoDate } = await load()
  t.alike(phoneProofs({ publicKey: M, phoneVerifiedDate: DATE, phoneSince: DATE }, M), { known: true, vouched: true, sinceHeld: true })
  t.alike(phoneProofs({ publicKey: M, phoneVerifiedDate: null, phoneSince: null }, M), { known: true, vouched: false, sinceHeld: false })
  t.alike(phoneProofs({ publicKey: OTHER, phoneVerifiedDate: DATE, phoneSince: DATE }, M), { known: false, vouched: false, sinceHeld: false }, 'another key proves nothing')
  t.alike(phoneProofs(null, M), { known: false, vouched: false, sinceHeld: false })
  t.alike(phoneProofs({ publicKey: M, phoneVerifiedDate: DATE }, null), { known: false, vouched: false, sinceHeld: false })
  t.is(isIsoDate('2026-11-11T12:00:00Z'), false, 'not canonical')
  t.is(isIsoDate('2026-02-30T12:00:00.000Z'), false)
  t.is(isIsoDate(Date.parse(DATE)), false)
  t.is(isIsoDate(DATE), true)
})

test('loading while the first policy read is in flight', async (t) => {
  const { r, calls } = await mount(t, {})
  t.is(r.out.gate, 'loading')
  t.is(r.out.pending, true)
  t.is(calls.filter(([n]) => n === 'phonePolicy').length, 1, 'one read')
  t.is(calls.filter(([n]) => n === 'phoneStart').length, 0, 'no status read before the policy')
})

test('off on required false, with no status read', async (t) => {
  const { r, calls } = await mount(t, { phonePolicy: async () => ({ required: false }) })
  t.is(r.out.gate, 'off')
  t.is(calls.filter(([n]) => n === 'phoneStart').length, 0)
})

test('off when not hosted, without asking anything', async (t) => {
  const { r, calls } = await mount(t, {}, { hosted: false })
  t.is(r.out.gate, 'off')
  t.is(calls.filter(([n]) => n === 'phonePolicy').length, 0)
})

test('a failed policy read: the node proofs decide, once node.info is known', async (t) => {
  const fail = { phonePolicy: async () => null }
  const vouched = await mount(t, fail, { info: { publicKey: M, phoneVerifiedDate: DATE, phoneSince: null } })
  t.is(vouched.r.out.gate, 'ok', 'a vouching node proof opens it')
  const since = await mount(t, fail, { info: { publicKey: M, phoneVerifiedDate: null, phoneSince: DATE } })
  t.is(since.r.out.gate, 'needed', 'a held since keeps the step')
  const neither = await mount(t, fail, { info: { publicKey: M, phoneVerifiedDate: null, phoneSince: null } })
  t.is(neither.r.out.gate, 'off', 'neither: as before the check existed')
  const unknown = await mount(t, fail, { info: null })
  t.is(unknown.r.out.gate, 'loading', 'node.info not read yet')
  const other = await mount(t, fail, { info: { publicKey: OTHER, phoneVerifiedDate: DATE, phoneSince: null } })
  t.is(other.r.out.gate, 'loading', 'node.info of another key')
  t.is(neither.calls.filter(([n]) => n === 'phoneStart').length, 0, 'no status read on an unknown policy')
})

test('a failed policy read is tried again when the connection comes back', async (t) => {
  let answer = null
  const { r, calls, node } = await mount(t, { phonePolicy: async () => answer })
  t.is(r.out.gate, 'loading')
  answer = { required: false }
  node.online = false
  r.rerender({})
  node.online = true
  r.rerender({})
  await tick()
  t.is(calls.filter(([n]) => n === 'phonePolicy').length, 2)
  t.is(r.out.gate, 'off')
})

test('closed while the status read fails, unless the node vouches', async (t) => {
  const err = Object.assign(new Error('serviço indisponível'), { code: 'indisponivel' })
  const failing = { phonePolicy: async () => ({ required: true }), phoneStart: async () => { throw err } }
  const plain = await mount(t, failing, { info: { publicKey: M, phoneVerifiedDate: null, phoneSince: null } })
  t.is(plain.r.out.gate, 'loading', 'blocking')
  t.is(plain.r.out.error, err, 'the error is handed to the screen')
  t.is(plain.r.out.pending, false, 'nothing in flight')
  const vouched = await mount(t, failing, { info: { publicKey: M, phoneVerifiedDate: DATE, phoneSince: null } })
  t.is(vouched.r.out.gate, 'ok')
  t.is(proofsSent(vouched.nodeCalls).filter((p) => 'verified' in p).length, 0, 'a failure changes nothing the node holds')
})

test('open after a verificado status, the proof stored through phone.proof', async (t) => {
  const { r, calls, nodeCalls, afterProofs } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => ({ state: 'verificado', proof: PROOF })
  })
  t.is(r.out.gate, 'ok')
  t.is(r.out.state, 'verificado')
  const status = calls.find(([n]) => n === 'phoneStatus')
  t.alike(status[1], { member: M, nonce: 'n1', signature: 's' }, 'a fresh nonce, signed by the node')
  t.alike(nodeCalls.find(([m]) => m === 'phone.sign')[1], { action: 'status', nonce: 'n1' })
  t.alike(proofsSent(nodeCalls).filter((p) => 'verified' in p), [{ verified: PROOF }])
  t.ok(afterProofs() >= 1, 'node.info read again')
})

test('nenhum closes even with a stored proof, and clears it', async (t) => {
  const { r, nodeCalls } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => ({ state: 'nenhum' })
  }, { info: { publicKey: M, phoneVerifiedDate: DATE, phoneSince: DATE } })
  t.is(r.out.gate, 'needed')
  t.alike(proofsSent(nodeCalls).filter((p) => 'verified' in p), [{ verified: null }])
})

test('recheck asks again with a new nonce; markVerified opens and stores', async (t) => {
  let n = 0
  const { r, calls, nodeCalls } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStart: async () => ({ nonce: 'nonce' + (++n) }),
    phoneStatus: async () => ({ state: 'nenhum' })
  })
  t.is(r.out.gate, 'needed')
  r.out.recheck()
  await tick()
  const nonces = calls.filter(([c]) => c === 'phoneStatus').map(([, b]) => b.nonce)
  t.alike(nonces, ['nonce1', 'nonce2'], 'never the same nonce twice')
  r.out.markVerified(PROOF, r.out.key)
  await tick()
  t.is(r.out.gate, 'ok')
  t.alike(proofsSent(nodeCalls).filter((p) => p.verified !== null && 'verified' in p), [{ verified: PROOF }])
})

test('markVerified wins over a status read still in flight', async (t) => {
  const status = deferred()
  const { r, nodeCalls } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: () => status.promise
  })
  t.is(r.out.gate, 'loading')
  r.out.markVerified(PROOF, r.out.key)
  status.resolve({ state: 'nenhum' })
  await tick()
  t.is(r.out.gate, 'ok')
  t.absent(proofsSent(nodeCalls).some((p) => p.verified === null), 'the late nenhum clears nothing')
})

test('the since effect stores the since and sends null to clear', async (t) => {
  const held = await mount(t, { phoneSince: async () => SINCE })
  t.alike(proofsSent(held.nodeCalls).filter((p) => 'since' in p), [{ since: SINCE }])
  t.ok(held.afterProofs() >= 1)
  const cleared = await mount(t, { phoneSince: async () => null })
  t.alike(proofsSent(cleared.nodeCalls).filter((p) => 'since' in p), [{ since: null }])
  const failed = await mount(t, { phoneSince: async () => undefined })
  t.is(proofsSent(failed.nodeCalls).filter((p) => 'since' in p).length, 0, 'a failure sends nothing')
  const pendingRead = await mount(t, { phoneSince: () => new Promise(() => {}) })
  t.is(proofsSent(pendingRead.nodeCalls).length, 0, 'a read that never settles (the Vitrine) sends nothing')
  const locked = await mount(t, { phoneSince: async () => SINCE }, { locked: true })
  t.is(proofsSent(locked.nodeCalls).length, 0, 'not while locked')
})

test('the since is sent once per generation and installation', async (t) => {
  const { r, nodeCalls } = await mount(t, { phoneSince: async () => SINCE })
  r.rerender({ info: { publicKey: M } })
  await tick()
  t.is(proofsSent(nodeCalls).filter((p) => 'since' in p).length, 1)
  r.rerender({ generation: 2 })
  await tick()
  t.is(proofsSent(nodeCalls).filter((p) => 'since' in p).length, 2, 'again after a reset')
})

test('stale answers are dropped', async (t) => {
  const status = deferred()
  let first = true
  const { r, nodeCalls } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: () => {
      if (first) { first = false; return status.promise }
      return new Promise(() => {})
    }
  })
  r.rerender({ member: OTHER })
  await tick()
  status.resolve({ state: 'nenhum' })
  await tick()
  t.is(r.out.state, undefined, 'the old member answer is not shown')
  t.is(r.out.gate, 'loading')
  t.absent(proofsSent(nodeCalls).some((p) => 'verified' in p), 'nothing cleared for the next member')

  const late = deferred()
  const again = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: () => late.promise
  })
  again.r.rerender({ locked: true })
  late.resolve({ state: 'verificado', proof: PROOF })
  await tick()
  t.is(again.r.out.gate, 'loading')
  t.absent(proofsSent(again.nodeCalls).some((p) => 'verified' in p), 'a lock drops the answer')

  const gen = deferred()
  let once = true
  const third = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: () => {
      if (once) { once = false; return gen.promise }
      return new Promise(() => {})
    }
  })
  third.r.rerender({ generation: 2 })
  gen.resolve({ state: 'nenhum' })
  await tick()
  t.absent(proofsSent(third.nodeCalls).some((p) => 'verified' in p), 'a reset drops the answer')
})

test('a policy answer from another installation is not used', async (t) => {
  const p = deferred()
  let once = true
  const { r } = await mount(t, {
    phonePolicy: () => {
      if (once) { once = false; return p.promise }
      return new Promise(() => {})
    }
  })
  r.rerender({ origin: 'https://outra.example.test' })
  p.resolve({ required: false })
  await tick()
  t.is(r.out.gate, 'loading')
})

const reconnect = (r, node) => {
  node.online = false
  r.rerender({})
  node.online = true
  r.rerender({})
}

test('markVerified applies only under the key its request started with', async (t) => {
  const { r, nodeCalls } = await mount(t, { phonePolicy: async () => ({ required: true }) })
  const started = r.out.key
  t.is(started, '1#' + M + '#' + ORIGIN)
  r.rerender({ origin: 'https://outra.example.test' })
  r.out.markVerified(PROOF, started)
  await tick()
  t.is(r.out.gate, 'loading', 'another installation stays closed')
  r.rerender({ origin: ORIGIN, generation: 2 })
  r.out.markVerified(PROOF, started)
  r.out.markVerified(PROOF)
  await tick()
  t.is(r.out.gate, 'loading', 'another generation stays closed, and a missing key counts as stale')
  r.rerender({ locked: true, generation: 1 })
  r.out.markVerified(PROOF, started)
  await tick()
  t.is(r.out.state, undefined, 'never while locked')
  t.absent(proofsSent(nodeCalls).some((p) => 'verified' in p), 'nothing stored for a stale answer')
  r.rerender({ locked: false })
  r.out.markVerified(PROOF, r.out.key)
  await tick()
  t.is(r.out.gate, 'ok', 'the current key opens it')
})

test('a refused clear is tried again until the node accepts it, for its key only', async (t) => {
  const { r, nodeCalls, node } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => ({ state: 'nenhum' })
  }, {}, { proofFails: 2 })
  const clears = () => proofsSent(nodeCalls).filter((p) => 'verified' in p && p.verified === null).length
  t.is(clears(), 1)
  reconnect(r, node)
  await tick()
  t.is(clears(), 2, 'again when the connection comes back')
  reconnect(r, node)
  await tick()
  t.is(clears(), 3, 'accepted at the third')
  reconnect(r, node)
  await tick()
  t.is(clears(), 3, 'not after the node accepted it')

  const stop = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: (() => { let n = 0; return () => (n++ === 0 ? Promise.resolve({ state: 'nenhum' }) : new Promise(() => {})) })()
  }, {}, { proofFails: 5 })
  stop.r.rerender({ member: OTHER })
  await tick()
  reconnect(stop.r, stop.node)
  await tick()
  t.is(proofsSent(stop.nodeCalls).filter((p) => 'verified' in p).length, 1, 'a new key stops the retries')
})

test('a refused store of a verificado proof is tried again', async (t) => {
  const { r, nodeCalls, node } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => ({ state: 'verificado', proof: PROOF })
  }, {}, { proofFails: 1 })
  const stores = () => proofsSent(nodeCalls).filter((p) => p.verified === PROOF).length
  t.is(stores(), 1)
  t.is(r.out.gate, 'ok', 'the answer opens it meanwhile')
  reconnect(r, node)
  await tick()
  t.is(stores(), 2)
})

test('node.info is read while the gate waits on it, and again on reconnect', async (t) => {
  let reads = 0
  const readInfo = async () => { reads++ }
  const { r, node } = await mount(t, { phonePolicy: async () => null }, { readInfo, infoFree: true })
  t.is(r.out.gate, 'loading')
  t.is(reads, 1)
  reconnect(r, node)
  await tick()
  t.is(reads, 2, 'the reconnect reads again')
  const held = await mount(t, { phonePolicy: async () => null }, { readInfo, infoFree: false })
  t.is(held.r.out.gate, 'loading')
  t.is(reads, 2, 'held back while infoFree is false')
  await mount(t, { phonePolicy: async () => null }, { readInfo, infoFree: true, info: { publicKey: M, phoneVerifiedDate: null, phoneSince: null } })
  t.is(reads, 2, 'not once node.info is known')
})

async function mountVerify (t, account, props = {}) {
  const { usePhoneVerify } = await loadVerify()
  const calls = fakeAccount(account)
  const { node } = fakeNode()
  let drops = 0
  const r = runtime((p) => usePhoneVerify(p))
  t.teardown(() => r.unmount())
  r.rerender({ node, member: M, gateKey: '1#' + M + '#' + ORIGIN, onDropped: () => { drops++ }, ...props })
  await tick()
  return { r, calls, drops: () => drops }
}

test('usePhoneVerify: a check answers with its key, a fresh nonce each time', async (t) => {
  const { r, calls } = await mountVerify(t, { phoneCheck: async () => ({ state: 'verificado', proof: PROOF }) })
  const out = await r.out.check('123456')
  t.alike(out, { state: 'verificado', proof: PROOF, key: '1#' + M + '#' + ORIGIN })
  await r.out.check('123456')
  t.alike(calls.filter(([n]) => n === 'phoneCheck').map(([, b]) => b.nonce), ['n1', 'n2'])
  t.is(await r.out.check('12345'), null, 'six digits only')
})

test('usePhoneVerify: an answer is dropped on a session change, on reset and on unmount', async (t) => {
  const answer = deferred()
  const keyed = await mountVerify(t, { phoneCheck: () => answer.promise })
  const pending = keyed.r.out.check('123456')
  await tick()
  keyed.r.rerender({ gateKey: '2#' + M + '#' + ORIGIN })
  answer.resolve({ state: 'verificado', proof: PROOF })
  t.is(await pending, null, 'another generation, same member')
  t.is(keyed.drops(), 0, 'the new session asks its own status')

  const late = deferred()
  const reset = await mountVerify(t, { phoneCheck: () => late.promise })
  const p2 = reset.r.out.check('123456')
  await tick()
  reset.r.out.reset()
  late.resolve({ state: 'verificado', proof: PROOF })
  t.is(await p2, null)
  t.is(reset.drops(), 1, 'a dropped answer of the same session asks the status')

  const gone = deferred()
  const unmounted = await mountVerify(t, { phoneSend: () => gone.promise })
  const p3 = unmounted.r.out.send('(11) 91234-5678')
  await tick()
  unmounted.r.unmount()
  gone.resolve({ state: 'verificado', proof: PROOF })
  t.is(await p3, null, 'nothing reaches an unmounted screen')
  t.is(unmounted.drops(), 1)

  const early = deferred()
  const beforeSend = await mountVerify(t, { phoneStart: () => early.promise })
  const p4 = beforeSend.r.out.check('123456')
  beforeSend.r.out.reset()
  early.resolve({ nonce: 'n' })
  t.is(await p4, null)
  t.is(beforeSend.drops(), 0, 'nothing reached the service, nothing to ask')
})

test('a pending clear survives a lock, a reset and an installation switch of the same member', async (t) => {
  let n = 0
  const vouching = { publicKey: M, phoneVerifiedDate: DATE, phoneSince: null }
  const err = Object.assign(new Error('serviço indisponível'), { code: 'indisponivel' })
  const { r, nodeCalls, node } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => {
      if (n++ === 0) return { state: 'nenhum' }
      throw err
    }
  }, { info: vouching }, { proofFails: 100 })
  const clears = () => proofsSent(nodeCalls).filter((p) => 'verified' in p && p.verified === null).length
  t.is(clears(), 1)
  r.rerender({ locked: true, member: null })
  r.rerender({ locked: false, member: M, generation: 2, info: vouching })
  await tick()
  t.is(r.out.state, undefined, 'the new status read failed')
  t.is(r.out.gate, 'loading', 'the stale vouch does not open the gate while its clear is pending')
  const afterReset = clears()
  t.ok(afterReset >= 2, 'the clear is sent again for the same member')
  r.rerender({ origin: 'https://outra.example.test' })
  await tick()
  reconnect(r, node)
  await tick()
  t.ok(clears() > afterReset, 'and keeps trying after an installation switch')
  t.is(r.out.gate, 'loading')

  r.rerender({ member: OTHER, info: { publicKey: OTHER, phoneVerifiedDate: DATE, phoneSince: null } })
  await tick()
  const atSwitch = clears()
  reconnect(r, node)
  await tick()
  t.is(clears(), atSwitch, 'another member drops it')
})

test('a later verificado supersedes a pending clear', async (t) => {
  const { r, nodeCalls, node } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => ({ state: 'nenhum' })
  }, { info: { publicKey: M, phoneVerifiedDate: DATE, phoneSince: null } }, { proofFails: 1 })
  r.out.markVerified(PROOF, r.out.key)
  await tick()
  const sent = () => proofsSent(nodeCalls).filter((p) => 'verified' in p)
  t.is(r.out.gate, 'ok')
  t.alike(sent()[sent().length - 1], { verified: PROOF })
  const count = sent().length
  reconnect(r, node)
  await tick()
  t.absent(sent().slice(count).some((p) => p.verified === null), 'the clear is not sent again')
})

test('usePhoneVerify: an uncertain send keeps the code field and asks for the status', async (t) => {
  const lost = Object.assign(new Error('incerto'), { code: 'indisponivel', uncertain: true })
  const { r } = await mountVerify(t, { phoneSend: async () => { throw lost } })
  const out = await r.out.send('(11) 91234-5678')
  t.alike(out, { uncertain: true, key: '1#' + M + '#' + ORIGIN }, 'the caller can recheck under the started key')
  t.is(r.out.sent, true, 'the code field stays open')
  t.ok(r.out.resendIn > 0, 'the resend waits')
})

const SINCE_DATED = { type: 'phone-since', since: DATE, sig: 'y' }

test('an accepted since is read back from node.info until it shows, even when that read fails', async (t) => {
  let reads = 0
  let fail = true
  const readInfo = async () => {
    reads++
    if (fail) throw new Error('nó ocupado')
  }
  const neither = { publicKey: M, phoneVerifiedDate: null, phoneSince: null }
  const { r, node, nodeCalls } = await mount(t, {
    phonePolicy: async () => null,
    phoneSince: async () => SINCE_DATED
  }, { info: neither, readInfo, infoFree: true })
  t.alike(proofsSent(nodeCalls).filter((p) => 'since' in p), [{ since: SINCE_DATED }], 'the node accepted the since')
  t.is(r.out.gate, 'needed', 'the accepted since holds the step before node.info shows it')
  const first = reads
  t.ok(first >= 1, 'node.info is read after the store')
  reconnect(r, node)
  await tick()
  t.ok(reads > first, 'a failed read is tried again')
  fail = false
  r.rerender({ info: { ...neither, phoneSince: DATE } })
  await tick()
  t.is(r.out.gate, 'needed', 'the since held by the node keeps the step')
  const shown = reads
  reconnect(r, node)
  await tick()
  t.is(reads, shown, 'no more reads once node.info shows it')
})

test('an answer from another installation, during a switch, is dropped', async (t) => {
  t.teardown(() => { delete globalThis.__phoneOriginPin })
  const policy = deferred()
  const first = await mount(t, { phonePolicy: () => policy.promise })
  globalThis.__phoneOriginPin = 'https://outra.example.test'
  policy.resolve({ required: false })
  await tick()
  t.is(first.r.out.gate, 'loading', 'the other installation\'s policy is not stored here')

  const since = deferred()
  globalThis.__phoneOriginPin = undefined
  const second = await mount(t, { phonePolicy: async () => ({ required: true }), phoneSince: () => since.promise })
  globalThis.__phoneOriginPin = 'https://outra.example.test'
  since.resolve(null)
  await tick()
  t.is(proofsSent(second.nodeCalls).filter((p) => 'since' in p).length, 0, 'its since is never handed to the node')

  const sent = await mount(t, { phonePolicy: async () => ({ required: false }), phoneSince: async () => null }, { origin: 'https://terceira.example.test' })
  t.is(sent.r.out.gate, 'loading', 'nothing is asked while the calls go elsewhere')
  t.is(proofsSent(sent.nodeCalls).length, 0)
})

test('an accepted clear keeps masking the vouch until node.info shows it', async (t) => {
  let n = 0
  let fail = true
  let reads = 0
  const readInfo = async () => {
    reads++
    if (fail) throw new Error('nó ocupado')
  }
  const vouching = { publicKey: M, phoneVerifiedDate: DATE, phoneSince: null }
  const err = Object.assign(new Error('serviço indisponível'), { code: 'indisponivel' })
  const { r, nodeCalls, node } = await mount(t, {
    phonePolicy: async () => ({ required: true }),
    phoneStatus: async () => {
      if (n++ === 0) return { state: 'nenhum' }
      throw err
    }
  }, { info: vouching, readInfo, infoFree: true })
  t.alike(proofsSent(nodeCalls).filter((p) => 'verified' in p), [{ verified: null }], 'the node accepted the clear')
  r.rerender({ generation: 2 })
  await tick()
  t.is(r.out.state, undefined, 'the new status read failed')
  t.is(r.out.gate, 'loading', 'node.info still reports the old proof: no vouch')
  const before = reads
  reconnect(r, node)
  await tick()
  t.ok(reads > before, 'node.info is read again')
  t.is(proofsSent(nodeCalls).filter((p) => 'verified' in p).length, 1, 'the accepted clear is not sent again')
  fail = false
  r.rerender({ info: { ...vouching, phoneVerifiedDate: null } })
  await tick()
  r.rerender({ info: vouching })
  await tick()
  t.is(r.out.gate, 'ok', 'once shown, the mask is gone (a later proof vouches again)')
})
