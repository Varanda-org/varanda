'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/wallet.js')
const policy = { available: true, mode: 'carteira' }
const account = (state, extra = {}) => ({ kyc: { state, attempt: 1 }, ...extra })

test('wallet: pure ES module loads in Node without imports', async (t) => {
  const wallet = await load()
  t.alike(Object.keys(wallet).sort(), [
    'KYC_STATES', 'TEXTS', 'canonicalJson', 'cepDigits', 'cpfDigits', 'isBirthDate',
    'isCep', 'isCpf', 'isPin', 'walletErrorText', 'walletStep'
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
    indisponivel: 'A conta de pagamentos está indisponível agora. Tente mais tarde.'
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
  t.is(TEXTS.OPTIN_WHAT, 'Você pode abrir uma conta ligada ao seu @nome para, nas próximas versões, receber e enviar dinheiro por Pix. É opcional: a Varanda continua funcionando igual sem ela.')
  t.is(TEXTS.OPTIN_KYC, 'Para abrir a conta, a lei pede uma verificação de identidade (KYC), feita pela Hodle, empresa parceira. Você vai enviar nome completo, CPF, data de nascimento, e-mail, endereço, a foto de um documento e uma selfie com prova de vida.')
  t.is(TEXTS.OPTIN_DATA, 'Esses dados vão para a Hodle e seus parceiros regulados; as fotos vão do seu navegador direto para a Hodle. A Varanda guarda só os identificadores da conta e da carteira e o estado da verificação. A Varanda nunca guarda sua senha de 6 dígitos (PIN), seu CPF, suas fotos nem seu endereço.')
  t.is(TEXTS.OPTIN_PERMANENT, 'A conta criada na Hodle não pode ser apagada depois.')
  t.is(TEXTS.OPTIN_MONEY, 'O dinheiro fica em BRLA, uma moeda digital que vale 1 real, emitida pela Avenia, numa carteira em seu nome. A Varanda não é banco e o saldo não rende juros.')
  t.is(TEXTS.OPTIN_FEES, 'Quando enviar dinheiro estiver disponível, a Varanda poderá cobrar uma taxa própria, sempre mostrada antes de você confirmar.')
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
