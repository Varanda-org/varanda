// Sincronizar (Ajustes > Avançado): read-only diagnostics of the automatic
// sync. The app starts and keeps the sync itself (node.js), so this screen
// sends no start or stop request: it shows the summary the top-bar chip used
// to carry (syncSignals.js chipState), the state from the node's events (kept
// by the provider, keyed by runId), the next retry and the last 200 event and
// warning lines.

import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode, useSyncLines, useSyncSignals } from '../node'
import { chipState } from '../syncSignals'
import { Body, Btn, Card, Mono, Page, Soft, Title, useNow } from '../ui'
import { type } from '../ui/theme'
import { useTheme } from '../ui/ThemeProvider'

// The log stays behind this row; the label is also the accessibility label.
const LOG_LABEL = 'Ver registro'

const REASONS = {
  done: 'concluída',
  idle: 'em pausa',
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

// Dot colour of the status row: danger when there is no network or node,
// accent when syncing or recovering, warn for the waiting states in between.
function dotColor (summary, colors) {
  if (summary === 'sem rede' || summary === 'sem conexão') return colors.danger
  if (summary === 'sincronização automática' || summary === 'sincronizando…' || summary === 'recuperando…') return colors.accent
  return colors.warn
}

export default function Sincronizar ({ embedded = false, onOpenConnection }) {
  const node = useNode()
  const { colors } = useTheme()
  const [logOpen, setLogOpen] = useState(false)
  const { sync, autoSync } = node
  const lines = useSyncLines()
  // lastDownloadAt drives the chip's 'sincronizando…'.
  const signals = useSyncSignals()
  // Ticks each second while a retry is waited for (the countdown).
  const now = useNow(1000)
  const running = sync.active !== null
  const { stopped: last } = sync
  const summary = chipState({
    online: node.online,
    connected: node.phase === 'ready' && node.online !== false,
    active: sync.active || null,
    wanted: Boolean(autoSync && autoSync.wanted),
    signals,
    now,
    recovering: Boolean(node.passkey && node.passkey.recovering)
  })
  const retryIn = autoSync.backoffUntil > now ? Math.ceil((autoSync.backoffUntil - now) / 1000) : 0
  return (
    <Page>
      {embedded ? null : <Title>Sincronização</Title>}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor(summary, colors) }} />
          <Body style={{ flex: 1 }}>{summary}</Body>
        </View>
        {node.phase !== 'ready' ? <Soft>sem conexão com o nó</Soft> : null}
        {node.phase !== 'ready' && typeof onOpenConnection === 'function' ? <Btn label='abrir Conexão' secondary onPress={onOpenConnection} /> : null}
        <Body>{stateLine(sync.active, Boolean(node.passkey && node.passkey.recovering))}</Body>
        {!running && last ? <Soft>{'última execução ' + String(last.runId) + ': ' + (REASONS[last.reason] || displayText(last.reason)) + (endTime(last.at) ? ', às ' + endTime(last.at) : '')}</Soft> : null}
        {retryIn > 0 ? <Soft>{'nova tentativa em ' + String(retryIn) + ' s'}</Soft> : null}
        {autoSync.reconciling ? <Soft>conferindo o estado…</Soft> : null}
        <Soft>Atualiza sozinho enquanto o app está aberto e com rede.</Soft>
      </Card>
      <Pressable
        onPress={() => setLogOpen((o) => !o)}
        accessibilityRole='button'
        accessibilityLabel={LOG_LABEL}
        accessibilityState={{ expanded: logOpen }}
        // react-native-web does not map accessibilityState.expanded.
        aria-expanded={logOpen}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ ...type.counter, color: colors.accent }}>{LOG_LABEL}</Text>
      </Pressable>
      {logOpen
        ? (
          <Card>
            <Soft>{'linhas (as últimas ' + String(lines.length) + ')'}</Soft>
            {lines.length === 0 ? <Soft>Nenhuma linha ainda.</Soft> : null}
            {lines.map((line, i) => <Mono key={i}>{displayText(line)}</Mono>)}
          </Card>
          )
        : null}
    </Page>
  )
}
