// One member row: avatar and name (with the verified @nome) open the profile;
// the pill follows ('Seguir') or unfollows ('Seguindo'), disabled while the
// follow set is unknown (`following` null). Never shows a key and has no
// 'denunciar'.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { whoOf } from '../who'
import { pageBadgeLabel } from '../pageBadge'
import { Avatar } from './Avatar'
import { FollowPill } from './FollowPill'
import { type } from './theme'
import { useStyles } from './ThemeProvider'

// `hint` is the names view (its page flags are the seeder's hint, when names
// learned one) and `hit` the search row (its own seeder hint). Either may say
// page; a names view without the flags must not hide the hit's badge.
const flag = (k, a, b) => (a && a[k] === true) || (b && b[k] === true)
export const mergePageInfo = (hint, hit) => ({ page: flag('page', hint, hit), closed: flag('closed', hint, hit), moved: flag('moved', hint, hit) })

export function MemberRow ({ hit, hint, avatar, following, onOpen, onFollow, onUnfollow, pending, disabled }) {
  const pageInfo = mergePageInfo(hint, hit)
  const profile = { name: hit.name, username: hit.username, ...(pageInfo.page === true ? { page: true } : {}) }
  const badge = pageBadgeLabel(pageInfo)
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  const subtitle = who.subtitle ? displayText(who.subtitle) : null
  const open = typeof onOpen === 'function' ? () => onOpen(hit.author, profile) : undefined
  return (
    <View>
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
            {badge ? <Text style={styles.handle} numberOfLines={1}>{badge}</Text> : null}
          </View>
        </Pressable>
        <FollowPill
          small
          following={following}
          title={title}
          pending={pending}
          disabled={disabled}
          onFollow={() => onFollow(hit)}
          onUnfollow={() => onUnfollow(hit)}
        />
      </View>
      <View style={styles.divider} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16
  },
  // Starts after the avatar (16 padding + 44 avatar + 12 gap).
  divider: { marginLeft: 72, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  open: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.meta, color: colors.soft }
})
