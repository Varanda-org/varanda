'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
const mensagem = read('Mensagem.js')

test('pinToEnd follows a changed newest message without re-pinning an older page', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const state = Object.freeze({ pinned: false, newest: 'a', lastY: 100 })
  const same = pinToEnd(state, Object.freeze({ kind: 'newest', newest: 'a' }))
  t.alike(same, state, 'the same newest leaves a reader alone')
  t.not(same, state, 'even an unchanged state is copied')
  const next = pinToEnd(state, Object.freeze({ kind: 'newest', newest: 'b' }))
  t.alike(next, { pinned: true, newest: 'b', lastY: 100 })
  t.alike(state, { pinned: false, newest: 'a', lastY: 100 }, 'the input stays unchanged')
  const user = pinToEnd(Object.freeze(next), Object.freeze({ kind: 'user' }))
  t.alike(user, { pinned: false, newest: 'b', lastY: 100 }, 'a user gesture releases the pin')
  t.not(user, next)
})

test('pinToEnd keeps animated downward frames and resizes pinned', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const cases = [
    { name: 'first frame away from the end', lastY: null, y: 100, contentHeight: 2000, pinned: true },
    { name: 'resize at the same offset', lastY: 100, y: 100, contentHeight: 3000, pinned: true },
    { name: 'animated scroll down away from the end', lastY: 100, y: 200, contentHeight: 3000, pinned: true },
    { name: 'small move up', lastY: 100, y: 90, contentHeight: 3000, pinned: true },
    { name: 'exactly 48 pixels up', lastY: 100, y: 52, contentHeight: 3000, pinned: true },
    { name: 'more than 48 pixels up', lastY: 100, y: 51, contentHeight: 3000, pinned: false },
    { name: 'measured end of the first batch', lastY: 100, y: 200, contentHeight: 600, pinned: true }
  ]
  for (const { name, lastY, y, contentHeight, pinned } of cases) {
    const state = Object.freeze({ pinned: true, newest: 'a', lastY })
    const event = Object.freeze({ kind: 'frame', y, contentHeight, layoutHeight: 400 })
    const next = pinToEnd(state, event)
    t.alike(next, { pinned, newest: 'a', lastY: y }, name)
    t.not(next, state, 'a frame returns a new state')
  }
  const state = Object.freeze({ pinned: false, newest: 'a', lastY: 100 })
  t.alike(pinToEnd(state, { kind: 'frame', y: 200, contentHeight: 600, layoutHeight: 400 }), { ...state, lastY: 200 }, 'reaching the end does not restore a released pin')
})

test('conversations follow content batches and release the pin on user gestures', (t) => {
  for (const file of ['Mensagem.js', 'Grupo.js']) {
    const src = read(file)
    t.ok(/import \{[^}]*\bpinToEnd\b[^}]*\} from '\.\.\/dm-screen'/.test(src), file + ' uses the shared pin state')
    const list = src.slice(src.indexOf('<RefreshableList'), src.indexOf('\n      />', src.indexOf('<RefreshableList')))
    t.ok(list.includes('onContentSizeChange='), file + ' follows content growth')
    t.ok(list.includes('onUserScroll='), file + ' yields to a gesture')
  }
  t.absent(mensagem.includes('list.scrollToEnd({ animated: !first })'), 'Mensagem no longer relies on the initial timer')
  t.absent(read('Grupo.js').includes('setTimeout(() => list.scrollToEnd'), 'Grupo scrolls without a timer')
})

test('conversations release the pin before a jump or an older page, and feed a frame before following', (t) => {
  const bodyOf = (src, start, end) => {
    const at = src.indexOf(start)
    return at < 0 ? '' : src.slice(at, src.indexOf(end, at))
  }
  const release = "endPin.current = pinToEnd(endPin.current, { kind: 'user' })"
  const grupo = read('Grupo.js')
  const jump = bodyOf(grupo, 'const scrollToKey = (key) => {', '\n  }\n')
  t.ok(jump.includes(release) && jump.indexOf(release) < jump.indexOf('list.scrollToIndex('), 'a quote jump releases the pin before it scrolls')
  const olderOf = { 'Mensagem.js': 'const loadOlder = async () => {', 'Grupo.js': 'const loadOlder = useCallback(async () => {' }
  for (const file of ['Mensagem.js', 'Grupo.js']) {
    const src = read(file)
    const older = bodyOf(src, olderOf[file], '\n  }')
    t.ok(older.includes(release), file + ' loadOlder is a gesture')
    const track = bodyOf(src, 'const trackBottom = useCallback(', '\n  }, [')
    t.ok(track.includes("kind: 'frame'"), file + ' feeds every frame to the pin')
    t.absent(track.includes('followEnd('), file + ' never restarts a scroll from a frame (Android restarts the animation)')
    const follow = bodyOf(src, 'const followEnd = useCallback(', '\n  }, [')
    t.ok(follow.includes('settleTimer.current = setTimeout(') && follow.includes('if (endPin.current.pinned && now'), file + ' scrolls once more after layout settles, only while still pinned')
  }
})

test('the request composer keeps Aceitar and Recusar, Bloquear lives in the Conversa sheet', (t) => {
  const start = mensagem.indexOf("} else if (folder === 'request')")
  const composer = mensagem.slice(start, mensagem.indexOf('} else if (blockNote', start))
  t.ok(composer.includes('LABELS.accept') && composer.includes('LABELS.decline'), 'accept and decline stay')
  t.absent(composer.includes('LABELS.block'), 'no inline Bloquear')
  const sheet = mensagem.slice(mensagem.indexOf("title='Conversa'"))
  t.ok(sheet.includes('LABELS.block') && sheet.includes("decide('blocked')"), 'Bloquear in the sheet')
  t.ok(sheet.indexOf('LABELS.block') < sheet.indexOf('LABELS.delete'), 'above delete')
  t.absent(mensagem.includes('<Sheet open={menu}'), 'the menu is the compact ActionsSheet, not a full-height sheet')
  t.ok(mensagem.includes('<ActionsSheet\n        open={menu}'), 'the Conversa menu itself')
  t.ok(sheet.includes("icon: 'lixeira', label: LABELS.delete, danger: true"), 'delete is a danger row')
  const confirm = mensagem.slice(mensagem.indexOf("title='Apagar esta conversa?'"))
  t.ok(confirm.includes("decide('deleted')"), 'the compact confirmation deletes')
  t.is(confirm.split("label: 'Cancelar'").length - 1, 1, 'one Cancelar')
})

test('opening the keyboard keeps the newest message in view', (t) => {
  t.ok(mensagem.includes("Keyboard.addListener('keyboardDidShow'") && mensagem.includes('if (!atBottom.current) return'), 'scrolls to the end only when at the bottom')
  t.ok(mensagem.includes('onScrollFrame={trackBottom}'))
})

test('community and group confirms are stacked and per-person actions are menus', (t) => {
  for (const f of ['ComunidadeInfo.js', 'GrupoAjustes.js', 'Grupo.js']) t.ok(read(f).includes('<ConfirmStack'), f + ' stacks its confirm')
  const info = read('ComunidadeInfo.js')
  t.ok(info.includes('<MoreButton') && info.includes('ActionsSheet'), 'community menus')
  t.absent(info.includes("<Btn label={isMember ? 'Sair da comunidade'"), 'leave is not a body button')
  t.ok(read('GrupoAjustes.js').includes('<MoreButton'), 'member actions menu')
})

test('Escape in a menu over the group settings closes only the menu', (t) => {
  const ajustes = read('GrupoAjustes.js')
  t.ok(ajustes.includes('<Sheet open={visible} onClose={onClose}'), 'the settings are a Sheet, an Escape layer')
  t.absent(ajustes.includes('addEventListener'), 'no own Escape handler to close the settings under an open menu')
  const ui = (file) => require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', file), 'utf8')
  t.ok(ui('ActionsSheet.js').includes("useEscapeLayer(shown, onClose, 'actions')"), 'the menu is an Escape layer')
  t.ok(ui('Sheet.js').includes("useEscapeLayer(!!open, onClose, 'sheet')"), 'the sheet is an Escape layer')
})

test('request footer clears the gesture bar and splits accept and decline', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('paddingBottom: Math.max(8, insets.bottom)'), 'footer uses the bottom inset')
  t.ok(/decideItem: \{ flex: 1/.test(src), 'accept and decline share the row')
  t.absent(src.includes('<View style={styles.composer}>'), 'no footer skips the inset')
  t.ok(/composer: \{[^}]*paddingHorizontal: 16,/.test(src), 'footer side margin is 16')
})

test('the Mensagem mais button puts the keyboard away, and a resize keeps the bottom', (t) => {
  t.ok(mensagem.includes('onPress: () => { Keyboard.dismiss(); setMenu(true) }'), 'keyboard dismissed before the menu')
  t.ok(mensagem.includes('if (resized && !bottom) return'), 'a frame with an unchanged offset does not leave the bottom')
})

test('Grupo keeps the newest line above the keyboard', (t) => {
  const grupo = read('Grupo.js')
  t.ok(grupo.includes("Keyboard.addListener('keyboardDidShow'") && grupo.includes('sub.remove()'), 'listener added and removed')
  t.ok(grupo.includes('if (!atBottom.current) return') && grupo.includes('onScrollFrame={trackBottom}'), 'only when at the bottom')
})

test('Android avoids the keyboard too (edge to edge: adjustResize no longer resizes)', (t) => {
  const grupo = read('Grupo.js')
  const perfil = read('Perfil.js')
  for (const src of [mensagem, grupo, perfil]) t.absent(src.includes("Platform.OS === 'ios' ? 'padding' : undefined"), 'no iOS-only behavior')
  t.ok(mensagem.includes("<KeyboardAvoidingView style={styles.root} behavior='padding' enabled={avoidKeyboard}>"), 'Mensagem pads')
  t.ok(grupo.includes("<KeyboardAvoidingView style={styles.root} behavior='padding' enabled={avoidKeyboard}>"), 'Grupo pads')
  t.ok(perfil.includes("behavior='padding' keyboardVerticalOffset={top}") && perfil.includes('measureInWindow'), 'Perfil pads by its measured top inside a sheet')
})

test('the composer placeholder is one short word that fits a 320 pt screen', (t) => {
  const fs = require('fs')
  const path = require('path')
  t.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'ChatComposer.js'), 'utf8').includes("placeholder = 'Mensagem',"))
  t.absent(fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8').includes('Escreva uma mensagem'))
})

test('Escape on an Ajustes sub-page goes back to the list', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Ajustes.js'), 'utf8')
  t.ok(src.includes("useEscapeLayer(screen !== null && screen !== 'lista', () => onNavigate('lista'), 'sheet')"), 'a draft on a sub-page is not dropped by Escape')
})

test('Android: keyboard padding only while the keyboard is open, and back on an Ajustes sub-page goes to the list', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
  for (const f of ['screens/Mensagem.js', 'screens/Grupo.js']) {
    t.ok(read(f).includes("behavior='padding' enabled={avoidKeyboard}") && read(f).includes('useKeyboardAvoidEnabled()'), f + ' drops the padding when the keyboard closes')
  }
  const gate = read('ui/keyboardAvoid.js')
  t.ok(gate.includes("addListener('keyboardDidHide', () => setShown(false))") && gate.includes('return !android || shown'))
  const sheet = read('ui/Sheet.js')
  t.ok(sheet.includes("onRequestClose={typeof onBack === 'function' ? onBack : onClose}"), 'Sheet lets a screen handle Android back')
  const ios = sheet.slice(sheet.indexOf("presentationStyle='pageSheet'"), sheet.indexOf('allowSwipeDismissal'))
  t.ok(ios.includes('onRequestClose={onClose}') && !ios.includes('? onBack :'), 'an iOS swipe always closes the sheet')
  t.ok(read('screens/Ajustes.js').includes("onBack={screen !== null && screen !== 'lista' ? () => onNavigate('lista') : undefined}"), 'Ajustes sub-pages go back to the list')
})

test('the newest message stays visible when the keyboard opens on Android', (t) => {
  const fs = require('fs')
  const path = require('path')
  for (const f of ['Mensagem.js', 'Grupo.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', f), 'utf8')
    t.ok(src.includes('timers = [setTimeout(toEnd, 50), setTimeout(toEnd, 300)]'), f + ' scrolls again after the list shrinks')
  }
})

test('the delete confirmation lists Cancelar before Apagar (first focus on the web is safe)', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  const sheet = src.slice(src.indexOf("title='Apagar esta conversa?'"))
  t.ok(sheet.indexOf("label: 'Cancelar'") > -1 && sheet.indexOf("label: 'Cancelar'") < sheet.indexOf("label: 'Apagar'"))
})

test('followAutocorrect follows only the first change, inside the window, in the last word', async (t) => {
  const { followAutocorrect } = await import('../src/chatSend.js')
  const sent = Object.freeze({ text: 'ola teh', at: 1000, followed: false })
  t.alike(followAutocorrect(sent, 'ola the', 1100), { text: 'ola the', at: 1000, followed: true }, 'last word inside the window follows')
  t.alike(followAutocorrect(sent, 'ola the', 1400), { text: 'ola teh', at: 1000, followed: true }, 'outside the window it does not')
  t.alike(followAutocorrect(sent, 'ola the', 999), { text: 'ola teh', at: 1000, followed: true }, 'a clock before the send does not')
  const spaced = { text: 'hello ', at: 1000, followed: false }
  t.alike(followAutocorrect(spaced, 'hello w', 1100), { text: 'hello ', at: 1000, followed: true }, 'a new word typed after a trailing space is never a correction')
  const short = { text: 'oi', at: 1000, followed: false }
  t.alike(followAutocorrect(short, 'oi!', 1100), { text: 'oi', at: 1000, followed: true }, 'typing more after the send is not a correction')
  t.alike(followAutocorrect(short, 'o', 1100), { text: 'oi', at: 1000, followed: true }, 'deleting back is not a correction')
  t.alike(followAutocorrect({ text: 'helo', at: 1000, followed: false }, 'hello', 1100), { text: 'hello', at: 1000, followed: true }, 'a letter inserted inside the word is followed')
  t.alike(followAutocorrect(sent, 'ola the amigo', 1100), { text: 'ola teh', at: 1000, followed: true }, 'an added word does not')
  t.alike(followAutocorrect(sent, 'oi teh', 1100), { text: 'ola teh', at: 1000, followed: true }, 'a changed earlier word does not')
  t.alike(followAutocorrect(sent, '', 1100), { text: 'ola teh', at: 1000, followed: true }, 'an empty value does not')
  t.is(followAutocorrect(null, 'ola the', 1100), null, 'nothing in flight stays null')
  const once = followAutocorrect(sent, 'ola the', 1100)
  t.is(followAutocorrect(once, 'ola them', 1200), once, 'a second change is never followed')
  t.alike(followAutocorrect({ text: 'teh', at: 0, followed: false }, 'the', 10), { text: 'the', at: 0, followed: true }, 'a single word')
})

test('the screens clear an autocorrected draft of the text that was sent', (t) => {
  const grupo = read('Grupo.js')
  for (const [name, src] of [['Mensagem', mensagem], ['Grupo', grupo]]) {
    t.ok(src.includes("from '../chatSend'") && /import \{[^}]*followAutocorrect[^}]*\} from '..\/chatSend'/.test(src), name + ' imports followAutocorrect')
    t.ok(src.includes('followAutocorrect(inFlightRef.current, t, Date.now())'), name + ' follows the first composer change')
    t.ok(src.includes('followed.text') || src.includes('f.text'), name + ' clears the corrected text')
  }
  t.ok(mensagem.includes('inFlightRef.current = typed === draft ? { text: typed, at: Date.now(), followed: false } : null'), 'the chat arms only when the composer shows the text being sent')
  const send = grupo.slice(grupo.indexOf('const sendPost = async'), grupo.indexOf('const sendPost = async') + 5000)
  t.ok(send.indexOf('const followed = inFlightRef.current\n    inFlightRef.current = null') > send.indexOf('await post.run('), 'sendPost takes and nulls the ref right after post.run')
  t.ok(send.includes('inFlightRef.current = heldCard === undefined ?'), 'sendPost never arms for a retry')
  t.ok(!grupo.slice(grupo.indexOf('const pageSend = async'), grupo.indexOf('const sendPost = async')).includes('inFlightRef.current = { text'), 'pageSend does not arm: its retry closure holds a stale draft')
  const media = grupo.slice(grupo.indexOf('const sendMedia = async'), grupo.indexOf('const cancelMedia'))
  const cancelAt = media.indexOf("if (r.phase === 'cancelled') return")
  const takeAt = media.indexOf('const followed = token.live ? inFlightRef.current : null')
  t.ok(cancelAt > 0 && takeAt > cancelAt && media.includes('if (token.live) inFlightRef.current = null'), 'sendMedia takes the ref only after the cancelled check, and only while still the live send')
  t.ok(media.includes('sentAt, acting, followed)'), 'sendMedia passes the taken ref to mediaDone')
  t.ok(media.includes('sentAt, acting, null)') && media.includes('held.acting, null)'), 'sendVoice and retryMedia pass null')
  t.ok(mensagem.includes("endPin.current = { pinned: true, newest: '', lastY: null }\n    opened.current = false\n    attachments.clear()"), 'the identity reset also resets endPin and opened')
})
