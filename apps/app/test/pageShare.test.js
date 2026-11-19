// The Page's web share helpers (src/pageShare.js). ES module through import().
'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')

const load = () => import('../src/pageShare.js')
const PAGE = 'ab'.repeat(32)

test('pageShareOp and sharedRefs read the status answer', async (t) => {
  const { pageShareOp, sharedRefs } = await load()
  t.alike(pageShareOp(4), { seq: 4 })
  t.alike([...sharedRefs(PAGE.toUpperCase(), { shared: [2, 5, 0, -1, 'x', 1.5] })], [PAGE.toUpperCase() + ':2', PAGE.toUpperCase() + ':5'].map((s) => s.toLowerCase()))
  t.is(sharedRefs(PAGE, {}).size, 0)
  t.is(sharedRefs(PAGE, null).size, 0)
  t.is(sharedRefs(PAGE, { shared: 'x' }).size, 0)
  t.is(sharedRefs('nope', { shared: [1] }).size, 0)
})

test('shareAnswerState and shareErrorState map answers and errors', async (t) => {
  const { shareAnswerState, shareErrorState } = await load()
  t.is(shareAnswerState({ shareSeq: 3, created: false }, 'publish').state, 'on')
  t.is(shareAnswerState({ ok: true, changed: true }, 'unpublish').state, 'off')
  t.is(shareAnswerState({ ok: true, changed: true }, 'publish').state, 'uncertain', 'wrong shape')
  t.is(shareAnswerState(null, 'publish').state, 'uncertain')
  t.is(shareErrorState(Object.assign(new Error('x'), { uncertain: true }), 'publish').state, 'uncertain')
  t.is(shareErrorState(null, 'publish').state, 'uncertain')
  const refused = shareErrorState(new Error('Limite atingido'), 'publish')
  t.is(refused.state, 'error')
  t.is(refused.message, 'Limite atingido')
  t.is(shareErrorState(new Error(''), 'unpublish').message, 'Não deu para tirar da web.')
})

test('shareNewAsPage sends one request and never rejects', async (t) => {
  const { shareNewAsPage } = await load()
  let n = 0
  const ok = await shareNewAsPage(async (op) => { n++; t.alike(op, { seq: 6 }); return { shareSeq: 2, created: true } }, PAGE, 6)
  t.is(n, 1)
  t.is(ok.ref, PAGE + ':6')
  t.is(ok.result.state, 'on')
  n = 0
  const lost = await shareNewAsPage(async () => { n++; throw Object.assign(new Error('perdeu'), { uncertain: true }) }, PAGE, 6)
  t.is(n, 1, 'no retry')
  t.is(lost.result.state, 'uncertain')
  const refused = await shareNewAsPage(async () => { throw new Error('não') }, PAGE, 6)
  t.is(refused.result.state, 'error')
  t.alike(await shareNewAsPage(async () => ({}), PAGE, null), { ref: null, result: null }, 'no seq, no request')
})

test('pageSeqOf accepts only a ref of this page', async (t) => {
  const { pageSeqOf } = await load()
  t.is(pageSeqOf(PAGE, PAGE + ':7'), 7)
  t.is(pageSeqOf(PAGE, 'cd'.repeat(32) + ':7'), null, 'another author')
  t.is(pageSeqOf(PAGE, PAGE + ':0'), null)
  t.is(pageSeqOf(PAGE, PAGE + ':x'), null)
  t.is(pageSeqOf(PAGE, null), null)
})

test('pageShareOps reads status once and writes one request per call', async (t) => {
  const { pageShareOps } = await load()
  let reads = 0
  let shares = 0
  let unshares = 0
  const ops = pageShareOps({
    page: PAGE,
    status: async () => { reads++; return { shared: reads > 2 ? [] : [3] } },
    share: async (seq) => { shares++; t.is(seq, 5); return { shareSeq: 9, created: true } },
    unshare: async (seq) => { unshares++; t.is(seq, 3); return { ok: true, changed: true } }
  })
  t.is((await ops.read(PAGE + ':3')).state, 'on')
  t.is((await ops.read(PAGE + ':4')).state, 'off')
  t.is(reads, 2)
  t.is((await ops.publish(PAGE + ':5')).state, 'on')
  t.is((await ops.unpublish(PAGE + ':3')).state, 'off')
  t.is(shares + unshares, 2)
  t.is((await ops.publish('cd'.repeat(32) + ':5')).state, 'error', 'another author never reaches the service')
  t.is(shares, 1)
})

test('pageShareOps maps a lost answer to uncertain and never retries', async (t) => {
  const { pageShareOps } = await load()
  let n = 0
  const lost = async () => { n++; throw Object.assign(new Error('x'), { uncertain: true }) }
  const ops = pageShareOps({ page: PAGE, status: lost, share: lost, unshare: async () => ({}) })
  t.is((await ops.publish(PAGE + ':1')).state, 'uncertain')
  t.is((await ops.read(PAGE + ':1')).state, 'uncertain')
  t.is(n, 2)
  t.is((await ops.unpublish(PAGE + ':1')).state, 'uncertain', 'wrong shape')
})

test('a Page\'s own post gets the web menu and nobody else\'s does (source pins)', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  for (const f of ['src/screens/ARua.js', 'src/screens/Conversa.js']) {
    const src = read(f)
    t.ok(/actingOwn = actingPage !== null && String\(\w+\.author\)\.toLowerCase\(\) === actingPage/.test(src), f + ': only the acting page\'s own author')
    t.ok(src.includes('|| actingOwn)'), f + ': publishable lifts the exclusion for it alone')
    t.ok(/\(authorKey === (own|ownKey\.toLowerCase\(\)) && authorKey !== actingPage\)/.test(src), f + ': the person path keeps excluding the acting page key')
    t.ok(/\(!\((prof|authorProfile) && (prof|authorProfile)\.page === true\) \|\| actingOwn\)/.test(src), f + ': another page\'s post stays no diary post')
  }
  const app = read('App.js')
  t.ok(app.includes('ops={shareOps}') && app.includes('sharePageOf(shareTarget, acting)') && app.includes('acting.kind, acting.key]'), 'App opens page mode only for the acting page\'s ref')
})

test('sharePageOf names the acting page only for its own post refs', async (t) => {
  const { sharePageOf } = await load()
  const acting = { kind: 'page', key: PAGE }
  t.is(sharePageOf(PAGE + ':3', acting), PAGE)
  t.is(sharePageOf(PAGE.toUpperCase() + ':3', acting), PAGE, 'uppercase ref')
  t.is(sharePageOf('cd'.repeat(32) + ':3', acting), null, 'another page or a person')
  t.is(sharePageOf(PAGE + ':3', { kind: 'member' }), null, 'acting as the member')
  t.is(sharePageOf(null, acting), null)
  t.is(sharePageOf(PAGE + ':3', null), null)
  t.is(sharePageOf(PAGE + ':0', acting), null, 'bad seq')
})

test('pageShareOps unpublish re-reads status after a change and never repeats the unshare', async (t) => {
  const { pageShareOps } = await load()
  let unshares = 0
  let reads = 0
  const mk = (status) => pageShareOps({ page: PAGE, status, share: async () => ({}), unshare: async () => { unshares++; return { ok: true, changed: true } } })
  // Unbound, as PostShareSheet calls ops[action](target).
  const call = (ops, action, ref) => { const fn = ops[action]; return fn(ref) }
  const still = await call(mk(async () => { reads++; return { shared: [3] } }), 'unpublish', PAGE + ':3')
  t.is(still.state, 'on', 'older shares stay live: not off')
  const gone = await call(mk(async () => { reads++; return { shared: [] } }), 'unpublish', PAGE + ':3')
  t.is(gone.state, 'off')
  const lost = await call(mk(async () => { reads++; throw new Error('x') }), 'unpublish', PAGE + ':3')
  t.is(lost.state, 'uncertain')
  t.is(lost.message, 'Não deu para ver se esta publicação está na web.')
  t.is(unshares, 3)
  t.is(reads, 3)
  let r2 = 0
  const noop = pageShareOps({ page: PAGE, status: async () => { r2++; return { shared: [] } }, share: async () => ({}), unshare: async () => ({ ok: true, changed: false }) })
  t.is((await noop.unpublish(PAGE + ':3')).state, 'off')
  t.is(r2, 0, 'no read when nothing changed')
})

const COVER = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 4, blocks: 2, bytes: 40000, sha256: createHash('sha256').update(new Uint8Array(40000)).digest('hex'), width: 1200, height: 900 }

test('coveredState and read: covered is known only from a current service', async (t) => {
  const { coveredState, pageShareOps } = await load()
  t.is(coveredState({ shared: [3], covered: [3] }, 3), true)
  t.is(coveredState({ shared: [3], covered: [] }, 3), false)
  t.is(coveredState({ shared: [3] }, 3), null, 'an older service: unknown')
  t.is(coveredState(null, 3), null)
  let status = { shared: [3, 4], covered: [4] }
  const ops = pageShareOps({ page: PAGE, status: async () => status, share: async () => ({}), unshare: async () => ({}) })
  t.is(ops.page, PAGE)
  t.is((await ops.read(PAGE + ':3')).cover, false, 'shared, no cover: the repair may be offered')
  t.is((await ops.read(PAGE + ':4')).cover, true)
  t.is((await ops.read(PAGE + ':5')).cover, false, 'not shared')
  status = { shared: [3] }
  t.is((await ops.read(PAGE + ':3')).cover, null, 'no covered list: no button')
})

test('coverAsPage sends one post-cover and maps an older service to no cover', async (t) => {
  const { coverAsPage } = await load()
  const ops = []
  const ok = await coverAsPage(async (op) => { ops.push(op); return { coverSeq: 8, created: true } }, 3, COVER)
  t.is(ok.state, 'on')
  t.alike(ops, [{ seq: 3, image: COVER }], 'the op is exactly { seq, image }')
  for (const code of ['pedido-invalido', 'midia-invalida', 'nao-encontrado', 'limite', 'indisponivel']) {
    let n = 0
    const r = await coverAsPage(async () => { n++; throw Object.assign(new Error('x'), { code }) }, 3, COVER)
    t.is(r.state, 'off', code)
    t.is(n, 1, 'never retried')
  }
  t.is((await coverAsPage(async () => { throw Object.assign(new Error('x'), { uncertain: true }) }, 3, COVER)).state, 'uncertain')
  t.is((await coverAsPage(async () => ({}), 3, COVER)).state, 'uncertain', 'wrong shape')
  let none = 0
  t.is((await coverAsPage(async () => { none++ }, 0, COVER)).state, 'off')
  t.is(none, 0, 'a bad seq never reaches the service')
})

test('shareNewAsPage: a cover failure leaves the share on', async (t) => {
  const { shareNewAsPage } = await load()
  let writes = 0
  let uploads = 0
  const cover = {
    post: { media: [{ ...COVER, mime: 'image/avif', bytes: 90000, width: 2000, height: 1500 }] },
    held: { bytes: new Uint8Array(90000), mime: 'image/avif' },
    encodeThumbnail: async () => ({ bytes: new Uint8Array(40000), mime: 'image/jpeg', width: 1200, height: 900 }),
    upload: async () => { uploads++; return COVER },
    write: async (op) => { writes++; t.alike(op, { seq: 6, image: COVER }); throw Object.assign(new Error('Pedido inválido'), { code: 'pedido-invalido' }) }
  }
  const out = await shareNewAsPage(async () => ({ shareSeq: 2, created: true }), PAGE, 6, cover)
  t.is(out.result.state, 'on')
  t.is(uploads, 1)
  t.is(writes, 1)
  writes = 0
  uploads = 0
  const off = await shareNewAsPage(async () => { throw new Error('não') }, PAGE, 6, cover)
  t.is(off.result.state, 'error')
  t.is(uploads + writes, 0, 'no cover without a share')
})
