// Seguindo: follow.add, follow.remove, follow.list (offset paging). Rows show
// the avatar, the name (learned through the names cache) and the handle, with
// a "Seguindo" pill to unfollow. Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { useNames } from '../names'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { handleOf } from '../format'
import { ErrorText, Field, Mono, Notice, SectionHeader, Soft, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Pill } from '../ui/Pill'
import { colors, type } from '../ui/theme'

const PAGE = 50

// One followed diary. Tapping the name column shows the whole key.
function FollowRow ({ followKey, name, onRemove, pending, disabled }) {
  const [open, setOpen] = useState(false)
  const handle = displayText(handleOf(followKey))
  const named = typeof name === 'string' && name !== ''
  return (
    <View style={styles.row}>
      <Avatar name={named ? name : null} publicKey={followKey} size={44} />
      <Pressable
        style={styles.who}
        accessibilityRole='button'
        accessibilityLabel='mostrar a chave inteira'
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
      >
        {named
          ? (
            <>
              <Text style={styles.name} numberOfLines={1}>{displayText(name)}</Text>
              <Text style={styles.handle} numberOfLines={1}>{handle}</Text>
            </>
            )
          : <Text style={styles.name} numberOfLines={1}>{handle}</Text>}
        {open ? <Mono>{displayText(followKey)}</Mono> : null}
      </Pressable>
      <Pill
        label='Seguindo'
        onPress={() => onRemove(followKey)}
        pending={pending}
        disabled={disabled}
        accessibilityLabel={'deixar de seguir ' + handle}
      />
    </View>
  )
}

export default function Seguindo ({ active }) {
  const node = useNode()
  const names = useNames()
  const bottomPad = useBottomPad()
  const [keys, setKeys] = useState([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [localError, setLocalError] = useState('')
  // True while follow.list is re-read after a change: no new change until then.
  const [rereading, setRereading] = useState(false)
  // The key being removed: only its row shows "Seguindo…".
  const [removing, setRemoving] = useState(null)
  const [done, setDone] = useNotice()
  const add = useAction()
  const remove = useAction()
  const more = useAction()

  // Reads from the start; keeps at least as many entries as were shown.
  const reload = useCallback(async (want) => {
    try {
      const r = await node.request('follow.list', { offset: 0, limit: Math.min(FOLLOW_LIMIT_MAX, Math.max(PAGE, want)) })
      setKeys(r.follows)
      setTotal(r.total)
      setLoaded(true)
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request])

  // After any follow change (success or failure, uncertain included) the list
  // is re-read before the person can act again; the error text stays.
  const reread = async () => {
    setRereading(true)
    try {
      await reload(keys.length)
    } finally {
      setRereading(false)
    }
  }

  useEffect(() => { if (active) reload(PAGE) }, [active, reload])

  // Looks up the names of the keys not in the cache yet (one log.read at a
  // time, paused during a sync); rows re-render as names arrive.
  const { nameOf, resolve } = names
  useEffect(() => {
    for (const key of keys) {
      if (nameOf(key) === undefined) resolve(key)
    }
  }, [keys, nameOf, resolve])

  // A 64-hex key, or '@nome' on a hosted page: the account service names the
  // key, and the follow is still that key (follows stay keys).
  const doAdd = async () => {
    setDone('')
    const text = input.trim()
    const key = text.toLowerCase()
    let name = null
    if (!isKey(key)) {
      if (!text.startsWith('@')) return setLocalError('chave inválida (64 dígitos hexadecimais) ou @nome')
      if (!node.hosted) return setLocalError('siga pela chave nesta versão')
      name = isUsername(text)
      if (name === null) return setLocalError('nome inválido')
    }
    setLocalError('')
    const r = await add.run(async () => {
      let target = key
      if (name !== null) {
        const found = await lookupUsername(name)
        // Same-origin data, not a signature check: only a consistent answer.
        if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) throw new Error('nome não encontrado')
        target = found.member
      }
      return node.request('follow.add', { key: target })
    })
    if (r.ok) {
      setInput('')
      setDone(r.value.changed ? 'seguindo' : 'você já seguia esta chave')
    }
    await reread()
  }

  const doRemove = async (key) => {
    setDone('')
    setRemoving(key)
    try {
      const r = await remove.run(() => node.request('follow.remove', { key }))
      if (r.ok) setDone(r.value.changed ? 'deixou de seguir' : 'esta chave não estava na lista')
      await reread()
    } finally {
      setRemoving(null)
    }
  }

  const doMore = async () => {
    const r = await more.run(() => node.request('follow.list', { offset: keys.length, limit: PAGE }))
    if (r.ok) {
      setKeys((prev) => prev.concat(r.value.follows))
      setTotal(r.value.total)
    }
  }

  const changing = add.pending || remove.pending || rereading

  const header = (
    <View style={styles.header}>
      <Field
        placeholder={node.hosted ? 'chave pública do diário (64 dígitos hexadecimais) ou @nome' : 'chave pública do diário (64 dígitos hexadecimais)'}
        value={input}
        onChangeText={setInput}
        mono
        multiline
        lines={2}
      />
      <View style={styles.addRow}>
        <Pill label='Seguir' filled onPress={doAdd} pending={add.pending} disabled={input.trim() === '' || changing} />
      </View>
      <ErrorText>{localError || add.error}</ErrorText>
      <Notice>{done}</Notice>
      <ErrorText>{loadError || remove.error}</ErrorText>
    </View>
  )

  const footer = loaded && keys.length < total
    ? (
      <View style={styles.footer}>
        <ErrorText>{more.error}</ErrorText>
        <Pill label='mais' onPress={doMore} pending={more.pending} />
      </View>
      )
    : null

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={{ paddingBottom: bottomPad }}
      keyboardShouldPersistTaps='handled'
      data={keys}
      keyExtractor={(key) => key}
      ListHeaderComponent={
        <>
          {header}
          <SectionHeader right={loaded ? <Soft>{String(total) + (total === 1 ? ' diário' : ' diários')}</Soft> : null}>
            Seguindo
          </SectionHeader>
        </>
      }
      ListEmptyComponent={loaded && total === 0
        ? <View style={styles.empty}><Soft>Você ainda não segue ninguém.</Soft></View>
        : null}
      renderItem={({ item }) => (
        <FollowRow
          followKey={item}
          name={nameOf(item)}
          onRemove={doRemove}
          pending={removing === item}
          disabled={changing}
        />
      )}
      ListFooterComponent={footer}
    />
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  header: { paddingVertical: 12, paddingHorizontal: 16, gap: 8 },
  addRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  who: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  handle: { ...type.postMeta, color: colors.soft },
  empty: { paddingVertical: 16, paddingHorizontal: 16 },
  footer: { paddingVertical: 12, paddingHorizontal: 16, gap: 8, alignItems: 'center' }
})
