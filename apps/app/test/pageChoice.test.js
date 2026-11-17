// A page's votes and RSVPs, the pure part (src/pageChoice.js): the pick key,
// the 'status' picked map, who votes, and what a tap does after an unknown
// outcome. No network.
'use strict'

const test = require('brittle')

const load = () => import('../src/pageChoice.js')

const A = 'ab'.repeat(32)
const P = 'cd'.repeat(32)

test('pickRef builds author:seq, lowercase, and refuses a bad key or seq', async (t) => {
  const { pickRef } = await load()
  t.is(pickRef(A.toUpperCase(), 5), A + ':5')
  t.is(pickRef(A, 0), null)
  t.is(pickRef(A, 1.5), null)
  t.is(pickRef('nope', 1), null)
  t.is(pickRef(undefined, 1), null)
})

test('choicePage is the page key only when acting as a page', async (t) => {
  const { choicePage } = await load()
  t.is(choicePage({ kind: 'page', key: P }), P)
  t.is(choicePage({ kind: 'me' }), null)
  t.is(choicePage({ kind: 'page', key: 'x' }), null)
  t.is(choicePage(null), null)
})

test('pickedFromStatus keeps well formed entries and drops the rest', async (t) => {
  const { pickedFromStatus, pickedOf } = await load()
  const m = pickedFromStatus({
    picked: {
      [A + ':3']: [1],
      [A + ':4']: [0],
      [A + ':5']: [4],
      [A + ':0']: [1],
      'zz:1': [1],
      [A + ':6']: ['x'],
      [A + ':7']: 1,
      [A + ':8']: [2, 4, 2, 1.5, -1, 0],
      [A + ':10']: []
    }
  })
  t.alike([...m.entries()], [[A + ':3', [1]], [A + ':4', [0]], [A + ':8', [2, 0]]], 'bad picks dropped, a repeat keeps its newest place')
  t.is(pickedOf(m, A + ':3', 2), 1)
  t.is(pickedOf(m, A + ':4', 2), 0, 'option 0 is a vote')
  t.is(pickedOf(m, A + ':9', 2), null, 'absent is no vote')
  t.is(pickedFromStatus({}).size, 0)
  t.is(pickedFromStatus(null).size, 0)
  t.is(pickedFromStatus({ picked: [1] }).size, 0)
  t.is(pickedOf(m, null, 2), null)
  t.is(pickedOf(m, A + ':3'), null, 'no option count, no pick')
  t.is(pickedOf(m, A + ':3', 0), null)
})

test('pickedOf folds like polls.js livePick: the newest pick the post has', async (t) => {
  const { pickedFromStatus, pickedOf } = await load()
  const { livePick } = require('@varanda/core/lib/polls')
  // A page voted 0, then 3 on a foreign 2-option poll: the service answers
  // [3, 0] and readers count 0.
  const m = pickedFromStatus({ picked: { [A + ':3']: [3, 0] } })
  t.is(pickedOf(m, A + ':3', 2), 0, 'the out-of-range 3 falls back to 0')
  t.is(pickedOf(m, A + ':3', 4), 3, 'a poll with 4 options counts the 3')
  t.is(pickedOf(pickedFromStatus({ picked: { [A + ':3']: [3, 2] } }), A + ':3', 2), null, 'no pick in range is no vote')
  const at = '2026-01-01T00:00:00.000Z'
  const choice = (seq, pick) => ({ seq, record: { type: 'choice', to: { author: A, seq: 3 }, pick, at } })
  const entries = [choice(1, 0), choice(2, 3)]
  t.is(livePick({ entries, poll: { author: A, seq: 3 }, count: 2, now: Date.parse(at) + 1 }).pick, 0, 'the reader agrees')
})

test('withPick settles on a copy: a pick goes first, null withdraws', async (t) => {
  const { withPick, pickedOf } = await load()
  const base = new Map([[A + ':3', [1]]])
  const next = withPick(base, A + ':3', 0)
  t.alike(next.get(A + ':3'), [0, 1], 'the new pick first, the old one kept')
  t.is(pickedOf(next, A + ':3', 2), 0)
  t.alike(base.get(A + ':3'), [1], 'the original is untouched')
  t.alike(withPick(next, A + ':3', 1).get(A + ':3'), [1, 0], 'a repeated pick moves to the front')
  t.is(withPick(next, A + ':3', null).has(A + ':3'), false, 'a withdrawal clears the history')
  t.is(pickedOf(withPick(next, A + ':3', null), A + ':3', 2), null)
  t.alike(withPick(undefined, A + ':7', 2).get(A + ':7'), [2])
})

test('tapAfterUncertain resends only the same pick on the same page and post', async (t) => {
  const { tapAfterUncertain } = await load()
  const retry = () => {}
  const pending = { page: P, ref: A + ':3', pick: 1, retry }
  t.is(tapAfterUncertain(pending, { page: P, ref: A + ':3', pick: 1 }), 'resend')
  t.is(tapAfterUncertain(pending, { page: P, ref: A + ':3', pick: 0 }), 'fresh')
  t.is(tapAfterUncertain(pending, { page: P, ref: A + ':3', pick: null }), 'fresh')
  t.is(tapAfterUncertain(pending, { page: 'ee'.repeat(32), ref: A + ':3', pick: 1 }), 'fresh')
  t.is(tapAfterUncertain(pending, { page: P, ref: A + ':4', pick: 1 }), 'fresh')
  t.is(tapAfterUncertain(null, { page: P, ref: A + ':3', pick: 1 }), 'fresh')
  t.is(tapAfterUncertain({ ...pending, retry: undefined }, { page: P, ref: A + ':3', pick: 1 }), 'fresh')
})

test('the cards and rows wire the page identity (source pins)', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const read = (f) => readFileSync(join(__dirname, '../src', f), 'utf8')
  for (const f of ['ui/PollCard.js', 'ui/EventCard.js']) {
    const src = read(f)
    t.ok(src.includes('choicePage(useActing())'), f + ' knows who acts')
    t.ok(src.includes('readPagePick(nodeRef.current, page, ref, ' + (f === 'ui/PollCard.js' ? 'count' : '2') + ')'), f + ' reads the page pick from status, folded for its option count')
    t.ok(src.includes('setPagePick(nodeRef.current, page, ref,'), f + ' votes with the page action')
    t.ok(src.includes('tapAfterUncertain('), f + ' resends only on an explicit tap')
    t.ok(src.includes("request('choice.set'"), f + ' keeps the person path')
  }
  for (const f of ['screens/ARua.js', 'screens/Conversa.js']) {
    const src = read(f)
    t.ok(/pollable && Array\.isArray\(/.test(src), f + ' shows a page post poll')
    t.absent(/diaryPost && Array\.isArray\([a-z]+\.poll/.test(src), f + ' no longer hides it for a page')
    t.ok(/const postRef = diaryPost/.test(src), f + ' keeps the web link off for a page')
  }
  const post = read('screens/Publicar.js')
  t.ok(post.includes('structured.error'), 'Publicar refuses a bad page poll before signing')
  t.ok(post.includes('...(plain ? {} : structured)'), 'Publicar sends the poll or event in the page post op')
})

test('refusalText names a definite known page refusal, never an uncertain one', async (t) => {
  const { refusalText } = await load()
  const err = (code, extra = {}) => Object.assign(new Error('texto ' + code), { code, ...extra })
  for (const code of ['termos-pendentes', 'encerrada', 'pausada', 'sem-permissao', 'limite']) {
    t.is(refusalText(err(code), 'geral'), 'texto ' + code, code)
  }
  t.is(refusalText(err('pausada', { uncertain: true }), 'geral'), 'geral', 'uncertain keeps the generic text')
  t.is(refusalText(err('indisponivel'), 'geral'), 'geral', 'an unknown token')
  t.is(refusalText(new Error('x'), 'geral'), 'geral')
  t.is(refusalText(null, 'geral'), 'geral')
})

test('the Page variants of the notice and the spoken mark', async (t) => {
  const { choiceNotice, ownMark, PAGE_VOTE_NOTICE, PAGE_RSVP_NOTICE, PAGE_PICK_UNREAD } = await load()
  t.is(choiceNotice(null, 'pessoa', PAGE_VOTE_NOTICE), 'pessoa')
  t.is(choiceNotice(P, 'pessoa', PAGE_VOTE_NOTICE), PAGE_VOTE_NOTICE)
  t.is(choiceNotice(P, null, PAGE_VOTE_NOTICE), null, 'no notice once picked')
  t.is(ownMark(null, ', seu voto'), ', seu voto')
  t.is(ownMark(P, ', seu voto'), ', voto da Página')
  for (const text of [PAGE_VOTE_NOTICE, PAGE_RSVP_NOTICE, PAGE_PICK_UNREAD]) {
    t.ok(text.includes('Página'), 'pt-BR text for the Page')
    t.absent(text.includes('—'), 'no em dash')
  }
})

test('Conversa shares one status read per page and drops the pick after an unknown outcome (source pins)', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const src = readFileSync(join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  t.ok(src.includes('const pageReads = new Map()'), 'pending reads are kept per page')
  t.ok(src.includes('if (!fresh && pageReads.has(page)) return pageReads.get(page)'), 'a plain read joins the one in flight')
  t.ok(src.includes('if (pageReads.get(page) === read) pageReads.delete(page)'), 'a failed read is not kept')
  const set = src.slice(src.indexOf('export async function setPagePick'))
  t.ok(set.includes('pageStatus.delete(page)'), 'an uncertain failure drops the cached entry')
  const card = (f) => readFileSync(join(__dirname, '../src/ui', f), 'utf8')
  for (const f of ['PollCard.js', 'EventCard.js']) {
    const src2 = card(f)
    t.ok(src2.includes("setError(''); setUnread(false); retryRef.current = null }, [page])"), f + ' resets the error with the identity')
    t.ok(src2.includes('refusalText(err,'), f + ' names a definite page refusal')
    t.ok(src2.includes('PAGE_PICK_UNREAD'), f + ' says when the page pick could not be read')
  }
  t.ok(card('EventCard.js').includes('(!grouped && pageRef.current !== page)'), 'a person answer is dropped after a switch to a Page too')
})
