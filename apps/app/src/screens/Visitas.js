// Visitas (entry { screen: 'visitas' }): who passed by the own profile,
// grouped by day, newest first. Hosted nodes only. Every listed person had
// their own switch on (mutual): there is no anonymous visit and no count
// badge anywhere. The list is the node's own; names and avatars come from the
// profiles cache like other member lists. The switch itself lives in Ajustes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNames } from '../names'
import { useNode } from '../node'
import { NOT_HOSTED } from '../pessoas'
import { DMS_OFF_NOTICE } from '../visits'
import { whoOf } from '../who'
import { EMPTY_BODY, EMPTY_TITLE, LOAD_FAILED, OFF_BODY, OFF_TITLE, VISITAS_TITLE, rowsOf, viewOf } from '../visitasView'
import { Soft, useBottomPad, useNow } from '../ui'
import { Avatar } from '../ui/Avatar'
import { OfflineNote } from '../ui/OfflineNote'
import { RefreshableList } from '../ui/RefreshableList'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { layout, space, type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

function VisitRow ({ keyHex, profile, onOpen }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  return (
    <Pressable
      accessibilityRole='link'
      accessibilityLabel={'ver o perfil de ' + title}
      onPress={() => onOpen(keyHex, profile)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar name={who.avatarName} publicKey={keyHex} size={44} picture={(profile || {}).avatar} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
      </View>
    </Pressable>
  )
}

export default function Visitas ({ active = true, onBack, onOpenMember }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const names = useNames()
  const { profileOf, resolveMany } = names
  const bottom = useBottomPad()
  const now = useNow(60000)
  const [data, setData] = useState({ list: null, state: null, failed: false, dmsOff: false })

  const load = useCallback(async () => {
    try {
      const [state, list] = await Promise.all([requestRef.current('visits.state', {}), requestRef.current('visits.list', {})])
      setData({ list, state, failed: false, dmsOff: false })
      resolveMany(rowsOf(list).map((r) => r.key))
    } catch (err) {
      // The node refuses Visitas without private messages (visits.set);
      // only that answer shows the notice.
      const dmsOff = err !== null && typeof err === 'object' && err.message === DMS_OFF_NOTICE
      setData((d) => ({ ...d, failed: true, dmsOff }))
    }
  }, [resolveMany])

  useEffect(() => {
    if (hosted && active) load()
  }, [hosted, active, load])

  const view = useMemo(() => viewOf({ list: data.list, state: data.state, now, dmsOn: !data.dmsOff }), [data.list, data.state, now, data.dmsOff])
  const items = useMemo(() => view.groups.flatMap((g) => [{ id: 'h' + g.key, header: g.label }, ...g.rows.map((r) => ({ id: g.key + ':' + r.key, row: r }))]), [view.groups])

  if (!hosted) {
    return (
      <View style={styles.screen}>
        <TopBar title={VISITAS_TITLE} onBack={onBack} />
        <EmptyState icon='olho' title={VISITAS_TITLE} body={NOT_HOSTED} />
      </View>
    )
  }

  const loading = data.state === null && !data.failed
  let header = null
  if (view.notices.length > 0) header = <View style={styles.notices}>{view.notices.map((n) => <Soft key={n}>{n}</Soft>)}</View>

  let empty = null
  if (loading) empty = <Skeleton />
  else if (data.failed && data.state === null) empty = <ErrorState message={LOAD_FAILED} onRetry={load} />
  else if (view.off) empty = <EmptyState icon='olho' title={OFF_TITLE} body={OFF_BODY} />
  else if (view.empty) empty = <EmptyState icon='olho' title={EMPTY_TITLE} body={EMPTY_BODY} />

  return (
    <View style={styles.screen}>
      <TopBar title={VISITAS_TITLE} onBack={onBack} />
      <RefreshableList
        data={empty ? [] : items}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={<View><OfflineNote />{header}</View>}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: bottom }}
        onRefresh={load}
        renderItem={({ item }) => item.header
          ? <Text style={styles.day} accessibilityRole='header'>{item.header}</Text>
          : <VisitRow keyHex={item.row.key} profile={profileOf(item.row.key)} onOpen={onOpenMember} />}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  notices: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  day: { ...type.section, color: colors.soft, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.hit, paddingVertical: space.sm, paddingHorizontal: space.lg },
  pressed: { opacity: 0.6 },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.rowName, color: colors.ink },
  handle: { ...type.caption, color: colors.soft }
})
