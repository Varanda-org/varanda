// Identidade: create the identity, show the public key and the member
// certificate status, add the certificate the association issued. Ajustes
// shows it in two parts (`view`): 'conta' is the account link and @nome in
// plain words, 'tecnica' the technical card (public key behind a reveal,
// association, certificate) under Avançado. The setup uses 'all'.
//
// On the web's browser node (node.passkey !== null) the identity comes from
// a passkey: the first card is 'Entrar' (entrar com a passkey, criar passkey,
// concluir a criação when the PRF only arrives on a second ceremony,
// recomeçar for an account of another identity), a blocking notice when the
// browser cannot derive it (no PRF), steps and 'tentar de novo' when the
// chosen passkey gives no PRF or will not sync (src/passkeyTrouble.js), and
// after a successful unlock the diary
// is created if missing and a once sync runs (on a second device it brings
// the certificate and the posts back from the seeder). The app's in-app web
// node (the native web kind) shows the same cards with device wording (no
// browser or page address texts); the core node and varanda-serve keep the
// plain identity card.
//
// With `setup` (the first run, App.js) the same cards render inside the
// onboarding Stepper (src/onboarding.js decides the step) with welcome copy,
// and the technical card (key, association, certificate state) stays for
// Ajustes › Identidade. The setup changes presentation only: every ceremony,
// link, certificate, reset and rename path is the one Ajustes uses. The setup
// names the key a code and the certificate the association's release.
//
// Recovery (docs/rpc.md 5.90 to 5.94): 'entrar com outra passkey' whenever
// a passkey is known, and 'Entrar com código de recuperação' (a field, then
// the same ceremony() wrapper). The provider (src/node.js) finishes a passkey
// or code that opens only a recovery entry; a code ends in { needsPasskey },
// whose card creates the passkey the account opens with from now on
// (finishRecovery, in the press) and registers it before the once sync. A
// registration that fails leaves the device signed in and the passkey held
// for 'registrar de novo' in Ajustes › Passkeys e recuperação. While that
// card waits it is the only card: its own pending creation gets its own
// 'concluir', and nothing else (Entrar, the phone, the code field) can start
// a ceremony that would abandon the account's root. The code entry is hidden
// while another creation awaits 'concluir', so a code never starts beside it.
//
// The cards keep one short line each; the passkey and Google-link
// explanations sit behind the info button (src/help.js), whose sheet nests in the
// Ajustes Sheet when the card renders there.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, Text, TextInput } from 'react-native'
import { displayText } from '@varanda/rpc'
import { parseCertificateText } from '../config'
import { useNode, useNotice } from '../node'
import { admission, authorizeLink, accountStatus, finishLink, formatNextChange, invitePolicy, isUsername, parseReturn, parseReturnInvite, parseReturnWaitlist, passkeyAdd, passkeyStart, readPending, recoveryPut, recoveryStart, renameFinish, renameStart, startLink, toError } from '../account'
import { enrolWith } from '../passkeyEnrol'
import { ENTRY_TEXT, ENTRY_TITLE } from '../feiraEntry'
import { useFeiraEntryStart } from '../useFeiraEntryStart'
import { registerEntry } from '../recovery'
import { isAppClient } from '../appClient'
import { acceptableAuthorizeUrl } from '../authorizeUrl'
import { deviceRandomBytes, newLinkSecret } from '../appLinkSecret'
import { HELP, SHORT } from '../help'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { useOutbox } from '../outboxProvider'
import { BROWSER_TEXT, KNOWN_LOST_FULL_TEXT, KNOWN_LOST_TEXT, MISSED_TEXT, NONE_FULL_TEXT, NONE_TEXT, NOT_SYNCED_TITLE, OTHER_PASSKEY_LABEL, PHONE_BUTTON, PHONE_HINT, PHONE_SIGNIN_BUTTON, PHONE_SIGNIN_HINT, RETRY_BUTTON, SYNC_ADVICE, UNUSABLE_TITLE, notSyncedSteps, unusableSteps } from '../passkeyTrouble'
import { OPEN_IN_BROWSER_TEXT } from '../profileLink'
import { INVITE_NEEDED_TEXT, INVITE_READY_TEXT } from '../signupInvite'
import { dropSignupInvite, dropSignupInviteCard, loadSignupInvite } from '../signupInviteStore'
import { FULL_TEXT, admissionFor, admissionOffer } from '../signupAdmission'
import { hostOf, installationOrigin } from '../installation'
import { dropsHeldInvite, parseSessionReturn } from '../linkReturn'
import * as AuthSession from '../authSession'
import { InvitePaste } from './Idade'
import { holdUnregistered, releaseUnregistered } from './Passkeys'
import { Body, Btn, Card, ConfirmStack, ErrorText, Field, Label, Mono, Notice, Page, Row, Soft, Title, errorText, useAction, useNow } from '../ui'
import { HelpNote } from '../ui/Help'
import { ShareProfile } from '../ui/ShareProfile'
import { Stepper } from '../ui/Stepper'
import { fonts, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { atName } from '../who'

const WELCOME_TEXT = 'Uma rede social feita entre pessoas.'
// Shown wherever the own key is shown during the setup (the association
// issues the certificate for it).
const KEY_NOTE = 'Esta chave é só sua; a associação usa ela para emitir o certificado.'
const NO_NAME = 'ainda sem @nome'
// The setup's certificate step in plain words; HELP.certificado names PLAIN_SUBMIT.
const PLAIN_CODE_LABEL = 'Código para enviar à associação'
const PLAIN_SEND_TEXT = 'Envie este código à associação. Cole abaixo o que ela devolver.'
const PLAIN_CERT_LABEL = 'O que a associação devolveu'
const PLAIN_SUBMIT = 'Gravar e continuar'
// Replaces parseCertificateText's JSON wording in the setup only.
const PLAIN_PARSE_ERROR = 'Não foi possível ler esse texto. Cole tudo o que a associação devolveu.'
// The in-app web node (native web kind) has the same passkey cards; only the
// place they name changes.
const NATIVE = Platform.OS !== 'web'
const PLACE = NATIVE ? 'neste aparelho' : 'neste navegador'
const EXISTS_TEXT = 'Já existe uma conta ' + PLACE + '. Uma passkey criada aqui abre outra conta; para entrar na mesma conta com outra passkey, cadastre-a antes em Ajustes › Passkeys e recuperação.'
const RECOVERY_ACCOUNT = { recoveryStart, recoveryPut }
const CODE_LABEL = 'Entrar com código de recuperação'
const CODE_HINT = 'O código tem 36 letras e números, em 9 grupos de 4.'
const NEEDS_PASSKEY_TEXT = 'O código abriu a sua conta. Para terminar, crie uma passkey nova: é com ela que você vai entrar daqui em diante. Faça isso agora: depois de dois minutos é preciso digitar o código de novo.'
const REGISTER_FAILED_TEXT = 'Você entrou, mas a passkey nova não foi cadastrada na conta: depois de sair, ela não abre a conta. Abra Ajustes › Passkeys e recuperação e toque em registrar de novo.'
const REGISTER_UNCERTAIN_TEXT = 'Você entrou, mas não deu para saber se a passkey nova foi cadastrada na conta. Abra Ajustes › Passkeys e recuperação para conferir.'
const RESET_TEXT = 'A conta antiga não pode ser reconstruída: será preciso vincular de novo. As publicações dela que ainda aguardam envio são apagadas.'
// The app's counterpart of BROWSER_TEXT: this device's credential manager
// gives no PRF (or passkeys are not available here yet), so nothing can be
// derived on it.
const DEVICE_TEXT = 'Este aparelho ainda não consegue abrir sua conta com a passkey. Use o Varanda no navegador (Chrome, Edge ou Safari 18 ou mais novo).'
const PENDING_TEXT = 'A passkey foi criada. Toque abaixo para concluir e entrar.'

// A finishRecovery result (or its 'concluir'): the new passkey's sealed root.
function finishing (r) {
  return !!r && typeof r === 'object' && typeof r.lookupId === 'string' && !!r.blob && typeof r.blob === 'object'
}

function mismatchText (legacy) {
  return 'A conta guardada ' + PLACE + ' é de outra passkey' +
    (legacy ? ' (de uma versão anterior do app)' : '') + '.'
}

// The certificate step: the public key to send to the association (copy or
// share) and the field for the certificate it issues. PR B puts the account
// link before this step. `plain` (the setup) names the key a code and the
// certificate what the association returns.
export function CertificateStep ({ publicKey, certText, onCertText, onSubmit, error, pending, plain = false }) {
  const styles = useStyles(makeStyles)
  const [copyNote, setCopyNote] = useState('')
  const [manual, setManual] = useState(false)
  const manualRef = useRef(null)
  const key = displayText(publicKey)
  const nav = typeof navigator !== 'undefined' ? navigator : null
  const canShare = nav !== null && typeof nav.share === 'function'

  // Clipboard refused: the key in a field, focused and selected.
  useEffect(() => {
    if (!manual) return
    const el = manualRef.current
    if (!el) return
    try {
      el.focus()
      if (typeof el.select === 'function') el.select()
    } catch {}
  }, [manual])

  const copy = async () => {
    setCopyNote('')
    try {
      if (nav === null || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') throw new Error('sem área de transferência')
      await nav.clipboard.writeText(String(publicKey))
      setManual(false)
      setCopyNote(plain ? 'código copiado' : 'chave copiada')
    } catch {
      setManual(true)
      setCopyNote(plain ? 'não foi possível copiar: o código está selecionado acima, copie-o' : 'não foi possível copiar: a chave está selecionada abaixo, copie-a')
    }
  }

  const share = async () => {
    setCopyNote('')
    try {
      await nav.share({ text: String(publicKey) })
    } catch {}
  }

  return (
    <Card>
      <Label>{plain ? PLAIN_CODE_LABEL : 'sua chave pública'}</Label>
      <Mono>{key}</Mono>
      {plain ? null : <Soft>{KEY_NOTE}</Soft>}
      {manual
        ? (
          <TextInput
            ref={manualRef}
            style={styles.manual}
            value={key}
            selectTextOnFocus
            multiline
            autoCapitalize='none'
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel={plain ? 'código para enviar à associação' : 'sua chave pública'}
            onChangeText={() => {}}
          />
          )
        : null}
      <Row>
        <Btn label={plain ? 'Copiar código' : 'Copiar chave'} secondary onPress={copy} />
        {canShare ? <Btn label='Compartilhar' secondary onPress={share} /> : null}
      </Row>
      {copyNote ? <Soft>{copyNote}</Soft> : null}
      <Body>{plain ? PLAIN_SEND_TEXT : 'Envie esta chave à associação; ela emite o certificado de membro (JSON), que você cola abaixo.'}</Body>
      <Label>{plain ? PLAIN_CERT_LABEL : 'certificado de membro (JSON emitido pela associação)'}</Label>
      <Field value={certText} onChangeText={onCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
      <ErrorText>{error}</ErrorText>
      <Btn label={plain ? PLAIN_SUBMIT : 'Gravar certificado'} onPress={onSubmit} pending={pending} disabled={certText.trim() === ''} />
    </Card>
  )
}

// The account link (hosted page with a passkey): the association's account
// service issues the member certificate and the @nome once the key is linked
// to a Google account. Only same-origin /account/* calls (../account.js) and
// the RPCs account.sign, cert.add and username.add; the Google page opens in
// this same tab and nothing of the link is kept across the reload, except the
// profile invite (src/profileLink.js) and a group or community link
// (src/groupLinkStore) in tab storage, which are never sent to /account/*.
const RELOAD_TEXT = 'Vamos abrir o Google e, na volta, pedir sua passkey de novo.'
const RENAME_RULE = 'Depois de trocar, você só poderá mudar de novo daqui a 7 dias.'
const NAME_RULE = '@nome inválido: de 3 a 20 letras minúsculas, números ou _, começando por letra'
const LINK_FAILED = 'não foi possível vincular a conta'
const CERT_KEPT_ERROR = 'certificado já gravado'
const CERT_KEPT_TEXT = 'Conta vinculada.'
const CERT_RECEIVED = 'Conta vinculada.'
// Finish errors (account.js ERROR_MESSAGES) after which the pending row is
// useless: the member may pick another Google account. 'lista-de-espera' is
// not one of them: the cap is full, this key stays, and the form retries by hand.
// 'convite-invalido' is: the invite died while the member was at Google.
const RESTARTABLE = new Set(['conta-vinculada', 'nome-em-uso', 'expirado', 'convite-invalido'])
// Start refusals for a network that is by invite: a calm state, not an error.
const INVITE_REFUSALS = new Set(['convite-obrigatorio', 'convite-invalido'])

// ?conta=ok|erro|cancelado|lista-de-espera, read once per page load (every
// mounted Identidade shows it, including the one App.js opens in Ajustes
// after the return) and removed from the address bar. The value is cached
// here, so a LinkCard mounted after the removal still shows it; App.js only
// reads the query, this is the only place that removes it.
// 'lista-de-espera' is not a notice: it opens the card in its waitlist state,
// and 'convite-invalido' opens it in its invite state (the stored code is
// dead, so it is dropped here).
let returnNotice
let returnWaitlist = ''
let returnInvite = ''
function takeReturnNotice () {
  if (returnNotice !== undefined) return returnNotice
  returnNotice = null
  try {
    const loc = globalThis.location
    const hist = globalThis.history
    if (!loc || typeof loc.search !== 'string' || !hist) return null
    returnNotice = parseReturn(loc.search)
    returnWaitlist = parseReturnWaitlist(loc.search)
    returnInvite = parseReturnInvite(loc.search)
    if (returnInvite !== '') {
      dropSignupInvite()
      dropSignupInviteCard()
    }
    if (new URLSearchParams(loc.search).has('conta')) hist.replaceState(hist.state, '', loc.pathname + loc.hash)
  } catch {}
  return returnNotice
}
function takeReturnWaitlist () {
  takeReturnNotice()
  return returnWaitlist
}

// The native sign-in (apps/cli/lib/account/app-return.js). V is held in this
// process's memory only, never in storage or a log, for the member that
// started: appLink = { member, secret, redeem }. R comes only from the result
// of the auth session the app opened (its https return reaches this app
// only); varanda://conta is no longer a return, since any app can claim or
// forge it. Each start clears R.
// A restarted app holds no V, so its return cannot be redeemed ('expirado').
let appLink = null
let appExpired = false
// An auth session that ended 'failed' (Auth Tab verification failed or timed
// out, e.g. no assetlinks): later starts send the person to the site.
let authSessionBroken = false
const returnListeners = new Set()
const SESSION_RETURN_PATH = '/account/app/conta'

function siteHost () {
  try {
    return hostOf(installationOrigin())
  } catch {
    return null
  }
}
// No auth session on this device: the link is done on the site, with the
// same passkey (the same diary key, so the same account).
function noSessionText () {
  const host = siteHost()
  const where = host ? 'pelo site ' + host : 'pelo site da instalação'
  return 'Este aparelho não consegue abrir o login do Google dentro do app. Ligue a conta Google ' + where + ' no navegador, entrando com a mesma passkey: é a mesma conta.'
}

function noteAccountReturn (outcome) {
  const search = '?conta=' + outcome
  returnNotice = parseReturn(search)
  returnWaitlist = parseReturnWaitlist(search)
  returnInvite = parseReturnInvite(search)
}
function notifyReturn () {
  for (const fn of returnListeners) fn()
}

// The proofs for this key's app row, or {} (the web, or nothing held).
function appProofs (member) {
  if (appLink === null || appLink.member !== member) return {}
  return { linkSecret: appLink.secret, redeem: appLink.redeem }
}
function takeReturnInvite () {
  takeReturnNotice()
  return returnInvite
}

// username.add runs at most once per record per page load (the RPC is
// idempotent, but it is a mutating request that preempts a running sync).
const syncedRecords = new Set()
// Records whose automatic username.add failed on this page (see LinkCard).
const failedRecords = new Set()
// Per key, the newest `date` of a username record this page sent
// successfully or saw in status: the newest record by seq is the displayed
// name, so a record older than one already accepted here is never sent (it
// would revert a rename). The node refuses such a record anyway
// ('registro de nome antigo', docs/rpc.md 5.19); from the automatic path
// that is not an error (expected after a rename on another device).
const acceptedDates = new Map()
const OLD_RECORD_ERROR = 'registro de nome antigo'
function noteDate (key, date) {
  const newest = acceptedDates.get(key)
  if (newest === undefined || date > newest) acceptedDates.set(key, date)
}
function accepted (key, record) {
  syncedRecords.add(JSON.stringify(record))
  noteDate(key, record.date)
}

function LinkCard ({ publicKey, memberCert, active, quiet, setup = false, onChanged, onLinked, onInviteChanged, feira = null }) {
  const node = useNode()
  const now = useNow(60000)
  // { key, status, pending } of the last load for this key.
  const [acct, setAcct] = useState(null)
  const [acctError, setAcctError] = useState('')
  const [returned, setReturned] = useState(takeReturnNotice)
  const [name, setName] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  // A pending Google account the member gives up on (rejected by finish, or
  // 'começar de novo'): the stale row is ignored for this page load and the
  // link form shows; its 'vincular conta Google' starts a new row, whose
  // cookie replaces the old one (the service lets the old row expire).
  const [restart, setRestart] = useState(() => NATIVE && appExpired)
  const [confirmFailed, setConfirmFailed] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => (NATIVE && appExpired ? toError('expirado').message : ''))
  const [note, setNote] = useState('')
  const [, setPasteTick] = useState(0)
  // Sentence for a full member cap ('lista-de-espera'), or ''. Not an error.
  const [waitlist, setWaitlist] = useState(takeReturnWaitlist)
  // Sentence for an invite refusal ('convite-obrigatorio', 'convite-invalido'),
  // or ''. Not an error either.
  const [inviteNote, setInviteNote] = useState(takeReturnInvite)
  // undefined while unread; null when the network is open (no endpoint, a
  // failed read or required false: the service still refuses on its own).
  const [policy, setPolicy] = useState(undefined)
  const policyAsked = useRef(false)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!active || policyAsked.current) return
    policyAsked.current = true
    invitePolicy().then(
      (p) => setPolicy(p && p.required === true ? p : null),
      () => setPolicy(null)
    )
  }, [active])

  // A visitor from a Feira listing link (src/useFeiraEntryStart.js): with the
  // Feira on, invites required and no code held, the card offers "Pedir
  // entrada"; only that press asks the service for a code, and the code then
  // goes through the ordinary flow below.
  const {
    decision: feiraDecision,
    offer: feiraOffer,
    busy: feiraBusy,
    tried: feiraTried,
    press: pressFeiraStart,
    limit: feiraLimit,
    limitRef: feiraLimitRef
  } = useFeiraEntryStart({
    feira,
    active,
    required: policy === undefined ? undefined : policy !== null,
    blocked: !!memberCert,
    onNote: setInviteNote,
    takeReturnInvite
  })

  const load = useCallback(async () => {
    const mine = ++seqRef.current
    try {
      const status = await accountStatus(publicKey)
      const pending = status.linked === true ? null : await readPending(appProofs(publicKey))
      if (mine !== seqRef.current) return
      setAcct({ key: publicKey, status, pending })
      setAcctError('')
    } catch (err) {
      if (mine === seqRef.current) setAcctError(errorText(err))
    }
  }, [publicKey])

  useEffect(() => { if (active) load() }, [active, load])

  // An auth session's return while this card is mounted (the app was not
  // reloaded, unlike the web page): the same states as a page load, then the
  // service is asked again.
  useEffect(() => {
    if (!NATIVE) return
    const take = () => {
      setReturned(returnNotice)
      setWaitlist(returnWaitlist)
      setInviteNote(returnInvite)
      // The app keeps its held code across the return: a refused Feira code
      // reads as the seller's limit, as on the web page load.
      if (returnInvite !== '') feiraLimitRef.current({ code: 'convite-invalido' })
      setConfirmFailed(false)
      setNote('')
      if (appExpired) {
        setError(toError('expirado').message)
        setRestart(true)
        setFormOpen(true)
      } else {
        setError('')
        setRestart(false)
      }
      load()
    }
    returnListeners.add(take)
    return () => { returnListeners.delete(take) }
  }, [load])

  const cur = acct !== null && acct.key === publicKey ? acct : null
  const status = cur === null ? null : cur.status
  const linked = status !== null && status.linked === true

  const run = async (fn) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNote('')
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // The certificate, then the username record. A diary that already holds a
  // certificate (the pilot's v1 identity) keeps it: block 0 never changes.
  const apply = async (cert, record) => {
    let kept = false
    try {
      await node.request('cert.add', { cert })
    } catch (err) {
      if (!(err && err.message === CERT_KEPT_ERROR)) throw err
      kept = true
    }
    // In the setup the shell drops the web's Google return here, before
    // onChanged tells it the certificate arrived (a newcomer may confirm
    // while the recovery still holds the shell's info read).
    if (typeof onLinked === 'function') onLinked()
    if (record) {
      await node.request('username.add', { record })
      accepted(publicKey, record)
    }
    return kept
  }

  const certTried = useRef(new Set())
  // A username record whose automatic username.add failed is kept in the
  // module-level failedRecords (it survives closing Ajustes): no automatic
  // retry, since each try runs the write gate's sync, until the member
  // presses 'enviar o @nome de novo'.
  const [, setRetryTick] = useState(0)
  const failedTag = status && status.usernameRecord ? JSON.stringify(status.usernameRecord) : null
  const nameFailed = failedTag !== null && failedRecords.has(failedTag)
  const retryName = () => {
    if (!nameFailed) return
    failedRecords.delete(failedTag)
    syncedRecords.delete(failedTag)
    setError('')
    setRetryTick((n) => n + 1)
  }
  const receive = () => run(async () => {
    try {
      const kept = await apply(status.cert, status.usernameRecord || null)
      setNote(kept ? CERT_KEPT_TEXT : CERT_RECEIVED)
    } finally {
      await onChanged()
    }
  })

  // Linked: a member without a certificate receives it automatically (also
  // after a finish whose answer was lost: status carries the same cert); a
  // member with one gets the newest username record into the diary.
  useEffect(() => {
    if (!active || quiet || busy || !linked) return
    const record = status.usernameRecord || null
    if (!memberCert) {
      // Once per certificate: a failure shows the error and 'receber o
      // certificado' instead of retrying in a loop.
      const certTag = JSON.stringify(status.cert)
      if (certTried.current.has(certTag)) return
      certTried.current.add(certTag)
      receive()
      return
    }
    if (record === null) return
    const tag = JSON.stringify(record)
    if (syncedRecords.has(tag) || failedRecords.has(tag)) return
    const newest = acceptedDates.get(publicKey)
    if (newest !== undefined && record.date < newest) return
    syncedRecords.add(tag)
    noteDate(publicKey, record.date)
    node.request('username.add', { record }).then(() => accepted(publicKey, record), (err) => {
      if (err && err.message === OLD_RECORD_ERROR) return
      syncedRecords.delete(tag)
      failedRecords.add(tag)
      setError(errorText(err))
      setRetryTick((n) => n + 1)
    })
  }, [active, quiet, busy, linked, status, memberCert, publicKey, nameFailed])

  const doLink = () => {
    const username = isUsername(name)
    if (username === null) return setError(NAME_RULE)
    run(async () => {
      try {
        // The app: a fresh V per start, whose hash names the new row; a V
        // still held for this key proves the old row, so a restart may
        // replace it. V is kept only once the service took its proof.
        const app = isAppClient()
        // Checked before start, so no row is created for a link that cannot
        // come back.
        if (app && (authSessionBroken || !AuthSession.isAvailable())) throw new Error(noSessionText())
        const link = app ? newLinkSecret(deviceRandomBytes) : null
        const held = app ? appProofs(publicKey).linkSecret : undefined
        const { nonce } = await startLink({ member: publicKey, username, invite: loadSignupInvite()?.code, appProof: link?.proof, linkSecret: held })
        const current = link === null ? null : { member: publicKey, secret: link.secret, redeem: null }
        if (current !== null) {
          appLink = current
          appExpired = false
        }
        const { signature } = await node.request('account.sign', { phase: 'reserve', nonce, username, sub: '' })
        const { authorizeUrl } = await authorizeLink({ signature, linkSecret: link?.secret })
        // authorizeLink goes to the installation, or on the hosted web app to
        // the page's own origin, so that is the account origin.
        const accountOrigin = installationOrigin() ?? globalThis.location?.origin ?? null
        if (!acceptableAuthorizeUrl(authorizeUrl, accountOrigin)) throw new Error('serviço indisponível')
        setWaitlist('')
        setInviteNote('')
        setNote(RELOAD_TEXT)
        // The auth session hands its https return to this app only.
        if (app) await linkInSession(current, authorizeUrl)
        else globalThis.location.assign(authorizeUrl)
      } catch (err) {
        // Full cap: a calm notice. The name stays; nothing retries on its own.
        if (err && err.code === 'lista-de-espera') {
          setInviteNote('')
          setWaitlist(err.message)
          return
        }
        setWaitlist('')
        if (feiraLimit(err)) return
        if (err && INVITE_REFUSALS.has(err.code)) {
          // The web keeps its stored code: start answers 'convite-invalido'
          // for a code held by another pending link too, and that one may
          // free up. The app drops it, so its paste field shows again for
          // another link instead of resending a dead code.
          if (dropsHeldInvite(err, NATIVE)) {
            dropSignupInvite()
            dropSignupInviteCard()
            if (onInviteChanged) onInviteChanged()
          }
          setInviteNote(err.message)
          return
        }
        throw err
      }
    })
  }

  const linkInSession = async (current, authorizeUrl) => {
    let res
    try {
      res = await AuthSession.open(authorizeUrl, hostOf(installationOrigin()), SESSION_RETURN_PATH)
    } catch (err) {
      if (appLink !== current) return
      // INVALID: an installation the session cannot name (a port, or not
      // https). Nothing else ever opens the link.
      if (err && err.code === 'BUSY') throw new Error(LINK_FAILED)
      throw new Error(noSessionText())
    }
    if (appLink !== current || !res) return
    if (res.type === 'failed') {
      // The browser may have loaded the return as a page and kept R in its
      // history: without V, which goes here, nobody can redeem it.
      appLink = null
      authSessionBroken = true
      throw new Error(noSessionText())
    }
    if (res.type !== 'ok') return
    const ret = parseSessionReturn(res.url)
    if (ret === null) return
    noteAccountReturn(ret.outcome)
    if (ret.code) current.redeem = ret.code
    notifyReturn()
  }

  const doConfirm = () => run(async () => {
    const row = cur === null ? null : cur.pending
    // Never sign for a pending link of another key.
    if (row === null || row.member !== publicKey || typeof row.sub !== 'string' || row.sub === '') throw new Error(LINK_FAILED)
    setConfirmFailed(false)
    // The app's row answers only to V and R: without both, nothing is
    // signed or sent, and the member starts again.
    const proofs = appProofs(publicKey)
    if (isAppClient() && (typeof proofs.linkSecret !== 'string' || typeof proofs.redeem !== 'string')) {
      setConfirmFailed(true)
      throw toError('expirado')
    }
    try {
      const { signature } = await node.request('account.sign', { phase: 'finish', nonce: row.nonce, username: row.username, sub: row.sub })
      // R is spent by this finish whatever its answer.
      if (isAppClient() && appLink !== null) appLink.redeem = null
      const done = await finishLink({ signature, ...proofs })
      if (isAppClient()) appLink = null
      const kept = await apply(done.cert, done.usernameRecord)
      certTried.current.add(JSON.stringify(done.cert))
      // The passkey that created this identity, while the sign-up window is
      // open (Excluir conta verifies it later). Best effort, not awaited: a
      // miss is retried at the next start (App.js) until the service closes
      // the window.
      enrolWith({ passkey: node.passkey, request: node.request, member: publicKey, username: row.username, start: passkeyStart, add: passkeyAdd }).catch(() => {})
      dropSignupInvite()
      setWaitlist('')
      setNote(kept ? CERT_KEPT_TEXT : CERT_RECEIVED)
    } catch (err) {
      // The cap filled at Google: nothing was stored. Keep this key and the
      // chosen name. Not RESTARTABLE, and restartLink is not called.
      if (err && err.code === 'lista-de-espera') {
        setWaitlist(err.message)
        if (name.trim() === '' && typeof row.username === 'string') setName(row.username)
        return
      }
      // The account or the name belongs to another key, or the row expired:
      // this row can never be confirmed, so offer another account.
      setWaitlist('')
      if (feiraLimit(err)) {
        setConfirmFailed(true)
        return
      }
      if (err && err.code === 'convite-invalido') {
        dropSignupInvite()
        dropSignupInviteCard()
        if (onInviteChanged) onInviteChanged()
      }
      if (err && RESTARTABLE.has(err.code)) setConfirmFailed(true)
      throw err
    } finally {
      // A lost answer or 'expirado' after a finish that went through: the
      // status read below brings the certificate back.
      await onChanged()
      load()
    }
  })

  const doRename = () => {
    const username = isUsername(newName)
    if (username === null) return setError(NAME_RULE)
    run(async () => {
      try {
        const { nonce } = await renameStart({ member: publicKey, username })
        const { signature } = await node.request('account.sign', { phase: 'rename', nonce, username, sub: '' })
        const r = await renameFinish({ member: publicKey, nonce, signature })
        await node.request('username.add', { record: r.usernameRecord })
        accepted(publicKey, r.usernameRecord)
        setNewName('')
        setRenameOpen(false)
        setNote('Pronto: agora você é @' + username + '. A próxima troca fica liberada em ' + formatNextChange(r.nextChangeAt) + '.')
      } finally {
        // Awaited: busy clears only once status is fresh, so the effect
        // above never acts on a status that still carries the old record.
        await onChanged()
        await load()
      }
    })
  }

  // The app's paste field (Idade.js InvitePaste) now holds a code: the form
  // comes back (the tick re-renders when no note was showing).
  const usePasted = () => {
    setError('')
    setInviteNote('')
    setPasteTick((n) => n + 1)
    if (onInviteChanged) onInviteChanged()
  }

  const restartLink = () => {
    setError('')
    setNote('')
    setConfirmFailed(false)
    setRestart(true)
    setFormOpen(true)
  }

  let body
  if (cur === null) {
    body = acctError ? null : <Soft>carregando…</Soft>
  } else if (linked) {
    const next = typeof status.nextChangeAt === 'string' ? Date.parse(status.nextChangeAt) : NaN
    const blocked = !Number.isNaN(next) && now < next
    const typed = isUsername(newName)
    body = (
      <>
        <Label>seu @nome</Label>
        <Body>{displayText(atName(status.username) || NO_NAME)}</Body>
        {/* After the one automatic try (certTried), whatever else cleared the error. */}
        {!memberCert && status.cert && certTried.current.has(JSON.stringify(status.cert)) && !busy ? <Btn label='Tentar de novo' onPress={receive} /> : null}
        {memberCert && nameFailed && !busy ? <Btn label='Tentar enviar o @nome de novo' onPress={retryName} /> : null}
        {!renameOpen
          ? <Btn label='Trocar @nome' secondary onPress={() => { setError(''); setNote(''); setRenameOpen(true) }} disabled={busy} />
          : blocked
            ? (
              <>
                <Body>{'Você poderá trocar o @nome de novo em ' + formatNextChange(status.nextChangeAt) + '.'}</Body>
                <Btn label='Fechar' secondary onPress={() => setRenameOpen(false)} />
              </>
              )
            : (
              <>
                <Field label='novo @nome' placeholder='@nome' value={newName} onChangeText={setNewName} mono />
                <Body>{RENAME_RULE}</Body>
                <Row>
                  <Btn label={'Trocar para @' + displayText(typed || newName.trim().replace(/^@/, ''))} onPress={doRename} pending={busy} disabled={typed === null} />
                  <Btn label='Cancelar' secondary onPress={() => setRenameOpen(false)} disabled={busy} />
                </Row>
              </>
              )}
      </>
    )
  } else {
    const waiting = waitlist !== ''
    const row = restart ? null : cur.pending
    const foreign = row !== null && row.member !== publicKey
    // While the cap is full the confirm step is not a failure: the name form
    // stays, including the setup step, with a manual retry and no spinner.
    const confirmable = !waiting && row !== null && !foreign && typeof row.sub === 'string' && row.sub !== ''
    const showForm = !confirmable && (!memberCert || formOpen || waiting)
    // No code stored, by invite or after an invite refusal: no @nome field
    // and no Google button, so Google is never reached without a code. With
    // a stored code a refusal keeps the form: the code may have been held
    // by an earlier attempt and work again. The code itself is never shown.
    const required = policy !== undefined && policy !== null
    const hasInvite = loadSignupInvite() !== null
    const inviteBlocked = !waiting && !hasInvite && (inviteNote !== '' || required)
    const waitlistNote = waiting
      ? (
        <>
          <Body>{waitlist}</Body>
          <Btn label='Tentar de novo' onPress={doLink} disabled={busy || isUsername(name) === null} />
        </>
        )
      : null
    const inviteLine = inviteBlocked
      ? null
      : inviteNote !== ''
        ? <Body>{inviteNote}</Body>
        : required && hasInvite ? <Soft>{INVITE_READY_TEXT}</Soft> : null
    const inviteNeeded = (
      <>
        <Body>{inviteNote || (feiraDecision !== null && feiraDecision.action === 'needs-invite' ? feiraDecision.text : feiraOffer ? ENTRY_TEXT : INVITE_NEEDED_TEXT)}</Body>
        {feiraOffer ? <Btn label={feiraTried && !feiraBusy ? 'Tentar de novo' : 'Pedir entrada'} onPress={pressFeiraStart} pending={feiraBusy} /> : null}
        {NATIVE ? <InvitePaste onPasted={usePasted} disabled={busy || feiraBusy} /> : null}
      </>
    )
    // Until the policy answers, the button waits rather than racing it.
    const linkDisabled = name.trim() === '' || policy === undefined || feiraBusy
    body = (
      <>
        {foreign ? <ErrorText>{LINK_FAILED}</ErrorText> : null}
        {confirmable
          ? (
            <>
              <Body>
                {setup
                  ? 'Quase lá: confirme o vínculo com ' + displayText(atName(row.username) || NO_NAME) + '.'
                  : 'Conta Google escolhida. Confirme o vínculo com ' + displayText(atName(row.username) || NO_NAME) + '.'}
              </Body>
              {confirmFailed
                // The mapped message is the card's error line below.
                ? <Btn label='Usar outra conta Google' onPress={restartLink} disabled={busy} />
                : (
                  <>
                    <Btn label='Confirmar vínculo' onPress={doConfirm} pending={busy} />
                    <Btn label='Começar de novo' secondary onPress={restartLink} disabled={busy} />
                  </>
                  )}
            </>
            )
          : null}
        {showForm && setup
          ? (
            <>
              {inviteBlocked ? null : <Field label='@nome' placeholder='@nome' value={name} onChangeText={setName} mono />}
              <Body>{SHORT.link}</Body>
              {inviteLine}
              {inviteBlocked
                ? inviteNeeded
                : waitlistNote || <Btn label='Continuar com o Google' onPress={doLink} pending={busy} disabled={linkDisabled} />}
            </>
            )
          : null}
        {showForm && !setup
          ? (
            <>
              <HelpNote doc={HELP.vinculo}><Body>{SHORT.link}</Body></HelpNote>
              {inviteLine}
              {inviteBlocked
                ? inviteNeeded
                : (
                  <>
                    <Field label='@nome' placeholder='@nome' value={name} onChangeText={setName} mono />
                    {waitlistNote || <Btn label='Vincular conta Google' onPress={doLink} pending={busy} disabled={linkDisabled} />}
                  </>
                  )}
            </>
            )
          : null}
        {!confirmable && !showForm
          ? <Btn label='Vincular conta Google' secondary onPress={() => { setError(''); setFormOpen(true) }} />
          : null}
      </>
    )
  }

  return (
    <Card>
      {setup ? null : <Label>conta</Label>}
      <Notice>{returned || ''}</Notice>
      {body}
      <ErrorText>{acctError || error}</ErrorText>
      <Notice>{note}</Notice>
      {acctError ? <Btn label='Tentar de novo' secondary onPress={load} /> : null}
    </Card>
  )
}

// setup: the first run (App.js). The cards render inside the Stepper of
// `step` (src/onboarding.js) at `index` of `total`.
// onLinked (setup only): called once a certificate from the account link
// lands in this diary, so the shell knows the setup took the Google return.
// feira (App.js): a Feira listing entry, { holder, origin, hold } from
// src/feiraEntry.js and the signup invite holder's writer; null otherwise.
// onInviteChanged: the held signup code or its card changed here (a paste,
// a drop), so the shell reads the card again.
export default function Identidade ({ active, embedded = false, setup = false, view = 'all', step, index = 0, total = 3, onInfo, onLinked, onInviteChanged, invite = null, feira = null }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const outbox = useOutbox()
  const passkey = node.passkey
  const pkStatus = passkey !== null ? passkey.status : null
  const locked = passkey !== null && (pkStatus === null || pkStatus.unlocked !== true)
  const generation = passkey !== null ? passkey.generation : 0
  const [info, setInfo] = useState(null)
  const [identity, setIdentity] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [certText, setCertText] = useState('')
  const [certLocal, setCertLocal] = useState('')
  const [done, setDone] = useNotice()
  const create = useAction()
  const add = useAction()

  // Passkey ceremonies (web). Not through useAction: it keeps only the text
  // of an error, and these branch on err.code and err.legacy.
  const pkBusy = useRef(false)
  const [pkPending, setPkPending] = useState(false)
  const [pkError, setPkError] = useState('')
  const [pkNote, setPkNote] = useState('')
  // null, or { created, notSynced, cleaned } once a ceremony reported NO_PRF
  // or NOT_SYNCED, until 'tentar de novo'. staleIds: user ids of unusable
  // passkeys the manager still holds (a cleaned one was already sent for
  // removal). Only failures seen in this page session: a stored refusal is
  // never a reason to name a passkey, because it may have become the account
  // on another device or browser since.
  const [noPrf, setNoPrf] = useState(null)
  const [staleIds, setStaleIds] = useState([])
  // null, or { legacy } once a ceremony reported MISMATCH (the stored diary
  // belongs to another identity): offers "recomeçar".
  const [mismatch, setMismatch] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)
  // false, true, or { phone: true }. The phone flag has to live here: the
  // EXISTS confirm is a second click, and that click must repeat the phone
  // ceremony rather than a plain create.
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [showKey, setShowKey] = useState(false)
  // Fallback only when status.pending is missing (an older node script).
  const [awaitingComplete, setAwaitingComplete] = useState(false)
  // A passkey chosen at Entrar failed: a creation awaiting 'concluir' may be
  // gone, so 'Criar passkey' is offered beside it (no effect when none awaits).
  const [createToo, setCreateToo] = useState(false)
  // The known passkey did not appear. A cancel forgets nothing.
  const [knownLost, setKnownLost] = useState(false)
  // The web cannot tell a dismissed sheet from a missing passkey (both are
  // NotAllowedError): one miss only offers another passkey; the lost card
  // waits for that second try to fail too.
  const [missedOnce, setMissedOnce] = useState(false)
  // NONE on Entrar with no known passkey: a notice, not an error line.
  const [noCredential, setNoCredential] = useState(false)
  // The recovery code field. The typed code leaves the state once the node
  // took it (or on cancelar); a refused one stays so a typo can be fixed.
  const [codeOpen, setCodeOpen] = useState(false)
  const [codeText, setCodeText] = useState('')
  // A code opened the account's root ({ needsPasskey }): the next press
  // creates the passkey (finishRecovery).
  const [needsPasskey, setNeedsPasskey] = useState(false)
  // The registration of that passkey failed (shown once unlocked).
  const [regNote, setRegNote] = useState('')
  // The result of the finishRecovery (or its 'concluir') that installed the
  // identity: afterUnlock registers it before the once sync starts.
  const finishedRef = useRef(null)
  // The once sync after an unlock (node.passkey.recovering, shared by every
  // mounted Identidade): no instance sends a request while it runs (any
  // member request would preempt and end it); the one that unlocked reads
  // what it needs before starting the run.
  const recovering = passkey !== null && passkey.recovering === true

  // notify = false keeps the shell's info as it is (the setup step stays up
  // while the sync after an unlock runs).
  const refresh = useCallback(async (notify = true) => {
    try {
      const i = await node.request('node.info', {})
      setInfo(i)
      // Lets the shell know whether setup is complete (identity + certificate).
      if (notify && typeof onInfo === 'function') onInfo(i)
      setIdentity(i.publicKey === null ? null : await node.request('identity.show', {}))
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request, onInfo])

  // An unlock, lock or reset changed the identity: what was read is stale.
  useEffect(() => {
    setInfo(null)
    setIdentity(null)
    setLoadError('')
  }, [generation])

  // Also when the recovery ends: a second device now has its certificate
  // back (the provider re-reads the passkey status then).
  // During the setup (passkey, no confirmed certificate) nothing is read
  // while a once run is active (a read would preempt and end it): the read
  // happens when it ends.
  const setupIncomplete = info === null || info.publicKey === null || info.memberCert !== true
  const setupIncompleteRef = useRef(setupIncomplete)
  setupIncompleteRef.current = setupIncomplete
  const onceActive = node.sync.active !== null && node.sync.active.once === true
  useEffect(() => {
    if (!active || locked || recovering) return
    if (passkey !== null && onceActive && setupIncompleteRef.current) return
    refresh()
  }, [active, locked, recovering, onceActive, generation, refresh])

  // While the setup is incomplete (unlocked, no confirmed certificate) every
  // ended sync run may have brought the certificate (a manual sync after a
  // recovery that timed out): read the identity and the passkey status again.
  const setupOpenRef = useRef(false)
  setupOpenRef.current = passkey !== null && active && !locked && !recovering && !onceActive &&
    (info === null || info.publicKey === null || info.memberCert !== true)
  const passkeyRef = useRef(passkey)
  passkeyRef.current = passkey
  const stopped = node.sync.stopped
  useEffect(() => {
    if (stopped === null || !setupOpenRef.current) return
    refresh()
    if (passkeyRef.current !== null) passkeyRef.current.refresh()
  }, [stopped, refresh])

  // Whether a new member can join (hosted only), asked before any creation is
  // offered: the ceremony runs synchronously in the click, so the press cannot
  // await it. A failed read (null) never blocks, because the account service
  // still refuses later. The answer belongs to one installation (origin).
  const [admissionEntry, setAdmissionEntry] = useState(null)
  const [admissionPending, setAdmissionPending] = useState(false)
  const admissionSeq = useRef(0)
  const admissionOrigin = installationOrigin() ?? globalThis.location?.origin ?? ''
  const admissionState = admissionFor(admissionEntry, admissionOrigin)
  const readAdmission = useCallback(() => {
    const mine = ++admissionSeq.current
    const origin = admissionOrigin
    setAdmissionPending(true)
    admission().then((answer) => {
      if (mine !== admissionSeq.current) return
      setAdmissionEntry({ origin, answer })
      setAdmissionPending(false)
    })
  }, [admissionOrigin])
  // A boolean, not the passkey object: that object changes on every status
  // refresh, which would drop the answer in flight and ask again.
  const admissionAsks = passkey !== null
  useEffect(() => {
    if (!active || !locked || node.hosted !== true || !admissionAsks || admissionState !== undefined) return
    readAdmission()
  }, [active, locked, node.hosted, admissionAsks, admissionState, readAdmission])
  useEffect(() => () => { admissionSeq.current++ }, [])

  const doCreate = async () => {
    const r = await create.run(() => node.request('identity.create', {}))
    if (r.ok) refresh()
  }

  const doCert = async () => {
    setDone('')
    const parsed = parseCertificateText(certText)
    if (parsed.error) return setCertLocal(parsed.error)
    const cert = parsed.cert
    setCertLocal('')
    const r = await add.run(() => node.request('cert.add', { cert }))
    if (r.ok) {
      setCertText('')
      setDone(setup ? 'Conta liberada.' : 'Certificado gravado.')
      refresh()
    }
  }

  const pkStart = () => {
    if (pkBusy.current) return false
    pkBusy.current = true
    setPkPending(true)
    setPkError('')
    setPkNote('')
    setConfirmCreate(false)
    setConfirmReset(false)
    return true
  }
  const pkEnd = () => {
    pkBusy.current = false
    setPkPending(false)
  }
  // created: the failing passkey was made on this page (Criar or concluir),
  // so it can be named for deletion; one chosen at Entrar may be the account.
  // Every sign-in path (doUnlock, onOtherPasskey, the phone sign-in) passes
  // false, so a NOT_SYNCED there shows the card without growing staleIds.
  // plain: Entrar offered only the known passkey. A cancel there, or NONE,
  // means that passkey did not appear. Nothing is reset or forgotten.
  const pkFail = (err, created = false, mode = false) => {
    const code = err && err.code
    if (code === 'NO_PRF' || code === 'NOT_SYNCED') {
      const id = err.userId
      const cleaned = err.cleaned === true
      // Both codes: a cleaned id was already handed to the manager, so the
      // list grows only for passkeys the person may still have to remove.
      // err.created false: the authenticator handed back a passkey that was
      // not made by this request (it may be an account): never named.
      if (created && err.created !== false && !cleaned && typeof id === 'string') setStaleIds((ids) => ids.includes(id) ? ids : [...ids, id])
      // After a failure at Entrar a pending creation may be gone (that same
      // passkey) or still live (another one): 'Criar passkey' shows beside
      // 'concluir'.
      if (!created) setCreateToo(true)
      return setNoPrf({ created, notSynced: code === 'NOT_SYNCED', cleaned })
    }
    if (code === 'MISMATCH') return setMismatch({ legacy: err.legacy === true })
    const known = pkStatus !== null && pkStatus.passkeyKnown === true
    // NONE (Android: no passkey for this site) or a second miss after
    // 'entrar com outra passkey': the known passkey is gone from here.
    if (known && (code === 'NONE' || (mode === 'other' && code === 'CANCELLED'))) {
      setNoCredential(false)
      setMissedOnce(false)
      return setKnownLost(true)
    }
    // Platform difference, not a capability: Android reports a missing
    // passkey as NONE, so its CANCELLED is a real cancel; the browser sends
    // the same NotAllowedError for both.
    if (known && mode === 'plain' && code === 'CANCELLED' && !NATIVE) return setMissedOnce(true)
    if (code === 'NONE') {
      // The notice says to create one here: offer 'Criar passkey' even
      // beside a pending 'concluir'.
      setCreateToo(true)
      return setNoCredential(true)
    }
    setPkError(errorText(err))
  }

  // After an unlock: the diary for this key (created if this browser has
  // none), then one sync with the seeder.
  const afterUnlock = async () => {
    // A diary that already exists with a sync running (e.g. "sincronizar uma
    // vez" started on Entrar): any read would preempt that run, and recover()
    // adopts it, so go straight there.
    const adopt = pkStatus !== null && pkStatus.exists === true && node.sync.active !== null
    if (!adopt) {
      try {
        const i = await node.request('node.info', {})
        if (i.publicKey === null) await node.request('identity.create', {})
      } catch (err) {
        setPkError(errorText(err))
      }
      await refresh(false)
      // The status read right after a first ceremony has no key yet (the diary
      // did not exist); re-reading it here makes the key known before any
      // Google step, even when the recovery ends without a sync (offline).
      try { await passkey.refresh() } catch {}
    }
    // recovery.sign needs the diary, and never preempts a run.
    const finished = finishedRef.current
    finishedRef.current = null
    if (finished !== null) await registerFinished(finished)
    // Ends the recovery itself when the run cannot start (no identity, a run
    // already active); every Identidade then reads again.
    await passkey.recover()
  }

  const registerFinished = async (r) => {
    let member = typeof r.publicKey === 'string' ? r.publicKey : null
    if (member === null) {
      try {
        const st = await passkey.refresh()
        if (st && typeof st.publicKey === 'string') member = st.publicKey
      } catch {}
    }
    const entry = { member, kind: 'passkey', lookupId: r.lookupId, blob: r.blob, credentialId: r.credentialId, userId: r.userId, change: false }
    try {
      if (member === null) throw new Error('identidade não encontrada')
      await registerEntry({ request: node.request, account: RECOVERY_ACCOUNT, member, kind: 'passkey', lookupId: r.lookupId, blob: r.blob })
      releaseUnregistered()
      setRegNote('')
    } catch (err) {
      if (member !== null) holdUnregistered(entry)
      setRegNote(err && err.uncertain === true ? REGISTER_UNCERTAIN_TEXT : REGISTER_FAILED_TEXT)
    }
  }

  // The handle's unlock/complete is called synchronously in the click
  // handler: the WebAuthn ceremony needs this click's user activation, so
  // nothing is awaited before it. Phone and "another passkey" go through
  // the same helper, still inside the click.
  // plain: Entrar with the known credential only.
  const ceremony = (call, created = false, completing = false, mode = false) => {
    if (!pkStart()) return
    passkey.beginRecovery()
    let pending
    try { pending = call() } catch (err) { pending = Promise.reject(err) }
    Promise.resolve(pending)
      .then(async (r) => {
        if (r && r.pending === true) {
          passkey.endRecovery()
          setAwaitingComplete(true)
          setCreateToo(false)
          // knownLost stays: a replacement that then fails at 'concluir'
          // must still offer Criar and another passkey.
          setNoCredential(false)
          return
        }
        if (r && r.needsPasskey === true) {
          passkey.endRecovery()
          setCodeText('')
          setCodeOpen(false)
          return setNeedsPasskey(true)
        }
        if (mode === 'code') setCodeText('')
        finishedRef.current = (mode === 'finish' || completing) && finishing(r) ? r : null
        setNeedsPasskey(false)
        setAwaitingComplete(false)
        setCreateToo(false)
        setMismatch(null)
        setNoPrf(null)
        setStaleIds([])
        setKnownLost(false)
        setMissedOnce(false)
        setNoCredential(false)
        await afterUnlock()
      }, (err) => {
        passkey.endRecovery()
        // The node drops the pending creation only when its own passkey fails.
        // Older nodes omit status.pending, so this local flag is the fallback.
        if (completing && err && err.code === 'NO_PRF') setAwaitingComplete(false)
        // The node dropped the held root (timeout, lock): the code again.
        if (mode === 'finish' && err && err.code === 'RECOVERY_BAD') setNeedsPasskey(false)
        pkFail(err, created, mode)
      })
      .finally(pkEnd)
  }

  // status.pending is authoritative when the node sends a boolean (it
  // survives a reload). The local flag covers an older node script.
  const showComplete = pkStatus !== null && typeof pkStatus.pending === 'boolean'
    ? pkStatus.pending
    : awaitingComplete
  // knownLost offers Criar again even when this device still has a record
  // of the passkey that just failed to appear.
  // While 'concluir' waits, a new creation would abandon that passkey.
  const createFirst = (knownLost && !showComplete) || (pkStatus !== null && !pkStatus.passkeyKnown && (!showComplete || createToo))
  // Hybrid transport (the phone QR) is a browser capability. Native has no
  // such sheet: the button is not offered, and no phone ceremony is started.
  const phoneOk = !NATIVE && pkStatus !== null && pkStatus.hybrid !== 'no'
  const offer = admissionOffer({ hosted: node.hosted === true, admission: admissionState, createFirst, phoneOk })
  // A hidden EXISTS confirm must not keep the phone and code buttons disabled.
  useEffect(() => {
    if (!offer.create && confirmCreate !== false) setConfirmCreate(false)
  }, [offer.create, confirmCreate])
  // Offer creation advice only when creation is available, including when
  // a known passkey is lost and Criar is offered again.
  const showPhoneHint = phoneOk && offer.create && (pkStatus.platform !== 'yes' || knownLost)

  const doUnlock = () => ceremony(() => passkey.unlock({}), false, false, 'plain')
  const doRegister = (phone = false) => {
    if (!offer.create) return
    // The press event is truthy and is not a phone choice. The flag set when
    // the EXISTS confirm opened is what the second click has to forward.
    const usePhone = phone === true || (typeof confirmCreate === 'object' && confirmCreate !== null && confirmCreate.phone === true)
    ceremony(() => passkey.unlock(usePhone ? { register: true, phone: true } : { register: true }), true)
  }
  const doComplete = () => ceremony(() => passkey.complete(), true, true)

  const onCreatePress = (phone = false) => {
    if (!offer.create) return
    const usePhone = phone === true
    if (pkStatus !== null && pkStatus.exists && !confirmCreate) {
      setConfirmCreate(usePhone ? { phone: true } : true)
      return
    }
    doRegister(usePhone)
  }

  const onPhonePress = () => {
    if (!phoneOk) return
    // A new account on top of an existing diary still needs the EXISTS
    // confirm. The ceremony itself stays in that later click (doRegister).
    if (offer.phoneCreate && pkStatus !== null && pkStatus.exists && !confirmCreate) {
      onCreatePress(true)
      return
    }
    ceremony(() => passkey.unlock(offer.phoneCreate ? { register: true, phone: true } : { phone: true }), offer.phoneCreate)
  }

  const onOtherPasskey = () => ceremony(() => passkey.unlock({ any: true }), false, false, 'other')

  // No WebAuthn here: the node checks the code, then the provider fetches the
  // sealed root. The ceremony wrapper keeps one flow and one busy flag.
  const onCodeSubmit = () => {
    const code = codeText.trim()
    // Another creation awaits 'concluir': it is finished or abandoned first.
    if (code === '' || showComplete) return
    ceremony(() => passkey.unlockWithCode(code), false, false, 'code')
  }
  const onCodeCancel = () => {
    setCodeText('')
    setCodeOpen(false)
  }
  // WebAuthn inside the press: finishRecovery is the call itself.
  const onFinishRecovery = () => ceremony(() => passkey.finishRecovery(), true, false, 'finish')
  // The recovery's own creation answered { pending: true }: its 'concluir'
  // keeps the 'finish' mode, so the result is registered and a dropped root
  // (RECOVERY_BAD) ends the recovery card.
  const onFinishComplete = () => ceremony(() => passkey.complete(), true, true, 'finish')
  const onCancelRecovery = () => {
    setNeedsPasskey(false)
    passkey.cancelRecovery().catch(() => {})
  }

  // Only the reset: the next click is 'entrar com a passkey' (a ceremony
  // after an awaited reset would have lost the click's activation).
  // The outbox items of the identity being reset go first (their diary is
  // about to be deleted): a crash in between never leaves posts queued for a
  // diary that is gone. A reset that then fails keeps them deleted, as
  // RESET_TEXT says.
  const doReset = () => {
    if (!pkStart()) return
    const oldKey = pkStatus !== null ? pkStatus.publicKey : null
    if (typeof oldKey === 'string' && !outbox.forgetAuthor(oldKey)) {
      setPkError('não foi possível apagar as publicações que aguardam envio neste aparelho')
      return pkEnd()
    }
    passkey.reset().then(() => {
      setMismatch(null)
      setAwaitingComplete(false)
      setCreateToo(false)
      setKnownLost(false)
      setMissedOnce(false)
      setStaleIds([])
      setNoCredential(false)
      setPkNote('A conta antiga foi apagada ' + (NATIVE ? 'deste aparelho' : 'deste navegador') + '. Entre com a passkey para recomeçar.')
    }, pkFail).finally(pkEnd)
  }

  // A profile invite (App.js, src/profileLink.js) or a group or community
  // link (src/groupLink.js) on a card where no ceremony is possible (an
  // in-app browser, an IP address): the visitor is told to open the link
  // elsewhere and can copy it; a group or community link is never drawn as
  // text. Hosted page only.
  const inviteHere = node.hosted === true && invite !== null
  // A Feira listing link: the visitor is told why to enter. Nothing is sent.
  const feiraHere = feira !== null && !!feira.holder && feira.holder.load(feira.origin) !== null
  const blockedInvite = inviteHere
    ? (
      <>
        <Notice>{displayText(invite.text)}</Notice>
        <Soft>{invite.openText || OPEN_IN_BROWSER_TEXT}</Soft>
        <ShareProfile url={invite.link} labels={invite.labels} />
      </>
      )
    : null
  let entrar = null
  if (passkey !== null && locked) {
    // The browser itself cannot (no WebAuthn, or it reports no PRF): only
    // another browser helps.
    const browserBlocked = pkStatus !== null && (pkStatus.webauthn === false || pkStatus.prf === 'no')
    // A diary of an older version is known before any ceremony.
    const shownMismatch = mismatch || (pkStatus !== null && pkStatus.legacy ? { legacy: true } : null)
    if (pkStatus === null) {
      entrar = passkey.error
        ? (
          <Card>
            <ErrorText>{passkey.error}</ErrorText>
            <Btn label='Tentar de novo' onPress={() => passkey.refresh()} />
          </Card>
          )
        : <Soft>carregando…</Soft>
    } else if (pkStatus.rpIdError && !NATIVE) {
      // The address cannot carry a passkey (an IP): the page must be opened
      // by its domain name (localhost in development).
      entrar = (
        <Card>
          <Notice>{displayText(pkStatus.rpIdError)}</Notice>
          {blockedInvite}
        </Card>
      )
    } else if (browserBlocked) {
      // No live failure here, so no passkey is named for deletion.
      entrar = (
        <Card>
          <Notice>{NATIVE ? DEVICE_TEXT : BROWSER_TEXT}</Notice>
          {blockedInvite}
        </Card>
      )
    } else if (noPrf !== null) {
      // A passkey was created or chosen but its manager gives no PRF, or the
      // new one would stay on this device. The node keeps a created one out
      // of the next creation, so another try can save the new one elsewhere.
      const steps = noPrf.notSynced === true
        ? notSyncedSteps({ userIds: staleIds, cleaned: noPrf.cleaned === true, native: NATIVE, withLink: inviteHere, phone: phoneOk })
        : unusableSteps({ userIds: staleIds, withLink: inviteHere, created: noPrf.created, known: pkStatus.passkeyKnown === true && noPrf.created !== true, native: NATIVE, cleaned: noPrf.cleaned === true })
      entrar = (
        <Card>
          <Notice>{noPrf.notSynced === true ? NOT_SYNCED_TITLE : UNUSABLE_TITLE}</Notice>
          {steps.map((step) => <Body key={step}>{step}</Body>)}
          <Btn label={RETRY_BUTTON} onPress={() => setNoPrf(null)} disabled={pkPending} />
          {blockedInvite}
        </Card>
      )
    } else if (needsPasskey) {
      // Exclusive: a pending creation here can only be the recovery's own
      // (the code entry is hidden while another one awaits 'concluir').
      entrar = (
        <Card>
          <Body>{NEEDS_PASSKEY_TEXT}</Body>
          {showComplete
            ? (
              <>
                <Body>{PENDING_TEXT}</Body>
                <Btn label='Concluir a criação da passkey' onPress={onFinishComplete} pending={pkPending} />
              </>
              )
            : <Btn label='Criar passkey nova' onPress={onFinishRecovery} pending={pkPending} />}
          <Btn label='Cancelar' secondary onPress={onCancelRecovery} disabled={pkPending} />
          <ErrorText>{pkError}</ErrorText>
        </Card>
      )
    } else {
      // The welcome. The first ceremony leads: 'Criar passkey' for a browser
      // with no passkey known (or one whose known passkey did not appear),
      // 'Entrar com a passkey' otherwise; the other is secondary. Same
      // handlers as before (doUnlock, onCreatePress, doRegister, doComplete):
      // only the order and the labels changed.
      const entrarBtn = (
        <Btn
          label='Entrar com a passkey'
          secondary={showComplete || offer.create}
          onPress={doUnlock}
          pending={pkPending && !showComplete}
          disabled={pkPending}
        />
      )
      const criarBtn = !createFirst
        ? null
        : confirmCreate
          ? (
            <>
              <Notice>{EXISTS_TEXT}</Notice>
              <Row>
                <Btn label='Criar mesmo assim' secondary onPress={doRegister} disabled={pkPending} />
                <Btn label='Cancelar' secondary onPress={() => setConfirmCreate(false)} disabled={pkPending} />
              </Row>
            </>
            )
          : <Btn label='Criar passkey' onPress={onCreatePress} disabled={pkPending} />
      entrar = (
        <Card>
          <Text style={styles.brand}>Varanda</Text>
          {inviteHere
            ? (
              <>
                <Notice>{displayText(invite.text)}</Notice>
                <Btn label='Agora não' secondary onPress={() => invite.onDismiss()} disabled={pkPending} />
              </>
              )
            : null}
          {feiraHere
            ? (
              <>
                <Label>{ENTRY_TITLE}</Label>
                <Notice>{ENTRY_TEXT}</Notice>
              </>
              )
            : null}
          <Body>{WELCOME_TEXT}</Body>
          <Soft>{SHORT.passkeyLoss}</Soft>
          {offer.create ? <Soft>{SYNC_ADVICE}</Soft> : null}
          {knownLost ? <Notice>{offer.full || offer.waiting ? KNOWN_LOST_FULL_TEXT : KNOWN_LOST_TEXT}</Notice> : null}
          {noCredential ? <Notice>{offer.full || offer.waiting ? NONE_FULL_TEXT : NONE_TEXT}</Notice> : null}
          {shownMismatch
            ? (
              <>
                <Notice>{mismatchText(shownMismatch.legacy)}</Notice>
                {confirmReset
                  ? (
                    <>
                      <Notice>{RESET_TEXT}</Notice>
                      <ConfirmStack
                        confirm={<Btn label='Apagar e recomeçar' danger onPress={doReset} pending={pkPending} />}
                        cancel={<Btn label='Cancelar' secondary onPress={() => setConfirmReset(false)} disabled={pkPending} />}
                      />
                    </>
                    )
                  : <Btn label='Recomeçar com esta passkey' danger onPress={() => setConfirmReset(true)} disabled={pkPending} />}
              </>
              )
            : null}
          {showComplete
            ? (
              <>
                <Body>{PENDING_TEXT}</Body>
                <Btn label='Concluir a criação da passkey' onPress={doComplete} pending={pkPending} />
              </>
              )
            : null}
          {offer.create ? criarBtn : null}
          {offer.full
            ? (
              <>
                <Body>{FULL_TEXT}</Body>
                <Btn label={RETRY_BUTTON} secondary onPress={readAdmission} disabled={pkPending || admissionPending} />
              </>
              )
            : null}
          {missedOnce && !knownLost ? <Soft>{MISSED_TEXT}</Soft> : null}
          {knownLost || missedOnce || pkStatus.passkeyKnown === true ? <Btn label={OTHER_PASSKEY_LABEL} secondary onPress={onOtherPasskey} disabled={pkPending} /> : null}
          {entrarBtn}
          {phoneOk ? <Btn label={offer.phoneCreate ? PHONE_BUTTON : PHONE_SIGNIN_BUTTON} secondary onPress={onPhonePress} disabled={pkPending || confirmCreate !== false} /> : null}
          {showPhoneHint ? <Soft>{PHONE_HINT}</Soft> : null}
          {phoneOk ? <Soft>{PHONE_SIGNIN_HINT}</Soft> : null}
          {showComplete
            ? null
            : codeOpen
              ? (
                <>
                  <Label>Código de recuperação</Label>
                  <TextInput
                    style={styles.manual}
                    value={codeText}
                    onChangeText={setCodeText}
                    autoCapitalize='characters'
                    autoCorrect={false}
                    spellCheck={false}
                    autoComplete='off'
                    importantForAutofill='no'
                    accessibilityLabel='código de recuperação'
                    editable={!pkPending}
                  />
                  <Soft>{CODE_HINT}</Soft>
                  <Row>
                    <Btn label='Entrar com o código' onPress={onCodeSubmit} pending={pkPending} disabled={pkPending || codeText.trim() === ''} />
                    <Btn label='Cancelar' secondary onPress={onCodeCancel} disabled={pkPending} />
                  </Row>
                </>
                )
              : <Btn label={CODE_LABEL} secondary onPress={() => setCodeOpen(true)} disabled={pkPending || confirmCreate !== false} />}
          <ErrorText>{pkError}</ErrorText>
          <Notice>{pkNote}</Notice>
          {node.hosted === true ? <Notice>{takeReturnNotice() || ''}</Notice> : null}
        </Card>
      )
    }
  }

  // The frame: in the setup the Stepper of the current step (the Page is
  // flush: the Stepper carries the column and its padding); otherwise the
  // plain page with its title (none when the top bar already shows one).
  const frame = (title, children) => (setup
    ? (
      <Page flush padBottom={16}>
        <Stepper index={index} total={total} title={STEP_TITLES[step] || title} hint={STEP_HINTS[step] || ''}>
          {children}
        </Stepper>
      </Page>
      )
    : (
      <Page>
        {embedded ? null : <Title>{title}</Title>}
        {children}
      </Page>
      ))

  if (entrar !== null) return frame('Entrar', entrar)

  const withPasskey = passkey !== null
  // certLocal only ever holds a parseCertificateText error.
  const certError = setup && certLocal ? PLAIN_PARSE_ERROR : certLocal
  const needsCert = info !== null && info.publicKey !== null && !info.memberCert
  // Hosted page with a passkey: the account link replaces the pasted
  // certificate. Native and varanda-serve keep CertificateStep / the field.
  const linkMode = node.hosted === true && withPasskey
  // Which parts render (Ajustes: 'conta' and 'tecnica'; everything else 'all').
  const showLink = view !== 'tecnica' || needsCert
  const showTech = view !== 'conta'

  return frame('Identidade', (
    <>
      <ErrorText>{loadError}</ErrorText>
      <ErrorText>{withPasskey ? pkError : ''}</ErrorText>
      {withPasskey && regNote ? <Notice>{regNote}</Notice> : null}
      {recovering ? <Notice>Buscando sua conta…</Notice> : null}
      {info === null && !loadError ? <Soft>carregando…</Soft> : null}
      {info !== null && info.publicKey === null
        ? (
          <Card>
            <Body>Você ainda não tem uma conta neste aparelho. Crie uma para começar.</Body>
            <ErrorText>{create.error}</ErrorText>
            <Btn label='Criar conta' onPress={doCreate} pending={create.pending} />
          </Card>
          )
        : null}
      {/* The technical card stays in Ajustes › Identidade; the setup shows
          the key only where the certificate step needs it (below). */}
      {showTech && !setup && info !== null && info.publicKey !== null
        ? (
          <Card>
            <Label>chave pública</Label>
            {showKey ? <Mono>{displayText(info.publicKey)}</Mono> : null}
            <Btn label={showKey ? 'Esconder chave' : 'Mostrar chave'} secondary onPress={() => setShowKey((v) => !v)} />
            {identity ? <Label>associação</Label> : null}
            {identity ? <Mono>{displayText(identity.association)}</Mono> : null}
            <Body>{'certificado de membro: ' + (info.memberCert ? 'válido' : 'ausente')}</Body>
          </Card>
          )
        : null}
      {needsCert && showTech
        ? <Soft>{setup ? 'Sem a liberação da associação, este aparelho não publica nem sincroniza.' : 'Sem o certificado, este aparelho não publica nem sincroniza.'}</Soft>
        : null}
      {showLink && linkMode && info !== null && info.publicKey !== null
        ? (
          <LinkCard
            publicKey={info.publicKey}
            memberCert={info.memberCert === true}
            active={active}
            quiet={recovering || onceActive}
            setup={setup}
            onChanged={refresh}
            onLinked={setup ? onLinked : undefined}
            feira={feira}
            onInviteChanged={onInviteChanged}
          />
          )
        : null}
      {showTech && needsCert && withPasskey && !linkMode
        ? (
          <CertificateStep
            publicKey={info.publicKey}
            certText={certText}
            onCertText={setCertText}
            onSubmit={doCert}
            error={certError || add.error}
            pending={add.pending}
            plain={setup}
          />
          )
        : null}
      {showTech && needsCert && !withPasskey
        ? (
          <Card>
            {/* The setup hides the technical card: the association issues
                the certificate for this key, so it is shown here. */}
            {setup ? <Label>{PLAIN_CODE_LABEL}</Label> : null}
            {setup ? <Mono>{displayText(info.publicKey)}</Mono> : null}
            <Label>{setup ? PLAIN_CERT_LABEL : 'certificado de membro (JSON emitido pela associação)'}</Label>
            <Field value={certText} onChangeText={setCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
            <ErrorText>{certError || add.error}</ErrorText>
            <Btn label={setup ? PLAIN_SUBMIT : 'Gravar certificado'} onPress={doCert} pending={add.pending} disabled={certText.trim() === ''} />
          </Card>
          )
        : null}
      <Notice>{done}</Notice>
      {showTech && !setup && info !== null && info.publicKey !== null ? <Soft>{'pessoas seguidas: ' + String(info.followCount)}</Soft> : null}
    </>
  ))
}

const makeStyles = (colors) => StyleSheet.create({
  brand: { ...type.profileName, color: colors.accent, fontFamily: fonts.title },
  manual: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.ink,
    minHeight: 64
  }
})
