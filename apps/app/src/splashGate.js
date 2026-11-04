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

export function bootPatienceMs (step) {
  return step === 'recuperando' ? RECOVERY_PATIENCE_MS : BOOT_PATIENCE_MS
}

export function coverBoot ({ step, passkeyKnown, age, ageError, infoKnown, profileSlow } = {}) {
  if (step === 'entrar') return passkeyKnown !== true
  if (step === 'recuperando') return true
  if (step === 'idade') return age === 'loading' && !(typeof ageError === 'string' && ageError !== '')
  if (step === 'vinculo' || step === 'identidade' || step === 'certificado') return infoKnown !== true
  if (step === 'carregando') return profileSlow !== true
  return false
}

export function holdBootCover ({ cover, elapsedMs, settled, step } = {}) {
  if (settled === true || cover !== true) return false
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return elapsed < bootPatienceMs(step)
}
