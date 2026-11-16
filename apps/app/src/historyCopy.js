// Copying the conversation history to another device (rpc 5.151,
// docs/protocol.md section 11): the texts of the Conversas option and its
// sheet, the result lines, and the small store the two events feed
// (dm.copyProgress on the device that copies, dm.copyImported on the device
// that receives). Pure: no React, no react-native, no Node built-ins, so the
// tests run it as it is. The retention is the seeder's (core
// DM_RETENTION_MS, 14 days once the sibling change lands); the texts say 14.

export const COPY_DAYS = 14

export const COPY_ROW_LABEL = 'Copiar conversas para outro aparelho'
export const COPY_ROW_HINT = 'Leva o texto e as fotos guardadas aqui.'
export const COPY_TITLE = 'Copiar conversas'
export const COPY_POINTS = Object.freeze([
  'Vai o texto das conversas, também o das Páginas que você administra, e as fotos guardadas neste aparelho. As fotos das Páginas não vão.',
  'Só os seus aparelhos que entram com a mesma passkey conseguem abrir a cópia. Ela fica lacrada com a sua chave.',
  'O outro aparelho tem ' + COPY_DAYS + ' dias para abrir a Varanda e receber. Depois a cópia some.',
  'As fotos usam a cota semanal de cópia do semeador, das mais recentes para as mais antigas. Se a cota acabar, ou se o semeador não oferecer a cópia de fotos, elas ficam de fora e o texto vai inteiro.',
  'Só o texto leva poucos minutos. Com a cota de fotos inteira, leva de 30 a 50 minutos. Deixe o app aberto até terminar.'
])
export const COPY_START = 'Copiar agora'
export const COPY_AGAIN = 'Tentar de novo'
export const COPY_CLOSE = 'Fechar'
export const COPY_STARTING = 'Preparando a cópia'

export const IMPORTED_TITLE = 'Conversas copiadas de outro aparelho'
export const IMPORTED_DISMISS = 'Entendi'

function plural (n, one, many) {
  return n + ' ' + (n === 1 ? one : many)
}

function isCount (n) {
  return Number.isSafeInteger(n) && n >= 0
}

// dm.copyProgress { done, total } -> '3 de 5', or the starting text.
export function progressText (progress) {
  if (!progress || !isCount(progress.done) || !isCount(progress.total) || progress.total === 0) return COPY_STARTING
  return 'Copiando: ' + Math.min(progress.done, progress.total) + ' de ' + progress.total
}

// The result of dm.historyCopy { messages, photos, notCached, leftOut } as the
// sentences the sheet shows, in order. A malformed result says only that it
// finished.
export function resultLines (result) {
  if (!result || !isCount(result.messages) || !isCount(result.photos)) return ['A cópia terminou.']
  const lines = ['Pronto: ' + plural(result.messages, 'mensagem copiada', 'mensagens copiadas') + ' e ' + plural(result.photos, 'foto', 'fotos') + '.']
  if (isCount(result.notCached) && result.notCached > 0) {
    lines.push(plural(result.notCached, 'foto não estava guardada', 'fotos não estavam guardadas') + ' neste aparelho e ' + (result.notCached === 1 ? 'ficou' : 'ficaram') + ' de fora.')
  }
  if (isCount(result.leftOut) && result.leftOut > 0) {
    lines.push(plural(result.leftOut, 'foto ficou de fora', 'fotos ficaram de fora') + ' porque a cota de cópia de fotos acabou ou o semeador não a oferece. Uma nova cópia começa de novo pelas fotos mais recentes.')
  }
  return lines
}

// dm.copyImported { messages } -> the notice's body.
export function importedText (imported) {
  const n = imported && isCount(imported.messages) ? imported.messages : 0
  if (n === 0) return 'As conversas deste aparelho já estavam em dia.'
  return plural(n, 'mensagem chegou', 'mensagens chegaram') + ' de outro aparelho seu. ' + (n === 1 ? 'Ela aparece na data em que foi enviada.' : 'Elas aparecem na data em que foram enviadas.')
}

const IDLE = Object.freeze({ progress: null, imported: null })

// The next state for an event; anything but the two events, or a malformed
// one, leaves it as it was.
export function copyReduce (state, name, data) {
  if (name === 'dm.copyProgress') {
    if (!data || !isCount(data.done) || !isCount(data.total)) return state
    return { ...state, progress: { done: data.done, total: data.total } }
  }
  if (name === 'dm.copyImported') {
    if (!data || !isCount(data.messages)) return state
    return { ...state, imported: { messages: data.messages } }
  }
  return state
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
    clearProgress () {
      if (state.progress === null) return
      state = { ...state, progress: null }
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
