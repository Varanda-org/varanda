'use strict'

// One actions sheet per list (src/ui/PostSheetHost.js) instead of two per PostRow.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const load = () => import('../src/ui/postSheetState.js')
const count = (s, needle) => s.split(needle).length - 1

test('sheet state: show opens with the actions, close keeps them for the slide out', async (t) => {
  const { CLOSED, sheetReducer } = await load()
  const actions = [{ label: 'Apagar', onPress: () => {} }]
  const open = sheetReducer(CLOSED, { type: 'show', actions })
  t.is(open.open, true)
  t.is(open.actions, actions)
  const closed = sheetReducer(open, { type: 'close' })
  t.is(closed.open, false)
  t.is(closed.actions, actions, 'a pressed row still runs once the sheet is gone')
  t.is(sheetReducer(closed, { type: 'close' }), closed, 'closing a closed sheet changes nothing')
  t.is(sheetReducer(CLOSED, { type: 'show', actions: [] }).open, false, 'no actions, no sheet')
  t.is(sheetReducer(open, { type: 'other' }), open)
})

test('a list renders one sheet: the provider owns it and A Rua wraps each list once', (t) => {
  const host = read('ui/PostSheetHost.js')
  t.is(count(host, '<ActionsSheet'), 1, 'the provider mounts a single sheet')
  const rua = read('screens/ARua.js')
  t.is(count(rua, '<PostSheetProvider>'), 2, 'the page feed and the member feed are each wrapped')
  t.ok(rua.includes("import { PostSheetProvider } from '../ui/PostSheetHost'"))
})

test('a row hands its actions to the list sheet and mounts its own only without one', (t) => {
  const row = read('ui/PostRow.js')
  t.ok(row.includes('const host = usePostSheet()'))
  t.ok(row.includes('host.show(rowId, sheetRef.current[kind] || [])'), 'both sheets go through the host')
  t.ok(row.includes('host.refresh(rowId, sheetRef.current[hostSheet.current] || [])'), 'an open sheet gets the row\'s fresh actions')
  t.ok(row.includes('{host === null'), 'the row sheets are mounted only without a provider')
  t.is(count(row, '<ActionsSheet'), 2, 'the repost and mais sheets keep every action in the fallback')
  t.ok(row.includes('sheetRef.current = { repost: repostSheet, more: moreSheet }'), 'same action lists feed the host')
})

test('sources have no em dash', (t) => {
  for (const f of ['ui/PostSheetHost.js', 'ui/postSheetState.js']) t.absent(read(f).includes('\u2014'), f)
  t.absent(fs.readFileSync(__filename, 'utf8').includes('\u2014'))
})

test('every screen that renders PostRow sits under a PostSheetProvider, so no screen mounts per-row sheets', (t) => {
  const dir = path.join(__dirname, '../src/screens')
  const screens = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && /<PostRow\b/.test(read('screens/' + f)))
  t.ok(screens.length >= 6, 'the screens that render rows are found')
  for (const f of screens) {
    const src = read('screens/' + f)
    t.ok(/import \{ PostSheetProvider \} from '..\/ui\/PostSheetHost'/.test(src), f + ' imports the provider')
    t.ok(/<PostSheetProvider>/.test(src), f + ' mounts it around its list')
  }
})

test('sheet state: only the row that opened the sheet refreshes its actions while it is up', async (t) => {
  const { CLOSED, sheetReducer } = await load()
  const a = {}
  const b = {}
  const first = [{ label: 'Republicar', onPress: () => {} }]
  const fresh = [{ label: 'Desfazer republicação', onPress: () => {} }]
  const open = sheetReducer(CLOSED, { type: 'show', owner: a, actions: first })
  t.is(open.owner, a)
  t.is(sheetReducer(open, { type: 'refresh', owner: a, actions: fresh }).actions, fresh, 'the owner\'s render replaces the stale closures')
  t.is(sheetReducer(open, { type: 'refresh', owner: b, actions: fresh }), open, 'another row changes nothing')
  t.is(sheetReducer(open, { type: 'refresh', owner: a, actions: first }), open, 'the same list changes nothing')
  const closed = sheetReducer(open, { type: 'close' })
  t.is(sheetReducer(closed, { type: 'refresh', owner: a, actions: fresh }), closed, 'a closed sheet keeps what was pressed')
  t.is(sheetReducer(open, { type: 'refresh', owner: a, actions: [] }).open, false, 'no actions left, no sheet')
})

test('a sheet opened again during its slide out runs the pressed action at once', (t) => {
  const sheet = read('ui/ActionsSheet.js')
  const effect = sheet.slice(sheet.indexOf('  useEffect(() => {\n    if (shown) {'), sheet.indexOf('return () => clearTimeout(t)'))
  t.ok(/if \(shown\) \{\n\s+gone\.current = false\n(\s+\/\/.*\n)+\s+if \(pending\.current !== null\) flush\(\)/.test(effect), 'a reopen flushes the action of the last press')
})

test('no screen hands a list a fragment of skeleton rows: the list sets onLayout on its empty slot', (t) => {
  const dir = path.join(__dirname, '../src/screens')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    t.absent(read('screens/' + file).includes('<><SkeletonRow'), file)
  }
})
