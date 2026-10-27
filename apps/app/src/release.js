// Pure release policy. The notice compares the running document's release
// with the one the server serves now. A waiting worker is a hint to check,
// not the signal.
export const RELEASE_CHECK_MS = 30 * 60 * 1000
export const RELEASE_FOCUS_MIN_MS = 60000
export const UPDATE_TEXT = 'Nova versão disponível.'
export const UPDATE_ACTION = 'atualizar'

const RELEASE_ID = /^[0-9a-f]{16}$/
// finish-web.js renders the worker with JSON.stringify(version) in this assignment.
const WORKER_VERSION = /const VERSION = "([0-9a-f]{16})"/

function releaseId (value) {
  return typeof value === 'string' && RELEASE_ID.test(value)
}

// The 16-hex release baked into a rendered /sw.js, or null. Never throws.
export function parseWorkerRelease (text) {
  try {
    if (typeof text !== 'string') return null
    const match = WORKER_VERSION.exec(text)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function releaseState (arg) {
  try {
    const running = arg.running
    const served = arg.served
    return { update: releaseId(running) && releaseId(served) && running !== served }
  } catch {
    return { update: false }
  }
}

// Focus and visibility returns share a shorter cooldown so paired browser
// events do not start two requests, while an idle visible tab checks slowly.
export function shouldCheck (arg) {
  try {
    const { now, lastCheck, visible, focus = false } = arg
    if (visible !== true || !Number.isFinite(now)) return false
    return lastCheck === null || (Number.isFinite(lastCheck) &&
      now - lastCheck >= (focus === true ? RELEASE_FOCUS_MIN_MS : RELEASE_CHECK_MS))
  } catch {
    return false
  }
}
