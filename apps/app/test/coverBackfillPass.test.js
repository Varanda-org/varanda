'use strict'

const test = require('brittle')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OWN = 'ab'.repeat(32)
const PAGE = 'cd'.repeat(32)
const OTHER = 'ef'.repeat(32)
const AVIF = Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 97, 118, 105, 102])
const JPEG = Uint8Array.from([255, 216, 255, 217])
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const image = { core: OTHER, start: 1, blocks: 1, bytes: AVIF.length, mime: 'image/avif', sha256: hash(AVIF), width: 1600, height: 1200 }
const post = { type: 'post', text: 'Publicação antiga', media: [image] }
const row = (seq) => ({ seq, image })
const own = (seq = 1) => OWN + ':' + seq
const page = (seq = 1) => PAGE + ':' + seq
let start = 0
const loadPlanner = () => import('../src/coverBackfill.js?pass-test=' + ++start)
const load = () => import('../src/coverBackfillPass.js')

async function fixture (options = {}) {
  const { runBackfillPass } = await load()
  const log = []
  const values = new Map()
  const store = {
    read: (identity) => values.get(identity) ?? null,
    write: async (identity, text) => {
      const entries = JSON.parse(text)
      const last = entries[entries.length - 1]
      log.push([last.outcome === 'pending' ? 'claim' : 'settle', last.ref, last.outcome])
      if (options.claimFails && last.outcome === 'pending') throw new Error('disk')
      if (options.settleFails && last.outcome !== 'pending') throw new Error('disk')
      values.set(identity, text)
    }
  }
  let live = true
  let ownReads = 0
  let pageReads = 0
  const config = {
    identity: OWN,
    alive: () => live,
    listOwn: async () => {
      log.push(['listOwn'])
      ownReads++
      if (options.ownError) throw options.ownError
      if (options.ownAnswer !== undefined) return options.ownAnswer
      return { posts: options.covered && ownReads > 1 ? [] : (options.own ?? [row(1)]), more: false }
    },
    listPages: async (only) => {
      log.push(['listPages', only])
      pageReads++
      if (options.pageGone && pageReads > 1) return []
      return options.pages ?? []
    },
    readPost: async (candidate) => {
      log.push(['readPost', candidate.ref])
      return options.missing ? null : options.post ?? post
    },
    buildDeps: (candidate) => ({
      fetchStill: async (source) => {
        log.push(['fetch', candidate.ref, source])
        if (options.fetchFails) throw new Error('fetch')
        return AVIF
      },
      encodeThumbnail: async (bytes, mime) => {
        log.push(['encode', candidate.ref, mime])
        if (options.dieBeforeUpload) live = false
        return options.noDecode ? null : { bytes: JPEG, mime: 'image/jpeg', width: 1200, height: 900 }
      },
      upload: async (built) => {
        log.push(['upload', candidate.ref])
        if (options.uploadError) throw options.uploadError
        if (options.dieBeforeCover) live = false
        return { ...image, mime: built.mime, bytes: built.bytes.length, sha256: hash(built.bytes), width: built.width, height: built.height }
      },
      setCover: async () => {
        log.push([candidate.kind === 'own' ? 'post.cover' : 'post-cover', candidate.ref])
        return options.result ?? { state: 'on' }
      }
    })
  }
  const { createBackfillPlanner } = await loadPlanner()
  const planner = createBackfillPlanner({ store, identity: OWN })
  return {
    log,
    config,
    store,
    ledger: () => JSON.parse(values.get(OWN) || '[]'),
    run: () => runBackfillPass({ ...config, planner }),
    restart: async () => {
      const { createBackfillPlanner } = await loadPlanner()
      await runBackfillPass({ ...config, planner: createBackfillPlanner({ store, identity: OWN }) })
    }
  }
}

const calls = (f, name) => f.log.filter((entry) => entry[0] === name)
const sent = (f) => f.log.filter((entry) => ['upload', 'post.cover', 'post-cover'].includes(entry[0]))

test('old shared AVIF gets one cover without a tap, after durable claim', async (t) => {
  const f = await fixture({ own: [row(1), row(2)] })
  await f.run()
  t.alike(sent(f), [['upload', own(1)], ['post.cover', own(1)], ['upload', own(2)], ['post.cover', own(2)]])
  for (const seq of [1, 2]) {
    const steps = f.log.filter((entry) => entry[1] === own(seq)).map((entry) => entry[0])
    t.alike(steps, ['claim', 'readPost', 'fetch', 'encode', 'upload', 'post.cover', 'settle'], 'claim precedes even the stored record request')
  }
  t.alike(f.ledger(), [{ ref: own(1), outcome: 'done' }, { ref: own(2), outcome: 'done' }])
  await f.run()
  await f.restart()
  t.is(calls(f, 'upload').length, 2, 'neither same start nor a new planner and process repeat a post')
})

test('failed and uncertain attempts survive a new planner over the same store', async (t) => {
  for (const [options, outcome] of [
    [{ fetchFails: true }, 'failed'],
    [{ uploadError: new Error('upload') }, 'failed'],
    [{ result: { state: 'off' } }, 'failed'],
    [{ result: { state: 'uncertain' } }, 'uncertain'],
    [{ uploadError: Object.assign(new Error('lost'), { uncertain: true }) }, 'uncertain']
  ]) {
    const f = await fixture(options)
    await f.run()
    t.alike(f.ledger(), [{ ref: own(), outcome }])
    const before = [...sent(f)]
    await f.restart()
    t.alike(sent(f), before, 'no later send')
    t.is(calls(f, 'fetch').length, 1, 'no later fetch')
  }
})

test('uncertain and unexpected answers stop before the next candidate', async (t) => {
  for (const result of [{ state: 'uncertain' }, { state: 'unknown' }, {}]) {
    const f = await fixture({ own: [row(1), row(2)], result })
    await f.run()
    t.alike(f.ledger(), [{ ref: own(), outcome: 'uncertain' }])
    t.is(calls(f, 'fetch').length, 1)
  }
})

test('fresh uncovered read excludes a post covered or unshared meanwhile', async (t) => {
  const f = await fixture({ covered: true })
  await f.run()
  t.is(calls(f, 'listOwn').length, 2)
  t.is(calls(f, 'encode').length, 1)
  t.alike(sent(f), [])
  t.is(f.ledger()[0].outcome, 'failed')
})

test('a dead pass sends neither an upload nor a later cover', async (t) => {
  const beforeUpload = await fixture({ own: [row(1), row(2)], dieBeforeUpload: true })
  await beforeUpload.run()
  t.alike(sent(beforeUpload), [])
  t.is(calls(beforeUpload, 'claim').length, 1)
  const beforeCover = await fixture({ own: [row(1), row(2)], dieBeforeCover: true })
  await beforeCover.run()
  t.alike(sent(beforeCover), [['upload', own()]])
  t.is(calls(beforeCover, 'claim').length, 1)
})

test('unknown method, core refusal and malformed uncovered answers attempt nothing', async (t) => {
  for (const options of [
    { ownError: Object.assign(new Error('método desconhecido'), { code: 'USAGE' }) },
    { ownError: Object.assign(new Error('A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.'), { code: 'USAGE' }) },
    ...[null, {}, { posts: [row(1)] }, { posts: [row(2), row(1)], more: false }, { posts: [{ seq: 1, image: {} }], more: false }, { posts: [row(1)], more: 'yes' }].map((ownAnswer) => ({ ownAnswer }))
  ]) {
    const f = await fixture(options)
    await f.run()
    t.alike(f.ledger(), [])
    t.alike(sent(f), [])
  }
})

test('absent page uncovered means no attempt; a pass caps pages at one', async (t) => {
  const absent = await fixture({ own: [], pages: [{ page: PAGE, status: {} }] })
  await absent.run()
  t.alike(absent.ledger(), [])
  const f = await fixture({ own: [row(1), row(2)], pages: [{ page: PAGE, status: { uncovered: [row(1), row(2)] } }] })
  await f.run()
  t.alike(sent(f), [['upload', own(1)], ['post.cover', own(1)], ['upload', own(2)], ['post.cover', own(2)], ['upload', page()], ['post-cover', page()]])
  t.alike(calls(f, 'listPages'), [['listPages', null], ['listPages', PAGE]], 're-read the selected page')
  const gone = await fixture({ own: [], pageGone: true, pages: [{ page: PAGE, status: { uncovered: [row(1)] } }] })
  await gone.run()
  t.alike(sent(gone), [], 'lost page role or refused status prevents upload')
})

test('four posts exhaust the automatic pass', async (t) => {
  const f = await fixture({ own: [1, 2, 3, 4, 5].map(row), pages: [{ page: PAGE, status: { uncovered: [row(1)] } }] })
  await f.run()
  t.is(calls(f, 'upload').length, 4)
  t.is(calls(f, 'post-cover').length, 0)
})

test('null decode records no-decode without sending anything', async (t) => {
  const f = await fixture({ noDecode: true })
  await f.run()
  t.alike(sent(f), [])
  t.alike(f.ledger(), [{ ref: own(), outcome: 'no-decode' }])
  await f.restart()
  t.is(calls(f, 'fetch').length, 1)
})

test('missing records fail and posts needing no cover finish without sending', async (t) => {
  const missing = await fixture({ missing: true })
  await missing.run()
  t.alike(missing.ledger(), [{ ref: own(), outcome: 'failed' }])
  const skipped = await fixture({ post: { type: 'post', text: 'Sem foto' } })
  await skipped.run()
  t.alike(skipped.ledger(), [{ ref: own(), outcome: 'done' }])
  t.alike(sent(skipped), [])
})

test('claim and settle failures end the pass without another attempt', async (t) => {
  const claim = await fixture({ own: [row(1), row(2)], claimFails: true })
  await claim.run()
  t.is(calls(claim, 'readPost').length, 0)
  t.is(calls(claim, 'fetch').length, 0)
  t.alike(sent(claim), [])
  const settle = await fixture({ own: [row(1), row(2)], settleFails: true })
  await settle.run()
  t.alike(settle.ledger(), [{ ref: own(), outcome: 'pending' }])
  t.is(calls(settle, 'upload').length, 1)
})

test('page roster comes from owned/admin and current status, never invites', async (t) => {
  const { listBackfillPages } = await load()
  let statusCalls = 0
  const data = { owned: [{ page: PAGE }], admin: [{ page: OTHER }], invites: [{ page: OWN }] }
  const deps = {
    identity: OWN,
    alive: () => true,
    list: async () => data,
    status: async (page) => {
      statusCalls++
      return { owner: page === PAGE ? OWN : PAGE, admins: page === OTHER ? [OWN] : [], uncovered: [row(1)] }
    }
  }
  t.alike((await listBackfillPages(deps)).map((r) => r.page), [PAGE, OTHER])
  t.is(statusCalls, 2)
  for (const status of [async () => ({}), async () => ({ owner: OTHER, admins: [] }), async () => { throw new Error('sem-permissao') }, async () => ({ owner: OWN, closed: true })]) {
    t.alike(await listBackfillPages({ ...deps, status }), [])
  }
  t.alike(await listBackfillPages({ ...deps, list: async () => ({ owned: [], admin: [] }) }, PAGE), [], 'role loss on re-read')
  t.alike(await listBackfillPages({ ...deps, alive: () => false }), [])
})

test('shell mounts backfill once with the existing setup and Terms gates', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.is((app.match(/useCoverBackfill\(\{/g) || []).length, 1)
  t.ok(app.includes('identity: ownKey'))
  t.ok(app.includes('enabled: ready && !locked && setupDone && termsOk && ageClear && phoneClear'))
})

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function hookFixture () {
  const idle = deferred()
  const calls = []
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
  let pass = null
  const effect = (slots, index, fn, deps) => {
    const previous = slots[index]
    if (previous && deps.every((v, i) => v === previous.deps[i])) return
    if (previous?.cleanup) previous.cleanup()
    slots[index] = { deps, cleanup: fn() }
  }
  const deps = {
    useRef: (value) => refs[refIndex++] || (refs[refIndex - 1] = { current: value }),
    useEffect: (fn, args) => effect(effects, effectIndex++, fn, args),
    useLayoutEffect: (fn, args) => effect(layouts, layoutIndex++, fn, args),
    createBackfillPlanner: () => ({}),
    store: {},
    runBackfillPass: async (args) => { pass = args; calls.push('pass') },
    listBackfillPages: async () => [],
    actAs: async () => ({}),
    pagesPostCover: async (node) => {
      await node.request('page.sign', {})
      calls.push('page HTTP write')
      return { coverSeq: 2, created: true }
    },
    pagesUploadEncoded: async () => {},
    coverAsPage: async (write) => write({}),
    addCover: async () => {},
    diaryPeekSlots: { run: (fn) => fn() },
    encodeThumbnail: async () => null,
    fetchMedia: async () => AVIF,
    nativeSubtle: undefined,
    isAppClient: () => false,
    expoFetch: undefined,
    isVisible: () => visible,
    isOnline: () => online,
    subscribeVisible: (fn) => { onVisible = fn; return () => calls.push('offVisible') },
    subscribeOnline: (fn) => { onOnline = fn; return () => calls.push('offOnline') }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/useCoverBackfill.js'), 'utf8')
    .replace(/^import .*\n/gm, '')
  const slot = '__backfillHook' + ++start
  globalThis[slot] = deps
  let hook
  try {
    const prelude = 'const { ' + Object.keys(deps).join(', ') + ' } = globalThis[' + JSON.stringify(slot) + ']\n'
    hook = (await import('data:text/javascript;base64,' + Buffer.from(prelude + source).toString('base64'))).useCoverBackfill
  } finally {
    delete globalThis[slot]
  }
  const node = {
    hosted: true,
    config: {},
    epoch: 1,
    online: true,
    visible: true,
    passkey: { generation: 1, status: { unlocked: true, publicKey: OWN } },
    request: async () => ({}),
    media: { upload: async () => {} },
    whenIdle: (ms) => { calls.push(['idle', ms]); return { promise: idle.promise, cancel: () => calls.push('cancel') } }
  }
  const render = (args = {}) => {
    refIndex = effectIndex = layoutIndex = 0
    hook({ node, identity: OWN, enabled: true, ...args })
  }
  return {
    node,
    calls,
    idle,
    render,
    pass: () => pass,
    hide: () => { visible = false; onVisible(false) },
    offline: () => { online = false; onOnline(false) },
    cleanup: () => {
      for (const slot of [...layouts, ...effects]) if (slot.cleanup) slot.cleanup()
    }
  }
}

test('hook waits for idle and cancels the idle handle on cleanup', async (t) => {
  const h = await hookFixture()
  h.render()
  t.alike(h.calls, [['idle', 4000]])
  h.cleanup()
  h.idle.resolve()
  await flush()
  t.is(h.pass(), null, 'late idle resolution cannot begin')
  t.ok(h.calls.includes('cancel'))
  t.ok(h.calls.includes('offVisible'))
  t.ok(h.calls.includes('offOnline'))
})

test('hook gates hosted, unlocked, setup/Terms, visibility, connectivity and vitrine', async (t) => {
  for (const patch of [
    { hosted: false }, { config: null }, { online: false }, { visible: false },
    { passkey: { status: { unlocked: false, publicKey: OWN } } },
    { passkey: { status: { unlocked: true, publicKey: OTHER } } }
  ]) {
    const h = await hookFixture()
    Object.assign(h.node, patch)
    h.render()
    h.idle.resolve()
    await flush()
    t.is(h.pass(), null)
    t.alike(h.calls, [], 'does not even wait')
  }
  const h = await hookFixture()
  h.render({ enabled: false })
  h.idle.resolve()
  await flush()
  t.is(h.pass(), null)
})

test('hook alive ends on cleanup, lock, background, offline, identity and epoch changes', async (t) => {
  for (const change of [
    (h) => h.cleanup(),
    (h) => { h.node.passkey = { generation: 2, status: { unlocked: false } }; h.render() },
    (h) => h.hide(),
    (h) => h.offline(),
    (h) => h.render({ identity: OTHER }),
    (h) => { h.node.epoch++; h.render() },
    (h) => { h.node.passkey.generation++; h.render() }
  ]) {
    const h = await hookFixture()
    h.render()
    h.idle.resolve()
    await flush()
    const pass = h.pass()
    t.ok(pass.alive())
    change(h)
    t.absent(pass.alive())
    h.cleanup()
  }
})

test('late page signature never reaches the HTTP write after cleanup', async (t) => {
  const h = await hookFixture()
  const signing = deferred()
  h.node.request = () => signing.promise
  h.render()
  h.idle.resolve()
  await flush()
  const deps = h.pass().buildDeps({ kind: 'page', author: PAGE, seq: 1, ref: page() })
  const result = deps.setCover(image).then(() => 'sent', () => 'stopped')
  h.cleanup()
  signing.resolve({ signature: 'fixture' })
  t.is(await result, 'stopped')
  t.absent(h.calls.includes('page HTTP write'))
})

test('a pass stopped during claim or the fresh list never sends', async (t) => {
  const f = await fixture()
  let live = true
  f.config.alive = () => live
  const write = f.store.write
  f.store.write = async (...args) => { await write(...args); live = false }
  await f.run()
  t.alike(sent(f), [])
  t.is(calls(f, 'readPost').length, 0)
  const reread = await fixture()
  let reads = 0
  live = true
  reread.config.alive = () => live
  reread.config.listOwn = async () => {
    if (++reads === 2) live = false
    return { posts: [row(1)], more: false }
  }
  await reread.run()
  t.alike(sent(reread), [])
})

test('no stored post request or fetch runs until claim persistence resolves', async (t) => {
  const f = await fixture()
  const gate = deferred()
  const write = f.store.write
  f.store.write = async (...args) => {
    await gate.promise
    await write(...args)
  }
  const running = f.run()
  await flush()
  t.is(calls(f, 'readPost').length, 0)
  t.is(calls(f, 'fetch').length, 0)
  t.alike(sent(f), [])
  gate.resolve()
  await running
  t.alike(sent(f), [['upload', own()], ['post.cover', own()]])
})
