// Dev-only, local-only timing marks for the content-loading measurements
// (never stored, never sent). A release bundle has __DEV__ false, so no env
// value can turn them on. Pure ES module: imports nothing, so Node's import()
// tests it.

const RING = 256

export function perfEnabled (env, dev) {
  return dev === true && env !== null && typeof env === 'object' && env.EXPO_PUBLIC_VARANDA_PERF === '1'
}

// The lab driver's dev hook (src/node.js) acts as the signed-in member, so it
// passes only what the dataset setup needs (apps/cli/scripts/lab-dataset.js
// reader-setup.js): no deletes, messages, identity or recovery calls, even in
// a development build.
export const DEV_HOOK_METHODS = Object.freeze(['follow.add', 'community.join', 'post.create'])

export function devHookRequest (request) {
  return (method, params) => DEV_HOOK_METHODS.includes(method)
    ? request(method, params)
    : Promise.reject(new Error('método fora do gancho de medição: ' + String(method)))
}

const OFF = Object.freeze({ mark () {}, span () {}, report: () => [] })

export function createMarks ({ enabled, now = Date.now } = {}) {
  if (enabled !== true) return OFF
  const origin = now()
  const ring = new Array(RING)
  let count = 0
  const push = (name, ms, extra) => {
    ring[count % RING] = { name, ms, extra }
    count += 1
  }
  return {
    mark (name, extra) { push(name, now() - origin, extra) },
    span (name, startedAt, endedAt) { push(name, endedAt - startedAt) },
    report () {
      const out = []
      const first = Math.max(0, count - RING)
      for (let i = first; i < count; i++) {
        const e = ring[i % RING]
        out.push('perf: ' + e.name + ' ' + e.ms + (e.extra === undefined ? '' : ' ' + e.extra))
      }
      return out
    }
  }
}
