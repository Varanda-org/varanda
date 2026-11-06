'use strict'

// The GIF picker: its pure helpers (src/gif.js) and source scans of the
// picker, the attach sheet and the composer wiring. Nothing touches the
// network.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/gif.js')
const src = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')
const item = (id, w = 200, h = 100) => ({ id, width: w, height: h, bytes: 5000 })

// Every string literal of a source file, comments excluded.
function literals (code) {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const out = []
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  let m
  while ((m = re.exec(stripped)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

test('GifPicker.js and gif.js name no host: every path is relative to the account origin', (t) => {
  for (const file of ['ui/GifPicker.js', 'gif.js']) {
    const code = src(file)
    t.absent(/[a-z][a-z0-9+.-]*:\/\//i.test(code), file + ': no scheme://')
    t.absent(/\b(giphy|tenor|klipy|gfycat|imgur)\b/i.test(code), file + ': no provider name')
    for (const s of literals(code)) {
      t.absent(s.startsWith('//'), file + ': protocol-relative ' + s)
      if (s.startsWith('/')) t.ok(s.startsWith('/account/gif/'), file + ': only account GIF routes, ' + s)
      t.absent(/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(s), file + ': host-like literal ' + s)
    }
  }
  // gif.js builds every URL from accountOriginOf (or '' for the same origin).
  t.ok(src('gif.js').includes("import { accountOriginOf } from './pageGate.js'"))
  t.ok(src('ui/GifPicker.js').includes("import { gifImage, gifReady, gifSearch } from '../account'"))
  t.absent(/\bfetch\s*\(/.test(src('ui/GifPicker.js')), 'the picker never fetches by itself')
  t.absent(/source=\{\{\s*uri:\s*(?!uri\b)/.test(src('ui/GifPicker.js')), 'an Image shows only the device-local uri')
})

test('the picker texts, and the error that picks them', async (t) => {
  const g = await load()
  t.is(g.GIF_EMPTY_TEXT, 'Nenhum GIF encontrado')
  t.is(g.GIF_UNAVAILABLE_TEXT, 'Busca de GIF indisponível')
  t.is(g.GIF_LIMIT_TEXT, 'Limite de buscas de GIF por hoje')
  t.is(g.gifErrorText({ code: 'limite-gif' }), g.GIF_LIMIT_TEXT)
  for (const err of [{ code: 'indisponivel' }, { code: 'nao-autorizado' }, new Error('x'), null, undefined]) {
    t.is(g.gifErrorText(err), g.GIF_UNAVAILABLE_TEXT, String(err && err.code))
  }
  for (const text of [g.GIF_EMPTY_TEXT, g.GIF_UNAVAILABLE_TEXT, g.GIF_LIMIT_TEXT]) t.absent(text.includes('\u2014'))
  t.ok(g.GIF_DEBOUNCE_MS >= 200 && g.GIF_DEBOUNCE_MS <= 600, 'a short debounce')
})

test('gifQuery: trimmed, 1 to 64 characters, else nothing to search', async (t) => {
  const { gifQuery } = await load()
  t.is(gifQuery('  gato '), 'gato')
  t.is(gifQuery(''), '')
  t.is(gifQuery('   '), '')
  t.is(gifQuery('a'.repeat(65)), '')
  t.is(gifQuery('😀'.repeat(64)), '😀'.repeat(64))
  t.is(gifQuery(5), '')
})

test('mergeGifPage: one cell per id, in order', async (t) => {
  const { mergeGifPage } = await load()
  t.alike(mergeGifPage([item('a'), item('b')], { items: [item('b'), item('c')], next: null }).map((i) => i.id), ['a', 'b', 'c'])
  t.alike(mergeGifPage([], { items: [item('a'), item('a')] }).map((i) => i.id), ['a'])
  t.alike(mergeGifPage(null, null), [])
  t.alike(mergeGifPage([item('a'), null, { id: 5 }], { items: [] }).map((i) => i.id), ['a'])
})

test('gifReduce: a new query restarts, a stale answer is dropped, more pages append', async (t) => {
  const { gifIdle, gifReduce, gifNotice, GIF_EMPTY_TEXT, GIF_LIMIT_TEXT, GIF_UNAVAILABLE_TEXT } = await load()
  let s = gifReduce(gifIdle, { type: 'query', text: '  ' })
  t.is(s, gifIdle, 'nothing to search')
  s = gifReduce(s, { type: 'query', text: 'gato' })
  t.is(s.phase, 'loading')
  t.is(s.query, 'gato')
  const first = s.gen
  t.is(gifReduce(s, { type: 'query', text: ' gato ' }), s, 'the same query does not search again')
  s = gifReduce(s, { type: 'query', text: 'cão' })
  t.is(gifReduce(s, { type: 'page', gen: first, page: { items: [item('x')], next: null } }), s, 'an older query is dropped')
  s = gifReduce(s, { type: 'page', gen: s.gen, page: { items: [item('a'), item('b')], next: 'c1' } })
  t.is(s.phase, 'ready')
  t.is(s.next, 'c1')
  t.is(gifNotice(s), '')
  s = gifReduce(s, { type: 'more' })
  t.is(s.phase, 'more')
  t.is(gifReduce(s, { type: 'more' }), s, 'one next page at a time')
  s = gifReduce(s, { type: 'page', gen: s.gen, page: { items: [item('b'), item('c')], next: null } })
  t.alike(s.items.map((i) => i.id), ['a', 'b', 'c'])
  t.is(gifReduce(s, { type: 'more' }), s, 'no more after the last page')

  let e = gifReduce(gifIdle, { type: 'query', text: 'x' })
  e = gifReduce(e, { type: 'page', gen: e.gen, page: { items: [], next: null } })
  t.is(gifNotice(e), GIF_EMPTY_TEXT)

  let f = gifReduce(gifIdle, { type: 'query', text: 'x' })
  f = gifReduce(f, { type: 'fail', gen: f.gen, error: { code: 'limite-gif' } })
  t.is(f.phase, 'error')
  t.is(gifNotice(f), GIF_LIMIT_TEXT, '429')
  const again = gifReduce(f, { type: 'query', text: 'x' })
  t.is(again.phase, 'loading', 'the same query can be tried again after an error')
  let g = gifReduce(gifIdle, { type: 'query', text: 'x' })
  g = gifReduce(g, { type: 'fail', gen: g.gen, error: { code: 'indisponivel' } })
  t.is(gifNotice(g), GIF_UNAVAILABLE_TEXT, '503')

  let h = gifReduce(gifIdle, { type: 'query', text: 'x' })
  h = gifReduce(h, { type: 'page', gen: h.gen, page: { items: [item('a')], next: 'c' } })
  h = gifReduce(h, { type: 'more' })
  h = gifReduce(h, { type: 'fail', gen: h.gen, error: { code: 'limite-gif' } })
  t.is(h.phase, 'ready', 'a failed next page keeps the grid')
  t.is(h.items.length, 1)
  t.is(h.next, null, 'and stops asking')
  t.is(h.error, GIF_LIMIT_TEXT)
  t.is(gifReduce(h, { type: 'unknown' }), h)
})

const gif = (w, h, n = 64) => {
  const b = new Uint8Array(n)
  b.set([71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8])
  return b
}

test('gifFileFrom: the gallery GIF checks, then mediaBounds', async (t) => {
  const { gifFileFrom } = await load()
  const bounds = (bytes, mime) => (mime === 'image/gif' ? { width: 3, height: 2 } : null)
  t.alike(gifFileFrom(gif(3, 2), bounds), { bytes: gif(3, 2), mime: 'image/gif', width: 3, height: 2 })
  t.is(gifFileFrom(gif(3, 2), () => null), null, 'mediaBounds refuses')
  t.is(gifFileFrom(gif(3, 2), () => { throw new Error('x') }), null)
  t.is(gifFileFrom(new Uint8Array(64), bounds), null, 'not a GIF')
  t.is(gifFileFrom(gif(0, 2), bounds), null, 'zero width')
  t.is(gifFileFrom(gif(3, 2, 8 * 1024 * 1024 + 1), bounds), null, 'over the GIF size limit')
  t.is(gifFileFrom('GIF89a', bounds), null)
  // The real mediaBounds (from @varanda/rpc) on a truncated GIF refuses it.
  t.is(gifFileFrom(gif(3, 2)), null, 'a header alone is not a GIF mediaBounds accepts')
})

test('gifQueue: at most N tasks at once, all run', async (t) => {
  const { gifQueue } = await load()
  const q = gifQueue(2)
  let running = 0
  let peak = 0
  const task = (v) => async () => {
    running++
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running--
    return v
  }
  const results = await Promise.all([1, 2, 3, 4, 5].map((v) => q.run(task(v))))
  t.alike(results, [1, 2, 3, 4, 5])
  t.is(peak, 2)
  await t.exception(() => q.run(async () => { throw new Error('boom') }), /boom/)
  t.is(await q.run(async () => 'after'), 'after', 'a failure frees its slot')
})

test('the attach sheet shows GIF only with the capability, and stages the picked file', (t) => {
  const sheet = src('ui/AttachSheet.js')
  t.ok(sheet.includes("o.planned !== true || (o.key === 'gif' && gif === true)"), 'the GIF row is gated')
  t.ok(sheet.includes('attachOptions({ gif }).map('))
  t.ok(sheet.includes('boundedFile(given !== null ? source : await encodeFile(source))'), 'a picked GIF is bounded again, never re-encoded')
  const composer = src('ui/ChatComposer.js')
  t.ok(composer.includes('gif={gifReady}'))
  t.ok(composer.includes("if (kind === 'gif') setGifOpen(true); else onAttach(kind)"))
  t.ok(composer.includes("onPick={(file) => onAttach('gif', file)}"))
  t.ok(composer.includes('{typeof onAttach === \'function\' && gifReady'), 'no picker without the capability')
  for (const screen of ['screens/Mensagem.js', 'screens/Grupo.js']) {
    t.ok(src(screen).includes('(kind, file) => attachments.pick(file)'), screen + ' stages the GIF like a gallery pick')
  }
  const picker = src('ui/GifPicker.js')
  t.ok(picker.includes('revokeUrl(made)'), 'a tile releases its local URL')
  t.ok(picker.includes("gifImage(item.id, 'full', session)"), 'the pick fetches the full bytes through the session')
  t.ok(picker.includes('gifFileFrom('), 'the full bytes pass the GIF checks')
  t.absent(/Platform\.OS/.test(picker), 'capability, not platform')
  t.ok(picker.includes('export { gifOriginOf }'), 'the composer gets the tested gifOriginOf from gif.js')
  t.absent(/function gifOriginOf/.test(picker), 'no second gifOriginOf in the picker')
  for (const f of ['ui/GifPicker.js', 'gif.js', 'ui/AttachSheet.js', 'ui/ChatComposer.js']) t.absent(src(f).includes('\u2014'), f)
})
