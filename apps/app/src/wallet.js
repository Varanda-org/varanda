export const KYC_STATES = Object.freeze(['documentos', 'pendente', 'aprovado', 'recusado', 'expirado'])

export function walletStep ({ policy, account } = {}) {
  if (policy?.available !== true) return 'off'
  if (account === undefined) return 'loading'
  if (account === null) return 'explicar'
  // The server reports a lost subaccount create with kyc.state 'documentos'.
  if (account.subaccountUncertain === true) return 'incerto'
  const state = account.kyc?.state
  if (state === 'recusado' || state === 'expirado') return state
  if (state === 'documentos') {
    return account.documentReady === true && account.selfieReady === true ? 'dados' : 'documentos'
  }
  if (state !== 'aprovado') return 'aguardando'
  if (account.walletUncertain === true) return 'incerto'
  if (account.wallet) return 'pronto'
  if (!['carteira', 'pix', 'completo'].includes(policy.mode)) return 'aguardando-carteira'
  return 'pin'
}

export function isPin (s) {
  return typeof s === 'string' && /^[0-9]{6}$/.test(s) &&
    !/^([0-9])\1{5}$/.test(s) && !'0123456789'.includes(s) && !'9876543210'.includes(s)
}

export function cpfDigits (s) {
  return typeof s === 'string' ? s.replace(/\D/g, '') : ''
}

export function isCpf (s) {
  if (typeof s !== 'string' || !/^(?:[0-9]{11}|[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2})$/.test(s)) return false
  const digits = cpfDigits(s)
  if (/^([0-9])\1{10}$/.test(digits)) return false
  for (let length = 9; length <= 10; length++) {
    let sum = 0
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i)
    const remainder = sum % 11
    if (Number(digits[length]) !== (remainder < 2 ? 0 : 11 - remainder)) return false
  }
  return true
}

export function isBirthDate (s, now = Date.now()) {
  if (typeof s !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) || s.startsWith('0000')) return false
  const birth = new Date(s + 'T00:00:00.000Z')
  // Matches the server and the legal text: age counts on the Brasília calendar, fixed UTC-3 since 2019.
  const today = new Date(now - 3 * 60 * 60 * 1000)
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(today.getTime())) return false
  if (birth.toISOString().slice(0, 10) !== s) return false
  let age = today.getUTCFullYear() - birth.getUTCFullYear()
  if (today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age--
  return age >= 18
}

export function cepDigits (s) {
  return typeof s === 'string' && /^(?:[0-9]{8}|[0-9]{5}-[0-9]{3})$/.test(s) ? s.replace('-', '') : ''
}

export function isCep (s) {
  return cepDigits(s) !== ''
}

export function canonicalJson (obj) {
  if (obj === null || typeof obj !== 'object' ||
    (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null)) {
    throw new TypeError('Os dados devem ser um objeto com valores de texto.')
  }
  // Serializing each entry preserves UTF-16 key order even for integer keys.
  return '{' + Object.keys(obj).sort().map(key => {
    const value = obj[key]
    if (typeof value !== 'string') throw new TypeError('Os dados devem conter apenas valores de texto.')
    return JSON.stringify(key) + ':' + JSON.stringify(value)
  }).join(',') + '}'
}

export const TEXTS = Object.freeze({
  OPTIN_TITLE: 'Conta de pagamentos (opcional)',
  OPTIN_WHAT: 'Você pode abrir uma conta ligada ao seu @nome para receber e enviar dinheiro por Pix, quando o serviço liberar. É opcional: a Varanda continua funcionando igual sem ela.',
  OPTIN_KYC: 'Para abrir a conta, a lei pede uma verificação de identidade (KYC), feita pela Hodle, empresa parceira. Você vai enviar nome completo, CPF, data de nascimento, e-mail, endereço, a foto de um documento e uma selfie com prova de vida.',
  OPTIN_DATA: 'Esses dados vão para a Hodle e seus parceiros regulados; as fotos vão do seu navegador direto para a Hodle. A Varanda guarda só os identificadores da conta e da carteira e o estado da verificação. A Varanda nunca guarda sua senha de 6 dígitos (PIN), seu CPF, suas fotos nem seu endereço.',
  OPTIN_PERMANENT: 'A conta criada na Hodle não pode ser apagada depois.',
  OPTIN_MONEY: 'O dinheiro fica em BRLA, uma moeda digital que vale 1 real, emitida pela Avenia, numa carteira em seu nome. A Varanda não é banco e o saldo não rende juros.',
  OPTIN_FEES: 'Em alguns envios a Varanda cobra uma taxa própria, sempre mostrada antes de você confirmar, junto com a taxa do parceiro e o total.',
  OPTIN_SKIP: 'Deixar para depois',
  OPTIN_START: 'Quero abrir a conta',
  PIN_HINT: 'Escolha uma senha de 6 dígitos (PIN). Você vai digitá-la toda vez que enviar dinheiro. Ninguém na Varanda pode ver ou recuperar essa senha. Três erros bloqueiam o uso por 24 horas.',
  KYC_WAIT: 'Sua verificação de identidade está em análise. Aguarde e confira de novo mais tarde.',
  KYC_REJECTED: 'Sua verificação de identidade foi recusada. Você pode começar uma nova tentativa.',
  KYC_APPROVED: 'Verificação aprovada. A carteira será liberada em breve.',
  LIVENESS_OPEN: 'A selfie é feita numa página da Hodle, que abre em outra janela. Quando terminar, volte aqui e toque em Já terminei.',
  UNDER_18: 'Para abrir a conta de pagamentos, você precisa ter 18 anos ou mais.',
  UNCERTAIN_CREATE: 'Não deu para confirmar se a conta ou a carteira foi criada. Aguarde e toque em Conferir; nada é refeito sozinho.'
})

const ERROR_TEXTS = Object.freeze({
  // Also sent right after opt-in, before anything is in review.
  'kyc-pendente': 'A verificação de identidade ainda não terminou.',
  'kyc-recusado': TEXTS.KYC_REJECTED,
  'documentos-pendentes': 'Envie a foto do documento e termine a selfie para continuar.',
  'pin-invalido': 'A senha de 6 dígitos não foi aceita. Confira a senha antes de continuar.',
  'pin-bloqueado': 'A senha foi bloqueada após três erros. Aguarde 24 horas.',
  'carteira-pendente': 'Abra a conta de pagamentos antes.',
  // Client-only token for the wallet-create 404 while the operator mode is cadastro.
  'aguardando-carteira': TEXTS.KYC_APPROVED,
  'carteira-incerta': TEXTS.UNCERTAIN_CREATE,
  'termos-pendentes': 'Leia e aceite os termos da conta de pagamentos para continuar.',
  'limite-carteira': 'Você atingiu o limite de pedidos da conta de pagamentos. Tente mais tarde.',
  'idade-minima': TEXTS.UNDER_18,
  indisponivel: 'A conta de pagamentos está indisponível agora. Tente mais tarde.',
  // Same sentences as account.js, so the money screens and the account link do not disagree.
  'saldo-insuficiente': 'Saldo insuficiente. O saldo precisa cobrir também as taxas pendentes.',
  'valor-invalido': 'Valor inválido.',
  'destino-invalido': 'Destino inválido.',
  'taxa-mudou': 'A taxa mudou. Confira de novo antes de confirmar.'
})

export function walletErrorText (err) {
  // An outcome that may have happened gets the caller's uncertain text, never a retry hint.
  if (err?.uncertain === true) return null
  const code = err?.code
  return typeof code === 'string' && Object.hasOwn(ERROR_TEXTS, code) ? ERROR_TEXTS[code] : null
}

// Integer centavos only. A float such as 1.234,56 * 100 is not exact, so parsing
// stays on the digit string. Input has its own ceiling; display takes any safe
// integer so a large balance or statement row never renders blank.
const MAX_CENTS = 100000000
const DISPLAY_MAX_CENTS = Number.MAX_SAFE_INTEGER
// A preview line above this is not a real quote: refuse the preview.
const PREVIEW_MAX_CENTS = 10000000000
export const MIN_DEPOSIT_CENTS = 100
export const MIN_PAYOUT_CENTS = 10

const BRL_RE = /^(?:R\$ *)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/i

function isCents (n, max = MAX_CENTS) {
  return Number.isSafeInteger(n) && n >= 0 && n <= max
}

export function parseBrl (text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().replace(/[\u00a0\u202f]/g, ' ')
  const match = BRL_RE.exec(trimmed)
  if (!match) return null
  const whole = match[1].replace(/\./g, '')
  if (whole.length > 9) return null
  const frac = (match[2] || '').padEnd(2, '0')
  const cents = Number(whole) * 100 + Number(frac)
  if (!isCents(cents)) return null
  return cents
}

export function formatBrl (cents) {
  if (!isCents(cents, DISPLAY_MAX_CENTS)) return null
  const reais = Math.floor(cents / 100)
  const frac = String(cents % 100).padStart(2, '0')
  const digits = String(reais)
  let grouped = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += '.'
    grouped += digits[i]
  }
  return 'R$ ' + grouped + ',' + frac
}

// Hodle's pixKeyType on the wire. A random key is RANDOM; the label is what the screen shows.
export const PIX_KEY_LABELS = Object.freeze({
  PHONE: 'telefone',
  CPF: 'CPF',
  EMAIL: 'e-mail',
  RANDOM: 'chave aleatória',
  CNPJ: 'CNPJ'
})

// The service's pattern (wallet-routes.js and hodle.js PIX_KEY_RES EMAIL).
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,252}\.[A-Za-z]{2,24}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MOBILE_RE = /^(?:1[1-9]|[2-9]\d)9\d{8}$/

function canonicalPhone (text) {
  const trimmed = text.trim()
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null
  const compact = trimmed.replace(/[\s().-]/g, '')
  if (MOBILE_RE.test(compact)) return '+55' + compact
  const match = /^(?:\+55|0055|055|55)(0?\d{10,11})$/.exec(compact)
  if (!match) return null
  const national = match[1].replace(/^0/, '')
  if (!/^(?:1[1-9]|[2-9]\d)(?:\d{8}|9\d{8})$/.test(national)) return null
  return '+55' + national
}

function isCnpjDigits (digits) {
  if (!/^[0-9]{14}$/.test(digits) || /^([0-9])\1{13}$/.test(digits)) return false
  for (let length = 12; length <= 13; length++) {
    let sum = 0
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * ((length - 1 - i) % 8 + 2)
    const remainder = sum % 11
    if (Number(digits[length]) !== (remainder < 2 ? 0 : 11 - remainder)) return false
  }
  return true
}

export function pixKeyCandidates (text) {
  if (typeof text !== 'string') return Object.freeze([])
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 120) return Object.freeze([])
  if (UUID_RE.test(trimmed)) return Object.freeze(['RANDOM'])
  if (trimmed.includes('@')) return Object.freeze(trimmed.length <= 77 && EMAIL_RE.test(trimmed) ? ['EMAIL'] : [])
  const digits = trimmed.replace(/\D/g, '')
  // Punctuation cannot disambiguate a national number that is also a valid CPF.
  if (/^[\d\s().-]+$/.test(trimmed) && digits.length === 11) {
    const candidates = []
    if (isCpf(digits)) candidates.push('CPF')
    if (MOBILE_RE.test(digits)) candidates.push('PHONE')
    return Object.freeze(candidates)
  }
  const cnpjShape = /^[\d./-]+$/.test(trimmed) && digits.length === 14
  // The separators canonicalPhone strips, plus the slash: a spaced CNPJ must
  // not fall through to a phone-only answer.
  const validCnpj = /^[\d\s()./-]+$/.test(trimmed) && digits.length === 14 && isCnpjDigits(digits)
  if (canonicalPhone(trimmed)) {
    // A valid CNPJ typed without the slash can also read as a +55 number.
    return Object.freeze(validCnpj ? ['CNPJ', 'PHONE'] : ['PHONE'])
  }
  if (cnpjShape || validCnpj) return Object.freeze(['CNPJ'])
  return Object.freeze([])
}

export function pixKeyType (text) {
  const candidates = pixKeyCandidates(text)
  return candidates.length === 1 ? candidates[0] : null
}

// What the payout request sends. The mask below is only the field punctuation.
export function canonicalPixKey (text, type = pixKeyType(text)) {
  if (!pixKeyCandidates(text).includes(type)) return null
  if (type === 'CPF') return cpfDigits(text.trim())
  if (type === 'CNPJ') return text.trim().replace(/\D/g, '')
  if (type === 'PHONE') return canonicalPhone(text)
  if (type === 'EMAIL') return text.trim()
  if (type === 'RANDOM') return text.trim().toLowerCase()
  return null
}

export function maskPixKey (key, type) {
  const canonical = canonicalPixKey(key, type)
  if (canonical === null) return ''
  if (type === 'CPF') {
    return canonical.slice(0, 3) + '.' + canonical.slice(3, 6) + '.' + canonical.slice(6, 9) + '-' + canonical.slice(9)
  }
  if (type === 'CNPJ') {
    return canonical.slice(0, 2) + '.' + canonical.slice(2, 5) + '.' + canonical.slice(5, 8) + '/' + canonical.slice(8, 12) + '-' + canonical.slice(12)
  }
  if (type === 'PHONE') {
    const national = canonical.slice(3)
    const ddd = national.slice(0, 2)
    const rest = national.slice(2)
    const split = rest.length === 9 ? 5 : 4
    return '+55 (' + ddd + ') ' + rest.slice(0, split) + '-' + rest.slice(split)
  }
  return canonical
}

// The screen mints this with crypto.getRandomValues. The helper stays free of that API.
export const OP_ID_RE = /^[A-Za-z0-9_-]{22,43}$/

function centsOf (obj, key) {
  if (!obj || typeof obj !== 'object' || !Object.hasOwn(obj, key)) return null
  return isCents(obj[key], PREVIEW_MAX_CENTS) ? obj[key] : null
}

function feeLine (label, value) {
  return Object.freeze({ label, value })
}

// Prints the server preview as given. Recomputing the rate here would let the
// screen show a different charge from the one the PIN confirms.
export function feeLines (preview) {
  const amount = centsOf(preview, 'amountCents')
  const varanda = centsOf(preview, 'varandaFeeCents')
  const hodle = centsOf(preview, 'hodleFeeCents')
  const pending = centsOf(preview, 'pendingFeeCents')
  const total = centsOf(preview, 'totalDebitCents')
  const net = centsOf(preview, 'netReceivedCents')
  if (amount === null || varanda === null || hodle === null || pending === null || total === null || net === null) return null
  const lines = [
    feeLine('Valor', formatBrl(amount)),
    // The new fee leaves only after the Pix concludes, in a later send.
    feeLine(varanda === 0 ? 'Taxa da Varanda' : 'Taxa da Varanda (cobrada depois que o Pix for concluído)', varanda === 0 ? 'sem taxa' : formatBrl(varanda)),
    feeLine('Taxa do parceiro', formatBrl(hodle))
  ]
  if (pending > 0) lines.push(feeLine('Taxas pendentes', formatBrl(pending)))
  lines.push(feeLine('Total debitado', formatBrl(total)))
  lines.push(feeLine('Quem recebe ganha', formatBrl(net)))
  return Object.freeze(lines)
}

export const UNCERTAIN_MONEY = 'Não deu para confirmar se o envio foi feito. Confira o extrato antes de repetir: nada é reenviado sozinho.'

export const OP_STATUS_TEXTS = Object.freeze({
  enviado: 'Pedido enviado. A confirmação ainda não chegou.',
  incerto: UNCERTAIN_MONEY,
  pendente: 'Em andamento.',
  concluido: 'Concluído.',
  falhou: 'Não foi feito.',
  devolvido: 'Devolvido.',
  // Not final: a late Pix is still honored.
  expirado: 'O código Pix expirou. Se você pagou, o valor aparece aqui quando o banco confirmar.'
})

export function opStatusText (kind, status) {
  // A failed deposit still settles (concluido or devolvido).
  if (kind === 'deposit' && status === 'falhou') return 'Este recebimento ainda não foi concluído. Se você pagou o código, o valor entra na conta ou volta para quem pagou.'
  return typeof status === 'string' && Object.hasOwn(OP_STATUS_TEXTS, status) ? OP_STATUS_TEXTS[status] : undefined
}

export const DISPUTE_TEXTS = Object.freeze({
  aberta: 'Contestação em análise.',
  aceita: 'Contestação aceita.',
  rejeitada: 'Contestação não aceita.',
  cancelada: 'A contestação foi retirada.'
})

export const FEE_STATUS_TEXTS = Object.freeze({
  cobrada: 'Taxa cobrada.',
  pendente: 'Taxa pendente: será cobrada num próximo envio seu, depois que o Pix for concluído. Se ele falhar ou voltar antes, não é cobrada.',
  incerta: 'Não deu para confirmar se a taxa foi cobrada. Confira o extrato: nada é cobrado sozinho.',
  enviada: 'Taxa enviada; aguardando confirmação.'
})

export const RECEIVE_TEXTS = Object.freeze({
  ONE_CHARGE: 'Este código Pix vale para um único valor. Não é uma chave permanente da sua conta.',
  OWN_CPF: 'Por padrão, só o seu CPF pode pagar este Pix.',
  OTHER_CPF: 'Para receber de outra pessoa, informe o CPF dela. Esse CPF vai só para a Hodle, para autorizar esse Pix.',
  NO_VARANDA_FEE: 'Nesta versão, receber não tem taxa da Varanda.',
  EXPIRY: 'O código deixa de valer no horário mostrado. Depois disso, gere outro.'
})

// The two amounts are the deposit response. This does not decide how much of
// the Pix the partner keeps; that split is already in the response.
export function depositArrivalText (hodleFeeCents, netCents) {
  if (!isCents(hodleFeeCents) || !isCents(netCents)) return null
  return 'Taxa do parceiro: ' + formatBrl(hodleFeeCents) + '. Chega na sua conta: ' + formatBrl(netCents) + ' em BRLA'
}

export const PAY_TEXTS = Object.freeze({
  BEFORE_PIN: 'Antes do PIN, a conferência mostra quem recebe, a taxa do parceiro, a taxa da Varanda e o total debitado.',
  OTHER_CPF: 'Pagar a outra pessoa pede o CPF de quem recebe.',
  cap (maxCents) {
    const formatted = formatBrl(maxCents)
    return formatted === null ? null : 'O limite por operação é ' + formatted + '.'
  }
})
