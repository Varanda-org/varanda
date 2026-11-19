'use strict'

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')

const KINDS = ['dm', 'dm-page', 'group', 'group-private']
const MAX_RESPONSE = 65536

function endpoint (value, name, originOnly = false) {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
    if (originOnly && (url.pathname !== '/' || url.search)) throw new Error()
    return url
  } catch {
    throw new Error(name + ' inválido')
  }
}

function post (url, headers, body, signal, agent) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(url, { method: 'POST', headers, signal, agent }, (res) => {
      let size = 0
      const chunks = []
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE) {
          res.destroy(new Error('resposta grande demais'))
        } else {
          chunks.push(chunk)
        }
      })
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('resposta interrompida')))
      res.on('end', () => {
        let data = null
        try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function createFcm (config = {}) {
  if (!config || typeof config !== 'object') throw new Error('config inválido')
  const { account, now = Date.now, timeoutMs = 10000 } = config
  if (!account || typeof account !== 'object') throw new Error('account ausente')
  for (const name of ['project_id', 'client_email', 'private_key', 'token_uri']) {
    if (typeof account[name] !== 'string' || !account[name].trim()) throw new Error(name + ' inválido ou ausente')
  }
  if (!/^[A-Za-z0-9-]+$/.test(account.project_id) || /[\r\n\0]/.test(account.project_id)) throw new Error('project_id inválido')
  if (typeof now !== 'function') throw new Error('now inválido')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('timeoutMs inválido')
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(account.private_key)
    if (privateKey.asymmetricKeyType !== 'rsa') throw new Error()
  } catch {
    throw new Error('private_key inválido')
  }
  const tokenUrl = endpoint(account.token_uri, 'token_uri')
  const audience = account.token_uri
  const email = account.client_email
  if (config.tokenOrigin !== undefined) {
    const override = endpoint(config.tokenOrigin, 'tokenOrigin', true)
    tokenUrl.protocol = override.protocol
    tokenUrl.host = override.host
  }
  const origin = endpoint(config.origin === undefined ? 'https://fcm.googleapis.com' : config.origin, 'origin', true)
  const messageUrl = new URL('/v1/projects/' + account.project_id + '/messages:send', origin)
  const agents = {
    'https:': new https.Agent({ keepAlive: true, maxSockets: 1 }),
    'http:': new http.Agent({ keepAlive: true, maxSockets: 1 })
  }
  let accessToken = null
  let refreshAt = 0
  let issuedAt = 0
  let tokenExchange = null

  async function oauthToken (signal) {
    const time = now()
    if (!Number.isFinite(time)) throw new Error('now inválido')
    if (accessToken && time >= issuedAt && time < refreshAt) return accessToken
    if (tokenExchange === null) {
      tokenExchange = exchangeToken(time, signal).finally(() => { tokenExchange = null })
    }
    return tokenExchange
  }

  async function exchangeToken (time, signal) {
    const iat = Math.floor(time / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: audience, iat, exp: iat + 3600 })).toString('base64url')
    const input = header + '.' + claims
    const assertion = input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
    const { status, data } = await post(tokenUrl, { 'content-type': 'application/x-www-form-urlencoded' }, body, signal, agents[tokenUrl.protocol])
    if (status !== 200 || !data || typeof data.access_token !== 'string' || !data.access_token.length || /[^\x21-\x7e]/.test(data.access_token) || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('resposta OAuth inválida')
    accessToken = data.access_token
    issuedAt = time
    refreshAt = time + Math.max(0, data.expires_in - 300) * 1000
    return accessToken
  }

  async function send (notice) {
    return deliver(notice, false)
  }

  async function sendSilent (notice) {
    return deliver(notice, true)
  }

  async function deliver (notice, silent) {
    let timer
    try {
      if (!notice || typeof notice !== 'object') return 'dropped'
      const { token, alert, tag, kind, g, close, asOf } = notice
      if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[^A-Za-z0-9_:-]/.test(token)) return 'dropped'
      if (silent) {
        if (!Array.isArray(close) || close.length < 1 || close.length > 64 || !Array.from(close).every(tag => typeof tag === 'string' && tag.length === 16 && /^[A-Za-z0-9_-]{16}$/.test(tag))) return 'dropped'
        if (!Number.isSafeInteger(asOf) || asOf < 0) return 'dropped'
      } else {
        if (typeof alert !== 'string' || !alert.length || alert.length > 200) return 'dropped'
        if (typeof tag !== 'string' || tag.length !== 16 || !/^[A-Za-z0-9_-]{16}$/.test(tag) || !KINDS.includes(kind)) return 'dropped'
        if (!Number.isSafeInteger(g) || g < 0) return 'dropped'
      }
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)
      const credential = await oauthToken(controller.signal)
      const body = JSON.stringify({
        message: silent
          ? {
              token,
              data: { k: 'seen-sync', c: close.join(','), a: String(asOf) },
              android: { priority: 'normal', collapse_key: 'seen-sync' }
            }
          : {
              token,
              notification: { body: alert },
              android: { collapse_key: tag, priority: 'high', notification: { tag, channel_id: 'conversas', event_time: new Date(g).toISOString() } },
              data: { k: kind, t: tag, g: String(g) }
            }
      })
      const { status, data } = await post(messageUrl, { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body, controller.signal, agents[messageUrl.protocol])
      if (status === 200) return 'ok'
      const error = data && data.error
      if (status === 404 && error && error.status === 'NOT_FOUND' && Array.isArray(error.details) && error.details.some(detail => detail && detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && detail.errorCode === 'UNREGISTERED')) return 'gone'
      return 'dropped'
    } catch {
      return 'dropped'
    } finally {
      clearTimeout(timer)
    }
  }

  return { send, sendSilent }
}

module.exports = { createFcm }
