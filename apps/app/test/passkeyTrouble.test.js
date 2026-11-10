'use strict'

// The Entrar card texts when no passkey can open the account
// (src/passkeyTrouble.js).
const test = require('brittle')

const load = () => import('../src/passkeyTrouble.js')
const ID = '1E0B24' + 'ab'.repeat(29)
const ID2 = 'c0ffee' + 'cd'.repeat(29)

test('staleName labels a hex user id like the passkey does', async (t) => {
  const { staleName } = await load()
  t.is(staleName(ID), 'Varanda 1e0b24')
  t.is(staleName('abc'), '')
  t.is(staleName('zzzzzz'), '')
  t.is(staleName(null), '')
  t.is(staleName(undefined), '')
})

test('deleteStep names one or several unusable passkeys, once each', async (t) => {
  const { deleteStep } = await load()
  t.is(deleteStep([]), '')
  t.is(deleteStep(undefined), '')
  t.is(deleteStep(['nope', null]), '')
  t.is(deleteStep([ID]), 'Se você não usou essa passkey para entrar em outro aparelho, apague a passkey "Varanda 1e0b24" do app onde você guarda senhas: ela foi criada aqui, mas não funciona com o Varanda.')
  t.is(deleteStep([ID, ID.toLowerCase(), 'nope']), deleteStep([ID]), 'same label once, invalid ids ignored')
  t.is(deleteStep([ID, ID2]), 'Se você não usou essas passkeys para entrar em outro aparelho, apague as passkeys "Varanda 1e0b24" e "Varanda c0ffee" do app onde você guarda senhas: elas foram criadas aqui, mas não funcionam com o Varanda.')
  t.absent(/^Apague/.test(deleteStep([ID])), 'the deletion is conditional: the passkey may be the account elsewhere')
  t.ok(deleteStep([ID, ID2, 'ee' + ID2.slice(2)]).includes('"Varanda 1e0b24", "Varanda c0ffee" e "Varanda eeffee"'))
})

test('unusableSteps for a passkey created here: delete, create again, other browser', async (t) => {
  const { unusableSteps, RETRY_LABEL } = await load()
  const all = unusableSteps({ userIds: [ID], created: true })
  t.is(all.length, 3)
  t.ok(all[0].startsWith('1. Se você não usou essa passkey para entrar em outro aparelho, apague a passkey "Varanda 1e0b24"'))
  t.ok(all[1].startsWith('2. Toque em ' + RETRY_LABEL + ' e crie a passkey outra vez.'))
  t.ok(all[1].includes('escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google ou da Apple)'))
  t.is(all[2], '3. Se não der certo, abra o Varanda no Safari ou no Chrome.')

  const noId = unusableSteps({ userIds: [], created: true })
  t.is(noId.length, 2)
  t.ok(noId[0].startsWith('1. Toque em ' + RETRY_LABEL + ' e crie'))
  t.ok(noId[1].startsWith('2. Se não der certo'))

  const withLink = unusableSteps({ userIds: [ID], created: true, withLink: true })
  t.is(withLink.length, 2, 'the invite already says to open the link elsewhere')
  t.ok(withLink[1].startsWith('2. Toque em'))
})

test('unusableSteps for a passkey chosen at Entrar: no create step, only passkeys created here named', async (t) => {
  const { unusableSteps, RETRY_LABEL } = await load()
  const chosen = unusableSteps()
  t.alike(chosen, [
    '1. Toque em ' + RETRY_LABEL + ' e escolha outra passkey do Varanda, se tiver.',
    '2. Se não der certo, abra o Varanda no Safari ou no Chrome.'
  ])
  for (const step of chosen) {
    t.absent(/apague/i.test(step))
    t.absent(step.includes('crie'))
  }
  // A passkey created here failed earlier: it is still named after a later
  // failure at Entrar.
  const later = unusableSteps({ userIds: [ID] })
  t.ok(later[0].startsWith('1. Se você não usou essa passkey para entrar em outro aparelho, apague a passkey "Varanda 1e0b24"'))
  t.ok(later[1].startsWith('2. Toque em ' + RETRY_LABEL + ' e escolha'))

  t.alike(unusableSteps({ known: true }), [
    '1. Toque em ' + RETRY_LABEL + '.',
    '2. Se não der certo, abra o Varanda no Safari ou no Chrome.'
  ], 'Entrar offers only the stored passkey')
  t.is(unusableSteps({ known: true, created: true })[0], '1. Toque em ' + RETRY_LABEL + '.', "no create step where 'Criar passkey' is not shown")
  t.alike(unusableSteps({ known: true, withLink: true }), ['1. Toque em ' + RETRY_LABEL + '.'])
  t.alike(unusableSteps(), unusableSteps({ userIds: [] }))
})

test('unusableSteps on the installed app suggests a synced manager without naming a browser in the create step', async (t) => {
  const { unusableSteps, RETRY_LABEL } = await load()
  const steps = unusableSteps({ userIds: [ID], created: true, native: true })
  t.is(steps.length, 3)
  t.ok(steps[1].startsWith('2. Toque em ' + RETRY_LABEL + ' e crie a passkey outra vez.'))
  t.ok(steps[1].includes('escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google ou da Apple)'))
  t.absent(/Chrome|Safari|Edge|Firefox|navegador/.test(steps[1]))
  t.is(steps[2], '3. Se não der certo, entre pelo site da associação no Chrome.')
  t.alike(unusableSteps({ native: true, withLink: true }), ['1. Toque em ' + RETRY_LABEL + ' e escolha outra passkey do Varanda, se tiver.'])
})

test('unusableSteps acknowledges requested cleanup without hiding names still to remove', async (t) => {
  const { unusableSteps, deleteStep } = await load()
  const none = unusableSteps({ userIds: [], created: true, cleaned: true })
  t.is(none[0], '1. O app já pediu ao gerenciador para retirar a passkey que não serviu.')
  t.absent(/apague/i.test(none.join(' ')))
  t.ok(none[1].startsWith('2. Toque em'))
  const some = unusableSteps({ userIds: [ID], created: true, cleaned: true })
  t.is(some[0], none[0])
  t.is(some[1], '2. ' + deleteStep([ID]))
  t.ok(some[2].startsWith('3. Toque em'))
  t.absent(/apagada|excluída/.test(some.join(' ')))
})

test('notSyncedSteps names only unusable passkeys and recommends synced managers and phone QR', async (t) => {
  const { notSyncedSteps, deleteStep, RETRY_LABEL, PHONE_LABEL } = await load()
  const phone = 'Sem gerenciador assim neste aparelho? Toque em ' + RETRY_LABEL + ', em Outras formas de entrar e em ' + PHONE_LABEL + ': leia com a câmera do celular o QR code que aparece na tela.'
  const retry = 'Toque em ' + RETRY_LABEL + ' e, ao criar, escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google, da Apple ou outro), nunca uma chave de segurança, o Windows Hello ou o perfil do navegador.'
  t.alike(notSyncedSteps({ userIds: [ID], cleaned: false }), [
    '1. ' + deleteStep([ID]),
    '2. ' + retry,
    '3. ' + phone
  ])
  t.alike(notSyncedSteps(), ['1. ' + retry, '2. ' + phone])
  t.alike(notSyncedSteps({ userIds: ['nope', null] }), notSyncedSteps())
  t.alike(notSyncedSteps({ native: true }), ['1. ' + retry, '2. Se não der certo, escolha nas configurações do aparelho um gerenciador de senhas que sincroniza e crie a passkey de novo.'])
  for (const options of [{ withLink: true }, { native: true, withLink: true }]) {
    t.alike(notSyncedSteps(options), ['1. ' + retry])
  }
})

test('notSyncedSteps never points to another browser', async (t) => {
  const { notSyncedSteps, deleteStep, RETRY_LABEL, PHONE_LABEL } = await load()
  const retry = 'Toque em ' + RETRY_LABEL + ' e, ao criar, escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google, da Apple ou outro), nunca uma chave de segurança, o Windows Hello ou o perfil do navegador.'
  const browser = 'Se não der certo, abra o Varanda no celular e crie a passkey lá: o celular guarda a passkey num gerenciador que sincroniza.'
  const site = 'Se não der certo, escolha nas configurações do aparelho um gerenciador de senhas que sincroniza e crie a passkey de novo.'
  t.alike(notSyncedSteps({ phone: false }), ['1. ' + retry, '2. ' + browser])
  t.alike(notSyncedSteps({ phone: false, userIds: [ID] }), ['1. ' + deleteStep([ID]), '2. ' + retry, '3. ' + browser])
  t.absent(notSyncedSteps({ phone: false }).join(' ').includes(PHONE_LABEL))
  t.alike(notSyncedSteps({ phone: true }), notSyncedSteps())
  for (const phone of [true, false]) {
    t.alike(notSyncedSteps({ phone, native: true }), ['1. ' + retry, '2. ' + site], 'native, phone ' + phone)
    t.alike(notSyncedSteps({ phone, withLink: true }), ['1. ' + retry], 'withLink, phone ' + phone)
    t.alike(notSyncedSteps({ phone, native: true, withLink: true }), ['1. ' + retry], 'native withLink, phone ' + phone)
  }
})

// The screen is React and is not loaded here; these pin the wiring that
// feeds the pure texts above.
test('Identidade feeds the cards: phone transport, created passkeys and a pending replacement', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')
  t.ok(src.includes('notSyncedSteps({ userIds: staleIds, cleaned: noPrf.cleaned === true, native: NATIVE, withLink: inviteHere, phone: phoneOk })'))
  t.ok(src.includes('known: pkStatus.passkeyKnown === true && noPrf.created !== true'), 'a passkey created here gets the create step')
  const pendingBranch = src.slice(src.indexOf('if (r && r.pending === true) {'), src.indexOf('await afterUnlock()'))
  const pendingOnly = pendingBranch.slice(0, pendingBranch.indexOf('return'))
  t.absent(pendingOnly.includes('setKnownLost(false)'), 'a pending creation keeps knownLost')
  t.ok(pendingBranch.slice(pendingBranch.indexOf('return')).includes('setKnownLost(false)'), 'a full success clears knownLost')
  t.ok(src.includes('const doUnlock = () => ceremony(() => passkey.unlock({}), false, false, \'plain\')'), 'Entrar is not a creation')
  t.ok(src.includes('const onOtherPasskey = () => ceremony(() => passkey.unlock({ any: true }), false, false, \'other\')'), 'another passkey is not a creation')
  t.ok(src.includes('if (known && mode === \'plain\' && code === \'CANCELLED\' && !NATIVE) return setMissedOnce(true)'), 'one web miss only offers another passkey')
  t.ok(src.includes('const createFirst = (knownLost && !showComplete) ||'), 'no new creation beside a pending concluir')
  t.ok(src.includes('if (created && err.created !== false && !cleaned && typeof id === \'string\') setStaleIds'), 'only created passkeys are named')
  t.absent(src.includes('.refused'), 'a stored refusal never names a passkey: it may be the account elsewhere now')
  t.absent(src.includes('deleteStep'), 'the browser-blocked card has no live failure and names nothing')
  t.is(src.split('setStaleIds(').length - 1, 3, 'staleIds grows only in pkFail and is cleared on success and reset')
  t.ok(pendingBranch.slice(pendingBranch.indexOf('return')).includes('setStaleIds([])'), 'a full success clears the names')
  const resetBody = src.slice(src.indexOf('const doReset = () => {'), src.indexOf('}, pkFail).finally(pkEnd)'))
  t.ok(resetBody.includes('setStaleIds([])'), 'a reset clears the names')
})

test('Identidade: the code recovery card is exclusive and owns its pending creation', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')
  t.absent(src.includes('needsPasskey && !showComplete'), 'a pending creation never drops to the welcome card')
  const start = src.indexOf('} else if (needsPasskey) {')
  t.ok(start > 0, 'the recovery card is its own branch')
  const card = src.slice(start, src.indexOf('} else {', start))
  t.ok(card.includes("<Btn label='Concluir a criação da passkey' onPress={onFinishComplete}"), 'its own concluir')
  t.ok(card.includes("<Btn label='Criar passkey nova' onPress={onFinishRecovery}"))
  t.ok(card.includes("<Btn label='Cancelar' secondary onPress={onCancelRecovery}"))
  for (const other of ['Entrar com a passkey', 'doComplete', 'onPhonePress', 'CODE_LABEL', 'TextInput', 'onOtherPasskey']) {
    t.absent(card.includes(other), 'no ' + other + ' on the recovery card')
  }
  t.ok(src.includes("const onFinishComplete = () => ceremony(() => passkey.complete(), true, true, 'finish')"), 'concluir runs in the press')
  const pendingBranch = src.slice(src.indexOf('if (r && r.pending === true) {'), src.indexOf('if (r && r.needsPasskey === true) {'))
  t.absent(pendingBranch.includes('setNeedsPasskey'), 'a pending result keeps needsPasskey')
  t.ok(src.includes("if (mode === 'finish' && err && err.code === 'RECOVERY_BAD') setNeedsPasskey(false)"), 'a dropped root ends the card')
  t.is(src.split('setNeedsPasskey(false)').length - 1, 3, 'cleared only on success, cancel and a definitive failure')
})

test('Identidade: no code recovery while another creation awaits concluir', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')
  t.ok(/\{showComplete\n\s+\? null\n\s+: codeOpen/.test(src), 'the code entry and field are hidden beside concluir')
  t.ok(src.includes("if (code === '' || showComplete) return"), 'and a submit is refused then too')
})

test('notSyncedSteps acknowledges requested cleanup without hiding names still to remove', async (t) => {
  const { notSyncedSteps, deleteStep } = await load()
  const none = notSyncedSteps({ userIds: [], cleaned: true })
  t.is(none[0], '1. O app já pediu ao gerenciador para retirar a passkey que não serviu.')
  t.absent(/apague/i.test(none.join(' ')))
  t.ok(none[1].startsWith('2. Toque em'))
  const some = notSyncedSteps({ userIds: [ID], cleaned: true })
  t.is(some[0], none[0])
  t.is(some[1], '2. ' + deleteStep([ID]))
  t.ok(some[2].startsWith('3. Toque em'))
  t.absent(/apagada|excluída/.test(some.join(' ')))
})

test('phone labels read inside sentences; the card explanations moved to the help sheet', async (t) => {
  const m = await load()
  t.is(m.PHONE_LABEL, 'criar com o celular')
  t.is(m.PHONE_SIGNIN_LABEL, 'entrar com o celular')
  for (const name of ['SYNC_ADVICE', 'PHONE_HINT', 'PHONE_SIGNIN_HINT']) {
    t.absent(name in m, name + ' lives in HELP.entrar (src/help.js)')
  }
})

test('sign-in texts distinguish missing, known lost and unsuitable passkeys', async (t) => {
  const { NONE_TEXT, KNOWN_LOST_TEXT, NONE_FULL_TEXT, KNOWN_LOST_FULL_TEXT, OTHER_PASSKEY_LABEL, NOT_SYNCED_TITLE } = await load()
  t.is(NONE_TEXT, 'Nenhuma conta da Varanda neste aparelho. Toque em Criar minha conta. Se você já tem conta, confira se o aparelho está na mesma conta Google de antes, ou toque em Outras formas de entrar e use o código de recuperação.')
  t.is(KNOWN_LOST_TEXT, 'A conta que este aparelho conhece não apareceu. Ela pode ter sido apagada ou estar guardada em outra conta Google, Apple ou de um gerenciador de senhas: toque em Entrar com outra passkey ou crie uma conta nova.')
  t.is(NONE_FULL_TEXT, 'Nenhuma conta da Varanda neste aparelho. Se você já tem conta, confira se o aparelho está na mesma conta Google de antes, ou toque em Outras formas de entrar e use o código de recuperação.')
  t.is(KNOWN_LOST_FULL_TEXT, 'A conta que este aparelho conhece não apareceu. Ela pode ter sido apagada ou estar guardada em outra conta Google, Apple ou de um gerenciador de senhas: toque em Entrar com outra passkey.')
  for (const text of [NONE_FULL_TEXT, KNOWN_LOST_FULL_TEXT]) {
    t.absent(/Crie|crie|criar/.test(text), 'no creation offered while full')
    t.absent(/\u2014/.test(text), 'no em dash')
  }
  t.is(OTHER_PASSKEY_LABEL, 'Entrar com outra passkey')
  t.is(NOT_SYNCED_TITLE, 'Essa passkey não serve para o Varanda.')
})

test('texts carry no em dash and never the full user id', async (t) => {
  const m = await load()
  const texts = [
    ...Object.values(m).filter((value) => typeof value === 'string'),
    m.staleName(ID), m.deleteStep([ID, ID2]),
    ...m.unusableSteps({ userIds: [ID, ID2], created: true }),
    ...m.unusableSteps({ userIds: [ID] }),
    ...m.unusableSteps({ userIds: [ID, ID2], cleaned: true, created: true }),
    ...m.notSyncedSteps({ userIds: [ID, ID2] }),
    ...m.notSyncedSteps({ userIds: [ID, ID2], cleaned: true }),
    ...m.notSyncedSteps({ native: true }),
    ...m.notSyncedSteps({ withLink: true }),
    ...m.notSyncedSteps({ phone: false, userIds: [ID, ID2] })
  ]
  for (const text of texts) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
    t.absent(text.toLowerCase().includes(ID.toLowerCase()))
    t.absent(text.includes(ID2))
  }
})

test('beside a pending concluir the missing-account notice names only Concluir e entrar', async (t) => {
  const { NONE_PENDING_TEXT } = await load()
  t.is(NONE_PENDING_TEXT, 'Nenhuma conta da Varanda neste aparelho. Toque em Concluir e entrar para terminar a conta que você começou a criar.')
  t.absent(/Outras formas de entrar|código/.test(NONE_PENDING_TEXT), 'the code row is hidden while concluir waits')
})

test('the onboarding link step is restyled in setup only', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')
  const reload = src.split('\n').find((line) => line.startsWith('const RELOAD_TEXT = '))
  t.ok(reload, 'RELOAD_TEXT is defined')
  t.absent(reload.includes('passkey'), 'the reload text names no passkey')
  t.ok(src.includes('<InvitePaste onPasted={usePasted} disabled={busy || feiraBusy} setup={setup} />'))
  t.ok(src.includes('{recovering && !setup ? <Notice>Buscando sua conta…</Notice> : null}'))
  t.ok(src.includes('const big = setup ? { block: true, large: true } : {}'))
  const card = src.slice(src.indexOf('function LinkCard ('), src.indexOf('export default function Identidade'))
  for (const kept of [
    '<HelpNote doc={HELP.vinculo}><Body>{SHORT.link}</Body></HelpNote>',
    "label='Vincular conta Google'",
    '<Label>conta</Label>',
    '<Card>\n      {setup ? null : <Label>conta</Label>}',
    "'Conta Google escolhida. Confirme o vínculo com '",
    "label='Confirmar vínculo'"
  ]) {
    t.ok(card.includes(kept), 'Ajustes keeps ' + kept)
  }
  t.ok(src.includes('Sem a liberação da associação'), 'manual setup steps keep the release line')
  t.ok(src.includes('needsCert && showTech && !(setup && linkMode)'), 'hosted Google step hides it')
  const large = card.split('\n').filter((line) => line.includes('block large'))
  t.ok(large.length > 0)
  for (const line of large) {
    t.ok(line.includes("label='Confirmar'") || line.includes("label='Continuar com o Google'"), 'block large only on the setup buttons: ' + line.trim())
  }
})
