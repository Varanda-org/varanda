'use strict'

// Pure view of the Posts salvos screen (src/savedView.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/savedView.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const post = (text = 'oi') => ({ type: 'post', text, at: '2026-01-01T00:00:00.000Z', replyTo: null })
const peekOf = (key, entries) => ({ key, entries, profile: { name: 'Ana', bio: '', avatar: null }, username: null })

test('planLoads groups by author, at most 29 seqs a call, ascending', async (t) => {
  const { planLoads, MAX_IN_FLIGHT } = await load()
  const entries = []
  for (let i = 40; i >= 1; i--) entries.push({ author: A, seq: i, savedAt: 1 })
  entries.push({ author: B, seq: 3, savedAt: 1 }, { author: 'x', seq: 1 }, { author: B, seq: 0 })
  const plan = planLoads(entries)
  t.is(plan.length, 3)
  t.is(plan[0].seqs.length, 29)
  t.is(plan[1].seqs.length, 11)
  t.alike(plan[2], { author: B, seqs: [3] })
  t.alike(plan[0].seqs, plan[0].seqs.slice().sort((a, b) => a - b))
  t.is(MAX_IN_FLIGHT, 2)
})

test('planLoads puts the seeder hints on the first chunk of each author only', async (t) => {
  const { planLoads } = await load()
  const entries = []
  for (let i = 1; i <= 40; i++) entries.push({ author: A, seq: i, savedAt: 1 })
  entries.push({ author: B, seq: 3, savedAt: 1 })
  const plan = planLoads(entries, undefined, { [A]: { profileSeq: 2, usernameSeq: 5 }, [B]: { profileSeq: null, usernameSeq: 0 } })
  t.is(plan.length, 3)
  t.is(plan[0].profileSeq, 2)
  t.is(plan[0].usernameSeq, 5)
  t.absent('profileSeq' in plan[1] || 'usernameSeq' in plan[1], 'second chunk has no hints')
  t.alike(plan[2], { author: B, seqs: [3] }, 'null or zero hints are omitted')
  t.alike(planLoads([{ author: A, seq: 1 }], undefined, { [A]: { profileSeq: 2, usernameSeq: 5 } }), [{ author: A, seqs: [1], profileSeq: 2, usernameSeq: 5 }])
  t.alike(planLoads([{ author: A, seq: 1 }], (k) => k === A, { [A]: { profileSeq: 2, usernameSeq: 5 } }), [], 'a blocked author is not read')
})

test('buildRows: verified post, missing, invalid, blocked and repost rows', async (t) => {
  const { buildRows } = await load()
  const entries = [
    { author: A, seq: 1, savedAt: 3 },
    { author: A, seq: 2, savedAt: 2 },
    { author: B, seq: 1, savedAt: 1 },
    { author: A, seq: 4, savedAt: 1 },
    { author: A, seq: 1, savedAt: 1 }
  ]
  const peeked = new Map([
    [A, peekOf(A, [{ seq: 1, record: post('ola') }, { seq: 4, record: { type: 'repost', on: true, at: '2026-01-01T00:00:00.000Z', to: { author: B, seq: 1 } } }])],
    [B, peekOf(B, [{ seq: 1, record: post('bloqueado') }])]
  ])
  const rows = buildRows({ entries, peeked, isBlocked: (k) => k === B })
  t.alike(rows.map((r) => [r.kind, r.key]), [
    ['post', A + ':1'], ['gone', A + ':2'], ['gone', B + ':1'], ['gone', A + ':4']
  ])
  t.is(rows[0].post.text, 'ola')
  t.is(rows[0].post.name, 'Ana')
  t.absent(JSON.stringify(rows[1]).includes('Ana'), 'a gone row carries no peer text')
})

test('a post under another key is not shown', async (t) => {
  const { buildRows } = await load()
  const peeked = new Map([[A, peekOf(B, [{ seq: 1, record: post() }])]])
  t.is(buildRows({ entries: [{ author: A, seq: 1 }], peeked })[0].kind, 'gone')
})

test('canSavePost and notices', async (t) => {
  const { canSavePost, saveNotice, unsaveNotice } = await load()
  const { SAVED_FULL_TEXT, SAVED_SCOPES_TEXT } = await import('../src/savedPosts.js')
  t.ok(canSavePost({ hosted: true, author: A, seq: 1 }))
  t.absent(canSavePost({ hosted: false, author: A, seq: 1 }))
  t.absent(canSavePost({ hosted: true, author: A, seq: 0 }))
  t.absent(canSavePost({ hosted: true, author: 'zz', seq: 1 }))
  t.is(saveNotice({ ok: false, reason: 'full' }), SAVED_FULL_TEXT)
  t.is(saveNotice({ ok: true, persisted: true }), 'Publicação salva.')
  t.is(saveNotice({ ok: false, reason: 'scopes' }), SAVED_SCOPES_TEXT)
  t.ok(saveNotice({ ok: true, persisted: false }).includes('só até fechar'))
  t.is(saveNotice(null), 'Não foi possível salvar agora.')
  t.is(unsaveNotice(true), 'Tirado dos salvos.')
})

test('viewOf', async (t) => {
  const v = await load()
  t.is(v.viewOf({ hosted: false, phase: 'ready', count: 1 }).view, 'off')
  t.is(v.viewOf({ hosted: true, phase: 'ready', count: 0 }).view, 'empty')
  t.is(v.viewOf({ hosted: true, phase: 'ready', count: 2 }).view, 'ready')
  t.is(v.viewOf({ hosted: true, phase: 'loading', count: 2, online: false }).view, 'offline')
  t.is(v.viewOf({ hosted: true, phase: 'idle', count: 3, online: false }).view, 'offline')
  t.is(v.viewOf({ hosted: true, phase: 'ready', count: 3, online: false }).view, 'ready')
  t.is(v.viewOf({ hosted: true, phase: 'error', count: 2 }).view, 'error')
  t.is(v.viewOf({ hosted: true, phase: 'loading', count: 2, online: true }).view, 'loading')
})

test('texts are pt-BR without an em dash and the module stays pure', async (t) => {
  const v = await load()
  t.is(v.SAVED_TITLE, 'Posts salvos')
  t.is(v.UNAVAILABLE_TEXT, 'Publicação indisponível')
  t.is(v.UNSAVE_LABEL, 'Tirar dos salvos')
  const src = fs.readFileSync(path.join(__dirname, '../src/savedView.js'), 'utf8')
  t.absent(src.includes(String.fromCharCode(0x2014)))
  t.absent(/from 'react|react-native/.test(src))
  for (const k of Object.keys(v)) if (typeof v[k] === 'string') t.absent(v[k].includes(String.fromCharCode(0x2014)), k)
})

test('planLoads skips blocked authors; buildRows: loading, unchecked, kept post', async (t) => {
  const { planLoads, buildRows } = await load()
  t.alike(planLoads([{ author: A, seq: 1 }, { author: B, seq: 2 }], (k) => k === A), [{ author: B, seqs: [2] }])
  const entries = [{ author: A, seq: 1 }, { author: A, seq: 2 }, { author: B, seq: 1 }, { author: B, seq: 2 }]
  const peeked = new Map([[A, peekOf(A, [{ seq: 1, record: post('antigo') }])]])
  const rows = buildRows({ entries, peeked, attempted: new Set([A + ':1', A + ':2', B + ':1']), failedAuthors: new Set([A, B]) })
  t.alike(rows.map((r) => r.kind), ['post', 'unchecked', 'unchecked', 'unchecked'])
  const late = buildRows({ entries: [{ author: A, seq: 2 }], peeked: new Map(), attempted: new Set() })
  t.is(late[0].kind, 'loading')
  t.is(buildRows({ entries: [{ author: A, seq: 2 }], peeked: new Map(), attempted: new Set([A + ':2']) })[0].kind, 'gone')
})
