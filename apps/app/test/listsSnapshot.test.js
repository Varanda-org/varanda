'use strict'

// The 'listas' snapshot codec (src/listsSnapshot.js): six lists, each entry
// with its own 14 days, strict keys, the caps, the byte measure over the
// whole stored text and the block rewrite.
const test = require('brittle')

const load = () => import('../src/listsSnapshot.js')
const loadRules = () => import('../src/screenSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const OTHER = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const ME = Object.freeze({ kind: 'me' })

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }
const id = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })
const keyOf = (n) => n.toString(16).padStart(64, '0')

function post (author, seq, extra = {}) {
  return { kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null, ...extra }
}

async function feiraRows () {
  const { mineView } = await import('../src/feiraScreen.js')
  const item = (seq) => ({ seq, kind: 'produto', title: 'Bicicleta ' + seq, text: 'aro 29', price: 50000, unit: null, cat: 'esporte', place: { uf: 'SP', city: 'São Paulo', bairro: null }, at: at(seq), status: 'disponivel', editSeq: null, editedAt: null })
  const mine = mineView(OWN, item(3))
  // As feiraClient.hydrate adds to an index row.
  const indexed = { ...mineView(STRANGER, { ...item(2), media: [avatar] }), stale: false, name: 'Loja', username: 'loja', certDate: null, page: false }
  const stale = { ...mineView(OTHER, item(1)), stale: true, status: null, statusLabel: null, name: '', username: null, certDate: '2026-01-01T00:00:00.000Z', page: true }
  return [mine, indexed, stale]
}

async function topicRows () {
  const { trendRows } = await import('../src/topicTrend.js')
  return trendRows([{ tag: 'samba', authors: 3 }, { tag: 'feira', authors: 1 }])
}

async function testimonialRows (owner = OWN) {
  const { rowsFrom } = await import('../src/testimonials.js')
  const peek = {
    key: owner,
    entries: [
      { seq: 7, record: { type: 'testimonial-show', from: FOLLOW, seq: 2, text: 'pessoa incrível', at: at(7) } },
      { seq: 8, record: { type: 'testimonial-show', from: STRANGER, seq: 4, text: 'gente boa', at: at(8) } }
    ]
  }
  const writer = (key, seq, name) => ({ key, entries: [{ seq, record: { type: 'testimonial', to: owner } }], profile: { name, avatar }, username: name.toLowerCase() })
  return rowsFrom(peek, owner, { [FOLLOW]: writer(FOLLOW, 2, 'Bia'), [STRANGER]: writer(STRANGER, 4, 'Caio') })
}

const engager = (author, seq) => ({ author, seq, name: 'Bia', username: 'bia', avatar })

async function inputs () {
  return {
    seguindo: { scope: '', rows: [FOLLOW, STRANGER], total: 2 },
    salvos: { scope: '', rows: [{ ref: STRANGER + ':2', post: post(STRANGER, 2, { quote: { author: OTHER, seq: 1 } }) }, { ref: FOLLOW + ':5', post: post(FOLLOW, 5) }] },
    feira: { scope: 'cidade|SP|sao paulo', rows: await feiraRows() },
    assuntos: { scope: '', rows: await topicRows() },
    curtidas: { scope: OTHER + ':9', rows: [engager(FOLLOW, 3), engager(STRANGER, 4)], total: null },
    depoimentos: { scope: '', rows: await testimonialRows() }
  }
}

// A body with every list, each saved a second after the previous one.
async function fullBody (l, now = NOW) {
  const all = await inputs()
  let body = null
  let i = 0
  for (const name of l.LIST_NAMES) body = l.putList(body, name, all[name], now - (6 - i++) * 1000)
  return body
}

const fits = () => true

test('every list round-trips through build and parse', async (t) => {
  const l = await load()
  const all = await inputs()
  for (const name of l.LIST_NAMES) {
    const built = l.build({ previous: null, name, ...all[name], blocked: [] }, { fits, now: NOW, owner: OWN })
    t.ok(built, name + ' builds')
    const entry = built.lists[name]
    t.is(entry.savedAt, NOW)
    t.alike(entry.rows, all[name].rows, name + ' keeps the rows as the screen holds them')
    t.alike(l.parse(JSON.parse(JSON.stringify(built)), { now: NOW, owner: OWN }), built, name + ' parses back')
  }
  const body = await fullBody(l)
  t.is(Object.keys(body.lists).length, 6)
  t.alike(l.parse(JSON.parse(JSON.stringify(body)), { now: NOW, owner: OWN }), body)
  t.alike(Object.keys(body.lists.seguindo), ['savedAt', 'scope', 'rows', 'total'])
  t.alike(Object.keys(body.lists.salvos), ['savedAt', 'scope', 'rows'], 'no total, cursor or offset')
})

test('an unknown list, entry or row key fails the whole parse', async (t) => {
  const l = await load()
  const body = await fullBody(l)
  const opts = { now: NOW, owner: OWN }
  const bad = (change, why) => {
    const copy = JSON.parse(JSON.stringify(body))
    change(copy)
    t.is(l.parse(copy, opts), null, why)
  }
  bad((b) => { b.lists.outra = b.lists.salvos }, 'unknown list')
  bad((b) => { b.extra = 1 }, 'body key')
  bad((b) => { b.lists.salvos.next = 'x' }, 'entry key')
  bad((b) => { b.lists.salvos.total = 2 }, 'a total on a list without one')
  bad((b) => { delete b.lists.seguindo.total }, 'Seguindo without its total')
  bad((b) => { b.lists.seguindo.total = -1 }, 'a negative total')
  bad((b) => { b.lists.curtidas.total = 1.5 }, 'a fractional total')
  bad((b) => { b.lists.feira.rows[0].extra = 1 }, 'feira row key')
  bad((b) => { b.lists.feira.rows[1].place.extra = 1 }, 'feira place key')
  bad((b) => { b.lists.feira.rows[0].status = null }, 'a status missing on a row that is not stale')
  bad((b) => { b.lists.salvos.rows[0].post.extra = 1 }, 'salvo post key')
  bad((b) => { b.lists.salvos.rows[0].ref = FOLLOW + ':2' }, 'a salvo ref that is not its post')
  bad((b) => { b.lists.assuntos.rows[0].label = '#outra' }, 'a topic label that is not its tag')
  bad((b) => { b.lists.curtidas.rows[0].avatar = { bad: 1 } }, 'an engager avatar that is not a descriptor')
  bad((b) => { b.lists.curtidas.rows[0].extra = 1 }, 'engager row key')
  bad((b) => { b.lists.curtidas.scope = 'post' }, 'a curtidas scope that is not a ref')
  bad((b) => { b.lists.depoimentos.scope = 'x' }, 'a depoimentos scope other than empty')
  bad((b) => { b.lists.depoimentos.rows[0].pending = true }, 'depoimento row key')
  bad((b) => { b.lists.depoimentos.rows[0].text = '' }, 'an empty depoimento')
  bad((b) => { b.lists.depoimentos.rows[0].text = 'a'.repeat(801) }, 'a depoimento over the write limit')
  bad((b) => { b.lists.feira.scope = 'x'.repeat(257) }, 'a scope over 256 characters')
  bad((b) => { b.lists.seguindo.rows.push(b.lists.seguindo.rows[0]) }, 'a duplicate row')
  bad((b) => { b.lists.seguindo.savedAt = -1 }, 'a bad savedAt')
})

test('a depoimento whose ref names another owner fails, and is never built', async (t) => {
  const l = await load()
  const rows = await testimonialRows()
  const built = l.build({ previous: null, name: 'depoimentos', scope: '', rows, blocked: [] }, { fits, now: NOW, owner: OWN })
  t.is(built.lists.depoimentos.rows.length, 2)
  t.is(l.parse(JSON.parse(JSON.stringify(built)), { now: NOW, owner: FOLLOW }), null, 'parsed for another owner')
  t.is(l.parse(JSON.parse(JSON.stringify(built)), { now: NOW }), null, 'parsed without an owner')
  const copy = JSON.parse(JSON.stringify(built))
  copy.lists.depoimentos.rows[0].ref = OTHER + ':' + copy.lists.depoimentos.rows[0].seq
  t.is(l.parse(copy, { now: NOW, owner: OWN }), null, 'a ref naming another owner')
  copy.lists.depoimentos.rows[0].ref = OWN + ':99'
  t.is(l.parse(copy, { now: NOW, owner: OWN }), null, 'a ref with another seq')
  const others = await testimonialRows(OTHER)
  const mixed = l.build({ previous: null, name: 'depoimentos', scope: '', rows: others.concat(rows), blocked: [] }, { fits, now: NOW, owner: OWN })
  t.alike(mixed.lists.depoimentos.rows, rows, 'another owner\'s rows are left out at build')
  const own = { ...rows[0], from: OWN, ref: OWN + ':' + rows[0].seq }
  t.is(l.build({ previous: null, name: 'depoimentos', scope: '', rows: [own], blocked: [] }, { fits, now: NOW, owner: OWN }).lists.depoimentos.rows.length, 0, 'a depoimento from the owner')
})

test('caps: rows per list, bytes per entry and over the whole stored text', async (t) => {
  const l = await load()
  const s = await loadRules()
  const { utf8ByteLength } = (await import('@varanda/rpc')).default
  const keys = Array.from({ length: 150 }, (_, i) => keyOf(i + 1))
  const seguindo = l.putList(null, 'seguindo', { scope: '', rows: keys, total: 150 }, NOW)
  t.is(seguindo.lists.seguindo.rows.length, l.SEGUINDO_MAX_ROWS, '100 keys')
  t.is(seguindo.lists.seguindo.total, 150, 'the total stays the whole list')
  const many = Array.from({ length: 40 }, (_, i) => engager(keyOf(i + 1), 1))
  t.is(l.putList(null, 'curtidas', { scope: OTHER + ':1', rows: many, total: 40 }, NOW).lists.curtidas.rows.length, l.LIST_MAX_ROWS, '30 rows')
  const tooMany = JSON.parse(JSON.stringify(seguindo))
  tooMany.lists.seguindo.rows.push(keyOf(999))
  t.is(l.parse(tooMany, { now: NOW, owner: OWN }), null, 'a parse over the row cap')

  const long = Array.from({ length: 30 }, (_, i) => ({ ref: keyOf(i + 1) + ':1', post: post(keyOf(i + 1), 1, { text: 'é'.repeat(1000) }) }))
  const salvos = l.putList(null, 'salvos', { scope: '', rows: long }, NOW).lists.salvos
  t.ok(salvos.rows.length < 30 && salvos.rows.length > 0, 'rows cut from the end')
  t.alike(salvos.rows.map((r) => r.ref), long.slice(0, salvos.rows.length).map((r) => r.ref), 'the first rows stay')
  t.ok(utf8ByteLength(JSON.stringify(salvos)) <= l.LIST_ENTRY_MAX_BYTES)
  const over = { lists: { salvos: { ...salvos, rows: long } } }
  t.is(l.parse(over, { now: NOW, owner: OWN }), null, 'a parse over the entry bytes')

  // Six entries at their byte cap, envelope included, stay within the whole cap.
  let body = null
  const names = ['salvos', 'feira', 'assuntos', 'depoimentos', 'seguindo', 'curtidas']
  const big = 'é'.repeat(1000)
  const rowsFor = {
    salvos: long,
    feira: (await feiraRows()).map((r) => ({ ...r, text: big + big })).concat(Array.from({ length: 27 }, (_, i) => ({ ...(feiraRowsSync(i)), text: big + big }))),
    assuntos: Array.from({ length: 30 }, (_, i) => ({ tag: 'tag' + i, label: '#tag' + i, meta: 'm'.repeat(256) })),
    depoimentos: Array.from({ length: 30 }, (_, i) => ({ from: keyOf(i + 1), seq: i + 1, text: big.slice(0, 400), at: at(i), ref: OWN + ':' + (i + 1), name: 'n'.repeat(100), username: null, avatar })),
    seguindo: keys,
    curtidas: Array.from({ length: 30 }, (_, i) => ({ ...engager(keyOf(i + 1), 1), name: 'é'.repeat(100), avatar }))
  }
  const totals = { seguindo: 150, curtidas: 30 }
  names.forEach((name, i) => {
    body = l.putList(body, name, { scope: name === 'curtidas' ? OTHER + ':1' : '', rows: rowsFor[name], total: totals[name] }, NOW - (6 - i) * 1000)
  })
  t.is(Object.keys(body.lists).length, 6)
  const whole = s.buildScreenSnapshot('listas', { ...id(), previous: body, blocked: [] })
  t.ok(whole, 'built within the cap')
  const text = JSON.stringify(whole)
  t.ok(utf8ByteLength(text) <= l.LISTS_SNAPSHOT_MAX_BYTES, 'the whole text, envelope included, fits')
  t.ok(utf8ByteLength(text) > 140000, 'most entries near their own cap')
  t.is(Object.keys(whole.body.lists).length, 6, 'six full entries stay within the cap')
  t.alike(s.parseScreenSnapshot(text, 'listas', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW }), whole)
})

// A Feira row of an author per index, synchronously (the shape of mineView).
function feiraRowsSync (i) {
  const author = keyOf(i + 100)
  return { author, seq: 1, editSeq: null, edited: false, kind: 'produto', kindLabel: 'Produto', title: 'Item', text: 'x', price: 100, unit: null, priceLabel: 'R$ 1,00', cat: 'casa', catLabel: 'Casa', place: { uf: 'SP', city: 'São Paulo', bairro: null, label: 'São Paulo/SP' }, media: [], status: 'disponivel', statusLabel: 'Disponível', at: at(1), editedAt: null, ref: author + ':1' }
}

test('the oldest entry is dropped first when the text does not fit', async (t) => {
  const l = await load()
  const body = await fullBody(l)
  const sizes = []
  const built = l.build({ previous: body, blocked: [] }, {
    fits: (b) => { sizes.push(Object.keys(b.lists).length); return Object.keys(b.lists).length <= 3 },
    now: NOW,
    owner: OWN
  })
  t.alike(sizes, [6, 5, 4, 3])
  t.alike(Object.keys(built.lists), ['depoimentos', 'curtidas', 'assuntos'], 'the three saved last stay, newest first')
  t.is(l.build({ previous: body, blocked: [] }, { fits: () => false, now: NOW, owner: OWN }), null, 'nothing fits')
})

test('every entry expires 14 days after its own save; saving one list renews no other', async (t) => {
  const l = await load()
  const all = await inputs()
  let body = l.putList(null, 'seguindo', all.seguindo, NOW)
  // Salvos saved every day for 20 days.
  for (let d = 1; d <= 20; d++) {
    body = l.putList(body, 'salvos', all.salvos, NOW + d * DAY)
    if (d <= 14) t.ok('seguindo' in body.lists, 'seguindo still there on day ' + d)
  }
  t.absent('seguindo' in body.lists, 'the untouched list expired on its own clock')
  t.alike(Object.keys(body.lists), ['salvos'])

  const both = l.putList(l.putList(null, 'seguindo', all.seguindo, NOW), 'salvos', all.salvos, NOW + 10 * DAY)
  const text = JSON.parse(JSON.stringify(both))
  t.alike(Object.keys(l.parse(text, { now: NOW + 13 * DAY, owner: OWN }).lists).sort(), ['salvos', 'seguindo'])
  t.alike(Object.keys(l.parse(text, { now: NOW + 15 * DAY, owner: OWN }).lists), ['salvos'], 'parse drops the expired entry')
  t.alike(Object.keys(l.withoutAuthors(text, [], { now: NOW + 15 * DAY }).lists), ['salvos'], 'withoutAuthors too')
  t.alike(Object.keys(l.build({ previous: text, blocked: [] }, { fits, now: NOW + 15 * DAY, owner: OWN }).lists), ['salvos'], 'build too')
  t.alike(l.parse(text, { now: NOW + 25 * DAY, owner: OWN }), { lists: {} }, 'all gone')
  const future = JSON.parse(JSON.stringify(l.putList(null, 'seguindo', all.seguindo, NOW + 2 * DAY)))
  t.alike(l.parse(future, { now: NOW, owner: OWN }), { lists: {} }, 'an entry saved in the future is not fresh')
})

test('the envelope age is the shared one, 14 days', async (t) => {
  const l = await load()
  const s = await loadRules()
  const body = await fullBody(l)
  const snap = s.buildScreenSnapshot('listas', { ...id(), previous: body, blocked: [] })
  const text = JSON.stringify(snap)
  const bind = (now) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now })
  t.ok(s.parseScreenSnapshot(text, 'listas', bind(NOW + 13 * DAY)))
  t.is(s.parseScreenSnapshot(text, 'listas', bind(NOW + 15 * DAY)), null, 'too old')
  t.is(s.parseScreenSnapshot(text, 'listas', bind(NOW - 2 * DAY)), null, 'from the future')
  t.is(l.listsCodec.maxAgeMs, 14 * DAY)
  t.is(l.listsCodec.maxBytes, 262144)
})

test('a block removes its rows across the six lists', async (t) => {
  const l = await load()
  const body = await fullBody(l)
  const out = l.withoutAuthors(body, [STRANGER], { now: NOW })
  t.alike(out.lists.seguindo.rows, [FOLLOW], 'Seguindo')
  t.alike(out.lists.salvos.rows.map((r) => r.ref), [FOLLOW + ':5'], 'Salvos')
  t.alike(out.lists.feira.rows.map((r) => r.author), [OWN, OTHER], 'Feira')
  t.alike(out.lists.assuntos, body.lists.assuntos, 'Assuntos names no one')
  t.alike(out.lists.curtidas.rows.map((r) => r.author), [FOLLOW], 'Curtidas')
  t.alike(out.lists.depoimentos.rows.map((r) => r.from), [FOLLOW], 'Depoimentos by from')
  const quoted = l.withoutAuthors(body, [OTHER], { now: NOW })
  t.alike(quoted.lists.salvos.rows.map((r) => r.ref), [FOLLOW + ':5'], 'a salvo quoting the blocked author goes too')
  t.absent('curtidas' in quoted.lists, 'the likes of a post by the blocked author go whole')
  t.alike(quoted.lists.feira.rows.map((r) => r.author), [OWN, STRANGER])
  const built = l.build({ previous: body, blocked: new Set([STRANGER]) }, { fits, now: NOW, owner: OWN })
  t.alike(built.lists.seguindo.rows, [FOLLOW], 'build leaves blocked keys out too')
  t.alike(built.lists.depoimentos.rows.map((r) => r.from), [FOLLOW])
  t.is(l.build({ previous: body }, { fits, now: NOW, owner: OWN }), null, 'build needs the block list')
})

test('putList and removeList', async (t) => {
  const l = await load()
  const all = await inputs()
  t.is(l.putList(null, 'outra', all.salvos, NOW), null, 'unknown list')
  t.is(l.putList(null, 'seguindo', { scope: '', rows: [FOLLOW] }, NOW), null, 'Seguindo needs its total')
  t.is(l.putList(null, 'curtidas', { scope: 'x', rows: [] }, NOW), null, 'curtidas needs a post ref')
  t.is(l.putList(null, 'salvos', all.salvos, -1), null, 'a bad clock')
  t.is(l.putList(null, 'curtidas', { scope: OTHER + ':1', rows: [] }, NOW).lists.curtidas.total, null, 'a missing curtidas total reads as null')
  const body = await fullBody(l)
  const removed = l.removeList(body, 'feira')
  t.absent('feira' in removed.lists)
  t.is(Object.keys(removed.lists).length, 5)
  t.is(l.removeList(null, 'feira'), null)
  const loose = l.putList(null, 'curtidas', { scope: OTHER + ':1', rows: [{ ...engager(FOLLOW, 1), name: 'x'.repeat(5000), username: 'Não', extra: 1 }, { author: 'nope', seq: 1 }], total: 1 }, NOW)
  t.alike(loose.lists.curtidas.rows, [{ author: FOLLOW, seq: 1, name: null, username: null, avatar }], 'build keeps the row, without what it cannot keep')
})

test('wipe: listas goes with the other kinds through the store', async (t) => {
  const s = await loadRules()
  t.ok(s.SCREEN_SNAPSHOT_KINDS.includes('listas'), 'a kind: clearAll and every wipe reach it')
})
