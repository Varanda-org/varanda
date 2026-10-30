'use strict'

// Human lines for runSync events (docs/protocol.md §7 `sync`), shared by the
// CLI (stdout) and the node session (sync.event lines, docs/rpc.md §6).
const { safe } = require('./safe')

function key8 (hex) {
  return safe(String(hex).slice(0, 8))
}

// Human stdout line for a sync event (docs §7); null = nothing on stdout.
function formatEvent (ev) {
  switch (ev.event) {
    case 'ready':
      return 'sync ready'
    case 'peer': {
      const unverified = ev.role === 'seeder' && !ev.verified ? ' não verificado' : ''
      return 'peer ' + safe(ev.role) + ' ' + key8(ev.peerKey) + unverified
    }
    case 'admitted':
      return 'admitted ' + safe(ev.key) + ' ' + safe(ev.length)
    case 'rejected':
      return 'rejected ' + safe(ev.key) + ' ' + safe(ev.reason)
    case 'withdrawn':
      return 'withdrawn ' + safe(ev.key) + ' ' + key8(ev.peerKey) + ' ' + safe(ev.reason)
    case 'have':
      return 'have ' + safe(ev.key) + ' ' + safe(ev.length)
    case 'downloaded':
      return 'downloaded ' + safe(ev.key) + ' ' + safe(ev.length)
    case 'group-downloaded':
      return 'grupo ' + key8(ev.key) + ' ' + safe(ev.length)
    default:
      return null
  }
}

module.exports = { key8, formatEvent }
