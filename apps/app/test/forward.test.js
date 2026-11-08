'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/forward.js')
const loadRpc = async () => (await import('@varanda/rpc')).default

const AUTHOR = '1'.repeat(64)
const PEER = '3'.repeat(64)
const GROUP = '4'.repeat(64)
const CORE = '5'.repeat(64)
const SHA = '6'.repeat(64)
const BLOB_KEY = '7'.repeat(64)
const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function dmItem (n = 1, mime = 'image/jpeg') {
  const voice = mime === 'audio/mp4'
  return { id: n.toString(16).padStart(64, '0'), key: BLOB_KEY, nonce: 'c'.repeat(48), chunks: 1, bytes: 144, sha256: SHA, mime, w: voice ? 0 : 32, h: voice ? 0 : 24, ms: voice ? 3000 : 0 }
}

function publicItem (n = 1) {
  return { core: CORE, mime: 'image/png', start: n, blocks: 1, bytes: 100, sha256: SHA, width: 40, height: 30 }
}

function privateItem (n = 1) {
  return { core: CORE, mime: 'application/octet-stream', start: n, blocks: 1, bytes: 32768, sha256: SHA, key: BLOB_KEY, nonce: 'd'.repeat(48), plainMime: 'image/webp', plainSha256: SHA, w: 50, h: 60, ms: 0 }
}

const dmSource = (extra = {}) => ({ kind: 'dm', author: AUTHOR, at: NOW - HOUR, text: 'olá', media: [dmItem()], replyTo: 'e'.repeat(32), ...extra })
const publicSource = (extra = {}) => ({ kind: 'group', visibility: 'public', author: AUTHOR, at: NOW - 30 * DAY, text: 'público', media: [publicItem()], replyTo: { diary: AUTHOR, seq: 3 }, ...extra })
const privateSource = (extra = {}) => ({ kind: 'group', visibility: 'private', author: AUTHOR, at: NOW - 30 * DAY, text: 'segredo', media: [privateItem()], ...extra })
const postSource = (extra = {}) => ({ kind: 'post', author: AUTHOR, at: NOW - 30 * DAY, text: 'post', media: [publicItem()], ...extra })

const toDm = { kind: 'dm', to: PEER }
const toPublic = { kind: 'group', group: GROUP, visibility: 'public' }
const toPrivate = { kind: 'group', group: GROUP, visibility: 'private' }

const voiceSource = (kind) => {
  if (kind === 'dm') return dmSource({ media: [dmItem(1, 'audio/mp4')], text: '' })
  if (kind === 'public') return publicSource({ media: [{ core: CORE, mime: 'audio/mp4', start: 1, blocks: 1, bytes: 100, sha256: SHA, width: 0, height: 0, ms: 4000 }], text: '' })
  return privateSource({ media: [{ ...privateItem(), plainMime: 'audio/mp4', w: 0, h: 0, ms: 5000 }], text: '' })
}

test('every direction re-uploads into the destination, never reuses', async (t) => {
  const { forwardPlan } = await load()
  const cases = [
    [dmSource(), toDm, 'dm.putMedia', { mime: 'image/jpeg', width: 32, height: 24 }],
    [dmSource(), toPrivate, 'media.uploadFile', { mime: 'image/jpeg', width: 32, height: 24, sealed: true }],
    [dmSource(), toPublic, 'media.uploadFile', { mime: 'image/jpeg', width: 32, height: 24 }],
    [publicSource(), toDm, 'dm.putMedia', { mime: 'image/png', width: 40, height: 30 }],
    [publicSource(), toPublic, 'media.uploadFile', { mime: 'image/png', width: 40, height: 30 }],
    [publicSource(), toPrivate, 'media.uploadFile', { mime: 'image/png', width: 40, height: 30, sealed: true }],
    [privateSource(), toDm, 'dm.putMedia', { mime: 'image/webp', width: 50, height: 60 }],
    [privateSource(), toPrivate, 'media.uploadFile', { mime: 'image/webp', width: 50, height: 60, sealed: true }],
    [privateSource(), toPublic, 'media.uploadFile', { mime: 'image/webp', width: 50, height: 60 }],
    [postSource(), toPublic, 'media.uploadFile', { mime: 'image/png', width: 40, height: 30 }]
  ]
  for (const [source, target, method, params] of cases) {
    const r = forwardPlan(source, target)
    t.is(r.ok, true)
    t.alike(r.uploads, [{ index: 0, method, params }], source.kind + ' to ' + target.kind)
    t.absent(JSON.stringify(r).includes('reuse'))
  }
})

test('an old dm source is still planned: no 7-day window', async (t) => {
  const { forwardPlan } = await load()
  const r = forwardPlan(dmSource({ at: NOW - 30 * DAY }), toDm)
  t.is(r.ok, true)
  t.is(r.uploads.length, 1)
  t.absent(r.dropped)
})

test('voice notes re-upload with kind voice and their length, in every direction', async (t) => {
  const { forwardPlan } = await load()
  const want = { dm: 3000, public: 4000, private: 5000 }
  for (const kind of ['dm', 'public', 'private']) {
    const source = voiceSource(kind)
    const dm = forwardPlan(source, toDm)
    t.alike(dm.uploads[0], { index: 0, method: 'dm.putMedia', params: { mime: 'audio/mp4', width: 0, height: 0, ms: want[kind], kind: 'voice' } }, kind + ' to dm')
    const sealed = forwardPlan(source, toPrivate)
    t.alike(sealed.uploads[0].params, { mime: 'audio/mp4', width: 0, height: 0, ms: want[kind], kind: 'voice', sealed: true }, kind + ' to private')
    const open = forwardPlan(source, toPublic)
    t.alike(open.uploads[0].params, { mime: 'audio/mp4', width: 0, height: 0, ms: want[kind], kind: 'voice' }, kind + ' to public')
  }
})

test('text length counts code points, not UTF-16 units', async (t) => {
  const { forwardPlan } = await load()
  const rpc = await loadRpc()
  const atCap = '\u{1F600}'.repeat(rpc.MAX_TEXT)
  t.ok(atCap.length > rpc.MAX_TEXT, 'more units than the cap')
  t.is(forwardPlan(publicSource({ text: atCap, media: [] }), toPublic).ok, true, 'MAX_TEXT code points pass')
  t.alike(forwardPlan(publicSource({ text: atCap + 'a', media: [] }), toPublic), { ok: false, error: 'mensagem longa demais' })
})

test('dm destination: text over the budget fails before any upload', async (t) => {
  const { forwardPlan } = await load()
  const rpc = await loadRpc()
  const { WIDEST_DM_ITEM } = await import('../src/attach-plan.js')
  const budget = rpc.dmTextBudget({ to: PEER, fwd: 1, media: Array(4).fill(WIDEST_DM_ITEM), cert: rpc.MEMBER_CERT_STANDIN })
  // An emoji is one code point and 4 bytes: under MAX_TEXT, over the budget.
  const emoji = '\u{1F600}'
  const text = emoji.repeat(Math.floor(budget / 4) + 1)
  t.ok(Array.from(text).length <= rpc.MAX_TEXT)
  const media = [dmItem(1), dmItem(2), dmItem(3), dmItem(4)]
  t.alike(forwardPlan(dmSource({ text, media }), toDm), { ok: false, error: 'mensagem longa demais' })
  t.is(forwardPlan(dmSource({ text, media }), toPrivate).ok, true, 'a group has no DM budget')
  t.is(forwardPlan(dmSource({ text: emoji.repeat(Math.floor(budget / 4)), media }), toDm).ok, true)
})

test('an item gone before the forward drops, the text still forwards', async (t) => {
  const { forwardPlan, EXPIRED } = await load()
  t.is(EXPIRED, 'A mídia expirou')
  const r = forwardPlan(dmSource({ media: [{ unavailable: true }, dmItem(2)] }), toDm)
  t.is(r.ok, true)
  t.is(r.uploads.length, 1)
  t.is(r.uploads[0].index, 1)
  t.is(r.dropped, 'A mídia expirou')
  t.alike(forwardPlan(dmSource({ text: '', media: [{ unavailable: true }] }), toDm), { ok: false, error: 'A mídia expirou' })
})

test('private media into a public group asks for the audience; nothing else does', async (t) => {
  const { forwardPlan, AUDIENCE_QUESTION } = await load()
  t.is(AUDIENCE_QUESTION, 'Esta mídia era privada. Enviar para um grupo público?')
  t.is(forwardPlan(dmSource(), toPublic).confirm, 'audience')
  t.is(forwardPlan(privateSource(), toPublic).confirm, 'audience')
  t.absent(forwardPlan(dmSource({ media: [] }), toPublic).confirm, 'text only')
  t.absent(forwardPlan(publicSource(), toPublic).confirm)
  t.absent(forwardPlan(postSource(), toPublic).confirm)
  t.absent(forwardPlan(dmSource(), toPrivate).confirm)
  t.absent(forwardPlan(privateSource(), toDm).confirm)
})

test('fwd 1 set, replyTo dropped, nothing names the author', async (t) => {
  const { forwardPlan } = await load()
  const cases = [
    [dmSource(), toDm],
    [dmSource(), toPrivate],
    [publicSource(), toDm],
    [publicSource(), toPublic],
    [privateSource(), toPublic],
    [postSource(), toPrivate]
  ]
  for (const [source, target] of cases) {
    const r = forwardPlan(source, target)
    t.is(r.ok, true)
    t.is(r.fwd, 1)
    t.is(r.text, source.text)
    t.absent('replyTo' in r)
    t.absent('author' in r)
    t.absent(JSON.stringify(r).includes(AUTHOR), 'no author key anywhere')
  }
})

test('text-only forwards with no uploads', async (t) => {
  const { forwardPlan } = await load()
  t.alike(forwardPlan(dmSource({ media: [] }), toPublic), { ok: true, fwd: 1, text: 'olá', uploads: [] })
})

test('inputs that do not fit give ok false, never a throw', async (t) => {
  const { forwardPlan } = await load()
  const bad = [
    [null, toDm],
    [{ ...dmSource(), kind: 'story' }, toDm],
    [{ ...publicSource(), visibility: 'secret' }, toDm],
    [{ ...dmSource(), text: 5 }, toDm],
    [{ ...dmSource(), media: 'x' }, toDm],
    [dmSource({ media: [publicItem()] }), toDm],
    [publicSource({ media: [privateItem()] }), toDm],
    [privateSource({ media: [publicItem()] }), toDm],
    [dmSource({ media: [null] }), toDm],
    [dmSource(), null],
    [dmSource(), { kind: 'feed' }],
    [dmSource(), { kind: 'dm' }],
    [dmSource(), { kind: 'dm', to: 'nope' }],
    [dmSource(), { ...toPublic, visibility: 'friends' }],
    [dmSource({ text: '', media: [] }), toDm]
  ]
  for (const [source, target] of bad) {
    let r
    try {
      r = forwardPlan(source, target)
    } catch (err) {
      t.fail('threw: ' + err.message)
      continue
    }
    t.is(r.ok, false)
    t.is(typeof r.error, 'string')
  }
  const getter = dmSource()
  Object.defineProperty(getter, 'text', { get () { throw new Error('boom') }, enumerable: true })
  t.is(forwardPlan(getter, toDm).ok, false)
})

// runForward drives the I/O through injected calls.
const BYTES = () => new Uint8Array([1, 2, 3])

// Each upload answers a distinct item, as the node does.
function fakeMedia (log) {
  let n = 8
  return {
    putDm: async (args) => { log.push(['putDm', { ...args, bytes: args.bytes.length }]); return dmItem(++n, args.mime) },
    upload: async (args) => { log.push(['upload', { ...args, bytes: args.bytes.length }]); return args.sealed ? privateItem(++n) : publicItem(++n) }
  }
}

// Whether @varanda/rpc validateParams already takes fwd on the send methods
// (the node side of the forwarding change).
async function rpcTakesFwd () {
  const rpc = await loadRpc()
  return rpc.validateParams('group.post', { group: GROUP, text: 'a', fwd: 1 }).ok
}

test('runForward reads the cache first, then the source, then drops', async (t) => {
  const { forwardPlan, runForward } = await load()
  const plan = forwardPlan(publicSource({ media: [publicItem(1), publicItem(2), publicItem(3)] }), toPublic)
  const reads = []
  const log = []
  const sent = []
  const r = await runForward({
    plan,
    target: toPublic,
    readCache: async (i) => { reads.push('cache' + i); return i === 0 ? { bytes: BYTES(), mime: 'image/png', w: 41, h: 31 } : null },
    readSource: async (i) => { reads.push('source' + i); if (i === 2) throw new Error('gone'); return { bytes: BYTES(), mime: 'image/png' } },
    media: fakeMedia(log),
    request: async (method, params) => { sent.push({ method, params }); return {} }
  })
  t.alike(reads, ['cache0', 'cache1', 'source1', 'cache2', 'source2'])
  t.is(r.dropped, 'A mídia expirou')
  if (!(await rpcTakesFwd())) {
    t.comment('waits for fwd in @varanda/rpc validateParams: ' + (r.error && r.error.message))
    return
  }
  t.is(r.phase, 'done')
  t.alike(log, [
    ['upload', { bytes: 3, mime: 'image/png', width: 41, height: 31 }],
    ['upload', { bytes: 3, mime: 'image/png', width: 40, height: 30 }]
  ], 'the measured size wins')
  t.is(sent.length, 1)
  t.is(sent[0].method, 'group.post')
  t.is(sent[0].params.fwd, 1)
  t.is(sent[0].params.media.length, 2)
  t.absent('replyTo' in sent[0].params)
})

test('runForward: nothing read and no text fails with A mídia expirou, no upload, no send', async (t) => {
  const { forwardPlan, runForward } = await load()
  const plan = forwardPlan(dmSource({ text: '' }), toDm)
  const log = []
  let sends = 0
  const r = await runForward({ plan, target: toDm, readCache: async () => null, readSource: async () => null, media: fakeMedia(log), request: async () => { sends++ } })
  t.is(r.phase, 'failed')
  t.is(r.error.message, 'A mídia expirou')
  t.is(log.length, 0)
  t.is(sends, 0)
})

test('runForward voice: dm.putMedia with kind voice and ms, then dm.send with fwd 1', async (t) => {
  const { forwardPlan, runForward } = await load()
  const plan = forwardPlan(voiceSource('private'), toDm)
  const log = []
  const sent = []
  const r = await runForward({
    plan,
    target: toDm,
    readCache: async () => ({ bytes: BYTES(), mime: 'audio/mp4', w: 0, h: 0, ms: 5010 }),
    media: fakeMedia(log),
    request: async (method, params) => { sent.push({ method, params }); return {} }
  })
  if (!(await rpcTakesFwd())) {
    t.comment('waits for fwd in @varanda/rpc validateParams: ' + (r.error && r.error.message))
    return
  }
  t.is(r.phase, 'done')
  t.alike(log, [['putDm', { bytes: 3, mime: 'audio/mp4', width: 0, height: 0, ms: 5010, kind: 'voice', to: PEER }]])
  t.is(sent[0].method, 'dm.send')
  t.is(sent[0].params.fwd, 1)
})

// The audit shape: the first destination's send is uncertain, the sheet goes
// on to the next. Each putDm names its own destination, so the node seals a
// fresh blob per conversation instead of reusing the first one's.
test('runForward passes each destination as to on every dm.putMedia', async (t) => {
  const { forwardPlan, runForward } = await load()
  const OTHER = '5'.repeat(64)
  const log = []
  const media = fakeMedia(log)
  const err = Object.assign(new Error('incerto'), { uncertain: true })
  for (const [to, request] of [[PEER, async () => { throw err }], [OTHER, async () => ({})]]) {
    const target = { kind: 'dm', to }
    const plan = forwardPlan(dmSource({ media: [dmItem(1), dmItem(2)] }), target)
    await runForward({ plan, target, readCache: async () => ({ bytes: BYTES(), mime: 'image/jpeg', w: 32, h: 24 }), media, request })
  }
  t.alike(log.map(([m, args]) => [m, args.to]), [['putDm', PEER], ['putDm', PEER], ['putDm', OTHER], ['putDm', OTHER]])
})

test('runForward uncertain keeps the op and never resends by itself', async (t) => {
  const { forwardPlan, runForward, retryForward } = await load()
  const plan = forwardPlan(publicSource({ media: [] }), toPrivate)
  let sends = 0
  const err = Object.assign(new Error('incerto'), { uncertain: true })
  const r = await runForward({ plan, target: toPrivate, media: fakeMedia([]), request: async () => { sends++; throw err } })
  if (!(await rpcTakesFwd())) {
    t.comment('waits for fwd in @varanda/rpc validateParams: ' + (r.error && r.error.message))
    return
  }
  t.is(r.phase, 'uncertain')
  t.is(sends, 1)
  t.is(r.op.params.fwd, 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(sends, 1, 'no automatic resend')
  const again = await retryForward({ op: r.op, request: async () => { sends++; return {} } })
  t.is(again.phase, 'done')
  t.is(sends, 2, 'one explicit retry, one more send')
})

test('runForward zero-fills every plaintext it read once the forward settles', async (t) => {
  const { forwardPlan, runForward } = await load()
  const plan = forwardPlan(voiceSource('public'), toDm)
  const read = BYTES()
  let seen = null
  const r = await runForward({
    plan,
    target: toDm,
    readCache: async () => ({ bytes: read, mime: 'audio/mp4', w: 0, h: 0, ms: 4000 }),
    media: { putDm: async (args) => { seen = Array.from(args.bytes); return dmItem(9, 'audio/mp4') } },
    request: async () => ({})
  })
  if (await rpcTakesFwd()) t.is(r.phase, 'done')
  t.alike(seen, [1, 2, 3], 'the upload got the plaintext')
  t.ok(read.every((b) => b === 0), 'wiped after the upload')
  const cancelled = BYTES()
  let alive = true
  const two = forwardPlan(publicSource({ media: [publicItem(1), publicItem(2)] }), toPublic)
  const c = await runForward({
    plan: two,
    target: toPublic,
    readCache: async () => { alive = false; return { bytes: cancelled, mime: 'image/png' } },
    media: fakeMedia([]),
    request: async () => ({}),
    live: () => alive
  })
  t.is(c.phase, 'cancelled')
  t.ok(cancelled.every((b) => b === 0), 'wiped on cancel too')
})

test('dmForwardSource: expired dm.thread media drops with A mídia expirou; nothing left, nothing offered', async (t) => {
  const { dmForwardSource, forwardPlan } = await load()
  const captioned = dmForwardSource('legenda', { unavailable: true })
  t.alike(captioned, { kind: 'dm', text: 'legenda', media: [{ unavailable: true }] })
  const p = forwardPlan(captioned, toDm)
  t.is(p.ok, true)
  t.is(p.dropped, 'A mídia expirou', 'the caption goes with the expired note')
  t.is(p.uploads.length, 0)
  t.is(dmForwardSource('', { unavailable: true }), null, 'media-only and expired: no Encaminhar')
  t.is(dmForwardSource('', [{ unavailable: true }]), null)
  t.is(dmForwardSource('', null), null)
  t.alike(dmForwardSource(undefined, [dmItem()]), { kind: 'dm', text: '', media: [dmItem()] })
  t.alike(dmForwardSource('oi', null), { kind: 'dm', text: 'oi', media: [] })
})

test('forward.js imports only pure modules and has no em dash', async (t) => {
  const src = readFileSync(join(__dirname, '..', 'src', 'forward.js'), 'utf8')
  const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map(m => m[1])
  const dynamic = [...src.matchAll(/\b(?:import|require)\s*\(/g)]
  t.alike(dynamic, [], 'no dynamic import or require')
  for (const spec of specs) t.ok(spec === '@varanda/rpc' || /^\.\.?\/[\w./-]+\.js$/.test(spec), 'allowed import ' + spec)
  t.absent(/react|node:|@varanda\/core|@varanda\/web-member|fetch\(/.test(src))
  t.absent(/reuse|DM_REUSE|DAY_MS/i.test(src), 'no reuse path')
  const dash = String.fromCharCode(0x2014)
  t.absent(src.includes(dash))
  t.absent(readFileSync(__filename, 'utf8').includes(dash))
})

test('forwardPlan: a listed term is refused only on its way into a public group', async (t) => {
  const { forwardPlan } = await load()
  const { BLOCKED_TERMS } = await import('../src/blockedTerms.js')
  const { refusalText } = await import('../src/wordCheck.js')
  const term = BLOCKED_TERMS[0]
  for (const source of [dmSource({ text: term }), publicSource({ text: term }), postSource({ text: term })]) {
    const plan = forwardPlan(source, toPublic)
    t.absent(plan.ok, source.kind + ' into a public group')
    t.is(plan.error, refusalText(term))
  }
  t.ok(forwardPlan(dmSource({ text: term }), toDm).ok, 'into a direct message')
  t.ok(forwardPlan(privateSource({ text: term }), toPrivate).ok, 'into a private group')
  t.ok(forwardPlan(dmSource({ text: 'um texto comum' }), toPublic).ok, 'ordinary text into a public group')
})
