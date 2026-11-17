// The Page's web share helpers (src/pageShare.js). ES module through import().
'use strict'

const test = require('brittle')

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
    status: async () => { reads++; return { shared: [3] } },
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
  t.ok(app.includes('ops={shareOps}') && app.includes('shareTarget.slice(0, 64).toLowerCase() === acting.key'), 'App opens page mode only for the acting page\'s ref')
})
