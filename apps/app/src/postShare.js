// What the publish sheet shows for post.shared, post.share and post.unshare
// (docs/rpc.md 5.121 to 5.123). Pure ES module: the caller passes the rpc
// `call(method, params)`, so tests run it without a node.
//
// Every function resolves to { state, shareSeq, message } and never rejects:
// - 'on' / 'off': what this device's node answered (after a write, what it
//   wrote, not what the seeder holds; the sheet words it that way);
// - 'uncertain': the outcome is unknown (an uncertain error, a timeout, a
//   lost connection, an internal error, an answer of the wrong shape);
// - 'error': the node refused, with plain words, never the raw message.
// One call sends one request. Nothing here retries.

export const UNCERTAIN_MESSAGE = 'Não deu para confirmar. Abra de novo para conferir.'

const REF = /^[0-9a-f]{64}:[1-9][0-9]*$/

// Codes the node answers before it changes anything for these methods.
const REFUSAL_CODES = new Set(['USAGE', 'NOT_FOUND', 'UNAUTHORIZED', 'LOCKED'])

const REFUSALS = Object.freeze({
  'referência inválida': 'Não encontramos esta publicação. Ela pode ter sido apagada.',
  'parâmetro inválido: to': 'Não encontramos esta publicação. Ela pode ter sido apagada.',
  'o registro não é uma publicação': 'Só uma publicação pode ir para a web.',
  'limite do diário atingido': 'Seu diário chegou ao limite de registros.',
  'limite de publicações na web atingido': 'Você chegou ao limite de publicações na web.',
  'identidade bloqueada: entre com a passkey': 'Entre com sua passkey para continuar.',
  'identidade não encontrada': 'Entre na sua conta para continuar.',
  'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.': 'Publicar na web só funciona pelo app ou pelo navegador.',
  'método desconhecido': 'Esta versão ainda não publica na web.'
})

const OFFLINE = 'Sem conexão com o servidor agora. Tente de novo em instantes.'

const FALLBACK = Object.freeze({
  read: 'Não deu para ver se esta publicação está na web.',
  publish: 'Não deu para publicar na web.',
  unpublish: 'Não deu para tirar da web.'
})

// -> { state: 'on' | 'off' | ..., shareSeq }
export function readShared (call, ref) {
  return run(call, 'post.shared', ref, 'read', (r) => {
    if (hasKeys(r, ['shareSeq']) && r.shareSeq === null) return result('off', null, '')
    if (hasKeys(r, ['shareSeq']) && isSeq(r.shareSeq)) return result('on', r.shareSeq, '')
    return null
  })
}

export function publish (call, ref) {
  return run(call, 'post.share', ref, 'publish', (r) => {
    if (hasKeys(r, ['shareSeq', 'created']) && isSeq(r.shareSeq) && typeof r.created === 'boolean') return result('on', r.shareSeq, '')
    return null
  })
}

export function unpublish (call, ref) {
  return run(call, 'post.unshare', ref, 'unpublish', (r) => {
    if (hasKeys(r, ['ok', 'changed']) && r.ok === true && typeof r.changed === 'boolean') return result('off', null, '')
    return null
  })
}

// The words for a failed call: exported for the tests.
export function errorState (err, action) {
  if (err === null || typeof err !== 'object' || err.uncertain === true || !REFUSAL_CODES.has(err.code)) {
    return result('uncertain', null, UNCERTAIN_MESSAGE)
  }
  const message = typeof err.message === 'string' ? err.message : ''
  if (Object.hasOwn(REFUSALS, message)) return result('error', null, REFUSALS[message])
  if (/semeador|conexão/.test(message)) return result('error', null, OFFLINE)
  return result('error', null, Object.hasOwn(FALLBACK, action) ? FALLBACK[action] : FALLBACK.read)
}

async function run (call, method, ref, action, read) {
  if (typeof call !== 'function' || typeof ref !== 'string' || !REF.test(ref)) {
    return result('error', null, REFUSALS['referência inválida'])
  }
  let answer
  try {
    answer = await call(method, { to: ref })
  } catch (err) {
    return errorState(err, action)
  }
  return read(answer) || result('uncertain', null, UNCERTAIN_MESSAGE)
}

function result (state, shareSeq, message) {
  return { state, shareSeq, message }
}

function isSeq (value) {
  return Number.isSafeInteger(value) && value >= 1
}

// Presence only: a key a later node adds does not make the answer unknown.
function hasKeys (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return keys.every((k) => Object.hasOwn(value, k))
}
