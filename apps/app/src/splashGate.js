// The entrance needs time on screen to be seen. A failure is exempt only when
// Conexao would show next, so retry and 'Detalhes técnicos' stay reachable:
// node.js uses 'config' for a failed configurable connection or the first-run
// form, and 'config-error' for hosted discovery failure. When the intro or the
// terms gate comes next (gateNext), holding delays nothing anyone needs, so the
// minimum applies whatever the phase. Once Conexao shows, retries keep it
// mounted so its local state survives.
export const SPLASH_MIN_MS = 1500
export const CONNECT_PATIENCE_MS = 10000
export const HOLD_PHASES = ['loading', 'connecting', 'ready']

export function holdSplash ({ phase, elapsedMs, released, gateNext }) {
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return released !== true && elapsed < SPLASH_MIN_MS && (gateNext === true || HOLD_PHASES.includes(phase))
}

export function coverConnecting ({ phase, canConfigure, elapsedMs, released }) {
  if (released === true) return false
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return phase === 'loading' || (phase === 'connecting' && (!canConfigure || elapsed < CONNECT_PATIENCE_MS))
}

// Boot steps paint a disabled age check or 'carregando…' before the read that
// says whether the person must act, so a returning member would see them flash
// before A Rua. The patience reveals the real screen, with its own error text,
// when a read hangs, so a required age check can never sit under the splash
// forever. 'recuperando' gets a longer patience: the node bounds its run (30 s,
// restarted once after a preemption, src/node.js), and the age read waits for
// it, so revealing it at 10 s would only show the next placeholder; the cap
// covers a run whose end never arrives. settled is a one-way latch the caller
// sets once the first real screen has shown.
export const BOOT_PATIENCE_MS = 10000
export const RECOVERY_PATIENCE_MS = 65000
// 'pronto' stays covered until A Rua's first page is on screen with the
// names and counts of its first rows (feedReady), so the person does not see
// them fill in; never longer than this, then A Rua finishes in view.
export const CONTENT_PATIENCE_MS = 5000

export function bootPatienceMs (step) {
  if (step === 'recuperando') return RECOVERY_PATIENCE_MS
  if (step === 'pronto') return CONTENT_PATIENCE_MS
  return BOOT_PATIENCE_MS
}

export function coverBoot ({ step, passkeyKnown, age, ageError, infoKnown, profileSlow, feedReady } = {}) {
  if (step === 'entrar') return passkeyKnown !== true
  if (step === 'recuperando') return true
  if (step === 'idade') return age === 'loading' && !(typeof ageError === 'string' && ageError !== '')
  if (step === 'vinculo' || step === 'identidade' || step === 'certificado') return infoKnown !== true
  if (step === 'carregando') return profileSlow !== true
  if (step === 'pronto') return feedReady !== true
  return false
}

// Rows whose names and counts the cover waits for: what fills the first
// screen of A Rua.
export const FEED_FIRST_ROWS = 6

// Whether A Rua's first rows are ready to show: every author looked up (a
// profileOf answer other than undefined, null included), every reposted
// original answered (hasOriginal, any outcome), and the counts answered for
// at least one of their posts, unless counts are not read here
// (countsSkipped: no hosted node, offline, indexing, or a failed answer).
export function feedDetailsReady ({ authors, shown, profileOf, originals, hasOriginal, hasCount, countsSkipped } = {}) {
  if (!Array.isArray(authors) || typeof profileOf !== 'function') return false
  if (!authors.every((a) => profileOf(a) !== undefined)) return false
  const reposted = Array.isArray(originals) ? originals : []
  if (reposted.length > 0 && (typeof hasOriginal !== 'function' || !reposted.every(hasOriginal))) return false
  if (countsSkipped === true) return true
  const refs = Array.isArray(shown) ? shown : []
  return refs.length === 0 || (typeof hasCount === 'function' && refs.some(hasCount))
}

// The bar under the splash: real steps only (connected, own profile known,
// first page, its names and counts), never a timer. 0..1.
export function bootProgress ({ phase, step, page, details } = {}) {
  if (details === true) return 1
  if (page === true) return 0.8
  if (step === 'pronto') return 0.6
  if (phase === 'ready') return 0.35
  return 0.1
}

export function holdBootCover ({ cover, elapsedMs, settled, step } = {}) {
  if (settled === true || cover !== true) return false
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return elapsed < bootPatienceMs(step)
}
