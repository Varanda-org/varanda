'use strict'

// Source-text checks for the post framing step (src/ui/FrameEditor.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/ui/FrameEditor.js'), 'utf8')

test('frame editor imports its math from crop and frame', (t) => {
  t.ok(/from '\.\.\/media\/crop'/.test(src), 'crop math')
  t.ok(src.includes("import { FRAMES, frameById } from '../media/frame'"), 'frames')
  t.absent(/import[^\n]*\bModal\b/.test(src), 'no Modal')
  t.absent(/\bScrollView\b/.test(src), 'no paging ScrollView')
})

test('every crop call passes the ratio', (t) => {
  const calls = [...src.matchAll(/\b(clampCrop|displayRect|panBy|zoomBy|nudge|limitsOf)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)]
  t.ok(calls.length >= 8, 'found the crop calls')
  for (const [, name, args] of calls) {
    const parts = args.split(',').map((s) => s.trim())
    t.ok(/^(ratio|r|ratioFor\(id\))$/.test(parts[parts.length - 1]), name + ' passes the ratio')
  }
})

test('frame editor is the top Escape layer', (t) => {
  t.ok(src.includes("useEscapeLayer(true, () => { if (!off && onCancel) onCancel() }, 'editor')"))
})

test('format chips come from FRAMES as radios', (t) => {
  t.ok(src.includes('{FRAMES.map((frame) => {'), 'chips from FRAMES')
  t.ok(src.includes("accessibilityRole='radio'"), 'radio role')
  t.ok(src.includes('accessibilityState={{ checked, disabled }}'), 'checked state')
  t.ok(src.includes("accessibilityLabel='Enquadramento da foto'"), 'viewport label')
})

test('help, cancel and apply', (t) => {
  t.ok(src.includes('<HelpButton doc={HELP.enquadramento} />'), 'help behind the (i)')
  t.ok(src.includes("<Pill label='Cancelar' onPress={onCancel} disabled={off} />"), 'cancel is textual')
  t.ok(src.includes("<Pill label='Aplicar' filled pending={pending} onPress={apply} />"), 'apply is textual')
  t.ok(src.includes('onApply({ frameId: current, crops: out })'), 'apply sends frame and crops')
})

test('pager uses chevrons, not the move arrows', (t) => {
  t.ok(src.includes("<IconAction icon='voltar' label='foto anterior'"))
  t.ok(src.includes("<IconAction icon='seta' label='próxima foto'"))
  t.ok(src.includes("{'foto ' + (at + 1) + ' de ' + list.length}"))
})

test('keys from the help sheet portal never reach the editor', (t) => {
  t.ok(/const outside = \(e\) => [^\n]*\.contains\(e\.target\)/.test(src), 'helper checks the DOM target')
  t.ok(src.includes('const onKeyDown = (e) => {\n    if (outside(e)) return'), 'keydown goes through it')
  t.ok(src.includes('const onKeyUp = (e) => {\n    if (outside(e)) return'), 'keyup goes through it')
})
