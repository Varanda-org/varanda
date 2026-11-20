// A sheet asked while another is still leaving opens only once that one is
// gone (its onDismiss, or the fallback timer where none is reported).
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/sheetHandover.js')
const read = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')

function fakeClock () {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    setTimer (run, ms) { timers.set(++id, { at: now + ms, run }); return id },
    clearTimer (id) { timers.delete(id) },
    pending: () => timers.size,
    tick (ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    }
  }
}

test('a sheet asked while none is leaving opens at once', async (t) => {
  const { createHandover } = await load()
  const clock = fakeClock()
  const h = createHandover(clock)
  let opened = 0
  h.request(() => opened++)
  t.is(opened, 1)
  t.absent(h.busy())
})

test('a sheet asked right after another closed waits for its dismissal', async (t) => {
  const { createHandover } = await load()
  const clock = fakeClock()
  const h = createHandover(clock)
  const gone = h.leave(700)
  let opened = 0
  h.request(() => opened++)
  t.is(opened, 0, 'not shown while the other sheet slides out')
  t.ok(h.busy())
  clock.tick(100)
  t.is(opened, 0)
  gone()
  t.is(opened, 1, 'shown on the dismissal')
  t.is(clock.pending(), 0, 'the fallback timer is cleared')
  gone()
  t.is(opened, 1, 'a second dismissal report does nothing')
})

test('a dismissal that never reports is covered by the fallback', async (t) => {
  const { createHandover } = await load()
  const clock = fakeClock()
  const h = createHandover(clock)
  h.leave(320)
  let opened = 0
  h.request(() => opened++)
  clock.tick(319)
  t.is(opened, 0)
  clock.tick(1)
  t.is(opened, 1)
  t.absent(h.busy())
})

test('the next sheet waits for every leaving sheet, and a withdrawn request never runs', async (t) => {
  const { createHandover } = await load()
  const clock = fakeClock()
  const h = createHandover(clock)
  const a = h.leave(700)
  const b = h.leave(700)
  const opened = []
  const cancel = h.request(() => opened.push('cancelled'))
  h.request(() => opened.push('kept'))
  cancel()
  a()
  t.alike(opened, [], 'one sheet is still leaving')
  b()
  t.alike(opened, ['kept'])
})

test('Sheet and ActionsSheet share the hand-over', (t) => {
  const sheet = read('ui/Sheet.js')
  const actions = read('ui/ActionsSheet.js')
  t.absent(sheet.includes('\u2014') || actions.includes('\u2014'), 'no em dash')
  t.ok(sheet.includes("import { sheetHandover } from '../sheetHandover'"))
  t.ok(sheet.includes('export function Sheet ({ open, onClose, onBack, onDismiss,'), 'onDismiss prop, the name the PageNoticeSheet hand-over uses')
  t.is(sheet.split('visible={handed.visible}').length - 1, 2, 'both Modals (iOS page sheet and panel) follow the hand-over')
  t.is(sheet.split('onDismiss={dismissed}').length - 1, 2, 'both Modals report their dismissal')
  t.absent(sheet.includes('visible={!!open}'), 'no Modal shows on open alone')
  const hook = sheet.slice(sheet.indexOf('export function useHandedOpen'), sheet.indexOf('// The row\'s 16 pt edge'))
  t.ok(/useLayoutEffect\(\(\) => \{\s+if \(was\.current && !visible\)/.test(hook), 'leaving is marked in a layout effect, before requests of the same commit')
  t.ok(hook.includes('sheetHandover.request(() => setShown(true))'))
  t.ok(hook.includes('const [shown, setShown] = useState(false)'), 'a sheet mounted open waits for the request too')
  t.absent(hook.includes('sheetHandover.busy()'), 'never decided in render, before a closing sheet of the same commit marks itself leaving')
  t.ok(actions.includes('visible={handed.visible}'), 'the menu waits for a leaving sheet')
  t.ok(/const flush = \(\) => \{\s+handed\.dismissed\(\)/.test(actions), 'the menu leaves the hand-over before its row action runs')
})
