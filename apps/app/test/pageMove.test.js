// The closed and moved page view (src/pageMove.js): pure, no network.
'use strict'

const test = require('brittle')

const load = () => import('../src/pageMove.js')
const key = (c) => c.repeat(64)
const K1 = key('1')
const K2 = key('2')
const K3 = key('3')
const OTHER = key('9')

const read = (page, extra = {}) => ({ page, closed: false, movedTo: null, movedFrom: null, ...extra })
const statement = (page, to, extra = {}) => ({ moved: { type: 'page-moved', page, to, gen: 2, ...extra } })

test('a node-verified movedTo moves to K2 with the cut at the page-moved seq', async (t) => {
  const { pageMoveView } = await load()
  const v = pageMoveView(read(K1, { movedTo: { to: K2, seq: 9 } }))
  t.alike(v, { key: K2, cut: 9, moved: true, closed: false, follow: true })
})

test('a statement with a matching origin moves to K2, cut after fromSeq', async (t) => {
  const { pageMoveView, successorOf } = await load()
  const v = pageMoveView(read(K1), {
    statement: successorOf(statement(K1, K2)),
    targetRead: read(K2, { movedFrom: { from: K1, fromSeq: 6 } })
  })
  t.alike(v, { key: K2, cut: 7, moved: true, closed: false, follow: true })
})

test('a bad issuer signature yields no successor', async (t) => {
  // The node drops a page-origin whose countersignature fails: K2's read
  // reports movedFrom null, and the statement alone never counts.
  const { pageMoveView, moveOf, successorOf } = await load()
  const s = successorOf(statement(K1, K2))
  t.is(moveOf(read(K1), { statement: s, targetRead: read(K2, { movedFrom: null }) }), null)
  t.is(moveOf(read(K1), { statement: s, targetRead: null }), null)
  t.is(pageMoveView(read(K1), { statement: s, targetRead: read(K2) }).moved, false)
})

test('a statement without a matching origin is ignored', async (t) => {
  const { moveOf, successorOf } = await load()
  const s = successorOf(statement(K1, K2))
  // Origin names another key.
  t.is(moveOf(read(K1), { statement: s, targetRead: read(K2, { movedFrom: { from: OTHER, fromSeq: 6 } }) }), null)
  // The K2 read is about another page.
  t.is(moveOf(read(K1), { statement: s, targetRead: read(K3, { movedFrom: { from: K1, fromSeq: 6 } }) }), null)
  // The statement is about another page.
  t.is(moveOf(read(K1), { statement: successorOf(statement(OTHER, K2)), targetRead: read(K2, { movedFrom: { from: K1, fromSeq: 6 } }) }), null)
  // The statement carries a seq the origin does not name.
  const withSeq = successorOf(statement(K1, K2, { fromSeq: 5 }))
  t.is(withSeq.fromSeq, 5)
  t.is(moveOf(read(K1), { statement: withSeq, targetRead: read(K2, { movedFrom: { from: K1, fromSeq: 6 } }) }), null)
  t.alike(moveOf(read(K1), { statement: withSeq, targetRead: read(K2, { movedFrom: { from: K1, fromSeq: 5 } }) }), { to: K2, cut: 6 })
})

test('successorOf rejects what is not a statement', async (t) => {
  const { successorOf } = await load()
  t.is(successorOf(null), null)
  t.is(successorOf({}), null)
  t.is(successorOf({ moved: { page: K1, to: 'zz' } }), null)
  t.is(successorOf({ moved: { page: K1, to: K1 } }), null)
})

test('closed hides the follow flag', async (t) => {
  const { pageMoveView, resolveChain } = await load()
  const closed = pageMoveView(read(K1, { closed: true, movedTo: { to: K2, seq: 4 } }))
  t.alike(closed, { key: K1, cut: null, moved: false, closed: true, follow: false })
  // Moved to a K2 that was closed since: the banner stays, the follow does not.
  const reads = { [K1]: read(K1, { movedTo: { to: K2, seq: 4 } }), [K2]: read(K2, { closed: true }) }
  const chain = resolveChain(K1, (k) => ({ read: reads[k], targetRead: reads[reads[k].movedTo ? reads[k].movedTo.to : ''] }))
  const v = pageMoveView(reads[K1], { targetRead: reads[K2], chain })
  t.is(v.moved, true)
  t.is(v.follow, false)
})

test('a chain longer than 4 stops', async (t) => {
  const { resolveChain, pageMoveView, MAX_HOPS } = await load()
  t.is(MAX_HOPS, 4)
  const keys = ['1', '2', '3', '4', '5', '6', '7'].map(key)
  const reads = {}
  keys.forEach((k, i) => { reads[k] = read(k, i + 1 < keys.length ? { movedTo: { to: keys[i + 1], seq: 3 } } : {}) })
  const lookup = (k) => ({ read: reads[k], targetRead: reads[keys[keys.indexOf(k) + 1]] })
  const chain = resolveChain(keys[0], lookup)
  t.is(chain.hops, 4)
  t.is(chain.key, keys[4])
  t.is(pageMoveView(reads[keys[0]], { targetRead: reads[keys[1]], chain }).key, keys[4])
})

test('a cycle ends the walk', async (t) => {
  const { resolveChain } = await load()
  const reads = { [K1]: read(K1, { movedTo: { to: K2, seq: 3 } }), [K2]: read(K2, { movedTo: { to: K1, seq: 3 } }) }
  const chain = resolveChain(K1, (k) => ({ read: reads[k] }))
  t.is(chain.hops, 1)
  t.is(chain.key, K2)
})

test('shownUnderCut keeps posts below the cut only', async (t) => {
  const { shownUnderCut } = await load()
  t.ok(shownUnderCut(null, 50))
  t.ok(shownUnderCut(7, 6))
  t.absent(shownUnderCut(7, 7))
  t.absent(shownUnderCut(7, 8))
})
