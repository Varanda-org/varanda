// The reads behind A Rua's comment fold (foldRounds.js): parents first, then
// at most FOLD_READ_ROUNDS rounds of ancestors, FOLD_STRANGER_READS of
// strangers' per ingest, give-ups kept out of the shared originals, and the
// queued/reading state behind pending()'s guess.
'use strict'

const test = require('brittle')
const load = () => import('../src/foldRounds.js')

const ME = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const X = '99'.repeat(32)
// A distinct stranger key per index.
const stranger = (i) => (i + 16).toString(16).padStart(2, '0').repeat(32)

const ref = (author, seq) => author + ':' + seq
const post = (author, seq, to = null) => ({
  kind: 'post',
  author,
  seq,
  text: 't' + seq,
  at: '2026-11-15T10:00:00.000Z',
  name: 'N',
  username: null,
  replyTo: to === null ? null : { author: to.slice(0, to.indexOf(':')), seq: Number(to.slice(to.indexOf(':') + 1)) }
})

const TRANSIENT = Object.freeze({ transient: true })

// The world of posts a peek can reach, and an originals map written like
// ARua's resolve writes it: the item, null when absent, never twice.
function harness ({ world = new Map(), known = [ME, B], blocked = [], strangers = true, originals = new Map(), dead = new Set(), onResolve = null } = {}) {
  const reads = []
  const asks = []
  const deaths = []
  const knownSet = new Set(known)
  const blockedSet = new Set(blocked)
  const h = {
    reads,
    asks,
    deaths,
    originals,
    dead,
    opts: {
      stored: (r) => originals.get(r),
      transient: (r) => originals.get(r) === TRANSIENT,
      isDead: (r) => dead.has(r),
      resolve: async (refs) => {
        reads.push(refs.slice())
        if (onResolve) await onResolve(refs)
        for (const r of refs) {
          const cur = originals.get(r)
          if (cur === undefined || cur === TRANSIENT) originals.set(r, world.has(r) ? world.get(r) : null)
        }
      },
      isKnown: (a) => knownSet.has(a),
      isBlocked: (a) => blockedSet.has(a),
      live: () => true,
      loadFollows: async () => {},
      strangers,
      onAsk: (refs) => asks.push(...refs),
      onDead: (refs) => { deaths.push(...refs); for (const r of refs) dead.add(r) },
      ownKey: ME,
      blocked: blockedSet
    }
  }
  return h
}

test('FOLD_STRANGER_READS bounds the stranger reads of one ingest', async (t) => {
  const { foldRounds, FOLD_STRANGER_READS } = await load()
  t.is(FOLD_STRANGER_READS, 8)
  // 20 comments of a followed author on 20 strangers' replies, each one a
  // reply to a stranger's root.
  const list = []
  const world = new Map()
  for (let i = 0; i < 20; i++) {
    const mid = ref(stranger(i), 2)
    const top = ref(stranger(i), 1)
    world.set(mid, post(stranger(i), 2, top))
    world.set(top, post(stranger(i), 1))
    list.push(post(B, i + 1, mid))
  }
  const h = harness({ world })
  await foldRounds({ list, ...h.opts })
  const read = h.reads.flat()
  t.is(read.length, FOLD_STRANGER_READS, 'eight stranger reads in all, across the rounds')
  t.is(h.deaths.length, 0, 'the rest are left for a later ingest, not given up on')
})

test('at most FOLD_READ_ROUNDS rounds, then the rest is given up on', async (t) => {
  const { foldRounds, FOLD_READ_ROUNDS } = await load()
  t.is(FOLD_READ_ROUNDS, 3)
  // A followed author's chain six hops deep.
  const world = new Map()
  for (let s = 1; s <= 6; s++) world.set(ref(C, s), post(C, s, s > 1 ? ref(C, s - 1) : null))
  const list = [post(B, 9, ref(C, 6))]
  const h = harness({ world, known: [ME, B, C] })
  const out = await foldRounds({ list, ...h.opts })
  t.is(h.reads.length, FOLD_READ_ROUNDS, 'three rounds read')
  t.alike(h.reads, [[ref(C, 6)], [ref(C, 5)], [ref(C, 4)]])
  t.alike(h.deaths, [ref(C, 3)], 'the next hop is given up on')
  t.ok(out.dead.has(ref(C, 3)))
  t.absent(h.originals.has(ref(C, 3)), 'and never written into the originals')
  t.alike(h.asks, [ref(C, 6), ref(C, 5), ref(C, 4)], 'each ask recorded in the fold set')
})

test('a declined ref ends in the dead set, never in the originals, and a later need still reads it', async (t) => {
  const { foldRounds } = await load()
  const top = ref(X, 1)
  const world = new Map([[top, post(X, 1)]])
  const list = [post(B, 4, top)]
  const h = harness({ world, strangers: false })
  const out = await foldRounds({ list, ...h.opts })
  t.alike(h.reads, [], 'a stranger is not read on a core node or offline')
  t.alike(h.deaths, [top], 'declined')
  t.ok(out.dead.has(top))
  t.is(h.originals.get(top), undefined, 'the originals stay unread')
  // What ARua's resolve reads: every ref whose original is undefined.
  await h.opts.resolve([top])
  t.is(h.originals.get(top), world.get(top), 'a repost, quote or reply mark that needs it reads it')

  // A later ingest skips what an earlier one gave up on.
  const again = harness({ world, strangers: true, dead: new Set([ref(X, 2)]) })
  await foldRounds({ list: [post(B, 5, ref(X, 2))], ...again.opts })
  t.alike(again.reads, [], 'a dead ref ends its chain for the fold')
})

test('no blocked author post is read, and none is given up on', async (t) => {
  const { foldRounds, parentAsks } = await load()
  const list = [post(B, 4, ref(C, 1)), post(B, 5, ref(X, 1))]
  const h = harness({ blocked: [C, X] })
  await foldRounds({ list, ...h.opts })
  t.alike(h.reads, [])
  t.alike(h.deaths, [])

  const isKnown = (a) => a === ME || a === B
  const isBlocked = (a) => a === X || a === B
  const parents = [ref(X, 1), ref(C, 2), ref(B, 3), ref(ME, 4), 7]
  const fold = parentAsks(parents, { fold: true, strangers: true, isKnown, isBlocked })
  t.alike(fold.strangers, [ref(C, 2)], 'round 0: a blocked stranger is not read for the fold')
  t.alike(fold.kin, [ref(ME, 4)], 'nor a blocked followed author')
  const plain = parentAsks(parents, { fold: false, strangers: true, isKnown, isBlocked })
  t.alike(plain.strangers, [ref(X, 1), ref(C, 2)], 'without the fold, the parents read as before')
  t.alike(plain.kin, [])
  const core = parentAsks(parents, { fold: true, strangers: false, isKnown, isBlocked })
  t.alike(core.strangers, [], 'strangers only hosted and online')
  t.alike(core.kin, [ref(ME, 4)])
})

test('a transient failure is answered only for what this ingest asked', async (t) => {
  const { foldRounds } = await load()
  const top = ref(C, 1)
  const world = new Map([[top, post(C, 1)]])
  const list = [post(B, 4, top)]
  const earlier = harness({ world, known: [ME, B, C], originals: new Map([[top, TRANSIENT]]) })
  await foldRounds({ list, ...earlier.opts })
  t.alike(earlier.reads, [[top]], 'a blip of an earlier ingest is asked again')
  t.is(earlier.originals.get(top), world.get(top))

  const now = harness({ world, known: [ME, B, C], originals: new Map([[top, TRANSIENT]]) })
  await foldRounds({ list, answered: [top], ...now.opts })
  t.alike(now.reads, [], 'one this ingest read is an answer')
  t.alike(now.deaths, [], 'and is not given up on')
})

test('parents are read first and uncapped, then the roots no feed item holds', async (t) => {
  const { foldRounds, foldRoots } = await load()
  const root = ref(X, 1)
  const mid = ref(stranger(1), 3)
  const world = new Map([[root, post(X, 1)], [mid, post(stranger(1), 3, root)]])
  const feedRoot = post(C, 7)
  const list = [post(B, 4, mid), feedRoot, post(B, 5, ref(C, 7))]
  const h = harness({ world, known: [ME, B, C] })
  const out = await foldRounds({ list, parents: [mid], ...h.opts })
  t.alike(h.reads, [[mid], [root]], 'the parent, then its root')
  t.alike(h.asks, [root], 'parents are recorded by the caller, rounds by onAsk')
  t.alike(out.roots, [root], 'the stranger root gets counts and own state; the feed root has them')

  const blocked = foldRoots(list, { originalOf: (r) => h.originals.get(r), ownKey: ME, blocked: new Set([X]) })
  t.alike(blocked, [], 'never a blocked root')
  const pending = foldRoots([post(B, 4, mid)], { originalOf: () => undefined, ownKey: ME, blocked: null })
  t.alike(pending, [], 'nothing while the chain is unread')
})

test('a throw in resolve still stops the tracker', async (t) => {
  const { foldRounds, foldTracker } = await load()
  const tracker = foldTracker()
  const h = harness({ known: [ME, B, C], onResolve: async () => { throw new Error('boom') } })
  await t.exception(foldRounds({ list: [post(B, 4, ref(C, 1))], ...h.opts, tracker }), /boom/)
  t.absent(tracker.busy(), 'the folding state is cleared')
  t.absent(tracker.guess(C, { isKnown: () => true, isBlocked: () => false }), 'and guesses nothing')
})

test('the tracker guesses while queued and reading, and asks for a render only after a guess', async (t) => {
  const { foldTracker, queueIngest } = await load()
  const tracker = foldTracker()
  const isKnown = (a) => a === B
  const isBlocked = (a) => a === X
  t.absent(tracker.guess(C, { isKnown, isBlocked }), 'idle: nothing is pending on a guess')

  // Queued at once, before its run starts: the first-paint gate holds.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let renders = 0
  const onRender = () => { renders++ }
  const tail = queueIngest(gate, async () => {
    t.ok(tracker.guess(C, { isKnown, isBlocked }), 'running, before the rounds: still held')
    tracker.start({ budget: 0, strangers: true, isBlocked })
    t.absent(tracker.guess(C, { isKnown, isBlocked }), 'the rounds would not ask a stranger over budget')
    t.ok(tracker.guess(B, { isKnown, isBlocked }), 'but would ask a followed author')
    tracker.stop()
  }, { fold: true, tracker, onRender })
  t.ok(tracker.busy(), 'marked queued synchronously')
  t.ok(tracker.guess(C, { isKnown, isBlocked }), 'queued: an unknown author may still be asked')
  t.absent(tracker.guess(X, { isKnown, isBlocked }), 'never a blocked one')
  release()
  await tail
  t.absent(tracker.busy())
  t.is(renders, 1, 'one render after the guesses')

  // No guess, no render.
  const quiet = queueIngest(Promise.resolve(), async () => {}, { fold: true, tracker, onRender })
  await quiet
  t.is(renders, 1, 'nothing guessed: no forced render')

  // A run that throws, or a plain ingest, still settles.
  const failing = queueIngest(Promise.resolve(), async () => {
    tracker.guess(C, { isKnown, isBlocked })
    throw new Error('boom')
  }, { fold: true, tracker, onRender })
  await failing
  t.absent(tracker.busy(), 'a throw clears the queued mark')
  t.is(renders, 2)
  const plain = queueIngest(Promise.resolve(), async () => {}, { fold: false, tracker, onRender })
  t.absent(tracker.busy(), 'a plain ingest is not a fold ingest')
  await plain
  t.is(renders, 2)

  // Two queued: the render waits for the last.
  let open
  const held = new Promise((resolve) => { open = resolve })
  const first = queueIngest(held, async () => { tracker.guess(C, { isKnown, isBlocked }) }, { fold: true, tracker, onRender })
  const second = queueIngest(first, async () => {}, { fold: true, tracker, onRender })
  open()
  await first
  t.is(renders, 2, 'another fold ingest still queued: its guesses still hold')
  t.ok(tracker.busy())
  await second
  t.is(renders, 3)
})

test('foldAsk: own and followed anywhere, strangers capped and only when they can be read', async (t) => {
  const { foldAsk } = await load()
  const known = new Set([ME, B])
  const isKnown = (a) => known.has(a)
  const none = () => false
  const needs = [ref(ME, 1), ref(C, 2), ref(B, 3), ref(X, 4)]
  const core = foldAsk(needs, { isKnown, isBlocked: none, strangers: false, budget: 8 })
  t.alike(core.ask, [ref(ME, 1), ref(B, 3)])
  t.alike(core.decline, [ref(C, 2), ref(X, 4)])
  const hosted = foldAsk(needs, { isKnown, isBlocked: none, strangers: true, budget: 1 })
  t.alike(hosted.ask, [ref(ME, 1), ref(C, 2), ref(B, 3)])
  t.alike(hosted.later, [ref(X, 4)])
  t.is(hosted.budget, 0)
  const blocked = foldAsk(needs, { isKnown, isBlocked: (a) => a === C || a === ME, strangers: true, budget: 8 })
  t.alike(blocked.ask, [ref(B, 3), ref(X, 4)])
  t.alike(blocked.decline, [])
  t.alike(foldAsk(needs, { isKnown, isBlocked: none, strangers: true, budget: 8, skip: new Set([ref(ME, 1)]) }).ask, [ref(C, 2), ref(B, 3), ref(X, 4)])
})

test('a ref given up on earlier but answered since is read through', async (t) => {
  const { foldRounds } = await load()
  const root = ref(C, 1)
  const mid = ref(C, 2)
  const world = new Map([[root, post(C, 1)]])
  // social.dead still holds mid from an earlier ingest; a plain need read it since.
  const h = harness({ world, known: [ME, B, C], originals: new Map([[mid, post(C, 2, root)]]), dead: new Set([mid]) })
  const out = await foldRounds({ list: [post(B, 4, mid)], ...h.opts })
  t.alike(h.reads, [[root]], 'the stored answer wins over the dead mark: its parent is asked')
  t.alike(out.roots, [root], 'and the root is counted')
})

test('settle clears the reading state of a run that returned early', async (t) => {
  const { foldTracker, queueIngest } = await load()
  const tracker = foldTracker()
  const isKnown = (a) => a === B
  const isBlocked = () => false
  await queueIngest(Promise.resolve(), async () => {
    tracker.start({ budget: 8, strangers: true, isBlocked })
    // returns before foldRounds, without stop()
  }, { fold: true, tracker })
  t.absent(tracker.busy(), 'nothing left reading')
  t.absent(tracker.guess(B, { isKnown, isBlocked }), 'and nothing guessed')
})

test('a started ingest on a core node does not guess strangers, before or after the rounds', async (t) => {
  const { foldTracker, queueIngest, FOLD_STRANGER_READS } = await load()
  const tracker = foldTracker()
  const isKnown = (a) => a === B
  const isBlocked = () => false
  await queueIngest(Promise.resolve(), async () => {
    t.ok(tracker.guess(C, { isKnown, isBlocked }), 'follow list unknown: the blanket guess')
    tracker.start({ budget: FOLD_STRANGER_READS, strangers: false, isBlocked })
    t.absent(tracker.guess(C, { isKnown, isBlocked }), 'known from here: a stranger is never read on a core node')
    t.ok(tracker.guess(B, { isKnown, isBlocked }), 'a followed author is')
  }, { fold: true, tracker })
})

test('a running fold ingest does not hide the queued mark of the next one', async (t) => {
  const { foldTracker, queueIngest } = await load()
  const tracker = foldTracker()
  const isKnown = (a) => a === B
  const isBlocked = (a) => a === X
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let seen = null
  const first = queueIngest(Promise.resolve(), async () => {
    tracker.start({ budget: 0, strangers: true, isBlocked })
    await gate
    seen = { stranger: tracker.guess(C, { isKnown, isBlocked }), blocked: tracker.guess(X, { isKnown, isBlocked }) }
  }, { fold: true, tracker })
  const second = queueIngest(first, async () => {}, { fold: true, tracker })
  release()
  await second
  t.ok(seen.stranger, 'the queued ingest may still ask a stranger')
  t.absent(seen.blocked, 'never a blocked one')
})

test('pendingOf: need, then dead, then the fold asks, then the guess', async (t) => {
  const { pendingOf } = await load()
  const r = ref(C, 1)
  const base = { stored: () => undefined, need: new Set(), fold: new Set(), dead: new Set(), guess: () => false }
  t.absent(pendingOf(r, base), 'nothing asked, nothing guessed')
  t.absent(pendingOf(null, base))
  t.absent(pendingOf(r, { ...base, stored: () => null, need: new Set([r]) }), 'an answer is not pending')
  t.ok(pendingOf(r, { ...base, need: new Set([r]), dead: new Set([r]) }), 'a plain need reads it again')
  t.absent(pendingOf(r, { ...base, fold: new Set([r]), dead: new Set([r]) }), 'the fold gave up on it')
  t.ok(pendingOf(r, { ...base, fold: new Set([r]) }), 'a fold ask')
  const guessed = []
  t.ok(pendingOf(r, { ...base, guess: (a) => { guessed.push(a); return true } }), 'the tracker guess')
  t.alike(guessed, [C], 'asked by author')
})

test('foldOriginalOf: the answer wins, transient is no answer, dead ends, stale only while pending and not blocked', async (t) => {
  const { foldOriginalOf } = await load()
  const r = ref(C, 1)
  const item = post(C, 1)
  const old = post(C, 1)
  const isTransient = (i) => i === TRANSIENT
  const base = { stored: () => undefined, isTransient, dead: new Set(), stale: new Map([[r, old]]), pending: () => true, isBlocked: () => false }
  t.is(foldOriginalOf(null, base), null)
  t.is(foldOriginalOf(r, { ...base, stored: () => item }), item, 'the answer wins')
  t.is(foldOriginalOf(r, { ...base, stored: () => null }), null)
  t.is(foldOriginalOf(r, { ...base, stored: () => TRANSIENT }), undefined, 'a transient failure is no answer')
  t.is(foldOriginalOf(r, { ...base, dead: new Set([r]) }), null, 'a give-up ends the chain')
  t.is(foldOriginalOf(r, base), old, 'the previous epoch while it is read again')
  t.is(foldOriginalOf(r, { ...base, pending: () => false }), undefined, 'only while read again')
  t.is(foldOriginalOf(r, { ...base, isBlocked: (a) => a === C }), undefined, 'never a blocked author')
  t.is(foldOriginalOf(r, { ...base, stale: new Map() }), undefined)
})

test('shownOriginalOf: a stored answer wins, else the last good copy, never a stale null, a deleted ref or a blocked author', async (t) => {
  const { shownOriginalOf } = await load()
  const r = ref(C, 1)
  const item = post(C, 1)
  const old = post(C, 1)
  const isTransient = (i) => i === TRANSIENT
  const base = { stored: undefined, isTransient, stale: new Map([[r, old]]), deleted: new Set(), isBlocked: () => false, blocksOk: true }
  t.is(shownOriginalOf(r, base), old, 'the last good copy while it is read again')
  t.is(shownOriginalOf(r, { ...base, blocksOk: false }), undefined, 'never before block.list answered for this run: a seeded copy of an author blocked since is not drawn')
  t.is(shownOriginalOf(r, { ...base, stored: TRANSIENT, blocksOk: false }), undefined, 'nor while its read failed')
  t.is(shownOriginalOf(r, { ...base, stored: item, blocksOk: false }), item, 'the live answer still wins')
  t.is(shownOriginalOf(r, { ...base, stored: null, blocksOk: false }), null, 'a live null too')
  t.is(shownOriginalOf(r, { ...base, stored: TRANSIENT }), old, 'and while its read failed for a transient reason')
  t.is(shownOriginalOf(r, { ...base, stored: null }), null, 'a live null wins over the copy')
  t.is(shownOriginalOf(r, { ...base, stored: item }), item, 'the live answer wins')
  t.is(shownOriginalOf(r, { ...base, isBlocked: (a) => a === C }), undefined, 'never a blocked author')
  t.is(shownOriginalOf(r, { ...base, stale: new Map([[r, post(X, 1)]]), isBlocked: (a) => a === X }), undefined, 'checked by the post author too')
  t.is(shownOriginalOf(r, { ...base, deleted: new Set([r]) }), undefined, 'never a deleted ref')
  t.is(shownOriginalOf(r, { ...base, stale: new Map([[r, null]]) }), undefined, 'a stale null is never returned')
  t.is(shownOriginalOf(r, { ...base, stale: new Map([[r, null]]), stored: TRANSIENT }), undefined, 'not even for a transient failure')
  t.is(shownOriginalOf(r, { ...base, stale: new Map() }), undefined, 'nothing held: still on its way')
  t.is(shownOriginalOf(r, { ...base, stored: TRANSIENT, stale: new Map() }), undefined)
  t.is(shownOriginalOf(r, { ...base, stored: null, isBlocked: () => true }), null, 'the stored answer is not the stale rule\'s to filter')
})

test('A Rua\'s original() shows the last good copy and a quote keeps peek photos', (t) => {
  const fs = require('fs')
  const path = require('path')
  const SRC = path.join(__dirname, '..', 'src')
  const withoutComments = (src) => src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
  const arua = withoutComments(fs.readFileSync(path.join(SRC, 'screens', 'ARua.js'), 'utf8'))
  const quote = withoutComments(fs.readFileSync(path.join(SRC, 'ui', 'QuoteCard.js'), 'utf8'))
  const start = arua.indexOf('const original = useCallback(')
  t.ok(start > 0)
  const original = arua.slice(start, arua.indexOf('}, [social, isBlockedNow, blocksOk])', start))
  t.ok(original.length > 0 && arua.indexOf('}, [social, isBlockedNow, blocksOk])', start) > start, 'redrawn when block.list answers')
  t.absent(original.includes('const transient'), 'scoped to original()')
  t.ok(original.includes('shownOriginalOf(ref, {'), 'original() reads through shownOriginalOf')
  t.ok(original.includes('stale: staleRef.current'), 'with the last good copies')
  t.ok(original.includes('deleted: deletedRef.current'), 'the deleted refs')
  t.ok(original.includes('isBlocked: isBlockedNow'), 'and the live block list')
  t.ok(original.includes('blocksOk\n'), 'and whether it answered for this run')
  t.ok(arua.includes("const blocksOk = blocksNow.loadState === 'ok'"), 'read from useBlocks() at each render')
  t.ok(arua.includes("social.persistOf(post.quote.author) || (strangerPersist === 'peek' || strangerPersist === 'copy' ? strangerPersist : false)"), 'a peek or copy row\'s stranger quote is kept the same way')
  t.ok(arua.includes('persist: quotePersist,'), 'the quote carries it')
  t.ok(arua.includes('    quotePersist,\n'), 'and the row cache compares it')
  t.absent(/q\.persist === true|'peek' : q\.persist/.test(quote), 'no hand coercion of q.persist left')
  t.is((quote.match(/persistMode\(q\.persist\)/g) || []).length, 6, 'media, link thumbs and avatars pass the mode through')
})

test('staleOf merges the previous stale map, never a dead, deleted or blocked ref, never a transient failure', async (t) => {
  const { staleOf } = await load()
  const isTransient = (i) => i === TRANSIENT
  const p = post(ME, 1)
  const kept = post(B, 9)
  const originals = new Map([[ref(ME, 1), p], [ref(B, 2), null], [ref(C, 3), TRANSIENT], [ref(B, 4), post(B, 4)]])
  const prev = new Map([[ref(B, 9), kept], [ref(C, 3), post(C, 3)], [ref(X, 5), post(X, 5)], [ref(ME, 6), post(ME, 6)], [ref(B, 7), post(B, 7)], [ref(ME, 1), post(ME, 1)]])
  const out = staleOf(originals, { dead: new Set([ref(B, 7), ref(C, 8)]), deleted: new Set([ref(B, 4), ref(ME, 6)]), isTransient, prev, isBlocked: (a) => a === X })
  t.is(out.get(ref(ME, 1)), p, 'the new answer wins')
  t.is(out.get(ref(B, 2)), null)
  t.is(out.get(ref(B, 4)), null, 'a deleted post is gone')
  t.is(out.get(ref(C, 8)), null, 'a give-up ends the chain')
  t.is(out.get(ref(B, 9)), kept, 'a prior entry the new originals do not hold is kept')
  t.ok(out.get(ref(C, 3)) !== undefined && out.get(ref(C, 3)).seq === 3, 'a transient failure keeps the prior post')
  t.is(out.get(ref(B, 7)), null, 'not for a ref now dead')
  t.is(out.get(ref(ME, 6)), null, 'nor a deleted one')
  t.absent(out.has(ref(X, 5)), 'nor a blocked author')
  const fresh = staleOf(new Map([[ref(C, 3), TRANSIENT]]), { dead: new Set(), deleted: new Set(), isTransient })
  t.absent(fresh.has(ref(C, 3)), 'a transient failure alone is no answer')
})

test('rootIngest reads each root once per epoch through a plain ingest', async (t) => {
  const { rootIngest } = await load()
  const done = new Set()
  const shown = new Set([ref(B, 1)])
  const args = rootIngest([ref(B, 1), ref(C, 2), ref(C, 2), ref(X, 3)], { shown, done })
  t.alike(args, { shown: [ref(C, 2), ref(X, 3)] }, 'roots not shown yet, distinct')
  t.absent('fold' in args, 'never a fold ingest, so it cannot loop')
  t.is(rootIngest([ref(C, 2)], { shown, done }), null, 'not twice in an epoch')
  t.is(rootIngest([], { shown, done: new Set() }), null)
})

test('replayIngest replays the plain asks and the fold with the parents at hand', async (t) => {
  const { replayIngest, replyParents } = await load()
  const top = ref(C, 1)
  const local = new Map([[ref(B, 4), post(B, 4, top)], [ref(B, 5), post(B, 5, ref(B, 4))], [ref(B, 6), post(B, 6, top)], [ref(B, 7), post(B, 7)]])
  local.set(ref(B, 8), { kind: 'repost', author: B, seq: 8, replyTo: { author: X, seq: 1 } })
  local.set(ref(B, 9), post(B, 9, ref('DD'.repeat(32), 2)))
  t.alike(replyParents(local), [top, ref('dd'.repeat(32), 2)], 'parents it does not hold, distinct, no repost')
  const need = new Set([ref(X, 2)])
  const fold = replayIngest({ need, local }, true)
  t.alike(fold.need, [ref(X, 2)], 'need alone, no fold ask')
  t.alike(fold.parents, replyParents(local), 'round 0 as a page ingest has it')
  t.is(fold.fold, true)
  t.is(fold.local, local)
  const plain = replayIngest({ need, local }, false)
  t.absent('parents' in plain, 'no fold, no parents')
  t.is(plain.fold, false)
  t.is(replayIngest({ need: new Set(), local }, false), null, 'nothing to replay')
})
