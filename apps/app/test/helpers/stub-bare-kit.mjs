import { EventEmitter } from 'node:events'

// Records every Worklet the client creates; the IPC does nothing.
export class Worklet {
  constructor (id) {
    this.id = id
    this.terminated = false
    this.IPC = new EventEmitter()
    this.IPC.write = () => {}
    this.IPC.end = () => {}
    ;(globalThis.__stubWorklets ??= []).push(this)
  }

  start (filename, source, args) {
    this.args = args
  }

  terminate () {
    this.terminated = true
  }
}
