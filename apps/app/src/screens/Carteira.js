/* global document */

// Conta de pagamentos (Ajustes, hosted web only): the opt-in, the identity
// check at Hodle and the PIN. Every step comes from the service's status
// (walletStep), never from the URL. Each call is signed by the node over the
// exact op the service receives, and nothing that changes state is ever sent
// again on its own: an unknown outcome forces a status read before any button
// comes back. The PIN, the CPF, every KYC field, the chosen photos and the
// single-use liveness URL live only in this component and are cleared after
// each request, on leaving and on a member change (Ajustes keeps hidden
// screens mounted, so nothing is cleared by unmounting). Once the wallet is
// open and the operator mode moves money (pix, completo), Dinheiro below
// shows Saldo, Receber, Pagar and Extrato under the same rules.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import {
  debitTerms, kycHash, uploadDocument, walletBalance, walletCreate, walletDeposit, walletKycDocument,
  walletKycSubmit, walletOpStatus, walletOptin, walletPayout, walletPayoutQuote, walletPolicy, walletPreview,
  walletStart, walletStatement, walletStatus
} from '../account'
import { HELP, carteiraHelp } from '../help'
import { copyText } from '../share'
import {
  DISPUTE_TEXTS, FEE_STATUS_TEXTS, MIN_DEPOSIT_CENTS, MIN_PAYOUT_CENTS, PAY_TEXTS, PIX_KEY_LABELS, RECEIVE_TEXTS,
  TEXTS, UNCERTAIN_MONEY, canonicalPixKey, cepDigits, cpfDigits, depositArrivalText, feeLines, formatBrl,
  isBirthDate, isCep, isCpf, isPin, maskPixKey, opStatusText, parseBrl, pixKeyCandidates, walletErrorText, walletStep
} from '../wallet'
import { Body, Btn, Card, ErrorText, Field, Label, Notice, Page, Row, Soft, Spinner, UNCERTAIN, errorText, useNow } from '../ui'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { colors, fonts } from '../ui/theme'

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
const MONEY_MODES = Object.freeze(['pix', 'completo'])
const POLL_EVERY_MS = 10 * 1000
const LATE_POLL_EVERY_MS = 30 * 1000
const DEPOSIT_LATE_MS = 24 * 60 * 60 * 1000
const DEPOSIT_DONE = Object.freeze(['concluido', 'devolvido'])
const DEPOSIT_LATE = Object.freeze(['expirado', 'falhou'])
// A payout whose request may still be accepted cannot be abandoned before
// the app's 100 s money timeout plus the service's legs have surely ended.
const LOCK_SETTLE_MS = 3 * 60 * 1000
const CONFIRM_MS = 5 * 60 * 1000
const FINAL_STATUSES = Object.freeze(['concluido', 'falhou', 'devolvido', 'expirado'])
const OPEN_FEES = Object.freeze(['enviada', 'incerta'])
const OPEN_STATUSES = Object.freeze(['enviado', 'incerto'])
const KEEP_CONFIRM_CODES = Object.freeze(['pin-invalido', 'limite-carteira', 'indisponivel'])
const BALANCE_NOTE = 'BRLA, vale 1 real; não rende juros.'
const KIND_LABELS = Object.freeze({
  deposit: 'Recebido por Pix',
  payout: 'Pago por Pix',
  transfer: 'Envio na Varanda',
  crypto: 'Envio para outra carteira',
  swap: 'Troca'
})
const KEY_CHOICE_LABELS = Object.freeze({ CPF: 'CPF', PHONE: 'Celular', CNPJ: 'CNPJ' })
const MONEY_TEXTS = Object.freeze({
  amount: 'Confira o valor.',
  minDeposit: 'O valor mínimo para receber é ' + formatBrl(MIN_DEPOSIT_CENTS) + '.',
  minPayout: 'O valor mínimo para pagar é ' + formatBrl(MIN_PAYOUT_CENTS) + '.',
  cpf: 'Confira o CPF.',
  key: 'Confira a chave Pix: CPF, CNPJ, e-mail, telefone com +55 ou chave aleatória.',
  noRandom: 'Este navegador não consegue gerar o pedido com segurança. Atualize o navegador.',
  depositUncertain: 'Não deu para confirmar se o código foi gerado. Toque em Gerar código Pix de novo: o mesmo pedido nunca cria uma segunda cobrança, mas o código pode não aparecer de novo. Se você já pagou, o valor chega sozinho; se não, gere outro.',
  copied: 'Código copiado.',
  selected: 'Código selecionado. Copie pelo menu do aparelho.',
  copyFailed: 'Não deu para copiar. Toque e segure o código para copiar.',
  expired: 'Este código expirou.',
  confirmExpired: 'A conferência expirou. Toque em Conferir de novo.',
  previewRefused: 'Não dá para fazer este pagamento agora.',
  notFound: 'O extrato não mostra este pagamento: ele não chegou a ser registrado. Você pode tentar de novo com o mesmo pedido, sem risco de pagar duas vezes.',
  latePix: 'O código anterior ainda pode receber um Pix atrasado; não pague os dois.',
  inFlight: 'Um pagamento ainda está em andamento. Toque em Conferir para ver se ele foi confirmado.',
  settleWait: 'Este pagamento ainda pode ser aceito. Aguarde alguns minutos e confira de novo antes de desistir.',
  keyChoice: 'Este número pode ser mais de um tipo de chave (CPF, CNPJ ou celular). Escolha qual é antes de conferir.',
  otherCpf: 'Este CPF não é o mesmo do pagamento anterior. Digite o mesmo CPF para tentar de novo.',
  checking: 'O extrato mostra este pagamento. Conferindo a confirmação…',
  readFirst: 'Antes de outro pagamento, confira o extrato.',
  empty: 'Nenhuma operação nos últimos dias.'
})
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

// 16 random bytes as base64url (22 characters): the service turns it into
// the operation's external id, so the same tap always names the same charge.
function mintOpId () {
  const c = globalThis.crypto
  if (!c || typeof c.getRandomValues !== 'function') return null
  const bytes = c.getRandomValues(new Uint8Array(16))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// The service's externalIdFor (wallet-ops-store.js): lets the screen find an
// uncertain payout in the statement without asking the service to resend it.
async function payoutExternalId (member, opId) {
  const hex = await sha256Hex(member + ':payout:' + opId)
  return hex === null ? null : 'var-' + hex.slice(0, 32)
}

// Lowercase hex SHA-256, or null without WebCrypto. Also how the screen
// remembers which CPF an attempt used without keeping the number.
async function sha256Hex (text) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle || typeof subtle.digest !== 'function') return null
  try {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function timeOf (iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : null
}

function dateText (iso) {
  const t = timeOf(iso)
  if (t === null) return ''
  try {
    return new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ')
  }
}

// One candidate: that type. Two (an 11-digit number that is both a valid CPF
// and a mobile number): only the type the member picked, never a default.
function chosenKeyType (text, choice) {
  const candidates = pixKeyCandidates(text)
  if (candidates.length === 1) return candidates[0]
  return candidates.length > 1 && candidates.includes(choice) ? choice : null
}

const isFinal = (row) => !!row && FINAL_STATUSES.includes(row.status) && !(row.fee && OPEN_FEES.includes(row.fee.status))

// Its own clock, so only this line re-renders every second, and nothing
// ticks while the screen is hidden (Ajustes keeps it mounted).
function Countdown ({ until, label, onExpire }) {
  const now = useNow(1000)
  const left = Math.max(0, until - now)
  const gone = left === 0
  const fired = useRef(false)
  useEffect(() => {
    if (gone && !fired.current) {
      fired.current = true
      if (typeof onExpire === 'function') onExpire()
    }
  }, [gone, onExpire])
  const s = Math.ceil(left / 1000)
  const text = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
  return <Soft>{label} {text}</Soft>
}

function Line ({ label, value }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  )
}

function feeSentence (fee, prefix) {
  if (!fee || !Object.hasOwn(FEE_STATUS_TEXTS, fee.status)) return null
  const formatted = formatBrl(fee.cents)
  const amount = formatted !== null ? ' (' + formatted + ')' : ''
  return prefix + amount + ': ' + FEE_STATUS_TEXTS[fee.status]
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
  } else if (step === 'pronto' && policy && MONEY_MODES.includes(policy.mode)) {
    // Keyed by member: another member's balance, charge or form never shows.
    body = <Dinheiro key={member} active={active} policy={policy} member={member} signed={signed} />
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

// Saldo, Receber, Pagar and Extrato. Nothing here is sent twice on its own:
// a deposit or a payout whose outcome is unknown keeps its opId, and only a
// deliberate tap sends that same opId again, which the service answers with
// the stored outcome instead of a second charge or payout.
function Dinheiro ({ active, policy, member, signed }) {
  const [view, setView] = useState('saldo')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const genRef = useRef(0)
  const maxCents = Number.isSafeInteger(policy.maxCents) ? policy.maxCents : null

  // Saldo
  const [bal, setBal] = useState(null)

  // Receber
  const [recvAmount, setRecvAmount] = useState('')
  const [recvOther, setRecvOther] = useState(false)
  const [payerCpf, setPayerCpf] = useState('')
  const recvOpRef = useRef(null)
  // 'cents:payerHash' of the request recvOpRef names.
  const recvKeyRef = useRef(null)
  const [charge, setCharge] = useState(null)
  const [chargeGone, setChargeGone] = useState(false)
  const [depositUncertain, setDepositUncertain] = useState(false)
  const codeRef = useRef(null)

  // Pagar
  const [pixKey, setPixKey] = useState('')
  // The member's pick when the key reads as a mobile number and also as a
  // CPF or a CNPJ.
  const [keyChoice, setKeyChoice] = useState(null)
  const [payAmount, setPayAmount] = useState('')
  const [payOther, setPayOther] = useState(false)
  const [beneficiaryCpf, setBeneficiaryCpf] = useState('')
  const [quote, setQuote] = useState(null)
  const [preview, setPreview] = useState(null)
  const [confirmUntil, setConfirmUntil] = useState(0)
  const [payPin, setPayPin] = useState('')
  const payOpRef = useRef(null)
  // The exact op of the last payout sent (without the CPF), for a deliberate
  // 'Tentar de novo' under the same opId.
  const lastOpRef = useRef(null)
  const expectedRef = useRef(null)
  // SHA-256 of the beneficiary CPF of that payout, null for one's own.
  const payCpfHashRef = useRef(null)
  // form | confirm | incerto | result
  const [phase, setPhase] = useState('form')
  const [result, setResult] = useState(null)
  // Set by an unknown payout outcome; only a statement read clears it.
  const [mustStatement, setMustStatement] = useState(false)
  const [retryReady, setRetryReady] = useState(false)
  // The payout in flight or with an unknown outcome: { opId, externalId,
  // cents, sentAt, inFlight }. It outlives generation changes (leaving the
  // screen), blocks Conferir and Pagar, and only an op-status answer (or a
  // statement row confirmed by op-status) with a settled status releases it.
  const [payLock, setPayLockState] = useState(null)
  const payLockRef = useRef(null)
  const setPayLock = useCallback((v) => {
    payLockRef.current = v
    setPayLockState(v)
  }, [])
  const settleLock = useCallback((row) => {
    const l = payLockRef.current
    if (l && row && l.externalId === row.externalId && !OPEN_STATUSES.includes(row.status)) setPayLock(null)
  }, [setPayLock])

  // Extrato
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(null)

  const clearSecrets = useCallback(() => {
    setPayerCpf('')
    setBeneficiaryCpf('')
    setPayPin('')
  }, [])

  // A confirmation is only good with the PIN typed right after it, so it
  // goes when the PIN does.
  const dropConfirm = useCallback(() => {
    setQuote(null)
    setPreview(null)
    setConfirmUntil(0)
    setPhase((p) => (p === 'confirm' ? 'form' : p))
  }, [])

  useEffect(() => {
    if (!active) {
      genRef.current++
      clearSecrets()
      dropConfirm()
      setError('')
      setNote('')
    }
  }, [active, clearSecrets, dropConfirm])

  useEffect(() => () => { genRef.current++ }, [])

  const run = async (fn) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNote('')
    const gen = genRef.current
    try {
      await fn(gen)
    } catch (err) {
      if (gen === genRef.current) setError(walletErrorText(err) || errorText(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const go = (next) => {
    if (busyRef.current) return
    clearSecrets()
    dropConfirm()
    setError('')
    setNote('')
    setView(next)
  }

  const readBalance = () => run(async (gen) => {
    const b = await signed('balance', {}, walletBalance)
    if (gen === genRef.current) setBal(b)
  })

  useEffect(() => {
    if (active && view === 'saldo') readBalance()
    // Only on opening Saldo: readBalance changes every render.
  }, [active, view])

  // A new amount or payer is a new charge; the same amount and payer keep the
  // opId, so a repeated tap after an unknown outcome gets the same code back.
  // The payer is compared through a hash: the CPF itself is cleared after
  // every attempt.
  const generate = () => run(async (gen) => {
    const cents = parseBrl(recvAmount)
    if (cents === null) return setError(MONEY_TEXTS.amount)
    if (cents < MIN_DEPOSIT_CENTS) return setError(MONEY_TEXTS.minDeposit)
    if (maxCents !== null && cents > maxCents) return setError(PAY_TEXTS.cap(maxCents))
    const cpfText = payerCpf.trim()
    try {
      if (recvOther && !isCpf(cpfText)) return setError(MONEY_TEXTS.cpf)
      const payer = recvOther ? await sha256Hex(cpfDigits(cpfText)) : ''
      if (payer === null) return setError(MONEY_TEXTS.noRandom)
      const key = cents + ':' + payer
      if (recvKeyRef.current !== key) {
        recvOpRef.current = null
        setDepositUncertain(false)
      }
      if (recvOpRef.current === null) {
        recvOpRef.current = mintOpId()
        recvKeyRef.current = key
      }
      if (recvOpRef.current === null) return setError(MONEY_TEXTS.noRandom)
      const op = { opId: recvOpRef.current, cents }
      if (recvOther) op.payerCpf = cpfDigits(cpfText)
      let out
      try {
        out = await signed('deposit', op, walletDeposit)
      } catch (err) {
        if (gen !== genRef.current) return
        if (err && err.uncertain === true) {
          setDepositUncertain(true)
          return
        }
        // A definite refusal: the next tap is a new request.
        recvOpRef.current = null
        recvKeyRef.current = null
        throw err
      } finally {
        delete op.payerCpf
      }
      if (gen !== genRef.current) return
      setDepositUncertain(false)
      setChargeGone(false)
      setCharge({ ...out, cents, createdAt: Date.now() })
    } finally {
      setPayerCpf('')
    }
  })

  const newCharge = () => {
    setCharge(null)
    setChargeGone(false)
    setDepositUncertain(false)
    setRecvAmount('')
    setPayerCpf('')
    recvOpRef.current = null
    recvKeyRef.current = null
    setNote('')
  }

  const copyCode = async () => {
    const code = charge && charge.qrCode
    if (typeof code !== 'string') return
    if (await copyText(globalThis.navigator, code)) {
      setNote(MONEY_TEXTS.copied)
      return
    }
    // Without clipboard access, select the code so the system menu copies it.
    try {
      const node = codeRef.current
      const doc = globalThis.document
      if (!node || !doc || typeof globalThis.Node !== 'function' || !(node instanceof globalThis.Node)) throw new Error('no node')
      const range = doc.createRange()
      range.selectNodeContents(node)
      const sel = globalThis.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      setNote(MONEY_TEXTS.selected)
    } catch {
      setNote(MONEY_TEXTS.copyFailed)
    }
  }

  // The charge's state is read while Receber is showing: every 10 s while it
  // is open, then every 30 s for a day after an expirado or falhou, because
  // a late Pix is still honored (expirado -> pendente/concluido) and a failed
  // credit still settles (falhou -> concluido/devolvido). The read never
  // sends anything to the payer or the provider.
  const chargeId = charge && charge.externalId
  const chargeStatus = charge && charge.status
  const chargeAt = charge ? charge.createdAt : 0
  const chargeLate = DEPOSIT_LATE.includes(chargeStatus)
  const chargePolled = !!charge && !DEPOSIT_DONE.includes(chargeStatus) &&
    (!chargeLate || Date.now() - chargeAt < DEPOSIT_LATE_MS)
  const readCharge = useCallback(async (id) => {
    const row = await signed('op-status', { externalId: id }, walletOpStatus)
    setCharge((c) => (c && c.externalId === row.externalId ? { ...c, status: row.status } : c))
  }, [signed])
  useEffect(() => {
    if (!active || view !== 'receber' || !chargeId || !chargePolled) return
    const timer = setInterval(async () => {
      if (busyRef.current) return
      if (chargeLate && Date.now() - chargeAt >= DEPOSIT_LATE_MS) return
      const gen = genRef.current
      try {
        if (gen === genRef.current) await readCharge(chargeId)
      } catch {}
    }, chargeLate ? LATE_POLL_EVERY_MS : POLL_EVERY_MS)
    return () => clearInterval(timer)
  }, [active, view, chargeId, chargePolled, chargeLate, chargeAt, readCharge])

  const checkCharge = () => run(async () => {
    if (chargeId) await readCharge(chargeId)
  })

  // Any change to the payment drops the confirmation: a quote covers one
  // amount, key and beneficiary.
  const editPay = (setter) => (t) => {
    setter(t)
    dropConfirm()
  }

  // A new key needs a new answer to 'Esta chave é'.
  const editPixKey = (t) => {
    setPixKey(t)
    setKeyChoice(null)
    dropConfirm()
  }

  const resetPay = () => {
    setPhase('form')
    setResult(null)
    setQuote(null)
    setPreview(null)
    setConfirmUntil(0)
    setPixKey('')
    setKeyChoice(null)
    setPayAmount('')
    setPayOther(false)
    setRetryReady(false)
    clearSecrets()
    payOpRef.current = null
    lastOpRef.current = null
    expectedRef.current = null
    payCpfHashRef.current = null
    setError('')
    setNote('')
  }

  // One quote per tap on Conferir, never on its own: a quote may reserve a
  // payout at the provider that cannot be cancelled.
  const conferir = () => run(async (gen) => {
    if (mustStatement) return setError(MONEY_TEXTS.readFirst)
    if (payLockRef.current !== null) return setError(MONEY_TEXTS.inFlight)
    const type = chosenKeyType(pixKey, keyChoice)
    if (type === null) return setError(pixKeyCandidates(pixKey).length > 1 ? MONEY_TEXTS.keyChoice : MONEY_TEXTS.key)
    const cents = parseBrl(payAmount)
    if (cents === null) return setError(MONEY_TEXTS.amount)
    if (cents < MIN_PAYOUT_CENTS) return setError(MONEY_TEXTS.minPayout)
    if (maxCents !== null && cents > maxCents) return setError(PAY_TEXTS.cap(maxCents))
    const cpfText = beneficiaryCpf.trim()
    if (payOther && !isCpf(cpfText)) return setError(MONEY_TEXTS.cpf)
    if (payOpRef.current === null) payOpRef.current = mintOpId()
    if (payOpRef.current === null) return setError(MONEY_TEXTS.noRandom)
    const key = canonicalPixKey(pixKey, type)
    if (key === null) return setError(MONEY_TEXTS.key)
    const op = { cents, pixKey: key, pixKeyType: type }
    if (payOther) op.beneficiaryCpf = cpfDigits(cpfText)
    let q
    try {
      q = await signed('payout-quote', op, walletPayoutQuote)
    } finally {
      delete op.beneficiaryCpf
    }
    if (gen !== genRef.current) return
    const p = await signed('preview', { kind: 'payout', cents, quoteId: q.quoteId }, walletPreview)
    if (gen !== genRef.current) return
    if (p.ok !== true) return setError(walletErrorText({ code: p.reason }) || MONEY_TEXTS.previewRefused)
    if (feeLines(p) === null) return setError(MONEY_TEXTS.previewRefused)
    const expires = timeOf(q.expiresAt)
    const until = Math.min(Date.now() + CONFIRM_MS, expires === null ? Infinity : expires)
    setQuote({ ...q, cents, pixKey: key, pixKeyType: type })
    setPreview(p)
    setConfirmUntil(until)
    setPhase('confirm')
  })

  const enterUncertain = () => {
    setPhase('incerto')
    setMustStatement(true)
    setRetryReady(false)
    setQuote(null)
    setPreview(null)
  }

  // A definite refusal is final for its opId (the service records a wrong PIN
  // as a failure of that external id), so the next attempt always gets a
  // fresh one. A wrong PIN or a passing limit keeps the confirmation while
  // the quote is still valid; anything else goes back to the form. Returns
  // true when the confirmation stays: its card has no CPF field, so the
  // beneficiary CPF must stay too for the next Pagar.
  const refused = (err, retry) => {
    payOpRef.current = null
    const code = err && err.code
    setError(walletErrorText(err) || errorText(err))
    if (!retry && KEEP_CONFIRM_CODES.includes(code)) {
      payOpRef.current = mintOpId()
      return true
    }
    setQuote(null)
    setPreview(null)
    setConfirmUntil(0)
    setPhase('form')
    setRetryReady(false)
    setBeneficiaryCpf('')
    return false
  }

  // retry: the same op as the unknown attempt, under the same opId; the
  // service answers it with the stored outcome if it ever arrived. A payment
  // to someone else needs the same CPF again, checked against its hash.
  // The answer is applied even if the screen was left meanwhile (the
  // component stays mounted per member): dropping it could let a second
  // payout go out while the first is already pendente or concluido.
  const pay = (retry) => run(async () => {
    const chosen = payPin
    setPayPin('')
    let op = null
    // Set once the payout request is on its way: only then is the CPF spent,
    // unless the refusal keeps the confirmation (kept).
    let sent = false
    let kept = false
    try {
      if (!isPin(chosen)) return setError('Digite a senha de 6 dígitos (PIN) da carteira.')
      if (retry) {
        if (lastOpRef.current === null) return
        op = { ...lastOpRef.current }
        if (payCpfHashRef.current !== null) {
          const cpfText = beneficiaryCpf.trim()
          if (!isCpf(cpfText)) return setError(MONEY_TEXTS.cpf)
          if (await sha256Hex(cpfDigits(cpfText)) !== payCpfHashRef.current) return setError(MONEY_TEXTS.otherCpf)
          op.beneficiaryCpf = cpfDigits(cpfText)
        }
      } else {
        if (mustStatement) return setError(MONEY_TEXTS.readFirst)
        if (payLockRef.current !== null) return setError(MONEY_TEXTS.inFlight)
        if (quote === null || preview === null || Date.now() >= confirmUntil || payOpRef.current === null) {
          dropConfirm()
          return setError(MONEY_TEXTS.confirmExpired)
        }
        op = {
          opId: payOpRef.current,
          cents: quote.cents,
          quoteId: quote.quoteId,
          pixKey: quote.pixKey,
          pixKeyType: quote.pixKeyType,
          ...debitTerms(preview)
        }
        lastOpRef.current = { ...op }
        expectedRef.current = await payoutExternalId(member, op.opId)
        payCpfHashRef.current = null
        if (payOther) {
          op.beneficiaryCpf = cpfDigits(beneficiaryCpf.trim())
          payCpfHashRef.current = await sha256Hex(op.beneficiaryCpf)
        }
      }
      const lock = { opId: op.opId, externalId: expectedRef.current, cents: op.cents, sentAt: Date.now(), inFlight: true }
      setPayLock(lock)
      let out
      try {
        out = await signed('payout', op, (a) => {
          sent = true
          return walletPayout({ ...a, pin: chosen })
        })
      } catch (err) {
        if (err && err.uncertain === true) {
          setPayLock({ ...lock, inFlight: false })
          enterUncertain()
        } else {
          // A definite refusal: nothing was sent under this opId.
          setPayLock(null)
          kept = refused(err, retry)
        }
        return
      }
      payOpRef.current = null
      setQuote(null)
      setPreview(null)
      setRetryReady(false)
      // The payout answer is the service's own ledger row; an enviado or
      // incerto answer keeps the lock until op-status settles it.
      setPayLock({ ...lock, externalId: out.externalId, inFlight: false })
      settleLock(out)
      setResult({ ...out, confirmed: true })
      setPhase('result')
      if (out.status === 'incerto') setMustStatement(true)
    } finally {
      if (op !== null) delete op.beneficiaryCpf
      setPayPin('')
      if (sent && !kept) setBeneficiaryCpf('')
    }
  })

  // Reads the locked payout's own row. Only a settled status releases it.
  const checkLock = () => run(async () => {
    const l = payLockRef.current
    if (l === null) return
    if (l.externalId === null) return readStatementNow()
    const row = await signed('op-status', { externalId: l.externalId }, walletOpStatus)
    settleLock(row)
    setResult({ externalId: row.externalId, status: row.status, fee: row.fee, pendingFee: null, confirmed: true })
    setPhase('result')
    setMustStatement(false)
  })

  // 'Desistir' after a statement without the payout: allowed only once the
  // request can no longer be accepted.
  const giveUp = () => {
    const l = payLockRef.current
    if (l !== null && (l.inFlight || Date.now() - l.sentAt < LOCK_SETTLE_MS)) {
      setError(MONEY_TEXTS.settleWait)
      return
    }
    setPayLock(null)
    resetPay()
  }

  // The statement read an unknown payout requires before anything else.
  // Finding its row means it was registered, but the statement does not
  // settle the service's ledger: only op-status does, so the payment counts
  // as final only once op-status says so (polled every 10 s until then).
  const readStatement = (more) => run((gen) => statementBody(gen, more))
  const readStatementNow = () => statementBody(genRef.current, false)
  async function statementBody (gen, more) {
    const s = await signed('statement', more && cursor !== null ? { cursor } : {}, walletStatement)
    if (gen !== genRef.current) return
    setItems((prev) => (more && prev !== null ? [...prev, ...s.items] : s.items))
    setCursor(s.cursor)
    if (more) return
    setMustStatement(false)
    if (phase !== 'incerto') return
    const expected = expectedRef.current
    const hit = expected ? s.items.find((i) => i.externalId === expected) : undefined
    if (hit) {
      payOpRef.current = null
      setResult({ externalId: hit.externalId, status: hit.status, fee: hit.fee, pendingFee: null, confirmed: false })
      setPhase('result')
      setNote(MONEY_TEXTS.checking)
      let row
      try {
        row = await signed('op-status', { externalId: hit.externalId }, walletOpStatus)
      } catch {
        return
      }
      settleLock(row)
      if (gen !== genRef.current) return
      setNote('')
      setResult((r) => (r && r.externalId === row.externalId ? { ...r, status: row.status, fee: row.fee, confirmed: true } : r))
    } else {
      setRetryReady(true)
      setNote(MONEY_TEXTS.notFound)
    }
  }
  const checkStatement = () => readStatement(false)

  useEffect(() => {
    if (active && view === 'extrato') readStatement(false)
    // Only on opening Extrato: readStatement changes every render.
  }, [active, view])

  // Reads one unsettled row again (enviado or incerto); op-status is what
  // moves the service's ledger, and it never resends the operation.
  const checkItem = (externalId) => run(async (gen) => {
    const row = await signed('op-status', { externalId }, walletOpStatus)
    settleLock(row)
    if (gen !== genRef.current) return
    setItems((list) => (list === null
      ? list
      : list.map((i) => (i.externalId === row.externalId ? { ...i, status: row.status, fee: row.fee, dispute: row.dispute } : i))))
  })

  const resultId = result && result.externalId
  const resultOpen = phase === 'result' && !!result && !(result.confirmed === true && isFinal(result))
  useEffect(() => {
    if (!active || view !== 'pagar' || !resultId || !resultOpen) return
    const timer = setInterval(async () => {
      if (busyRef.current) return
      const gen = genRef.current
      try {
        const row = await signed('op-status', { externalId: resultId }, walletOpStatus)
        settleLock(row)
        if (gen !== genRef.current) return
        setResult((r) => (r && r.externalId === row.externalId ? { ...r, status: row.status, fee: row.fee, confirmed: true } : r))
      } catch {}
    }, POLL_EVERY_MS)
    return () => clearInterval(timer)
  }, [active, view, resultId, resultOpen, signed, settleLock])

  // Leaving the confirmation spends the PIN and the CPF typed for it.
  const leaveConfirm = useCallback(() => {
    dropConfirm()
    setPayPin('')
    setBeneficiaryCpf('')
  }, [dropConfirm])

  const onConfirmExpired = useCallback(() => {
    leaveConfirm()
    setError(MONEY_TEXTS.confirmExpired)
  }, [leaveConfirm])

  const off = busy || !active
  const locked = payLock !== null
  let content = null
  const lockNote = locked
    ? (
      <>
        <Notice>{MONEY_TEXTS.inFlight}</Notice>
        <Btn label='Conferir' secondary onPress={checkLock} pending={busy} disabled={off} />
      </>
      )
    : null

  if (view === 'pagar') {
    const candidates = pixKeyCandidates(pixKey)
    const keyType = chosenKeyType(pixKey, keyChoice)
    const keyMask = keyType !== null ? maskPixKey(pixKey, keyType) : ''
    const lines = preview !== null ? feeLines(preview) : null
    const reserved = preview !== null && Number.isSafeInteger(preview.reservedFeeCents) && preview.reservedFeeCents > 0
      ? formatBrl(preview.reservedFeeCents)
      : null
    const reservedText = reserved !== null ? 'Reservado para taxas pendentes: ' + reserved + ' (fica na sua conta até ser cobrado).' : null
    if (phase === 'form') {
      content = (
        <>
          <Body>Pagar por Pix</Body>
          <Soft>{PAY_TEXTS.BEFORE_PIN}</Soft>
          {maxCents !== null ? <Soft>{PAY_TEXTS.cap(maxCents)}</Soft> : null}
          <Field label='Chave Pix' value={pixKey} onChangeText={editPixKey} maxLength={120} editable={!off} mono />
          {candidates.length > 1
            ? (
              <>
                <Label>Esta chave é:</Label>
                <Row>
                  {candidates.map((c) => (
                    <Btn
                      key={c}
                      label={KEY_CHOICE_LABELS[c] || PIX_KEY_LABELS[c]}
                      secondary={keyChoice !== c}
                      onPress={() => { setKeyChoice(c); dropConfirm() }}
                      disabled={off}
                    />
                  ))}
                </Row>
              </>
              )
            : null}
          {keyType !== null
            ? <Soft>{PIX_KEY_LABELS[keyType]}: {keyMask}</Soft>
            : (candidates.length === 0 && pixKey.trim() !== '' ? <Soft>{MONEY_TEXTS.key}</Soft> : null)}
          <Field label='Valor (R$)' value={payAmount} onChangeText={editPay(setPayAmount)} maxLength={16} editable={!off} mono />
          <Check
            label='Pagar a outra pessoa'
            checked={payOther}
            onToggle={() => { editPay(setPayOther)(!payOther); setBeneficiaryCpf('') }}
            disabled={off}
          />
          {payOther
            ? (
              <>
                <Soft>{PAY_TEXTS.OTHER_CPF}</Soft>
                <Field label='CPF de quem recebe' value={beneficiaryCpf} onChangeText={editPay(setBeneficiaryCpf)} maxLength={14} editable={!off} mono />
              </>
              )
            : null}
          {mustStatement
            ? (
              <>
                <Notice>{MONEY_TEXTS.readFirst}</Notice>
                <Btn label='Conferir o extrato' secondary onPress={checkStatement} pending={busy} disabled={off} />
              </>
              )
            : null}
          {lockNote}
          <Btn label='Conferir' onPress={conferir} pending={busy} disabled={off || mustStatement || locked} />
        </>
      )
    } else if (phase === 'confirm' && quote !== null && lines !== null) {
      content = (
        <Card>
          <Label>Quem recebe</Label>
          <Body>{displayText(quote.ownerName) || 'Nome não informado pelo banco'}</Body>
          {quote.taxIdMasked ? <Soft>Documento: {displayText(quote.taxIdMasked)}</Soft> : null}
          {quote.bankName ? <Soft>Banco: {displayText(quote.bankName)}</Soft> : null}
          <Soft>{PIX_KEY_LABELS[quote.pixKeyType]}: {maskPixKey(quote.pixKey, quote.pixKeyType)}</Soft>
          {lines.map((l) => <Line key={l.label} label={l.label} value={l.value} />)}
          {reservedText ? <Soft>{reservedText}</Soft> : null}
          <Countdown key={confirmUntil} until={confirmUntil} label='A conferência vale por mais' onExpire={onConfirmExpired} />
          <PinField label='Senha de 6 dígitos (PIN)' value={payPin} onChangeText={setPayPin} editable={!off} />
          {lockNote}
          <Row>
            <Btn label={'Pagar ' + formatBrl(preview.totalDebitCents)} onPress={() => pay(false)} pending={busy} disabled={off || mustStatement || locked} />
            <Btn label='Alterar' secondary onPress={leaveConfirm} disabled={busy} />
          </Row>
        </Card>
      )
    } else if (phase === 'incerto') {
      content = (
        <Card>
          <Notice>{UNCERTAIN_MONEY}</Notice>
          {locked && payLock.externalId !== null
            ? <Btn label='Conferir' secondary onPress={checkLock} pending={busy} disabled={off} />
            : null}
          {!retryReady
            ? <Btn label='Conferir o extrato' onPress={checkStatement} pending={busy} disabled={off} />
            : (
              <>
                {payCpfHashRef.current !== null
                  ? <Field label='CPF de quem recebe (o mesmo de antes)' value={beneficiaryCpf} onChangeText={setBeneficiaryCpf} maxLength={14} editable={!off} mono />
                  : null}
                <PinField label='Senha de 6 dígitos (PIN)' value={payPin} onChangeText={setPayPin} editable={!off} />
                <Row>
                  <Btn label='Tentar de novo' onPress={() => pay(true)} pending={busy} disabled={off} />
                  <Btn label='Desistir' secondary onPress={giveUp} disabled={busy} />
                </Row>
              </>
              )}
        </Card>
      )
    } else if (phase === 'result' && result !== null) {
      const feeText = feeSentence(result.fee, 'Taxa da Varanda')
      const pendingText = feeSentence(result.pendingFee, 'Taxa pendente anterior')
      content = (
        <Card>
          <Label>Pagamento</Label>
          <Body>{opStatusText('payout', result.status)}</Body>
          {feeText ? <Soft>{feeText}</Soft> : null}
          {pendingText ? <Soft>{pendingText}</Soft> : null}
          {resultOpen ? <Spinner /> : null}
          {mustStatement ? <Notice>{MONEY_TEXTS.readFirst}</Notice> : null}
          {lockNote}
          <Row>
            {mustStatement
              ? <Btn label='Conferir o extrato' onPress={checkStatement} pending={busy} disabled={off} />
              : <Btn label='Novo pagamento' onPress={resetPay} disabled={off || locked} />}
            <Btn label='Ver extrato' secondary onPress={() => go('extrato')} disabled={busy} />
          </Row>
        </Card>
      )
    }
  }

  if (view === 'receber') {
    const final = !!charge && FINAL_STATUSES.includes(charge.status)
    const showCode = !!charge && typeof charge.qrCode === 'string' && !final && !chargeGone
    // A repeated request can come back without its code: offer a new charge
    // rather than leave the member with nothing to pay for 15 minutes.
    const noCode = !!charge && typeof charge.qrCode !== 'string' && charge.status !== 'concluido'
    const until = charge ? timeOf(charge.expiresAt) : null
    const arrival = charge && charge.hodleFeeCents !== null && charge.netCents !== null
      ? depositArrivalText(charge.hodleFeeCents, charge.netCents)
      : null
    content = charge === null
      ? (
        <>
          <Body>Receber por Pix</Body>
          <Soft>{RECEIVE_TEXTS.ONE_CHARGE}</Soft>
          <Soft>{RECEIVE_TEXTS.NO_VARANDA_FEE}</Soft>
          {maxCents !== null ? <Soft>{PAY_TEXTS.cap(maxCents)}</Soft> : null}
          <Field label='Valor (R$)' value={recvAmount} onChangeText={setRecvAmount} maxLength={16} editable={!off} mono />
          <Soft>{RECEIVE_TEXTS.OWN_CPF}</Soft>
          <Check
            label='Quem vai pagar não sou eu'
            checked={recvOther}
            onToggle={() => { setRecvOther(!recvOther); setPayerCpf('') }}
            disabled={off}
          />
          {recvOther
            ? (
              <>
                <Soft>{RECEIVE_TEXTS.OTHER_CPF}</Soft>
                <Field label='CPF de quem vai pagar' value={payerCpf} onChangeText={setPayerCpf} maxLength={14} editable={!off} mono />
              </>
              )
            : null}
          {depositUncertain ? <Notice>{MONEY_TEXTS.depositUncertain}</Notice> : null}
          <Btn label='Gerar código Pix' onPress={generate} pending={busy} disabled={off} />
        </>
        )
      : (
        <Card>
          <Label>Receber {formatBrl(charge.cents)}</Label>
          {showCode
            ? (
              <>
                <Soft>Pix copia e cola</Soft>
                <Text ref={codeRef} style={styles.code} selectable>{charge.qrCode}</Text>
                <Btn label='Copiar' onPress={copyCode} disabled={!active} />
                {arrival ? <Body>{arrival}</Body> : null}
                {until !== null
                  ? <Countdown key={chargeId} until={until} label='O código vale por mais' onExpire={() => setChargeGone(true)} />
                  : null}
                <Soft>{RECEIVE_TEXTS.EXPIRY}</Soft>
              </>
              )
            : null}
          {chargeGone && !final ? <Notice>{MONEY_TEXTS.expired}</Notice> : null}
          {!showCode && charge.status !== null && (final || charge.qrCode === null)
            ? <Body>{opStatusText('deposit', charge.status)}</Body>
            : null}
          {DEPOSIT_LATE.includes(charge.status) && chargeId
            ? <Btn label='Conferir' secondary onPress={checkCharge} pending={busy} disabled={off} />
            : null}
          {(chargeGone || final) && !DEPOSIT_DONE.includes(charge.status)
            ? <Soft>{MONEY_TEXTS.latePix}</Soft>
            : null}
          {chargeGone || final || noCode
            ? <Btn label='Gerar outro' secondary onPress={newCharge} disabled={off} />
            : null}
        </Card>
        )
  }

  if (view === 'saldo') {
    content = (
      <>
        <Card>
          <Label>Saldo</Label>
          {bal === null
            ? (busy ? <Spinner /> : <Soft>Saldo ainda não carregado.</Soft>)
            : <Text style={styles.balance}>{formatBrl(bal.cents)}</Text>}
          <Soft>{BALANCE_NOTE}</Soft>
          {bal !== null && bal.pendingFeeCents > 0
            ? (
              <>
                <Notice>Taxas pendentes: {formatBrl(bal.pendingFeeCents)}</Notice>
                <Soft>{FEE_STATUS_TEXTS.pendente}</Soft>
              </>
              )
            : null}
          {mustStatement ? <Notice>{MONEY_TEXTS.readFirst}</Notice> : null}
          {payLock !== null ? <Notice>{MONEY_TEXTS.inFlight}</Notice> : null}
        </Card>
        <Row>
          <Btn label='Receber' onPress={() => go('receber')} disabled={off} />
          <Btn label='Pagar' onPress={() => go('pagar')} disabled={off} />
          <Btn label='Extrato' secondary onPress={() => go('extrato')} disabled={off} />
        </Row>
        <Row>
          <Btn label='Atualizar' secondary onPress={readBalance} pending={busy} disabled={off} />
        </Row>
        <HelpNote doc={carteiraHelp(policy)}><Soft>Taxas, limites e o que acontece quando algo não se confirma.</Soft></HelpNote>
      </>
    )
  }

  if (view === 'extrato') {
    content = (
      <>
        <Body>Extrato</Body>
        {items === null
          ? (busy ? <Spinner /> : null)
          : (items.length === 0 ? <Soft>{MONEY_TEXTS.empty}</Soft> : null)}
        {(items || []).map((item, i) => {
          const incoming = item.direction === 'in' || item.kind === 'deposit'
          const feeText = feeSentence(item.fee, 'Taxa da Varanda')
          const amountText = formatBrl(item.cents)
          return (
            <Card key={item.externalId || 'i' + i}>
              <Line label={KIND_LABELS[item.kind]} value={amountText === null ? '' : (incoming ? '+ ' : '- ') + amountText} />
              <Soft>{opStatusText(item.kind, item.status)}</Soft>
              {item.dispute !== null ? <Soft>{DISPUTE_TEXTS[item.dispute]}</Soft> : null}
              {item.to !== null ? <Soft>Para: {displayText(item.to)}</Soft> : null}
              {item.hodleFeeCents !== null && item.hodleFeeCents > 0
                ? <Soft>Taxa do parceiro: {formatBrl(item.hodleFeeCents)}</Soft>
                : null}
              {feeText ? <Soft>{feeText}</Soft> : null}
              {item.at !== null ? <Soft>{dateText(item.at)}</Soft> : null}
              {OPEN_STATUSES.includes(item.status) && item.externalId !== null
                ? <Btn label='Conferir' secondary onPress={() => checkItem(item.externalId)} disabled={off} />
                : null}
            </Card>
          )
        })}
        <Row>
          <Btn label='Atualizar' secondary onPress={() => readStatement(false)} pending={busy} disabled={off} />
          {cursor !== null && items !== null
            ? <Btn label='Ver mais' secondary onPress={() => readStatement(true)} disabled={off} />
            : null}
        </Row>
      </>
    )
  }

  return (
    <>
      {view !== 'saldo'
        ? <Btn label='Voltar ao saldo' secondary onPress={() => go('saldo')} disabled={busy} />
        : null}
      {content}
      <ErrorText>{error}</ErrorText>
      {note ? <Soft>{note}</Soft> : null}
    </>
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
  ready: { fontWeight: '700' },
  balance: { fontSize: 32, fontWeight: '800', color: colors.ink },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  lineLabel: { fontSize: 15, color: colors.soft, flexShrink: 1 },
  lineValue: { fontSize: 15, fontWeight: '600', color: colors.ink, textAlign: 'right' },
  code: { fontSize: 13, lineHeight: 19, color: colors.ink, fontFamily: fonts.mono }
})
