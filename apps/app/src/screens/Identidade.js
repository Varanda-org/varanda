// Identidade: create the identity, show the public key and the member
// certificate status, add the certificate the association issued.
//
// On the web's browser node (node.passkey !== null) the identity comes from
// a passkey: the first card is 'Entrar' (entrar com a passkey, criar passkey,
// concluir a criação when the PRF only arrives on a second ceremony,
// recomeçar for a diary of another identity), a blocking notice when the
// browser cannot derive it (no PRF), and after a successful unlock the diary
// is created if missing and a once sync runs (on a second device it brings
// the certificate and the posts back from the seeder). The native node and
// varanda-serve keep the plain identity card.
//
// With `setup` (the first run, App.js) the same cards render inside the
// onboarding Stepper (src/onboarding.js decides the step) with welcome copy,
// and the technical card (key, association, certificate state) stays for
// Ajustes › Identidade. The setup changes presentation only: every ceremony,
// link, certificate, reset and rename path is the one Ajustes uses.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { authorizeLink, accountStatus, finishLink, formatNextChange, isUsername, parseReturn, readPending, renameFinish, renameStart, startLink } from '../account'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { useOutbox } from '../outboxProvider'
import { Body, Btn, Card, ErrorText, Field, Label, Mono, Notice, Page, Row, Soft, Title, errorText, useAction, useNow } from '../ui'
import { Stepper } from '../ui/Stepper'
import { colors, fonts, type } from '../ui/theme'
import { atName } from '../who'

const WELCOME_TEXT = 'Uma rede social que roda nos aparelhos das pessoas.'
const ENTRAR_TEXT = 'Sua identidade vem da passkey: guarde-a no Gerenciador de Senhas do Google para entrar no celular e no computador. Perder a passkey é perder a identidade; outra passkey é outra identidade.'
// Shown wherever the own key is shown during the setup (the association
// issues the certificate for it).
const KEY_NOTE = 'Sua chave é mostrada aqui e no seu perfil; ela nunca aparece para outras pessoas.'
const NO_NAME = 'ainda sem @nome'
// A passkey created but unusable (no PRF) is named so it can be deleted.
function staleText (userId) {
  return typeof userId === 'string' && /^[0-9a-f]{6,}$/i.test(userId)
    ? 'Apague do gerenciador de senhas a passkey "Varanda ' + userId.slice(0, 6).toLowerCase() + '", que foi criada mas não serve.'
    : ''
}

const NO_PRF_TEXT = 'Este navegador ou gerenciador de passkeys não oferece o recurso necessário (PRF). Use o Chrome ou o Edge com o Gerenciador de Senhas do Google, ou o Safari 18 com as Chaves do iCloud.'
const EXISTS_TEXT = 'Já existe um diário neste navegador; outra passkey é outra identidade.'
const RESET_TEXT = 'A identidade antiga não pode ser reconstruída; ela precisa de um certificado novo. As publicações dela que ainda estão na fila de saída são apagadas.'
const PENDING_TEXT = 'A passkey foi criada. Conclua a criação para derivar a sua identidade.'

function mismatchText (legacy) {
  return 'O diário guardado neste navegador é de outra identidade' +
    (legacy ? ', de uma versão anterior, com a chave gravada no navegador' : '') + '.'
}

// The certificate step: the public key to send to the association (copy or
// share) and the field for the certificate it issues. PR B puts the account
// link before this step.
export function CertificateStep ({ publicKey, certText, onCertText, onSubmit, error, pending }) {
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
      setCopyNote('chave copiada')
    } catch {
      setManual(true)
      setCopyNote('não foi possível copiar: a chave está selecionada abaixo, copie-a')
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
      <Label>sua chave pública</Label>
      <Mono>{key}</Mono>
      <Soft>{KEY_NOTE}</Soft>
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
            accessibilityLabel='sua chave pública'
            onChangeText={() => {}}
          />
          )
        : null}
      <Row>
        <Btn label='copiar chave' secondary onPress={copy} />
        {canShare ? <Btn label='compartilhar' secondary onPress={share} /> : null}
      </Row>
      {copyNote ? <Soft>{copyNote}</Soft> : null}
      <Body>Envie esta chave à associação; ela emite o certificado de membro (JSON), que você cola abaixo.</Body>
      <Label>certificado de membro (JSON emitido pela associação)</Label>
      <Field value={certText} onChangeText={onCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
      <ErrorText>{error}</ErrorText>
      <Btn label='gravar certificado' onPress={onSubmit} pending={pending} disabled={certText.trim() === ''} />
    </Card>
  )
}

// The account link (hosted page with a passkey): the association's account
// service issues the member certificate and the @nome once the key is linked
// to a Google account. Only same-origin /account/* calls (../account.js) and
// the RPCs account.sign, cert.add and username.add; the Google page opens in
// this same tab, so nothing is kept in the browser across the reload.
const LINK_TEXT = 'Para receber o certificado de membro, vincule esta chave a uma conta Google e escolha um @nome. A associação registra o vínculo entre esta chave e a conta Google para poder responder a um pedido judicial ou bloquear a conta; nada mais é coletado. Esta etapa não verifica a idade. Você poderá trocar o @nome depois, uma vez a cada 7 dias.'
const RELOAD_TEXT = 'A página vai abrir o Google e, na volta, recarregar e pedir a passkey de novo.'
const RENAME_RULE = 'Depois de trocar, você só poderá mudar de novo daqui a 7 dias.'
const NAME_RULE = 'nome inválido: de 3 a 20 letras minúsculas, números ou _, começando por letra'
const LINK_FAILED = 'não foi possível vincular a conta'
const CERT_KEPT_ERROR = 'certificado já gravado'
const CERT_KEPT_TEXT = 'vínculo registrado; o certificado atual foi mantido'
const CERT_RECEIVED = 'certificado recebido'
// Finish errors (account.js ERROR_MESSAGES) after which the pending row is
// useless: the member may pick another Google account.
const RESTARTABLE = new Set(['conta-vinculada', 'nome-em-uso', 'expirado'])

// ?conta=ok|erro|cancelado, read once per page load (every mounted
// Identidade shows it, including the one App.js opens in Ajustes after the
// return) and removed from the address bar. The value is cached here, so a
// LinkCard mounted after the removal still shows it; App.js only reads the
// query, this is the only place that removes it.
let returnNotice
function takeReturnNotice () {
  if (returnNotice !== undefined) return returnNotice
  returnNotice = null
  try {
    const loc = globalThis.location
    const hist = globalThis.history
    if (!loc || typeof loc.search !== 'string' || !hist) return null
    returnNotice = parseReturn(loc.search)
    if (new URLSearchParams(loc.search).has('conta')) hist.replaceState(hist.state, '', loc.pathname + loc.hash)
  } catch {}
  return returnNotice
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

function LinkCard ({ publicKey, memberCert, active, quiet, setup = false, onChanged }) {
  const node = useNode()
  const now = useNow(60000)
  // { key, status, pending } of the last load for this key.
  const [acct, setAcct] = useState(null)
  const [acctError, setAcctError] = useState('')
  const [returned] = useState(takeReturnNotice)
  const [name, setName] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  // A pending Google account the member gives up on (rejected by finish, or
  // 'começar de novo'): the stale row is ignored for this page load and the
  // link form shows; its 'vincular conta Google' starts a new row, whose
  // cookie replaces the old one (the service lets the old row expire).
  const [restart, setRestart] = useState(false)
  const [confirmFailed, setConfirmFailed] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seqRef.current
    try {
      const status = await accountStatus(publicKey)
      const pending = status.linked === true ? null : await readPending()
      if (mine !== seqRef.current) return
      setAcct({ key: publicKey, status, pending })
      setAcctError('')
    } catch (err) {
      if (mine === seqRef.current) setAcctError(errorText(err))
    }
  }, [publicKey])

  useEffect(() => { if (active) load() }, [active, load])

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
      const { nonce } = await startLink({ member: publicKey, username })
      const { signature } = await node.request('account.sign', { phase: 'reserve', nonce, username, sub: '' })
      const { authorizeUrl } = await authorizeLink({ signature })
      if (typeof authorizeUrl !== 'string' || !/^https:\/\//.test(authorizeUrl)) throw new Error('serviço indisponível')
      setNote(RELOAD_TEXT)
      globalThis.location.assign(authorizeUrl)
    })
  }

  const doConfirm = () => run(async () => {
    const row = cur === null ? null : cur.pending
    // Never sign for a pending link of another key.
    if (row === null || row.member !== publicKey || typeof row.sub !== 'string' || row.sub === '') throw new Error(LINK_FAILED)
    setConfirmFailed(false)
    try {
      const { signature } = await node.request('account.sign', { phase: 'finish', nonce: row.nonce, username: row.username, sub: row.sub })
      const done = await finishLink({ signature })
      const kept = await apply(done.cert, done.usernameRecord)
      certTried.current.add(JSON.stringify(done.cert))
      setNote(kept ? CERT_KEPT_TEXT : CERT_RECEIVED)
    } catch (err) {
      // The account or the name belongs to another key, or the row expired:
      // this row can never be confirmed, so offer another account.
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
        <Label>nome de usuário</Label>
        <Body>{displayText(atName(status.username) || NO_NAME)}</Body>
        {/* After the one automatic try (certTried), whatever else cleared the error. */}
        {!memberCert && status.cert && certTried.current.has(JSON.stringify(status.cert)) && !busy ? <Btn label='receber o certificado' onPress={receive} /> : null}
        {memberCert && nameFailed && !busy ? <Btn label='enviar o @nome de novo' onPress={retryName} /> : null}
        {!renameOpen
          ? <Btn label='trocar @nome' secondary onPress={() => { setError(''); setNote(''); setRenameOpen(true) }} disabled={busy} />
          : blocked
            ? (
              <>
                <Body>{'Você poderá trocar o @nome de novo em ' + formatNextChange(status.nextChangeAt) + '.'}</Body>
                <Btn label='fechar' secondary onPress={() => setRenameOpen(false)} />
              </>
              )
            : (
              <>
                <Field label='novo @nome' placeholder='@nome' value={newName} onChangeText={setNewName} mono />
                <Body>{RENAME_RULE}</Body>
                <Row>
                  <Btn label={'trocar para @' + displayText(typed || newName.trim().replace(/^@/, ''))} onPress={doRename} pending={busy} disabled={typed === null} />
                  <Btn label='cancelar' secondary onPress={() => setRenameOpen(false)} disabled={busy} />
                </Row>
              </>
              )}
      </>
    )
  } else {
    const row = restart ? null : cur.pending
    const foreign = row !== null && row.member !== publicKey
    const confirmable = row !== null && !foreign && typeof row.sub === 'string' && row.sub !== ''
    const showForm = !confirmable && (!memberCert || formOpen)
    body = (
      <>
        {foreign ? <ErrorText>{LINK_FAILED}</ErrorText> : null}
        {confirmable
          ? (
            <>
              <Body>
                {setup
                  ? 'Quase lá: confirme o vínculo com ' + displayText(atName(row.username) || NO_NAME) + '.'
                  : 'Conta Google escolhida. Confirme o vínculo com o nome ' + displayText(atName(row.username) || NO_NAME) + '.'}
              </Body>
              {confirmFailed
                // The mapped message is the card's error line below.
                ? <Btn label='usar outra conta Google' onPress={restartLink} disabled={busy} />
                : (
                  <>
                    <Btn label='confirmar vínculo' onPress={doConfirm} pending={busy} />
                    <Btn label='começar de novo' secondary onPress={restartLink} disabled={busy} />
                  </>
                  )}
            </>
            )
          : null}
        {showForm && setup
          ? (
            <>
              <Field label='Escolha seu @nome' placeholder='@nome' value={name} onChangeText={setName} mono />
              <Soft>Começa com @: de 3 a 20 letras minúsculas, números ou _.</Soft>
              <Body>{LINK_TEXT}</Body>
              <Soft>{RELOAD_TEXT}</Soft>
              <Btn label='Vincular conta Google' onPress={doLink} pending={busy} disabled={name.trim() === ''} />
            </>
            )
          : null}
        {showForm && !setup
          ? (
            <>
              <Body>{LINK_TEXT}</Body>
              <Field label='@nome' placeholder='@nome' value={name} onChangeText={setName} mono />
              <Soft>{RELOAD_TEXT}</Soft>
              <Btn label='vincular conta Google' onPress={doLink} pending={busy} disabled={name.trim() === ''} />
            </>
            )
          : null}
        {!confirmable && !showForm
          ? <Btn label='vincular conta Google' secondary onPress={() => { setError(''); setFormOpen(true) }} />
          : null}
      </>
    )
  }

  return (
    <Card>
      {setup ? null : <Label>conta Google</Label>}
      <Notice>{returned || ''}</Notice>
      {body}
      <ErrorText>{acctError || error}</ErrorText>
      <Notice>{note}</Notice>
      {acctError ? <Btn label='tentar de novo' secondary onPress={load} /> : null}
    </Card>
  )
}

// setup: the first run (App.js). The cards render inside the Stepper of
// `step` (src/onboarding.js) at `index` of `total`.
export default function Identidade ({ active, embedded = false, setup = false, step, index = 0, total = 3, onInfo }) {
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
  // null, or { userId } once a ceremony reported NO_PRF.
  const [noPrf, setNoPrf] = useState(null)
  // null, or { legacy } once a ceremony reported MISMATCH (the stored diary
  // belongs to another identity): offers "recomeçar".
  const [mismatch, setMismatch] = useState(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [awaitingComplete, setAwaitingComplete] = useState(false)
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

  const doCreate = async () => {
    const r = await create.run(() => node.request('identity.create', {}))
    if (r.ok) refresh()
  }

  const doCert = async () => {
    setDone('')
    let cert
    try {
      // iOS smart punctuation turns typed " into curly quotes; a certificate
      // holds only ASCII values, so they are read back as plain quotes.
      cert = JSON.parse(certText.replace(/[“”„‟″]/g, '"'))
    } catch {
      return setCertLocal('JSON inválido')
    }
    if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) return setCertLocal('o certificado deve ser um objeto JSON')
    setCertLocal('')
    const r = await add.run(() => node.request('cert.add', { cert }))
    if (r.ok) {
      setCertText('')
      setDone('certificado gravado')
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
  const pkFail = (err) => {
    const code = err && err.code
    if (code === 'NO_PRF') return setNoPrf({ userId: err.userId })
    if (code === 'MISMATCH') return setMismatch({ legacy: err.legacy === true })
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
    }
    // Ends the recovery itself when the run cannot start (no identity, a run
    // already active); every Identidade then reads again.
    await passkey.recover()
  }

  // The handle's unlock/complete is called synchronously in the click
  // handler: the WebAuthn ceremony needs this click's user activation, so
  // nothing is awaited before it.
  const ceremony = (call) => {
    if (!pkStart()) return
    passkey.beginRecovery()
    let pending
    try { pending = call() } catch (err) { pending = Promise.reject(err) }
    Promise.resolve(pending)
      .then(async (r) => {
        if (r && r.pending === true) {
          passkey.endRecovery()
          setAwaitingComplete(true)
          return
        }
        setAwaitingComplete(false)
        setMismatch(null)
        setNoPrf(null)
        await afterUnlock()
      }, (err) => {
        passkey.endRecovery()
        pkFail(err)
      })
      .finally(pkEnd)
  }

  const doUnlock = () => ceremony(() => passkey.unlock({}))
  const doRegister = () => ceremony(() => passkey.unlock({ register: true }))
  const doComplete = () => ceremony(() => passkey.complete())

  const onCreatePress = () => {
    if (pkStatus !== null && pkStatus.exists && !confirmCreate) return setConfirmCreate(true)
    doRegister()
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
      setPkError('não foi possível apagar a fila de saída deste aparelho')
      return pkEnd()
    }
    passkey.reset().then(() => {
      setMismatch(null)
      setAwaitingComplete(false)
      setPkNote('O diário antigo foi apagado deste navegador. Entre com a passkey para recomeçar.')
    }, pkFail).finally(pkEnd)
  }

  let entrar = null
  if (passkey !== null && locked) {
    const blocked = noPrf !== null || (pkStatus !== null && (pkStatus.webauthn === false || pkStatus.prf === 'no' || !!pkStatus.rpIdError))
    // A diary of an older version is known before any ceremony.
    const shownMismatch = mismatch || (pkStatus !== null && pkStatus.legacy ? { legacy: true } : null)
    if (pkStatus === null) {
      entrar = passkey.error
        ? (
          <Card>
            <ErrorText>{passkey.error}</ErrorText>
            <Btn label='tentar de novo' onPress={() => passkey.refresh()} />
          </Card>
          )
        : <Soft>carregando…</Soft>
    } else if (pkStatus.rpIdError) {
      // The address cannot carry a passkey (an IP): the page must be opened
      // by its domain name (localhost in development).
      entrar = <Card><Notice>{displayText(pkStatus.rpIdError)}</Notice></Card>
    } else if (blocked) {
      const stale = noPrf !== null ? staleText(noPrf.userId) : ''
      entrar = (
        <Card>
          <Notice>{NO_PRF_TEXT}</Notice>
          {stale ? <Notice>{stale}</Notice> : null}
        </Card>
      )
    } else {
      // The welcome. The first ceremony leads: 'Criar passkey' for a browser
      // with no passkey known, 'Entrar com a passkey' otherwise; the other is
      // secondary. Same handlers as before (doUnlock, onCreatePress, doRegister,
      // doComplete): only the order and the labels changed.
      const createFirst = !pkStatus.passkeyKnown && !awaitingComplete
      const entrarBtn = (
        <Btn
          label='Entrar com a passkey'
          secondary={awaitingComplete || createFirst}
          onPress={doUnlock}
          pending={pkPending && !awaitingComplete}
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
                <Btn label='criar mesmo assim' secondary onPress={doRegister} disabled={pkPending} />
                <Btn label='cancelar' secondary onPress={() => setConfirmCreate(false)} disabled={pkPending} />
              </Row>
            </>
            )
          : <Btn label='Criar passkey' onPress={onCreatePress} disabled={pkPending} />
      entrar = (
        <Card>
          <Text style={styles.brand}>Varanda</Text>
          <Body>{WELCOME_TEXT}</Body>
          <Soft>{ENTRAR_TEXT}</Soft>
          {shownMismatch
            ? (
              <>
                <Notice>{mismatchText(shownMismatch.legacy)}</Notice>
                {confirmReset
                  ? (
                    <>
                      <Notice>{RESET_TEXT}</Notice>
                      <Row>
                        <Btn label='apagar o diário e recomeçar' danger onPress={doReset} pending={pkPending} />
                        <Btn label='cancelar' secondary onPress={() => setConfirmReset(false)} disabled={pkPending} />
                      </Row>
                    </>
                    )
                  : <Btn label='recomeçar com esta passkey' danger onPress={() => setConfirmReset(true)} disabled={pkPending} />}
              </>
              )
            : null}
          {awaitingComplete
            ? (
              <>
                <Body>{PENDING_TEXT}</Body>
                <Btn label='concluir a criação da passkey' onPress={doComplete} pending={pkPending} />
              </>
              )
            : null}
          {createFirst ? criarBtn : null}
          {entrarBtn}
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
  const needsCert = info !== null && info.publicKey !== null && !info.memberCert
  // Hosted page with a passkey: the account link replaces the pasted
  // certificate. Native and varanda-serve keep CertificateStep / the field.
  const linkMode = node.hosted === true && withPasskey

  return frame('Identidade', (
    <>
      <ErrorText>{loadError}</ErrorText>
      <ErrorText>{withPasskey ? pkError : ''}</ErrorText>
      {recovering ? <Notice>sincronizando com o semeador…</Notice> : null}
      {info === null && !loadError ? <Soft>carregando…</Soft> : null}
      {info !== null && info.publicKey === null
        ? (
          <Card>
            <Body>Você ainda não tem identidade neste nó. A identidade é a chave do seu diário; crie uma para começar.</Body>
            <ErrorText>{create.error}</ErrorText>
            <Btn label='criar identidade' onPress={doCreate} pending={create.pending} />
          </Card>
          )
        : null}
      {/* The technical card stays in Ajustes › Identidade; the setup shows
          the key only where the certificate step needs it (below). */}
      {!setup && info !== null && info.publicKey !== null
        ? (
          <Card>
            <Label>sua chave pública</Label>
            <Mono>{displayText(info.publicKey)}</Mono>
            {identity ? <Label>associação</Label> : null}
            {identity ? <Mono>{displayText(identity.association)}</Mono> : null}
            <Body>{'certificado de membro: ' + (info.memberCert ? 'válido' : 'ausente')}</Body>
          </Card>
          )
        : null}
      {needsCert ? <Soft>Sem o certificado, o nó não publica nem sincroniza.</Soft> : null}
      {linkMode && info !== null && info.publicKey !== null
        ? (
          <LinkCard
            publicKey={info.publicKey}
            memberCert={info.memberCert === true}
            active={active}
            quiet={recovering || onceActive}
            setup={setup}
            onChanged={refresh}
          />
          )
        : null}
      {needsCert && withPasskey && !linkMode
        ? (
          <CertificateStep
            publicKey={info.publicKey}
            certText={certText}
            onCertText={setCertText}
            onSubmit={doCert}
            error={certLocal || add.error}
            pending={add.pending}
          />
          )
        : null}
      {needsCert && !withPasskey
        ? (
          <Card>
            {/* The setup hides the technical card: the association issues
                the certificate for this key, so it is shown here. */}
            {setup ? <Label>sua chave pública</Label> : null}
            {setup ? <Mono>{displayText(info.publicKey)}</Mono> : null}
            {setup ? <Soft>{KEY_NOTE}</Soft> : null}
            <Label>certificado de membro (JSON emitido pela associação)</Label>
            <Field value={certText} onChangeText={setCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
            <ErrorText>{certLocal || add.error}</ErrorText>
            <Btn label='gravar certificado' onPress={doCert} pending={add.pending} disabled={certText.trim() === ''} />
          </Card>
          )
        : null}
      <Notice>{done}</Notice>
      {!setup && info !== null && info.publicKey !== null ? <Soft>{'diários seguidos: ' + String(info.followCount)}</Soft> : null}
    </>
  ))
}

const styles = StyleSheet.create({
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
