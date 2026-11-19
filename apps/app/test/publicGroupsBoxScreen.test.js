'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const diario = read('src/screens/Diario.js')
const membro = read('src/screens/Membro.js')
const hook = read('src/usePublicGroups.js')
const app = read('App.js')

const NOTE = 'É isto que qualquer pessoa vê no seu perfil: grupos públicos de entrada aberta, sem a Geral de cada comunidade. Para esconder, use Ajustes, em Privacidade e segurança.'

test('both screens import the box and the hook', (t) => {
  for (const [name, src] of [['Diario', diario], ['Membro', membro]]) {
    t.ok(src.includes("import { PublicGroupsBox } from '../ui/PublicGroupsBox'"), name + ' PublicGroupsBox')
    t.ok(src.includes("import { usePublicGroups } from '../usePublicGroups'"), name + ' usePublicGroups')
    t.ok(/onOpenCommunity, onOpenGroup,/.test(src), name + ' takes onOpenGroup next to onOpenCommunity')
  }
})

test('Membro shows the public groups only where hostedHere allows', (t) => {
  const boxes = membro.match(/<PublicGroupsBox[^>]*>/g) || []
  t.is(boxes.length, 1, 'one box')
  t.ok(boxes[0].includes("title='Grupos públicos'"), 'title')
  t.ok(boxes[0].includes('onOpen={onOpenGroup}'), 'opens the group')
  t.ok(/usePublicGroups\(author, \{ enabled: hostedHere && !own,/.test(membro), 'gated on hostedHere and not the own profile')
  t.ok(membro.includes('const hostedHere = node.hosted === true && !isPage && !blockedHere'), 'hostedHere excludes pages and blocked profiles')
  t.ok(/useMemo\(\(\) => \(\{ tick, groupVersions \}\), \[tick, groupVersions\]\)/.test(membro), 'reads again on refresh and group change')
  // The box sits after the communities in common, inside the same wrapper.
  const common = membro.indexOf("<CommunitiesBox items={common} title='Comunidades em comum'")
  const box = membro.indexOf('<PublicGroupsBox')
  t.ok(common > 0 && box > common, 'after the communities in common')
  t.ok(box < membro.indexOf('<Segmented options={tabs}', common), 'before the tabs')
  t.is((membro.match(/<CommunitiesBox/g) || []).length, 1, 'still one CommunitiesBox')
})

test('Diario shows the own public groups with the note, nothing when hidden', (t) => {
  const boxes = diario.match(/<PublicGroupsBox[^>]*>/g) || []
  t.is(boxes.length, 1, 'one box')
  t.ok(boxes[0].includes("title='Seus grupos públicos'"), 'title')
  t.ok(boxes[0].includes("note='" + NOTE + "'"), 'note')
  t.ok(boxes[0].includes('items={publicGroups.rows}'), 'rows from the hook')
  t.ok(diario.includes('{publicGroups.hidden || typeof onOpenGroup !== \'function\''), 'hidden renders nothing')
  t.ok(/usePublicGroups\(ownPublicKey, \{ enabled: node\.hosted === true, version: publicGroupsVersion \}\)/.test(diario), 'own diary, hosted only')
  const start = diario.indexOf('const publicGroupsVersion = useMemo(')
  t.ok(start > 0, 'version memo')
  const memo = diario.slice(start, diario.indexOf('])', start) + 2)
  t.ok(memo.includes('groupVersions'), 'version mentions groupVersions')
  t.ok(/\[refresh, pulls, active, groupVersions\]/.test(memo), 'same signals as community.list')
  const communities = diario.indexOf("<CommunitiesBox items={communities} title='Suas comunidades'")
  t.ok(communities > 0 && diario.indexOf('<PublicGroupsBox') > communities, 'after the own communities')
  t.is((diario.match(/<CommunitiesBox/g) || []).length, 1, 'still one CommunitiesBox')
})

test('App passes openGroup to the profiles', (t) => {
  t.ok(app.includes('onOpenGroup: openGroup'), 'screen props')
  const start = app.indexOf('<Diario\n')
  t.ok(start > 0, 'Diario element')
  const el = app.slice(start, app.indexOf('/>', start))
  t.ok(el.includes('onOpenGroup={openGroup}'), 'Diario gets openGroup')
})

test('the hook reads pages after the block list, never one group at a time', (t) => {
  t.ok(hook.includes("import { useBlocks } from './blocksProvider'"), 'imports useBlocks')
  t.ok(hook.includes("import { fetchPublicGroups } from './indexClient'"), 'fetchPublicGroups')
  t.ok(hook.includes("import { visibleRows } from './groupShelves'"), 'visibleRows')
  t.absent(hook.includes('fetchGroup('), 'no per-group read')
  t.ok(hook.includes("blocks.loadState === 'ok'"), 'waits for the loaded list')
  t.ok(hook.includes('blocked.has(diary)'), 'no read for a blocked diary')
  t.ok(hook.includes('const PAGES_MAX = 2'), 'two pages at most')
  t.ok(hook.includes('if (!res || res.ok !== true) return NONE'), 'any failure is no list')
  t.ok(hook.includes('if (res.value.hidden) return HIDDEN'), 'hidden answer')
  t.ok(hook.includes('if (gen.current === mine)'), 'stale answers dropped')
  t.absent(/complete/.test(hook.replace(/^\/\/.*$/gm, '')), 'complete: false never reads again')
})

// The sort runs in Node: lifted from the hook source, which cannot load here.
function loadSort () {
  const start = hook.indexOf('export function sortPublicGroups')
  const end = hook.indexOf('\n}\n', start)
  const src = hook.slice(start, end + 2).replace('export function', 'function')
  return new Function(src + '\nreturn sortPublicGroups')() // eslint-disable-line no-new-func
}

test('sortPublicGroups orders by name in pt-BR, ties by group key', (t) => {
  const sort = loadSort()
  const k = (n) => n.toString(16).padStart(64, '0')
  const rows = [
    { group: k(3), name: 'Zé' },
    { group: k(2), name: 'ética' },
    { group: k(1), name: 'Árvore' },
    { group: k(5), name: 'banda' },
    { group: k(4), name: 'banda' }
  ]
  const out = sort(rows)
  t.alike(out.map((r) => r.name), ['Árvore', 'banda', 'banda', 'ética', 'Zé'])
  t.alike(out.slice(1, 3).map((r) => r.group), [k(4), k(5)], 'ties by key')
  t.is(rows[0].name, 'Zé', 'input untouched')
})
