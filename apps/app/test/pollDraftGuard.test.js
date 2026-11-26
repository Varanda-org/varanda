'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const src = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')

test('a poll draft never falls through to a plain post or the outbox', (t) => {
  const at = src.indexOf('const send = async () => {')
  t.ok(at > 0, 'send found')
  const body = src.slice(at)
  const guard = body.indexOf('if (pollDraft !== null && pageRetryRef.current === null) {')
  t.ok(guard > 0, 'send branches on the draft, not on pollActive')
  t.ok(guard < body.indexOf('queue(sent, sentReply)'), 'before the outbox')
  t.ok(guard < body.indexOf("const method = sentQuote ? 'post.quote'"), 'before a plain post')
  const branch = body.slice(guard, guard + 260)
  t.ok(branch.includes('if (!pollOk) { setCheckError(node.online === false ? POLL_NEEDS_ONLINE : POLL_ALONE); return }'), 'refuses with a message and keeps the draft')
  t.ok(branch.includes('return asPage !== null ? sendAsPage() : sendPoll()'), 'sends the poll when allowed: as the page when acting as one')
  t.ok(!branch.includes('setPollDraft(null)'), 'the draft is kept')
  t.ok(src.includes("const POLL_NEEDS_ONLINE = 'Enquete só pode ser publicada com conexão.'"), 'offline message in pt-BR')
})

test('a poll draft turns off the link card and the music button', (t) => {
  t.ok(/useLinkDraft\(\{ text, enabled: [^\n]*pollDraft === null/.test(src), 'no link card draft while polling')
  t.ok(src.includes('musicAvailable === true && pollDraft === null'), 'music button hidden while polling')
  t.ok(src.includes('refusalOf(text, ...altTexts, ...(pollDraft !== null ? pollDraft.options : []), ...(eventDraft !== null ? eventEditorTexts(eventDraft) : []))'), 'options are word-checked whenever a draft exists')
})

test('the poll button stays while a draft is held back, so it can be discarded', (t) => {
  t.ok(src.includes('{(pollOk && !hasVideo && !preparingVideo) || pollHeldBack'), 'button shown for a held back draft')
  t.ok(src.includes('setPollDraft(pollDraft !== null ? null : editorInit())'), 'toggle clears the draft')
})
