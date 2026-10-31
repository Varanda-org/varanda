// Comunidade: one community (community.info, docs/rpc.md 5.59): its name,
// the groups linked two-way (each opens its Cadeira) and how many admins it
// has. The community creator also adds an admin (community.admin, 5.60) and
// links a group (community.link, 5.58). Hosted web only, like the Cadeiras
// tab. A mutation that comes back uncertain is never resent: the screen
// re-reads and only then lets the person try again.
// Props: community (hex64 root key), onBack(), onOpenGroup(group),
// onOpenMember(diary).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { PRIVATE_LABEL, parseJoinLink, reconcile } from '../groups'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, colors, errorText, useAction, useBottomPad } from '../ui'
import { Icon } from '../ui/Icon'
import { TopBar } from '../ui/TopBar'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { WEB_ONLY_MESSAGE } from './Cadeiras'

const { displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/

function keyOf (text) {
  const fromLink = parseJoinLink(text)
  if (fromLink) return fromLink
  const t = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return HEX64.test(t) ? t : null
}

function adminsLabel (n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return n === 1 ? '1 administrador' : n + ' administradores'
}

function GroupRow ({ title, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title}
      accessibilityHint='abre a cadeira'
      onPress={onPress}
    >
      <View style={styles.icon}><Icon name='cadeira' size={24} color={colors.ink} /></View>
      <Text style={styles.name} numberOfLines={1}>{title}</Text>
    </Pressable>
  )
}

export function Comunidade ({ community, onBack, onOpenGroup, onOpenMember }) {
  const node = useNode()
  const hosted = node.hosted === true
  const bottomPad = useBottomPad()
  const [info, setInfo] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [ownKey, setOwnKey] = useState(null)
  const [adminInput, setAdminInput] = useState('')
  const [adminNote, setAdminNote] = useState('')
  const [adminUncertain, setAdminUncertain] = useState(false)
  const [linkInput, setLinkInput] = useState('')
  const [linkNote, setLinkNote] = useState('')
  // An uncertain link: { group, verdict } until reconciled.
  const [linkCheck, setLinkCheck] = useState(null)
  const admin = useAction()
  const link = useAction()
  const gen = useRef(0)
  const requestRef = useRef(node.request)
  requestRef.current = node.request

  const load = useCallback(async () => {
    const mine = ++gen.current
    setLoading(true)
    setLoadError('')
    try {
      const res = await requestRef.current('community.info', { community })
      if (mine !== gen.current) return
      setInfo(res && typeof res === 'object' ? res : null)
    } catch (err) {
      if (mine !== gen.current) return
      setLoadError(errorText(err))
    } finally {
      if (mine === gen.current) setLoading(false)
    }
  }, [community])

  useEffect(() => {
    if (!hosted) return
    load()
    requestRef.current('node.info', {}).then((i) => {
      setOwnKey(i && typeof i.publicKey === 'string' ? i.publicKey : null)
    }).catch(() => {})
  }, [hosted, load])

  // groups.changed also names communities: a pending or incomplete answer
  // fills in when the data arrives.
  const version = node.getGroupVersion(community)
  const lastVersion = useRef(version)
  useEffect(() => {
    if (!hosted || version === lastVersion.current) return
    lastVersion.current = version
    load()
  }, [hosted, version, load])

  if (!hosted) {
    return (
      <View style={styles.root}>
        <TopBar title='Comunidade' onBack={onBack} />
        <EmptyState icon='cadeira' title='Só na versão web' body={WEB_ONLY_MESSAGE} />
      </View>
    )
  }

  const offline = node.online === false
  const creator = info !== null && typeof ownKey === 'string' && info.creator === ownKey
  const pending = info !== null && info.state === 'pending'
  const title = info && typeof info.name === 'string' && info.name !== '' ? displayText(info.name) : 'Comunidade'
  const groups = info && Array.isArray(info.groups) ? info.groups : []

  // A member key, never a group link.
  const adminKey = HEX64.test(adminInput.trim().toLowerCase()) ? adminInput.trim().toLowerCase() : null
  const addAdmin = async () => {
    if (!adminKey || offline || adminUncertain) return
    setAdminNote('')
    const res = await admin.run(() => node.request('community.admin', { community, member: adminKey, on: true }))
    if (res.ok) {
      setAdminInput('')
      setAdminNote('Administrador adicionado.')
      load()
      return
    }
    if (res.uncertain) {
      // The count alone cannot tell whether this grant landed: re-read and
      // leave a new attempt to the person.
      setAdminUncertain(true)
      load()
    }
  }

  const linkKey = keyOf(linkInput)
  const recheckLink = async (group) => {
    try {
      const view = await node.request('group.info', { group })
      const verdict = reconcile({ action: 'link', community, on: true }, { info: view })
      setLinkCheck(verdict === 'landed' ? null : { group, verdict })
      if (verdict === 'landed') {
        setLinkInput('')
        setLinkNote('Cadeira vinculada.')
      }
    } catch {
      setLinkCheck({ group, verdict: 'unknown' })
    }
    load()
  }

  const doLink = async () => {
    const group = linkKey
    if (!group || offline) return
    setLinkNote('')
    setLinkCheck(null)
    const res = await link.run(() => node.request('community.link', { community, group, on: true }))
    if (res.ok) {
      const sides = res.value && Array.isArray(res.value.sides) ? res.value.sides : []
      setLinkInput('')
      setLinkNote(sides.includes('group')
        ? 'Cadeira vinculada.'
        : 'Vínculo pedido. A cadeira aparece aqui quando a criadora dela também vincular esta comunidade.')
      load()
      return
    }
    if (res.uncertain) await recheckLink(group)
  }

  let linkStatus = null
  if (linkCheck && linkCheck.verdict === 'not-landed') {
    linkStatus = (
      <View style={styles.inline}>
        <ErrorText>O vínculo não foi registrado.</ErrorText>
        <Btn label='tentar de novo' onPress={doLink} pending={link.pending} disabled={offline} secondary />
      </View>
    )
  } else if (linkCheck) {
    linkStatus = (
      <View style={styles.inline}>
        <ErrorText>{UNCERTAIN}</ErrorText>
        <Btn label='conferir' onPress={() => recheckLink(linkCheck.group)} secondary />
      </View>
    )
  } else if (link.error) {
    linkStatus = <ErrorText>{link.error}</ErrorText>
  }

  let body
  if (info === null && loadError) {
    body = <ErrorState message={loadError} onRetry={load} pending={loading} />
  } else if (info === null) {
    body = <Skeleton />
  } else {
    body = (
      <View>
        <View style={styles.block}>
          {info.admins > 0 ? <Soft>{adminsLabel(info.admins)}</Soft> : null}
          {pending ? <Soft>Aguardando a sincronização desta comunidade.</Soft> : null}
          {!pending && info.incomplete === true ? <Soft>Algumas cadeiras ainda não chegaram a este aparelho; a lista pode estar incompleta.</Soft> : null}
          {loadError ? <ErrorText>{loadError}</ErrorText> : null}
        </View>
        <SectionHeader>Cadeiras</SectionHeader>
        {groups.length === 0
          ? <View style={styles.block}><Soft>Nenhuma cadeira vinculada ainda.</Soft></View>
          : groups.map((g) => (
            <GroupRow
              key={g.group}
              title={typeof g.name === 'string' && g.name !== '' ? displayText(g.name) : PRIVATE_LABEL}
              onPress={() => { if (typeof onOpenGroup === 'function') onOpenGroup(g.group) }}
            />
          ))}
        {creator
          ? (
            <View>
              <SectionHeader>Administração</SectionHeader>
              <View style={styles.block}>
                <Field
                  label='Vincular uma cadeira'
                  value={linkInput}
                  onChangeText={(t) => { setLinkInput(t); setLinkCheck(null); setLinkNote(''); link.clearError() }}
                  placeholder='/g/…'
                  mono
                />
                <Soft>O vínculo vale quando os dois lados aceitam: a comunidade e a cadeira.</Soft>
                {linkStatus}
                {linkNote ? <Soft>{linkNote}</Soft> : null}
                <Btn label='Vincular' onPress={doLink} disabled={!linkKey || offline || linkCheck !== null} pending={link.pending} />
              </View>
              <View style={styles.block}>
                <Field
                  label='Adicionar administrador (chave da pessoa)'
                  value={adminInput}
                  onChangeText={(t) => { setAdminInput(t); setAdminUncertain(false); setAdminNote(''); admin.clearError() }}
                  mono
                />
                <Soft>Administradores da comunidade podem banir, admitir e ocultar nas cadeiras vinculadas.</Soft>
                {adminUncertain ? <ErrorText>{UNCERTAIN}</ErrorText> : <ErrorText>{admin.error}</ErrorText>}
                {adminNote ? <Soft>{adminNote}</Soft> : null}
                <Btn label='Adicionar' onPress={addAdmin} disabled={!adminKey || offline || adminUncertain} pending={admin.pending} />
              </View>
              {offline ? <View style={styles.block}><Soft>Sem internet: conecte-se para alterar a comunidade.</Soft></View> : null}
            </View>
            )
          : null}
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <TopBar title={title} subtitle='Comunidade' onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        keyboardShouldPersistTaps='handled'
        refreshControl={<RefreshControl refreshing={loading && info !== null} onRefresh={load} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {body}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  block: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  pressed: { opacity: 0.6 },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  name: { ...type.postName, color: colors.ink, flex: 1 }
})
