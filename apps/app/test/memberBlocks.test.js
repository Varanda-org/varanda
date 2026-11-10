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
  t.alike(blockedRowView({ author: B, repostedBy: null, quote: null }, hasOf(A)), { quote: null })
})

test('a quote of a blocked author reads as unavailable and carries nothing of theirs', async (t) => {
  const { blockedRowView } = await load()
  const onOpen = () => {}
  const quote = { author: A, name: 'Ana', username: 'ana', avatar: { core: 'x' }, at: '2026-01-01T00:00:00.000Z', text: 'segredo', media: [{}], preview: {}, persist: true, missing: false, onOpen }
  const masked = blockedRowView({ author: B, quote }, hasOf(A)).quote
  t.alike(masked, { author: A, name: null, username: null, avatar: null, at: null, text: null, media: null, preview: null, persist: false, missing: true, onOpen })
  t.is(blockedRowView({ author: B, quote }, hasOf(C)).quote, quote, 'another author: untouched')
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
