'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/conversas.js')
const at = '2026-11-05T12:00:00.000Z'

test('mergeRows interleaves conversations and groups by newest instant without changing inputs', async (t) => {
  const { mergeRows } = await load()
  const dm = Object.freeze({ peer: 'ana', name: 'Ana', preview: 'Oi', mine: true, at, unread: true })
  const group = Object.freeze({
    group: 'jardim',
    name: 'Jardim',
    community: 'bairro',
    unread: 3,
    last: Object.freeze({ preview: 'Até amanhã', name: 'Bia', at: '2026-11-05T13:00:00.000Z' })
  })
  const dmConversations = Object.freeze([dm, Object.freeze({ peer: 'bia', at: '2026-11-05T11:00:00.000Z' })])
  const groups = Object.freeze([group])
  const rows = mergeRows({ dmConversations, groups })
  t.alike(rows.map((row) => row.key), ['group:jardim', 'dm:ana', 'dm:bia'])
  t.alike(rows[0], {
    kind: 'group',
    key: 'group:jardim',
    group: 'jardim',
    title: 'Jardim',
    subtitle: 'Bia: Até amanhã',
    mine: false,
    at: group.last.at,
    unread: 3,
    community: 'bairro'
  })
  t.alike(rows[1], {
    kind: 'dm', key: 'dm:ana', peer: 'ana', title: 'Ana', subtitle: 'Oi', mine: true, at, unread: true, community: null
  })
  t.is(dmConversations[0], dm)
  t.is(groups[0], group)
  t.is(rows[2].unread, false)
  t.alike(mergeRows(), [])
})

test('mergeRows uses instants rather than ISO text order and breaks timed ties by namespaced key', async (t) => {
  const { mergeRows } = await load()
  const rows = mergeRows({
    dmConversations: [
      { peer: 'z', name: 'A', at },
      { peer: 'a', name: 'Z', at: '2026-11-05T09:00:00-03:00' },
      { peer: 'old', at: '-000001-01-01T00:00:00.000Z' }
    ],
    groups: [
      { group: 'a', name: 'A', last: { at } },
      { group: 'epoch', last: { at: '1970-01-01T00:00:00.000Z' } }
    ]
  })
  t.alike(rows.map((row) => row.key), ['dm:a', 'dm:z', 'group:a', 'group:epoch', 'dm:old'])
})

test('groups without a last message follow timed rows by Portuguese title then key', async (t) => {
  const { mergeRows } = await load()
  const rows = mergeRows({
    dmConversations: [{ peer: 'timed', at }],
    groups: [
      { group: 'a', name: 'Zoológico' },
      { group: 'z', name: 'Árvores', last: null },
      { group: 'b', name: 'Árvores', last: { at: 'not-a-date' }, community: 'bairro' },
      { group: 'g', general: true }
    ]
  })
  t.alike(rows.map((row) => row.key), ['dm:timed', 'group:b', 'group:z', 'group:g', 'group:a'])
  t.alike(rows[1], {
    kind: 'group', key: 'group:b', group: 'b', title: 'Árvores', subtitle: '', mine: false, at: null, unread: 0, community: 'bairro'
  })
  t.is(rows[3].title, 'Geral')
  t.is(mergeRows({ groups: [{ group: 'x' }] })[0].title, 'Grupo')
  t.is(mergeRows({ dmConversations: [{ peer: 'f'.repeat(64), at: 'nope' }] })[0].at, null)
})

test('previews preserve raw peer text, mark own messages and respect hidden group messages', async (t) => {
  const { mergeRows } = await load()
  const rows = mergeRows({
    dmConversations: [
      { peer: 'a', name: 'Ana\u202e', preview: 'Olá\u202e', at },
      { peer: 'b', name: ' ', username: 'bia', preview: 'Oi', at },
      { peer: 'c', title: 'Nome conhecido', name: null, at }
    ],
    groups: [
      { group: 'a', last: { preview: 'Oi\nBia', mine: true, at } },
      { group: 'b', last: { preview: 'segredo', name: 'Ana', mine: true, hidden: true, at } },
      { group: 'c', last: { preview: 'Olá\u202e', username: 'bia', at } },
      { group: 'd', last: { preview: '', mine: true, at } }
    ]
  })
  t.is(rows[0].title, 'Ana\u202e')
  t.is(rows[0].subtitle, 'Olá\u202e')
  t.is(rows[1].title, '@bia')
  t.is(rows[2].title, 'Nome conhecido')
  t.is(rows[3].subtitle, 'Oi Bia')
  t.is(rows[3].mine, true)
  t.is(rows[4].subtitle, 'mensagem escondida')
  t.is(rows[4].mine, false, 'a hidden own message is not drawn as Você')
  t.is(rows[5].subtitle, 'bia: Olá\u202e')
  t.is(rows[6].subtitle, '')
})

test('own marker is the mine flag, never text, so a peer named Você differs from an own message', async (t) => {
  const { mergeRows } = await load()
  const rows = mergeRows({
    dmConversations: [{ peer: 'p'.repeat(64), preview: 'a\nb', mine: true, at }, { peer: 'q', name: 'Você', preview: 'x', at }],
    groups: [
      { group: 'own', last: { preview: 'Oi', mine: true, at } },
      { group: 'peer', last: { preview: 'Oi', name: 'Você', mine: false, at } }
    ]
  })
  const by = Object.fromEntries(rows.map((row) => [row.key, row]))
  t.is(by['group:own'].subtitle, 'Oi')
  t.is(by['group:own'].mine, true)
  t.is(by['group:peer'].subtitle, 'Você: Oi')
  t.is(by['group:peer'].mine, false)
  t.is(by['dm:' + 'p'.repeat(64)].subtitle, 'a b')
  t.is(by['dm:' + 'p'.repeat(64)].mine, true)
  t.is(by['dm:q'].mine, false)
  for (const row of rows) t.absent(row.subtitle.startsWith('Você: ') && row.mine, 'no baked marker')
})

test('rows carry raw ids and a DM without known names has a null title', async (t) => {
  const { mergeRows } = await load()
  const peer = 'a'.repeat(64)
  const [dm] = mergeRows({ dmConversations: [{ peer, at }] })
  t.is(dm.peer, peer)
  t.is(dm.title, null)
  t.is(dm.key, 'dm:' + peer)
  t.is(mergeRows({ groups: [{ id: 'g1' }] })[0].group, 'g1')
})

test('group authors follow the anti-impersonation rule of who.js', async (t) => {
  const { mergeRows } = await load()
  const author = (last) => mergeRows({ groups: [{ group: 'g', last: { preview: 'oi', at, ...last } }] })[0].subtitle
  t.is(author({ name: '@bia' }), 'bia: oi')
  t.is(author({ name: '\uff20bia' }), 'bia: oi')
  t.is(author({ name: '\u200b@bia' }), 'bia: oi')
  t.is(author({ name: '\u200b', username: 'carla' }), 'carla: oi')
  t.is(author({ name: '\u200b' }), 'oi')
  t.is(author({}), 'oi')
})

test('mergeRows keeps request conversations out of the inbox and preserves badge types', async (t) => {
  const { mergeRows } = await load()
  const rows = mergeRows({
    dmConversations: [
      { peer: 'request', folder: 'request', unread: true },
      { peer: 'other', folder: 'other' },
      { peer: 'a', folder: 'inbox', unread: 4, at },
      null, {}
    ],
    groups: [{ id: 'a', unread: true, last: { at } }, { group: 'b', unread: -1, last: { at } }, null, {}]
  })
  t.alike(rows.map((row) => row.key), ['dm:a', 'group:a', 'group:b'])
  t.alike(rows.map((row) => row.unread), [false, 0, 0])
})

test('filters select the expected conversations and pinned entries without changing their order', async (t) => {
  const { FILTERS, FILTER_LABELS, mergeRows, applyFilter, requestsRow, communitiesRow } = await load()
  t.alike(FILTERS, ['todas', 'nao-lidas', 'grupos'])
  t.alike(FILTERS.map((id) => FILTER_LABELS[id]), ['Todas', 'Não lidas', 'Grupos'])
  t.ok(Object.isFrozen(FILTERS))
  t.ok(Object.isFrozen(FILTER_LABELS))
  const rows = Object.freeze([
    requestsRow({ requests: false }),
    communitiesRow(),
    ...mergeRows({
      dmConversations: [{ peer: 'a', unread: true, at }, { peer: 'b', unread: false, at }],
      groups: [{ group: 'a', unread: 2, last: { at } }, { group: 'b', unread: 0 }]
    })
  ])
  t.alike(applyFilter(rows, 'todas'), rows)
  t.alike(applyFilter(rows, 'nao-lidas').map((row) => row.key), ['dm:a', 'group:a'])
  t.alike(applyFilter(rows, 'grupos').map((row) => row.key), ['communities', 'group:a', 'group:b'])
  t.is(applyFilter(rows, 'nao-lidas')[0], rows[2])
  for (const filter of FILTERS) t.alike(applyFilter([], filter), [])
})

test('Pedidos uses the global request dot even when the loaded page has no requests', async (t) => {
  const { requestsRow, communitiesRow, applyFilter } = await load()
  t.alike(requestsRow({ requests: true, conversations: [] }), {
    kind: 'requests', key: 'requests', title: 'Pedidos de mensagem', pinned: true, unread: true
  })
  for (const requests of [false, undefined, 3]) {
    t.is(requestsRow({ requests, conversations: [{ folder: 'inbox', unread: true }] }).unread, false)
  }
  t.is(requestsRow().unread, false)
  t.is(requestsRow(null).unread, false)
  t.alike(communitiesRow(), { kind: 'communities', key: 'communities', title: 'Comunidades', pinned: true })
  for (const unread of [false, true]) {
    const request = requestsRow({ requests: unread })
    t.alike(applyFilter([request], 'todas'), [request])
    t.alike(applyFilter([request], 'nao-lidas'), unread ? [request] : [])
    t.alike(applyFilter([request], 'grupos'), [])
  }
})

test('the pure model has no receipt or typing fields, prohibited words or em dash', async (t) => {
  const { mergeRows } = await load()
  const source = readFileSync(join(__dirname, '../src/conversas.js'), 'utf8')
  const withoutLabel = source.replaceAll("'Não lidas'", "''")
  for (const word of ['lida', 'entregue', 'digitando']) {
    t.absent(new RegExp('\\b' + word + '\\b', 'i').test(withoutLabel), word)
  }
  t.absent(source.includes('\u2014'))
  const imports = source.match(/^import .*$/gm) || []
  t.alike(imports, ["import { whoOf, UNNAMED } from './who.js'", "import { plainPreview } from './chatPreview.js'"], 'only who.js and the pure preview helper')
  t.absent(/\brequire\s*\(/.test(source), 'no runtime dependencies')
  const rows = mergeRows({
    dmConversations: [{ peer: 'a', read: true, delivered: true, typing: true }],
    groups: [{ group: 'b', read: true, delivered: true, typing: true }]
  })
  for (const row of rows) {
    const own = row.kind === 'dm' ? 'peer' : 'group'
    t.alike(Object.keys(row).sort(), ['at', 'community', own, 'key', 'kind', 'mine', 'subtitle', 'title', 'unread'].sort())
  }
})

test('group names with no visible character fall back to Geral or Grupo', async (t) => {
  const { mergeRows } = await load()
  for (const name of ['@', '\uff20', '\u200b', '\u00ad', ' @\u200b\u00ad ']) {
    const [general, plain] = mergeRows({
      groups: [{ group: 'g', name, general: true, at }, { group: 'h', name, at }]
    }).sort((a, b) => a.key < b.key ? -1 : 1)
    t.is(general.title, 'Geral', JSON.stringify(name))
    t.is(plain.title, 'Grupo', JSON.stringify(name))
  }
})

test('Comunidades separates Minhas comunidades from Descobrir and tells the search states apart', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const mine = src.indexOf('<SectionHeader>Minhas comunidades</SectionHeader>')
  const discover = src.indexOf('<SectionHeader>Descobrir</SectionHeader>')
  t.ok(mine > 0 && discover > 0, 'both headers')
  // The search goes first: a field under a long list ends up under the keyboard.
  const header = src.slice(src.indexOf('  const header = ('), src.indexOf('\n  )\n', src.indexOf('  const header = (')))
  t.ok(header.indexOf('{discover}') > 0 && header.indexOf('{discover}') < header.indexOf('{mineSection}'), 'Descobrir above Minhas comunidades')
  t.absent(src.includes('ListFooterComponent={discover}'), 'not under the rows')
  t.ok(src.includes("label='Buscar grupos públicos'"), 'the true search label stays')
  t.ok(src.includes('<Soft>O resultado abre um grupo da comunidade</Soft>'), 'one line says what a hit opens')
  t.ok(src.includes("'na comunidade ' + community"), 'each hit names its community')
  t.ok(src.includes("label='Tentar de novo' onPress={() => search.retry()}"), 'an error offers a retry')
  t.ok(src.includes('v.complete === false') && src.includes('<Soft>Alguns grupos podem faltar</Soft>'), 'an incomplete index says groups may be missing')
  t.ok(src.includes('search.unavailable'), 'an absent index is not a retryable error')
  t.absent(src.includes('Platform.OS'), 'no platform check')
})

test('a group search result shows its community and count on up to two lines', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  t.ok(src.includes('numberOfLines={metaLines}') && src.includes('metaLines={3}'), 'search meta wraps')
  t.ok(src.indexOf("label='Buscar grupos públicos'") < src.indexOf('O resultado abre um grupo da comunidade'), 'the hint follows the field')
})

test('the Comunidades list shrinks above the keyboard, so a search result can be reached', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  t.ok(src.includes("import { KeyboardForm } from './Perfil'") && src.indexOf('<KeyboardForm>') < src.indexOf('<RefreshableList') && src.indexOf('</KeyboardForm>') > src.indexOf('<RefreshableList'), 'the list sits in the keyboard form')
})

test('the group search is typed as is', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  const ui = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'index.js'), 'utf8')
  t.ok(/returnKeyType='search'\s+plain/.test(src), 'the field is plain')
  t.ok(ui.includes("mono || plain ? { autoCapitalize: 'none', autoCorrect: false, spellCheck: false }"), 'plain turns capitals and autocorrect off')
})

test('opening a community or group from Comunidades closes the search keyboard', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidades.js'), 'utf8')
  const at = (name) => src.slice(src.indexOf('const ' + name + ' = useCallback('), src.indexOf('}, [', src.indexOf('const ' + name + ' = useCallback(')))
  t.ok(at('openCommunity').includes('Keyboard.dismiss()'), 'community')
  t.ok(at('openGroup').includes('Keyboard.dismiss()'), 'group')
})
