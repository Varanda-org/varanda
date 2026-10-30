/* global document */

// Conta de pagamentos (Ajustes, hosted web only): the opt-in, the identity
// check at Hodle and the PIN. Every step comes from the service's status
// (walletStep), never from the URL. Each call is signed by the node over the
// exact op the service receives, and nothing that changes state is ever sent
// again on its own: an unknown outcome forces a status read before any button
// comes back. The PIN, the CPF, every KYC field, the chosen photos and the
// single-use liveness URL live only in this component and are cleared after
// each request, on leaving and on a member change (Ajustes keeps hidden
// screens mounted, so nothing is cleared by unmounting).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  kycHash, uploadDocument, walletCreate, walletKycDocument, walletKycSubmit,
  walletOptin, walletPolicy, walletStart, walletStatus
} from '../account'
import { HELP } from '../help'
import { TEXTS, cepDigits, cpfDigits, isBirthDate, isCep, isCpf, isPin, walletErrorText, walletStep } from '../wallet'
import { Body, Btn, Card, ErrorText, Field, Label, Notice, Page, Row, Soft, Spinner, UNCERTAIN, errorText } from '../ui'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { colors } from '../ui/theme'

const READ_EVERY_MS = 30 * 1000
const PHOTO_ACCEPT = 'image/jpeg,image/png'
const DOCUMENTS = Object.freeze([
  { type: 'ID', label: 'RG ou CIN', sides: 2 },
  { type: 'DRIVERS-LICENSE', label: 'CNH', sides: 2 },
  { type: 'PASSPORT', label: 'Passaporte', sides: 1 }
])
const ADULT_LABEL = 'Tenho 18 anos ou mais'
const TWO_SIDES_LABEL = 'O documento tem frente e verso'
const DOC_SENT_TEXT = 'Foto do documento enviada.'
const DOC_READY_TEXT = 'A Hodle já recebeu a foto do documento.'
const SELFIE_READY_TEXT = 'A Hodle já recebeu a selfie.'
const LINK_TEXT = 'Se a página não abriu, toque neste link:'
const PIN_RULE = 'A senha precisa ter 6 dígitos, sem números todos iguais nem em sequência, e as duas precisam ser iguais.'
const FORM_TEXTS = Object.freeze({
  fullName: 'Escreva seu nome completo.',
  cpf: 'Confira o CPF.',
  birth: 'Escreva a data de nascimento como DD/MM/AAAA.',
  email: 'Confira o e-mail.',
  cep: 'Confira o CEP (8 números).',
  uf: 'Escreva a sigla do estado, como SP.',
  city: 'Escreva a cidade.',
  street: 'Escreva o endereço com número.'
})
const APPROVED_TEXT = 'Verificação aprovada.'
const POLICY_FAILED_TEXT = 'Não deu para carregar a conta de pagamentos agora.'
const READY_TITLE = 'Conta aberta'
const READY_TEXT = 'Receber e enviar chegam na próxima versão.'
const EMPTY_FORM = Object.freeze({ fullName: '', cpf: '', birth: '', email: '', cep: '', uf: '', city: '', street: '' })
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UF_RE = /^[A-Za-z]{2}$/

// DD/MM/AAAA (as people write it) or AAAA-MM-DD -> AAAA-MM-DD, else ''.
function isoDate (s) {
  const t = typeof s === 'string' ? s.trim() : ''
  const br = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(t)
  if (br) return br[3] + '-' + br[2] + '-' + br[1]
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(t) ? t : ''
}

// isBirthDate also refuses a real date of someone under 18: asking again as
// of a far future instant tells the two apart.
const FAR_FUTURE = Date.UTC(2200, 0, 1)
const isRealDate = (iso) => isBirthDate(iso, FAR_FUTURE)

// A hidden <input type=file> for one photo, created per pick and removed when
// it ends (the same pattern as src/media/attach.web.js).
function pickPhoto () {
  if (typeof document !== 'object' || document === null) return Promise.resolve(null)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = PHOTO_ACCEPT
    input.style.display = 'none'
    input.setAttribute('aria-hidden', 'true')
    let settled = false
    const done = (file) => {
      if (settled) return
      settled = true
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      try { input.remove() } catch {}
      resolve(file)
    }
    const onChange = () => done((input.files && input.files[0]) || null)
    const onCancel = () => done(null)
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', onCancel)
    document.body.appendChild(input)
    input.click()
  })
}

function Check ({ label, checked, onToggle, disabled }) {
  return (
    <Pressable
      style={styles.check}
      accessibilityRole='checkbox'
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: !!disabled }}
      disabled={disabled}
      onPress={onToggle}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Icon name='ok' size={14} color='#ffffff' /> : null}
      </View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  )
}

// The kit's Field has no secure entry; the PIN must not show on screen.
function PinField ({ label, value, onChangeText, editable }) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(t) => onChangeText(t.replace(/\D/g, '').slice(0, 6))}
        secureTextEntry
        keyboardType='number-pad'
        inputMode='numeric'
        autoComplete='off'
        autoCorrect={false}
        maxLength={6}
        editable={editable}
        accessibilityLabel={label}
      />
    </View>
  )
}

// open: the screen is showing; active: open and the node ready (for calls).
// member: the unlocked public key; node: from useNode (signs wallet.sign).
export default function Carteira ({ open, active, member, node, onBack }) {
  const [policy, setPolicy] = useState(null)
  const [policyRead, setPolicyRead] = useState(false)
  // undefined: not read yet; null: no account; else the parsed status.
  const [account, setAccount] = useState(undefined)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  // An unknown outcome keeps every action off until a status read succeeds.
  const [mustRead, setMustRead] = useState(false)
  // A 404 on wallet-create: the operator has not opened wallets yet.
  const [createClosed, setCreateClosed] = useState(false)
  // 'Tentar de novo' after recusado or expirado: the service starts the new
  // attempt on the next document request.
  const [retry, setRetry] = useState(false)
  const [adult, setAdult] = useState(false)
  const [docType, setDocType] = useState('ID')
  const [twoSides, setTwoSides] = useState(true)
  const [front, setFront] = useState(null)
  const [back, setBack] = useState(null)
  const [docSent, setDocSent] = useState(false)
  const [livenessUrl, setLivenessUrl] = useState(null)
  const [opened, setOpened] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  // Bumped on every clear: an answer from before it is dropped.
  const genRef = useRef(0)

  const clearSecrets = useCallback(() => {
    setForm(EMPTY_FORM)
    setPin('')
    setPin2('')
    setFront(null)
    setBack(null)
    setLivenessUrl(null)
    setOpened(false)
  }, [])

  const forget = useCallback(() => {
    genRef.current++
    clearSecrets()
    setError('')
    setReadError('')
    setAdult(false)
    setDocSent(false)
    setRetry(false)
  }, [clearSecrets])

  // Read at call time: the node object changes on every sync event, and a
  // callback depending on it would re-run the load (each read is rate
  // limited by the service).
  const memberRef = useRef(member)
  const nodeRef = useRef(node)
  memberRef.current = member
  nodeRef.current = node

  const signed = useCallback(async (action, op, fn) => {
    const who = memberRef.current
    const { nonce } = await walletStart({ member: who, action })
    const { signature } = await nodeRef.current.request('wallet.sign', { action, nonce, op })
    return fn({ member: who, nonce, signature, op })
  }, [])

  // Only the newest read applies: a slow poll answer must not overwrite a
  // newer state that a tap already read.
  const readSeqRef = useRef(0)
  const readStatus = useCallback(async () => {
    const gen = genRef.current
    const seq = ++readSeqRef.current
    const { account: a } = await signed('status', {}, walletStatus)
    if (gen !== genRef.current || seq !== readSeqRef.current) return false
    setAccount(a)
    return true
  }, [signed])

  const load = useCallback(async () => {
    if (typeof memberRef.current !== 'string') return
    const gen = genRef.current
    setReadError('')
    const p = await walletPolicy()
    if (gen !== genRef.current) return
    setPolicyRead(true)
    // walletPolicy answers null only when the read failed: the last known
    // policy stays, and the screen says so instead of going blank.
    if (p === null) {
      setReadError(POLICY_FAILED_TEXT)
      return
    }
    setPolicy(p)
    if (p.available !== true) return
    try {
      if (await readStatus()) setMustRead(false)
    } catch (err) {
      if (gen === genRef.current) setReadError(walletErrorText(err) || errorText(err))
    }
  }, [readStatus])

  // Another member's state never shows, even for a moment. Declared before
  // the load so that, on mount and on a change, it runs first.
  useEffect(() => {
    forget()
    setAccount(undefined)
    setPolicy(null)
    setPolicyRead(false)
    setMustRead(false)
    setCreateClosed(false)
  }, [member, forget])

  // Leaving the screen (or the node going away) clears every typed secret.
  useEffect(() => {
    if (!active) forget()
  }, [active, forget])

  // `load` is stable, so this runs only on open, active and member changes.
  useEffect(() => {
    if (active) load()
  }, [active, member, load])

  // One action at a time. A failure shows its text; an unknown outcome also
  // reads the status before anything can be tapped again. `reread`: the
  // service may have recorded a new state even on a definite refusal (a
  // refused submit moves the attempt to recusado), so read it once.
  const run = async (fn, { reread = false } = {}) => {
    if (busyRef.current || typeof member !== 'string' || !node) return
    busyRef.current = true
    setBusy(true)
    setError('')
    const gen = genRef.current
    try {
      await fn(gen)
    } catch (err) {
      if (gen !== genRef.current) return
      if (err && err.uncertain === true) {
        setError(UNCERTAIN)
        setMustRead(true)
        try {
          if (await readStatus()) setMustRead(false)
        } catch {}
      } else if (err && err.code === 'aguardando-carteira') {
        setCreateClosed(true)
      } else {
        setError(walletErrorText(err) || errorText(err))
        if (reread) {
          try { await readStatus() } catch {}
        }
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const check = () => run(async (gen) => {
    const p = await walletPolicy()
    if (gen === genRef.current && p !== null) setPolicy(p)
    if (await readStatus()) {
      setMustRead(false)
      setCreateClosed(false)
    }
  })

  const optin = () => run(async (gen) => {
    if (!adult) return
    const out = await signed('optin', { adult: 1 }, walletOptin)
    if (gen !== genRef.current) return
    if (out.account !== undefined) setAccount(out.account)
    else await readStatus()
  })

  const pickFront = async () => { const f = await pickPhoto(); if (f) setFront(f) }
  const pickBack = async () => { const f = await pickPhoto(); if (f) setBack(f) }
  const chooseDoc = (d) => {
    setDocType(d.type)
    setTwoSides(d.sides === 2)
    setBack(null)
  }

  const sendDocument = () => run(async (gen) => {
    const sides = twoSides && docType !== 'PASSPORT'
    if (!front || (sides && !back)) {
      setError(sides ? 'Escolha a foto da frente e a do verso.' : 'Escolha a foto do documento.')
      return
    }
    const urls = await signed('kyc-document', { documentType: docType, isDoubleSided: sides ? 1 : 0 }, walletKycDocument)
    if (gen !== genRef.current) return
    await uploadDocument(urls.uploadUrlFront, front)
    if (sides) await uploadDocument(urls.uploadUrlBack, back)
    if (gen !== genRef.current) return
    setFront(null)
    setBack(null)
    setDocSent(true)
  }, { reread: true })

  const startSelfie = () => run(async (gen) => {
    const { livenessUrl: url } = await signed('kyc-document', { documentType: 'SELFIE-FROM-LIVENESS' }, walletKycDocument)
    if (gen !== genRef.current) return
    setOpened(false)
    setLivenessUrl(url)
  }, { reread: true })

  // Straight from the tap, with nothing awaited first, so the browser counts
  // it as the person's own action. Hodle's page has no return address and
  // cannot be framed, hence a new window and the 'Já terminei' button.
  const openLiveness = () => {
    if (typeof livenessUrl !== 'string') return
    try { globalThis.open(livenessUrl, '_blank', 'noopener') } catch {}
    // With noopener the browser never says whether the window opened, so the
    // link stays as the way out of a blocked popup.
    setOpened(true)
  }

  const finished = () => run(async () => {
    if (await readStatus()) setMustRead(false)
  })

  const submitKyc = () => run(async (gen) => {
    const f = form
    const dateOfBirth = isoDate(f.birth)
    const bad = [
      ['fullName', f.fullName.trim() !== ''],
      ['cpf', isCpf(f.cpf.trim())],
      ['birth', dateOfBirth !== '' && isRealDate(dateOfBirth)],
      ['email', EMAIL_RE.test(f.email.trim())],
      ['cep', isCep(f.cep.trim())],
      ['uf', UF_RE.test(f.uf.trim())],
      ['city', f.city.trim() !== ''],
      ['street', f.street.trim() !== '']
    ].find(([, ok]) => !ok)
    if (bad) {
      setError(FORM_TEXTS[bad[0]])
      return
    }
    if (!isBirthDate(dateOfBirth)) {
      setError(TEXTS.UNDER_18)
      return
    }
    const kyc = {
      fullName: f.fullName.trim(),
      dateOfBirth,
      taxIdNumber: cpfDigits(f.cpf.trim()),
      email: f.email.trim(),
      country: 'BR',
      state: f.uf.trim().toUpperCase(),
      city: f.city.trim(),
      zipCode: cepDigits(f.cep.trim()),
      streetAddress: f.street.trim()
    }
    // The form stays while start and sign run (the service has not seen the
    // data yet); once the submit itself was attempted, any outcome clears it.
    let sent = false
    try {
      const hash = await kycHash(kyc)
      const out = await signed('kyc-submit', { kycHash: hash }, (a) => {
        sent = true
        return walletKycSubmit({ ...a, kyc })
      })
      if (gen !== genRef.current) return
      if (out.account !== undefined) setAccount(out.account)
      else await readStatus()
    } finally {
      if (sent) setForm(EMPTY_FORM)
    }
  }, { reread: true })

  const createWallet = () => run(async (gen) => {
    try {
      if (!isPin(pin) || pin !== pin2) {
        setError(PIN_RULE)
        return
      }
      const chosen = pin
      setPin('')
      setPin2('')
      await signed('wallet-create', {}, (a) => walletCreate({ ...a, pin: chosen }))
      if (gen !== genRef.current) return
      await readStatus()
    } finally {
      setPin('')
      setPin2('')
    }
  })

  const tryAgain = () => {
    setError('')
    setDocSent(false)
    clearSecrets()
    setRetry(true)
  }

  const leave = () => {
    forget()
    if (typeof onBack === 'function') onBack()
  }

  const serverStep = walletStep({ policy, account })
  const step = createClosed && serverStep === 'pin'
    ? 'aguardando-carteira'
    : (retry && (serverStep === 'recusado' || serverStep === 'expirado') ? 'documentos' : serverStep)

  // A new attempt is under way once the service reports documentos again.
  useEffect(() => {
    if (retry && serverStep !== 'recusado' && serverStep !== 'expirado') setRetry(false)
  }, [retry, serverStep])

  // While the check is in review, the status is read again every 30 s.
  useEffect(() => {
    if (!active || step !== 'aguardando') return
    const timer = setInterval(() => {
      if (busyRef.current) return
      readStatus().catch(() => {})
    }, READ_EVERY_MS)
    return () => clearInterval(timer)
  }, [active, step, readStatus])

  if (!policyRead) return open ? <Page><Soft>carregando…</Soft></Page> : null
  // Blank only when the service actually said the account is off; a failed
  // first read shows its error and a retry instead.
  if (step === 'off' && policy !== null) return null

  const off = busy || mustRead
  const set = (key) => (text) => setForm((f) => ({ ...f, [key]: text }))
  const sides = twoSides && docType !== 'PASSPORT'
  // During a retry the readiness still describes the refused attempt.
  const docReady = !retry && !!account && account.documentReady === true
  const selfieReady = !retry && !!account && account.selfieReady === true
  let body = null

  if (step === 'loading') {
    body = readError ? null : <Soft>carregando…</Soft>
  } else if (step === 'explicar') {
    body = (
      <>
        <Body>{TEXTS.OPTIN_WHAT}</Body>
        <Body>{TEXTS.OPTIN_KYC}</Body>
        <Soft>{TEXTS.OPTIN_DATA}</Soft>
        <Notice>{TEXTS.OPTIN_PERMANENT}</Notice>
        <Soft>{TEXTS.OPTIN_MONEY}</Soft>
        <HelpNote doc={HELP.carteira}><Soft>{TEXTS.OPTIN_FEES}</Soft></HelpNote>
        <Check label={ADULT_LABEL} checked={adult} onToggle={() => setAdult((v) => !v)} disabled={off} />
        <Row>
          <Btn label={TEXTS.OPTIN_START} onPress={optin} pending={busy} disabled={off || !adult} />
          <Btn label={TEXTS.OPTIN_SKIP} secondary onPress={leave} disabled={busy} />
        </Row>
      </>
    )
  } else if (step === 'documentos') {
    body = (
      <>
        {docReady || docSent
          ? <Soft>{docReady ? DOC_READY_TEXT : DOC_SENT_TEXT}</Soft>
          : (
            <Card>
              <Label>Documento com foto</Label>
              <Row>
                {DOCUMENTS.map((d) => (
                  <Btn key={d.type} label={d.label} secondary={docType !== d.type} onPress={() => chooseDoc(d)} disabled={off} />
                ))}
              </Row>
              {docType !== 'PASSPORT'
                ? <Check label={TWO_SIDES_LABEL} checked={twoSides} onToggle={() => { setTwoSides((v) => !v); setBack(null) }} disabled={off} />
                : null}
              <Soft>Fotos em JPG ou PNG, nítidas e sem reflexo.</Soft>
              <Row>
                <Btn label={front ? 'Frente escolhida' : (sides ? 'Escolher foto da frente' : 'Escolher foto')} secondary onPress={pickFront} disabled={off} />
                {sides ? <Btn label={back ? 'Verso escolhido' : 'Escolher foto do verso'} secondary onPress={pickBack} disabled={off} /> : null}
              </Row>
              <Btn label='Enviar documento' onPress={sendDocument} pending={busy} disabled={off || !front || (sides && !back)} />
            </Card>
            )}
        {docReady || docSent
          ? (
            <Card>
              {selfieReady
                ? <Soft>{SELFIE_READY_TEXT}</Soft>
                : (
                  <>
                    <Body>{TEXTS.LIVENESS_OPEN}</Body>
                    {livenessUrl === null
                      ? <Btn label='Selfie com prova de vida' onPress={startSelfie} pending={busy} disabled={off} />
                      : <Btn label='Abrir a página da selfie' onPress={openLiveness} disabled={off} />}
                    {livenessUrl !== null && opened
                      ? (
                        <>
                          <Soft>{LINK_TEXT}</Soft>
                          <Text
                            style={styles.link}
                            href={livenessUrl}
                            hrefAttrs={{ target: '_blank', rel: 'noopener noreferrer' }}
                            selectable
                          >
                            {livenessUrl}
                          </Text>
                        </>
                        )
                      : null}
                  </>
                  )}
              <Btn label='Já terminei, conferir' secondary onPress={finished} disabled={off} />
            </Card>
            )
          : null}
      </>
    )
  } else if (step === 'dados') {
    body = (
      <>
        <Soft>{DOC_READY_TEXT} {SELFIE_READY_TEXT}</Soft>
        <Body>Agora preencha seus dados, iguais aos do documento.</Body>
        <Field label='Nome completo' value={form.fullName} onChangeText={set('fullName')} maxLength={200} editable={!off} />
        <Field label='CPF' value={form.cpf} onChangeText={set('cpf')} maxLength={14} editable={!off} mono />
        <Field label='Data de nascimento (DD/MM/AAAA)' value={form.birth} onChangeText={set('birth')} maxLength={10} editable={!off} mono />
        <Field label='E-mail' value={form.email} onChangeText={set('email')} maxLength={200} editable={!off} mono />
        <Field label='CEP' value={form.cep} onChangeText={set('cep')} maxLength={9} editable={!off} mono />
        <Field label='Estado (sigla)' value={form.uf} onChangeText={set('uf')} maxLength={2} editable={!off} />
        <Field label='Cidade' value={form.city} onChangeText={set('city')} maxLength={200} editable={!off} />
        <Field label='Endereço (rua, número e complemento)' value={form.street} onChangeText={set('street')} maxLength={200} editable={!off} />
        <Row>
          <Btn label='Enviar para verificação' onPress={submitKyc} pending={busy} disabled={off} />
          <Btn label='Conferir' secondary onPress={check} disabled={busy} />
        </Row>
      </>
    )
  } else if (step === 'aguardando') {
    body = (
      <>
        <Body>{TEXTS.KYC_WAIT}</Body>
        {busy ? <Spinner /> : null}
        <Btn label='Conferir de novo' secondary onPress={check} disabled={busy} />
      </>
    )
  } else if (step === 'aguardando-carteira') {
    body = (
      <>
        <Body>{TEXTS.KYC_APPROVED}</Body>
        <Btn label='Conferir de novo' secondary onPress={check} disabled={busy} />
      </>
    )
  } else if (step === 'recusado' || step === 'expirado') {
    body = (
      <>
        <Body>{TEXTS.KYC_REJECTED}</Body>
        <Btn label='Tentar de novo' onPress={tryAgain} disabled={off} />
      </>
    )
  } else if (step === 'pin') {
    body = (
      <>
        <Body>{APPROVED_TEXT}</Body>
        <Soft>{TEXTS.PIN_HINT}</Soft>
        <PinField label='Senha de 6 dígitos (PIN)' value={pin} onChangeText={setPin} editable={!off} />
        <PinField label='Repita a senha' value={pin2} onChangeText={setPin2} editable={!off} />
        <Btn label='Criar carteira' onPress={createWallet} pending={busy} disabled={off} />
      </>
    )
  } else if (step === 'incerto') {
    body = (
      <>
        <Body>{TEXTS.UNCERTAIN_CREATE}</Body>
        <Btn label='Conferir' secondary onPress={check} disabled={busy} />
      </>
    )
  } else if (step === 'pronto') {
    body = (
      <Card>
        <Body style={styles.ready}>{READY_TITLE}</Body>
        <Soft>{READY_TEXT}</Soft>
      </Card>
    )
  }

  return (
    <Page>
      {body}
      <ErrorText>{readError || error}</ErrorText>
      {readError ? <Btn label='Tentar de novo' secondary onPress={load} disabled={busy} /> : null}
      {mustRead && !['incerto', 'aguardando', 'aguardando-carteira', 'dados'].includes(step)
        ? <Btn label='Conferir' secondary onPress={check} disabled={busy} />
        : null}
    </Page>
  )
}

const styles = StyleSheet.create({
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkText: { flex: 1, fontSize: 16, color: colors.ink },
  field: { gap: 4 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink
  },
  link: { fontSize: 14, lineHeight: 20, color: colors.accent, textDecorationLine: 'underline' },
  ready: { fontWeight: '700' }
})
