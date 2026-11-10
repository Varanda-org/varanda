'use strict'

// Conversas (group rows) and Comunidades (Minhas comunidades) paint their
// stored snapshots (src/screenSnapshot.js) on a cold start and store the
// next complete live list. Both screens load react-native, so the wiring is
// checked on their text; the module-level helpers run here on their own
// source, with the store and liveBinding stubbed.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const CONVERSAS = fs.readFileSync(path.join(APP, 'src/screens/Conversas.js'), 'utf8')
const COMUNIDADES = fs.readFileSync(path.join(APP, 'src/screens/Comunidades.js'), 'utf8')

const OWN = 'aa'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const C1 = '11'.repeat(32)
const G1 = '33'.repeat(32)
const G2 = '44'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' })

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `function <name> (...) { ... }`, braces matched.
function fnText (src, name) {
  let start = src.indexOf('\nfunction ' + name + ' (')
  if (start < 0) {
    start = src.indexOf('\nexport function ' + name + ' (')
    if (start >= 0) start += 'export '.length
  }
  if (start < 0) throw new Error('no function ' + name)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

function helper (code, name, deps, extra = []) {
  const names = Object.keys(deps)
  const body = extra.map((n) => fnText(code, n)).concat(fnText(code, name)).join('\n')
  // eslint-disable-next-line no-new-func
  return new Function(...names, body + '\nreturn ' + name)(...names.map((k) => deps[k]))
}

const CONV = withoutComments(CONVERSAS)
const COM = withoutComments(COMUNIDADES)
const groupHook = fnText(CONV, 'useGroupRows')
const inboxHook = fnText(CONV, 'useInbox')
const conversas = fnText(CONV, 'Conversas')
const comunidades = fnText(COM, 'Comunidades')

const liveBinding = (ownKey, config) => (config && config.association ? { origin: ORIGIN, association: config.association, owner: ownKey.toLowerCase() } : null)
const nodeOf = (status, config = { association: ASSOC }) => ({ passkey: status === null ? null : { status }, config })
const UNLOCKED = { unlocked: true, signedOut: false, publicKey: OWN }

test('the binding exists only for the unlocked member acting as the member', (t) => {
  const bind = helper(COM, 'memberSnapshotBinding', { liveBinding })
  t.alike(bind({ node: nodeOf(UNLOCKED), acting: ME, pageKey: null }), { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME })
  t.is(bind({ node: nodeOf(UNLOCKED), acting: PAGE, pageKey: PAGE.key }), null, 'acting as a page')
  t.is(bind({ node: nodeOf(UNLOCKED), acting: ME, pageKey: PAGE.key }), null, 'a page key on screen')
  t.is(bind({ node: nodeOf(UNLOCKED), acting: PAGE, pageKey: null }), null, 'a page actor with pages off')
  t.is(bind({ node: nodeOf({ ...UNLOCKED, unlocked: false }), acting: ME, pageKey: null }), null, 'locked')
  t.is(bind({ node: nodeOf({ ...UNLOCKED, signedOut: true }), acting: ME, pageKey: null }), null, 'signed out')
  t.is(bind({ node: nodeOf(null), acting: ME, pageKey: null }), null, 'no passkey identity')
  t.is(bind({ node: nodeOf(UNLOCKED, null), acting: ME, pageKey: null }), null, 'no configuration (the Vitrine)')
})

test('a read is stored only under the identity it began with', (t) => {
  const same = helper(COM, 'sameSnapshotBinding', {})
  const b = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME }
  t.ok(same(b, { ...b }))
  t.absent(same(b, null), 'locked or a page since')
  t.absent(same(null, b), 'began without a binding')
  t.absent(same(b, { ...b, owner: 'bb'.repeat(32) }), 'another owner')
})

test('a refused list removes the stored one; a good one is saved with the generation', (t) => {
  const calls = []
  const deps = {
    buildScreenSnapshot: (kind, input) => (input.rows.length === 0 ? null : { kind, input }),
    clearScreenSnapshot: (kind) => calls.push(['clear', kind]),
    saveScreenSnapshot: (kind, snap, gen) => calls.push(['save', kind, gen])
  }
  const save = helper(COM, 'saveGroupSnapshot', deps)
  const b = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME }
  save('comunidades', null, [{}], 1)
  save('comunidades', b, [], 1)
  save('conversasGrupos', b, [{}], 7)
  t.alike(calls, [['clear', 'comunidades'], ['save', 'conversasGrupos', 7]])
})

test('Conversas seeds the group rows with loaded false and still reads live', (t) => {
  t.ok(/useState\(\(\) => \(enabled \? seededGroups\(binding\) : NO_GROUPS\)\)/.test(groupHook), 'seeded in the first render')
  t.ok(/const NO_GROUPS = \{ rows: \[\], loaded: false,/.test(CONV), 'the seed keeps loaded false')
  t.ok(/readGroupSnapshot\('conversasGrupos', binding\)/.test(fnText(CONV, 'seededGroups')))
  t.ok(groupHook.includes("requestRef.current('community.list', {})"), 'community.list still runs')
  t.ok(groupHook.includes("requestRef.current('community.info', { community: c.community })"), 'community.info still runs')
  const effect = groupHook.slice(groupHook.indexOf('if (enabled) {'))
  t.ok(effect.indexOf('seededGroups(bindingRef.current)') < effect.indexOf('load()'), 'seeded then read')
  t.ok(groupHook.includes("perfMarks().mark('rows-snapshot:conversas')"))
  t.ok(groupHook.includes("perfMarks().mark('rows-live:conversas')"))
})

test('Conversas stores only a complete group list, guarded by the generation', (t) => {
  const saves = CONV.match(/saveGroupSnapshot\(/g) || []
  t.is(saves.length, 1, 'one save in the file')
  const line = groupHook.split('\n').find((l) => l.includes('saveGroupSnapshot('))
  t.ok(line, 'the save is in the group hook')
  t.ok(/!partial && sameSnapshotBinding\(snapshotBinding, bindingRef\.current\)/.test(line), 'not partial, same identity')
  t.ok(line.includes("saveGroupSnapshot('conversasGrupos', snapshotBinding, rows, cacheGen)"))
  const load = groupHook.slice(groupHook.indexOf('const load = useCallback'))
  t.ok(load.indexOf('const cacheGen = cacheGeneration()') < load.indexOf("'community.list'"), 'generation read before the list')
})

test('the DM inbox is never seeded nor stored', (t) => {
  t.absent(/snapshot|Snapshot|cacheGeneration/.test(inboxHook), 'nothing of the snapshots in useInbox')
  t.absent(/screenSnapshotStore|saveScreenSnapshot|buildScreenSnapshot/.test(CONV), 'Conversas never touches the store directly')
  // Only `rows` of the group read reaches a save; the dm.list answer (r,
  // inbox.rows, merged) never does.
  for (const m of CONV.matchAll(/saveGroupSnapshot\(([^)]*)\)/g)) t.absent(/inbox|dm|merged|\br\b/.test(m[1]), 'save args: ' + m[1])
})

test('Conversas binds the snapshot to the member, never a page', (t) => {
  t.ok(conversas.includes('memberSnapshotBinding({ node, acting, pageKey })'))
  t.ok(/useGroupRows\(\{ enabled: hosted && allowed && pageKey === null,[^}]*binding: snapshotBinding \}\)/.test(conversas))
})

test('Comunidades seeds from the snapshot, saves only the member list', (t) => {
  t.ok(comunidades.includes('memberSnapshotBinding({ node, acting, pageKey })'))
  t.ok(/readGroupSnapshot\('comunidades', snapshotBinding\)/.test(comunidades), 'seeded in the first render')
  t.ok(/rows: rows === null \? \[\] : rows, loaded: false,/.test(comunidades), 'loaded stays false')
  const load = comunidades.slice(comunidades.indexOf('const load = useCallback'))
  const pageBranch = load.slice(0, load.indexOf("'community.list'"))
  t.absent(pageBranch.includes('saveGroupSnapshot'), 'the page branch never saves')
  t.ok(pageBranch.indexOf('const gen = cacheGeneration()') > pageBranch.indexOf('if (pageKey !== null)'), 'generation read for the member list')
  t.ok(load.includes("if (sameSnapshotBinding(binding, bindingRef.current)) saveGroupSnapshot('comunidades', binding, rows, gen)"))
  t.ok(comunidades.includes("perfMarks().mark('rows-snapshot:comunidades')"))
  t.ok(comunidades.includes("perfMarks().mark('rows-live:comunidades')"))
})

test('a stored private group shows the placeholder, Geral its community name, no unread', async (t) => {
  const snap = await import('../src/screenSnapshot.js')
  const { mergeRows } = await import('../src/conversas.js')
  const live = [
    { group: G1, community: C1, role: 'member', general: true, name: 'Geral', title: 'Bairro', visibility: 'public', unread: 5, last: { name: 'x', preview: 'segredo', at: '2026-11-01T00:00:00.000Z' } },
    { group: G2, community: C1, role: 'member', general: false, name: 'Segredo', visibility: 'private', unread: 3, last: null }
  ]
  const built = snap.buildScreenSnapshot('conversasGrupos', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, rows: live })
  const text = JSON.stringify(built)
  t.absent(text.includes('Segredo'), 'no private name')
  t.absent(text.includes('segredo') || text.includes('unread'), 'no preview, no count')
  const parsed = snap.parseScreenSnapshot(text, 'conversasGrupos', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME })
  const seedRow = helper(CONV, 'seedRow', {})
  const rows = mergeRows({ groups: parsed.body.rows.map(seedRow) })
  const byGroup = Object.fromEntries(rows.map((r) => [r.group, r]))
  t.is(byGroup[G1].title, 'Bairro')
  t.is(byGroup[G2].title, 'Grupo', 'the placeholder')
  t.is(byGroup[G1].unread + byGroup[G2].unread, 0)
  t.is(snap.buildScreenSnapshot('conversasGrupos', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: PAGE, rows: live }), null, 'a page actor builds none')
})

test('a stored group row is marked in memory only', async (t) => {
  const seedRow = helper(CONV, 'seedRow', {})
  const row = seedRow({ community: C1, group: G2, role: 'member', general: false, name: null })
  t.is(row.seeded, true)
  t.absent('name' in row || 'title' in row || 'at' in row || 'last' in row || 'unread' in row)
  const snap = await import('../src/screenSnapshot.js')
  const built = snap.buildScreenSnapshot('conversasGrupos', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, rows: [{ ...row, visibility: 'public' }] })
  t.alike(Object.keys(built.body.rows[0]).sort(), ['community', 'general', 'group', 'name', 'role'], 'the flag is never stored')
})

test('the dm.list paging window never drops a stored group row', (t) => {
  t.ok(conversas.includes('const storedGroupIds = useMemo(() => new Set(groups.rows.filter((r) => r.seeded === true).map((r) => r.group)), [groups.rows])'))
  const paged = conversas.slice(conversas.indexOf('const paged = useMemo'))
  t.ok(paged.slice(0, paged.indexOf('Date.parse(row.at)')).includes("if (row.kind !== 'group' || storedGroupIds.has(row.group)) return true"), 'kept before the time test')
})

test('a partial load keeps the stored rows of the communities it missed', (t) => {
  const load = groupHook.slice(groupHook.indexOf('const load = useCallback'))
  t.ok(/catch \{\s*partial = true\s*missed\.add\(c\.community\)/.test(load), 'a thrown community.info is missed')
  t.ok(load.includes('if (!info || info.incomplete === true) missed.add(c.community)'), 'an empty or incomplete answer is missed')
  t.ok(load.includes('rows: partial ? withMissedSeeds(rows, s.rows, missed) : rows,'), 'complete replaces all, partial keeps missed stored rows')
  const merge = helper(CONV, 'withMissedSeeds', {})
  const C2 = '22'.repeat(32)
  const G3 = '55'.repeat(32)
  const live = [{ group: G1, community: C1, role: 'member', unread: 2 }]
  const shown = [
    { group: G1, community: C1, role: 'member', seeded: true },
    { group: G2, community: C1, role: 'member', seeded: true },
    { group: G3, community: C2, role: 'member', seeded: true },
    { group: '66'.repeat(32), community: C1, role: 'member' }
  ]
  t.alike(merge(live, shown, new Set([C1])).map((r) => r.group), [G1, G2], 'incomplete C1: live G1 wins, stored G2 kept, C2 answered in full')
  t.is(merge(live, shown, new Set([C1]))[0].unread, 2, 'the live row')
  const line = groupHook.split('\n').find((l) => l.includes('saveGroupSnapshot('))
  t.ok(line.includes("saveGroupSnapshot('conversasGrupos', snapshotBinding, rows, cacheGen)"), 'only live rows are saved')
})
