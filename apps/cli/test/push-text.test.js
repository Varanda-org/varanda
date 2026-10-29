'use strict'

// apps/cli/lib/account/push-text.js: the pt-BR sentence a Web Push notice
// carries. Pure: no network, no disk.

const test = require('brittle')
const { pushBody, PUSH_TITLE, PUSH_FALLBACK_BODY, PUSH_BODY_MAX } = require('../lib/account/push-text')

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex

function codePoints (s) {
  return Array.from(s).length
}

test('push text: constants', (t) => {
  t.is(PUSH_TITLE, 'Varanda')
  t.is(PUSH_FALLBACK_BODY, 'Você tem um aviso novo na Varanda')
  t.is(PUSH_BODY_MAX, 120)
})

test('push text: the four sentences for a normal name', (t) => {
  t.is(pushBody({ kind: 'follow', name: 'Ana Souza' }), 'Ana Souza começou a seguir você')
  t.is(pushBody({ kind: 'reply', name: 'Ana Souza' }), 'Ana Souza respondeu ao seu post')
  t.is(pushBody({ kind: 'like', name: 'Ana Souza' }), 'Ana Souza curtiu seu post')
  t.is(pushBody({ kind: 'repost', name: 'Ana Souza' }), 'Ana Souza republicou seu post')
})

test('push text: unknown kind is a TypeError', (t) => {
  for (const kind of ['quote', 'mention', '', 'toString', '__proto__', undefined, null, 1]) {
    t.exception.all(() => pushBody({ kind, name: 'Ana' }), TypeError, String(kind))
  }
  t.exception.all(() => pushBody(), TypeError, 'no argument')
})

test('push text: no visible name and no username gives Alguém', (t) => {
  for (const name of ['', '@@', '​‍﻿', ' ㅤ ', '＠﹫', undefined, null, 42]) {
    t.is(pushBody({ kind: 'like', name }), 'Alguém curtiu seu post', JSON.stringify(name))
  }
})

test('push text: leading at-signs never pass for a username', (t) => {
  t.is(pushBody({ kind: 'follow', name: '@alice' }), 'alice começou a seguir você')
  t.is(pushBody({ kind: 'follow', name: '‏@alice', username: 'bob' }), 'alice começou a seguir você')
})

test('push text: username only when the display name is empty, never with @', (t) => {
  t.is(pushBody({ kind: 'reply', name: '', username: 'alice_01' }), 'alice_01 respondeu ao seu post')
  t.is(pushBody({ kind: 'reply', name: '@@', username: 'alice_01' }), 'alice_01 respondeu ao seu post')
  t.is(pushBody({ kind: 'reply', username: 'alice_01' }), 'alice_01 respondeu ao seu post')
  t.is(pushBody({ kind: 'reply', name: 'Ana', username: 'alice_01' }), 'Ana respondeu ao seu post')
  t.absent(pushBody({ kind: 'reply', username: 'alice_01' }).includes('@'))
})

test('push text: a username that is not valid is never used', (t) => {
  for (const username of ['abc123', 'deadbe', '@alice', 'Alice', 'ab', '1alice', 'a'.repeat(21), 'ali ce', 42]) {
    t.is(pushBody({ kind: 'like', name: '', username }), 'Alguém curtiu seu post', String(username))
  }
})

test('push text: a long name is clipped, the fixed phrase never is', (t) => {
  const name = 'x'.repeat(80)
  for (const kind of ['follow', 'reply', 'like', 'repost']) {
    const body = pushBody({ kind, name })
    t.ok(codePoints(body) <= PUSH_BODY_MAX, kind + ' length')
    t.ok(body.startsWith('xxxx'), kind + ' keeps the name')
  }
  t.ok(pushBody({ kind: 'follow', name }).endsWith(' começou a seguir você'))
  const astral = '\u{1f600}'.repeat(200)
  const body = pushBody({ kind: 'reply', name: astral })
  t.ok(codePoints(body) <= PUSH_BODY_MAX)
  t.ok(body.endsWith(' respondeu ao seu post'))
  t.absent(/[\ud800-\udbff](?![\udc00-\udfff])/.test(body), 'no lone high surrogate')
})

test('push text: control characters never survive', (t) => {
  const names = ['Ana\u0000Souza', '\u001b[31mAna', 'Ana\r\nSouza', 'Ana\u0085', '\u0007\u0008']
  for (const name of names) {
    const body = pushBody({ kind: 'follow', name })
    t.absent(CONTROL.test(body), JSON.stringify(name))
    t.ok(body.endsWith(' começou a seguir você'))
  }
})
