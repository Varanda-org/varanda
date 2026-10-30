// Shared push state for the Avisos note in the shell and the Ajustes row, so
// both show one read and one operation in flight. Browser and service calls
// are injected; none of their failures may escape into the app.

import { PUSH_DENIED, PUSH_FAILED, PUSH_UNCERTAIN, pushStateAfter, pushUiState } from './push-state.js'
import { dismissedAtOf, dismissalActive } from './install-offer.js'

export const PUSH_NOTE_KEY = 'varanda-push-dismissed'
export const PUSH_ERRORS = { denied: PUSH_DENIED, failed: PUSH_FAILED, uncertain: PUSH_UNCERTAIN }

// Eligibility comes from `fresh`, the last read that really answered:
// pushStateAfter keeps an old key or a whole old state when the follow-up read
// is unusable, so the reconciled state can look offerable when it is not.
// pushUiState only rejects a 'denied' permission and defaults a missing
// swUpToDate to true, and enablePush cannot work without a registration,
// hence the extra checks. Pending is not an input: the bar stays during a
// turn-on instead of vanishing under the finger.
export function pushNoteKind ({ state = null, fresh = null, dismissedAt = null, now } = {}) {
  if (state === null || fresh === null || typeof state !== 'object' || typeof fresh !== 'object') return 'none'
  if (dismissalActive(dismissedAt, now)) return 'none'
  if (fresh.support !== 'ok' || fresh.key == null || !fresh.registration || fresh.swUpToDate !== true) return 'none'
  if (fresh.permission !== 'default' && fresh.permission !== 'granted') return 'none'
  // The reconciled state may say "off" from the step alone; a browser read that
  // could not tell must not lead to a turn-on that takes a subscription for new.
  if (fresh.subscribed !== true && fresh.subscribed !== false) return 'none'
  const ui = pushUiState({
    support: fresh.support,
    keyAvailable: fresh.key != null,
    permission: fresh.permission,
    subscribed: state.subscribed,
    registered: state.registered,
    pending: false,
    swUpToDate: fresh.swUpToDate === true
  })
  return ui.visible && !ui.on && !ui.disabled && ui.note === null ? 'offer' : 'none'
}

export function createPushStore ({ getPushState, pushKey, pushCheck, enablePush, disablePush, pushSupportNow, storage, now: clock } = {}) {
  const now = () => {
    try {
      const value = typeof clock === 'function' ? clock() : Date.now()
      if (Number.isFinite(value)) return value
    } catch {}
    return Date.now()
  }
  let dismissedAt = null
  try { dismissedAt = dismissedAtOf(storage().getItem(PUSH_NOTE_KEY)) } catch {}
  let member = null
  let state = null
  let fresh = null
  let pending = false
  let error = ''
  // Every read or result is applied only while its seq is the newest; gen
  // marks a session (lock, leave, other account) whose flights are never reused.
  let op = null // null | { member, gen, promise }
  let readFlight = null // null | { member, gen, promise }
  let seq = 0
  let gen = 0
  let busy = false
  let snapshot
  const listeners = new Set()

  function getSnapshot () {
    const note = pushNoteKind({ state, fresh, dismissedAt, now: now() })
    if (!snapshot || snapshot.member !== member || snapshot.state !== state || snapshot.pending !== pending ||
      snapshot.error !== error || snapshot.note !== note) {
      snapshot = { member, state, pending, error, note }
    }
    return snapshot
  }

  function emit () {
    for (const fn of [...listeners]) {
      try { fn() } catch {}
    }
  }

  function subscribe (fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  const readPush = async (who) => {
    const s = await getPushState()
    if (s.support !== 'ok') return { ...s, key: null, registered: null }
    const [key, check] = await Promise.all([
      pushKey(),
      s.endpoint ? pushCheck({ member: who, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }) : null
    ])
    return { ...s, key, registered: check ? check.registered : null }
  }

  // busy and pending survive a session change: the subscription belongs to the
  // browser, and a second step while one is in flight could have either drop
  // what the other made.
  function forget () {
    gen += 1
    readFlight = null
    state = null
    fresh = null
  }

  async function read (who) {
    const mine = ++seq
    error = ''
    if (who == null) {
      member = null
      forget()
      emit()
      return
    }
    if (who !== member) {
      member = who
      forget()
      emit()
    }
    try {
      if (op !== null && op.member === who && op.gen === gen) {
        const view = await op.promise
        if (mine !== seq) return
        state = view.state
        fresh = view.fresh
        error = view.error
        return
      }
      let flight = readFlight
      if (flight === null || flight.member !== who || flight.gen !== gen) {
        flight = { member: who, gen, promise: readPush(who) }
        readFlight = flight
        const clear = () => { if (readFlight === flight) readFlight = null }
        flight.promise.then(clear, clear)
      }
      const next = await flight.promise
      if (mine !== seq) return
      state = next
      fresh = next
    } catch {
    } finally {
      if (mine === seq) emit()
    }
  }

  // Must run straight from the press with nothing awaited and nothing emitted
  // before the step: the permission prompt needs the tap's user activation.
  function run (turnOff, node, who) {
    const before = state
    // enablePush drops a subscription it believes it created when a later step
    // fails. That belief needs a real browser read that saw none: without a
    // registration getPushState never asked the browser.
    const known = before.subscribed !== null && fresh !== null && !!fresh.registration && typeof fresh.subscribed === 'boolean'
    const step = turnOff
      ? call(() => disablePush({ node, member: who, registration: before.registration, subscription: before.subscription }))
      : call(() => enablePush({ node, member: who, key: before.key, registration: before.registration, subscription: before.subscription, subscriptionKnown: known }))
    // Reads started before the step must never overwrite its outcome.
    const opSeq = ++seq
    readFlight = null
    const promise = Promise.resolve(step).catch(() => ({ ok: false, reason: 'failed' })).then(async (result) => {
      let after = null
      try { after = await readPush(who) } catch {}
      const { error: reason, ...next } = pushStateAfter({ action: turnOff ? 'off' : 'on', result, before, after })
      return { state: next, fresh: after, error: reason === null ? '' : (PUSH_ERRORS[reason] || PUSH_FAILED) }
    }).catch(() => ({ state: before, fresh: null, error: PUSH_FAILED }))
    // Published before any listener runs, so a read a listener starts joins it.
    const current = { member: who, gen, promise }
    op = current
    busy = true
    pending = true
    error = ''
    emit()
    let resync = false
    promise.then((view) => {
      if (opSeq === seq) {
        state = view.state
        fresh = view.fresh
        error = view.error
        return
      }
      // A session begun during the step (a lock and unlock, or another account
      // on this browser, whose subscription they share) could not join it, and
      // what it read may predate it.
      resync = current.gen !== gen && member !== null
    }).finally(() => {
      op = null
      const done = () => {
        busy = false
        pending = false
        emit()
      }
      if (!resync) return done()
      // From scratch, and still pending until it lands: a flight begun before
      // the step ended would bring back the state from before it, and a tap on
      // that state would take this step's subscription for a new one. Until a
      // read lands, nothing about the browser is known.
      readFlight = null
      fresh = null
      emit()
      read(member).finally(() => {
        // A failed read leaves the pre-step snapshot: show nothing rather than it.
        if (fresh === null) state = null
        done()
      })
    })
    return true
  }

  function call (fn) {
    try {
      return fn()
    } catch {
      return { ok: false, reason: 'failed' }
    }
  }

  function toggle ({ node, member: who } = {}) {
    if (busy || state === null || who == null || who !== member) return false
    return run(state.subscribed === true && state.registered === true, node, who)
  }

  function activate ({ node, member: who } = {}) {
    if (busy || state === null || who == null || who !== member) return false
    if (getSnapshot().note !== 'offer') return false
    if (state.subscribed === true && state.registered === true) return false
    return run(false, node, who)
  }

  // Before Sair or Recomeçar, while push.sign still works. It does not wait
  // for an operation in flight (a documented limit) and never blocks them.
  async function offHere ({ node, member: who } = {}) {
    try {
      if (who == null || pushSupportNow() !== 'ok') return
      // No subscription handed over: the held one may be stale (another window
      // replaced it), and disablePush reads the current one itself. Sair needs
      // no user activation, so that await costs nothing.
      await disablePush({ node, member: who, registration: state ? state.registration : null, subscription: null })
    } catch {}
  }

  function dismiss () {
    dismissedAt = Math.trunc(now())
    try { storage().setItem(PUSH_NOTE_KEY, String(dismissedAt)) } catch {}
    emit()
  }

  return { getSnapshot, subscribe, read, activate, toggle, offHere, dismiss }
}
