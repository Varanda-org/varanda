// A Rua warms the photo of the most likely next momento (momentStripWarm.js).
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/momentStripWarm.js')

const OWN = 'aa'.repeat(32)
const A = 'bb'.repeat(32)
const B = 'cc'.repeat(32)
const at = '2026-11-07T10:00:00.000Z'
const item = (seq, mime) => ({ seq, ref: 'ref' + seq, at, media: { mime: mime || 'image/jpeg', ms: 0 } })
const ring = (author, start, ...items) => ({ author, items, start })

test('stripWarmRef: first unseen image ring, skipping own and fully seen rings', async (t) => {
  const { stripWarmRef } = await load()
  const seen = new Set(['ref1'])
  const rings = [ring(OWN, 0, item(9)), ring(A, 0, item(1)), ring(B, 0, item(2))]
  const ref = stripWarmRef(rings, OWN, seen)
  t.is(ref.author, B)
  t.is(ref.seq, 2)
  t.is(ref.expected.mime, 'image/jpeg')
})

test('stripWarmRef: a video at the start item gives null, nothing further', async (t) => {
  const { stripWarmRef } = await load()
  const rings = [ring(A, 1, item(1, 'image/jpeg'), item(2, 'video/mp4')), ring(B, 0, item(3))]
  t.is(stripWarmRef(rings, OWN, new Set()), null)
})

test('stripWarmRef: null for empty or invalid input', async (t) => {
  const { stripWarmRef } = await load()
  t.is(stripWarmRef([], OWN, new Set()), null)
  t.is(stripWarmRef(null, OWN, new Set()), null)
  t.is(stripWarmRef([null, 5, { author: A }], OWN, new Set()), null)
  t.is(stripWarmRef([ring(OWN, 0, item(1))], OWN, new Set()), null)
})

test('ARua.js: the warm effect is gated, idle, owner strip, released on cleanup', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ARua.js'), 'utf8')
  const at = src.indexOf('stripWarmKey === \'\'')
  t.ok(at > 0)
  const body = src.slice(at, at + 1200)
  for (const gate of ['node.hosted', 'active === false', 'node.visible === false', '!stripWarmOpen']) t.ok(body.includes(gate), gate)
  const idle = body.indexOf('node.whenIdle(')
  const want = body.indexOf("store.want('strip', ref")
  t.ok(idle > 0 && want > idle, 'whenIdle before want')
  t.ok(body.includes("store.want('strip', ref ? [null, ref] : [])"), 'ref is read-ahead (index 1)')
  t.absent(body.includes('ref ? [ref] : []'), 'ref never at index 0')
  t.ok(body.includes("store.want('strip', [])"), 'cleanup releases')
  t.ok(body.includes('cancelled'))
  const head = src.slice(src.indexOf('const stripLatch'), at)
  t.ok(head.includes('seederVerified') && head.includes('node.online !== false') && head.includes('node.epoch'), 'latch gate')
  const deps = src.slice(src.indexOf('}, [stripWarmKey'), src.indexOf('}, [stripWarmKey') + 200).split('\n')[0]
  t.ok(deps.includes('stripWarmOpen'))
  t.absent(deps.includes('node.signals'), 'no signals object in deps')
  t.ok(src.includes('const stripWarm = useMemo('), 'memoized')
  t.absent(/Platform\.OS/.test(body))
})
