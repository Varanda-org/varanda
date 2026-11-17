// The note for an own diary the seeder's storage budget keeps out: its
// sentence and look, and where the shell mounts it. App.js is read as text
// because it pulls in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')

function loadNote () {
  const element = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const colors = { soft: 'soft', accent: 'accent', warm: 'warm', line: 'line' }
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24 }) },
    './Icon': { Icon: 'Icon' },
    './theme': { layout: { hit: 44 }, space: { xs: 4, sm: 8, lg: 16 }, type: { replyMark: {} } },
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
  modules['../syncSignals'] = compile('syncSignals.js')
  return compile('ui/StorageFullNote.js')
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props?.children)]
}

test('the note says the seeder has no room, with no button, and is announced', (t) => {
  const { StorageFullNote } = loadNote()
  const row = StorageFullNote({})
  const tree = nodes(row)
  t.alike(tree.filter((node) => node.type === 'Text').map((node) => node.props.children), ['O semeador está sem espaço e não está guardando seu diário agora.'])
  t.alike(tree.filter((node) => node.type === 'Icon').map((node) => node.props.name), ['sinc'])
  t.is(tree.filter((node) => node.type === 'Pressable').length, 0, 'nothing to press: no action and no close')
  t.is(row.props.accessibilityRole, 'alert')
  t.is(row.props.accessibilityLiveRegion, 'polite')
  t.is(row.props['aria-live'], 'polite')
  t.absent(row.props.style.paddingTop, 'no inset under a top bar')
  const inset = StorageFullNote({ inset: true })
  const style = Object.assign({}, ...inset.props.style.filter(Boolean))
  t.is(style.paddingTop, 30, '6 pt plus the safe-area inset on Diário')
  t.absent(fs.readFileSync(path.join(__dirname, '../src/ui/StorageFullNote.js'), 'utf8').includes('Platform'), 'decided by what the node reports, never by platform')
})

test('the shell mounts the note once, after the device note, and the notes under it give up the top inset', (t) => {
  const device = app.indexOf('<DeviceOffNote')
  const note = app.indexOf('<StorageFullNote')
  const invite = app.indexOf('<InviteDropNote')
  t.ok(device !== -1 && device < note, 'after DeviceOffNote')
  t.ok(note !== -1 && note < invite, 'before InviteDropNote')
  t.is(app.split('<StorageFullNote').length - 1, 1, 'mounted once')
  t.ok(app.includes('const storageNoteShown = storageFullShown({ online: node.online, signals: node.signals })'), 'gated by the folded signal')
  const nodeSrc = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  const flags = nodeSrc.slice(nodeSrc.indexOf('function useRunFlags'), nodeSrc.indexOf('\n}\n', nodeSrc.indexOf('function useRunFlags')))
  t.is(flags.split('storageFull').length - 1, 3, 'useNode().signals carries the flag (read, kept, memo dependency)')
  t.ok(app.includes('{storageNoteShown\n            ? <StorageFullNote inset={tab === \'diario\' && !deviceOffShown && scheduledDeletion === null} />'), 'its own inset only on Diário with no note above')
  for (const name of ['InviteDropNote', 'UpdateNote', 'InstallCard', 'InstallNote', 'PushNote']) {
    const at = app.indexOf('<' + name)
    const jsx = app.slice(at, app.indexOf('/>', at))
    t.ok(jsx.includes('!storageNoteShown'), name + ' takes no inset under the note')
  }
  t.absent(app.includes('\u2014'), 'no em dash in App.js')
})
