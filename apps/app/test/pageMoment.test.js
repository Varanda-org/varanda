// A momento published as whoever is acting, the pure part (src/pageMoment.js)
// and the screens' pins. No network.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/pageMoment.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

const P = 'cd'.repeat(32)
const Q = 'ef'.repeat(32)
const ITEM = { id: 'a'.repeat(64), key: 'b'.repeat(64), mime: 'image/jpeg' }

test('momentComposerOn: a plain post, as the person or as a Page', async (t) => {
  const { momentComposerOn } = await load()
  t.is(momentComposerOn({ canPublish: true, reply: null, quote: null }), true)
  t.is(momentComposerOn({ canPublish: true }), true, 'a Page is no longer a reason to refuse')
  t.is(momentComposerOn({ canPublish: false }), false)
  t.is(momentComposerOn({ canPublish: true, reply: { ref: 'x' } }), false)
  t.is(momentComposerOn({ canPublish: true, quote: { ref: 'x' } }), false)
  t.is(momentComposerOn({ canPublish: undefined }), false)
})

test('momentPublisher and momentRoute: the page key acting, else the person', async (t) => {
  const { momentPublisher, momentRoute } = await load()
  t.is(momentPublisher(P), P)
  t.is(momentPublisher(null), null)
  t.is(momentPublisher(undefined), null)
  t.is(momentPublisher('nope'), null)
  t.is(momentPublisher(P.toUpperCase()), null, 'only the lowercase key the store keeps')
  t.is(momentRoute(null), 'person')
  t.is(momentRoute(P), 'page')
})

test('createMomentItems: only the item put here, for the publisher acting now', async (t) => {
  const { createMomentItems } = await load()
  const items = createMomentItems()
  t.is(items.take(null), null, 'nothing put yet')
  t.is(items.held, false)
  items.put(ITEM, P)
  t.is(items.held, true)
  t.is(items.take(P), ITEM, 'the page it was put for')
  t.is(items.take(null), null, 'not the person')
  t.is(items.take(Q), null, 'not another page')
  items.clear()
  t.is(items.take(P), null)
  t.is(items.held, false)
})

test('createMomentItems: the person keeps its own item, a bad item is never kept', async (t) => {
  const { createMomentItems } = await load()
  const items = createMomentItems()
  items.put(ITEM, null)
  t.is(items.take(null), ITEM)
  t.is(items.take(undefined), ITEM, 'an absent publisher is the person')
  items.put(undefined, null)
  t.is(items.take(null), null, 'a missing answer replaces what was kept')
  items.put('x', P)
  t.is(items.take(P), null, 'a non-object is no item')
  items.put(null, P)
  t.is(items.held, false)
})

test('createMomentItems: an identity change drops the item, the same identity keeps it', async (t) => {
  const { createMomentItems } = await load()
  const items = createMomentItems()
  items.put(ITEM, P)
  items.follow(P)
  t.is(items.take(P), ITEM, 'same page: kept for the next explicit press')
  items.follow(Q)
  t.is(items.held, false, 'another page: dropped')
  items.put(ITEM, P)
  items.follow(null)
  t.is(items.take(P), null, 'back to the person: dropped')
  items.put(ITEM, null)
  items.follow(null)
  t.is(items.take(null), ITEM)
  items.follow(P)
  t.is(items.take(null), null)
})

test('momentFailure: a page retries on a tap, the person holds, a refusal is plain', async (t) => {
  const { momentFailure } = await load()
  const retry = () => {}
  t.is(momentFailure({ uncertain: true, publisher: P, retry, itemKept: true }), 'retry')
  t.is(momentFailure({ uncertain: true, publisher: P, retry: undefined, itemKept: true }), 'hold', 'no retry to offer: held, never resent')
  t.is(momentFailure({ uncertain: true, publisher: null, retry, itemKept: true }), 'hold', 'the person never resends')
  t.is(momentFailure({ uncertain: true, publisher: null, itemKept: false }), null)
  t.is(momentFailure({ uncertain: false, publisher: P, retry, itemKept: true }), null)
  t.is(momentFailure({ publisher: P, retry, itemKept: true }), null)
})

test('momentDeleteAs: a Page deletes only its own momento while acting as it', async (t) => {
  const { momentDeleteAs } = await load()
  t.is(momentDeleteAs(P + ':3', P), P)
  t.is(momentDeleteAs(Q + ':3', P), null, 'another author')
  t.is(momentDeleteAs(P + ':3', null), null, 'the person deletes with moment.delete')
  t.is(momentDeleteAs(P + ':3', 'nope'), null)
  t.is(momentDeleteAs(undefined, P), null)
  t.is(momentDeleteAs(P.slice(0, 60) + ':3', P), null)
})

test('momentPutArgs: a copy of the bytes, ahead only for a Page', async (t) => {
  const { momentPutArgs } = await load()
  const photo = { bytes: new Uint8Array([1, 2]), mime: 'image/jpeg', width: 2, height: 3 }
  const a = momentPutArgs(photo)
  t.alike(Object.keys(a), ['bytes', 'mime', 'width', 'height'], 'the person buys stamps as before')
  t.not(a.bytes, photo.bytes, 'a copy')
  t.alike(a.bytes, photo.bytes)
  t.is(momentPutArgs(photo, { publisher: P }).ahead, true, 'a Page never buys right before its upload')
  t.absent('ahead' in momentPutArgs(photo, { publisher: 'nope' }), 'not a page key: the person')
  const clip = { bytes: new Uint8Array([3]), mime: 'video/mp4', width: 640, height: 360, ms: 3000 }
  t.alike(momentPutArgs(clip, { clip: true, publisher: P }), { bytes: new Uint8Array([3]), mime: 'video/mp4', width: 640, height: 360, ms: 3000, kind: 'video', ahead: true })
})

test('isMomentPreparing and momentPublishedAs', async (t) => {
  const { isMomentPreparing, momentPublishedAs, MOMENT_PREPARING, MOMENT_PREPARING_NOTICE } = await load()
  t.is(MOMENT_PREPARING, 'envio em preparo', 'the node message (web-member dm.js MOMENT_PREPARING)')
  t.ok(isMomentPreparing(new Error('envio em preparo')))
  t.absent(isMomentPreparing(new Error('mídia inválida')))
  t.absent(isMomentPreparing(null))
  t.is(MOMENT_PREPARING_NOTICE, 'Preparando o envio. Tente de novo em instantes.')
  t.is(momentPublishedAs('Padaria'), 'Momento publicado como Padaria.')
})

test('Publicar: a Page upload never buys right before it, and a held retry keeps its Página', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes('node.media.putMoment(momentPutArgs(file, { clip: !!clip, publisher }))'), 'ahead for a Page')
  t.ok(src.includes('else if (isMomentPreparing(err)) setError(MOMENT_PREPARING_NOTICE)'), 'the notice, and the person presses again')
  t.ok(src.includes('itemKept: kept.take(publisher) !== null'), 'the item kept for this publisher')
  const put = src.indexOf('const put = await node.media.putMoment(')
  t.ok(put > 0 && src.indexOf('if (switchRef.current === switches) kept.put(put, publisher)', put) > put, 'an item back after an identity switch is not recorded')
  t.ok(src.includes('kept.follow(publisherRef.current)'), 'a settled retry drops an item of another publisher')
  t.ok(src.includes('if (publisherRef.current !== publisher) publishedElsewhere(label)'), 'a send that landed for a previous publisher')
  t.ok(src.includes('setNote(momentPublishedAs(label))'), 'says for whom')
  t.ok(src.includes("if (busy || moment.pending || (moment.canRetry && id !== 'moment')) return"), 'the mode switch waits for the retry, except back to Momento')
  t.ok(src.includes("setMode(moment.canRetry ? 'moment' : 'post')"), 'a reopening with a held retry lands on Momento')
  t.is(src.split('disabled={held || moment.canRetry}').length - 1, 2, 'both chips wait for the retry')
  t.ok(src.includes("moment.heldLabel !== null ? 'Publicando como ' + moment.heldLabel"), 'the footer names the held request\'s Página')
})

test('Publicar: a Page publishes with pagesMoment and keeps its identity in the composer', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("import { MOMENT_PAGE_UNCERTAIN, MOMENT_PREPARING_NOTICE, createMomentItems, isMomentPreparing, momentComposerOn, momentFailure, momentPublishedAs, momentPutArgs } from '../pageMoment'"))
  t.ok(src.includes('momentComposerOn({ canPublish: canPublishMoment(node), reply: replyProp, quote })'), 'a Page is allowed')
  t.ok(src.includes('active: open === true && momentMode, asPage, asLabel: '), 'the draft knows who publishes')
  t.ok(src.includes('kept.follow(asPage)'), 'an identity change drops the item')
  t.ok(src.includes('const retry = async () => {') && src.includes('await pending.retry()'), 'the page retry is the same request, on a tap')
  t.absent(/node\.request\('moment\.create'[^\n]*\n[^\n]*retry/.test(src), 'no automatic resend')
  t.ok(src.includes('<Btn label=\'Tentar de novo\' onPress={retryMoment}'), 'the tap')
  t.ok(src.includes('canQueue && asPage === null'), 'the outbox stays the person\'s')
})

test('App and the store: the composer no longer switches the identity', (t) => {
  const acting = read('src/actingAs.js')
  t.absent(acting.includes('enterMoment') || acting.includes('leaveMoment'))
  const app = read('App.js')
  t.absent(app.includes('enterMoment') || app.includes('leaveMoment'))
})

test('Momentos: the delete as the Page goes through the page delete action', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes("import { momentDeleteAs } from '../pageMoment'"))
  t.ok(src.includes("action: 'delete', page: as, op: { to: target.ref }"), 'the page delete')
  t.ok(src.includes("await request('moment.delete', { to: target.ref })"), 'the person keeps moment.delete')
  t.ok(src.includes('const pageOwn = !mine && author !== null && actingPage === author'))
  t.ok(src.includes('page={pageOwn ? actingPage : null}'))
})
