// Device records and renewal policy. All I/O is supplied by the caller.
import { PUSH_DENIED, PUSH_FAILED, PUSH_UNCERTAIN } from './push-state.js'

export const NONE = Object.freeze({ member: null, state: null, pending: false, error: '', note: 'none' })
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function validTransport (value) {
  return value === 'apns' || value === 'fcm'
}

export function validToken (transport, token) {
  if (typeof token !== 'string') return false
  if (transport === 'apns') return token.length >= 64 && token.length <= 200 && !/[^0-9a-f]/.test(token)
  return transport === 'fcm' && token.length >= 1 && token.length <= 4096 && !/[^A-Za-z0-9_:-]/.test(token)
}

export function validKey (key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(key)
}

export function deviceRecord (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
    !['transport', 'token', 'key'].every((key) => Object.hasOwn(value, key)) ||
    !validToken(value.transport, value.token) || !validKey(value.key)) return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  return { transport: value.transport, token: value.token, key: value.key }
}

export function deviceKey (random) {
  const bytes = random(16)
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Fonte aleatória indisponível.')
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64[(acc >> bits) & 63]
    }
  }
  return out + B64[(acc << (6 - bits)) & 63]
}

export function deviceState ({ record, token, registered, suspended = false } = {}) {
  if (!deviceRecord(record) || suspended) return 'off'
  if ((validToken(record.transport, token) && token !== record.token) || registered === false) return 'needs-renewal'
  return 'on'
}

export function deviceIntent (kind) {
  if (kind === 'group' || kind === 'group-private') return { kind: 'group' }
  return kind === 'dm' || kind === 'dm-page' ? { kind } : null
}

// A failed mutation stops automatic work until an explicit tap. A second
// check or render is not another launch, and a duplicate token is no event.
export function createRenewal () {
  let launched = false
  let failed = false
  const tokens = new Set()
  return {
    refuse () { failed = true },
    recover () { failed = false },
    take (event, state, token) {
      if (failed) return false
      if (event === 'launch') {
        if (launched) return false
        launched = true
      } else if (event === 'token') {
        if (tokens.has(token)) return false
        tokens.add(token)
      } else return false
      return state === 'needs-renewal'
    }
  }
}

export function createNativePushStore ({ client, getNode } = {}) {
  let member = null
  let generation = 0
  let snapshot = NONE
  let policy = createRenewal()
  let flight = null
  let stop = null
  let leaving = false
  const listeners = new Set()
  const publish = (value) => {
    snapshot = Object.freeze(value)
    for (const fn of [...listeners]) { try { fn() } catch {} }
  }
  const current = (who, gen) => member === who && generation === gen
  const errorOf = (result) => result.ok ? '' : result.reason === 'denied' ? PUSH_DENIED : result.reason === 'uncertain' ? PUSH_UNCERTAIN : PUSH_FAILED

  async function change (off, node, who, gen, token, automatic = false) {
    if (!current(who, gen)) return
    publish({ ...snapshot, pending: true, error: '' })
    let result
    try {
      const active = () => current(who, gen) && (!leaving || off)
      result = off
        ? await client.disablePush({ node, member: who, active })
        : await client.enablePush({ node, member: who, token, automatic, active })
    } catch {
      result = { ok: false, reason: 'failed' }
    }
    if (!current(who, gen)) return
    if (!result.ok) policy.refuse()
    else if (!automatic) policy.recover()
    let state = snapshot.state
    try { state = await client.getPushState(who) } catch {}
    if (!current(who, gen)) return
    if (state?.support !== 'ok') publish(NONE)
    else publish({ member: who, state, pending: false, error: errorOf(result), note: 'none' })
  }

  function track (promise) {
    flight = promise
    promise.finally(() => { if (flight === promise) flight = null }).catch(() => {})
    return promise
  }

  async function inspect (who, gen, event, token) {
    try {
      const state = await client.getPushState(who, token)
      if (!current(who, gen)) return
      if (state.support !== 'ok') return publish(NONE)
      publish({ member: who, state, pending: false, error: state.suspended ? PUSH_UNCERTAIN : snapshot.error, note: 'none' })
      if (state.permission !== 'granted' || state.suspended || !state.token) return
      const node = getNode()
      if (node && policy.take(event, state.deviceState, state.token)) {
        await change(false, node, who, gen, state.token, true)
      }
    } catch {
      if (current(who, gen)) publish({ ...snapshot, pending: false, error: PUSH_FAILED })
    }
  }

  function read (who) {
    const changed = who !== member
    if (who == null || who !== member) {
      member = who || null
      generation++
      policy = createRenewal()
      if (stop) stop()
      stop = null
      publish(NONE)
      if (member) {
        const gen = generation
        stop = client.onToken((token) => {
          // Serialize rotations behind a permission prompt or a mutation.
          const before = flight || Promise.resolve()
          track(before.then(() => {
            if (current(who, gen) && !leaving) return inspect(who, gen, 'token', token)
          }))
        })
      }
    }
    if (!member) return Promise.resolve()
    if (flight) {
      if (!changed) return flight
      const gen = generation
      return track(flight.then(() => {
        if (current(who, gen)) return inspect(who, gen, 'launch')
      }))
    }
    return track(inspect(member, generation, 'launch'))
  }

  function toggle ({ node, member: who } = {}) {
    if (flight || leaving || who !== member || !snapshot.state || !who) return false
    const off = snapshot.state.subscribed === true && snapshot.state.registered === true
    const gen = generation
    track(Promise.resolve().then(() => change(off, node, who, gen)))
    return true
  }

  async function offHere ({ node, member: who } = {}) {
    if (!who) return
    leaving = true
    try {
      if (flight) await flight
      await client.disablePush({ node, member: who })
      if (who === member) await inspect(who, generation, 'read')
    } catch {} finally { leaving = false }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    read,
    toggle,
    activate: () => false,
    offHere,
    dismiss () {}
  }
}
