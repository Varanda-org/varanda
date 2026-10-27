// Pure install-offer policy and controller. Browser capabilities and time are
// injected; failed reads and callbacks must never interrupt the app.

export const DISMISS_KEY = 'varanda-install-dismissed'
export const DISMISS_MS = 30 * 24 * 60 * 60 * 1000

function read (arg, key) {
  try { return arg && typeof arg === 'object' ? arg[key] : undefined } catch {}
}

export function deviceOf (arg) {
  const rawAgent = read(arg, 'userAgent')
  const rawPlatform = read(arg, 'platform')
  const userAgent = typeof rawAgent === 'string' ? rawAgent : ''
  const platform = typeof rawPlatform === 'string' ? rawPlatform : ''
  const touches = read(arg, 'maxTouchPoints')
  const ios = /iPhone|iPod|iPad/.test(userAgent) ||
    ((platform === 'MacIntel' || userAgent.includes('Macintosh')) && typeof touches === 'number' && touches > 1)
  return {
    handheld: read(arg, 'mobileHint') === true || ios || (userAgent.includes('Android') && userAgent.includes('Mobile')),
    iosSafari: ios && userAgent.includes('Safari/') && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\//.test(userAgent)
  }
}

export function dismissedAtOf (raw) {
  if (typeof raw !== 'string' || !/^[0-9]{1,15}$/.test(raw)) return null
  const at = Number(raw)
  return Number.isSafeInteger(at) ? at : null
}

export function dismissalActive (at, now) {
  return Number.isFinite(at) && Number.isFinite(now) && at <= now && now - at < DISMISS_MS
}

export function installView (arg) {
  if (read(arg, 'eligible') !== true || read(arg, 'standalone') === true || read(arg, 'installed') === true) {
    return { note: 'none', canPrompt: false }
  }
  const canPrompt = read(arg, 'hasPrompt') === true
  let note = 'none'
  if (read(arg, 'handheld') === true && !dismissalActive(read(arg, 'dismissedAt'), read(arg, 'now'))) {
    if (canPrompt) note = 'prompt'
    else if (read(arg, 'iosSafari') === true) note = 'ios'
  }
  return { note, canPrompt }
}

export function createInstallOffer (arg) {
  const eligible = read(arg, 'eligible') === true
  const win = read(arg, 'win')
  const nav = read(arg, 'nav')
  const storage = read(arg, 'storage')
  const clock = read(arg, 'now')
  const now = () => {
    try {
      const value = typeof clock === 'function' ? clock() : Date.now()
      if (Number.isFinite(value)) return value
    } catch {}
    return Date.now()
  }
  const device = deviceOf({
    userAgent: read(nav, 'userAgent'),
    platform: read(nav, 'platform'),
    maxTouchPoints: read(nav, 'maxTouchPoints'),
    mobileHint: read(read(nav, 'userAgentData'), 'mobile')
  })
  let dismissedAt = null
  try { dismissedAt = dismissedAtOf(storage().getItem(DISMISS_KEY)) } catch {}
  let mql = null
  try { mql = win.matchMedia('(display-mode: standalone)') } catch {}
  const isStandalone = () => {
    const matches = read(mql, 'matches')
    const nativeStandalone = read(nav, 'standalone')
    return matches === true || nativeStandalone === true
  }
  let standalone = isStandalone()
  let deferred = null
  let pending = false
  let installed = false
  let snapshot
  const listeners = new Set()
  const removers = []

  function getSnapshot () {
    const next = installView({
      eligible,
      standalone,
      installed,
      hasPrompt: deferred !== null && !pending,
      ...device,
      dismissedAt,
      now: now()
    })
    if (!snapshot || snapshot.note !== next.note || snapshot.canPrompt !== next.canPrompt) snapshot = next
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

  function prompt () {
    if (installed || standalone || pending || deferred === null) return Promise.resolve('unavailable')
    const e = deferred
    let result
    try {
      // Keep this synchronous and before state changes or subscriber callbacks:
      // Chrome requires the tap's user activation to still be active.
      result = e.prompt()
    } catch {
      if (deferred === e) deferred = null
      pending = false
      emit()
      return Promise.resolve('unavailable')
    }
    if (deferred === e) deferred = null
    pending = true
    emit()
    const finish = (outcome) => {
      if (outcome === 'accepted') {
        installed = true
        deferred = null
      }
      pending = false
      emit()
      return outcome
    }
    return Promise.resolve(result).then(() => {
      // A missing, throwing or rejecting userChoice counts as a decline.
      return Promise.resolve(read(e, 'userChoice')).then(
        (choice) => finish(read(choice, 'outcome') === 'accepted' ? 'accepted' : 'dismissed'),
        () => finish('dismissed')
      )
    }, () => finish('unavailable'))
  }

  function dismiss () {
    dismissedAt = Math.trunc(now())
    try { storage().setItem(DISMISS_KEY, String(dismissedAt)) } catch {}
    emit()
  }

  function stop () {
    for (const remove of removers.splice(0)) {
      try { remove() } catch {}
    }
  }

  function attach (target, name, fn) {
    try {
      target.addEventListener(name, fn)
      removers.push(() => target.removeEventListener(name, fn))
    } catch {}
  }

  if (eligible && typeof read(win, 'addEventListener') === 'function') {
    attach(win, 'beforeinstallprompt', (event) => {
      try { event.preventDefault() } catch {}
      if (!installed && typeof read(event, 'prompt') === 'function') {
        deferred = event
        emit()
      }
    })
    attach(win, 'appinstalled', () => {
      installed = true
      deferred = null
      emit()
    })
    const onChange = () => {
      standalone = isStandalone()
      emit()
    }
    if (typeof read(mql, 'addEventListener') === 'function') attach(mql, 'change', onChange)
    else {
      try {
        mql.addListener(onChange)
        removers.push(() => mql.removeListener(onChange))
      } catch {}
    }
  }

  return { getSnapshot, subscribe, prompt, dismiss, stop }
}
