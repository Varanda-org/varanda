// One member row: avatar and name (with the verified @nome) open the profile;
// the pill follows ('Seguir') or unfollows ('Seguindo'), disabled while the
// follow set is unknown (`following` null). Never shows a key and has no
// 'denunciar'.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { FollowPill } from './FollowPill'
import { colors, type } from './theme'

export function MemberRow ({ hit, avatar, following, onOpen, onFollow, onUnfollow, pending, disabled }) {
  const profile = { name: hit.name, username: hit.username }
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(hit.author, profile) : undefined
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.open, pressed && open && styles.pressed]}
        accessibilityRole='link'
        accessibilityLabel={'ver o perfil de ' + title}
        disabled={!open}
        onPress={open}
      >
        <Avatar name={who.avatarName} publicKey={hit.author} size={44} picture={avatar} persist={following === true} />
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </Pressable>
      <FollowPill
        following={following}
        title={title}
        pending={pending}
        disabled={disabled}
        onFollow={() => onFollow(hit)}
        onUnfollow={() => onUnfollow(hit)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  open: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft }
})
