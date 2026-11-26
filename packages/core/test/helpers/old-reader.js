'use strict'

const b4a = require('b4a')

const READERS = {
  'pre-115': require('../fixtures/old-readers/records-pre-115'),
  'pre-218': require('../fixtures/old-readers/records-pre-218')
}

const PINS = {
  'pre-115': 'b1abfbc692e19c4762fdab1cd3f6e199b18d4f197c33e70e62fe2b704b29ccbb',
  'pre-218': 'd675d083d4beb6e67f8b62ac6e8a3924c020d2a1dd1b6660574cf45b42fd5685'
}

const FIXTURE_PATHS = {
  'pre-115': require.resolve('../fixtures/old-readers/records-pre-115'),
  'pre-218': require.resolve('../fixtures/old-readers/records-pre-218')
}

function readOld (reader, raws) {
  const result = { gate: null, entries: [], invalid: [], posts: [], profile: null }
  if (raws.length === 0) {
    result.gate = 'not-in-log'
    return result
  }
  for (let seq = 0; seq < raws.length; seq++) {
    let record = null
    try {
      record = reader.decodeBlock ? reader.decodeBlock(raws[seq]) : JSON.parse(b4a.toString(raws[seq], 'utf8'))
    } catch {}
    const reason = record === null ? 'malformed' : reader.validateRecord(record, seq)
    if (reason !== null) {
      result.invalid.push({ seq, reason })
      if (seq === 0) {
        // Old readers have no genesisReason and collapse every failure; the
        // current reader keeps 'unsupported-cert-version' like the gates do.
        result.gate = reader.genesisReason ? reader.genesisReason(record) : 'not-in-log'
        return result
      }
      continue
    }
    result.entries.push({ seq, record })
    if (record.type === 'post') {
      const copy = reader.validRecordCopy ? reader.validRecordCopy(record, seq) : record
      if (copy !== null) result.posts.push({ seq, record: copy })
    }
  }
  if (reader.latestProfile) result.profile = reader.latestProfile(result.entries)
  return result
}

module.exports = { READERS, PINS, FIXTURE_PATHS, readOld }
