'use strict'

// The own-device DM push mute (src/dmWakeMute.web.js and .native.js) and the
// DM wake emitter in src/dm-open.js. ES modules loaded through import(); the
// browser navigator is replaced by a fake for each web case and restored after.
const test = require('brittle')

const loadWeb = () => import('../src/dmWakeMute.web.js')
const loadNative = () => import('../src/dmWakeMute.native.js')
const loadOpen = () => import('../src/dm-open.js')

function setNavigator (value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator')
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  return () => {
    if (had && prev) Object.defineProperty(globalThis, 'navigator', prev)
    else delete globalThis.navigator
  }
}

test('native: no-op that touches no browser global', async (t) => {
  const restore = setNavigator(new Proxy({}, { get () { throw new Error('navigator read') } }))
  try {
    const { noteOwnDmDrop } = await loadNative()
    t.is(noteOwnDmDrop(), undefined)
  } finally {
    restore()
  }
})

test('web: posts exactly the marker to the controlling worker', async (t) => {
  const sent = []
  const restore = setNavigator({ serviceWorker: { controller: { postMessage: (m) => sent.push(m) } } })
  try {
    const { noteOwnDmDrop } = await loadWeb()
    t.is(noteOwnDmDrop(), undefined)
    t.alike(sent, [{ type: 'varanda-dm-sent' }])
    t.alike(Object.keys(sent[0]), ['type'], 'no id or other field')
  } finally {
    restore()
  }
})

test('web: no controller yet is silent', async (t) => {
  const restore = setNavigator({ serviceWorker: {} })
  try {
    const { noteOwnDmDrop } = await loadWeb()
    t.is(noteOwnDmDrop(), undefined)
  } finally {
    restore()
  }
})

test('web: no service worker support is silent', async (t) => {
  const restore = setNavigator({})
  try {
    const { noteOwnDmDrop } = await loadWeb()
    t.is(noteOwnDmDrop(), undefined)
  } finally {
    restore()
  }
})

test('web: a throwing postMessage never throws out', async (t) => {
  const restore = setNavigator({
    serviceWorker: { controller: { postMessage () { throw new Error('closed port') } } }
  })
  try {
    const { noteOwnDmDrop } = await loadWeb()
    t.is(noteOwnDmDrop(), undefined)
  } finally {
    restore()
  }
})

test('dm-open: requestDmWake calls every onDmWake listener until unsubscribed', async (t) => {
  const { onDmWake, requestDmWake } = await loadOpen()
  let a = 0
  let b = 0
  t.is(requestDmWake(), false, 'nobody listening: not taken')
  const offA = onDmWake(() => { a++ })
  const offB = onDmWake(() => { b++ })
  t.is(requestDmWake(), true, 'taken')
  t.is(a, 1)
  t.is(b, 1)
  offA()
  requestDmWake()
  t.is(a, 1, 'unsubscribed listener is not called')
  t.is(b, 2)
  offB()
  t.is(requestDmWake(), false, 'everyone unsubscribed: not taken')
  t.is(b, 2)
})

test('dm-open: wake and open channels are independent', async (t) => {
  const { onDmWake, onDmOpen, requestDmWake, requestDmOpen } = await loadOpen()
  let wakes = 0
  let opens = 0
  const offWake = onDmWake(() => { wakes++ })
  const offOpen = onDmOpen(() => { opens++ })
  requestDmOpen()
  t.is(wakes, 0, 'an open does not wake')
  requestDmWake()
  t.is(opens, 1, 'a wake does not open')
  offWake()
  offOpen()
})
