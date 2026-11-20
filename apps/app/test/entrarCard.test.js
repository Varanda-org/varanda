'use strict'

// The Entrar welcome card copy and the 'Outras formas de entrar' visibility
// (src/entrarCard.js).

const test = require('brittle')

const load = () => import('../src/entrarCard.js')

test('welcome card copy uses the agreed plain words', async (t) => {
  const m = await load()
  t.is(m.CREATE_LABEL, 'Criar minha conta')
  t.is(m.ENTRAR_LABEL, 'Entrar')
  t.is(m.HAVE_ACCOUNT_LABEL, 'Já tenho conta')
  t.is(m.MORE_LABEL, 'Outras formas de entrar')
  t.absent('LESS_LABEL' in m)
  t.absent('SIMPLE_TEXT' in m)
  t.is(m.COMPLETE_LABEL, 'Concluir e entrar')
  t.is(m.COMPLETE_TEXT, 'Falta só confirmar mais uma vez. Toque em Concluir e entrar.')
  t.is(m.CANCELLED_TEXT, 'Você fechou a confirmação. Toque de novo quando quiser.')
  t.is(m.NO_ANSWER_TEXT, 'O aparelho não respondeu. Tente de novo.')
})

test('entrarLabel distinguishes secondary sign-in from the main action', async (t) => {
  const { entrarLabel } = await load()
  t.is(entrarLabel(true), 'Já tenho conta')
  t.is(entrarLabel(false), 'Entrar')
})

test('advancedOpen follows notices, toggle taps and visible recovery fields', async (t) => {
  const { advancedOpen } = await load()
  t.is(advancedOpen({}), false)
  t.is(advancedOpen({ advanced: null, knownLost: false, missedOnce: false, codeOpen: false, showComplete: false }), false)
  t.is(advancedOpen({ knownLost: true }), true)
  t.is(advancedOpen({ missedOnce: true }), true)
  t.is(advancedOpen({ codeOpen: true }), true)
  t.is(advancedOpen({ codeOpen: true, showComplete: true }), false, 'a hidden stale field does not open the section')
  t.is(advancedOpen({ codeOpen: true, showComplete: true, knownLost: true }), true)
  t.is(advancedOpen({ advanced: false, knownLost: true }), false)
  t.is(advancedOpen({ advanced: false, missedOnce: true }), false)
  t.is(advancedOpen({ advanced: true }), true)
  t.is(advancedOpen({ advanced: false, codeOpen: true }), true)
  t.is(advancedOpen({ advanced: false, codeOpen: true, showComplete: true }), false)
  t.is(advancedOpen(), false)
})

test('plainError simplifies common ceremony errors and preserves other meanings', async (t) => {
  const { plainError, CANCELLED_TEXT, NO_ANSWER_TEXT } = await load()
  t.is(plainError(null), '')
  t.is(plainError('x'), '')
  t.is(plainError({ code: 'CANCELLED' }), CANCELLED_TEXT)
  t.is(plainError({ code: 'CANCELLED', uncertain: true }), '')
  t.is(plainError({ code: 'WEBAUTHN', message: 'a passkey não respondeu; tente de novo' }), NO_ANSWER_TEXT)
  t.is(plainError({ code: 'WEBAUTHN', message: 'outra coisa' }), '')
  t.is(plainError({ code: 'WEBAUTHN' }), NO_ANSWER_TEXT)
  t.is(plainError({ code: 'NONE' }), '')
  t.is(plainError({ code: 'CANCELLED', message: 'nenhuma criação de passkey pendente' }), '', 'a CANCELLED with its own meaning keeps the usual text')
  const err = new Error('entrada com a passkey cancelada')
  err.code = 'CANCELLED'
  t.is(plainError(err), CANCELLED_TEXT)
  const other = new Error('cancelled')
  other.code = 'CANCELLED'
  t.is(plainError(other), '')
})

test('plainError stays aligned with the shared ceremony messages', async (t) => {
  const { plainError, CANCELLED_TEXT, NO_ANSWER_TEXT } = await load()
  const { MESSAGES } = await import('../src/passkeyOptions.js')
  t.is(plainError({ code: 'WEBAUTHN', message: MESSAGES.WEBAUTHN }), NO_ANSWER_TEXT)
  t.is(plainError({ code: 'CANCELLED', message: MESSAGES.CANCELLED }), CANCELLED_TEXT)
  const web = require('@varanda/web-member/lib/passkey')
  t.is(plainError({ code: 'WEBAUTHN', message: web.MESSAGES.WEBAUTHN }), NO_ANSWER_TEXT, 'the browser node uses the same default')
  t.is(plainError({ code: 'CANCELLED', message: web.MESSAGES.CANCELLED }), CANCELLED_TEXT, 'the browser node uses the same default')
})

test('plain welcome strings avoid technical words', async (t) => {
  const { CREATE_LABEL, ENTRAR_LABEL, HAVE_ACCOUNT_LABEL, MORE_LABEL, COMPLETE_LABEL, COMPLETE_TEXT, CANCELLED_TEXT, NO_ANSWER_TEXT } = await load()
  t.absent(/passkey|PRF|QR|gerenciador|chave/i.test([CREATE_LABEL, ENTRAR_LABEL, HAVE_ACCOUNT_LABEL, MORE_LABEL, COMPLETE_LABEL, COMPLETE_TEXT, CANCELLED_TEXT, NO_ANSWER_TEXT].join(' ')))
})

test('welcome card strings contain no em dash', async (t) => {
  const m = await load()
  for (const value of Object.values(m)) {
    if (typeof value === 'string') t.absent(value.includes('\u2014'), value)
  }
})

test('welcome card source has no imports so Node can load it alone', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'entrarCard.js'), 'utf8')
  t.absent(/^\s*import\s/m.test(src))
})
