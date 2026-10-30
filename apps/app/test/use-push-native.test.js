'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

test('native push: exactly eight exports, immutable snapshots and harmless actions', async (t) => {
  const native = await import('../src/usePush.native.js')
  t.alike(Object.keys(native).sort(), ['activatePush', 'dismissPush', 'getPush', 'readPush', 'subscribePush', 'togglePush', 'turnOffPush', 'usePush'])
  const none = { member: null, state: null, pending: false, error: '', note: 'none' }
  t.alike(native.getPush(), none)
  t.ok(Object.isFrozen(native.getPush()))
  t.is(native.getPush(), native.getPush())
  const view = native.usePush()
  t.is(view, native.usePush())
  t.ok(Object.isFrozen(view))
  t.is(view.note, 'none')
  t.alike(view, {
    ...none,
    readPush: native.readPush,
    activatePush: native.activatePush,
    togglePush: native.togglePush,
    turnOffPush: native.turnOffPush,
    dismissPush: native.dismissPush
  })
  const unsubscribe = native.subscribePush(() => t.fail('native never notifies'))
  t.is(typeof unsubscribe, 'function')
  t.is(native.readPush(), undefined)
  t.is(native.dismissPush(), undefined)
  t.is(native.activatePush(), false)
  t.is(native.togglePush(), false)
  const off = native.turnOffPush()
  t.ok(off instanceof Promise)
  t.is(await off, undefined)
  t.is(unsubscribe(), undefined)
})

test('native push: source has no imports or em dash', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/usePush.native.js'), 'utf8')
  t.absent(/^\s*import\b/m.test(source))
  t.absent(source.includes('\u2014'))
})
