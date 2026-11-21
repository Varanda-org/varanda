'use strict'

// Screen reader semantics of the profile header, the follow pill and the
// outbox in Diario (#155), pinned on the sources like the other screen tests.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')

test('ProfileHeader: the name and the @nome are one heading, the bio stays apart', (t) => {
  const src = read('ui/ProfileHeader.js')
  const head = src.slice(src.indexOf('{title || subtitle'), src.indexOf('{bio ?'))
  t.ok(head.includes("<View accessible accessibilityRole='header'>"), 'one focus stop')
  t.ok(head.includes('<Text style={styles.name}>{title}</Text>') && head.includes('<Text style={styles.keyText}>{subtitle}</Text>'), 'both texts inside it')
  t.absent(head.includes('MentionText'), 'the bio holds links, so it is not grouped')
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
