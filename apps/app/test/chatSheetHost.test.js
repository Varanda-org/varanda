'use strict'

// One actions sheet per chat list (src/ui/ChatSheetHost.js) instead of one per
// Bubble, and no button role on a bubble that holds buttons of its own.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const count = (s, needle) => s.split(needle).length - 1

test('chat sheet state: show keeps title and header, close keeps them for the slide out', async (t) => {
  const { CLOSED, chatSheetReducer } = await import('../src/ui/chatSheetState.js')
  const header = () => null
  const sheet = { title: 'Ana', actions: [{ label: 'Copiar', onPress: () => {} }], header }
  const owner = {}
  const open = chatSheetReducer(CLOSED, { type: 'show', owner, sheet })
  t.is(open.open, true)
  t.is(open.sheet.title, 'Ana')
  t.is(open.sheet.header, header)
  const closed = chatSheetReducer(open, { type: 'close' })
  t.is(closed.open, false)
  t.is(closed.sheet, sheet, 'a pressed action still runs once the sheet is gone')
  t.is(chatSheetReducer(closed, { type: 'close' }), closed)
  t.is(chatSheetReducer(CLOSED, { type: 'show', owner, sheet: { actions: [] } }).open, false, 'no actions, no sheet')
})

test('chat sheet state: only the bubble that opened the sheet refreshes it while it is up', async (t) => {
  const { CLOSED, chatSheetReducer } = await import('../src/ui/chatSheetState.js')
  const a = {}
  const b = {}
  const first = { actions: [{ label: 'um' }] }
  const second = { actions: [{ label: 'dois' }] }
  const open = chatSheetReducer(CLOSED, { type: 'show', owner: a, sheet: first })
  t.is(chatSheetReducer(open, { type: 'refresh', owner: b, sheet: second }), open, 'another bubble cannot replace it')
  t.is(chatSheetReducer(open, { type: 'refresh', owner: a, sheet: second }).sheet, second)
  const closed = chatSheetReducer(open, { type: 'close' })
  t.is(chatSheetReducer(closed, { type: 'refresh', owner: a, sheet: second }), closed, 'a closed sheet is not refreshed')
})

test('a list of bubbles mounts one ActionsSheet: the provider has it, the bubble only without a provider', (t) => {
  const host = read('ui/ChatSheetHost.js')
  t.is(count(host, '<ActionsSheet'), 1)
  const bubble = read('ui/Bubble.js')
  t.is(count(bubble, '<ActionsSheet'), 1, 'one mount in the bubble source')
  t.ok(bubble.includes('{host === null && rows.length > 0\n        ? <ActionsSheet'), 'and it is the fallback for no provider')
  t.ok(bubble.includes('host.show(owner, sheetRef.current)'))
  t.ok(bubble.includes('host.refresh(owner, sheetRef.current)'))
  t.is(count(bubble, 'setOpen(true)') > 5, true)
  t.ok(bubble.includes('const [localOpen, setLocalOpen] = useState(false)'), 'the local open state serves only the fallback')
})

test('every screen that renders Bubble sits under a ChatSheetProvider', (t) => {
  const dir = path.join(__dirname, '../src/screens')
  const screens = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && /<Bubble\b/.test(read('screens/' + f)))
  t.ok(screens.includes('Mensagem.js') && screens.includes('Grupo.js'))
  for (const f of screens) {
    const src = read('screens/' + f)
    t.ok(src.includes("import { ChatSheetProvider } from '../ui/ChatSheetHost'"), f + ' imports it')
    t.ok(/<ChatSheetProvider[ >]/.test(src), f + ' mounts it')
  }
  const dm = read('screens/Mensagem.js')
  t.ok(dm.includes("const scope = identity + ':' + props.peer + (typeof props.oldPage === 'string' ? ':' + props.oldPage : '')"))
  t.ok(dm.includes('<ChatSheetProvider key={scope}>'), 'a peer, identity or old-key switch remounts the DM sheet with its thread')
})

test('the bubble is not a button: its links and cards are, the chevron stays the only one', (t) => {
  const bubble = read('ui/Bubble.js')
  const pressable = bubble.slice(bubble.indexOf('<Pressable\n'), bubble.indexOf('style={[styles.bubble,'))
  t.absent(pressable.includes('accessibilityRole'), 'no role on the bubble')
  t.absent(pressable.includes('accessibilityHint'), 'no hint on the bubble')
  t.ok(pressable.includes('accessibilityActions='), 'screen readers keep the actions')
  t.ok(pressable.includes('onLongPress='), 'and the long press')
  t.is(count(bubble, "accessibilityRole='button'"), 1, 'the chevron')
})

test('sources have no em dash', (t) => {
  for (const f of ['ui/ChatSheetHost.js', 'ui/chatSheetState.js', 'ui/Bubble.js']) t.absent(read(f).includes(String.fromCharCode(0x2014)), f)
  t.absent(fs.readFileSync(__filename, 'utf8').includes(String.fromCharCode(0x2014)))
})
