// Web Escape over stacked layers: only the top layer closes, the press is
// marked handled (App skips it) and the release is consumed (a Modal below
// never sees it).
'use strict'

const test = require('brittle')

const load = () => import('../src/ui/escapeLayer.js')

function key (type, k = 'Escape') {
  const e = { type, key: k, prevented: false, stopped: false }
  e.preventDefault = () => { e.prevented = true }
  e.stopImmediatePropagation = () => { e.stopped = true }
  return e
}

test('keydown is marked handled and closes nothing', async (t) => {
  const { createEscapeStack, handleKey } = await load()
  const stack = createEscapeStack()
  let closed = 0
  stack.push({ onClose: () => { closed++ } })
  const e = key('keydown')
  t.ok(handleKey(stack, e))
  t.ok(e.prevented, 'App sees a handled event')
  t.absent(e.stopped)
  t.is(closed, 0)
})

test('keyup is consumed and closes only the top layer', async (t) => {
  const { createEscapeStack, handleKey } = await load()
  const stack = createEscapeStack()
  const closed = []
  const sheet = { kind: 'sheet', onClose: () => closed.push('sheet') }
  const menu = { kind: 'actions', onClose: () => closed.push('menu') }
  stack.push(sheet)
  stack.push(menu)
  t.is(stack.count(), 2)
  t.is(stack.count('actions'), 1)
  const e = key('keyup')
  t.ok(handleKey(stack, e))
  t.ok(e.prevented && e.stopped, 'the release never reaches a modal below')
  t.alike(closed, ['menu'])
  stack.pop(menu)
  handleKey(stack, key('keydown'))
  handleKey(stack, key('keyup'))
  t.alike(closed, ['menu', 'sheet'], 'a second Escape closes the sheet')
  stack.pop(sheet)
  t.is(stack.top(), null)
})

test('pop removes the given layer even when it is not on top', async (t) => {
  const { createEscapeStack } = await load()
  const stack = createEscapeStack()
  const a = { onClose () {} }
  const b = { onClose () {} }
  stack.push(a)
  stack.push(b)
  stack.pop(a)
  t.is(stack.top(), b)
  t.is(stack.count(), 1)
})

test('an empty stack or another key does nothing', async (t) => {
  const { createEscapeStack, handleKey, escapeLayerCount } = await load()
  const stack = createEscapeStack()
  for (const type of ['keydown', 'keyup']) {
    const e = key(type)
    t.absent(handleKey(stack, e))
    t.absent(e.prevented || e.stopped)
  }
  let closed = 0
  stack.push({ onClose: () => { closed++ } })
  const other = key('keyup', 'Enter')
  t.absent(handleKey(stack, other))
  t.absent(other.prevented || other.stopped)
  t.is(closed, 0)
  t.is(escapeLayerCount(), 0, 'the shared stack starts empty')
})

test('every component with its own Escape uses the shared layers', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
  t.ok(read('ui/MediaGrid.js').includes("useEscapeLayer(!!open, () => closeRef.current(), 'viewer')"), 'the photo viewer is a layer')
  t.absent(read('ui/MediaGrid.js').includes("event.key === 'Escape'"), 'the viewer has no Escape listener of its own')
  t.ok(read('screens/NovoGrupo.js').includes("useEscapeLayer(!!visible, onClose, 'sheet')"), 'useEscapeClose delegates to the layers')
  t.ok(read('ui/AvatarEditor.js').includes("'editor')"), 'the photo editor is a layer')
})

test('the chat photo viewer is an Escape layer too', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'ChatMedia.js'), 'utf8')
  t.ok(src.includes("useEscapeLayer(uri !== null, onClose, 'viewer')"), 'Escape on a chat photo never leaves the conversation')
})
