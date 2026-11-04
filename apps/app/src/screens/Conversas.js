// Conversas: the tab. A segmented selector (selectorItems) above either
// Mensagens (private 1:1 text, hosted only) or the unchanged Comunidades
// screen. The selector state is local (memory only) and opens on Mensagens.
// `showMensagens` is a counter: when it changes (a push opened Conversas) the
// Mensagens segment comes back. App.js draws the top bar. onSegment(id)
// reports the shown segment, so App.js counts the groups as seen only while
// Comunidades is on screen.
// Props: { onOpenGroup, onOpenCommunity, onOpenThread, showMensagens, onSegment }.

import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { selectorItems } from '../dm'
import { initialSegment } from '../dm-open'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'
import { Comunidades } from './Comunidades'
import { Mensagens } from './Mensagens'

export function Conversas ({ onOpenGroup, onOpenCommunity, onOpenThread, showMensagens = 0, onSegment }) {
  const styles = useStyles(makeStyles)
  const items = selectorItems()
  const [segment, setSegment] = useState(() => initialSegment(items))
  const last = useRef(showMensagens)
  useEffect(() => {
    if (last.current !== showMensagens) {
      last.current = showMensagens
      setSegment(initialSegment(selectorItems()))
    }
  }, [showMensagens])
  useEffect(() => {
    if (typeof onSegment === 'function') onSegment(segment)
  }, [segment, onSegment])

  return (
    <View style={styles.root}>
      <View style={styles.selector} accessibilityRole='tablist'>
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole='tab'
            accessibilityState={{ selected: segment === item.id }}
            onPress={() => setSegment(item.id)}
            style={[styles.tab, segment === item.id && styles.tabOn]}
          >
            <Text style={[styles.tabText, segment === item.id && styles.tabTextOn]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={segment === 'mensagens' ? styles.root : styles.hidden}>
        <Mensagens onOpenThread={onOpenThread} />
      </View>
      <View style={segment === 'comunidades' ? styles.root : styles.hidden}>
        <Comunidades onOpenGroup={onOpenGroup} onOpenCommunity={onOpenCommunity} />
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hidden: { display: 'none' },
  selector: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { ...type.pill, color: colors.soft },
  tabTextOn: { color: colors.ink }
})
