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
  OPTIN_WHAT: 'Você pode abrir uma conta ligada ao seu @nome para, nas próximas versões, receber e enviar dinheiro por Pix. É opcional: a Varanda continua funcionando igual sem ela.',
  OPTIN_KYC: 'Para abrir a conta, a lei pede uma verificação de identidade (KYC), feita pela Hodle, empresa parceira. Você vai enviar nome completo, CPF, data de nascimento, e-mail, endereço, a foto de um documento e uma selfie com prova de vida.',
  OPTIN_DATA: 'Esses dados vão para a Hodle e seus parceiros regulados; as fotos vão do seu navegador direto para a Hodle. A Varanda guarda só os identificadores da conta e da carteira e o estado da verificação. A Varanda nunca guarda sua senha de 6 dígitos (PIN), seu CPF, suas fotos nem seu endereço.',
  OPTIN_PERMANENT: 'A conta criada na Hodle não pode ser apagada depois.',
  OPTIN_MONEY: 'O dinheiro fica em BRLA, uma moeda digital que vale 1 real, emitida pela Avenia, numa carteira em seu nome. A Varanda não é banco e o saldo não rende juros.',
  OPTIN_FEES: 'Quando enviar dinheiro estiver disponível, a Varanda poderá cobrar uma taxa própria, sempre mostrada antes de você confirmar.',
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
  indisponivel: 'A conta de pagamentos está indisponível agora. Tente mais tarde.'
})

export function walletErrorText (err) {
  // An outcome that may have happened gets the caller's uncertain text, never a retry hint.
  if (err?.uncertain === true) return null
  const code = err?.code
  return typeof code === 'string' && Object.hasOwn(ERROR_TEXTS, code) ? ERROR_TEXTS[code] : null
}
