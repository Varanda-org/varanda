'use strict'

const test = require('brittle')
const { createHash, randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/wallet.js')
const policy = { available: true, mode: 'carteira' }
const account = (state, extra = {}) => ({ kyc: { state, attempt: 1 }, ...extra })

test('wallet: pure ES module loads in Node without imports', async (t) => {
  const wallet = await load()
  t.alike(Object.keys(wallet).sort(), [
    'DISPUTE_TEXTS', 'FEE_STATUS_TEXTS', 'KYC_STATES', 'MIN_DEPOSIT_CENTS', 'MIN_PAYOUT_CENTS',
    'OP_ID_RE', 'OP_STATUS_TEXTS', 'PAY_TEXTS', 'PIX_KEY_LABELS', 'RECEIVE_TEXTS', 'TEXTS',
    'UNCERTAIN_MONEY', 'canonicalJson', 'canonicalPixKey', 'cepDigits', 'cpfDigits',
    'depositArrivalText', 'feeLines', 'formatBrl', 'isBirthDate', 'isCep', 'isCpf', 'isPin',
    'maskPixKey', 'opStatusText', 'parseBrl', 'pixKeyCandidates', 'pixKeyType', 'walletErrorText', 'walletStep'
  ].sort())
  const source = readFileSync(join(__dirname, '../src/wallet.js'), 'utf8')
  t.absent(/\b(?:import|require)\s*(?:\(|[{*'"\w])/.test(source))
  t.absent(source.includes(String.fromCharCode(0x2014)))
  t.ok(Object.isFrozen(wallet.KYC_STATES))
  t.alike([...wallet.KYC_STATES], ['documentos', 'pendente', 'aprovado', 'recusado', 'expirado'])
  t.absent(wallet.KYC_STATES.includes('dados'))
})

test('walletStep: only explicit availability opens onboarding', async (t) => {
  const { walletStep } = await load()
  t.is(walletStep(), 'off')
  for (const unavailable of [undefined, null, {}, { available: false }, { available: 'true' }, { available: 1 }]) {
    for (const value of [undefined, null, account('aprovado', { wallet: { id: 'test-wallet' } })]) {
      t.is(walletStep({ policy: unavailable, account: value }), 'off')
    }
  }
  t.is(walletStep({ policy }), 'loading')
  t.is(walletStep({ policy, account: null }), 'explicar')
})

test('walletStep: document and selfie readiness are both required for form entry', async (t) => {
  const { walletStep } = await load()
  for (const state of ['documentos']) {
    for (const documentReady of [undefined, false, true, 1, 'true']) {
      for (const selfieReady of [undefined, false, true, 1, 'true']) {
        t.is(walletStep({ policy, account: account(state, { documentReady, selfieReady }) }),
          documentReady === true && selfieReady === true ? 'dados' : 'documentos')
      }
    }
  }
})

test('walletStep: pending, rejected, expired and unknown verification states', async (t) => {
  const { walletStep } = await load()
  for (const state of ['recusado', 'expirado']) {
    t.is(walletStep({ policy, account: account(state) }), state)
    t.is(walletStep({ policy, account: account(state, { wallet: { id: 'test-wallet' } }) }), state)
  }
  for (const state of ['pendente', 'dados', undefined, null, 'Approved', 'outro']) {
    t.is(walletStep({ policy, account: account(state, { documentReady: true, selfieReady: true }) }), 'aguardando')
  }
  for (const value of [{}, { kyc: null }, { kyc: 'aprovado' }, false]) {
    t.is(walletStep({ policy, account: value }), 'aguardando')
  }
})

test('walletStep: C11 defaults to registration and gates wallet creation by mode', async (t) => {
  const { walletStep, TEXTS } = await load()
  for (const mode of [undefined, null, '', 'cadastro', 'Carteira', 'outro']) {
    t.is(walletStep({ policy: { available: true, mode }, account: account('aprovado') }), 'aguardando-carteira')
  }
  for (const mode of ['carteira', 'pix', 'completo']) {
    t.is(walletStep({ policy: { available: true, mode }, account: account('aprovado') }), 'pin')
  }
  t.is(TEXTS.KYC_APPROVED, 'Verificação aprovada. A carteira será liberada em breve.')
})

test('walletStep: existing wallets and uncertain creation do not invite creation again', async (t) => {
  const { walletStep } = await load()
  for (const mode of ['cadastro', 'carteira', 'pix', 'completo']) {
    const p = { available: true, mode }
    t.is(walletStep({ policy: p, account: account('aprovado', { wallet: { id: 'test-wallet' } }) }), 'pronto')
    t.is(walletStep({ policy: p, account: account('aprovado', { walletUncertain: true }) }), 'incerto')
    t.is(walletStep({ policy: p, account: account('aprovado', { wallet: { id: 'test-wallet' }, walletUncertain: true }) }), 'incerto')
  }
  t.is(walletStep({ policy, account: account('aprovado', { wallet: null, walletUncertain: false }) }), 'pin')
})

test('walletStep: a lost subaccount create is frozen before any KYC branch', async (t) => {
  const { walletStep } = await load()
  for (const mode of ['cadastro', 'carteira']) {
    const p = { available: true, mode }
    for (const state of ['documentos', 'pendente', 'aprovado', 'recusado', 'expirado', undefined]) {
      t.is(walletStep({ policy: p, account: account(state, { subaccountUncertain: true }) }), 'incerto')
      t.is(walletStep({ policy: p, account: account(state, { subaccountUncertain: true, documentReady: true, selfieReady: true }) }), 'incerto')
    }
    t.is(walletStep({ policy: p, account: { subaccountUncertain: true } }), 'incerto')
  }
  for (const value of [false, 'true', 1, undefined]) {
    t.is(walletStep({ policy, account: account('documentos', { subaccountUncertain: value }) }), 'documentos')
  }
})

test('walletStep: C14 follows the current attempt without retaining an earlier outcome', async (t) => {
  const { walletStep } = await load()
  for (const previous of ['recusado', 'expirado']) {
    t.is(walletStep({ policy, account: account(previous) }), previous)
    const current = Object.freeze({
      kyc: Object.freeze({ state: 'documentos', attempt: 2 }),
      documentReady: false,
      selfieReady: false
    })
    t.is(walletStep({ policy, account: current }), 'documentos')
    t.is(walletStep({ policy, account: { ...current, documentReady: true } }), 'documentos')
    t.is(walletStep({ policy, account: { ...current, documentReady: true, selfieReady: true } }), 'dados')
    t.is(current.kyc.attempt, 2)
    t.is(current.kyc.state, 'documentos')
  }
})

test('isPin: six ASCII digits, no repeated digits or ascending or descending runs', async (t) => {
  const { isPin } = await load()
  for (const value of [undefined, null, 246802, {}, [], '', '12345', '1234567', ' 246802', '246802\n', '１２３４５６', 'abcdef']) {
    t.is(isPin(value), false)
  }
  for (let digit = 0; digit <= 9; digit++) t.is(isPin(String(digit).repeat(6)), false)
  for (let start = 0; start <= 4; start++) {
    const run = '0123456789'.slice(start, start + 6)
    t.is(isPin(run), false)
    t.is(isPin([...run].reverse().join('')), false)
  }
  for (const value of ['024680', '246802', '112233', '987650']) t.is(isPin(value), true)
})

// Synthetic check digits avoid using anyone's identity in fixtures.
function syntheticCpf (base) {
  let digits = base
  while (digits.length < 11) {
    let sum = 0
    for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (digits.length + 1 - i)
    digits += String((sum * 10 % 11) % 10)
  }
  return digits
}

test('isCpf and cpfDigits: check digits, masks, repeated digits and malformed input', async (t) => {
  const { isCpf, cpfDigits } = await load()
  for (const base of ['123456789', '012345678', '987654321', '100000000']) {
    const value = syntheticCpf(base)
    const masked = value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
    t.is(isCpf(value), true)
    t.is(isCpf(masked), true)
    t.ok(cpfDigits(masked) === value)
    for (const position of [9, 10]) {
      const changed = value.slice(0, position) + ((Number(value[position]) + 1) % 10) + value.slice(position + 1)
      t.is(isCpf(changed), false)
    }
    t.is(isCpf('x' + value), false)
  }
  for (let digit = 0; digit <= 9; digit++) t.is(isCpf(String(digit).repeat(11)), false)
  for (const value of [undefined, null, 123, {}, [], '', '123', '123.456.789-0', '１２３４５６７８９０１']) {
    t.is(isCpf(value), false)
  }
  for (const value of [undefined, null, 123, {}, []]) t.is(cpfDigits(value), '')
  t.is(cpfDigits(''), '')
})

test('isBirthDate: exact eighteenth birthday on the Brasília calendar, real dates and leap years', async (t) => {
  const { isBirthDate } = await load()
  t.is(isBirthDate('2008-10-31', Date.parse('2026-10-31T02:00:00Z')), false)
  t.is(isBirthDate('2008-10-31', Date.parse('2026-10-31T03:00:00Z')), true)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-29T23:59:59.999Z')), false)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T00:00:00.000Z')), false)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T02:59:59.999Z')), false)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T03:00:00.000Z')), true)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-29T23:59:59-03:00')), false)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T00:00:00-03:00')), true)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T05:59:59+03:00')), false)
  t.is(isBirthDate('2008-10-30', Date.parse('2026-10-30T06:00:00+03:00')), true)
  t.is(isBirthDate('2008-12-31', Date.parse('2026-01-01T00:00:00Z')), false)
  t.is(isBirthDate('2008-02-29', Date.parse('2026-03-01T02:59:59.999Z')), false)
  t.is(isBirthDate('2008-02-29', Date.parse('2026-03-01T03:00:00Z')), true)
  t.is(isBirthDate('2000-02-29', Date.parse('2026-10-30T00:00:00Z')), true)
  t.is(isBirthDate('1900-01-01'), true)
  for (const value of [undefined, null, 20000101, {}, [], '', '2000-2-01', '2000-02-1', '2000-01-01\n',
    '2001-02-29', '1900-02-29', '2000-02-30', '2000-04-31', '2000-00-01', '2000-13-01', '2000-01-00',
    '0000-01-01', '30/10/2000', '2000-01-01T00:00:00Z', '2026-10-31']) {
    t.is(isBirthDate(value, Date.parse('2026-10-30T00:00:00Z')), false)
  }
  t.is(isBirthDate('2000-01-01', NaN), false)
})

test('isCep and cepDigits: eight ASCII digits, with or without the hyphen mask', async (t) => {
  const { isCep, cepDigits } = await load()
  for (const [value, digits] of [['01234567', '01234567'], ['12345678', '12345678'], ['01000-000', '01000000'], ['12345-678', '12345678']]) {
    t.is(isCep(value), true)
    t.is(cepDigits(value), digits)
  }
  for (const value of [undefined, null, 12345678, {}, [], '', '1234567', '123456789', '1234-5678', '123456-78',
    '12345--678', '12.345-678', '12345 678', '12345678\n', '１２３４５６７８']) {
    t.is(isCep(value), false)
    t.is(cepDigits(value), '')
  }
})

test('canonicalJson: C16 UTF-16 key order and pinned UTF-8 SHA-256 vector', async (t) => {
  const { canonicalJson } = await load()
  const input = Object.freeze({ z: 'fim', á: 'ação', a: 'linha\n"aspas"', 2: 'dois', 10: 'dez', '😀': 'rosto', '\uE000': 'privado' })
  const expected = '{"10":"dez","2":"dois","a":"linha\\n\\"aspas\\"","z":"fim","á":"ação","😀":"rosto","\uE000":"privado"}'
  const hash = '000885f86d0a62f19f7a29a0d3ab17994d8316253310494a9fd57f7780717333'
  const json = canonicalJson(input)
  t.is(json, expected)
  t.is(createHash('sha256').update(json, 'utf8').digest('hex'), hash)
  t.is(canonicalJson(Object.fromEntries(Object.entries(input).reverse())), expected)
  t.alike(JSON.parse(json), input)
  t.is(canonicalJson({}), '{}')
  t.is(canonicalJson(Object.assign(Object.create(null), { b: '', a: ' ' })), '{"a":" ","b":""}')
  t.is(canonicalJson(JSON.parse('{"__proto__":"text","a":"value"}')), '{"__proto__":"text","a":"value"}')
})

test('canonicalJson: rejects nonobjects and nonstring values', async (t) => {
  const { canonicalJson } = await load()
  for (const value of [undefined, null, [], 'text', 3, true, new Date(0), Object.create({ a: 'inherited' })]) {
    await t.exception.all(() => canonicalJson(value), TypeError)
  }
  for (const value of [undefined, null, [], {}, 3, true, NaN, Symbol('test'), () => 'text']) {
    await t.exception.all(() => canonicalJson({ a: value }), TypeError)
  }
})

test('walletErrorText: only fixed known errors, never provider text', async (t) => {
  const { walletErrorText, TEXTS } = await load()
  const expected = {
    'kyc-pendente': 'A verificação de identidade ainda não terminou.',
    'kyc-recusado': TEXTS.KYC_REJECTED,
    'documentos-pendentes': 'Envie a foto do documento e termine a selfie para continuar.',
    'pin-invalido': 'A senha de 6 dígitos não foi aceita. Confira a senha antes de continuar.',
    'pin-bloqueado': 'A senha foi bloqueada após três erros. Aguarde 24 horas.',
    'carteira-pendente': 'Abra a conta de pagamentos antes.',
    'aguardando-carteira': 'Verificação aprovada. A carteira será liberada em breve.',
    'carteira-incerta': TEXTS.UNCERTAIN_CREATE,
    'termos-pendentes': 'Leia e aceite os termos da conta de pagamentos para continuar.',
    'limite-carteira': 'Você atingiu o limite de pedidos da conta de pagamentos. Tente mais tarde.',
    'idade-minima': TEXTS.UNDER_18,
    indisponivel: 'A conta de pagamentos está indisponível agora. Tente mais tarde.',
    'saldo-insuficiente': 'Saldo insuficiente. O saldo precisa cobrir também as taxas pendentes.',
    'valor-invalido': 'Valor inválido.',
    'destino-invalido': 'Destino inválido.',
    'taxa-mudou': 'A taxa mudou. Confira de novo antes de confirmar.'
  }
  for (const [code, text] of Object.entries(expected)) {
    t.is(walletErrorText({ code, message: 'untrusted provider message' }), text)
    t.absent(text.includes(String.fromCharCode(0x2014)))
  }
  // A missing subaccount and an opt-in with nothing in review must not read as approval or review.
  t.not(walletErrorText({ code: 'carteira-pendente' }), TEXTS.KYC_APPROVED)
  t.is(walletErrorText({ code: 'aguardando-carteira' }), TEXTS.KYC_APPROVED)
  t.absent(walletErrorText({ code: 'kyc-pendente' }).includes('análise'))
  for (const code of Object.keys(expected)) {
    t.is(walletErrorText({ code, uncertain: true }), null)
    t.is(walletErrorText({ code, uncertain: false }), expected[code])
  }
  for (const err of [undefined, null, {}, 'indisponivel', { code: 'outro' }, { code: 'resultado-incerto', uncertain: true },
    { code: '__proto__' }, { code: 'constructor' }, { code: 'toString' }, { code: ['indisponivel'] }]) {
    t.is(walletErrorText(err), null)
  }
})

test('TEXTS: frozen disclosures, no em dash or yield promises', async (t) => {
  const { TEXTS } = await load()
  t.ok(Object.isFrozen(TEXTS))
  t.alike(Object.keys(TEXTS).sort(), [
    'OPTIN_TITLE', 'OPTIN_WHAT', 'OPTIN_KYC', 'OPTIN_DATA', 'OPTIN_PERMANENT', 'OPTIN_MONEY', 'OPTIN_FEES',
    'OPTIN_SKIP', 'OPTIN_START', 'PIN_HINT', 'KYC_WAIT', 'KYC_REJECTED', 'KYC_APPROVED', 'LIVENESS_OPEN',
    'UNDER_18', 'UNCERTAIN_CREATE'
  ].sort())
  t.is(TEXTS.OPTIN_TITLE, 'Conta de pagamentos (opcional)')
  t.is(TEXTS.OPTIN_WHAT, 'Você pode abrir uma conta ligada ao seu @nome para receber e enviar dinheiro por Pix, quando o serviço liberar. É opcional: a Varanda continua funcionando igual sem ela.')
  t.is(TEXTS.OPTIN_KYC, 'Para abrir a conta, a lei pede uma verificação de identidade (KYC), feita pela Hodle, empresa parceira. Você vai enviar nome completo, CPF, data de nascimento, e-mail, endereço, a foto de um documento e uma selfie com prova de vida.')
  t.is(TEXTS.OPTIN_DATA, 'Esses dados vão para a Hodle e seus parceiros regulados; as fotos vão do seu navegador direto para a Hodle. A Varanda guarda só os identificadores da conta e da carteira e o estado da verificação. A Varanda nunca guarda sua senha de 6 dígitos (PIN), seu CPF, suas fotos nem seu endereço.')
  t.is(TEXTS.OPTIN_PERMANENT, 'A conta criada na Hodle não pode ser apagada depois.')
  t.is(TEXTS.OPTIN_MONEY, 'O dinheiro fica em BRLA, uma moeda digital que vale 1 real, emitida pela Avenia, numa carteira em seu nome. A Varanda não é banco e o saldo não rende juros.')
  t.is(TEXTS.OPTIN_FEES, 'Em alguns envios a Varanda cobra uma taxa própria, sempre mostrada antes de você confirmar, junto com a taxa do parceiro e o total.')
  t.is(TEXTS.OPTIN_SKIP, 'Deixar para depois')
  t.is(TEXTS.OPTIN_START, 'Quero abrir a conta')
  t.is(TEXTS.LIVENESS_OPEN, 'A selfie é feita numa página da Hodle, que abre em outra janela. Quando terminar, volte aqui e toque em Já terminei.')
  t.is(TEXTS.UNCERTAIN_CREATE, 'Não deu para confirmar se a conta ou a carteira foi criada. Aguarde e toque em Conferir; nada é refeito sozinho.')
  for (const fragment of ['6 dígitos', 'toda vez que enviar', 'Ninguém na Varanda pode ver ou recuperar', 'Três erros', '24 horas']) {
    t.ok(TEXTS.PIN_HINT.includes(fragment))
  }
  t.ok(TEXTS.UNDER_18.includes('18 anos'))
  for (const text of Object.values(TEXTS)) {
    t.is(typeof text, 'string')
    t.ok(text.length > 0)
    t.absent(text.includes(String.fromCharCode(0x2014)))
    t.absent(/rende|juros/i.test(text.replace('não rende juros', '')))
  }
})

test('parseBrl: reais and centavos, thousands, R$ and the ceiling', async (t) => {
  const { parseBrl } = await load()
  t.is(parseBrl('12'), 1200)
  t.is(parseBrl('12,50'), 1250)
  t.is(parseBrl('12,5'), 1250)
  t.is(parseBrl('R$ 12,50'), 1250)
  t.is(parseBrl('R$12,50'), 1250)
  t.is(parseBrl('r$ 12,50'), 1250)
  t.is(parseBrl('1.234,56'), 123456)
  t.is(parseBrl('R$ 1.234,56'), 123456)
  t.is(parseBrl('R$\u00a01.234,56'), 123456)
  t.is(parseBrl('  12,50  '), 1250)
  t.is(parseBrl('0'), 0)
  t.is(parseBrl('0,00'), 0)
  t.is(parseBrl('0,01'), 1)
  t.is(parseBrl('00,50'), 50)
  t.is(parseBrl('12.345'), 1234500)
  t.is(parseBrl('999.999,99'), 99999999)
  t.is(parseBrl('1.000.000,00'), 100000000)
  t.is(parseBrl('1.000.000'), 100000000)
  for (const value of [undefined, null, 12, 12.5, {}, [], '', ' ', 'R$', '12,', ',50', '.50',
    '12.50', '1,234.56', '1.234,567', '12,500', '0,001', '1.000.000,01', '100000000',
    '-1', 'R$ -1,00', '-0,01', '+12', '12,50 reais', '１2', '1 234,56', '12,50\nextra',
    'R$ R$ 12', '\u221212,00']) {
    t.is(parseBrl(value), null)
  }
})

test('formatBrl: grouped reais and two decimals, or null', async (t) => {
  const { formatBrl, parseBrl } = await load()
  t.is(formatBrl(0), 'R$ 0,00')
  t.is(formatBrl(1), 'R$ 0,01')
  t.is(formatBrl(10), 'R$ 0,10')
  t.is(formatBrl(100), 'R$ 1,00')
  t.is(formatBrl(1200), 'R$ 12,00')
  t.is(formatBrl(123456), 'R$ 1.234,56')
  t.is(formatBrl(100000), 'R$ 1.000,00')
  t.is(formatBrl(1234500), 'R$ 12.345,00')
  t.is(formatBrl(100000000), 'R$ 1.000.000,00')
  t.is(formatBrl(100000001), 'R$ 1.000.000,01')
  t.is(formatBrl(9999999999), 'R$ 99.999.999,99')
  t.is(formatBrl(10000000000), 'R$ 100.000.000,00')
  t.is(formatBrl(10000000001), 'R$ 100.000.000,01')
  t.is(formatBrl(Number.MAX_SAFE_INTEGER), 'R$ 90.071.992.547.409,91')
  t.is(formatBrl(parseBrl('R$ 1.234,56')), 'R$ 1.234,56')
  for (const value of [undefined, null, -1, 1.5, NaN, Infinity, '100', 10000000000.5, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(formatBrl(value), null)
  }
})

test('deposit and payout minimums are the Hodle floors', async (t) => {
  const { MIN_DEPOSIT_CENTS, MIN_PAYOUT_CENTS } = await load()
  t.is(MIN_DEPOSIT_CENTS, 100)
  t.is(MIN_PAYOUT_CENTS, 10)
})

test('pixKeyType: every Hodle kind, and a bad CPF stays null', async (t) => {
  const { pixKeyType, canonicalPixKey, maskPixKey, PIX_KEY_LABELS, isCpf } = await load()
  t.alike(Object.keys(PIX_KEY_LABELS).sort(), ['CNPJ', 'CPF', 'EMAIL', 'PHONE', 'RANDOM'].sort())
  t.ok(Object.isFrozen(PIX_KEY_LABELS))
  t.is(PIX_KEY_LABELS.RANDOM, 'chave aleatória')
  t.absent(Object.values(PIX_KEY_LABELS).includes('EVP'))
  const source = readFileSync(join(__dirname, '../src/wallet.js'), 'utf8')
  t.absent(source.includes('EVP'))

  const cpf = syntheticCpf('123456789')
  const maskedCpf = cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  t.is(isCpf(cpf), true)
  t.is(pixKeyType(cpf), 'CPF')
  t.is(pixKeyType(maskedCpf), 'CPF')
  t.is(canonicalPixKey(maskedCpf), cpf)
  t.is(maskPixKey(cpf, 'CPF'), maskedCpf)
  t.is(maskPixKey(maskedCpf, 'CPF'), maskedCpf)
  const badCpf = cpf.slice(0, 10) + ((Number(cpf[10]) + 1) % 10)
  t.is(isCpf(badCpf), false)
  t.is(pixKeyType(badCpf), null)
  t.is(pixKeyType('11111111111'), null)
  t.is(canonicalPixKey(badCpf), null)
  t.is(maskPixKey(badCpf, 'CPF'), '')

  const cnpj = '12345678000199'
  const maskedCnpj = '12.345.678/0001-99'
  t.is(pixKeyType(cnpj), 'CNPJ')
  t.is(pixKeyType(maskedCnpj), 'CNPJ')
  t.is(canonicalPixKey(maskedCnpj), cnpj)
  t.is(maskPixKey(cnpj, 'CNPJ'), maskedCnpj)
  t.is(pixKeyType('1234567800019'), null)
  t.is(pixKeyType('123456780001991'), null)
  t.is(pixKeyType('123.456.789/01'), null)

  const email = 'pessoa@exemplo.com'
  t.is(pixKeyType(email), 'EMAIL')
  t.is(pixKeyType('  Pessoa@Exemplo.com  '), 'EMAIL')
  t.is(canonicalPixKey('  Pessoa@Exemplo.com  '), 'Pessoa@Exemplo.com')
  t.is(maskPixKey(email, 'EMAIL'), email)
  t.is(pixKeyType('pessoa@exemplo'), null)
  t.is(pixKeyType('pessoa@@exemplo.com'), null)
  t.is(pixKeyType('a'.repeat(70) + '@exemplo.com'), null)
  // The service's pattern: a letters-only TLD of 2 to 24 and a local part of at most 64.
  t.is(pixKeyType('a'.repeat(64) + '@ex.com'), 'EMAIL')
  t.is(pixKeyType('a'.repeat(65) + '@ex.com'), null)
  t.is(pixKeyType('pessoa@exemplo.123'), null)
  t.is(pixKeyType('pessoa@10.0.0.1'), null)
  t.is(pixKeyType('pessoa@exemplo.c'), null)
  t.is(pixKeyType('pessoa@exemplo.' + 'c'.repeat(25)), null)
  t.is(pixKeyType('pessoa@sub.exemplo.com.br'), 'EMAIL')

  const mobile = '+5511987654321'
  t.is(pixKeyType(mobile), 'PHONE')
  t.is(pixKeyType('+55 (11) 98765-4321'), 'PHONE')
  t.is(pixKeyType('55 11 98765-4321'), 'PHONE')
  t.is(pixKeyType('5511987654321'), 'PHONE')
  t.is(canonicalPixKey('+55 (11) 98765-4321'), mobile)
  t.is(maskPixKey('5511987654321', 'PHONE'), '+55 (11) 98765-4321')
  t.is(pixKeyType('+551133334444'), 'PHONE')
  t.is(canonicalPixKey('+55 (11) 3333-4444'), '+551133334444')
  t.is(maskPixKey('+551133334444', 'PHONE'), '+55 (11) 3333-4444')
  t.is(pixKeyType('11987654321'), 'PHONE')
  t.is(pixKeyType('+5511'), null)
  t.is(pixKeyType('+55 11 98765-43210'), null)
  t.is(pixKeyType('+5411987654321'), null)
  t.is(maskPixKey(mobile, 'CPF'), '')

  const uuid = '550E8400-E29B-41D4-A716-446655440000'
  t.is(pixKeyType(uuid), 'RANDOM')
  t.is(pixKeyType('123e4567-e89b-12d3-a456-426614174000'), 'RANDOM')
  t.is(canonicalPixKey(uuid), uuid.toLowerCase())
  t.is(maskPixKey(uuid, 'RANDOM'), uuid.toLowerCase())
  t.is(pixKeyType('550e8400e29b41d4a716446655440000'), null)
  t.is(pixKeyType('550e8400-e29b-41d4-a716-44665544000'), null)
  t.is(pixKeyType('RANDOM'), null)

  for (const value of [undefined, null, 11987654321, {}, [], '', '   ', 'chave']) {
    t.is(pixKeyType(value), null)
    t.is(canonicalPixKey(value), null)
    t.is(maskPixKey(value, 'EMAIL'), '')
  }
})

test('Pix candidates preserve CPF and mobile ambiguity until an explicit choice', async (t) => {
  const { pixKeyCandidates, pixKeyType, canonicalPixKey, maskPixKey } = await load()
  t.is(typeof pixKeyCandidates, 'function')
  if (typeof pixKeyCandidates !== 'function') return
  const cases = [
    ['11987654374', ['CPF', 'PHONE']],
    ['11987654321', ['PHONE']],
    [syntheticCpf('123456789'), ['CPF']],
    ['11111111111', []],
    ['10987654321', []],
    ['1198765432', []]
  ]
  for (const [digits, expected] of cases) {
    const spellings = [
      digits,
      digits.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3'),
      digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
    ]
    for (const text of spellings) {
      const candidates = pixKeyCandidates(text)
      t.alike(candidates, expected)
      t.ok(Object.isFrozen(candidates))
      t.is(pixKeyType(text), expected.length === 1 ? expected[0] : null)
      t.is(canonicalPixKey(text), expected.length === 1 ? (expected[0] === 'PHONE' ? '+55' + digits : digits) : null)
      t.is(canonicalPixKey(text, 'CPF'), expected.includes('CPF') ? digits : null)
      t.is(canonicalPixKey(text, 'PHONE'), expected.includes('PHONE') ? '+55' + digits : null)
      t.is(canonicalPixKey(text, 'CNPJ'), null)
    }
  }
  t.is(maskPixKey('11987654374', 'CPF'), '119.876.543-74')
  t.is(maskPixKey('119.876.543-74', 'PHONE'), '+55 (11) 98765-4374')
  for (const text of [undefined, null, 11987654374, {}, '', '119/876/54374']) {
    t.alike(pixKeyCandidates(text), [])
    t.ok(Object.isFrozen(pixKeyCandidates(text)))
    t.is(canonicalPixKey(text, 'CPF'), null)
    t.is(canonicalPixKey(text, 'PHONE'), null)
  }
})

test('Pix phone normalization removes one trunk zero and accepts country prefixes before CNPJ detection', async (t) => {
  const { pixKeyType, canonicalPixKey } = await load()
  const cases = [
    ['+55 (011) 3333-4444', '+551133334444'],
    ['0551133334444', '+551133334444'],
    ['00551133334444', '+551133334444'],
    ['05511987654321', '+5511987654321'],
    ['005511987654321', '+5511987654321'],
    ['55011987654321', '+5511987654321'],
    ['055011987654321', '+5511987654321'],
    ['0055011987654321', '+5511987654321'],
    ['+55 (011) 98765-4374', '+5511987654374']
  ]
  for (const [text, expected] of cases) {
    t.is(pixKeyType(text), 'PHONE')
    t.is(canonicalPixKey(text), expected)
    t.is(canonicalPixKey(text, 'PHONE'), expected)
    t.is(canonicalPixKey(text, 'CNPJ'), null)
  }
  for (const text of ['+55 (0011) 3333-4444', '+55 (10) 98765-4321', '+55 (11) 88765-4321']) {
    t.is(pixKeyType(text), null)
    t.is(canonicalPixKey(text, 'PHONE'), null)
  }
})

test('Pix candidates ask between CNPJ and phone for a valid CNPJ typed without the slash', async (t) => {
  const { pixKeyCandidates, pixKeyType, canonicalPixKey } = await load()
  for (const [text, phone] of [['00551198000100', '+551198000100'], ['55011987000131', '+5511987000131']]) {
    t.alike(pixKeyCandidates(text), ['CNPJ', 'PHONE'])
    t.ok(Object.isFrozen(pixKeyCandidates(text)))
    t.is(pixKeyType(text), null)
    t.is(canonicalPixKey(text), null)
    t.is(canonicalPixKey(text, 'CNPJ'), text)
    t.is(canonicalPixKey(text, 'PHONE'), phone)
  }
  const masked = '00.551.198/0001-00'
  t.alike(pixKeyCandidates(masked), ['CNPJ'])
  t.is(pixKeyType(masked), 'CNPJ')
  t.is(canonicalPixKey(masked), '00551198000100')
  t.is(canonicalPixKey(masked, 'PHONE'), null)
})

test('Pix candidates ask between CNPJ and phone for a valid CNPJ typed with spaces (R4)', async (t) => {
  const { pixKeyCandidates, pixKeyType, canonicalPixKey } = await load()
  for (const [text, digits, phone] of [
    ['00 551 198 0001 00', '00551198000100', '+551198000100'],
    ['55 011 987 0001 31', '55011987000131', '+5511987000131'],
    ['(00) 551-198 0001.00', '00551198000100', '+551198000100']
  ]) {
    t.alike(pixKeyCandidates(text), ['CNPJ', 'PHONE'], text)
    t.is(pixKeyType(text), null)
    t.is(canonicalPixKey(text, 'CNPJ'), digits)
    t.is(canonicalPixKey(text, 'PHONE'), phone)
  }
  const notPhone = '11 222 333 0001 81'
  t.alike(pixKeyCandidates(notPhone), ['CNPJ'], 'a spaced CNPJ that is not a phone')
  t.is(canonicalPixKey(notPhone), '11222333000181')
  t.alike(pixKeyCandidates('11 222 333/0001-81'), ['CNPJ'])
  t.alike(pixKeyCandidates('05511987654321'), ['PHONE'], 'a 14-digit phone that fails the CNPJ check stays PHONE')
  t.alike(pixKeyCandidates('055 1198 765 4321'), ['PHONE'])
  t.alike(pixKeyCandidates('11 222 333 0001 82'), [], 'a spaced invalid CNPJ that is not a phone is still refused')
})

test('OP_ID_RE matches the screen mint, 22 to 43 url-safe characters', async (t) => {
  const { OP_ID_RE } = await load()
  t.is(String(OP_ID_RE), '/^[A-Za-z0-9_-]{22,43}$/')
  const minted = randomBytes(32).toString('base64url')
  t.is(minted.length, 43)
  t.ok(OP_ID_RE.test(minted))
  const short = randomBytes(16).toString('base64url')
  t.is(short.length, 22)
  t.ok(OP_ID_RE.test(short))
  t.ok(OP_ID_RE.test('a'.repeat(22)))
  t.ok(OP_ID_RE.test('_'.repeat(43)))
  t.ok(OP_ID_RE.test('-'.repeat(30)))
  t.absent(OP_ID_RE.test('a'.repeat(21)))
  t.absent(OP_ID_RE.test('a'.repeat(44)))
  t.absent(OP_ID_RE.test('a'.repeat(21) + '.'))
  t.absent(OP_ID_RE.test('a'.repeat(22) + ' '))
  t.absent(OP_ID_RE.test(''))
})

// This table must match apps/cli/lib/account/fees.js verbatim so rounding cannot drift.
const CENTS_MAX = 100000
const BPS_MAX = 2000
const AMOUNT_MAX = 1e10
const FEE_VECTORS = Object.freeze([
  { name: 'half up at .5', unit: 'centavos', cents: 0, bps: 250, amount: 100, fee: 3 },
  { name: 'below .5', unit: 'centavos', cents: 0, bps: 249, amount: 100, fee: 2 },
  { name: 'tiny amount', unit: 'centavos', cents: 0, bps: 50, amount: 1, fee: 0 },
  { name: 'exactly .5 of a centavo', unit: 'centavos', cents: 0, bps: 50, amount: 100, fee: 1 },
  { name: 'just under .5', unit: 'centavos', cents: 0, bps: 49, amount: 100, fee: 0 },
  { name: 'fixed plus percent', unit: 'centavos', cents: 50, bps: 100, amount: 10000, fee: 150 },
  { name: 'fixed only', unit: 'centavos', cents: 50, bps: 0, amount: 12345, fee: 50 },
  { name: 'zero rate', unit: 'centavos', cents: 0, bps: 0, amount: 12345, fee: 0 },
  { name: 'largest inputs', unit: 'centavos', cents: CENTS_MAX, bps: BPS_MAX, amount: AMOUNT_MAX, fee: 2000100000 },
  { name: 'crypto brla debit (USDC funded from BRLA)', unit: 'centavos', cents: 30, bps: 150, amount: 33333, fee: 530 },
  { name: 'swap half up', unit: 'micros', cents: 0, bps: 30, amount: 1666667, fee: 5000 },
  { name: 'swap below .5', unit: 'micros', cents: 0, bps: 30, amount: 1666, fee: 5 },
  { name: 'swap tiny', unit: 'micros', cents: 0, bps: 1, amount: 4999, fee: 0 },
  { name: 'swap exactly .5', unit: 'micros', cents: 0, bps: 1, amount: 5000, fee: 1 },
  { name: 'swap largest inputs', unit: 'micros', cents: 0, bps: BPS_MAX, amount: AMOUNT_MAX, fee: 2000000000 },
  { name: 'crypto usdc debit', unit: 'micros', cents: 0, bps: 150, amount: 10000000, fee: 150000 },
  { name: 'crypto usdc half up', unit: 'micros', cents: 0, bps: 150, amount: 333333, fee: 5000 }
].map(Object.freeze))

function halfUpFee (amount, fixed, bps) {
  return fixed + Math.floor((amount * bps + 5000) / 10000)
}

test('feeLines prints the server preview, including the duplicated fee vectors', async (t) => {
  const { feeLines, formatBrl } = await load()
  const zero = {
    amountCents: 1000,
    varandaFeeCents: 0,
    hodleFeeCents: 0,
    pendingFeeCents: 0,
    totalDebitCents: 1000,
    netReceivedCents: 1000
  }
  t.alike(feeLines(zero), [
    { label: 'Valor', value: 'R$ 10,00' },
    { label: 'Taxa da Varanda', value: 'sem taxa' },
    { label: 'Taxa do parceiro', value: 'R$ 0,00' },
    { label: 'Total debitado', value: 'R$ 10,00' },
    { label: 'Quem recebe ganha', value: 'R$ 10,00' }
  ])
  const charged = {
    amountCents: 10000,
    varandaFeeCents: 150,
    hodleFeeCents: 250,
    pendingFeeCents: 0,
    totalDebitCents: 10400,
    netReceivedCents: 10000
  }
  t.alike(feeLines(charged), [
    { label: 'Valor', value: 'R$ 100,00' },
    { label: 'Taxa da Varanda (cobrada depois que o Pix for concluído)', value: 'R$ 1,50' },
    { label: 'Taxa do parceiro', value: 'R$ 2,50' },
    { label: 'Total debitado', value: 'R$ 104,00' },
    { label: 'Quem recebe ganha', value: 'R$ 100,00' }
  ])
  const pending = { ...charged, pendingFeeCents: 50, totalDebitCents: 10450 }
  const pendingLines = feeLines(pending)
  t.alike(pendingLines.map(line => line.label), [
    'Valor', 'Taxa da Varanda (cobrada depois que o Pix for concluído)', 'Taxa do parceiro', 'Taxas pendentes', 'Total debitado', 'Quem recebe ganha'
  ])
  t.is(pendingLines[3].value, 'R$ 0,50')
  // A total that does not add up is still shown: the charge is the preview, not a local sum.
  const drifted = { ...charged, varandaFeeCents: 7, totalDebitCents: 99999, netReceivedCents: 1 }
  const driftedLines = feeLines(drifted)
  t.is(driftedLines[1].value, 'R$ 0,07')
  t.is(driftedLines[3].value, 'R$ 999,99')
  t.is(driftedLines[4].value, 'R$ 0,01')
  t.ok(Object.isFrozen(pendingLines))
  t.ok(Object.isFrozen(pendingLines[0]))
  await t.exception.all(() => { pendingLines.push({ label: 'extra', value: 'x' }) }, TypeError)
  await t.exception.all(() => { pendingLines[0].label = 'outro' }, TypeError)
  const before = JSON.stringify(charged)
  feeLines(charged)
  t.is(JSON.stringify(charged), before)

  for (const vector of FEE_VECTORS) {
    const fixed = vector.unit === 'centavos' ? vector.cents : 0
    t.is(halfUpFee(vector.amount, fixed, vector.bps), vector.fee, vector.name)
    t.ok(Number.isSafeInteger(vector.fee))
    if (vector.unit !== 'centavos') continue
    if (vector.amount > AMOUNT_MAX || vector.fee > AMOUNT_MAX) continue
    const total = vector.amount + vector.fee
    if (total > AMOUNT_MAX) continue
    const lines = feeLines({
      amountCents: vector.amount,
      varandaFeeCents: vector.fee,
      hodleFeeCents: 0,
      pendingFeeCents: 0,
      totalDebitCents: total,
      netReceivedCents: vector.amount
    })
    t.is(lines[1].value, vector.fee === 0 ? 'sem taxa' : formatBrl(vector.fee))
    t.is(lines[1].value, vector.fee === 0 ? 'sem taxa' : formatBrl(halfUpFee(vector.amount, vector.cents, vector.bps)))
  }

  const aboveInputCap = feeLines({
    ...zero,
    amountCents: 100000000,
    varandaFeeCents: 1,
    totalDebitCents: 100000001,
    netReceivedCents: 100000000
  })
  t.is(aboveInputCap?.[3].value, 'R$ 1.000.000,01')
  for (const key of Object.keys(zero)) {
    const lines = feeLines({ ...zero, [key]: AMOUNT_MAX })
    t.ok(lines?.some(line => line.value === 'R$ 100.000.000,00'), key)
    t.is(feeLines({ ...zero, [key]: AMOUNT_MAX + 1 }), null, key)
  }

  const inherited = Object.create({
    amountCents: 100,
    varandaFeeCents: 0,
    hodleFeeCents: 0,
    pendingFeeCents: 0,
    totalDebitCents: 100,
    netReceivedCents: 100
  })
  const missingPartner = { ...zero }
  delete missingPartner.hodleFeeCents
  const missingPending = { ...zero }
  delete missingPending.pendingFeeCents
  for (const preview of [undefined, null, {}, [], inherited, missingPartner, missingPending,
    { ...zero, amountCents: -1 }, { ...zero, amountCents: 1.5 }, { ...zero, amountCents: '1000' },
    { ...zero, pendingFeeCents: -1 }, { ...zero, totalDebitCents: AMOUNT_MAX + 1 },
    { ...zero, hodleFeeCents: undefined }]) {
    t.is(feeLines(preview), null)
  }
})

test('money texts stay frozen, name the Pix rules, and promise no yield', async (t) => {
  const {
    OP_STATUS_TEXTS, DISPUTE_TEXTS, FEE_STATUS_TEXTS, RECEIVE_TEXTS, PAY_TEXTS,
    UNCERTAIN_MONEY, depositArrivalText, PIX_KEY_LABELS
  } = await load()
  t.is(UNCERTAIN_MONEY, 'Não deu para confirmar se o envio foi feito. Confira o extrato antes de repetir: nada é reenviado sozinho.')
  t.is(OP_STATUS_TEXTS.incerto, UNCERTAIN_MONEY)
  t.alike(Object.keys(OP_STATUS_TEXTS).sort(), ['enviado', 'incerto', 'pendente', 'concluido', 'falhou', 'devolvido', 'expirado'].sort())
  t.alike(Object.keys(DISPUTE_TEXTS).sort(), ['aberta', 'aceita', 'rejeitada', 'cancelada'].sort())
  t.alike(Object.keys(FEE_STATUS_TEXTS).sort(), ['cobrada', 'pendente', 'incerta', 'enviada'].sort())
  t.is(OP_STATUS_TEXTS.expirado, 'O código Pix expirou. Se você pagou, o valor aparece aqui quando o banco confirmar.')
  t.is(DISPUTE_TEXTS.cancelada, 'A contestação foi retirada.')
  t.is(FEE_STATUS_TEXTS.enviada, 'Taxa enviada; aguardando confirmação.')
  t.is(FEE_STATUS_TEXTS.pendente, 'Taxa pendente: será cobrada num próximo envio seu, depois que o Pix for concluído. Se ele falhar ou voltar antes, não é cobrada.')
  t.alike(Object.keys(RECEIVE_TEXTS).sort(), ['ONE_CHARGE', 'OWN_CPF', 'OTHER_CPF', 'NO_VARANDA_FEE', 'EXPIRY'].sort())
  t.ok(RECEIVE_TEXTS.ONE_CHARGE.includes('único valor'))
  t.ok(RECEIVE_TEXTS.ONE_CHARGE.includes('Não é uma chave permanente'))
  t.ok(RECEIVE_TEXTS.OWN_CPF.includes('só o seu CPF'))
  t.ok(RECEIVE_TEXTS.OTHER_CPF.includes('CPF dela'))
  t.ok(RECEIVE_TEXTS.OTHER_CPF.includes('Hodle'))
  t.ok(RECEIVE_TEXTS.OTHER_CPF.includes('autorizar'))
  t.ok(RECEIVE_TEXTS.NO_VARANDA_FEE.includes('não tem taxa da Varanda'))
  t.ok(RECEIVE_TEXTS.EXPIRY.includes('horário'))
  t.ok(PAY_TEXTS.BEFORE_PIN.includes('quem recebe'))
  t.ok(PAY_TEXTS.BEFORE_PIN.includes('taxa do parceiro'))
  t.ok(PAY_TEXTS.BEFORE_PIN.includes('taxa da Varanda'))
  t.ok(PAY_TEXTS.BEFORE_PIN.includes('total'))
  t.ok(PAY_TEXTS.BEFORE_PIN.includes('PIN'))
  t.is(PAY_TEXTS.OTHER_CPF, 'Pagar a outra pessoa pede o CPF de quem recebe.')
  t.is(PAY_TEXTS.cap(300000), 'O limite por operação é R$ 3.000,00.')
  t.is(PAY_TEXTS.cap(10), 'O limite por operação é R$ 0,10.')
  t.is(PAY_TEXTS.cap(1.5), null)
  t.is(PAY_TEXTS.cap('300000'), null)
  t.is(depositArrivalText(150, 9850), 'Taxa do parceiro: R$ 1,50. Chega na sua conta: R$ 98,50 em BRLA')
  t.is(depositArrivalText(0, 10000), 'Taxa do parceiro: R$ 0,00. Chega na sua conta: R$ 100,00 em BRLA')
  t.is(depositArrivalText(-1, 100), null)
  t.is(depositArrivalText(1.5, 100), null)
  t.is(depositArrivalText(100, 100000001), null)

  const tables = [OP_STATUS_TEXTS, DISPUTE_TEXTS, FEE_STATUS_TEXTS, RECEIVE_TEXTS, PAY_TEXTS, PIX_KEY_LABELS]
  for (const table of tables) t.ok(Object.isFrozen(table))
  const strings = [
    UNCERTAIN_MONEY,
    ...Object.values(OP_STATUS_TEXTS),
    ...Object.values(DISPUTE_TEXTS),
    ...Object.values(FEE_STATUS_TEXTS),
    ...Object.values(RECEIVE_TEXTS),
    PAY_TEXTS.BEFORE_PIN,
    PAY_TEXTS.OTHER_CPF,
    PAY_TEXTS.cap(300000),
    depositArrivalText(150, 9850),
    ...Object.values(PIX_KEY_LABELS)
  ]
  for (const text of strings) {
    t.is(typeof text, 'string')
    t.ok(text.length > 0)
    t.absent(text.includes(String.fromCharCode(0x2014)))
    t.absent(/\brende\b|\bjuros\b|\brendimento\b/i.test(text))
  }
})

test('opStatusText: failed deposits do not claim receipt, other states use the shared text', async (t) => {
  const { opStatusText, OP_STATUS_TEXTS } = await load()
  t.is(typeof opStatusText, 'function')
  if (typeof opStatusText !== 'function') return
  const depositFailure = opStatusText('deposit', 'falhou')
  t.is(depositFailure, 'Este recebimento ainda não foi concluído. Se você pagou o código, o valor entra na conta ou volta para quem pagou.')
  t.absent(depositFailure.includes(String.fromCharCode(0x2014)))
  t.absent(/\brende\b|\bjuros\b|\brendimento\b/i.test(depositFailure))
  t.is(opStatusText('payout', 'falhou'), 'Não foi feito.')
  for (const kind of ['deposit', 'payout', 'transfer', 'crypto', 'swap', undefined]) {
    for (const status of Object.keys(OP_STATUS_TEXTS)) {
      if (kind === 'deposit' && status === 'falhou') continue
      t.is(opStatusText(kind, status), OP_STATUS_TEXTS[status])
    }
    t.is(opStatusText(kind, 'unknown'), undefined)
  }
})
