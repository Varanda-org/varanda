'use strict'

// The composer's "Publicar também na web" box (src/postShareCompose.js): who
// is offered it, the single post.share, and the words after. No network.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { createHash } = require('node:crypto')
const { compileFunction } = require('node:vm')

// The send bodies read the description draft (alts, videoAlt) and its helpers.
// No description typed in these drafts, so neither helper has a list to build.
function altScope () {
  return { altParam: () => null, videoAltParam: () => null, alts: {}, videoAlt: '' }
}

const load = () => import('../src/postShareCompose.js')

const AUTHOR = 'ab'.repeat(32)
const SRC = path.join(__dirname, '../src')
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8')

function caller (answer) {
  const calls = []
  const call = async (method, params) => {
    calls.push([method, params])
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, call }
}

function rpcError (code, message, uncertain = false) {
  return Object.assign(new Error(message), { code, uncertain })
}

test('webShareOffered is true only for a plain post with the box on', async (t) => {
  const { webShareOffered } = await load()
  const base = { enabled: true, online: true, author: AUTHOR }
  t.is(webShareOffered(base), true)
  t.is(webShareOffered({ enabled: true, author: AUTHOR }), true, 'online unknown is fine')
  t.is(webShareOffered({ ...base, author: AUTHOR.toUpperCase() }), true)
  t.is(webShareOffered(), false)
  t.is(webShareOffered({ ...base, page: true }), true, 'a Page post is offered the box too')
  t.is(webShareOffered({ ...base, enabled: undefined }), false)
  t.is(webShareOffered({ ...base, enabled: 'yes' }), false)
  t.is(webShareOffered({ ...base, online: false }), false)
  for (const bad of [undefined, null, 'abc', 'zz'.repeat(32), AUTHOR + 'a', 7]) {
    t.is(webShareOffered({ ...base, author: bad }), false, 'author ' + String(bad))
  }
  for (const key of ['locked', 'moment', 'reply', 'quote', 'poll', 'event']) {
    t.is(webShareOffered({ ...base, [key]: true }), false, key)
    t.is(webShareOffered({ ...base, [key]: { id: 1 } }), false, key + ' object')
  }
})

test('webShareRef builds a lowercase ref from a key and a seq', async (t) => {
  const { webShareRef } = await load()
  t.is(webShareRef(AUTHOR, 4), AUTHOR + ':4')
  t.is(webShareRef(AUTHOR.toUpperCase(), 4), AUTHOR + ':4')
  for (const seq of [0, -1, null, undefined, 1.5, '3', NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(webShareRef(AUTHOR, seq), null, 'seq ' + String(seq))
  }
  t.is(webShareRef('nope', 4), null)
  t.is(webShareRef(null, 4), null)
})

test('shareNew sends one post.share and returns the ref and the result', async (t) => {
  const { shareNew } = await load()
  const c = caller({ shareSeq: 9, created: true })
  t.alike(await shareNew(c.call, AUTHOR, 5), {
    ref: AUTHOR + ':5',
    result: { state: 'on', shareSeq: 9, message: '' }
  })
  t.alike(c.calls, [['post.share', { to: AUTHOR + ':5' }]])
})

test('shareNew maps failures and never rejects or retries', async (t) => {
  const { shareNew } = await load()
  const lost = caller(rpcError('INTERNAL', 'timeout', true))
  const a = await shareNew(lost.call, AUTHOR, 5)
  t.is(a.result.state, 'uncertain')
  t.is(a.result.shareSeq, null)
  t.is(lost.calls.length, 1, 'one call, no retry')

  const refused = caller(rpcError('USAGE', 'limite de publicações na web atingido'))
  const b = await shareNew(refused.call, AUTHOR, 5)
  t.is(b.result.state, 'error')
  t.is(refused.calls.length, 1)

  const none = caller({ shareSeq: 1, created: true })
  t.alike(await shareNew(none.call, AUTHOR, null), { ref: null, result: null })
  t.is(none.calls.length, 0, 'no call without a seq')

  const bad = await shareNew(null, AUTHOR, 5)
  t.ok(bad.result && bad.result.state, 'a missing call still resolves')
})

test('webShareAfter words each outcome, and only "on" says sent', async (t) => {
  const { webShareAfter, WEB_SHARE_SENT, WEB_SHARE_UNKNOWN, WEB_SHARE_FAILED, WEB_SHARE_NO_REF } = await load()
  const ref = AUTHOR + ':5'
  t.is(webShareAfter(null), null)
  t.is(webShareAfter(undefined), null)
  t.is(webShareAfter('x'), null)
  const noRef = { ref: null, notice: '', toast: WEB_SHARE_NO_REF }
  t.alike(webShareAfter({ ref: null, result: null }), noRef)
  t.alike(webShareAfter({ ref, result: null }), noRef)
  t.alike(webShareAfter({ ref: 5, result: { state: 'on' } }), noRef)
  t.alike(webShareAfter({ ref, result: { state: 'on', shareSeq: 2, message: '' } }), { ref, notice: WEB_SHARE_SENT, toast: '' })
  const unknown = webShareAfter({ ref, result: { state: 'uncertain', shareSeq: null, message: 'x' } })
  t.alike(unknown, { ref, notice: WEB_SHARE_UNKNOWN, toast: '' })
  t.absent(unknown.notice.includes('Enviado'))
  const failed = webShareAfter({ ref, result: { state: 'error', shareSeq: null, message: 'Você chegou ao limite de publicações na web.' } })
  t.alike(failed, { ref, notice: WEB_SHARE_FAILED + ' Você chegou ao limite de publicações na web.', toast: '' })
  t.absent(failed.notice.includes('Enviado'))
  t.alike(webShareAfter({ ref, result: { state: 'error', message: '' } }), { ref, notice: WEB_SHARE_FAILED, toast: '' })
})

test('webShareAfter calls an unknown state unknown and drops the generic reason', async (t) => {
  const { webShareAfter, WEB_SHARE_UNKNOWN, WEB_SHARE_FAILED } = await load()
  const ref = AUTHOR + ':5'
  t.is(WEB_SHARE_UNKNOWN, 'A publicação saiu. Não deu para confirmar o envio para a web.')
  t.alike(webShareAfter({ ref, result: { state: undefined } }), { ref, notice: WEB_SHARE_UNKNOWN, toast: '' })
  t.alike(webShareAfter({ ref, result: { state: 'weird', message: 'x' } }), { ref, notice: WEB_SHARE_UNKNOWN, toast: '' })
  t.alike(webShareAfter({ ref, result: {} }), { ref, notice: WEB_SHARE_UNKNOWN, toast: '' })
  t.is(webShareAfter({ ref, result: { state: 'error', message: 'Não deu para publicar na web.' } }).notice, WEB_SHARE_FAILED)
  t.is(webShareAfter({ ref, result: { state: 'error', message: 7 } }).notice, WEB_SHARE_FAILED)
})

test('shareNew still resolves when publish itself throws', async (t) => {
  const { shareNew } = await load()
  const { UNCERTAIN_MESSAGE } = await import('../src/postShare.js')
  // A revoked proxy throws in Array.isArray, inside publish's answer check,
  // outside its own try: the only way publish rejects.
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  const calls = []
  const call = async (method, params) => { calls.push([method, params]); return proxy }
  t.alike(await shareNew(call, AUTHOR, 5), {
    ref: AUTHOR + ':5',
    result: { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE }
  })
  t.is(calls.length, 1, 'one call, no retry')
})

test('firstReadView: the first read decides the words, never claiming more than it knows', async (t) => {
  const m = await load()
  const { firstReadView, WEB_SHARE_SENT, WEB_SHARE_UNKNOWN, WEB_SHARE_FAILED, REOPEN_FOR_LINK, REOPEN_TO_CHECK } = m
  const { UNCERTAIN_MESSAGE } = await import('../src/postShare.js')
  const REASON = WEB_SHARE_FAILED + ' Você chegou ao limite de publicações na web.'
  const leads = ['', WEB_SHARE_SENT, WEB_SHARE_UNKNOWN, WEB_SHARE_FAILED, REASON]
  const reads = {
    on: { state: 'on', shareSeq: 3, message: '' },
    off: { state: 'off', shareSeq: null, message: '' },
    uncertain: { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE },
    error: { state: 'error', shareSeq: null, message: 'Não deu para ver se esta publicação está na web.' },
    malformed: null
  }
  const expected = {
    on: [
      { phase: 'on', note: '', error: '' },
      { phase: 'on', note: WEB_SHARE_SENT, error: '' },
      { phase: 'on', note: WEB_SHARE_SENT, error: '' },
      { phase: 'on', note: WEB_SHARE_SENT, error: '' },
      { phase: 'on', note: WEB_SHARE_SENT, error: '' }
    ],
    off: [
      { phase: 'off', note: '', error: '' },
      { phase: 'off', note: '', error: '' },
      { phase: 'off', note: WEB_SHARE_FAILED, error: '' },
      { phase: 'off', note: WEB_SHARE_FAILED, error: '' },
      { phase: 'off', note: REASON, error: '' }
    ],
    uncertain: [
      { phase: 'unknown', note: UNCERTAIN_MESSAGE, error: '' },
      { phase: 'unknown', note: WEB_SHARE_SENT + ' ' + REOPEN_FOR_LINK, error: '' },
      { phase: 'unknown', note: WEB_SHARE_UNKNOWN + ' ' + REOPEN_TO_CHECK, error: '' },
      { phase: 'unknown', note: WEB_SHARE_UNKNOWN + ' ' + REOPEN_TO_CHECK, error: '' },
      { phase: 'unknown', note: WEB_SHARE_UNKNOWN + ' ' + REOPEN_TO_CHECK, error: '' }
    ],
    error: leads.map((lead) => ({ phase: 'unknown', note: lead, error: reads.error.message }))
  }
  expected.malformed = expected.uncertain
  for (const [name, r] of Object.entries(reads)) {
    leads.forEach((lead, i) => {
      const label = name + ' read, lead ' + (i === 0 ? 'none' : lead.slice(0, 30))
      const view = firstReadView(lead, r)
      t.alike(view, expected[name][i], label)
      if (view.phase === 'on' || view.phase === 'off') t.absent(view.note.includes('Não deu para confirmar'), label + ': no doubt on a known state')
      if (view.phase === 'off') t.absent(view.note.includes('Enviado'), label + ': off never says sent')
    })
  }
  t.is(firstReadView(WEB_SHARE_UNKNOWN, reads.on).note, WEB_SHARE_SENT, 'a live share after an unknown write says sent')
  t.is(firstReadView(REASON, reads.on).note, WEB_SHARE_SENT, 'a live share after a refusal says sent')
  for (const bad of [undefined, 'x', 7, []]) {
    t.alike(firstReadView('', bad).phase, 'unknown', 'malformed ' + JSON.stringify(bad))
  }
  t.alike(firstReadView(undefined, reads.on), { phase: 'on', note: '', error: '' }, 'a non-string notice is no notice')
  const r = { state: 'on', shareSeq: 1, message: '' }
  t.not(firstReadView('', r), r, 'a new object')
})

test('the sent notice matches the publish sheet, and the module stays pure', async (t) => {
  const { WEB_SHARE_SENT, WEB_SHARE_LABEL } = await load()
  t.is(WEB_SHARE_LABEL, 'Publicar também na web')
  t.ok(read('ui/PostShareSheet.js').includes(WEB_SHARE_SENT), 'same words as POST_SHARE_SENT')
  const source = read('postShareCompose.js')
  t.absent(source.includes(String.fromCharCode(0x2014)), 'no em dash')
  t.absent(source.includes('Platform.OS'))
  t.absent(/\b(?:window|document|navigator|localStorage|sessionStorage)\./.test(source))
  const imports = source.split('\n').filter((line) => /^\s*import\b/.test(line))
  t.alike(imports, ["import { UNCERTAIN_MESSAGE, addCover, claimCover, publish, releaseCover, sendCover } from './postShare.js'"])
})

// Publicar.js is JSX the tests cannot load: its wiring is checked as text.
function publicarBody (src, head) {
  const at = src.indexOf(head)
  if (at < 0) return null
  const end = src.indexOf('\n  }\n', at)
  return src.slice(at, end)
}

test('Publicar shows the box as a checkbox, unticked, with the consent only when ticked', (t) => {
  const src = read('screens/Publicar.js')
  t.ok(src.includes("accessibilityRole='checkbox' accessibilityState={{ checked: webShare,"), 'a checkbox reading webShare')
  t.ok(src.includes('{webShare ? <Soft>{POST_SHARE_CONSENT}</Soft> : null}'), 'the consent shows only while ticked')
  t.ok(src.includes('const [webShare, setWebShare] = useState(false)'), 'unticked to begin with')
  t.ok(src.includes('if (!open || !webShareOk) setWebShare(false)'), 'a close or a state without the box unticks it')
})

test('Publicar offers the box only for a plain own post', (t) => {
  const src = read('screens/Publicar.js')
  const at = src.indexOf('webShareOffered({')
  t.ok(at > 0)
  const offer = src.slice(at, src.indexOf('})', at))
  for (const part of ['reply: !!reply', 'quote: !!quote', 'poll: pollDraft !== null', 'event: eventDraft !== null', 'moment: momentMode', 'locked,', 'online: node.online', 'enabled: postPublic.enabled']) {
    t.ok(offer.includes(part), part)
  }
  t.ok(src.includes('const webOn = webShare && webShareOk'), 'a tick is void the moment the box stops being offered')
  t.ok(src.includes('const sentWeb = webOn && !sentReply && !sentQuote'), 'a reply or quote never shares')
  t.ok(src.includes("const sentWeb = webOn && kind === 'post'") && src.includes('shareNewAsPage('), 'a Page post shares once through the page action')
})

test('Publicar unticks after every post and when shared content arrives', (t) => {
  const src = read('screens/Publicar.js')
  const from = src.indexOf('appliedShareRef.current = shared.id')
  const to = src.indexOf('const current = textRef.current', from)
  t.ok(from > 0 && to > from)
  t.ok(src.slice(from, to).includes('setWebShare(false)'), 'shared text or files never inherit a tick')
  const at = src.indexOf('  const published = (sent,')
  const end = src.indexOf('\n  // Keeps the post', at)
  t.ok(at > 0 && end > at)
  t.ok(src.slice(at, end).includes('setWebShare(false)'), 'the tick never outlives its post')
})

test('a failed share never repeats the generic publish error of the sheet', async (t) => {
  const { webShareAfter, WEB_SHARE_FAILED } = await load()
  const { errorState } = await import('../src/postShare.js')
  const generic = errorState(Object.assign(new Error('algo novo'), { code: 'USAGE' }), 'publish')
  t.is(generic.state, 'error')
  t.is(webShareAfter({ ref: AUTHOR + ':5', result: generic }).notice, WEB_SHARE_FAILED)
})

test('Publicar shares once after the post, never from the outbox, a poll, an event or a page', (t) => {
  const src = read('screens/Publicar.js')
  t.ok(src.includes('!sentWeb && canQueue'), 'a ticked post never falls back to the outbox')
  t.is(src.split('shareNew(').length - 1, 2, 'one share after post.create, one after an uncertain post is found')
  for (const head of ['  const queue = async (', '  const sendPoll = async (', '  const sendEvent = async (']) {
    const body = publicarBody(src, head)
    t.ok(body, head.trim() + ' found')
    t.absent(body && body.includes('shareNew'), head.trim() + ' never shares')
  }
  const page = publicarBody(src, '  const sendAsPage = async (')
  t.ok(page && !page.includes('shareNew(') && !page.includes("'post.share'"), 'a Page post never uses the person share, only shareNewAsPage')
  const retry = page.slice(page.indexOf('await action.run(async () => {'), page.indexOf('if (pageRetryRef.current !== pending) return'))
  t.ok(retry.includes('pending.retry()') && retry.includes('shareNewAsPage('), 'the retry branch shares inside the same action.run')
  t.absent(src.includes("'post.share'"), 'the screen never sends post.share itself')
})

const COVER = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 4, blocks: 2, bytes: 40000, sha256: createHash('sha256').update(new Uint8Array(40000)).digest('hex'), width: 1200, height: 900 }
const AVIF = { ...COVER, mime: 'image/avif', bytes: 90000, width: 2000, height: 1500 }

function coverInput ({ built = { bytes: new Uint8Array(40000), mime: 'image/jpeg', width: 1200, height: 900 }, uploadThrows = false } = {}) {
  const seen = { uploads: 0 }
  return {
    seen,
    cover: {
      post: { media: [AVIF] },
      held: { bytes: new Uint8Array(90000), mime: 'image/avif' },
      encodeThumbnail: async () => built,
      upload: async () => { seen.uploads++; if (uploadThrows) throw new Error('x'); return COVER }
    }
  }
}

// A call that answers post.share and post.cover as given.
function routed (answers) {
  const calls = []
  const call = async (method, params) => {
    calls.push([method, params])
    const a = answers[method]
    if (a instanceof Error) throw a
    return a
  }
  return { calls, call }
}

test('shareNew adds one cover after the share answered on', async (t) => {
  const { shareNew } = await load()
  const c = routed({ 'post.share': { shareSeq: 9, created: true }, 'post.cover': { coverSeq: 10, created: true } })
  const { cover, seen } = coverInput()
  const out = await shareNew(c.call, AUTHOR, 5, cover)
  t.alike(out, { ref: AUTHOR + ':5', result: { state: 'on', shareSeq: 9, message: '' } })
  t.alike(c.calls.map(([m]) => m), ['post.share', 'post.cover'])
  t.alike(c.calls[1][1], { to: AUTHOR + ':5', image: COVER })
  t.is(seen.uploads, 1)
})

test('a cover failure still reports the share as sent, and nothing is retried', async (t) => {
  const { shareNew, webShareAfter, WEB_SHARE_SENT } = await load()
  const cases = [
    ['refused by an older node', { 'post.share': { shareSeq: 9, created: true }, 'post.cover': rpcError('USAGE', 'método desconhecido') }, {}],
    ['lost answer', { 'post.share': { shareSeq: 9, created: true }, 'post.cover': rpcError('USAGE', 'x', true) }, {}],
    ['upload failed', { 'post.share': { shareSeq: 9, created: true } }, { uploadThrows: true }],
    ['nothing built', { 'post.share': { shareSeq: 9, created: true } }, { built: null }]
  ]
  for (const [name, answers, opts] of cases) {
    const c = routed(answers)
    const { cover, seen } = coverInput(opts)
    const out = await shareNew(c.call, AUTHOR, 5, cover)
    t.is(out.result.state, 'on', name)
    t.is(webShareAfter(out).notice, WEB_SHARE_SENT, name + ': the sent words, nothing alarming')
    t.ok(c.calls.filter(([m]) => m === 'post.cover').length <= 1, name + ': at most one post.cover')
    t.ok(seen.uploads <= 1, name + ': at most one upload')
  }
})

test('shareNew sends no cover when the share is not on', async (t) => {
  const { shareNew } = await load()
  for (const share of [rpcError('USAGE', 'limite do diário atingido'), rpcError('USAGE', 'x', true), {}]) {
    const c = routed({ 'post.share': share })
    const { cover, seen } = coverInput()
    await shareNew(c.call, AUTHOR, 5, cover)
    t.alike(c.calls.map(([m]) => m), ['post.share'])
    t.is(seen.uploads, 0)
  }
})

test('the composer cover holds the post like the sheet, so no second cover starts meanwhile', async (t) => {
  const { shareNew } = await load()
  const { claimCover, coverInFlight, releaseCover } = await import('../src/postShare.js')
  const ref = AUTHOR + ':5'
  let during = null
  const c = routed({ 'post.share': { shareSeq: 9, created: true }, 'post.cover': { coverSeq: 10, created: true } })
  const { cover } = coverInput()
  const upload = cover.upload
  cover.upload = async (...a) => { during = coverInFlight(ref); return upload(...a) }
  await shareNew(c.call, AUTHOR, 5, cover)
  t.is(during, true, 'held while the cover is written')
  t.is(coverInFlight(ref), false, 'released after')

  t.ok(claimCover(ref), 'the sheet holds an attempt')
  const held = routed({ 'post.share': { shareSeq: 9, created: true }, 'post.cover': { coverSeq: 10, created: true } })
  const second = coverInput()
  const out = await shareNew(held.call, AUTHOR, 5, second.cover)
  releaseCover(ref)
  t.is(out.result.state, 'on', 'the share still answers')
  t.alike(held.calls.map(([m]) => m), ['post.share'], 'no second post.cover')
  t.is(second.seen.uploads, 0, 'no second upload')
})

test('heldStill picks the held bytes of the first still', async (t) => {
  const { heldStill } = await load()
  const a = new Uint8Array(3)
  const poster = { bytes: new Uint8Array(4), mime: 'image/jpeg' }
  t.alike(heldStill([AVIF, COVER], [{ bytes: a, mime: 'image/avif' }, null]), { bytes: a, mime: 'image/avif' })
  t.alike(heldStill([COVER, { mime: 'video/mp4' }], [poster, null]), poster, 'a video post: its poster')
  t.is(heldStill([AVIF], [{ bytes: a, mime: 'image/webp' }]), null, 'other bytes')
  t.is(heldStill([AVIF], [null]), null)
  t.is(heldStill(null, []), null)
})

// Execute the screen's send closures with local I/O doubles, without JSX.
// One rig can send more than once: the items (and the thumbnail state the
// send patches onto them) persist between taps, like the screen's state.
// ctl.fail: '' | 'encode' | 'upload' | 'all' (definite failures);
// ctl.lost(n): throws an uncertain error with a retry on the n-th signed
// thumbnail upload (the retry resends the same signature, no new one).
function thumbRig (t, { page = false, kind = 'stills', postFails = false, fail = '', expectErrors = false } = {}) {
  const original = { ...AVIF }
  const descriptors = kind === 'text'
    ? null
    : kind === 'video'
      ? [{ ...COVER }, { ...AVIF, mime: 'video/mp4' }]
      : Array.from({ length: 3 }, () => kind === 'gif' ? { ...original, mime: 'image/gif' } : kind === 'small' ? { ...COVER, width: 320, height: 240 } : { ...original })
  const items = (descriptors || []).map((d, id) => ({ id, encoded: { bytes: new Uint8Array(d.bytes), mime: d.mime }, postThumb: null }))
  const built = { bytes: new Uint8Array(40000), mime: 'image/jpeg', width: 640, height: 480 }
  const thumb = { ...COVER, width: built.width, height: built.height }
  const seen = { encodes: [], uploads: 0, signs: 0, resends: 0, originals: 0, calls: [], published: 0, errors: [] }
  const ctl = { fail, lost: () => false }
  const uploadingRef = { current: false }
  let encoded = -1
  // The service's answer for one signed upload.
  const upload = async () => {
    t.ok(uploadingRef.current, 'send stays locked during thumbnail upload')
    seen.uploads++
    seen.signs++
    if (ctl.fail === 'all' || (ctl.fail === 'upload' && seen.uploads === 2)) throw new Error('thumbnail refused')
    if (ctl.lost(seen.signs)) {
      // Only the Page client can resend a signed upload; a person's lost upload has no retry.
      const retry = async () => {
        seen.resends++
        if (ctl.resendFails) throw Object.assign(new Error('refused'), { code: 'pedido-invalido' })
        return { descriptor: thumb }
      }
      throw Object.assign(new Error('lost thumbnail answer'), { uncertain: true, ...(page ? { retry } : {}) })
    }
    return thumb
  }
  const request = async (method, params) => {
    seen.calls.push([method, params])
    if (postFails) throw new Error('post refused')
    return { seq: 1 }
  }
  const uploadOriginals = async (list, target = null) => {
    t.is(target, page ? AUTHOR : null, 'originals use the right owner')
    seen.originals++
    return descriptors
  }
  const patch = (id, fields) => Object.assign(items.find((item) => item.id === id) || {}, fields)
  const src = read('screens/Publicar.js')
  const helpers = src.slice(src.indexOf('  const keptThumbs ='), src.indexOf('  // One photo as the page'))
  const { keptThumbs, keepThumb } = compileFunction(helpers + '\nreturn { keptThumbs, keepThumb }', ['patch'])(patch)
  const scope = {
    ...altScope(),
    buildPostThumbs: null,
    pagePostOp: null,
    keptThumbs,
    keepThumb,
    THUMB_UNSURE_TEXT: 'unsure',
    busy: false,
    uploadingRef,
    queueingRef: { current: false },
    pageRetryRef: { current: null },
    pagePosterRef: { current: null },
    pageCardRef: { current: null },
    cardRef: { current: null },
    mountedRef: { current: true },
    nodeRef: { current: {} },
    nodeRequest: request,
    node: { online: true, request },
    memberKeyOf: async () => AUTHOR,
    actAs: async (node, args) => {
      t.is(args.page, AUTHOR, 'Page signature uses the selected Page')
      return request(args.action, args.op)
    },
    action: { run: async (fn) => { try { return { ok: true, value: await fn() } } catch { return { ok: false, uncertain: false } } } },
    cacheGeneration: () => 0,
    text: 'foto',
    reply: null,
    quote: null,
    pollDraft: null,
    eventDraft: null,
    musicDraft: null,
    asPage: null,
    webOn: false,
    hasVideo: kind === 'video',
    hasMedia: descriptors !== null,
    mediaReady: true,
    mediaOnline: true,
    canVideo: true,
    offlineQueue: false,
    canQueue: false,
    items,
    media: { upload },
    uploadAll: uploadOriginals,
    uploadBytesForPage: async (target, image) => {
      t.is(target, AUTHOR, 'thumbnail uploaded for the selected Page')
      return { descriptor: await upload(image) }
    },
    video: { draft: { state: { phase: 'ready', file: { poster: items[0]?.encoded } }, upload: uploadOriginals } },
    pageVideoMedia: async () => { seen.originals++; return descriptors },
    encodeThumbnail: async (bytes) => {
      t.ok(uploadingRef.current, 'send stays locked during thumbnail encoding')
      t.ok(seen.originals >= 1, 'originals uploaded before thumbnails')
      const at = items.findIndex((item) => item.encoded.bytes === bytes)
      t.ok(at > encoded, 'uses held bytes in order')
      encoded = at
      seen.encodes.push(bytes)
      if (ctl.fail === 'encode' && seen.encodes.length === 2) throw new Error('decode failed')
      return built
    },
    refusalOf: () => '',
    previewRefusal: () => '',
    linkDraft: { take: () => null },
    musicSnapshot: () => null,
    withCardFallback: (fn, card) => ({ op: fn(card), card }),
    setCheckError: (error) => {
      if (!error) return
      if (expectErrors) seen.errors.push(error)
      else t.fail(error)
    },
    setUploading: () => {},
    confirm: () => {},
    seqOf: (value) => value.seq,
    published: () => { seen.published++ }
  }
  const name = page ? 'sendNewAsPage' : 'send'
  return {
    seen,
    ctl,
    items,
    thumb,
    async send () {
      const { buildPostThumbs } = await import('../src/postThumbs.js')
      const { pagePostOp } = await import('../src/pagePost.js')
      scope.buildPostThumbs = buildPostThumbs
      scope.pagePostOp = pagePostOp
      encoded = -1
      const before = seen.calls.length
      const body = publicarBody(src.slice(src.indexOf('  const sendNewAsPage =')), '  const ' + name + ' = async (')
      const run = compileFunction(body + '\n  }\nreturn ' + name, Object.keys(scope))(...Object.values(scope))
      if (page) await run(AUTHOR, 'foto', null, null, null)
      else await run()
      t.is(uploadingRef.current, false, 'upload lock released')
      return seen.calls.length > before ? seen.calls[seen.calls.length - 1][1] : null
    }
  }
}

async function sendWithThumbs (t, opts = {}) {
  const rig = thumbRig(t, opts)
  const params = await rig.send()
  t.is(rig.seen.calls.length, 1, 'post sent once')
  t.is(rig.seen.published, opts.postFails ? 0 : 1, 'publication outcome preserved')
  return { seen: rig.seen, params, thumb: rig.thumb }
}

test('Publicar sends aligned thumbnails for personal and Page posts without retries', async (t) => {
  for (const page of [false, true]) {
    for (const fail of ['', 'encode', 'upload', 'all']) {
      const { params, seen, thumb } = await sendWithThumbs(t, { page, fail })
      if (fail === 'all') t.absent(Object.hasOwn(params, 'thumbs'), 'all failed: omit thumbs')
      else t.alike(params.thumbs, [thumb, fail ? null : thumb, thumb], 'three slots, failed thumbnail stays null')
      t.is(seen.encodes.length, 3, 'one encode per still')
      t.is(seen.uploads, fail === 'encode' ? 2 : 3, 'no repeated thumbnail upload')
      t.is(seen.originals, 1, 'no repeated original batch')
      t.is(seen.resends, 0, 'a definite failure is never resent')
    }
    await sendWithThumbs(t, { page, postFails: true })
  }
})

test('Publicar omits thumbs for text, GIFs, small stills and videos', async (t) => {
  for (const page of [false, true]) {
    for (const kind of ['text', 'gif', 'small', 'video']) {
      const { params, seen } = await sendWithThumbs(t, { page, kind })
      t.absent(Object.hasOwn(params, 'thumbs'), kind + ': same post keys')
      t.is(seen.encodes.length, 0, 'no thumbnail encode')
      t.is(seen.uploads, 0, 'no thumbnail upload')
    }
  }
})

test('Publicar stops on an uncertain thumbnail and the next tap resends the same signature', async (t) => {
  for (const page of [false, true]) {
    const rig = thumbRig(t, { page, expectErrors: true })
    // The second thumbnail's answer is lost.
    rig.ctl.lost = (n) => n === 2
    t.is(await rig.send(), null, 'no post while a thumbnail is uncertain')
    t.is(rig.seen.calls.length, 0)
    t.is(rig.seen.published, 0)
    t.alike(rig.seen.errors, ['unsure'], 'the person is told')
    t.is(rig.seen.encodes.length, 2, 'the third photo waits behind the uncertain one')
    t.is(rig.seen.signs, 2)
    t.alike(rig.items.map((item) => item.postThumb && Object.keys(item.postThumb).sort()), [['image', 'owner'], page ? ['expect', 'owner', 'retry'] : null, null], 'the done one and the retry (a Page has one) are kept on their items')
    t.is(rig.items[0].postThumb.image, rig.thumb)
    t.is(rig.items[2].postThumb, null)

    const params = await rig.send()
    t.alike(params.thumbs, [rig.thumb, rig.thumb, rig.thumb], 'all three thumbnails on the post')
    t.is(rig.seen.resends, page ? 1 : 0, 'a Page resends the kept signed upload once')
    t.is(rig.seen.signs, page ? 3 : 4, 'a Page signs only the photo never sent; a person has no retry to reuse')
    t.is(rig.seen.encodes.length, page ? 3 : 4, 'the first photo is never encoded again')
    t.is(rig.seen.uploads, rig.seen.signs, 'the first thumbnail is not uploaded again')
    t.is(rig.seen.originals, 2, 'originals go through uploadAll, which keeps the done ones')
    t.is(rig.seen.calls.length, 1)
    t.is(rig.seen.published, 1)
  }
})

test('Publicar keeps thumbnails already uploaded when a later send fails for good', async (t) => {
  const rig = thumbRig(t, { page: true, expectErrors: true })
  rig.ctl.lost = (n) => n === 1
  t.is(await rig.send(), null)
  t.ok(typeof rig.items[0].postThumb.retry === 'function')
  // The resend is refused for good: that thumbnail alone becomes null and the post goes out.
  rig.ctl.resendFails = true
  const params = await rig.send()
  t.alike(params.thumbs, [null, rig.thumb, rig.thumb])
  t.is(rig.seen.resends, 1)
  t.is(rig.items[0].postThumb, null, 'a refused retry is dropped')
  t.is(rig.seen.published, 1)
})

test('Publicar drops the kept thumbnail state of a photo that was encoded again or belongs to another owner', (t) => {
  const src = read('screens/Publicar.js')
  t.ok(src.includes("cropBase: cropped && whole === null ? 'encoded' : 'full', postThumb: null }"), 'readyItem and the reframe reset it through framedFields')
  const helpers = src.slice(src.indexOf('  const keptThumbs ='), src.indexOf('  // One photo as the page'))
  const { keptThumbs } = compileFunction(helpers + '\nreturn { keptThumbs, keepThumb }', ['patch'])(() => {})
  const entry = { image: {}, owner: AUTHOR }
  t.alike(keptThumbs([{ postThumb: entry }, { postThumb: null }, {}], AUTHOR), [entry, null, null])
  t.alike(keptThumbs([{ postThumb: entry }], null), [null], 'a Page thumbnail never goes on a personal post')
  t.alike(keptThumbs([{ postThumb: { image: {}, owner: null } }], AUTHOR), [null], 'nor a personal one on a Page post')
})
