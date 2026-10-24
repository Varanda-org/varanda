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

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { Body, Btn, Card, ErrorText, Field, Label, Mono, Notice, Page, Row, Soft, Title, errorText, useAction } from '../ui'
import { colors, fonts } from '../ui/theme'

const ENTRAR_TEXT = 'A sua identidade é derivada da passkey. Guarde-a no Gerenciador de Senhas do Google para entrar com a mesma identidade no celular e no computador. A chave fica só na memória enquanto a página está aberta; perder a passkey perde a identidade. O sistema pode oferecer outro gerenciador (um iPhone pode usar as Chaves do iCloud): outra passkey é outra identidade.'
// A passkey created but unusable (no PRF) is named so it can be deleted.
function staleText (userId) {
  return typeof userId === 'string' && /^[0-9a-f]{6,}$/i.test(userId)
    ? 'Apague do gerenciador de senhas a passkey "Varanda ' + userId.slice(0, 6).toLowerCase() + '", que foi criada mas não serve.'
    : ''
}

const NO_PRF_TEXT = 'Este navegador ou gerenciador de passkeys não oferece o recurso necessário (PRF). Use o Chrome ou o Edge com o Gerenciador de Senhas do Google, ou o Safari 18 com as Chaves do iCloud.'
const EXISTS_TEXT = 'Já existe um diário neste navegador; outra passkey é outra identidade.'
const RESET_TEXT = 'A identidade antiga não pode ser reconstruída; ela precisa de um certificado novo.'
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

export default function Identidade ({ active, embedded = false, onInfo }) {
  const node = useNode()
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
  const doReset = () => {
    if (!pkStart()) return
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
      entrar = (
        <Card>
          <Body>{ENTRAR_TEXT}</Body>
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
          <Btn label='entrar com a passkey' secondary={awaitingComplete} onPress={doUnlock} pending={pkPending && !awaitingComplete} disabled={pkPending} />
          {!pkStatus.passkeyKnown && !awaitingComplete
            ? (confirmCreate
                ? (
                  <>
                    <Notice>{EXISTS_TEXT}</Notice>
                    <Row>
                      <Btn label='criar mesmo assim' secondary onPress={doRegister} disabled={pkPending} />
                      <Btn label='cancelar' secondary onPress={() => setConfirmCreate(false)} disabled={pkPending} />
                    </Row>
                  </>
                  )
                : <Btn label='criar passkey' secondary onPress={onCreatePress} disabled={pkPending} />)
            : null}
          <ErrorText>{pkError}</ErrorText>
          <Notice>{pkNote}</Notice>
        </Card>
      )
    }
  }

  if (entrar !== null) {
    return (
      <Page>
        {embedded ? null : <Title>Entrar</Title>}
        {entrar}
      </Page>
    )
  }

  const withPasskey = passkey !== null
  const needsCert = info !== null && info.publicKey !== null && !info.memberCert

  return (
    <Page>
      {embedded ? null : <Title>Identidade</Title>}
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
      {info !== null && info.publicKey !== null
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
      {needsCert && withPasskey
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
            <Label>certificado de membro (JSON emitido pela associação)</Label>
            <Field value={certText} onChangeText={setCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
            <ErrorText>{certLocal || add.error}</ErrorText>
            <Btn label='gravar certificado' onPress={doCert} pending={add.pending} disabled={certText.trim() === ''} />
          </Card>
          )
        : null}
      <Notice>{done}</Notice>
      {info !== null && info.publicKey !== null ? <Soft>{'diários seguidos: ' + String(info.followCount)}</Soft> : null}
    </Page>
  )
}

const styles = StyleSheet.create({
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
