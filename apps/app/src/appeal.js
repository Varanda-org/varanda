// Helpers for a blocked member's appeal (recurso) to the association's
// moderation. Pure ES module: no React and no Node built-ins, so Metro bundles
// it and Node's import() loads it in tests. Same flow and same-origin account
// service as ./report.js (whose request builder and JSON reader it shares);
// the statement itself is signed by the browser node (RPC appeal.sign,
// docs/rpc.md 5.57, @varanda/core lib/appeal.js).

import { buildPost, readJson, wellFormed } from './report.js'

export { wellFormed }

// Code points (Array.from length), as @varanda/core lib/appeal.js TEXT_MAX.
export const TEXT_MAX = 1000

const TIMEOUT_MS = 8000

export const NOT_LINKED_MESSAGE = 'Para recorrer, primeiro vincule sua conta Google em Ajustes → Conta e @nome.'

const ERROR_MESSAGES = {
  'nao-vinculado': NOT_LINKED_MESSAGE,
  'nao-bloqueado': 'esta conta não está bloqueada',
  'limite-recursos': 'você já recorreu nos últimos 30 dias',
  limite: 'a moderação não pode receber recursos agora',
  'assinatura-invalida': 'não foi possível provar a chave',
  expirado: 'o recurso expirou, tente de novo',
  'pedido-invalido': 'recurso inválido'
}
const FALLBACK_MESSAGE = 'serviço indisponível'

// The appellant's words -> trimmed string ('' when only whitespace), or null
// when longer than TEXT_MAX code points.
export function validateAppealText (text) {
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

// The request builders (exported for the tests; no network).
export function buildAppealStart ({ member }) {
  return buildPost('/account/appeal/start', { member })
}

export function buildAppealSend ({ member, nonce, text, signature }) {
  return buildPost('/account/appeal', { member, nonce, text, signature })
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
export async function appealStart ({ member }) {
  const data = await call(buildAppealStart({ member }))
  if (typeof data.nonce !== 'string') throw toError('indisponivel')
  return { nonce: data.nonce }
}

// -> { id, duplicate }
export async function appealSend (fields) {
  const data = await call(buildAppealSend(fields))
  return { id: typeof data.id === 'string' ? data.id : null, duplicate: data.duplicate === true }
}
