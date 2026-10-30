// Helpers for a member's report (denúncia) to the association's moderation.
// Pure ES module: no React and no Node built-ins, so Metro bundles it and
// Node's import() loads it in tests. The page talks to the same-origin account
// service; the statement itself is signed by the browser node (RPC
// report.sign, docs/rpc.md 5.20, @varanda/core lib/report.js).
//
// The fetch wrapper follows the same rules as ./account.js (same-origin
// credentials, no cache, 8 s timeout, JSON read only when the content type
// says so and the body is under 4096 bytes); it is a local copy so that file
// stays untouched.

import { resolveUrl } from './installation.js'
import { isAppClient } from './appClient.js'

// Same order and labels as @varanda/core lib/report.js REASONS/REASON_LABELS.
export const REASONS = [['spam', 'spam'], ['assedio', 'assédio'], ['ilegal', 'conteúdo ilegal'], ['outro', 'outro']]
// Code points (Array.from length), as report.js TEXT_MAX and format.js countChars.
export const TEXT_MAX = 280

const TIMEOUT_MS = 8000
const MAX_BODY = 4096

export const NOT_LINKED_MESSAGE = 'Para denunciar, primeiro vincule sua conta Google em Ajustes → Conta e @nome.'

const ERROR_MESSAGES = {
  'nao-vinculado': NOT_LINKED_MESSAGE,
  'limite-denuncias': 'muitas denúncias em 24 horas; tente de novo amanhã',
  limite: 'a moderação não pode receber denúncias agora',
  'assinatura-invalida': 'não foi possível provar a chave',
  expirado: 'a denúncia expirou, tente de novo',
  'pedido-invalido': 'denúncia inválida'
}
const FALLBACK_MESSAGE = 'serviço indisponível'
const REPLACEMENT = String.fromCodePoint(0xfffd)

// Lone surrogates become U+FFFD (String.prototype.toWellFormed, spelled out
// for runtimes without it): report.js refuses a string that is not well
// formed, because a lone surrogate and U+FFFD give the same UTF-8 bytes and a
// digest would not bind the exact text (B3 D5). Posts may legally hold them.
export function wellFormed (s) {
  if (typeof s !== 'string') return ''
  if (typeof s.toWellFormed === 'function') return s.toWellFormed()
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1]
        i++
      } else {
        out += REPLACEMENT
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += REPLACEMENT
    } else {
      out += s[i]
    }
  }
  return out
}

// The reporter's note -> trimmed string ('' when only whitespace), or null
// when longer than TEXT_MAX code points.
export function validateReportText (text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return Array.from(trimmed).length > TEXT_MAX ? null : trimmed
}

// Never carries a raw body: the message comes from a fixed table.
export function toError (code) {
  const known = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
  const err = new Error(known ? ERROR_MESSAGES[code] : FALLBACK_MESSAGE)
  err.code = known ? code : 'indisponivel'
  return err
}

export async function readJson (res) {
  const type = res.headers && res.headers.get ? res.headers.get('content-type') : ''
  if (!/^application\/json\b/i.test(type || '')) return null
  let text
  try { text = await res.text() } catch { return null }
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BODY) return null
  try { return JSON.parse(text) } catch { return null }
}

export function buildPost (path, body) {
  const app = isAppClient()
  const headers = { accept: 'application/json', 'content-type': 'application/json' }
  if (app) headers['x-varanda-client'] = 'app'
  return {
    url: resolveUrl(path),
    init: {
      method: 'POST',
      credentials: app ? 'omit' : 'same-origin',
      // React Native's fetch (whatwg-fetch) appends '_=<timestamp>' to the
      // URL for 'no-store'; one rule for every app request (media/fetch.js).
      ...(app ? {} : { cache: 'no-store' }),
      headers,
      body: JSON.stringify(body)
    }
  }
}

// The request builders (exported for the tests; no network).
export function buildReportStart ({ member }) {
  return buildPost('/account/report/start', { member })
}

// `seq` null = a report of the whole account (quote '').
export function buildReportSend ({ member, nonce, target, seq, reason, text, quote, signature }) {
  return buildPost('/account/report', { member, nonce, target, seq, reason, text, quote, signature })
}

async function call ({ url, init }) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  let res
  let data
  try {
    res = await fetch(url, { ...init, signal: ctl.signal })
    data = await readJson(res)
  } catch {
    throw toError('indisponivel')
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw toError('indisponivel')
    return data
  }
  throw toError(data && typeof data.error === 'string' ? data.error : '')
}

// -> { nonce }
export async function reportStart ({ member }) {
  const data = await call(buildReportStart({ member }))
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

// -> { id, duplicate }
export async function reportSend (fields) {
  const data = await call(buildReportSend(fields))
  return { id: typeof data.id === 'string' ? data.id : null, duplicate: data.duplicate === true }
}
