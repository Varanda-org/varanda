'use strict'

const fs = require('node:fs')
const { formatFeedItem } = require('@varanda/core/lib/feed')
const { jsonLine, safe } = require('@varanda/core/lib/safe')
const member = require('@varanda/core/lib/member')
const { readRaw } = require('@varanda/core/lib/store')
const { validateParams } = require('@varanda/rpc')
const { validRecordCopy, validateRecord } = require('@varanda/core/lib/records')

function usage (message) {
  const err = new Error(message)
  err.code = 'USAGE'
  return err
}

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function warn (line) {
  process.stderr.write(line + '\n')
}

// The CLI runs with today's store options (none).
function ctxOf (flags) {
  return { dataDir: flags.dataDir, association: flags.association || null }
}

function subOf (flags, expected, message) {
  const sub = flags.positionals[0]
  if (sub !== expected && !(Array.isArray(expected) && expected.includes(sub))) throw usage(message)
  return sub
}

// ---- id ----

async function idRun (flags) {
  const sub = flags.positionals[0]
  if (sub === 'create') {
    const result = await member.idCreate(ctxOf(flags))
    print(flags, result, 'chave pública: ' + result.publicKey)
  } else if (sub === 'show') {
    const result = await member.idShow(ctxOf(flags))
    print(flags, result, 'chave pública: ' + result.publicKey)
  } else {
    throw usage('node bin/varanda.js id create|show')
  }
}

// ---- cert ----

function readCertFile (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error('não foi possível ler ' + file)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('certificado inválido (malformed)')
  }
}

async function certRun (flags) {
  subOf(flags, 'add', 'node bin/varanda.js cert add')
  if (!flags.certFile) throw usage('informe --cert-file <arquivo>')
  const ctx = ctxOf(flags)
  // A missing identity is reported before an unreadable file.
  member.trustRoot(ctx)
  const cert = readCertFile(flags.certFile)
  const result = await member.certAdd(ctx, cert)
  print(flags, result, 'certificado gravado (bloco 0)')
}

// ---- profile / post / reply ----

async function profileRun (flags) {
  subOf(flags, 'set', 'node bin/varanda.js profile set')
  if (flags.name === null) throw usage('informe --name <nome>')
  const result = await member.profileSet(ctxOf(flags), { name: flags.name, bio: flags.bio })
  print(flags, result, 'perfil atualizado #' + result.seq)
}

async function postRun (flags) {
  if (flags.text === null) throw usage('informe --text <texto>')
  const result = await member.postCreate(ctxOf(flags), { text: flags.text })
  print(flags, result, 'publicado #' + result.seq)
}

async function replyRun (flags) {
  if (!flags.to || flags.text === null) throw usage('informe --to <chave>:<seq> e --text <texto>')
  const result = await member.postReply(ctxOf(flags), { to: flags.to, text: flags.text })
  print(flags, result, 'publicado #' + result.seq)
}

async function deleteRun (flags) {
  if (!flags.to) throw usage('informe --to <chave>:<seq>')
  const ctx = ctxOf(flags)
  // The original type is needed to route an already deleted profile too.
  const record = await member.withIdentity(ctx, async ({ diary, ownHex }) => {
    if (flags.to.author !== ownHex) return null
    const entries = await readRaw(diary)
    const entry = entries.find((entry) => entry.seq === flags.to.seq)
    return entry ? validRecordCopy(entry.record, entry.seq) : null
  })
  // A cleared target has no type left: the profile path answers it from its
  // tombstones and still recognises a compatibility pair, while a cleared
  // post (a single tombstone) gets the same answer as from the post path.
  const remove = !record || record.type === 'profile' ? member.profileDelete : member.postDelete
  const result = await remove(ctx, { to: flags.to })
  print(flags, result, result.changed ? 'apagado #' + flags.to.seq : 'já apagado')
}

// ---- follows ----

async function followRun (flags, follow) {
  if (!flags.author) throw usage('informe --author <hex>')
  const ctx = ctxOf(flags)
  const result = follow ? await member.followAdd(ctx, flags.author) : await member.followRemove(ctx, flags.author)
  let line
  if (follow) line = result.changed ? 'seguindo ' + flags.author : 'já seguindo'
  else line = result.changed ? 'deixou de seguir ' + flags.author : 'não seguia'
  print(flags, result, line)
}

async function followsRun (flags) {
  const result = await member.followList(ctxOf(flags))
  print(flags, result, result.follows.join('\n'))
}

// ---- log ----

// "[foto]" / "[N fotos]" for a post's media descriptors, '' when it has none.
function mediaTag (media) {
  if (!Array.isArray(media) || media.length === 0) return ''
  return media.length === 1 ? '[foto]' : '[' + media.length + ' fotos]'
}

// A post's text with the media tag appended; a photo-only post shows just
// the tag. Peer-derived text is escaped by formatFeedItem / safe().
function withMediaTag (text, media) {
  const tag = mediaTag(media)
  if (tag === '') return text
  return text === '' ? tag : text + '\n' + tag
}

// One short human line for a log entry. Only a validated copy of the record
// is formatted; an invalid one prints a fixed line (raw peer fields are never
// converted to strings). Peer-derived strings are escaped.
function logLine ({ seq, record, deleted }) {
  if (deleted === true) return '#' + seq + ' apagado'
  const r = validRecordCopy(record, seq)
  if (r === null) {
    let reason
    try { reason = validateRecord(record, seq) } catch { reason = null }
    return '#' + seq + ' inválido (' + safe(typeof reason === 'string' ? reason : 'malformed') + ')'
  }
  const short = (k) => safe(k.slice(0, 8))
  let body
  if (r.type === 'follow') body = (r.on ? 'segue ' : 'deixa de seguir ') + short(r.key)
  else if (r.type === 'media-core') body = 'mídia ' + short(r.key)
  else if (r.type === 'like') body = (r.on ? 'curtiu ' : 'descurtiu ') + short(r.to.author) + '#' + r.to.seq
  else if (r.type === 'repost') body = (r.on ? 'republicou ' : 'desfez republicação ') + short(r.to.author) + '#' + r.to.seq
  else if (r.type === 'post') body = 'publicação ' + safe(withMediaTag(r.text, r.media)).replace(/\n/g, ' ') + (r.quote ? ' cita ' + short(r.quote.author) + '#' + r.quote.seq : '')
  else if (r.type === 'profile') body = 'perfil ' + safe(r.name)
  else if (r.type === 'delete') body = 'apagou #' + r.seq
  else if (r.type === 'member-cert') body = 'certificado'
  else body = safe(r.type)
  return '#' + seq + ' ' + body
}

// `log --before <seq>`: a canonical block seq, the same bound as log.read.
function logBefore (text) {
  if (text == null) return null
  const checked = /^[1-9][0-9]*$/.test(text) ? validateParams('log.read', { before: Number(text) }) : { ok: false }
  if (!checked.ok) throw usage('before inválido')
  return checked.value.before
}

async function logRun (flags) {
  const before = logBefore(flags.before)
  const { key, entries: all } = await member.logRead(ctxOf(flags), { author: flags.author || null })
  const older = before === null ? all : all.filter((entry) => entry.seq < before)
  const entries = flags.limit ? older.slice(-flags.limit) : older
  const next = entries.length < older.length ? entries[0].seq : null
  if (flags.json) {
    for (const entry of entries) process.stdout.write(jsonLine(entry) + '\n')
    process.stdout.write(jsonLine({ key, entries, next }) + '\n')
  } else {
    for (const entry of entries) process.stdout.write(logLine(entry) + '\n')
    if (next !== null) warn('há blocos mais antigos: use --before ' + next)
  }
}

// ---- feed ----

// `feed --before <cursor>`: the JSON cursor `feed` prints, validated as
// feed.read validates it.
function feedBefore (text) {
  if (text == null) return null
  let cursor
  try {
    cursor = JSON.parse(text)
  } catch {
    throw usage('before inválido')
  }
  const checked = validateParams('feed.read', { before: cursor })
  if (!checked.ok) throw usage('before inválido')
  return checked.value.before
}

async function feedRun (flags) {
  const limit = flags.limit || Infinity
  const { items, skipped, future } = await member.feedRead(ctxOf(flags), {
    limit,
    before: feedBefore(flags.before),
    onWarn: warn
  })
  const last = items.length > 0 ? items[0] : null
  const next = last !== null && items.length === limit ? { at: last.at, author: last.author, seq: last.seq } : null
  if (flags.json) {
    process.stdout.write(jsonLine({ items, skipped, future, next }) + '\n')
  } else {
    const width = feedWidth(process.stdout)
    for (const item of items) process.stdout.write(formatFeedItem({ ...item, text: withMediaTag(item.text, item.media) }, { width }) + '\n')
    if (next !== null) warn("pode haver publicações mais antigas: use --before '" + jsonLine(next) + "'")
  }
}

// Wrap width of the human feed: the terminal width on a TTY, otherwise 80
// (scripts should use --json, which is never wrapped). Floor of 20.
function feedWidth (stream) {
  const cols = stream.isTTY ? Number(stream.columns) : 80
  return Math.max(20, Number.isFinite(cols) && cols > 0 ? cols : 80)
}

module.exports = {
  publishConfig: member.publishConfig,
  feedWidth,
  commands: {
    id: { summary: 'identidade (chave pública do diário)', run: idRun },
    cert: { summary: 'grava o certificado como bloco 0 do diário', run: certRun },
    profile: { summary: 'define nome e bio', run: profileRun },
    post: { summary: 'publica um texto (--text)', run: postRun },
    reply: { summary: 'responde a uma publicação (--to <chave>:<seq> --text)', run: replyRun },
    delete: { summary: 'apaga uma publicação ou versão do perfil (--to <chave>:<seq>)', run: deleteRun },
    follow: { summary: 'segue uma chave pública', run: (flags) => followRun(flags, true) },
    unfollow: { summary: 'deixa de seguir uma chave pública', run: (flags) => followRun(flags, false) },
    follows: { summary: 'lista as chaves seguidas', run: followsRun },
    log: { summary: 'mostra os blocos locais de um diário', run: logRun },
    feed: { summary: 'feed com as publicações dos diários seguidos', run: feedRun }
  }
}
