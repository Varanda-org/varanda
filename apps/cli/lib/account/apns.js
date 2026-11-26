'use strict'

const http2 = require('node:http2')
const crypto = require('node:crypto')

const KINDS = ['dm', 'dm-page', 'group', 'group-private', 'social', 'invite-drop']
const MAX_RESPONSE = 65536

function createApns (config = {}) {
  if (!config || typeof config !== 'object') throw new Error('config inválido')
  const { key, keyId, teamId, topic, sandbox = false, now = Date.now, timeoutMs = 10000 } = config
  for (const [name, value] of Object.entries({ key, keyId, teamId, topic })) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(name === 'key' ? '' : value)) throw new Error(name + ' inválido ou ausente')
  }
  if (typeof sandbox !== 'boolean') throw new Error('sandbox inválido')
  if (typeof now !== 'function') throw new Error('now inválido')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('timeoutMs inválido')
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(key)
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error()
  } catch {
    throw new Error('key inválido')
  }
  let origin
  try {
    origin = new URL(config.origin === undefined ? (sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com') : config.origin)
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error()
  } catch {
    throw new Error('origin inválido')
  }

  let session = null
  let jwt = null
  let issuedAt = 0

  function providerToken () {
    const time = now()
    if (!Number.isFinite(time)) throw new Error('now inválido')
    if (jwt && time >= issuedAt && time - issuedAt < 50 * 60 * 1000) return jwt
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(time / 1000) })).toString('base64url')
    const input = header + '.' + claims
    const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    jwt = input + '.' + signature.toString('base64url')
    issuedAt = time
    return jwt
  }

  function connection () {
    if (session && !session.closed && !session.destroyed) return session
    const current = http2.connect(origin.origin)
    session = current
    const forget = () => {
      if (session === current) session = null
    }
    current.on('close', forget)
    current.on('error', () => {
      forget()
      current.destroy()
    })
    current.on('goaway', () => {
      forget()
      current.close()
    })
    return current
  }

  async function send (notice) {
    return deliver(notice, false)
  }

  async function sendSilent (notice) {
    return deliver(notice, true)
  }

  async function deliver (notice, silent) {
    try {
      if (!notice || typeof notice !== 'object') return 'dropped'
      const { token, alert, tag, kind, g, close, asOf } = notice
      if (typeof token !== 'string' || token.length < 64 || token.length > 200 || /[^a-f0-9]/.test(token)) return 'dropped'
      if (silent) {
        if (!Array.isArray(close) || close.length < 1 || close.length > 64 || !Array.from(close).every(tag => typeof tag === 'string' && tag.length === 16 && /^[A-Za-z0-9_-]{16}$/.test(tag))) return 'dropped'
        if (!Number.isSafeInteger(asOf) || asOf < 0) return 'dropped'
      } else {
        if (typeof alert !== 'string' || !alert.length || alert.length > 200) return 'dropped'
        if (typeof tag !== 'string' || tag.length !== 16 || !/^[A-Za-z0-9_-]{16}$/.test(tag) || !KINDS.includes(kind)) return 'dropped'
        if (!Number.isSafeInteger(g) || g < 0) return 'dropped'
      }
      const authorization = 'bearer ' + providerToken()
      const current = connection()
      return await new Promise((resolve) => {
        let stream
        let settled = false
        const finish = (outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        }
        const timer = setTimeout(() => {
          finish('dropped')
          if (stream) stream.close(http2.constants.NGHTTP2_CANCEL)
          if (current.connecting) current.destroy()
        }, timeoutMs)
        try {
          stream = current.request({
            ':method': 'POST',
            ':path': '/3/device/' + token,
            authorization,
            'apns-topic': topic,
            'apns-push-type': silent ? 'background' : 'alert',
            'apns-priority': silent ? '5' : '10',
            ...(silent ? {} : { 'apns-collapse-id': tag }),
            'content-type': 'application/json'
          })
          let status = 0
          let size = 0
          const chunks = []
          stream.on('response', (headers) => { status = headers[':status'] })
          stream.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_RESPONSE) {
              finish('dropped')
              stream.close(http2.constants.NGHTTP2_CANCEL)
            } else {
              chunks.push(chunk)
            }
          })
          stream.on('error', () => finish('dropped'))
          stream.on('aborted', () => finish('dropped'))
          stream.on('close', () => finish('dropped'))
          stream.on('end', () => {
            if (stream.rstCode) return finish('dropped')
            if (status === 200) return finish('ok')
            let reason
            try { reason = JSON.parse(Buffer.concat(chunks).toString()).reason } catch {}
            finish(status === 410 && reason === 'Unregistered' ? 'gone' : 'dropped')
          })
          stream.end(JSON.stringify(silent
            ? { aps: { 'content-available': 1 }, k: 'seen-sync', c: close, a: asOf }
            : { aps: { alert: { body: alert }, sound: 'default', 'thread-id': kind }, k: kind, t: tag, g }))
        } catch {
          finish('dropped')
          if (stream) stream.destroy()
        }
      })
    } catch {
      return 'dropped'
    }
  }

  function close () {
    if (session) session.destroy()
    session = null
  }

  return { send, sendSilent, close }
}

module.exports = { createApns }
