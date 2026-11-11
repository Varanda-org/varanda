'use strict'

// Membro paints a followed author's 'membro' snapshot (src/screenSnapshot.js)
// while profile.read and the member index answer, and writes it after a live
// first page. Membro.js loads react-native, so the wiring is checked on its
// text; its module-level rule runs here on its own source.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const MEMBRO = fs.readFileSync(path.join(APP, 'src/screens/Membro.js'), 'utf8')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text from `start` through the brace that closes the one at `open`.
function blockFrom (src, start, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced at ' + start)
}

// A top-level `function <name> (...) { ... }`.
function fnText (src, name) {
  let start = src.indexOf('\nexport function ' + name + ' (')
  if (start >= 0) start += '\nexport '.length
  else start = src.indexOf('\nfunction ' + name + ' (') + 1
  if (start < 1) throw new Error('no function ' + name)
  return blockFrom(src, start, src.indexOf(') {', start) + 2)
}

// A `const <name> = useCallback(...)` body inside the component.
function callbackText (src, name) {
  const start = src.indexOf('const ' + name + ' = useCallback(')
  if (start < 0) throw new Error('no callback ' + name)
  const arrow = src.indexOf('=>', start)
  return blockFrom(src, arrow, src.indexOf('{', arrow))
}

const CODE = withoutComments(MEMBRO)
const allowed = new Function(fnText(CODE, 'membroSnapshotAllowed') + '\nreturn membroSnapshotAllowed')() // eslint-disable-line no-new-func
const seed = callbackText(CODE, 'seedSnapshot')
const save = callbackText(CODE, 'armSnapshotSave')
const drop = callbackText(CODE, 'dropSnapshotEntry')
const load = callbackText(CODE, 'load')

const ME = { kind: 'me' }
const base = { author: FOLLOW, ownKey: OWN, follows: new Set([FOLLOW]), blocked: false, page: false, acting: ME }

test('membro snapshot: only a followed person, as the member', (t) => {
  t.ok(allowed(base), 'followed author')
  t.absent(allowed({ ...base, author: STRANGER }), 'a stranger never')
  t.absent(allowed({ ...base, follows: null }), 'follow state not known yet')
  t.absent(allowed({ ...base, follows: [FOLLOW] }), 'only the node answer (a Set), never a guess')
  t.absent(allowed({ ...base, blocked: true }), 'a blocked author never')
  t.absent(allowed({ ...base, page: true }), 'a page never')
  t.absent(allowed({ ...base, acting: { kind: 'page', key: OWN } }), 'acting as a page never')
  t.absent(allowed({ ...base, acting: null }), 'unknown actor never')
  t.absent(allowed({ ...base, author: OWN, follows: new Set([OWN]) }), 'the own diary is not a membro entry')
})

test('membro snapshot: the seed waits for follow.list and runs before the live reads', (t) => {
  const rule = seed.indexOf('membroSnapshotAllowed(')
  t.ok(rule > 0 && /follows: followSet/.test(seed.slice(rule, seed.indexOf(')', rule))), 'seed checks the follow.list answer')
  t.ok(rule < seed.indexOf("loadScreenSnapshot('membro'"), 'the rule runs before the store is read')
  t.ok(/blocked: at\.blocked/.test(seed) && /page: at\.page/.test(seed), 'blocked and page are checked')
  t.ok(/acting = actingAs\.get\(\)/.test(seed), 'the current actor is checked')
  t.ok(seed.indexOf("postsRef.current.phase !== 'loading'") > 0, 'live rows are never overwritten')
  t.ok(seed.indexOf('!headerRef.current.verified') > 0, 'a live header is never overwritten')
  t.ok(/seeded: true/.test(seed), 'seeded rows are marked')
  t.ok(seed.indexOf("perfMarks().mark('rows-snapshot:membro')") > 0, 'rows-snapshot mark')

  const call = load.indexOf('seedSnapshot(set, alive)')
  t.ok(call > 0, 'load seeds from the follow.list promise')
  t.ok(/if \(!refreshing\) followsRef\.current\.then\(\(set\) => seedSnapshot\(set, alive\)\)/.test(load), 'never on a refresh')
  t.ok(/if \(!blockedHere\) \{\s*followsRef\.current = loadFollows\(\)/.test(load), 'a blocked author is not seeded (no follow read in that load)')
  t.ok(call < load.indexOf('await readProfile()'), 'seed armed before profile.read')
  t.ok(call < load.indexOf('await readPage('), 'seed armed before the member index')
  t.is(load.split('loadFollows()').length, 2, 'follow.list is read once per load, as before')
})

test('membro snapshot: saved only after a live page, still followed, generation guarded', (t) => {
  const live = load.indexOf("perfMarks().mark('rows-live:membro')")
  const arm = load.indexOf('armSnapshotSave(')
  t.ok(live > 0 && arm > live, 'armed after the live first page')
  t.ok(/if \(index\.page !== true\) armSnapshotSave\(/.test(load), 'never for a page index')
  t.ok(load.indexOf('seeded: false') > 0, 'the live page replaces the seeded rows')

  const gen = save.indexOf('const gen = cacheGeneration()')
  t.ok(gen > 0 && gen < save.indexOf('setTimeout('), 'generation read when armed')
  t.ok(/saveScreenSnapshot\('membro', snapshot, gen\)/.test(save), 'the store gets the armed generation')
  const rule = save.indexOf('membroSnapshotAllowed(')
  t.ok(rule > 0 && /follows: at\.follows/.test(save.slice(rule, save.indexOf(')', rule))), 'followed again when it fires')
  t.ok(rule < save.indexOf('buildScreenSnapshot('), 'the rule runs before the build')
  t.ok(/!headerRef\.current\.verified\) return/.test(save), 'only a live header')
  t.ok(/sessionAllowsSnapshot\(at\.passkey, ownKey\)/.test(save), 'an unlocked session of the owner')
  t.ok(/followed: at\.follows/.test(save) && /blocked: at\.blockedKeys/.test(save), 'the rules filter by follows and blocks')
})

test('membro snapshot: unfollow and block remove the entry at once', (t) => {
  t.ok(/mark\(author, on\)\s*if \(!on\) dropSnapshotEntry\(\)/.test(CODE), 'an unfollow here drops the entry')
  t.ok(/if \(blockedHere\) dropSnapshotEntry\(\)/.test(CODE), 'a block drops the entry')
  t.ok(/clearTimeout\(saveTimerRef\.current\)/.test(drop), 'a pending save is cancelled')
  t.ok(/screenWithoutAuthors\(snapshot, \[author\]\)/.test(drop), 'the author and their reposts go')
  t.ok(/acting\.kind !== 'me'\) \{\s*clearScreenSnapshot\('membro'\)/.test(drop), 'acting as a page: everything goes')
  t.ok(/Object\.keys\(next\.body\.authors\)\.length === 0 \|\| !saveScreenSnapshot\('membro', next, cacheGeneration\(\)\)\) clearScreenSnapshot\('membro'\)/.test(drop), 'an empty or failed rewrite clears')
  const toggle = CODE.slice(CODE.indexOf('const togglePageFollow = async'), CODE.indexOf('const isFollowed ='))
  t.absent(/Snapshot|snapshot/.test(toggle), 'a page follow never touches the member snapshot')
})

test('membro snapshot: page rows and seeded paging', (t) => {
  const snap = CODE.slice(CODE.indexOf('snapRef.current = {'), CODE.indexOf('useEffect(', CODE.indexOf('snapRef.current = {')))
  t.ok(/page: isPage \|\| /.test(snap), 'a page by any sign')
  t.ok(/seed\.page === true/.test(snap) && /idxHint !== null/.test(snap) && /pageRead !== null/.test(snap) && /namedPage\.page === true/.test(snap), 'seed, index, page.read and learned names count')
  t.ok(/current\.seeded \|\| current\.loadingMore/.test(CODE), 'seeded rows are never paged')
  t.ok(/if \(current\.seeded \|\| current\.atEnd/.test(CODE), 'the Mural fill waits for the live page')
  t.ok(/!seeded && !mural && !depo && !atEnd/.test(CODE), 'no load more under seeded rows')
  t.ok(/const postsReady = posts\.phase === 'ready' && !posts\.seeded/.test(CODE), 'common communities wait for the live page')
})
