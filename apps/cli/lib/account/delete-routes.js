'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAccountLink } = require('@varanda/core/lib/account-link')

// Excluir conta (README "Excluir conta", docs/protocol.md "Account
// deletion"): the member asks, from the app, to delete the account. Mounted
// by ./server.js.
//
//   - POST /account/delete/start { member } -> { nonce, username }: no proof,
//     a linked member only (as /account/rename/start). A deleted key answers
//     'conta-excluida'; a member who still owns a live page answers
//     'paginas-ativas' (closing a page needs the owner's signed record, and
//     the page's other admins would lose it without warning). The nonce is
//     single-use, in memory, for NONCE_TTL_MS; the table is bounded and its
//     oldest row goes first.
//   - POST /account/delete/finish { member, nonce, signature } -> { deleted }:
//     the account-link proof (packages/core/lib/account-link.js) at phase
//     'delete', over the nonce and the member's current @nome (the one the
//     person typed to confirm), charged on a per-member window after it
//     verified. Then, in this order:
//       1. the block of the member's diary is queued in the moderation desk
//          (./moderation-store.js requestDeletion, actor 'titular'), so a
//          failure here deletes nothing and is a definite refusal;
//       2. the directory deletes the link (./store.js deleteMember): sub,
//          e-mail, certificate and records go, the names stay burned;
//       3. the other stores are purged (./deletion.js purge), and the
//          periodic sweep retries whatever could not be purged now.
//     A failure after step 1 is 'resultado-incerto': the block is queued
//     either way, and a retry finds the key deleted or deletes it.
//     `deleted` is 'concluida' once the published blocklist holds the key
//     (the operator's `mod apply` signed it and the seeder received it),
//     else 'pendente'.
//
// A finish for a key already deleted answers { deleted } as a success, so
// a retry after an uncertain answer ends well. Logs carry only
// { event: 'exclusao', reason }: never a key, a name or an address.

const MAX_BODY = 4096
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/

// createDeleteRoutes({ accounts, moderation, pagesStore, purge, isBlocked,
// association, now, log, memberLimit, send, refuse, fromStore, checkPost,
// readJsonBody, over }) -> { owns, handle, stats }.
function createDeleteRoutes ({ accounts, moderation = null, pagesStore = null, purge = async () => ({ pending: 0 }), isBlocked = () => false, association, now = Date.now, log = () => {}, memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over }) {
  // nonce -> { member, username, expiresAt }, insertion order = age.
  const nonces = new Map()

  function sweep () {
    const t = now()
    for (const [n, row] of nonces) {
      if (row.expiresAt <= t) nonces.delete(n)
    }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function state (member) {
    return isBlocked(member) ? 'concluida' : 'pendente'
  }

  // Pages the member owns that are neither closed nor moved. A store that
  // cannot answer refuses: deleting the owner would orphan the page.
  function ownsLivePage (member) {
    if (pagesStore === null) return false
    try {
      return pagesStore.listFor(member).owned.some((p) => !p.closed && p.movedTo === null)
    } catch {
      throw refuse('indisponivel')
    }
  }

  // -> the member's current @nome; refuses a deleted or unlinked key.
  function currentName (member) {
    if (accounts.deletedAt(member) !== null) throw refuse('conta-excluida')
    const st = accounts.status(member)
    if (!st.linked) throw refuse('nao-vinculado')
    return st.username
  }

  async function start (req, res, body) {
    const member = memberParam(body.member)
    const username = currentName(member)
    if (ownsLivePage(member)) throw refuse('paginas-ativas')
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, username, expiresAt: now() + NONCE_TTL_MS })
    send(res, 200, { nonce, username })
  }

  async function finish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && NONCE_RE.test(body.nonce) ? body.nonce : null
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const row = nonce === null ? undefined : nonces.get(nonce)
    // Single-use: the nonce is spent by its first finish, whatever the outcome.
    if (nonce !== null) nonces.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    const fields = { phase: 'delete', nonce, member, username: row.username, association, sub: '' }
    if (!verifyAccountLink(fields, body.signature).ok) throw refuse('assinatura-invalida')
    if (!memberLimit(member)) throw over()
    if (accounts.deletedAt(member) !== null) {
      send(res, 200, { deleted: state(member) })
      return
    }
    // A rename between start and finish: the typed name is no longer it.
    if (currentName(member) !== row.username) throw refuse('expirado')
    if (ownsLivePage(member)) throw refuse('paginas-ativas')
    if (moderation === null) throw refuse('indisponivel')
    try {
      await moderation.requestDeletion(member)
    } catch (err) {
      throw fromStore(err)
    }
    try {
      await accounts.deleteMember(member)
    } catch {
      log({ event: 'exclusao', reason: 'diretorio-incerto' })
      throw refuse('resultado-incerto')
    }
    log({ event: 'exclusao', reason: 'pedido' })
    await purge(member)
    send(res, 200, { deleted: state(member) })
  }

  const POST = {
    '/account/delete/start': start,
    '/account/delete/finish': finish
  }

  function owns (pathname) {
    return pathname === '/account/delete' || pathname.startsWith('/account/delete/')
  }

  async function handle (req, res, url) {
    const p = url.pathname
    if (req.method === 'POST' && Object.hasOwn(POST, p)) {
      checkPost(req)
      const body = await readJsonBody(req, MAX_BODY)
      return POST[p](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only, never a nonce.
  function stats () {
    return { nonces: nonces.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  NONCE_TTL_MS,
  createDeleteRoutes
}
