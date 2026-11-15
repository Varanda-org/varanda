'use strict'

// The reply bar above the chat composer is tappable: the screen decides what
// the tap does (scroll to the quoted message), the composer only forwards it.
// Source checks, like the other composer tests.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8')
const composer = read('ChatComposer.js')
const preview = read('ReplyPreview.js')

test('ChatComposer forwards onOpenReply to the reply bar next to Cancelar', (t) => {
  t.ok(/\n {2}onOpenReply,\n/.test(composer), 'a prop of the composer')
  t.ok(composer.includes('mine={reply.mine} onPress={onOpenReply} onCancel={onCancelReply} />'), 'the reply bar gets the tap and keeps its cancel')
  t.ok(composer.includes('onOpenReply: tapping the reply bar'), 'documented in the props comment')
})

test('ReplyPreview makes the body a button only when it has a tap, and Cancelar stays apart', (t) => {
  t.ok(preview.includes("typeof onPress === 'function'"), 'no handler, no button: a bar without onOpenReply is as before')
  t.ok(preview.includes("accessibilityHint='mostrar a mensagem respondida'"), 'the button says what it does')
  const press = preview.slice(preview.indexOf("accessibilityHint='mostrar a mensagem respondida'"), preview.indexOf("accessibilityLabel='Cancelar'"))
  t.ok(press.includes('onPress={onPress}'), 'the body press is the tap')
  t.absent(press.includes('onCancel'), 'Cancelar is its own button, outside the body press')
})

test('Mensagem and Grupo wire the reply bar tap to the same scroll as a bubble quote', (t) => {
  const screen = (file) => fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
  const dm = screen('Mensagem.js')
  t.ok(dm.includes('onOpenReply={replyTo ? () => scrollToKey(rows.find((row) => row.id === replyTo.id)?.key) : undefined}'), 'DM: only while replying, by the row of the quoted id, through scrollToKey (the missing toast)')
  const group = screen('Grupo.js')
  t.ok(group.includes('onOpenReply={replyBar ? () => scrollToKey(replyKey) : undefined}'), 'group: only while replying, with the writer:seq key')
  t.ok(group.includes('onPress: () => scrollToKey(row.replyTo)'), 'the bubble quote scrolls by the same writer:seq key')
})
