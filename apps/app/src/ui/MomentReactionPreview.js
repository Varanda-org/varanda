import { useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { isKey } from '@varanda/rpc'
import { MOMENT_GONE } from '../momentReaction'
import { sharedPreviews } from '../momentPreviews'
import { useNode } from '../node'
import { revokeUrl, urlFromBytes } from '../media/display'
import { Soft } from '../ui'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { radius } from './theme'

export function MomentReactionPreview ({ author, seq, identity, folder }) {
  const { request, media } = useNode()
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const key = JSON.stringify([identity, author, seq, folder])
  const [state, setState] = useState(null)
  const allowed = folder !== 'request' && isKey(author) && Number.isSafeInteger(seq) && seq >= 1
  useEffect(() => {
    if (!allowed) return undefined
    setState(null)
    return sharedPreviews(request, media, { urlFromBytes, revokeUrl, now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout })
      .watch({ identity, author, seq }, (next) => setState({ key, ...next }))
  }, [allowed, key, identity, author, seq, request, media])
  if (!allowed || state?.key !== key) return null
  if (state.kind === 'gone') return <Soft>{MOMENT_GONE}</Soft>
  if (state.kind === 'video') {
    return <View style={[styles.tile, state.size]} accessibilityLabel='Vídeo do momento'><Icon name='tocar' size={24} color={colors.soft} /></View>
  }
  return <Image source={{ uri: state.uri }} style={[styles.tile, state.size]} resizeMode='contain' accessibilityLabel='Foto do momento' onError={state.handleError} />
}

const makeStyles = (colors) => StyleSheet.create({
  tile: { borderRadius: radius.sm, backgroundColor: colors.skeleton, alignItems: 'center', justifyContent: 'center' }
})
