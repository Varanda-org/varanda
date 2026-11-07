// The Feira's composer and listing detail decisions: the Anunciar form
// state, the photos it carries, where a listing goes (the member's diary or
// a page acted as), the submission with its uploads, and the actions the
// Anúncio screen offers. Pure ES module: no React, no platform module, no
// Node built-ins; uploads and requests are passed in, so Node's import()
// tests every branch with fakes.
//
// No automatic retry: a failed upload or send only reports. An unknown
// outcome (uncertain) keeps the photo bytes and the descriptors already
// obtained, and hands back the error's own retry (the same signed bytes),
// which only a person's press may call. Photos uploaded for one identity are
// never sent as another: a change of identity during the uploads cancels
// the submission and the late descriptor is dropped.

import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'
import { KIND_LABELS, statusLabel, statusOptions, unitOptions, validateListingForm, parsePriceText } from './feira.js'

const { feira } = rpc

export const MAX_PHOTOS = MAX_MEDIA_PER_POST
export const ACK_TEXT = 'Público na web e em buscadores'
export const ACK_ERROR = 'Confirme que o anúncio fica público na web e em buscadores.'
export const PHOTOS_NOTE = 'até ' + MAX_PHOTOS + ' fotos por anúncio'
export const IDENTITY_CHANGED = 'Você trocou de perfil durante o envio. Nada foi publicado.'
export const UNKNOWN_STATUS = 'Situação desconhecida'
export const KIND_ORDER = Object.freeze(['produto', 'servico', 'procura'])

const HEX64 = /^[0-9a-f]{64}$/
const isKey = (v) => typeof v === 'string' && HEX64.test(v)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const refOf = (author, seq) => author + ':' + seq

export const kindChoices = () => KIND_ORDER.map((kind) => ({ kind, label: KIND_LABELS[kind] }))

// A procura states a budget ("até quanto"), never a price.
export function priceFieldLabel (kind) {
  return kind === 'procura' ? 'Até quanto você paga' : 'Valor'
}

export function priceModeChoices (kind) {
  return [
    { mode: 'valor', label: kind === 'procura' ? 'Até um valor' : 'Valor' },
    { mode: 'combinar', label: 'A combinar' },
    { mode: 'gratis', label: kind === 'procura' ? 'Sem pagamento' : 'Grátis' }
  ]
}

export function emptyForm ({ uf = '', city = '' } = {}) {
  return { kind: 'produto', title: '', text: '', priceMode: 'valor', priceText: '', unit: null, cat: '', uf, city, bairro: '' }
}

// The price the unit rule sees while the person types: an unreadable value
// still counts as a positive price, so the unit choices do not flicker.
function formPrice (form) {
  if (form.priceMode === 'combinar') return null
  if (form.priceMode === 'gratis') return 0
  const cents = parsePriceText(form.priceText)
  return cents === null || cents === 0 ? 100 : cents
}

// The units the form offers now (feira.unitAllowed, through feira.js).
export function unitChoices (form) {
  if (!form || !feira.isKind(form.kind)) return [null]
  return unitOptions(form.kind, formPrice(form))
}

// The form after a change: a unit the new kind or price refuses goes back
// to none, so the form never holds a pair core refuses.
export function updateForm (form, patch) {
  const next = { ...form, ...patch }
  if (next.unit !== null && !unitChoices(next).includes(next.unit)) next.unit = null
  return next
}

// Picking photos: how many of `picked` fit next to `current`.
export function photoRoom (current, picked) {
  const room = Math.max(0, MAX_PHOTOS - (Number.isSafeInteger(current) ? current : 0))
  const take = Math.min(room, Number.isSafeInteger(picked) && picked > 0 ? picked : 0)
  return { take, note: picked > take ? PHOTOS_NOTE : '' }
}

// Where a listing goes: the page acted as (hosted, pages on) or the
// member's own diary. -> { kind: 'personal' } | { kind: 'page', page }.
export function destinationOf ({ actingPage = null } = {}) {
  return isKey(actingPage) ? { kind: 'page', page: actingPage } : { kind: 'personal' }
}

// The identity a descriptor is valid for.
export function identityOf (dest) {
  return dest && dest.kind === 'page' && isKey(dest.page) ? 'page:' + dest.page : 'me'
}

// A photo: { id, encoded: { bytes, mime, width, height }, descriptor,
// identity, retry }. A descriptor or a pending signed upload of another
// identity is dropped (the bytes stay on the device; nothing is uploaded
// until the next press): the retry would land under the old identity.
export function photosFor (photos, identity) {
  return photos.map((p) => ((p.descriptor || typeof p.retry === 'function') && p.identity !== identity ? { ...p, descriptor: null, identity: null, retry: null } : p))
}

// The request a listing creation becomes, or the first problem. Nothing is
// uploaded before this passes: a refusal costs no bytes.
export function createCheck ({ form, ack, dest } = {}) {
  if (ack !== true) return { ok: false, field: 'ack', error: ACK_ERROR }
  const v = validateListingForm(form)
  if (!v.ok) return v
  return { ok: true, value: v.value, dest: dest && dest.kind === 'page' ? dest : { kind: 'personal' } }
}

// -> { method, params } for the member, { action, page, op } for a page.
export function createRequest (value, dest, media) {
  const fields = { kind: value.kind, title: value.title, text: value.text, price: value.price, unit: value.unit, cat: value.cat, place: value.place }
  if (Array.isArray(media) && media.length > 0) fields.media = media
  if (dest.kind === 'page') return { action: 'listing', page: dest.page, op: fields }
  return { method: 'listing.create', params: fields }
}

const sameMime = (d, encoded) => d && typeof d === 'object' && encoded && d.mime === encoded.mime

// Uploads the photos that have no descriptor for `identity`, one at a time.
// -> { ok: true, photos, media } | { ok: false, photos, error, uncertain?,
// cancelled? }. deps: uploadOne(photo, dest) -> descriptor; validDescriptor;
// currentIdentity() read after every upload.
async function uploadPhotos (photos, dest, identity, deps) {
  const out = photosFor(photos, identity)
  const media = []
  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    if (p.descriptor) {
      media.push(p.descriptor)
      continue
    }
    if (!p.encoded) return { ok: false, photos: out, error: 'Foto ainda não está pronta.' }
    let d
    try {
      d = await deps.uploadOne(p, dest)
    } catch (err) {
      const uncertain = !!(err && err.uncertain === true)
      out[i] = { ...p, identity, retry: uncertain && typeof err.retry === 'function' ? err.retry : null }
      if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, photos: photosFor(out, deps.currentIdentity()), error: IDENTITY_CHANGED }
      return { ok: false, uncertain, photos: out, error: err }
    }
    // A descriptor that lands after the identity changed belongs to the
    // old identity: it is dropped and the submission stops.
    if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, photos: photosFor(out, deps.currentIdentity()), error: IDENTITY_CHANGED }
    if (!deps.validDescriptor(d) || !sameMime(d, p.encoded)) return { ok: false, photos: out, error: 'resposta inválida' }
    out[i] = { ...p, descriptor: d, identity, retry: null }
    media.push(d)
  }
  return { ok: true, photos: out, media }
}

// The whole Anunciar press: check, upload, send. deps: { uploadOne,
// validDescriptor, currentIdentity, send(request) }. Never retries: a
// failure answers once, with the photos as they stand (bytes kept).
// -> { ok: true, answer, photos } | { ok: false, error, field?, photos,
// uncertain?, retry?, cancelled?, stage? }. stage 'send' marks a failure of
// the creation itself: when uncertain, the listing may exist already.
export async function submitListing ({ form, ack, dest, photos = [] }, deps) {
  const check = createCheck({ form, ack, dest })
  if (!check.ok) return { ...check, photos }
  if (photos.length > MAX_PHOTOS) return { ok: false, field: 'photos', error: PHOTOS_NOTE, photos }
  const identity = identityOf(check.dest)
  if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, error: IDENTITY_CHANGED, photos }
  const up = await uploadPhotos(photos, check.dest, identity, deps)
  if (!up.ok) return up
  if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, error: IDENTITY_CHANGED, photos: photosFor(up.photos, deps.currentIdentity()) }
  const request = createRequest(check.value, check.dest, up.media)
  try {
    return { ok: true, answer: await deps.send(request), photos: up.photos }
  } catch (err) {
    const uncertain = !!(err && err.uncertain === true)
    return {
      ok: false,
      error: err,
      uncertain,
      retry: uncertain && typeof err.retry === 'function' ? err.retry : null,
      stage: 'send',
      identity,
      photos: up.photos
    }
  }
}

// A pending retry stays usable only for the identity that signed it.
export function retryUsable (pending, identity) {
  return !!(pending && typeof pending.retry === 'function' && pending.identity === identity)
}

// Whether a failed press must lock the form: an unknown outcome of the
// creation itself, with or without a signed retry. A plain RPC timeout has
// no retry, and pressing Anunciar again would create a second listing.
export function holdsPublication (r) {
  return !!(r && r.ok !== true && r.uncertain === true && r.cancelled !== true && r.stage === 'send')
}

export const UNKNOWN_PUBLICATION = 'Não sabemos se o anúncio foi publicado. Confira em Meus anúncios antes de anunciar de novo.'

// ---- edit (wired in PR4) -------------------------------------------------

// 2500 -> '25,00'; 123456 -> '1.234,56'.
export function priceText (cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) return ''
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return whole + ',' + String(cents % 100).padStart(2, '0')
}

const rawPlace = (p) => (p && typeof p === 'object' ? p : {})

// The edit form of a listing (a listing.mine item with `seq`, or a verified
// view with `author` and `seq`). The kind is locked: an edit carries none.
// expectedRevision is the live edit's seq, 0 when there is none. `author`
// names the diary for a listing.mine item, which carries none.
export function editModel (listing, { author = null } = {}) {
  if (!listing || typeof listing !== 'object' || !isSeq(listing.seq) || !feira.isKind(listing.kind)) return null
  const place = rawPlace(listing.place)
  const price = listing.price
  return {
    seq: listing.seq,
    author: isKey(listing.author) ? listing.author : (isKey(author) ? author : null),
    kind: listing.kind,
    kindLocked: true,
    expectedRevision: isSeq(listing.editSeq) ? listing.editSeq : 0,
    media: Array.isArray(listing.media) ? listing.media.slice(0, MAX_PHOTOS) : [],
    form: {
      kind: listing.kind,
      title: typeof listing.title === 'string' ? listing.title : '',
      text: typeof listing.text === 'string' ? listing.text : '',
      priceMode: price === null ? 'combinar' : price === 0 ? 'gratis' : 'valor',
      priceText: priceText(price),
      unit: listing.unit === undefined ? null : listing.unit,
      cat: listing.cat,
      uf: place.uf,
      city: typeof place.city === 'string' ? place.city : '',
      bairro: typeof place.bairro === 'string' ? place.bairro : ''
    }
  }
}

// The listing.edit snapshot. `media`: the descriptors to show, kept ones and
// newly uploaded ones in order; none -> null (photos dropped). `to` is the
// root's ref: an edit never moves the link.
export function editRequest (model, form, media, dest) {
  if (!model || !isSeq(model.seq)) return { ok: false, field: 'kind', error: 'Anúncio inválido.' }
  if (form && form.kind !== model.kind) return { ok: false, field: 'kind', error: 'O tipo do anúncio não muda depois de publicado.' }
  const v = validateListingForm({ ...form, kind: model.kind })
  if (!v.ok) return v
  const author = dest && dest.kind === 'page' ? dest.page : model.author
  if (!isKey(author)) return { ok: false, field: 'kind', error: 'Anúncio inválido.' }
  const list = Array.isArray(media) ? media.slice(0, MAX_PHOTOS) : []
  const fields = {
    to: refOf(author, model.seq),
    expectedRevision: model.expectedRevision,
    title: v.value.title,
    text: v.value.text,
    price: v.value.price,
    unit: v.value.unit,
    cat: v.value.cat,
    place: v.value.place,
    media: list.length > 0 ? list : null
  }
  if (dest && dest.kind === 'page') return { ok: true, request: { action: 'listing-edit', page: dest.page, op: fields } }
  return { ok: true, request: { method: 'listing.edit', params: fields } }
}

// The answer's seq is the new edit block: the next expectedRevision.
export function nextRevision (model, answer) {
  return answer && isSeq(answer.seq) ? { ...model, expectedRevision: answer.seq } : model
}

// ---- the Anúncio screen ----------------------------------------------------

// Who may change a listing from this screen: its author as the member, or
// the page acted as when the listing is that page's.
export function ownerDest (listing, { me = null, actingPage = null } = {}) {
  if (!listing || !isKey(listing.author)) return null
  if (isKey(actingPage) && listing.author === actingPage) return { kind: 'page', page: actingPage }
  if (!isKey(actingPage) && listing.author === me) return { kind: 'personal' }
  return null
}

// The status buttons for the owner: every status the kind allows except the
// current one ('Encontrei' for a found procura). None while the status is
// unknown (stale index row): the owner re-reads it first.
export function statusButtons (listing) {
  if (!listing || listing.stale === true || !feira.isStatus(listing.status)) return []
  return statusOptions(listing.kind)
    .filter((s) => s !== listing.status)
    .map((status) => ({ status, label: listing.kind === 'procura' && status === 'vendido' ? 'Encontrei' : statusLabel(status, 'produto') }))
}

export function statusBadge (listing) {
  if (!listing) return ''
  if (listing.stale === true || !feira.isStatus(listing.status)) return UNKNOWN_STATUS
  return listing.status === 'disponivel' ? '' : statusLabel(listing.status, listing.kind)
}

export function statusRequest (listing, status, dest) {
  const to = refOf(listing.author, listing.seq)
  if (dest.kind === 'page') return { action: 'listing-status', page: dest.page, op: { to, status } }
  return { method: 'listing.status', params: { to, status } }
}

// A page deletes through its 'delete' statement, which takes the listing
// with its live edit in one append.
export function deleteRequest (listing, dest) {
  const to = refOf(listing.author, listing.seq)
  if (dest.kind === 'page') return { action: 'delete', page: dest.page, op: { to } }
  return { method: 'listing.delete', params: { to } }
}

export function reportTarget (listing) {
  if (!listing || !isKey(listing.author) || !isSeq(listing.seq)) return null
  return { kind: 'listing', author: listing.author, seq: listing.seq, title: typeof listing.title === 'string' ? listing.title : '' }
}

// The actions the screen shows. owner from ownerDest; online from node.online.
export function detailActions (listing, { owner = null, online = true } = {}) {
  if (!listing) return { conversar: false, compartilhar: false, salvar: false, denunciar: false, statuses: [], apagar: false }
  const mine = owner !== null
  return {
    conversar: !mine && online,
    compartilhar: true,
    salvar: !mine,
    denunciar: !mine && online,
    statuses: mine && online ? statusButtons(listing) : [],
    apagar: mine && online
  }
}

// The listing with `seq` in an author route answer's verified rows.
export function pickListing (items, seq) {
  if (!Array.isArray(items)) return null
  return items.find((i) => i && i.seq === seq) || null
}

export const FIRST_EDIT_NOTE = 'A primeira versão (título, texto e fotos) continua no seu diário até você apagar o anúncio. A página pública mostra a versão nova.'
export const EDIT_CONFLICT = 'Este anúncio mudou em outro aparelho. Recarregue para editar a versão atual.'
export const UNKNOWN_EDIT = 'Não sabemos se a edição foi gravada. Recarregue o anúncio antes de editar de novo.'

// Whether this edit would be the listing's first: the root stays readable in
// the diary, which the person is told before pressing.
export function firstEdit (model) {
  return !!(model && model.expectedRevision === 0)
}

// The listing's current photos as composer photos, tied to the identity
// that owns the listing: they are sent again as they are, never uploaded.
export function keptPhotos (model, identity) {
  if (!model || !Array.isArray(model.media)) return []
  return model.media.slice(0, MAX_PHOTOS).map((d, i) => ({ id: 'kept:' + i, kept: true, encoded: null, descriptor: d, identity, retry: null }))
}

// The whole Salvar press of an edit: check, upload the new photos, send
// listing.edit (or the page's 'listing-edit') with expectedRevision. Never
// retries. A 'conflito' (someone else edited first) leaves the form and the
// photos as they are and asks for a reload. -> { ok: true, answer, model,
// photos } with model at the next revision | { ok: false, error, field?,
// photos, conflict?, uncertain?, retry?, cancelled?, stage?, identity? }.
export async function submitEdit ({ model, form, dest, photos = [] }, deps) {
  const to = dest && dest.kind === 'page' ? dest : { kind: 'personal' }
  const check = editRequest(model, form, [], to)
  if (!check.ok) return { ...check, photos }
  if (photos.length > MAX_PHOTOS) return { ok: false, field: 'photos', error: PHOTOS_NOTE, photos }
  const identity = identityOf(to)
  if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, error: IDENTITY_CHANGED, photos }
  const up = await uploadPhotos(photos, to, identity, deps)
  if (!up.ok) return up
  if (deps.currentIdentity() !== identity) return { ok: false, cancelled: true, error: IDENTITY_CHANGED, photos: photosFor(up.photos, deps.currentIdentity()) }
  const plan = editRequest(model, form, up.media, to)
  if (!plan.ok) return { ...plan, photos: up.photos }
  try {
    const answer = await deps.send(plan.request)
    return { ok: true, answer, model: nextRevision(model, answer), photos: up.photos }
  } catch (err) {
    const uncertain = !!(err && err.uncertain === true)
    // The node answers USAGE with the message 'conflito' (listing.edit); a
    // page's service answers the token 'conflito' as the code.
    if (!uncertain && err && (err.code === 'conflito' || (err.code === 'USAGE' && err.message === 'conflito'))) return { ok: false, conflict: true, error: EDIT_CONFLICT, stage: 'send', identity, photos: up.photos }
    return {
      ok: false,
      error: err,
      uncertain,
      retry: uncertain && typeof err.retry === 'function' ? err.retry : null,
      stage: 'send',
      identity,
      photos: up.photos
    }
  }
}
