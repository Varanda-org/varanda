// The notice a device shows when a copy of the conversation history from
// another device of the same passkey was filed here (dm.copyImported,
// docs/protocol.md section 11). The copy itself runs in the node, without a
// screen. Pure: no React, no react-native, no Node built-ins, so the tests run
// it as it is.

export const IMPORTED_TITLE = 'Conversas copiadas de outro aparelho'
export const IMPORTED_DISMISS = 'Entendi'

function plural (n, one, many) {
  return n + ' ' + (n === 1 ? one : many)
}

function isCount (n) {
  return Number.isSafeInteger(n) && n >= 0
}

// dm.copyImported { messages } -> the notice's body.
export function importedText (imported) {
  const n = imported && isCount(imported.messages) ? imported.messages : 0
  if (n === 0) return 'As conversas deste aparelho já estavam em dia.'
  return plural(n, 'mensagem chegou', 'mensagens chegaram') + ' de outro aparelho seu. ' + (n === 1 ? 'Ela aparece na data em que foi enviada.' : 'Elas aparecem na data em que foram enviadas.')
}

const IDLE = Object.freeze({ imported: null })

// The next state for an event; anything but dm.copyImported, or a malformed
// one, leaves it as it was.
export function copyReduce (state, name, data) {
  if (name !== 'dm.copyImported' || !data || !isCount(data.messages)) return state
  return { ...state, imported: { messages: data.messages } }
}

// One store per app: node.js feeds it, the screens read it with
// useSyncExternalStore (get returns the same object until an event changes it).
export function createCopyStore () {
  let state = IDLE
  const listeners = new Set()
  const emit = () => { for (const fn of [...listeners]) fn() }
  return {
    get: () => state,
    subscribe (fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    apply (name, data) {
      const next = copyReduce(state, name, data)
      if (next === state) return
      state = next
      emit()
    },
    clearImported () {
      if (state.imported === null) return
      state = { ...state, imported: null }
      emit()
    }
  }
}

export const copyStore = createCopyStore()
