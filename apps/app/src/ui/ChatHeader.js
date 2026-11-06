// The top bar of a chat: back, the person's round avatar (or the group's
// rounded square), the title with an optional subtitle under it, then the
// icon actions on the right. A tap on the avatar or the titles runs onPress
// (the profile or the group's Informações). Built on TopBar, so the bar keeps
// its height, safe area and 44 pt targets. `title` and `subtitle` may be the
// peer's raw strings: both go through displayText here.
//
// Props: { title, subtitle, publicKey, picture, persist, group, onBack, onPress,
//   pressLabel, right }. `group` draws the square avatar; `right` is passed
//   to TopBar as is ({ icon, label, onPress, badge } or a list of them).

import { Pressable, StyleSheet } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Avatar } from './Avatar'
import { TopBar } from './TopBar'
import { useStyles } from './ThemeProvider'

const SIZE = 36

export function ChatHeader ({ title, subtitle, publicKey, picture, persist = false, group = false, onBack, onPress, pressLabel, right }) {
  const styles = useStyles(makeStyles)
  const shownTitle = typeof title === 'string' ? displayText(title).trim() : ''
  const shownSubtitle = typeof subtitle === 'string' ? displayText(subtitle).trim() : ''
  const press = typeof onPress === 'function' ? onPress : undefined
  const avatar = (
    <Avatar
      name={shownTitle || null}
      publicKey={typeof publicKey === 'string' ? publicKey : ''}
      picture={picture}
      persist={persist}
      size={SIZE}
      shape={group ? 'square' : 'circle'}
    />
  )
  // The avatar is decorative for screen readers: the titles carry the label
  // and the same action, so it is announced once.
  const leading = press
    ? (
      <Pressable
        onPress={press}
        accessibilityElementsHidden
        importantForAccessibility='no-hide-descendants'
        hitSlop={4}
        style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}
      >
        {avatar}
      </Pressable>
      )
    : avatar
  return (
    <TopBar
      onBack={onBack}
      leading={leading}
      title={shownTitle}
      subtitle={shownSubtitle || undefined}
      onTitlePress={press}
      titleLabel={pressLabel}
      right={right}
    />
  )
}

const makeStyles = () => StyleSheet.create({
  avatar: { borderRadius: SIZE / 2 },
  pressed: { opacity: 0.6 }
})
