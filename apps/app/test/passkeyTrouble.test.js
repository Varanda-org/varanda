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
  t.is(deleteStep([ID]), 'Apague a passkey "Varanda 1e0b24" do app onde você guarda senhas. Ela foi criada, mas não funciona com o Varanda.')
  t.is(deleteStep([ID, ID.toLowerCase(), 'nope']), deleteStep([ID]), 'same label once, invalid ids ignored')
  t.is(deleteStep([ID, ID2]), 'Apague as passkeys "Varanda 1e0b24" e "Varanda c0ffee" do app onde você guarda senhas. Elas foram criadas, mas não funcionam com o Varanda.')
  t.ok(deleteStep([ID, ID2, 'ee' + ID2.slice(2)]).includes('"Varanda 1e0b24", "Varanda c0ffee" e "Varanda eeffee"'))
})

test('unusableSteps for a passkey created here: delete, create again, other browser', async (t) => {
  const { unusableSteps, RETRY_LABEL } = await load()
  const all = unusableSteps({ userIds: [ID], created: true })
  t.is(all.length, 3)
  t.ok(all[0].startsWith('1. Apague a passkey "Varanda 1e0b24"'))
  t.ok(all[1].startsWith('2. Toque em ' + RETRY_LABEL + ' e crie a passkey outra vez.'))
  t.ok(all[1].includes('Senhas da Apple') && all[1].includes('Gerenciador de Senhas do Google'))
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
    t.absent(step.includes('Apague'))
    t.absent(step.includes('crie'))
  }
  // A passkey created here failed earlier: it is still named after a later
  // failure at Entrar.
  const later = unusableSteps({ userIds: [ID] })
  t.ok(later[0].startsWith('1. Apague a passkey "Varanda 1e0b24"'))
  t.ok(later[1].startsWith('2. Toque em ' + RETRY_LABEL + ' e escolha'))

  t.alike(unusableSteps({ known: true }), [
    '1. Toque em ' + RETRY_LABEL + '.',
    '2. Se não der certo, abra o Varanda no Safari ou no Chrome.'
  ], 'Entrar offers only the stored passkey')
  t.is(unusableSteps({ known: true, created: true })[0], '1. Toque em ' + RETRY_LABEL + '.', "no create step where 'Criar passkey' is not shown")
  t.alike(unusableSteps({ known: true, withLink: true }), ['1. Toque em ' + RETRY_LABEL + '.'])
  t.alike(unusableSteps(), unusableSteps({ userIds: [] }))
})

test('texts carry no em dash and never the full user id', async (t) => {
  const m = await load()
  const texts = [m.BROWSER_TEXT, m.UNUSABLE_TITLE, m.RETRY_LABEL, ...m.unusableSteps({ userIds: [ID, ID2], created: true }), ...m.unusableSteps({ userIds: [ID] })]
  for (const text of texts) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
    t.absent(text.toLowerCase().includes(ID.toLowerCase()))
    t.absent(text.includes(ID2))
  }
})
