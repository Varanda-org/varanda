'use strict'

// `varanda secrets key|signing-key|seal|open|verify`: shared provider
// credentials travel as ciphertext in the signed release bundle, signed by a
// maintainer whose key is pinned in the signers file (format in
// ../sealed-secrets.js). No command prints a secret key or a value. Exit
// codes: 0 done, 1 error, 2 usage, 3 (open) this server is not a recipient,
// only after the signature verified.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { UsageError } = require('../cli')
const { refuseExisting, writeNew } = require('../write-new')
const { linkNew } = require('@varanda/core/lib/link-new')
const { fsyncDir } = require('@varanda/core/lib/member')
const sealed = require('../sealed-secrets')

const NOT_RECIPIENT = 3
// Far above any legal input (64 recipients, 8 values of 4096 bytes).
const MAX_INPUT = 1024 * 1024

function print (flags, result, line) {
  process.stdout.write((flags.json ? JSON.stringify(result) : line) + '\n')
}

function tmpName (file) {
  return path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp')
}

// A unique temp file next to `file`, mode 0600 from creation, written and
// fsynced. The caller publishes it and always unlinks it afterwards; a
// failed write or fsync unlinks it here, since it may already hold a secret.
function writeTmp (file, text) {
  const tmp = tmpName(file)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  return tmp
}

// Like write-new's writeNew, but the file is 0600 before it holds a byte.
function writeNewPrivate (file, text) {
  refuseExisting(file)
  let tmp = null
  try {
    tmp = writeTmp(file, text)
    try {
      linkNew(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error('o arquivo de saída já existe: ' + file)
      throw err
    }
    fsyncDir(path.dirname(file))
  } finally {
    if (tmp !== null) try { fs.unlinkSync(tmp) } catch {}
  }
}

// Replaces `file` atomically: temp file in the same directory, then rename,
// so only the --out directory has to be writable (read-only root in docker).
function replacePrivate (file, text) {
  let tmp = null
  try {
    tmp = writeTmp(file, text)
    fs.renameSync(tmp, file)
    tmp = null
    fsyncDir(path.dirname(file))
  } finally {
    if (tmp !== null) try { fs.unlinkSync(tmp) } catch {}
  }
}

// stat before open: opening a FIFO would block until a writer shows up.
// O_NONBLOCK covers one swapped in between, and fstat checks what was opened.
function readInput (file, label) {
  let fd
  try {
    if (!fs.statSync(file).isFile()) throw new Error(label + ' não é um arquivo comum: ' + file)
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(label + ' não encontrado: ' + file)
    throw err
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(label + ' não é um arquivo comum: ' + file)
    if (stat.size > MAX_INPUT) throw new Error(label + ' grande demais: ' + file)
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// The key file must be a regular file, not a symlink, unreadable by group and
// other. The lstat check refuses a FIFO before open could block on it;
// O_NOFOLLOW, O_NONBLOCK and fstat then check the very file that is read.
function readKeyFile (file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('arquivo de chave não encontrado: ' + file)
    throw err
  }
  if (stat.isSymbolicLink()) throw new Error('o arquivo de chave é um link simbólico: ' + file)
  if (!stat.isFile()) throw new Error('o arquivo de chave não é um arquivo comum: ' + file)
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ELOOP') throw new Error('o arquivo de chave é um link simbólico: ' + file)
    throw err
  }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile()) throw new Error('o arquivo de chave não é um arquivo comum: ' + file)
    if ((opened.mode & 0o077) !== 0) throw new Error('o arquivo de chave pode ser lido por outros usuários (use chmod 600): ' + file)
    if (opened.size > MAX_INPUT) throw new Error('arquivo de chave inválido')
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function oneFile (flags) {
  if (flags.files.length !== 1) throw new UsageError('informe um --file')
  return flags.files[0]
}

// Both the entry itself (lstat) and what it points to (stat), as BigInt
// dev:ino pairs so inode numbers above 2^53 cannot collide.
function entryIds (file, statFs) {
  const ids = []
  for (const method of ['lstatSync', 'statSync']) {
    try {
      const st = statFs[method](file, { bigint: true })
      ids.push(st.dev + ':' + st.ino)
    } catch {}
  }
  return ids
}

// --out must never name an input: `open` would rename the result over the
// key file or the sealed file, and readInput follows links. Refused when the
// paths are equal or when any of the input's entry or link target is the
// existing --out's entry or link target. -> the clashing flag, or null.
function clash (out, inputs, statFs = fs) {
  const outIds = entryIds(out, statFs)
  for (const [flag, file] of inputs) {
    if (file === null) continue
    if (file === out) return flag
    if (outIds.length > 0 && entryIds(file, statFs).some((id) => outIds.includes(id))) return flag
  }
  return null
}

function needOut (flags) {
  if (!flags.out) throw new UsageError('informe --out <arquivo>')
  const inputs = [
    ...flags.files.map((f) => ['--file', f]),
    ['--recipients', flags.recipients],
    ['--key-file', flags.keyFile],
    ['--signing-key', flags.signingKey],
    ['--signers', flags.signers]
  ]
  const flag = clash(flags.out, inputs)
  if (flag !== null) throw new UsageError('--out não pode ser o mesmo arquivo de ' + flag)
  return flags.out
}

function count (n, one, many) {
  return n + ' ' + (n === 1 ? one : many)
}

function key (flags) {
  const out = needOut(flags)
  refuseExisting(out)
  const file = sealed.generateKeyFile()
  writeNewPrivate(out, JSON.stringify(file) + '\n')
  print(flags, { publicKey: file.publicKey }, file.publicKey)
  return 0
}

// Same conventions as `key`; the file says it is a signing key, so neither
// parser takes it for the other kind.
function signingKey (flags) {
  const out = needOut(flags)
  refuseExisting(out)
  const file = sealed.generateSigningKeyFile()
  writeNewPrivate(out, JSON.stringify(file) + '\n')
  print(flags, { publicKey: file.publicKey }, file.publicKey)
  return 0
}

function needSigners (flags) {
  if (!flags.signers) throw new UsageError('informe --signers <arquivo>')
  return flags.signers
}

function readSigners (file) {
  return sealed.parseSigners(readInput(file, 'lista de quem sela'))
}

function seal (flags) {
  const input = oneFile(flags)
  if (!flags.recipients) throw new UsageError('informe --recipients <arquivo>')
  if (!flags.signingKey) throw new UsageError('informe --signing-key <arquivo>')
  const out = needOut(flags)
  refuseExisting(out)
  const signer = sealed.parseSigningKeyFile(readKeyFile(flags.signingKey))
  const recipients = sealed.parseRecipients(readInput(flags.recipients, 'arquivo de destinatários'))
  const secrets = sealed.parsePlainEnv(readInput(input, 'arquivo de segredos'))
  writeNew(out, JSON.stringify(sealed.seal(secrets, recipients, signer), null, 2) + '\n')
  print(flags, { names: secrets.size, recipients: recipients.length }, count(secrets.size, 'nome selado', 'nomes selados') + ' para ' + count(recipients.length, 'servidor', 'servidores'))
  return 0
}

function open (flags) {
  if (!flags.keyFile) throw new UsageError('informe --key-file <arquivo>')
  const input = oneFile(flags)
  const signersFile = needSigners(flags)
  const out = needOut(flags)
  const signers = readSigners(signersFile)
  const serverKey = sealed.parseKeyFile(readKeyFile(flags.keyFile))
  let secrets
  try {
    secrets = sealed.open(readInput(input, 'arquivo selado'), serverKey, signers)
  } catch (err) {
    if (err.code !== 'NOT_RECIPIENT') throw err
    process.stderr.write(err.message + '\n')
    return NOT_RECIPIENT
  }
  replacePrivate(out, sealed.formatEnv(secrets))
  print(flags, { written: secrets.size }, count(secrets.size, 'nome gravado', 'nomes gravados'))
  return 0
}

// What a reviewer runs on a pull request: no secret key involved.
function verify (flags) {
  const input = oneFile(flags)
  const signers = readSigners(needSigners(flags))
  const result = sealed.verify(readInput(input, 'arquivo selado'), signers)
  print(flags, result, 'assinatura válida: ' + result.signer + ', ' + count(result.recipients, 'servidor', 'servidores'))
  return 0
}

const SUBCOMMANDS = 'secrets key|signing-key|seal|open|verify'

async function run (flags) {
  const [sub, extra] = flags.positionals
  if (extra !== undefined) throw new UsageError(SUBCOMMANDS)
  if (sub === 'key') return key(flags)
  if (sub === 'signing-key') return signingKey(flags)
  if (sub === 'seal') return seal(flags)
  if (sub === 'open') return open(flags)
  if (sub === 'verify') return verify(flags)
  throw new UsageError(SUBCOMMANDS)
}

module.exports = {
  commands: {
    secrets: { summary: 'credenciais compartilhadas seladas para os servidores', run }
  },
  // For tests.
  clash
}
