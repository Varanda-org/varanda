// Native. No outbox: publishing keeps today's behaviour and nothing is
// stored. randomId exists only so both platforms export the same names.

export const outboxAvailable = false

export function loadOutbox () {
  return []
}

export function saveOutbox (items) {
  return false
}

export function randomId () {
  let id = ''
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}
