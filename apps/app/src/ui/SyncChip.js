// The sync state chip of the top bar: no network (the browser says it is
// offline), offline (no node), syncing, last sync or a call to sync. Pressing it opens the sync screen (onPress).

import { Pressable, StyleSheet, Text } from 'react-native'
import { sinceText } from '../format'
import { useNode } from '../node'
import { Icon } from './Icon'
import { useNow } from './index'
import { colors, type } from './theme'

export function SyncChip ({ onPress }) {
  const { phase, sync, online } = useNode()
  const now = useNow(30000)
  const offline = online === false
  const connected = phase === 'ready' && !offline
  const stopped = sync && sync.stopped
  let text
  if (offline) text = 'sem rede'
  else if (!connected) text = 'sem conexão'
  else if (sync && sync.active) text = 'sincronizando…'
  else if (stopped && stopped.reason === 'done' && !(stopped.result && stopped.result.ok === false)) text = 'sincronizado ' + sinceText(stopped.at, now)
  else text = 'sincronizar'
  const tint = connected ? colors.accent : colors.soft
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={'sincronização: ' + text}
      onPress={onPress}
      hitSlop={4}
      style={[styles.chip, connected ? styles.on : styles.off]}
    >
      <Icon name={connected ? 'sinc' : 'semconexao'} size={13} color={tint} />
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
