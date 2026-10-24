// The verdict on the answer of this origin's /varanda.json, and the remembered
// association of the last valid answer. Pure: no imports, no globals, so Node
// tests load it directly.

export const MAX_DISCOVERY_BYTES = 4096

const HEX64 = /^[0-9a-f]{64}$/

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// result: { kind: 'threw' } (fetch rejected, aborted or a refused redirect) or
// { kind: 'response', status, contentType, text, redirected, oversized?,
// invalidText? }. oversized: the body passed MAX_DISCOVERY_BYTES and its read
// was cancelled; invalidText: the body is not valid UTF-8. Both are judged
// only after the status and the content type, without measuring text.
// validate(json) -> { config } or { error }.
// -> { verdict: 'transport' } (the installation did not answer: a remembered
// configuration may stand in), { verdict: 'invalid', error } (it answered, and
// the answer is not a configuration) or { verdict: 'live', config }.
export function discoveryOutcome (result, validate) {
  if (result.kind === 'threw' || result.redirected === true) return { verdict: 'transport' }
  const { status } = result
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return { verdict: 'transport' }
  if (!(status >= 200 && status <= 299)) return { verdict: 'invalid', error: 'status' }
  if (!/application\/json/i.test(result.contentType || '')) return { verdict: 'invalid', error: 'content-type' }
  if (result.oversized === true) return { verdict: 'invalid', error: 'size' }
  if (result.invalidText === true) return { verdict: 'invalid', error: 'text' }
  const text = typeof result.text === 'string' ? result.text : ''
  if (utf8Length(text) > MAX_DISCOVERY_BYTES) return { verdict: 'invalid', error: 'size' }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { verdict: 'invalid', error: 'json' }
  }
  if (!isPlainObject(json)) return { verdict: 'invalid', error: 'shape' }
  const checked = validate(json)
  if (checked.error !== undefined || !checked.config) return { verdict: 'invalid', error: checked.error }
  return { verdict: 'live', config: checked.config }
}

// stored: the parsed localStorage value { v: 1, origin, association }. Only the
// association of the same origin is used; a stored seederUrl is never trusted
// (the seeder is always this origin's /seeder, derived by validate).
// -> the configuration or null.
export function rememberedHostedConfig (stored, { origin }, validate) {
  if (!isPlainObject(stored) || stored.v !== 1) return null
  if (typeof origin !== 'string' || stored.origin !== origin) return null
  if (typeof stored.association !== 'string' || !HEX64.test(stored.association)) return null
  return validate({ v: 1, association: stored.association }).config || null
}

function utf8Length (text) {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
