'use strict'

// A listing in Conversas (src/feiraChat.js): the card, the draft text and the
// listing pill. ES modules loaded through import().
const test = require('brittle')
const { validateParams, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardTextLength } = require('@varanda/rpc')

const load = () => import('../src/feiraChat.js')
const loadFeira = () => import('../src/feira.js')
const loadCard = () => import('../src/linkCard.js')
const A = 'ab'.repeat(32)
const PEER = 'cd'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const URL7 = ORIGIN + '/f/' + A + '/7'

const root = (extra = {}) => ({
  type: 'listing',
  kind: 'produto',
  title: 'Bicicleta aro 26',
  text: 'Pouco uso.',
  price: 25000,
  unit: null,
  cat: 'esporte',
  place: { uf: 'SP', city: 'São Paulo', bairro: 'Pinheiros' },
  at: '2026-11-01T12:00:00.000Z',
  ...extra
})

async function view (extra) {
  const f = await loadFeira()
  return f.listingView({ author: A, seq: 7, root: root(extra) })
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
const thumbOk = async (bytes, mime, opts) => ({ bytes: JPEG, mime: 'image/jpeg', width: Math.min(opts.side, 320), height: 240 })
const DM_IMAGE = {
  id: '1'.repeat(64),
  key: '2'.repeat(64),
  nonce: '3'.repeat(48),
  chunks: 1,
  bytes: 4096,
  sha256: '4'.repeat(64),
  mime: 'image/jpeg',
  w: 320,
  h: 240,
  ms: 0
}

test('listingCard: snapshot shape, exact DM card after cardForSend', async (t) => {
  const c = await load()
  const { cardForSend } = await loadCard()
  const listing = await view()
  const snap = await c.listingCard({ origin: ORIGIN, listing })
  t.alike(Object.keys(snap).sort(), ['desc', 'host', 'thumb', 'title', 'url'])
  t.is(snap.url, URL7)
  t.is(snap.host, 'bora.varanda.app')
  t.is(snap.title, 'Bicicleta aro 26')
  t.is(snap.desc, 'Produto · R$ 250,00 · Pinheiros, São Paulo/SP')
  t.is(snap.thumb, null)

  const card = await cardForSend(snap, {})
  t.alike(Object.keys(card).sort(), ['desc', 'host', 'image', 'title', 'url'])
  t.is(card.image, null)
  t.ok(validateParams('dm.send', { to: PEER, text: 'oi ' + URL7, card }).ok, 'card without image passes dm.send')
})

test('listingCard: thumbnail from the first photo, uploaded by cardForSend', async (t) => {
  const c = await load()
  const { cardForSend } = await loadCard()
  const listing = await view()
  const seen = []
  const snap = await c.listingCard({
    origin: ORIGIN,
    listing,
    photo: { bytes: Uint8Array.from([1, 2, 3]), mime: 'image/webp' },
    encodeThumbnail: async (bytes, mime, opts) => { seen.push({ mime, opts }); return thumbOk(bytes, mime, opts) }
  })
  t.alike(seen, [{ mime: 'image/webp', opts: { side: 320, maxBytes: MAX_CARD_IMAGE_BYTES - 16 } }])
  t.is(snap.thumb.mime, 'image/jpeg')
  const card = await cardForSend(snap, { upload: async () => DM_IMAGE })
  t.alike(card.image, DM_IMAGE)
  t.ok(validateParams('dm.send', { to: PEER, text: URL7, card }).ok, 'card with image passes dm.send')
})

test('listingCard: a failed or oversized thumbnail drops only the image', async (t) => {
  const c = await load()
  const listing = await view()
  const photo = { bytes: Uint8Array.from([1]), mime: 'image/jpeg' }
  const failed = await c.listingCard({ origin: ORIGIN, listing, photo, encodeThumbnail: async () => { throw new Error('decode') } })
  t.is(failed.thumb, null)
  t.is(failed.url, URL7)
  const big = await c.listingCard({ origin: ORIGIN, listing, photo, encodeThumbnail: async () => ({ bytes: new Uint8Array(MAX_CARD_IMAGE_BYTES), mime: 'image/jpeg', width: 320, height: 320 }) })
  t.is(big.thumb, null)
  const noPhoto = await c.listingCard({ origin: ORIGIN, listing, encodeThumbnail: thumbOk })
  t.is(noPhoto.thumb, null)
})

test('listingCard: caps title and desc, refuses a bad origin', async (t) => {
  const c = await load()
  const { cardForSend } = await loadCard()
  const long = await view({ title: 'x'.repeat(80), place: { uf: 'SP', city: 'c'.repeat(40), bairro: 'b'.repeat(40) }, price: 99999999 })
  const snap = await c.listingCard({ origin: ORIGIN, listing: long })
  t.ok(cardTextLength(snap.title) <= MAX_CARD_TITLE)
  t.ok(cardTextLength(snap.desc) <= MAX_CARD_DESC)
  const card = await cardForSend(snap, {})
  t.ok(validateParams('dm.send', { to: PEER, text: URL7, card }).ok)

  t.is(await c.listingCard({ origin: 'http://bora.varanda.app', listing: long }), null)
  t.is(await c.listingCard({ origin: 'https://localhost', listing: long }), null, 'a host a card cannot carry')
  t.is(await c.listingCard({ origin: ORIGIN, listing: null }), null)
  t.is(c.listingCardFields({ origin: ORIGIN, listing: { ...long, author: 'zz' } }), null)
})

test('draftText per kind', async (t) => {
  const c = await load()
  t.is(c.draftText(await view(), URL7), 'Olá! Tenho interesse no seu anúncio "Bicicleta aro 26" na Feira: ' + URL7)
  t.is(c.draftText(await view({ kind: 'servico', title: 'Aula de violão' }), URL7), 'Olá! Tenho interesse no seu serviço "Aula de violão" na Feira: ' + URL7)
  t.is(c.draftText(await view({ kind: 'procura', title: 'Berço' }), URL7), 'Olá! Vi sua procura por "Berço" na Feira e posso ajudar: ' + URL7)
  t.is(c.draftText(await view(), 'http://x.example/f'), '')
  t.is(c.draftText({ kind: 'produto', title: 'a\u2028b\nc' }, URL7), 'Olá! Tenho interesse no seu anúncio "a b c" na Feira: ' + URL7)
  t.absent(c.draftText(await view(), URL7).includes('\u2014'))
  const { previewTarget } = await import('../src/preview.js')
  for (const title of ['Bicicleta https://tracker.example/buyer42', 'Bicicleta www.tracker.example', 'Bicicleta HTTPS://Tracker.example']) {
    const draft = c.draftText({ kind: 'produto', title }, URL7)
    t.is(draft, 'Olá! Tenho interesse no seu anúncio na Feira: ' + URL7, 'a title with a link is left out')
    t.is(previewTarget(draft), URL7, 'the only previewed link is the listing')
  }
})

test('listingLinkOf: own origin only, last link wins, fragment ignored', async (t) => {
  const c = await load()
  t.alike(c.listingLinkOf(URL7, ORIGIN), { author: A, seq: 7 }, 'an old message with only the url')
  t.alike(c.listingLinkOf('Olá! Tenho interesse: ' + URL7 + '.', ORIGIN), { author: A, seq: 7 })
  t.alike(c.listingLinkOf(URL7 + '#oferta=5000', ORIGIN), { author: A, seq: 7 }, 'an offer url still matches the pill')
  t.alike(c.listingLinkOf({ url: URL7 + '#oferta=5000&resposta=recusada' }, ORIGIN), { author: A, seq: 7 })
  t.alike(c.listingLinkOf({ url: URL7 }, ORIGIN), { author: A, seq: 7 })
  t.alike(c.listingLinkOf(ORIGIN + '/anuncio/' + A + '/3', ORIGIN), { author: A, seq: 3 })
  t.alike(c.listingLinkOf(ORIGIN + '/f/' + A + '/1 e ' + URL7, ORIGIN), { author: A, seq: 7 })

  t.is(c.listingLinkOf('https://evil.example/f/' + A + '/7', ORIGIN), null, 'a foreign url is ignored')
  t.is(c.listingLinkOf({ url: 'https://evil.example/f/' + A + '/7' }, ORIGIN), null)
  t.is(c.listingLinkOf(ORIGIN + '.evil.example/f/' + A + '/7', ORIGIN), null)
  t.is(c.listingLinkOf('https://evil.example/a:' + URL7, ORIGIN), null, 'glued to another token')
  t.is(c.listingLinkOf(URL7 + '/extra', ORIGIN), null)
  t.is(c.listingLinkOf(URL7 + '?x=1', ORIGIN), null)
  t.is(c.listingLinkOf(URL7, 'http://bora.varanda.app'), null)
  t.is(c.listingLinkOf('x'.repeat(4001) + ' ' + URL7, ORIGIN), null)
  t.is(c.listingLinkOf(null, ORIGIN), null)
  t.is(c.listingLinkOf({ url: 42 }, ORIGIN), null)
})
