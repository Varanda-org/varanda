'use strict'

const test = require('brittle')

const load = () => import('../src/profileSlim.js')
const OWN = 'ab'.repeat(32)
const MEMBER = 'cd'.repeat(32)
const UNKNOWN = 'ef'.repeat(32)
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const item = (author, seq, age = 1000) => ({ ref: author + ':' + seq, at: new Date(NOW - age).toISOString() })
const dataOf = () => ({ phase: 'ready', own: [item(OWN, 1), item(OWN, 2)], authors: [{ author: MEMBER, items: [item(MEMBER, 3)] }] })

test('about hints preserve displayed values in field order and cap before extras', async (t) => {
  const { aboutHint, ABOUT_LABEL, ABOUT_LABEL_OWN } = await load()
  const { aboutView } = await import('../src/profileAbout.js')
  const about = aboutView({ city: 'Recife', work: 'Artes', studies: 'Música', birthday: '04-12', interests: 'Cinema', about: 'Long text' })
  about.rows.reverse()
  t.is(ABOUT_LABEL_OWN, 'Sobre mim')
  t.is(ABOUT_LABEL, 'Sobre')
  t.is(aboutHint(about), 'Recife · Artes')
  t.is(aboutHint(about, ['', 'Extra', ' ', 'Outro'], 1), 'Recife · Extra · Outro')
  t.is(aboutHint(about, ['Extra'], 0), 'Extra')
  const birthday = about.rows.find((row) => row.key === 'birthday').value
  t.is(aboutHint(about, [], 4), 'Recife · Artes · Música · ' + birthday)
  t.is(aboutHint({ rows: [{ key: 'city', value: '' }, { key: 'work', value: 'Artes' }, { key: 'studies', value: 'Música' }] }), 'Artes · Música')
})

test('empty about and omitted fields do not enter the hint', async (t) => {
  const { aboutHint } = await load()
  for (const about of [null, undefined, {}, { rows: [] }, { about: 'Long text', rows: [{ key: 'interests', value: 'Cinema' }] }]) {
    t.is(aboutHint(about), '')
    t.is(aboutHint(about, ['Extra']), 'Extra')
  }
})

test('about entry accepts any truthy flag', async (t) => {
  const { aboutEntry } = await load()
  t.is(aboutEntry({}), false)
  t.is(aboutEntry({ about: false, mood: null, extra: '', count: 0 }), false)
  t.is(aboutEntry({ about: false, mood: true }), true)
  t.is(aboutEntry({ count: 1 }), true)
})

test('shortcuts use shared labels and filter strictly in the requested order', async (t) => {
  const { SHORTCUTS, OWN_SHORTCUTS, MEMBER_SHORTCUTS, shortcutList } = await load()
  const { SAVED_ENTRY_LABEL } = await import('../src/savedView.js')
  const { VISITAS_ENTRY_LABEL } = await import('../src/visitasView.js')
  t.alike(SHORTCUTS, {
    salvos: { icon: 'salvar', label: SAVED_ENTRY_LABEL },
    eventos: { icon: 'evento', label: 'Eventos' },
    visitas: { icon: 'olho', label: VISITAS_ENTRY_LABEL },
    recados: { icon: 'recado', label: 'Recados' },
    varandinha: { icon: 'droplet', label: 'Varandinha' },
    anuncios: { icon: 'feira', label: 'Anúncios' }
  })
  t.alike(OWN_SHORTCUTS, ['salvos', 'eventos', 'visitas', 'recados', 'varandinha'])
  t.alike(MEMBER_SHORTCUTS, ['anuncios', 'recados', 'varandinha', 'eventos'])
  t.alike(shortcutList(OWN_SHORTCUTS, { varandinha: true, visitas: true, eventos: 1, recados: 'true', salvos: false }), [
    { id: 'visitas', icon: 'olho', label: VISITAS_ENTRY_LABEL },
    { id: 'varandinha', icon: 'droplet', label: 'Varandinha' }
  ])
  t.alike(shortcutList(MEMBER_SHORTCUTS, { eventos: true, anuncios: true }), [
    { id: 'anuncios', icon: 'feira', label: 'Anúncios' },
    { id: 'eventos', icon: 'evento', label: 'Eventos' }
  ])
  t.alike(shortcutList(OWN_SHORTCUTS, {}), [])
})

test('avatar moments select own or followed items and track all seen', async (t) => {
  const { avatarMoments } = await load()
  const args = { data: dataOf(), ownKey: OWN, now: NOW, seen: [] }
  t.alike(avatarMoments({ ...args, author: OWN }), { count: 2, unseen: true })
  t.alike(avatarMoments({ ...args, author: MEMBER }), { count: 1, unseen: true })
  t.alike(avatarMoments({ ...args, author: OWN, seen: [OWN + ':1'] }), { count: 2, unseen: true })
  t.alike(avatarMoments({ ...args, author: OWN, seen: [OWN + ':1', OWN + ':2'] }), { count: 2, unseen: false })
  t.alike(avatarMoments({ ...args, author: MEMBER, seen: new Set([MEMBER + ':3']) }), { count: 1, unseen: false })
  t.is(avatarMoments({ ...args, author: UNKNOWN }), null)
})

test('avatar moments require ready data and a valid author', async (t) => {
  const { avatarMoments } = await load()
  const args = { data: dataOf(), ownKey: OWN, now: NOW, author: OWN }
  for (const phase of ['idle', 'loading', 'error', undefined]) {
    t.is(avatarMoments({ ...args, data: { ...args.data, phase } }), null)
  }
  t.is(avatarMoments({ ...args, data: null }), null)
  for (const author of [null, undefined, '', 'a'.repeat(63), 'g'.repeat(64), 123]) {
    t.is(avatarMoments({ ...args, author }), null)
  }
})

test('avatar moments exclude expired items and empty rings', async (t) => {
  const { avatarMoments } = await load()
  const data = dataOf()
  const args = { data, ownKey: OWN, now: NOW }
  data.own[0] = item(OWN, 1, 24 * 60 * 60 * 1000)
  t.alike(avatarMoments({ ...args, author: OWN, seen: [OWN + ':2'] }), { count: 1, unseen: false })
  data.authors[0].items.push(item(MEMBER, 4, 24 * 60 * 60 * 1000))
  t.alike(avatarMoments({ ...args, author: MEMBER }), { count: 1, unseen: true })
  t.is(avatarMoments({ ...args, author: OWN, now: NOW + 24 * 60 * 60 * 1000 }), null)
  t.is(avatarMoments({ ...args, author: MEMBER, now: NOW + 24 * 60 * 60 * 1000 }), null)
  data.own = []
  data.authors = []
  t.is(avatarMoments({ ...args, author: OWN }), null)
  t.is(avatarMoments({ ...args, author: MEMBER }), null)
})
