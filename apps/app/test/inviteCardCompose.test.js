'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { compileFunction } = require('vm')
const rpc = require('@varanda/rpc')
const load = () => import('../src/inviteCardCompose.js')
const ORIGIN = 'https://bora.varanda.app'
const CODE = 'a'.repeat(43)
const MEMBER = '12'.repeat(32)
const SIGNATURE = '34'.repeat(64)
const EXPIRES = 1800000000

// Exercise the screen's actual create handler without loading React Native.
// Account and node calls are fakes; the URL builders and transitions are real.
async function screenCreate (options = {}) {
  const compose = await load()
  const { buildSignupInviteUrl } = await import('../src/signupInvite.js')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Convites.js'), 'utf8')
  const start = src.indexOf('  const create = async () => {')
  const end = src.indexOf('\n  const retryKey', start)
  if (start < 0 || end < 0) throw new Error('create handler not found')
  const calls = []
  const output = { url: null, note: '', draft: { ...compose.initialCompose(), enabled: true, name: 'Ana', ...options.draft } }
  const openRef = { current: true }
  const env = {
    ...compose,
    draft: output.draft,
    origin: ORIGIN,
    ownKey: MEMBER,
    busyRef: { current: false },
    openRef,
    errorCodeRef: { current: '' },
    dropGen: { current: 0 },
    buildSignupInviteUrl,
    buildInviteCardUrl: rpc.buildInviteCardUrl,
    UNAVAILABLE_TEXT: 'serviço indisponível',
    MAYBE_CREATED_TEXT: 'maybe created',
    errorText: (err) => err.message,
    changeDraft: (event) => { output.draft = compose.composeTransition(output.draft, event) },
    invitesStart: async () => {
      calls.push('start')
      if (options.closeAt === 'start') openRef.current = false
      return { nonce: 'nonce' }
    },
    node: {
      request: async (method, args) => {
        calls.push({ method, args })
        if (options.closeAt === method) openRef.current = false
        if (method === 'inviteCard.sign') {
          if (options.signFails) throw new Error('sign failed')
          return { signature: options.badSignature ? 'invalid' : SIGNATURE }
        }
        return { signature: SIGNATURE }
      }
    },
    invitesFinish: async () => {
      calls.push('finish')
      if (options.closeAt === 'finish') openRef.current = false
      return { code: CODE, expiresAt: new Date(EXPIRES * 1000).toISOString(), used: 1, remaining: 2 }
    },
    refreshSummary: async () => { calls.push('summary') }
  }
  for (const key of ['busy', 'error', 'note', 'url', 'count', 'summary', 'limitHit', 'awaitingDrop', 'draft']) {
    env['set' + key[0].toUpperCase() + key.slice(1)] = (value) => {
      output[key] = typeof value === 'function' ? value(output[key] ?? null) : value
    }
  }
  const create = compileFunction(src.slice(start, end) + '\nreturn create', Object.keys(env))(...Object.values(env))
  await create()
  return { calls, output }
}

test('composer suggestions never overwrite a typed message', async (t) => {
  const { initialCompose, composeTransition } = await load()
  const { SUGGESTIONS } = await import('../src/inviteCardCopy.js')
  let state = composeTransition(initialCompose(), { type: 'toggle' })
  t.is(state.phase, 'writing')
  state = composeTransition(state, { type: 'design', value: 'cordel' })
  t.is(state.message, SUGGESTIONS.cordel)
  state = composeTransition(state, { type: 'message', value: 'Vem cá!' })
  state = composeTransition(state, { type: 'region', value: 'sul' })
  t.is(state.message, 'Vem cá!')
  state = composeTransition(state, { type: 'message', value: '' })
  state = composeTransition(state, { type: 'design', value: 'chimarrao' })
  t.is(state.message, '', 'clearing the message still counts as typing')
})

test('composer uses the UTF-8 budget and rejects a blank recipient', async (t) => {
  const { fits, room, counterText, cardFields, initialCompose } = await load()
  const fields = { origin: ORIGIN, name: 'Ana', design: 'minas', message: 'é🌻' }
  const budget = room(fields)
  t.ok(fits(fields))
  t.is(counterText(fields), '6 de ' + budget + ' bytes')
  t.ok(fits({ ...fields, message: 'a'.repeat(budget) }))
  t.absent(fits({ ...fields, message: 'a'.repeat(budget + 1) }))
  t.absent(fits({ ...fields, name: '   ' }))
  t.is(cardFields({ ...initialCompose(), enabled: true, name: '   ' }, ORIGIN), null)
})

test('all regional designs fit the codec budget including the preview query', async (t) => {
  const { fits, room } = await load()
  for (const origin of [ORIGIN, 'https://a.test', 'https://' + 'a'.repeat(100) + '.test']) {
    for (const design of rpc.DESIGNS) {
      const fields = { origin, name: 'João 🌻', design }
      const budget = room(fields)
      t.is(budget, rpc.messageRoom({ ...fields, code: CODE, expires: 2 ** 32 - 1 }))
      const message = 'a'.repeat(budget)
      const url = rpc.buildInviteCardUrl({ ...fields, message, code: CODE, expires: EXPIRES, member: MEMBER, signature: SIGNATURE })
      t.ok(fits({ ...fields, message }))
      t.ok(url && url.length <= 400)
      t.ok(url.includes('?c=' + rpc.designIndex(design) + '#c1.'))
      t.absent(fits({ ...fields, message: message + 'a' }))
    }
  }
})

test('composer states and labels retain the draft when skipping', async (t) => {
  const { initialCompose, composeTransition, createLabel } = await load()
  let state = initialCompose()
  t.is(state.phase, 'idle')
  t.is(createLabel(state, ORIGIN), 'Criar link de convite')
  state = composeTransition(state, { type: 'toggle' })
  state = composeTransition(state, { type: 'name', value: 'Ana' })
  t.is(createLabel(state, ORIGIN), 'Criar link com cartão')
  state = composeTransition(state, { type: 'create' })
  t.is(state.phase, 'creating')
  t.is(composeTransition(state, { type: 'toggle' }), state, 'busy draft cannot change')
  state = composeTransition(state, { type: 'sign' })
  t.is(state.phase, 'signing')
  t.is(createLabel(state, ORIGIN), 'Assinando cartão')
  for (const phase of ['plain', 'card', 'card-failed']) {
    t.is(composeTransition(state, { type: phase }).phase, phase)
  }
  state = composeTransition(state, { type: 'card' })
  state = composeTransition(state, { type: 'toggle' })
  t.is(state.name, 'Ana')
  t.is(createLabel(state, ORIGIN), 'Criar link de convite')
  t.alike(composeTransition(state, { type: 'reset' }), initialCompose())
})

test('skipping the card creates the plain link with one finish and no card signature', async (t) => {
  const { output, calls } = await screenCreate({ draft: { enabled: false } })
  t.is(output.url, ORIGIN + '/convite/' + CODE)
  t.is(output.draft.phase, 'plain')
  t.is(calls.filter((c) => c === 'finish').length, 1)
  t.is(calls.filter((c) => c.method === 'inviteCard.sign').length, 0)
})

test('a fitting card signs after finish and shares the complete URL', async (t) => {
  const { output, calls } = await screenCreate({ draft: { name: ' Ana ', message: ' Vem, cafe\u0301! ' } })
  const signed = calls.find((c) => c.method === 'inviteCard.sign')
  t.ok(calls.indexOf('finish') < calls.indexOf(signed))
  t.is(calls.filter((c) => c === 'finish').length, 1)
  t.alike(signed.args, { code: CODE, design: 'marajoara', name: 'Ana', message: 'Vem, café!', expires: EXPIRES })
  t.ok(output.url.includes('?c=0#c1.'))
  t.ok(output.url.length <= 400)
  t.alike(rpc.parseInviteCardUrl(output.url), { ...signed.args, member: MEMBER, signature: SIGNATURE })
  t.is(output.draft.phase, 'card')
  t.is(output.note, '')
  t.alike(output.count, { key: MEMBER, used: 1, remaining: 2 })
})

test('sign or builder failure retains the plain link and never repeats finish', async (t) => {
  for (const options of [{ signFails: true }, { badSignature: true }]) {
    const { output, calls } = await screenCreate(options)
    t.is(output.url, ORIGIN + '/convite/' + CODE)
    t.is(output.note, 'O convite foi criado. O cartão não entrou no link.')
    t.is(output.draft.phase, 'card-failed')
    t.is(calls.filter((c) => c === 'finish').length, 1)
    t.is(calls.filter((c) => c.method === 'inviteCard.sign').length, 1)
    t.is(output.count.used, 1)
    t.is(output.error, '')
  }
})

test('a name of only spaces cannot attach a card', async (t) => {
  const { output, calls } = await screenCreate({ draft: { name: '   ' } })
  t.is(output.url, ORIGIN + '/convite/' + CODE)
  t.is(calls.filter((c) => c.method === 'inviteCard.sign').length, 0)
})

test('closing before finish spends nothing and a later finish keeps the link', async (t) => {
  for (const closeAt of ['start', 'invite.sign']) {
    const { output, calls } = await screenCreate({ closeAt })
    t.is(calls.filter((c) => c === 'finish').length, 0)
    t.is(output.url, null)
    t.is(output.draft.phase, 'idle')
  }
  for (const closeAt of ['finish', 'inviteCard.sign']) {
    const { output, calls } = await screenCreate({ closeAt })
    t.is(calls.filter((c) => c === 'finish').length, 1)
    t.ok(output.url.startsWith(ORIGIN + '/convite/' + CODE), 'the spent invite stays for the next opening')
    t.is(output.draft.phase, 'idle')
  }
})

test('problem names what keeps the card back', async (t) => {
  const { problem, room, PROBLEM_TEXT } = await load()
  const base = { name: 'Ana', design: 'minas', message: 'Vem!' }
  t.is(problem(base, ORIGIN), null)
  t.is(problem({ ...base, name: '   ' }, ORIGIN), 'nome')
  t.is(problem({ ...base, name: 'a'.repeat(41) }, ORIGIN), 'nome-longo')
  t.is(problem({ ...base, name: 'a'.repeat(40) }, ORIGIN), null)
  t.is(problem({ ...base, message: '  ' }, ORIGIN), 'mensagem-vazia')
  t.is(problem({ ...base, message: 'oi\u202e' }, ORIGIN), 'mensagem-simbolos')
  t.is(problem({ ...base, message: 'a'.repeat(room({ ...base, origin: ORIGIN }) + 1) }, ORIGIN), 'mensagem-longa')
  t.is(problem({ ...base, message: 'a'.repeat(201) }, ORIGIN), 'mensagem-longa', 'over 200 code points is a length problem')
  for (const key of ['nome', 'nome-longo', 'mensagem-vazia', 'mensagem-simbolos', 'mensagem-longa']) t.ok(PROBLEM_TEXT[key])
})

test('a listed term in the name or the message keeps the card from being signed', async (t) => {
  const { cardFields, cardRefusal, initialCompose } = await load()
  const { BLOCKED_TERMS } = await import('../src/blockedTerms.js')
  const { refusalText } = await import('../src/wordCheck.js')
  const term = BLOCKED_TERMS[0]
  const base = { ...initialCompose(), enabled: true, name: 'Ana', message: 'Vem!' }
  t.is(cardRefusal(base), '')
  t.ok(cardFields(base, ORIGIN), 'an ordinary card is signed')
  for (const state of [{ ...base, name: term }, { ...base, message: 'Vem, ' + term + '!' }]) {
    t.is(cardRefusal(state), refusalText(term))
    t.is(cardFields(state, ORIGIN), null, 'no fields, so nothing to sign and the button waits')
  }
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Convites.js'), 'utf8')
  t.ok(src.includes('<ErrorText>{cardRefused}</ErrorText>'), 'Convites shows the refusal')
})

test('the counter has room before the name is typed', async (t) => {
  const { counterText, room } = await load()
  const fields = { origin: ORIGIN, name: '', design: 'minas', message: 'oi' }
  t.ok(room(fields) > 0)
  t.absent(counterText(fields).endsWith(' de 0 bytes'))
  t.ok(room({ ...fields, name: 'Ana Maria' }) < room(fields), 'the room tightens as the name grows')
})

test('an incomplete card keeps its label and waits; the plain flow is unchanged', async (t) => {
  const { initialCompose, composeTransition, createLabel, cardFields } = await load()
  const on = composeTransition(initialCompose(), { type: 'toggle' })
  t.is(on.name, '')
  t.is(createLabel(on, ORIGIN), 'Criar link com cartão')
  t.is(cardFields(on, ORIGIN), null, 'the screen disables create while the card is incomplete')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Convites.js'), 'utf8')
  t.ok(src.includes('const cardMissing = draft.enabled && cardFields(draft, origin) === null'))
  t.ok(src.includes('disabled={busy || limitHit || awaitingDrop || noLeft || cardMissing}'))
  t.ok(src.includes("{cardMissing && cardRefused === '' ? <Soft>{PROBLEM_TEXT[problem(draft, origin)]}</Soft> : null}"))
  const off = initialCompose()
  t.is(createLabel(off, ORIGIN), 'Criar link de convite')
  const { output, calls } = await screenCreate({ draft: { enabled: false, name: '' } })
  t.is(output.url, ORIGIN + '/convite/' + CODE)
  t.is(calls.filter((c) => c.method === 'inviteCard.sign').length, 0)
})
