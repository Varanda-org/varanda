/* global AbortController, setTimeout, clearTimeout */

// Guest AWS credentials for the face liveness capture, shared by the web
// detector and the native module. The account service hands the device only
// { sessionId, region, identityPoolId }; the device asks Cognito for an
// unauthenticated identity itself, so no AWS secret ever passes through the
// service. Nothing is cached in module scope: every capture gets fresh
// credentials, and they live only as long as the caller keeps them.

// Same list as apps/cli/lib/account/hodle.js and the hosted CSP: a region
// outside it would need a connect-src the page does not allow.
export const STREAMING_REGIONS = Object.freeze([
  'us-east-1',
  'us-west-2',
  'ap-south-1',
  'ap-northeast-1',
  'eu-west-1',
  'sa-east-1',
  'ap-southeast-5',
  'ap-southeast-7'
])

// Same grammar as ID_RE in apps/cli/lib/account/hodle.js.
export const SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_FIELD = 8192

function codeError (code) {
  const err = new Error(code === 'TIMEOUT'
    ? 'A verificação demorou demais. Tente de novo.'
    : 'Não foi possível preparar a verificação. Tente de novo.')
  err.code = code
  return err
}

function validRegion (region) {
  return typeof region === 'string' && STREAMING_REGIONS.includes(region)
}

function validPool (region, pool) {
  if (!validRegion(region) || typeof pool !== 'string') return false
  const prefix = region + ':'
  return pool.startsWith(prefix) && UUID_RE.test(pool.slice(prefix.length))
}

function nonEmpty (v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD
}

export function parseCapture (obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const { sessionId, region, identityPoolId } = obj
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!validPool(region, identityPoolId)) return null
  return { sessionId, region, identityPoolId }
}

export function createCredentialProvider ({ region, identityPoolId, fetch, timeoutMs = 8000, endpoint } = {}) {
  const usable = validPool(region, identityPoolId) && typeof fetch === 'function'
  const url = endpoint || 'https://cognito-identity.' + region + '.amazonaws.com/'

  async function call (target, payload, signal) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityService.' + target
        },
        body: JSON.stringify(payload),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal
      })
    } catch {
      throw codeError(signal && signal.aborted ? 'TIMEOUT' : 'CREDENTIALS')
    }
    if (!res || res.status !== 200 || res.redirected) throw codeError('CREDENTIALS')
    try {
      const data = await res.json()
      if (!data || typeof data !== 'object') throw new Error()
      return data
    } catch {
      throw codeError(signal && signal.aborted ? 'TIMEOUT' : 'CREDENTIALS')
    }
  }

  async function fetchCredentials (signal) {
    const id = await call('GetId', { IdentityPoolId: identityPoolId }, signal)
    if (!nonEmpty(id.IdentityId)) throw codeError('CREDENTIALS')
    const out = await call('GetCredentialsForIdentity', { IdentityId: id.IdentityId }, signal)
    const c = out.Credentials
    if (!c || typeof c !== 'object') throw codeError('CREDENTIALS')
    const { AccessKeyId, SecretKey, SessionToken, Expiration } = c
    if (!nonEmpty(AccessKeyId) || !nonEmpty(SecretKey) || !nonEmpty(SessionToken)) throw codeError('CREDENTIALS')
    if (typeof Expiration !== 'number' || !Number.isFinite(Expiration) || Expiration <= 0) throw codeError('CREDENTIALS')
    return {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretKey,
      sessionToken: SessionToken,
      expiration: new Date(Expiration * 1000)
    }
  }

  return async function credentialProvider () {
    if (!usable) throw codeError('CREDENTIALS')
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort()
        reject(codeError('TIMEOUT'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([fetchCredentials(ctrl ? ctrl.signal : undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
