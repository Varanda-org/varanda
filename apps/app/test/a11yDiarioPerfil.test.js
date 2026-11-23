'use strict'

// Screen reader semantics of the profile header, the follow pill and the
// outbox in Diario (#155), pinned on the sources like the other screen tests.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')

test('ProfileHeader: the name is the heading and the @nome is its own element after it', (t) => {
  const src = read('ui/ProfileHeader.js')
  const head = src.slice(src.indexOf('<View style={styles.data}>'), src.indexOf('{bio ?'))
  const title = "{title ? <Text style={styles.name} accessibilityRole='header'>{title}</Text> : null}"
  const handle = '{subtitle ? <Text style={styles.keyText}>{subtitle}</Text> : null}'
  t.ok(head.includes(title), 'the name Text carries the header role')
  t.ok(head.includes(handle), 'the @nome is a separate Text')
  t.ok(head.indexOf(title) < head.indexOf(handle), 'the @nome is read right after the title')
  t.absent(head.includes('accessible'), 'no accessible View joins the free name and the verified @nome in one phrase')
})

test('FollowPill: a followed member reads as following, with what a press opens', (t) => {
  const src = read('ui/FollowPill.js')
  t.ok(src.includes("accessibilityLabel={'seguindo ' + title + ', toque para deixar de seguir'}"), 'state first')
  t.ok(src.includes("accessibilityLabel={'seguir ' + title}"), 'not following: the action')
})

test('Diario outbox: every action names the queued item it acts on', (t) => {
  const src = read('screens/Diario.js')
  t.ok(src.includes("const queuedLabel = (item) => 'a publicação escrita ' + (relativeTime(item.writtenAt, now) ?? displayText(item.writtenAt))"), 'one helper')
  t.ok(src.includes("accessibilityLabel={'enviar ' + queuedLabel(item)}"), 'Enviar')
  t.ok(src.includes("accessibilityLabel={'tentar de novo enviar ' + queuedLabel(item)}"), 'Tentar de novo')
  t.ok(src.includes("accessibilityLabel={'apagar ' + queuedLabel(item)}"), 'apagar')
})
