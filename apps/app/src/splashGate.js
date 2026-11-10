// The entrance needs time on screen during loading and connecting. 'ready'
// skips the minimum so a returning member sees A Rua as soon as it is ready.
// A failure is exempt when Conexao would show next, so retry and
// 'Detalhes técnicos' stay reachable:
// node.js uses 'config' for a failed configurable connection or the first-run
// form, and 'config-error' for hosted discovery failure. When the intro or the
// terms gate comes next (gateNext), holding delays nothing anyone needs, so the
// minimum applies whatever the phase. Once Conexao shows, retries keep it
// mounted so its local state survives.
export const SPLASH_MIN_MS = 1500
export const CONNECT_PATIENCE_MS = 10000
export const HOLD_PHASES = ['loading', 'connecting']

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
// A missing first page must not keep A Rua covered forever. Names and counts
// get only a short grace after the page arrives, then finish in view.
export const CONTENT_PATIENCE_MS = 5000
export const DETAILS_GRACE_MS = 400

export function detailsGraceOver ({ page, pageAtMs, nowMs }) {
  return page === true && Number.isFinite(pageAtMs) && Number.isFinite(nowMs) && nowMs - pageAtMs >= DETAILS_GRACE_MS
}

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

// A returning member's cold start on the phone may show A Rua's saved rows
// (./feedSnapshot.js) instead of the splash while the node boots. It is a
// cover, never a step: it shows only where the splash would, and every gate
// still decides what comes after it. Any doubt keeps the splash.
// - snapshot: parsed for this installation and association, with rows;
// - previewCapable: the store's flag (false on the web);
// - savedAt within PREVIEW_MAX_AGE_MS and not in the future: an older first
//   page would show what the member may have left behind days ago;
// - sessionLive: the native session store holds a live record for exactly
//   the snapshot's owner, the one the resume will use;
// - no intro, terms or other gate next, no Conexão, not locked;
// - step: null while it is still unknown (the boot), else not 'entrar' nor a
//   step that asks the person for something.
export const PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PREVIEW_BLOCKED_STEPS = ['entrar', 'recuperando', 'idade', 'vinculo', 'identidade', 'certificado', 'perfil']
const PREVIEW_STEPS = ['carregando', 'pronto']

export function previewAllowed ({ snapshot, previewCapable, gateNext, showConexao, step, locked, sessionLive, nowMs } = {}) {
  if (previewCapable !== true || sessionLive !== true) return false
  if (gateNext !== false || showConexao !== false || locked !== false) return false
  if (step !== null && !PREVIEW_STEPS.includes(step)) return false
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return false
  const savedAt = snapshot.savedAt
  if (!Number.isSafeInteger(savedAt) || !Number.isSafeInteger(nowMs)) return false
  return savedAt <= nowMs && nowMs - savedAt <= PREVIEW_MAX_AGE_MS
}
