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
