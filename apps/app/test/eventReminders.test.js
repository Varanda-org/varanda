'use strict'

const test = require('brittle')
const load = () => import('../src/eventReminders.js')
const O1 = 'https://bora.varanda.app'
const O2 = 'https://outra.example.org'
const key = (i) => i.toString(16).padStart(64, '0')
const ref = (i, seq = 1) => ({ author: key(i), seq })

function disk (initial = null) {
  const d = { raw: initial, writes: 0, failRead: false, now: () => 0 }
  d.read = async () => { if (d.failRead) throw new Error('x'); return d.raw }
  d.write = async (raw) => { d.writes++; d.raw = raw }
  return d
}

test('set, has, load, remove', async (t) => {
  const m = await load()
  const store = m.createReminderStore(disk())
  t.alike(await store.set(O1, key(9), ref(1), 1000), { ok: true, persisted: true })
  t.alike(await store.set(O1, key(9), ref(1), 2000), { ok: true, persisted: true }, 'updates start')
  t.alike(await store.load(O1, key(9)), [{ ...ref(1), start: 2000 }])
  t.ok(await store.has(O1, key(9), ref(1)))
  t.ok(await store.remove(O1, key(9), ref(1)))
  t.absent(await store.has(O1, key(9), ref(1)))
  t.is((await store.set(O1, key(9), { author: 'x', seq: 1 }, 5)).reason, 'invalid')
  t.is((await store.set(O1, key(9), ref(1), -1)).reason, 'invalid')
})

test('scoped per origin and account, stores no text', async (t) => {
  const m = await load()
  const d = disk()
  const store = m.createReminderStore(d)
  await store.set(O1, key(9), ref(1), 1)
  await store.set(O2, key(9), ref(2), 2)
  await store.set(O1, key(8), ref(3), 3)
  t.is((await store.load(O1, key(9))).length, 1)
  t.is((await store.load(O2, key(9)))[0].author, key(2))
  await store.forgetKey(key(9))
  t.is((await store.load(O2, key(9))).length, 0)
  t.is((await store.load(O1, key(8))).length, 1)
  t.alike(Object.keys(JSON.parse(d.raw).scopes[0].entries[0]).sort(), ['author', 'seq', 'start'])
})

test('capped, never dropped silently', async (t) => {
  const m = await load()
  const store = m.createReminderStore(disk())
  for (let i = 1; i <= m.MAX_REMINDERS; i++) t.ok((await store.set(O1, key(9), ref(1, i), i)).ok)
  t.is((await store.set(O1, key(9), ref(1, 999), 1)).reason, 'full')
  t.ok((await store.set(O1, key(9), ref(1, 1), 5)).ok, 'update at the cap')
  for (let i = 1; i <= m.MAX_ORIGINS; i++) await store.set('https://o' + i + '.example.org', key(i), ref(1), 1)
  t.is((await store.set('https://nova.example.org', key(1), ref(1), 1)).reason, 'scopes')
})

test('failed read never writes; garbage is sanitized', async (t) => {
  const m = await load()
  const d = disk()
  const store = m.createReminderStore(d)
  d.failRead = true
  t.alike(await store.set(O1, key(9), ref(1), 1), { ok: true, persisted: false })
  t.is(d.writes, 0)
  t.is(m.sanitize('{bad').size, 0)
  t.is(m.sanitize(JSON.stringify({ v: 2, scopes: [] })).size, 0)
})

test('dueReminders picks the next 24 hours', async (t) => {
  const m = await load()
  const now = 1000000
  const h = 3600000
  const list = [
    { ...ref(1), start: now + 25 * h },
    { ...ref(2), start: now + 2 * h },
    { ...ref(3), start: now + 24 * h },
    { ...ref(4), start: now - 1 },
    { ...ref(5), start: now + h }
  ]
  t.alike(m.dueReminders(list, now).map((e) => e.author), [key(5), key(2), key(3)])
  t.alike(m.dueReminders(null, now), [])
})

test('past reminders expire so the cap never sticks', async (t) => {
  const m = await load()
  let now = 1000
  const d = disk()
  const store = m.createReminderStore({ ...d, now: () => now })
  for (let i = 1; i <= m.MAX_REMINDERS; i++) t.ok((await store.set(O1, key(9), ref(1, i), 2000 + i)).ok)
  t.is((await store.set(O1, key(9), ref(1, 999), 5000)).reason, 'full')
  now = 3000
  t.is((await store.load(O1, key(9))).length, 0, 'only future ones load')
  t.ok((await store.set(O1, key(9), ref(1, 999), 5000)).ok)
})

test('removing an account also forgets its reminders (source)', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8')
  for (const file of ['App.js', 'src/screens/Identidade.js']) {
    const src = read(file)
    t.ok(/forgetSavedFor\(/.test(src) && /forgetReminderKey\(/.test(src), file + ' calls both')
    t.ok(/import \{ forgetReminderKey \} from '[./a-z]*eventRemindersStore'/.test(src), file + ' imports the store')
  }
})
