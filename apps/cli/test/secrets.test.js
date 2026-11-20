'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Worker } = require('node:worker_threads')
const { tmpDir } = require('./helpers/net')
const sealed = require('../lib/sealed-secrets')

const BIN = path.join(__dirname, '..', 'bin', 'varanda.js')
const HEX64 = /^[0-9a-f]{64}$/

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

// Every value and secret key the tests create, and every stderr, checked
// against each other at the end: no error ever carries a secret.
const secrets = new Set()
const stderrs = []

// A child still running after 50 s, short of the 60 s kill below, is reported
// on stderr with where it waits (helpers/stuck-child.js reads /proc, so Linux
// only). Its errors are ignored: it never changes a result.
if (process.platform === 'linux') {
  const watcher = new Worker(path.join(__dirname, 'helpers', 'stuck-child.js'), { workerData: { parent: process.pid, afterMs: 50000 } })
  watcher.on('error', () => {})
  watcher.unref()
}

function varanda (args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 60000 })
  stderrs.push(r.stderr)
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function value (label) {
  const v = label + '-' + crypto.randomBytes(12).toString('hex')
  secrets.add(v)
  return v
}

function makeKey (t, dir, name) {
  const out = path.join(dir, name)
  const r = varanda(['secrets', 'key', '--out', out])
  t.is(r.code, 0, name + ' created')
  const file = JSON.parse(fs.readFileSync(out, 'utf8'))
  secrets.add(file.secretKey)
  return { file: out, publicKey: file.publicKey, secretKey: file.secretKey, stdout: r.stdout }
}

function makeSigningKey (t, dir, name) {
  const out = path.join(dir, name)
  const r = varanda(['secrets', 'signing-key', '--out', out])
  t.is(r.code, 0, name + ' created')
  const file = JSON.parse(fs.readFileSync(out, 'utf8'))
  secrets.add(file.secretKey)
  return { file: out, publicKey: file.publicKey, secretKey: file.secretKey, stdout: r.stdout }
}

function write (dir, name, text, mode = 0o644) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, text, { mode })
  fs.chmodSync(file, mode)
  return file
}

function mode (file) {
  return fs.statSync(file).mode & 0o777
}

function setup (t) {
  const dir = tmpDir(t, 'varanda-secrets-')
  const a = makeKey(t, dir, 'a-key.json')
  const b = makeKey(t, dir, 'b-key.json')
  const c = makeKey(t, dir, 'c-key.json')
  const signer = makeSigningKey(t, dir, 'signer.json')
  const other = makeSigningKey(t, dir, 'other-signer.json')
  const signers = write(dir, 'signers.txt', '# quem sela\n' + signer.publicKey.toUpperCase() + '  # mantenedora\n\n' + other.publicKey + '\n')
  const values = {
    VARANDA_DIDIT_API_KEY: value('didit'),
    VARANDA_GIF_API_URL: 'https://gif.example/v1?q=a&b=' + value('gif'),
    VARANDA_GOOGLE_CLIENT_SECRET: value('g') + ' #not-a-comment = x'
  }
  const plain = write(dir, 'plain.env', [
    '# shared credentials',
    '',
    'VARANDA_GOOGLE_CLIENT_SECRET=' + values.VARANDA_GOOGLE_CLIENT_SECRET,
    'VARANDA_DIDIT_API_KEY=' + values.VARANDA_DIDIT_API_KEY,
    '   ',
    'VARANDA_GIF_API_URL=' + values.VARANDA_GIF_API_URL,
    ''
  ].join('\n'), 0o600)
  const recipients = write(dir, 'servers.txt', '# servers\n' + a.publicKey + '  # one\n\n' + b.publicKey.toUpperCase() + '\n')
  const sealedFile = path.join(dir, 'secrets.sealed.json')
  const r = varanda(['secrets', 'seal', '--file', plain, '--recipients', recipients, '--seq', '5', '--signing-key', signer.file, '--out', sealedFile])
  t.is(r.code, 0, 'sealed')
  return { dir, a, b, c, signer, other, signers, values, plain, recipients, sealedFile, sealStdout: r.stdout }
}

test('secrets key writes a 0600 key file and prints only the public key', (t) => {
  const dir = tmpDir(t, 'varanda-secrets-')
  const k = makeKey(t, dir, 'secrets-key.json')
  t.ok(HEX64.test(k.publicKey))
  t.ok(HEX64.test(k.secretKey))
  t.is(k.stdout, k.publicKey + '\n', 'stdout is the public key alone')
  t.absent(k.stdout.includes(k.secretKey))
  t.is(mode(k.file), 0o600)
  const file = JSON.parse(fs.readFileSync(k.file, 'utf8'))
  t.alike(Object.keys(file), ['v', 'publicKey', 'secretKey'])
  t.is(file.v, 1)
  const parsed = sealed.parseKeyFile(fs.readFileSync(k.file, 'utf8'))
  t.is(parsed.publicKey, k.publicKey, 'the stored public key matches the secret key')
  t.alike(fs.readdirSync(dir), ['secrets-key.json'], 'no temp file left')

  const json = varanda(['secrets', 'key', '--out', path.join(dir, 'other.json'), '--json'])
  t.is(json.code, 0)
  t.alike(Object.keys(JSON.parse(json.stdout)), ['publicKey'])

  const before = fs.readFileSync(k.file, 'utf8')
  const again = varanda(['secrets', 'key', '--out', k.file])
  t.is(again.code, 1, 'existing --out refused')
  t.is(again.stderr, 'erro: o arquivo de saída já existe: ' + k.file + '\n')
  t.is(again.stdout, '')
  t.is(fs.readFileSync(k.file, 'utf8'), before, 'the existing key is untouched')

  const link = path.join(dir, 'link.json')
  fs.symlinkSync(path.join(dir, 'missing.json'), link)
  const viaLink = varanda(['secrets', 'key', '--out', link])
  t.is(viaLink.code, 1, 'a dangling symlink --out is refused')
  t.absent(fs.existsSync(path.join(dir, 'missing.json')))

  t.is(varanda(['secrets', 'key']).code, 2, '--out is required')
  t.is(varanda(['secrets', 'bogus']).code, 2)
  t.is(varanda(['secrets']).code, 2)
})

test('secrets seal and open: round trip with two recipients, others get exit 3', (t) => {
  const s = setup(t)
  t.is(s.sealStdout, '3 nomes selados para 2 servidores\n')
  const text = fs.readFileSync(s.sealedFile, 'utf8')
  for (const v of Object.values(s.values)) t.absent(text.includes(v), 'no value in clear in the sealed file')
  const body = JSON.parse(text)
  t.alike(Object.keys(body), ['v', 'seq', 'recipients', 'iv', 'tag', 'data', 'signer', 'signature'])
  t.is(body.seq, 5, 'the seq given to seal, as a JSON integer')
  t.is(body.v, 1)
  t.is(body.signer, s.signer.publicKey, 'the signer is the sealing key')
  t.is(Buffer.from(body.signature, 'base64').length, 64, 'an Ed25519 signature')
  t.alike(body.recipients.map((r) => r.publicKey), [s.a.publicKey, s.b.publicKey], 'recipients in file order, lower case')
  for (const r of body.recipients) t.alike(Object.keys(r), ['publicKey', 'ephemeral', 'iv', 'tag', 'key'])
  t.not(body.recipients[0].ephemeral, body.recipients[1].ephemeral, 'one ephemeral key per recipient')

  const expected = [
    "VARANDA_DIDIT_API_KEY='" + s.values.VARANDA_DIDIT_API_KEY + "'",
    "VARANDA_GIF_API_URL='" + s.values.VARANDA_GIF_API_URL + "'",
    "VARANDA_GOOGLE_CLIENT_SECRET='" + s.values.VARANDA_GOOGLE_CLIENT_SECRET + "'",
    ''
  ].join('\n')
  for (const k of [s.a, s.b]) {
    const out = path.join(s.dir, 'open-' + path.basename(k.file) + '.env')
    const r = varanda(['secrets', 'open', '--key-file', k.file, '--file', s.sealedFile, '--signers', s.signers, '--out', out])
    t.is(r.code, 0)
    t.is(r.stdout, '3 nomes gravados\n', 'prints only the count')
    t.is(r.stderr, '')
    t.is(fs.readFileSync(out, 'utf8'), expected, 'sorted, single-quoted lines')
    t.is(mode(out), 0o600)
  }

  const outC = path.join(s.dir, 'c.env')
  const notRecipient = varanda(['secrets', 'open', '--key-file', s.c.file, '--file', s.sealedFile, '--signers', s.signers, '--out', outC])
  t.is(notRecipient.code, 3)
  t.is(notRecipient.stderr, 'este servidor não é destinatário\n')
  t.is(notRecipient.stdout, '')
  t.absent(fs.existsSync(outC), 'nothing written for a non-recipient')

  const json = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', s.signers, '--out', path.join(s.dir, 'j.env'), '--json'])
  t.alike(JSON.parse(json.stdout), { written: 3 })

  const existing = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.signer.file, '--out', s.sealedFile])
  t.is(existing.code, 1, 'seal refuses an existing --out')
  t.is(fs.readFileSync(s.sealedFile, 'utf8'), text, 'the sealed file is untouched')

  t.is(varanda(['secrets', 'open', '--file', s.sealedFile, '--signers', s.signers, '--out', outC]).code, 2, '--key-file is required')
  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--seq', '1', '--signing-key', s.signer.file, '--out', outC + '.x']).code, 2, '--recipients is required')
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--signers', s.signers, '--out', outC]).code, 2, '--file is required')
})

test('secrets open replaces --out atomically', (t) => {
  const s = setup(t)
  const outDir = path.join(s.dir, 'o')
  fs.mkdirSync(outDir)
  const out = write(outDir, 'aberto.env', "VARANDA_DIDIT_API_KEY='old'\n", 0o644)
  const inode = fs.statSync(out).ino
  const r = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', s.signers, '--out', out])
  t.is(r.code, 0)
  t.ok(fs.readFileSync(out, 'utf8').includes(s.values.VARANDA_DIDIT_API_KEY), 'new content')
  t.is(mode(out), 0o600, 'the replaced file is 0600')
  t.not(fs.statSync(out).ino, inode, 'a new file renamed over the old one')
  t.alike(fs.readdirSync(outDir), ['aberto.env'], 'no temp file left')

  // A failed open leaves the previous file as it was.
  const before = fs.readFileSync(out, 'utf8')
  const bad = write(s.dir, 'bad.json', '{}')
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', bad, '--signers', s.signers, '--out', out]).code, 1)
  t.is(fs.readFileSync(out, 'utf8'), before)
  t.alike(fs.readdirSync(outDir), ['aberto.env'])
})

test('secrets open refuses a key file that is a symlink, not a file or too open', (t) => {
  const s = setup(t)
  const out = path.join(s.dir, 'x.env')
  const run = (keyFile) => varanda(['secrets', 'open', '--key-file', keyFile, '--file', s.sealedFile, '--signers', s.signers, '--out', out])

  const link = path.join(s.dir, 'link-key.json')
  fs.symlinkSync(s.a.file, link)
  const viaLink = run(link)
  t.is(viaLink.code, 1)
  t.is(viaLink.stderr, 'erro: o arquivo de chave é um link simbólico: ' + link + '\n')

  const notFile = run(s.dir)
  t.is(notFile.code, 1)
  t.is(notFile.stderr, 'erro: o arquivo de chave não é um arquivo comum: ' + s.dir + '\n')

  for (const m of [0o640, 0o604, 0o660]) {
    fs.chmodSync(s.a.file, m)
    const open = run(s.a.file)
    t.is(open.code, 1, 'mode ' + m.toString(8) + ' refused')
    t.is(open.stderr, 'erro: o arquivo de chave pode ser lido por outros usuários (use chmod 600): ' + s.a.file + '\n')
  }
  fs.chmodSync(s.a.file, 0o400)
  t.is(run(s.a.file).code, 0, '0400 is fine')

  const mismatch = JSON.parse(fs.readFileSync(s.b.file, 'utf8'))
  mismatch.publicKey = s.a.publicKey
  const forged = write(s.dir, 'forged-key.json', JSON.stringify(mismatch), 0o600)
  const r = run(forged)
  t.is(r.code, 1, 'a public key that does not match the secret key is refused')
  t.is(r.stderr, 'erro: arquivo de chave inválido\n')
})

test('secrets open refuses every tampered sealed file without writing', (t) => {
  const s = setup(t)
  const original = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64')
    buf[0] ^= 1
    return buf.toString('base64')
  }
  const cases = {
    'payload data': (o) => { o.data = flip(o.data) },
    'payload tag': (o) => { o.tag = flip(o.tag) },
    'payload iv': (o) => { o.iv = flip(o.iv) },
    'wrapped key': (o) => { o.recipients[0].key = flip(o.recipients[0].key) },
    'wrap tag': (o) => { o.recipients[0].tag = flip(o.recipients[0].tag) },
    ephemeral: (o) => { o.recipients[0].ephemeral = o.recipients[1].ephemeral },
    'other recipient dropped': (o) => { o.recipients.pop() },
    'recipients reordered': (o) => { o.recipients.reverse() },
    'unknown v': (o) => { o.v = 2 },
    'extra top-level key': (o) => { o.note = 'x' },
    'no signature': (o) => { delete o.signer; delete o.signature },
    'signature dropped': (o) => { delete o.signature },
    'short signature': (o) => { o.signature = Buffer.alloc(32).toString('base64') },
    'upper-case signer': (o) => { o.signer = o.signer.toUpperCase() },
    'extra recipient key': (o) => { o.recipients[0].note = 'x' },
    'missing key': (o) => { delete o.tag },
    'short tag': (o) => { o.tag = Buffer.alloc(8).toString('base64') },
    'non-canonical base64': (o) => { o.iv = o.iv.replace(/=*$/, '') + '\n' },
    'duplicate recipient': (o) => { o.recipients[1] = o.recipients[0] },
    'upper-case key': (o) => { o.recipients[0].publicKey = o.recipients[0].publicKey.toUpperCase() }
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = JSON.parse(JSON.stringify(original))
    mutate(copy)
    const file = write(s.dir, 'tampered.json', JSON.stringify(copy))
    const out = path.join(s.dir, 'tampered.env')
    const r = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', file, '--signers', s.signers, '--out', out])
    t.is(r.code, 1, name + ': exit 1')
    t.is(r.stdout, '', name + ': nothing printed')
    t.ok(/^erro: (arquivo selado inválido|arquivo selado sem assinatura|assinatura do arquivo selado inválida|versão do arquivo selado desconhecida)\n$/.test(r.stderr), name + ': ' + r.stderr.trim())
    t.absent(fs.existsSync(out), name + ': nothing written')
  }
  const garbage = write(s.dir, 'garbage.json', 'not json')
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', garbage, '--signers', s.signers, '--out', path.join(s.dir, 'g.env')]).code, 1)
})

test('secrets seal: allow-list, refused names, values and recipients', (t) => {
  const dir = tmpDir(t, 'varanda-secrets-')
  const a = makeKey(t, dir, 'a.json')
  const signer = makeSigningKey(t, dir, 'signer.json')
  const recipients = write(dir, 'servers.txt', a.publicKey + '\n')
  let n = 0
  const seal = (plainText, recipientsFile = recipients) => {
    const plain = write(dir, 'plain-' + (++n) + '.env', plainText, 0o600)
    const out = path.join(dir, 'out-' + n + '.json')
    const r = varanda(['secrets', 'seal', '--file', plain, '--recipients', recipientsFile, '--seq', '1', '--signing-key', signer.file, '--out', out])
    r.out = out
    return r
  }

  for (const name of sealed.ALLOWED) {
    const r = seal(name + '=' + value(name) + '\n')
    t.is(r.code, 0, name + ' is allowed')
  }
  t.alike([...sealed.ALLOWED].sort(), [
    'VARANDA_AUDIUS_API_KEY', 'VARANDA_DIDIT_API_KEY', 'VARANDA_DIDIT_WORKFLOW_ID', 'VARANDA_GIF_API_KEY',
    'VARANDA_GIF_API_URL', 'VARANDA_GIF_MEDIA_HOSTS', 'VARANDA_GOOGLE_CLIENT_ID', 'VARANDA_GOOGLE_CLIENT_SECRET'
  ])

  for (const name of ['VARANDA_PHONE_KEY', 'VARANDA_PAGE_KEYS', 'VARANDA_TRIAGE_TOKEN', 'VARANDA_PUSH_TOKEN']) {
    const v = value(name)
    const r = seal('VARANDA_DIDIT_API_KEY=' + value('ok') + '\n' + name + '=' + v + '\n')
    t.is(r.code, 1, name + ' refused')
    t.is(r.stderr, 'erro: nome não permitido: ' + name + '\n', name + ' refused by name only')
    t.absent(fs.existsSync(r.out), 'nothing sealed')
  }
  // A stray secret line (a base32 key ending in "="), or a known name glued
  // to its value, parses as a name: only an exactly known name is echoed,
  // anything else is reported by line number.
  const stray = 'JBSWY3DP' + crypto.randomBytes(8).toString('hex').toUpperCase()
  secrets.add(stray)
  for (const name of ['OTHER', 'VARANDA_OTHER', stray, 'VARANDA_GIF_API_KEY' + stray, 'VARANDA_PHONE_KEY' + stray]) {
    const r = seal('VARANDA_DIDIT_API_KEY=' + value('ok') + '\n' + name + '====\n')
    t.is(r.code, 1, 'an unknown name is refused')
    t.is(r.stderr, 'erro: linha 2: nome não permitido\n', 'reported by line number only')
  }

  const charset = 'erro: valor inválido em VARANDA_GIF_API_KEY: use de 1 a 4096 caracteres ASCII imprimíveis, sem aspas simples nem barra invertida\n'
  const quote = seal('VARANDA_GIF_API_KEY=' + value("it's") + '\n')
  t.is(quote.code, 1, 'a single quote is refused')
  t.is(quote.stderr, charset)
  for (const v of [value('a') + '\\', value('a') + '\\b', '\\' + value('a')]) {
    const r = seal('VARANDA_GIF_API_KEY=' + v + '\n')
    t.is(r.code, 1, 'a backslash is refused')
    t.is(r.stderr, charset)
  }
  for (const [v, message] of [
    [' ' + value('lead'), 'tire os espaços do começo e do fim'],
    [value('trail') + ' ', 'tire os espaços do começo e do fim'],
    ['"' + value('dq') + '"', 'tire as aspas duplas em volta do valor']
  ]) {
    const r = seal('VARANDA_GIF_API_KEY=' + v + '\n')
    t.is(r.code, 1, 'refused: ' + message)
    t.is(r.stderr, 'erro: valor inválido em VARANDA_GIF_API_KEY: ' + message + '\n', 'names only the variable')
  }
  t.is(seal('VARANDA_GIF_API_KEY=a "b" ' + value('inner') + '\n').code, 0, 'inner spaces and double quotes are fine')
  t.is(seal('VARANDA_GIF_API_KEY="' + value('one') + '\n').code, 0, 'a lone leading double quote is kept literally')

  t.is(seal('VARANDA_GIF_API_KEY=\n').code, 1, 'an empty value is refused')
  t.is(seal('VARANDA_GIF_API_KEY=' + 'a'.repeat(4096) + '\n').code, 0, '4096 characters are fine')
  t.is(seal('VARANDA_GIF_API_KEY=' + 'a'.repeat(4097) + '\n').code, 1, '4097 characters are refused')
  t.is(seal('VARANDA_GIF_API_KEY=café' + value('x') + '\n').code, 1, 'non-ASCII is refused')
  t.is(seal('VARANDA_GIF_API_KEY=a\tb' + value('x') + '\n').code, 1, 'a tab is refused')
  const dup = seal('VARANDA_GIF_API_KEY=' + value('one') + '\nVARANDA_GIF_API_KEY=' + value('two') + '\n')
  t.is(dup.stderr, 'erro: nome repetido: VARANDA_GIF_API_KEY\n')
  const badLine = seal('# x\n' + value('naked') + '\n')
  t.is(badLine.stderr, 'erro: linha 2 inválida: use NOME=valor\n', 'a bad line is named by number only')
  const lower = seal('varanda_gif_api_key=' + value('lower') + '\n')
  t.is(lower.stderr, 'erro: linha 1 inválida: use NOME=valor\n')
  t.is(seal('# only comments\n\n').stderr, 'erro: nenhum segredo no arquivo\n')
  t.is(seal('VARANDA_GIF_API_KEY=' + value('crlf') + '\r\n').code, 0, 'CRLF line endings are fine')

  const okPlain = 'VARANDA_GIF_API_KEY=' + value('r') + '\n'
  const b = makeKey(t, dir, 'b.json')
  t.is(seal(okPlain, write(dir, 'dup.txt', a.publicKey + '\n' + a.publicKey.toUpperCase() + '\n')).stderr, 'erro: destinatário repetido na linha 2\n')
  t.is(seal(okPlain, write(dir, 'bad.txt', a.publicKey + '\nnot-a-key\n')).stderr, 'erro: destinatário inválido na linha 2\n')
  t.is(seal(okPlain, write(dir, 'empty.txt', '# none\n')).stderr, 'erro: nenhum destinatário\n')
  const many = Array.from({ length: 65 }, () => crypto.randomBytes(32).toString('hex')).join('\n')
  t.is(seal(okPlain, write(dir, 'many.txt', many)).stderr, 'erro: mais de 64 destinatários\n')
  t.is(seal(okPlain, write(dir, 'low.txt', '00'.repeat(32) + '\n')).stderr, 'erro: chave pública inválida: destinatário 1\n', 'a low-order key is refused')
  const sixtyFour = [a.publicKey, b.publicKey, ...Array.from({ length: 62 }, () => sealed.generateKeyFile().publicKey)].join('\n')
  t.is(seal(okPlain, write(dir, 'max.txt', sixtyFour)).code, 0, '64 recipients are fine')
})

test('sealed-secrets: canonical payload and recipient AAD', (t) => {
  const payload = sealed.canonicalPayload(new Map([['VARANDA_GIF_API_URL', 'https://x/?a=b'], ['VARANDA_DIDIT_API_KEY', 'k']]))
  t.is(payload.toString('utf8'), 'VARANDA_DIDIT_API_KEY=k\nVARANDA_GIF_API_URL=https://x/?a=b\n')
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  t.is(sealed.recipientsAad([b, a]).toString('utf8'), 'varanda-secrets-v1\n' + b + '\n' + a)

  const key = sealed.generateKeyFile()
  const parsed = sealed.parseKeyFile(JSON.stringify(key))
  const signing = sealed.generateSigningKeyFile()
  const signer = sealed.parseSigningKeyFile(JSON.stringify(signing))
  const box = sealed.seal(new Map([['VARANDA_DIDIT_API_KEY', 'k']]), [key.publicKey], signer, 4294967295)
  t.alike(sealed.open(JSON.stringify(box), parsed, [signing.publicKey]), new Map([['VARANDA_DIDIT_API_KEY', 'k']]))
  t.alike(sealed.verify(JSON.stringify(box), [signing.publicKey]), { signer: signing.publicKey, recipients: 1, seq: 4294967295 })
  t.exception(() => sealed.open(JSON.stringify(box), parsed, []), /lista de quem sela: nenhuma chave/, 'open needs a signer list')
  t.exception(() => sealed.open(JSON.stringify(box), parsed), /lista de quem sela: nenhuma chave/, 'open without a signer list throws')
  t.exception(() => sealed.seal(new Map([['VARANDA_DIDIT_API_KEY', 'k']]), [key.publicKey]), /falta a chave de assinatura/, 'seal needs a signing key')
  for (const seq of [undefined, 0, -1, 1.5, 4294967296, '1', NaN, 2 ** 53]) {
    t.exception(() => sealed.seal(new Map([['VARANDA_DIDIT_API_KEY', 'k']]), [key.publicKey], signer, seq), /seq inválido/, 'seal refuses seq ' + String(seq))
  }
  t.is(sealed.formatEnv(new Map([['VARANDA_GIF_API_KEY', 'b'], ['VARANDA_DIDIT_API_KEY', 'a b']])), "VARANDA_DIDIT_API_KEY='a b'\nVARANDA_GIF_API_KEY='b'\n")
})

// The signed bytes as docs/protocol.md defines them, written apart from the
// module: a context string, then every field as uint32be length || bytes.
function signedBytesSpec (o) {
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const hex = (h) => Buffer.from(h, 'hex')
  const b64 = (v) => Buffer.from(v, 'base64')
  const fields = [u32(o.v), u32(o.seq), u32(o.recipients.length)]
  for (const r of o.recipients) fields.push(hex(r.publicKey), hex(r.ephemeral), b64(r.iv), b64(r.tag), b64(r.key))
  fields.push(b64(o.iv), b64(o.tag), b64(o.data), hex(o.signer))
  return Buffer.concat([Buffer.from('varanda-secrets-signature-v1', 'utf8'), ...fields.flatMap((f) => [u32(f.length), f])])
}

// Signs a sealed object (signer: a signing key file's JSON) apart from the
// module.
function signSpec (o, signer) {
  const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(signer.secretKey, 'hex')]), format: 'der', type: 'pkcs8' })
  o.signer = signer.publicKey
  o.signature = crypto.sign(null, signedBytesSpec(o), privateKey).toString('base64')
  return o
}

// Seals `payload` bytes as-is, following the v1 format in sealed-secrets.js
// independently of the module, so open's own checks are what refuse it.
function forge (payload, recipientHex, signer) {
  const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
  const contentKey = crypto.randomBytes(32)
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const ephemeralPublic = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const recipientPublic = Buffer.from(recipientHex, 'hex')
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI, recipientPublic]), format: 'der', type: 'spki' })
  })
  const kek = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), 'varanda-secrets-v1', 32))
  const gcm = (key, plain, aad) => {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    if (aad) cipher.setAAD(aad)
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }
  const wrapped = gcm(kek, contentKey, null)
  const body = gcm(contentKey, Buffer.from(payload, 'utf8'), Buffer.from('varanda-secrets-v1\n' + recipientHex, 'utf8'))
  return signSpec({
    v: 1,
    seq: 1,
    recipients: [{ publicKey: recipientHex, ephemeral: ephemeralPublic.toString('hex'), iv: wrapped.iv, tag: wrapped.tag, key: wrapped.data }],
    iv: body.iv,
    tag: body.tag,
    data: body.data
  }, signer)
}

test('secrets open refuses a forged payload with a backslash, a quote or edge spaces', (t) => {
  const dir = tmpDir(t, 'varanda-secrets-')
  const a = makeKey(t, dir, 'a.json')
  const signer = makeSigningKey(t, dir, 'signer.json')
  const signers = write(dir, 'signers.txt', signer.publicKey + '\n')
  const open = (payload, name) => {
    const file = write(dir, name + '.json', JSON.stringify(forge(payload, a.publicKey, signer)))
    const out = path.join(dir, name + '.env')
    const r = varanda(['secrets', 'open', '--key-file', a.file, '--file', file, '--signers', signers, '--out', out])
    r.out = out
    return r
  }
  const good = open('VARANDA_DIDIT_API_KEY=' + value('good') + '\n', 'good')
  t.is(good.code, 0, 'the forger follows the format')
  t.is(good.stdout, '1 nome gravado\n', 'singular for one name')

  // Compose reads a trailing backslash as an escape of the closing quote, so
  // the next line could inject a variable.
  const injected = 'VARANDA_AUDIUS_API_KEY=' + value('x') + '\\\nVARANDA_DIDIT_API_KEY=VARANDA_PHONE_KEY=injected #\n'
  for (const [name, payload] of Object.entries({
    'trailing-backslash': injected,
    'inner-backslash': 'VARANDA_DIDIT_API_KEY=' + value('a') + '\\b\n',
    'single-quote': 'VARANDA_DIDIT_API_KEY=' + value("it's") + '\n',
    'edge-space': 'VARANDA_DIDIT_API_KEY=' + value('s') + ' \n',
    'double-quoted': 'VARANDA_DIDIT_API_KEY="' + value('q') + '"\n',
    unsorted: 'VARANDA_GIF_API_KEY=' + value('g') + '\nVARANDA_DIDIT_API_KEY=' + value('d') + '\n',
    'not-allowed': 'VARANDA_PHONE_KEY=' + value('p') + '\n'
  })) {
    const r = open(payload, name)
    t.is(r.code, 1, name + ': exit 1')
    t.is(r.stderr, 'erro: arquivo selado inválido\n', name + ': no value in the message')
    t.absent(fs.existsSync(r.out), name + ': nothing written')
  }
})

test('sealed-secrets: formatEnv refuses what compose could misread', (t) => {
  for (const v of ['a\\', 'a\\b', "a'b", ' a', 'a ', '"a"', '']) {
    t.exception(() => sealed.formatEnv(new Map([['VARANDA_GIF_API_KEY', v]])), /^Error: valor inválido em VARANDA_GIF_API_KEY: /, JSON.stringify(v) + ' refused')
  }
  t.exception(() => sealed.canonicalPayload(new Map([['VARANDA_GIF_API_KEY', 'a\\']])), /valor inválido/, 'seal refuses it too')
})

test('secrets: --out may not name an input, singular and plural counts', (t) => {
  const s = setup(t)
  const keyBefore = fs.readFileSync(s.a.file, 'utf8')
  const sealedBefore = fs.readFileSync(s.sealedFile, 'utf8')
  const open = (out, keyFile = s.a.file, file = s.sealedFile) => varanda(['secrets', 'open', '--key-file', keyFile, '--file', file, '--signers', s.signers, '--out', out])

  const sameKey = open(s.a.file)
  t.is(sameKey.code, 2, 'open --out equal to --key-file')
  t.ok(sameKey.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --key-file\n'))
  const sameFile = open(s.sealedFile)
  t.is(sameFile.code, 2, 'open --out equal to --file')
  t.ok(sameFile.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --file\n'))
  const spelled = open(path.join(s.dir, 'o', '..', path.basename(s.a.file)))
  t.is(spelled.code, 2, 'another spelling of the same path')
  const linkDir = path.join(s.dir, 'linked')
  fs.symlinkSync(s.dir, linkDir)
  const viaDir = open(path.join(linkDir, path.basename(s.sealedFile)))
  t.is(viaDir.code, 2, 'the same entry through a symlinked directory')
  t.is(fs.readFileSync(s.a.file, 'utf8'), keyBefore, 'the key file is untouched')
  t.is(fs.readFileSync(s.sealedFile, 'utf8'), sealedBefore, 'the sealed file is untouched')

  const sealTo = (out) => varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.signer.file, '--out', out])
  const sealPlain = sealTo(s.plain)
  t.is(sealPlain.code, 2, 'seal --out equal to --file')
  t.ok(sealPlain.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --file\n'))
  const sealRecipients = sealTo(s.recipients)
  t.is(sealRecipients.code, 2, 'seal --out equal to --recipients')
  t.ok(sealRecipients.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --recipients\n'))
  const keyOut = path.join(s.dir, 'new-key.json')
  const keySame = varanda(['secrets', 'key', '--out', keyOut, '--key-file', keyOut])
  t.is(keySame.code, 2, 'key --out equal to --key-file')
  t.absent(fs.existsSync(keyOut))

  const one = write(s.dir, 'one.env', 'VARANDA_GIF_API_KEY=' + value('one') + '\n', 0o600)
  const oneRecipient = write(s.dir, 'one.txt', s.a.publicKey + '\n')
  const oneSealed = path.join(s.dir, 'one.sealed.json')
  const r = varanda(['secrets', 'seal', '--file', one, '--recipients', oneRecipient, '--seq', '1', '--signing-key', s.signer.file, '--out', oneSealed])
  t.is(r.stdout, '1 nome selado para 1 servidor\n', 'singular')
  t.is(open(path.join(s.dir, 'one-open.env'), s.a.file, oneSealed).stdout, '1 nome gravado\n', 'singular')
  t.is(s.sealStdout, '3 nomes selados para 2 servidores\n', 'plural')
  t.is(open(path.join(s.dir, 'three.env')).stdout, '3 nomes gravados\n', 'plural')
})

test('secrets open refuses an input that is a link to the existing --out', (t) => {
  const s = setup(t)
  const before = fs.readFileSync(s.sealedFile, 'utf8')
  const link = path.join(s.dir, 'link.json')
  fs.symlinkSync(s.sealedFile, link)
  const r = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', link, '--signers', s.signers, '--out', s.sealedFile])
  t.is(r.code, 2, '--file is a symlink to --out')
  t.ok(r.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --file\n'))
  t.is(fs.readFileSync(s.sealedFile, 'utf8'), before, 'the sealed file is not overwritten with plaintext')

  // The other way round: --out is a link to the input.
  const outLink = path.join(s.dir, 'out-link.env')
  fs.symlinkSync(s.sealedFile, outLink)
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', s.signers, '--out', outLink]).code, 2, '--out is a symlink to --file')
  const hard = path.join(s.dir, 'hard.json')
  fs.linkSync(s.sealedFile, hard)
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', hard, '--signers', s.signers, '--out', s.sealedFile]).code, 2, 'a hard link of --out')
  t.is(fs.readFileSync(s.sealedFile, 'utf8'), before)
})

test('secrets: inodes are compared as BigInt', (t) => {
  const { clash } = require('../lib/commands/secrets')
  // Two inodes that differ only above 2^53: as Numbers they would collide.
  const inodes = { '/o/out.env': 2n ** 53n, '/i/in.json': 2n ** 53n + 1n }
  const statFs = {}
  for (const method of ['lstatSync', 'statSync']) {
    statFs[method] = (file, options) => {
      const ino = inodes[file]
      return options && options.bigint ? { dev: 1n, ino } : { dev: 1, ino: Number(ino) }
    }
  }
  t.is(clash('/o/out.env', [['--file', '/i/in.json']], statFs), null, 'distinct inodes above 2^53 do not clash')
  t.is(clash('/o/out.env', [['--file', '/o/out.env']], statFs), '--file', 'the same path clashes')
  inodes['/i/in.json'] = 2n ** 53n
  t.is(clash('/o/out.env', [['--file', '/i/in.json']], statFs), '--file', 'the same inode clashes')
})

test('secrets leaves no temp file when the write fails', async (t) => {
  const s = setup(t)
  const { parseArgs } = require('../lib/cli')
  const { commands } = require('../lib/commands/secrets')
  const outDir = path.join(s.dir, 'fail')
  fs.mkdirSync(outDir)
  const runs = {
    open: ['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', s.signers, '--out', path.join(outDir, 'aberto.env')],
    key: ['secrets', 'key', '--out', path.join(outDir, 'secrets-key.json')]
  }
  for (const [name, argv] of Object.entries(runs)) {
    const fsync = fs.fsyncSync
    fs.fsyncSync = () => {
      const err = new Error('ENOSPC: no space left on device')
      err.code = 'ENOSPC'
      throw err
    }
    try {
      await t.exception(async () => commands.secrets.run(parseArgs(argv, {}, s.dir)), /ENOSPC/, name + ' fails')
    } finally {
      fs.fsyncSync = fsync
    }
    t.alike(fs.readdirSync(outDir), [], name + ': no temp file and no output left')
  }
})

test('secrets refuses a FIFO as any input without blocking', (t) => {
  const s = setup(t)
  const fifo = path.join(s.dir, 'fifo')
  const made = spawnSync('mkfifo', ['-m', '600', fifo])
  if (made.status !== 0) {
    t.fail('mkfifo failed')
    return
  }
  const out = path.join(s.dir, 'f.env')
  const asKey = varanda(['secrets', 'open', '--key-file', fifo, '--file', s.sealedFile, '--signers', s.signers, '--out', out])
  t.is(asKey.code, 1, 'FIFO --key-file refused')
  t.is(asKey.stderr, 'erro: o arquivo de chave não é um arquivo comum: ' + fifo + '\n')
  const asSealed = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', fifo, '--signers', s.signers, '--out', out])
  t.is(asSealed.code, 1, 'FIFO --file refused')
  t.is(asSealed.stderr, 'erro: arquivo selado não é um arquivo comum: ' + fifo + '\n')
  const asRecipients = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', fifo, '--seq', '1', '--signing-key', s.signer.file, '--out', path.join(s.dir, 'f.json')])
  t.is(asRecipients.code, 1, 'FIFO --recipients refused')
  t.absent(fs.existsSync(out))
})

test('secrets signing-key writes a 0600 key file and prints only the public key', (t) => {
  const dir = tmpDir(t, 'varanda-secrets-')
  const k = makeSigningKey(t, dir, 'signing-key.json')
  t.ok(HEX64.test(k.publicKey))
  t.ok(HEX64.test(k.secretKey))
  t.is(k.stdout, k.publicKey + '\n', 'stdout is the public key alone')
  t.absent(k.stdout.includes(k.secretKey))
  t.is(mode(k.file), 0o600)
  const file = JSON.parse(fs.readFileSync(k.file, 'utf8'))
  t.alike(Object.keys(file), ['v', 'type', 'publicKey', 'secretKey'])
  t.is(file.v, 1)
  t.is(file.type, 'varanda-secrets-signing-key', 'the file says what it is')
  t.is(sealed.parseSigningKeyFile(fs.readFileSync(k.file, 'utf8')).publicKey, k.publicKey, 'the stored public key matches the secret key')
  t.alike(fs.readdirSync(dir), ['signing-key.json'], 'no temp file left')

  const json = varanda(['secrets', 'signing-key', '--out', path.join(dir, 'other.json'), '--json'])
  t.is(json.code, 0)
  t.alike(Object.keys(JSON.parse(json.stdout)), ['publicKey'])

  const before = fs.readFileSync(k.file, 'utf8')
  const again = varanda(['secrets', 'signing-key', '--out', k.file])
  t.is(again.code, 1, 'existing --out refused')
  t.is(again.stderr, 'erro: o arquivo de saída já existe: ' + k.file + '\n')
  t.is(fs.readFileSync(k.file, 'utf8'), before, 'the existing key is untouched')
  const link = path.join(dir, 'link.json')
  fs.symlinkSync(path.join(dir, 'missing.json'), link)
  t.is(varanda(['secrets', 'signing-key', '--out', link]).code, 1, 'a dangling symlink --out is refused')
  t.absent(fs.existsSync(path.join(dir, 'missing.json')))
  t.is(varanda(['secrets', 'signing-key']).code, 2, '--out is required')
})

test('secrets: a server key and a signing key are never taken for each other', (t) => {
  const s = setup(t)
  const out = path.join(s.dir, 'x.env')
  const asServer = varanda(['secrets', 'open', '--key-file', s.signer.file, '--file', s.sealedFile, '--signers', s.signers, '--out', out])
  t.is(asServer.code, 1, 'a signing key as --key-file is refused')
  t.is(asServer.stderr, 'erro: este arquivo é uma chave de assinatura, não a chave do servidor\n')
  const sealedOut = path.join(s.dir, 'x.json')
  const asSigner = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.a.file, '--out', sealedOut])
  t.is(asSigner.code, 1, 'a server key as --signing-key is refused')
  t.is(asSigner.stderr, 'erro: este arquivo é uma chave de servidor, não uma chave de assinatura\n')
  t.absent(fs.existsSync(sealedOut))

  const forged = JSON.parse(fs.readFileSync(s.signer.file, 'utf8'))
  forged.publicKey = s.other.publicKey
  const mismatch = write(s.dir, 'mismatch.json', JSON.stringify(forged), 0o600)
  const r = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', mismatch, '--out', sealedOut])
  t.is(r.code, 1, 'a public key that does not match the secret key is refused')
  t.is(r.stderr, 'erro: arquivo de chave inválido\n')
  const wrongType = JSON.parse(fs.readFileSync(s.signer.file, 'utf8'))
  wrongType.type = 'varanda-secrets-server-key'
  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', write(s.dir, 'type.json', JSON.stringify(wrongType), 0o600), '--out', sealedOut]).stderr, 'erro: arquivo de chave inválido\n', 'another type string is refused')

  fs.chmodSync(s.signer.file, 0o644)
  const open = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.signer.file, '--out', sealedOut])
  t.is(open.code, 1, 'a signing key readable by others is refused')
  t.is(open.stderr, 'erro: o arquivo de chave pode ser lido por outros usuários (use chmod 600): ' + s.signer.file + '\n')
  const link = path.join(s.dir, 'signer-link.json')
  fs.chmodSync(s.signer.file, 0o600)
  fs.symlinkSync(s.signer.file, link)
  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', link, '--out', sealedOut]).code, 1, 'a symlinked signing key is refused')
  t.absent(fs.existsSync(sealedOut))
})

test('secrets: seal needs --signing-key, open and verify need --signers', (t) => {
  const s = setup(t)
  const out = path.join(s.dir, 'u.json')
  const noSigner = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--out', out])
  t.is(noSigner.code, 2, 'seal without --signing-key')
  t.ok(noSigner.stderr.startsWith('uso: informe --signing-key <arquivo>\n'))
  t.absent(fs.existsSync(out))
  const noList = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--out', out])
  t.is(noList.code, 2, 'open without --signers')
  t.ok(noList.stderr.startsWith('uso: informe --signers <arquivo>\n'))
  t.absent(fs.existsSync(out))
  const verifyNoList = varanda(['secrets', 'verify', '--file', s.sealedFile])
  t.is(verifyNoList.code, 2, 'verify without --signers')
  t.ok(verifyNoList.stderr.startsWith('uso: informe --signers <arquivo>\n'))
  t.is(varanda(['secrets', 'verify', '--signers', s.signers]).code, 2, 'verify without --file')
  t.is(varanda(['secrets', 'verify', 'extra', '--file', s.sealedFile, '--signers', s.signers]).code, 2, 'no extra positional')

  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.signer.file, '--out', s.signer.file]).code, 2, 'seal --out equal to --signing-key')
  const sameList = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', s.signers, '--out', s.signers])
  t.is(sameList.code, 2, 'open --out equal to --signers')
  t.ok(sameList.stderr.startsWith('uso: --out não pode ser o mesmo arquivo de --signers\n'))
  t.ok(fs.readFileSync(s.signers, 'utf8').startsWith('# quem sela\n'), 'the signers file is untouched')
})

test('secrets verify and open: only a listed signer, checked before decryption', (t) => {
  const s = setup(t)
  const ok = varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', s.signers])
  t.is(ok.code, 0)
  t.is(ok.stdout, 'assinatura válida: ' + s.signer.publicKey + ', seq 5, 2 servidores\n', 'signer, seq and recipient count')
  t.is(ok.stderr, '')
  const json = varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', s.signers, '--json'])
  // The exact line update.sh matches: these keys, in this order, one line.
  t.is(json.stdout, '{"signer":"' + s.signer.publicKey + '","recipients":2,"seq":5}\n', 'the --json contract')
  t.is(json.stderr, '')

  const onlyOther = write(s.dir, 'only-other.txt', s.other.publicKey + '\n')
  const unlisted = 'erro: o arquivo selado não foi assinado por uma chave da lista de quem sela\n'
  const v = varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', onlyOther])
  t.is(v.code, 1, 'verify: unlisted signer')
  t.is(v.stderr, unlisted)
  t.is(v.stdout, '')

  const out = path.join(s.dir, 'unlisted.env')
  const o = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', onlyOther, '--out', out])
  t.is(o.code, 1, 'open: unlisted signer')
  t.is(o.stderr, unlisted)
  t.absent(fs.existsSync(out), 'nothing written')
  const existing = write(s.dir, 'existing.env', "VARANDA_DIDIT_API_KEY='old'\n", 0o600)
  t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', onlyOther, '--out', existing]).code, 1)
  t.is(fs.readFileSync(existing, 'utf8'), "VARANDA_DIDIT_API_KEY='old'\n", 'an existing --out is untouched')

  // Signature first: a server outside the recipient list gets 3 only for a
  // file that verified.
  const c = (file, signers) => varanda(['secrets', 'open', '--key-file', s.c.file, '--file', file, '--signers', signers, '--out', out])
  t.is(c(s.sealedFile, s.signers).code, 3, 'a valid file: not a recipient')
  const notListed = c(s.sealedFile, onlyOther)
  t.is(notListed.code, 1, 'a non-recipient with an unlisted signer gets 1, not 3')
  t.is(notListed.stderr, unlisted)
  const body = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  body.data = flipB64(body.data)
  const badSig = c(write(s.dir, 'bad-sig.json', JSON.stringify(body)), s.signers)
  t.is(badSig.code, 1, 'a non-recipient with a bad signature gets 1, not 3')
  t.is(badSig.stderr, 'erro: assinatura do arquivo selado inválida\n')
  t.absent(fs.existsSync(out))

  // A file from before signatures says so.
  const unsigned = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  delete unsigned.signer
  delete unsigned.signature
  const unsignedFile = write(s.dir, 'unsigned.json', JSON.stringify(unsigned))
  t.is(varanda(['secrets', 'verify', '--file', unsignedFile, '--signers', s.signers]).stderr, 'erro: arquivo selado sem assinatura\n', 'verify: an unsigned file')
  const u = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', unsignedFile, '--signers', s.signers, '--out', out])
  t.is(u.code, 1, 'open: an unsigned file')
  t.is(u.stderr, 'erro: arquivo selado sem assinatura\n')
  t.absent(fs.existsSync(out))

  // A file sealed by another key in the list verifies too.
  const otherSealed = path.join(s.dir, 'other.sealed.json')
  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '1', '--signing-key', s.other.file, '--out', otherSealed]).code, 0)
  t.is(varanda(['secrets', 'verify', '--file', otherSealed, '--signers', s.signers]).stdout, 'assinatura válida: ' + s.other.publicKey + ', seq 1, 2 servidores\n')
  t.is(varanda(['secrets', 'verify', '--file', otherSealed, '--signers', write(s.dir, 'only-signer.txt', s.signer.publicKey + '\n')]).code, 1)
})

function flipB64 (v) {
  const buf = Buffer.from(v, 'base64')
  buf[buf.length - 1] ^= 1
  return buf.toString('base64')
}

function flipHex (h) {
  return h.slice(0, -1) + (parseInt(h.slice(-1), 16) ^ 1).toString(16)
}

test('secrets: a flipped byte in any signed field fails verify and open', (t) => {
  const s = setup(t)
  const original = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  const badSig = 'erro: assinatura do arquivo selado inválida\n'
  const cases = {
    'recipient list (a public key)': [(o) => { o.recipients[1].publicKey = flipHex(o.recipients[1].publicKey) }, badSig],
    'recipient ephemeral key': [(o) => { o.recipients[0].ephemeral = flipHex(o.recipients[0].ephemeral) }, badSig],
    'wrapped key': [(o) => { o.recipients[0].key = flipB64(o.recipients[0].key) }, badSig],
    'wrap iv': [(o) => { o.recipients[0].iv = flipB64(o.recipients[0].iv) }, badSig],
    'wrap tag': [(o) => { o.recipients[0].tag = flipB64(o.recipients[0].tag) }, badSig],
    'second recipient wrapped key': [(o) => { o.recipients[1].key = flipB64(o.recipients[1].key) }, badSig],
    iv: [(o) => { o.iv = flipB64(o.iv) }, badSig],
    tag: [(o) => { o.tag = flipB64(o.tag) }, badSig],
    data: [(o) => { o.data = flipB64(o.data) }, badSig],
    'data shortened': [(o) => { o.data = Buffer.from(o.data, 'base64').subarray(1).toString('base64') }, badSig],
    'recipients reordered': [(o) => { o.recipients.reverse() }, badSig],
    'signer swapped for another listed key': [(o) => { o.signer = s.other.publicKey }, badSig],
    'signature byte': [(o) => { o.signature = flipB64(o.signature) }, badSig],
    'seq raised': [(o) => { o.seq = o.seq + 1 }, badSig],
    'seq lowered': [(o) => { o.seq = o.seq - 1 }, badSig],
    'seq low bit of the top byte': [(o) => { o.seq = o.seq + 2 ** 24 }, badSig],
    'signer byte': [(o) => { o.signer = flipHex(o.signer) }, 'erro: o arquivo selado não foi assinado por uma chave da lista de quem sela\n'],
    version: [(o) => { o.v = 2 }, 'erro: versão do arquivo selado desconhecida\n']
  }
  for (const [name, [mutate, message]] of Object.entries(cases)) {
    const copy = JSON.parse(JSON.stringify(original))
    mutate(copy)
    const file = write(s.dir, 'flipped.json', JSON.stringify(copy, null, 2) + '\n')
    const v = varanda(['secrets', 'verify', '--file', file, '--signers', s.signers])
    t.is(v.code, 1, name + ': verify fails')
    t.is(v.stderr, message, name + ': verify says why')
    const out = path.join(s.dir, 'flipped.env')
    const o = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', file, '--signers', s.signers, '--out', out])
    t.is(o.code, 1, name + ': open fails')
    t.is(o.stderr, message, name + ': open stops at the signature, before decrypting')
    t.absent(fs.existsSync(out), name + ': nothing written')
  }

  // v has one legal value, so the signature over it is checked in the library.
  const parsed = sealed.parseSealed(JSON.stringify(original))
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(parsed.signer, 'hex')]), format: 'der', type: 'spki' })
  t.ok(crypto.verify(null, sealed.signedBytes(parsed), publicKey, parsed.signature), 'the signature holds over the parsed fields')
  t.absent(crypto.verify(null, sealed.signedBytes({ ...parsed, v: 2 }), publicKey, parsed.signature), 'another version breaks it')
  t.alike(sealed.signedBytes(parsed), signedBytesSpec(original), 'the module signs the bytes docs/protocol.md defines')
})

test('secrets: key order and whitespace do not change what is verified', (t) => {
  const s = setup(t)
  const original = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  const reorder = (o) => Object.fromEntries(Object.entries(o).reverse())
  const shuffled = reorder({ ...original, recipients: original.recipients.map(reorder) })
  t.not(Object.keys(shuffled)[0], 'v', 'keys really reordered')
  const variants = {
    compact: JSON.stringify(shuffled),
    tabs: JSON.stringify(shuffled, null, '\t'),
    'spaces and CRLF': JSON.stringify(original, null, 4).replace(/\n/g, '\r\n') + '\r\n\r\n'
  }
  for (const [name, text] of Object.entries(variants)) {
    const file = write(s.dir, 'variant.json', text)
    const v = varanda(['secrets', 'verify', '--file', file, '--signers', s.signers])
    t.is(v.code, 0, name + ': verifies')
    t.is(v.stdout, 'assinatura válida: ' + s.signer.publicKey + ', seq 5, 2 servidores\n')
    const out = path.join(s.dir, 'variant-' + name.replace(/\W/g, '') + '.env')
    t.is(varanda(['secrets', 'open', '--key-file', s.b.file, '--file', file, '--signers', s.signers, '--out', out]).code, 0, name + ': opens')
    t.ok(fs.readFileSync(out, 'utf8').includes(s.values.VARANDA_DIDIT_API_KEY))
  }
})

test('secrets: signers file parse errors', (t) => {
  const s = setup(t)
  const out = path.join(s.dir, 'p.env')
  const existing = write(s.dir, 'keep.env', "VARANDA_DIDIT_API_KEY='old'\n", 0o600)
  let n = 0
  const check = (text, message, label) => {
    const list = write(s.dir, 'signers-' + (++n) + '.txt', text)
    const v = varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', list])
    t.is(v.code, 1, label + ': verify exits 1')
    t.is(v.stderr, 'erro: ' + message + '\n', label)
    t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', list, '--out', out]).code, 1, label + ': open exits 1')
    t.is(varanda(['secrets', 'open', '--key-file', s.a.file, '--file', s.sealedFile, '--signers', list, '--out', existing]).code, 1)
    t.absent(fs.existsSync(out), label + ': nothing written')
    t.is(fs.readFileSync(existing, 'utf8'), "VARANDA_DIDIT_API_KEY='old'\n", label + ': an existing --out is untouched')
  }
  check(s.signer.publicKey + '\nnot-a-key\n', 'lista de quem sela: chave inválida na linha 2', 'a bad line')
  check(s.signer.publicKey + '1\n', 'lista de quem sela: chave inválida na linha 1', 'a 65-hex line')
  check('# a\n' + s.signer.publicKey + '\n' + s.signer.publicKey.toUpperCase() + '\n', 'lista de quem sela: chave repetida na linha 3', 'a repeated key, in any case')
  check('# ninguém ainda\n\n', 'lista de quem sela: nenhuma chave', 'only comments')
  check('', 'lista de quem sela: nenhuma chave', 'empty')
  const seventeen = [s.signer.publicKey, ...Array.from({ length: 16 }, () => crypto.randomBytes(32).toString('hex'))].join('\n')
  check(seventeen, 'lista de quem sela: mais de 16 chaves', 'seventeen keys')
  const sixteen = write(s.dir, 'sixteen.txt', ['# dezesseis', ...Array.from({ length: 15 }, () => crypto.randomBytes(32).toString('hex')), s.signer.publicKey + ' # a última'].join('\n'))
  t.is(varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', sixteen]).code, 0, 'sixteen keys, comments and a CR-free last line are fine')
  t.is(varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', path.join(s.dir, 'missing.txt')]).stderr, 'erro: lista de quem sela não encontrado: ' + path.join(s.dir, 'missing.txt') + '\n', 'a missing file')
  const fifo = path.join(s.dir, 'signers-fifo')
  if (spawnSync('mkfifo', ['-m', '600', fifo]).status === 0) {
    t.is(varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', fifo]).code, 1, 'a FIFO --signers is refused without blocking')
  }
})

test('secrets seal: --seq is required, decimal, 1 to 4294967295', (t) => {
  const s = setup(t)
  let n = 0
  const sealWith = (seqArgs) => {
    const out = path.join(s.dir, 'seq-' + (++n) + '.json')
    const r = varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--signing-key', s.signer.file, ...seqArgs, '--out', out])
    r.out = out
    return r
  }
  const usageLine = 'uso: informe --seq <n>, um inteiro de 1 a 4294967295\n'
  const missing = sealWith([])
  t.is(missing.code, 2, 'seal without --seq')
  t.ok(missing.stderr.startsWith(usageLine), missing.stderr.split('\n')[0])
  t.absent(fs.existsSync(missing.out))
  for (const bad of ['', '0', '00', '01', '-1', '+1', '1.5', '1.0', '1e3', '0x10', ' 1', '1 ', 'abc', '4294967296', '9999999999', '12345678901']) {
    const r = sealWith(['--seq', bad])
    t.is(r.code, 2, JSON.stringify(bad) + ' refused')
    t.ok(r.stderr.startsWith(usageLine), JSON.stringify(bad) + ': ' + r.stderr.split('\n')[0])
    t.absent(fs.existsSync(r.out), JSON.stringify(bad) + ': nothing written')
  }
  for (const [arg, seq] of [['1', 1], ['4294967295', 4294967295], ['1000000000', 1000000000]]) {
    const r = sealWith(['--seq', arg])
    t.is(r.code, 0, arg + ' accepted')
    t.is(JSON.parse(fs.readFileSync(r.out, 'utf8')).seq, seq, arg + ': stored as a JSON integer')
    const v = varanda(['secrets', 'verify', '--file', r.out, '--signers', s.signers, '--json'])
    t.is(v.stdout, '{"signer":"' + s.signer.publicKey + '","recipients":2,"seq":' + seq + '}\n', arg + ': verify reports it')
  }
})

test('secrets: seq must be a JSON integer from 1 to 4294967295', (t) => {
  const s = setup(t)
  const original = JSON.parse(fs.readFileSync(s.sealedFile, 'utf8'))
  const cases = {
    'a string': (o) => { o.seq = String(o.seq) },
    'a float': (o) => { o.seq = o.seq + 0.5 },
    zero: (o) => { o.seq = 0 },
    negative: (o) => { o.seq = -5 },
    'above 2^32 - 1': (o) => { o.seq = 4294967296 },
    'above 2^32, same low bytes': (o) => { o.seq = o.seq + 4294967296 },
    null: (o) => { o.seq = null },
    'an array': (o) => { o.seq = [o.seq] },
    missing: (o) => { delete o.seq }
  }
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = JSON.parse(JSON.stringify(original))
    mutate(copy)
    const file = write(s.dir, 'seq.json', JSON.stringify(copy))
    const v = varanda(['secrets', 'verify', '--file', file, '--signers', s.signers])
    t.is(v.code, 1, name + ': verify fails')
    t.is(v.stderr, 'erro: arquivo selado inválido\n', name + ': refused by the parser')
    const out = path.join(s.dir, 'seq.env')
    const o = varanda(['secrets', 'open', '--key-file', s.a.file, '--file', file, '--signers', s.signers, '--out', out])
    t.is(o.code, 1, name + ': open fails')
    t.is(o.stderr, 'erro: arquivo selado inválido\n', name + ': open refused by the parser')
    t.absent(fs.existsSync(out), name + ': nothing written')
  }
})

test('secrets verify: an older file still verifies, and its lower seq shows it', (t) => {
  const s = setup(t)
  const older = path.join(s.dir, 'older.json')
  t.is(varanda(['secrets', 'seal', '--file', s.plain, '--recipients', s.recipients, '--seq', '4', '--signing-key', s.signer.file, '--out', older]).code, 0)
  const now = JSON.parse(varanda(['secrets', 'verify', '--file', s.sealedFile, '--signers', s.signers, '--json']).stdout)
  const then = JSON.parse(varanda(['secrets', 'verify', '--file', older, '--signers', s.signers, '--json']).stdout)
  t.alike(Object.keys(now), ['signer', 'recipients', 'seq'], 'the --json keys, in order')
  t.is(now.seq, 5)
  t.is(then.seq, 4, 'the replayed file carries its own, lower seq')
  // Moving a newer seq onto the older file breaks its signature.
  const forged = JSON.parse(fs.readFileSync(older, 'utf8'))
  forged.seq = 6
  const r = varanda(['secrets', 'verify', '--file', write(s.dir, 'forged-seq.json', JSON.stringify(forged)), '--signers', s.signers])
  t.is(r.code, 1)
  t.is(r.stderr, 'erro: assinatura do arquivo selado inválida\n')
})

// The committed sealed file must carry a signature from a key pinned in the
// repository, so a pull request that swaps it for someone else's fails CI.
const REPO_SEALED = path.join(__dirname, '..', '..', '..', 'deploy', 'seeder', 'secrets.sealed.json')
const REPO_SIGNERS = path.join(__dirname, '..', '..', '..', 'deploy', 'seeder', 'secrets-signers.txt')
const hasRepoSealed = fs.existsSync(REPO_SEALED)

test('repo: deploy/seeder/secrets-signers.txt holds only comments and public keys', (t) => {
  const text = fs.readFileSync(REPO_SIGNERS, 'utf8')
  t.absent(text.includes('\u2014'), 'no em dash')
  const entries = text.split('\n').map((l) => (l.includes('#') ? l.slice(0, l.indexOf('#')) : l).trim()).filter((l) => l !== '')
  for (const e of entries) t.ok(HEX64.test(e.toLowerCase()), 'a 64-hex key')
  t.ok(entries.length <= 16, 'at most 16 keys')
  if (entries.length > 0) t.alike(sealed.parseSigners(text), entries.map((e) => e.toLowerCase()), 'parses as a signers file')
})

test('repo: deploy/seeder/secrets.sealed.json verifies against secrets-signers.txt' + (hasRepoSealed ? '' : ' (skipped: no sealed file committed yet)'), { skip: !hasRepoSealed }, (t) => {
  const r = varanda(['secrets', 'verify', '--file', REPO_SEALED, '--signers', REPO_SIGNERS])
  t.is(r.code, 0, 'the committed sealed file is signed by a pinned key: ' + (r.stderr || r.stdout).trim())
})

test('no secret value or secret key in any error', (t) => {
  t.ok(stderrs.length > 50, 'stderr collected from every run')
  t.ok(secrets.size > 20)
  for (const err of stderrs) {
    for (const secret of secrets) {
      if (err.includes(secret)) t.fail('a secret appears in stderr: ' + err.slice(0, 40))
    }
  }
  t.pass('checked ' + stderrs.length + ' outputs')
})
