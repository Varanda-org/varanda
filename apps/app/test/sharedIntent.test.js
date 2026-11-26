'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/sharedIntent.js')
const AT = 1700000000000
const ID = AT + '-' + 'a'.repeat(32)

test('shareMomentKind accepts exactly one photo or video without losses', async (t) => {
  const { shareMomentKind } = await load()
  const photo = { files: [{}], video: null, dropped: 0, failed: 0, videoNote: '' }
  const video = { ...photo, files: [], video: {} }
  t.is(shareMomentKind(photo), 'photo')
  t.is(shareMomentKind(video), 'video')
  for (const item of [photo, video]) {
    for (const fields of [{ dropped: 1 }, { failed: 1 }, { videoNote: 'extra' }, { videoNote: 'photos' }, { videoNote: 'failed' }]) {
      t.is(shareMomentKind({ ...item, ...fields }), null)
    }
  }
  t.is(shareMomentKind({ ...photo, video: {} }), null, 'a photo cannot include a video')
  t.is(shareMomentKind({ ...photo, files: [{}, {}] }), null, 'two photos')
  t.is(shareMomentKind({ ...video, files: [{}] }), null, 'a video cannot include a photo')
  t.is(shareMomentKind({ ...video, video: null, text: 'texto' }), null, 'text only')
  for (const item of [null, undefined, false, 1, 'photo', {}, []]) {
    t.is(shareMomentKind(item), null, 'invalid share ' + JSON.stringify(item))
  }
})

test('shareAsks requires exact permission for the shared kind', async (t) => {
  const { shareAsks } = await load()
  const photo = { files: [{}], video: null, dropped: 0, failed: 0, videoNote: '' }
  const video = { ...photo, files: [], video: {} }
  for (const item of [photo, video]) {
    t.is(shareAsks({ share: item, canMoment: true }), true)
    for (const permission of [false, undefined, null, 1, 'true']) {
      t.is(shareAsks({ share: item, canMoment: permission }), false)
      t.is(shareAsks({ share: item, canMoment: () => permission }), false)
    }
  }
  t.is(shareAsks({ share: photo, canMoment: (kind) => kind === 'photo' }), true)
  t.is(shareAsks({ share: video, canMoment: (kind) => kind === 'video' }), true)
  t.is(shareAsks({ share: video, canMoment: (kind) => kind === 'photo' }), false)
  t.is(shareAsks({ share: null, canMoment: true }), false)
  t.is(shareAsks({ share: { ...photo, files: [] }, canMoment: () => true }), false)
})

test('momentShareText keeps fitting text and explains text left out or cut', async (t) => {
  const { momentShareText } = await load()
  t.alike(momentShareText('oi', 'foto', 200), { text: 'oi\nfoto', note: '' })
  t.alike(momentShareText('rascunho', '', 2), { text: 'rascunho', note: '' })
  t.alike(momentShareText('rascunho', 'foto', 2), { text: 'rascunho', note: 'o texto compartilhado não coube no momento' })
  t.alike(momentShareText('', 'a'.repeat(201), 200), { text: 'a'.repeat(200), note: 'o texto compartilhado foi cortado em 200 caracteres' })
  t.alike(momentShareText('  \n', 'a😀bc', 3), { text: 'a😀b', note: 'o texto compartilhado foi cortado em 3 caracteres' })
  t.alike(momentShareText('', 'a😀b', 3), { text: 'a😀b', note: '' })
  t.alike(momentShareText('', 'link', 200, true), { text: 'link', note: 'o texto compartilhado foi cortado em 1000 caracteres' }, 'a share already cut to the post limit says so')
  t.alike(momentShareText('rascunho', 'link', 2, true), { text: 'rascunho', note: 'o texto compartilhado não coube no momento' })
  for (const value of [null, undefined, 42, false, {}, []]) {
    t.alike(momentShareText(value, value, 200), { text: '', note: '' })
    t.alike(momentShareText(value, 'foto', 200), { text: 'foto', note: '' })
    t.alike(momentShareText('rascunho', value, 2), { text: 'rascunho', note: '' })
  }
})

test('momentShareBack explains a positive integer duration or uses the fallback', async (t) => {
  const { MOMENT_SHARE_BACK, momentShareBack } = await load()
  t.is(MOMENT_SHARE_BACK, 'não dá para publicar momentos agora, o compartilhamento abriu como publicação')
  for (const seconds of [1, 30, 60]) {
    t.is(momentShareBack(seconds), 'o vídeo passa de ' + seconds + ' segundos, por isso abriu como publicação')
  }
  for (const seconds of [0, -1, 1.5, NaN, Infinity, -Infinity, '30', null, undefined, true, {}]) {
    t.is(momentShareBack(seconds), MOMENT_SHARE_BACK)
  }
})

function raw (fields = {}) {
  return {
    id: ID,
    at: AT,
    title: '',
    text: '',
    url: '',
    total: 0,
    files: [],
    ...fields
  }
}

function share (suffix = 'a', at = AT) {
  return {
    id: String(at) + '-' + suffix.repeat(32),
    at,
    text: 'texto',
    clipped: false,
    files: [],
    dropped: 0,
    failed: 0
  }
}

test('composeShareText sanitizes shared fields and preserves line feeds', async (t) => {
  const { composeShareText } = await load()
  const result = composeShareText({
    title: 'ignored',
    text: 'a\r\nb\rc\u0000d\u202ee\u2066f\ufffdg',
    url: 'https://example.com/a'
  })
  t.alike(result, {
    text: 'a\nb\ncdefg\nhttps://example.com/a',
    clipped: false
  })
  t.is(result.text.includes('\ufffd'), false, 'replacement characters are removed')
})

test('composeShareText uses the title only for empty text and appends safe urls once', async (t) => {
  const { composeShareText } = await load()
  t.alike(composeShareText({ title: 'Título', text: '   ', url: '' }), { text: 'Título', clipped: false })
  t.alike(composeShareText({ title: 'Título', text: 'Corpo', url: '' }), { text: 'Corpo', clipped: false })
  t.is(composeShareText({ title: '', text: 'Veja https://example.com', url: 'https://example.com' }).text, 'Veja https://example.com')
  t.is(composeShareText({ title: '', text: 'Veja', url: 'HTTPS://example.com' }).text, 'Veja\nHTTPS://example.com')
  t.is(composeShareText({ title: '', text: '', url: 'https://example.com' }).text, 'https://example.com')
  t.is(composeShareText({ title: '', text: 'Corpo', url: 'javascript:alert(1)' }).text, 'Corpo')
  t.is(composeShareText({ title: '', text: 'Corpo', url: 'https://example.com/a b' }).text, 'Corpo')
})

test('composeShareText clips by code point with an emoji at the edge', async (t) => {
  const { composeShareText } = await load()
  const source = 'a'.repeat(rpc.MAX_TEXT - 1) + '\u{1f600}x'
  const result = composeShareText({ title: '', text: source, url: '' })
  t.is(Array.from(result.text).length, rpc.MAX_TEXT)
  t.is(result.text.endsWith('\u{1f600}'), true)
  t.is(result.clipped, true)
})

test('composeShareText keeps an exactly fitting url and never cuts an overflowing url', async (t) => {
  const { composeShareText } = await load()
  const url = 'https://example.com/a'
  const exactBody = 'a'.repeat(rpc.MAX_TEXT - Array.from(url).length - 1)
  t.alike(composeShareText({ title: '', text: exactBody, url }), {
    text: exactBody + '\n' + url,
    clipped: false
  })
  const overflowBody = exactBody + 'x'
  t.alike(composeShareText({ title: '', text: overflowBody, url }), {
    text: overflowBody,
    clipped: true
  })

  const spaced = 'a'.repeat(rpc.MAX_TEXT - 2) + '   tail'
  t.alike(composeShareText({ title: '', text: spaced, url }), {
    text: 'a'.repeat(rpc.MAX_TEXT - 2),
    clipped: true
  })
})

test('composeShareText accepts urls through 2000 characters', async (t) => {
  const { composeShareText } = await load()
  const atLimit = 'https://' + 'a'.repeat(2000 - 'https://'.length)
  const overLimit = atLimit + 'a'
  t.alike(composeShareText({ title: '', text: '', url: atLimit }), { text: '', clipped: true })
  t.alike(composeShareText({ title: '', text: '', url: overLimit }), { text: '', clipped: false })
})

test('acceptShare rejects malformed identity and future timestamps', async (t) => {
  const { acceptShare } = await load()
  for (const id of [
    'bad',
    AT + '-' + 'A'.repeat(32),
    String(AT).slice(1) + '-' + 'a'.repeat(32),
    AT + '-' + 'a'.repeat(31)
  ]) {
    t.is(acceptShare(raw({ id, text: 'x' }), AT), null, id)
  }
  t.is(acceptShare(raw({ at: AT + 1, text: 'x' }), AT), null, 'id timestamp must match')
  const atLimit = AT + 60000
  t.ok(acceptShare(raw({ id: atLimit + '-' + 'b'.repeat(32), at: atLimit, text: 'x' }), AT), '60 seconds ahead')
  const future = AT + 61000
  t.is(acceptShare(raw({ id: future + '-' + 'b'.repeat(32), at: future, text: 'x' }), AT), null, '61 seconds ahead')
  t.is(acceptShare([], AT), null, 'raw must be a plain object')
  t.is(acceptShare(raw({ at: Number.MAX_SAFE_INTEGER + 1, text: 'x' }), AT), null, 'at must be safe')
  t.is(acceptShare(raw({ files: null, text: 'x' }), AT), null, 'files must be an array')
})

test('acceptShare keeps ten native files and counts all offered entries', async (t) => {
  const { acceptShare } = await load()
  const files = Array.from({ length: 11 }, (_, i) => ({
    uri: 'file://' + i,
    mimeType: i === 10 ? 'image/gif' : 'image/jpeg',
    width: 100 + i,
    height: 200 + i
  }))
  const accepted = acceptShare(raw({ files, total: 3 }), AT)
  t.is(accepted.files.length, 10)
  t.alike(accepted.files[0], { uri: 'file://0', mimeType: 'image/jpeg', width: 100, height: 200 })
  t.is(accepted.dropped, 1)
  t.is(accepted.failed, 0)
})

test('acceptShare separates over-cap and failed files and passes a web File through', async (t) => {
  const { acceptShare } = await load()
  const file = { type: 'image/png', size: 42, name: 'photo.png' }
  const second = { type: 'image/gif', size: 43, name: 'animation.gif' }
  let accepted = acceptShare(raw({ files: [{ nope: true }, file, second], total: 3 }), AT)
  t.is(accepted.files.length, 2)
  t.is(accepted.files[0], file, 'web file reference')
  t.is(accepted.files[1], second, 'second web file reference')
  t.is(accepted.dropped, 0)
  t.is(accepted.failed, 1)

  const files = Array.from({ length: 10 }, (_, i) => ({ type: 'image/png', size: i + 1 }))
  accepted = acceptShare(raw({ files, total: 12 }), AT)
  t.is(accepted.files.length, 10)
  t.is(accepted.dropped, 2)
  t.is(accepted.failed, 0)
  t.is(acceptShare(raw(), AT), null, 'an empty share is ignored')
})

test('acceptShare takes one video when no photo came along and says why one is left out', async (t) => {
  const { acceptShare } = await load()
  const clip = { uri: 'file://v/0.mp4', mimeType: 'video/mp4' }
  let accepted = acceptShare(raw({ files: [clip], videos: 1 }), AT)
  t.alike(accepted.files, [])
  t.alike(accepted.video, { uri: 'file://v/0.mp4', mimeType: 'video/mp4', width: undefined, height: undefined })
  t.is(accepted.videoNote, '')
  t.is(accepted.failed, 0, 'a video is not a failed photo')
  t.is(accepted.dropped, 0)

  const web = { type: 'video/mp4', size: 9 }
  accepted = acceptShare(raw({ files: [web, { type: 'video/mp4', size: 10 }], videos: 2 }), AT)
  t.is(accepted.video, web, 'the first web video, by reference')
  t.is(accepted.videoNote, 'extra')

  const photo = { type: 'image/png', size: 4 }
  accepted = acceptShare(raw({ files: [web, photo], total: 1, videos: 1 }), AT)
  t.alike(accepted.files, [photo])
  t.is(accepted.video, null, 'a post holds a video or photos')
  t.is(accepted.videoNote, 'photos')

  accepted = acceptShare(raw({ text: 'veja', files: [], videos: 1 }), AT)
  t.is(accepted.video, null)
  t.is(accepted.videoNote, 'failed', 'offered but not copied')
  t.is(accepted.failed, 0)

  accepted = acceptShare(raw({ files: [{ mimeType: 'video/mp4' }], text: 'x' }), AT)
  t.is(accepted.video, null, 'a malformed video entry is not used')
  t.is(accepted.videoNote, 'failed')
  t.is(accepted.failed, 0, 'and is not counted as a photo')

  accepted = acceptShare(raw({ videos: 1 }), AT)
  t.alike([accepted.text, accepted.files, accepted.video, accepted.videoNote], ['', [], null, 'failed'], 'a video that did not arrive still opens the composer to say so')
  t.is(acceptShare(raw({ videos: 0 }), AT), null, 'nothing to show')
  accepted = acceptShare(raw({ files: [clip], videos: '3' }), AT)
  t.is(accepted.videoNote, '', 'a malformed count falls back to the entries')
})

test('shareStep keeps the newest share and ignores released inbox entries', async (t) => {
  const { EMPTY, shareStep } = await load()
  const first = share('a')
  const second = share('b', AT + 1)
  let unchanged = shareStep(EMPTY, { type: 'inbox', share: null, ownKey: 'one' })
  t.is(unchanged.state, EMPTY, 'a null inbox changes nothing')
  t.alike(unchanged.effects, [])
  unchanged = shareStep(EMPTY, { type: 'inbox', share: undefined, ownKey: 'one' })
  t.is(unchanged.state, EMPTY, 'an undefined inbox changes nothing')
  t.alike(unchanged.effects, [])
  unchanged = shareStep(EMPTY, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT })
  t.is(unchanged.state, EMPTY, 'an empty tick changes nothing')
  t.alike(unchanged.effects, [])
  let result = shareStep(EMPTY, { type: 'inbox', share: first, ownKey: 'one' })
  t.alike(result.state, { held: first, phase: 'idle', owner: 'one', last: null, taken: false })
  t.alike(result.effects, [])
  const held = result.state
  result = shareStep(held, { type: 'inbox', share: first, ownKey: 'two' })
  t.is(result.state, held, 'same id is ignored')
  result = shareStep(held, { type: 'inbox', share: second, ownKey: 'two' })
  t.alike(result.effects, [{ type: 'release', id: first.id }])
  t.alike(result.state, { held: second, phase: 'idle', owner: 'two', last: first.id, taken: false })
  const newest = result.state
  result = shareStep(newest, { type: 'inbox', share: first, ownKey: 'one' })
  t.is(result.state, newest, 'a released peek cannot requeue the old share')
})

test('shareStep expires after one hour and records the dropped id', async (t) => {
  const { EMPTY, EXPIRED_TEXT, SHARE_TTL_MS, shareStep } = await load()
  const item = share()
  const held = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: 'one' }).state
  const atLimit = shareStep(held, { type: 'tick', ready: false, locked: false, ownKey: 'one', now: AT + SHARE_TTL_MS })
  t.is(atLimit.state, held, 'the exact ttl is still valid')
  const expired = shareStep(held, { type: 'tick', ready: true, locked: true, ownKey: 'two', now: AT + SHARE_TTL_MS + 1 })
  t.alike(expired.state, { held: null, phase: 'idle', owner: null, last: item.id, taken: false })
  t.alike(expired.effects, [
    { type: 'release', id: item.id },
    { type: 'toast', text: EXPIRED_TEXT }
  ])
  const replay = shareStep(expired.state, { type: 'inbox', share: item, ownKey: 'one' })
  t.is(replay.state, expired.state)
})

test('shareStep opens once and a lock lets it open again', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  let state = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: null }).state
  for (const ownKey of [null, '']) {
    const gated = shareStep(state, { type: 'tick', ready: true, locked: false, ownKey, now: AT })
    t.is(gated.state, state, 'a missing account key keeps the held share idle')
    t.alike(gated.effects, [])
  }
  let result = shareStep(state, { type: 'tick', ready: false, locked: false, ownKey: 'one', now: AT })
  t.alike(result.state, { held: item, phase: 'idle', owner: 'one', last: null, taken: false })
  t.alike(result.effects, [], 'binding alone does not open')
  result = shareStep(result.state, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT })
  t.alike(result.effects, [{ type: 'open' }])
  t.is(result.state.phase, 'shown')
  state = result.state
  result = shareStep(state, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT })
  t.is(result.state, state, 'shown stays shown')
  t.alike(result.effects, [])
  result = shareStep(state, { type: 'tick', ready: true, locked: true, ownKey: 'one', now: AT })
  t.is(result.state.held, item, 'lock keeps the share')
  t.is(result.state.owner, 'one', 'lock keeps the owner')
  t.is(result.state.phase, 'idle')
  result = shareStep(result.state, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT })
  t.alike(result.effects, [{ type: 'open' }])
})

test('shareStep drops another owner without a toast', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const held = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: 'one' }).state
  const result = shareStep(held, { type: 'tick', ready: true, locked: false, ownKey: 'two', now: AT })
  t.alike(result.state, { held: null, phase: 'idle', owner: null, last: item.id, taken: false })
  t.alike(result.effects, [{ type: 'release', id: item.id }])
})

test('shareStep drops a bound share when the account leaves the device', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const bound = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: 'one' }).state
  for (const state of [bound, { ...bound, phase: 'shown', taken: true }]) {
    const result = shareStep(state, { type: 'tick', ready: false, locked: true, ownKey: null, gone: true, now: AT })
    t.alike(result.state, { held: null, phase: 'idle', owner: null, last: item.id, taken: false })
    t.alike(result.effects, [{ type: 'release', id: item.id }], 'released without a toast, taken or not')
  }
  const kept = shareStep(bound, { type: 'tick', ready: false, locked: true, ownKey: 'one', now: AT })
  t.is(kept.state.held, item, 'a lock alone keeps the bound share')
  const unbound = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: null }).state
  let result = shareStep(unbound, { type: 'tick', ready: false, locked: true, ownKey: null, gone: true, now: AT })
  t.is(result.state, unbound, 'a share that arrived with no account waits for the next one')
  t.alike(result.effects, [])
  result = shareStep(result.state, { type: 'tick', ready: true, locked: false, ownKey: 'two', now: AT })
  t.is(result.state.owner, 'two')
  t.alike(result.effects, [{ type: 'open' }])
})

test('shareStep binds to a locked stored account, so Recomeçar drops the share', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const dropped = { held: null, phase: 'idle', owner: null, last: item.id, taken: false }
  let result = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: null })
  result = shareStep(result.state, { type: 'tick', ready: false, locked: true, ownKey: 'one', now: AT })
  t.alike(result.state, { held: item, phase: 'idle', owner: 'one', last: null, taken: false }, 'the locked stored account owns it')
  t.alike(result.effects, [])
  const other = shareStep(result.state, { type: 'tick', ready: false, locked: true, ownKey: 'two', now: AT })
  t.alike(other.state, dropped, 'another stored account drops it while locked')
  t.alike(other.effects, [{ type: 'release', id: item.id }])
  const reset = shareStep(result.state, { type: 'tick', ready: false, locked: true, ownKey: null, gone: true, now: AT })
  t.alike(reset.state, dropped)
  t.alike(reset.effects, [{ type: 'release', id: item.id }])
  const next = shareStep(reset.state, { type: 'tick', ready: true, locked: false, ownKey: 'two', now: AT })
  t.alike(next.effects, [], 'the next account never sees it')
})

test('shareStep requeues shown shares and ignores a stale done id', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  let state = shareStep(EMPTY, { type: 'inbox', share: item, ownKey: 'one' }).state
  state = shareStep(state, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT }).state
  const stale = shareStep(state, { type: 'done', id: 'stale' })
  t.is(stale.state, state)
  let result = shareStep(state, { type: 'requeue' })
  t.is(result.state.phase, 'idle')
  result = shareStep(result.state, { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT })
  t.alike(result.effects, [{ type: 'open' }])
  result = shareStep(result.state, { type: 'done', id: item.id })
  t.alike(result.state, { held: null, phase: 'idle', owner: null, last: item.id, taken: false })
  t.alike(result.effects, [{ type: 'release', id: item.id }])
  const replay = shareStep(result.state, { type: 'inbox', share: item, ownKey: 'one' })
  t.is(replay.state, result.state, 'done share stays done')
})

test('shareStep starts with a frozen untaken empty state', async (t) => {
  const { EMPTY } = await load()
  t.is(EMPTY.taken, false)
  t.is(Object.isFrozen(EMPTY), true)
})

test('shareStep takes the shown share without effects', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const state = { ...EMPTY, held: item, phase: 'shown', owner: 'one' }
  const result = shareStep(state, { type: 'taken', id: item.id })
  t.alike(result.state, { ...state, taken: true })
  t.alike(result.effects, [])
  t.is(state.taken, false, 'the previous state stays unchanged')
})

test('shareStep ignores taken for a different id', async (t) => {
  const { EMPTY, shareStep } = await load()
  const state = { ...EMPTY, held: share(), phase: 'shown', owner: 'one' }
  const result = shareStep(state, { type: 'taken', id: share('b').id })
  t.is(result.state, state)
  t.alike(result.effects, [])
})

test('shareStep ignores taken while idle or empty', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  for (const state of [{ ...EMPTY, held: item, owner: 'one' }, EMPTY]) {
    const result = shareStep(state, { type: 'taken', id: item.id })
    t.is(result.state, state)
    t.alike(result.effects, [])
  }
})

test('shareStep skips expiry while taken and expires again after a lock', async (t) => {
  const { EMPTY, EXPIRED_TEXT, SHARE_TTL_MS, shareStep } = await load()
  const item = share()
  const state = { ...EMPTY, held: item, phase: 'shown', owner: 'one', taken: true }
  const tick = { type: 'tick', ready: true, locked: false, ownKey: 'one', now: AT + SHARE_TTL_MS + 1 }
  const applying = shareStep(state, tick)
  t.is(applying.state, state, 'encoding keeps its files beyond the ttl')
  t.alike(applying.effects, [])
  const locked = shareStep(state, { ...tick, locked: true })
  t.alike(locked.state, { ...state, phase: 'idle', taken: false })
  t.alike(locked.effects, [], 'locking requeues without releasing')
  const expired = shareStep(locked.state, tick)
  t.alike(expired.state, { ...EMPTY, last: item.id })
  t.alike(expired.effects, [
    { type: 'release', id: item.id },
    { type: 'toast', text: EXPIRED_TEXT }
  ])
})

test('shareStep ignores requeue while taken', async (t) => {
  const { EMPTY, shareStep } = await load()
  const state = { ...EMPTY, held: share(), phase: 'shown', owner: 'one', taken: true }
  const result = shareStep(state, { type: 'requeue' })
  t.is(result.state, state)
  t.alike(result.effects, [])
})

test('shareStep done clears taken and releases only the matching share', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const state = { ...EMPTY, held: item, phase: 'shown', owner: 'one', taken: true }
  const stale = shareStep(state, { type: 'done', id: share('b').id })
  t.is(stale.state, state)
  t.alike(stale.effects, [])
  const result = shareStep(state, { type: 'done', id: item.id })
  t.is(result.state.taken, false)
  t.alike(result.state, { ...EMPTY, last: item.id })
  t.alike(result.effects, [{ type: 'release', id: item.id }])
})

test('mergeDraft keeps fitting text and leaves a full draft unchanged', async (t) => {
  const { mergeDraft } = await load()
  t.alike(mergeDraft('rascunho', '', 2), { text: 'rascunho', kept: true }, 'a photo-only share never cuts the draft')
  t.alike(mergeDraft('abcdef', 'x', 4), { text: 'abcdef', kept: false }, 'a draft over the limit stays whole when the shared text does not fit')
  t.alike(mergeDraft('  ', 'abcde', 4), { text: 'abcd', kept: false })
  t.alike(mergeDraft('  ', 'a\u{1f600}bc', 3), { text: 'a\u{1f600}b', kept: false })
  t.alike(mergeDraft('a', '\u{1f600}', 3), { text: 'a\n\u{1f600}', kept: true })
  t.alike(mergeDraft('a', '\u{1f600}', 2), { text: 'a', kept: false })
})

test('shareNote covers every branch in priority order', async (t) => {
  const { shareNote } = await load()
  t.is(shareNote({ hadFiles: true, canAttach: false, noRoom: 2, dropped: 3, failed: 1, kept: false, clipped: true }), 'não dá para anexar fotos agora. algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: false, canAttach: false, noRoom: 2, dropped: 3, kept: false, clipped: true }), 'até 10 fotos por publicação')
  t.is(shareNote({ hadFiles: false, canAttach: false, noRoom: 2, dropped: 3, failed: 1, kept: false, clipped: true }), 'até 10 fotos por publicação. algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: true, canAttach: true, noRoom: 0, dropped: 3, failed: 1, kept: false, clipped: true }), 'só as 10 primeiras fotos foram anexadas. algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, kept: false, clipped: true }), 'o texto compartilhado não coube no rascunho')
  t.is(shareNote({ hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, failed: 1, kept: false, clipped: true }), 'o texto compartilhado não coube no rascunho. algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, failed: 1, kept: true, clipped: true }), 'o texto compartilhado foi cortado em 1000 caracteres. algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, failed: 1, kept: true, clipped: false }), 'algumas fotos não puderam ser abertas')
  t.is(shareNote({ hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, kept: true, clipped: false }), '')
})

test('shareNote tells why a shared video is not attached', async (t) => {
  const { shareNote } = await load()
  const base = { hadFiles: false, canAttach: true, noRoom: 0, dropped: 0, kept: true, clipped: false }
  t.is(shareNote({ ...base, hadVideo: true, canVideo: false, kept: false }), 'não dá para anexar vídeos agora')
  t.is(shareNote({ ...base, hadVideo: true, canVideo: true, kept: false }), 'o texto compartilhado não coube no rascunho')
  t.is(shareNote({ ...base, hadVideo: true, canVideo: true, videoNote: 'extra' }), 'só o primeiro vídeo foi anexado')
  t.is(shareNote({ ...base, hadFiles: true, failed: 1, videoNote: 'photos' }), 'algumas fotos não puderam ser abertas. o vídeo ficou de fora, uma publicação leva um vídeo ou fotos')
  t.is(shareNote({ ...base, kept: false, videoNote: 'failed' }), 'o texto compartilhado não coube no rascunho. o vídeo não pôde ser recebido')
  t.is(shareNote({ ...base, videoNote: 'constructor' }), '', 'only the known notes')
})

test('sharedLinkHold holds a link the share brought, and only that', async (t) => {
  const { sharedLinkHold } = await load()
  t.is(sharedLinkHold('', 'olha https://example.com/a'), 'olha https://example.com/a', 'a shared link on an empty draft is held')
  t.is(sharedLinkHold('oi', 'oi\nhttps://example.com/a'), 'oi\nhttps://example.com/a', 'a shared link after the draft is held')
  t.is(sharedLinkHold('', 'só texto'), null, 'a share without a link changes nothing')
  t.is(sharedLinkHold('veja https://example.org/x', 'veja https://example.org/x\nhttps://example.com/a'), null, 'the draft link still comes first')
  t.is(sharedLinkHold('rascunho', 'rascunho'), null, 'a share that did not fit leaves the draft alone')
  t.is(sharedLinkHold('', 'http://example.com/a'), null, 'no preview target, nothing to hold')
  t.is(sharedLinkHold(null, 'https://example.com/a'), null)
})

test('sharedLinkHold keeps a hold across a later share', async (t) => {
  const { linkHeld, sharedLinkHold } = await load()
  const first = 'olha https://example.com/a'
  const hold = sharedLinkHold('', first)
  t.is(sharedLinkHold(first, first, hold), first, 'a share that did not fit keeps the hold')
  const more = first + '\nmais texto'
  t.is(sharedLinkHold(first, more, hold), more, 'a share without a link moves the hold to the new text')
  t.is(linkHeld(sharedLinkHold(first, more, hold), more), true, 'still no automatic preview')
  t.is(sharedLinkHold(first, more, null), null, 'released before by the tap: the preview goes on as usual')
  t.is(sharedLinkHold(first, more, 'outro texto'), null, 'a hold the text no longer matches is gone')
  t.is(sharedLinkHold(first, 'só texto', hold), null, 'no preview target, nothing to hold')
})

test('linkHeld keeps the hold only while the text is exactly the shared one', async (t) => {
  const { linkHeld, sharedLinkHold } = await load()
  const merged = 'olha https://example.com/a'
  const hold = sharedLinkHold('', merged)
  t.is(linkHeld(hold, merged), true, 'no automatic preview for the shared text')
  t.is(linkHeld(hold, merged + ' '), false, 'any edit releases it')
  t.is(linkHeld(hold, 'olha https://example.com/b'), false)
  t.is(linkHeld(null, merged), false, 'the tap releases it')
  t.is(linkHeld('só texto', 'só texto'), false, 'no preview target, nothing held')
})

test('shareStep loaded lets go of a taken share without releasing its files', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const state = { ...EMPTY, held: item, phase: 'shown', owner: 'one', taken: true }
  const result = shareStep(state, { type: 'loaded', id: item.id })
  t.alike(result.state, { ...EMPTY, last: item.id }, 'the shell forgets it')
  t.alike(result.effects, [], 'Publicar keeps the files for a retry')
  const again = shareStep(result.state, { type: 'inbox', share: item, ownKey: 'one' })
  t.is(again.state, result.state, 'the same share is not read again')
  const next = share('b', AT + 1)
  const other = shareStep(result.state, { type: 'inbox', share: next, ownKey: 'one' })
  t.is(other.state.held, next, 'a newer share is read meanwhile')
  t.alike(other.effects, [], 'nothing of the kept share is released')
})

test('shareStep ignores loaded unless the matching share is shown and taken', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  for (const state of [
    EMPTY,
    { ...EMPTY, held: item, owner: 'one' },
    { ...EMPTY, held: item, phase: 'shown', owner: 'one' },
    { ...EMPTY, held: share('b'), phase: 'shown', owner: 'one', taken: true }
  ]) {
    const result = shareStep(state, { type: 'loaded', id: item.id })
    t.is(result.state, state)
    t.alike(result.effects, [])
  }
})

test('shareStep free releases a kept share, and drops it if it is still held', async (t) => {
  const { EMPTY, shareStep } = await load()
  const item = share()
  const next = { ...EMPTY, held: share('b', AT + 1), owner: 'one' }
  const kept = shareStep(next, { type: 'free', id: item.id })
  t.is(kept.state, next, 'the share the shell holds now stays')
  t.alike(kept.effects, [{ type: 'release', id: item.id }])
  const held = { ...EMPTY, held: item, phase: 'shown', owner: 'one', taken: true }
  const dropped = shareStep(held, { type: 'free', id: item.id })
  t.alike(dropped.state, { ...EMPTY, last: item.id })
  t.alike(dropped.effects, [{ type: 'release', id: item.id }])
  for (const id of ['', 'x', null, 42, '../' + item.id]) {
    const bad = shareStep(next, { type: 'free', id })
    t.is(bad.state, next, 'no release for ' + JSON.stringify(id))
    t.alike(bad.effects, [])
  }
})

test('retryableEncode refuses only size and format', async (t) => {
  const { retryableEncode } = await load()
  t.ok(retryableEncode('não foi possível abrir a foto'))
  t.ok(retryableEncode('não foi possível preparar a foto'))
  t.ok(retryableEncode('sem conexão'))
  t.absent(retryableEncode('formato não aceito'))
  t.absent(retryableEncode('arquivo grande demais'))
  t.absent(retryableEncode('foto grande demais'))
  t.absent(retryableEncode('imagem grande demais'))
  t.absent(retryableEncode(''))
  t.absent(retryableEncode(undefined))
})

test('holdShare and settleHold keep a share until each failed photo settles', async (t) => {
  const { holdShare, settleHold } = await load()
  t.alike(holdShare(ID, []), { hold: null, done: ID }, 'nothing failed: done now')
  t.alike(holdShare(ID, undefined), { hold: null, done: ID })
  const start = holdShare(ID, [3, 5, 3])
  t.alike(start, { hold: { id: ID, ids: [3, 5] }, done: null }, 'held, each id once')
  const same = settleHold(start.hold, [9])
  t.is(same.hold, start.hold, 'another photo changes nothing')
  t.is(same.done, null)
  const one = settleHold(start.hold, [3])
  t.alike(one, { hold: { id: ID, ids: [5] }, done: null })
  t.alike(settleHold(one.hold, [5, 7]), { hold: null, done: ID }, 'the last one frees it')
  t.alike(settleHold(null, [5]), { hold: null, done: null }, 'no hold')
  t.alike(settleHold(start.hold, null), { hold: start.hold, done: null })
})

test('restoreDraft puts the kept text first and never cuts it', async (t) => {
  const { restoreDraft } = await load()
  t.is(restoreDraft('', 'atual', 10), 'atual', 'nothing kept')
  t.is(restoreDraft(null, 'atual', 10), 'atual')
  t.is(restoreDraft('guardado', '', 3), 'guardado', 'an empty draft takes it whole, over max too')
  t.is(restoreDraft('guardado', '  \n', 3), 'guardado', 'a blank draft too')
  t.is(restoreDraft('guardado', 'guardado', 3), 'guardado', 'not twice')
  t.is(restoreDraft('ab', 'cd', 5), 'ab\ncd', 'both when they fit')
  t.is(restoreDraft('ab', 'cde', 5), 'ab', 'the kept text alone when they do not')
  t.is(restoreDraft('😀', 'ab', 4), '😀\nab', 'counted by code point')
})
