/* global navigator, document, location, history, Notification, MessageChannel */

// Web: the browser half of Web Push on the hosted page. Never throws and
// never retries a state-changing step: a repeat after an unknown outcome is
// the person's choice, and the server replaces the same endpoint in place.
// Globals are read inside each call, never at import.

import { hostedPage } from './configStore'
import { webMode } from './client/mode'
import { pushFinish, pushStart } from './account'
import { applicationServerKey, parseLaunch, parseMessage, pushSupport, stripLaunch, subscriptionJsonOf } from './push-state'

const READY_MS = 3000
const PING_MS = 1500
const UNSUBSCRIBE_MS = 5000
// A subscription read that failed: unlike null, it says nothing about
// whether one exists.
const UNKNOWN = Symbol('unknown')

function sw () {
  try {
    return typeof navigator === 'object' && navigator !== null && navigator.serviceWorker ? navigator.serviceWorker : null
  } catch {
    return null
  }
}

function permissionNow () {
  try {
    return typeof Notification === 'function' ? Notification.permission : null
  } catch {
    return null
  }
}

export function pushSupportNow () {
  try {
    const meta = document.querySelector('meta[name="varanda-release"]')
    return pushSupport({
      mode: webMode,
      hosted: hostedPage,
      hasMarker: !!meta && !!meta.getAttribute('content'),
      hasServiceWorker: sw() !== null,
      hasPushManager: typeof globalThis.PushManager === 'function',
      hasNotification: typeof Notification === 'function'
    })
  } catch {
    return 'not-hosted'
  }
}

function within (promise, ms, late = null) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(late), ms) })
  ]).finally(() => clearTimeout(timer))
}

// An older active worker without the push handler never answers.
function ping (reg) {
  return new Promise((resolve) => {
    let timer
    try {
      const worker = reg && reg.active
      if (!worker || typeof MessageChannel !== 'function') return resolve(false)
      const channel = new MessageChannel()
      timer = setTimeout(() => {
        try { channel.port1.close() } catch {}
        resolve(false)
      }, PING_MS)
      channel.port1.onmessage = (e) => {
        clearTimeout(timer)
        try { channel.port1.close() } catch {}
        const d = e && e.data
        resolve(!!d && typeof d === 'object' && d.source === 'varanda-sw' && d.push === 1)
      }
      worker.postMessage({ type: 'varanda-push-ping' }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

// -> the subscription, null when there is none, or UNKNOWN when the read
// failed.
async function currentSubscription (reg) {
  try {
    return (reg && reg.pushManager ? await reg.pushManager.getSubscription() : null) || null
  } catch {
    return UNKNOWN
  }
}

function jsonOf (sub) {
  try {
    return sub ? subscriptionJsonOf(sub.toJSON()) : null
  } catch {
    return null
  }
}

function endpointOf (sub) {
  const json = jsonOf(sub)
  return json ? json.endpoint : null
}

// Read when the Ajustes sheet opens, so the click handler already holds the
// registration: on Safari any await before subscribe() spends the user
// activation the permission prompt needs. Never asks for permission.
export async function getPushState () {
  const support = pushSupportNow()
  if (support !== 'ok') return { support }
  const out = { support, permission: permissionNow(), subscribed: false, registration: null, subscription: null, endpoint: null, p256dh: null, auth: null, swUpToDate: false }
  try {
    const reg = await within(sw().ready, READY_MS)
    if (!reg) return out
    out.registration = reg
    const [sub, upToDate] = await Promise.all([currentSubscription(reg), ping(reg)])
    out.swUpToDate = upToDate
    if (sub === UNKNOWN) {
      out.subscribed = null
      return out
    }
    out.subscription = sub
    out.subscribed = sub !== null
    // The keys go with the endpoint to pushCheck: the vendor's push service
    // knows every endpoint it issued but never sees them.
    const json = jsonOf(sub)
    if (json !== null) Object.assign(out, json)
  } catch {}
  return out
}

// -> true only when the browser confirmed the subscription is gone. Awaited
// (bounded) so no later read or retry can pick up a subscription that a
// pending cleanup is about to remove.
async function unsubscribe (sub) {
  try {
    const done = await within(Promise.resolve(sub.unsubscribe()).then((r) => r !== false, () => false), UNSUBSCRIBE_MS, false)
    return done === true
  } catch {
    return false
  }
}

// `registration` and `subscription` come from getPushState. With no
// subscription the first await is pushManager.subscribe(), which shows the
// permission prompt itself; nothing is awaited before it.
// The result also carries the permission as it stands afterwards.
export function enablePush (opts) {
  return enableSteps(opts).then((r) => ({ ...r, permission: permissionNow() }), () => ({ ok: false, reason: 'failed', permission: permissionNow() }))
}

// A subscription the browser already had may still be stored by the
// service (pushCheck failing looks the same as not registered), so a failed
// turn-on drops only one this call created.
async function enableSteps ({ node, member, key, registration, subscription = null, subscriptionKnown = true } = {}) {
  let sub = subscription
  // After a failed read, subscribe() may hand back the browser's existing
  // subscription: never treat it as ours to drop.
  const created = sub === null && subscriptionKnown === true
  if (sub === null) {
    let serverKey
    try {
      serverKey = applicationServerKey(key)
      if (serverKey === null || !registration || !registration.pushManager) return { ok: false, reason: 'failed' }
    } catch {
      return { ok: false, reason: 'failed' }
    }
    try {
      sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey })
    } catch {
      return { ok: false, reason: permissionNow() === 'denied' ? 'denied' : 'failed' }
    }
  }
  let json
  let signature
  let nonce
  try {
    json = subscriptionJsonOf(sub.toJSON())
    if (json === null) throw new Error('subscription')
    nonce = (await pushStart({ member, action: 'on' })).nonce
    signature = (await node.request('push.sign', { nonce, action: 'on', endpoint: json.endpoint, p256dh: json.p256dh, auth: json.auth })).signature
    if (typeof signature !== 'string') throw new Error('signature')
  } catch {
    return dropIfCreated(sub, created, json)
  }
  try {
    await pushFinish({ member, nonce, action: 'on', signature, endpoint: json.endpoint, p256dh: json.p256dh, auth: json.auth })
    return { ok: true, subscription: sub, endpoint: json.endpoint }
  } catch (err) {
    if (err && err.uncertain === true) return { ok: false, reason: 'uncertain', subscription: sub, endpoint: json.endpoint }
    // The service answered with a refusal: nothing was stored now.
    return dropIfCreated(sub, created, json)
  }
}

async function dropIfCreated (sub, created, json) {
  if (created && await unsubscribe(sub)) return { ok: false, reason: 'failed', subscription: null }
  return { ok: false, reason: 'failed', subscription: sub, endpoint: json ? json.endpoint : endpointOf(sub) }
}

// Also used by Sair and Recomeçar while the key still exists. This browser
// stops rendering whatever the service says: a row left behind dies on the
// vendor's next 404/410. `unsubscribed` says whether this browser really
// dropped the subscription, so the caller never shows "off" from a guess.
export async function disablePush ({ node, member, registration = null, subscription = null } = {}) {
  let sub = subscription
  try {
    if (sub === null) {
      const s = sw()
      const reg = registration || (s && typeof s.getRegistration === 'function' ? await within(s.getRegistration(), READY_MS, UNKNOWN) : null)
      sub = reg === UNKNOWN ? UNKNOWN : await currentSubscription(reg)
    }
  } catch {
    sub = UNKNOWN
  }
  // A failed read is never taken for "nothing to remove".
  if (sub === UNKNOWN) return { ok: false, reason: 'failed', unsubscribed: false }
  if (sub === null) return { ok: true, unsubscribed: true }
  let sent = false
  let ok = false
  let uncertain = false
  try {
    const json = subscriptionJsonOf(sub.toJSON())
    if (json !== null) {
      const { nonce } = await pushStart({ member, action: 'off' })
      const { signature } = await node.request('push.sign', { nonce, action: 'off', endpoint: json.endpoint, p256dh: json.p256dh, auth: json.auth })
      if (typeof signature !== 'string') throw new Error('signature')
      sent = true
      await pushFinish({ member, nonce, action: 'off', signature, endpoint: json.endpoint, p256dh: json.p256dh, auth: json.auth })
      ok = true
    }
  } catch (err) {
    uncertain = sent && !!err && err.uncertain === true
  }
  // Bounded: Sair and Recomeçar wait for this before removing the key.
  const unsubscribed = await unsubscribe(sub)
  if (ok) return { ok: true, unsubscribed }
  return { ok: false, reason: uncertain ? 'uncertain' : 'failed', unsubscribed }
}

// The notification click's query (/?aviso=...), read once at load and then
// cleaned from the address bar, the rest of the search and the hash kept.
// Memory only: the intent is never stored.
export function captureLaunch () {
  if (hostedPage !== true) return null
  try {
    const search = location.search || ''
    const intent = parseLaunch(search)
    const kept = stripLaunch(search)
    if (kept !== search) {
      try {
        history.replaceState(history.state, '', location.pathname + kept + (location.hash || ''))
      } catch {}
    }
    return intent
  } catch {
    return null
  }
}

// A click while a window is already open arrives as a worker message.
export function listenLaunch (fn) {
  const s = hostedPage === true ? sw() : null
  if (s === null) return () => {}
  const onMessage = (e) => {
    try {
      const intent = parseMessage(e && e.data)
      if (intent !== null) fn(intent)
    } catch {}
  }
  try {
    s.addEventListener('message', onMessage)
    return () => {
      try { s.removeEventListener('message', onMessage) } catch {}
    }
  } catch {
    return () => {}
  }
}
