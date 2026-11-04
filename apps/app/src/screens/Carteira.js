// Conta de pagamentos (Ajustes, hosted node: the site and the installed
// app): the opt-in, the identity check at Hodle and the PIN. Every step comes from the service's status
// (walletStep), never from the URL. Each call is signed by the node over the
// exact op the service receives, and nothing that changes state is ever sent
// again on its own: an unknown outcome forces a status read before any button
// comes back. The PIN, the CPF, every KYC field, the chosen photos and the
// single-use liveness URL live only in this component and are cleared after
// each request, on leaving and on a member change (Ajustes keeps hidden
// screens mounted, so nothing is cleared by unmounting). Once the wallet is
// open and the operator mode moves money (pix, completo), Dinheiro below
// shows Saldo, Receber, Pagar and Extrato under the same rules, plus Enviar
// and Cripto when the mode is completo.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import {
  debitTerms, hasAction, kycHash, uploadDocument, walletBalance, walletCreate, walletCryptoPreview, walletDeposit,
  walletKycDocument, walletKycSubmit, walletLivenessRetry, walletLivenessValidate, walletOpStatus, walletOptin,
  walletPayout, walletPayoutQuote, walletPolicy, walletPreview, walletSendCrypto, walletStart, walletStatement,
  walletStatus, walletSwap, walletSwapQuote, walletTransfer
} from '../account'
import { HELP, carteiraHelp } from '../help'
import { isAvailable, LivenessCapture } from '../livenessCapture'
import { base64url } from '../appLinkSecret'
import { openExternal, linkProps } from '../openExternal'
import { pickPhoto } from '../pickPhoto'
import { selectContents } from '../selectText'
import { hasValidChecksum } from '../evmAddress'
import { sha256Hex } from '../sha256'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { uploadDeps } from '../uploadFetch'
import {
  CRYPTO_TEXTS, DISPUTE_TEXTS, FEE_STATUS_TEXTS, MIN_DEPOSIT_CENTS, MIN_PAYOUT_CENTS, PAY_TEXTS, PIX_KEY_LABELS,
  RECEIVE_TEXTS, TEXTS, TRANSFER_TEXTS, UNCERTAIN_MONEY, USDC_TEXTS, canonicalPixKey, cepDigits, cpfDigits,
  depositArrivalText, feeLines, feeLinesFor, formatBrl, formatUsdc, isBirthDate, isCep, isCpf, isPin, maskPixKey,
  normalizeAddress, opStatusText, parseBrl, parseUsdc, pixKeyCandidates, swapQuoteLines, targetKind, usdcFeeLines,
  walletErrorText, walletStep
} from '../wallet'
import { Body, Btn, Card, ErrorText, Field, Label, Notice, Page, Row, Soft, Spinner, UNCERTAIN, errorText, useNow } from '../ui'
import { HelpNote } from '../ui/Help'
import { Icon } from '../ui/Icon'
import { fonts } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const READ_EVERY_MS = 30 * 1000
// Hodle may take a moment to record a validated selfie; five reads stay far
// under the service's status limit (60 per 600 s).
const SELFIE_POLLS = 5
const SELFIE_POLL_MS = 4 * 1000
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
const PHOTO_FAILED_TEXT = 'Não deu para usar essa foto. Escolha outra, de até 10 MB.'
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
// Refusals of a send retry that prove its opId has no row: the service answers
// a known opId with the stored row, and these come after that read or depend
// only on the op itself. Any other refusal (service, ledger, terms, proof)
// may come before the read, so it proves nothing.
const RETRY_NOTHING_SENT = Object.freeze(['destino-invalido', 'saldo-insuficiente', 'taxa-mudou', 'limite-carteira', 'valor-invalido', 'pedido-invalido'])
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
const SEND_TEXTS = Object.freeze({
  target: 'Digite um @nome da Varanda ou um endereço 0x.',
  noAddress: 'Envio para endereço indisponível agora.',
  badChecksum: 'Este endereço tem um erro de digitação: as letras maiúsculas e minúsculas não conferem. Copie o endereço de novo de quem vai receber.',
  noNome: 'Envio por @nome indisponível agora.',
  checkbox: 'Marque que conferiu o endereço e a rede antes de digitar a senha.',
  // Says nothing about why: whether a name exists or has a wallet is not told.
  badTarget: 'Não é possível enviar para este destino.',
  previewRefused: 'Não dá para fazer este envio agora.',
  notSettled: 'O envio ainda não foi confirmado. Você pode conferir de novo ou tentar de novo com o mesmo pedido, sem risco de enviar duas vezes.',
  inFlight: 'Um envio ainda está em andamento. Toque em Conferir para ver se ele foi confirmado.',
  copied: 'Endereço copiado.',
  copyFailed: 'Não deu para copiar. Toque e segure o endereço para copiar.',
  noReceive: 'O endereço não está disponível agora.',
  usdcAddress: 'USDC só pode ser enviado para um endereço 0x.',
  usdcCap (micros) {
    return 'O limite por envio de USDC é ' + usdcText(micros) + ', taxas incluídas.'
  },
  usdcNetwork (network) {
    return 'O USDC sai do seu saldo em USDC, na rede ' + network.charAt(0).toUpperCase() + network.slice(1) + '. Um envio na rede errada não pode ser desfeito.'
  },
  receiveNetwork (network) {
    return 'Este endereço recebe BRLA e USDC só na rede ' + network.charAt(0).toUpperCase() + network.slice(1) + '. Outra moeda ou outra rede pode se perder.'
  }
})
// Converter. A conversion is never sent again: its opId stays while it may
// still settle, and a failed or stuck one goes to support, not to a new try.
const SWAP_TEXTS = Object.freeze({
  amount: 'Confira o valor em USDC.',
  quoteRefused: 'Não dá para converter agora.',
  cap (micros) {
    return 'O limite por conversão é ' + usdcText(micros) + '.'
  },
  inFlight: 'Uma conversão ainda está em andamento. Toque em Conferir para ver se ela foi concluída.',
  code: 'Código da conversão:',
  providerCode: 'Código da Hodle:'
})
// Still open at the provider: no other conversion starts meanwhile.
const SWAP_OPEN = Object.freeze(['enviado', 'pendente', 'incerto'])
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

function Check ({ label, checked, onToggle, disabled }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
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
        {checked ? <Icon name='ok' size={14} color={colors.accentInk} /> : null}
      </View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  )
}

// The kit's Field has no secure entry; the PIN must not show on screen.
function PinField ({ label, value, onChangeText, editable }) {
  const styles = useStyles(makeStyles)
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
  return base64url(c.getRandomValues(new Uint8Array(16)))
}

// The service's externalIdFor (wallet-ops-store.js): lets the screen find an
// uncertain payout or send without asking the service to resend it.
async function opExternalId (member, kind, opId) {
  const hex = await sha256Hex(member + ':' + kind + ':' + opId)
  return hex === null ? null : 'var-' + hex.slice(0, 32)
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

function usdcText (micros) {
  const formatted = formatUsdc(micros)
  return formatted === null ? null : formatted + ' USDC'
}

function Line ({ label, value }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  )
}

// A USDC fee is counted in micros: formatBrl would read them as centavos.
function feeSentence (fee, prefix) {
  if (!fee || !Object.hasOwn(FEE_STATUS_TEXTS, fee.status)) return null
  const formatted = fee.asset === 'USDC' ? usdcText(fee.feeMicros) : formatBrl(fee.cents)
  const amount = formatted !== null ? ' (' + formatted + ')' : ''
  return prefix + amount + ': ' + FEE_STATUS_TEXTS[fee.status]
}

// A USDC send's confirmation, from the micros preview as the service gave it.
function usdcSendLines (p) {
  const fee = usdcFeeLines(p.varandaFeeMicros)
  const amount = usdcText(p.amountMicros)
  const pending = usdcText(p.pendingFeeMicros)
  const total = usdcText(p.totalDebitMicros)
  const net = usdcText(p.netReceivedMicros)
  if (fee === null || amount === null || pending === null || total === null || net === null) return null
  const lines = [{ label: 'Valor', value: amount }, ...fee]
  if (p.pendingFeeMicros > 0) lines.push({ label: 'Taxas pendentes', value: pending })
  lines.push({ label: 'Total debitado', value: total })
  lines.push({ label: 'Quem recebe ganha', value: net })
  return lines
}

// open: the screen is showing; active: open and the node ready (for calls).
// member: the unlocked public key; node: from useNode (signs wallet.sign).
export default function Carteira ({ open, active, member, node, onBack }) {
  const styles = useStyles(makeStyles)
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
  // The in-page capture: { sessionId, region, identityPoolId } while the
  // detector shows, and the last region and pool kept for one retry.
  const captureRef = useRef(null)
  const retryRef = useRef(null)
  // A detector completion that arrived while another action held the screen:
  // it waits for the person's own tap, never sent later on its own.
  const pendingRef = useRef(null)
  const [selfieStage, setSelfieStage] = useState('idle')
  const [cameraDenied, setCameraDenied] = useState(false)
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
    captureRef.current = null
    retryRef.current = null
    pendingRef.current = null
    setSelfieStage('idle')
    setCameraDenied(false)
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
  // The newest status read, for a loop that waits on it inside one run.
  const accountRef = useRef(undefined)
  const readStatus = useCallback(async () => {
    const gen = genRef.current
    const seq = ++readSeqRef.current
    const { account: a } = await signed('status', {}, walletStatus)
    if (gen !== genRef.current || seq !== readSeqRef.current) return false
    accountRef.current = a
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

  // A pick that ends after a member change or leaving is dropped. null is a
  // cancel; false is a photo the picker could not use, which must not look
  // like a cancel.
  const pickFront = async () => {
    const gen = genRef.current
    const f = await pickPhoto()
    if (gen !== genRef.current) return
    if (f === false) setError(PHOTO_FAILED_TEXT)
    else if (f) setFront(f)
  }
  const pickBack = async () => {
    const gen = genRef.current
    const f = await pickPhoto()
    if (gen !== genRef.current) return
    if (f === false) setError(PHOTO_FAILED_TEXT)
    else if (f) setBack(f)
  }
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
    // The upload URLs expire 30 s after they are made (X-Amz-Expires), so
    // the back starts with the front instead of waiting for it to finish.
    await Promise.all([
      uploadDocument(urls.uploadUrlFront, front, uploadDeps()),
      sides ? uploadDocument(urls.uploadUrlBack, back, uploadDeps()) : null
    ])
    if (gen !== genRef.current) return
    setFront(null)
    setBack(null)
    setDocSent(true)
  }, { reread: true })

  const startSelfie = () => run(async (gen) => {
    const { livenessUrl: url, capture } = await signed('kyc-document', { documentType: 'SELFIE-FROM-LIVENESS' }, walletKycDocument)
    if (gen !== genRef.current) return
    setOpened(false)
    setLivenessUrl(url)
    retryRef.current = null
    pendingRef.current = null
    setCameraDenied(false)
    if (capture && isAvailable()) {
      captureRef.current = capture
      setSelfieStage('capturing')
    } else {
      captureRef.current = null
      setSelfieStage('idle')
    }
  }, { reread: true })

  const dropCapture = () => {
    captureRef.current = null
    retryRef.current = null
    pendingRef.current = null
    setSelfieStage('idle')
    setCameraDenied(false)
  }

  // 'selfie-ausente': the service no longer holds a live selfie, so the old
  // hosted link is dead too and only a new selfie document can start over.
  const selfieGone = () => {
    dropCapture()
    setLivenessUrl(null)
    setOpened(false)
  }

  // Hodle may take a moment to record the selfie: read the status until it
  // says ready, at most SELFIE_POLLS times.
  const awaitSelfie = async (gen, ready) => {
    setSelfieStage('validating')
    try {
      const reads = ready ? 1 : SELFIE_POLLS
      for (let i = 0; i < reads; i++) {
        if (i > 0) await wait(SELFIE_POLL_MS)
        if (gen !== genRef.current) return
        if (await readStatus()) setMustRead(false)
        if (accountRef.current?.selfieReady === true) break
      }
    } catch {}
    if (gen === genRef.current) setSelfieStage('idle')
  }

  // Every detector callback names the capture it was mounted for: one that
  // was dropped (cleared, replaced, or another member) is ignored. `tapped`:
  // the person confirmed a completion kept while the screen was busy.
  const captureDone = (c, tapped = false) => {
    if (captureRef.current !== c && !(tapped && pendingRef.current === c)) return
    if (busyRef.current) {
      // run() would decline and the finished capture would be lost: keep it
      // for 'Confirmar a selfie' instead of sending it later on its own.
      captureRef.current = null
      pendingRef.current = c
      setSelfieStage('pending')
      return
    }
    dropCapture()
    run(async (gen) => {
      setSelfieStage('validating')
      let out
      try {
        out = await signed('kyc-liveness-validate', {}, walletLivenessValidate)
      } catch (err) {
        if (gen !== genRef.current) throw err
        if (err?.uncertain !== true && err?.code === 'selfie-recusada') {
          retryRef.current = { region: c.region, identityPoolId: c.identityPoolId }
          setSelfieStage('retry')
        } else if (err?.uncertain !== true && err?.code === 'selfie-ausente') {
          selfieGone()
        } else {
          dropCapture()
        }
        throw err
      }
      if (gen !== genRef.current) return
      await awaitSelfie(gen, out.ready)
    })
  }

  const confirmSelfie = () => {
    if (pendingRef.current) captureDone(pendingRef.current, true)
  }

  const captureError = (c, code) => {
    if (captureRef.current !== c) return
    if (code === 'SESSION_EXPIRED') {
      captureRef.current = null
      retryRef.current = { region: c.region, identityPoolId: c.identityPoolId }
      setCameraDenied(false)
      setSelfieStage('retry')
      return
    }
    // The detector stays: its own 'Tentar de novo' asks for the camera again.
    if (code === 'CAMERA_DENIED') {
      setCameraDenied(true)
      return
    }
    dropCapture()
  }

  const captureCancel = (c) => {
    if (captureRef.current === c) dropCapture()
  }

  // The retry stage and its button stay until the service answers: a refused
  // retry can be tapped again, an unknown outcome is never retried.
  const retrySelfie = () => run(async (gen) => {
    const base = retryRef.current
    if (!base) return
    let out
    try {
      out = await signed('kyc-liveness-retry', {}, walletLivenessRetry)
    } catch (err) {
      if (gen !== genRef.current) throw err
      if (err?.uncertain === true) dropCapture()
      else if (err?.code === 'selfie-ausente') selfieGone()
      throw err
    }
    if (gen !== genRef.current) return
    if (out.alreadyCompleted === true) {
      dropCapture()
      await awaitSelfie(gen, out.ready)
      return
    }
    if (!isAvailable()) {
      dropCapture()
      return
    }
    retryRef.current = null
    setCameraDenied(false)
    captureRef.current = { ...base, sessionId: out.sessionId }
    setSelfieStage('capturing')
  })

  // Straight from the tap, with nothing awaited first, so the browser counts
  // it as the person's own action. Hodle's page has no return address and
  // cannot be framed, hence a new window and the 'Já terminei' button.
  const openLiveness = () => {
    if (typeof livenessUrl !== 'string') return
    // Choosing the hosted page ends the in-page attempt: two at once could
    // race at Hodle.
    dropCapture()
    openExternal(livenessUrl)
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
  const capture = captureRef.current
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
                    {selfieStage === 'capturing' && capture
                      ? (
                        <>
                          <Body>{TEXTS.LIVENESS_IN_APP}</Body>
                          {cameraDenied ? <Notice>{TEXTS.LIVENESS_CAMERA_DENIED}</Notice> : null}
                          <LivenessCapture
                            key={capture.sessionId}
                            sessionId={capture.sessionId}
                            region={capture.region}
                            identityPoolId={capture.identityPoolId}
                            onComplete={() => captureDone(capture)}
                            onError={(code) => captureError(capture, code)}
                            onCancel={() => captureCancel(capture)}
                          />
                        </>
                        )
                      : selfieStage === 'validating'
                        ? <><Body>{TEXTS.LIVENESS_IN_APP}</Body><Spinner /></>
                        : selfieStage === 'pending'
                          ? (
                            <>
                              <Body>{TEXTS.LIVENESS_PENDING}</Body>
                              <Btn label='Confirmar a selfie' onPress={confirmSelfie} pending={busy} disabled={off} />
                            </>
                            )
                          : selfieStage === 'retry'
                            ? (
                              <>
                                <Body>{TEXTS.LIVENESS_RETRY}</Body>
                                <Btn label='Tentar a selfie de novo' onPress={retrySelfie} pending={busy} disabled={off} />
                              </>
                              )
                            : <Body>{TEXTS.LIVENESS_OPEN}</Body>}
                    {livenessUrl === null
                      ? <Btn label='Selfie com prova de vida' onPress={startSelfie} pending={busy} disabled={off} />
                      : <Btn label='Abrir a página da selfie' onPress={openLiveness} disabled={off} />}
                    {livenessUrl !== null && opened
                      ? (
                        <>
                          <Soft>{LINK_TEXT}</Soft>
                          <Text
                            style={styles.link}
                            {...linkProps(livenessUrl)}
                            selectable
                          >
                            {livenessUrl}
                          </Text>
                        </>
                        )
                      : null}
                  </>
                  )}
              <Btn label='Já terminei, conferir' secondary onPress={finished} disabled={off || selfieStage === 'capturing' || selfieStage === 'validating'} />
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

// Saldo, Receber, Pagar, Enviar, Cripto and Extrato. Nothing here is sent twice on its own:
// a deposit or a payout whose outcome is unknown keeps its opId, and only a
// deliberate tap sends that same opId again, which the service answers with
// the stored outcome instead of a second charge or payout.
function Dinheiro ({ active, policy, member, signed }) {
  const styles = useStyles(makeStyles)
  const [view, setView] = useState('saldo')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const genRef = useRef(0)
  const maxCents = Number.isSafeInteger(policy.maxCents) ? policy.maxCents : null
  const maxUsdcMicros = Number.isSafeInteger(policy.maxUsdcMicros) && policy.maxUsdcMicros >= 1 ? policy.maxUsdcMicros : null

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

  // Enviar: one destination field, read as an @nome or an address.
  const canTransfer = hasAction(policy, 'transfer')
  const canCrypto = hasAction(policy, 'send-crypto')
  // An unexpected network label has no warning text, so no address send.
  const networkWarning = CRYPTO_TEXTS.onlyBrla(policy.network)
  // USDC moves only from the USDC balance, never paid for with BRLA.
  const usdcHeld = bal !== null && Number.isSafeInteger(bal.usdcMicros) && bal.usdcMicros > 0
  const canSendUsdc = canCrypto && networkWarning !== null && usdcHeld
  const canSwap = hasAction(policy, 'swap')
  // BRLA | USDC
  const [sendAsset, setSendAsset] = useState('BRLA')
  const usdcSend = sendAsset === 'USDC' && canSendUsdc
  const [sendTarget, setSendTarget] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  // { kind, dest, cents, preview, until }, or for USDC { kind, asset, dest, micros, preview, until }
  const [sendConfirm, setSendConfirm] = useState(null)
  const [sendChecked, setSendChecked] = useState(false)
  const [sendPin, setSendPin] = useState('')
  const sendOpRef = useRef(null)
  // { kind, op } of the last send, for 'Tentar de novo' under the same opId.
  const lastSendRef = useRef(null)
  const sendExpectedRef = useRef(null)
  // form | confirm | incerto | result
  const [sendPhase, setSendPhaseState] = useState('form')
  // Mirrored so a check that answers after the screen moved on can still
  // read where the Enviar view is.
  const sendPhaseRef = useRef('form')
  const setSendPhase = useCallback((v) => {
    sendPhaseRef.current = typeof v === 'function' ? v(sendPhaseRef.current) : v
    setSendPhaseState(sendPhaseRef.current)
  }, [])
  const [sendResult, setSendResult] = useState(null)
  const [sendRetryReady, setSendRetryReady] = useState(false)
  // Like payLock, for the send in flight or with an unknown outcome.
  const [sendLock, setSendLockState] = useState(null)
  const sendLockRef = useRef(null)
  const setSendLock = useCallback((v) => {
    sendLockRef.current = v
    setSendLockState(v)
  }, [])
  // Whatever path settles the current send (Conferir in the statement, a
  // late check, the poll), an open incerto card follows it to the result.
  const settleSend = useCallback((row) => {
    const l = sendLockRef.current
    if (!(l && row && l.externalId === row.externalId && !OPEN_STATUSES.includes(row.status))) return
    setSendLock(null)
    if (sendPhaseRef.current !== 'incerto') return
    const kind = lastSendRef.current !== null ? lastSendRef.current.kind : l.kind
    sendOpRef.current = null
    setSendRetryReady(false)
    setSendResult({ externalId: row.externalId, status: row.status, fee: row.fee, pendingFee: null, txHash: row.txHash || null, kind, confirmed: true })
    setSendPhase('result')
  }, [setSendLock, setSendPhase])

  // Converter: { micros, quote, until } of the quote on screen.
  const [swapAmount, setSwapAmount] = useState('')
  const [swapConfirm, setSwapConfirm] = useState(null)
  const [swapPin, setSwapPin] = useState('')
  const swapOpRef = useRef(null)
  // form | confirm | progress
  const [swapPhase, setSwapPhaseState] = useState('form')
  const swapPhaseRef = useRef('form')
  const setSwapPhase = useCallback((v) => {
    swapPhaseRef.current = typeof v === 'function' ? v(swapPhaseRef.current) : v
    setSwapPhaseState(swapPhaseRef.current)
  }, [])
  // { externalId, status } of the conversion sent; only an op-status answer moves it.
  const [swapResult, setSwapResult] = useState(null)
  // The conversion that may still settle: { opId, externalId }. Only a final
  // op-status answer releases it, and while it is held no new opId is minted.
  const [swapLock, setSwapLockState] = useState(null)
  const swapLockRef = useRef(null)
  const setSwapLock = useCallback((v) => {
    swapLockRef.current = v
    setSwapLockState(v)
  }, [])
  const settleSwap = useCallback((row) => {
    const l = swapLockRef.current
    if (!(l && row && l.externalId === row.externalId)) return
    // The Hodle swap id is what Hodle support searches; a row without one
    // never erases the id already known.
    setSwapResult((r) => (r && r.externalId === row.externalId
      ? { ...r, status: row.status, providerId: row.providerId || r.providerId || null }
      : r))
    if (SWAP_OPEN.includes(row.status)) return
    setSwapLock(null)
    swapOpRef.current = null
  }, [setSwapLock])

  const clearSecrets = useCallback(() => {
    setPayerCpf('')
    setBeneficiaryCpf('')
    setPayPin('')
    setSendPin('')
    setSwapPin('')
  }, [])

  // A confirmation is only good with the PIN typed right after it, so it
  // goes when the PIN does.
  const dropConfirm = useCallback(() => {
    setQuote(null)
    setPreview(null)
    setConfirmUntil(0)
    setPhase((p) => (p === 'confirm' ? 'form' : p))
    setSendConfirm(null)
    setSendChecked(false)
    setSendPhase((p) => (p === 'confirm' ? 'form' : p))
    setSwapConfirm(null)
    setSwapPhase((p) => (p === 'confirm' ? 'form' : p))
  }, [setSendPhase, setSwapPhase])

  // A balance read that empties the USDC balance takes the USDC choice away;
  // the typed micros must not stay in the form to be previewed as reais.
  useEffect(() => {
    if (canSendUsdc || sendAsset !== 'USDC') return
    setSendAsset('BRLA')
    setSendAmount('')
    if (sendLockRef.current !== null || sendPhaseRef.current !== 'confirm') return
    setSendConfirm(null)
    setSendChecked(false)
    setSendPin('')
    setSendPhase('form')
  }, [canSendUsdc, sendAsset, setSendPhase])

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
    if (active && (view === 'saldo' || view === 'cripto')) readBalance()
    // Only on opening Saldo or Cripto: readBalance changes every render.
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
    if (await copyText(shareNav(), code)) {
      setNote(MONEY_TEXTS.copied)
      return
    }
    // Without clipboard access, select the code so the system menu copies it.
    setNote(selectContents(codeRef.current) ? MONEY_TEXTS.selected : MONEY_TEXTS.copyFailed)
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
    if (sendLockRef.current !== null) return setError(SEND_TEXTS.inFlight)
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
        expectedRef.current = await opExternalId(member, 'payout', op.opId)
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

  // Reads one unsettled row again (enviado or incerto, or a pendente
  // conversion, which no other path polls once the Converter is left);
  // op-status is what moves the service's ledger, and it never resends.
  const checkItem = (externalId) => run(async (gen) => {
    const row = await signed('op-status', { externalId }, walletOpStatus)
    settleLock(row)
    settleSend(row)
    settleSwap(row)
    if (gen !== genRef.current) return
    setItems((list) => (list === null
      ? list
      : list.map((i) => (i.externalId === row.externalId
        ? { ...i, status: row.status, fee: row.fee, dispute: row.dispute, providerId: row.providerId || i.providerId }
        : i))))
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

  // Enviar. The preview is read on Conferir only; the destination is checked
  // by the service at send time, never looked up from this screen.
  const editSend = (setter) => (t) => {
    setter(t)
    dropConfirm()
  }

  const sendRefusalText = (err) => (err && err.code === 'destino-invalido'
    ? SEND_TEXTS.badTarget
    : walletErrorText(err) || errorText(err))

  const conferirSend = () => run(async (gen) => {
    // USDC chosen but no longer offered: never fall through to a BRLA preview.
    if (sendAsset === 'USDC' && !canSendUsdc) return setError(SEND_TEXTS.previewRefused)
    if (sendLockRef.current !== null) return setError(SEND_TEXTS.inFlight)
    if (payLockRef.current !== null) return setError(MONEY_TEXTS.inFlight)
    const target = targetKind(sendTarget)
    if (target === null) return setError(SEND_TEXTS.target)
    if (usdcSend && target !== 'address') return setError(SEND_TEXTS.usdcAddress)
    if (target === 'nome' && !canTransfer) return setError(SEND_TEXTS.noNome)
    if (target === 'address' && (!canCrypto || networkWarning === null)) return setError(SEND_TEXTS.noAddress)
    const amount = usdcSend ? parseUsdc(sendAmount) : parseBrl(sendAmount)
    if (amount === null || amount < 1) return setError(MONEY_TEXTS.amount)
    if (usdcSend && maxUsdcMicros !== null && amount > maxUsdcMicros) return setError(SEND_TEXTS.usdcCap(maxUsdcMicros))
    const raw = sendTarget.trim().replace(/^@/, '')
    const kind = target === 'nome' ? 'transfer' : 'crypto'
    // A send to an outside address cannot be undone, so a mixed-case address
    // must carry a valid EIP-55 checksum before it is lowercased.
    if (kind === 'crypto' && !hasValidChecksum(raw)) return setError(SEND_TEXTS.badChecksum)
    const dest = kind === 'transfer' ? raw.toLowerCase() : normalizeAddress(raw)
    if (dest === null) return setError(SEND_TEXTS.target)
    if (sendOpRef.current === null) sendOpRef.current = mintOpId()
    if (sendOpRef.current === null) return setError(MONEY_TEXTS.noRandom)
    if (usdcSend) {
      const p = await signed('preview', { kind, asset: 'USDC', source: 'USDC', amountMicros: amount }, walletCryptoPreview)
      if (gen !== genRef.current) return
      if (p.ok !== true) return setError(walletErrorText({ code: p.reason }) || SEND_TEXTS.previewRefused)
      if (usdcFeeLines(p.varandaFeeMicros) === null) return setError(SEND_TEXTS.previewRefused)
      // The confirmation renders only with these lines: without them there
      // would be neither the form nor the card.
      if (usdcSendLines(p) === null) return setError(SEND_TEXTS.previewRefused)
      setSendConfirm({ kind, asset: 'USDC', dest, micros: amount, preview: p, until: Date.now() + CONFIRM_MS })
      setSendChecked(false)
      setSendPhase('confirm')
      return
    }
    const cents = amount
    const p = await signed('preview', { kind, cents }, walletPreview)
    if (gen !== genRef.current) return
    if (p.ok !== true) return setError(walletErrorText({ code: p.reason }) || SEND_TEXTS.previewRefused)
    if (feeLinesFor(p, kind) === null) return setError(SEND_TEXTS.previewRefused)
    setSendConfirm({ kind, dest, cents, preview: p, until: Date.now() + CONFIRM_MS })
    setSendChecked(false)
    setSendPhase('confirm')
  })

  const resetSend = () => {
    setSendPhase('form')
    setSendResult(null)
    setSendConfirm(null)
    setSendChecked(false)
    setSendTarget('')
    setSendAmount('')
    setSendAsset('BRLA')
    setSendRetryReady(false)
    setSendPin('')
    sendOpRef.current = null
    lastSendRef.current = null
    sendExpectedRef.current = null
    setError('')
    setNote('')
  }

  // A definite refusal is final for its opId, so the next attempt gets a
  // fresh one; a wrong PIN or a passing limit keeps the confirmation.
  const sendRefused = (err, retry) => {
    sendOpRef.current = null
    setError(sendRefusalText(err))
    if (!retry && KEEP_CONFIRM_CODES.includes(err && err.code)) {
      sendOpRef.current = mintOpId()
      return
    }
    setSendConfirm(null)
    setSendChecked(false)
    setSendPhase('form')
    setSendRetryReady(false)
  }

  // retry: the same op under the same opId, which the service answers with
  // the stored outcome instead of a second send. The PIN goes into this one
  // request and leaves the state before it is sent.
  const sendPay = (retry) => run(async () => {
    const chosen = sendPin
    setSendPin('')
    if (!isPin(chosen)) return setError('Digite a senha de 6 dígitos (PIN) da carteira.')
    let kind
    let op
    if (retry) {
      if (lastSendRef.current === null) return
      kind = lastSendRef.current.kind
      op = { ...lastSendRef.current.op }
    } else {
      if (sendLockRef.current !== null) return setError(SEND_TEXTS.inFlight)
      if (sendConfirm === null || Date.now() >= sendConfirm.until || sendOpRef.current === null) {
        dropConfirm()
        return setError(MONEY_TEXTS.confirmExpired)
      }
      if (sendConfirm.kind === 'crypto' && !sendChecked) return setError(SEND_TEXTS.checkbox)
      kind = sendConfirm.kind
      // A USDC send is funded by the USDC balance only (source USDC).
      op = sendConfirm.asset === 'USDC'
        ? { opId: sendOpRef.current, amountMicros: sendConfirm.micros, asset: 'USDC', source: 'USDC' }
        : { opId: sendOpRef.current, cents: sendConfirm.cents }
      if (kind === 'transfer') op.to = sendConfirm.dest
      else op.address = sendConfirm.dest
      Object.assign(op, debitTerms(sendConfirm.preview))
      lastSendRef.current = { kind, op: { ...op } }
      sendExpectedRef.current = await opExternalId(member, kind, op.opId)
    }
    const lock = { opId: op.opId, externalId: sendExpectedRef.current, kind, sentAt: Date.now(), inFlight: true }
    setSendLock(lock)
    const send = kind === 'transfer' ? walletTransfer : walletSendCrypto
    let out
    try {
      out = await signed(kind === 'transfer' ? 'transfer' : 'send-crypto', op, (a) => send({ ...a, pin: chosen }))
    } catch (err) {
      // On a retry, operacao-pendente may be the first request still inside
      // the service: nothing is known about this opId yet.
      if ((err && err.uncertain === true) || (retry && err && err.code === 'operacao-pendente')) {
        setSendLock({ ...lock, inFlight: false })
        setSendPhase('incerto')
        setSendRetryReady(false)
        setSendConfirm(null)
        setSendChecked(false)
      } else if (retry && !RETRY_NOTHING_SENT.includes(err && err.code)) {
        // The first attempt may still settle, so the lock and the opId stay.
        setSendLock({ ...lock, inFlight: false })
        setError(sendRefusalText(err))
      } else {
        // A definite refusal: nothing was sent under this opId.
        setSendLock(null)
        sendRefused(err, retry)
      }
      return
    }
    setError('')
    setSendConfirm(null)
    setSendChecked(false)
    setSendRetryReady(false)
    setSendLock({ ...lock, externalId: out.externalId, inFlight: false })
    settleSend(out)
    if (OPEN_STATUSES.includes(out.status)) {
      setSendPhase('incerto')
      return
    }
    sendOpRef.current = null
    setSendResult({ ...out, kind, confirmed: true })
    setSendPhase('result')
  })

  // An unknown send is settled by op-status (the service reads the provider
  // statement by reference); a statement read alone does not move its row.
  const checkSend = () => run(async (gen) => {
    const l = sendLockRef.current
    const id = l !== null && l.externalId !== null ? l.externalId : sendExpectedRef.current
    if (id === null) return
    let row
    try {
      row = await signed('op-status', { externalId: id }, walletOpStatus)
    } catch (err) {
      // An unanswered check proves nothing: the lock and the opId stay.
      if (gen === genRef.current) setSendRetryReady(true)
      throw err
    }
    // A settled row moves the incerto card to the result here, even when
    // this answer arrives after the screen moved on.
    settleSend(row)
    if (gen !== genRef.current) return
    if (OPEN_STATUSES.includes(row.status)) {
      setSendPhase('incerto')
      setSendRetryReady(true)
      setNote(SEND_TEXTS.notSettled)
    }
  })

  const sendResultId = sendResult && sendResult.externalId
  const sendOpen = sendPhase === 'result' && !!sendResult && !(sendResult.confirmed === true && isFinal(sendResult))
  useEffect(() => {
    if (!active || view !== 'enviar' || !sendResultId || !sendOpen) return
    const timer = setInterval(async () => {
      if (busyRef.current) return
      const gen = genRef.current
      try {
        const row = await signed('op-status', { externalId: sendResultId }, walletOpStatus)
        settleSend(row)
        if (gen !== genRef.current) return
        if (OPEN_STATUSES.includes(row.status)) {
          setSendRetryReady(true)
          setSendPhase('incerto')
          return
        }
        setSendResult((r) => (r && r.externalId === row.externalId ? { ...r, status: row.status, fee: row.fee, txHash: row.txHash || r.txHash, confirmed: true } : r))
      } catch {}
    }, POLL_EVERY_MS)
    return () => clearInterval(timer)
  }, [active, view, sendResultId, sendOpen, signed, settleSend, setSendPhase])

  // A send in flight or already sent is past its confirmation: the countdown
  // left on screen must not touch it.
  const onSendExpired = useCallback(() => {
    if (sendLockRef.current !== null || sendPhaseRef.current !== 'confirm') return
    dropConfirm()
    setSendPin('')
    setError(MONEY_TEXTS.confirmExpired)
  }, [dropConfirm])

  const copyAddress = async () => {
    const address = bal && bal.address
    if (typeof address !== 'string') return
    setNote(await copyText(shareNav(), address) ? SEND_TEXTS.copied : SEND_TEXTS.copyFailed)
  }

  // Converter. The quote binds nothing (the provider prices the swap again),
  // so it carries no opId; the amount is echoed back before the PIN.
  const editSwap = (t) => {
    setSwapAmount(t)
    dropConfirm()
    setSwapPin('')
  }

  const quoteSwap = () => run(async (gen) => {
    if (swapLockRef.current !== null) return setError(SWAP_TEXTS.inFlight)
    if (sendLockRef.current !== null) return setError(SEND_TEXTS.inFlight)
    if (payLockRef.current !== null) return setError(MONEY_TEXTS.inFlight)
    const micros = parseUsdc(swapAmount)
    if (micros === null || micros < 1) return setError(SWAP_TEXTS.amount)
    if (maxUsdcMicros !== null && micros > maxUsdcMicros) return setError(SWAP_TEXTS.cap(maxUsdcMicros))
    const q = await signed('swap-quote', { amountMicros: micros }, walletSwapQuote)
    if (gen !== genRef.current) return
    if (q.amountInMicros !== micros || swapQuoteLines(q) === null) return setError(SWAP_TEXTS.quoteRefused)
    setSwapConfirm({ micros, quote: q, until: Date.now() + CONFIRM_MS })
    setSwapPhase('confirm')
  })

  // One request under one opId. An unknown outcome is settled by op-status
  // only: there is no retry, with this opId or a new one.
  const swapPay = () => run(async () => {
    const chosen = swapPin
    setSwapPin('')
    if (!isPin(chosen)) return setError('Digite a senha de 6 dígitos (PIN) da carteira.')
    if (swapLockRef.current !== null) return setError(SWAP_TEXTS.inFlight)
    if (sendLockRef.current !== null) return setError(SEND_TEXTS.inFlight)
    if (payLockRef.current !== null) return setError(MONEY_TEXTS.inFlight)
    if (swapConfirm === null || Date.now() >= swapConfirm.until) {
      dropConfirm()
      return setError(MONEY_TEXTS.confirmExpired)
    }
    if (swapOpRef.current === null) swapOpRef.current = mintOpId()
    if (swapOpRef.current === null) return setError(MONEY_TEXTS.noRandom)
    const op = { opId: swapOpRef.current, amountMicros: swapConfirm.micros }
    const expected = await opExternalId(member, 'swap', op.opId)
    if (expected === null) return setError(MONEY_TEXTS.noRandom)
    setSwapLock({ opId: op.opId, externalId: expected })
    let out
    try {
      out = await signed('swap', op, (a) => walletSwap({ ...a, pin: chosen }))
    } catch (err) {
      if (err && err.uncertain === true) {
        setSwapConfirm(null)
        setSwapResult({ externalId: expected, status: 'incerto', providerId: null })
        setSwapPhase('progress')
        return
      }
      // A definite refusal: nothing was converted under this opId, and the
      // service keeps any row it wrote, so the next conversion needs a new one.
      setSwapLock(null)
      swapOpRef.current = null
      setError(walletErrorText(err) || errorText(err))
      if (!KEEP_CONFIRM_CODES.includes(err && err.code)) {
        setSwapConfirm(null)
        setSwapPhase('form')
      }
      return
    }
    setError('')
    setSwapConfirm(null)
    setSwapLock({ opId: op.opId, externalId: out.externalId })
    setSwapResult({ externalId: out.externalId, status: out.status, providerId: out.providerId || null })
    setSwapPhase('progress')
    settleSwap(out)
  })

  const checkSwap = () => run(async () => {
    const l = swapLockRef.current
    if (l === null) return
    const row = await signed('op-status', { externalId: l.externalId }, walletOpStatus)
    settleSwap(row)
  })

  const swapId = swapResult && swapResult.externalId
  const swapPolling = swapPhase === 'progress' && swapLock !== null
  useEffect(() => {
    if (!active || view !== 'cripto' || !swapId || !swapPolling) return
    const timer = setInterval(async () => {
      if (busyRef.current) return
      try {
        const row = await signed('op-status', { externalId: swapId }, walletOpStatus)
        settleSwap(row)
      } catch {}
    }, POLL_EVERY_MS)
    return () => clearInterval(timer)
  }, [active, view, swapId, swapPolling, signed, settleSwap])

  const onSwapExpired = useCallback(() => {
    if (swapLockRef.current !== null || swapPhaseRef.current !== 'confirm') return
    dropConfirm()
    setSwapPin('')
    setError(MONEY_TEXTS.confirmExpired)
  }, [dropConfirm])

  // Back to the form after a settled conversion. A new one is a deliberate
  // new action: swapPay mints a new opId, since settleSwap dropped the old one.
  const newSwap = () => {
    if (swapLockRef.current !== null) return
    setSwapResult(null)
    setSwapAmount('')
    setSwapConfirm(null)
    setSwapPin('')
    setSwapPhase('form')
    readBalance()
  }

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

  const canSendAddress = canCrypto && networkWarning !== null
  if (view === 'enviar') {
    const sendLocked = sendLock !== null
    const sendLockNote = sendLocked
      ? (
        <>
          <Notice>{SEND_TEXTS.inFlight}</Notice>
          <Btn label='Conferir' secondary onPress={checkSend} pending={busy} disabled={off} />
        </>
        )
      : null
    const usdcConfirm = sendConfirm !== null && sendConfirm.asset === 'USDC'
    const sendLines = sendConfirm === null
      ? null
      : (usdcConfirm ? usdcSendLines(sendConfirm.preview) : feeLinesFor(sendConfirm.preview, sendConfirm.kind))
    const sendKind = lastSendRef.current !== null ? lastSendRef.current.kind : null
    if (sendPhase === 'form') {
      const typed = targetKind(sendTarget)
      const typedUsdc = usdcSend ? parseUsdc(sendAmount) : null
      content = (
        <>
          {canSendUsdc
            ? (
              <>
                <Label>O que enviar</Label>
                <Row>
                  {['BRLA', 'USDC'].map((a) => (
                    <Btn
                      key={a}
                      label={a}
                      secondary={sendAsset !== a}
                      onPress={() => { setSendAsset(a); setSendAmount(''); dropConfirm() }}
                      disabled={off}
                    />
                  ))}
                </Row>
              </>
              )
            : null}
          {usdcSend
            ? (
              <>
                <Body>Enviar USDC</Body>
                <Soft>Para um endereço 0x. Sai do seu saldo em USDC: {usdcText(bal.usdcMicros)}.</Soft>
              </>
              )
            : (
              <>
                <Body>Enviar BRLA</Body>
                <Soft>{canSendAddress ? 'Para um @nome da Varanda ou para um endereço 0x.' : 'Para um @nome da Varanda.'}</Soft>
              </>
              )}
          <Field
            label={usdcSend ? 'Para (endereço 0x)' : (canSendAddress ? 'Para (@nome ou endereço 0x)' : 'Para (@nome)')}
            value={sendTarget}
            onChangeText={editSend(setSendTarget)}
            maxLength={64}
            editable={!off}
            mono
          />
          {typed === 'address' && canSendAddress
            ? <Notice>{usdcSend ? SEND_TEXTS.usdcNetwork(policy.network) : networkWarning}</Notice>
            : null}
          <Field
            label={usdcSend ? 'Valor (USDC)' : 'Valor (R$)'}
            value={sendAmount}
            onChangeText={editSend(setSendAmount)}
            maxLength={usdcSend ? 24 : 16}
            editable={!off}
            mono
          />
          {typedUsdc !== null ? <Soft>Você vai enviar {usdcText(typedUsdc)}.</Soft> : null}
          {payLock !== null ? <Notice>{MONEY_TEXTS.inFlight}</Notice> : null}
          {sendLockNote}
          <Btn label='Conferir' onPress={conferirSend} pending={busy} disabled={off || sendLocked} />
        </>
      )
    } else if (sendPhase === 'confirm' && sendConfirm !== null && sendLines !== null) {
      const isAddress = sendConfirm.kind === 'crypto'
      const totalText = usdcConfirm ? usdcText(sendConfirm.preview.totalDebitMicros) : formatBrl(sendConfirm.preview.totalDebitCents)
      // Other pending fees held in the balance, in the send's own asset.
      const reservedKey = usdcConfirm ? 'reservedFeeMicros' : 'reservedFeeCents'
      const reserved = Number.isSafeInteger(sendConfirm.preview[reservedKey]) && sendConfirm.preview[reservedKey] > 0
        ? (usdcConfirm ? usdcText(sendConfirm.preview.reservedFeeMicros) : formatBrl(sendConfirm.preview.reservedFeeCents))
        : null
      content = (
        <Card>
          <Label>Quem recebe</Label>
          {isAddress
            ? (
              <>
                <Text style={styles.code} selectable>{sendConfirm.dest}</Text>
                <Soft>{CRYPTO_TEXTS.CONFIRM_ADDRESS}</Soft>
                <Notice>{usdcConfirm ? SEND_TEXTS.usdcNetwork(policy.network) : networkWarning}</Notice>
              </>
              )
            : (
              <>
                <Body>@{displayText(sendConfirm.dest)}</Body>
                <Soft>{TRANSFER_TEXTS.CONFIRM_NOME}</Soft>
              </>
              )}
          {sendLines.map((l) => <Line key={l.label} label={l.label} value={l.value} />)}
          {reserved !== null ? <Soft>{'Reservado para taxas pendentes: ' + reserved + ' (fica na sua conta até ser cobrado).'}</Soft> : null}
          <Countdown key={sendConfirm.until} until={sendConfirm.until} label='A conferência vale por mais' onExpire={onSendExpired} />
          {isAddress
            ? <Check label={CRYPTO_TEXTS.CHECKBOX} checked={sendChecked} onToggle={() => { setSendChecked(!sendChecked); setSendPin('') }} disabled={off} />
            : null}
          {!isAddress || sendChecked
            ? <PinField label='Senha de 6 dígitos (PIN)' value={sendPin} onChangeText={setSendPin} editable={!off} />
            : null}
          {sendLockNote}
          <Row>
            <Btn
              label={'Enviar ' + totalText}
              onPress={() => sendPay(false)}
              pending={busy}
              disabled={off || sendLocked || (isAddress && !sendChecked)}
            />
            <Btn label='Alterar' secondary onPress={() => { dropConfirm(); setSendPin('') }} disabled={busy} />
          </Row>
        </Card>
      )
    } else if (sendPhase === 'incerto') {
      content = (
        <Card>
          <Notice>{sendKind === 'crypto' ? CRYPTO_TEXTS.UNCERTAIN : TRANSFER_TEXTS.UNCERTAIN}</Notice>
          <Btn label='Conferir o extrato' onPress={checkSend} pending={busy} disabled={off} />
          {sendRetryReady
            ? (
              <>
                <PinField label='Senha de 6 dígitos (PIN)' value={sendPin} onChangeText={setSendPin} editable={!off} />
                <Btn label='Tentar de novo' onPress={() => sendPay(true)} pending={busy} disabled={off} />
              </>
              )
            : null}
        </Card>
      )
    } else if (sendPhase === 'result' && sendResult !== null) {
      const feeText = feeSentence(sendResult.fee, 'Taxa da Varanda')
      const pendingText = feeSentence(sendResult.pendingFee, 'Taxa pendente anterior')
      content = (
        <Card>
          <Label>Envio</Label>
          <Body>{opStatusText(sendResult.kind, sendResult.status)}</Body>
          {sendResult.txHash ? <Soft>Transação: {displayText(sendResult.txHash)}</Soft> : null}
          {feeText ? <Soft>{feeText}</Soft> : null}
          {pendingText ? <Soft>{pendingText}</Soft> : null}
          {sendOpen ? <Spinner /> : null}
          {sendLockNote}
          <Row>
            <Btn label='Novo envio' onPress={resetSend} disabled={off || sendLocked} />
            <Btn label='Ver extrato' secondary onPress={() => go('extrato')} disabled={busy} />
          </Row>
        </Card>
      )
    }
  }

  // Receiving from another wallet, and Converter when the service offers the
  // swap and there is USDC to convert. A conversion under way stays on screen
  // even once the USDC balance is spent.
  if (view === 'cripto') {
    // onlyBrla vets the network label; once USDC can leave or be converted,
    // "só enviamos BRLA" would be false, so the receive note names both.
    const brlaOnly = bal !== null ? CRYPTO_TEXTS.onlyBrla(bal.network) : null
    const warning = brlaOnly !== null && (canSwap || canSendUsdc) ? SEND_TEXTS.receiveNetwork(bal.network) : brlaOnly
    const usdc = bal !== null ? usdcText(bal.usdcMicros) : null
    const showSwap = canSwap && (swapPhase !== 'form' || usdcHeld)
    const swapLines = swapConfirm !== null ? swapQuoteLines(swapConfirm.quote) : null
    const typedSwap = parseUsdc(swapAmount)
    let swapCard = null
    if (showSwap && swapPhase === 'form') {
      swapCard = (
        <Card>
          <Label>{USDC_TEXTS.CONVERTER}</Label>
          <Soft>{USDC_TEXTS.NO_VARANDA_FEE}</Soft>
          <Field label='Valor (USDC)' value={swapAmount} onChangeText={editSwap} maxLength={24} editable={!off} mono />
          {typedSwap !== null ? <Soft>Você vai converter {usdcText(typedSwap)}.</Soft> : null}
          {swapLock !== null ? <Notice>{SWAP_TEXTS.inFlight}</Notice> : null}
          <Btn label='Ver cotação' onPress={quoteSwap} pending={busy} disabled={off || swapLock !== null} />
        </Card>
      )
    } else if (showSwap && swapPhase === 'confirm' && swapConfirm !== null && swapLines !== null) {
      swapCard = (
        <Card>
          <Label>{USDC_TEXTS.CONVERTER}</Label>
          {swapLines.map((l) => <Line key={l.label} label={l.label} value={l.value} />)}
          <Notice>{USDC_TEXTS.QUOTE}</Notice>
          <Soft>{USDC_TEXTS.NO_VARANDA_FEE}</Soft>
          <Countdown key={swapConfirm.until} until={swapConfirm.until} label='A cotação vale por mais' onExpire={onSwapExpired} />
          <PinField label='Senha de 6 dígitos (PIN)' value={swapPin} onChangeText={setSwapPin} editable={!off} />
          <Row>
            <Btn label={'Converter ' + usdcText(swapConfirm.micros)} onPress={swapPay} pending={busy} disabled={off || swapLock !== null} />
            <Btn label='Alterar' secondary onPress={() => { dropConfirm(); setSwapPin('') }} disabled={busy} />
          </Row>
        </Card>
      )
    } else if (showSwap && swapPhase === 'progress' && swapResult !== null) {
      const status = swapResult.status
      // incerto and falhou go to support with the code: never a retry button.
      const support = status === 'incerto' || status === 'falhou'
      swapCard = (
        <Card>
          <Label>{USDC_TEXTS.CONVERTER}</Label>
          {status === 'incerto'
            ? <Notice>{UNCERTAIN_MONEY}</Notice>
            : <Body>{opStatusText('swap', status)}</Body>}
          {SWAP_OPEN.includes(status) && status !== 'incerto' ? <Soft>{USDC_TEXTS.PROGRESS}</Soft> : null}
          {support
            ? (
              <>
                <Notice>{USDC_TEXTS.SUPPORT}</Notice>
                <Soft>{SWAP_TEXTS.code}</Soft>
                <Text style={styles.code} selectable>{swapResult.externalId}</Text>
                {swapResult.providerId
                  ? (
                    <>
                      <Soft>{SWAP_TEXTS.providerCode}</Soft>
                      <Text style={styles.code} selectable>{swapResult.providerId}</Text>
                    </>
                    )
                  : null}
              </>
              )
            : null}
          {swapPolling ? <Spinner /> : null}
          <Row>
            {swapLock !== null
              ? <Btn label='Conferir' secondary onPress={checkSwap} pending={busy} disabled={off} />
              : null}
            {swapLock === null && !SWAP_OPEN.includes(status)
              ? <Btn label='Fechar' onPress={newSwap} disabled={off} />
              : null}
            <Btn label='Ver extrato' secondary onPress={() => go('extrato')} disabled={busy} />
          </Row>
        </Card>
      )
    }
    content = (
      <>
        <Card>
          <Label>Receber de outra carteira</Label>
          {bal === null
            ? (busy ? <Spinner /> : <Soft>Saldo ainda não carregado.</Soft>)
            : (bal.address !== null && warning !== null
                ? (
                  <>
                    <Text style={styles.code} selectable>{bal.address}</Text>
                    <Btn label='Copiar' onPress={copyAddress} disabled={!active} />
                    <Notice>{warning}</Notice>
                  </>
                  )
                : <Soft>{SEND_TEXTS.noReceive}</Soft>)}
          {usdc !== null
            ? (
              <>
                <Line label='USDC' value={usdc} />
                <Soft>{showSwap ? USDC_TEXTS.OFFERED : CRYPTO_TEXTS.USDC_HERE}</Soft>
              </>
              )
            : null}
          <Btn label='Atualizar' secondary onPress={readBalance} pending={busy} disabled={off} />
        </Card>
        {swapCard}
      </>
    )
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
        {canTransfer || canSendAddress || canCrypto
          ? (
            <Row>
              {canTransfer || canSendAddress ? <Btn label='Enviar' onPress={() => go('enviar')} disabled={off} /> : null}
              {canCrypto ? <Btn label='Cripto' secondary onPress={() => go('cripto')} disabled={off} /> : null}
            </Row>
            )
          : null}
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
          // A row without a known direction gets no sign rather than a guess.
          const sign = incoming ? '+ ' : (item.direction === 'out' ? '- ' : '')
          const feeText = feeSentence(item.fee, 'Taxa da Varanda')
          // A USDC row may also carry centavos from the provider; its amount is the micros.
          const amountText = item.asset === 'USDC' ? usdcText(item.amountMicros) : formatBrl(item.cents)
          return (
            <Card key={item.externalId || 'i' + i}>
              <Line label={KIND_LABELS[item.kind]} value={amountText === null ? '' : sign + amountText} />
              <Soft>{opStatusText(item.kind, item.status)}</Soft>
              {item.dispute !== null ? <Soft>{DISPUTE_TEXTS[item.dispute]}</Soft> : null}
              {item.to !== null ? <Soft>Para: {displayText(item.to)}</Soft> : null}
              {item.hodleFeeCents !== null && item.hodleFeeCents > 0
                ? <Soft>Taxa do parceiro: {formatBrl(item.hodleFeeCents)}</Soft>
                : null}
              {item.asset === 'USDC' && item.feeMicros > 0
                ? <Soft>Taxa do parceiro: {usdcText(item.feeMicros)}</Soft>
                : null}
              {feeText ? <Soft>{feeText}</Soft> : null}
              {item.at !== null ? <Soft>{dateText(item.at)}</Soft> : null}
              {item.kind === 'swap' && item.providerId
                ? <Soft>{SWAP_TEXTS.providerCode} {item.providerId}</Soft>
                : null}
              {(OPEN_STATUSES.includes(item.status) || (item.kind === 'swap' && item.status === 'pendente')) && item.externalId !== null
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

const makeStyles = (colors) => StyleSheet.create({
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
