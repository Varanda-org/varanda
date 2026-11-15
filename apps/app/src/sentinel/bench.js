// Dev-only helpers for the Sentinela on-device benchmark. Nothing here reads
// user content or sends anything anywhere: it only computes numbers and
// formats one log line. A release bundle has __DEV__ false, so no env value
// can turn the benchmark on. Pure ES module: imports nothing, so Node's
// import() tests it.

// Same shape as perfEnabled (src/perfMarks.js): dev must be exactly true.
export function sentinelBenchEnabled (env, dev) {
  return dev === true && env !== null && typeof env === 'object' && env.EXPO_PUBLIC_VARANDA_SENTINEL_BENCH === '1'
}

function assertVector (v, name) {
  if (!Array.isArray(v) || v.length === 0) throw new Error(name + ' must be a non-empty array')
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) throw new Error(name + '[' + i + '] must be a finite number')
  }
}

// Cosine similarity of two equal-length, non-empty numeric vectors.
export function cosine (a, b) {
  assertVector(a, 'a')
  assertVector(b, 'b')
  if (a.length !== b.length) throw new Error('length mismatch: ' + a.length + ' vs ' + b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) throw new Error('zero-norm vector')
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Nearest-rank percentile on an already sorted array: index ceil(p/100 * n) - 1.
function nearestRank (sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

// Summary of a list of finite numbers. Empty input gives nulls, not zeros,
// so an empty run is never mistaken for a fast one.
export function summary (samples) {
  if (!Array.isArray(samples)) throw new Error('samples must be an array')
  if (samples.length === 0) return { n: 0, p50: null, p95: null, min: null, max: null }
  for (let i = 0; i < samples.length; i++) {
    if (typeof samples[i] !== 'number' || !Number.isFinite(samples[i])) throw new Error('sample ' + i + ' must be a finite number')
  }
  const sorted = samples.slice().sort((x, y) => x - y)
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  }
}

const NAME = /^[a-z0-9-]+$/

// One line: 'sentinel-bench <name> k=v k=v'. Stats must be a flat object whose
// values are finite numbers (printed to 2 decimals) or null (printed as '-').
// Arrays, strings and anything else throw, so no text or vector reaches the
// log; callers pass only timings, sizes, counts and cosines.
export function formatLine (name, stats) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('bench name must match [a-z0-9-]+')
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) throw new Error('stats must be a flat object')
  const parts = ['sentinel-bench', name]
  for (const key of Object.keys(stats)) {
    if (!NAME.test(key.replace(/_/g, '-'))) throw new Error('bad stat key: ' + key)
    const value = stats[key]
    if (value === null) {
      parts.push(key + '=-')
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('stat ' + key + ' must be a finite number or null')
    parts.push(key + '=' + String(Math.round(value * 100) / 100))
  }
  return parts.join(' ')
}
