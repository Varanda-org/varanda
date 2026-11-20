'use strict'

// A Página's reactions in its Conversas (inner v11/v12): the page client's
// routing and the kept re-put of an unconfirmed momento reaction.
const test = require('brittle')

const PAGE = 'cd'.repeat(32)
const PEER = 'ab'.repeat(32)

function fakeNode (answers = {}) {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, request }
}

test('the page reacts to a message through dm.pageDraft kind react, then the page statement and dm.pageSend', async (t) => {
  const { pageDmClient } = await import('../src/dm-screen.js')
  const node = fakeNode({ 'dm.pageDraft': { id: 'd1', digest: 'e'.repeat(64), at: 'x' }, 'dm.pageSend': { id: 'd1', at: 'x' } })
  const signed = []
  const sign = async (digest) => { signed.push(digest); return { signature: 's', expiresAt: 9 } }
  const dm = pageDmClient({ request: node.request, sign, page: PAGE })
  const target = { from: PEER, id: 'f'.repeat(32) }
  t.alike(await dm('dm.react', { to: PEER, target, emoji: '❤️' }), { ok: true })
  t.alike(node.calls, [
    { method: 'dm.pageDraft', params: { page: PAGE, kind: 'react', to: PEER, target, emoji: '❤️' } },
    { method: 'dm.pageSend', params: { page: PAGE, id: 'd1', signature: 's', expiresAt: 9 } }
  ])
  t.alike(signed, ['e'.repeat(64)], 'signs the draft digest')
  await dm('dm.react', { to: PEER, target, emoji: '' })
  t.is(node.calls[2].params.emoji, '', 'withdrawing drafts emoji ""')
})

test('the page reacts to a momento with a one-emoji msg carrying moment', async (t) => {
  const { pageDmClient } = await import('../src/dm-screen.js')
  const { reactionParams } = await import('../src/momentReaction.js')
  const node = fakeNode({ 'dm.pageDraft': { id: 'd2', digest: 'a'.repeat(64) }, 'dm.pageSend': { id: 'd2' } })
  const dm = pageDmClient({ request: node.request, sign: async () => ({ signature: 's', expiresAt: 1 }), page: PAGE })
  await dm('dm.send', reactionParams({ seq: 4 }, PEER, '👍'))
  t.alike(node.calls[0], { method: 'dm.pageDraft', params: { page: PAGE, kind: 'msg', to: PEER, text: '👍', moment: 4 } })
  await dm('dm.send', { to: PEER, text: 'oi' })
  t.absent('moment' in node.calls[2].params, 'a plain message carries no moment')
})

test('an uncertain page reaction keeps the same signed re-put, never a new draft', async (t) => {
  const { pageDmClient } = await import('../src/dm-screen.js')
  const { reactionRetry } = await import('../src/momentReaction.js')
  let puts = 0
  let drafts = 0
  const request = async (method) => {
    if (method === 'dm.pageDraft') { drafts++; return { id: 'd3', digest: 'b'.repeat(64) } }
    puts++
    throw Object.assign(new Error('x'), { uncertain: true })
  }
  const dm = pageDmClient({ request, sign: async () => ({ signature: 's', expiresAt: 1 }), page: PAGE })
  const err = await dm('dm.react', { to: PEER, target: { from: PEER, id: 'f'.repeat(32) }, emoji: '❤️' }).catch((e) => e)
  t.is(typeof err.retry, 'function')
  const again = reactionRetry(err, true)
  t.is(again, err.retry)
  await again().catch(() => {})
  t.is(drafts, 1, 'one draft')
  t.is(puts, 2, 'the re-put only')
  t.is(reactionRetry(err, false), null, 'a person keeps no re-put')
  t.is(reactionRetry(new Error('x'), true), null, 'no retry on the error, none kept')
})

test('while a page reaction is held uncertain, its message takes only the retry', async (t) => {
  const { reactionTap, PAGE_REACTION_HELD } = await import('../src/dm-screen.js')
  const heart = '❤️'
  const thumbs = '👍'
  t.alike(reactionTap({}, heart), { retry: false, emoji: null, locked: false }, 'nothing held: a plain toggle')
  t.alike(reactionTap({ unsure: heart, held: true }, heart), { retry: true, emoji: heart, locked: false }, 'the same emoji is the retry')
  t.alike(reactionTap({ unsure: heart, held: true }, thumbs), { retry: false, emoji: null, locked: true }, 'another emoji is locked')
  t.alike(reactionTap({ unsure: '', removed: heart, held: true }, heart), { retry: true, emoji: '', locked: false }, 'the removed emoji retries the removal')
  t.alike(reactionTap({ unsure: '', removed: heart, held: true }, thumbs).locked, true, 'nothing else while a removal is held')
  t.alike(reactionTap({ unsure: heart }, thumbs), { retry: false, emoji: null, locked: false }, 'a person keeps no re-put: no lock')
  t.ok(PAGE_REACTION_HELD.length > 0)

  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  t.ok(src.includes('held: context.retries.has(key) }, picked)') && src.includes('if (tap.locked) {'), 'Mensagem locks the held message')
  t.is(src.split('if (context.retries.has(key) || context.sending.has(key)').length - 1, 2, 'a thread read never drops a held unsure state')
})
