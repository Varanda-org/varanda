'use strict'

const test = require('brittle')
const load = () => import('../src/wifiOnly.js?' + Math.random())

function memoryStore (entries = new Map()) {
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) }
  }
}

test('on by default; unreadable stays on', async (t) => {
  const { wifiOnlyOf, WIFI_ONLY_LABEL } = await load()
  t.is(WIFI_ONLY_LABEL, 'Sincronizar só no Wi-Fi')
  t.is(wifiOnlyOf(null), true)
  t.is(wifiOnlyOf(''), true)
  t.is(wifiOnlyOf('{"v":2,"wifiOnly":false}'), true)
  t.is(wifiOnlyOf('{"v":1,"wifiOnly":false}'), false)
})

test('off persists and notifies once per change', async (t) => {
  const first = await load()
  const entries = new Map()
  first.bindWifiOnly(memoryStore(entries))
  const seen = []
  first.onWifiOnly((v) => seen.push(v))
  t.is(first.setWifiOnly(false), true)
  t.is(first.setWifiOnly(false), false)
  t.is(first.setWifiOnly('x'), false)
  t.alike(seen, [false])
  const second = await load()
  second.bindWifiOnly(memoryStore(entries))
  t.is(second.wifiOnly(), false)
})
