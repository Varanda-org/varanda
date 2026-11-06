'use strict'
// The worklet's Bare.on('unhandledRejection') listener (worklet/main.js),
// apart so the Node tests reach it. Without a listener Bare aborts the whole
// app on a rejection nobody handled; with it the rejection is logged and the
// node keeps running, as the browser node does. Uncaught exceptions still
// abort. The listener never throws: a throw here goes to Bare's
// uncaughtException path, which aborts.

const { safe } = require('@varanda/core/lib/safe')

function reasonText (reason) {
  try {
    if (reason instanceof Error) return String(reason.stack || reason.message)
    return String(reason)
  } catch {
    return '(unprintable reason)'
  }
}

// log(line): console.error in the worklet (the system log). The line is one
// line: safe() escapes the stack's newlines along with any control text.
function createRejectionLogger (log) {
  return function onUnhandledRejection (reason) {
    try {
      log('varanda worklet: unhandled rejection ' + safe(reasonText(reason)))
    } catch {}
  }
}

module.exports = { createRejectionLogger }
