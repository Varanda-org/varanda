'use strict'

const test = require('brittle')
const { MAX_TEXT, feira, displayText } = require('@varanda/rpc')

const load = () => import('../src/anunciarSteps.js')
const form = (patch = {}) => ({ kind: 'produto', title: 'Mesa', text: 'Pouco uso.', priceMode: 'valor', priceText: '25,50', unit: null, cat: 'moveis', uf: 'SP', city: 'Santos', bairro: 'Gonzaga', ...patch })

test('anunciarSteps: order, titles and optional photos', async (t) => {
  const { STEPS, STEP_TITLES, stepErrors, canAdvance } = await load()
  t.alike(STEPS, ['fotos', 'detalhes', 'preco', 'revisao'])
  t.alike(STEP_TITLES, ['Fotos', 'O que é', 'Preço e lugar', 'Revisão'])
  t.alike(stepErrors({}, 'fotos', false), [])
  t.ok(canAdvance({}, 'fotos', false))
  t.absent(canAdvance(form(), 'missing', true))
})

test('anunciarSteps: every field error belongs to one step', async (t) => {
  const { STEPS, stepErrors, canAdvance } = await load()
  const { validateListingForm } = await import('../src/feira.js')
  const cases = [
    ['detalhes', { kind: '' }],
    ['detalhes', { title: '' }],
    ['detalhes', { title: 'x'.repeat(feira.MAX_LISTING_TITLE + 1) }],
    ['detalhes', { title: 'Mesa\u0000' }],
    ['detalhes', { text: 'x'.repeat(MAX_TEXT + 1) }],
    ['detalhes', { text: 'Mesa\u0000' }],
    ['detalhes', { cat: '' }],
    ['preco', { priceMode: '' }],
    ['preco', { priceText: '' }],
    ['preco', { priceText: '0' }],
    ['preco', { unit: 'hora' }],
    ['preco', { kind: 'procura', unit: 'a-partir' }],
    ['preco', { kind: 'servico', priceMode: 'combinar', unit: 'hora' }],
    ['preco', { priceMode: 'gratis', unit: 'a-partir' }],
    ['preco', { uf: '' }],
    ['preco', { city: '' }],
    ['preco', { city: 'x'.repeat(feira.MAX_PLACE + 1) }],
    ['preco', { bairro: 'x'.repeat(feira.MAX_PLACE + 1) }]
  ]
  for (const [owner, patch] of cases) {
    const draft = form(patch)
    const { field, error } = validateListingForm(draft)
    t.ok(field && error, 'the shared check rejects ' + JSON.stringify(patch))
    for (const step of STEPS) {
      t.alike(stepErrors(draft, step, true), step === owner ? [{ field, error }] : [], step + ': ' + field)
      t.is(canAdvance(draft, step, true), step !== owner)
    }
    t.alike(draft, form(patch), 'checking does not change the draft')
  }
})

test('anunciarSteps: unfinished steps do not mask each other', async (t) => {
  const { stepErrors, canAdvance } = await load()
  const { emptyForm } = await import('../src/feiraCompose.js')
  const draft = emptyForm()
  t.alike(stepErrors(draft, 'detalhes', false).map((e) => e.field), ['title', 'cat'])
  t.alike(stepErrors(draft, 'preco', false).map((e) => e.field), ['price', 'uf', 'city'])
  t.ok(canAdvance({ ...draft, title: 'Mesa', cat: 'moveis' }, 'detalhes', false))
  t.ok(canAdvance({ ...draft, priceMode: 'gratis', uf: 'SP', city: 'Santos' }, 'preco', false))
  t.alike(stepErrors(null, 'detalhes', false).map((e) => e.field), ['kind', 'title', 'cat'])
})

test('anunciarSteps: acknowledgement belongs only to review', async (t) => {
  const { STEPS, stepErrors, canAdvance } = await load()
  const { ACK_ERROR } = await import('../src/feiraCompose.js')
  for (const ack of [false, undefined, 1, 'true']) {
    for (const step of STEPS) {
      t.alike(stepErrors(form(), step, ack), step === 'revisao' ? [{ field: 'ack', error: ACK_ERROR }] : [])
      t.is(canAdvance(form(), step, ack), step !== 'revisao')
    }
  }
  t.ok(canAdvance(form(), 'revisao', true))
})

test('anunciarSteps: word refusals stay with the step containing the text', async (t) => {
  const { STEPS, stepErrors } = await load()
  const { BLOCKED_TERMS } = await import('../src/blockedTerms.js')
  const { validateListingForm } = await import('../src/feira.js')
  for (const field of ['title', 'text', 'city', 'bairro']) {
    const draft = form({ [field]: BLOCKED_TERMS[0] })
    const result = validateListingForm(draft)
    const owner = field === 'title' || field === 'text' ? 'detalhes' : 'preco'
    t.is(result.field, '')
    for (const step of STEPS) t.alike(stepErrors(draft, step, true), step === owner ? [{ field: '', error: result.error }] : [])
  }
})

test('anunciarSteps: preview matches the listing fields without uploading photos', async (t) => {
  const { previewListing } = await load()
  const { validateListingForm } = await import('../src/feira.js')
  for (const kind of ['produto', 'servico', 'procura']) {
    for (const priceMode of ['valor', 'gratis', 'combinar']) {
      const draft = form({ kind, priceMode, title: ' Mesa ', city: ' Santos ' })
      const snapshot = structuredClone(draft)
      const result = validateListingForm(draft)
      t.ok(result.ok)
      t.alike(previewListing(draft), { ...result.value, status: 'disponivel', stale: false, media: [] })
      t.alike(draft, snapshot)
    }
  }
  t.is(previewListing(form({ kind: 'servico', unit: 'hora' })).unit, 'hora')
  t.is(previewListing(form({ bairro: '' })).place.bairro, null)
  const unsafe = 'Mesa\u0000\u200f'
  const preview = previewListing(form({ title: unsafe, text: unsafe, city: unsafe, bairro: unsafe, uf: unsafe }))
  for (const value of [preview.title, preview.text, preview.place.city, preview.place.bairro, preview.place.uf]) t.is(value, displayText(unsafe))
})
