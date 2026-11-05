export const SLOW_REQUEST_MS = 2000

export function slowRequestLine (method, startedAt, endedAt) {
  if (typeof method !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(method)) return null
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null
  const ms = endedAt - startedAt
  if (ms <= SLOW_REQUEST_MS) return null
  return 'pedido lento: ' + method + ', ' + (ms / 1000).toFixed(1) + ' s'
}
