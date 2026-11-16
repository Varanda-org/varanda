// The rich profile on the browser node (docs/rpc.md): profile.about,
// profile.mood and profile.extra.delete through lib/session.js and an
// in-memory client, on memory storage with no seeder (the node dials a port
// nothing listens on). Both append to the own diary with the tombstones of
// every earlier live version, the newest record wins for readers, a bad field
// is refused by the shared validators before anything is written, and a
// delete tombstones every live version.
const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord, validRecordCopy, moodRecord, profileAboutRecord } = require('@varanda/core/lib/records')
const { deletedSeqs } = require('@varanda/core/lib/deletion')
const { createEngagementIndex } = require('@varanda/core/lib/engagement-index')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { createBrowserNode } = require('../lib/node')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function certified (t, { storage = memoryNodeStorage(), kp = generateAssociationKeyPair(), keyPair = crypto.keyPair(), created = false } = {}) {
  await testnet(t)
  const internal = []
  const node = createBrowserNode({
    storage,
    association: hex(kp.publicKey),
    seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    peekTimeoutMs: 300
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 30000 })
  if (created) return { web, node, key: hex(keyPair.publicKey), internal }
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  return { web, node, key: publicKey, internal }
}

// A certified diary written straight through member-ops with no node, as a
// device on an older version (or several devices) could leave it: every
// record of records() appended as is, so earlier versions stay live.
// -> { ctx, kp, keyPair, storage, key }.
async function prepared (records = []) {
  const kp = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: hex(kp.publicKey), keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  await appendRaw(ctx, records)
  return { ctx, kp, keyPair, storage, key: publicKey }
}

async function appendRaw (ctx, records) {
  for (let i = 0; i < records.length; i += 8) {
    await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, records.slice(i, i + 8)))
  }
}

// The own diary's raw blocks and the seqs of the live blocks of `type`.
async function rawOf (ctx) {
  return member.withIdentity(ctx, ({ diary }) => store.readRaw(diary))
}

function liveOf (raw, type) {
  const gone = deletedSeqs(raw)
  return raw.filter((e) => !gone.has(e.seq) && e.record !== null && e.record.type === type).map((e) => e.seq)
}

function tombsOf (raw) {
  return raw.filter((e) => e.record !== null && e.record.type === 'delete').map((e) => [e.seq, e.record.seq])
}

// Wraps store.appendRecords for one test: counts each append's size and
// throws on the failAt-th call (from 1), 0 for never.
function spyAppends (t, failAt = 0) {
  const orig = store.appendRecords
  const sizes = []
  store.appendRecords = async (diary, records, limits) => {
    sizes.push(records.length)
    if (sizes.length === failAt) throw new Error('falha simulada')
    return orig(diary, records, limits)
  }
  t.teardown(() => { store.appendRecords = orig })
  return sizes
}

function moods (n, from = 0) {
  return Array.from({ length: n }, (_, i) => moodRecord({ emoji: '', text: 'humor ' + (from + i) }))
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function entries (web) {
  return (await web.request('log.read', {})).entries
}

const FULL = {
  about: 'Moro em Curitiba.\nGosto de música.',
  city: 'Curitiba',
  work: 'Marcenaria',
  studies: 'Design',
  interests: 'café, bicicleta',
  birthday: '02-29',
  theme: 'floresta'
}
const EMPTY = { about: null, city: null, work: null, studies: null, interests: null, birthday: null, theme: null }

test('profile.about appends the record with every key, a second one replaces it and null clears a field', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('profile.about', FULL), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('profile.about', { ...FULL, city: null, theme: null }), { seq: 3, ref: key + ':3' }, 'a repeat is another record, after the tombstone of the first')
  t.alike(await web.request('profile.about', EMPTY), { seq: 5, ref: key + ':5' }, 'all empty clears the profile extras')

  const log = await entries(web)
  t.alike(log.map((e) => [e.seq, e.record.type]), [[0, 'member-cert'], [2, 'delete'], [4, 'delete'], [5, 'profile-about']], 'only the newest version is left')
  t.alike(log.filter((e) => e.record.type === 'delete').map((e) => e.record.seq), [1, 3], 'each edit tombstones the version before')
  const last = log[log.length - 1]
  t.alike(Object.keys(last.record), ['type', 'about', 'city', 'work', 'studies', 'interests', 'birthday', 'theme', 'at'])
  t.alike({ ...last.record, type: undefined, at: undefined }, { ...EMPTY, type: undefined, at: undefined })
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(internal, [])
})

test('profile.about keeps every key of the record it writes', async (t) => {
  const { web, internal } = await certified(t)
  await web.request('profile.about', FULL)
  await web.request('profile.about', { ...FULL, city: null, theme: null })
  const log = await entries(web)
  const last = log[log.length - 1]
  t.alike({ ...last.record, type: undefined, at: undefined }, { ...FULL, city: null, theme: null, type: undefined, at: undefined })
  t.alike(internal, [])
})

test('profile.mood appends the record, tombstones the one before, and both fields empty clear it', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('profile.mood', { emoji: '😀', text: 'em dia de feira' }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('profile.mood', { emoji: '☕' }), { seq: 3, ref: key + ':3' }, 'the text defaults to empty')
  t.alike(await web.request('profile.mood', { emoji: '', text: 'só texto' }), { seq: 5, ref: key + ':5' }, 'no emoji, only text')
  t.alike(await web.request('profile.mood', { emoji: '', text: '' }), { seq: 7, ref: key + ':7' }, 'clear')

  const log = await entries(web)
  t.alike(log.map((e) => e.record.type), ['member-cert', 'delete', 'delete', 'delete', 'mood'])
  t.alike(log.filter((e) => e.record.type === 'delete').map((e) => [e.seq, e.record.seq]), [[2, 1], [4, 3], [6, 5]])
  const last = log[log.length - 1]
  t.alike(Object.keys(last.record), ['type', 'emoji', 'text', 'at'])
  t.alike([last.record.emoji, last.record.text], ['', ''])
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.alike(internal, [])
})

test('profile.about and profile.mood tombstone only their own type, in the same append as the new record', async (t) => {
  const { web, key, internal } = await certified(t)
  await web.request('profile.about', FULL)
  await web.request('profile.mood', { emoji: '😀' })
  const ix = indexOf(key, await entries(web))
  t.alike(await web.request('profile.about', { ...FULL, city: 'Recife' }), { seq: 4, ref: key + ':4' })
  t.alike(await web.request('profile.mood', { emoji: '☕' }), { seq: 6, ref: key + ':6' })
  const log = await entries(web)
  const tombs = log.filter((e) => e.record.type === 'delete')
  t.alike(tombs.map((e) => [e.seq, e.record.seq]), [[3, 1], [5, 2]])
  indexOf(key, log.filter((e) => e.seq > 2), ix)
  t.is(ix.profileExtra(key).about, 4, 'the seeder shows the newest about')
  t.is(ix.profileExtra(key).mood, 6, 'and the newest mood')
  t.alike(internal, [])
})

test('profileAbout tombstones every earlier live version, and edited twice only the newest is live', async (t) => {
  const { ctx } = await prepared([
    profileAboutRecord({ ...FULL, city: 'A' }),
    moodRecord({ emoji: '😀' }),
    profileAboutRecord({ ...FULL, city: 'B' })
  ])
  const sizes = spyAppends(t)
  t.alike(liveOf(await rawOf(ctx), 'profile-about'), [1, 3], 'two live versions left by an older writer')
  const r = await member.profileAbout(ctx, { ...FULL, city: 'C' })
  t.is(r.seq, 6)
  t.alike(sizes, [3], 'both tombstones and the new record in one append')
  let raw = await rawOf(ctx)
  t.alike(tombsOf(raw), [[4, 1], [5, 3]])
  t.alike(liveOf(raw, 'profile-about'), [6])
  t.alike(liveOf(raw, 'mood'), [2], 'the mood is untouched')

  const r2 = await member.profileAbout(ctx, { ...FULL, city: 'D' })
  t.is(r2.seq, 8)
  raw = await rawOf(ctx)
  t.alike(tombsOf(raw), [[4, 1], [5, 3], [7, 6]])
  t.alike(liveOf(raw, 'profile-about'), [8], 'edited twice, only the newest is live')
  t.is(raw[8].record.city, 'D')
  for (const e of raw.slice(1)) if (e.record !== null) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
})

test('profileAbout with seven earlier versions is still one append of eight', async (t) => {
  const { ctx } = await prepared(Array.from({ length: 7 }, (_, i) => profileAboutRecord({ ...EMPTY, city: 'v' + i })))
  const sizes = spyAppends(t)
  const r = await member.profileAbout(ctx, FULL)
  t.alike(sizes, [8])
  t.is(r.seq, 15)
  t.alike(liveOf(await rawOf(ctx), 'profile-about'), [15])
})

test('profileAbout past one append: older tombstones first, the newest earlier version goes with the new record', async (t) => {
  const { ctx } = await prepared(Array.from({ length: 9 }, (_, i) => profileAboutRecord({ ...EMPTY, city: 'v' + i })))
  const sizes = spyAppends(t)
  const r = await member.profileAbout(ctx, FULL)
  t.alike(sizes, [2, 8], 'the two oldest first, then seven tombstones and the record')
  t.is(r.seq, 19, 'the new record is the last block')
  const raw = await rawOf(ctx)
  t.alike(tombsOf(raw), [[10, 1], [11, 2], [12, 3], [13, 4], [14, 5], [15, 6], [16, 7], [17, 8], [18, 9]], 'oldest first, the newest earlier version last')
  t.alike(liveOf(raw, 'profile-about'), [19])
  t.is(raw[19].record.about, FULL.about)
})

test('moodSet past one append: a failed final append leaves the newest earlier mood showing, and a repeat converges', async (t) => {
  const { ctx } = await prepared(moods(10))
  const sizes = spyAppends(t, 2)
  const err = await member.moodSet(ctx, { emoji: '☕', text: 'novo' }).then(() => null, (e) => e)
  t.ok(err !== null && /falha simulada/.test(err.message), 'the failed append throws')
  t.is(err.written, 13, 'the error carries the last block already stored')
  t.alike(sizes, [3, 8])
  let raw = await rawOf(ctx)
  t.alike(tombsOf(raw), [[11, 1], [12, 2], [13, 3]], 'only the oldest went')
  const live = liveOf(raw, 'mood')
  t.alike(live, [4, 5, 6, 7, 8, 9, 10])
  t.is(raw[live[live.length - 1]].record.text, 'humor 9', 'the newest earlier mood still shows, never an older one')

  const r = await member.moodSet(ctx, { emoji: '☕', text: 'novo' })
  t.alike(sizes, [3, 8, 8], 'the repeat fits in one append')
  t.is(r.seq, 21)
  raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'mood'), [21], 'only the new mood is live')
  t.is(tombsOf(raw).length, 10)
})

test('moodSet republished tombstones every earlier live mood and leaves the about', async (t) => {
  const { ctx } = await prepared([moodRecord({ emoji: '😀' }), profileAboutRecord(FULL), moodRecord({ emoji: '☕' })])
  const r = await member.moodSet(ctx, { emoji: '', text: 'oi' })
  t.is(r.seq, 6)
  const raw = await rawOf(ctx)
  t.alike(tombsOf(raw), [[4, 1], [5, 3]])
  t.alike(liveOf(raw, 'mood'), [6])
  t.alike(liveOf(raw, 'profile-about'), [2])
})

test('profile.mood after a failed chunk still counts what landed and answers the error', async (t) => {
  const { kp, keyPair, storage, key } = await prepared(moods(10))
  const { web, internal } = await certified(t, { storage, kp, keyPair, created: true })
  spyAppends(t, 2)
  const err = await errorOf(web.request('profile.mood', { emoji: '☕' }))
  t.is(err && err.code, 'INTERNAL', 'the write fails')
  const log = await entries(web)
  t.alike(log.filter((e) => e.record.type === 'delete').map((e) => e.record.seq), [1, 2, 3], 'the first chunk landed')
  const shown = log.filter((e) => e.record.type === 'mood')
  t.alike(shown.map((e) => e.seq), [4, 5, 6, 7, 8, 9, 10])
  t.is(shown[shown.length - 1].record.text, 'humor 9', 'the newest earlier mood still shows')
  t.alike(await web.request('profile.mood', { emoji: '☕' }), { seq: 21, ref: key + ':21' }, 'a repeat by the user finishes it')
  t.alike((await entries(web)).filter((e) => e.record.type === 'mood').map((e) => e.seq), [21])
  t.alike(internal.map((e) => e.message), ['falha simulada'], 'the failure was reported once, as an internal error')
})

test('profile.about refuses an invalid theme, birthday or field, and nothing is written', async (t) => {
  const { web, internal } = await certified(t)
  const bad = (p) => ['USAGE', 'parâmetro inválido: ' + p]
  t.alike(await errorPair(web.request('profile.about', { ...FULL, theme: 'neon' })), bad('theme'), 'an unknown theme id')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, theme: '' })), bad('theme'), 'empty is null, never an empty string')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, birthday: '02-30' })), bad('birthday'), 'a day the month lacks')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, birthday: '13-01' })), bad('birthday'), 'a month past 12')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, birthday: '1990-05-17' })), bad('birthday'), 'a birthday has no year')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, about: 'x'.repeat(601) })), bad('about'))
  t.alike(await errorPair(web.request('profile.about', { ...FULL, city: '   ' })), bad('city'), 'only whitespace')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, city: 'a\nb' })), bad('city'), 'a line break outside about')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, work: 'x'.repeat(81) })), bad('work'))
  t.alike(await errorPair(web.request('profile.about', { ...FULL, interests: 'x'.repeat(201) })), bad('interests'))
  const { theme, ...missing } = FULL
  t.is(theme, 'floresta')
  t.alike(await errorPair(web.request('profile.about', missing)), ['USAGE', 'parâmetro obrigatório: theme'], 'every key is required')
  t.alike(await errorPair(web.request('profile.about', { ...FULL, relationship: 'solteira' })), ['USAGE', 'parâmetro desconhecido'], 'no relationship field')
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('profile.mood refuses a bad emoji or text, and nothing is written', async (t) => {
  const { web, internal } = await certified(t)
  const bad = (p) => ['USAGE', 'parâmetro inválido: ' + p]
  t.alike(await errorPair(web.request('profile.mood', { emoji: 'ab' })), bad('emoji'), 'not an emoji')
  t.alike(await errorPair(web.request('profile.mood', { emoji: '😀😀' })), bad('emoji'), 'two emoji')
  t.alike(await errorPair(web.request('profile.mood', { emoji: '😀', text: 'x'.repeat(61) })), bad('text'))
  t.alike(await errorPair(web.request('profile.mood', { emoji: '😀', text: 'a\nb' })), bad('text'), 'one line')
  t.alike(await errorPair(web.request('profile.mood', { text: 'sem emoji' })), ['USAGE', 'parâmetro obrigatório: emoji'], 'the emoji is required (may be empty)')
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert'], 'nothing written')
  t.alike(internal, [])
})

test('profile.about and profile.mood need a certificate and an unlocked identity', async (t) => {
  await testnet(t)
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: hex(generateAssociationKeyPair().publicKey),
    seederUrl: 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node, { timeoutMs: 30000 })
  const [c1] = await errorPair(web.request('profile.about', FULL))
  const [c2] = await errorPair(web.request('profile.mood', { emoji: '😀' }))
  t.ok(c1 !== null && c1 !== undefined, 'about refused without an identity')
  t.ok(c2 !== null && c2 !== undefined, 'mood refused without an identity')
})

const LOCKED = 'identidade bloqueada: entre com a passkey'
const NOTHING = ['USAGE', 'nada para apagar']

// The seeder's engagement index fed with `log` the way the seeder scans a
// diary: tombstones applied with removeRecord, other records added.
function indexOf (key, log, ix = createEngagementIndex()) {
  for (const e of log) {
    if (e.record.type === 'delete') ix.removeRecord(key, e.record.seq)
    else ix.add(key, e.seq, validRecordCopy(e.record, e.seq))
  }
  return ix
}

test('profile.extra.delete about tombstones every live version in one append and the index then points at none', async (t) => {
  // Several live versions, as an older writer could leave them.
  const p = await prepared([
    profileAboutRecord(FULL),
    moodRecord({ emoji: '☕' }),
    profileAboutRecord({ ...FULL, city: null }),
    profileAboutRecord({ ...FULL, theme: 'mar' })
  ])
  const { web, key, internal } = await certified(t, { ...p, created: true })
  const before = await entries(web)
  const ix = indexOf(key, before)
  t.is(ix.profileExtra(key).about, 4)

  t.alike(await web.request('profile.extra.delete', { kind: 'about' }), { seq: 7, deleted: [1, 3, 4] })
  const log = await entries(web)
  const tombs = log.filter((e) => e.record.type === 'delete')
  t.alike(tombs.map((e) => [e.seq, e.record.seq]), [[5, 1], [6, 3], [7, 4]], 'one tombstone per version')
  t.ok(tombs.every((e) => e.record.at === tombs[0].record.at), 'one append, one at')
  for (const e of tombs) t.is(validateRecord(e.record, e.seq), null, 'valid tombstone at its seq')
  t.absent(log.some((e) => e.record.type === 'profile-about'), 'no version is readable any more')
  t.alike(log.filter((e) => e.record.type === 'mood').map((e) => e.seq), [2], 'the mood is untouched')
  indexOf(key, tombs, ix)
  t.is(ix.profileExtra(key).about, null, 'no older version comes back on the seeder')
  t.is(ix.profileExtra(key).mood, 2)

  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'about' })), NOTHING, 'a repeat finds nothing live')
  t.is((await entries(web)).length, log.length, 'and writes nothing')
  t.alike(internal, [])
})

test('profile.extra.delete after edits through the node tombstones the one live version', async (t) => {
  const { web, key, internal } = await certified(t)
  await web.request('profile.about', FULL)
  await web.request('profile.about', { ...FULL, city: null })
  t.alike(await web.request('profile.extra.delete', { kind: 'about' }), { seq: 4, deleted: [3] })
  const log = await entries(web)
  t.absent(log.some((e) => e.record.type === 'profile-about'))
  t.is(indexOf(key, log).profileExtra(key).about, null)
  t.alike(internal, [])
})

test('profile.extra.delete mood tombstones every live mood, the cleared one included', async (t) => {
  const p = await prepared([
    moodRecord({ emoji: '😀', text: 'feliz' }),
    profileAboutRecord(FULL),
    moodRecord({ emoji: '', text: 'só texto' }),
    moodRecord({ emoji: '', text: '' })
  ])
  const { web, key, internal } = await certified(t, { ...p, created: true })
  const ix = indexOf(key, await entries(web))
  t.is(ix.profileExtra(key).mood, 4)

  t.alike(await web.request('profile.extra.delete', { kind: 'mood' }), { seq: 7, deleted: [1, 3, 4] })
  const log = await entries(web)
  t.absent(log.some((e) => e.record.type === 'mood'))
  t.alike(log.filter((e) => e.record.type === 'profile-about').map((e) => e.seq), [2], 'the about is untouched')
  indexOf(key, log.filter((e) => e.record.type === 'delete'), ix)
  t.is(ix.profileExtra(key).mood, null)
  t.is(ix.profileExtra(key).about, 2)
  t.alike(internal, [])
})

test('profile.extra.delete past one append: every version goes, the newest one last', async (t) => {
  const p = await prepared(moods(10))
  const { web, key, internal } = await certified(t, { ...p, created: true })
  const r = await web.request('profile.extra.delete', { kind: 'mood' })
  t.alike(r.deleted, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const tombs = (await entries(web)).filter((e) => e.record.type === 'delete')
  t.is(tombs.length, 10)
  t.is(r.seq, tombs[tombs.length - 1].seq)
  t.is(tombs[tombs.length - 1].record.seq, 10, 'the shown version is tombstoned last, so a failed chunk leaves it showing')
  t.is(indexOf(key, await entries(web)).profileExtra(key).mood, null)
  t.alike(internal, [])
})

test('profile.extra.delete with nothing live answers nada para apagar and writes nothing', async (t) => {
  const { web, internal } = await certified(t)
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'about' })), NOTHING)
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'mood' })), NOTHING)
  await web.request('profile.mood', { emoji: '😀' })
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'about' })), NOTHING, 'a mood is not an about')
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'theme' })), ['USAGE', 'parâmetro inválido: kind'])
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert', 'mood'], 'nothing written')
  t.alike(internal, [])
})

test('profile.extra.delete needs an unlocked identity, and nothing is written while locked', async (t) => {
  const { web, node, internal } = await certified(t)
  await web.request('profile.about', FULL)
  await node.clearKeyPair()
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'about' })), ['USAGE', LOCKED])
  t.alike(await errorPair(web.request('profile.extra.delete', { kind: 'mood' })), ['USAGE', LOCKED])
  t.alike((await entries(web)).map((e) => e.record.type), ['member-cert', 'profile-about'], 'nothing written')
  t.alike(internal, [])
})
