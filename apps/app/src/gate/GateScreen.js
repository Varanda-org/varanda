// The gate harness screen: runs src/gate/harness.js once per JS context and
// shows its log. Mounted by App.js only when EXPO_PUBLIC_VARANDA_GATE_URL
// was set at build time.

import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStyles } from '../ui/ThemeProvider'
import { runGate } from './harness'

const KEY = '__varandaGate'

export default function GateScreen ({ url }) {
  const styles = useStyles(makeStyles)
  const [lines, setLines] = useState(() => (globalThis[KEY] ? globalThis[KEY].lines.slice() : []))

  useEffect(() => {
    if (!globalThis[KEY]) {
      const shared = { lines: [], listeners: new Set() }
      globalThis[KEY] = shared
      const log = (line) => {
        shared.lines.push(line)
        for (const fn of shared.listeners) fn(shared.lines.slice())
      }
      runGate(url, log).then(
        () => log('harness: finished'),
        (err) => log('harness: stopped: ' + (err && err.message ? err.message : String(err)))
      )
    }
    const shared = globalThis[KEY]
    shared.listeners.add(setLines)
    setLines(shared.lines.slice())
    return () => { shared.listeners.delete(setLines) }
  }, [url])

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Varanda: iOS gate</Text>
      <Text style={styles.url}>{url}</Text>
      <ScrollView style={styles.log}>
        {lines.map((line, i) => (
          <Text key={i} style={line.startsWith('FAIL') ? styles.fail : styles.line}>{line}</Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '600', marginTop: 8, color: colors.ink },
  url: { fontSize: 12, color: colors.soft, marginBottom: 8 },
  log: { flex: 1 },
  line: { fontFamily: 'Menlo', fontSize: 11, marginBottom: 4, color: colors.ink },
  fail: { fontFamily: 'Menlo', fontSize: 11, marginBottom: 4, color: colors.danger }
})
