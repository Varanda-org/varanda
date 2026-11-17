'use strict'

const test = require('brittle')

const load = () => import('../src/pageVote.js')
const P = 'a'.repeat(64)
const M = 'b'.repeat(64)

test('the page pick is the option whose voters hold the page key', async (t) => {
  const { pagePickOf } = await load()
  const answer = { voters: [{ pick: 0, by: [M] }, { pick: 1, by: [P] }, { pick: 2, by: [] }] }
  t.is(pagePickOf(answer, P, 3), 1)
  t.is(pagePickOf(answer, M, 3), 0, 'the member key is only what the caller passes')
})

test('a page that did not vote has no pick, never the member one', async (t) => {
  const { pagePickOf } = await load()
  t.is(pagePickOf({ voters: [{ pick: 0, by: [M] }, { pick: 1, by: [] }] }, P, 2), null)
  t.is(pagePickOf({ voters: [] }, P, 2), null)
})

test('an answer that cannot tell is unknown, not null', async (t) => {
  const { pagePickOf } = await load()
  t.is(pagePickOf(null, P, 2), undefined)
  t.is(pagePickOf({}, P, 2), undefined)
  t.is(pagePickOf({ voters: 'x' }, P, 2), undefined)
  t.is(pagePickOf({ voters: [{ pick: -1, by: [P] }] }, P, 2), undefined)
  t.is(pagePickOf({ voters: [{ pick: 0 }] }, P, 2), undefined)
  t.is(pagePickOf({ voters: [] }, 'nope', 2), undefined)
  t.is(pagePickOf({ voters: [{ pick: 0, by: [P] }, { pick: 1, by: [P] }] }, P, 2), undefined, 'two picks for one key')
})

test('a cut voter list never proves the page did not vote', async (t) => {
  const { pagePickOf } = await load()
  const cut = { voters: [{ pick: 0, count: 950, by: [M] }, { pick: 1, count: 0, by: [] }] }
  t.is(pagePickOf(cut, P, 2), undefined, 'missing from a cut list is unknown')
  t.is(pagePickOf({ voters: [{ pick: 0, count: 950, by: [M, P] }, { pick: 1, count: 0, by: [] }] }, P, 2), 0, 'found in a cut list is a pick')
  t.is(pagePickOf({ voters: [{ pick: 0, count: 1, by: [M] }, { pick: 1, count: 0, by: [] }] }, P, 2), null, 'a whole list is a no vote')
})

test('an option beyond the count is ignored', async (t) => {
  const { pagePickOf } = await load()
  t.is(pagePickOf({ voters: [{ pick: 5, by: [P] }] }, P, 2), null)
})

test('the screens act as the page through the service and never show the node pick (source pins)', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const read = (f) => readFileSync(join(__dirname, '../src', f), 'utf8')
  const topico = read('screens/Topico.js')
  t.ok(topico.includes("action: 'group-choice'") && topico.includes('pageGroupChoiceOp({ group, target: root, pick: next.pick })'), 'Topico: the page vote is one group-choice')
  t.ok(topico.includes("action: 'group-post'") && topico.includes('pageGroupPostOp({ group, text, replyTo: root })'), 'Topico: the page reply is one group-post')
  t.ok(topico.includes("action: 'group-read', op: params") && topico.includes("action: 'group-voters'"), 'Topico: the page reads the thread and the voters from the service')
  t.ok(topico.includes('readState.by === pageKey'), 'Topico: a read made for another identity is never shown')
  t.ok(topico.includes('sent !== null && sent.page === pageKey ? sent.pick : readPick'), 'Topico: the answered pick stays until a read shows it')
  t.ok(topico.includes('pick: index') && topico.includes('tapAfterUncertain(pending, { page, ref, pick: index })'), 'Topico: the retry is matched by the option tapped')
  t.absent(/pick: next\.pick \}\) === 'resend'/.test(topico), 'Topico: not by the toggled value')
  t.ok(topico.includes('pageKeyRef.current !== page'), 'Topico: an answer after a switch is dropped')
  t.ok(topico.includes("request('group.read', params)") && topico.includes("request('group.choose'"), 'Topico: the person path stays')
  const card = read('ui/EventCard.js')
  t.ok(card.includes("action: 'group-choice'") && card.includes('pageGroupChoiceOp({ group, target: { writer, seq }, pick: next })'), 'EventCard: the page RSVP in a group is one group-choice')
  t.ok(card.includes("action: 'group-voters'") && card.includes('pagePickOf(res, page, 2)'), 'EventCard: the page RSVP is read from the service')
  t.ok(card.includes('gRead !== undefined ? gRead : serviceMine'), 'EventCard: an unknown read falls back to the service mine, never the node')
  t.ok(card.includes('tapAfterUncertain(pending, { page, ref, pick: index })'), 'EventCard: the retry is matched by the option tapped')
  t.ok(card.includes("request('group.choose'"), 'EventCard: the person path stays')
  const eventos = read('screens/Eventos.js')
  t.ok(eventos.includes("action: 'group-events'") && eventos.includes('rowsState.by === pageKey'), 'Eventos: the page agenda comes from the service, tagged with the identity')
  t.ok(eventos.includes("request('group.events', { group })"), 'Eventos: the person path stays')
  t.ok(topico.includes('{ page, ref, pick: index, value, retry: err.retry }'), 'Topico: a resend keeps the signed pick, never the toggle')
  t.absent(topico.includes('value: next.pick, retry'), 'Topico: the retry value is not recomputed')
  t.ok(topico.includes("setLoadingMore(false)\n    setMoreError('')\n  }, [pageKey])"), 'Topico: an identity switch resets the older-page spinner')
  t.ok(topico.includes('readPick === pending.value') && !topico.includes("setSent(null); setNote('')"), 'Topico: a read clears only the notice of the tap it confirms')
  t.ok(card.includes('readPick === pending.value') && !card.includes("readPick === sent.pick) { setSent(null); setError('')"), 'EventCard: a read clears only the notice of the tap it confirms')
  const comunidade = read('screens/Comunidade.js')
  t.ok(comunidade.includes('hosted && (asPage.page || isMember) && typeof onOpenAgenda'), 'Comunidade: a page can open the Agenda')
  t.absent(comunidade.includes('hosted && !asPage.page && isMember && typeof onOpenAgenda'), 'Comunidade: the page is no longer cut out of the Agenda')
  t.ok(comunidade.includes("g.visibility === 'public' && typeof g.group"), 'Comunidade: only public groups are listed for the Agenda')
})
