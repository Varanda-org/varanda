// Wiring of the push note in the shell and the Ajustes row to the one store,
// read as text because both files pull in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
const ajustes = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Ajustes.js'), 'utf8')

test('the shell shows the push note after the release and install notes', (t) => {
  const update = app.indexOf('<UpdateNote')
  const install = app.indexOf('<InstallNote')
  const push = app.indexOf('<PushNote')
  t.ok(update !== -1 && update < install, 'UpdateNote before InstallNote')
  t.ok(install !== -1 && install < push, 'InstallNote before PushNote')
  t.is(app.split('<PushNote').length - 1, 1, 'PushNote mounted once')
  const jsx = app.slice(push, app.indexOf('/>', push))
  t.ok(jsx.includes('push.activatePush('), 'Ativar calls activatePush')
  t.ok(jsx.includes('push.dismissPush('), 'close calls dismissPush')
  t.absent(jsx.includes('togglePush('), 'the note never toggles')
  t.ok(app.includes("from './src/usePush'"), 'App.js uses the shared store')
  t.ok(/if \(locked\) readPush\(null\)/.test(app), 'any lock drops the push view')
  t.ok(app.includes("push.note === 'offer' && pushMember !== null && push.member === pushMember ? <PushNote"), 'the note shows only while this member is eligible')
})

test('Ajustes shows the row only while this member is eligible', (t) => {
  t.ok(ajustes.includes('const push = pushEligible && pushStore.member === member ? pushStore.state : null'), 'row gated on eligibility')
})

test('Ajustes drives the same store', (t) => {
  t.ok(/import \{ usePush \} from '\.\.\/usePush'/.test(ajustes), 'imports usePush')
  t.ok(ajustes.includes('togglePush('), 'row toggles through the store')
  t.ok(ajustes.includes('turnOffPush('), 'Sair and Recomeçar turn off through the store')
  for (const gone of ['pushOp', 'pushBusy', 'const readPush', "from '../pushClient'"]) {
    t.absent(ajustes.includes(gone), 'no local ' + gone)
  }
})

test('no em dash in the wired files', (t) => {
  t.absent(app.includes('\u2014'), 'App.js')
  t.absent(ajustes.includes('\u2014'), 'Ajustes.js')
})

function loadNotes () {
  const element = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const colors = { soft: 'soft', accent: 'accent', warm: 'warm', line: 'line' }
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24 }) },
    './Icon': { Icon: 'Icon' },
    './theme': { layout: { hit: 44 }, space: { xs: 4, sm: 8, lg: 16 }, type: { replyMark: {}, chip: {} } },
    './ThemeProvider': { useStyles: (make) => make(colors), useTheme: () => ({ colors }) }
  }
  function compile (file) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    const { code } = transformSync(source, {
      babelrc: false,
      configFile: false,
      plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }], require.resolve('@babel/plugin-transform-modules-commonjs')]
    })
    const exports = {}
    runInNewContext(code, {
      exports,
      require (name) {
        if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name)
        return modules[name]
      }
    })
    return exports
  }
  modules['./NoteBar'] = compile('ui/NoteBar.js')
  modules['../release'] = compile('release.js')
  return Object.assign({}, ...['InstallNote', 'PushNote', 'UpdateNote'].map((name) => compile('ui/' + name + '.js')))
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}

function styleOf (node) {
  const style = typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style
}

test('install, push and update notes share NoteBar without changing their sentences', (t) => {
  const notes = loadNotes()
  const cases = [
    { name: 'InstallNote', props: { kind: 'prompt' }, text: 'Instalar o Varanda', label: 'Instalar', spoken: 'Instalar o Varanda', handler: 'onInstall', icon: 'smartphone', close: 'Fechar' },
    { name: 'PushNote', props: {}, text: 'Receber avisos neste aparelho', label: 'Ativar', spoken: 'Ativar avisos neste aparelho', handler: 'onEnable', icon: 'sino', close: 'Fechar' },
    { name: 'PushNote', props: { pending: true, text: 'Avisos desativados' }, text: 'Avisos desativados', label: 'Ativar', spoken: 'Ativar avisos neste aparelho', handler: 'onEnable', icon: 'sino', close: 'Fechar' },
    { name: 'UpdateNote', props: {}, text: 'Nova versão disponível.', label: 'atualizar', spoken: 'atualizar', handler: 'onUpdate', close: 'fechar' }
  ]
  for (const item of cases) {
    const calls = []
    const onAction = () => calls.push('action')
    const onClose = () => calls.push('close')
    const row = notes[item.name]({ ...item.props, [item.handler]: onAction, onClose })
    const tree = nodes(row)
    t.ok(fs.readFileSync(path.join(__dirname, '../src/ui', item.name + '.js'), 'utf8').includes("from './NoteBar'"), item.name + ' uses NoteBar')
    t.alike(tree.filter((node) => node.type === 'Text').map((node) => node.props.children), [item.text, item.label], item.name + ': visible sentences')
    t.alike(tree.filter((node) => node.type === 'Icon').map((node) => node.props.name), [item.icon, 'fechar'].filter(Boolean))
    t.absent(row.props.accessibilityRole, 'the note remains presentational')
    const [action, close] = tree.filter((node) => node.type === 'Pressable')
    t.is(action.props.accessibilityLabel, item.spoken)
    t.is(close.props.accessibilityLabel, item.close)
    t.alike(calls, [], 'rendering never starts an action')
    if (item.props.pending) {
      t.is(action.props.disabled, true)
      t.absent(action.props.onPress)
    } else {
      t.is(action.props.onPress, onAction, 'the original handler receives the press directly')
      action.props.onPress()
    }
    close.props.onPress()
    t.alike(calls, item.props.pending ? ['close'] : ['action', 'close'])
    for (const button of [action, close]) {
      t.is(button.props.hitSlop, undefined, 'the 44 pt box is the whole target, with no slop past the bar')
      t.ok(styleOf(button).minHeight >= 44)
      t.is(styleOf(button).marginVertical, -4, 'the target reaches into the bar padding, so the bar stays 44 pt')
    }
    t.ok(styleOf(close).minWidth >= 44)
    const insetRow = notes[item.name]({ ...item.props, inset: true })
    t.is(styleOf(insetRow).paddingTop, 30, 'the original 6 pt plus safe-area inset is kept')
  }
})

test('install instructions and optional update dismissal remain unchanged', (t) => {
  const { InstallNote, UpdateNote } = loadNotes()
  const onClose = () => {}
  const ios = nodes(InstallNote({ kind: 'ios', onClose }))
  t.alike(ios.filter((node) => node.type === 'Text').map((node) => node.props.children), ['Compartilhar → Adicionar à Tela de Início'])
  const buttons = ios.filter((node) => node.type === 'Pressable')
  t.is(buttons.length, 1)
  t.is(buttons[0].props.onPress, onClose)
  for (const kind of [undefined, null, '', 'other']) t.is(InstallNote({ kind }), null)
  const update = nodes(UpdateNote({ onUpdate () {} })).filter((node) => node.type === 'Pressable')
  t.is(update.length, 1, 'an update has no close button without a dismissal handler')
})
