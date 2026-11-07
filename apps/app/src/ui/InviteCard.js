// A signup invite card: the regional frame with the greeting a member wrote,
// opening with a short fade and grow (../inviteCardMotion.js). The name,
// message and username come from the card in the link, so they are peer
// text and go through displayText. `children` is the action slot inside the
// card; it answers touches at once, also while the card is still opening.

import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, Text } from 'react-native'
import { displayText } from '@varanda/rpc'
import { inviteCardMotion } from '../inviteCardMotion'
import { InviteCardFrame } from './InviteCardFrame'
import { useReduceMotion } from './StackLayer'
import { useStyles } from './ThemeProvider'
import { space, type } from './theme'

export function InviteCard ({ design, name, message, username, expiryText, maxMessageLines, children }) {
  const styles = useStyles(makeStyles)
  const reduced = useReduceMotion()
  const start = inviteCardMotion(false).from
  const opacity = useRef(new Animated.Value(start.opacity)).current
  const scale = useRef(new Animated.Value(start.scale)).current

  // Played on mount; a reduced motion setting that arrives late settles it.
  useEffect(() => {
    const m = inviteCardMotion(reduced)
    if (m.duration === 0) {
      opacity.setValue(m.to.opacity)
      scale.setValue(m.to.scale)
      return
    }
    const easing = Easing.bezier(...m.bezier)
    const anim = Animated.parallel([
      Animated.timing(opacity, { toValue: m.to.opacity, duration: m.duration, easing, useNativeDriver: false }),
      Animated.timing(scale, { toValue: m.to.scale, duration: m.duration, easing, useNativeDriver: false })
    ])
    anim.start()
    return () => anim.stop()
  }, [reduced, opacity, scale])

  const hasUser = typeof username === 'string' && username !== ''
  return (
    <Animated.View style={[styles.wrap, { opacity, transform: [{ scale }] }]}>
      <InviteCardFrame design={design}>
        <Text style={styles.name}>{'Pra ' + displayText(name)}</Text>
        <Text style={styles.message} numberOfLines={maxMessageLines} ellipsizeMode={maxMessageLines ? 'tail' : undefined}>{displayText(message, { multiline: true })}</Text>
        {hasUser ? <Text style={styles.user} numberOfLines={1}>{'@' + displayText(username)}</Text> : null}
        {typeof expiryText === 'string' && expiryText !== '' ? <Text style={styles.expiry}>{expiryText}</Text> : null}
        {children}
      </InviteCardFrame>
    </Animated.View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { width: '100%', alignItems: 'center' },
  name: { ...type.profileName, color: colors.ink },
  message: { ...type.postText, color: colors.ink },
  user: { ...type.postName, color: colors.ink, marginTop: space.xs },
  expiry: { ...type.replyMark, color: colors.ink }
})
