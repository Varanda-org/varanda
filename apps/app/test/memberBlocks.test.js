'use strict'

// The pure rules of the member's block list on screen (src/memberBlocks.js) and
// the report to the service worker (src/pushBlocks.web.js, .native.js).
const test = require('brittle')

const load = () => import('../src/memberBlocks.js')
const loadWeb = () => import('../src/pushBlocks.web.js')
const loadNative = () => import('../src/pushBlocks.native.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const hasOf = (...keys) => (key) => keys.includes(key)

function setNavigator (value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator')
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  return () => {
    if (had && prev) Object.defineProperty(globalThis, 'navigator', prev)
    else delete globalThis.navigator
  }
}

test('blockedSetOf keeps only keys', async (t) => {
  const { blockedSetOf } = await load()
  t.alike([...blockedSetOf({ keys: [A, 'x', A.toUpperCase(), null, B] })], [A, B])
  t.is(blockedSetOf(null).size, 0)
  t.is(blockedSetOf({ keys: 'x' }).size, 0)
})

test('a row by a blocked author, or reposted by one, draws nothing', async (t) => {
  const { blockedRowView } = await load()
  t.is(blockedRowView({ author: A }, hasOf(A)), null)
  t.is(blockedRowView({ author: B, repostedBy: { author: A } }, hasOf(A)), null)
  t.alike(blockedRowView({ author: B, repostedBy: null, quote: null }, hasOf(A)), { quote: null, replyQuote: undefined })
})

test('a quote of a blocked author reads as unavailable and carries nothing of theirs', async (t) => {
  const { blockedRowView } = await load()
  const onOpen = () => {}
  const quote = { author: A, name: 'Ana', username: 'ana', avatar: { core: 'x' }, at: '2026-01-01T00:00:00.000Z', text: 'segredo', media: [{}], preview: {}, persist: true, missing: false, onOpen }
  const masked = blockedRowView({ author: B, quote }, hasOf(A)).quote
  t.alike(masked, { author: A, name: null, username: null, avatar: null, at: null, text: null, media: null, preview: null, persist: false, missing: true, onOpen })
  t.is(blockedRowView({ author: B, quote }, hasOf(C)).quote, quote, 'another author: untouched')
})

test('a reply quote of a blocked person reads as unavailable, with no name, sender or tap', async (t) => {
  const { blockedRowView, UNAVAILABLE_REPLY_QUOTE } = await load()
  const replyQuote = { name: 'Ana', text: 'segredo', senderKey: A, ref: A + ':5', onPress: () => {} }
  const view = blockedRowView({ author: B, replyQuote }, hasOf(A))
  t.alike(view.replyQuote, { name: null, text: 'Mensagem indisponível', senderKey: undefined, onPress: undefined })
  t.is(UNAVAILABLE_REPLY_QUOTE, 'Mensagem indisponível')
  t.is(view.quote, undefined)
  t.is(blockedRowView({ author: B, replyQuote }, hasOf(C)).replyQuote, replyQuote, 'another sender: the same object')
  const missing = { name: null, text: 'Mensagem indisponível', senderKey: undefined, ref: A + ':5', onPress: () => {} }
  t.is(blockedRowView({ author: B, replyQuote: missing }, hasOf(A)).replyQuote, missing, 'a missing quote names no one already')
  const quote = { author: A, text: 'x', onOpen: () => {} }
  const both = blockedRowView({ author: B, quote, replyQuote }, hasOf(A))
  t.is(both.quote.missing, true)
  t.is(both.replyQuote.text, 'Mensagem indisponível', 'both are masked together')
  const conversa = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  t.ok(conversa.includes("const MISSING_QUOTE = '" + UNAVAILABLE_REPLY_QUOTE + "'"), 'the same words as a quote the screen could not read')
})

test('rows of a blocked person go, the array stays the same when nothing does', async (t) => {
  const { withoutBlockedKeys, withoutBlockedRefs } = await load()
  const items = [{ key: A, seq: 1 }, { key: B, seq: 2 }, null, { seq: 3 }]
  t.alike(withoutBlockedKeys(items, hasOf(A)), [{ key: B, seq: 2 }, null, { seq: 3 }])
  t.is(withoutBlockedKeys(items, hasOf(C)), items)
  const refs = [A + ':1', B + ':2', 7]
  t.alike(withoutBlockedRefs(refs, hasOf(A)), [B + ':2', 7])
  t.is(withoutBlockedRefs(refs, hasOf(C)), refs)
})

test('blockedPeekParams asks the name and @nome blocks only, or nothing', async (t) => {
  const { blockedPeekParams } = await load()
  t.alike(blockedPeekParams(A, { profileSeq: 9, usernameSeq: 4 }), { author: A, seqs: [4, 9], profileOnly: true, profileSeq: 9, usernameSeq: 4 })
  t.alike(blockedPeekParams(A, { profileSeq: 9, usernameSeq: 9 }), { author: A, seqs: [9], profileOnly: true, profileSeq: 9, usernameSeq: 9 })
  t.alike(blockedPeekParams(A, { profileSeq: 9 }), { author: A, seqs: [9], profileOnly: true, profileSeq: 9 })
  t.is(blockedPeekParams(A, { profileSeq: 0, usernameSeq: null }), null)
  t.is(blockedPeekParams(A, null), null)
})

test('the confirmation names the person, and states what a block cannot do', async (t) => {
  const { confirmTitle, BLOCK_TEXTS } = await load()
  t.is(confirmTitle('Ana'), 'Bloquear Ana?')
  t.is(confirmTitle(null), 'Bloquear esta pessoa?')
  t.is(confirmTitle(''), 'Bloquear esta pessoa?')
  t.ok(BLOCK_TEXTS.confirmNote.includes('não é avisada'))
  t.ok(BLOCK_TEXTS.confirmNote.includes('ainda pode ver o que você publica'))
})

test('native: no-op that touches no browser global', async (t) => {
  const restore = setNavigator(new Proxy({}, { get () { throw new Error('navigator read') } }))
  try {
    const { reportBlocks } = await loadNative()
    t.is(reportBlocks([A]), undefined)
  } finally {
    restore()
  }
})

test('web: posts the list to the controlling worker', async (t) => {
  const sent = []
  const restore = setNavigator({ serviceWorker: { controller: { postMessage: (m) => sent.push(m) } } })
  try {
    const { reportBlocks } = await loadWeb()
    reportBlocks([A, B])
    t.alike(sent, [{ type: 'varanda-blocks', keys: [A, B] }])
  } finally {
    restore()
  }
})

test('web: the mute list goes the same way, as its own message; native does nothing', async (t) => {
  const sent = []
  const restore = setNavigator({ serviceWorker: { controller: { postMessage: (m) => sent.push(m) } } })
  try {
    const { reportMutes } = await loadWeb()
    reportMutes([A])
    t.alike(sent, [{ type: 'varanda-mutes', keys: [A] }])
  } finally {
    restore()
  }
  const back = setNavigator(new Proxy({}, { get () { throw new Error('navigator read') } }))
  try {
    const { reportMutes } = await loadNative()
    t.is(reportMutes([A]), undefined)
  } finally {
    back()
  }
})

test('web: before a worker controls the page, the list waits for the active one', async (t) => {
  const sent = []
  const restore = setNavigator({ serviceWorker: { controller: null, ready: Promise.resolve({ active: { postMessage: (m) => sent.push(m) } }) } })
  try {
    const { reportBlocks } = await loadWeb()
    reportBlocks([A])
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.alike(sent, [{ type: 'varanda-blocks', keys: [A] }])
  } finally {
    restore()
  }
})

test('web: no worker, or one that throws, is harmless', async (t) => {
  const { reportBlocks } = await loadWeb()
  let restore = setNavigator({})
  try {
    t.execution(() => reportBlocks([A]))
  } finally {
    restore()
  }
  restore = setNavigator({ serviceWorker: { controller: { postMessage () { throw new Error('closed') } } } })
  try {
    t.execution(() => reportBlocks([A]))
  } finally {
    restore()
  }
})

// blocksProvider.js loads react-native, so its pure helper runs here from its
// own source text and the wiring is checked on that text.
const PROVIDER = require('fs').readFileSync(require('path').join(__dirname, '../src/blocksProvider.js'), 'utf8')
const between = (src, from, to) => {
  const start = src.indexOf(from)
  return src.slice(start, src.indexOf(to, start + from.length))
}

test('rereadsAfterWrites: a set that settled during the read sends the list read again', (t) => {
  const m = /\nexport function rereadsAfterWrites \(writesAt, writesNow\) \{\n([\s\S]*?)\n\}\n/.exec(PROVIDER)
  t.ok(m, 'exported beside isLatestReload')
  if (m === null) return
  // eslint-disable-next-line no-new-func
  const rereadsAfterWrites = new Function('writesAt', 'writesNow', m[1])
  t.is(rereadsAfterWrites(0, 0), false, 'no set: the answer commits')
  t.is(rereadsAfterWrites(4, 4), false)
  t.is(rereadsAfterWrites(0, 1), true, 'one set settled: read again')
  t.is(rereadsAfterWrites(2, 5), true, 'several')
})

test('blocksProvider: block.list on the control lane, re-read after a set it overlapped', (t) => {
  const reload = between(PROVIDER, 'const reload = useCallback', '}, [commit])')
  const writesAt = reload.indexOf('const writes = writesRef.current')
  const requestAt = reload.indexOf("requestRef.current('block.list', {}, { priority: 'control' })")
  const rereadAt = reload.indexOf('if (current() && rereadsAfterWrites(writes, writesRef.current)) return reload(alive)')
  const commitAt = reload.indexOf('commit(blockedSetOf(answer))')
  t.ok(requestAt !== -1, 'control priority')
  t.ok(writesAt !== -1 && writesAt < requestAt, 'the write count is read before the request')
  t.ok(rereadAt > requestAt && rereadAt < commitAt, 'a moved count commits nothing and reads the list again')
  t.is(PROVIDER.split("requestRef.current('block.list'").length - 1, 1, 'one list request')
  const loadedAt = reload.indexOf("nextLoadState(s, 'loaded')")
  const markAt = reload.indexOf("perfMarks().mark('blocks-ok')")
  t.ok(markAt > loadedAt && loadedAt !== -1, 'blocks-ok after the list is loaded')
  t.ok(/if \(!markedRef\.current\) \{\s*markedRef\.current = true\s*perfMarks\(\)\.mark\('blocks-ok'\)/.test(reload), 'once per run')

  const setBlock = between(PROVIDER, 'const setBlock = useCallback', 'const refresh = useCallback')
  const setAt = setBlock.indexOf("await requestRef.current('block.set', { key, on })")
  const countAt = setBlock.indexOf('writesRef.current++')
  t.ok(setAt !== -1 && countAt > setAt && countAt < setBlock.indexOf('commit(next)'), 'counted once the set settled, before its commit')
  t.is(setBlock.split("'block.set'").length - 1, 1, 'the set is never repeated')
  t.is(PROVIDER.split('writesRef.current++').length - 1, 1, 'only a set moves the count')
})

test('a control block.list leaves at once while five visible reads are in flight', async (t) => {
  const { createRequestQueue } = await import('../src/requestQueue.js')
  const queue = createRequestQueue()
  const calls = []
  const send = (method) => new Promise((resolve) => calls.push({ method, release: () => resolve({ method }) }))
  const reads = Array.from({ length: 6 }, () => queue.run('feed.read', {}, send))
  t.is(calls.length, 5, 'five reads in flight, one waiting')
  const list = queue.run('block.list', {}, send, { priority: 'control' })
  t.is(calls.length, 6)
  t.is(calls[5].method, 'block.list', 'sent before the waiting read')
  calls[5].release()
  t.alike(await list, { method: 'block.list' })
  const visible = queue.run('block.list', {}, send)
  t.is(calls.length, 6, 'without the control lane it would wait behind the reads')
  for (let i = 0; i < 5; i++) calls[i].release()
  await Promise.all(reads.slice(0, 5))
  for (const c of calls.slice(6)) c.release()
  await Promise.all([reads[5], visible])
  t.alike(calls.slice(6).map((c) => c.method), ['feed.read', 'block.list'], 'and leave after the read queued before it')
})
