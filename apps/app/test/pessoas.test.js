// Pure logic of the public 'Seguindo' and 'Seguidores' lists (pessoas.js):
// verification of the seeder's list against peeked follow records, cursors
// and strings.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/pessoas.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const D = '12'.repeat(32)
const E = '34'.repeat(32)
const F = '56'.repeat(32)
const G = '78'.repeat(32)
const AT = '2026-10-20T10:00:00.000Z'

const follow = (key, over = {}) => ({ type: 'follow', key, on: true, at: AT, ...over })

function peek (key, entries) {
  return { key, entries: entries.map(([seq, record]) => ({ seq, record })), profile: null, username: null }
}

test('refOf: the follower block for seguidores, the author block for seguindo', async (t) => {
  const { refOf } = await load()
  t.is(refOf('seguidores', A, { key: B, seq: 4, at: AT }), B + ':4')
  t.is(refOf('seguindo', A, { key: B, seq: 4, at: AT }), A + ':4')
  t.is(refOf('likes', A, { key: B, seq: 4 }), null)
  t.is(refOf('seguindo', A, { key: B, seq: 0 }), null)
  t.is(refOf('seguindo', 'x', { key: B, seq: 1 }), null)
  t.is(refOf('seguidores', A, null), null)
})

test('confirmFollows seguidores: only a signed follow of the author proves a row', async (t) => {
  const { confirmFollows } = await load()
  const peeked = new Map([
    [B, peek(B, [[2, follow(A)]])],
    [C, peek(C, [[3, follow(D)]])],
    [D, peek(D, [[4, follow(A, { on: false })]])],
    [E, peek(E, [[5, follow(A, { at: '2026-10-21T10:00:00.000Z' })]])],
    [F, peek(F, [[6, { type: 'like', key: A, on: true, at: AT }]])],
    [G, peek(B, [[7, follow(A)]])]
  ])
  const items = [
    { key: B, seq: 2, at: AT },
    { key: C, seq: 3, at: AT },
    { key: D, seq: 4, at: AT },
    { key: E, seq: 5, at: AT },
    { key: F, seq: 6, at: AT },
    { key: G, seq: 7, at: AT },
    { key: '9a'.repeat(32), seq: 1, at: AT },
    { key: B, seq: 2, at: AT },
    { key: 'x', seq: 1, at: AT }
  ]
  const out = confirmFollows({ kind: 'seguidores', author: A, items, peeked })
  t.alike(out.rows, [{ key: B, seq: 2, at: AT }])
  t.is(out.unavailable, 7, 'wrong target, on false, other at, other type, wrong peek key, no peek, malformed')
})

test('confirmFollows seguindo: entries come from the author diary and name the target', async (t) => {
  const { confirmFollows } = await load()
  const peeked = new Map([
    [A, peek(A, [[2, follow(B)], [3, follow(D)], [4, follow(D, { on: false })], [8, follow(E)]])],
    [B, peek(B, [[5, follow(B)]])]
  ])
  const items = [
    { key: B, seq: 2, at: AT },
    { key: C, seq: 3, at: AT },
    { key: D, seq: 4, at: AT },
    { key: E, seq: 9, at: AT },
    { key: F, seq: 5, at: AT }
  ]
  const out = confirmFollows({ kind: 'seguindo', author: A, items, peeked })
  t.alike(out.rows, [{ key: B, seq: 2, at: AT }])
  t.is(out.unavailable, 4, 'other target, on false, seq not peeked, not in the author diary')
})

test('confirmFollows never confirms the author itself or bad input, never throws', async (t) => {
  const { confirmFollows } = await load()
  const peeked = new Map([[A, peek(A, [[2, follow(A)]])]])
  t.alike(confirmFollows({ kind: 'seguindo', author: A, items: [{ key: A, seq: 2, at: AT }], peeked }), { rows: [], unavailable: 1 })
  t.alike(confirmFollows({ kind: 'likes', author: A, items: [{ key: B, seq: 2, at: AT }], peeked }), { rows: [], unavailable: 1 })
  t.alike(confirmFollows({ kind: 'seguidores', author: A, items: [{ key: B, seq: 2, at: AT }], peeked: {} }), { rows: [], unavailable: 1 })
  t.alike(confirmFollows(), { rows: [], unavailable: 0 })
  t.alike(confirmFollows(null), { rows: [], unavailable: 0 })
  t.alike(confirmFollows({ kind: 'seguidores', author: A, items: [null, 7, { key: B, seq: 2 }] }), { rows: [], unavailable: 3 })
})

test('mergeRows appends new keys, keeps identity when nothing is added', async (t) => {
  const { mergeRows } = await load()
  const current = [{ key: B, seq: 1, at: AT }]
  const merged = mergeRows(current, [{ key: B, seq: 5, at: AT }, { key: C, seq: 2, at: AT }, { key: C, seq: 3, at: AT }])
  t.alike(merged, [{ key: B, seq: 1, at: AT }, { key: C, seq: 2, at: AT }])
  t.is(mergeRows(current, []), current)
  t.is(mergeRows(current, [{ key: B, seq: 9 }]), current)
  t.is(mergeRows(current, null), current)
  t.alike(mergeRows(null, [{ key: C, seq: 2 }, null]), [{ key: C, seq: 2 }])
})

test('nextCursor: a valid next that moves, as a copy', async (t) => {
  const { nextCursor } = await load()
  const next = { atMs: 1760000000000, key: C }
  const got = nextCursor(null, next)
  t.alike(got, next)
  t.not(got, next, 'a copy')
  t.is(nextCursor({ atMs: 1760000000000, key: C }, next), null, 'same cursor')
  t.alike(nextCursor({ atMs: 1, key: C }, next), next)
  t.alike(nextCursor(null, { atMs: 0, key: B }), { atMs: 0, key: B })
  for (const bad of [null, undefined, 'x', { atMs: -1, key: C }, { atMs: 1.5, key: C }, { atMs: 1, key: 'zz'.repeat(32) }, []]) {
    t.is(nextCursor(null, bad), null, JSON.stringify(bad))
  }
})

test('strings, countLabel, notesOf and errorFor', async (t) => {
  const { PESSOAS_TITLE, COUNT_LABEL, NOT_HOSTED, INCOMPLETE_NOTE, COUNTS_INCOMPLETE_NOTE, SEEDER_DOWN, MORE_FAILED, END_TEXT, KINDS, isKind, countLabel, notesOf, errorFor } = await load()
  const engagers = await import('../src/engagers.js')
  t.alike(PESSOAS_TITLE, { seguindo: 'Seguindo', seguidores: 'Seguidores' })
  t.alike(COUNT_LABEL, { seguindo: 'seguindo', seguidores: 'seguidores' })
  t.is(NOT_HOSTED, 'Disponível no site da associação ou no app ligado à instalação.')
  t.is(INCOMPLETE_NOTE, 'A lista pode estar incompleta.')
  t.is(COUNTS_INCOMPLETE_NOTE, 'A contagem pode estar incompleta.')
  t.is(SEEDER_DOWN, engagers.SEEDER_DOWN)
  t.is(MORE_FAILED, engagers.MORE_FAILED)
  t.is(END_TEXT, engagers.END_TEXT)
  t.alike(KINDS, ['seguindo', 'seguidores'])
  t.ok(isKind('seguindo') && isKind('seguidores') && !isKind('Seguindo'))
  t.is(countLabel(0), '0 pessoas')
  t.is(countLabel(1), '1 pessoa')
  t.is(countLabel(12), '12 pessoas')
  t.is(countLabel(-1), '')
  t.is(countLabel('3'), '')
  t.alike(notesOf({ indexing: true, complete: false, unavailable: 1 }), ['Ainda montando a lista completa…', '1 pessoa indisponível'])
  t.alike(notesOf({ complete: false, unavailable: 3 }), [INCOMPLETE_NOTE, '3 pessoas indisponíveis'])
  t.alike(notesOf({ complete: true, unavailable: 0 }), [])
  t.alike(notesOf(), [])
  t.alike(notesOf(null), [])
  t.is(errorFor('network'), SEEDER_DOWN)
  t.is(errorFor('timeout'), SEEDER_DOWN)
  t.is(errorFor('not-found'), 'Esta lista não está disponível agora.')
  t.is(errorFor('rate-limited'), 'Muitas consultas ao semeador agora. Tente de novo em alguns segundos.')
  t.is(errorFor('malformed'), 'Não foi possível carregar a lista.')
  t.is(errorFor(), 'Não foi possível carregar a lista.')
})

test('pessoas.js imports nothing from react, react-native or node built-ins', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pessoas.js'), 'utf8')
  const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  t.ok(specs.length > 0)
  for (const s of specs) {
    t.ok(s.startsWith('./'), 'relative import only: ' + s)
    t.absent(/^(react|react-native|node:)/.test(s), s)
  }
  t.absent(/\brequire\s*\(/.test(src), 'no require')
})

test('people lists use the search pill, a help button and a follow failure toast', (t) => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/screens', f), 'utf8')
  const pessoas = read('Pessoas.js')
  const seguindo = read('Seguindo.js')
  for (const src of [pessoas, seguindo]) {
    t.ok(/<SearchField\b/.test(src))
    t.absent(/<Field\b/.test(src))
    t.ok(/<HelpButton doc=\{FILTER_HELP\}/.test(src))
    t.absent(/<Soft>\{FILTER_HINT\}<\/Soft>/.test(src))
  }
  t.absent(/<SectionHeader/.test(seguindo), 'no repeated title')
  t.ok(/accessibilityLabel=\{who\.known \? 'denunciar '/.test(seguindo), 'report control stays')
  const fail = pessoas.slice(pessoas.indexOf('const doFollow'), pessoas.indexOf('const doUnfollow'))
  t.ok(/notify\(FOLLOW_FAILED\(r\)\)\s*\n\s*loadFollows\(\)/.test(fail), 'toast then re-read, no resend')
  t.is((fail.match(/request\('follow\.add'/g) || []).length, 1)
})

test('two follow presses in one tick send once, never toast and keep the first pending key', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Pessoas.js'), 'utf8')
  const code = src.slice(src.indexOf('const doFollow = async'), src.indexOf('const doUnfollow'))
  const pending = []
  const toasts = []
  const sent = []
  let reads = 0
  let release
  // Same contract as useAction.run: a call while busy returns without sending.
  let busy = false
  const follow = {
    run: async (fn) => {
      if (busy) return { ok: false, uncertain: false }
      busy = true
      try { return { ok: true, value: await fn() } } finally { busy = false }
    }
  }
  const build = new Function('own', 'followBusy', 'setDone', 'setPendingKey', 'follow', 'request', 'markKnown', 'displayText', 'whoOf', 'notify', 'FOLLOW_FAILED', 'loadFollows', 'onFollowsChanged', code + '; return doFollow') // eslint-disable-line no-new-func
  const doFollow = build('me', { current: false }, () => {}, (k) => pending.push(k), follow,
    (m, p) => { sent.push(p.key); return new Promise((resolve) => { release = () => resolve({ changed: true }) }) },
    () => {}, (x) => x, () => ({ title: 'Ana' }), (m) => toasts.push(m), () => 'falhou', () => { reads++ }, null)
  const first = doFollow({ author: 'a' })
  const second = doFollow({ author: 'b' })
  await second
  t.alike(sent, ['a'], 'one request')
  t.alike(pending, ['a'], 'the second press touched nothing')
  t.is(toasts.length, 0, 'no failure toast')
  t.is(reads, 0, 'no re-read')
  release()
  await first
  t.alike(pending, ['a', null], 'cleared by its own answer')
  t.alike(toasts, ['Agora você segue Ana.'])
})
