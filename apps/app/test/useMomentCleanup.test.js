'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { register } = require('node:module')

const OWN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const DAY = 24 * 60 * 60 * 1000
const ref = (seq) => OWN + ':' + seq
const expired = (seq) => ({ seq, ref: ref(seq), text: '', at: new Date(Date.now() - 3 * DAY + seq * 1000).toISOString() })
const HOOK = path.join(__dirname, '../src/useMomentCleanup.js')
const APP = path.join(__dirname, '../App.js')
const GATE = 'enabled: ready && !locked && setupDone && termsOk && ageClear && phoneClear && !(passkey && passkey.recovering)'
let start = 0

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
async function until (cond) {
  for (let i = 0; i < 200 && !cond(); i++) await flush()
}

async function hookFixture ({ values = new Map(), past = [expired(1)], answer = null, onWrite = null, exclusive = (fn) => fn() } = {}) {
  // A new query string gives the planner a fresh one-pass-per-identity set.
  let planner = await import('../src/momentCleanup.js?hook-test=' + ++start)
  const { runCleanupPass } = await import('../src/momentCleanupPass.js')
  const { momentsOf } = await import('../src/momentSeen.js')
  const idle = deferred()
  const calls = []
  const attempts = []
  const sent = []
  const refs = []
  const effects = []
  const layouts = []
  let refIndex = 0
  let effectIndex = 0
  let layoutIndex = 0
  let visible = true
  let online = true
  let onVisible
  let onOnline
  let args = null
  let running = null
  let changed = 0
  let writes = 0
  const store = {
    exclusive,
    read: (identity) => values.get(identity) ?? null,
    write: async (identity, text) => {
      values.set(identity, text)
      writes++
      if (onWrite) await onWrite(writes, JSON.parse(text), h)
    }
  }
  const effect = (slots, index, fn, deps) => {
    const previous = slots[index]
    if (previous && deps.every((v, i) => v === previous.deps[i])) return
    if (previous?.cleanup) previous.cleanup()
    slots[index] = { deps, cleanup: fn() }
  }
  const deps = {
    useRef: (value) => refs[refIndex++] || (refs[refIndex - 1] = { current: value }),
    useEffect: (fn, list) => effect(effects, effectIndex++, fn, list),
    useLayoutEffect: (fn, list) => effect(layouts, layoutIndex++, fn, list),
    createCleanupPlanner: (options) => planner.createCleanupPlanner(options),
    store,
    runCleanupPass: (options) => {
      args = options
      running = runCleanupPass(options)
      return running
    },
    momentsOf,
    momentsChanged: () => { changed++ },
    isVisible: () => visible,
    isOnline: () => online,
    subscribeVisible: (fn) => { onVisible = fn; return () => calls.push('offVisible') },
    subscribeOnline: (fn) => { onOnline = fn; return () => calls.push('offOnline') }
  }
  const source = fs.readFileSync(HOOK, 'utf8').replace(/^import .*\n/gm, '')
  const slot = '__momentCleanupHook' + start
  globalThis[slot] = deps
  let hook
  try {
    const prelude = 'const { ' + Object.keys(deps).join(', ') + ' } = globalThis[' + JSON.stringify(slot) + ']\n'
    hook = (await import('data:text/javascript;base64,' + Buffer.from(prelude + source).toString('base64'))).useMomentCleanup
  } finally {
    delete globalThis[slot]
  }
  const answers = {
    'moments.read': () => ({ authors: [], own: [], past }),
    'moment.delete': () => ({})
  }
  const node = {
    phase: 'ready',
    hosted: true,
    config: {},
    epoch: 1,
    online: true,
    visible: true,
    sync: { active: null, stopped: null, starting: false },
    passkey: { generation: 1, status: { unlocked: true, publicKey: OWN } },
    // As the request queue: a gate closed at launch rejects as never sent.
    request: async (method, params, options) => {
      attempts.push(method)
      if ((options?.signal && options.signal.aborted) || (options?.gate && !options.gate())) {
        throw Object.assign(new Error('pedido cancelado'), { queued: true })
      }
      sent.push([method, params, options])
      if (answer) return answer(method, params, h)
      return answers[method]()
    },
    whenIdle: (ms) => { calls.push(['idle', ms]); return { promise: idle.promise, cancel: () => calls.push('cancel') } }
  }
  const render = (props = {}) => {
    refIndex = effectIndex = layoutIndex = 0
    hook({ node, identity: OWN, enabled: true, ...props })
  }
  const h = {
    node,
    calls,
    attempts,
    sent,
    idle,
    render,
    values,
    args: () => args,
    running: () => running,
    changed: () => changed,
    ledger: () => JSON.parse(values.get(OWN) ?? '[]'),
    methods: () => sent.map((entry) => entry[0]),
    // A fresh one-pass-per-identity set, so a later turn can run a pass again.
    freshPlanner: async () => { planner = await import('../src/momentCleanup.js?hook-test=' + ++start) },
    lock: () => {
      node.passkey = { generation: 2, status: { unlocked: false } }
      render()
    },
    hide: () => { visible = false; onVisible(false) },
    offline: () => { online = false; onOnline(false) },
    cleanup: () => {
      for (const s of [...layouts, ...effects]) if (s.cleanup) s.cleanup()
    }
  }
  return h
}

async function begin (h) {
  h.render()
  h.idle.resolve()
  await flush()
}

test('App mounts useMomentCleanup once, after the cover backfill, with the setup gate', (t) => {
  const src = fs.readFileSync(APP, 'utf8')
  t.is(src.split('useMomentCleanup({').length - 1, 1, 'mounted exactly once')
  t.is(src.split("import { useMomentCleanup } from './src/useMomentCleanup'").length - 1, 1, 'imported once')
  const blockOf = (name) => {
    const at = src.indexOf(name + '({')
    return src.slice(at, src.indexOf('})', at))
  }
  const enabledOf = (block) => block.split('\n').find((line) => line.trim().startsWith('enabled:'))
  const block = blockOf('useMomentCleanup')
  const cover = blockOf('useCoverBackfill')
  t.ok(block.includes('identity: ownKey'))
  t.ok(block.includes(GATE))
  t.ok(enabledOf(block), 'has an enabled line')
  t.is(enabledOf(block), enabledOf(cover), 'same gate as the cover backfill')
  t.ok(src.indexOf('useCoverBackfill({') < src.indexOf('useMomentCleanup({'), 'mounted after useCoverBackfill')
})

test('hook source has no page leg and no actAs', (t) => {
  const src = fs.readFileSync(HOOK, 'utf8')
  t.absent(src.includes('actAs'))
  t.absent(/from '\.\/pages?'/.test(src))
})

test('hook makes no request while gated', async (t) => {
  for (const [name, patch] of [
    ['locked', { passkey: { generation: 1, status: { unlocked: false, publicKey: OWN } } }],
    ['other identity', { passkey: { generation: 1, status: { unlocked: true, publicKey: OTHER } } }],
    ['node starting', { phase: 'starting' }],
    ['not hosted', { hosted: false }],
    ['config null', { config: null }],
    ['offline', { online: false }],
    ['hidden', { visible: false }],
    ['once sync run', { sync: { active: { runId: 1, once: true }, stopped: null, starting: false } }],
    ['sync starting', { sync: { active: null, stopped: null, starting: true } }]
  ]) {
    const h = await hookFixture()
    Object.assign(h.node, patch)
    await begin(h)
    t.alike(h.calls, [], name + ': does not even wait')
    t.alike(h.attempts, [], name + ': no request')
    t.is(h.args(), null)
  }
  const h = await hookFixture()
  h.render({ enabled: false })
  h.idle.resolve()
  await flush()
  t.alike(h.attempts, [], 'disabled: no request')
})

test('hook makes no request when hidden or offline before idle', async (t) => {
  for (const change of [(h) => h.hide(), (h) => h.offline()]) {
    const h = await hookFixture()
    h.render()
    change(h)
    h.idle.resolve()
    await flush()
    t.alike(h.attempts, [])
    t.is(h.args(), null)
  }
})

test('a continuous sync does not hold the pass back', async (t) => {
  const h = await hookFixture()
  h.node.sync = { active: { runId: 1, once: false }, stopped: null, starting: false }
  await begin(h)
  await h.running()
  t.alike(h.methods(), ['moments.read', 'moments.read', 'moment.delete'])
})

test('hook deletes expired own momentos and tells the Momentos readers', async (t) => {
  const h = await hookFixture({ past: [expired(2), expired(1), { ...expired(3), at: new Date().toISOString() }] })
  await begin(h)
  t.alike(h.calls, [['idle', 4000]])
  t.is(await h.running(), 2)
  await flush()
  t.alike(h.sent.filter((e) => e[0] === 'moment.delete').map((e) => e[1]), [{ to: ref(1) }, { to: ref(2) }], 'oldest first, the live one kept')
  for (const [, , options] of h.sent) {
    t.ok(options.signal && typeof options.gate === 'function', 'every request carries the signal and the gate')
  }
  t.alike(h.ledger(), [{ ref: ref(1), tries: 1, state: 'done' }, { ref: ref(2), tries: 1, state: 'done' }])
  t.is(h.changed(), 1)
})

test('no request after an epoch change, a lock or a sync start', async (t) => {
  for (const change of [
    (h) => { h.node.epoch++; h.render() },
    (h) => h.lock(),
    (h) => { h.node.sync = { active: null, stopped: null, starting: true }; h.render() },
    (h) => { h.node.sync = { active: { runId: 2, once: true }, stopped: null, starting: false }; h.render() },
    (h) => { h.node.passkey.generation++; h.render() },
    (h) => h.render({ identity: OTHER }),
    (h) => h.hide(),
    (h) => h.offline(),
    (h) => h.cleanup()
  ]) {
    const reading = deferred()
    const h = await hookFixture({ answer: (method) => method === 'moments.read' ? reading.promise : {} })
    await begin(h)
    await until(() => h.sent.length === 1)
    const pass = h.args()
    const running = h.running()
    t.ok(pass.alive())
    change(h)
    t.absent(pass.alive())
    reading.resolve({ authors: [], own: [], past: [expired(1)] })
    t.is(await running, 0)
    await flush()
    t.alike(h.methods(), ['moments.read'], 'nothing after the change')
    t.alike(h.ledger(), [], 'no claim left behind')
    t.is(h.changed(), 0)
    h.cleanup()
  }
})

test('remove refuses before sending once the pass stopped', async (t) => {
  const { outcomeOf } = await import('../src/momentCleanup.js')
  const h = await hookFixture({ past: [] })
  await begin(h)
  await h.running()
  h.lock()
  const before = h.attempts.length
  const err = await h.args().remove(ref(1)).then(() => null, (e) => e)
  t.ok(err && err.queued === true)
  t.is(outcomeOf(err), 'refused', 'the pass gives the try back')
  t.is(h.attempts.length, before, 'nothing was handed to request')
})

test('a lock between claim and send sends nothing and restores the entry (O6)', async (t) => {
  const priors = [
    [],
    [{ ref: ref(1), tries: 1, state: 'failed' }],
    [{ ref: ref(1), tries: 2, state: 'uncertain' }]
  ]
  for (const prior of priors) {
    // Locked right after the claim is written.
    const values = new Map(prior.length ? [[OWN, JSON.stringify(prior)]] : [])
    const h = await hookFixture({
      values,
      onWrite: (n, ledger, fx) => {
        if (ledger.some((e) => e.state === 'pending')) fx.lock()
      }
    })
    await begin(h)
    await h.running()
    t.absent(h.methods().includes('moment.delete'), 'never sent')
    t.alike(h.ledger(), prior, 'entry as it was before the claim')
    t.is(h.changed(), 0)
  }
  for (const prior of priors) {
    // Locked while the fresh list is in flight; its answer still arrives.
    const values = new Map(prior.length ? [[OWN, JSON.stringify(prior)]] : [])
    const second = deferred()
    let reads = 0
    const h = await hookFixture({
      values,
      answer: (method) => {
        if (method !== 'moments.read') return {}
        return ++reads === 2 ? second.promise : { authors: [], own: [], past: [expired(1)] }
      }
    })
    await begin(h)
    await until(() => h.sent.length === 2)
    t.is(h.ledger().find((e) => e.ref === ref(1)).state, 'pending', 'claimed')
    h.lock()
    second.resolve({ authors: [], own: [], past: [expired(1)] })
    await h.running()
    t.alike(h.methods(), ['moments.read', 'moments.read'], 'never sent')
    t.alike(h.ledger(), prior, 'entry as it was before the claim')
  }
})

test('an answer that arrives after the pass stopped still settles done', async (t) => {
  const deleting = deferred()
  const h = await hookFixture({
    answer: (method) => method === 'moment.delete' ? deleting.promise : { authors: [], own: [], past: [expired(2), expired(1)] }
  })
  await begin(h)
  await until(() => h.methods().includes('moment.delete'))
  h.lock()
  t.absent(h.args().alive())
  deleting.resolve({})
  t.is(await h.running(), 1)
  await flush()
  t.alike(h.ledger(), [{ ref: ref(1), tries: 1, state: 'done' }])
  t.is(h.methods().filter((m) => m === 'moment.delete').length, 1, 'the second one is not sent')
  t.is(h.changed(), 1)
})

test('a read that is not a whole moments.read answer fails and settles nothing', async (t) => {
  const prior = [{ ref: ref(5), tries: 1, state: 'pending' }]
  for (const [name, answer] of [
    ['failed request', () => { throw new Error('falhou') }],
    ['not an object', () => null],
    ['no past', () => ({ authors: [], own: [] })],
    ['past not a list', () => ({ authors: [], own: [], past: {} })],
    ['malformed item', () => ({ authors: [], own: [], past: [expired(1), { seq: 'x' }] })]
  ]) {
    const h = await hookFixture({ values: new Map([[OWN, JSON.stringify(prior)]]), answer })
    await begin(h)
    t.is(await h.running(), 0, name)
    t.alike(h.ledger(), prior, name + ': no entry settled as gone')
    t.absent(h.methods().includes('moment.delete'))
    const err = await h.args().listPast().then(() => null, (e) => e)
    t.ok(err, name + ': listPast throws')
  }
})

test('a pass without the Web Lock does not tell the Momentos readers', async (t) => {
  const h = await hookFixture({ exclusive: async () => null })
  await begin(h)
  t.is(await h.running(), null)
  await flush()
  t.alike(h.attempts, [], 'no read without the lock')
  t.is(h.changed(), 0)
})

const ALL = [expired(5), expired(4), expired(3), expired(2), expired(1)]
const idleSync = () => ({ active: null, stopped: null, starting: false })

test('the once runs a delete starts itself do not stop the pass', async (t) => {
  for (const stale of [false, true]) {
    let runId = 10
    const h = await hookFixture({
      answer: (method, params, fx) => {
        if (method === 'moments.read') return { authors: [], own: [], past: ALL }
        // As session.js: ensureCaughtUp and pushAfterWrite emit sync.started
        // { once: true } and sync.stopped before the answer.
        const id = ++runId
        fx.node.sync = { active: { runId: id, once: true }, stopped: null, starting: false }
        fx.render()
        const finish = () => {
          fx.node.sync = { active: null, stopped: { runId: id }, starting: false }
          fx.render()
        }
        // Stale: the answer is read before sync.stopped renders.
        if (stale) setImmediate(finish)
        else finish()
        return {}
      }
    })
    await begin(h)
    t.is(await h.running(), 4, 'a whole pass')
    await flush()
    t.alike(h.sent.filter((e) => e[0] === 'moment.delete').map((e) => e[1].to), [ref(1), ref(2), ref(3), ref(4)])
    t.alike(h.ledger(), [1, 2, 3, 4].map((seq) => ({ ref: ref(seq), tries: 1, state: 'done' })))
    t.is(h.changed(), 1)
  }
})

test('a once run first seen with no own delete in flight stops the pass', async (t) => {
  const h = await hookFixture({
    past: ALL,
    onWrite: (n, ledger, fx) => {
      if (!ledger.some((e) => e.state === 'pending')) return
      fx.node.sync = { active: { runId: 99, once: true }, stopped: null, starting: false }
      fx.render()
    }
  })
  await begin(h)
  t.is(await h.running(), 0)
  t.absent(h.methods().includes('moment.delete'), 'nothing sent')
  t.alike(h.ledger(), [], 'the claim was given back')
  // The same foreign run is still active while later state renders.
  h.node.sync = { active: { runId: 99, once: true }, stopped: null, starting: false }
  h.render()
  t.absent(h.args().alive())
  t.is(h.changed(), 0)

  let runId = 0
  const after = await hookFixture({
    answer: (method, params, fx) => {
      if (method === 'moments.read') return { authors: [], own: [], past: ALL }
      const id = ++runId
      fx.node.sync = { active: { runId: id, once: true }, stopped: null, starting: false }
      fx.render()
      fx.node.sync = idleSync()
      fx.render()
      return {}
    },
    // A Sincronizar between two deletes, as the first one settles: a once run
    // the pass did not send.
    onWrite: (n, ledger, fx) => {
      if (!ledger.some((e) => e.state === 'done') || ledger.some((e) => e.state === 'pending')) return
      fx.node.sync = { active: { runId: 500, once: true }, stopped: null, starting: false }
      fx.render()
    }
  })
  await begin(after)
  t.is(await after.running(), 1)
  t.is(after.methods().filter((m) => m === 'moment.delete').length, 1, 'no send after the foreign run')
  t.alike(after.ledger(), [{ ref: ref(1), tries: 1, state: 'done' }])
})

test('a sync start during an own delete ends the pass after that answer settles', async (t) => {
  const h = await hookFixture({
    answer: (method, params, fx) => {
      if (method === 'moments.read') return { authors: [], own: [], past: ALL }
      fx.node.sync = { active: null, stopped: null, starting: true }
      fx.render()
      return {}
    }
  })
  await begin(h)
  t.is(await h.running(), 1)
  await flush()
  t.is(h.methods().filter((m) => m === 'moment.delete').length, 1)
  t.alike(h.ledger(), [{ ref: ref(1), tries: 1, state: 'done' }], 'settled done')
  t.is(h.changed(), 1)
})

test('an own run id is not trusted under another epoch or identity', async (t) => {
  const expiredOf = (seq, key) => ({ ...expired(seq), ref: key + ':' + seq })
  for (const change of ['epoch', 'identity']) {
    let recording = true
    let who = OWN
    let list = [expiredOf(1, OWN)]
    const h = await hookFixture({
      answer: (method, params, fx) => {
        if (method === 'moments.read') return { authors: [], own: [], past: list }
        if (recording) {
          fx.node.sync = { active: { runId: 7, once: true }, stopped: null, starting: false }
          fx.render()
          fx.node.sync = idleSync()
          fx.render()
        }
        return {}
      }
    })
    await begin(h)
    t.is(await h.running(), 1, change + ': run 7 was the first delete\'s own')
    recording = false
    await h.freshPlanner()
    const before = h.methods().length
    // The next session reuses run id 7 for a one-off sync of its own.
    const foreign = { active: { runId: 7, once: true }, stopped: null, starting: false }
    const props = {}
    if (change === 'epoch') {
      h.node.epoch = 2
    } else {
      who = OTHER
      props.identity = OTHER
      h.node.passkey = { generation: 1, status: { unlocked: true, publicKey: OTHER } }
    }
    list = [expiredOf(2, who)]
    h.node.sync = foreign
    h.render(props)
    await flush()
    await flush()
    t.is(h.methods().length, before, change + ': nothing sent during the other run 7')
    h.node.sync = idleSync()
    h.render(props)
    await until(() => h.methods().filter((m) => m === 'moment.delete').length === 2)
    t.alike(h.sent.filter((e) => e[0] === 'moment.delete').map((e) => e[1].to), [ref(1), who + ':2'], change + ': the pass runs once that run ends')
    h.cleanup()
  }
})

test('hook waits for idle and cancels the idle handle on cleanup', async (t) => {
  const h = await hookFixture()
  h.render()
  t.alike(h.calls, [['idle', 4000]])
  h.cleanup()
  h.idle.resolve()
  await flush()
  t.is(h.args(), null, 'late idle resolution cannot begin')
  t.alike(h.attempts, [])
  t.ok(h.calls.includes('cancel'))
  t.ok(h.calls.includes('offVisible'))
  t.ok(h.calls.includes('offOnline'))
})

test('moment cleanup web store uses identity keys and refuses failed reads and writes', async (t) => {
  const store = await import('../src/momentCleanupStore.web.js')
  const values = new Map()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, text) => values.set(key, text)
    }
  })
  t.teardown(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  t.is(store.read(OWN), null)
  await store.write(OWN, JSON.stringify([{ ref: ref(1), tries: 1, state: 'done' }]))
  t.is(store.read(OWN), values.get('varanda.momentCleanup.' + OWN))
  t.is(store.read(OTHER), null)
  globalThis.localStorage.getItem = () => { throw new Error('denied') }
  t.is(store.read(OWN), null)
  await t.exception(store.write(OWN, '[]'), /Registro de momentos indisponível\./)
  t.alike(JSON.parse(values.get('varanda.momentCleanup.' + OWN)), [{ ref: ref(1), tries: 1, state: 'done' }])
  globalThis.localStorage.getItem = (key) => values.get(key) ?? null
  store.read(OWN)
  globalThis.localStorage.setItem = () => { throw new Error('quota') }
  await t.exception(store.write(OWN, '[]'), /quota/)
  delete globalThis.localStorage
  t.is(store.read(OTHER), null)
  await t.exception(store.write(OTHER, '[]'))
})

const nativeStub = `
export const Paths = { document: { uri: 'file:///stub/Documents/' } }
export class File {
  constructor (dir, name) { this.uri = dir.uri + name }
  get exists () { return globalThis.__momentCleanupFiles.has(this.uri) }
  create () { globalThis.__momentCleanupFiles.set(this.uri, '') }
  write (text) {
    if (globalThis.__momentCleanupFailWrite) {
      globalThis.__momentCleanupFiles.set(this.uri, text.slice(0, 5))
      throw new Error('disk full')
    }
    globalThis.__momentCleanupFiles.set(this.uri, text)
  }
  async text () { return globalThis.__momentCleanupFiles.get(this.uri) }
  delete () { globalThis.__momentCleanupFiles.delete(this.uri) }
  move (dest) {
    if (globalThis.__momentCleanupFailMove && this.uri.endsWith('.tmp')) throw new Error('move failed')
    if (dest.exists) throw new Error('exists')
    globalThis.__momentCleanupFiles.set(dest.uri, globalThis.__momentCleanupFiles.get(this.uri))
    globalThis.__momentCleanupFiles.delete(this.uri)
    this.uri = dest.uri
  }
}
`
const hooks = `
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(nativeStub))}, shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

test('moment cleanup native store keeps one atomic file and falls back to the backup', async (t) => {
  const store = await import('../src/momentCleanupStore.native.js')
  const files = new Map()
  const globals = ['__momentCleanupFiles', '__momentCleanupFailWrite', '__momentCleanupFailMove']
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  t.teardown(() => {
    for (const [i, name] of globals.entries()) {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i])
      else delete globalThis[name]
    }
  })
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: false })
  }
  globalThis.__momentCleanupFiles = files
  const name = 'file:///stub/Documents/varanda-moment-cleanup.json'
  const text = JSON.stringify([{ ref: ref(1), tries: 1, state: 'pending' }])
  t.is(await store.read(OWN), null)
  await store.write(OWN, text)
  t.is(await store.read(OWN), text)
  t.alike([...files.keys()], [name])
  for (const failure of ['__momentCleanupFailWrite', '__momentCleanupFailMove']) {
    globalThis[failure] = true
    await t.exception(store.write(OWN, JSON.stringify([{ ref: ref(1), tries: 1, state: 'done' }])))
    globalThis[failure] = false
    t.is(await store.read(OWN), text, 'pending survives ' + failure)
    t.alike([...files.keys()], [name], 'temporary files cleaned up')
  }
  files.set(name + '.bak', files.get(name))
  files.delete(name)
  t.is(await store.read(OWN), text)
  await store.write(OTHER, JSON.stringify([{ ref: OTHER + ':2', tries: 1, state: 'done' }]))
  t.is(await store.read(OWN), text, 'another identity preserves the backup ledger')
  t.alike([...files.keys()], [name])
  globalThis.__momentCleanupFiles = null
  await t.exception.all(store.read(OWN))
  await t.exception.all(store.write(OWN, text))
})

test('web moment cleanup exclusive requires Web Locks and holds the lock until the pass settles', async (t) => {
  const { exclusive } = await import('../src/momentCleanupStore.web.js')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const navigator = {}
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator })
  t.teardown(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  })
  let calls = 0
  t.is(await exclusive(() => ++calls), null)
  t.is(calls, 0, 'missing Web Locks disables moment cleanup')
  let held = false
  navigator.locks = {
    request: async (name, options, fn) => {
      t.is(name, 'varanda-moment-cleanup')
      t.alike(options, { ifAvailable: true })
      if (held) return fn(null)
      held = true
      try { return await fn({ name }) } finally { held = false }
    }
  }
  let release
  const pending = exclusive(() => new Promise((resolve) => { release = resolve }))
  t.ok(held)
  t.is(await exclusive(() => ++calls), null)
  t.is(calls, 0, 'unavailable lock skips the callback')
  release('done')
  t.is(await pending, 'done')
  t.absent(held)
  t.is(await exclusive(() => ++calls), 1)
})
