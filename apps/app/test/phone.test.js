'use strict'

// The hosted phone gate (src/phone.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/phone.js')

const OPENERS = { state: 'verificado', vouched: true, sinceHeld: true }

test('phoneGate: hosted false is off, even with a verdict or a proof', async (t) => {
  const { phoneGate } = await load()
  for (const hosted of [false, undefined, null, 'true', 1]) {
    t.is(phoneGate({ hosted, policy: { required: true }, ...OPENERS }), 'off', String(hosted))
    t.is(phoneGate({ hosted, policy: { required: false }, state: 'nenhum' }), 'off', String(hosted))
  }
  t.is(phoneGate(), 'off')
})

test('phoneGate: required false is off, before a verdict or a proof', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, policy: { required: false }, ...OPENERS }), 'off')
  t.is(phoneGate({ hosted: true, policy: { required: false }, state: 'nenhum', vouched: true }), 'off')
  t.is(phoneGate({ hosted: true, policy: { required: false, extra: 1 }, state: 'verificado' }), 'off')
})

test('phoneGate: verificado is ok, before a missing policy would block', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, state: 'verificado' }), 'ok')
  t.is(phoneGate({ hosted: true, policy: { required: true }, state: 'verificado', vouched: false }), 'ok')
  t.is(phoneGate({ hosted: true, policy: undefined, state: 'verificado' }), 'ok')
  t.is(phoneGate({ hosted: true, policy: null, state: 'verificado', sinceHeld: true }), 'ok')
  for (const state of ['Verificado', ' verificado', 'verificado ', 'volta']) {
    t.not(phoneGate({ hosted: true, policy: { required: true }, state }), 'ok', state)
  }
})

test('phoneGate: nenhum is needed even when vouched', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, state: 'nenhum', vouched: true, sinceHeld: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: { required: true }, state: 'nenhum', vouched: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: undefined, state: 'nenhum', vouched: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: null, state: 'nenhum', vouched: true, sinceHeld: true }), 'needed')
})

test('phoneGate: vouched is ok while the policy or the status is unknown', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, vouched: true }), 'ok', 'policy and status omitted')
  t.is(phoneGate({ hosted: true, policy: undefined, state: undefined, vouched: true }), 'ok', 'policy in flight')
  t.is(phoneGate({ hosted: true, policy: { required: true }, vouched: true }), 'ok', 'status not answered')
  t.is(phoneGate({ hosted: true, policy: null, vouched: true, sinceHeld: true }), 'ok', 'failed policy still yields to the proof')
  t.is(phoneGate({ hosted: true, policy: { required: true }, vouched: 'true' }), 'loading', 'only boolean true vouches')
})

test('phoneGate: required true is loading until a status or a proof answers', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, policy: { required: true } }), 'loading')
  t.is(phoneGate({ hosted: true, policy: { required: true }, state: undefined, vouched: false, sinceHeld: true }), 'loading')
  t.is(phoneGate({ hosted: true, policy: { required: true }, state: 'pendente' }), 'loading')
  t.is(phoneGate({ hosted: true, policy: { required: 'true' }, sinceHeld: false }), 'off', 'only boolean true counts as required')
})

test('phoneGate: an undefined policy is loading', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true }), 'loading')
  t.is(phoneGate({ hosted: true, policy: undefined, sinceHeld: true }), 'loading')
  t.is(phoneGate({ hosted: true, policy: undefined, state: 'pendente', sinceHeld: true }), 'loading')
})

test('phoneGate: a failed policy with a held since is needed', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, policy: null, sinceHeld: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: null, state: undefined, vouched: false, sinceHeld: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: false, sinceHeld: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: { required: 'false' }, sinceHeld: true }), 'needed')
  t.is(phoneGate({ hosted: true, policy: null, sinceHeld: 'true' }), 'off', 'only boolean true')
})

test('phoneGate: a failed policy with neither proof is off', async (t) => {
  const { phoneGate } = await load()
  t.is(phoneGate({ hosted: true, policy: null }), 'off')
  t.is(phoneGate({ hosted: true, policy: null, vouched: false, sinceHeld: false }), 'off')
  t.is(phoneGate({ hosted: true, policy: null, state: 'pendente' }), 'off')
  t.is(phoneGate({ hosted: true, policy: {}, state: 'recusado' }), 'off')
  t.is(phoneGate({ hosted: true, policy: [], sinceHeld: false }), 'off')
})

test('phoneGate: a device record is not an input', async (t) => {
  const { phoneGate } = await load()
  const stored = { phone: '+5511912345678', verified: true, state: 'verificado', vouched: true, sinceHeld: true }
  t.is(phoneGate({ hosted: true, policy: null, stored, remembered: stored, device: stored }), 'off')
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/phone.js'), 'utf8')
  t.absent(/\b(localStorage|sessionStorage|AsyncStorage)\b/.test(src))
  t.absent(/^import /m.test(src))
})

test('phoneBlocking', async (t) => {
  const { phoneBlocking } = await load()
  t.is(phoneBlocking('loading'), true)
  t.is(phoneBlocking('needed'), true)
  t.is(phoneBlocking('ok'), false)
  t.is(phoneBlocking('off'), false)
  t.is(phoneBlocking(undefined), false)
})

test('phoneReadAllowed mirrors ageReadAllowed', async (t) => {
  const { phoneReadAllowed } = await load()
  const ok = { hosted: true, ready: true, termsOk: true, locked: false, member: 'a'.repeat(64), policyKnown: true, policyRequired: true }
  t.is(phoneReadAllowed(ok), true)
  t.is(phoneReadAllowed({ ...ok, recovering: true }), true)
  t.is(phoneReadAllowed({ ...ok, policyKnown: false }), false)
  t.is(phoneReadAllowed({ ...ok, policyRequired: false }), false)
  t.is(phoneReadAllowed({ ...ok, policyRequired: undefined }), false)
  t.is(phoneReadAllowed({ ...ok, policyRequired: 'true' }), false)
  t.is(phoneReadAllowed({ ...ok, locked: true }), false)
  t.is(phoneReadAllowed({ ...ok, locked: undefined }), false)
  t.is(phoneReadAllowed({ ...ok, ready: false }), false)
  t.is(phoneReadAllowed({ ...ok, member: null }), false)
  t.is(phoneReadAllowed({ ...ok, termsOk: false }), false)
  t.is(phoneReadAllowed({ ...ok, hosted: false }), false)
  t.is(phoneReadAllowed(), false)
})

test('toBrMobile: typed Brazilian mobiles become E.164', async (t) => {
  const { toBrMobile, BR_MOBILE_RE } = await load()
  t.alike(BR_MOBILE_RE.source, '^\\+55[1-9][1-9]9[0-9]{8}$')
  const saoPaulo = [
    '(11) 91234-5678',
    '11912345678',
    '5511912345678',
    '+55 11 91234-5678',
    '+5511912345678',
    '+5511912345678 ',
    '11.91234.5678',
    '(11)91234-5678',
    '+55 (11) 91234-5678',
    '55 11 91234 5678',
    '  +55-11-91234-5678  '
  ]
  for (const text of saoPaulo) t.is(toBrMobile(text), '+5511912345678', text)
  // Area code 55 is also a real code, so a national number that starts with
  // 55 must not be read as a country code unless it has the extra digits.
  for (const text of ['55912345678', '5555912345678', '+55 55 91234-5678']) {
    t.is(toBrMobile(text), '+5555912345678', text)
  }
})

test('toBrMobile: landline, other country, area code with 0, non-string', async (t) => {
  const { toBrMobile } = await load()
  const rejected = [
    '(11) 3123-4567',
    '1131234567',
    '+55 11 3333-4444',
    '551133334444',
    '+1 202 555 0134',
    '+351 91 234 5678',
    '441234567890',
    '(01) 91234-5678',
    '01912345678',
    '+55 01 91234-5678',
    '5501912345678',
    '10912345678',
    '011912345678',
    '',
    '1191234567',
    '119123456789',
    '11a912345678',
    '++5511912345678',
    '11912345678x'
  ]
  for (const text of rejected) t.is(toBrMobile(text), null, JSON.stringify(text))
  for (const bad of [undefined, null, 11912345678, true, {}, [], Symbol('n')]) {
    t.is(toBrMobile(bad), null, String(bad))
  }
})

test('isCode: exactly six digits', async (t) => {
  const { isCode } = await load()
  t.is(isCode('123456'), true)
  t.is(isCode('000000'), true)
  for (const bad of ['12345', '1234567', '12345 ', ' 123456', '12345a', '123 456', '', '١٢٣٤٥٦']) {
    t.is(isCode(bad), false, JSON.stringify(bad))
  }
  for (const bad of [undefined, null, 123456, true, {}, []]) t.is(isCode(bad), false, String(bad))
})

test('codeDigits: strips non-digits before keeping six', async (t) => {
  const { codeDigits } = await load()
  t.is(codeDigits('123-456'), '123456')
  t.is(codeDigits(' 12 34 56 '), '123456')
  t.is(codeDigits('1.2.3.4.5.6.7'), '123456')
  t.is(codeDigits('12a'), '12')
  t.is(codeDigits(''), '')
  for (const bad of [undefined, null, 123456, {}]) t.is(codeDigits(bad), '', String(bad))
})

test('phone texts and phoneErrorText', async (t) => {
  const { phoneErrorText, PHONE_UNAVAILABLE_TEXT, PHONE_SENT_TEXT, PHONE_UNCERTAIN_TEXT } = await load()
  t.is(PHONE_UNAVAILABLE_TEXT, 'A confirmação do celular está fora do ar agora. Tente de novo mais tarde.')
  t.is(PHONE_SENT_TEXT, 'Enviamos um código para o seu celular.')
  t.is(PHONE_UNCERTAIN_TEXT, 'Não deu para confirmar o envio. Se o código chegar, digite abaixo.')
  t.is(phoneErrorText({ code: 'indisponivel' }), PHONE_UNAVAILABLE_TEXT)
  t.is(phoneErrorText({ code: 'indisponivel', uncertain: true }), null)
  t.is(phoneErrorText({ code: 'limite' }), null)
  t.is(phoneErrorText(null), null)
  for (const text of [PHONE_UNAVAILABLE_TEXT, PHONE_SENT_TEXT, PHONE_UNCERTAIN_TEXT]) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
  }
})

const OLD = '2026-11-11T12:00:00.000Z'
const NEW = '2026-11-17T09:30:00.000Z'

test('phoneChange: a later proof date is a new number, the same date is not', async (t) => {
  const { phoneChange } = await load()
  t.is(phoneChange(OLD, NEW), 'changed')
  t.is(phoneChange(OLD, '2026-11-11T12:00:00.001Z'), 'changed', 'one millisecond later')
  t.is(phoneChange(OLD, OLD), 'same')
  t.is(phoneChange(NEW, OLD), 'unknown', 'an older answer proves nothing')
})

test('phoneChange: a missing or non-canonical date is unknown', async (t) => {
  const { phoneChange } = await load()
  for (const bad of [undefined, null, '', '2026-11-11T12:00:00Z', '2026-11-11', '2026-02-30T12:00:00.000Z', Date.parse(OLD), {}, ' ' + OLD.slice(1)]) {
    t.is(phoneChange(bad, NEW), 'unknown', 'before ' + String(bad))
    t.is(phoneChange(OLD, bad), 'unknown', 'after ' + String(bad))
  }
  t.is(phoneChange(), 'unknown')
})

test('phoneChangeOutcome: what Trocar o celular says after each answer', async (t) => {
  const { phoneChangeOutcome, PHONE_CHANGED_TEXT, PHONE_SAME_TEXT, PHONE_NOT_CHANGED_TEXT, PHONE_CHANGE_UNKNOWN_TEXT } = await load()
  t.is(PHONE_CHANGED_TEXT, 'Celular atualizado.')
  t.is(PHONE_SAME_TEXT, 'Esse já é o seu celular.')
  t.is(PHONE_NOT_CHANGED_TEXT, 'O número ainda não mudou. Confirme o código de novo ou peça outro.')
  t.is(PHONE_CHANGE_UNKNOWN_TEXT, 'Não deu para saber se o número mudou. Se precisar, troque de novo.')
  for (const via of ['check', 'recheck']) {
    t.alike(phoneChangeOutcome({ via, before: OLD, after: NEW }), { stay: false, text: PHONE_CHANGED_TEXT }, via + ': changed')
    t.alike(phoneChangeOutcome({ via, before: OLD, after: undefined }), { stay: false, text: PHONE_CHANGE_UNKNOWN_TEXT }, via + ': no proof')
    t.alike(phoneChangeOutcome({ via, before: null, after: NEW }), { stay: false, text: PHONE_CHANGE_UNKNOWN_TEXT }, via + ': nothing known before')
  }
  // The service answers a send with 'verificado' only for the member's live
  // number: a newer date there is a change made elsewhere, not by this send.
  for (const [before, after] of [[OLD, OLD], [OLD, NEW], [OLD, undefined], [null, NEW]]) {
    t.alike(phoneChangeOutcome({ via: 'send', before, after }), { stay: false, text: PHONE_SAME_TEXT }, 'the number typed is already the member\'s: ' + String(before) + ' ' + String(after))
  }
  t.alike(phoneChangeOutcome({ via: 'recheck', before: OLD, after: OLD }), { stay: true, text: PHONE_NOT_CHANGED_TEXT }, 'a lost check that recorded nothing keeps the screen')
  t.alike(phoneChangeOutcome({ via: 'check', before: OLD, after: OLD }), { stay: false, text: PHONE_CHANGE_UNKNOWN_TEXT }, 'a check never records the old date: doubtful')
  t.alike(phoneChangeOutcome(), { stay: false, text: PHONE_CHANGE_UNKNOWN_TEXT })
  for (const text of [PHONE_CHANGED_TEXT, PHONE_SAME_TEXT, PHONE_NOT_CHANGED_TEXT, PHONE_CHANGE_UNKNOWN_TEXT]) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
    t.absent(/[0-9]/.test(text), 'never a number: ' + text)
  }
})

test('phoneChangeShown: Trocar o celular for a linked, unlocked account behind an open gate', async (t) => {
  const { phoneChangeShown } = await load()
  const M = 'a'.repeat(64)
  const linked = { hosted: true, hasPasskey: true, unlocked: true, gate: 'ok', member: M }
  t.is(phoneChangeShown(linked), true, 'a linked account sees it')
  for (const gate of ['off', 'loading', 'needed', undefined, 'OK']) {
    t.is(phoneChangeShown({ ...linked, gate }), false, 'gate ' + String(gate))
  }
  t.is(phoneChangeShown({ ...linked, unlocked: false }), false, 'locked')
  t.is(phoneChangeShown({ ...linked, hosted: false }), false, 'not hosted (a hand-typed configuration)')
  t.is(phoneChangeShown({ ...linked, hasPasskey: false }), false, 'no passkey account')
  t.is(phoneChangeShown({ ...linked, member: null }), false, 'no member known')
  for (const v of [1, 'true', null]) {
    t.is(phoneChangeShown({ ...linked, hosted: v }), false, 'hosted ' + String(v))
    t.is(phoneChangeShown({ ...linked, unlocked: v }), false, 'unlocked ' + String(v))
  }
  t.is(phoneChangeShown(), false)
})

test('Ajustes and Telefone use the pure rules for Trocar o celular', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/screens', f), 'utf8')
  const ajustes = read('Ajustes.js')
  t.ok(ajustes.includes('const showChangePhone = phoneChangeShown({ hosted: node.hosted === true && phoneNode.hosted === true, hasPasskey, unlocked, gate: phoneGate, member: phoneMember })'))
  t.ok(ajustes.includes('statusDate={phoneProofDate}') && ajustes.includes('knownDate={phoneKnownDate}'))
  t.ok(ajustes.includes("setSaved(typeof text === 'string' && text !== '' ? text : PHONE_CHANGE_UNKNOWN_TEXT)"))
  t.absent(ajustes.includes("'Celular atualizado.'"), 'the verdict comes from Telefone')
  const telefone = read('Telefone.js')
  t.ok(telefone.includes('const [before] = useState(knownDate)'), 'the date before is read once, when the screen opens')
  t.ok(telefone.includes("if (answered && statusVerified) verified(undefined, awaiting, 'recheck', statusDate)"))
  t.ok(telefone.includes("finish(r, 'send')") && telefone.includes("finish(r, 'check')"))
  t.ok(telefone.includes('if (mode !== \'trocar\') return onVerified(proof, key)'), 'the setup step is unchanged')
  t.ok(telefone.includes('if (outcome.stay) setNotChanged(outcome.text)'))
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('phoneProofDate={phone.proofDate} phoneKnownDate={phone.knownDate}'))
})
