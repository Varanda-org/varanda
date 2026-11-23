'use strict'

// Test stand-ins for ctx.peekGroupRoot (lib/member-ops.js peekedRootHeader):
// the session reads a pending root's block 0 through the seeder
// (lib/root-peek.js); ops-level tests without a seeder read it from the
// storages that hold the root, as a seeder holding them would serve it.
const b4a = require('b4a')
const grp = require('@varanda/core/lib/group')
const store = require('../../lib/node-store')

const UNREAD = 'bloco 0 do grupo indisponível'

// -> (key) -> raw block 0 of root `key` from the first of `holders` (each a
// node storage, or anything with a `storage`) that holds it; a root none
// holds fails as an unanswered read. holders may be a function returning
// the list, read at each call.
function rootReader (...holders) {
  return async (key) => {
    const list = holders.length === 1 && typeof holders[0] === 'function' ? holders[0]() : holders
    for (const h of list) {
      const storage = h && h.storage ? h.storage : h
      const core = await store.openGroupCoreReadOnly(storage, key)
      if (core === null) continue
      try {
        if (core.length > 0) return await core.get(0, { raw: true, wait: false })
      } finally {
        await core.close()
      }
    }
    throw new Error(UNREAD)
  }
}

// -> a reader serving, for any key, the block 0 of a group root that names
// `community` (null: a standalone root) and was created by `diary`, for a
// fabricated root key no storage holds.
function fakeRootReader ({ community = null, diary = 'ab'.repeat(32) } = {}) {
  const header = grp.groupHeader({ kind: 'group', diary, community, member: community === null ? null : community, name: 'Grupo', join: 'open' })
  const raw = b4a.from(JSON.stringify(header))
  return async () => raw
}

module.exports = { rootReader, fakeRootReader, UNREAD }
