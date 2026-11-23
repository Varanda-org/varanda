import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText, isKey } from '@varanda/rpc'
import { STANDALONE_ROW_DOC, STANDALONE_ROW_LABEL, creatorCommunities, newGroupGate } from '../newGroup'
import { HelpNote } from '../ui/Help'
import { Soft, errorText } from '../ui'
import { Sheet } from '../ui/Sheet'
import { EmptyState, ErrorState, SkeletonRow } from '../ui/States'
import { useStyles } from '../ui/ThemeProvider'
import { layout, radius, space, type } from '../ui/theme'

export function NovoGrupoComunidade ({ open, onClose, request, onPick, onNewCommunity }) {
  const styles = useStyles(makeStyles)
  const [list, setList] = useState(null)
  const [checking, setChecking] = useState(null)
  const [reasons, setReasons] = useState({})
  const live = useRef(null)

  const load = useCallback(async (session) => {
    if (!session || session.loading) return
    session.loading = true
    setList(null)
    try {
      const res = await request('community.list')
      if (live.current !== session) return
      if (!Array.isArray(res?.communities)) throw new Error('Não foi possível listar as comunidades.')
      const rows = creatorCommunities(res.communities).filter((row) => isKey(row.community))
      setList({ rows, error: '' })
    } catch (err) {
      if (live.current === session) setList({ rows: [], error: errorText(err) })
    } finally {
      session.loading = false
    }
  }, [request])

  // Invalidate reads as soon as a close commits, including a switch to a Página.
  useLayoutEffect(() => {
    if (!open) return
    const session = { loading: false, checking: false }
    live.current = session
    setChecking(null)
    setReasons({})
    load(session)
    return () => { live.current = null }
  }, [open, load])

  const close = () => {
    live.current = null
    onClose()
  }

  const pick = async (community) => {
    const session = live.current
    if (!session || session.loading || session.checking) return
    session.checking = true
    setChecking(community)
    let gate
    let error
    try {
      gate = newGroupGate(await request('community.info', { community }))
    } catch (err) {
      error = errorText(err)
    }
    if (live.current !== session) return
    if (gate?.enabled) {
      live.current = null
      onPick(community)
      return
    }
    session.checking = false
    setChecking(null)
    setReasons((previous) => ({
      ...previous,
      [community]: gate?.reason || error || 'Não foi possível conferir a comunidade.'
    }))
  }

  // A group without community needs no community.info gate: anyone creates one.
  const pickStandalone = () => {
    const session = live.current
    if (!session || session.checking) return
    live.current = null
    onPick(null)
  }

  const standaloneRow = (
    <HelpNote key='standalone' doc={STANDALONE_ROW_DOC}>
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ disabled: checking !== null }}
        disabled={checking !== null}
        onPress={pickStandalone}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Text style={styles.name}>{STANDALONE_ROW_LABEL}</Text>
      </Pressable>
    </HelpNote>
  )

  let body
  if (list === null) {
    body = <View accessible accessibilityLabel='Carregando comunidades' accessibilityLiveRegion='polite'><SkeletonRow /></View>
  } else if (list.error) {
    body = <ErrorState message={list.error} onRetry={() => load(live.current)} />
  } else if (list.rows.length === 0) {
    body = (
      <View>
        <EmptyState
          icon='gente'
          title='Você ainda não criou uma comunidade.'
          actionLabel='Nova comunidade'
          onAction={() => { close(); onNewCommunity() }}
        />
      </View>
    )
  } else {
    body = list.rows.map(({ community, name }) => {
      const busy = checking === community
      const message = busy ? 'Conferindo comunidade…' : reasons[community]
      return (
        <View key={community}>
          <Pressable
            accessibilityRole='button'
            accessibilityState={{ disabled: checking !== null, busy }}
            disabled={checking !== null}
            onPress={() => pick(community)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={styles.name}>{typeof name === 'string' && name !== '' ? displayText(name) : 'Comunidade sem nome'}</Text>
          </Pressable>
          <View accessibilityLiveRegion='polite'>{message ? <Soft>{message}</Soft> : null}</View>
        </View>
      )
    })
  }

  return (
    <Sheet open={open} onClose={close} title='Novo grupo'>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>{standaloneRow}{body}</ScrollView>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { padding: space.lg, gap: space.sm },
  row: { minHeight: layout.hit, justifyContent: 'center', paddingVertical: space.sm, borderRadius: radius.sm },
  pressed: { opacity: 0.6 },
  name: { ...type.rowName, color: colors.ink }
})
