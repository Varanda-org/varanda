'use strict'

// Saved Feira listings (src/feiraSaved.js and the web store). ES modules
// loaded through import(); read and write are in-memory fakes.
const test = require('brittle')

const load = () => import('../src/feiraSaved.js')
const O1 = 'https://bora.varanda.app'
const O2 = 'https://outra.example.org'
const key = (i) => i.toString(16).padStart(64, '0')
const ref = (i, seq = 1) => ({ author: key(i), seq })

function disk (initial = null) {
  const d = { raw: initial, writes: 0 }
  d.read = async () => d.raw
  d.write = async (raw) => { d.writes++; d.raw = raw }
  return d
}

test('toggle, has, list and clear', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  t.alike(await store.list(O1), [])
  t.alike(await store.toggle(O1, ref(1)), { saved: true, full: false, persisted: true })
  t.alike(await store.toggle(O1, ref(2, 5)), { saved: true, full: false, persisted: true })
  t.ok(await store.has(O1, ref(1)))
  t.absent(await store.has(O1, ref(1, 2)))
  t.alike(await store.list(O1), [ref(2, 5), ref(1)], 'newest first')
  t.alike(await store.toggle(O1, ref(1)), { saved: false, full: false, persisted: true })
  t.alike(await store.list(O1), [ref(2, 5)])
  t.ok(await store.remove(O1, ref(2, 5)))
  t.alike(await store.list(O1), [])
  await store.toggle(O1, ref(3))
  t.ok(await store.clear(O1))
  t.alike(await store.list(O1), [])

  const again = s.createSavedStore({ read: d.read, write: d.write })
  t.alike(await again.list(O1), [], 'the cleared list was persisted')
})

test('cap: at most 100 refs per origin', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk())
  for (let i = 1; i <= s.MAX_SAVED; i++) t.is((await store.toggle(O1, ref(i))).saved, true)
  t.alike(await store.toggle(O1, ref(500)), { saved: false, full: true, persisted: false })
  t.is((await store.list(O1)).length, 100)
  t.absent(await store.has(O1, ref(500)))
  t.ok((await store.toggle(O2, ref(500))).saved, 'another origin has its own cap')
  await store.toggle(O1, ref(1))
  t.ok((await store.toggle(O1, ref(500))).saved, 'room again after removing one')

  const crowded = JSON.stringify({ v: 1, origins: [{ origin: O1, refs: Array.from({ length: 150 }, (_, i) => ref(i + 1)) }] })
  t.is(s.decodeSaved(crowded).get(O1).length, 100, 'a crowded file is cut on read')
})

test('no title or other peer text is stored', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.toggle(O1, { ...ref(1), title: 'Bicicleta', text: 'segredo' })
  t.absent(d.raw.includes('Bicicleta'))
  t.absent(d.raw.includes('segredo'))
  t.alike(JSON.parse(d.raw), { v: 1, origins: [{ origin: O1, refs: [ref(1)] }] })
  const hostile = JSON.stringify({ v: 1, origins: [{ origin: O1, refs: [{ ...ref(2), title: 'x' }], note: 'y' }] })
  const back = s.createSavedStore(disk(hostile))
  await back.toggle(O1, ref(3))
  t.alike(await back.list(O1), [ref(3), ref(2)])
})

test('origin isolation', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.toggle(O1, ref(1))
  await store.toggle(O2, ref(2))
  t.alike(await store.list(O1), [ref(1)])
  t.alike(await store.list(O2), [ref(2)])
  t.absent(await store.has(O2, ref(1)))
  await store.clear(O2)
  t.alike(await store.list(O1), [ref(1)], 'clearing one origin keeps the other')
  for (const bad of ['http://bora.varanda.app', O1 + '/', 'javascript:x', null]) {
    t.alike(await store.list(bad), [])
    t.is((await store.toggle(bad, ref(9))).saved, false)
  }
  for (let i = 0; i < s.MAX_ORIGINS + 2; i++) await store.toggle('https://o' + i + '.example.org', ref(1))
  const reread = s.decodeSaved(d.raw)
  t.is(reread.size, s.MAX_ORIGINS, 'the oldest origins are forgotten')
  t.absent(reread.has(O1))
})

test('bad refs and broken storage', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk('{not json'))
  t.alike(await store.list(O1), [])
  for (const bad of [null, { author: key(1) }, { author: key(171).toUpperCase(), seq: 1 }, { author: key(1), seq: 0 }, { author: key(1), seq: '1' }]) {
    t.is((await store.toggle(O1, bad)).saved, false)
    t.is(await store.has(O1, bad), false)
  }
  const failing = s.createSavedStore({ read: async () => { throw new Error('denied') }, write: async () => { throw new Error('quota') } })
  const out = await failing.toggle(O1, ref(1))
  t.alike(out, { saved: true, full: false, persisted: false }, 'a refused write is reported')
  t.ok(await failing.has(O1, ref(1)), 'memory keeps the change for this run')
  t.alike([...s.decodeSaved(JSON.stringify({ v: 2, origins: [] }))], [])
})

test('web store persists through localStorage', async (t) => {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) }
  }
  try {
    const web = await import('../src/feiraSavedStore.web.js')
    const s = await load()
    t.ok((await web.toggleSaved(O1, ref(1))).saved)
    t.ok(await web.isSaved(O1, ref(1)))
    t.alike(await web.listSaved(O1), [ref(1)])
    t.alike(JSON.parse(map.get(s.STORAGE_KEY)), { v: 1, origins: [{ origin: O1, refs: [ref(1)] }] })
    t.ok(await web.clearSaved(O1))
  } finally {
    delete globalThis.localStorage
  }
})

test('two stores over one storage keep each other\'s saves', async (t) => {
  const s = await load()
  const d = disk()
  const tab1 = s.createSavedStore({ read: d.read, write: d.write })
  const tab2 = s.createSavedStore({ read: d.read, write: d.write })
  t.alike(await tab1.list(O1), [])
  t.alike(await tab2.list(O1), [])
  await tab1.toggle(O1, ref(1))
  await tab2.toggle(O1, ref(2))
  t.alike(s.decodeSaved(d.raw).get(O1), [ref(2), ref(1)], 'both saves are stored')
  t.alike(await tab1.list(O1), [ref(2), ref(1)], 'a read sees the other store')
  t.ok(await tab1.has(O1, ref(2)))
  await tab2.toggle(O2, ref(3))
  t.ok(await tab1.remove(O1, ref(1)))
  t.alike(await tab2.list(O1), [ref(2)], 'a remove neither resurrects nor drops the other entries')
  t.alike(await tab2.list(O2), [ref(3)])
  await tab2.toggle(O1, ref(4))
  t.ok(await tab1.clear(O2))
  t.alike(await tab1.list(O1), [ref(4), ref(2)])
  t.alike(await tab2.list(O2), [])
})

const src = (file) => require('fs').readFileSync(require('path').join(__dirname, '..', 'src', file), 'utf8')

test('ListingTile: the save star is a sibling button, drawn only with onSave', (t) => {
  const tile = src('ui/ListingTile.js')
  const pressEnd = tile.indexOf('</PressScale>')
  const main = tile.slice(tile.indexOf('<PressScale'), pressEnd)
  const guard = tile.indexOf("if (typeof onSave !== 'function') return tile")
  const star = tile.slice(tile.indexOf('<Pressable', pressEnd), tile.indexOf('</Pressable>', pressEnd))
  t.ok(guard > pressEnd, 'without onSave the tile is returned before any star')
  t.ok(star.length > 0 && tile.indexOf('<Pressable', pressEnd) > guard, 'the star comes after the guard')
  t.absent(main.includes('Salvar') || main.includes('onSave'), 'the star is not inside the main press target')
  t.ok(star.includes("accessibilityRole='button'"))
  t.ok(star.includes("accessibilityLabel={saved === true ? 'Salvo' : 'Salvar'}"), 'the label tells the state')
  t.ok(star.includes('aria-pressed={saved === true}'), 'the web button carries aria-pressed, not only aria-selected')
  t.ok(star.includes("<Icon name='estrela'") && star.includes('filled={saved === true}'), 'a filled star, not colour alone')
  t.ok(star.includes('onSave()') && !star.includes('onPress()') && !star.includes('onPress={onPress}'), 'the star calls onSave, never the tile onPress')
  t.ok(/save: \{[^}]*position: 'absolute', top: 0, right: 0, width: layout\.hit, height: layout\.hit/.test(tile), 'a 44 pt target in the top right corner')
  t.ok(/badgeRow: \{[^}]*position: 'absolute', top: space\.xs, left: space\.xs, right: layout\.hit/.test(tile), 'the status chip sits top left and stops short of the star')
  t.ok(tile.includes('<View style={styles.badgeRow}><Text style={styles.badge} numberOfLines={1}>'), 'a long status stays on one line inside its bound')
  t.ok(/badge: \{[^}]*flexShrink: 1/.test(tile), 'the chip shrinks to its bound')
})

test('Feira: one guarded toggleSaved per star press, never for own listings', (t) => {
  const screen = src('screens/Feira.js')
  const body = screen.slice(screen.indexOf('async function toggleSave'), screen.indexOf('async function openSearch'))
  t.ok(body.includes('await toggleSaved(savedOrigin, { author: listing.author, seq: listing.seq })'), 'saves under the Feira origin')
  t.is(screen.split('toggleSaved(').length - 1, 1, 'one call site, no retry')
  const has = body.indexOf('if (saving.current.has(id)) return')
  const add = body.indexOf('saving.current.add(id)')
  const call = body.indexOf('toggleSaved(')
  t.ok(has >= 0 && has < add && add < call, 'a press while the write is pending is dropped')
  t.ok(/\} catch \{\} finally \{\s+saving\.current\.delete\(id\)\s+\}/.test(body), 'the pending mark is released in finally, after any outcome')
  t.ok(body.indexOf('if (!alive.current) return') > call && body.indexOf('if (!alive.current) return') < body.indexOf('setSaveNotice({'), 'nothing is set after unmount')
  t.ok(body.includes('setSaveNotice(null)') && body.indexOf('setSaveNotice(null)') < call, 'a new press clears the old message')
  t.ok(body.includes('if (!answer) { setSaveNotice({ scope: at, text: SAVE_FAILED }); readSaved(); return }'), 'a thrown write shows the notice and reads the store')
  t.ok(body.includes('if (answer.full) { setSaveNotice({ scope: at, text: SAVED_FULL_TEXT }); return }'), 'a full list keeps the state')
  t.absent(body.includes('setSavedKeys'), 'the press never sets the star set itself')
  t.ok(body.indexOf('answer.full') < body.lastIndexOf('readSaved()'), 'a full list returns before any read')
  t.ok(body.includes('setSaveNotice(answer.persisted === false ? { scope: at, text: SAVE_FAILED } : null)'))
  t.ok(body.trimEnd().endsWith('readSaved()\n  }'), 'every settled write ends by reading the store, so a stale star, a segment change or a pending read never leaves a wrong star')
  t.absent(body.includes('savedRead.current++'), 'a press never outdates a read by itself')
  t.absent(/keys\.(add|delete)\(/.test(body), 'no local flip of what was on screen')
  t.ok(screen.includes("const SAVE_FAILED = 'Não foi possível salvar neste aparelho.'"))
  t.ok(src('screens/Anuncio.js').includes("'Não foi possível salvar neste aparelho.'"), 'same sentence as the detail screen')
  t.ok(screen.includes("import { SAVED_FULL_TEXT } from '../feiraSaved'"))
  t.ok(screen.includes("const ownerKnown = HEX64.test(actingPage || ownKey || '')"), 'no star while ownership is unknown')
  t.ok(screen.includes('onSave={ownerKnown && HEX64.test(listing.author) && ownerDest(listing, { me: ownKey, actingPage }) === null ? () => toggleSave(listing) : undefined}'), 'own listings get no star')
  t.ok(screen.includes('saved={savedIds !== null && savedIds.has(listingId(listing))}'))
  t.ok(screen.includes('extraData={listExtra}') && screen.includes('const listExtra = useMemo(() => [savedIds, ownerKnown, actingPage, ownKey], [savedIds, ownerKnown, actingPage, ownKey])'), 'the grid redraws when a star changes, not on every render')
})

test('Feira: the saved set is read again on every load, and only the newest read lands', (t) => {
  const screen = src('screens/Feira.js')
  const read = screen.slice(screen.indexOf('function readSaved'), screen.indexOf('const load = useCallback'))
  t.ok(read.includes('listSaved(savedOrigin)'))
  t.ok(read.includes('() => new Set()'), 'a failed read leaves every star hollow')
  t.ok(read.includes('if (alive.current && ticket === savedRead.current && currentScope.current === at) setSavedKeys({ scope: at, keys })'), 'stale, superseded and unmounted reads are dropped')
  const load = screen.slice(screen.indexOf('const load = useCallback'), screen.indexOf('const loadRef = useRef(load)'))
  const activeGuard = load.indexOf('if (!active || !locationReady) return')
  const reread = load.indexOf('if (!more) readSaved()')
  t.ok(activeGuard >= 0 && reread > activeGuard, 'each first-page load or refresh of an active screen reads the set')
  t.ok(/useEffect\(\(\) => \{\n {4}loadRef\.current\(\)[\s\S]*?\}, \[scope, active, locationReady\]\)/.test(screen), 'coming back to the screen (active again) loads, so it reads the set')
  t.ok(screen.includes('onRefresh={() => load()}'), 'pull to refresh runs a first-page load')
})

test('Feira: the star message is a fixed line above the list', (t) => {
  const screen = src('screens/Feira.js')
  const line = "{starNotice ? <View style={styles.note} accessibilityLiveRegion='polite' aria-live='polite'><Soft>{starNotice}</Soft></View> : null}\n      <RefreshableList"
  t.ok(screen.includes(line), 'rendered right before the list, outside its header')
  t.is(screen.split('{starNotice ?').length - 1, 1, 'drawn in one place only')
  t.ok(screen.indexOf('{starNotice ?') > screen.indexOf('return (\n    <View\n      style={styles.screen}'), 'inside the screen, not the list header')
  t.ok(screen.includes("const starNotice = saveNotice && saveNotice.scope === scope ? saveNotice.text : ''"), 'a scope change hides the old message')
  const body = screen.slice(screen.indexOf('async function toggleSave'), screen.indexOf('async function openSearch'))
  t.absent(body.includes('setAlertNotice'), 'saved-search notices stay separate')
})
