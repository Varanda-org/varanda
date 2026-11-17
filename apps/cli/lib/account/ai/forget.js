'use strict'

// Excluir conta while the AI triage does not run (VARANDA_AI off, or the
// worker could not start): the copies an earlier run left in <dataDir> go at
// the deletion all the same, not when the AI runs again. The same drops as
// ./worker.js forgetMember: the cached reads and the marks of the reports
// about the member (./ledger.js, triage.json and triage-marks.jsonl) and
// their precedents (./exemplar-store.js, exemplars.json, whatever model
// wrote it).
//
// createTriageForget({ dataDir, moderation }) -> { holdsMember(m),
// forgetMember(m), brokenFiles() }, the shape ../deletion.js takes as
// `triage`. It never creates a file and never sets one aside: a store is
// opened, once, only when its file is already there, the ledger in its
// strict mode. Without triage.json the ledger holds nothing about anyone
// (the marks log alone has report ids and codes) and is not opened. No
// embedder, no model and no network: only the two stores. A file it cannot
// use makes both calls throw, so the sweep keeps the purge pending and names
// the file through brokenFiles(); nothing here logs.

const fs = require('node:fs')
const path = require('node:path')
const { isPlainObject } = require('@varanda/core/lib/cert')
const ledgerLib = require('./ledger')
const exemplarLib = require('./exemplar-store')

const LEDGER_NAMES = [ledgerLib.FILE, ledgerLib.LOG_FILE]
const EXEMPLAR_NAMES = [exemplarLib.FILE]

function noop () {}

function unusable () {
  const err = new Error('indisponivel')
  err.code = 'indisponivel'
  return err
}

function present (file) {
  try {
    fs.lstatSync(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

function createTriageForget ({ dataDir, moderation = null }) {
  const exemplarsFile = path.join(dataDir, exemplarLib.FILE)
  const ledgerFile = path.join(dataDir, ledgerLib.FILE)
  let ledger = null
  let exemplars = null
  const broken = new Set()

  // The store's own model check guards scoring, not these drops, so the
  // file's model is passed back; read here only because a missing file would
  // otherwise be created under it.
  function openExemplars () {
    if (exemplars !== null || !present(exemplarsFile)) return
    if (!fs.lstatSync(exemplarsFile).isFile()) throw unusable()
    let model = null
    try {
      const obj = JSON.parse(fs.readFileSync(exemplarsFile, 'utf8'))
      if (isPlainObject(obj)) model = obj.model
    } catch {}
    if (typeof model !== 'string' || model.length === 0) throw unusable()
    exemplars = exemplarLib.openExemplarStore(dataDir, { model })
  }

  function openLedgerOnce () {
    if (ledger !== null || !present(ledgerFile)) return
    ledger = ledgerLib.openLedger(dataDir, { strict: true })
  }

  // Runs `fn` on one store, noting the file while it fails (`names`: the
  // store's files, the first one when the error names none).
  function on (names, open, fn) {
    try {
      open()
      const out = fn()
      for (const n of names) broken.delete(n)
      return out
    } catch (err) {
      broken.add(names.includes(err.file) ? err.file : names[0])
      throw err
    }
  }

  // Same as worker.js reportIdsOf: the reports whose target is the member.
  function reportIdsOf (member) {
    return moderation === null ? [] : moderation.reportIdsAbout(member)
  }

  function holdsMember (member) {
    on(LEDGER_NAMES, openLedgerOnce, noop)
    if (ledger !== null) {
      const ids = reportIdsOf(member)
      if (on(LEDGER_NAMES, noop, () => ledger.holdsTarget(member, ids))) return true
    }
    return on(EXEMPLAR_NAMES, openExemplars, () => exemplars !== null && exemplars.holdsTarget(member))
  }

  // Both stores are tried even when the first throws; the first error is
  // thrown after, so the next pass tries again.
  function forgetMember (member) {
    let failure = null
    try {
      on(LEDGER_NAMES, openLedgerOnce, noop)
      if (ledger !== null) {
        const ids = reportIdsOf(member)
        on(LEDGER_NAMES, noop, () => ledger.forgetTarget(member, ids))
      }
    } catch (err) {
      failure = err
    }
    try {
      on(EXEMPLAR_NAMES, openExemplars, () => { if (exemplars !== null) exemplars.forgetTarget(member) })
    } catch (err) {
      if (failure === null) failure = err
    }
    if (failure !== null) throw failure
  }

  function brokenFiles () {
    return [...broken]
  }

  return { holdsMember, forgetMember, brokenFiles }
}

module.exports = { createTriageForget }
