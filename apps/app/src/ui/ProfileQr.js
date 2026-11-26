import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { displayText } from '@varanda/rpc'
import { profileQr, qrPath, QUIET_ZONE } from '../profileQr'
import { Soft } from './index'

const SIDE = 232

// Black on white in both themes: a reader needs the contrast, and a dark
// theme's inverted code fails on many cameras.
export function ProfileQr ({ url, label }) {
  const qr = useMemo(() => profileQr(url), [url])
  const d = useMemo(() => (qr === null ? '' : qrPath(qr)), [qr])
  if (qr === null) return <Soft>não foi possível gerar o QR</Soft>
  const box = qr.size + 2 * QUIET_ZONE
  return (
    <View style={styles.wrap}>
      <View style={styles.card} accessible accessibilityRole='image' accessibilityLabel={'QR de ' + displayText(label || 'perfil')}>
        <Svg width={SIDE} height={SIDE} viewBox={'0 0 ' + box + ' ' + box} shapeRendering='crispEdges'>
          <Rect x={0} y={0} width={box} height={box} fill='#ffffff' />
          <Path d={d} fill='#000000' />
        </Svg>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  card: { backgroundColor: '#ffffff', borderRadius: 16, padding: 8 }
})
