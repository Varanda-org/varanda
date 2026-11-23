'use strict'

// The association's own review accounts (README "Conta de revisão"): the App
// Store and Google Play reviewers sign in with a recovery code the operator
// hands to the store. `account review` (../commands/account.js) makes one
// with no device, under the service's lock: a random 32-byte root stands in
// for a passkey's PRF output, so the diary key comes from it exactly as on a
// device (@varanda/web-member lib/passkey.js keyPairFromPrf), and the code
// wraps that root as Ajustes > Passkeys e recuperação does (lib/recovery.js
// wrapRoot). The reviewer enters the code and creates a passkey, as anyone
// who recovers an account does.
//
// No one's face, document or number is used. The association records an age
// band for its own account with method 'associacao' (./age-store.js), and
// that band is also what lets the key through the phone gate
// (./phone-routes.js reviewAccount), so VARANDA_PHONE_REVIEW stays for
// accounts made on a device.
//
// Order: the name is reserved (a pending row, in memory only), the band is
// recorded, the link is written, then the code. The band comes first because
// a linked member with no band would move the age-since directory floor
// (./age-check-state.js) for everyone. A definite refusal of the link forgets
// the band again (best effort: an unlinked band is also swept after
// AGE_UNLINKED_TTL_MS). The code is returned once, after everything is on
// disk, and never reaches a log or an error.
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const { keyPairFromPrf } = require('@varanda/web-member/lib/passkey')
const { CODE_BYTES, deriveRecoveryKeys, wrapRoot, encodeCode } = require('@varanda/web-member/lib/recovery')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { phoneSub } = require('./store')

const REVIEW_METHOD = 'associacao'
const REVIEW_BAND = '18+'
// The same bound as VARANDA_PHONE_REVIEW: one per store and a spare each.
const REVIEW_MAX = 4
const ROOT_BYTES = 32
// Store refusals that prove the link was not written.
const DEFINITE = new Set(['nome-invalido', 'nome-em-uso', 'conta-vinculada', 'conta-excluida', 'expirado', 'lista-de-espera', 'convite-invalido'])
const NAME_ERRORS = {
  'nome-invalido': 'nome inválido: de 3 a 20 letras minúsculas, números ou _, começando por letra, fora da lista de palavras e dos nomes reservados',
  'nome-em-uso': 'nome em uso'
}

// True when `member` has the association's band. Never throws: a store that
// cannot answer keeps the gate shut.
function isReviewAccount (ages, member) {
  if (ages === null || ages === undefined) return false
  try {
    const entry = ages.get(member)
    return entry !== null && entry.method === REVIEW_METHOD
  } catch {
    return false
  }
}

// The review accounts on record that were not deleted.
function reviewMembers (ages, accounts) {
  return ages.entries()
    .filter((e) => e.method === REVIEW_METHOD && accounts.deletedAt(e.member) === null)
    .map((e) => e.member)
}

function codeOf (err) {
  return err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : null
}

function reserve (accounts, member, username) {
  try {
    return accounts.start({ member, username })
  } catch (err) {
    const code = codeOf(err)
    throw new Error(NAME_ERRORS[code] ?? 'não foi possível reservar o nome' + (code === null ? '' : ' (' + code + ')'))
  }
}

function bytes (randomBytes, n) {
  const raw = randomBytes(n)
  const out = new Uint8Array(n)
  out.set(raw)
  raw.fill(0)
  return out
}

// { username, association, issuer: { keyPair, cert }, accounts, ages,
// recovery } -> { member, username, code }. The stores are open for writing
// under the service's lock; `username` is already lowercase without '@'.
// `randomBytes` is for tests.
async function createReviewAccount ({ username, association, issuer, accounts, ages, recovery, randomBytes = nodeCrypto.randomBytes }) {
  if (reviewMembers(ages, accounts).length >= REVIEW_MAX) {
    throw new Error('já existem ' + REVIEW_MAX + ' contas de revisão: exclua uma com account delete antes de criar outra')
  }
  const root = bytes(randomBytes, ROOT_BYTES)
  let kp = null
  let secret = null
  let wrapKey = null
  try {
    kp = await keyPairFromPrf(root)
    const member = b4a.toString(kp.publicKey, 'hex')
    const row = reserve(accounts, member, username)
    try {
      await ages.record({ member, band: REVIEW_BAND, method: REVIEW_METHOD })
    } catch {
      accounts.dropPending(row.id)
      throw new Error('não foi possível gravar a idade em age.json: confira o arquivo e rode de novo')
    }
    try {
      const signature = signAccountLink({ phase: 'finish', nonce: row.nonce, member, username, association, sub: phoneSub(member) }, kp)
      await accounts.finish(row.id, { signature, phone: true }, issuer.keyPair, issuer.cert, association)
    } catch (err) {
      const code = codeOf(err)
      accounts.dropPending(row.id)
      if (!DEFINITE.has(code)) {
        throw new Error('não foi possível confirmar o vínculo da chave ' + member + ': confira com account status antes de rodar de novo')
      }
      try {
        await ages.forget(member)
      } catch {}
      throw new Error(NAME_ERRORS[code] ?? 'vínculo recusado (' + code + ')')
    }
    secret = bytes(randomBytes, CODE_BYTES)
    const derived = await deriveRecoveryKeys(secret, 'code')
    wrapKey = derived.wrapKey
    const blob = wrapRoot({ root, member, kind: 'code', wrapKey })
    try {
      await recovery.put({ member, kind: 'code', lookupId: derived.lookupId, blob })
    } catch {
      throw new Error('a conta @' + username + ' foi criada sem código de recuperação: exclua com account delete --member ' + member + ' --yes --force e crie outra')
    }
    return { member, username, code: encodeCode(secret) }
  } finally {
    root.fill(0)
    if (kp !== null) kp.secretKey.fill(0)
    if (secret !== null) secret.fill(0)
    if (wrapKey !== null) wrapKey.fill(0)
  }
}

module.exports = {
  REVIEW_METHOD,
  REVIEW_BAND,
  REVIEW_MAX,
  isReviewAccount,
  reviewMembers,
  createReviewAccount
}
