'use strict'

// A page's uncertain photo, GIF or voice send must re-put the signed draft.
// Drafting again would deliver a second message when the first already landed.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
const PAGE = '9'.repeat(64)
const PEER = '3'.repeat(64)
const DIGEST = 'cd'.repeat(32)
const SIG = 'ef'.repeat(64)
const EXPIRES = 1800000000000

test('Mensagem keeps a page media retry and measures page sends as v3', (t) => {
  const retry = src.slice(src.indexOf('const retryMedia = async () => {'), src.indexOf('const cancelMedia = () => {'))
  const pageBranch = retry.slice(retry.indexOf('if (pageKey !== null)'), retry.indexOf('retryChatSend('))
  t.ok(pageBranch.length > 0)
  t.ok(pageBranch.includes('runPageMediaRetry(held, unsureSend)'), 'a page calls the kept re-put')
  t.ok(pageBranch.includes('return'))
  t.absent(pageBranch.includes("dm('dm.send'"))
  t.ok(retry.includes('retryChatSend({ op: held.op, request: dm, onPhase: setMediaSend, uncertain: unsureSend })'), 'a person resends the same op')
  t.ok(src.includes('setMediaHold(mediaUncertainHold({ op: r.op, error: r.error, text, quoteId, typed, ctx, page: pageKey !== null }))'))
  t.ok(src.includes("typeof mediaHold.retry === 'function' || pageKey === null"))
  t.is(src.split('dmTarget(').length - 1, 4, 'card, photo, voice and offer all measure the page target')
  t.ok(src.includes('...(pageKey !== null ? { v: 3 } : {})'))
  t.ok(src.includes('if (forwardSource !== null && pageKey !== null) forwardSource.page = true'))
  t.ok(src.includes('onPress: () => setForwarding({ source: forwardSource, refs })'))
  t.absent(src.includes('\u2014'))
  t.absent(readFileSync(__filename, 'utf8').includes('\u2014'))
})

test('an uncertain page photo keeps the signed retry and a tap re-puts it', async (t) => {
  const { mediaUncertainHold, runPageMediaRetry, pageDmClient, PAGE_DM_UNSURE } = await import('../src/dm-screen.js')
  const calls = []
  let left = 1
  const node = async (method, params) => {
    calls.push([method, params])
    if (method === 'dm.pageDraft') return { id: 'ab'.repeat(16), digest: DIGEST, at: 1 }
    if (method === 'dm.pageSend') {
      if (left-- > 0) throw Object.assign(new Error(PAGE_DM_UNSURE), { uncertain: true })
      return { id: params.id, at: 2 }
    }
    throw new Error(method)
  }
  let signs = 0
  const dm = pageDmClient({
    request: node,
    sign: async () => { signs++; return { signature: SIG, expiresAt: EXPIRES } },
    page: PAGE
  })
  const media = [{ id: '1'.repeat(64) }]
  let error = null
  try {
    await dm('dm.send', { to: PEER, text: 'foto', media })
  } catch (err) {
    error = err
  }
  t.ok(error && error.uncertain === true)
  t.is(typeof error.retry, 'function')
  const op = { method: 'dm.send', params: { to: PEER, text: 'foto', media } }
  const hold = mediaUncertainHold({ op, error, text: 'foto', quoteId: null, typed: 'foto', ctx: null, page: true })
  t.is(hold.retry, error.retry)
  t.alike(hold, { op, text: 'foto', quoteId: null, typed: 'foto', ctx: null, retry: error.retry })
  t.is(mediaUncertainHold({ op, error, text: 'foto', quoteId: null, typed: 'foto', page: false }).retry, null, 'a person does not keep it')
  t.is(mediaUncertainHold({ op, error: new Error('recusado'), text: 'foto', quoteId: null, typed: 'foto', page: true }).retry, null)
  const again = await runPageMediaRetry(hold, (err) => !!(err && err.uncertain === true))
  t.is(again.phase, 'done')
  t.is(again.op, op)
  t.alike(calls.map((c) => c[0]), ['dm.pageDraft', 'dm.pageSend', 'dm.pageSend'])
  t.alike(calls[2][1], calls[1][1], 'the same signed draft')
  t.is(signs, 1, 'signed once')
  t.is(calls.filter((c) => c[0] === 'dm.pageDraft').length, 1, 'no second draft')
})

test('a still-uncertain page retry keeps the re-put, and a real refusal does not draft', async (t) => {
  const { mediaUncertainHold, runPageMediaRetry } = await import('../src/dm-screen.js')
  const retry = async () => {
    throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true, retry })
  }
  const unsure = await runPageMediaRetry({ op: { method: 'dm.send' }, retry }, (err) => err.uncertain === true)
  t.is(unsure.phase, 'uncertain')
  const next = mediaUncertainHold({ op: unsure.op, error: unsure.error, text: '', quoteId: null, typed: '', page: true })
  t.is(next.retry, retry, 'Tentar de novo calls the same re-put')
  const refused = await runPageMediaRetry({
    op: { method: 'dm.send' },
    retry: async () => { throw new Error('rascunho expirado') }
  }, (err) => err.uncertain === true)
  t.is(refused.phase, 'failed')
  t.is(refused.error.message, 'rascunho expirado')
  const missing = await runPageMediaRetry({ op: { method: 'dm.send' } }, () => true)
  t.is(missing.phase, 'failed')
  t.is(missing.error.message, 'nada para reenviar')
})

test('an expired page media retry settles unknown: attachments cleared, no new draft', async (t) => {
  const done = src.slice(src.indexOf('const mediaDone = ('), src.indexOf('const sendMedia = async'))
  const settled = done.slice(done.indexOf("if (r.phase === 'done' || r.phase === 'maybe') {"), done.indexOf("} else if (r.phase === 'uncertain') {"))
  t.ok(settled.length > 0, 'maybe takes the settled branch')
  t.ok(settled.includes('attachments.clear()'), 'the staged photos are dropped')
  t.ok(settled.includes('setMediaHold(null)'))
  t.ok(settled.includes("if (r.phase === 'maybe') setMediaNote(MEDIA_MAYBE)"), 'a neutral note says it may have been sent')
  t.ok(done.includes("r.phase === 'maybe' || r.phase === 'uncertain'"), 'the conversation is reread')
  t.ok(src.includes("const PAGE_DRAFT_GONE = 'rascunho expirado'"))
  t.ok(src.includes("const MEDIA_MAYBE = 'A mensagem pode ter sido enviada. Confira na conversa.'"))
  const retry = src.slice(src.indexOf('const retryMedia = async () => {'), src.indexOf('const cancelMedia = () => {'))
  t.ok(retry.includes("const gone = r.phase === 'failed' && r.error && r.error.message === PAGE_DRAFT_GONE"))
  t.ok(retry.includes("mediaDone(gone ? { ...r, phase: 'maybe' } : r, held.text, held.quoteId, held.typed, held.ctx)"))
  t.absent(retry.includes('sendMedia('), 'the retry never drafts again')
  t.ok(src.includes("{mediaNote !== '' && mediaHold === null ? <Soft>{mediaNote}</Soft> : null}"))

  const { mediaUncertainHold, runPageMediaRetry, pageDmClient, PAGE_DM_UNSURE } = await import('../src/dm-screen.js')
  const calls = []
  let sends = 0
  const node = async (method, params) => {
    calls.push(method)
    if (method === 'dm.pageDraft') return { id: 'ab'.repeat(16), digest: DIGEST, at: 1 }
    if (method === 'dm.pageSend') {
      if (sends++ === 0) throw Object.assign(new Error(PAGE_DM_UNSURE), { uncertain: true })
      throw new Error('rascunho expirado')
    }
    throw new Error(method)
  }
  const dm = pageDmClient({ request: node, sign: async () => ({ signature: SIG, expiresAt: EXPIRES }), page: PAGE })
  const media = [{ id: '1'.repeat(64) }]
  let error = null
  try {
    await dm('dm.send', { to: PEER, text: 'foto', media })
  } catch (err) {
    error = err
  }
  const op = { method: 'dm.send', params: { to: PEER, text: 'foto', media } }
  const hold = mediaUncertainHold({ op, error, text: 'foto', quoteId: null, typed: 'foto', ctx: null, page: true })
  const r = await runPageMediaRetry(hold, (err) => !!(err && err.uncertain === true))
  t.is(r.phase, 'failed')
  t.is(r.error.message, 'rascunho expirado', 'the screen maps this answer to maybe')
  t.alike(calls, ['dm.pageDraft', 'dm.pageSend', 'dm.pageSend'], 'no second dm.pageDraft')
})

test('the may-have-been-sent note is reset with the identity and by any new send', (t) => {
  const reset = src.slice(src.indexOf('const seenPage = useRef(pageKey)'), src.indexOf('}, [pageKey])', src.indexOf('const seenPage = useRef(pageKey)')))
  t.ok(reset.includes("setMediaNote('')"), 'another identity does not see the note')
  t.ok(reset.includes("setMediaError('')"))
  const send = src.slice(src.indexOf('const send = async ('), src.indexOf('lastErr.current = null', src.indexOf('const send = async (')))
  t.ok(send.includes("setMediaNote('')"), 'a text send clears it')
  const offer = src.slice(src.indexOf('const offerSend = async (build) => {'), src.indexOf('let lastOffer = null'))
  t.ok(offer.includes("setMediaNote('')"), 'an offer step clears it')
})

test('an expired page text or offer retry settles unknown and is never signed again', (t) => {
  t.ok(src.includes('const draftGone = (err) => !!(err && err.message === PAGE_DRAFT_GONE)'))
  const held = src.slice(src.indexOf('const retryHeld = async () => {'), src.indexOf('const mediaApi = '))
  const gone = held.slice(held.indexOf('} else if (draftGone(err)) {'), held.indexOf('reread()'))
  t.ok(gone.length > 0, 'retryHeld handles the expired draft')
  t.ok(gone.includes('setHold(null)'), 'the hold is cleared, so no dead Tentar de novo')
  t.ok(gone.includes('post.clearError()'), 'the raw node error is not shown')
  t.ok(gone.includes('setMediaNote(MEDIA_MAYBE)'))
  t.ok(gone.includes('setDraft(\'\')'), 'the held text leaves the composer')
  t.absent(gone.includes('send('), 'nothing is sent again')
  t.ok(held.indexOf('reread()') > held.indexOf('draftGone(err)'), 'the conversation is reread after it')
  const offer = src.slice(src.indexOf('const offerSend = async (build) => {'), src.indexOf('const offerOp = '))
  const og = offer.slice(offer.indexOf("} else if (sent !== null && typeof sent.retry === 'function' && draftGone(lastOffer)) {"), offer.indexOf('} else if (lastOffer && lastOffer.message === BLOCKED_SEND)'))
  t.ok(og.length > 0, 'a page offer re-put handles the expired draft')
  t.ok(og.includes('setOfferHold(null)'))
  t.ok(og.includes('offerAct.clearError()'))
  t.ok(og.includes('setMediaNote(MEDIA_MAYBE)'))
  t.absent(og.includes('dm('), 'nothing is sent again')
  t.ok(offer.indexOf('reread()') > offer.indexOf('draftGone(lastOffer)'))
})

test('every DM upload in Mensagem goes through putDm, which names the page when acting as one', (t) => {
  t.ok(src.includes('const putDm = (args) => mediaApi.putDm({ ...args, to: peer, ...(pageKey !== null ? { page: pageKey } : {}) })'))
  t.is(src.split('mediaApi.putDm(').length - 1, 1, 'no upload bypasses it')
  t.is(src.split('putDm({ bytes:').length - 1, 3, 'card thumbnail, photo and voice note')
})
