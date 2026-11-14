// The "+" sheet of the Conversas tab: search a member by name to open a
// private conversation, or start a community or a group. A group always
// lives inside a community, so 'Novo grupo' is a separate entry the caller
// opens in the existing creation screen. With an empty search the sheet lists
// `recent`, the peers of the loaded private conversations (newest first, at
// most 8), titled from the names cache. The sheet only reports the choice;
// the caller owns navigation (it pushes 'mensagem' for a person).

import { useContext } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { useMemberSearch } from '../useMemberSearch'
import { RECENT_MAX } from '../conversas'
import { UNNAMED, whoOf } from '../who'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { ErrorText, Soft } from '../ui'
import { Pill } from '../ui/Pill'
import { SearchField } from '../ui/SearchField'
import { Skeleton } from '../ui/States'
import { ScreenVisible } from '../ui/screenVisible'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { layout, radius, space, type } from '../ui/theme'

function Entry ({ icon, label, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <Pressable accessibilityRole='button' accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.entry, pressed && styles.pressed]}>
      <View style={styles.entryIcon}><Icon name={icon} size={22} color={colors.accentInk} /></View>
      <Text style={styles.entryLabel}>{label}</Text>
      <Icon name='seta' size={20} color={colors.soft} />
    </Pressable>
  )
}

// A person row, from a search hit or a recent conversation. `who` is whoOf
// output; the title never reads 'sem nome'.
function PersonRow ({ peer, who, picture, onPress }) {
  const styles = useStyles(makeStyles)
  const title = displayText(who.title === UNNAMED ? 'Pessoa' : who.title)
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={'mensagem para ' + title}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
    >
      <Avatar name={who.avatarName} publicKey={peer} size={40} picture={picture} persist={false} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
    </Pressable>
  )
}

function Body ({ onOpenThread, onNewCommunity, onNewGroup, recent, autoFocus }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const search = useMemberSearch({ request: node.request, hosted: node.hosted === true, online: node.online, ownKey })
  const hits = search.hits.filter((h) => h.author !== ownKey)
  const names = useNames()
  const profileOf = names ? names.profileOf : null
  const listed = search.phase === 'ready' || search.phase === 'loading'
  // A hit is a verified profile: teach the names cache first, so the thread
  // opens with the name instead of waiting for its own profile read.
  const openHit = (hit) => {
    if (names && typeof names.learn === 'function') names.learn(hit.author, { name: hit.name, username: hit.username })
    onOpenThread(hit.author)
  }
  const recentPeers = (Array.isArray(recent) ? recent : []).filter((peer) => typeof peer === 'string' && peer !== ownKey).slice(0, RECENT_MAX)
  return (
    <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
      <SearchField
        label='buscar pessoa'
        placeholder='Buscar pessoa pelo nome'
        value={search.query}
        onChangeText={(text) => search.setQuery(text)}
        autoFocus={autoFocus}
      />
      {search.query.trim() === ''
        ? (
          <View>
            {onNewGroup ? <Entry icon='conversas' label='Novo grupo' onPress={onNewGroup} /> : null}
            {onNewCommunity ? <Entry icon='gente' label='Nova comunidade' onPress={onNewCommunity} /> : null}
            {recentPeers.length > 0
              ? (
                <View style={styles.recent}>
                  <Text style={styles.heading} accessibilityRole='header'>Conversas recentes</Text>
                  {recentPeers.map((peer) => {
                    const profile = profileOf ? profileOf(peer) : null
                    return (
                      <PersonRow
                        key={peer}
                        peer={peer}
                        who={whoOf(profile ? { name: profile.name, username: profile.username } : {})}
                        picture={profile && profile.avatar ? profile.avatar : undefined}
                        onPress={() => onOpenThread(peer)}
                      />
                    )
                  })}
                </View>
                )
              : null}
          </View>
          )
        : (
          <View>
            {node.online === false || search.phase === 'offline' ? <Soft>A busca precisa de internet.</Soft> : null}
            {search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
            {search.phase === 'loading' && hits.length === 0 ? <Skeleton rows={2} /> : null}
            {hits.map((hit) => (
              <PersonRow
                key={hit.author}
                peer={hit.author}
                who={whoOf({ name: hit.name, username: hit.username })}
                onPress={() => openHit(hit)}
              />
            ))}
            {search.phase === 'ready' && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
            {search.phase === 'ready' && hits.length === 0 && search.unchecked > 0
              ? (
                <>
                  <Soft>Não deu para conferir todo mundo agora.</Soft>
                  <Pill label='Tentar de novo' onPress={() => search.retry()} />
                </>
                )
              : null}
            {search.phase === 'ready' && hits.length > 0 && search.unchecked > 0 ? <Soft>Algumas pessoas não puderam ser conferidas agora.</Soft> : null}
            {listed && search.complete === false ? <Soft>Ainda montando a lista; alguém pode faltar.</Soft> : null}
            {listed && search.more ? <Soft>Há mais gente com esse nome. Tente um nome mais específico.</Soft> : null}
            {search.phase === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
          </View>
          )}
    </ScrollView>
  )
}

export function NovaConversa ({ open, onClose, onOpenThread, onNewCommunity, onNewGroup, recent }) {
  // Read outside the Sheet, which marks its own body visible: the keyboard
  // comes up only while the screen under the sheet is the one in view, never
  // for a sheet left open on a hidden tab or under a covering layer.
  const seen = useContext(ScreenVisible)
  return (
    <Sheet open={open} onClose={onClose} title='Nova conversa'>
      <Body
        autoFocus={open === true && seen === true}
        recent={recent}
        onOpenThread={(peer) => { onClose(); onOpenThread(peer) }}
        onNewCommunity={onNewCommunity ? () => { onClose(); onNewCommunity() } : undefined}
        onNewGroup={onNewGroup ? () => { onClose(); onNewGroup() } : undefined}
      />
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  pressed: { opacity: 0.6 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit + space.sm },
  entryIcon: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  entryLabel: { ...type.postName, flex: 1, color: colors.ink },
  hit: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit + space.sm },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft },
  recent: { marginTop: space.sm },
  heading: { ...type.section, color: colors.soft, paddingVertical: space.sm }
})
