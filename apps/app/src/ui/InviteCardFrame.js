// The regional frame around an invite card, drawn from the shared art data
// (../inviteCardArt.js) with plain Views only, so it renders the same on iOS,
// Android and web with no svg, font or image: rects and circles are boxes,
// diamonds are turned squares, triangles are the border trick. The art is
// laid out on the measured width; the text sits on a card panel over the
// clear centre and the frame grows with it. An unknown design gets the
// neutral frame.

import { useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { CANVAS, SAFE_AREA, artFor, layoutArt } from '../inviteCardArt'
import { useStyles, useTheme } from './ThemeProvider'
import { radius, space } from './theme'

export const INVITE_CARD_MAX_WIDTH = 420

function Shape ({ item }) {
  if (item.kind === 'tri') {
    const edge = item.up ? 'borderBottom' : 'borderTop'
    return (
      <View
        style={{
          position: 'absolute',
          left: item.left,
          top: item.top,
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderLeftWidth: item.leftWidth,
          borderRightWidth: item.rightWidth,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          [edge + 'Width']: item.height,
          [edge + 'Color']: item.color
        }}
      />
    )
  }
  if (item.kind === 'diamond') {
    return (
      <View
        style={{
          position: 'absolute',
          left: item.left,
          top: item.top,
          width: item.side,
          height: item.side,
          backgroundColor: item.color,
          transform: [{ scaleX: item.scaleX }, { rotate: '45deg' }]
        }}
      />
    )
  }
  return (
    <View
      style={{
        position: 'absolute',
        left: item.left,
        top: item.top,
        width: item.width,
        height: item.height,
        borderRadius: item.radius,
        backgroundColor: item.color
      }}
    />
  )
}

export function InviteCardFrame ({ design, children }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  const screen = useWindowDimensions()
  // A first guess from the screen until the frame reports its own size.
  const [box, setBox] = useState(null)
  const art = artFor(design)
  const width = box ? box.width : Math.min(INVITE_CARD_MAX_WIDTH, Math.max(0, screen.width - space.lg * 2))
  const k = width / CANVAS.w
  const minHeight = CANVAS.h * k
  const height = box ? box.height : minHeight
  const items = width > 0 ? layoutArt(art, width, height, scheme) : []
  const onLayout = (e) => {
    const { width: w, height: h } = e.nativeEvent.layout
    setBox((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
  }
  return (
    <View style={[styles.frame, { backgroundColor: art.bg[scheme === 'dark' ? 'dark' : 'light'], minHeight }]} onLayout={onLayout}>
      <View style={StyleSheet.absoluteFill} pointerEvents='none' accessible={false} importantForAccessibility='no-hide-descendants'>
        {items.map((item, i) => <Shape key={i} item={item} />)}
      </View>
      <View
        style={{
          paddingTop: SAFE_AREA.y * k,
          paddingBottom: (CANVAS.h - SAFE_AREA.y - SAFE_AREA.h) * k,
          paddingLeft: SAFE_AREA.x * k,
          paddingRight: (CANVAS.w - SAFE_AREA.x - SAFE_AREA.w) * k,
          minHeight,
          flexGrow: 1
        }}
      >
        <View style={styles.panel}>{children}</View>
      </View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  frame: {
    position: 'relative',
    width: '100%',
    maxWidth: INVITE_CARD_MAX_WIDTH,
    alignSelf: 'center',
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line
  },
  panel: {
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.sm
  }
})
