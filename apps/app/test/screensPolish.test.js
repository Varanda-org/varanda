'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const section = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)))

// Evaluate the screen's choices without loading React Native, as in dm.test.js.
function evaluate (source, deps = {}) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), source)(...Object.values(deps))
}

function conditionBefore (source, markup, deps) {
  const at = source.indexOf(markup)
  if (at === -1) throw new Error('missing markup: ' + markup)
  const match = source.slice(0, at).match(/\{([^{}\n]+)\s*\?\s*$/)
  if (!match) throw new Error('missing condition before: ' + markup)
  return evaluate('return ' + match[1], deps)
}

test('feed and search first loads use row skeleton lists', (t) => {
  for (const name of ['ARua', 'Espiadinha', 'Busca', 'BuscaGlobal']) {
    const src = read('screens/' + name + '.js')
    t.ok(src.includes('SkeletonRow } from'), name + ' imports row placeholders')
    t.ok(src.includes('<SkeletonRow'), name + ' renders row placeholders')
    t.absent(/<Skeleton\b|<Spinner\b|<ActivityIndicator\b/.test(src), name + ' has no bare spinner or old placeholder')
  }
})

test('both A Rua feeds keep load errors in the list header', (t) => {
  const src = read('screens/ARua.js')
  t.ok(src.includes('commit({ items: [], loading: false, error: errorText(failure), incomplete: false })'), 'a failed page refresh clears rows and incomplete status')
  t.ok(src.includes('commit({ loading: false, refreshing: false, loadError: errorText(err) })'), 'a failed member refresh preserves loaded rows')
  for (const [name, error] of [['PageARua', 'error'], ['MemberARua', 'loadError']]) {
    const body = src.slice(src.indexOf('function ' + name))
    const empty = section(body, 'let empty', 'const del = useDelete')
    t.ok(body.includes('if (' + error + ') empty = null'), name + ' does not replace the list with an error')
    t.absent(empty.includes('empty = <ErrorState'), name + ' has no empty error branch')
    const header = section(body, 'ListHeaderComponent={(', 'ListEmptyComponent={empty}')
    t.ok(header.includes('{' + error + ' ? <ErrorState'), name + ' shows the band even without rows')
    t.absent(header.includes('items.length > 0 && ' + error), name + ' uses the same place with rows')
  }
  t.ok(src.includes("secondaryLabel='Atualizar'"), 'empty feeds offer a second path')
  t.ok(src.includes("actionLabel='Atualizar'"), 'a followed but empty feed can refresh')
})

test('incomplete counts keep their explanation in a shared info button', async (t) => {
  const src = read('screens/ARua.js')
  const note = section(src, 'export function CountsNote', '\n\n')
  t.ok(src.includes("import { HelpButton, HelpNote } from '../ui/Help'"), 'the shared help control is imported')
  t.ok(src.includes("const INCOMPLETE_NOTE = 'Alguns números podem estar incompletos.'"), 'the original sentence stays unchanged')
  t.ok(note.includes('const doc = countsNoteDoc(social.social.flags)') && note.includes('if (doc === null) return null'), 'CountsNote renders only when the rule gives a doc')
  t.ok(note.includes('<HelpButton doc={doc} size={18} style={styles.countsHelp} />'), 'CountsNote renders a HelpButton with its own doc')
  t.ok(note.includes("<Text style={styles.countsNoteText} accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>{doc.title}</Text>"), 'a visible label, read once on the button')
  t.ok(src.includes("countsNote: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, minHeight: layout.hit }") && src.includes('countsHelp: { marginLeft: -8 }'), 'the 44 pt target stays inside its own row, without the inset margin')
  const rule = section(src, 'export function countsNoteDoc', '\n\n')
  t.ok(rule.length > 0, 'one pure rule picks the note')
  const countsNoteDoc = evaluate(rule.replace('export ', '') + '\nreturn countsNoteDoc', { INCOMPLETE_NOTE: 'Alguns números podem estar incompletos.' })
  for (const indexing of [false, true]) {
    for (const complete of [false, true, undefined, null, 0]) {
      const doc = countsNoteDoc({ indexing, complete })
      t.alike(doc, !indexing && complete === false ? { title: 'Números incompletos', paragraphs: ['Alguns números podem estar incompletos.'] } : null, 'indexing=' + indexing + ', complete=' + complete)
    }
  }
  for (const name of ['Busca', 'Diario', 'Espiadinha']) {
    const consumer = read('screens/' + name + '.js')
    t.ok(/import \{[^}]*\bCountsNote\b[^}]*\} from '\.\/ARua'/.test(consumer) && consumer.includes('<CountsNote social={social} />'), name + ' shares the same control')
  }
  t.ok(src.includes('{incomplete ? <Soft>incompleto: algumas publicações podem não ter chegado.</Soft> : null}'), 'the separate publication warning stays')
  const { HELP } = await import('../src/help.js')
  t.is(HELP.rua.paragraphs[2], 'Os números de curtidas e respostas podem chegar incompletos. Eles não mudam o que foi publicado.', 'the general feed help keeps its distinct sentence')
})

test('shell toast has a 44 point action and extends action lifetime for large text', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/toastAction: \{[^\n]*minHeight: 44[^\n]*minWidth: 44/.test(src), 'both touch dimensions on the visible action')
  const action = section(src, 'accessibilityLabel={toast.actionLabel}', '<Text style={styles.toastActionText}>')
  t.absent(action.includes('hitSlop={8}'), 'the shell action has its own target')
  t.ok(action.includes('style={styles.toastAction}'), 'the shell uses the enlarged target')
  t.ok(src.includes('const { width, fontScale } = useWindowDimensions()'), 'the shell observes text settings')
  t.ok(src.includes('import { LARGE_TEXT, layout, space, type }'), 'the shell shares the theme threshold')
  const constants = section(src, 'const TOAST_MS', '// The native splash')
  const callback = section(src, '  const showToast = (input)', '\n\n  // The outbox')
  const LARGE_TEXT = evaluate(section(read('ui/theme.js'), 'export const LARGE_TEXT', '\n').replace('export ', '') + '\nreturn LARGE_TEXT')
  for (const fontScale of [1, LARGE_TEXT - 0.01, LARGE_TEXT, 1.3, 2]) {
    for (const withAction of [false, true]) {
      let delay
      const input = withAction ? { text: 'Republicado', actionLabel: 'Desfazer', onAction: () => {} } : 'publicado'
      evaluate(constants + callback + '\nshowToast(input)', {
        input,
        fontScale,
        LARGE_TEXT,
        toastTimer: { current: null },
        clearTimeout: () => {},
        setToast: () => {},
        setTimeout: (fn, ms) => { delay = ms }
      })
      t.is(delay, withAction ? (fontScale >= LARGE_TEXT ? 8000 : 4000) : 2500, 'action=' + withAction + ', scale=' + fontScale)
    }
  }
})

test('Espiadinha keeps the expiry action at the footer and notes alongside refresh errors', (t) => {
  const src = read('screens/Espiadinha.js')
  const header = section(src, 'const header = (', 'const footer = (')
  const footer = section(src, 'const footer = (', 'let empty')
  t.ok(header.includes('{!expired ? <HelpNote doc={statusHelp}><Soft>{statusNote}</Soft></HelpNote> : null}'), 'the header note yields to expiry at the footer')
  t.ok(header.includes('{items.length > 0 && loadError ? <ErrorState'), 'a refresh error joins the notes')
  t.ok(footer.includes('{expired') && footer.includes('<HelpNote doc={statusHelp}><Soft>{statusNote}</Soft></HelpNote>'), 'expiry is explained where pagination stopped')
  t.ok(footer.includes("<Pill label='atualizar' onPress={loadFirst} pending={loading || refreshing} />"), 'expiry offers refresh at the footer')
  t.ok(src.includes('ListHeaderComponent={notice === null ? header : null}'), 'errors do not replace the notes')
  t.ok(src.includes('ListFooterComponent={notice === null ? footer : null}'), 'errors do not hide expiry')
  t.ok(src.includes("body={loadError} actionLabel='Tentar de novo' onAction={loadFirst} secondaryLabel='publicar'"), 'first-load errors have both paths')
})

test('Espiadinha explains capability limits with help and another path', async (t) => {
  const src = read('screens/Espiadinha.js')
  t.ok(src.includes("import { NOT_HOSTED } from '../pessoas'"), 'shared capability wording')
  t.ok(src.includes("body={NOT_HOSTED} actionLabel='Saiba mais' onAction={() => setHelpOpen(true)} secondaryLabel='publicar'"), 'the capability state offers help and publishing')
  t.ok(src.includes('<HelpSheet open={helpOpen}'), 'the help action opens a sheet')
  t.absent(src.includes('Só na versão web'), 'no platform-only title')
  const { NOT_HOSTED } = await import('../src/pessoas.js')
  t.is(NOT_HOSTED, 'Disponível no site da associação ou no app ligado à instalação.')
  const { peekNotice } = await import('../src/peek.js')
  t.is(peekNotice({ hosted: false, supported: true, online: true, loadedAt: null }), 'web-only')
  t.is(peekNotice({ hosted: true, supported: true, online: true, loadedAt: null }), null)
})

test('Busca collapses status notes into the existing help sheet', (t) => {
  const src = read('screens/Busca.js')
  const top = section(src, 'const top = (', 'const footer = (')
  t.is((top.match(/<Soft>/g) || []).length, 1, 'one search note')
  t.ok(top.includes('<HelpNote doc={searchHelp}><Soft>{statusNote}</Soft></HelpNote>'), 'one help trigger')
  t.ok(src.includes('const searchNotes = [flags.indexing && SEARCH_INDEXING_NOTE, !flags.complete && SEARCH_INCOMPLETE_NOTE, gone].filter(Boolean)'), 'all details are retained')
  t.ok(src.includes('paragraphs: [...HELP.busca.paragraphs, ...searchNotes]'), 'details stay in help')
  t.ok(src.includes("const statusNote = loading ? 'Buscando publicações…' : searchNotes[0] || SHORT.search"), 'loading has a distinct message')
})

test('search distinguishes untouched, searching and no result with clear actions', (t) => {
  const global = read('screens/BuscaGlobal.js')
  const posts = read('screens/Busca.js')
  t.ok(global.includes("drafts.publicacoes.trim() === ''"), 'untouched posts draft has its own state')
  t.ok(global.includes('body={BUSCA_EMPTY.publicacoes} actionLabel={BUSCA_LABEL.publicacoes} onAction={() => inputRef.current?.focus()}'), 'the initial prompt focuses the input')
  t.ok(global.includes("plan('publicacoes', drafts.publicacoes).query === null"), 'invalid input is separate from waiting')
  t.ok(global.includes('<Soft>Buscando publicações…</Soft><SkeletonRow />'), 'debounce wait has loading rows')
  t.ok(global.includes(': postsTimer.current !== null'), 'a cancelled debounce does not pretend to be searching')
  t.ok(global.includes("<View accessibilityLiveRegion='polite'><Soft>Buscando pessoas…</Soft><View style={styles.bleed}><SkeletonRow />"), 'only placeholder rows bleed, the search note keeps the gutter')
  t.ok(global.includes("title='Ninguém encontrado com esse nome.' actionLabel='Limpar' onAction={() => onChangeText('')}"), 'no account results can be cleared')
  t.ok(posts.includes("<View accessible accessibilityLabel='Buscando publicações' accessibilityLiveRegion='polite'"), 'the loading label belongs to an accessible element')
  t.ok(posts.includes("body={SEARCH_EMPTY_BODY} actionLabel='Limpar' onAction={onClear}"), 'no post results can be cleared')
  t.ok(posts.includes("body={loadError} actionLabel='Tentar de novo' onAction={loadFirst} secondaryLabel='Limpar'"), 'post errors offer retry and clear')
  t.ok(global.includes("onClear={() => onChangeText('')}"), 'post clear uses the field edit path')
  const field = read('ui/SearchField.js')
  t.ok(global.includes('inputRef={inputRef}') && field.includes('ref={inputRef}'), 'SearchField forwards inputRef to its TextInput')
  t.ok(field.includes('clear: { minWidth: layout.hit, minHeight: layout.hit'), 'SearchField keeps a layout.hit clear target')
})

test('Momentos rings animate presses and grow with text while announcing the full name', (t) => {
  const src = read('ui/MomentosStrip.js')
  const ring = section(src, 'function Ring (', '// data:')
  t.ok(/<PressScale\s+accessibilityRole='button'\s+accessibilityLabel=\{label\}/.test(ring), 'the animated control owns the full label')
  t.ok(ring.includes('const width = 72 * Math.min(ROW_CAP, Math.max(1, fontScale))'), 'the slot grows at font scale 1.3')
  t.ok(ring.includes('styles.ringItem, { width }'), 'the calculated width reaches the control')
  t.ok(/ringName: \{[^\n]*width: '100%'/.test(src), 'the name uses the enlarged slot')
  t.ok(/ringName: \{ \.\.\.type\.caption,/.test(src), 'ring labels use the caption token')
  t.ok(src.includes("label={'momentos de ' + name}") && src.includes('const name = displayText(whoOf(profile || {}).title)'), 'the full label remains sanitized')
  t.ok(ring.includes('maxFontSizeMultiplier={ROW_CAP}') && src.includes('const ROW_CAP = 1.3'), 'text and slot share the cap')
})

test('Espiadinha chooses a single note and the help for that note', async (t) => {
  const { HELP } = await import('../src/help.js')
  const { PEEK_SHORT_TEXT } = await import('../src/peek.js')
  const src = read('screens/Espiadinha.js')
  const choice = section(src, '  const statusNote =', '  const header =')
  for (const expired of [false, true]) {
    for (const incomplete of [false, true]) {
      for (const skipped of [null, '2 diários indisponíveis']) {
        const result = evaluate(choice + '\nreturn { statusNote, statusHelp }', { expired, meta: { incomplete }, skipped, HELP, PEEK_SHORT_TEXT })
        t.is(result.statusNote, expired ? 'A lista expirou; puxe para atualizar.' : incomplete ? 'A lista pode estar incompleta; puxe para atualizar.' : skipped || PEEK_SHORT_TEXT)
        t.is(result.statusHelp, !expired && !incomplete && skipped ? HELP.ausentes : HELP.espiadinha, 'help follows the visible note')
      }
    }
  }
})

test('Busca chooses one status note while retaining all details in help', async (t) => {
  const { HELP, SHORT } = await import('../src/help.js')
  const { SEARCH_INDEXING_NOTE, SEARCH_INCOMPLETE_NOTE } = await import('../src/topics.js')
  const src = read('screens/Busca.js')
  const choice = section(src, '  const searchNotes =', '  const top =')
  for (const loading of [false, true]) {
    for (const indexing of [false, true]) {
      for (const complete of [false, true]) {
        for (const gone of [null, '2 publicações indisponíveis']) {
          const result = evaluate(choice + '\nreturn { statusNote, searchHelp }', { loading, flags: { indexing, complete }, gone, HELP, SHORT, SEARCH_INDEXING_NOTE, SEARCH_INCOMPLETE_NOTE })
          const notes = [indexing && SEARCH_INDEXING_NOTE, !complete && SEARCH_INCOMPLETE_NOTE, gone].filter(Boolean)
          t.is(result.statusNote, loading ? 'Buscando publicações…' : notes[0] || SHORT.search)
          t.alike(result.searchHelp.paragraphs, [...HELP.busca.paragraphs, ...notes])
        }
      }
    }
  }
})

test('account search choices separate untouched, searching, empty and unverified results', (t) => {
  const src = read('screens/BuscaGlobal.js')
  for (const [kind, phase, hits, unchecked, expected] of [
    ['empty', 'idle', [], 0, [true, false, false]],
    ['name', 'loading', [], 0, [false, true, false]],
    ['name', 'ready', [], 0, [false, false, true]],
    ['name', 'ready', [], 1, [false, false, false]],
    ['name', 'loading', [{}], 0, [false, false, false]],
    ['name', 'ready', [{}], 0, [false, false, false]],
    ['name', 'error', [], 0, [false, false, false]]
  ]) {
    const deps = { cls: { kind }, search: { phase, unchecked }, hits, ready: phase === 'ready' }
    const choices = [
      conditionBefore(src, "<EmptyState icon='gente' title={CATEGORY_LABEL.contas}", deps),
      conditionBefore(src, "<View accessibilityLiveRegion='polite'><Soft>Buscando pessoas…", deps),
      conditionBefore(src, "<EmptyState icon='gente' title='Ninguém encontrado com esse nome.'", deps)
    ]
    t.alike(choices, expected, kind + ', ' + phase + ', hits=' + hits.length + ', unchecked=' + unchecked)
  }
})

test('post search choices distinguish blank, invalid and pending drafts from completed empty reads', async (t) => {
  const { plan } = await import('../src/buscaGlobal.js')
  const global = read('screens/BuscaGlobal.js')
  const draftChoice = section(global, "{drafts.publicacoes.trim() === ''", '\n        <HelpNote')
    .slice(1).replace(/<EmptyState[^\n]+?\/>/g, (markup) => JSON.stringify(markup.includes('SEARCH_INVALID') ? 'invalid' : markup.includes('BUSCA_LABEL.publicacoes') ? 'untouched' : 'paused'))
    .replace(/<View[^\n]+?<\/View>/g, "'searching'").replace(/}$/, '')
  for (const [draft, timer, expected] of [['', null, 'untouched'], ['  ', null, 'untouched'], ['a', null, 'invalid'], ['café', 1, 'searching'], ['café', null, 'paused']]) {
    t.is(evaluate('return ' + draftChoice, { drafts: { publicacoes: draft }, postsTimer: { current: timer }, plan }), expected)
  }
  const src = read('screens/Busca.js')
  const emptyChoice = section(src, '  let empty', '  const reportable')
    .replace(/<EmptyState[^\n]+?\/>/g, (markup) => JSON.stringify(markup.match(/body=({[^}]+}|'[^']*')/)[1]))
    .replace(/<View[^\n]+?<\/View>/g, "'searching'")
  for (const [loadedAt, atEnd, loadError, expected] of [[null, false, '', 'searching'], [1, true, '', '{SEARCH_EMPTY_BODY}'], [1, false, '', '{SEARCH_CONTINUE_BODY}'], [1, true, 'failed', '{loadError}']]) {
    t.is(evaluate(emptyChoice + '\nreturn empty', { notice: null, loadedAt, atEnd, loadError }), expected)
  }
})

test('unavailable and empty states retain scoped titles, short actions and matching help', (t) => {
  const global = read('screens/BuscaGlobal.js')
  t.ok(global.includes('title={BUSCA_NOT_HOSTED_TITLE} body={BUSCA_NOT_HOSTED}'), 'the search title stays unchanged')
  t.ok(global.includes("actionLabel={hosted ? BUSCA_LABEL.contas : 'Digitar código'}"), 'the code action describes focusing the input')
  t.ok(global.includes('body={hosted ? BUSCA_EMPTY.contas : BUSCA_EMPTY_CODE}'), 'the instruction remains in the body')
  const peek = read('screens/Espiadinha.js')
  const unavailable = section(peek, "} else if (notice === 'web-only')", "} else if (notice === 'offline')")
  t.absent(unavailable.includes('Saiba mais') || unavailable.includes('setHelpOpen'), 'unsupported nodes do not offer contradictory help')
  t.ok(unavailable.includes("actionLabel='publicar' onAction={onPublish}"), 'unsupported nodes offer publishing')
  t.ok(/title='Ninguém para espiar ainda'[^\n]+actionLabel='publicar' onAction=\{onPublish\}/.test(peek), 'publishing remains the primary empty action')
  for (const name of ['ARua', 'Espiadinha', 'Busca', 'BuscaGlobal']) {
    t.absent(/(?:actionLabel|secondaryLabel|label)='tentar de novo'/.test(read('screens/' + name + '.js')), name + ' uses the shared retry casing')
  }
})

// Run a discovery screen's own 'seguir' handler (and its helpers) without
// React: the source text, cut at each function's closing brace, in a vm.
function followHandler (screen, helpers, context) {
  const src = read('screens/' + screen + '.js')
  const cut = (marker) => {
    const at = src.indexOf(marker)
    if (at === -1) throw new Error('missing ' + marker + ' in ' + screen)
    return src.slice(at, src.indexOf('\n  }\n', at) + '\n  }\n'.length)
  }
  const body = [...helpers, 'const follow = async (author, name, username) => {'].map(cut).join('')
  return require('node:vm').runInNewContext('(() => {\n' + body + 'return follow\n})()', context)
}

function followHarness (screen, { answer, loadedAt = 1, active = true }) {
  const A = 'a'.repeat(64)
  const h = { A, calls: [], toasts: [], commits: [], dropped: [], marks: [], reconciles: [], reloads: 0, changed: 0 }
  const context = {
    stateRef: { current: { following: new Set(), loadedAt, items: [] } },
    activeRef: { current: active },
    mountedRef: { current: true },
    followsPending: { current: false },
    commit: (patch) => {
      context.stateRef.current = { ...context.stateRef.current, ...patch }
      if (patch.following) h.commits.push([...patch.following])
    },
    request: (method, params) => {
      h.calls.push(method + ' ' + JSON.stringify(params))
      return answer()
    },
    dropFollowed: (author) => h.dropped.push(author),
    markFollow: (key, on) => h.marks.push([key, on]),
    reconcileFollows: (alive) => { h.reconciles.push(alive) },
    loadFollows: () => { h.reloads++ },
    displayText: (s) => s,
    whoOf: (p) => ({ title: p.name }),
    errorText: (err) => (err.uncertain ? 'incerto: pode ter sido aplicado; confira antes de repetir' : err.message),
    onToast: (text) => h.toasts.push(text),
    onFollowsChanged: () => { h.changed++ }
  }
  h.context = context
  h.follow = followHandler(screen, screen === 'Espiadinha' ? ['const rereadFollows = () => {'] : [], context)
  return h
}

test('a failed or uncertain seguir on Espiadinha and Busca reads the follow set again, with one write per press', async (t) => {
  const failures = [new Error('falhou'), Object.assign(new Error('x'), { uncertain: true })]
  for (const screen of ['Espiadinha', 'Busca']) {
    for (const err of failures) {
      let reject
      const h = followHarness(screen, { answer: () => new Promise((resolve, _reject) => { reject = _reject }) })
      const first = h.follow(h.A, 'Bia', 'bia')
      await h.follow(h.A, 'Bia', 'bia')
      t.is(h.calls.length, 1, screen + ': a second press while pending sends nothing')
      reject(err)
      await first
      await new Promise((resolve) => setTimeout(resolve, 5))
      t.alike(h.calls, ['follow.add ' + JSON.stringify({ key: h.A })], screen + ': exactly one follow.add, never resent')
      t.alike(h.toasts, [err.uncertain ? 'incerto: pode ter sido aplicado; confira antes de repetir' : 'falhou'], screen + ': the failure is shown, an uncertain one says it may have worked')
      const reads = screen === 'Espiadinha' ? h.reconciles.length : h.reloads
      t.is(reads, 1, screen + ': the follow set is read again once')
      t.alike(h.dropped, [], screen + ': rows leave only after a success')
      t.alike(h.marks, [], screen + ': the set is not marked on a failure')
      t.is(h.changed, 0, screen + ': no follow change is announced')
      t.alike(h.commits, [[h.A], []], screen + ': pending is set before the request and cleared after')
      if (screen === 'Espiadinha' && h.reconciles.length === 1) {
        t.is(h.reconciles[0](), true, 'the re-read runs while mounted')
        h.context.mountedRef.current = false
        t.is(h.reconciles[0](), false, 'and stops on unmount')
      }
    }
    const ok = followHarness(screen, { answer: () => Promise.resolve({ changed: true }) })
    await ok.follow(ok.A, 'Bia', 'bia')
    t.is(ok.calls.length, 1, screen + ': one write on success')
    t.is(screen === 'Espiadinha' ? ok.reconciles.length : ok.reloads, 0, screen + ': a success reads nothing again')
    t.alike(screen === 'Espiadinha' ? ok.dropped : ok.marks, screen === 'Espiadinha' ? [ok.A] : [[ok.A, true]], screen + ': a success applies the follow')
  }
  for (const [loadedAt, active] of [[null, true], [1, false]]) {
    const h = followHarness('Espiadinha', { answer: () => Promise.reject(new Error('falhou')), loadedAt, active })
    await h.follow(h.A, 'Bia', 'bia')
    t.is(h.calls.length, 1, 'one write')
    t.is(h.reconciles.length, 0, 'a hidden or loading list does not read now')
    t.is(h.context.followsPending.current, true, 'it keeps the read for the next show or first page')
  }
})

// useFollowSet without React: hook slots persist across renders (in call
// order) and state commits are recorded. The hook's own source text runs in
// a vm with the real readFollowKeys; render() re-runs it as React would.
function followSetHarness (answer, readFollowKeys) {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  const at = src.indexOf('export function useFollowSet')
  if (at === -1) throw new Error('missing useFollowSet')
  const body = src.slice(at, src.indexOf('\n}\n', at) + 3).replace('export ', '')
  const h = { commits: [], calls: 0 }
  const slots = []
  let slot = 0
  const keysOf = (v) => [...(v && v.set ? v.set : v)].sort()
  const context = {
    FOLLOW_LIMIT_MAX: 500,
    readFollowKeys,
    useState: (initial) => {
      const i = slot++
      if (!(i in slots)) slots[i] = { value: initial }
      const cell = slots[i]
      return [cell.value, (v) => {
        cell.value = typeof v === 'function' ? v(cell.value) : v
        h.commits.push(keysOf(cell.value))
      }]
    },
    useRef: (current) => {
      const i = slot++
      if (!(i in slots)) slots[i] = { current }
      return slots[i]
    },
    useCallback: (fn) => fn,
    request: (method, params) => {
      h.calls++
      return answer(method, params)
    }
  }
  const hook = require('node:vm').runInNewContext(body + '\nuseFollowSet', context)
  h.render = () => {
    slot = 0
    h.set = hook(context.request)
    return h.set
  }
  h.render()
  return h
}

test('a failed follow set read keeps the shown set and its marks, never a partial one', async (t) => {
  const { readFollowKeys } = await import('../src/follow.js')
  const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(64))
  let mode = 'fail'
  let release
  const h = followSetHarness((method, { offset }) => {
    if (mode === 'fail') return Promise.reject(Object.assign(new Error('x'), { uncertain: true }))
    if (mode === 'slow') {
      mode = 'ok'
      return new Promise((resolve) => { release = () => resolve({ follows: [A], total: 1 }) })
    }
    if (mode === 'partial' && offset > 0) return Promise.reject(new Error('caiu'))
    return Promise.resolve(offset === 0 ? { follows: [A.toUpperCase()], total: 2 } : { follows: [B], total: 2 })
  }, readFollowKeys)
  const shown = () => {
    const f = h.render().follows
    return f === null ? null : [...f].sort()
  }
  const first = await h.set.load()
  t.alike([...first], [], 'a failed first read resolves to an empty set')
  t.alike(h.commits, [], 'and commits nothing (no-store, the safe side)')
  t.is(shown(), null, 'the set stays unknown, so no one shows as a stranger')
  mode = 'ok'
  const good = await h.set.load()
  t.alike([...good].sort(), [A, B], 'a complete paged read replaces the set')
  t.alike(h.commits.at(-1), [A, B])
  h.set.mark(C, true)
  t.alike(h.commits.at(-1), [A, B, C], 'mark adds to the known set')
  for (const failing of ['partial', 'fail']) {
    mode = failing
    const before = h.commits.length
    const got = await h.set.load()
    t.alike([...got], [], failing + ': resolves to an empty set for callers that wait on it')
    t.alike(shown(), [A, B, C], failing + ': the shown set keeps the last good read and its marks')
    t.is(h.commits.length, before, failing + ': commits nothing, so no partial or empty set')
  }
  h.set.mark(A, false)
  t.alike(h.commits.at(-1), [B, C], 'mark keeps working on the kept set')
  mode = 'ok'
  t.alike([...await h.set.load()].sort(), [A, B], 'the next good read replaces it')
  t.alike(shown(), [A, B], 'the new set is shown')
  t.alike(shown(), [A, B], 'and stays shown across renders')
  mode = 'fail'
  let before = h.commits.length
  t.alike([...await h.set.load()], [], 'a failed read resolves empty')
  t.is(h.commits.length, before, 'and commits nothing')
  t.alike(shown(), [A, B], 'the last good set still shows')
  mode = 'ok'
  await h.set.load()
  h.set.mark(C, true)
  mode = 'fail'
  before = h.commits.length
  await h.set.load()
  t.alike(shown(), [A, B, C], 'a failed re-read keeps the set and its marks')
  t.is(h.commits.length, before, 'without a commit')
  h.set.mark(A, false)
  t.alike(shown(), [B, C], 'mark works')
  mode = 'slow'
  const slow = h.set.load()
  release()
  t.alike([...await slow], [A], 'a slow read resolves to what it read')
  t.alike(shown(), [A], 'and is committed when it lands')
  mode = 'fail'
  await h.set.load()
  t.alike(shown(), [A], 'a failure after it keeps it')
  const partial = followSetHarness((method, { offset }) => offset === 0 ? Promise.resolve({ follows: [A], total: 2 }) : Promise.reject(new Error('caiu')), readFollowKeys)
  t.alike([...await partial.set.load()], [], 'a first read that fails on a later page is empty, not partial')
  t.alike(partial.commits, [], 'and commits nothing')
})

test('Espiadinha and Busca track mount for the follow re-read, StrictMode safe', async (t) => {
  for (const screen of ['Espiadinha', 'Busca']) {
    const src = read('screens/' + screen + '.js')
    const at = src.indexOf('const mountedRef = useRef(true)')
    t.ok(at !== -1, screen + ' keeps a mounted ref')
    const block = src.slice(at, src.indexOf('}, [])', at) + '}, [])'.length)
    const effects = []
    const ref = require('node:vm').runInNewContext('(() => {\n' + block + '\nreturn mountedRef\n})()', {
      useRef: (current) => ({ current }),
      useEffect: (fn, deps) => effects.push({ fn, deps })
    })
    t.is(effects.length, 1, screen + ': one effect')
    t.is(JSON.stringify(effects[0].deps), '[]', screen + ': runs on mount only')
    ref.current = false
    const cleanup = effects[0].fn()
    t.is(ref.current, true, screen + ': the effect body marks it mounted (StrictMode remount)')
    t.is(typeof cleanup, 'function', screen + ': with a cleanup')
    if (typeof cleanup === 'function') cleanup()
    t.is(ref.current, false, screen + ': the cleanup marks it unmounted')
  }
  const h = followHarness('Busca', { answer: () => Promise.reject(new Error('falhou')) })
  const press = h.follow(h.A, 'Bia', 'bia')
  h.context.mountedRef.current = false
  await press
  t.is(h.calls.length, 1, 'one write')
  t.is(h.reloads, 0, 'Busca does not read the follow set after unmount')
  t.alike(h.toasts, ['falhou'], 'the failure is still reported')
})
