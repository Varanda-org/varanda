'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')

function evaluate (source, deps = {}) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), source)(...Object.values(deps))
}

test('settings group every row and keep the existing advanced toggle last', (t) => {
  const src = read('screens/Ajustes.js')
  const headings = ['Perfil e conta', 'Privacidade e segurança', 'Aparência e avisos']
  const positions = headings.map((heading) => src.indexOf('<SectionHeader>' + heading + '</SectionHeader>'))
  t.ok(positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1])), 'three ordered groups')
  t.ok(positions.every((at) => at >= 0) && src.indexOf("label='Avançado'") > positions[2] && !src.includes('<SectionHeader>Avançado'), 'existing advanced row follows the named groups')
  const profile = src.slice(positions[0], positions[1])
  const privacy = src.slice(positions[1], positions[2])
  const appearance = src.slice(positions[2], src.indexOf("label='Avançado'"))
  const expected = [
    ["'Editar perfil'", "() => { setSaved(''); onNavigate('perfil') }"],
    ["'Conta e @nome'", "() => onNavigate('conta')"],
    ["'Passkeys e recuperação'", "() => onNavigate('passkeys')"],
    ["'Trocar o celular'", "() => { setSaved(''); onNavigate('telefone') }"],
    ["'Recorrer de um bloqueio'", "() => onNavigate('recurso')"],
    ['{BLOCK_TEXTS.listTitle}', "() => onNavigate('bloqueados')"],
    ["'Convidar pessoas'", "() => onNavigate('convites')"],
    ["'Páginas'", 'openPaginas'],
    ["'Termos e privacidade'", "() => onNavigate('termos')"],
    ["'Aparência'", "() => onNavigate('aparencia')"],
    ['{PUSH_LABEL}', '() => { pushStore.togglePush({ node, member }) }'],
    ["'Guardar dados neste aparelho'", 'doPersist'],
    ["'Instalar o app'", "() => onNavigate('instalar')"],
    ['{PREVIEW_PREF_LABEL}', 'togglePreviews'],
    ["'Avançado'", '() => setAdvanced((v) => !v)'],
    ["'Conexão'", "() => onNavigate('conexao')"],
    ["'Sincronização'", "() => onNavigate('sincronizar')"],
    ["'Identidade técnica'", "() => onNavigate('identidade')"],
    ["'Recomeçar'", "() => { reset.clearError(); setConfirm(confirm === 'recomecar' ? null : 'recomecar') }"],
    ["'Sair'", "() => { exit.clearError(); setConfirm(confirm === 'sair' ? null : 'sair') }"],
    ["'Excluir conta'", "() => { setConfirm(null); onNavigate('excluir') }"],
    ['{MODE_LABELS[m]}', '() => setMode(m)']
  ]
  const rows = src.match(/<Item\b[\s\S]*?\/>/g) || []
  t.is(rows.length, expected.length, 'every HEAD row, including the appearance choice')
  for (const [label, handler] of expected) {
    const row = rows.find((row) => row.includes('label=' + label))
    t.ok(row && row.includes('onPress={' + handler + '}'), label + ' keeps its HEAD handler')
  }
  t.ok(profile.includes("label='Editar perfil'") && privacy.includes("label='Passkeys e recuperação'") && appearance.includes("label='Aparência'"), 'rows follow their subject')
  t.ok(src.indexOf("label='Sair'") < src.indexOf("label='Avançado'") && src.indexOf("label='Sair'") < src.indexOf("label='Recomeçar'") && src.indexOf("label='Excluir conta'") > src.indexOf("label='Sair'") && src.indexOf("label='Excluir conta'") < src.indexOf("label='Avançado'"), 'account exit rows precede the last advanced group in HEAD order')
  for (const first of ["first icon='shield' label='Passkeys", "first={!(account && unlocked)} icon='phone'", "first={!(account && unlocked) && !showChangePhone} icon='shield'", "first={!account && !showChangePhone} icon='bloquear'", "first={!account && !showChangePhone && !hosted} icon='file-text'"]) {
    t.ok(privacy.includes(first), 'first visible privacy row has no divider: ' + first)
  }
})

test('settings notes have titles and version details are separate accessible items', (t) => {
  const src = read('screens/Ajustes.js')
  const notes = src.slice(src.indexOf('<View style={styles.notes}>'), src.indexOf('            {unlocked\n', src.indexOf('<View style={styles.notes}>')))
  for (const title of ['Prévia de links', 'Avisos neste aparelho', 'Dados neste aparelho']) {
    t.ok(notes.includes('<SectionHeader>' + title + '</SectionHeader>'), title + ' belongs to the appearance group')
  }
  t.ok(/<\/View>\s*<\/View>\s*$/.test(notes) && src.includes('advanced: { marginTop: space.lg }'), 'notes close inside their group and advanced has normal spacing')
  const footer = src.slice(src.indexOf('<View style={styles.version}'), src.indexOf('</Page>'))
  t.is((footer.match(/aria-live=/g) || []).length, 1, 'one web live region for the footer')
  t.absent(footer.includes('accessibilityLiveRegion='), 'no per-line native live region')
  const region = footer.match(/aria-live=\{([^}]+)\}/)
  const effect = src.slice(src.indexOf('const [versionNote, setVersionNote]')).match(/useEffect\(\(\) => \{([^]*?)\}, \[versionNote\]\)/)
  t.ok(region && effect, 'footer region and copy announcement effect exist')
  if (region && effect) {
    for (const os of ['android', 'ios', 'web']) {
      for (const versionNote of ['', 'Versão copiada.']) {
        const spoken = []
        const Platform = { OS: os }
        evaluate(effect[1], { Platform, versionNote, AccessibilityInfo: { announceForAccessibility: (text) => spoken.push(text) } })
        t.alike(spoken, os !== 'web' && versionNote ? [versionNote] : [], os + ': only native announces a nonempty copy note')
        t.is(evaluate('return ' + region[1], { Platform }), os === 'web' ? 'polite' : undefined, os + ': only web has a live region')
      }
    }
  }
  t.ok(src.includes('[lines.appLine, lines.serverLine, versionNote].filter(Boolean).map(') && src.includes('accessibilityLabel={line}') && src.includes('onPress={copyVersion}'), 'each version line retains its copy action')
})

test('long moment captions expand, pause and resume without changing navigation', (t) => {
  const src = read('screens/Momentos.js')
  t.ok(src.includes('captionLayout({ max: captionMax, fontScale: win.fontScale, lineHeight: type.postText.lineHeight, hit: layout.hit, height: captionHeight })') && src.includes('{captionLong'), 'control uses measured caption geometry')
  t.ok(src.includes("accessibilityLabel={captionExpanded ? 'recolher a legenda' : 'mostrar a legenda inteira'}") && src.includes('accessibilityState={{ expanded: captionExpanded }}'), 'control exposes its action and state')
  t.ok(src.includes('onPress={() => setCaptionExpanded((value) => !value)}') && /const running = [^\n]+&& !captionExpanded/.test(src), 'toggle pauses and resumes through caption state alone')
  const step = src.slice(src.indexOf('const step = useCallback'), src.indexOf('\n  }, [', src.indexOf('const step = useCallback')))
  t.ok(step.includes('setCaptionExpanded(false)') && !step.includes('setHeld(false)'), 'stepping clears the caption pause without clearing a held press')
  t.ok(src.includes('captionExpanded ? captionExpandedHeight : captionCollapsedHeight'), 'expanded clip uses the available room')
  t.ok(/if \(!captionExpanded\) \{\s*captionOffsetRef.current = 0\s*if \(captionScrollRef.current\) captionScrollRef.current.scrollTo\(\{ y: 0, animated: false \}\)/.test(src), 'collapse resets the pull guard without waiting for a scroll event')
  t.ok(src.includes("text: { ...type.postText, color: '#ffffff', ...TEXT_SHADOW }") && !src.includes('includeFontPadding: false'), 'caption preserves the viewer text style')
  t.ok(src.includes('scrollEnabled={captionScrolls}') && src.includes('style={[styles.caption, { maxHeight: captionMax }]}'), 'the caption keeps its capped scroll container')
  t.ok((src.match(/<ActivityIndicator color=\{colors.ink\}/g) || []).length === 2, 'both loading states use the viewer theme')
})

test('composer announces only threshold crossings, including pasted text', (t) => {
  const src = read('screens/Publicar.js')
  const match = src.match(/export function counterAnnouncement \(previous, count, limit\) \{[\s\S]*?\n\}/)
  t.ok(match, 'threshold helper exists')
  t.ok(src.includes('useCounterAnnouncement(open && momentMode, momentCount, MOMENT_TEXT_MAX)') && src.includes('useCounterAnnouncement(open && !momentMode, len, MAX_TEXT)'), 'both counters use the threshold hook')
  t.ok(src.includes("accessibilityLabel={momentCount + ' de ' + MOMENT_TEXT_MAX + ' caracteres'}") && src.includes("accessibilityLabel={len + ' de ' + MAX_TEXT + ' caracteres'}"), 'focus reads the current count and the configured limit')
  t.is((src.match(/accessibilityLiveRegion='none'/g) || []).length, 2, 'neither counter announces every letter')
  t.ok(src.includes("typeof AccessibilityInfo.announceForAccessibilityWithOptions === 'function'") && src.includes('AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true })'), 'threshold reaches the screen reader')
  t.ok((src.match(/accessibilityLiveRegion='polite' aria-live='polite'/g) || []).length === 2, 'both web counters have a polite live region')
  if (!match) return
  const announce = new Function(match[0].replace('export ', '') + '\nreturn counterAnnouncement')() // eslint-disable-line no-new-func
  for (const limit of [200, 1000]) {
    for (const count of [1, 20, limit - 21]) t.is(announce(count - 1, count, limit), '', 'ordinary typing stays quiet')
    t.is(announce(limit - 21, limit - 20, limit), 'Restam 20 caracteres', 'twenty remaining')
    t.is(announce(0, limit - 5, limit), 'Restam 5 caracteres', 'paste crosses warning with the actual remainder')
    t.is(announce(limit - 20, limit - 19, limit), '', 'no repeated warning')
    t.is(announce(limit - 1, limit, limit), 'Limite de caracteres atingido', 'zero remaining')
    t.is(announce(0, limit + 10, limit), 'Limite de caracteres atingido', 'paste across both thresholds announces only the limit')
    t.is(announce(limit, limit + 1, limit), '', 'over-limit typing stays quiet')
    t.is(announce(limit, limit - 1, limit), '', 'deletion stays quiet')
  }
})

test('composer toolbar is revealed on focus and layout, with photo action and press feedback', (t) => {
  const src = read('screens/Publicar.js')
  t.ok(src.includes('focusRef.current = true; defer()') && /m.current.tailBottom = [^\n]+\n\s+defer\(\)/.test(src) && src.includes('autoFocus'), 'focus and toolbar measurements defer keyboard-aware reveal')
  const toolbar = src.slice(src.indexOf('<View ref={postView.tailRef}'), src.indexOf('<EmojiPicker'))
  t.ok(toolbar.includes("accessibilityLabel='Adicionar foto'") && (toolbar.match(/<PressScale/g) || []).length === 2, 'photo and emoji buttons use press feedback')
  t.ok(src.includes('momentBody: { gap: space.md') && src.includes('paddingVertical: space.sm'), 'composer spacing uses tokens')
})

test('intro preserves shared buttons and the top-right skip action', (t) => {
  const intro = read('screens/Introducao.js')
  t.ok(intro.includes('<Btn block large label={index === last ? START_LABEL : NEXT_LABEL} onPress={index === last ? finish : () => goTo(index + 1)} />') && intro.includes('<StepLink label={BACK_LABEL} onPress={() => goTo(index - 1)} />'), 'next and back keep the shared buttons and handlers')
  t.ok(intro.includes("<Pressable accessibilityRole='button' onPress={finish} hitSlop={8} style={({ pressed }) => [styles.skip, pressed && styles.pressed]}>") && intro.includes('<Text style={styles.skipText}>{SKIP_LABEL}</Text>'), 'Pular keeps its original button and handler')
  t.ok(/skip: \{[^\n]*minHeight: layout.hit, minWidth: layout.hit/.test(intro) && read('ui/theme.js').includes('hit: 44'), 'both skip touch dimensions are 44 points')
  t.ok(intro.includes("alignItems: 'flex-end'") && intro.includes("skipText: { fontSize: 15, fontWeight: '700', color: colors.soft }"), 'skip stays at the top right with its original text style')
  t.ok(intro.includes('paddingHorizontal: space.xl, paddingBottom: space.xl, gap: 20'), 'intro spacing preserves the footer gap')
  t.absent(intro.includes('PressScale'), 'no hand-rolled button replacements')
})

test('caption geometry reserves a toggle only when three scaled lines and its target fit', (t) => {
  const src = read('screens/Momentos.js')
  const match = src.match(/export function captionLayout \([^]*?\n\}/)
  const scroll = src.match(/const captionScrolls = ([^\n]+)/)
  t.ok(match && scroll, 'caption geometry and actual scroll condition exist')
  if (!match || !scroll) return
  const geometry = evaluate(match[0].replace('export ', '') + '\nreturn captionLayout')
  const scrolls = (max, height, long, expanded) => evaluate('return ' + scroll[1], { captionMax: max, captionHeight: height, captionLong: long, captionExpanded: expanded, layout: { hit: 44 } })
  for (const fontScale of [1, 1.5]) {
    const floor = geometry({ max: 72, fontScale, lineHeight: 21, hit: 44, height: 126 })
    t.alike(floor, { collapsedHeight: 72, expandedHeight: 72, long: false }, 'floor keeps the full cap at scale ' + fontScale)
    t.is(scrolls(72, 126, floor.long, false), true, 'floor scrolls without expansion at scale ' + fontScale)
    const roomy = geometry({ max: 276, fontScale, lineHeight: 21, hit: 44, height: 315 })
    t.alike(roomy, { collapsedHeight: 63 * fontScale, expandedHeight: 232, long: true }, 'roomy long text has a three-line clip and an expandable area')
    t.is(scrolls(276, 315, roomy.long, false), false, 'collapsed text does not scroll')
    t.is(scrolls(276, 315, roomy.long, true), true, 'expanded overflow scrolls')
    const short = geometry({ max: 276, fontScale, lineHeight: 21, hit: 44, height: 63 * fontScale })
    t.alike(short, { collapsedHeight: 276, expandedHeight: 276, long: false }, 'three lines or less need no toggle')
    t.is(scrolls(276, 63 * fontScale, short.long, false), false, 'short text does not scroll')
    const boundary = geometry({ max: 63 * fontScale + 44, fontScale, lineHeight: 21, hit: 44, height: 315 })
    t.alike(boundary, { collapsedHeight: 63 * fontScale, expandedHeight: 63 * fontScale, long: true }, 'exactly three scaled lines plus the target fits')
  }
})

test('composer web announcement effect clears stale thresholds', (t) => {
  const src = read('screens/Publicar.js')
  const helper = src.match(/export function counterAnnouncement \([^]*?\n\}/)
  const effect = src.slice(src.indexOf('function useCounterAnnouncement')).match(/useEffect\(\(\) => \{([^]*?)\}, \[active, count, limit\]\)/)
  t.ok(helper && effect, 'real counter helper and effect are available')
  if (!helper || !effect) return
  const counterAnnouncement = evaluate(helper[0].replace('export ', '') + '\nreturn counterAnnouncement')
  for (const limit of [200, 1000]) {
    let announcement = ''
    const previous = { current: 0 }
    const update = (count, active = true) => evaluate(effect[1], {
      active,
      count,
      limit,
      previous,
      counterAnnouncement,
      AccessibilityInfo: {},
      setAnnouncement: (text) => { announcement = text }
    })
    update(limit - 20)
    t.is(announcement, 'Restam 20 caracteres', '20 left sets the web region')
    update(limit - 19)
    t.is(announcement, '', 'leaving 20 left clears the region')
    update(limit)
    t.is(announcement, 'Limite de caracteres atingido', '0 left sets the web region')
    update(limit - 1)
    t.is(announcement, '', 'leaving 0 left clears the region')
    update(limit)
    t.is(announcement, 'Limite de caracteres atingido', 'returning to 0 announces again')
    update(limit, false)
    t.is(announcement, '', 'closing the composer clears the region')
  }
})
