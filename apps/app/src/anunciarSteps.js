import rpc from '@varanda/rpc'
import { parsePriceText, validateListingForm } from './feira.js'
import { ACK_ERROR } from './feiraCompose.js'

const { displayText, feira } = rpc

export const STEPS = Object.freeze(['fotos', 'detalhes', 'preco', 'revisao'])
export const STEP_TITLES = Object.freeze(['Fotos', 'O que é', 'Preço e lugar', 'Revisão'])

const fields = {
  detalhes: ['kind', 'title', 'text', 'cat'],
  preco: ['priceMode', 'priceText', 'unit', 'uf', 'city', 'bairro']
}
// Other steps need complete values because the shared check stops at the
// first error. These values never enter the draft or a publish request.
const complete = { kind: 'produto', title: 'Anúncio', text: '', cat: 'outros', priceMode: 'valor', priceText: '1', unit: null, uf: 'SP', city: 'São Paulo', bairro: '' }

export function stepErrors (form, step, ack) {
  if (step === 'revisao') return ack === true ? [] : [{ field: 'ack', error: ACK_ERROR }]
  if (!Object.hasOwn(fields, step)) return []
  const draft = { ...complete }
  for (const key of fields[step]) draft[key] = form?.[key]
  if (step === 'preco' && feira.isKind(form?.kind)) draft.kind = form.kind
  const errors = []
  while (true) {
    const result = validateListingForm(draft)
    if (result.ok) return errors
    const { field, error } = result
    errors.push({ field, error })
    // The word check has no field and already sees only this step's text.
    if (field === '') return errors
    if (field === 'price') {
      draft.priceMode = complete.priceMode
      draft.priceText = complete.priceText
    } else draft[field] = complete[field]
  }
}

export function canAdvance (form, step, ack) {
  return STEPS.includes(step) && stepErrors(form, step, ack).length === 0
}

export function previewListing (form) {
  const text = (value) => displayText(typeof value === 'string' ? value.trim() : '')
  return {
    kind: form.kind,
    title: text(form.title),
    text: displayText(typeof form.text === 'string' ? form.text.trim() : '', { multiline: true }),
    price: form.priceMode === 'combinar' ? null : form.priceMode === 'gratis' ? 0 : parsePriceText(form.priceText),
    unit: form.unit ?? null,
    cat: form.cat,
    place: { uf: text(form.uf), city: text(form.city), bairro: text(form.bairro) || null },
    status: 'disponivel',
    stale: false,
    media: []
  }
}
