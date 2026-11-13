import { useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { isKey } from '@varanda/rpc'
import { MOMENT_GONE, previewPlan, previewUntil } from '../momentReaction'
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
    let alive = true
    let gone = false
    let read = false
    let polling = null
    let expiry = null
    let release = null
    let until = null
    const drop = () => {
      gone = true
      clearTimeout(polling)
      clearTimeout(expiry)
      if (release) release()
      release = null
      if (alive) setState({ key, kind: 'gone' })
    }
    const loadImage = async (lookup, size) => {
      read = true
      try {
        const got = await media.read({ kind: 'moment', author, seq })
        const forget = () => {
          if (typeof got?.uri !== 'string') return
          const name = got.uri.slice(got.uri.lastIndexOf('/') + 1)
          try { if (typeof media.forgetReadFile === 'function') media.forgetReadFile(name) } catch {}
        }
        let uri = null
        try {
          if (alive && !gone && Date.now() < until && got?.mime === lookup.mime) {
            if (got.bytes instanceof Uint8Array) {
              uri = urlFromBytes(got.bytes, got.mime)
              release = () => revokeUrl(uri)
              forget()
            } else if (typeof got.uri === 'string' && got.uri.startsWith('file://')) {
              uri = got.uri
              release = forget
            }
          }
          if (!uri) forget()
        } catch (err) {
          forget()
          throw err
        } finally {
          if (got?.bytes instanceof Uint8Array) got.bytes.fill(0)
        }
        if (!alive) return
        if (!uri) drop()
        else setState({ key, kind: 'image', uri, size, handleError: drop })
      } catch {
        if (alive) drop()
      }
    }
    const lookup = async () => {
      try {
        const found = await request('moment.lookup', { author, seq })
        if (!alive || gone) return
        const plan = previewPlan(found)
        until = previewUntil(found)
        if (plan.kind === 'gone' || until === null || Date.now() >= until) {
          drop()
          return
        }
        clearTimeout(expiry)
        expiry = setTimeout(() => {
          drop()
          lookup()
        }, until - Date.now())
        const scale = Math.min(1, 72 / Math.max(found.w, found.h))
        const size = { width: found.w * scale, height: found.h * scale }
        if (plan.kind === 'video') setState({ key, kind: 'video', size })
        else if (!read) loadImage(found, size)
      } catch {
        if (alive) drop()
      } finally {
        if (alive && !gone) polling = setTimeout(lookup, 15000)
      }
    }
    setState(null)
    lookup()
    return () => {
      alive = false
      clearTimeout(polling)
      clearTimeout(expiry)
      if (release) release()
      release = null
    }
  }, [allowed, key, author, seq, request, media])
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
