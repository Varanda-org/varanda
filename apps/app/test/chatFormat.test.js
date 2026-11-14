'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')

const read = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')

test('the composer offers six formats in an initially hidden accessible row', (t) => {
  const src = read('ui/ChatComposer.js')
  t.ok(src.includes('const [formatOpen, setFormatOpen] = useState(false)'))
  t.ok(src.includes("accessibilityLabel='formatação'"))
  t.ok(src.includes('accessibilityState={{ expanded: formatOpen, disabled: !editable }}'))
  t.ok(src.includes('onPress={() => setFormatOpen((v) => !v)}'))
  t.ok(src.includes('>Aa</Text>'))
  t.ok(src.includes('{formatOpen && editable && !recording'))
  for (const [label, marker] of [
    ['Negrito', "'*'"], ['Itálico', "'_'"], ['Riscado', "'~'"],
    ['Código', "'`'"], ['Bloco de código', 'null'], ['Spoiler', "'||'"]
  ]) t.ok(src.includes("['" + label + "', " + marker + ']'), label)
  t.ok(src.includes('Você também pode digitar *negrito*, _itálico_ e `código`'))
  t.ok(src.includes("<ScrollView horizontal keyboardShouldPersistTaps='always'"))
  t.ok(src.includes("accessibilityRole='button'\n                  accessibilityLabel={label}"))
  t.ok(src.includes('onPress={() => pickFormat(marker)}'))
  t.ok(src.includes('formatButton: { minWidth: layout.hit, minHeight: layout.hit,'))
  const pick = src.slice(src.indexOf('const pickFormat ='), src.indexOf('const pickMention ='))
  t.ok(pick.includes('if (!editable) return'))
  t.ok(pick.includes('marker === null\n      ? insertCodeBlock(text, selRef.current)\n      : wrapSelection(text, selRef.current, marker)'))
  t.ok(pick.includes('change(next.text)'))
  t.ok(pick.includes('selRef.current = next.selection') && pick.includes('setForcedSel(next.selection)'))
  t.ok(pick.includes('setCollapsed(next.selection.start === next.selection.end)'))
  t.ok(src.includes('selection={forcedSel || undefined}'))
})

test('format picks restore web focus and selection after rendering', (t) => {
  const src = read('ui/ChatComposer.js')
  const pick = src.slice(src.indexOf('const pickFormat ='), src.indexOf('const pickMention ='))
  const timer = pick.match(/setTimeout\(\(\) => \{([\s\S]*?)\}, 0\)/)
  t.ok(timer, 'restore after rendering')
  if (!timer) return
  t.ok(pick.indexOf('setForcedSel(next.selection)') < pick.indexOf('setTimeout('))
  t.ok(timer[1].includes('const input = inputRef.current'))
  t.ok(timer[1].includes('if (!input) return'))
  t.ok(/try \{[\s\S]*if \(typeof input.focus === 'function'\) input.focus\(\)[\s\S]*if \(typeof input.setSelectionRange === 'function'\) input.setSelectionRange\(next.selection.start, next.selection.end\)[\s\S]*\} catch \{\}/.test(timer[1]))
})

test('format limits allow edits that do not lengthen an oversized draft', (t) => {
  const src = read('ui/ChatComposer.js')
  const pick = src.slice(src.indexOf('const pickFormat ='), src.indexOf('const pickMention ='))
  const guard = "if (next.text.length > text.length && !countAfterInsert(next.text, '', max).allowed)"
  t.ok(pick.includes(guard), 'only a longer draft can hit the format limit')
  t.ok(pick.indexOf(guard) >= 0 && pick.indexOf(guard) < pick.indexOf('change(next.text)'), 'respect the draft limit before changing text')
})

test('the Aa toggle shares the emoji tool size and touch padding', (t) => {
  const src = read('ui/ChatComposer.js')
  const toggle = src.match(/<Pressable\s+accessibilityRole='button'\s+accessibilityLabel='formatação'([\s\S]*?)<\/Pressable>/)
  t.ok(toggle)
  if (!toggle) return
  t.ok(toggle[1].includes('style={({ pressed }) => [styles.tool, pressed && styles.pressed]}'))
  t.ok(toggle[1].includes('hitSlop={(layout.hit - SEND) / 2}'))
  t.absent(src.includes('formatToggle:'), 'no unused toggle style')
})

test('the input cleans pasted TAB and CR and preserves ordinary typing', async (t) => {
  const { cleanPaste } = await import('../src/formatInsert.js')
  const src = read('ui/ChatComposer.js')
  const match = src.match(/const changeText = (\(next\) => \{[\s\S]*?\n {2}\})\n\n {2}const pickFormat/)
  t.ok(match, 'the input has a change handler')
  if (!match) return
  t.ok(src.includes('onChangeText={changeText}'))
  t.ok(match[1].includes('const before = selRef.current'))
  t.ok(match[1].includes('cleanPaste(next.slice(0, rawCaret)).length'), 'map the raw prefix through paste cleaning')
  for (const [previous, raw, expected, caret, selection = null] of [
    ['', 'oi *texto*\n', 'oi *texto*\n', null],
    ['', '\tconst x = 1\r\n\treturn x\r', '  const x = 1\n  return x\n', 25],
    ['', 'ação 😀', 'ação 😀', null],
    ['antes depois', 'antes\t depois', 'antes   depois', 7],
    ['fim', '\r\nfim', '\nfim', 1],
    ['antes fim', 'antes\r\n\tfim', 'antes\n  fim', 8],
    ['😀fim', '😀\rfim', '😀\nfim', 3],
    ['foo', 'foo\tfoo', 'foo  foo', 8, { start: 3, end: 3 }],
    ['hello', 'hello\txo', 'hello  xo', 9, { start: 5, end: 5 }],
    ['xxfooyy', 'xx\tfooyy', 'xx  fooyy', 7, { start: 2, end: 5 }],
    ['hello\nworld', 'hellofoo\r\nworld', 'hellofoo\nworld', 8, { start: 5, end: 5 }],
    ['hello', 'hello\txo', 'hello  xo', 9, { start: 1, end: 1 }],
    ['foo', 'foo\tfoo', 'foo  foo', 8]
  ]) {
    const received = []
    const states = []
    const timers = []
    const placed = []
    const selRef = { current: selection }
    const input = runInNewContext(match[1], {
      text: previous,
      cleanPaste,
      change: (text) => received.push(text),
      selRef,
      setCaret: (value) => states.push(['caret', value]),
      setCollapsed: (value) => states.push(['collapsed', value]),
      setForcedSel: (value) => states.push(['selection', { ...value }]),
      setTimeout: (fn, delay) => timers.push({ fn, delay }),
      inputRef: { current: { focus: () => placed.push('focus'), setSelectionRange: (start, end) => placed.push([start, end]) } }
    })
    input(raw)
    t.alike(received, [expected])
    if (caret === null) {
      t.alike(states, [], 'ordinary typing keeps its selection')
      t.is(timers.length, 0)
      continue
    }
    t.alike({ ...selRef.current }, { start: caret, end: caret })
    t.alike(states, [['caret', caret], ['collapsed', true], ['selection', { start: caret, end: caret }]])
    t.alike(placed, [], 'wait for the cleaned text to render')
    t.is(timers.length, 1)
    t.is(timers[0].delay, 0)
    timers[0].fn()
    t.alike(placed, ['focus', [caret, caret]], 'place the web caret after focus')
  }
})

async function nodePreviews () {
  const { mergeRows } = await import('../src/conversas.js')
  const { lastLine } = await import('../src/groups.js')
  const { previewLine } = await import('../src/dm-screen.js')
  return [
    ['DM inbox', (preview) => mergeRows({ dmConversations: [{ peer: 'peer', preview }] })[0].subtitle],
    ['group inbox', (preview) => mergeRows({ groups: [{ group: 'group', last: { preview, mine: true } }] })[0].subtitle],
    ['community group', (preview) => lastLine({ preview, mine: true })],
    ['DM requests', previewLine]
  ]
}

test('all node-clipped previews strip styles before flattening and hide truncated spoilers', async (t) => {
  for (const [site, preview] of await nodePreviews()) {
    t.is(preview('*forte* _leve_ ~risco~ `código` ||segredo||'), 'forte leve risco código spoiler', site)
    t.is(preview('```js\nconst x = 1\nreturn x\n```'), 'const x = 1', site + ' parses fences before flattening')
    const tail = 'oi ||segredo||'
    const filler = 'x'.repeat(140 - 'oi ||segr'.length - 1) + ' '
    t.is(preview((filler + tail).slice(0, 140)), filler + 'oi spoiler', site + ' hides a cut spoiler')
    for (let cut = 5; cut < tail.length; cut++) {
      const filler = 'x'.repeat(140 - cut - 1) + ' '
      const full = filler + tail
      t.is(preview(full.slice(0, 140)), filler + 'oi spoiler', site + ' cut at ' + cut)
    }
    t.is(preview(null), '', site + ' missing text')
  }
})

test('node previews distinguish complete text from a possible cut by code points', async (t) => {
  for (const [site, preview] of await nodePreviews()) {
    for (const [text, expected] of [
      ['Bom dia *pessoal*', 'Bom dia pessoal'],
      ['`x`', 'x'],
      ['||segredo||', 'spoiler'],
      ['x'.repeat(133) + ' *fim*', 'x'.repeat(133) + ' fim'],
      ['x'.repeat(135) + ' ||se', 'x'.repeat(135) + ' spoiler'],
      ['😀'.repeat(70) + ' *ok*', '😀'.repeat(70) + ' ok']
    ]) t.is(preview(text), expected, site + ' with ' + Array.from(text).length + ' code points')
  }
})

test('all four node preview sites use plainPreview before flattening', (t) => {
  for (const [file, call] of [
    ['conversas.js', 'flat(plainPreview(dm.preview))'],
    ['conversas.js', 'flat(plainPreview(last.preview))'],
    ['groups.js', 'displayText(plainPreview(last.preview).replace('],
    ['dm-screen.js', 'return plainPreview(value).replace(']
  ]) {
    const src = read(file)
    t.ok(src.includes(call), file + ': ' + call)
    t.absent(/plainOf\([^\n]*clipped/.test(src), file + ' delegates clipping detection')
  }
})

test('group replies strip styles and hide spoilers before the 90 code point cut', async (t) => {
  const { replyPreview } = await import('../src/group-screen.js')
  const { quoteText } = await import('../src/chatPreview.js')
  const preview = (text) => quoteText(replyPreview({ replyTo: 'writer:1' }, new Map([['writer:1', { name: 'Ana', text }]])).text)
  t.is(preview('*forte* _leve_ ~risco~ `código` ||segredo||'), 'forte leve risco código spoiler')
  t.is(preview('```js\nconst x = 1\nreturn x\n```'), 'const x = 1')
  t.is(preview('*' + '😀'.repeat(91) + '*'), '😀'.repeat(90), 'strip before clipping, preserve code points')
  t.is(preview('a'.repeat(85) + ' ||' + 'segredo'.repeat(20) + '||'), 'a'.repeat(85) + ' spoi', 'a spoiler crossing the cut stays hidden')
  const src = read('chatPreview.js')
  t.ok(src.indexOf('plainOf(text)') >= 0 && src.indexOf('plainOf(text)') < src.indexOf('.slice(0, 90)'), 'quoteText parses the full text before the app cut')
})

test('ReplyPreview uses one plain quote for display and accessibility', async (t) => {
  const { quoteText } = await import('../src/chatPreview.js')
  const src = read('ui/ReplyPreview.js')
  t.ok(src.includes("import { quoteText } from '../chatPreview'"))
  t.ok(src.includes('const shownText = quoteText(text)'))
  t.ok(src.includes('<Text style={styles.text} numberOfLines={lines}>{shownText}</Text>'))
  t.ok(src.includes("accessibilityLabel={(shownName ? shownName + ': ' : '') + shownText}"))
  // Execute the component's displayed expression without loading React Native.
  const match = src.match(/const shownText = ([^\n]+)/)
  t.ok(match)
  if (!match) return
  const preview = runInNewContext('(text) => ' + match[1], { quoteText })
  for (const [text, expected] of [
    ['*forte* _leve_ ~risco~ `código` ||segredo||', 'forte leve risco código spoiler'],
    ['```js\nconst x = 1\nreturn x\n```', 'const x = 1'],
    ['oi ||segredo||', 'oi spoiler'],
    ['oi\u202e\ud800', 'oi\ufffd\ufffd'],
    [null, ''],
    [42, ''],
    ['Oi\n\nTudo bem?', 'Oi Tudo bem?'],
    ['um\rdois\u2028três\u2029quatro', 'um dois três quatro'],
    ['a'.repeat(89) + '\u202e' + 'fim', 'a'.repeat(89) + '\ufffd'],
    ['😀'.repeat(91), '😀'.repeat(90)]
  ]) t.is(preview(text), expected)
})

test('Aa shows only while focused or open, and the mic is a bare ink icon with haptics', (t) => {
  const src = read('ui/ChatComposer.js')
  t.ok(src.includes('{reached || formatOpen'))
  t.absent(src.includes('{focused || formatOpen'), 'blur must not hide Aa')
  t.ok(src.includes('onFocus={() => { setFocused(true); setReached(true) }}'))
  t.absent(/setReached\(false\)/.test(src), 'the latch never resets')
  t.ok(src.includes("<Icon name='microfone' size={20} color={colors.ink} />"))
  t.ok(src.includes("    tap('select')\n    update({ ...r, phase: 'recording'"))
  t.ok(src.includes("if (r.phase === 'recording') tap('warn')"))
})
