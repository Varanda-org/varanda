'use strict'

// The account-side verified post reader (apps/cli/lib/account/ai/read-post.js)
// against a local http fixture server serving real blocks (real association,
// real member certificates, real records), plus one round trip through the
// REAL seeder route of startSeedWs over a stub seeder. No model, no DHT.
const test = require('brittle')
const http = require('node:http')
const net = require('node:net')
const b4a = require('b4a')
const { createCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, postRecord, postEditRecord, profileRecord } = require('@varanda/core/lib/records')
const { digest } = require('@varanda/core/lib/report')
const { startSeedWs } = require('../lib/seed-ws')
const { createPostReader, MAX_BODY } = require('../lib/account/ai/read-post')
const { judge } = require('../lib/account/ai/triage')

const TOKEN = 'c3'.repeat(32)
const AT = '2026-03-01T12:00:00.000Z'
const DESC = { core: 'dd'.repeat(32), mime: 'image/png', start: 1, blocks: 1, bytes: 10, sha256: 'ee'.repeat(32), width: 4, height: 4 }

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function randomKey () {
  return hex(generateAssociationKeyPair().publicKey)
}

function block (record) {
  return Buffer.from(JSON.stringify(record), 'utf8')
}

function body (block0, blk, over = {}) {
  return JSON.stringify({ v: 2, fork: 0, length: 3, block0: block0.toString('base64'), block: blk.toString('base64'), edit: null, ...over })
}

function editOf (seq, record) {
  return { seq, block: block(record).toString('base64') }
}

// A fixture server: `handler(req, res)` is swapped per case; every request
// is recorded (path and authorization header).
async function fixture (t) {
  const state = { handler: (req, res) => res.writeHead(404).end(), requests: [] }
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    state.requests.push({ url: req.url, auth: req.headers.authorization })
    state.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  state.baseUrl = 'http://127.0.0.1:' + server.address().port
  return state
}

function serveJson (text) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }
}

test('read: a verified post, media, quote, and the request it sends', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })

  const text = '  olá varanda 👋\nsegunda linha '
  fx.handler = serveJson(body(b0, block(postRecord({ text, at: AT }))))
  const r = await reader.read({ diaryKey: key, seq: 2 })
  t.alike(r, { ok: true, text, hasMedia: false, hasQuote: false, hasPoll: false, textCp: Array.from(text).length, contentHash: digest(text), seq: 2 })
  t.is(r.textCp, 30, 'code points, not UTF-16 units')
  t.is(text.length, 31)
  t.is(fx.requests[0].url, '/moderation-post/' + key + '/2')
  t.is(fx.requests[0].auth, 'Bearer ' + TOKEN)

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'com foto', at: AT, media: [DESC] }))))
  const m = await reader.read({ diaryKey: key, seq: 2 })
  t.is(m.ok, true)
  t.is(m.hasMedia, true)
  t.is(m.hasQuote, false)
  t.is(m.text, 'com foto')
  t.alike(Object.keys(m).sort(), ['contentHash', 'hasMedia', 'hasPoll', 'hasQuote', 'ok', 'seq', 'text', 'textCp'], 'only the text, never the descriptors')

  fx.handler = serveJson(body(b0, block(postRecord({ text: '', at: AT, media: [DESC] }))))
  const photo = await reader.read({ diaryKey: key, seq: 2 })
  t.alike([photo.ok, photo.text, photo.textCp, photo.hasMedia, photo.contentHash], [true, '', 0, true, digest('')], 'a photo-only post')

  const poster = { ...DESC, mime: 'image/jpeg' }
  const video = { ...DESC, mime: 'video/mp4', start: 2, ms: 3000 }
  for (const text of ['com vídeo', '']) {
    fx.handler = serveJson(body(b0, block(postRecord({ text, at: AT, media: [poster, video] }))))
    const v = await reader.read({ diaryKey: key, seq: 2 })
    t.alike(v, { ok: true, text, hasMedia: true, hasQuote: false, hasPoll: false, textCp: Array.from(text).length, contentHash: digest(text), seq: 2 }, 'a video pair is media, with or without a caption')
    t.alike(judge({ ...v, kind: 'post', reason: 'spam', priorAi: false, truncated: false }), { action: 'aberta', code: 'midia', note: '', nearest: null }, 'the verified video post stays open for a person')
  }

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'citando', at: AT, quote: { author: randomKey(), seq: 4 } }))))
  const q = await reader.read({ diaryKey: key, seq: 2 })
  t.is(q.ok, true)
  t.is(q.hasQuote, true)
  t.is(q.hasMedia, false)
  t.is(q.text, 'citando')
  t.is(q.hasPoll, false)
})

test('read: a poll post is read with its options as part of the text and never judged alone', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'Qual a melhor praia?', at: AT, poll: ['Leblon', 'Ipanema', 'Barra'] }))))
  const r = await reader.read({ diaryKey: key, seq: 2 })
  const text = 'Qual a melhor praia?\nLeblon\nIpanema\nBarra'
  t.alike(r, { ok: true, text, hasMedia: false, hasQuote: false, hasPoll: true, textCp: Array.from(text).length, contentHash: digest(text), seq: 2 })
  t.not(r.contentHash, digest('Qual a melhor praia?'), 'the options are part of the hash')
  t.alike(judge({ ...r, kind: 'post', reason: 'spam', priorAi: false, truncated: false }), { action: 'aberta', code: 'enquete', note: '', nearest: null }, 'the verified poll post stays open for a person')

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'Sem opcoes', at: AT }))))
  t.is((await reader.read({ diaryKey: key, seq: 2 })).hasPoll, false)
})

test('read: an event post is read with its title and place as part of the text and never judged alone', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })
  const event = { title: 'Mutirão da horta', start: '2030-05-01T12:00:00.000Z', end: null, place: 'Praça Central' }

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'Venha!', at: AT, event }))))
  const r = await reader.read({ diaryKey: key, seq: 2 })
  const text = 'Venha!\nMutirão da horta\nPraça Central'
  t.alike(r, { ok: true, text, hasMedia: false, hasQuote: false, hasPoll: true, textCp: Array.from(text).length, contentHash: digest(text), seq: 2 })
  t.alike(judge({ ...r, kind: 'post', reason: 'spam', priorAi: false, truncated: false }), { action: 'aberta', code: 'enquete', note: '', nearest: null }, 'the verified event post stays open for a person')

  fx.handler = serveJson(body(b0, block(postRecord({ text: 'Venha!', at: AT, event: { ...event, place: '' } }))))
  t.is((await reader.read({ diaryKey: key, seq: 2 })).text, 'Venha!\nMutirão da horta', 'no place: the title alone')
})

test('read: an edited post is read as readers see it, with the text as first written', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })
  const read = () => reader.read({ diaryKey: key, seq: 2 })
  const post = block(postRecord({ text: 'texto original', at: AT }))
  const length = { length: 5 }

  fx.handler = serveJson(body(b0, post, { ...length, edit: editOf(4, postEditRecord({ seq: 2, text: 'texto novo', at: AT })) }))
  const r = await read()
  t.alike(r, { ok: true, text: 'texto novo', hasMedia: false, hasQuote: false, hasPoll: false, textCp: 10, contentHash: digest('texto novo'), seq: 2, edited: true, original: 'texto original' })
  t.alike(judge({ ...r, edited: r.edited === true, kind: 'post', reason: 'spam', priorAi: false, truncated: false }), { action: 'aberta', code: 'editada', note: '', nearest: null }, 'the verified edited post stays open for a person')

  fx.handler = serveJson(body(b0, post, { ...length, edit: { seq: null, block: null } }))
  t.alike(await read(), { ok: false, code: 'edicao-incerta' }, 'an edit the seeder could not read is never read as unedited')
  fx.handler = serveJson(body(b0, post, { ...length, edit: editOf(4, postEditRecord({ seq: 2, text: '', at: AT })) }))
  t.alike(await read(), { ok: false, code: 'edicao-incerta' }, 'the newest edit does not apply: an older one might')
  fx.handler = serveJson(body(b0, post, { ...length, edit: editOf(4, postEditRecord({ seq: 1, text: 'outro', at: AT })) }))
  t.alike(await read(), { ok: false, code: 'recusado' }, 'an edit of another post')
  fx.handler = serveJson(body(b0, post, { ...length, edit: editOf(4, postRecord({ text: 'não é edição', at: AT })) }))
  t.alike(await read(), { ok: false, code: 'recusado' }, 'a block that is no edit')
  fx.handler = serveJson(body(b0, block(postRecord({ text: 'oi \uD800', at: AT })), { ...length, edit: editOf(4, postEditRecord({ seq: 2, text: 'oi', at: AT })) }))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'an ill-formed original')

  // A poll or an event admits no edit: every reader shows it as written.
  const poll = block(postRecord({ text: 'Qual?', at: AT, poll: ['Sim', 'Não'] }))
  for (const edit of [editOf(4, postEditRecord({ seq: 2, text: 'trocado', at: AT })), { seq: null, block: null }]) {
    fx.handler = serveJson(body(b0, poll, { ...length, edit }))
    t.alike(await read(), { ok: true, text: 'Qual?\nSim\nNão', hasMedia: false, hasQuote: false, hasPoll: true, textCp: 13, contentHash: digest('Qual?\nSim\nNão'), seq: 2 }, 'a poll reads as written')
  }

  // A media post keeps its media and takes the new caption.
  fx.handler = serveJson(body(b0, block(postRecord({ text: 'legenda', at: AT, media: [DESC] })), { ...length, edit: editOf(3, postEditRecord({ seq: 2, text: '', at: AT })) }))
  const m = await read()
  t.alike([m.ok, m.text, m.hasMedia, m.edited, m.original], [true, '', true, true, 'legenda'])
})

test('read: wrong type, bad certificate and revoked issuer never return ok', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const post = block(postRecord({ text: 'oi', at: AT }))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })
  const read = () => reader.read({ diaryKey: key, seq: 2 })

  fx.handler = serveJson(body(b0, block(profileRecord({ name: 'Ana', at: AT }))))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'a profile')
  fx.handler = serveJson(body(b0, b0))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'a member-cert at seq')
  fx.handler = serveJson(body(b0, Buffer.from('{"type":"post","text":"x"}')))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'a malformed post')
  fx.handler = serveJson(body(b0, Buffer.from('not json')))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'not JSON')

  // A certificate from another association, for another key, or tampered.
  const other = makeAssociation()
  fx.handler = serveJson(body(block(memberCertRecord(createCert({ member: key }, other.kp))), post))
  t.alike(await read(), { ok: false, code: 'certificado' }, 'untrusted association')
  fx.handler = serveJson(body(block(memberCertRecord(createCert({ member: randomKey() }, assoc.kp))), post))
  t.alike(await read(), { ok: false, code: 'certificado' }, 'member mismatch')
  const forged = createCert({ member: key }, assoc.kp)
  forged.ageBand = forged.ageBand === '18+' ? '16-17' : '18+'
  fx.handler = serveJson(body(Buffer.from(JSON.stringify({ type: 'member-cert', cert: forged })), post))
  t.alike(await read(), { ok: false, code: 'certificado' }, 'bad signature')
  fx.handler = serveJson(body(post, post))
  t.alike(await read(), { ok: false, code: 'certificado' }, 'block 0 not a certificate')

  // A v2 certificate whose issuer the blocklist revoked.
  const issuerKp = generateAssociationKeyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const v2 = block(memberCertRecord(createIssuedCert({ member: key }, issuerKp, issuerCert)))
  fx.handler = serveJson(body(v2, post))
  t.is((await read()).ok, true, 'v2 certificate, issuer not revoked')
  let revoked = new Set([hex(issuerKp.publicKey)])
  const strict = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex, revokedIssuers: () => revoked })
  t.alike(await strict.read({ diaryKey: key, seq: 2 }), { ok: false, code: 'certificado' }, 'revoked issuer')
  revoked = new Set()
  t.is((await strict.read({ diaryKey: key, seq: 2 })).ok, true, 'the snapshot is read on every call')
  const throwing = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex, revokedIssuers: () => { throw new Error('x') } })
  t.alike(await throwing.read({ diaryKey: key, seq: 2 }), { ok: false, code: 'certificado' }, 'a throwing snapshot fails closed')
  // A getter that returns the snapshot's raw array (or nothing) instead of a
  // Set must not mean "nothing revoked".
  for (const bad of [[hex(issuerKp.publicKey)], null, undefined, 'x']) {
    const r = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex, revokedIssuers: () => bad })
    t.alike(await r.read({ diaryKey: key, seq: 2 }), { ok: false, code: 'certificado' }, 'non-Set revocations fail closed: ' + String(bad))
  }

  // A post whose text has a lone surrogate (records.js accepts it) is not
  // returned: its UTF-8 digest would collide with the U+FFFD text.
  fx.handler = serveJson(body(b0, block(postRecord({ text: 'oi \uD800', at: AT }))))
  t.alike(await read(), { ok: false, code: 'nao-e-publicacao' }, 'ill-formed text')
})

test('read: refused, absent and malformed answers', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const post = block(postRecord({ text: 'oi', at: AT }))
  const fx = await fixture(t)
  const reader = createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: assoc.hex })
  const read = () => reader.read({ diaryKey: key, seq: 2 })
  const recusado = { ok: false, code: 'recusado' }

  fx.handler = (req, res) => res.writeHead(404).end('não encontrado\n')
  t.alike(await read(), { ok: false, code: 'ausente' })
  fx.handler = (req, res) => res.writeHead(503).end()
  t.alike(await read(), recusado, '503')
  fx.handler = (req, res) => res.writeHead(302, { location: '/moderation-post/' + key + '/3' }).end()
  t.alike(await read(), recusado, 'a redirect')
  t.is(fx.requests.filter((r) => r.url.endsWith('/3')).length, 0, 'the redirect is never followed')

  for (const [over, label] of [
    [{ fork: 1 }, 'fork 1'],
    [{ v: 1 }, 'v 1 (a seeder from before edits)'],
    [{ edit: undefined }, 'no edit key'],
    [{ edit: 'x' }, 'edit not an object'],
    [{ edit: { seq: 2 } }, 'edit without block'],
    [{ edit: { seq: null, block: null, extra: 1 } }, 'edit with an extra key'],
    [{ edit: { seq: null, block: 'eA==' } }, 'unknown edit with a block'],
    [{ edit: { seq: 2, block: 'eA==' } }, 'edit not above the post'],
    [{ edit: { seq: 3, block: 'eA==' } }, 'edit not below the length'],
    [{ length: 4, edit: { seq: 3, block: 'not base64!' } }, 'edit block bad base64'],
    [{ length: 4, edit: { seq: 3.5, block: 'eA==' } }, 'edit seq not an integer'],
    [{ length: 2 }, 'length not beyond seq'],
    [{ length: 3.5 }, 'length not an integer'],
    [{ extra: true }, 'an extra key'],
    [{ block: 'not base64!' }, 'bad base64'],
    [{ block0: 42 }, 'block0 not a string']
  ]) {
    fx.handler = serveJson(body(b0, post, over))
    t.alike(await read(), recusado, label)
  }
  fx.handler = serveJson(JSON.stringify({ v: 2, fork: 0, length: 3, block0: b0.toString('base64'), edit: null }))
  t.alike(await read(), recusado, 'a missing key')
  fx.handler = serveJson('{')
  t.alike(await read(), recusado, 'malformed JSON')
  fx.handler = serveJson('[]')
  t.alike(await read(), recusado, 'not an object')

  // 2 MB, streamed without a length, and declared up front.
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61)
  fx.handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(big.subarray(0, 1024 * 1024))
    res.end(big.subarray(1024 * 1024))
  }
  t.alike(await read(), recusado, 'a 2 MB streamed body')
  fx.handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': big.byteLength })
    res.end(big)
  }
  t.alike(await read(), recusado, 'a 2 MB declared body')
  fx.handler = serveJson(body(b0, post) + ' '.repeat(MAX_BODY))
  t.alike(await read(), recusado, 'one byte beyond the cap')
})

test('read: a black-hole port is timeout, a closed port is recusado', async (t) => {
  const sockets = new Set()
  const hole = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
  })
  await new Promise((resolve) => hole.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy()
    hole.close(resolve)
  }))
  const reader = createPostReader({ baseUrl: 'http://127.0.0.1:' + hole.address().port, token: TOKEN, association: makeAssociation().hex, timeoutMs: 300 })
  const started = Date.now()
  t.alike(await reader.read({ diaryKey: randomKey(), seq: 1 }), { ok: false, code: 'timeout' })
  t.ok(Date.now() - started < 5000, 'bounded by timeoutMs')

  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const closed = createPostReader({ baseUrl: 'http://127.0.0.1:' + port, token: TOKEN, association: makeAssociation().hex })
  t.alike(await closed.read({ diaryKey: randomKey(), seq: 1 }), { ok: false, code: 'recusado' })
})

test('read: configuration and arguments', async (t) => {
  const fx = await fixture(t)
  const assoc = makeAssociation().hex
  const key = randomKey()
  const config = { ok: false, code: 'config' }
  for (const baseUrl of [
    'http://example.com', 'http://example.com:80', 'https://127.0.0.1:1', 'http://127.0.0.1',
    'http://127.0.0.1:1/x', 'http://127.0.0.2:1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://user@127.0.0.1:1', 'http://[::1]', 42, undefined
  ]) {
    t.alike(await createPostReader({ baseUrl, token: TOKEN, association: assoc }).read({ diaryKey: key, seq: 1 }), config, 'baseUrl ' + String(baseUrl))
  }
  for (const token of ['C3'.repeat(32), 'c3'.repeat(31), '', null]) {
    t.alike(await createPostReader({ baseUrl: fx.baseUrl, token, association: assoc }).read({ diaryKey: key, seq: 1 }), config, 'token')
  }
  t.alike(await createPostReader({ baseUrl: fx.baseUrl, token: TOKEN, association: 'x' }).read({ diaryKey: key, seq: 1 }), config, 'association')
  t.alike(await createPostReader().read({ diaryKey: key, seq: 1 }), config, 'no options')

  const reader = createPostReader({ baseUrl: fx.baseUrl + '/', token: TOKEN, association: assoc })
  for (const args of [
    { diaryKey: key.toUpperCase(), seq: 1 }, { diaryKey: key.slice(2), seq: 1 }, { diaryKey: 42, seq: 1 },
    { diaryKey: key, seq: 0 }, { diaryKey: key, seq: 1.5 }, { diaryKey: key, seq: '1' }, { diaryKey: key, seq: -1 }, undefined, null, 'x'
  ]) {
    t.alike(await reader.read(args), config, 'args ' + JSON.stringify(args))
  }
  t.is(fx.requests.length, 0, 'nothing is requested on a config error')
  // localhost and [::1] are accepted (a trailing '/' is tolerated).
  t.alike(await reader.read({ diaryKey: key, seq: 1 }), { ok: false, code: 'ausente' })
  const local = createPostReader({ baseUrl: fx.baseUrl.replace('127.0.0.1', 'localhost'), token: TOKEN, association: assoc })
  t.not((await local.read({ diaryKey: key, seq: 1 })).code, 'config', 'localhost')
  const v6 = createPostReader({ baseUrl: 'http://[::1]:1', token: TOKEN, association: assoc, timeoutMs: 500 })
  t.not((await v6.read({ diaryKey: key, seq: 1 })).code, 'config', '[::1]')
})

test('read: through the real seeder route (startSeedWs + a stub seeder)', async (t) => {
  const assoc = makeAssociation()
  const key = randomKey()
  const b0 = block(memberCertRecord(createCert({ member: key }, assoc.kp)))
  const blocks = { 2: block(postRecord({ text: 'olá varanda', at: AT })), 3: block(profileRecord({ name: 'Ana', at: AT })), 4: block(postRecord({ text: 'antes', at: AT })) }
  const edits = { 4: { seq: 5, block: block(postEditRecord({ seq: 4, text: 'depois', at: AT })) } }
  const seeder = {
    stats: () => ({ status: 'ok' }),
    moderationPost: async (diary, seq) => diary === key && blocks[seq] ? { fork: 0, length: 6, block0: b0, block: blocks[seq], edit: edits[seq] || null } : null
  }
  const ws = await startSeedWs({ port: 0, seeder, triageToken: TOKEN, post: { rate: 1000, burst: 1000 } })
  t.teardown(() => ws.close(), { force: true })
  const baseUrl = 'http://127.0.0.1:' + ws.port
  const reader = createPostReader({ baseUrl, token: TOKEN, association: assoc.hex })

  const r = await reader.read({ diaryKey: key, seq: 2 })
  t.alike(r, { ok: true, text: 'olá varanda', hasMedia: false, hasQuote: false, hasPoll: false, textCp: 11, contentHash: digest('olá varanda'), seq: 2 })
  t.alike(await reader.read({ diaryKey: key, seq: 3 }), { ok: false, code: 'nao-e-publicacao' })
  t.alike(await reader.read({ diaryKey: key, seq: 4 }), { ok: true, text: 'depois', hasMedia: false, hasQuote: false, hasPoll: false, textCp: 6, contentHash: digest('depois'), seq: 4, edited: true, original: 'antes' }, 'an edit travels through the route')
  t.alike(await reader.read({ diaryKey: key, seq: 6 }), { ok: false, code: 'ausente' })
  const wrongToken = createPostReader({ baseUrl, token: 'd4'.repeat(32), association: assoc.hex })
  t.alike(await wrongToken.read({ diaryKey: key, seq: 2 }), { ok: false, code: 'ausente' }, 'a wrong token is the generic 404')
})
