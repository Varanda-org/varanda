'use strict'

// A page in a PUBLIC group does what a person does (docs/protocol.md §12,
// "Páginas em comunidades"), through the page routes of
// apps/cli/lib/account/pages-routes.js, loopback only: a local seeder and
// seed-ws on a local DHT, the account service with pages on and a real
// pages-groups client, and a member node that reads what the page wrote.

const test = require('brittle')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept, signClose } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { BLOCKED_TERMS } = require('@varanda/rpc')
const member = require('@varanda/core/lib/member')
const store = require('@varanda/core/lib/store')
const { person, startSeeder, syncOnce } = require('../../../packages/core/test/helpers/sync-groups')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesGroups, authorHideIs } = require('../lib/account/pages-groups')
const { createAccountServer } = require('../lib/account/server')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function newKey () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function sha256 (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

function be16 (n) {
  return [(n >> 8) & 0xff, n & 0xff]
}

function le16 (n) {
  return [n & 0xff, (n >> 8) & 0xff]
}

// apps/cli/test/pages-media.test.js's JPEG.
function jpeg (width, height, size, fill = 0x5a) {
  const head = b4a.from([0xff, 0xd8, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const out = b4a.alloc(size, fill)
  head.copy(out, 0)
  out[size - 2] = 0xff
  out[size - 1] = 0xd9
  return out
}

// packages/rpc/test/media-bounds.test.js's GIF.
function gif (w, h, frames) {
  const parts = [...b4a.from('GIF89a'), ...le16(w), ...le16(h), 0x80, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < frames; i++) {
    parts.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0)
    parts.push(0x2c, ...le16(0), ...le16(0), ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0)
  }
  parts.push(0x3b)
  return b4a.from(parts)
}

// packages/web-member/test/dm.test.js's minimal MPEG-4 audio file: what
// audioBounds reads, with no metadata.
function m4a ({ ms = 3000 } = {}) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  const trak = (h) => box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(h), be32(0), be32(0), be32(0), [0]), box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 28, 0, 1, 0, 4, 20, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 23, 135, 208, 0, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(ms), be32(1)), box('stsz', [0, 0, 0, 0], be32(1), be32(ms)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(ms), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  return b4a.from([
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), trak('soun')),
    ...box('mdat', new Array(ms).fill(9))
  ])
}

test('pages groups parity: the hide skip reads only writers a page diary join binds', (t) => {
  const P = 'p'.repeat(64)
  const W = 'a'.repeat(64)
  const F = 'f'.repeat(64)
  const target = { writer: W, seq: 3 }
  const hide = (on, at) => ({ seq: 1, record: { type: 'group-hide', target, on, at } })
  const bound = { key: W, diary: P, entries: [hide(true, '2026-11-17T10:00:00.000Z')] }
  // Its header claims the page diary, with no join behind it.
  const forged = { key: F, diary: P, entries: [hide(false, '2099-01-01T00:00:00.000Z')] }
  const loaded = { bound: [bound], input: { writers: [bound, forged] } }
  t.ok(authorHideIs(loaded, P, target, true), 'hidden, from the bound writer')
  t.absent(authorHideIs(loaded, P, target, false), 'a forged unhide does not skip a real unhide')
  const forgedHide = { key: F, diary: P, entries: [hide(true, '2099-01-01T00:00:00.000Z')] }
  t.absent(authorHideIs({ bound: [], input: { writers: [forgedHide] } }, P, target, true), 'an unbound writer alone hides nothing')
})

test('pages groups parity: in a public group a page posts, reacts, votes and hides as a person', async (t) => {
  t.timeout(900000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const seeder = await startSeeder(t, bootstrap, assocKp)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + ws.port

  const a = await person(t, assocKp, 'Ana')
  const { community: C } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: G } = await member.groupCreate(a, { name: 'Praça', join: 'open', community: C })
  const { group: GP } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community: C })
  const theirs = await member.groupPost(a, { group: G, text: 'bom dia, praça' })
  await syncOnce(bootstrap, a)

  const dir = tmpDir(t, 'varanda-account-')
  const accounts = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const log = () => {}
  const writer = createPagesWriter({ dir, keys, association, seederWs, log })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  await until(() => writer.connected() && pg.connected(), { name: 'links up', timeoutMs: 20000 })
  const accountServer = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleStub(),
    store: accounts,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    // The global bucket would throttle this test's many polls.
    ratePerSecond: 1000,
    burst: 5000,
    pages: { keys, writer, pagesStore, dir, pagesGroups: pg, blocklist: { has: () => false }, limits: { reboxEveryMs: 0, ops: () => true, media: () => true } }
  })
  const server = await accountServer.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => server.close(), { force: true })
  const base = 'http://127.0.0.1:' + server.port

  async function api (pathname, body, headers = null) {
    const init = { method: 'POST', headers: { origin: ORIGIN } }
    if (headers !== null) {
      Object.assign(init.headers, headers, { 'content-type': 'application/octet-stream' })
      init.body = body
    } else {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let subSeq = 300
  let termsCount = 0
  async function linked (username) {
    const m = newKey()
    const row = accounts.start({ member: m.hex, username })
    accounts.reserve(row.id)
    accounts.putGoogle(row.id, { sub: '70000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
    await accounts.finish(row.id, { signature: 'a'.repeat(128) }, issuerKp, issuerCert, association)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'H'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }

  async function start (m, action) {
    const r = await api('/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status)
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    return api('/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }

  // Again while the fold is still partial.
  function settled (m, action, page, op, name) {
    return until(async () => {
      const r = await act(m, action, page, op)
      return r.body && r.body.error === 'indisponivel' ? null : r
    }, { name, timeoutMs: 120000, intervalMs: 500 })
  }

  // One signed body, to send and resend as is.
  async function signed (m, action, page, op) {
    const { nonce } = await start(m, action)
    return { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) }
  }

  async function upload (m, page, bytes, op) {
    const { nonce } = await start(m, 'media')
    return api('/account/pages/media', bytes, {
      'x-varanda-page-member': m.hex,
      'x-varanda-page-nonce': nonce,
      'x-varanda-page-page': page,
      'x-varanda-page-signature': sign(m, 'media', nonce, page, op),
      'x-varanda-page-op': JSON.stringify(op)
    })
  }

  async function item (m, page, bytes, fields) {
    const r = await upload(m, page, bytes, { sha256: sha256(bytes), bytes: bytes.length, ...fields })
    t.is(r.status, 200, 'upload ' + fields.mime + ': ' + JSON.stringify(r.body))
    return r.body.descriptor
  }

  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  const ana = await linked('ana')
  const bia = await linked('bia')
  const cai = await linked('cai')

  const created = await start(ana, 'create')
  const P = created.page
  const genesis = roster(ana, P, { gen: 1, owner: ana.hex, admins: [], prev: null }, created.nonce)
  const createOp = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: genesis.at, nonce: created.nonce } }
  const made = await api('/account/pages/create', { member: ana.hex, nonce: created.nonce, page: P, op: createOp, signature: sign(ana, 'create', created.nonce, P, createOp), record: genesis })
  t.is(made.status, 200, JSON.stringify(made.body))
  {
    const { nonce } = await start(ana, 'invite')
    const row = pagesStore.get(P)
    const record = roster(ana, P, { gen: row.gen + 1, owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq }, nonce)
    const op = { member: bia.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq, at: record.at, nonce } }
    t.is((await api('/account/pages/invite', { member: ana.hex, nonce, page: P, op, signature: sign(ana, 'invite', nonce, P, op), record })).status, 200)
    const acc = await start(bia, 'accept')
    const f = { page: P, gen: row.gen + 1, rosterSignature: pagesStore.get(P).invites[bia.hex].rosterSignature, at: new Date().toISOString(), nonce: acc.nonce, actor: bia.hex }
    t.is((await api('/account/pages/accept', { member: bia.hex, nonce: acc.nonce, page: P, record: { type: 'page-accept', ...f, signature: signAccept(f, bia.kp) } })).status, 200)
  }

  t.is((await settled(ana, 'community-join', P, { community: C }, 'community join')).body.role, 'member')
  t.is((await settled(bia, 'group-join', P, { group: G, community: C }, 'group join')).body.state, 'member')
  const W = pg.writersOf(P).find((r) => r.group === G).writer

  // The page writer's records as the member node replicates them.
  async function pageLog (min, writer = W, ok = (entries) => entries.length >= min) {
    return until(async () => {
      await syncOnce(bootstrap, a)
      const s = await store.openStore(a.dataDir)
      try {
        const core = await store.openReplica(s, writer)
        try {
          const entries = await store.readBlocks(core)
          return ok(entries) ? entries : null
        } finally {
          await core.close()
        }
      } finally {
        await s.close()
      }
    }, { name: 'page writer log', timeoutMs: 180000, intervalMs: 500 })
  }

  async function readAsPage () {
    return (await settled(bia, 'group-read', P, { group: G }, 'group read')).body
  }

  // ---- uploads ----------------------------------------------------------
  const photo = await item(bia, P, jpeg(640, 480, 2000), { mime: 'image/jpeg', width: 640, height: 480 })
  const anim = await item(bia, P, gif(10, 20, 3), { mime: 'image/gif', width: 10, height: 20 })
  const voiceBytes = m4a()
  const voice = await item(bia, P, voiceBytes, { mime: 'audio/mp4', width: 0, height: 0, ms: 3000 })
  t.alike(Object.keys(voice).sort(), ['blocks', 'bytes', 'core', 'height', 'mime', 'ms', 'sha256', 'start', 'width'], 'a voice note has the person\'s audio descriptor keys')
  t.is(voice.width, 0)
  t.is(voice.ms, 3000)
  const thumb = await item(bia, P, jpeg(64, 64, 400), { mime: 'image/jpeg', width: 64, height: 64 })
  const badVoice = (fields) => upload(bia, P, voiceBytes, { sha256: sha256(voiceBytes), bytes: voiceBytes.length, mime: 'audio/mp4', width: 0, height: 0, ms: 3000, ...fields })
  t.is((await badVoice({ ms: 60000 })).body.error, 'midia-invalida', 'a voice note claiming another duration')
  t.is((await badVoice({ width: 1 })).body.error, 'midia-invalida', 'a voice note with a picture size')
  t.is((await upload(bia, P, voiceBytes, { sha256: sha256(voiceBytes), bytes: voiceBytes.length, mime: 'audio/mp4', width: 0, height: 0 })).body.error, 'midia-invalida', 'a voice note with no duration')
  const notAudio = jpeg(64, 64, 400, 0x11)
  t.is((await upload(bia, P, notAudio, { sha256: sha256(notAudio), bytes: notAudio.length, mime: 'audio/mp4', width: 0, height: 0, ms: 3000 })).body.error, 'midia-invalida', 'bytes that are no voice note')

  // A voice note is a group item only: never in a page post, reply, quote,
  // listing or link card.
  const plain = await act(bia, 'post', P, { text: 'oi' })
  t.is(plain.status, 200, JSON.stringify(plain.body))
  const to = P + ':' + plain.body.seq
  t.is((await act(bia, 'post', P, { text: 'voz', media: [voice] })).body.error, 'midia-invalida', 'no voice note in a page post')
  t.is((await act(bia, 'reply', P, { to, text: 'voz', media: [voice] })).body.error, 'midia-invalida', 'nor in a reply')
  t.is((await act(bia, 'quote', P, { to, text: 'voz', media: [voice] })).body.error, 'midia-invalida', 'nor in a quote')
  const listing = { kind: 'servico', title: 'Conserto de bicicleta', text: 'Na garagem', price: 5000, unit: 'hora', cat: 'reparos', place: { uf: 'SP', city: 'São Paulo', bairro: null } }
  t.is((await act(bia, 'listing', P, { ...listing, media: [voice] })).body.error, 'midia-invalida', 'nor in a listing')
  t.is((await act(bia, 'post', P, { text: 'x', preview: { url: 'https://example.com/v', image: voice } })).body.error, 'midia-invalida', 'nor as a card image')

  // ---- posts ------------------------------------------------------------
  const post = (op, name) => settled(bia, 'group-post', P, { group: G, ...op }, name)
  const withPhoto = await post({ text: '', media: [photo] }, 'photo post')
  t.is(withPhoto.status, 200, 'a photo post: ' + JSON.stringify(withPhoto.body))
  const withGif = await post({ text: 'olha', media: [anim] }, 'gif post')
  t.is(withGif.status, 200, 'a GIF post')
  const withVoice = await post({ text: '', media: [voice] }, 'voice post')
  t.is(withVoice.status, 200, 'a voice note post')
  t.is((await post({ text: '', media: [voice, photo] }, 'voice and photo')).body.error, 'midia-invalida', 'a voice note never next to a photo')
  const video = { ...photo, mime: 'video/mp4', ms: 3000 }
  t.is((await post({ text: '', media: [video] }, 'video')).body.error, 'midia-invalida', 'no video in a group')
  const stranger = { ...photo, sha256: 'ee'.repeat(32) }
  t.is((await post({ text: '', media: [stranger] }, 'stranger media')).body.error, 'midia-invalida', 'only the page\'s own items')
  t.is((await post({ text: 'x', media: [photo], card: { url: 'https://example.com/a' } }, 'media and card')).body.error, 'pedido-invalido', 'media and a card never together')

  const card = await post({ text: 'veja', card: { url: 'https://example.com/pao', title: 'Pão' } }, 'card post')
  t.is(card.status, 200, 'a card without image: ' + JSON.stringify(card.body))
  const cardImg = await post({ text: 'com foto', card: { url: 'https://example.com/bolo', title: 'Bolo', image: thumb } }, 'card image post')
  t.is(cardImg.status, 200, 'a card with the page\'s own thumbnail: ' + JSON.stringify(cardImg.body))
  t.is((await post({ text: 'x', card: { url: 'https://example.com/c', image: { ...thumb, sha256: 'ab'.repeat(32) } } }, 'card stranger image')).body.error, 'midia-invalida', 'a card image that is not a page item')
  t.is((await post({ text: 'x', card: { url: 'https://example.com/c', image: voice } }, 'card voice image')).body.error, 'midia-invalida', 'a voice note is no card image')
  t.is((await post({ text: '\u0007', media: [photo] }, 'bad caption')).body.error, 'pedido-invalido', 'a bad caption is a text refusal, not a media one')
  t.is((await post({ text: 'x', card: { url: 'https://example.com/' + BLOCKED_TERMS[0] } }, 'card term')).body.error, 'termo-recusado', 'the card url through the blocklist')

  const reply = await post({ text: 'respondendo', replyTo: { writer: G, seq: theirs.seq } }, 'reply')
  t.is(reply.status, 200, 'a reply')
  const fwd = await post({ text: 'repassando', fwd: 1 }, 'forward')
  t.is(fwd.status, 200, 'a forward')

  // ---- forum ------------------------------------------------------------
  const topic = await post({ text: 'Tópico do pão', topic: true }, 'topic')
  t.is(topic.status, 200, 'a topic: ' + JSON.stringify(topic.body))
  const poll = await post({ text: 'Qual pão?', topic: true, poll: ['Francês', 'Integral'] }, 'poll')
  t.is(poll.status, 200, 'a topic with a poll')
  const event = await post({ text: 'Feira de pães', event: { title: 'Feira', start: '2030-01-01T10:00:00.000Z', end: null, place: 'Praça' } }, 'event')
  t.is(event.status, 200, 'an event: ' + JSON.stringify(event.body))
  t.is((await post({ text: 'Feira', media: [photo], event: { title: 'Feira', start: '2030-01-01T10:00:00.000Z' } }, 'event media')).body.error, 'pedido-invalido', 'an event never with media')
  t.is((await post({ text: 'enquete', poll: ['a', 'b'] }, 'poll alone')).body.error, 'pedido-invalido', 'a poll only on a topic')
  t.is((await post({ text: 'resp', topic: true, replyTo: { writer: G, seq: theirs.seq } }, 'topic reply')).body.error, 'pedido-invalido', 'a topic is a root')
  t.is((await post({ text: 'Qual?', topic: true, poll: ['ok', BLOCKED_TERMS[0]] }, 'poll term')).body.error, 'termo-recusado', 'poll options through the blocklist')
  t.is((await post({ text: 'Feira', event: { title: 'Feira', start: '2030-01-01T10:00:00.000Z', place: BLOCKED_TERMS[0] } }, 'event term')).body.error, 'termo-recusado', 'the event place through the blocklist')

  const log1 = await pageLog(event.body.seq + 2)
  const at = (seq) => log1.find((e) => e.seq === seq).record
  t.is(at(topic.body.seq).type, 'group-post')
  t.alike(at(topic.body.seq + 1).target, { writer: W, seq: topic.body.seq }, 'the topic mark names its root')
  t.is(at(topic.body.seq + 1).type, 'group-topic')
  t.is(at(poll.body.seq + 1).type, 'group-topic', 'a poll root: topic at root+1')
  t.is(at(poll.body.seq + 2).type, 'group-poll', 'and the poll at root+2')
  t.alike(at(poll.body.seq + 2).target, { writer: W, seq: poll.body.seq })
  t.alike(at(poll.body.seq + 2).options, ['Francês', 'Integral'])
  t.is(at(event.body.seq + 1).type, 'group-event', 'an event at root+1')
  t.alike(at(event.body.seq + 1).target, { writer: W, seq: event.body.seq })
  t.alike(at(withVoice.body.seq).media, [voice], 'the voice note descriptor as stored')
  t.alike(at(cardImg.body.seq).card.image, thumb, 'the card thumbnail as stored')
  t.is(at(fwd.body.seq).fwd, 1)
  t.alike(at(reply.body.seq).replyTo, { writer: G, seq: theirs.seq })

  // ---- reactions ----------------------------------------------------------
  const target = { writer: G, seq: theirs.seq }
  const react = (op, name) => settled(bia, 'group-react', P, { group: G, target, ...op }, name)
  t.alike((await react({ emoji: '👍' }, 'react')).body, { ok: true }, 'a reaction')
  let length = (await pageLog(event.body.seq + 3)).length
  let row = (await readAsPage()).items.find((x) => x.seq === theirs.seq && x.writer === G)
  t.alike(row.reactions, [{ emoji: '👍', count: 1, mine: true }], 'the page reads its reaction')
  t.alike((await react({ emoji: '👍' }, 'react again')).body, { ok: true }, 'the same reaction again')
  t.alike((await react({ emoji: '' }, 'withdraw')).body, { ok: true }, 'a withdrawal')
  const afterReact = await pageLog(length + 1)
  t.is(afterReact.length, length + 1, 'the repeat wrote nothing, the withdrawal one block')
  length = afterReact.length
  row = (await readAsPage()).items.find((x) => x.seq === theirs.seq && x.writer === G)
  t.absent(row.reactions, 'no reaction left')
  t.is((await settled(bia, 'group-react', P, { group: G, target: { writer: G, seq: 999 }, emoji: '👍' }, 'react missing')).body.error, 'nao-encontrado', 'no reaction on a missing post')
  t.is((await act(bia, 'group-react', P, { group: G, target, emoji: 'nao-emoji' })).body.error, 'pedido-invalido', 'the emoji is checked before the lock')

  // ---- votes and RSVPs ----------------------------------------------------
  const vote = (tgt, pick, name) => settled(bia, 'group-choice', P, { group: G, target: tgt, pick }, name)
  const pollRoot = { writer: W, seq: poll.body.seq }
  t.alike((await vote(pollRoot, 1, 'vote')).body, { ok: true }, 'a vote')
  t.alike((await vote(pollRoot, 1, 're-vote')).body, { ok: true }, 'the same vote again')
  t.is((await vote(pollRoot, 5, 'bad pick')).body.error, 'pedido-invalido', 'a pick outside the poll')
  t.alike((await vote(pollRoot, null, 'withdraw vote')).body, { ok: true }, 'a withdrawn vote')
  t.alike((await vote({ writer: W, seq: event.body.seq }, 0, 'rsvp')).body, { ok: true }, 'an RSVP')
  t.is((await vote({ writer: W, seq: topic.body.seq }, 0, 'no poll')).body.error, 'nao-encontrado', 'a topic with no poll takes no vote')
  const afterVotes = await pageLog(length + 3)
  t.is(afterVotes.length, length + 3, 'vote, withdrawal and RSVP: three blocks, the repeat none')
  t.alike(afterVotes.slice(-3).map((e) => [e.record.type, e.record.pick]), [['group-choice', 1], ['group-choice', null], ['group-choice', 0]])
  length = afterVotes.length

  // ---- hides --------------------------------------------------------------
  const hide = (tgt, on, name) => settled(bia, 'group-hide', P, { group: G, target: tgt, on }, name)
  t.is((await hide(target, true, 'hide theirs')).body.error, 'sem-permissao', 'never another diary\'s post')
  t.alike((await hide({ writer: W, seq: fwd.body.seq }, true, 'hide own')).body, { ok: true }, 'its own post')
  row = (await readAsPage()).items.find((x) => x.writer === W && x.seq === fwd.body.seq)
  t.is(row.hidden, true, 'the own post is hidden')
  t.is((await settled(bia, 'group-react', P, { group: G, target: { writer: W, seq: fwd.body.seq }, emoji: '👍' }, 'react hidden')).body.error, 'nao-encontrado', 'no reaction on a hidden post')

  // ---- same-statement resends: one answer, no second block ---------------
  const send = (action, body) => api('/account/pages/' + action, body)
  const pollBody = await signed(bia, 'group-post', P, { group: G, text: 'Café ou chá?', topic: true, poll: ['Café', 'Chá'] })
  const sent = await send('group-post', pollBody)
  t.is(sent.status, 200, 'a topic with a poll: ' + JSON.stringify(sent.body))
  const again = await send('group-post', pollBody)
  t.is(again.body.seq, sent.body.seq, 'the resend answers the same seq')
  const root2 = { writer: W, seq: sent.body.seq }
  let L = sent.body.seq + 3
  t.is((await pageLog(L)).length, L, 'post, topic and poll once')
  for (const [action, op] of [
    ['group-react', { group: G, target, emoji: '👍' }],
    ['group-choice', { group: G, target: root2, pick: 0 }],
    ['group-hide', { group: G, target: root2, on: true }]
  ]) {
    const body = await signed(bia, action, P, op)
    t.alike((await send(action, body)).body, { ok: true }, action)
    t.alike((await send(action, body)).body, { ok: true }, action + ' resent')
    L++
    t.is((await pageLog(L)).length, L, action + ': one block for the two sends')
  }
  t.alike((await hide(root2, true, 'hide again')).body, { ok: true }, 'a hide the page already holds')
  t.alike((await hide(root2, false, 'unhide')).body, { ok: true }, 'an unhide')
  L++
  t.is((await pageLog(L)).length, L, 'the repeated hide wrote nothing, the unhide one block')
  t.alike((await hide(root2, false, 'unhide again')).body, { ok: true }, 'an unhide the page already holds')
  t.alike((await readAsPage()).items.find((x) => x.writer === W && x.seq === root2.seq).hidden, false, 'the root shows again')
  const threadReply = await post({ text: 'Café!', replyTo: root2 }, 'thread reply')
  t.is(threadReply.status, 200)
  L++
  t.is((await pageLog(L)).length, L, 'the unhide again wrote nothing')

  // ---- forum reads ----------------------------------------------------------
  const read = (action, op, name) => settled(bia, action, P, { group: G, ...op }, name)
  const topics = await read('group-topics', {}, 'topics')
  t.is(topics.status, 200, JSON.stringify(topics.body).slice(0, 300))
  const t2 = topics.body.items.find((x) => x.writer === W && x.seq === root2.seq)
  t.alike(t2.poll, { options: ['Café', 'Chá'], totals: [1, 0], mine: 0 }, 'the topic lists the poll with the page\'s pick')
  t.is(t2.replies, 1, 'and its replies')
  t.is(topics.body.items[0].seq, root2.seq, 'newest topic first')
  t.ok(topics.body.items.some((x) => x.writer === W && x.seq === topic.body.seq && x.poll === null), 'a topic without a poll')
  t.absent(JSON.stringify(topics.body).includes('"by"'), 'never a voter list')
  t.is((await read('group-topics', { limit: 1 }, 'topics page')).body.items.length, 1, 'a limit')
  t.is((await act(bia, 'group-topics', P, { group: G, limit: 31 })).body.error, 'pedido-invalido', 'at most GROUP_TOPICS_LIMIT')
  const voters = await read('group-voters', { target: root2 }, 'voters')
  t.alike(voters.body, { voters: [{ pick: 0, count: 1, by: [P] }, { pick: 1, count: 0, by: [] }] }, 'who voted, the page included')
  t.is((await read('group-voters', { target: { writer: W, seq: topic.body.seq } }, 'voters none')).body.error, 'nao-encontrado', 'a topic without a poll has no voters')
  const events = await read('group-events', {}, 'events')
  t.is(events.status, 200, 'events: ' + JSON.stringify(events.body).slice(0, 300))
  const ev = events.body.items.find((x) => x.writer === W && x.seq === event.body.seq)
  t.alike(ev.event, { title: 'Feira', start: '2030-01-01T10:00:00.000Z', end: null, place: 'Praça' }, 'the event')
  t.alike([ev.totals, ev.mine], [[1, 0], 0], 'with the page\'s RSVP')
  t.alike((await read('group-voters', { target: { writer: W, seq: event.body.seq } }, 'rsvps')).body.voters[0].by, [P], 'who answered the event')
  const thread = await read('group-read', { topic: root2 }, 'thread')
  t.alike(thread.body.items.map((x) => x.seq), [threadReply.body.seq, root2.seq], 'the thread, the reply and its root')
  t.alike(thread.body.items[1].topic, { writer: W, seq: root2.seq, poll: true }, 'each row with the topic mark')
  t.alike(thread.body.poll, { options: ['Café', 'Chá'], totals: [1, 0], mine: 0 }, 'the root\'s poll with the page\'s pick')
  t.is(thread.body.event, null)
  t.is((await read('group-read', { topic: { writer: W, seq: event.body.seq } }, 'event alone')).body.error, 'nao-encontrado', 'an event without a topic mark has no thread')
  const evTopic = await post({ text: 'Mutirão', topic: true, event: { title: 'Mutirão', start: '2030-02-01T10:00:00.000Z' } }, 'event topic')
  t.is(evTopic.status, 200, 'a topic with an event: ' + JSON.stringify(evTopic.body))
  t.alike((await vote({ writer: W, seq: evTopic.body.seq }, 1, 'rsvp maybe')).body, { ok: true })
  const evThread = await read('group-read', { topic: { writer: W, seq: evTopic.body.seq } }, 'event thread')
  t.alike(evThread.body.event, { writer: W, seq: evTopic.body.seq, title: 'Mutirão', start: '2030-02-01T10:00:00.000Z', end: null, place: '', totals: [0, 1], mine: 1 }, 'an event topic answers its event with the page\'s RSVP')
  t.is(evThread.body.poll, null)
  t.is((await read('group-read', { topic: { writer: G, seq: theirs.seq } }, 'not a topic')).body.error, 'nao-encontrado', 'a post that is no topic')
  t.is((await act(bia, 'group-read', P, { group: G, topic: root2, limit: 25 })).body.error, 'pedido-invalido', 'a thread page is at most GROUP_MARKED_LIMIT')
  const chat = await readAsPage()
  t.alike(chat.items.find((x) => x.seq === threadReply.body.seq && x.writer === W).topic, { writer: W, seq: root2.seq, poll: true }, 'the chat rows carry the topic mark')
  t.is(chat.items.find((x) => x.writer === G && x.seq === theirs.seq).topic, null, 'a post outside a topic has none')
  t.absent(JSON.stringify(chat).includes('"by"'), 'nor any voter list')
  for (const [action, op] of [['group-topics', {}], ['group-voters', { target: { writer: GP, seq: 1 } }], ['group-events', {}], ['group-read', { topic: { writer: GP, seq: 1 } }]]) {
    t.is((await settled(bia, action, P, { group: GP, ...op }, action + ' private read')).body.error, 'privado', action + ' in a private group')
    t.is((await act(cai, action, P, { group: G, ...op })).body.error, 'sem-permissao', action + ' by someone who is not on the page')
  }

  // ---- refusals -----------------------------------------------------------
  const ops = {
    'group-post': { group: GP, text: 'em claro' },
    'group-react': { group: GP, target: { writer: GP, seq: 1 }, emoji: '👍' },
    'group-hide': { group: GP, target: { writer: W, seq: 1 }, on: true },
    'group-choice': { group: GP, target: { writer: GP, seq: 1 }, pick: 0 }
  }
  for (const [action, op] of Object.entries(ops)) {
    t.is((await settled(bia, action, P, op, action + ' private')).body.error, 'privado', action + ' in a private group')
    t.is((await act(cai, action, P, { ...op, group: G })).body.error, 'sem-permissao', action + ' by someone who is not on the page')
  }

  // ---- after leaving: the author still hides its own post -----------------
  t.is((await settled(bia, 'group-leave', P, { group: G }, 'leave')).body.state, 'left')
  t.is((await act(bia, 'group-post', P, { group: G, text: 'saí' })).body.error, 'sem-permissao', 'no post after leaving')
  const late = await hide({ writer: W, seq: withGif.body.seq }, true, 'hide after leaving')
  t.alike(late.body, { ok: true }, 'a hide after leaving: ' + JSON.stringify(late.body))

  // ---- a second writer: the page's latest hide is the one that counts -------
  // Hidden on W, then, after a rejoin as W2, unhidden once on W2: a second
  // unhide writes nothing, though W's last mark still says hidden.
  t.is((await settled(bia, 'group-join', P, { group: G, community: C }, 'rejoin')).body.state, 'member', 'the page joins again')
  const W2 = pg.writersOf(P).find((r) => r.group === G && r.writer !== W).writer
  const gifRef = { writer: W, seq: withGif.body.seq }
  const unhide = (name) => until(async () => {
    const r = await act(bia, 'group-hide', P, { group: G, target: gifRef, on: false })
    return r.body && (r.body.error === 'indisponivel' || r.body.error === 'limite') ? null : r
  }, { name, timeoutMs: 120000, intervalMs: 500 })
  const hidesOn = (entries) => entries.filter((e) => e.record && e.record.type === 'group-hide').length
  t.alike((await unhide('unhide on W2')).body, { ok: true }, 'an unhide on the new writer')
  const w2Log = await pageLog(0, W2, (entries) => hidesOn(entries) >= 1)
  t.is(hidesOn(w2Log), 1, 'one hide block on W2')
  t.is((await readAsPage()).items.find((x) => x.writer === W && x.seq === withGif.body.seq).hidden, false, 'the post shows again')
  t.alike((await unhide('unhide again on W2')).body, { ok: true }, 'the same unhide again')
  t.is(hidesOn(await pageLog(w2Log.length, W2)), 1, 'the second unhide wrote nothing')

  // ---- a restart: a captured idempotent write is not run again -------------
  {
    const reactOp = { group: G, target, emoji: '👍' }
    const body = await signed(bia, 'group-react', P, reactOp)
    t.is((await api('/account/pages/group-react', body)).status, 200, 'the react answers')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    // Routes start over the same stores, as after a restart.
    const again = createAccountServer({
      association,
      origin: ORIGIN,
      google: googleStub(),
      store: accounts,
      issuer: { keyPair: issuerKp, cert: issuerCert },
      terms,
      log,
      ratePerSecond: 1000,
      burst: 5000,
      pages: { keys, writer, pagesStore, dir, pagesGroups: pg, blocklist: { has: () => false }, limits: { reboxEveryMs: 0, ops: () => true, media: () => true } }
    })
    const server2 = await again.listen({ host: '127.0.0.1', port: 0 })
    t.teardown(() => server2.close(), { force: true })
    const post2 = async (action, b) => {
      const res = await fetch('http://127.0.0.1:' + server2.port + '/account/pages/' + action, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(b) })
      return res.json()
    }
    t.is((await post2('group-react', body)).error, 'expirado', 'a react minted before the restart is refused')
    const startRes = await fetch('http://127.0.0.1:' + server2.port + '/account/pages/start', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ member: bia.hex, action: 'group-react' }) })
    const { nonce } = await startRes.json()
    const fresh = await post2('group-react', { member: bia.hex, nonce, page: P, op: reactOp, signature: sign(bia, 'group-react', nonce, P, reactOp) })
    t.alike(fresh, { ok: true }, 'a fresh react answers: ' + JSON.stringify(fresh))
  }

  // ---- a closed page --------------------------------------------------------
  {
    const { nonce } = await start(ana, 'close')
    const f = { page: P, gen: pagesStore.get(P).gen + 1, at: new Date().toISOString(), nonce, actor: ana.hex, association }
    const closed = await api('/account/pages/close', { member: ana.hex, nonce, page: P, record: { type: 'page-close', ...f, signature: signClose(f, ana.kp) } })
    t.is(closed.status, 200, 'close: ' + JSON.stringify(closed.body))
  }
  for (const [action, op] of [
    ['group-post', { group: G, text: 'fechada' }],
    ['group-react', { group: G, target, emoji: '👍' }],
    ['group-hide', { group: G, target: root2, on: true }],
    ['group-choice', { group: G, target: root2, pick: 1 }],
    ['group-topics', { group: G }],
    ['group-voters', { group: G, target: root2 }],
    ['group-events', { group: G }],
    ['group-read', { group: G, topic: root2 }]
  ]) {
    t.is((await act(ana, action, P, op)).body.error, 'encerrada', action + ' on a closed page')
  }
})
