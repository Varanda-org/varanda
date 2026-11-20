'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const diario = read('screens/Diario.js')
const membro = read('screens/Membro.js')
const box = read('ui/CommunitiesBox.js')

test('both screens import the box and the communities module', (t) => {
  for (const [name, src] of [['Diario', diario], ['Membro', membro]]) {
    t.ok(/import \{ CommunitiesBox \} from '\.\.\/ui\/CommunitiesBox'/.test(src), name + ' CommunitiesBox')
    t.ok(/from '\.\.\/communitiesBox'/.test(src), name + ' communitiesBox module')
    t.ok(src.includes('<CommunitiesBox'), name + ' renders the box')
  }
})

test('both screens read communities only on a hosted node', (t) => {
  for (const [name, src] of [['Diario', diario], ['Membro', membro]]) {
    t.ok(src.includes('node.hosted !== true'), name + ' hosted gate')
    t.ok(src.includes("request('community.list', {})"), name + ' community.list')
  }
})

test('Diario shows the own list', (t) => {
  t.ok(diario.includes("title='Suas comunidades'"), 'title')
  t.ok(diario.includes('setCommunities(communitiesOf(res))'), 'own admitted list')
})

test('Diario re-reads its communities on activation and on group changes', (t) => {
  const start = diario.indexOf('const [communities, setCommunities] = useState([])')
  t.ok(start > 0, 'communities state')
  const effect = diario.slice(start, diario.indexOf('// Replaces the rows with the newest page', start))
  t.ok(effect.includes('const groupVersions = node.groupVersions'), 'group version signal')
  t.ok(effect.includes('if (!active) return'), 'reads only while active')
  t.ok(/\}, \[node\.hosted, request, refresh, pulls, active, groupVersions\]\)/.test(effect), 'deps include active and groupVersions')
  t.ok(effect.includes('clearTimeout(timer)'), 'coalesced reads are cancelled')
  t.ok(effect.includes('() => {})'), 'errors swallowed')
})

test('Membro shows only the communities in common, never the full list', (t) => {
  t.ok(membro.includes("title='Comunidades em comum'"), 'title')
  t.absent(membro.includes('Suas comunidades'), 'no own-list title')
  t.ok(membro.includes('commonCommunities(own, byCommunity, author).items'), 'in-common rule')
  t.ok(membro.includes('own.slice(0, MAX_COMMON_LOOKUPS)'), 'bounded lookups')
  t.ok(membro.includes("request('community.members', { community: item.community, offset, limit: MEMBERS_PAGE })"), 'members read')
  // The box only ever gets the in-common state.
  const boxes = membro.match(/<CommunitiesBox[^>]*>/g) || []
  t.is(boxes.length, 1, 'one box')
  t.ok(boxes[0].includes('items={common}'), 'items are the in-common list')
  t.absent(/setCommon\(\s*(own|communitiesOf)/.test(membro), 'never the person\'s list')
  t.absent(/items=\{\s*communitiesOf/.test(membro), 'no communitiesOf straight to the box')
  t.ok(membro.includes('ownProfile'), 'not on the own profile')
})

test('Membro posts reach the private reply', (t) => {
  t.ok(/const handlers = \{[^}]*\bonMessage\b[^}]*\}/.test(membro), 'handlers include onMessage')
})

test('the box shows names through displayText and hides when empty', (t) => {
  t.ok(box.includes('displayText(item.name)'), 'displayText')
  t.ok(box.includes('if (list.length === 0) return null'), 'hidden when empty')
  t.ok(box.includes("name='gente'"), 'gente icon')
  t.ok(box.includes("'Ver todas ('"), 'Ver todas')
})

// The paging helper runs in Node: lifted from the screen source, which cannot load here.
function loadPageStep () {
  const start = membro.indexOf('export function membersPageStep')
  const end = membro.indexOf('\n}\n', start)
  const src = membro.slice(start, end + 2).replace('export function', 'function')
  return new Function(src + '\nreturn membersPageStep')() // eslint-disable-line no-new-func
}

const key = (n) => n.toString(16).padStart(64, '0')
const PERSON = key(250)
const page = (from, count) => Array.from({ length: count }, (_, i) => ({ member: key(from + i), banned: false }))

// Drives the step like the screen: serial pages, at most `max` of them.
function scan (step, rows, person, max) {
  const hits = []
  let offset = 0
  let reads = 0
  for (let n = 0; n < max && offset !== null; n++) {
    reads++
    const s = step({ members: rows.slice(offset, offset + 100), total: rows.length }, person, offset)
    hits.push(...s.hits)
    offset = s.next
  }
  return { hits, reads }
}

test('Membro pages community.members until the person is found', (t) => {
  t.ok(membro.includes('const MEMBERS_PAGES_MAX = 10'), 'page cap named')
  t.ok(membro.includes('page < MEMBERS_PAGES_MAX && offset !== null'), 'loop bounded by the cap')
  t.ok(membro.includes('const step = membersPageStep(res, author, offset)'), 'loop uses the step')
  t.ok(membro.includes('byCommunity.set(item.community, rows)'), 'only the rows read')
  const step = loadPageStep()
  const rows = page(0, 300)
  const found = scan(step, rows, PERSON, 10)
  t.is(found.hits.length, 1, 'person on the third page is found')
  t.is(found.hits[0].member, PERSON)
  t.is(found.reads, 3, 'stops on the page that has the person')
})

test('membersPageStep stops when the person cannot be on a later page', (t) => {
  const step = loadPageStep()
  // Last key on the first page sorts after the person: one read, not found.
  const after = scan(step, page(300, 400), PERSON, 10)
  t.is(after.reads, 1)
  t.is(after.hits.length, 0)
  // Offset reaches total.
  const short = scan(step, page(0, 150), key(999), 10)
  t.is(short.reads, 2)
  t.is(short.hits.length, 0)
  t.is(step({ members: page(0, 100), total: 100 }, key(999), 0).next, null, 'end of list')
  t.is(step({ members: page(0, 100), total: 500 }, key(999), 0).next, 100, 'next offset')
  t.is(step({ members: [], total: 500 }, key(999), 100).next, null, 'empty page')
  t.is(step(null, key(999), 0).next, null, 'bad answer')
  // Uppercase keys compare as lowercase hex.
  t.is(step({ members: [{ member: key(300).toUpperCase() }], total: 500 }, PERSON, 0).next, null, 'case-insensitive order')
})

test('membersPageStep fails closed past the page cap', (t) => {
  const step = loadPageStep()
  const far = page(0, 2000)
  const person = key(1500)
  const capped = scan(step, far, person, 10)
  t.is(capped.reads, 10, 'never more than the cap')
  t.is(capped.hits.length, 0, 'not in common')
})

test('Membro reads the in-common box again when group versions change', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Membro.js'), 'utf8')
  t.ok(src.includes('const groupVersions = node.groupVersions'), 'reads the group version signal')
  t.ok(src.includes('request, author, tick, groupVersions])'), 'the effect depends on it')
  t.ok(src.includes('clearTimeout(timer)'), 'a pending read is cancelled')
  t.ok(src.includes('if (commonFor.current !== author)'), 'cleared only for another profile, no flicker on refresh')
})

test('community chips grow with large text instead of cutting the name', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'CommunitiesBox.js'), 'utf8')
  t.ok(src.includes('minHeight: 40,') && !/\bheight: 40,/.test(src.replace('minHeight: 40,', '')), 'no fixed chip height')
  t.ok(src.includes('paddingBottom: space.sm'), 'the strip keeps a gap above the tabs')
})

test('a community chip wraps a long name instead of cutting it', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'CommunitiesBox.js'), 'utf8')
  t.absent(src.includes('maxWidth: 280'), 'no narrow fixed cap')
  t.ok(src.includes('width - 2 * space.lg') && src.includes('<Text style={styles.chipText} numberOfLines={2}>'), 'nearly full width, two lines')
})
