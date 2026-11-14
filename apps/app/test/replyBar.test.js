'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const src = read('ui/ReplyBar.js')
const publicar = read('screens/Publicar.js')
const app = read('../App.js')

function between (source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
}

// Execute the actual handlers and useAction lock without loading native UI.
function handlers (onSend, onExpand = async () => false, off = false) {
  let text = 'resposta'
  const actionSource = between(read('ui/index.js'), 'export function useAction () {', '// Date.now()').replace('export ', '')
  const useAction = new Function('useState', 'useRef', 'useCallback', 'errorText', actionSource + '\nreturn useAction') // eslint-disable-line no-new-func
  const action = useAction(() => [false, () => {}], (value) => ({ current: value }), (fn) => fn, (err) => err.message)()
  const code = between(src, '  const send = async () => {', '  const grow = (event) => {')
  const build = new Function('off', 'text', 'action', 'onSend', 'onExpand', 'setText', code + '\nreturn { send, expand }') // eslint-disable-line no-new-func
  return {
    ...build(off, text, action, onSend, onExpand, (next) => { text = typeof next === 'function' ? next(text) : next }),
    text: () => text,
    change: (value) => { text = value }
  }
}

test('ReplyBar pins accessible copy, theme, capped text and keyboard handling', (t) => {
  for (const text of ['Escreva uma resposta', 'cancelar resposta', 'Responder', 'abrir editor completo']) t.ok(src.includes(text), text)
  t.ok(src.includes("accessibilityLabel='cancelar resposta'"))
  t.ok(src.includes("accessibilityLabel='abrir editor completo'"))
  t.ok(src.includes("<Pill label='Responder'"))
  const line = between(src, '<View style={styles.line}>', '\n      </View>')
  t.ok(line.includes('<TextInput') && line.includes("<Pill label='Responder'"), 'the field and the send share one line')
  t.ok(line.indexOf('<TextInput') < line.indexOf("<Pill label='Responder'"))
  t.ok(line.includes("accessibilityLabel='abrir editor completo'"), 'expand stays on that line')
  t.absent(line.includes('cancelar resposta'), 'cancel stays off the field line')
  t.absent(line.includes('{length}/1000'), 'the counter sits under the line, so the field keeps its width at large text')
  t.ok(src.includes("counter: { ...type.counter, color: colors.soft, alignSelf: 'flex-end' }"))
  t.ok(src.indexOf('<View style={styles.target}>') < src.indexOf('<View style={styles.line}>'))
  t.ok(src.includes("line: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }"))
  t.absent(src.includes('styles.actions'), 'no second row of actions')
  t.ok(src.includes("import { replyChip } from '../threadRows'"))
  t.ok(src.includes('{replyChip(target)}'))
  t.ok(src.includes("icon='fechar' accessibilityLabel='cancelar resposta'"))
  t.ok(src.includes('displayText(note)'))
  t.absent(src.includes('KeyboardAvoidingView'), 'the bar never pads itself for the keyboard')
  const conversa = read('screens/Conversa.js')
  t.ok(conversa.includes("<KeyboardAvoidingView style={styles.flex} behavior='padding' enabled={avoidKeyboard}>"), 'Conversa pads its fixed-height root, as Mensagem does')
  t.ok(conversa.includes('const avoidKeyboard = useKeyboardAvoidEnabled()'), 'Android pads only while the keyboard is open')
  t.ok(conversa.includes('paddingBottom: keyboardOpen ? 8 : Math.max(8, insets.bottom)') && conversa.includes('const keyboardOpen = useKeyboardOpen()'), 'no inset band between the bar and an open keyboard')
  t.ok(read('ui/keyboardAvoid.js').includes("ios ? 'keyboardWillShow' : 'keyboardDidShow'"), 'iOS hears the keyboard before it moves, Android after')
  t.ok(conversa.includes('{full || sending\n'), 'a send that outlives the connection keeps its bar, so a sent reply never comes back as a draft')
  t.ok(src.includes('4 * LINE_HEIGHT * Math.min(fontScale, TEXT_CAP)'))
  t.ok(src.includes('onContentSizeChange={grow}'))
  t.ok(src.includes('length >= 900'))
  t.ok(src.includes('{length}/1000'))
  t.ok(src.includes('const length = [...text].length'))
  t.ok(src.includes('maxFontSizeMultiplier={TEXT_CAP}'))
  t.ok(src.includes('inputRef.current.focus()'))
  t.ok(src.includes('}, [focusSignal])'))
  t.ok(src.includes('const off = busy || disabled || action.pending'))
  t.ok(src.includes('editable={!off}'))
  t.absent(src.includes('Platform.OS'))
  t.absent(/#[\da-f]{3,8}\b/i.test(src))
  t.absent(src.includes(String.fromCodePoint(0x2014)))
})

test('only true send success clears the unchanged draft', async (t) => {
  for (const value of [true, false, null, undefined, {}, 'true']) {
    const h = handlers(async (text) => { t.is(text, 'resposta'); return value })
    await h.send()
    t.is(h.text(), value === true ? '' : 'resposta')
  }
  const failed = handlers(async () => { throw new Error('falhou') })
  await failed.send()
  t.is(failed.text(), 'resposta')
  const changed = handlers(async () => { changed.change('novo rascunho'); return true })
  await changed.send()
  t.is(changed.text(), 'novo rascunho')
})

test('useAction prevents two sends and an expansion during the same flight', async (t) => {
  let release
  let calls = 0
  let expands = 0
  const h = handlers(() => { calls++; return new Promise((resolve) => { release = resolve }) }, async () => { expands++; return true })
  const first = h.send()
  await h.send()
  await h.expand()
  t.is(calls, 1)
  t.is(expands, 0)
  t.is(h.text(), 'resposta')
  release(true)
  await first
  t.is(h.text(), '')
  t.ok(src.includes('const action = useAction()'))
  t.ok(src.includes('await action.run(() => onSend(sent))'))
})

test('expansion passes the draft, clears it only on acceptance and respects disabled', async (t) => {
  const accepted = handlers(async () => false, async (draft) => { t.is(draft, 'resposta'); return true })
  await accepted.expand()
  t.is(accepted.text(), '')
  const changed = handlers(async () => false, async () => { changed.change('novo rascunho'); return true })
  await changed.expand()
  t.is(changed.text(), 'novo rascunho')
  const h = handlers(async () => true, async (draft) => { t.is(draft, 'resposta'); return false })
  const result = await h.expand()
  t.is(result.value, false)
  t.is(h.text(), 'resposta')
  const failure = handlers(async () => true, async () => { throw new Error('falhou') })
  await failure.expand()
  t.is(failure.text(), 'resposta')
  let calls = 0
  const blocked = handlers(async () => { calls++; return true }, async () => { calls++; return true }, true)
  await blocked.send()
  await blocked.expand()
  t.is(calls, 0)
})

function handoff (onReplyDraft = () => {}) {
  let replyDrafts = new Set()
  const replyDraftsRef = { current: replyDrafts }
  const results = []
  const settleSource = between(publicar, '  const settleReplyDraft =', '\n  // True while')
  const pendingSource = between(publicar, '  const hasReplyDraft =', '  const settleReplyDraft =')
  const conflictSource = between(publicar, '  const replyDraftConflict =', '\n  useEffect')
  const seedSource = between(publicar, '    if (!replyDraftPending)', '\n  }, [replyDraftPending')
  const keepSource = between(publicar, '    const keepDraft =', '    const useReplyDraft =')
  const acceptSource = between(publicar, '    const useReplyDraft =', '    return (\n      <Sheet open={open}')
  const build = new Function('reply', 'open', 'held', 'hasMedia', 'text', 'replyDrafts', 'replyDraftsRef', 'setReplyDrafts', 'onReplyDraft', 'setText', 'onClearReply', 'onClose', 'genRef', 'removeItems', 'liveRef', // eslint-disable-line no-new-func
    [pendingSource, conflictSource, settleSource, keepSource, acceptSource].join('\n') +
    '\nreturn { pending: replyDraftPending, conflict: replyDraftConflict, keepDraft, useReplyDraft, seed: () => {' + seedSource + '} }')
  const state = { text: '', clears: 0, closes: 0, removed: [], genRef: { current: 0 } }
  const render = (reply, { open = true, held = false, hasMedia = false } = {}) => build(reply, open, held, hasMedia, state.text, replyDrafts, replyDraftsRef,
    (v) => { replyDrafts = v }, (v) => { results.push(v); onReplyDraft(v) }, (v) => { state.text = v },
    () => { state.clears++ }, () => { state.closes++ }, state.genRef, (ids) => state.removed.push(...ids), { current: new Set([1]) })
  return { render, state, results }
}

test('draft handoff prompts only when there is a draft to lose', (t) => {
  const reply = { ref: 'target', draft: 'resposta', handoff: 1 }
  for (const [text, options, conflict] of [
    ['', {}, false], ['resposta', {}, false], ['antigo', {}, true],
    ['', { held: true }, true], ['', { hasMedia: true }, true]
  ]) {
    const h = handoff()
    h.state.text = text
    const editor = h.render(reply, options)
    t.is(!!editor.conflict, conflict)
    editor.seed()
    t.is(h.state.text, conflict ? text : reply.draft)
    t.alike(h.results, options.held ? [false] : conflict ? [] : [true])
  }
  t.ok(publicar.includes('if (replyDraftConflict) {'))
  t.ok(publicar.includes('const hasMedia = items.length > 0'))
})

test('handoff serials distinguish identical drafts and preserve settled targets', (t) => {
  const h = handoff()
  const reply = { ref: 'target', draft: 'resposta', handoff: 1 }
  const first = h.render(reply)
  first.seed()
  first.seed()
  t.alike(h.results, [true], 'replayed effects settle only once')
  for (const text of ['', 'minha edição']) {
    h.state.text = text
    t.absent(h.render(reply, { open: false }).pending)
    const reopened = h.render({ ...reply })
    t.absent(reopened.pending)
    reopened.seed()
    t.is(h.state.text, text)
    t.alike(h.results, [true])
  }
  const repeated = h.render({ ...reply, handoff: 2 })
  t.ok(repeated.pending, 'the same text and ref have a new decision without a null render')
  t.ok(repeated.conflict)
  repeated.keepDraft()
  t.alike(h.results, [true, false])
  t.absent(h.render(reply).pending, 'restoring the prior target cannot seed it again')
  t.absent(h.render(null).pending)
  t.absent(h.render({ ref: reply.ref }).pending)
})

test('keeping a conflict preserves an in-flight send or an accepted reply to the same ref', (t) => {
  for (const label of ['Você tem um rascunho não publicado.', 'Usar a resposta', 'Manter o rascunho']) t.ok(publicar.includes(label))
  t.ok(publicar.includes('<Sheet open={open} onClose={keepDraft} grabber>'), 'every dismissal uses keepDraft')
  for (const mode of ['plain', 'held', 'same-ref', 'other-ref']) {
    const h = handoff()
    const reply = { ref: 'target', draft: 'resposta', handoff: 1 }
    if (mode.endsWith('ref')) {
      h.render(reply).seed()
    }
    h.state.text = 'meu texto'
    const next = { ref: mode === 'other-ref' ? 'other' : reply.ref, draft: 'nova resposta', handoff: 2 }
    const editor = h.render(next, { held: mode === 'held', hasMedia: true })
    t.is(editor.keepDraft(), false)
    editor.keepDraft()
    t.is(h.state.text, 'meu texto')
    t.alike(h.state.removed, [])
    t.is(h.state.genRef.current, 0)
    t.is(h.state.clears, 0)
    t.is(h.state.closes, 0)
    t.alike(h.results, mode.endsWith('ref') ? [true, false] : [false])
    t.absent(h.render(next).pending, 'declining returns to the editor')
    if (mode === 'same-ref') {
      t.absent(h.render(reply).pending, 'a previously settled handoff stays settled')
    }
  }
})

test('accepting a conflict replaces attachments and text only when not held', (t) => {
  const h = handoff()
  const reply = { ref: 'target', draft: 'nova resposta', handoff: 2 }
  h.state.text = 'antigo'
  h.render(reply, { held: true }).useReplyDraft()
  t.is(h.state.text, 'antigo')
  t.alike(h.results, [])
  h.render(reply).useReplyDraft()
  t.is(h.state.text, reply.draft)
  t.alike(h.results, [true])
  t.alike(h.state.removed, [1])
  t.absent(h.render(reply).pending)
})

test('ReplyBar restores an optional draft and reports edits and clears to its owner', (t) => {
  t.ok(src.includes("draft = '', onDraftChange"))
  t.ok(src.includes('const [text, setText] = useState(draft)'))
  const start = src.indexOf('  useEffect(() => {\n    if (typeof onDraftChange')
  t.ok(start >= 0)
  const code = src.slice(start, src.indexOf('\n\n', start))
  const run = new Function('useEffect', 'text', 'onDraftChange', code) // eslint-disable-line no-new-func
  const seen = []
  for (const text of ['rascunho', 'edição', '']) run((effect) => effect(), text, (draft) => seen.push(draft))
  t.alike(seen, ['rascunho', 'edição', ''])
  t.execution(() => run((effect) => effect(), 'rascunho', undefined), 'the callback stays optional')
})

function shell (composer) {
  const state = { composer, pushed: [], signal: null, renders: [] }
  const context = {
    composer,
    node: { hosted: true, online: true },
    actingAs: { get: () => ({ kind: 'member' }) },
    useCallback: (fn) => fn,
    replyDraftResolve: { current: null },
    replyDraftStash: { current: null },
    replyHandoffSerial: { current: 0 },
    setComposer: (value) => {
      state.composer = typeof value === 'function' ? value(state.composer) : value
      context.composer = state.composer
      state.renders.push(state.composer)
    },
    setComposeSignal: (update) => { state.signal = update(state.signal) },
    pushScreen: (entry) => state.pushed.push(entry)
  }
  const build = (code, name) => new Function(...Object.keys(context), code + '\nreturn ' + name)(...Object.values(context)) // eslint-disable-line no-new-func
  context.settleReplyDraft = build(between(app, '  const settleReplyDraft =', '\n  useEffect'), 'settleReplyDraft')
  const start = (reply) => build(between(app, '  const startReply =', '  const onPublished ='), 'startReply')(reply)
  const dismiss = (locked = false) => {
    context.locked = locked
    context.useEffect = (fn) => fn()
    build(between(app, '  useEffect(() => {\n    if (!composer.open', '  useEffect(() => () => {'), 'undefined')
  }
  return { state, context, start, dismiss }
}

test('App handoffs restore the exact parked reply and quote on every decline', async (t) => {
  const target = { ref: 'R', draft: 'abc' }
  for (const saved of [
    { reply: null, quote: null },
    { reply: { ...target, handoff: 8 }, quote: null },
    { reply: { ref: 'other', draft: 'guardado', handoff: 9 }, quote: null },
    { reply: null, quote: { ref: 'quote' } }
  ]) {
    for (const close of [false, true]) {
      const h = shell({ open: false, ...saved })
      const promise = h.start({ ...target, draft: 'xyz' })
      t.is(h.state.renders.length, 1)
      t.is(h.state.composer.reply.ref, target.ref, 'no null reply render')
      t.alike(h.context.replyDraftStash.current, saved)
      if (close) {
        h.context.setComposer((c) => ({ ...c, open: false }))
        h.dismiss()
      } else h.context.settleReplyDraft(false)
      t.is(await promise, false)
      t.is(h.state.composer.reply, saved.reply)
      t.is(h.state.composer.quote, saved.quote)
      t.is(h.context.replyDraftStash.current, null)
    }
  }
  const draftPath = between(app, "    if (typeof r.draft === 'string')", '  const onPublished =')
  t.absent(draftPath.includes('reply: null'))
  const keep = between(publicar, '    const keepDraft =', '    const useReplyDraft =')
  t.absent(keep.includes('onClearReply'))
})

test('App serials cover repeated drafts and accept drops the parked context', async (t) => {
  const h = shell({ open: false, reply: null, quote: { ref: 'quote' } })
  const draft = { ref: 'R', draft: 'abc' }
  const first = h.start(draft)
  const serial = h.state.composer.reply.handoff
  h.context.settleReplyDraft(true)
  t.is(await first, true)
  t.is(h.context.replyDraftStash.current, null)
  const saved = h.state.composer.reply
  h.context.setComposer((c) => ({ ...c, open: false }))
  const second = h.start(draft)
  t.ok(h.state.composer.reply.handoff > serial)
  h.context.settleReplyDraft(false)
  t.is(await second, false)
  t.is(h.state.composer.reply, saved)
  t.is(h.state.composer.quote, null)
})

test('App startReply keeps same-top signals and the offline sheet fallback', (t) => {
  const h = shell({ open: false, reply: null, quote: null })
  const target = { ref: 'R' }
  h.start(target)
  h.start(target)
  t.alike(h.state.pushed, [{ screen: 'conversa', key: 'R' }, { screen: 'conversa', key: 'R' }])
  t.is(h.state.signal.n, 2)
  t.is(h.state.composer.open, false)
  h.context.node.online = false
  h.start(target)
  t.alike(h.state.composer, { open: true, reply: target, quote: null })
})

test('held handoffs restore the in-flight target without clearing text or aborting', async (t) => {
  for (const saved of [{ reply: { ref: 'sent' }, quote: null }, { reply: null, quote: { ref: 'sent' } }]) {
    const h = shell({ open: true, ...saved })
    const editor = handoff(h.context.settleReplyDraft)
    editor.state.text = 'em envio'
    const pending = h.start({ ref: 'new', draft: 'resposta' })
    editor.render(h.state.composer.reply, { held: true }).seed()
    t.is(await Promise.race([pending, Promise.resolve('pending')]), false)
    t.is(h.state.composer.reply, saved.reply)
    t.is(h.state.composer.quote, saved.quote)
    t.is(editor.state.text, 'em envio')
    t.is(editor.state.genRef.current, 0)
    t.is(editor.state.closes, 0)
    t.alike(editor.state.removed, [])
  }
})

test('locking during a handoff drops its stash without restoring account content', async (t) => {
  const h = shell({ open: false, reply: { ref: 'old' }, quote: null })
  const pending = h.start({ ref: 'new', draft: 'resposta' })
  h.context.setComposer({ open: false, reply: null, quote: null })
  h.dismiss(true)
  t.is(await pending, false)
  t.is(h.state.composer.reply, null)
  t.is(h.context.replyDraftStash.current, null)
})
