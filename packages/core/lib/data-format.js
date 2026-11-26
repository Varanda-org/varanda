'use strict'

const fs = require('#fs')
const path = require('#path')

// On-disk layout version of a data dir, kept in <dataDir>/format.json.
// A dir without the file is BASE_DATA_FORMAT with nothing pending, and the
// file is never written while there is nothing to migrate, so an existing dir
// is not rewritten by an app that has no migration yet. A step is applied
// with the Corestore closed (openStore runs this before opening it), so it
// cannot reach the diary key, block 0 or the block numbering.
const BASE_DATA_FORMAT = 1
const DATA_FORMAT = 1
const MIGRATIONS = Object.freeze({})
const FORMAT_FILE = 'format.json'

const RESERVED = new Set(['store', 'quarantine', FORMAT_FILE])
// Key and certificate files (seeder-key.json, noise-key.json, dm-seed.json,
// passkeys.json, recovery.json, issuer-cert.json, page-keys.json...): a step
// that must touch one changes this guard on purpose, in review.
const SECRET_NAME = /key|seed|secret|recovery|cert/i

function fail (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

const invalid = () => fail('formato dos dados inválido', 'DATA_FORMAT_INVALID')
const newer = () => fail('dados de uma versão mais nova do Varanda: atualize o aplicativo', 'DATA_FORMAT_NEWER')

const isFormat = (n) => Number.isSafeInteger(n) && n >= 1

// Lazy: store.js requires this module, so the helpers are fetched at call time.
function storeHelpers () {
  return require('./store')
}

function readState (dataDir) {
  const file = path.join(dataDir, FORMAT_FILE)
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return { format: BASE_DATA_FORMAT, migrating: null }
    throw err
  }
  if (!st.isFile()) throw invalid()
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw invalid()
  }
  const keys = data !== null && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort().join() : ''
  if (keys !== 'format,migrating,v' || data.v !== 1 || !isFormat(data.format)) throw invalid()
  if (data.migrating !== null && !isFormat(data.migrating)) throw invalid()
  return { format: data.format, migrating: data.migrating }
}

function writeState (dataDir, format, migrating) {
  storeHelpers().writeJsonAtomic(path.join(dataDir, FORMAT_FILE), { v: 1, format, migrating }, 0o600)
}

// A step names files of the data dir by one path segment only. Reserved names
// compare without case: macOS and iOS volumes are case-insensitive.
function segment (name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('.') || RESERVED.has(name.toLowerCase()) || SECRET_NAME.test(name) ||
    name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw fail('nome de arquivo inválido', 'DATA_FORMAT_NAME')
  }
  return name
}

function stepContext (dataDir) {
  const at = (name) => path.join(dataDir, segment(name))
  return {
    // Only a regular file is read: a symlink could point into store/ and a
    // FIFO would block the open forever under the data-dir lock.
    readJson (name, fallback) {
      const file = at(name)
      let st
      try {
        st = fs.lstatSync(file)
      } catch (err) {
        if (err.code === 'ENOENT') return fallback
        throw err
      }
      if (!st.isFile()) throw fail('arquivo de dados inválido', 'DATA_FORMAT_NAME')
      return storeHelpers().readJson(file, fallback)
    },
    writeJsonAtomic: (name, obj, mode) => storeHelpers().writeJsonAtomic(at(name), obj, mode),
    exists (name) {
      try {
        fs.lstatSync(at(name))
        return true
      } catch (err) {
        if (err.code === 'ENOENT') return false
        throw err
      }
    },
    remove (name) {
      try {
        fs.unlinkSync(at(name))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
  }
}

// Brings the data dir to `target`, one step at a time. Every step is preceded
// by an intent ({ format: n - 1, migrating: n }) and followed by a commit
// ({ format: n, migrating: null }); a crash anywhere leaves format < target,
// so the next open re-runs step n from its start (steps must be idempotent:
// write the new file, then remove the old one). A dir written by a newer
// build, or left mid-step towards a newer format, is refused untouched.
async function ensureDataFormat (dataDir, { target = DATA_FORMAT, migrations = MIGRATIONS } = {}) {
  const state = readState(dataDir)
  if (state.format > target || (state.migrating !== null && state.migrating > target)) throw newer()
  for (let n = state.format + 1; n <= target; n++) {
    const step = migrations[n]
    if (step === null || typeof step !== 'object' || typeof step.run !== 'function') {
      throw fail('migração ausente', 'DATA_FORMAT_MISSING_STEP')
    }
  }
  for (let n = state.format + 1; n <= target; n++) {
    writeState(dataDir, n - 1, n)
    await migrations[n].run(stepContext(dataDir))
    writeState(dataDir, n, null)
  }
}

module.exports = { BASE_DATA_FORMAT, DATA_FORMAT, MIGRATIONS, FORMAT_FILE, ensureDataFormat }
