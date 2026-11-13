'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { register } = require('node:module')

// encode.native.js with expo-file-system, expo-image-manipulator and
// ./display replaced by stubs (a module hook) that record what decodes.
const thumbBox = globalThis.__thumb = { log: [] }
const thumbStubs = {
  'expo-file-system': 'export class File { constructor (uri) { this.uri = uri } get exists () { return false } async bytes () { return new Uint8Array(10) } delete () {} }',
  'expo-image-manipulator': 'export const SaveFormat = { JPEG: "jpeg" }\nexport async function manipulateAsync (uri, actions) { globalThis.__thumb.log.push(actions); const r = actions[0] && actions[0].resize; return { uri: "file:///t.jpg", width: r ? r.width : 9999, height: r ? r.height : 9999 } }',
  display: 'export function urlFromBytes () { return "blob:x" }\nexport function revokeUrl () {}',
  'expo/fetch': 'export async function fetch () { throw new Error("no network in tests") }'
}
const thumbHooks = `
const stubs = ${JSON.stringify(Object.fromEntries(Object.entries(thumbStubs).map(([k, v]) => [k, 'data:text/javascript,' + encodeURIComponent(v)])))}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  if (specifier === './display' && String(context.parentURL).endsWith('/encode.native.js')) return { url: stubs.display, shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(thumbHooks))

const card = () => import('../src/linkCard.js')
const native = () => import('../src/previewBuild.native.js')
const web = () => import('../src/previewBuild.web.js')
const SRC = path.join(__dirname, '../src')

const URL1 = 'https://example.com/a'
const URL2 = 'https://example.org/b'
const MEMBER = 'a'.repeat(64)
const HTML = '<html><head><title>Fallback</title><meta property="og:title" content="Título &amp; mais"><meta name="description" content="Descrição"><meta property="og:image" content="/img.png"></head></html>'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3])
const enc = (s) => new TextEncoder().encode(s)

function data (url = URL1, thumb = null) {
  return { url, host: new URL(url).hostname, title: 'Título', desc: 'Descrição', thumb }
}

// A streamed answer (one chunk), as expo/fetch gives natively.
function response (status, type, bytes, url, extra = {}) {
  let sent = false
  return {
    status,
    url,
    headers: { get: (k) => (k === 'content-type' ? type : k === 'content-length' ? String(bytes.byteLength) : null) },
    body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: bytes } }, cancel: async () => {} }) },
    ...extra
  }
}

test('draft state machine: build once per URL, ready, dismissed, failed', async (t) => {
  const { linkDraftIdle, linkDraftStep, needsBuild, draftView } = await card()
  let s = linkDraftIdle()
  t.is(s.phase, 'idle')
  s = linkDraftStep(s, { type: 'target', url: URL1 })
  t.is(s.phase, 'building')
  t.ok(needsBuild(s))
  s = linkDraftStep(s, { type: 'built', url: URL1, data: data() })
  t.is(s.phase, 'ready')
  t.alike(draftView(s), { url: URL1, host: 'example.com', title: 'Título', desc: 'Descrição' })
  s = linkDraftStep(s, { type: 'target', url: URL2 })
  t.is(s.phase, 'building')
  s = linkDraftStep(s, { type: 'failed', url: URL2 })
  t.is(s.phase, 'failed')
  t.is(draftView(s), null)
  // Back to the first URL: the kept result, no new build.
  s = linkDraftStep(s, { type: 'target', url: URL1 })
  t.is(s.phase, 'ready')
  t.absent(needsBuild(s))
  // The failed URL is not built again either.
  s = linkDraftStep(s, { type: 'target', url: URL2 })
  t.is(s.phase, 'failed')
  t.absent(needsBuild(s))
  s = linkDraftStep(s, { type: 'target', url: URL1 })
  s = linkDraftStep(s, { type: 'dismiss' })
  t.is(s.phase, 'dismissed')
  s = linkDraftStep(s, { type: 'target', url: null })
  t.is(s.phase, 'idle')
  s = linkDraftStep(s, { type: 'target', url: URL1 })
  t.is(s.phase, 'dismissed', 'a dismissed URL stays dismissed in this draft')
  t.is(linkDraftStep(s, { type: 'reset' }).phase, 'idle')
  t.is(linkDraftStep(s, { type: 'nonsense' }), s)
})

test('a late result for another URL is kept but not shown; invalid data fails', async (t) => {
  const { linkDraftIdle, linkDraftStep } = await card()
  let s = linkDraftStep(linkDraftIdle(), { type: 'target', url: URL2 })
  s = linkDraftStep(s, { type: 'built', url: URL1, data: data() })
  t.is(s.phase, 'building')
  t.is(s.url, URL2)
  s = linkDraftStep(s, { type: 'built', url: URL2, data: { ...data(URL2), host: 'evil.example' } })
  t.is(s.phase, 'failed', 'a host that is not the URL host is refused')
  s = linkDraftStep(s, { type: 'target', url: URL1 })
  t.is(s.phase, 'ready')
})

test('a photo drops the card', async (t) => {
  const { linkDraftIdle, linkDraftStep, photoDropsCard, freezeSnapshot } = await card()
  let s = linkDraftStep(linkDraftIdle(), { type: 'target', url: URL1 })
  s = linkDraftStep(s, { type: 'built', url: URL1, data: data() })
  t.is(photoDropsCard(s, false), s)
  s = photoDropsCard(s, true)
  t.is(s.phase, 'dismissed')
  t.is(freezeSnapshot(s, 'veja ' + URL1), null)
})

test('snapshot freeze: only the ready card for the link the text holds', async (t) => {
  const { linkDraftIdle, linkDraftStep, freezeSnapshot } = await card()
  const thumb = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', width: 10, height: 8 }
  let s = linkDraftStep(linkDraftIdle(), { type: 'target', url: URL1 })
  t.is(freezeSnapshot(s, URL1), null, 'nothing while building')
  s = linkDraftStep(s, { type: 'built', url: URL1, data: data(URL1, thumb) })
  const snap = freezeSnapshot(s, 'olha ' + URL1)
  t.ok(Object.isFrozen(snap))
  t.is(snap.thumb.width, 10)
  t.is(freezeSnapshot(s, 'olha ' + URL2), null, 'another link in the text')
  t.is(freezeSnapshot(s, 'sem link'), null)
})

test('buildDraft: thumbnail re-encoded, over-size dropped, card kept', async (t) => {
  const { buildDraft, CARD_THUMB_MAX_BYTES } = await card()
  const preview = async () => ({ url: URL1, host: 'example.com', title: 'T', desc: '', imageBytes: PNG, imageMime: 'image/png' })
  const small = await buildDraft(URL1, { buildPreview: preview, encodeThumbnail: async (b, m, o) => ({ bytes: new Uint8Array(o.maxBytes), mime: 'image/jpeg', width: 320, height: 200 }) })
  t.is(small.thumb.bytes.byteLength, CARD_THUMB_MAX_BYTES)
  t.ok(CARD_THUMB_MAX_BYTES <= 32768)
  const big = await buildDraft(URL1, { buildPreview: preview, encodeThumbnail: async () => ({ bytes: new Uint8Array(32769), mime: 'image/jpeg', width: 320, height: 200 }) })
  t.is(big.thumb, null, 'over 32768 bytes: the image is dropped')
  t.is(big.title, 'T')
  const wide = await buildDraft(URL1, { buildPreview: preview, encodeThumbnail: async () => ({ bytes: new Uint8Array(10), mime: 'image/jpeg', width: 640, height: 200 }) })
  t.is(wide.thumb, null, 'over 320 px: dropped')
  const never = await buildDraft(URL1, { buildPreview: preview, encodeThumbnail: async () => null })
  t.is(never.thumb, null)
  const thrown = await buildDraft(URL1, { buildPreview: preview, encodeThumbnail: async () => { throw new Error('x') } })
  t.is(thrown.thumb, null)
  t.is(await buildDraft(URL1, { buildPreview: async () => null }), null)
  t.is(await buildDraft(URL1, { buildPreview: async () => { throw new Error('x') } }), null)
  t.is(await buildDraft('http://example.com', { buildPreview: preview }), null)
  const ctl = new AbortController()
  ctl.abort()
  t.is(await buildDraft(URL1, { buildPreview: preview, signal: ctl.signal }), null)
})

test('cardForSend: upload once, failure keeps the card without image, budget first', async (t) => {
  const { cardForSend, withCardFallback } = await card()
  const thumb = { bytes: new Uint8Array(5), mime: 'image/jpeg', width: 10, height: 10 }
  const snap = { ...data(URL1), thumb }
  let uploads = 0
  const desc = { id: 'x' }
  const c = await cardForSend(snap, { upload: async () => { uploads++; return desc } })
  t.is(uploads, 1)
  t.alike(c.image, desc)
  t.ok(Object.isFrozen(c))
  const failed = await cardForSend(snap, { upload: async () => { throw new Error('x') } })
  t.is(failed.image, null)
  t.is(await cardForSend(snap, { upload: async () => { uploads++ }, fits: () => false }), null)
  t.is(uploads, 1, 'nothing uploaded for a text that cannot carry a card')
  const bare = await cardForSend(snap, { upload: async () => { uploads++ }, fits: (x) => x.image === null })
  t.is(bare.image, null)
  t.is(uploads, 1)
  const r = withCardFallback((x) => { if (x && x.image) throw new Error('no'); return x ? 'card' : 'plain' }, c)
  t.is(r.op, 'card')
  t.is(r.card.image, null)
  t.is(withCardFallback((x) => { if (x) throw new Error('no'); return 'plain' }, c).op, 'plain')
})

test('native buildPreview: the image only from the page host or a subdomain of it', async (t) => {
  const { buildPreview, sameSiteImage } = await native()
  t.ok(sameSiteImage('example.com', 'https://example.com/i.png'))
  t.ok(sameSiteImage('example.com', 'https://img.example.com/i.png'))
  t.absent(sameSiteImage('example.com', 'https://intranet.corp.example/i.png'), 'another host')
  t.absent(sameSiteImage('example.com', 'https://evilexample.com/i.png'), 'a suffix that is not a subdomain')
  t.absent(sameSiteImage('example.com', 'http://example.com/i.png'), 'not https')
  const asked = []
  const page = '<html><head><title>T</title><meta property="og:image" content="https://intranet.corp.example/chart.png"></head></html>'
  const fetch = async (url) => {
    asked.push(url)
    if (url === URL1) return response(200, 'text/html', enc(page), URL1)
    throw new Error('the image host must never be asked')
  }
  const p = await buildPreview(URL1, { fetch })
  t.is(p.title, 'T')
  t.is(p.imageBytes, null, 'no thumbnail')
  t.alike(asked, [URL1], 'only the page was fetched')
})

test('native buildPreview: https, html, capped, image sniffed', async (t) => {
  const { buildPreview } = await native()
  const asked = []
  const fetch = async (url, init) => {
    asked.push({ url, init })
    if (url === URL1) return response(200, 'text/html; charset=utf-8', enc(HTML), URL1)
    if (url === 'https://example.com/img.png') return response(200, 'image/png', PNG, url)
    throw new Error('unexpected')
  }
  const p = await buildPreview(URL1, { fetch })
  t.is(p.title, 'Título & mais')
  t.is(p.desc, 'Descrição')
  t.is(p.host, 'example.com')
  t.is(p.imageMime, 'image/png')
  t.ok(p.imageBytes instanceof Uint8Array)
  t.is(asked[0].init.credentials, 'omit')
  t.is(asked[0].init.redirect, 'manual', 'never follows a redirect')
  t.alike(Object.keys(p).sort(), ['desc', 'host', 'imageBytes', 'imageMime', 'title', 'url'])

  t.is(await buildPreview('http://example.com/', { fetch }), null, 'http refused')
  t.is(await buildPreview('https://127.0.0.1/', { fetch }), null, 'IP literal refused')
  t.is(await buildPreview(URL1, { fetch: async () => response(200, 'application/json', enc(HTML), URL1) }), null, 'not html')
  t.is(await buildPreview(URL1, { fetch: async () => response(200, 'text/html', new Uint8Array(512 * 1024 + 1), URL1) }), null, 'over 512 KiB')
  t.is(await buildPreview(URL1, { fetch: async () => response(200, 'text/html', enc(HTML), 'http://example.com/') }), null, 'redirect to http')
  t.is(await buildPreview(URL1, { fetch: async () => response(404, 'text/html', enc(HTML), URL1) }), null)
  const noImage = await buildPreview(URL1, { fetch: async (url) => url === URL1 ? response(200, 'text/html', enc(HTML), URL1) : response(200, 'image/png', enc('not an image at all'), url) })
  t.is(noImage.imageBytes, null, 'bytes that are not an image are dropped')
  t.is(noImage.title, 'Título & mais')
  const bigImage = await buildPreview(URL1, { fetch: async (url) => url === URL1 ? response(200, 'text/html', enc(HTML), URL1) : response(200, 'image/png', new Uint8Array(256 * 1024 + 1), url) })
  t.is(bigImage.imageBytes, null, 'image over 256 KiB dropped')
})

test('web buildPreview: through the account preview client only', async (t) => {
  const { buildPreview } = await web()
  const calls = []
  const account = {
    previewPolicy: async () => true,
    previewFetch: async (url, opts) => {
      calls.push({ url, opts })
      return { url, host: 'example.com', title: 'T', desc: 'D', imageBytes: PNG, imageMime: 'image/png' }
    }
  }
  const request = async () => ({})
  const p = await buildPreview(URL1, { member: MEMBER, request, origin: undefined, account })
  t.alike(Object.keys(p).sort(), ['desc', 'host', 'imageBytes', 'imageMime', 'title', 'url'])
  t.is(calls.length, 1)
  t.is(calls[0].opts.member, MEMBER)
  t.is(await buildPreview(URL1, { member: MEMBER, request, origin: null, account }), null, 'no account service')
  t.is(await buildPreview(URL1, { member: MEMBER, request, account: { ...account, previewPolicy: async () => false } }), null, 'policy off')
  t.is(await buildPreview(URL1, { member: MEMBER, request, account: { ...account, previewFetch: async () => { throw new Error('limite-previa') } } }), null, '429 is a plain text send')
  t.is(await buildPreview(URL1, { request, account }), null, 'no member')
  t.is(calls.length, 1)
})

test('shared code reaches previews only through ./previewBuild, and only with the preference on', (t) => {
  const composer = fs.readFileSync(path.join(SRC, 'ui/ChatComposer.js'), 'utf8')
  t.ok(composer.includes("from '../previewBuild'"), 'the platform module is chosen by the bundler')
  t.ok(composer.includes('previewsEnabled(previewPrefStore())'), 'Prévia de links off: nothing is built')
  t.ok(/const target = on \? previewTarget/.test(composer), 'no target, so no build, while off')
  for (const f of ['linkCard.js', 'ui/ChatComposer.js', 'screens/Publicar.js', 'screens/Mensagem.js', 'screens/Grupo.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8')
    t.absent(/previewBuild\.(web|native)/.test(src), f + ' never names a platform module')
    t.absent(src.includes('localStorage'), f + ' has no browser storage')
  }
})

// A real 1x1 PNG, then the same header declaring 16000 x 16000 pixels.
const PNG_1X1 = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
function pngBomb () {
  const b = Buffer.from(PNG_1X1)
  b.writeUInt32BE(16000, 16)
  b.writeUInt32BE(16000, 20)
  return new Uint8Array(b)
}

test('encodeThumbnail: a header past the photo bounds is dropped before any decode (web and native)', async (t) => {
  const encWeb = await import('../src/media/encode.web.js')
  let decodes = 0
  const realBitmap = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => { decodes++; throw new Error('no decoder here') }
  t.teardown(() => { globalThis.createImageBitmap = realBitmap })
  t.is(await encWeb.encodeThumbnail(pngBomb(), 'image/png'), null, 'web: huge header')
  t.is(await encWeb.encodeThumbnail(PNG_1X1, 'image/jpeg'), null, 'web: bytes that are not the declared type')
  t.is(decodes, 0, 'web: never decoded')
  t.is(await encWeb.encodeThumbnail(PNG_1X1, 'image/png'), null, 'web: a bounded header reaches the decoder (which fails here)')
  t.ok(decodes > 0, 'web: decoded')

  const encNative = await import('../src/media/encode.native.js')
  thumbBox.log = []
  t.is(await encNative.encodeThumbnail(pngBomb(), 'image/png'), null, 'native: huge header')
  t.alike(thumbBox.log, [], 'native: never decoded')
  t.alike(await encNative.encodeThumbnail(PNG_1X1, 'image/png'), { bytes: new Uint8Array(10), mime: 'image/jpeg', width: 1, height: 1 }, 'native: a bounded header is encoded')
  t.alike(thumbBox.log, [[{ resize: { width: 1, height: 1 } }]], 'native: one resize from the header size, no full-size probe')
})

test('native buildPreview: the body is read as a stream and cancelled past the cap', async (t) => {
  const { buildPreview } = await native()
  let reads = 0
  let cancelled = false
  let aborted = false
  const endless = (url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true })
    return {
      status: 200,
      url,
      headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
      body: {
        getReader: () => ({
          read: async () => { reads++; return { done: false, value: new Uint8Array(64 * 1024) } },
          cancel: async () => { cancelled = true }
        })
      },
      arrayBuffer: async () => { throw new Error('never buffered whole') }
    }
  }
  t.is(await buildPreview(URL1, { fetch: async (url, init) => endless(url, init) }), null, 'an endless page')
  t.is(reads, 9, 'stops at the first chunk past 512 KiB')
  t.ok(cancelled, 'the reader is cancelled')
  t.ok(aborted, 'the request is aborted')

  const chunks = [enc(HTML.slice(0, 40)), enc(HTML.slice(40))]
  const streamed = await buildPreview(URL1, {
    fetch: async (url) => url !== URL1
      ? null
      : {
          status: 200,
          url,
          headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
          body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }, cancel: async () => {} }) }
        }
  })
  t.is(streamed.title, 'Título & mais', 'a page in chunks is joined')

  let buffered = 0
  const noStream = { status: 200, url: URL1, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) }, arrayBuffer: async () => { buffered++; return enc(HTML).buffer } }
  t.is(await buildPreview(URL1, { fetch: async () => noStream }), null, 'a transport without a stream gives no preview')
  t.is(buffered, 0, 'never buffered whole')
  t.is(await buildPreview(URL1, { fetch: async () => response(200, 'text/html', enc(HTML), URL1, { headers: { get: (k) => (k === 'content-type' ? 'text/html' : String(512 * 1024 + 1)) }, body: { getReader: () => { throw new Error('read past a declared length') } } }) }), null, 'a declared length over the cap is refused before reading')
})

test('native buildPreview: a redirected page gives no card and a redirected image no thumbnail', async (t) => {
  const { buildPreview } = await native()
  const page = (extra) => async (url) => url === URL1 ? response(200, 'text/html', enc(HTML), URL1, extra) : response(200, 'image/png', PNG, url)
  t.is(await buildPreview(URL1, { fetch: page({ url: 'https://intranet.example.net/x' }) }), null, 'another landing URL')
  t.is(await buildPreview(URL1, { fetch: page({ redirected: true }) }), null, 'the transport says it followed one')
  t.is(await buildPreview(URL1, { fetch: page({ status: 0, url: '' }) }), null, 'an opaque manual redirect')
  t.is((await buildPreview(URL1, { fetch: page({ url: 'HTTPS://EXAMPLE.COM/a' }) })).title, 'Título & mais', 'the same URL, normalized')
  const imageMoved = await buildPreview(URL1, { fetch: async (url) => url === URL1 ? response(200, 'text/html', enc(HTML), URL1) : response(200, 'image/png', PNG, 'https://cdn.example.net/img.png') })
  t.is(imageMoved.title, 'Título & mais')
  t.is(imageMoved.imageBytes, null, 'a redirected image is dropped')
  t.is(imageMoved.url, URL1, 'the card names the link asked')
})

function filesUnder (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

test('fallbackCard: a music link passes the card rules, and only Publicar passes fallback', async (t) => {
  const { cardFields, cardForSend } = await card()
  const { fallbackCard } = await import('../src/musicEmbed.js')
  const { validLinkCard } = require('@varanda/core/lib/link-card')
  const id = 'abcdefghijk'
  const raw = fallbackCard('https://youtu.be/' + id)
  t.alike(cardFields(raw), { url: 'https://www.youtube.com/watch?v=' + id, host: 'www.youtube.com', title: 'YouTube', desc: '' })
  const sent = await cardForSend({ ...raw, thumb: null })
  t.is(sent.image, null, 'no thumbnail to upload')
  t.ok(validLinkCard(sent), 'core accepts the card with image null')
  t.is(fallbackCard('https://example.com/a'), null, 'a non-music URL')
  t.is(fallbackCard('https://audius.co/artist/track-name-123'), null, 'audius.co has no provider card')

  const composer = fs.readFileSync(path.join(SRC, 'ui/ChatComposer.js'), 'utf8')
  t.ok(/export function useLinkDraft \(\{ text, enabled = true, photos = false, member = null, fallback \}/.test(composer), 'fallback defaults to undefined')
  t.ok(/if \(data === null && typeof fallback === 'function'\) \{\s*try \{\s*const card = fallback\(target\)/.test(composer), 'an empty build asks the caller, inside try')
  t.ok(composer.includes("dispatch({ type: 'built', url: target, data: { ...card, thumb: null } })"), 'a returned object is the card, with no thumbnail')
  t.ok(composer.includes("dispatch(data ? { type: 'built', url: target, data } : { type: 'failed', url: target })"), 'anything else still fails as before')

  const publicar = fs.readFileSync(path.join(SRC, 'screens/Publicar.js'), 'utf8')
  t.ok(publicar.includes("import { fallbackCard, isAudiusLink } from '../musicEmbed'"), 'named import')
  t.absent(/import\s+fallbackCard\s+from\s+'\.\.\/musicEmbed'/.test(publicar), 'no default import')
  const passers = filesUnder(SRC).filter((file) => {
    const src = fs.readFileSync(file, 'utf8')
    return /useLinkDraft\(\{[^\n]*\bfallback\b/.test(src)
  }).map((file) => path.relative(SRC, file))
  t.alike(passers.sort(), [path.join('screens', 'Publicar.js')], 'only Publicar passes fallback')
})

test('LinkDraftCard draws a provider player for a music draft', (t) => {
  const composer = fs.readFileSync(path.join(SRC, 'ui/ChatComposer.js'), 'utf8')
  const start = composer.indexOf('export function LinkDraftCard (')
  const end = composer.indexOf('\n}\n', start)
  t.ok(start !== -1 && end !== -1, 'the draft card exists')
  const body = composer.slice(start, end)
  t.ok(composer.includes("import { MusicEmbedCard } from './MusicEmbedCard'"), 'imports the player card')
  t.ok(body.includes('const embed = embedOf(draft.view.url)'), 'only the draft card url picks a player')
  t.ok(body.includes('<MusicEmbedCard embed={embed} draft={draft.view} imageUri={draft.imageUri || undefined} onDismiss={() => draft.dismiss()} />'), 'the player draft keeps its image and remove button')
  t.ok(body.includes('<LinkCard draft={draft.view} imageUri={draft.imageUri || undefined} onDismiss={() => draft.dismiss()} />'), 'any other link keeps the LinkCard draft')
  t.ok(body.indexOf('if (!draft || !draft.view) return null') < body.indexOf('embedOf('), 'no lookup without a draft')
})

test('music snapshots respect the 300 character card URL boundary without an image', async (t) => {
  const { musicSnapshot } = await import('../src/musicDraft.js')
  const { MAX_CARD_URL } = require('@varanda/rpc')
  const { validLinkCard } = require('@varanda/core/lib/link-card')
  const { cardForSend } = await card()
  const prefix = 'https://audius.co/artist/'
  const item = { id: 'a'.repeat(32), title: 'Canção', artist: 'Artista', duration: 7200, url: prefix + 'x'.repeat(240 - prefix.length) }
  const ref = { kind: 'snippet', id: item.id, start: 7185 }
  const snapshot = musicSnapshot({ ref, item })
  const sent = await cardForSend(snapshot)
  t.is(MAX_CARD_URL, 300)
  t.is(snapshot.url.length, 295, 'the server caps the page at 240, leaving room for the longest fragment')
  t.is(sent.image, null)
  t.ok(validLinkCard(sent))
  // A card can reach 300, but the service refuses a page over 240.
  const boundary = { ...snapshot, url: snapshot.url.replace('#', 'xxxxx#') }
  t.is(boundary.url.length, 300)
  t.ok(validLinkCard(await cardForSend(boundary)))
  t.is(await cardForSend({ ...boundary, url: boundary.url + 'x' }), null)
  t.is(musicSnapshot({ ref, item: { ...item, url: item.url + 'xxxxx' } }), null)
})

test('Publicar holds the ordinary Audius build while availability is unknown or true, then builds when false', async (t) => {
  const src = fs.readFileSync(path.join(SRC, 'screens/Publicar.js'), 'utf8')
  t.ok(src.includes('useMusicAvailable(node, member, open)'), 'opening the composer refreshes music availability')
  t.ok(src.includes('musicAvailable === true && node.online !== false && previewsEnabled(previewPrefStore())'), 'resolution requires confirmed music and online previews')
  t.ok(src.includes('{musicAvailable === true && asPage === null'), 'the music button requires confirmed availability')
  t.ok(src.includes('asPage === null && musicAvailable === true && musicPickerOpen'), 'the picker requires confirmed availability')

  const slots = []
  const effects = []
  const timers = new Set()
  const fetched = []
  let cursor = 0
  const { buildPreview } = await native()
  const deps = {
    ...await card(),
    ...await import('../src/preview.js'),
    ...await import('../src/previewPref.js'),
    useNode: () => ({ online: true }),
    gifOriginOf: () => undefined,
    previewPrefStore: () => ({ getItem: () => null }),
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (value) => { slots[at] = value }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useEffect: (fn, values) => {
      const at = cursor++
      const previous = slots[at]
      if (previous && values.every((value, i) => Object.is(value, previous.values[i]))) return
      effects.push(() => {
        if (previous?.cleanup) previous.cleanup()
        slots[at] = { values, cleanup: fn() }
      })
    },
    setTimeout: (fn) => { timers.add(fn); return fn },
    clearTimeout: (fn) => timers.delete(fn),
    AbortController,
    buildPreview: (url, opts) => buildPreview(url, {
      ...opts,
      fetch: async (url) => { fetched.push(url); return response(200, 'text/html', enc('<title>Faixa</title>'), url) }
    }),
    encodeThumbnail: () => { throw new Error('no image') }
  }
  // Execute the real hook and Publicar call with a manual clock and native fetch stub.
  const composer = fs.readFileSync(path.join(SRC, 'ui/ChatComposer.js'), 'utf8')
  const hook = composer.slice(composer.indexOf('export function useLinkDraft'), composer.indexOf('// The draft card above')).replace('export ', '')
  // eslint-disable-next-line no-new-func
  const useLinkDraft = new Function(...Object.keys(deps), hook + '\nreturn useLinkDraft')(...Object.values(deps))
  const ctx = {
    ...await import('../src/musicEmbed.js'),
    ...await import('../src/preview.js'),
    useLinkDraft,
    text: 'https://audius.co/artist/song',
    open: true,
    asPage: null,
    musicDraft: null,
    shareLinkHeld: false,
    hasMedia: false,
    self: { publicKey: MEMBER },
    musicAvailable: null
  }
  const call = src.match(/^ {2}const linkDraft = useLinkDraft\([^\n]+/m)[0]
  for (const available of [null, true, false]) {
    ctx.musicAvailable = available
    cursor = 0
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(ctx), call)(...Object.values(ctx))
    for (const effect of effects.splice(0)) effect()
    for (const timer of [...timers]) { timers.delete(timer); timer() }
    await new Promise((resolve) => setImmediate(resolve))
    t.alike(fetched, available === false ? [ctx.text] : [], 'native page fetches with availability ' + available)
  }
  for (const slot of slots) { if (slot?.cleanup) slot.cleanup() }
})
