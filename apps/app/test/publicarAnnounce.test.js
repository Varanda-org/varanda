'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const source = fs.readFileSync(path.join(__dirname, '../src/screens/Publicar.js'), 'utf8')

const author = 'a'.repeat(64)
const target = 'b'.repeat(64)
const reply = { ref: target + ':3' }
const own = { author, seq: 7, gen: 2 }
const sent = 'Uma resposta'

async function publisher (calls, mounted = true) {
  const { ownReplyItem } = await import('../src/ownReply.js')
  const ctx = {
    tap: () => {},
    setPollDraft: () => {},
    setEventDraft: () => {},
    setMusicDraft: () => {},
    setWebShare: () => {},
    musicTried: { current: new Set() },
    setText: () => {},
    video: { draft: { state: { file: null } } },
    removeItems: () => {},
    onPublished: (...args) => { calls.push(['published', ...args]) },
    mountedRef: { current: mounted },
    announceOwnReply: (item, from) => {
      if (item === null) return
      const { author, seq, replyTo, text, media, gen } = item
      calls.push(['announce', { author, seq, replyTo, text, media, gen }, from])
    },
    ownReplyItem
  }
  const start = source.indexOf('  const published = (sent, sentReply')
  const end = source.indexOf('\n  // Keeps the post', start)
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(ctx), source.slice(start, end) + '\nreturn published')(...Object.values(ctx))
}

test('Publicar announces the confirmed reply before onPublished', async (t) => {
  const calls = []
  const published = await publisher(calls)
  const media = [{ core: 'c'.repeat(64) }]
  published(sent, reply, [], null, null, { ...own, media })
  t.alike(calls, [
    ['announce', { author, seq: 7, replyTo: { author: target, seq: 3 }, text: sent, media, gen: 2 }, 'publicar'],
    ['published', 'reply', reply.ref, null]
  ])
})

test('Publicar only announces confirmed replies while mounted', async (t) => {
  for (const { label, sentReply = reply, quote = null, sentOwn = own, mounted = true } of [
    { label: 'post', sentReply: null },
    { label: 'quote', quote: reply },
    { label: 'missing own reply', sentOwn: null },
    { label: 'missing sequence', sentOwn: { ...own, seq: null } },
    { label: 'unmounted', mounted: false }
  ]) {
    const calls = []
    const published = await publisher(calls, mounted)
    published(sent, sentReply, [], quote, null, sentOwn)
    t.absent(calls.some(([event]) => event === 'announce'), label)
  }
})

function composerBody (head) {
  const start = source.indexOf(head)
  return source.slice(start, source.indexOf('\n  }\n', start))
}

test('all four confirmed reply paths pass own metadata to published', (t) => {
  const send = composerBody('  const send = async () => {\n    if (busy ||')
  const logRead = send.indexOf("const res = await node.request('log.read', {})")
  const page = composerBody('  const sendNewAsPage = async (')
  const retry = composerBody('  const sendAsPage = async (')
  t.ok(send.slice(0, logRead).includes('published(sent, sentReply, sentIds, sentQuote, web !== null && mountedRef.current ? web : null, own)'), 'member success')
  t.ok(send.slice(logRead).includes('published(sent, sentReply, sentIds, sentQuote, late !== null && mountedRef.current ? late : null, own)'), 'reconciled success')
  t.ok(page.includes('published(sent, sentReply, sentIds, sentQuote, web !== null && mountedRef.current ? web : null, own)'), 'Page success')
  t.ok(retry.includes('published(pending.sent, pending.reply, pending.ids, pending.quote, late !== null && mountedRef.current ? late : null, own)'), 'Page retry success')
  t.ok(/setPageRetry\(\{[^\n]*\bmedia: sentMedia\b/.test(page), 'Page retry keeps the sent media')
  const queue = composerBody('  const queue = async (')
  t.ok(queue && !queue.includes('announceOwnReply'), 'the outbox never announces')
})

function ownLine (body, head) {
  const start = body.indexOf(head)
  return start === -1 ? '' : body.slice(start, body.indexOf('\n', start))
}

test('a Page reply names the Página as its author: its answer carries no ref', async (t) => {
  const { parseRef } = await import('../src/thread.js')
  const page = composerBody('  const sendNewAsPage = async (')
  const retry = composerBody('  const sendAsPage = async (')
  const seqOf = (value) => value.seq
  const answer = { value: { seq: 9, length: 10, pushed: true } }
  const expected = { author, seq: 9, media: null, gen: 2 }
  // eslint-disable-next-line no-new-func
  const fresh = new Function('sentReply', 'page', 'r', 'seqOf', 'sentMedia', 'gen', 'parseRef', ownLine(page, 'const own = sentReply') + '\nreturn own')
  t.alike(fresh(reply, author, answer, seqOf, null, 2, parseRef), expected, 'first send as a Página')
  // eslint-disable-next-line no-new-func
  const again = new Function('pending', 'r', 'seqOf', 'gen', 'parseRef', ownLine(retry, 'const own = pending.reply') + '\nreturn own')
  t.alike(again({ reply, page: author, media: null }, answer, seqOf, 2, parseRef), expected, 'Tentar de novo as a Página')
  const calls = []
  const published = await publisher(calls)
  published(sent, reply, [], null, null, fresh(reply, author, answer, seqOf, null, 2, parseRef))
  t.alike(calls[0], ['announce', { author, seq: 9, replyTo: { author: target, seq: 3 }, text: sent, media: undefined, gen: 2 }, 'publicar'], 'the open thread hears it')
})
