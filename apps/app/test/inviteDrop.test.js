'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { register } = require('node:module')

const load = () => import('../src/inviteDrop.js')
const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WEEK = '2026-11-09T03:00:00.000Z'
const NEXT_WEEK = '2026-11-16T03:00:00.000Z'
const record = (seenOpened = 1, resetsAt = WEEK, member = MEMBER) => ({ v: 1, member, resetsAt, seenOpened })
const grant = (opened = 1, used = 0, resetsAt = WEEK) => ({ mode: 'sorteio', perWeek: 3, opened, used, remaining: Math.max(0, opened - used), resetsAt })
const flush = () => new Promise((resolve) => setImmediate(resolve))

function deferred () {
  let finish
  const promise = new Promise((resolve) => { finish = resolve })
  return { promise, resolve: finish }
}

function clock () {
  const c = { t: 0, now: () => c.t }
  let id = 0
  const timers = new Map()
  c.setInterval = (fn, ms) => {
    const key = ++id
    timers.set(key, { fn, ms, at: c.now() + ms })
    return key
  }
  c.clearInterval = (key) => timers.delete(key)
  c.count = () => timers.size
  c.advance = async (ms) => {
    const end = c.now() + ms
    while (true) {
      const next = [...timers.values()].sort((a, b) => a.at - b.at)[0]
      if (!next || next.at > end) break
      c.t = next.at
      next.at += next.ms
      next.fn()
      await flush()
    }
    c.t = end
    await flush()
  }
  return c
}

async function fixture (options = {}) {
  const { createInviteDropMonitor, POLL_MS } = await load()
  const c = clock()
  const calls = []
  const notes = []
  const saved = []
  let answer = grant()
  let stored = options.seen || null
  const request = async (...args) => { calls.push(['sign', ...args]); return { signature: 'signed' } }
  const monitor = createInviteDropMonitor({
    policy: async () => { calls.push(['policy']); return { required: true, perWeek: 3 } },
    start: async (args) => { calls.push(['start', args]); return { nonce: 'challenge' } },
    summary: async (args) => { calls.push(['summary', args]); if (answer instanceof Error) throw answer; return answer },
    store: {
      load: async () => stored,
      save: async (r) => { saved.push(r); stored = r }
    },
    ...options,
    setInterval: c.setInterval,
    clearInterval: c.clearInterval,
    onNote: (note) => { shown.note = note; if (note) notes.push(note) }
  })
  const shown = { note: null }
  const update = (changes = {}) => monitor.update({ enabled: true, member: MEMBER, request, ...changes })
  return { monitor, update, request, c, calls, notes, saved, shown, POLL_MS, answer: (next) => { answer = next } }
}

test('seenRecordOf accepts only the exact presentation record', async (t) => {
  const { seenRecordOf } = await load()
  const original = record()
  t.alike(seenRecordOf(original), original)
  t.not(seenRecordOf(original), original, 'fresh copy')
  const bad = [null, undefined, [], {}, 'record', 1,
    { ...original, extra: true }, { ...original, v: 2 },
    { ...original, member: 'a' }, { ...original, member: MEMBER.toUpperCase() },
    { ...original, resetsAt: '2026-11-09' }, { ...original, resetsAt: '2026-02-30T03:00:00.000Z' },
    { ...original, resetsAt: 'invalid' }, { ...original, resetsAt: 0 },
    ...[-1, 101, 1.5, NaN, Infinity, '1'].map((n) => record(n)),
    Object.assign(Object.create(null), original),
    Object.assign(Object.create({ inherited: true }), original),
    { ...original, [Symbol('extra')]: true },
    Object.defineProperty(record(), 'hidden', { value: true }),
    Object.defineProperty(record(), 'resetsAt', { get () { throw new Error('read') } })]
  for (const value of bad) t.is(seenRecordOf(value), null)
})

test('shouldAnnounce follows opened, not the balance after spending', async (t) => {
  const { shouldAnnounce } = await load()
  t.is(shouldAnnounce({ summary: grant(), seen: null }), true)
  t.is(shouldAnnounce({ summary: grant(), seen: record() }), false)
  t.is(shouldAnnounce({ summary: grant(2, 1), seen: record() }), true, 'equal remaining, new grant')
  t.is(shouldAnnounce({ summary: grant(1, 1), seen: null }), false)
  t.is(shouldAnnounce({ summary: grant(0), seen: null }), false)
  t.is(shouldAnnounce({ summary: grant(1, 0, NEXT_WEEK), seen: record(3) }), true)
  t.is(shouldAnnounce({ summary: grant(), seen: record(2) }), false, 'older opened does not announce')
  t.is(shouldAnnounce({ summary: { ...grant(), mode: 'semanal' }, seen: null }), false)
  t.is(shouldAnnounce({ summary: null, seen: null }), false)
})

test('first poll signs summary, writes only when shown and announces each grant once', async (t) => {
  const f = await fixture()
  f.update()
  await flush()
  t.alike(f.calls, [
    ['policy'], ['start', { member: MEMBER }],
    ['sign', 'invite.sign', { action: 'summary', nonce: 'challenge' }],
    ['summary', { member: MEMBER, nonce: 'challenge', signature: 'signed' }]
  ])
  t.alike(f.notes, [record()])
  t.is(f.saved.length, 0, 'hidden note has not been seen')
  f.monitor.markSeen(f.notes[0])
  await flush()
  t.alike(f.saved, [record()])
  f.monitor.dismiss()
  await f.c.advance(f.POLL_MS - 1)
  t.is(f.calls.length, 4, 'no early poll')
  await f.c.advance(1)
  t.is(f.notes.length, 1, 'same grant stays seen')
  f.answer(grant(2))
  await f.c.advance(f.POLL_MS)
  t.alike(f.notes[1], record(2), 'grant while app remains open')
  f.monitor.markSeen(f.notes[1])
  await flush()
  f.monitor.dismiss()
  await f.c.advance(f.POLL_MS * 2)
  t.is(f.notes.length, 2)
  f.monitor.stop()
  t.is(f.c.count(), 0)
})

test('spend then receive with equal remaining and a new week both announce', async (t) => {
  const f = await fixture({ seen: record() })
  f.update()
  await flush()
  t.is(f.notes.length, 0)
  f.answer(grant(1, 1))
  await f.c.advance(f.POLL_MS)
  t.is(f.notes.length, 0)
  f.answer(grant(2, 1))
  await f.c.advance(f.POLL_MS)
  t.alike(f.notes, [record(2)])
  f.monitor.markSeen(f.notes[0])
  f.answer(grant(1, 0, NEXT_WEEK))
  await f.c.advance(f.POLL_MS)
  t.alike(f.notes[1], record(1, NEXT_WEEK))
  f.monitor.stop()
})

test('hidden or locked stops polling, visible edge polls immediately', async (t) => {
  const f = await fixture()
  f.update({ enabled: false })
  await f.c.advance(f.POLL_MS)
  t.is(f.calls.length, 0)
  f.update()
  await flush()
  f.monitor.markSeen(f.notes[0])
  f.update({ enabled: false })
  await f.c.advance(f.POLL_MS * 2)
  t.is(f.calls.length, 4)
  t.is(f.c.count(), 0)
  f.answer(grant(2))
  f.update()
  await flush()
  t.alike(f.notes[1], record(2))
  f.update({ enabled: false, member: null })
  await f.c.advance(f.POLL_MS)
  t.is(f.calls.length, 8, 'no work while locked')
  f.monitor.stop()
})

test('visibility flicker keeps the note for the same member, a new member clears it', async (t) => {
  const f = await fixture()
  f.update()
  await flush()
  t.alike(f.shown.note, record())
  f.monitor.markSeen(f.shown.note)
  await flush()
  f.update({ enabled: false })
  t.alike(f.shown.note, record(), 'hidden, not cleared')
  t.is(f.c.count(), 0)
  f.update()
  await flush()
  t.alike(f.shown.note, record(), 'same member keeps the seen note after the resumed poll')
  t.is(f.notes.length, 1, 'not announced twice')
  f.update({ enabled: false, member: null })
  f.update()
  await flush()
  t.alike(f.shown.note, record(), 'lock without a key change keeps it')
  f.update({ enabled: false, member: OTHER })
  t.is(f.shown.note, null, 'another member clears it at once')
  f.monitor.stop()
})

test('a resumed poll clears the note when nothing is left or the mode changed', async (t) => {
  for (const next of [grant(1, 1), { ...grant(), mode: 'semanal' }, null]) {
    const f = await fixture()
    f.update()
    await flush()
    f.monitor.markSeen(f.shown.note)
    f.update({ enabled: false })
    f.answer(next)
    f.update()
    await flush()
    t.is(f.shown.note, null)
    f.monitor.stop()
  }
})

test('polls coalesce and a late summary for another identity is discarded', async (t) => {
  const pending = deferred()
  const reads = []
  const f = await fixture({ summary: (args) => { reads.push(args.member); return args.member === MEMBER ? pending.promise : Promise.resolve(grant(2)) } })
  f.update()
  await flush()
  f.update()
  await f.c.advance(f.POLL_MS * 3)
  t.alike(reads, [MEMBER], 'one request in flight')
  f.update({ member: OTHER })
  await flush()
  t.alike(f.notes, [record(2, WEEK, OTHER)])
  pending.resolve(grant())
  await flush()
  t.alike(f.notes, [record(2, WEEK, OTHER)], 'old identity never publishes')
  f.monitor.stop()
})

test('lock and unmount cancel each awaited transport step', async (t) => {
  for (const stage of ['policy', 'load', 'start', 'sign', 'summary']) {
    for (const action of ['lock', 'unmount']) {
      const pending = deferred()
      const reached = []
      const step = (name, answer) => async () => { reached.push(name); return stage === name ? pending.promise : answer }
      const f = await fixture({
        policy: step('policy', { required: true }),
        start: step('start', { nonce: 'challenge' }),
        summary: step('summary', grant()),
        store: { load: step('load', null), save: async () => {} }
      })
      f.update({ request: step('sign', { signature: 'signed' }) })
      await flush()
      t.is(reached.at(-1), stage)
      if (action === 'lock') f.update({ enabled: false, member: null })
      else f.monitor.stop()
      const before = reached.length
      pending.resolve({ ...grant(), nonce: 'challenge', signature: 'signed', required: true })
      await flush()
      await f.c.advance(f.POLL_MS)
      t.is(reached.length, before, stage + ': no next step after ' + action)
      t.is(f.notes.length, 0, stage + ': no late note')
      t.is(f.c.count(), 0)
    }
  }
})

test('errors invent no balance and a later successful poll can announce', async (t) => {
  const f = await fixture()
  f.answer(new Error('offline'))
  f.update()
  await flush()
  t.is(f.notes.length, 0)
  t.is(f.saved.length, 0)
  f.answer(grant())
  await f.c.advance(f.POLL_MS)
  t.alike(f.notes, [record()])
  f.monitor.stop()
})

test('404 disables polling for the mount, including visibility and key changes', async (t) => {
  const f = await fixture()
  f.answer(null)
  f.update()
  await flush()
  t.is(f.c.count(), 0)
  t.is(f.notes.length, 0)
  f.update({ enabled: false })
  f.update({ member: OTHER })
  await f.c.advance(f.POLL_MS * 3)
  t.is(f.calls.length, 4)
  f.monitor.stop()
})

test('only a required policy permits the signed read', async (t) => {
  for (const answer of [null, { required: false }, new Error('offline')]) {
    const f = await fixture({ policy: async () => { if (answer instanceof Error) throw answer; return answer } })
    f.update()
    await f.c.advance(f.POLL_MS)
    t.is(f.calls.length, 0)
    t.is(f.notes.length, 0)
    f.monitor.stop()
  }
})

test('memory guard survives failed persistence and lock, scoped to the member', async (t) => {
  const f = await fixture({ store: { load: async () => record(0), save: async () => { throw new Error('disk') } } })
  f.update()
  await flush()
  f.monitor.markSeen(f.notes[0])
  f.monitor.dismiss()
  await f.c.advance(f.POLL_MS)
  f.update({ enabled: false })
  f.update()
  await flush()
  t.is(f.notes.length, 1, 'stale stored opened cannot erase the memory guard')
  f.update({ member: OTHER })
  await flush()
  t.alike(f.notes[1], record(1, WEEK, OTHER))
  f.update({ member: MEMBER })
  await flush()
  t.is(f.notes.length, 2, 'returning member is still guarded')
  f.monitor.stop()
})

test('seen store keeps memory on refused writes and delayed reads', async (t) => {
  const { createInviteSeenStore } = await load()
  const pending = deferred()
  const store = createInviteSeenStore({ read: () => pending.promise, write: () => { throw new Error('quota') } })
  const reading = store.load()
  t.is(await store.save(record(2)), false)
  pending.resolve(JSON.stringify(record()))
  t.alike(await reading, record(2))
  t.alike(await store.load(), record(2))
  t.is(await store.save({ ...record(), extra: true }), false)
  t.alike(await store.load(), record(2))
})

const loader = `
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: 'data:text/javascript,' + encodeURIComponent('export const Paths = { document: "document" }; export class File { constructor (...args) { return globalThis.__inviteFile(...args) } }'), shortCircuit: true }
  if (context.parentURL?.endsWith('/useInviteDrop.js')) {
    let source
    if (specifier === 'react') source = ['useState', 'useRef', 'useEffect', 'useCallback'].map((name) => 'export const ' + name + ' = (...args) => globalThis.__inviteHooks.' + name + '(...args)').join(';')
    if (specifier === './account') source = ['invitePolicy', 'invitesStart', 'invitesSummary'].map((name) => 'export const ' + name + ' = (...args) => globalThis.__inviteTransport.' + name + '(...args)').join(';')
    if (specifier === './inviteSeenStore') source = 'export const loadInviteSeen = () => globalThis.__inviteStore.load(); export const saveInviteSeen = (record) => globalThis.__inviteStore.save(record)'
    if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(loader))

test('hook keeps its monitor across renders and cancels on lock, key change and unmount', async (t) => {
  const c = clock()
  const oldInterval = globalThis.setInterval
  const oldClear = globalThis.clearInterval
  globalThis.setInterval = c.setInterval
  globalThis.clearInterval = c.clearInterval
  t.teardown(() => {
    globalThis.setInterval = oldInterval
    globalThis.clearInterval = oldClear
    delete globalThis.__inviteHooks
    delete globalThis.__inviteTransport
    delete globalThis.__inviteStore
  })
  let index = 0
  let effects = []
  const slots = []
  globalThis.__inviteHooks = {
    useState (initial) {
      const i = index++
      if (!slots[i]) slots[i] = { value: initial }
      return [slots[i].value, (value) => { slots[i].value = value }]
    },
    useRef (initial) {
      const i = index++
      if (!slots[i]) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback (fn, deps) {
      const i = index++
      if (!slots[i]) slots[i] = { fn }
      return slots[i].fn
    },
    useEffect (fn, deps) {
      const i = index++
      if (slots[i] && deps.every((dep, n) => Object.is(dep, slots[i].deps[n]))) return
      effects.push(() => {
        if (slots[i]?.cleanup) slots[i].cleanup()
        slots[i] = { deps, cleanup: fn() }
      })
    }
  }
  let reads = 0
  let stored = null
  const pending = deferred()
  globalThis.__inviteTransport = {
    invitePolicy: async () => ({ required: true }),
    invitesStart: async () => ({ nonce: 'challenge' }),
    invitesSummary: async () => { reads++; return reads === 2 ? pending.promise : grant() }
  }
  globalThis.__inviteStore = { load: async () => stored, save: async (r) => { stored = r } }
  const { useInviteDrop } = await import('../src/useInviteDrop.js')
  const request = async () => ({ signature: 'signed' })
  let props = { enabled: true, member: MEMBER, request }
  const render = (changes = {}) => {
    props = { ...props, ...changes }
    index = 0
    const result = useInviteDrop(props)
    const run = effects
    effects = []
    for (const effect of run) effect()
    return result
  }
  t.is(render().note, null)
  await flush()
  const shown = render()
  t.alike(shown.note, record())
  shown.markSeen(shown.note)
  await flush()
  t.alike(stored, record())
  render()
  await flush()
  t.is(reads, 1, 'ordinary renders never poll')
  await c.advance(15 * 60 * 1000)
  t.is(reads, 2)
  t.is(render({ member: OTHER }).note, null, 'old note hidden before effects')
  await flush()
  t.alike(render().note, record(1, WEEK, OTHER))
  pending.resolve(grant(2))
  await flush()
  t.alike(render().note, record(1, WEEK, OTHER), 'late answer discarded')
  t.is(render({ enabled: false, member: null }).note, null)
  await c.advance(15 * 60 * 1000)
  t.is(reads, 3)
  t.is(c.count(), 0)
  render({ enabled: true, member: MEMBER })
  await flush()
  t.is(render().note, null, 'seen grant stays hidden after unlock')
  for (const slot of slots) if (slot.cleanup) slot.cleanup()
  await c.advance(15 * 60 * 1000)
  t.is(reads, 4)
  t.is(c.count(), 0)
})

test('web and native stores round trip and keep memory when storage fails', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  t.teardown(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
    delete globalThis.__inviteFile
  })
  for (const platform of ['web', 'native']) {
    let raw = null
    let fail = false
    const names = []
    const read = () => { if (fail) throw new Error('read'); return raw }
    const write = (value) => { if (fail) throw new Error('write'); raw = value }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => { names.push(key); return read() },
        setItem: (key, value) => { names.push(key); write(value) }
      }
    })
    globalThis.__inviteFile = (dir, name) => {
      names.push(name)
      return { get exists () { return raw !== null }, text: async () => read(), create: () => write(''), write }
    }
    const store = await import('../src/inviteSeenStore.' + platform + '.js')
    t.is(await store.loadInviteSeen(), null, platform + ': empty')
    raw = '{invalid'
    t.is(await store.loadInviteSeen(), null, platform + ': malformed')
    raw = JSON.stringify({ ...record(), extra: true })
    t.is(await store.loadInviteSeen(), null, platform + ': strict schema')
    t.is(await store.saveInviteSeen(record()), true)
    t.alike(JSON.parse(raw), record())
    t.alike(await store.loadInviteSeen(), record())
    fail = true
    t.is(await store.saveInviteSeen(record(2)), false)
    t.alike(await store.loadInviteSeen(), record(2), platform + ': memory wins')
    t.ok(names.every((name) => name === (platform === 'web' ? 'varanda-invite-seen' : 'varanda-invite-seen.json')))
  }
})

test('shell and note share the push action and gate on hosted capabilities', (t) => {
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  const note = readFileSync(join(__dirname, '../src/ui/InviteDropNote.js'), 'utf8')
  const gate = app.match(/const inviteDrop = useInviteDrop\(\{([\s\S]*?)\n {2}\}\)/)[1]
  for (const clause of ['node.hosted === true', 'node.visible !== false', '!locked', 'pkStatus?.unlocked === true', 'member', 'request: node.request']) t.ok(gate.includes(clause), clause)
  t.absent(gate.includes('Platform.OS'))
  t.ok(/const openInvites = useCallback\(\(\) => \{\s*setAjustes\('convites'\)\s*setInviteNudge\(\(n\) => n \+ 1\)/.test(app))
  t.ok(/intent.kind === 'convite'\) \{\s*openInvites\(\)/.test(app))
  const launch = app.match(/const intent = launchRef\.current\n([\s\S]*?)\n {2}\}, \[launchSeq[^\]]*\]\)/)
  t.ok(launch, 'launch effect found')
  const body = launch[1]
  t.ok(body.includes("if (!atTabs && !(intent.kind === 'convite' && ajustes !== null)) return"), 'a convite applies while Ajustes is open')
  t.absent(/intent === null \|\| !atTabs/.test(body), 'atTabs alone no longer gates a convite')
  t.ok(body.indexOf("intent.kind === 'convite'") < body.indexOf('intent.recipient !== launchKey'), 'convite before the recipient check')
  t.ok(/\}, \[launchSeq, atTabs, ajustes, launchKey/.test(launch[0]), 'effect reruns when Ajustes opens or closes')
  t.ok(app.includes("ajustes !== 'convites'"))
  t.ok(app.includes('const handleInviteShown = inviteDrop.markSeen'))
  t.ok(app.includes('onShown={handleInviteShown}'))
  t.ok(app.includes('inviteDrop.dismiss(); openInvites()'))
  t.ok(note.includes('onShown(record)'))
  t.ok(note.includes('{INVITE_DROP_TITLE}'))
  t.ok(note.includes('{INVITE_DROP_BODY}'))
  t.is((note.match(/<Pressable\b/g) || []).length, 1)
  t.absent(note.includes('Platform.OS'))
})
