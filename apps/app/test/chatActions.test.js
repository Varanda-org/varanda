'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
const mensagem = read('Mensagem.js')

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
