'use strict'

// The browser's member sync gate for private groups (lib/sync.js): a
// private root syncs like a public one, and a writer whose `box` does not
// match its root's verified visibility is refused as 'header-invalid'
// (docs/protocol.md section 10, "Private groups"), the seeder's verdict.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { writerHeader, groupHeader } = require('@varanda/core/lib/group')
const { groupVerdict, boxMismatch } = require('../lib/sync')

const hex = (buf) => b4a.toString(buf, 'hex')
const key = () => hex(crypto.randomBytes(32))
const enc = (record) => b4a.from(JSON.stringify(record))

const group = key()
const diary = key()
const writer = key()
const privateRoot = enc(groupHeader({ diary, visibility: 'private', join: 'approval', name: null, box: key() }))
const publicRoot = enc(groupHeader({ diary, name: 'Praça', join: 'open' }))
const boxed = enc(writerHeader({ group, diary, box: key() }))
const bare = enc(writerHeader({ group, diary }))

test('a private root is accepted like a public one', (t) => {
  t.is(groupVerdict(privateRoot, group, group, diary), null)
  t.is(groupVerdict(publicRoot, group, group, diary), null)
  t.is(groupVerdict(privateRoot, group, group, key()), 'wrong-diary')
})

test('a private community root is header-invalid', (t) => {
  const raw = enc({ type: 'group-header', v: 1, kind: 'community', diary, visibility: 'private', join: 'approval', name: null, box: key(), at: new Date().toISOString() })
  t.is(groupVerdict(raw, group, group, diary, true), 'header-invalid')
})

test('a writer box must match the root\'s visibility', (t) => {
  t.is(groupVerdict(bare, writer, group, diary, false, 'private'), 'header-invalid', 'boxless in a private group')
  t.is(groupVerdict(boxed, writer, group, diary, false, 'private'), null, 'boxed in a private group')
  t.is(groupVerdict(boxed, writer, group, diary, false, 'public'), 'header-invalid', 'boxed in a public group')
  t.is(groupVerdict(bare, writer, group, diary, false, 'public'), null, 'boxless in a public group')
  t.is(groupVerdict(boxed, writer, group, diary), null, 'unknown visibility: checked later')
  t.is(groupVerdict(bare, writer, group, diary), null)
  t.is(groupVerdict(bare, writer, group, key(), false, 'private'), 'wrong-diary', 'the hint is judged first, as the seeder does')
})

test('boxMismatch only judges writers of the group', (t) => {
  t.ok(boxMismatch(bare, writer, group, 'private'))
  t.ok(boxMismatch(boxed, writer, group, 'public'))
  t.absent(boxMismatch(bare, writer, group, null))
  t.absent(boxMismatch(privateRoot, group, group, 'public'), 'a root is never judged by its box')
  t.absent(boxMismatch(bare, writer, key(), 'private'), 'a writer of another group')
})
