// Excluir conta, the pure part (no React, no react-native, no Node
// built-ins): the typed confirmation, the request sequence and the local
// receipt that lets the app confirm, after the device was wiped, when the
// diary left the network. The screen is src/screens/ExcluirConta.js; the
// account service side is apps/cli/lib/account/delete-routes.js.

import { toBrMobile } from './phone.js'

const KEY_RE = /^[0-9a-f]{64}$/

// The time the association promises for the diary to leave its seeders
// (the operator's `mod apply` signs the block). Same number as the Termos.
export const DELETE_DAYS = 7
// The wait of a deletion asked without a passkey the account service can
// verify (accounts from before the passkey was registered there, or a
// passkey that is not the registered one). Same number as the Termos and
// apps/cli/lib/account/delete-routes.js WAIT_MS.
export const WAIT_DAYS = 7

export const DELETED_TEXT = 'Esta conta foi excluída.'
export const PENDING_TEXT = 'O serviço de conta já apagou o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O número do celular, se houver, fica lacrado por até 180 dias e então é apagado. O diário sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias.'
export const DONE_TEXT = 'Exclusão concluída: o diário saiu dos semeadores da associação.'
export const PASSKEY_TEXT = 'A passkey continua no gerenciador de senhas do aparelho e o Varanda não consegue apagá-la. Para apagar: no iPhone, app Senhas (ou Ajustes > Senhas); no Android, Gerenciador de senhas do Google; no computador, o gerenciador do navegador. Procure pelo endereço do Varanda.'

// The person types the @nome (with or without '@', any case, spaces around).
export function typedMatches (typed, username) {
  if (typeof typed !== 'string' || typeof username !== 'string' || username === '') return false
  const t = typed.trim().toLowerCase()
  return (t.startsWith('@') ? t.slice(1) : t) === username
}

// accountStatus answer -> the ISO date of a deletion waiting for it, or null.
export function scheduledOf (status) {
  if (status === null || typeof status !== 'object') return null
  const d = status.scheduledDeletion
  return typeof d === 'string' && !Number.isNaN(Date.parse(d)) ? d : null
}

// The start answer -> 'agora' when the service holds a passkey key to verify
// (the deletion runs at once), else 'agendada' (it waits WAIT_DAYS). The
// ceremony can still end 'agendada' when the device's passkey is not the
// registered one.
export function deletionMode (prepared) {
  return prepared && Array.isArray(prepared.passkeys) && prepared.passkeys.length > 0 ? 'agora' : 'agendada'
}

// accountStatus answer -> 'pendente' | 'concluida' | null.
export function deletedOf (status) {
  if (status === null || typeof status !== 'object') return null
  return status.deleted === 'pendente' || status.deleted === 'concluida' ? status.deleted : null
}

// The receipt kept on the device after the wipe: only the public key and
// the date, never a secret. -> the receipt or null.
export function receiptOf (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 3 || value.v !== 1 || typeof value.member !== 'string' || !KEY_RE.test(value.member)) return null
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return null
  return { v: 1, member: value.member, at: value.at }
}

export function newReceipt (member, nowMs) {
  return { v: 1, member, at: new Date(nowMs).toISOString() }
}

function fail (message, code) {
  const err = new Error(message)
  if (code) err.code = code
  return err
}

// The whole request, with every effect injected:
//   confirm({ challenge })     the fresh passkey check over the nonce
//                              (node.passkey.confirm) -> { assertion }
//   sign({ nonce, username })  account.sign at phase 'delete'
//   finish({ nonce, signature, assertion?, wait? }) the account service's finish
//   status()                   accountStatus of the member, after an
//                              uncertain finish
//   beforeFinish()             e.g. switching push off while the key can sign
//                              (only when the deletion runs now: a waiting
//                              one keeps the push notice of its schedule)
// `prepared` is the start answer ({ nonce, username, passkeys }) read when
// the screen opened. confirm() runs before any await, so on the web it stays
// inside the tap (Safari's user activation). With an assertion of a passkey
// the service holds, -> { deleted }: the caller then saves the receipt and
// wipes the device. Otherwise -> { scheduled }: nothing is wiped, and the
// account keeps working until that date.
export async function requestDeletion ({ prepared, typed, confirm, sign, finish, status, beforeFinish = async () => {} }) {
  if (prepared === null || typeof prepared !== 'object' || typeof prepared.nonce !== 'string') throw fail('pedido expirado: tente de novo', 'expirado')
  if (!typedMatches(typed, prepared.username)) throw fail('digite o seu @nome para confirmar')
  const checked = await confirm({ challenge: prepared.nonce })
  const assertion = checked && checked.assertion ? checked.assertion : null
  const stored = Array.isArray(prepared.passkeys) ? prepared.passkeys : []
  const now = assertion !== null && stored.includes(assertion.credentialId)
  if (now) {
    try {
      await beforeFinish()
    } catch {}
  }
  const { signature } = await sign({ nonce: prepared.nonce, username: prepared.username })
  try {
    return await finish(now ? { nonce: prepared.nonce, signature, assertion } : { nonce: prepared.nonce, signature, wait: true })
  } catch (err) {
    // An unknown outcome is settled by reading the status, never by sending
    // the request again.
    if (err && (err.uncertain === true || err.code === 'conta-excluida')) {
      let st = null
      try { st = await status() } catch {}
      const deleted = deletedOf(st)
      if (deleted !== null) return { deleted }
      const scheduled = scheduledOf(st)
      if (scheduled !== null) return { scheduled }
    }
    throw err
  }
}

// Cancelling a waiting deletion, every effect injected: start() ->
// { nonce, username }, sign({ nonce, username }) -> { signature }
// (account.sign at phase 'cancel'), finish({ nonce, signature }) ->
// { cancelled }.
export async function cancelDeletion ({ start, sign, finish }) {
  const { nonce, username } = await start()
  const { signature } = await sign({ nonce, username })
  return finish({ nonce, signature })
}

// 'dd/mm/aaaa' of an ISO date, in Brasília time (UTC-3, no DST), as the
// schedule is told to the person.
export function scheduleDate (iso) {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms - 3 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear()
}

export function scheduledText (iso) {
  return 'A exclusão da conta está agendada para ' + scheduleDate(iso) + '. Até lá a conta continua funcionando, e você pode cancelar de qualquer aparelho.'
}

export const WAIT_TEXT = 'O serviço de conta não tem a passkey desta conta registrada (contas criadas antes desse registro, ou outra passkey). Por segurança, a exclusão fica agendada por ' + WAIT_DAYS + ' dias: todos os seus aparelhos mostram o pedido, e você pode cancelar até lá. Depois disso, ela segue como uma exclusão imediata.'

// Excluir conta sem a passkey (src/screens/ExcluirSemPasskey.js): the
// @nome, the number the member verified and the code texted to it. The
// service answers a send the same way whether or not the @nome and the
// number match, so the screen never learns which.

// Same rule as src/account.js isUsername (that module pulls in the
// installation and the network, so it is not imported here).
const SMS_NAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6_RE = /^[0-9a-f]{6}$/
export const SMS_RESEND_MS = 60 * 1000
// How often a device in the foreground re-reads the account status, so a
// deletion scheduled from another place (the operator, another device)
// shows on it.
export const STATUS_EVERY_MS = 10 * 60 * 1000
// After a failed read (no network yet, a 429), the next try comes this soon
// instead of a full STATUS_EVERY_MS later.
export const STATUS_RETRY_MS = 60 * 1000

// The typed @nome (spaces, an '@', any case) -> the name, or null.
export function smsName (text) {
  if (typeof text !== 'string') return null
  const t = text.trim().toLowerCase()
  const name = t.startsWith('@') ? t.slice(1) : t
  return SMS_NAME_RE.test(name) && !HEX6_RE.test(name) ? name : null
}

// The typed number -> E.164, as the phone verification screen sends it.
export function smsPhone (text) {
  return toBrMobile(text)
}

// The typed code, spaces dropped -> the six digits, or null.
export function smsCodeOk (text) {
  if (typeof text !== 'string') return null
  const t = text.replace(/\s/g, '')
  return /^[0-9]{6}$/.test(t) ? t : null
}

// Seconds left before another code may be asked (0: now).
export function resendWait (sentAt, now) {
  if (typeof sentAt !== 'number' || typeof now !== 'number') return 0
  // useNow can lag behind the press that set sentAt: the full wait.
  if (now < sentAt) return SMS_RESEND_MS / 1000
  const left = sentAt + SMS_RESEND_MS - now
  return left <= 0 ? 0 : Math.ceil(left / 1000)
}

export function resendLabel (seconds) {
  if (!(seconds > 0)) return 'Pedir outro código'
  return 'Pedir outro código em ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

// Whether the foreground may read the account status again. A clock that
// went back counts as due.
export function statusDue (lastAt, now) {
  if (typeof lastAt !== 'number') return true
  return now < lastAt || now - lastAt >= STATUS_EVERY_MS
}

// Whether to read the account status again at `now`: goodAt is the last
// successful read, triedAt the last try, failed whether that try failed.
// Only a good read holds the next one off for STATUS_EVERY_MS; a failed one
// is retried after STATUS_RETRY_MS.
export function statusReadDue ({ goodAt = null, triedAt = null, failed = false } = {}, now) {
  if (failed) return typeof triedAt !== 'number' || now < triedAt || now - triedAt >= STATUS_RETRY_MS
  return statusDue(goodAt, now)
}

// The date of a deletion already waiting for the @nome, or null when there
// is none or it could not be read: lookup(name) -> { member } | null,
// status(member) -> the accountStatus answer. Never throws.
export async function smsScheduled ({ username, lookup, status }) {
  try {
    const found = await lookup(username)
    if (!found || typeof found.member !== 'string' || !KEY_RE.test(found.member) || found.kind === 'page') return null
    return scheduledOf(await status(found.member))
  } catch {
    return null
  }
}

// Asks for a code once. send({ username, phone }) -> { sent: true }. With
// lookup and status, a deletion already waiting for the @nome (its date is
// public) is shown instead: the service skips the send for it and answers
// the same, so no SMS would come. -> { sent: true } | { scheduled }
export async function requestSmsCode ({ username, phone, send, lookup, status }) {
  const name = smsName(username)
  if (name === null) throw fail(SMS_TEXTS.name, 'nome-invalido')
  const number = smsPhone(phone)
  if (number === null) throw fail(SMS_TEXTS.phone, 'telefone-invalido')
  if (typeof lookup === 'function' && typeof status === 'function') {
    const scheduled = await smsScheduled({ username: name, lookup, status })
    if (scheduled !== null) return { scheduled }
  }
  return send({ username: name, phone: number })
}

// Sends the code once. A correct code only files a request: nothing is
// scheduled until the owner writes to the team. An uncertain answer is never
// settled by sending the code again; the next step (writing in) is the same
// whether or not the request landed. -> { requested: true }
export async function confirmSmsCode ({ username, phone, code, check }) {
  const name = smsName(username)
  const number = smsPhone(phone)
  const digits = smsCodeOk(code)
  if (name === null) throw fail(SMS_TEXTS.name, 'nome-invalido')
  if (number === null) throw fail(SMS_TEXTS.phone, 'telefone-invalido')
  if (digits === null) throw fail(SMS_TEXTS.code, 'codigo-invalido')
  return check({ username: name, phone: number, code: digits })
}

const CONTACT = 'contato@varanda.app'
export const SMS_TEXTS = {
  title: 'Excluir conta sem a passkey',
  intro: 'Sem a passkey e sem o código de recuperação, você ainda pode pedir a exclusão. Digite o seu @nome e o número de celular que você confirmou na Varanda. Se os dois baterem, enviamos um código por SMS para esse número.',
  nameLabel: 'Seu @nome',
  phoneLabel: 'Celular confirmado',
  send: 'Enviar código',
  codeIntro: 'Se o @nome e o número baterem, o código chega em instantes. Digite os 6 números.',
  codeLabel: 'Código do SMS',
  confirm: 'Pedir a exclusão',
  after: 'Até lá, a conta continua funcionando. Num aparelho em que a conta está aberta, dá para cancelar em Ajustes > Excluir conta.',
  help: 'Não tem mais o celular confirmado, ou entrou com o Google e nunca confirmou um celular? Escreva para ' + CONTACT + ' pelo e-mail da conta.',
  name: 'Digite um @nome válido.',
  phone: 'Digite um celular brasileiro com DDD, por exemplo (11) 91234-5678.',
  code: 'Digite os 6 números do código.',
  requested: 'Pedido registrado. Ainda falta um passo: escreva para ' + CONTACT + ' com o seu @nome. Nada acontece antes disso. Depois que a equipe confirmar, a conta fica marcada para exclusão em ' + WAIT_DAYS + ' dias.',
  uncertain: 'Não deu para confirmar se o pedido foi registrado. Para seguir, escreva para ' + CONTACT + ' com o seu @nome. Nada acontece antes disso.'
}

export function smsAlreadyText (iso) {
  return 'A exclusão desta conta já está agendada para ' + scheduleDate(iso) + '.'
}

const SMS_ERRORS = {
  'codigo-invalido': 'Código errado ou vencido. Confira os 6 números ou peça outro.',
  'limite-borda': 'Muitos pedidos agora. Tente de novo em uma hora.',
  'paginas-ativas': 'Esta conta ainda é dona de uma página. Escreva para ' + CONTACT + '.',
  'conta-excluida': 'Esta conta já foi excluída.',
  'telefone-invalido': 'Digite um celular brasileiro com DDD, por exemplo (11) 91234-5678.',
  'nome-invalido': 'Digite um @nome válido.',
  indisponivel: 'A exclusão sem a passkey não está disponível agora. Tente mais tarde ou escreva para ' + CONTACT + '.'
}

// A refusal -> the sentence the screen shows. An uncertain outcome gets
// its own sentence: the request may have landed.
export function smsErrorText (err) {
  if (err && err.uncertain === true) return SMS_TEXTS.uncertain
  const code = err && typeof err.code === 'string' ? err.code : ''
  return Object.hasOwn(SMS_ERRORS, code) ? SMS_ERRORS[code] : SMS_ERRORS.indisponivel
}

// The shell's account status (App.js): the next deletion state from a read.
// `answer` is the status, or null when the read failed; a failure keeps what
// is shown (an offline return to the foreground must not drop the date or
// the deleted hold). `start`: the first read for this member and node, the
// only one that leaves the passkey enrolment due.
// -> { deletedState, scheduledDeletion, enrolDue }
export function statusUpdate (prev, answer, { start = false, member = null } = {}) {
  if (answer === null || typeof answer !== 'object') return { deletedState: prev.deletedState, scheduledDeletion: prev.scheduledDeletion, enrolDue: null }
  const enrol = start && answer.linked === true && typeof answer.username === 'string' ? { member, username: answer.username } : null
  return { deletedState: deletedOf(answer), scheduledDeletion: scheduledOf(answer), enrolDue: enrol }
}

// Where an Ajustes move goes. Excluir conta opened from the explainer, and
// Excluir conta sem a passkey opened from Entrar (no account open), close
// the sheet on every way out instead of showing the Ajustes list.
export function ajustesTarget (screen, { aviso = false, entrar = false } = {}) {
  if (aviso && screen !== 'excluir') return null
  if (entrar && screen !== 'excluirSms') return null
  return screen
}
