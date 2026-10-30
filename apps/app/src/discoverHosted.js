// Native app: the verdict on the chosen installation's /varanda.json, under
// the same rules as the hosted web page (src/discovery.js): a transport
// failure may fall back to the remembered answer, any other answer that is
// not a { v: 1, association } JSON body within MAX_DISCOVERY_BYTES is
// invalid. The configuration is nativeHostedConfigOf's (kind 'hosted', the
// seeder at wss://<installation>/seeder). Pure: no react-native.

/* global URL */

import { discoveryOutcome, rememberedHostedConfig, MAX_DISCOVERY_BYTES } from './discovery.js'
import { nativeHostedConfigOf } from './config.js'

export { MAX_DISCOVERY_BYTES }

const validator = (installation) => (json) => nativeHostedConfigOf(json, { installation })

// React Native's fetch ignores redirect: 'error' and leaves `redirected`
// unset, so the final URL is checked too: an answer from anywhere but the
// installation's own /varanda.json is a redirect (the installation did not
// answer itself). A url that cannot be read counts as one; an absent or empty
// url (an engine that does not report it) is judged by `redirected` alone.
// -> true when the response must be treated as a redirect.
export function redirectedAway ({ redirected, url } = {}, { installation } = {}) {
  if (redirected === true) return true
  if (typeof url !== 'string' || url === '') return false
  try {
    const u = new URL(url)
    return u.origin !== installation || u.pathname !== '/varanda.json' || u.search !== '' || u.username !== '' || u.password !== ''
  } catch {
    return true
  }
}

// result: the fetch-like result of src/discovery.js discoveryOutcome.
// -> { verdict: 'transport' } | { verdict: 'invalid', error } |
// { verdict: 'live', config }.
export function hostedOutcome (result, { installation } = {}) {
  if (result === null || typeof result !== 'object') return { verdict: 'transport' }
  return discoveryOutcome(result, validator(installation))
}

// -> the configuration of a live, valid answer, else null.
export function discoverHosted (result, { installation } = {}) {
  const outcome = hostedOutcome(result, { installation })
  return outcome.verdict === 'live' ? outcome.config : null
}

// stored: { v: 1, origin, association } kept by the app. Only an answer of
// the same installation is used, and the seeder is always derived again.
// -> the configuration or null.
export function rememberedHosted (stored, { installation } = {}) {
  return rememberedHostedConfig(stored, { origin: installation }, validator(installation))
}
