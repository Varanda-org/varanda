'use strict'

const test = require('brittle')
const { feira, validateParams } = require('@varanda/rpc')
const { verifyConsent, foldListings } = require('@varanda/core/lib/listing')
const { validRecordCopy } = require('@varanda/core/lib/records')
const refOf = (e) => `${e.author}:${e.seq}`
const query = '/index/feira/sp/sao-paulo/todos/todas'
const load = async () => {
  const { fixtures, offerThread } = await import('../src/vitrine/fixtures.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  const { vitrineIndex } = await import('../src/vitrine/indexResponder.js')
  const request = createVitrineRequest(fixtures)
  return { f: fixtures, offerThread, request, createVitrineRequest, index: (url) => vitrineIndex(url, request), vitrineIndex }
}
const fields = (item) => Object.fromEntries(['title', 'text', 'price', 'unit', 'cat', 'place', 'media'].map((k) => [k, item[k]]))
const ownProduct = async (request) => (await request('listing.mine')).items.find((i) => i.seq === 40)
const photoResponse = async (author, d) => {
  const { vitrineMediaResponse } = await import('../src/vitrine/publicMedia.js')
  return vitrineMediaResponse(`/media/${author}/${d.core}/${d.start}/${d.blocks}`)
}

async function allMine (request) {
  const items = []
  let before
  do {
    const page = await request('listing.mine', before ? { before } : {})
    items.push(...page.items)
    before = page.next
  } while (before)
  return items
}

function noNetwork (t) {
  const original = globalThis.fetch
  globalThis.fetch = () => { throw new Error('unexpected network request') }
  t.teardown(() => { globalThis.fetch = original })
}

test('Feira fixtures fold like real diaries and include member and page listings', async (t) => {
  noNetwork(t)
  const { f, request, index } = await load()
  for (const e of [...f.listings, ...f.rates]) t.ok(validRecordCopy(e.record, e.seq), 'valid record shape')
  const mine = await request('listing.mine')
  const expected = foldListings(f.listings.filter((e) => e.author === f.own), Date.parse(f.now)).items
  t.alike(mine.items.map((i) => i.seq), expected.map((i) => i.seq))
  t.alike(mine.items.map((i) => i.title), expected.map((i) => i.record.title))
  t.is(mine.next, null)
  const product = mine.items.find((i) => i.seq === 40)
  t.is(product.title, 'Bicicleta azul revisada')
  t.is(product.editSeq, 44)
  t.is(product.media.length, 2)
  t.is(product.price, 25000)
  t.ok(mine.items.some((i) => i.kind === 'procura' && i.price === 18000))
  t.ok(mine.items.some((i) => i.status === 'vendido'))
  const page = await request('listing.mine', { limit: 1 })
  const rest = await request('listing.mine', { before: page.next })
  t.alike([...page.items, ...rest.items], mine.items)
  t.ok(index(query).items.some((i) => i.ref.startsWith(f.pages[0].author)))
  t.ok(index(query).items.some((i) => i.status === 'reservado'))
})

test('listing and edited listing photos load with verified bytes through the public route', async (t) => {
  noNetwork(t)
  const { f, request } = await load()
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const entries = f.listings.filter((e) => ['listing', 'listing-edit'].includes(e.record.type) && e.record.media)
  t.alike(entries.map((e) => e.record.type), ['listing', 'listing-edit'])
  const current = await ownProduct(request)
  for (const { author, media } of [...entries.map((e) => ({ author: e.author, media: e.record.media })), { author: f.own, media: current.media }]) {
    t.is(media.length, 2)
    for (const d of media) {
      t.absent(f.feed.some((post) => post.media?.some((item) => item.core === d.core && item.start === d.start && item.blocks === d.blocks)), 'listing route does not overlap a feed photo')
      const response = await photoResponse(author, d)
      t.is(response.status, 200)
      const bytes = new Uint8Array(await response.arrayBuffer())
      t.is(bytes.byteLength, d.bytes)
      t.is(Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join(''), d.sha256)
    }
  }
  const d = current.media[0]
  t.is((await photoResponse(f.own, { ...d, start: 9999 })).status, 404)
  t.is((await photoResponse('f'.repeat(64), d)).status, 404)
  t.is((await photoResponse(f.own, { ...d, core: 'f'.repeat(64) })).status, 404)
  t.is((await photoResponse(f.own, { ...d, blocks: d.blocks + 1 })).status, 404)
  const post = f.feed.find((post) => post.media?.length)
  t.is((await photoResponse(post.author, post.media[0])).status, 200)
})

test('edits retain the root, reject stale revisions, and update only their instance index', async (t) => {
  const { f, request, index, createVitrineRequest, vitrineIndex } = await load()
  const pristine = createVitrineRequest(f)
  const product = await ownProduct(request)
  const to = `${f.own}:${product.seq}`
  const change = { to, expectedRevision: product.editSeq, ...fields(product), title: 'Bicicleta verde', text: 'Pronta para passear.', media: null }
  const edited = await request('listing.edit', change)
  t.is(edited.ref, to)
  t.ok(edited.seq > product.seq)
  const live = await ownProduct(request)
  t.is(live.seq, product.seq)
  t.is(live.title, change.title)
  t.is(live.at, product.at)
  t.is(live.editSeq, edited.seq)
  t.alike(live.media, [])
  await t.exception(request('listing.edit', change), /conflito/)
  t.is(index(query).items.find((i) => i.ref === to).editSeq, edited.seq)
  t.is(index(query + '/verde').items.length, 1)
  t.is(index(query + '/revisada').items.length, 0)
  t.is((await ownProduct(pristine)).title, product.title)
  t.is(vitrineIndex(query, pristine).items.find((i) => i.ref === to).editSeq, product.editSeq)
  const peek = await request('diary.peek', { author: f.own, seqs: [product.seq, product.editSeq, edited.seq] })
  t.alike(peek.entries.map((e) => e.seq), [product.seq, edited.seq])
  t.alike(peek.missing, [product.editSeq])
  const { hydrate } = await import('../src/feiraClient.js')
  const hydrated = await hydrate(request, index(query))
  t.is(hydrated.items.find((i) => i.ref === to).title, change.title)
  t.is(hydrated.dropped, 0)
  t.is(hydrated.unavailable, 0)
})

test('status folds, sold listings leave the city, and deletion releases the root', async (t) => {
  const { f, request, index, vitrineIndex } = await load()
  const to = `${f.own}:40`
  const sold = await request('listing.status', { to, status: 'vendido' })
  const live = await ownProduct(request)
  t.is(live.status, 'vendido')
  t.is(live.statusSeq, sold.seq)
  t.absent(index(query).items.some((i) => i.ref === to))
  t.absent(vitrineIndex(query).items.some((i) => i.ref === to), 'default responder reads the active node')
  t.ok(index('/index/feira/autor/' + f.own).items.some((i) => i.ref === to && i.status === 'vendido'))
  await request('listing.status', { to, status: 'disponivel' })
  t.ok(index(query).items.some((i) => i.ref === to))
  const removed = await request('listing.delete', { to })
  t.is(removed.changed, true)
  t.ok(removed.deleted.includes(40))
  t.ok(removed.deleted.includes(44))
  t.is((await request('listing.delete', { to })).changed, false)
  t.absent(await ownProduct(request))
  t.absent(index('/index/feira/autor/' + f.own).items.some((i) => i.ref === to))
  await t.exception(request('listing.status', { to, status: 'disponivel' }), /não é um anúncio/)
})

test('the 31st live listing refuses and sold roots still count toward the limit', async (t) => {
  const { f, request } = await load()
  const product = await ownProduct(request)
  const input = { kind: 'produto', ...fields(product) }
  const initial = (await request('listing.mine')).items.length
  for (let i = initial; i < feira.MAX_LISTINGS; i++) await request('listing.create', input)
  t.is((await allMine(request)).length, 30)
  await t.exception(request('listing.create', input), /limite/)
  await request('listing.delete', { to: `${f.own}:42` })
  t.ok((await request('listing.create', input)).seq > 45)
  t.is((await allMine(request)).length, 30)
})

test('procura cannot reserve, bad units refuse, and foreign or missing roots cannot change', async (t) => {
  const { f, request } = await load()
  const product = await ownProduct(request)
  await t.exception(request('listing.status', { to: `${f.own}:41`, status: 'reservado' }), /uma procura não fica reservada/)
  await t.exception(request('listing.edit', { to: `${f.own}:40`, expectedRevision: 44, ...fields(product), unit: 'hora' }), /unit/)
  await t.exception(request('listing.create', { kind: 'procura', ...fields(product), unit: 'hora' }), /unit/)
  await t.exception(request('listing.status', { to: `${f.members[1].author}:40`, status: 'vendido' }), /não é um anúncio/)
  await t.exception(request('listing.delete', { to: `${f.own}:3` }), /não é um anúncio/)
  t.is((await ownProduct(request)).editSeq, 44)
})

test('ratings verify real consent, drop the bad one, and bind it to the rater and root', async (t) => {
  const { f, request } = await load()
  const [good, bad] = f.rates
  const consentFields = { listingAuthor: f.own, listingSeq: 40, rater: good.author, offerId: good.record.offer, consent: good.record.consent }
  t.ok(verifyConsent(consentFields), 'production verifier accepts the fixture signature')
  t.absent(verifyConsent({ ...consentFields, consent: bad.record.consent }))
  t.absent(verifyConsent({ ...consentFields, rater: bad.author }))
  const ratings = await request('listing.ratings', { author: f.own, seq: 40, refs: f.rates.map((e) => ({ rater: e.author, seq: e.seq })) })
  t.is(ratings.items.length, 1)
  t.is(ratings.items[0].rater, good.author)
  t.is(ratings.items[0].listingSeq, 40)
  t.is(ratings.dropped, 1)
  t.is(ratings.incomplete, false)
  const unknown = await request('listing.ratings', { author: f.own, seq: 40, refs: [{ rater: good.author, seq: 999 }] })
  t.is(unknown.incomplete, true)
  const wrong = await request('listing.ratings', { author: f.own, seq: 41, refs: [{ rater: good.author, seq: good.seq }] })
  t.is(wrong.items.length, 0)
  t.is(wrong.dropped, 1)
})

test('ratings keep the newest valid offer per rater and discard repeat offers and self ratings', async (t) => {
  const { f, createVitrineRequest } = await load()
  const { signVitrineConsent } = await import('../src/vitrine/fixtures.js')
  const data = JSON.parse(JSON.stringify(f))
  const first = data.rates[0]
  const offer = 'bc'.repeat(16)
  const newer = { author: first.author, seq: 48, record: { ...first.record, offer, consent: signVitrineConsent(f.own, 40, first.author, offer), stars: 4 } }
  data.rates.push({ ...first, seq: 47 }, newer)
  const request = createVitrineRequest(data)
  const refs = data.rates.map((e) => ({ rater: e.author, seq: e.seq }))
  const answer = await request('listing.ratings', { author: f.own, seq: 40, refs })
  t.alike(answer.items.map((i) => [i.rater, i.seq, i.stars]), [[first.author, 48, 4]])
  t.is(answer.dropped, 2)
  t.is(answer.incomplete, false)
  const self = await request('listing.ratings', { author: f.own, seq: 40, refs: [{ rater: f.own, seq: 999 }] })
  t.is(self.dropped, 1)
  t.is(self.incomplete, false)
})

test('consent needs an inbound proposal and ratings append once per offer', async (t) => {
  const { f, request, offerThread, index } = await load()
  const peer = f.members[1].author
  const proposal = offerThread[0]
  const signed = await request('listing.consent', { to: `${f.own}:40`, rater: peer, offer: proposal.id })
  t.ok(verifyConsent({ listingAuthor: f.own, listingSeq: 40, rater: peer, offerId: proposal.id, consent: signed.consent }))
  await t.exception(request('listing.consent', { to: `${f.own}:41`, rater: peer, offer: proposal.id }), /oferta ausente/)
  await t.exception(request('listing.consent', { to: `${f.own}:40`, rater: peer, offer: offerThread[1].id }), /oferta ausente/)
  const accepted = offerThread.at(-1)
  const ref = feira.parseOfferRef(accepted.card.url)
  const input = { to: `${ref.author}:${ref.seq}`, offer: accepted.replyTo, consent: ref.aceite, stars: 5, text: 'Combinado cumprido.' }
  await t.exception(request('listing.rate', { ...input, consent: '0'.repeat(128) }), /consentimento inválido/)
  const rated = await request('listing.rate', input)
  t.is(rated.ref, `${f.own}:${rated.seq}`)
  await t.exception(request('listing.rate', input), /oferta já avaliada/)
  const result = await request('listing.ratings', { author: peer, seq: ref.seq, refs: [{ rater: f.own, seq: rated.seq }] })
  t.is(result.items[0].text, input.text)
  t.ok(index('/index/feira/avaliacoes/' + peer).items.some((e) => e.ref === rated.ref))
})

test('offer cards round-trip, validate exact keys and host, and thumbnails stay in memory', async (t) => {
  noNetwork(t)
  const { f, request, offerThread } = await load()
  const peer = f.members[1].author
  for (const m of offerThread) {
    t.ok(feira.parseOfferRef(m.card.url))
    t.ok(validateParams('dm.send', { to: peer, text: m.text, card: m.card }).ok)
  }
  const fixture = offerThread[0]
  t.ok((await request.media.read({ kind: 'dm', from: peer, id: fixture.id, index: 'card' })).bytes.length > 0)
  const product = await ownProduct(request)
  const response = await photoResponse(f.own, product.media[0])
  const photo = { bytes: new Uint8Array(await response.arrayBuffer()), mime: product.media[0].mime }
  const image = await request.media.putDm({ to: peer, ...photo, width: 128, height: 128 })
  const card = { ...fixture.card, image }
  const sent = await request('dm.send', { to: peer, text: 'Proposta', card })
  card.title = 'Alterado fora da conversa'
  const thread = await request('dm.thread', { peer })
  const row = thread.messages.find((m) => m.id === sent.id)
  t.is(row.card.title, 'Proposta')
  t.alike(row.card.image, image)
  t.alike((await request.media.read({ kind: 'dm', from: f.own, id: sent.id, index: 'card' })).bytes, photo.bytes)
  await t.exception(request('dm.send', { to: peer, text: 'Proposta', card: { ...card, host: 'wrong.invalid' } }), /card/)
  const { host, ...missingHost } = card
  await t.exception(request('dm.send', { to: peer, text: 'Proposta', card: missingHost }), /card/)
  await t.exception(request('dm.send', { to: peer, text: 'Proposta', card: { ...card, extra: true } }), /card/)
  const ipcImage = await request('dm.putMedia', { to: peer, name: 'ab'.repeat(16) + '.bin', mime: 'image/jpeg', width: 128, height: 128 })
  t.ok(validateParams('dm.send', { to: peer, text: 'Proposta', card: { ...card, image: ipcImage } }).ok)
  const ipcSent = await request('dm.send', { to: peer, text: 'Proposta', card: { ...card, image: ipcImage } })
  t.ok(ipcSent.id)
  t.alike((await request.media.read({ kind: 'dm', from: f.own, id: ipcSent.id, index: 'card' })).bytes, photo.bytes)
})

test('listing photos are drawn offline, fresh on every read, and reports accept listing kind', async (t) => {
  noNetwork(t)
  const { f, request } = await load()
  const product = await ownProduct(request)
  for (const item of product.media) {
    const response = await photoResponse(f.own, item)
    t.is(response.status, 200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    t.is(bytes.length, item.bytes)
    const first = bytes[0]
    bytes.fill(0)
    const fresh = await photoResponse(f.own, item)
    t.is(new Uint8Array(await fresh.arrayBuffer())[0], first)
    const read = await request.media.read({ kind: 'listing', item })
    t.is(read.bytes.length, item.bytes, 'the media handle draws a real listing photo too')
    t.is(read.mime, 'image/jpeg')
  }
  const report = await request('report.sign', { nonce: 'ab'.repeat(32), target: f.members[1].author, seq: 40, kind: 'listing', reason: 'outro', text: '', quote: 'Aulas de bicicleta' })
  t.ok(/^[0-9a-f]{128}$/.test(report.signature))
  t.ok(f.listings.some((e) => refOf(e) === `${f.own}:40`))
})

test('Vitrine Feira policy and signup never fetch', async (t) => {
  noNetwork(t)
  const dev = globalThis.__DEV__
  const env = process.env.EXPO_PUBLIC_VARANDA_VITRINE
  globalThis.__DEV__ = true
  process.env.EXPO_PUBLIC_VARANDA_VITRINE = '1'
  t.teardown(() => {
    if (dev === undefined) delete globalThis.__DEV__
    else globalThis.__DEV__ = dev
    if (env === undefined) delete process.env.EXPO_PUBLIC_VARANDA_VITRINE
    else process.env.EXPO_PUBLIC_VARANDA_VITRINE = env
  })
  const account = await import('../src/account.js?t33')
  t.alike(await account.feiraPolicy(), { enabled: true })
  await t.exception(account.feiraStart({ author: 'ab'.repeat(32), seq: 40 }), /serviço indisponível/)
})
