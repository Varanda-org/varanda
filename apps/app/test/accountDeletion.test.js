'use strict'

// Excluir conta, the pure part (src/accountDeletion.js): the typed
// confirmation, the receipt and the request sequence with every effect
// injected. No network, no React.
const test = require('brittle')

const load = () => import('../src/accountDeletion.js')
const M = 'ab'.repeat(32)
const CRED = 'Q1JFRA'
const ASSERTION = { credentialId: CRED, clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AQID' }

test('typedMatches: the @nome with or without @, any case, spaces around', async (t) => {
  const { typedMatches } = await load()
  t.ok(typedMatches('ana', 'ana'))
  t.ok(typedMatches(' @Ana ', 'ana'))
  t.absent(typedMatches('an', 'ana'))
  t.absent(typedMatches('@@ana', 'ana'))
  t.absent(typedMatches('', 'ana'))
  t.absent(typedMatches('ana', ''))
  t.absent(typedMatches(null, 'ana'))
})

test('deletedOf and receiptOf accept only their exact shapes', async (t) => {
  const { deletedOf, receiptOf, newReceipt } = await load()
  t.is(deletedOf({ linked: false, deleted: 'pendente' }), 'pendente')
  t.is(deletedOf({ linked: false, deleted: 'concluida' }), 'concluida')
  t.is(deletedOf({ linked: true }), null)
  t.is(deletedOf({ deleted: 'talvez' }), null)
  t.is(deletedOf(null), null)
  const r = newReceipt(M, Date.parse('2026-11-06T12:00:00.000Z'))
  t.alike(r, { v: 1, member: M, at: '2026-11-06T12:00:00.000Z' })
  t.alike(receiptOf(r), r)
  t.is(receiptOf({ ...r, secret: 'x' }), null, 'nothing more than key and date')
  t.is(receiptOf({ ...r, member: 'AB'.repeat(32) }), null)
  t.is(receiptOf({ ...r, at: '2026-11-06' }), null)
  t.is(receiptOf([]), null)
})

function effects (overrides = {}) {
  const calls = []
  const fx = {
    confirm: (args) => { calls.push(['confirm', args]); return Promise.resolve({ ok: true, assertion: ASSERTION }) },
    beforeFinish: async () => { calls.push('push-off') },
    sign: async (args) => { calls.push(['sign', args]); return { signature: 'f'.repeat(128) } },
    finish: async (args) => { calls.push(['finish', args]); return { deleted: 'pendente' } },
    status: async () => { calls.push('status'); return { linked: false, deleted: 'pendente' } },
    ...overrides
  }
  return { fx, calls }
}

test('requestDeletion: typed name, then the passkey check over the nonce before any await, then push off, sign and finish with the assertion', async (t) => {
  const { requestDeletion } = await load()
  const { fx, calls } = effects()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana', passkeys: [CRED], scheduled: null }
  const p = requestDeletion({ prepared, typed: '@ana', ...fx })
  t.alike(calls, [['confirm', { challenge: prepared.nonce }]], 'the passkey check ran synchronously, inside the tap, over the nonce')
  t.alike(await p, { deleted: 'pendente' })
  t.alike(calls, [['confirm', { challenge: prepared.nonce }], 'push-off', ['sign', { nonce: prepared.nonce, username: 'ana' }], ['finish', { nonce: prepared.nonce, signature: 'f'.repeat(128), assertion: ASSERTION }]])
})

test('requestDeletion: without a stored passkey (or with another one) it asks to wait and keeps push on', async (t) => {
  const { requestDeletion, deletionMode } = await load()
  const at = '2026-11-13T12:00:00.000Z'
  for (const passkeys of [[], ['T1RIRVI']]) {
    const { fx, calls } = effects({ finish: async (args) => { calls.push(['finish', args]); return { scheduled: at } } })
    const prepared = { nonce: 'n'.repeat(43), username: 'ana', passkeys, scheduled: null }
    t.is(deletionMode(prepared), passkeys.length === 0 ? 'agendada' : 'agora')
    t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { scheduled: at })
    t.absent(calls.includes('push-off'), 'a waiting deletion keeps the push notice of its schedule')
    t.alike(calls[calls.length - 1], ['finish', { nonce: prepared.nonce, signature: 'f'.repeat(128), wait: true }], 'no assertion the service cannot verify')
  }
})

test('cancelDeletion, scheduledOf and the date in Brasília time', async (t) => {
  const { cancelDeletion, scheduledOf, scheduleDate, scheduledText } = await load()
  const calls = []
  const out = await cancelDeletion({
    start: async () => { calls.push('start'); return { nonce: 'c'.repeat(43), username: 'ana' } },
    sign: async (args) => { calls.push(['sign', args]); return { signature: 'e'.repeat(128) } },
    finish: async (args) => { calls.push(['finish', args]); return { cancelled: true } }
  })
  t.alike(out, { cancelled: true })
  t.alike(calls, ['start', ['sign', { nonce: 'c'.repeat(43), username: 'ana' }], ['finish', { nonce: 'c'.repeat(43), signature: 'e'.repeat(128) }]])
  t.is(scheduledOf({ linked: true, scheduledDeletion: '2026-11-13T12:00:00.000Z' }), '2026-11-13T12:00:00.000Z')
  t.is(scheduledOf({ linked: true }), null)
  t.is(scheduledOf({ scheduledDeletion: 'amanhã' }), null)
  t.is(scheduledOf(null), null)
  t.is(scheduleDate('2026-11-14T02:00:00.000Z'), '13/11/2026', 'still the 13th in Brasília')
  t.ok(scheduledText('2026-11-13T12:00:00.000Z').includes('13/11/2026'))
})

test('requestDeletion: a wrong name or a cancelled passkey sends nothing', async (t) => {
  const { requestDeletion } = await load()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana' }
  let { fx, calls } = effects()
  await t.exception(requestDeletion({ prepared, typed: 'bia', ...fx }), /digite o seu @nome/)
  t.alike(calls, [])
  ;({ fx, calls } = effects({ confirm: () => Promise.reject(Object.assign(new Error('entrada com a passkey cancelada'), { code: 'CANCELLED' })) }))
  await t.exception(requestDeletion({ prepared, typed: 'ana', ...fx }), /cancelada/)
  t.alike(calls.filter((c) => Array.isArray(c) && c[0] !== 'confirm'), [], 'nothing signed or sent after a cancel')
  await t.exception(requestDeletion({ prepared: null, typed: 'ana', ...fx }), /expirado/)
})

test('requestDeletion: an uncertain finish is settled by the status, never sent again', async (t) => {
  const { requestDeletion } = await load()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana' }
  const uncertain = Object.assign(new Error('serviço indisponível'), { uncertain: true })
  let { fx, calls } = effects({ finish: async () => { calls.push('finish'); throw uncertain } })
  t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { deleted: 'pendente' })
  t.is(calls.filter((c) => c === 'finish').length, 1, 'one finish only')
  t.ok(calls.includes('status'))
  ;({ fx, calls } = effects({ finish: async () => { throw uncertain }, status: async () => ({ linked: true }) }))
  await t.exception(requestDeletion({ prepared, typed: 'ana', ...fx }), /indisponível/, 'still linked: the error stands')
  ;({ fx, calls } = effects({ beforeFinish: async () => { throw new Error('push') } }))
  t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { deleted: 'pendente' }, 'a failed push switch-off never stops it')
})

test('PENDING_TEXT seals an optional phone for up to 180 days and does not name Google', async (t) => {
  const { PENDING_TEXT } = await load()
  t.ok(PENDING_TEXT.includes('se houver'))
  t.ok(PENDING_TEXT.includes('180 dias'))
  t.ok(PENDING_TEXT.includes('O número do celular, se houver, fica lacrado por até 180 dias e então é apagado.'))
  t.absent(PENDING_TEXT.includes('Google'))
})

test('Excluir conta: a page owner without Páginas on screen is told the way forward', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ExcluirConta.js'), 'utf8')
  t.ok(src.includes("const PAGES_LATER = 'Confirme o seu celular primeiro. Depois, encerre ou transfira a página em Páginas.'"))
  t.ok(src.includes("{typeof onOpenPaginas === 'function' ? <Btn label='Abrir Páginas' onPress={onOpenPaginas} /> : <Body>{PAGES_LATER}</Body>}"))
  t.absent(src.includes('\u2014'))
})

test('Excluir conta: every paragraph is listed as bullet rows, one unchanged sentence per row', async (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { DELETE_DAYS, WAIT_TEXT, PASSKEY_TEXT } = await load()
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ExcluirConta.js'), 'utf8')
  const lines = {
    WHAT_GOES: "const WHAT_GOES = 'Excluir a conta apaga, no serviço de conta da associação, o vínculo com a conta Google, se houver, o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O número do celular, se houver, fica lacrado por até 180 dias e então é apagado. O seu @nome fica reservado e nunca vai para outra pessoa.'",
    DIARY: "const DIARY = 'O diário (publicações, perfil, fotos, quem você segue, curtidas e republicações) sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias. Apps e semeadores modificados, cópias que outras pessoas já baixaram, mensagens já entregues e capturas de tela podem manter o conteúdo.'",
    GROUPS: "const GROUPS = 'As comunidades e os grupos que você criou deixam de existir para todos os participantes.'",
    KEPT: "const KEPT = 'Ficam guardadas as denúncias feitas por você ou contra você e as decisões dos moderadores, para moderação e pedidos legais.'",
    DEVICE: "const DEVICE = 'Neste aparelho, a conta e os dados são apagados logo depois do pedido. Não dá para desfazer.'"
  }
  const texts = { WAIT_TEXT, PASSKEY_TEXT }
  for (const [name, line] of Object.entries(lines)) {
    t.ok(src.includes(line + '\n'), name + ' is byte-identical')
    texts[name] = new Function('DELETE_DAYS', 'return ' + line.slice(line.indexOf('=') + 1))(DELETE_DAYS) // eslint-disable-line no-new-func
  }
  const helper = src.match(/^const sentences = (.+)$/m)
  t.ok(helper, 'the sentence split lives in the screen')
  const sentences = new Function('return ' + helper[1])() // eslint-disable-line no-new-func
  const counts = { WHAT_GOES: 3, DIARY: 2, GROUPS: 1, KEPT: 1, DEVICE: 2, WAIT_TEXT: 3, PASSKEY_TEXT: 3 }
  for (const [name, count] of Object.entries(counts)) {
    const rows = sentences(texts[name])
    t.is(rows.length, count, name + ' has one row per sentence')
    t.is(rows.join(' '), texts[name], name + ' rows give back the text byte for byte')
    t.ok(rows.every((r) => r.length > 0 && !r.startsWith(' ')), name + ' has no empty or padded row')
  }
  t.ok(src.includes('<Bullets texts={[WHAT_GOES]} strong />'))
  t.ok(src.includes("<Bullets texts={[DIARY, GROUPS, KEPT, mode === 'agendada' ? WAIT_TEXT : DEVICE, PASSKEY_TEXT]} />"))
  t.absent(/<(Body|Soft)>\{(WHAT_GOES|DIARY|GROUPS|KEPT|DEVICE)\}<\/(Body|Soft)>/.test(src), 'no paragraph left as a block')
  t.ok(src.includes('<Soft>Depois, confirme com a sua passkey.</Soft>'), 'the confirmation sentence stays')
})

test('Excluir conta: the delete action sits in a sticky bar, warns by touch and sends once per confirmed press', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ExcluirConta.js'), 'utf8')
  t.ok(src.includes("import { tap } from '../ui/haptics'"))
  t.ok(src.includes("  const press = () => {\n    tap('warn')\n    submit()\n  }"), 'the haptic runs synchronously before submit, so the passkey check stays inside the press')
  t.ok(src.includes("<Btn label={mode === 'agendada' ? 'Agendar exclusão' : 'Excluir conta'} danger block onPress={press} disabled={!matches} pending={action.pending} />"), 'a danger Btn, disabled until the typed @nome matches')
  const main = src.slice(src.indexOf('  const press = () => {'), src.indexOf('// A deletion waiting for its date'))
  const kbOpen = main.indexOf('<KeyboardForm>')
  const kbClose = main.indexOf('</KeyboardForm>')
  const pageOpen = main.indexOf('<Page>')
  const pageClose = main.indexOf('</Page>')
  const bar = main.indexOf('<View style={styles.bar}>')
  t.ok(src.includes("import { KeyboardForm } from './Perfil'"))
  t.ok(kbOpen !== -1 && kbOpen < pageOpen && bar < kbClose, 'the Page and the bar sit inside KeyboardForm, so the bar rises above the keyboard')
  t.ok(pageClose !== -1 && bar > pageClose, 'the bar is outside the scrolling Page')
  t.ok(main.slice(pageClose, bar).includes('{username !== null'), 'the bar shows under the same condition as the Field')
  const barSlice = main.slice(bar, kbClose)
  t.ok(barSlice.includes('onPress={press}'), 'the delete Btn is in the bar')
  t.ok(barSlice.indexOf('<ErrorText>{action.error}</ErrorText>') !== -1 && barSlice.indexOf('<ErrorText>{action.error}</ErrorText>') < barSlice.indexOf('onPress={press}'), 'a failed or cancelled press shows its error in the bar, next to the Btn')
  t.ok(main.slice(pageOpen, pageClose).includes(': <ErrorText>{action.error}</ErrorText>}'), 'without the bar the error still shows in the Page')
  t.absent(src.includes('insets'), 'the Ajustes Sheet already pads the bottom inset')
  t.ok(src.includes('  bar: { paddingVertical: space.md, paddingHorizontal: space.lg,'), 'the bar pads only its own spacing')
  t.is(src.split('submit()').length - 1, 1, 'submit runs only from the press')
  t.is(src.split('requestDeletion(').length - 1, 1, 'one request per submit')
  t.ok(src.includes('    prepare()\n  }, [active, prepare])'), 'opening the screen still only asks for a nonce')
  t.ok(src.includes('<Field label={\'Para confirmar, digite @\' + username} value={typed} onChangeText={setTyped} mono maxLength={24} placeholder={\'@\' + username} />'), 'the typed confirmation stays')
})

const caught = (p) => p.then(() => null, (e) => e)

test('Excluir sem a passkey: smsName, smsPhone and smsCodeOk normalize what the person types', async (t) => {
  const { smsName, smsPhone, smsCodeOk } = await load()
  t.is(smsName(' @Ana_01 '), 'ana_01')
  t.is(smsName('ana'), 'ana')
  t.is(smsName('@@ana'), null)
  t.is(smsName('ab'), null)
  t.is(smsName('e905a4'), null, 'a default handle is not an @nome')
  t.is(smsName(null), null)
  t.is(smsPhone('(11) 91234-5678'), '+5511912345678')
  t.is(smsPhone('11 3123-4567'), null, 'a landline')
  t.is(smsCodeOk(' 123 456 '), '123456')
  t.is(smsCodeOk('12345'), null)
  t.is(smsCodeOk('12345a'), null)
  t.is(smsCodeOk(123456), null)
})

test('Excluir sem a passkey: resendWait counts 60 s down, statusDue waits 10 min', async (t) => {
  const { resendWait, resendLabel, statusDue } = await load()
  t.is(resendWait(1000, 1000), 60)
  t.is(resendWait(1000, 1000 + 59001), 1)
  t.is(resendWait(1000, 1000 + 60000), 0)
  t.is(resendWait(1000, 0), 60, 'a now behind the press (useNow lags) is the full wait')
  t.is(resendWait(null, 5), 0)
  t.is(resendLabel(0), 'Pedir outro código')
  t.is(resendLabel(65), 'Pedir outro código em 1:05')
  t.ok(statusDue(null, 0))
  t.absent(statusDue(0, 10 * 60 * 1000 - 1))
  t.ok(statusDue(0, 10 * 60 * 1000))
  t.ok(statusDue(5000, 1000), 'a clock that went back is due')
})

test('Excluir sem a passkey: statusReadDue retries a failed read after 1 min, a good read waits 10 min', async (t) => {
  const { statusReadDue, STATUS_RETRY_MS, STATUS_EVERY_MS } = await load()
  t.is(STATUS_RETRY_MS, 60 * 1000)
  t.ok(statusReadDue({}, 0), 'never read is due')
  t.absent(statusReadDue({ goodAt: null, triedAt: 0, failed: true }, STATUS_RETRY_MS - 1))
  t.ok(statusReadDue({ goodAt: null, triedAt: 0, failed: true }, STATUS_RETRY_MS), 'a failed read is not held off past the retry pace')
  t.ok(statusReadDue({ goodAt: 0, triedAt: 100000, failed: true }, 100000 + STATUS_RETRY_MS), 'an older good read does not hold off the retry')
  t.absent(statusReadDue({ goodAt: 0, triedAt: 0, failed: false }, STATUS_RETRY_MS), 'a good read still throttles')
  t.absent(statusReadDue({ goodAt: 0, triedAt: 0, failed: false }, STATUS_EVERY_MS - 1))
  t.ok(statusReadDue({ goodAt: 0, triedAt: 0, failed: false }, STATUS_EVERY_MS))
  t.ok(statusReadDue({ goodAt: 5000, triedAt: 5000, failed: false }, 1000), 'a clock that went back reads (good)')
  t.ok(statusReadDue({ goodAt: null, triedAt: 5000, failed: true }, 1000), 'a clock that went back reads (failed)')
})

test('Excluir sem a passkey: requestSmsCode sends the normalized pair once and refuses bad input locally', async (t) => {
  const { requestSmsCode } = await load()
  const sent = []
  const send = async (body) => { sent.push(body); return { sent: true } }
  t.alike(await requestSmsCode({ username: '@Ana', phone: '(11) 91234-5678', send }), { sent: true })
  t.alike(sent, [{ username: 'ana', phone: '+5511912345678' }])
  await t.exception(requestSmsCode({ username: 'a', phone: '(11) 91234-5678', send }), /@nome/)
  await t.exception(requestSmsCode({ username: 'ana', phone: '123', send }), /celular/)
  t.is(sent.length, 1, 'nothing sent for bad input')
  const failing = async () => { sent.push('again'); throw Object.assign(new Error('x'), { uncertain: true }) }
  await t.exception(requestSmsCode({ username: 'ana', phone: '(11) 91234-5678', send: failing }))
  t.is(sent.length, 2, 'a failed send is not retried')
})

test('Excluir sem a passkey: confirmSmsCode checks once, files a request and never sends the code again', async (t) => {
  const { confirmSmsCode } = await load()
  let checks = 0
  const okCheck = async (body) => { checks++; t.alike(body, { username: 'ana', phone: '+5511912345678', code: '123456' }); return { requested: true } }
  t.alike(await confirmSmsCode({ username: 'Ana', phone: '11912345678', code: '123 456', check: okCheck }), { requested: true })
  t.is(checks, 1)

  checks = 0
  const lost = async () => { checks++; throw Object.assign(new Error('x'), { uncertain: true }) }
  {
    const e = await caught(confirmSmsCode({ username: 'ana', phone: '11912345678', code: '123456', check: lost, lookup: async () => { throw new Error('not read') }, status: async () => { throw new Error('not read') } }))
    t.ok(e !== null && e.uncertain === true, 'an uncertain answer stays uncertain: a request is not public')
  }
  t.is(checks, 1, 'the code is never sent again')

  const refused = async () => { throw Object.assign(new Error('x'), { code: 'codigo-invalido' }) }
  {
    const e = await caught(confirmSmsCode({ username: 'ana', phone: '11912345678', code: '123456', check: refused }))
    t.ok(e !== null && e.code === 'codigo-invalido')
  }
  {
    const e = await caught(confirmSmsCode({ username: 'ana', phone: '11912345678', code: '12', check: okCheck }))
    t.ok(e !== null && e.code === 'codigo-invalido')
  }
})

test('Excluir sem a passkey: smsErrorText maps tokens and keeps uncertain apart', async (t) => {
  const { smsErrorText, SMS_TEXTS } = await load()
  t.is(smsErrorText({ uncertain: true, code: 'codigo-invalido' }), SMS_TEXTS.uncertain)
  t.ok(/Código errado/.test(smsErrorText({ code: 'codigo-invalido' })))
  t.ok(/página/.test(smsErrorText({ code: 'paginas-ativas' })))
  t.ok(/contato@varanda\.app/.test(smsErrorText({ code: 'qualquer' })))
  t.is(SMS_TEXTS.requested, 'Pedido registrado. Ainda falta um passo: escreva para contato@varanda.app com o seu @nome. Nada acontece antes disso. Depois que a equipe confirmar, a conta fica marcada para exclusão em 7 dias.')
  t.ok(SMS_TEXTS.uncertain.includes('escreva para contato@varanda.app com o seu @nome'), 'an uncertain answer still names the step left')
  for (const text of Object.values(SMS_TEXTS)) t.absent(/agendad/.test(text), 'no text says this screen scheduled the deletion: ' + text)
  t.ok(SMS_TEXTS.intro.includes('Digite o seu @nome e o número de celular que você confirmou na Varanda. Se os dois baterem, enviamos um código por SMS para esse número.'))
  t.is(SMS_TEXTS.codeIntro, 'Se o @nome e o número baterem, o código chega em instantes. Digite os 6 números.')
})

test('Excluir sem a passkey: requestSmsCode shows a deletion already waiting instead of sending', async (t) => {
  const { requestSmsCode } = await load()
  const at = '2026-11-24T12:00:00.000Z'
  const sent = []
  const send = async (body) => { sent.push(body); return { sent: true } }
  const lookup = async () => ({ member: M })
  t.alike(await requestSmsCode({ username: 'ana', phone: '(11) 91234-5678', send, lookup, status: async () => ({ linked: true, scheduledDeletion: at }) }), { scheduled: at })
  t.is(sent.length, 0, 'no send: the service would skip it')
  t.alike(await requestSmsCode({ username: 'ana', phone: '(11) 91234-5678', send, lookup, status: async () => ({ linked: true }) }), { sent: true })
  t.alike(await requestSmsCode({ username: 'ana', phone: '(11) 91234-5678', send, lookup: async () => { throw new Error('offline') }, status: async () => ({}) }), { sent: true }, 'a failed read still sends')
  t.is(sent.length, 2)
})

test('statusUpdate: a failed read keeps the date and the deleted hold; only the first answer leaves the enrolment due', async (t) => {
  const { statusUpdate } = await load()
  const at = '2026-11-24T12:00:00.000Z'
  const prev = { deletedState: null, scheduledDeletion: at }
  t.alike(statusUpdate(prev, null, { start: false, member: M }), { deletedState: null, scheduledDeletion: at, enrolDue: null }, 'offline foreground read keeps the note')
  t.alike(statusUpdate({ deletedState: 'pendente', scheduledDeletion: null }, null, { start: true, member: M }), { deletedState: 'pendente', scheduledDeletion: null, enrolDue: null }, 'the deleted hold stays')
  const linked = { linked: true, username: 'ana', scheduledDeletion: at }
  t.alike(statusUpdate(prev, linked, { start: false, member: M }), { deletedState: null, scheduledDeletion: at, enrolDue: null }, 'no enrolment on a refresh')
  t.alike(statusUpdate(prev, linked, { start: true, member: M }).enrolDue, { member: M, username: 'ana' })
  t.alike(statusUpdate(prev, { linked: true, username: 'ana' }, { start: false, member: M }).scheduledDeletion, null, 'a cancel elsewhere clears the date')
})

test('ajustesTarget: Excluir conta sem a passkey from Entrar closes the sheet on every way out', async (t) => {
  const { ajustesTarget } = await load()
  t.is(ajustesTarget('lista', { entrar: true }), null)
  t.is(ajustesTarget('excluirSms', { entrar: true }), 'excluirSms')
  t.is(ajustesTarget('lista', { aviso: true }), null)
  t.is(ajustesTarget('excluir', { aviso: true }), 'excluir')
  t.is(ajustesTarget('lista'), 'lista')
})
