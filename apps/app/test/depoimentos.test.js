// Depoimentos screens (src/screens/Depoimentos.js, src/ui/TestimonialRow.js,
// Membro and Diario) read as source text, plus the pure device hide
// (src/testimonialHide.js) and its web store.
'use strict'

const test = require('brittle')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const SRC = join(__dirname, '../src')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const loadHide = () => import('../src/testimonialHide.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)

// The body of `const name = useCallback(async (...) => { ... }` up to the
// matching closing brace.
function callbackBody (src, name) {
  const start = src.indexOf('const ' + name + ' = useCallback(')
  if (start < 0) return null
  const open = src.indexOf('{', src.indexOf('=>', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return null
}

test('peer text goes through displayText', (t) => {
  const row = read('ui/TestimonialRow.js')
  t.ok(row.includes("from '@varanda/rpc'") && row.includes('displayText'), 'row imports displayText')
  t.ok(row.includes('displayText(row.text, { multiline: true })'), 'the text is multiline displayText')
  t.ok(row.includes('displayText(who.title)'), 'the name is displayText')
  t.absent(/\{row\.text\}/.test(row), 'never the raw text')
  t.absent(/like|curtid|count/i.test(row.replace(/^\/\/.*$/gm, '')), 'no likes or counts')
  t.ok(row.includes("'Remover do perfil'") && row.includes("'Denunciar a conta'"), 'owner and report actions')
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('displayText(who.title)'), 'sent rows show the name through displayText')
})

test('the write sheet keeps Enviar above the keyboard', (t) => {
  const screen = read('screens/Depoimentos.js')
  const start = screen.indexOf('export function WriteTestimonialSheet')
  const sheet = screen.slice(start, screen.indexOf('\n}\n', start))
  t.ok(sheet.includes("right={<Pill label='Enviar' filled pending={action.pending} disabled={body.length === 0 || over} onPress={send} maxFontSizeMultiplier={TEXT_CAP} />}"), 'Enviar in the header right slot')
  t.ok(screen.includes("import { Sheet, TEXT_CAP } from '../ui/Sheet'"), 'TEXT_CAP from Sheet')
  t.absent(sheet.includes('ConfirmStack'), 'no bottom button stack behind the keyboard')
  t.ok(sheet.includes('onClose={action.pending ? () => {} : onClose}'), 'Cancelar does nothing while sending')
  t.ok(screen.includes("import { KeyboardForm } from './Perfil'"), 'KeyboardForm from Perfil')
  t.ok(sheet.includes('<KeyboardForm>') && sheet.includes('</KeyboardForm>'), 'body inside KeyboardForm')
  t.ok(sheet.includes("<ScrollView style={styles.flex} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps='handled' keyboardDismissMode='interactive'>"), 'body scrolls and a drag dismisses the keyboard')
  t.ok(sheet.indexOf('<ScrollView') < sheet.indexOf('{counterLabel(count)}') && sheet.indexOf('{counterLabel(count)}') < sheet.indexOf('<Soft>{APPROVAL_NOTE}</Soft>') && sheet.indexOf('<ErrorText>') < sheet.indexOf('</ScrollView>'), 'counter, note and error scroll with the body')
  t.ok(screen.includes('export const WRITE_MAX_HEIGHT = 6 * 22 + 20') && screen.includes('maxHeight: WRITE_MAX_HEIGHT'), 'field capped near six lines')
  t.ok(screen.includes('minHeight: WRITE_MIN_HEIGHT') && screen.includes('export const WRITE_MIN_HEIGHT = 5 * 22 + 20'), 'starts five lines tall')
  t.ok(sheet.includes('<Label>{label}</Label>') && sheet.includes('accessibilityLabel={label}') && sheet.includes('const label = writeLabel(name)'), "'Para <nome>' label kept")
  t.ok(sheet.includes('editable={!action.pending}') && sheet.includes('if (typeof onUncertain === \'function\') onUncertain()'), 'locked while sending, uncertain path kept')
})

test('the write sheet carries the approval note and 400 chars', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes("'Só aparece no perfil depois que a pessoa aprovar.'"), 'approval note')
  t.ok(screen.includes('<Soft>{APPROVAL_NOTE}</Soft>'), 'note rendered in the sheet')
  t.ok(screen.includes('TESTIMONIAL_TEXT_MAX = 400'), '400 code points')
  // maxLength counts UTF-16 units on the web: 400 code points of emoji take 800.
  t.ok(screen.includes('export const TESTIMONIAL_FIELD_MAX = 2 * TESTIMONIAL_TEXT_MAX') && screen.includes('maxLength={TESTIMONIAL_FIELD_MAX}'), 'field allows the UTF-16 worst case')
  t.absent(screen.includes('maxLength={TESTIMONIAL_TEXT_MAX}'), 'never 400 UTF-16 units')
  t.ok(screen.includes("request('testimonial.write', { to, text: body })"), 'sent by testimonial.write')
  t.absent(screen.includes('testimonial.offer'), 'no testimonial.offer')
  const membro = read('screens/Membro.js')
  t.ok(membro.includes("icon: 'lapis', label: 'Escrever depoimento'"), 'Membro: write action with the lapis icon')
  t.ok(membro.includes("label: 'Retirar depoimento'"), 'Membro: retract own testimonial')
  t.ok(membro.includes('<WriteTestimonialSheet'), 'Membro: write sheet')
})

test('everything is gated on node.hosted, never Platform.OS', (t) => {
  for (const rel of ['screens/Depoimentos.js', 'ui/TestimonialRow.js', 'testimonialHide.js']) {
    t.absent(read(rel).includes('Platform'), rel + ': no Platform')
  }
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('const hosted = node.hosted === true'), 'hook gate')
  t.ok(/const enabled = hosted && online/.test(screen), 'nothing loads unless hosted and online')
  t.ok(screen.includes('if (node.hosted !== true) {'), 'screen gate')
  t.ok(read('screens/Membro.js').includes("const canTestimonial = node.hosted === true && full && !own && !isPage && typeof ownKey === 'string'"), 'Membro write gate')
})

test("'Agora não' writes no record", (t) => {
  const screen = read('screens/Depoimentos.js')
  const body = callbackBody(screen, 'notNow')
  t.ok(body, 'notNow handler found')
  t.absent(/testimonial\.|request\(/.test(body), 'no testimonial.* call and no request')
  t.ok(body.includes('hideTestimonial(row.ref)'), 'hides on this device')
  t.ok(screen.includes("<Pill label='Agora não' onPress={() => data.notNow(row)} />"), 'the pill calls notNow')
  t.ok(screen.includes("<Pill label='Mostrar no perfil' filled"), 'Mostrar no perfil is the filled pill')
  t.ok(screen.includes("request('testimonial.show', { from: row.from, seq: row.seq })"), 'show by testimonial.show')
  const diario = read('screens/Diario.js')
  t.ok(diario.includes('withPending: true'), 'Diario reads testimonial.pending')
  t.ok(screen.includes("'Depoimentos para aprovar (' + n + ')'"), 'pinned approval row label')
})

test('the hide store pair exists with the same exports', (t) => {
  for (const platform of ['native', 'web']) {
    const rel = 'testimonialHideStore.' + platform + '.js'
    t.ok(existsSync(join(SRC, rel)), rel)
    const src = read(rel)
    t.ok(src.includes('export const loadTestimonialHidden') && src.includes('export const hideTestimonial'), rel + ': exports')
    t.ok(src.includes("from './testimonialHide.js'"), rel + ': shared logic')
  }
  t.absent(existsSync(join(SRC, 'testimonialHideStore.js')), 'no shared file that would shadow the pair')
})

test('hide ids, list cleaning and visiblePending', async (t) => {
  const { HIDDEN_MAX, isHideId, hiddenListOf, withHidden, visiblePending } = await loadHide()
  t.ok(isHideId(A + ':1'))
  for (const bad of [A, A + ':0', A + ':01', A.toUpperCase() + ':1', 'ab:1', A + ':99999999999999999', 42, null]) t.absent(isHideId(bad), String(bad))
  t.alike(hiddenListOf([A + ':1', 'x', A + ':1', B + ':2']), [A + ':1', B + ':2'])
  t.alike(hiddenListOf('nope'), [])
  t.alike(withHidden([A + ':1', B + ':2'], A + ':1'), [B + ':2', A + ':1'], 'a repeat moves to the newest end')
  t.alike(withHidden([A + ':1'], 'bad'), [A + ':1'])
  const many = Array.from({ length: HIDDEN_MAX + 5 }, (_, i) => A + ':' + (i + 1))
  const kept = hiddenListOf(many)
  t.is(kept.length, HIDDEN_MAX)
  t.is(kept[kept.length - 1], A + ':' + (HIDDEN_MAX + 5), 'the newest kept')
  const rows = [{ ref: A + ':1' }, { ref: B + ':2' }, null, { ref: 3 }]
  t.alike(visiblePending(rows, [A + ':1']), [{ ref: B + ':2' }])
  t.alike(visiblePending(rows, new Set()), [{ ref: A + ':1' }, { ref: B + ':2' }])
  t.alike(visiblePending(null, []), [])
})

test('web hide store: localStorage, malformed data, failed writes', async (t) => {
  let raw = null
  let fail = false
  const keys = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => { keys.push(key); return raw },
      setItem: (key, value) => { keys.push(key); if (fail) throw new Error('write'); raw = value }
    }
  })
  t.teardown(() => { delete globalThis.localStorage })
  const { createTestimonialHideStore, STORAGE_KEY } = await loadHide()
  raw = '{invalid'
  const broken = createTestimonialHideStore({ read: () => raw, write: (v) => { raw = v } })
  t.alike(await broken.load(), [], 'malformed reads as empty')
  raw = null
  const store = await import('../src/testimonialHideStore.web.js')
  t.alike(await store.loadTestimonialHidden(), [])
  t.is(await store.hideTestimonial(A + ':3'), true)
  t.alike(JSON.parse(raw), [A + ':3'])
  t.is(await store.hideTestimonial('bad'), false, 'an invalid id is refused')
  fail = true
  t.is(await store.hideTestimonial(B + ':4'), false, 'a failed write says so')
  t.alike(await store.loadTestimonialHidden(), [A + ':3', B + ':4'], 'memory keeps the hide for this session')
  t.ok(keys.every((k) => k === STORAGE_KEY))
})

// A top-level `async function name (...) { ... }` of the source, compiled
// with the given constants in scope.
// Depoimentos.js's seqList, compiled from the same text it is checked against.
const SEQ_LIST_SRC = '(v) => Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x) && x >= 1) : []'
const SEQ_LIST = new Function('return ' + SEQ_LIST_SRC)() // eslint-disable-line no-new-func

function compileFunction (src, name, consts) {
  const start = src.indexOf('async function ' + name + ' (')
  if (start < 0) return null
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) {
      const names = Object.keys(consts)
      return new Function(...names, 'return ' + src.slice(start, i + 1))(...names.map((k) => consts[k])) // eslint-disable-line no-new-func
    }
  }
  return null
}

// A top-level `export function name (...) { ... }` of the source, compiled
// with the given constants in scope.
function compilePlain (src, name, consts) {
  const start = src.indexOf('export function ' + name + ' (')
  if (start < 0) return null
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) {
      const names = Object.keys(consts)
      return new Function(...names, 'return ' + src.slice(start + 'export '.length, i + 1))(...names.map((k) => consts[k])) // eslint-disable-line no-new-func
    }
  }
  return null
}

test('the own tab starts with the approval row and Enviados, then every row newest first', (t) => {
  const screen = read('screens/Depoimentos.js')
  const pendingLabel = (n) => 'Depoimentos para aprovar (' + n + ')'
  const tabItems = compilePlain(screen, 'tabItems', { pendingLabel, SENT_LABEL: 'Enviados' })
  t.ok(tabItems, 'tabItems found')
  const rows = [{ ref: B + ':9' }, { ref: A + ':4' }]
  const own = tabItems({ rows, pendingCount: 2, own: true, canOpen: true })
  t.alike(own.map((i) => i.kind + ':' + (i.label || i.row.ref)), ['link:Depoimentos para aprovar (2)', 'link:Enviados', 'row:' + B + ':9', 'row:' + A + ':4'], 'pinned row, Enviados, rows in order')
  t.alike(tabItems({ rows: [], pendingCount: 0, own: true, canOpen: true }).map((i) => i.label), ['Enviados'], 'Enviados always on the own tab, no approval row at 0')
  t.alike(tabItems({ rows, pendingCount: 3, own: false, canOpen: true }).map((i) => i.kind), ['row', 'row'], 'no own links on another profile')
  t.alike(tabItems({ rows, own: true, failed: true, error: 'x', canOpen: true }).map((i) => i.kind), ['link', 'retry', 'row', 'row'], 'a failed reload keeps its retry')
  t.is(tabItems({ rows: Array.from({ length: 10 }, (_, i) => ({ ref: A + ':' + (i + 1) })), own: false }).length, 10, 'all shown rows, no cap of three')
  t.ok(screen.includes("export const SENT_LABEL = 'Enviados'"), 'Enviados label')
  t.ok(screen.includes("export const TESTIMONIALS_TAB = { id: 'depoimentos', label: 'Depoimentos' }"), 'the tab')
  for (const gone of ['TestimonialsSection', 'SECTION_ROWS', 'Gerenciar depoimentos', 'Ver todos (']) t.absent(screen.includes(gone), 'no ' + gone)
  t.ok(read('screens/Diario.js').includes('onOpenAll: typeof onOpenTestimonials'), 'Diario passes the way in')
})

test('the empty tab and its footer follow the Mural rules', (t) => {
  const screen = read('screens/Depoimentos.js')
  const emptyBody = compilePlain(screen, 'emptyBody', { WRITE_HINT: 'Toque em ⋯ no perfil para escrever um depoimento.' })
  t.is(emptyBody({ own: false, canWrite: true }), 'Toque em ⋯ no perfil para escrever um depoimento.', 'hint when the viewer can write')
  t.is(emptyBody({ own: false, canWrite: false }), undefined, 'no hint when the viewer cannot write')
  t.is(emptyBody({ own: true, canWrite: true }), undefined, 'no hint on the own tab')
  t.ok(screen.includes("export const EMPTY_TITLE = 'Nenhum depoimento ainda'"), 'empty title')
  t.ok(screen.includes("else footer = <EmptyState icon='mensagem' title={EMPTY_TITLE} body={emptyBody({ own, canWrite })} />"), 'empty state with an icon in the footer')
  t.ok(screen.includes("else if (footerKind === 'error') footer = <ErrorState message={data.error || UNAVAILABLE} onRetry={handleRetry} />"), 'a failed first read keeps its retry')
  t.ok(screen.includes("else if (footerKind === 'loading') footer = <Skeleton rows={3} />"), 'loading skeleton')
  t.ok(read('screens/Membro.js').includes('canWrite: canWriteTestimonial && myTestimonial === null'), 'Membro: hint only when a write is offered')
})

test('a short index is never shown as every depoimento', (t) => {
  const screen = read('screens/Depoimentos.js')
  const indexIncomplete = compilePlain(screen, 'indexIncomplete', {})
  t.ok(indexIncomplete({ indexing: true, complete: true }), 'indexing')
  t.ok(indexIncomplete({ indexing: false, complete: false }), 'not complete')
  t.absent(indexIncomplete({ indexing: false, complete: true }), 'a complete index')
  t.absent(indexIncomplete(null), 'no index')
  const kind = compilePlain(screen, 'tabFooterKind', {})
  t.is(kind({ enabled: true, rowCount: 2, failed: false, phase: 'ready', incomplete: true }), 'incomplete', 'rows from a short index: no Fim')
  t.is(kind({ enabled: true, rowCount: 0, failed: false, phase: 'ready', incomplete: true }), 'incomplete', 'none from a short index: no empty state')
  t.is(kind({ enabled: true, rowCount: 2, failed: false, phase: 'ready', incomplete: false }), 'end', 'a complete list ends')
  t.is(kind({ enabled: true, rowCount: 0, failed: false, phase: 'ready', incomplete: false }), 'empty', 'a complete empty list')
  t.is(kind({ enabled: true, rowCount: 0, failed: true, phase: 'ready', incomplete: true }), 'error', 'a failure wins with nothing on screen')
  t.is(kind({ enabled: true, rowCount: 0, failed: false, phase: 'loading', incomplete: false }), 'loading', 'loading')
  t.is(kind({ enabled: false, rowCount: 0, failed: false, phase: 'off', incomplete: false }), 'off', 'not hosted')
  t.ok(screen.includes('return { index, rows: [], incomplete }') && screen.includes('return { index, rows: rowsFrom(peek, owner, writers), incomplete: shownIncomplete(incomplete, peek) }'), 'readShown carries the index word')
  t.ok(screen.includes('incomplete: v.incomplete === true'), 'useTestimonials keeps it')
  t.ok(screen.includes("footerKind === 'incomplete') footer = <View style={styles.more}><Soft>{INCOMPLETE_NOTE}</Soft><Pill label='Tentar de novo' onPress={handleRetry} /></View>"), 'tab: note with a retry')
  t.ok(screen.includes("if (data.incomplete || (own && data.pendingIncomplete)) items.push({ kind: 'incomplete'"), 'screen: one note for a short index or pending read')
})

test('an uncertain write never leaves Enviar live for a duplicate', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('uncertain = !!err && err.uncertain === true'), 'the sheet notes an uncertain failure')
  t.ok(/\} else if \(uncertain\) \{[\s\S]{0,160}onUncertain\(\)[\s\S]{0,40}onClose\(\)/.test(screen), 'and closes, telling the profile')
  const membro = read('screens/Membro.js')
  t.ok(membro.includes('const canWriteTestimonial = canTestimonial && !testimonialUncertain && !blockedHere'), 'Membro gates the write')
  t.ok(membro.includes("canWriteTestimonial && myTestimonial === null ? { icon: 'lapis', label: 'Escrever depoimento'"), 'no second Escrever depoimento')
  t.ok(membro.includes('setTestimonialUncertain(true)') && membro.includes('onToast(WRITE_UNCERTAIN)'), 'the toast says to check Enviados')
  t.ok(/Enviados/.test(screen.match(/WRITE_UNCERTAIN = '([^']*)'/)[1]), 'the text points to Enviados')
})

test('approved testimonials are peeked in chunks of PEEK_SEQS_MAX', async (t) => {
  const screen = read('screens/Depoimentos.js')
  const peekAll = compileFunction(screen, 'peekAll', { PEEK_SEQS_MAX: 32, diaryPeekSlots: { run: (fn) => fn() }, mergePeek: compilePlain(screen, 'mergePeek', { seqList: SEQ_LIST }) })
  t.ok(peekAll, 'peekAll found')
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params.seqs.length, inFlight])
    inFlight++
    await new Promise((resolve) => setImmediate(resolve))
    inFlight--
    return { key: params.author, profile: { name: 'x' }, entries: params.seqs.map((seq) => ({ seq, record: { type: 'testimonial-show' } })) }
  }
  let inFlight = 0
  const seqs = Array.from({ length: 64 }, (_, i) => 64 - i)
  const out = await peekAll(request, A, seqs.concat([5]))
  t.alike(calls.map((c) => c[1]), [32, 32], 'two chunks of 32')
  t.ok(calls.every((c) => c[0] === 'diary.peek' && c[2] === 0), 'serial diary.peek calls')
  t.is(out.key, A)
  t.is(out.entries.length, 64, 'all 64 entries merged')
  t.alike(out.profile, { name: 'x' }, 'hints from the first answer')
  t.ok(screen.includes('.slice(0, SHOWN_POINTERS_MAX)') && screen.includes('const SHOWN_POINTERS_MAX = 64'), 'up to 64 index pointers')
  t.ok(screen.includes('const peek = await peekAll(request, owner, shown.map((s) => s.seq))'), 'owner shows read through peekAll')
  t.ok(screen.includes('out.set(from, await peekAll(request, from, [...set]))'), 'writer peeks chunked too')
  t.absent(screen.includes('.slice(0, PEEK_SEQS_MAX)'), 'no silent cap at 32')
})

test("'Enviados' reads further pages only on 'Ver mais'", async (t) => {
  const screen = read('screens/Depoimentos.js')
  const readSentPages = compileFunction(screen, 'readSentPages', { SENT_PAGES: 8, LOG_LIMIT_MAX: 32 })
  t.ok(readSentPages, 'readSentPages found')
  let top = 1000
  const request = async (method, params) => {
    const end = params.before === undefined ? top : params.before - 1
    const seqs = Array.from({ length: Math.min(32, end) }, (_, i) => end - i)
    return { entries: seqs.map((seq) => ({ seq })), entriesTruncated: end > 32 ? end - 32 : 0 }
  }
  const first = await readSentPages(request, undefined)
  t.is(first.pages.length, 8, 'bounded first read')
  t.is(first.before, 1000 - 8 * 32 + 1, 'cursor kept while more of the log remains')
  const next = await readSentPages(request, first.before)
  t.is(next.before, 1000 - 16 * 32 + 1)
  top = 40
  const short = await readSentPages(request, undefined)
  t.is(short.pages.length, 2)
  t.is(short.before, null, 'no cursor once the log ended')
  t.ok(screen.includes("<Pill label='Ver mais' pending={data.sentLoadingMore} onPress={handleMoreSent} />"), 'explicit Ver mais')
  t.ok(screen.includes('const handleMoreSent = data.loadMoreSent'), 'Ver mais reads the next pages')
  t.ok(screen.includes("if (data.sentMore) items.push({ kind: 'more', key: 'm:sent' })"), 'Ver mais at the end of Enviados while more remains')
  t.ok(screen.includes('const pages = sentLogRef.current.pages.concat(log.pages)'), 'rows recomputed over every page read')
  t.absent(/onEndReached/.test(screen), 'never on scroll')
})

test('pending authors are resolved', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('resolve(rows.map((p) => p.from))'), 'pending from keys go to resolveMany')
  t.ok(screen.includes("if (keys.length > 0 && names && typeof names.resolveMany === 'function') names.resolveMany(keys)"), 'resolve calls resolveMany')
})

// The deps array closing `const name = useCallback(...)`.
function callbackDeps (src, name) {
  const body = callbackBody(src, name)
  if (body === null) return null
  const after = src.slice(src.indexOf(body) + body.length)
  const m = /^, \[([^\]]*)\]\)/.exec(after)
  return m ? m[1].split(',').map((x) => x.trim()) : null
}

test('a resolved name never reloads the lists or resets Ver mais', (t) => {
  const screen = read('screens/Depoimentos.js')
  for (const name of ['load', 'loadMoreSent']) {
    const deps = callbackDeps(screen, name)
    t.ok(deps, name + ' deps found')
    t.absent(deps.includes('names'), name + ' does not depend on the names context')
    t.ok(callbackBody(screen, name).includes('namesRef.current'), name + ' reads names through the ref')
  }
  t.ok(screen.includes('const namesRef = useRef(names)') && screen.includes('namesRef.current = names'), 'names kept in a ref')
})

test('writer peeks stay within two in flight and a failed one is never dropped', async (t) => {
  const screen = read('screens/Depoimentos.js')
  const peekAll = compileFunction(screen, 'peekAll', { PEEK_SEQS_MAX: 32, diaryPeekSlots: { run: (fn) => fn() }, mergePeek: compilePlain(screen, 'mergePeek', { seqList: SEQ_LIST }) })
  const peekWriters = compileFunction(screen, 'peekWriters', { peekAll, UNAVAILABLE: 'Depoimentos indisponíveis agora.' })
  t.ok(peekWriters, 'peekWriters found')
  let inFlight = 0
  let most = 0
  const calls = []
  const request = (bad) => async (method, params) => {
    calls.push(params.author)
    inFlight++
    most = Math.max(most, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight--
    if (params.author === bad) throw new Error('ocupado')
    return { key: params.author, entries: params.seqs.map((seq) => ({ seq })) }
  }
  const writers = Array.from({ length: 6 }, (_, i) => [String(i).repeat(64), new Set([1])])
  const ok = await peekWriters(request(null), new Map(writers))
  t.is(ok.size, 6, 'every writer read')
  t.ok(most <= 2, 'two peeks at most in flight')
  calls.length = 0
  await t.exception(peekWriters(request(writers[1][0]), new Map(writers)), /ocupado/, 'a failed writer read fails the whole read')
  t.is(inFlight, 0, 'no read left in flight after the failure')
  t.ok(calls.length < 6, 'the queue stops after a failure')
  // testimonial.pending waits for the shown reads, so the hook never runs a
  // third peek next to the two writer peeks.
  const load = callbackBody(screen, 'load')
  t.ok(load.includes("shown.then(() => live() ? diaryPeekSlots.run(() => request('testimonial.pending', {})) : null)"), 'pending runs after the shown reads, through the app-wide limiter')
  t.absent(load.includes("tasks.push(request('testimonial.pending'"), 'pending never runs alongside them')
  // The failure surfaces with a retry, in the tab and on the screen.
  t.ok(screen.includes("return <View style={styles.more}><ErrorText>{item.text}</ErrorText><Pill label='Tentar de novo' onPress={handleRetry} /></View>"), 'tab error with Tentar de novo')
  t.ok(screen.includes("if (shownFailed) items.push({ kind: 'retry', key: 'e:shown', text: data.error })"), 'screen keeps the rows and offers a retry')
  t.ok(screen.includes('<ErrorState message={data.error || UNAVAILABLE} onRetry={handleRetry} />'), 'first load error with a retry')
})

test('every peek goes through the app-wide diaryPeekSlots, and a failed first read keeps its retry', (t) => {
  const src = read('screens/Depoimentos.js')
  // The node's limit is per session, not per screen: Conversa and A Rua share
  // the same limiter (src/engagement.js), and so does this module.
  t.ok(src.includes("import { diaryPeekSlots } from '../engagement'"), 'shared limiter')
  t.absent(/PEEK_SLOTS|function gated|acquirePeek|releasePeek/.test(src), 'no module-level gate of its own')
  t.ok(src.includes("diaryPeekSlots.run(() => request('diary.peek'"), 'diary.peek goes through it')
  t.ok(src.includes("diaryPeekSlots.run(() => request('testimonial.pending', {}))"), 'so does testimonial.pending')
  const rest = src.replace("diaryPeekSlots.run(() => request('diary.peek'", '').replace("diaryPeekSlots.run(() => request('testimonial.pending'", '')
  t.absent(/request\('(diary\.peek|testimonial\.pending)'/.test(rest), 'no unlimited peek')
  t.ok(src.includes("(data.phase === 'ready' || data.phase === 'error')"), 'a first-load failure still shows its retry row')
})

test('row meta: the handle gives way and hides at large text, the date is never cut', (t) => {
  const row = read('ui/TestimonialRow.js')
  t.absent(row.includes("subtitle + ' · ' + time"), 'no single Text holding @nome and the date')
  t.ok(row.includes('who.subtitle && !(fontScale >= LARGE_TEXT) ? displayText(who.subtitle) : null'), 'handle hidden at large text')
  t.ok(row.includes('handle: { ...type.postMeta, color: colors.soft, flexShrink: 1'), 'handle shrinks')
  t.ok(row.includes('time: { ...type.postMeta, color: colors.soft, flexShrink: 0 }'), 'date never shrinks')
  t.ok(row.includes('<Text style={styles.time} numberOfLines={1}>'), 'the date is its own Text')
})

test('the tab links are full-width 44 pt rows with labels, never wrapping pills', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.absent(/<Pill label=\{item\.label/.test(screen), 'no link pill')
  t.ok(screen.includes('accessibilityLabel={item.label}') && screen.includes('style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}'), 'labelled row link')
  t.ok(/linkRow: \{[^}]*minHeight: 44/.test(screen), '44 pt row')
  t.ok(screen.includes("<Icon name='seta' size={20} color={colors.soft} />"), 'chevron')
  t.ok(/linkText: \{[^}]*flex: 1 \}/.test(screen) && !/linkText: \{[^}]*numberOfLines/.test(screen), 'label wraps, never cut')
})

test("'Agora não' refreshes every instance", (t) => {
  const body = callbackBody(read('screens/Depoimentos.js'), 'notNow')
  t.ok(body.indexOf('testimonialsChanged()') > body.indexOf('await hideTestimonial(row.ref)'), 'testimonialsChanged after the hide')
})

test('Enviados names wrap to two lines and Retirar names the person', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes("<Text style={styles.name} numberOfLines={2}>{'Para ' + title}</Text>"), 'two lines')
  t.ok(screen.includes("accessibilityLabel={'retirar depoimento para ' + title}"), 'Retirar labelled with the name')
  // Sheet titles stay short and fixed: a name there is cut on Android.
  t.ok(screen.includes('title={RETRACT_TITLE}') && screen.includes("export const RETRACT_TITLE = 'Retirar depoimento?'"), 'fixed retract title')
  t.ok(screen.includes('body={retractBody(retracting !== null ? retracting.name : null)}'), 'the body names the person')
  t.ok(screen.includes("'O depoimento para ' + name + ' deixa de valer"), 'retract body text')
  t.ok(screen.includes("export const REMOVE_TITLE = 'Remover do perfil?'") && screen.includes("'O depoimento de ' + name + ' deixa de aparecer no seu perfil.'"), 'remove: fixed title, named body')
  t.absent(screen.includes("title={'") || /title=\{[a-z]+Title\(/.test(screen), 'no title built from a name')
})

test('write sheet: code point counter and Enviar off past 400', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('return typeof text === \'string\' ? [...text].length : 0'), 'code points')
  t.ok(screen.includes("return n + '/' + TESTIMONIAL_TEXT_MAX"), 'N/400')
  t.ok(screen.includes('export const COUNTER_WARN = 380') && screen.includes('count >= COUNTER_WARN && styles.counterWarn'), 'warning from 380')
  t.ok(screen.includes('counterWarn: { color: colors.warn }') && /counter: \{[^}]*textAlign: 'right'/.test(screen), 'soft, right aligned, warn colour')
  t.ok(screen.includes('disabled={body.length === 0 || over}'), 'Enviar disabled over 400')
  t.ok(screen.includes('const over = textLength(body) > TESTIMONIAL_TEXT_MAX'), 'over counts code points')
  t.ok(screen.includes('title={WRITE_TITLE}') && screen.includes("export const WRITE_TITLE = 'Escrever depoimento'"), 'fixed sheet title')
  t.ok(screen.includes("return named(name) ? 'Para ' + name : 'Depoimento'") && screen.includes('const label = writeLabel(name)') && screen.includes('<Label>{label}</Label>'), 'the field label names the person')
  const membro = read('screens/Membro.js')
  t.ok(membro.includes('name={displayText(who.title)}'), 'Membro passes the name')
  t.absent(membro.includes('writeTitle') || membro.includes('retractTitle'), 'Membro: no title with a name')
  t.ok(membro.includes('title={RETRACT_TITLE}') && membro.includes('body={retractBody(displayText(who.title))}'), 'Membro: fixed retract title, named body')
  t.ok(membro.includes("onToast('Depoimento enviado. Aparece quando a pessoa aprovar.')"), 'toast after a send')
})

test('the viewer never reports themself: own depoimento offers Retirar', (t) => {
  const row = read('ui/TestimonialRow.js')
  t.ok(row.includes('row.from === ownKey.toLowerCase()'), 'own row detected')
  t.ok(/mine\s*\? \[typeof onRetract === 'function' \? \{ icon: 'lixeira', label: 'Retirar depoimento'/.test(row), 'own row: Retirar depoimento only')
  t.absent(row.includes("label: 'Retirar',"), 'never the bare Retirar label')
  const screen = read('screens/Depoimentos.js')
  t.absent(screen.includes('onReport={!own ? onReport : undefined}'), 'owner rows offer Denunciar too')
  t.ok(screen.includes('onRetract={retractRef !== null ? () => setRetracting(retractRef) : undefined}'), 'tab Retirar')
  t.ok(screen.includes('const retractRef = own || !enabled ? null : ownBlockRef(data.index'), 'tab retracts the writer block')
  t.ok(screen.includes('const ownRef = own ? null : ownBlockRef(data.index'), 'screen retracts the writer block')
  t.ok(screen.includes("await request('testimonial.delete', { to: ref, about: data.owner })"), 'tab: by testimonial.delete, about the profile owner')
  const membro = read('screens/Membro.js')
  t.ok(/useTestimonialTab\(\{[^]*?ownKey,[^]*?onRetracted: /.test(membro), 'Membro passes the viewer key')
  t.ok(read('screens/Diario.js').includes('onReport: typeof onReport'), 'Diario: Denunciar on own profile rows')
})

test('every retract names the person it is about, so a seeder ref cannot reach another own block', (t) => {
  const screen = read('screens/Depoimentos.js')
  const membro = read('screens/Membro.js')
  const deletes = (src) => src.match(/request\('testimonial\.delete', \{[^}]*\}\)/g) || []
  t.alike(deletes(screen), [
    "request('testimonial.delete', { to: removing.ref })",
    "request('testimonial.delete', { to: ref, about: data.owner })",
    "request('testimonial.delete', { to: removing.ref })",
    "request('testimonial.delete', { to: retracting.ref, about: retracting.about })"
  ], 'only the owner\'s Remover do perfil goes without about')
  t.ok(screen.includes('    owner,\n    phase: enabled ? state.phase'), 'the tab data carries the profile owner')
  t.ok(screen.includes('setRetracting({ ref: ownRef, name: ownerName, about: owner })'), 'screen: about the profile owner')
  t.ok(screen.includes('onRetract({ ref: row.ref, name: title, about: row.to })'), 'Enviados: about the row recipient')
  t.alike(deletes(membro), ["request('testimonial.delete', { to: ref, about: author })"], 'Membro: about the profile owner')
})

test('an unverified show makes the approved list incomplete, merged across chunks', (t) => {
  const screen = read('screens/Depoimentos.js')
  const fns = { mergePeek: compilePlain(screen, 'mergePeek', { seqList: SEQ_LIST }), shownIncomplete: compilePlain(screen, 'shownIncomplete', {}) }
  t.ok(screen.includes('const seqList = ' + SEQ_LIST_SRC), 'seqList as compiled here')
  const first = fns.mergePeek(null, { entries: [{ seq: 1 }], invalid: [2], unverified: [3], profile: 'p' })
  const merged = fns.mergePeek(first, { entries: [{ seq: 4 }], invalid: [5, 'x'], unverified: [6] })
  t.alike([merged.entries.map((e) => e.seq), merged.invalid, merged.unverified, merged.profile], [[1, 4], [2, 5], [3, 6], 'p'])
  t.alike(fns.mergePeek(null, { entries: [] }).unverified, [], 'an older node without unverified')
  t.is(fns.shownIncomplete(false, merged), true, 'unverified: incomplete')
  t.is(fns.shownIncomplete(false, fns.mergePeek(null, { entries: [], invalid: [1] })), false, 'invalid alone is complete')
  t.is(fns.shownIncomplete(true, fns.mergePeek(null, { entries: [] })), true, 'the index still decides too')
  t.ok(screen.includes('merged = mergePeek(merged, page)'), 'peekAll merges every chunk')
  t.ok(screen.includes('incomplete: shownIncomplete(incomplete, peek) }'), 'readShown applies the rule')
})

test('the screen declares its retry before renderItem', (t) => {
  const screen = read('screens/Depoimentos.js')
  const fn = screen.slice(screen.indexOf('export default function Depoimentos'))
  t.ok(fn.indexOf('const handleRetry = data.reload') > 0 && fn.indexOf('const handleRetry = data.reload') < fn.indexOf('const renderItem = '), 'declared first')
})

test('Depoimentos is the third profile tab, hosted only, in the one list', (t) => {
  for (const name of ['Diario', 'Membro']) {
    const src = read('screens/' + name + '.js')
    t.absent(src.includes('TestimonialsSection'), name + ': no section between the tabs and the content')
    t.ok(src.includes('const TABS_HOSTED = TABS.concat([TESTIMONIALS_TAB])'), name + ': three tabs')
    t.ok(src.includes('const tabs = node.hosted === true ? TABS_HOSTED : TABS'), name + ': two tabs unless hosted')
    t.ok(src.includes('<Segmented options={tabs} selected={shownTab} onSelect={setTab} />'), name + ': Segmented takes the tabs')
    t.ok(src.includes("const shownTab = tabs.some((t) => t.id === tab) ? tab : 'posts'"), name + ': a hidden tab falls back to Publicações')
    t.ok(src.includes('data={depo ? testimonialTab.items'), name + ': the tab feeds the one RefreshableList')
    t.ok(src.includes('ListFooterComponent={depo ? testimonialTab.footer'), name + ': footer carries the empty state')
    t.ok(src.includes('{testimonialTab.sheets}'), name + ': confirmation sheets beside the list')
    t.is(src.split('<RefreshableList').length - 1, 1, name + ': one RefreshableList')
    t.ok(src.includes("// 'posts' | 'mural' | 'depoimentos'. The state lives here"), name + ': the tab survives a thread visit')
  }
  t.ok(read('screens/Diario.js').includes('own: true,'), 'Diario: own tab')
  t.ok(read('screens/Membro.js').includes('own: false,'), 'Membro: another profile')
})

test('no publish button on the Depoimentos screen', async (t) => {
  const { showPostButton } = await import('../src/tabs.js')
  t.absent(showPostButton({ tab: 'diario', screen: 'depoimentos' }))
  t.ok(showPostButton({ tab: 'diario', screen: 'membro' }))
})

test('visual round 2: toast wraps, Enviados aligned, counter over the limit', (t) => {
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes("maxWidth: '92%'") && app.includes("<View pointerEvents='none' style={styles.toastLabel}>") && app.includes('toastLabel: { flexShrink: 1 }'), 'a long toast wraps inside the screen')
  t.ok(app.includes('bottom: fabShown ? insets.bottom + layout.tabBar + layout.fabAboveTabs + layout.fabSize + 12'), 'the toast sits above the publish button when it shows')
  t.ok(app.indexOf('{fabShown ? <Fab onPress={openComposer} /> : null}') < app.indexOf('<View pointerEvents=\'none\' style={styles.toastLabel}>'), 'and paints after it')
  t.ok(app.includes('toast && !(viewerOnTop || viewerLeaving)'), 'no toast over the viewer')
  const om = app.slice(app.indexOf('const openMomentos = useCallback('))
  t.ok(om.slice(0, om.indexOf('}, [pushScreen])')).includes('setToast(null)'), 'opening the viewer clears the toast')
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes("label: SENT_LABEL, icon: 'encaminhar'"), 'Enviados has an icon like the approval row')
  t.ok(screen.includes('count > TESTIMONIAL_TEXT_MAX && styles.counterOver') && screen.includes('counterOver: { color: colors.danger }'), 'over 400 the counter turns danger')
})

test('a confirmation keeps its text while it slides out', (t) => {
  const screen = read('screens/Depoimentos.js')
  t.ok(screen.includes('if (open && body) lastBody.current = body') && screen.includes('const shownBody = open ? body : lastBody.current'), 'the last body is held while closing')
  t.ok(screen.includes('{shownBody ? <Soft>{shownBody}</Soft> : null}'), 'and rendered')
})
