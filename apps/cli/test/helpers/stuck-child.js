'use strict'

// Worker thread, Linux only, started by secrets.test.js. spawnSync blocks the
// test's own thread, so this one watches its children: one still running
// after workerData.afterMs is written to fd 2 once, with its argv, state and
// kernel wait channel, before spawnSync's kill. Nothing else is read.

const fs = require('node:fs')
const { workerData } = require('node:worker_threads')

const { parent, afterMs } = workerData
const since = new Map() // pid -> when first seen as a child of parent, or 0 once reported

function read (pid, name) {
  try { return fs.readFileSync('/proc/' + pid + '/' + name, 'utf8') } catch { return null }
}

function tick () {
  const now = Date.now()
  const alive = new Set()
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(pid)) continue
    const stat = read(pid, 'stat')
    if (stat === null) continue
    // The fields after "(comm)" start with state and ppid.
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(ppid) !== parent) continue
    alive.add(pid)
    const first = since.get(pid)
    if (first === undefined) {
      since.set(pid, now)
    } else if (first !== 0 && now - first >= afterMs) {
      since.set(pid, 0)
      const argv = (read(pid, 'cmdline') || '').split('\0').filter(Boolean)
      fs.writeSync(2, 'stuck child ' + JSON.stringify({ pid: Number(pid), state, wchan: read(pid, 'wchan'), argv }) + '\n')
    }
  }
  for (const pid of since.keys()) if (!alive.has(pid)) since.delete(pid)
}

setInterval(() => { try { tick() } catch {} }, 1000)
