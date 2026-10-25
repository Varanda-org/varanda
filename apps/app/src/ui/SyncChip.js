// The sync state chip of the top bar: what the automatic sync is doing, from
// the folded sync signals (syncSignals.js chipState). There is no call to
// sync (sync is automatic) and no last-synced time: the node has no such fact
// (the own-sync signal is separate). Pressing it opens the sync screen
// (onPress).

import { Pressable, StyleSheet, Text } from 'react-native'
import { useNode } from '../node'
import { chipState, EMPTY_SIGNALS } from '../syncSignals'
import { Icon } from './Icon'
import { useNow } from './index'
import { colors, type } from './theme'

const SYNCING = ['sincronização automática', 'sincronizando…', 'conectando…', 'reconectando…', 'recuperando…']
const ACCENT = ['sincronização automática', 'sincronizando…']

export function SyncChip ({ onPress }) {
  const { phase, sync, online, autoSync, signals, passkey } = useNode()
  // 'sincronizando…' lasts 5 s after a download: re-render often enough.
  const now = useNow(2000)
  const text = chipState({
    online,
    connected: phase === 'ready' && online !== false,
    active: (sync && sync.active) || null,
    wanted: Boolean(autoSync && autoSync.wanted),
    signals: signals || EMPTY_SIGNALS,
    now,
    recovering: Boolean(passkey && passkey.recovering)
  })
  const on = SYNCING.includes(text)
  const accent = ACCENT.includes(text)
  const tint = accent ? colors.accent : colors.soft
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={'sincronização: ' + text}
      onPress={onPress}
      hitSlop={4}
      style={[styles.chip, accent ? styles.on : styles.off]}
    >
      <Icon name={on ? 'sinc' : 'semconexao'} size={13} color={tint} />
      <Text style={[styles.text, { color: tint }]} numberOfLines={1}>{text}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999 },
  on: { backgroundColor: colors.accentSoft },
  off: { backgroundColor: 'rgba(31,42,36,0.08)' },
  text: { ...type.chip }
})
