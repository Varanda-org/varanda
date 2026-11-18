'use strict'

const nodeCrypto = require('node:crypto')
const { verifyAccountLink, isUsername } = require('@varanda/core/lib/account-link')
const { isBrMobile } = require('@varanda/core/lib/phone')
const { verifyAssertion, isAssertion } = require('./webauthn')
const { countedKeys } = require('./passkey-store')
const { ownsLivePage: ownsLive } = require('./live-page')

// Excluir conta (README "Excluir conta", docs/protocol.md "Account
// deletion"): the member asks, from the app, to delete the account. Mounted
// by ./server.js.
//
//   - POST /account/delete/start { member } -> { nonce, username, passkeys,
//     scheduled }: no proof, a linked member only (as /account/rename/start).
//     A deleted key answers 'conta-excluida'; a member who still owns a live
//     page answers 'paginas-ativas' (closing a page needs the owner's signed
//     record, and the page's other admins would lose it without warning).
//     `passkeys` lists the credential ids whose public keys the service holds
//     for the member (./passkey-store.js: the one enrolled at sign-up and
//     each extra passkey a stored one vouched for, ./passkey-routes.js);
//     `scheduled` is the date of a deletion already
//     waiting, or null. The nonce is single-use, in memory, for
//     NONCE_TTL_MS; the table is bounded and its oldest row goes first. Its
//     32 bytes are also the challenge of the passkey ceremony.
//   - POST /account/delete/finish { member, nonce, signature, assertion?,
//     wait? }: the account-link proof (packages/core/lib/account-link.js) at
//     phase 'delete', over the nonce and the member's current @nome (the one
//     the person typed to confirm), charged on a per-member window after it
//     verified. Then:
//       a. `assertion` of a stored passkey ({ credentialId, clientDataJSON,
//          authenticatorData, signature }, ./webauthn.js verifyAssertion: the
//          nonce as challenge, this installation's rpId and origins, UP and
//          UV, the signature under the stored key, a counter that never goes
//          back) -> the deletion runs now and answers { deleted }. An
//          assertion of a stored passkey that does not verify answers
//          'passkey-invalida' and deletes nothing.
//       b. otherwise, with `wait: true` (no key is stored, as for every
//          account older than enrolment, or the person no longer has that
//          passkey) -> the deletion is scheduled WAIT_MS ahead and answers
//          { scheduled }. Every signed-in device learns it from
//          /account/status, a push goes out when notices are on, and the
//          person can cancel it from any device. Asking again keeps the
//          first date. Without `wait`, the answer is 'passkey-invalida'.
//          A schedule write that failed answers 'resultado-incerto' (it may
//          have landed).
//     The deletion itself, now or at its date, runs in this order:
//       1. the block of the member's diary is queued in the moderation desk
//          (./moderation-store.js requestDeletion, actor 'titular'), so a
//          failure here deletes nothing and is a definite refusal;
//       2. the directory deletes the link (./store.js deleteMember): sub,
//          e-mail, certificate and records go, the names stay burned;
//       3. the other stores are purged (./deletion.js purge, the passkeys
//          and the schedule included), and the periodic sweep retries
//          whatever could not be purged now.
//     A failure after step 1 is 'resultado-incerto': the block is queued
//     either way, and a retry finds the key deleted or deletes it.
//     `deleted` is 'concluida' once the published blocklist holds the key
//     (the operator's `mod apply` signed it and the seeder received it),
//     else 'pendente'.
//   - POST /account/delete/cancel/start { member } -> { nonce, username,
//     scheduled }
//     and POST /account/delete/cancel/finish { member, nonce, signature } ->
//     { cancelled }: the account-link proof at phase 'cancel' over the nonce
//     and the current @nome. `cancelled` is false when nothing was waiting.
//   - POST /account/delete/sms/send { username, phone } -> { sent: true }
//     and POST /account/delete/sms/check { username, phone, code } ->
//     { requested: true }: Excluir conta sem a passkey. No diary proof: the
//     @nome and the number the member verified (E.164), then the code the
//     provider texted to that number (./phone-routes.js deletionCodes, which
//     compares the typed number's index with the live, verified row and
//     never unseals one). send answers { sent: true } for an unknown @nome,
//     a page, a deleted account, a number that is not the member's, a
//     waiting deletion, a full window and a resend alike, and the code goes
//     after the answer; check answers 'codigo-invalido' for each of them,
//     and for a provider failure, at SMS_CHECK_FLOOR_MS from the request's
//     start. A correct code (the @nome and the number compared again first)
//     only files a request in `requests` (./deletion-requests.js) and
//     schedules nothing: the operator schedules with `varanda account
//     delete` once the owner writes to contato@varanda.app, and the wait
//     starts then. A code proves the line, not the person holding it, so
//     the operator talks to the owner first. Limits, none of them read by
//     another route: the global daily ceiling of deletion codes (a full one
//     skips the send, same answer), 3 codes a day per (member, number) and
//     3 a day per number that matched, 60 s between sends, 3 attempts and
//     10 minutes per code, and smsCheckLimit per member on a check whose
//     number matched the pending code.
//   - runScheduled() (the deletion sweep calls it every hour) drops the
//     requests older than 30 days and runs each deletion whose date came. A
//     member who meanwhile came to own a live page is skipped and retried at
//     the next sweep.
//
// The residual of the wait: anyone holding an unlocked session can schedule
// a deletion, which the person sees on a signed-in device once it reads the
// account status and can cancel for WAIT_MS. A finish for a key already deleted answers { deleted } as a
// success, so a retry after an uncertain answer ends well. Logs carry only
// { event: 'exclusao', reason }: never a key, a name or an address.

const MAX_BODY = 8192
const NONCE_TTL_MS = 600 * 1000
const MAX_NONCES = 1000
const WAIT_MS = 7 * 24 * 3600 * 1000
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/
const CODE_RE = /^[0-9]{6}$/
// Every refusal of the SMS check that depends on the account leaves at this
// time from the request's start, so the answer is the same whether or not
// the number matched or the provider was asked.
const SMS_CHECK_FLOOR_MS = 3000

// createDeleteRoutes({ accounts, moderation, pagesStore, passkeys, recovery,
// purge, isBlocked, notify, rpId, origins, association, now, log,
// memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over })
// -> { owns, handle, stats, scheduled(member), runScheduled() }.
// `passkeys` is an openPasskeyStore (null or unavailable: every route answers
// 503 'indisponivel', since neither a verified nor a scheduled deletion can
// be recorded). `recovery` (an openRecoveryStore or null) says which extra
// passkey keys still count (passkey-store countedKeys): a key whose recovery
// entry is gone neither shows in `passkeys` nor deletes at once. `notify(member)`
// sends the push notice of a new schedule. `codes` is the phone routes'
// deletionCodes and `requests` an openDeletionRequests (either null: the SMS
// routes answer 'indisponivel'); `smsCheckLimit` is the per-member window of
// the SMS check.
function createDeleteRoutes ({ codes = null, requests = null, smsCheckLimit = () => true, smsCheckFloorMs = SMS_CHECK_FLOOR_MS, accounts, moderation = null, pagesStore = null, passkeys = null, recovery = null, purge = async () => ({ pending: 0 }), isBlocked = () => false, notify = () => {}, beforeDelete = async () => {}, rpId, origins = [], association, now = Date.now, log = () => {}, memberLimit, send, refuse, fromStore, checkPost, readJsonBody, over }) {
  // nonce -> { member, username, kind, expiresAt }, insertion order = age.
  const nonces = new Map()

  function sweep () {
    const t = now()
    for (const [n, row] of nonces) {
      if (row.expiresAt <= t) nonces.delete(n)
    }
  }

  function mint (member, username, kind) {
    sweep()
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value)
    const nonce = nodeCrypto.randomBytes(32).toString('base64url')
    nonces.set(nonce, { member, username, kind, expiresAt: now() + NONCE_TTL_MS })
    return nonce
  }

  // Single-use: the nonce is spent by its first finish, whatever the outcome.
  function spend (body, member, kind) {
    const nonce = typeof body.nonce === 'string' && NONCE_RE.test(body.nonce) ? body.nonce : null
    const row = nonce === null ? undefined : nonces.get(nonce)
    if (nonce !== null) nonces.delete(nonce)
    if (row === undefined || row.member !== member || row.kind !== kind || row.expiresAt <= now()) throw refuse('expirado')
    return { nonce, username: row.username }
  }

  function memberParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  function usable () {
    if (passkeys === null || !passkeys.available()) throw refuse('indisponivel')
  }

  function state (member) {
    return isBlocked(member) ? 'concluida' : 'pendente'
  }

  function ownsLivePage (member) {
    try {
      return ownsLive(pagesStore, member)
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

  function fromPasskeys (fn) {
    try {
      return fn()
    } catch (err) {
      throw fromStore(err)
    }
  }

  // The date of the member's waiting deletion, or null (also when the store
  // cannot answer: /account/status must keep answering).
  function scheduled (member) {
    if (passkeys === null || !passkeys.available()) return null
    try {
      const h = passkeys.hold(member)
      return h === null ? null : h.runAt
    } catch {
      return null
    }
  }

  async function start (req, res, body) {
    usable()
    const member = memberParam(body.member)
    const username = currentName(member)
    if (ownsLivePage(member)) throw refuse('paginas-ativas')
    const ids = countedKeys(fromPasskeys(() => passkeys.keys(member)), recovery, member).map((k) => k.credentialId)
    const hold = fromPasskeys(() => passkeys.hold(member))
    const nonce = mint(member, username, 'delete')
    send(res, 200, { nonce, username, passkeys: ids, scheduled: hold === null ? null : hold.runAt })
  }

  // Steps 1 to 3 (see the top of the file). `reason` goes to the log.
  async function run (member, reason) {
    await beforeDelete(member)
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
    log({ event: 'exclusao', reason })
    await purge(member)
  }

  async function finish (req, res, body) {
    usable()
    const member = memberParam(body.member)
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    if (body.assertion !== undefined && !isAssertion(body.assertion)) throw refuse('pedido-invalido')
    if (body.wait !== undefined && body.wait !== true) throw refuse('pedido-invalido')
    const { nonce, username } = spend(body, member, 'delete')
    const fields = { phase: 'delete', nonce, member, username, association, sub: '' }
    if (!verifyAccountLink(fields, body.signature).ok) throw refuse('assinatura-invalida')
    if (!memberLimit(member)) throw over()
    if (accounts.deletedAt(member) !== null) {
      send(res, 200, { deleted: state(member) })
      return
    }
    // A rename between start and finish: the typed name is no longer it.
    if (currentName(member) !== username) throw refuse('expirado')
    if (ownsLivePage(member)) throw refuse('paginas-ativas')
    if (moderation === null) throw refuse('indisponivel')
    const stored = countedKeys(fromPasskeys(() => passkeys.keys(member)), recovery, member)
    const key = body.assertion === undefined ? undefined : stored.find((k) => k.credentialId === body.assertion.credentialId)
    if (key !== undefined) {
      const checked = verifyAssertion({ assertion: body.assertion, key, challenge: Buffer.from(nonce, 'base64url'), rpId, origins })
      if (!checked.ok) {
        log({ event: 'exclusao', reason: 'passkey-' + checked.reason })
        throw refuse('passkey-invalida')
      }
      // The counter only matters for clone detection; the record goes with
      // the purge below anyway.
      try {
        await passkeys.touch({ member, credentialId: key.credentialId, signCount: checked.signCount })
      } catch {}
      await run(member, 'pedido')
      send(res, 200, { deleted: state(member) })
      return
    }
    if (body.wait !== true) throw refuse('passkey-invalida')
    let out
    try {
      out = await passkeys.schedule({ member, runAt: new Date(now() + WAIT_MS).toISOString() })
    } catch {
      // The write may have landed (a lost lock after the rename): the app
      // settles it by reading /account/status, never by asking again.
      log({ event: 'exclusao', reason: 'agendada-incerta' })
      throw refuse('resultado-incerto')
    }
    if (out.changed) {
      log({ event: 'exclusao', reason: 'agendada' })
      try {
        notify(member)
      } catch {}
    }
    send(res, 200, { scheduled: out.runAt })
  }

  // Excluir conta sem a passkey: the @nome and the verified number, then the
  // code texted to it. An unknown @nome, a page, a deleted account, a number
  // that is not the member's live verified one, a full window and a resend
  // all get the same answers; the code is sent after the answer went.
  function smsUsable () {
    usable()
    // An unreadable request file would answer a paid code with indisponivel.
    if (moderation === null || codes === null || requests === null || !requests.available()) throw refuse('indisponivel')
    codes.available()
  }

  function smsBody (body, keys) {
    if (Object.keys(body).length !== keys.length || !keys.every((k) => Object.hasOwn(body, k))) throw refuse('pedido-invalido')
    if (typeof body.username !== 'string') throw refuse('nome-invalido')
    const raw = body.username.trim()
    const name = (raw.startsWith('@') ? raw.slice(1) : raw).toLowerCase()
    if (!isUsername(name)) throw refuse('nome-invalido')
    if (!isBrMobile(body.phone)) throw refuse('telefone-invalido')
    return name
  }

  // The current member holding `name`, or null (a page, a released name).
  function memberFor (name) {
    const found = accounts.lookup(name)
    return found === null || found.kind === 'page' ? null : found.member
  }

  async function smsSend (req, res, body) {
    const name = smsBody(body, ['username', 'phone'])
    smsUsable()
    // Every request pays for the index, so a match costs no extra time.
    const index = codes.index(body.phone)
    const member = memberFor(name)
    send(res, 200, { sent: true })
    if (member === null) return
    // A deletion already waiting shows its date publicly: no code.
    setImmediate(() => codes.send(member, body.phone, index, scheduled(member) !== null))
  }

  // The provider call ends before the floor; a short floor (tests) keeps the
  // client's own deadline.
  const smsProviderMs = smsCheckFloorMs >= 1000 ? smsCheckFloorMs - 500 : undefined

  async function smsCheck (req, res, body) {
    const name = smsBody(body, ['username', 'phone', 'code'])
    if (typeof body.code !== 'string' || !CODE_RE.test(body.code)) throw refuse('codigo-invalido')
    smsUsable()
    const index = codes.index(body.phone)
    const deadline = Date.now() + smsCheckFloorMs
    let p
    let member
    try {
      member = memberFor(name)
      if (member === null) throw refuse('codigo-invalido')
      p = await codes.check(member, index, body.code, { admit: () => smsCheckLimit(member), timeoutMs: smsProviderMs })
    } catch (err) {
      const left = deadline - Date.now()
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
      throw err
    }
    // Past this point only the holder of the code gets here.
    if (accounts.deletedAt(member) !== null) {
      codes.drop(member, p)
      throw refuse('conta-excluida')
    }
    // A rename or a new number between the send and now: the code no longer
    // proves anything about this account. A store that cannot answer keeps
    // the approved entry, so the same code can be retried.
    const live = codes.matchesNow(member, p.index)
    if (live === null) throw refuse('indisponivel')
    if (memberFor(name) !== member || !live) {
      codes.drop(member, p)
      throw refuse('codigo-invalido')
    }
    if (ownsLivePage(member)) {
      codes.drop(member, p)
      throw refuse('paginas-ativas')
    }
    // A failed or uncertain write keeps the approved entry, so the same code
    // retried files the request without asking the provider again.
    try {
      await requests.record(member)
    } catch {
      log({ event: 'exclusao', reason: 'pedido-sms-incerto' })
      throw refuse('indisponivel')
    }
    codes.drop(member, p)
    log({ event: 'exclusao', reason: 'pedido-sms' })
    send(res, 200, { requested: true })
  }

  async function cancelStart (req, res, body) {
    usable()
    const member = memberParam(body.member)
    const username = currentName(member)
    const hold = fromPasskeys(() => passkeys.hold(member))
    const nonce = mint(member, username, 'cancel')
    send(res, 200, { nonce, username, scheduled: hold === null ? null : hold.runAt })
  }

  async function cancelFinish (req, res, body) {
    usable()
    const member = memberParam(body.member)
    if (typeof body.signature !== 'string' || !HEX128_RE.test(body.signature)) throw refuse('assinatura-invalida')
    const { nonce, username } = spend(body, member, 'cancel')
    const fields = { phase: 'cancel', nonce, member, username, association, sub: '' }
    if (!verifyAccountLink(fields, body.signature).ok) throw refuse('assinatura-invalida')
    if (!memberLimit(member)) throw over()
    if (currentName(member) !== username) throw refuse('expirado')
    let out
    try {
      out = await passkeys.cancel(member)
    } catch (err) {
      throw fromStore(err)
    }
    if (out.changed) log({ event: 'exclusao', reason: 'cancelada' })
    send(res, 200, { cancelled: out.changed })
  }

  let running = null
  // The deletions whose date came. One run at a time; never throws.
  // -> { ran, skipped }
  function runScheduled () {
    if (running !== null) return running
    running = (async () => {
      let ran = 0
      let skipped = 0
      // Every sweep pass, so a request leaves the file after 30 days even
      // when nothing else writes it.
      if (requests !== null) {
        try {
          await requests.prune()
        } catch {
          log({ event: 'exclusao', reason: 'pedidos-poda-falhou' })
        }
      }
      if (passkeys === null || !passkeys.available() || moderation === null) return { ran, skipped }
      let due = []
      try {
        due = passkeys.due(now())
      } catch {
        return { ran, skipped }
      }
      for (const member of due) {
        try {
          if (accounts.deletedAt(member) !== null || !accounts.status(member).linked) {
            // Deleted meanwhile (or never linked): nothing left to run.
            await passkeys.cancel(member)
            continue
          }
          if (ownsLivePage(member)) {
            skipped++
            log({ event: 'exclusao', reason: 'agendada-paginas-ativas' })
            continue
          }
          await run(member, 'agendada-executada')
          ran++
        } catch {
          skipped++
          log({ event: 'exclusao', reason: 'agendada-falhou' })
        }
      }
      return { ran, skipped }
    })().finally(() => { running = null })
    return running
  }

  const POST = {
    '/account/delete/start': start,
    '/account/delete/finish': finish,
    '/account/delete/cancel/start': cancelStart,
    '/account/delete/cancel/finish': cancelFinish,
    '/account/delete/sms/send': smsSend,
    '/account/delete/sms/check': smsCheck
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

  return { owns, handle, stats, scheduled, runScheduled }
}

module.exports = {
  NONCE_TTL_MS,
  WAIT_MS,
  createDeleteRoutes
}
