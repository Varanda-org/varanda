#!/usr/bin/env node
'use strict'

// Operator-only: downloads the AI triage model (lib/account/ai/embedder.js)
// into a directory OUTSIDE the repository. Never run by npm test, npm run
// demo, CI or the Docker build; the account service only reads the result.
//   node apps/cli/scripts/fetch-ai-model.js --dir /var/lib/varanda/ai-model
// Fetches the five files of FILES from ONE immutable Hugging Face commit
// (MODEL_REVISION), each into a temp file in the destination directory that
// is renamed into place only after its sha256 matched the recorded one, so an
// interrupted or tampered download never leaves a file the embedder would
// accept. A file already present with the right hash is kept. Prints only
// file names and sizes, never bytes. The weights must never be committed.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { MODEL_ID, MODEL_REVISION, FILES } = require('../lib/account/ai/embedder')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

function usage (msg) {
  if (msg) console.error('erro: ' + msg)
  console.error('uso: node apps/cli/scripts/fetch-ai-model.js --dir <diretório fora do repositório>')
  process.exit(2)
}

function parseDir (argv) {
  const i = argv.indexOf('--dir')
  if (i === -1 || !argv[i + 1]) usage('informe --dir')
  return path.resolve(argv[i + 1])
}

// The real path of the nearest existing ancestor (symlinks resolved), plus
// the rest of the path: a symlink cannot smuggle the destination into the repo.
function realish (p) {
  let cur = p
  const rest = []
  while (!fs.existsSync(cur)) {
    rest.unshift(path.basename(cur))
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return path.join(fs.realpathSync(cur), ...rest)
}

function inside (child, parent) {
  // Only a real parent component means "outside": a directory merely named
  // `..models` is still inside.
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function lstatOrNull (p) {
  try {
    return fs.lstatSync(p)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Creates the directories between --dir and the file one at a time, refusing
// any component that is a symlink (or not a directory): a link below --dir,
// such as <dir>/Xenova -> <repo>/x, must never be followed, not even by
// mkdir. The parent's real path is then checked against the repository too.
function safeParent (dir, rel, repo) {
  let cur = dir
  for (const part of [...MODEL_ID.split('/'), ...rel.split('/').slice(0, -1)]) {
    cur = path.join(cur, part)
    const st = lstatOrNull(cur)
    if (!st) fs.mkdirSync(cur, { mode: 0o700 })
    else if (st.isSymbolicLink() || !st.isDirectory()) usage('caminho inseguro no diretório do modelo (link simbólico ou não é diretório)')
  }
  if (inside(fs.realpathSync(cur), repo)) usage('o diretório não pode ficar dentro do repositório')
  return cur
}

async function fetchOne (dir, rel, want, repo) {
  const dest = path.join(safeParent(dir, rel, repo), path.basename(rel))
  // The final file must be absent or a regular file: a symlink would make
  // the hash check (and the kept-file branch) read through it.
  const st = lstatOrNull(dest)
  if (st && (st.isSymbolicLink() || !st.isFile())) usage('arquivo inseguro no diretório do modelo (link simbólico ou não é arquivo comum)')
  if (st && (await sha256File(dest)) === want) {
    console.log('ok (já presente) ' + rel)
    return
  }
  const url = 'https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REVISION + '/' + rel
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error('download falhou: ' + rel + ' (HTTP ' + res.status + ')')
  const tmp = dest + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
  const hash = crypto.createHash('sha256')
  let size = 0
  try {
    const body = Readable.fromWeb(res.body)
    body.on('data', (c) => { hash.update(c); size += c.length })
    await pipeline(body, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }))
    const got = hash.digest('hex')
    if (got !== want) throw new Error('sha256 não confere: ' + rel)
    fs.renameSync(tmp, dest)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  console.log('ok ' + rel + ' (' + size + ' bytes)')
}

async function main () {
  const dir = parseDir(process.argv.slice(2))
  const repo = fs.realpathSync(REPO_ROOT)
  if (inside(realish(dir), repo)) usage('o diretório não pode ficar dentro do repositório')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [rel, want] of Object.entries(FILES)) await fetchOne(dir, rel, want, repo)
  console.log('modelo ' + MODEL_ID + '@' + MODEL_REVISION + ' pronto em ' + dir)
}

main().catch((err) => {
  console.error('erro: ' + (err && err.message ? err.message : 'falha'))
  process.exit(1)
})
