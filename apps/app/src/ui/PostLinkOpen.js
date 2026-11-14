/* global AbortController */
// What a visitor with no account on this device sees when it opened a shared
// post link, on a first visit or a later one (App.js decides when, through
// postLink.js postOpeningGate): the post as the installation's seeder
// previews it (../postPreview.js), else a row with no content, drawn the same
// whether the preview is loading or will never come. Every press in it, and
// Ver mais, opens ./PostLinkSheet, whose buttons go on to the terms gate as
// the intro's last card would. Como funciona shows the intro cards and comes
// back here; Agora não hides the preview for this load only, leading to the
// intro on a first visit and otherwise to the Terms and Entrar.

import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { statusBarStyle } from '../appearance'
import { HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'
import { postRef } from '../postLink'
import { fetchPostPreview } from '../postPreview'
import { POST_LINK_TITLE, PREVIEW_BAR_TITLE, SEE_MORE_LABEL } from '../postPreviewCopy'
import { Btn } from './index'
import { PostLinkPreviewRow } from './PostLinkPreviewRow'
import { PostLinkSheet } from './PostLinkSheet'
import { TopBar } from './TopBar'
import { fonts, layout, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

// The top bar pads the top inset itself, so the screen leaves it out.
function withoutTop (edges) {
  if (Array.isArray(edges)) return edges.filter((e) => e !== 'top')
  if (edges && typeof edges === 'object') return { ...edges, top: 'off' }
  return ['bottom', 'left', 'right']
}

export function PostLinkOpen ({ post, origin, onEnter, onHow, onLater, sidePad = 0, edges }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  const [asking, setAsking] = useState(false)
  const ref = typeof origin === 'string' && origin !== '' ? postRef(post) : null
  const target = ref !== null ? { author: post.author, seq: post.seq } : null
  const key = ref !== null ? origin + ' ' + ref : null
  const [answer, setAnswer] = useState({ key: null, model: null })
  useEffect(() => {
    if (target === null) return
    const ctl = new AbortController()
    let alive = true
    fetchPostPreview({ origin, post: target, signal: ctl.signal }).then((model) => {
      if (alive) setAnswer({ key, model })
    })
    return () => {
      alive = false
      ctl.abort()
      setAnswer({ key: null, model: null })
    }
  }, [origin, target && target.author, target && target.seq])
  // An earlier answer, for this or another post or installation, is never
  // drawn: leaving a target drops its answer, and the key check covers the
  // render before the cleanup's update lands.
  const model = key !== null && answer.key === key ? answer.model : null
  const ask = () => setAsking(true)
  return (
    <SafeAreaView style={[styles.root, { paddingHorizontal: sidePad }]} edges={withoutTop(edges)}>
      <TopBar title={PREVIEW_BAR_TITLE} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <Text accessibilityRole='header' style={styles.title}>{POST_LINK_TITLE}</Text>
          <PostLinkPreviewRow
            key={key || 'none'}
            model={model}
            origin={origin}
            post={target}
            onAsk={ask}
            skeleton={model === null}
          />
          <View style={styles.more}>
            <Btn block label={SEE_MORE_LABEL} onPress={ask} />
          </View>
          <View style={styles.dim} aria-hidden accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
            <PostLinkPreviewRow model={null} onAsk={ask} skeleton hidden />
            <PostLinkPreviewRow model={null} onAsk={ask} skeleton hidden />
          </View>
          <View style={styles.links}>
            <Pressable accessibilityRole='button' onPress={onHow} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <Text style={styles.linkText}>{HOW_LABEL}</Text>
            </Pressable>
            <Pressable accessibilityRole='button' onPress={onLater} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <Text style={styles.linkText}>{LATER_LABEL}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
      <PostLinkSheet open={asking} onClose={() => setAsking(false)} onEnter={onEnter} onHow={onHow} />
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, paddingBottom: space.lg },
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center' },
  title: { ...type.threadTitle, fontFamily: fonts.title, color: colors.ink, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  more: { paddingHorizontal: space.lg, paddingVertical: space.md },
  dim: { opacity: 0.45 },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md },
  link: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.xs },
  linkText: { ...type.pill, color: colors.ink },
  pressed: { opacity: 0.6 }
})
