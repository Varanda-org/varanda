'use strict'

// The Feira composer and listing detail decisions (src/feiraCompose.js). ES
// modules loaded through import().
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { validateParams } = require('@varanda/rpc')

const load = () => import('../src/feiraCompose.js')
const loadFeira = () => import('../src/feira.js')
const A = 'ab'.repeat(32)
const PAGE = 'cd'.repeat(32)
const ME = 'ef'.repeat(32)

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')

test('feiraCompose: stepped creation keeps the fields, preview and publication controls', (t) => {
  const src = source('src/screens/Anunciar.js')
  const step = (name, next) => src.slice(src.indexOf("{STEPS[index] === '" + name + "'"), next ? src.indexOf("{STEPS[index] === '" + next + "'") : src.indexOf("{error !== '' ?"))
  t.ok(/<Stepper index=\{index\} title=\{STEP_TITLES\[index\]\}>/.test(src))
  t.ok(src.includes("<Btn label='Continuar' block onPress={advance}"))
  t.ok(src.includes("<StepLink label='Voltar' onPress={goBack}"), 'Voltar is a text link that keeps the discard confirm')
  t.ok(src.includes("<Btn label='Publicar anúncio' block onPress={publish}"))
  t.ok(step('fotos', 'detalhes').includes('Fotos só podem ser publicadas na versão web.'))
  t.ok(src.includes("throw new Error('mídia disponível só na versão web')"))
  t.ok(step('detalhes', 'preco').includes("<Field label='Descrição'"))
  t.ok(step('detalhes', 'preco').includes('<Label>Categoria</Label>'))
  t.ok(step('preco', 'revisao').includes("<Field label='Cidade'"))
  t.ok(step('preco', 'revisao').includes('priceFieldLabel(form.kind)'))
  t.ok(step('revisao').includes("<ListingTile listing={previewListing(form)} width='100%' />"))
  t.ok(step('revisao').includes("accessibilityRole='checkbox'") && step('revisao').includes('{ACK_TEXT}'))
  t.ok(src.includes('Público na web e em buscadores'))
  t.ok(src.includes("<Sheet open={confirmLeave} onClose={() => setConfirmLeave(false)} title='Descartar anúncio?'>"))
  t.ok(src.includes("<Soft>{pending !== null ? UNKNOWN_PUBLICATION : 'O que você preencheu será perdido.'}</Soft>"), 'leaving an uncertain publication warns to check existing listings')
  t.ok(src.includes("<Btn label='Descartar' block danger onPress={onBack} />"))
  t.ok(src.includes("<Btn label='Continuar editando' block secondary onPress={() => setConfirmLeave(false)} />"))
})

test('feiraCompose: failed advance keeps errors visible beside the actions and at the field', (t) => {
  const src = source('src/screens/Anunciar.js')
  const advance = src.slice(src.indexOf('const advance = () => {'), src.indexOf('// Descriptors are valid'))
  const failure = advance.match(/if \(problem\) \{([\s\S]*?)\n {4}\}/)
  t.ok(failure, 'advance handles a step error')
  if (!failure) return
  t.absent(failure[1].includes('scrollTo'), 'a refusal keeps the current scroll position')
  t.ok(failure[1].includes('setField(problem.field)') && failure[1].includes('setError(problem.error)'))
  t.ok(src.includes("{error !== '' ? <ErrorText>{error}</ErrorText> : null}"), 'every error is repeated beside the actions')
  t.ok(src.includes("field === name && error !== '' ? <ErrorText>{error}</ErrorText> : null"), 'the field keeps its inline error')
  t.ok(advance.includes('move(index + 1)'), 'success moves to the next step')
  const move = src.slice(src.indexOf('const move = (next) => {'), src.indexOf('const back = () => {'))
  t.ok(move.includes('scrollRef.current?.scrollTo({ y: 0, animated: false })'), 'a new step starts at the top')
})

test('feiraCompose: review preview is labeled and uses a noninteractive tile', (t) => {
  const src = source('src/screens/Anunciar.js')
  t.ok(/<Label>Prévia<\/Label>\s+<ListingTile listing=\{previewListing\(form\)\} width='100%' \/>/.test(src))
  const tile = source('src/ui/ListingTile.js')
  t.ok(/if \(typeof onPress !== 'function'\) \{\s+return <View style=\{\[styles.tile, \{ width \}\]\}>\{content\}<\/View>\s+\}/.test(tile), 'without a press handler the tile is a plain View with the same style and content')
  const content = tile.slice(tile.indexOf('const content = ('), tile.indexOf("if (typeof onPress !== 'function')"))
  t.ok(content.includes('<Text style={styles.title}'), 'the plain preview includes its title')
  t.absent(/accessibilityRole|focusable|aria-hidden|accessibilityElementsHidden|no-hide-descendants|PressScale/.test(content), 'preview content remains readable without a button or focus target')
  t.ok(/<PressScale\s+accessibilityRole='button'[\s\S]*?onPress=\{onPress\}/.test(tile), 'interactive tiles keep their button and handler')
})

test('feiraCompose: back guard steps back and protects a draft at the first step', (t) => {
  const src = source('src/screens/Anunciar.js')
  const match = src.match(/const back = \(\) => \{([\s\S]*?)\n {2}\}\n {2}const backRef/)
  t.ok(match, 'the screen registers its own back decision')
  if (!match) return
  const run = (patch = {}) => {
    const state = { sendingRef: { current: false }, encoding: false, confirmLeave: false, pending: null, index: 0, ack: false, photos: [], initialForm: { current: { title: '', city: 'Santos' } }, form: { title: '', city: 'Santos' }, ...patch }
    const calls = []
    const args = { ...state, move: (index) => calls.push(index), setConfirmLeave: (open) => calls.push(open) }
    const consumed = vm.runInNewContext('(() => {' + match[1] + '})()', args)
    return { consumed, calls }
  }
  t.alike(run(), { consumed: false, calls: [] }, 'initial location alone does not mark a draft')
  for (const index of [1, 2, 3]) t.alike(run({ index }), { consumed: true, calls: [index - 1] })
  for (const index of [0, 1, 2, 3]) {
    for (const pending of [{ retry: null }, { retry: () => {} }]) {
      t.alike(run({ index, pending }), { consumed: true, calls: [true] }, 'an uncertain publication opens the sheet without changing step')
    }
  }
  for (const patch of [{ ack: true }, { photos: [{}] }, { form: { title: 'Mesa', city: 'Santos' } }, { form: { title: '', city: 'Recife' } }]) {
    t.alike(run(patch), { consumed: true, calls: [true] }, 'a draft asks before leaving')
  }
  for (const patch of [{ sendingRef: { current: true } }, { encoding: true }]) {
    for (const index of [0, 1, 2, 3]) {
      t.alike(run({ ...patch, index, ack: true, pending: { retry: null } }), { consumed: false, calls: [] }, 'sending or encoding permits leaving without a step change or sheet')
    }
  }
  t.alike(run({ confirmLeave: true }), { consumed: true, calls: [] }, 'an open confirmation consumes back')
  t.ok(src.includes('if (!back()) onBack()'), 'toolbar and button use the same decision')
  t.ok(src.includes('backRef.current = back'), 'the registered function reads the latest draft')
  t.ok(src.includes('return registerBackGuard(() => backRef.current())'), 'effect returns the registration cleanup')
})

test('feiraCompose: App routes hardware back and Escape through the active guard', (t) => {
  const src = source('App.js')
  t.ok(src.includes('const backGuardRef = useRef(null)'))
  const hardwareStart = src.indexOf("BackHandler.addEventListener('hardwareBackPress'")
  const hardware = src.slice(hardwareStart, src.indexOf('return () => sub.remove()', hardwareStart))
  t.ok(/if \(helpOpenRef.current \|\| sheetOpenRef.current\) return false\s+if \(backGuardRef.current\?\.\(\) === true\) return true/.test(hardware))
  const escape = src.slice(src.indexOf('const onKey = (event) =>'), src.indexOf("globalThis.addEventListener('keydown', onKey)"))
  t.ok(/sheetOpenRef.current\) return\s+if \(backGuardRef.current\?\.\(\) === true\) \{\s+event.preventDefault\(\)\s+return/.test(escape))
  t.ok(src.includes('registerBackGuard={(fn) => registerBackGuard(() => stackRef.current[stackRef.current.length - 1] === entry && fn())}'), 'hidden and departing screens cannot consume back')
  const match = src.match(/const registerBackGuard = useCallback\(\(fn\) => \{([\s\S]*?)\n {2}\}, \[\]\)/)
  t.ok(match, 'registration returns an owned cleanup')
  if (!match) return
  const ref = { current: null }
  const register = vm.runInNewContext('(fn) => {' + match[1] + '}', { backGuardRef: ref })
  const first = () => true
  const second = () => false
  const clearFirst = register(first)
  t.is(ref.current, first)
  const clearSecond = register(second)
  clearFirst()
  t.is(ref.current, second, 'an old unmount preserves the newer guard')
  clearSecond()
  t.is(ref.current, null, 'unmount clears its own guard')
})

const form = (extra = {}) => ({
  kind: 'produto',
  title: 'Bicicleta aro 26',
  text: 'Pouco uso.',
  priceMode: 'valor',
  priceText: '250,00',
  unit: null,
  cat: 'esporte',
  uf: 'SP',
  city: 'São Paulo',
  bairro: 'Pinheiros',
  ...extra
})

let nextId = 0
const photo = (mime = 'image/jpeg') => ({
  id: ++nextId,
  encoded: { bytes: new Uint8Array([1, 2, 3]), mime, width: 10, height: 10 },
  descriptor: null,
  identity: null,
  retry: null
})
const descriptor = (n, mime = 'image/jpeg') => ({ core: 'aa'.repeat(32), mime, start: n, blocks: 1, bytes: 3, sha256: 'bb'.repeat(32), width: 10, height: 10 })

function deps (over = {}) {
  const calls = { uploads: 0, sends: [] }
  let n = 0
  let identity = over.identity || 'me'
  const d = {
    calls,
    setIdentity: (v) => { identity = v },
    uploadOne: async (p) => {
      calls.uploads++
      if (over.onUpload) await over.onUpload(calls.uploads, d)
      return descriptor(++n, p.encoded.mime)
    },
    validDescriptor: (x) => !!x && typeof x.core === 'string',
    currentIdentity: () => identity,
    send: async (req) => {
      calls.sends.push(req)
      if (over.send) return over.send(req)
      return { seq: 9, ref: A + ':9' }
    }
  }
  return d
}

test('feiraCompose: at most four photos', async (t) => {
  const c = await load()
  t.is(c.MAX_PHOTOS, 4)
  t.alike(c.photoRoom(0, 4), { take: 4, note: '' })
  t.alike(c.photoRoom(2, 5), { take: 2, note: c.PHOTOS_NOTE })
  t.alike(c.photoRoom(4, 1), { take: 0, note: c.PHOTOS_NOTE })
  const five = [photo(), photo(), photo(), photo(), photo()]
  const d = deps()
  const r = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: five }, d)
  t.absent(r.ok)
  t.is(d.calls.uploads, 0, 'nothing uploaded')
  const four = five.slice(0, 4)
  const ok = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: four }, deps())
  t.ok(ok.ok)
  t.is(ok.photos.length, 4)
})

test('feiraCompose: unit rules per kind', async (t) => {
  const c = await load()
  t.alike(c.unitChoices(form()), [null, 'a-partir'], 'a product: none or a partir de')
  t.alike(c.unitChoices(form({ kind: 'servico' })), [null, 'hora', 'dia', 'mes', 'servico', 'a-partir'])
  t.alike(c.unitChoices(form({ kind: 'servico', priceMode: 'combinar' })), [null], 'no price, no unit')
  t.alike(c.unitChoices(form({ kind: 'servico', priceMode: 'gratis' })), [null])
  t.alike(c.unitChoices(form({ kind: 'procura' })), [null], 'a procura has no unit')
  t.alike(c.unitChoices(form({ priceText: '' })), [null, 'a-partir'], 'an unfinished value keeps the choices')
  const hourly = c.updateForm(form({ kind: 'servico' }), { unit: 'hora' })
  t.is(hourly.unit, 'hora')
  t.is(c.updateForm(hourly, { kind: 'produto' }).unit, null, 'a unit the new kind refuses is cleared')
  t.is(c.updateForm(hourly, { priceMode: 'combinar' }).unit, null, 'a unit the new price refuses is cleared')
  const ap = c.updateForm(form(), { unit: 'a-partir' })
  t.is(c.updateForm(ap, { kind: 'servico' }).unit, 'a-partir', 'a unit both allow stays')
  for (const kind of ['produto', 'servico', 'procura']) {
    for (const unit of c.unitChoices(form({ kind }))) {
      const r = c.createCheck({ form: form({ kind, unit }), ack: true, dest: { kind: 'personal' } })
      t.ok(r.ok, kind + ' ' + unit + ' is accepted')
      const req = c.createRequest(r.value, r.dest, [])
      t.ok(validateParams(req.method, req.params).ok, 'rpc accepts it')
    }
  }
})

test('feiraCompose: procura budget and no reservado', async (t) => {
  const c = await load()
  t.is(c.priceFieldLabel('procura'), 'Até quanto você paga')
  t.is(c.priceFieldLabel('produto'), 'Valor')
  t.is(c.kindChoices().find((k) => k.kind === 'procura').label, 'Procura-se')
  const r = c.createCheck({ form: form({ kind: 'procura', priceText: '300' }), ack: true, dest: { kind: 'personal' } })
  t.ok(r.ok)
  t.is(r.value.price, 30000, 'the budget is a price in cents')
  t.is(r.value.unit, null)
  const live = { author: A, seq: 3, kind: 'procura', status: 'disponivel', title: 'x' }
  const buttons = c.statusButtons(live)
  t.alike(buttons.map((b) => b.status), ['vendido'], 'no reservado for a procura')
  t.is(buttons[0].label, 'Encontrei')
  t.alike(c.statusButtons({ ...live, kind: 'produto' }).map((b) => b.label), ['Reservado', 'Vendido'])
  t.alike(c.statusButtons({ ...live, kind: 'produto', status: 'reservado' }).map((b) => b.label), ['Disponível', 'Vendido'])
})

test('feiraCompose: stale status shows unknown and offers no status change', async (t) => {
  const c = await load()
  const stale = { author: A, seq: 3, kind: 'produto', status: null, statusLabel: null, stale: true }
  t.is(c.statusBadge(stale), c.UNKNOWN_STATUS)
  t.alike(c.statusButtons(stale), [])
  const acts = c.detailActions(stale, { owner: { kind: 'personal' } })
  t.alike(acts.statuses, [])
  t.ok(acts.apagar, 'delete is still offered')
  t.is(c.statusBadge({ ...stale, stale: false, status: 'disponivel' }), '')
  t.is(c.statusBadge({ ...stale, stale: false, status: 'reservado' }), 'Reservado')
})

test('feiraCompose: personal vs page destination', async (t) => {
  const c = await load()
  t.alike(c.destinationOf({ actingPage: null }), { kind: 'personal' })
  t.alike(c.destinationOf({ actingPage: PAGE }), { kind: 'page', page: PAGE })
  t.alike(c.destinationOf({ actingPage: 'nope' }), { kind: 'personal' })
  t.is(c.identityOf({ kind: 'personal' }), 'me')
  t.is(c.identityOf({ kind: 'page', page: PAGE }), 'page:' + PAGE)

  const personal = deps()
  const r1 = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: [photo()] }, personal)
  t.ok(r1.ok)
  t.is(personal.calls.sends[0].method, 'listing.create')
  t.is(personal.calls.sends[0].params.media.length, 1)
  t.ok(validateParams('listing.create', personal.calls.sends[0].params).ok)

  const page = deps({ identity: 'page:' + PAGE })
  const r2 = await c.submitListing({ form: form(), ack: true, dest: { kind: 'page', page: PAGE }, photos: [] }, page)
  t.ok(r2.ok)
  t.alike(Object.keys(page.calls.sends[0]).sort(), ['action', 'op', 'page'])
  t.is(page.calls.sends[0].action, 'listing')
  t.is(page.calls.sends[0].page, PAGE)
  t.absent('media' in page.calls.sends[0].op, 'no photos: media left out')

  t.alike(c.ownerDest({ author: ME }, { me: ME }), { kind: 'personal' })
  t.alike(c.ownerDest({ author: PAGE }, { me: ME, actingPage: PAGE }), { kind: 'page', page: PAGE })
  t.is(c.ownerDest({ author: ME }, { me: ME, actingPage: PAGE }), null, 'acting as a page, own listings are not the page\'s')
  t.is(c.ownerDest({ author: A }, { me: ME }), null)
  const l = { author: PAGE, seq: 4, kind: 'produto' }
  t.alike(c.statusRequest(l, 'vendido', { kind: 'page', page: PAGE }), { action: 'listing-status', page: PAGE, op: { to: PAGE + ':4', status: 'vendido' } })
  t.alike(c.statusRequest({ ...l, author: ME }, 'vendido', { kind: 'personal' }), { method: 'listing.status', params: { to: ME + ':4', status: 'vendido' } })
  t.alike(c.deleteRequest(l, { kind: 'page', page: PAGE }), { action: 'delete', page: PAGE, op: { to: PAGE + ':4' } })
  t.alike(c.deleteRequest({ ...l, author: ME }, { kind: 'personal' }), { method: 'listing.delete', params: { to: ME + ':4' } })
  t.alike(c.reportTarget({ author: A, seq: 4, title: 'Mesa' }), { kind: 'listing', author: A, seq: 4, title: 'Mesa' })
})

test('feiraCompose: refused without the acknowledgement', async (t) => {
  const c = await load()
  t.is(c.ACK_TEXT, 'Público na web e em buscadores')
  const d = deps()
  for (const ack of [false, undefined, 'sim', 1]) {
    const r = await c.submitListing({ form: form(), ack, dest: { kind: 'personal' }, photos: [photo()] }, d)
    t.absent(r.ok)
    t.is(r.field, 'ack')
    t.is(r.error, c.ACK_ERROR)
  }
  t.is(d.calls.uploads, 0, 'no upload')
  t.is(d.calls.sends.length, 0, 'no send')
  const bad = await c.submitListing({ form: form({ title: '' }), ack: true, dest: { kind: 'personal' }, photos: [photo()] }, d)
  t.is(bad.field, 'title')
  t.is(d.calls.uploads, 0, 'an invalid form uploads nothing')
})

test('feiraCompose: a late upload is discarded after an identity change', async (t) => {
  const c = await load()
  const d = deps({ onUpload: (n, self) => { if (n === 1) self.setIdentity('page:' + PAGE) } })
  const photos = [photo(), photo()]
  const r = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos }, d)
  t.absent(r.ok)
  t.ok(r.cancelled)
  t.is(r.error, c.IDENTITY_CHANGED)
  t.is(d.calls.uploads, 1, 'the next photo is not uploaded')
  t.is(d.calls.sends.length, 0, 'nothing sent')
  t.ok(r.photos.every((p) => p.descriptor === null), 'the late descriptor is dropped')
  t.ok(r.photos.every((p) => p.encoded.bytes.byteLength === 3), 'the bytes stay')

  const before = deps({ identity: 'page:' + PAGE })
  const r2 = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos }, before)
  t.ok(r2.cancelled, 'a destination that is no longer the identity sends nothing')
  t.is(before.calls.uploads, 0)

  const kept = [{ ...photo(), descriptor: descriptor(1), identity: 'me' }]
  t.is(c.photosFor(kept, 'page:' + PAGE)[0].descriptor, null, 'descriptors of another identity are dropped')
  t.ok(c.photosFor(kept, 'me')[0].descriptor, 'the same identity keeps them')
})

test('feiraCompose: no automatic retry; uncertain keeps the bytes', async (t) => {
  const c = await load()
  let resent = 0
  const err = Object.assign(new Error('x'), { uncertain: true, retry: async () => { resent++; return { seq: 9 } } })
  const d = deps({ send: () => { throw err } })
  const photos = [photo(), photo()]
  const r = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos }, d)
  t.absent(r.ok)
  t.ok(r.uncertain)
  t.is(d.calls.sends.length, 1, 'sent once')
  t.is(resent, 0, 'the retry is not called by the controller')
  t.is(typeof r.retry, 'function', 'a person can retry the same signed request')
  t.ok(r.photos.every((p) => p.encoded && p.descriptor), 'bytes and descriptors kept')
  t.ok(c.retryUsable(r, 'me'))
  t.absent(c.retryUsable(r, 'page:' + PAGE), 'a retry is only for the identity that signed')

  const again = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: r.photos }, d)
  t.is(d.calls.uploads, 2, 'a new press does not upload the photos again')
  t.is(again.uncertain, true)

  const upErr = Object.assign(new Error('y'), { uncertain: true, retry: async () => descriptor(5) })
  const failing = deps({ onUpload: () => { throw upErr } })
  const r2 = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: [photo()] }, failing)
  t.ok(r2.uncertain)
  t.is(failing.calls.uploads, 1, 'an upload is not repeated')
  t.is(failing.calls.sends.length, 0)
  t.is(r2.photos[0].retry, upErr.retry, 'the photo keeps its signed upload for a manual retry')
})

test('feiraCompose: editModel round-trips a listing and locks the kind', async (t) => {
  const c = await load()
  const f = await loadFeira()
  const root = {
    type: 'listing',
    kind: 'servico',
    title: 'Aulas de violão',
    text: 'Iniciantes.',
    price: 123456,
    unit: 'hora',
    cat: 'aulas',
    place: { uf: 'RJ', city: 'Niterói', bairro: null },
    media: [descriptor(1)],
    at: '2026-11-01T12:00:00.000Z'
  }
  const view = f.listingView({ author: A, seq: 7, root })
  const model = c.editModel(view)
  t.ok(model.kindLocked)
  t.is(model.kind, 'servico')
  t.is(model.expectedRevision, 0)
  t.is(model.form.priceText, '1.234,56')
  const back = f.validateListingForm(model.form)
  t.ok(back.ok)
  t.alike(back.value, { kind: 'servico', title: root.title, text: root.text, price: root.price, unit: root.unit, cat: root.cat, place: root.place })

  const plan = c.editRequest(model, model.form, model.media, { kind: 'personal' })
  t.ok(plan.ok)
  t.is(plan.request.method, 'listing.edit')
  t.is(plan.request.params.to, A + ':7')
  t.is(plan.request.params.expectedRevision, 0)
  t.alike(plan.request.params.media, [descriptor(1)], 'kept media')
  t.ok(validateParams('listing.edit', plan.request.params).ok)
  t.is(c.editRequest(model, model.form, [], { kind: 'personal' }).request.params.media, null, 'no photos: null drops them')
  const replaced = c.editRequest(model, model.form, [descriptor(2)], { kind: 'personal' })
  t.alike(replaced.request.params.media, [descriptor(2)], 'replaced media')

  const locked = c.editRequest(model, { ...model.form, kind: 'produto' }, [], { kind: 'personal' })
  t.absent(locked.ok, 'the kind cannot change')
  t.is(locked.field, 'kind')

  const next = c.nextRevision(model, { seq: 12, ref: A + ':7' })
  t.is(next.expectedRevision, 12, 'the answer seq is the next expectedRevision')
  t.is(c.nextRevision(model, {}).expectedRevision, 0)

  const mine = { seq: 5, editSeq: 8, kind: 'produto', title: 'Mesa', text: '', price: null, unit: null, cat: 'moveis', place: { uf: 'SP', city: 'Santos', bairro: 'Gonzaga' }, media: [] }
  const m2 = c.editModel(mine, { author: PAGE })
  t.is(m2.expectedRevision, 8)
  t.is(m2.form.priceMode, 'combinar')
  const p2 = c.editRequest(m2, m2.form, [], { kind: 'page', page: PAGE })
  t.is(p2.request.action, 'listing-edit')
  t.is(p2.request.op.to, PAGE + ':5')
  t.is(p2.request.op.expectedRevision, 8)
  t.ok(validateParams('listing.edit', p2.request.op).ok)
  t.is(c.editModel({ seq: 0, kind: 'produto' }), null)
  t.is(c.editModel(null), null)
  const free = c.editModel({ ...mine, price: 0 })
  t.is(free.form.priceMode, 'gratis')
  t.is(free.form.priceText, '')
})

test('feiraCompose: detail actions', async (t) => {
  const c = await load()
  const l = { author: A, seq: 3, kind: 'produto', status: 'disponivel' }
  const reader = c.detailActions(l, { owner: null, online: true })
  t.ok(reader.conversar && reader.salvar && reader.denunciar && reader.compartilhar)
  t.absent(reader.apagar)
  t.alike(reader.statuses, [])
  const owner = c.detailActions(l, { owner: { kind: 'personal' }, online: true })
  t.absent(owner.conversar)
  t.absent(owner.denunciar)
  t.ok(owner.apagar)
  t.is(owner.statuses.length, 2)
  const off = c.detailActions(l, { owner: { kind: 'personal' }, online: false })
  t.absent(off.apagar)
  t.alike(off.statuses, [])
  t.is(c.pickListing([{ seq: 1 }, { seq: 3 }], 3).seq, 3)
  t.is(c.pickListing(null, 3), null)
})

test('feiraCompose: a pending photo upload does not follow an identity change', async (t) => {
  const c = await load()
  const upErr = Object.assign(new Error('y'), { uncertain: true, retry: async () => descriptor(7) })
  const failing = deps({ identity: 'page:' + PAGE, onUpload: () => { throw upErr } })
  const r = await c.submitListing({ form: form(), ack: true, dest: { kind: 'page', page: PAGE }, photos: [photo()] }, failing)
  t.ok(r.uncertain)
  t.is(r.photos[0].identity, 'page:' + PAGE, 'the signed upload is tied to the page that signed it')
  t.is(r.photos[0].retry, upErr.retry)
  t.is(c.photosFor(r.photos, 'page:' + PAGE)[0].retry, upErr.retry, 'the same page keeps it')
  const moved = c.photosFor(r.photos, 'me')
  t.is(moved[0].retry, null, 'another identity drops the old signed upload')
  t.ok(moved[0].encoded, 'the bytes stay')
  const d = deps()
  const r2 = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: moved }, d)
  t.ok(r2.ok)
  t.is(d.calls.uploads, 1, 'the photo is uploaded again as the new identity')
  t.absent(c.holdsPublication(r), 'an uncertain upload created no listing: the press stays free')
})

test('feiraCompose: an unknown creation outcome holds the form even without a retry', async (t) => {
  const c = await load()
  const err = Object.assign(new Error('timeout'), { uncertain: true })
  const d = deps({ send: () => { throw err } })
  const r = await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: [] }, d)
  t.ok(r.uncertain)
  t.is(r.retry, null)
  t.is(r.stage, 'send')
  t.ok(c.holdsPublication(r), 'a second press could create a second listing')
  t.ok(c.UNKNOWN_PUBLICATION.length > 0)
  const refused = deps({ send: () => { throw Object.assign(new Error('no'), { code: 'limite' }) } })
  t.absent(c.holdsPublication(await c.submitListing({ form: form(), ack: true, dest: { kind: 'personal' }, photos: [] }, refused)), 'a refusal frees the press')
  t.absent(c.holdsPublication({ ok: false, uncertain: true, cancelled: true, stage: 'send' }))
})

test('feiraCompose: submitEdit keeps kind and seq, sends expectedRevision, replaces photos', async (t) => {
  const c = await load()
  const mine = { seq: 5, editSeq: 8, kind: 'produto', title: 'Mesa', text: '', price: 2500, unit: null, cat: 'moveis', place: { uf: 'SP', city: 'Santos', bairro: 'Gonzaga' }, media: [descriptor(1), descriptor(2)] }
  const model = c.editModel(mine, { author: ME })
  t.absent(c.firstEdit(model), 'an edited listing is not on its first edit')
  t.ok(c.firstEdit(c.editModel({ ...mine, editSeq: undefined }, { author: ME })))
  const kept = c.keptPhotos(model, 'me')
  t.is(kept.length, 2)
  t.ok(kept.every((p) => p.kept && p.descriptor && p.identity === 'me'))

  const d = deps({ send: () => ({ seq: 11, ref: ME + ':5' }) })
  const r = await c.submitEdit({ model, form: { ...model.form, title: 'Mesa de jantar' }, dest: { kind: 'personal' }, photos: [kept[1], photo()] }, d)
  t.ok(r.ok)
  t.is(d.calls.uploads, 1, 'only the new photo is uploaded')
  t.is(d.calls.sends.length, 1)
  const sent = d.calls.sends[0]
  t.is(sent.method, 'listing.edit')
  t.is(sent.params.to, ME + ':5', 'the seq is kept')
  t.is(sent.params.expectedRevision, 8)
  t.is(sent.params.kind, undefined, 'an edit carries no kind')
  t.is(sent.params.title, 'Mesa de jantar')
  t.alike(sent.params.media, [descriptor(2), descriptor(1)], 'kept then new, in order')
  t.ok(validateParams('listing.edit', sent.params).ok)
  t.is(r.model.expectedRevision, 11, 'the answer is the next revision')
  t.is(r.model.kind, 'produto')

  const drop = deps()
  const r2 = await c.submitEdit({ model, form: model.form, dest: { kind: 'personal' }, photos: [] }, drop)
  t.ok(r2.ok)
  t.is(drop.calls.sends[0].params.media, null, 'no photos drops them all')

  const page = deps({ identity: 'page:' + PAGE })
  const pm = c.editModel(mine, { author: PAGE })
  const r3 = await c.submitEdit({ model: pm, form: pm.form, dest: { kind: 'page', page: PAGE }, photos: c.keptPhotos(pm, 'page:' + PAGE) }, page)
  t.ok(r3.ok)
  t.is(page.calls.sends[0].action, 'listing-edit')
  t.is(page.calls.sends[0].op.expectedRevision, 8)

  const kind = deps()
  const r4 = await c.submitEdit({ model, form: { ...model.form, kind: 'servico' }, dest: { kind: 'personal' }, photos: [photo()] }, kind)
  t.absent(r4.ok)
  t.is(r4.field, 'kind')
  t.is(kind.calls.uploads, 0, 'a refusal uploads nothing')
  t.is(kind.calls.sends.length, 0)
})

test('feiraCompose: submitEdit conflito keeps the form; uncertain is never resent', async (t) => {
  const c = await load()
  const model = c.editModel({ seq: 5, editSeq: 8, kind: 'produto', title: 'Mesa', text: '', price: null, unit: null, cat: 'moveis', place: { uf: 'SP', city: 'Santos', bairro: null }, media: [] }, { author: ME })
  const typed = { ...model.form, title: 'Mesa nova' }
  // The node's own shape: USAGE with the message 'conflito'.
  const conflict = deps({ send: () => { throw Object.assign(new Error('conflito'), { code: 'USAGE' }) } })
  const photos = [photo()]
  const r = await c.submitEdit({ model, form: typed, dest: { kind: 'personal' }, photos }, conflict)
  t.absent(r.ok)
  t.ok(r.conflict)
  t.is(r.error, c.EDIT_CONFLICT)
  t.is(conflict.calls.sends.length, 1, 'sent once')
  t.is(typed.title, 'Mesa nova', 'the typed form is untouched')
  t.ok(r.photos[0].encoded && r.photos[0].descriptor, 'the photo bytes and descriptor stay')
  t.absent(c.holdsPublication(r), 'a conflict is a known answer')
  const pageConflict = deps({ send: () => { throw Object.assign(new Error('conflito'), { code: 'conflito' }) } })
  t.ok((await c.submitEdit({ model, form: typed, dest: { kind: 'personal' }, photos: [] }, pageConflict)).conflict, "a page's service answers the token as the code")

  let resent = 0
  const err = Object.assign(new Error('x'), { uncertain: true, retry: async () => { resent++; return { seq: 12 } } })
  const unknown = deps({ send: () => { throw err } })
  const u = await c.submitEdit({ model, form: typed, dest: { kind: 'personal' }, photos: [] }, unknown)
  t.ok(u.uncertain)
  t.is(unknown.calls.sends.length, 1)
  t.is(resent, 0, 'the retry is only for a press')
  t.is(u.retry, err.retry)
  t.ok(c.holdsPublication(u), 'the form locks')
  const timeout = deps({ send: () => { throw Object.assign(new Error('t'), { uncertain: true }) } })
  const u2 = await c.submitEdit({ model, form: typed, dest: { kind: 'personal' }, photos: [] }, timeout)
  t.ok(c.holdsPublication(u2))
  t.is(u2.retry, null)
})

test('feiraCompose: a listed term refuses the listing before any upload or send', async (t) => {
  const c = await load()
  const { BLOCKED_TERMS } = await import('../src/blockedTerms.js')
  const { refusalText } = await import('../src/wordCheck.js')
  const term = BLOCKED_TERMS[0]
  const fields = [{ title: term }, { text: 'Pouco uso, ' + term + '.' }, { city: term + ' do Sul' }, { bairro: term }]
  const dests = [{ kind: 'personal' }, { kind: 'page', page: PAGE }]
  for (const extra of fields) {
    for (const dest of dests) {
      const d = deps({ identity: dest.kind === 'page' ? 'page:' + PAGE : 'me' })
      const r = await c.submitListing({ form: form(extra), ack: true, dest, photos: [photo()] }, d)
      t.absent(r.ok, Object.keys(extra)[0] + ': refused for ' + dest.kind)
      t.is(r.field, '', 'no field: shown above the button')
      t.is(r.error, refusalText(term))
      t.is(d.calls.uploads, 0, 'nothing uploaded')
      t.is(d.calls.sends.length, 0, 'nothing sent')
    }
  }

  const mine = { seq: 5, editSeq: 8, kind: 'produto', title: 'Mesa', text: '', price: 2500, unit: null, cat: 'moveis', place: { uf: 'SP', city: 'Santos', bairro: 'Gonzaga' }, media: [] }
  const model = c.editModel(mine, { author: ME })
  const d = deps()
  const edit = await c.submitEdit({ model, form: { ...model.form, title: term }, dest: { kind: 'personal' }, photos: [photo()] }, d)
  t.absent(edit.ok, 'an edit is refused too')
  t.is(edit.error, refusalText(term))
  t.is(d.calls.uploads, 0, 'nothing uploaded')
  t.is(d.calls.sends.length, 0, 'nothing sent')
})

test('feiraCompose: Anunciar and AnuncioEditar use the photo grid, a thin progress bar and sticky actions', (t) => {
  const create = source('src/screens/Anunciar.js')
  const edit = source('src/screens/AnuncioEditar.js')
  for (const src of [create, edit]) {
    t.ok(src.includes('<ListingPhotoGrid photos={photos} max={MAX_PHOTOS} locked={locked} canAdd={canAttach && !encoding} onAdd={attach} onRemove={removePhoto} onMove={movePhoto} />'), 'the grid replaces the old photo row')
    t.absent(/styles\.photo\b|photoImg|<Image/.test(src), 'no private photo markup left')
    t.ok(/const movePhoto = \(id, delta\) => \{\s+if \(locked\) return\s+setPhotos\(\(list\) => moveById\(list, id, delta\)\)/.test(src), 'a reorder only swaps the newest list and respects the lock')
    t.ok(src.includes("import { moveById } from '../photoOrder'"), 'the move uses the shared helper')
    t.ok(src.includes('pickImages(MAX_PHOTOS)') && !/expo-camera/.test(src), 'library picker, no camera')
  }
  t.ok(create.includes("accessibilityRole='progressbar'") && create.includes('(index + 1) / STEPS.length'), 'progress bar from the step count')
  t.ok(create.indexOf('<View style={[styles.bar, { paddingBottom: insets.bottom + space.md }]}>') > create.indexOf('</ScrollView>'), 'Continuar sits in a bar below the scroll')
  t.ok(/<View style=\{\[styles\.bar, \{ paddingBottom: insets\.bottom \+ space\.md \}\]\}>\s+\{error !== '' \? <ErrorText>\{error\}<\/ErrorText> : null\}\s+<Btn label='Salvar' block onPress=\{save\}/.test(edit), 'Salvar is in the sticky bar, under the repeated error')
  t.ok(edit.indexOf("label='Salvar'") > edit.indexOf('</ScrollView>'), 'Salvar sits below the scroll')
  t.is(edit.split("label='Salvar'").length, 2, 'one Salvar button')
  t.is(create.split("label='Publicar anúncio'").length, 2, 'one Publicar button')
})

test('feiraCompose: the sticky bars follow the keyboard and clear the bottom safe area', (t) => {
  const create = source('src/screens/Anunciar.js')
  const edit = source('src/screens/AnuncioEditar.js')
  for (const src of [create, edit]) {
    t.ok(src.includes("import { KeyboardForm } from './Perfil'"), 'shared keyboard wrapper')
    t.ok(src.includes('{ paddingBottom: insets.bottom + space.md }'), 'bar padding uses the bottom inset')
    t.ok(src.includes('const insets = useSafeAreaInsets()'), 'insets come from the safe area hook')
  }
  t.ok(create.includes('</KeyboardForm>') && edit.includes('</KeyboardForm>'), 'wrapper is closed')
  t.ok(create.indexOf('</KeyboardForm>') > create.indexOf('styles.bar, {') && edit.indexOf('</KeyboardForm>') > edit.indexOf('styles.bar, {'), 'the bar is inside the wrapper')
  const wrapped = (src) => src.slice(src.indexOf('<KeyboardForm inWindow>'), src.indexOf('</KeyboardForm>'))
  t.ok(wrapped(create).includes('<ScrollView ref={scrollRef}') && wrapped(create).includes('styles.bar'), 'Anunciar wraps scroll and bar')
  t.absent(wrapped(create).includes('<Sheet'), 'the confirm sheet stays outside')
  t.absent(create.slice(0, create.indexOf('<KeyboardForm inWindow>')).includes('<ScrollView ref'), 'scroll is inside the wrapper')
  t.ok(wrapped(edit).includes('<ScrollView') && wrapped(edit).includes('styles.bar'), 'AnuncioEditar wraps scroll and bar')
  t.ok(create.indexOf('<TopBar') < create.indexOf('<KeyboardForm inWindow>') && edit.indexOf('<TopBar title={asPage') < edit.indexOf('<KeyboardForm inWindow>'), 'TopBar stays above')
})

test('feiraCompose: full-screen forms measure the keyboard form on iOS too, sheets keep the Android rule', (t) => {
  for (const file of ['Anunciar', 'AnuncioEditar']) t.ok(source('src/screens/' + file + '.js').includes('<KeyboardForm inWindow>'), file + ' opts in')
  const perfil = source('src/screens/Perfil.js')
  t.ok(perfil.includes('export function KeyboardForm ({ children, inWindow = false })'), 'default is off')
  t.ok(perfil.includes("(!inWindow && Platform.OS !== 'android') || !view"), 'without inWindow the Android-only rule stays')
  t.absent(/<KeyboardForm inWindow/.test(source('src/screens/ExcluirConta.js') + source('src/screens/Denunciar.js')), 'sheets are unchanged')
})

test('feiraCompose: the error is repeated in the bottom bar, above its button', (t) => {
  for (const file of ['src/screens/Anunciar.js', 'src/screens/AnuncioEditar.js']) {
    const src = source(file)
    const bar = src.slice(src.indexOf('<View style={[styles.bar'), src.indexOf('</KeyboardForm>'))
    const line = bar.indexOf("{error !== '' ? <ErrorText>{error}</ErrorText> : null}")
    t.ok(line >= 0 && line < bar.indexOf('<Btn'), file + ': the error shows beside the action even when its field is scrolled away')
  }
  const create = source('src/screens/Anunciar.js')
  t.absent(create.slice(0, create.indexOf('<View style={[styles.bar')).includes("{error !== '' ? <ErrorText>{error}</ErrorText> : null}"), 'Anunciar shows the repeated error once')
  t.ok(source('src/screens/AnuncioEditar.js').includes("{error !== '' && field === '' && !conflict && pending !== null ? <ErrorText>{error}</ErrorText> : null}"), 'Editar keeps the error in the form only while the bar is hidden')
})
