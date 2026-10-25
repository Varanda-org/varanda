// Sincronizar: read-only diagnostics of the automatic sync. The app starts and
// keeps the sync itself (node.js), so this screen sends no start or stop
// request: it shows the state from the node's events (kept by the provider,
// keyed by runId), the next retry and the last 200 event and warning lines.

import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { Body, Btn, Card, Mono, Page, Soft, Title, useNow } from '../ui'

const REASONS = {
  done: 'concluída',
  stopped: 'parada',
  preempted: 'pausada para atender um pedido',
  timeout: 'tempo esgotado',
  error: 'erro'
}

// Time the last run ended, or '' when it is missing or unreadable.
function endTime (at) {
  if (at === undefined || at === null) return ''
  try {
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// The state line: a continuous run is the automatic sync; a once run is the
// recovery after an unlock while `recovering`, otherwise a short run the
// node makes around a publish.
function stateLine (active, recovering) {
  if (active === null) return 'parada'
  const kind = active.once ? (recovering ? 'recuperando (única, ' : 'sincronizando (única, ') : 'sincronizando (contínua, '
  return kind + 'execução ' + String(active.runId) + ')'
}

export default function Sincronizar ({ embedded = false, onOpenConnection }) {
  const node = useNode()
  const { sync, autoSync } = node
  // Ticks each second while a retry is waited for (the countdown).
  const now = useNow(1000)
  const running = sync.active !== null
  const { stopped: last } = sync
  const retryIn = autoSync.backoffUntil > now ? Math.ceil((autoSync.backoffUntil - now) / 1000) : 0
  return (
    <Page>
      {embedded ? null : <Title>Sincronização</Title>}
      <Card>
        {node.phase !== 'ready' ? <Soft>sem conexão com o nó</Soft> : null}
        {node.phase !== 'ready' && typeof onOpenConnection === 'function' ? <Btn label='abrir Conexão' secondary onPress={onOpenConnection} /> : null}
        <Body>{stateLine(sync.active, Boolean(node.passkey && node.passkey.recovering))}</Body>
        {!running && last ? <Soft>{'última execução ' + String(last.runId) + ': ' + (REASONS[last.reason] || displayText(last.reason)) + (endTime(last.at) ? ', às ' + endTime(last.at) : '')}</Soft> : null}
        {retryIn > 0 ? <Soft>{'nova tentativa em ' + String(retryIn) + ' s'}</Soft> : null}
        {autoSync.reconciling ? <Soft>conferindo o estado…</Soft> : null}
        <Soft>Atualiza sozinho enquanto o app está aberto e com rede.</Soft>
      </Card>
      <Card>
        <Soft>{'linhas (as últimas ' + String(sync.lines.length) + ')'}</Soft>
        {sync.lines.length === 0 ? <Soft>Nenhuma linha ainda.</Soft> : null}
        {sync.lines.map((line, i) => <Mono key={i}>{displayText(line)}</Mono>)}
      </Card>
    </Page>
  )
}
