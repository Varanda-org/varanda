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
