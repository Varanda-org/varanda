// Comunidade: one community (community.info, docs/rpc.md 5.59): its name,
// the groups linked two-way (each opens its group) and how many admins it
// has. The community creator also adds an admin (community.admin, 5.60) and
// links a group (community.link, 5.58). Hosted web only, like the Cadeiras
// tab. A mutation that comes back uncertain is never resent: the screen
// re-reads and only then lets the person try again.
// Props: community (hex64 root key), onBack(), onOpenGroup(group),
// onOpenMember(diary).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc, { isKey } from '@varanda/rpc'
import { useNode } from '../node'
import { isUsername, lookupUsername, usernameMatches } from '../account'
import { classifyFollowInput, PARTIAL_KEY_TEXT } from '../followInput'
import { communityLink } from '../groupLink'
import { canShare, copyText, shareUrl } from '../share'
import { shareNav } from '../shareNav'
import { fetchCommunity } from '../indexClient'
import { useMemberSearch } from '../useMemberSearch'
import { whoOf } from '../who'
import { shortKey } from '../format'
import { PRIVATE_LABEL, parseJoinLink, reconcile } from '../groups'
import { Btn, ErrorText, Field, SectionHeader, Soft, UNCERTAIN, colors, errorText, useAction, useBottomPad } from '../ui'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { EmptyState, ErrorState, Skeleton } from '../ui/States'
import { type } from '../ui/theme'
import { WEB_ONLY_MESSAGE } from './Cadeiras'

const { displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const NOT_FOUND = '@nome não encontrado.'

function origin () {
  return typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string' ? window.location.origin : ''
}

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

function GroupRow ({ title, detail, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={title}
      accessibilityHint='abre o grupo'
      onPress={onPress}
    >
      <View style={styles.icon}><Icon name='cadeira' size={24} color={colors.ink} /></View>
      <View style={styles.hitText}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={styles.handle} numberOfLines={1}>{detail}</Text> : null}
      </View>
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
  // Who the typed key or @nome resolved to, shown before the grant.
  const [candidate, setCandidate] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [localError, setLocalError] = useState('')
  const [shareNote, setShareNote] = useState('')
  // The seeder index's view, for someone whose node holds nothing of this
  // community yet: { status, name, groups, partial, error }.
  const [idx, setIdx] = useState({ status: 'idle', name: '', groups: [], partial: false, error: '' })
  const idxGen = useRef(0)
  const [granting, setGranting] = useState(null)
  const [adminUncertain, setAdminUncertain] = useState(false)
  const [linkInput, setLinkInput] = useState('')
  const [linkNote, setLinkNote] = useState('')
  // An uncertain link: { group, verdict } until reconciled.
  const [linkCheck, setLinkCheck] = useState(null)
  const admin = useAction()
  const resolveGen = useRef(0)
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

  const search = useMemberSearch({ request: node.request, hosted, online: node.online !== false, ownKey })

  const needIndex = hosted && ((info !== null && info.state === 'pending') || (info === null && loadError !== ''))
  const loadIndex = useCallback(async () => {
    const mine = ++idxGen.current
    setIdx((s) => ({ ...s, status: 'loading', error: '' }))
    const res = await fetchCommunity(community)
    if (mine !== idxGen.current) return
    if (!res || !res.ok) {
      setIdx({ status: 'error', name: '', groups: [], partial: false, error: res && res.reason === 'not-found' ? 'O servidor ainda não conhece esta comunidade.' : 'Não foi possível consultar o índice agora.' })
      return
    }
    const v = res.value
    setIdx({ status: 'done', name: v.name, groups: v.groups, partial: v.indexing === true || v.complete === false, error: '' })
  }, [community])
  useEffect(() => {
    if (!needIndex) {
      idxGen.current++
      return
    }
    loadIndex()
  }, [needIndex, loadIndex])

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
  const title = info && typeof info.name === 'string' && info.name !== ''
    ? displayText(info.name)
    : (idx.status === 'done' && needIndex && idx.name !== '' ? displayText(idx.name) : 'Comunidade')
  const groups = info && Array.isArray(info.groups) ? info.groups : []

  const cls = classifyFollowInput(adminInput)
  const searchable = cls.kind === 'name' || cls.kind === 'handle'
  const hits = search.hits.filter((h) => h.author !== ownKey)

  const typeAdmin = (t) => {
    setAdminInput(t)
    setAdminUncertain(false)
    setAdminNote('')
    setCandidate(null)
    setLocalError('')
    resolveGen.current++
    setResolving(false)
    admin.clearError()
    const c = classifyFollowInput(t)
    search.setQuery(c.kind === 'name' || c.kind === 'handle' ? t : '')
  }

  // A key or @nome becomes a candidate first; the grant waits for a tap.
  const findPerson = async () => {
    setLocalError('')
    setAdminNote('')
    if (cls.kind === 'key') return setCandidate({ member: cls.key, label: shortKey(cls.key) })
    if (cls.kind !== 'handle') return
    const name = isUsername(cls.handle)
    if (name === null) return setLocalError('@nome inválido')
    const mine = ++resolveGen.current
    setResolving(true)
    try {
      const found = await lookupUsername(name)
      if (mine !== resolveGen.current) return
      // Same-origin data, not a signature check: only a consistent answer.
      if (found === null || !isKey(found.member) || !usernameMatches(found.usernameRecord, found.member, name)) {
        setLocalError(NOT_FOUND)
      } else {
        setCandidate({ member: found.member, label: '@' + displayText(name) })
      }
    } catch (err) {
      if (mine === resolveGen.current) setLocalError(errorText(err))
    } finally {
      if (mine === resolveGen.current) setResolving(false)
    }
  }

  const grant = async (member, label) => {
    if (!HEX64.test(member) || offline || adminUncertain) return
    setAdminNote('')
    setGranting(member)
    try {
      const res = await admin.run(() => node.request('community.admin', { community, member, on: true }))
      if (res.ok) {
        setAdminInput('')
        setCandidate(null)
        search.clear()
        setAdminNote(label + ' agora é administrador.')
        load()
        return
      }
      if (res.uncertain) {
        // The count alone cannot tell whether this grant landed: re-read and
        // leave a new attempt to the person.
        setAdminUncertain(true)
        load()
      }
    } finally {
      setGranting(null)
    }
  }

  // The system share sheet when there is one, else a copy. The link is never
  // shown as text.
  const shareCommunity = async () => {
    const path = communityLink(community)
    if (path === null) return
    const url = origin() + path
    const nav = shareNav()
    setShareNote('')
    if (canShare(nav) && (await shareUrl(nav, { url, title: title === 'Comunidade' ? 'Varanda' : title })) !== 'failed') return
    setShareNote((await copyText(nav, url)) ? 'Link copiado.' : 'Não foi possível copiar o link.')
  }

  const linkKey = keyOf(linkInput)
  const recheckLink = async (group) => {
    try {
      const view = await node.request('group.info', { group })
      const verdict = reconcile({ action: 'link', community, on: true }, { info: view })
      setLinkCheck(verdict === 'landed' ? null : { group, verdict })
      if (verdict === 'landed') {
        setLinkInput('')
        setLinkNote('Grupo vinculado.')
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
        ? 'Grupo vinculado.'
        : 'Vínculo pedido. O grupo aparece aqui quando quem o criou também vincular esta comunidade.')
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
  const fromIndex = needIndex && idx.status === 'done'
  if (fromIndex) {
    body = (
      <View>
        <View style={styles.block}>
          <Soft>Pelo índice do servidor; abra um grupo para entrar.</Soft>
          {idx.partial ? <Soft>O índice ainda está sendo atualizado; a lista pode estar incompleta.</Soft> : null}
          <View style={styles.inline}>
            <Btn label='Compartilhar' onPress={shareCommunity} secondary />
          </View>
          {shareNote ? <Soft>{shareNote}</Soft> : null}
        </View>
        <SectionHeader>Grupos</SectionHeader>
        {idx.groups.length === 0
          ? <View style={styles.block}><Soft>Nenhum grupo vinculado ainda.</Soft></View>
          : idx.groups.map((g) => (
            <GroupRow
              key={g.group}
              title={typeof g.name === 'string' ? displayText(g.name) : PRIVATE_LABEL}
              detail={Number.isSafeInteger(g.writerCount) ? (g.writerCount === 1 ? '1 membro' : g.writerCount + ' membros') : 'grupo privado'}
              onPress={() => { if (typeof onOpenGroup === 'function') onOpenGroup(g.group) }}
            />
          ))}
      </View>
    )
  } else if (info === null && loadError && idx.status === 'loading') {
    body = <Skeleton />
  } else if (info === null && loadError) {
    body = <ErrorState message={idx.status === 'error' ? idx.error : loadError} onRetry={() => { load(); loadIndex() }} pending={loading} />
  } else if (info === null) {
    body = <Skeleton />
  } else {
    body = (
      <View>
        <View style={styles.block}>
          {info.admins > 0 ? <Soft>{adminsLabel(info.admins)}</Soft> : null}
          <View style={styles.inline}>
            <Btn label='Compartilhar' onPress={shareCommunity} secondary />
          </View>
          {shareNote ? <Soft>{shareNote}</Soft> : null}
          {pending ? <Soft>Aguardando a sincronização desta comunidade.</Soft> : null}
          {!pending && info.incomplete === true ? <Soft>Alguns grupos ainda não chegaram a este aparelho; a lista pode estar incompleta.</Soft> : null}
          {loadError ? <ErrorText>{loadError}</ErrorText> : null}
        </View>
        <SectionHeader>Grupos</SectionHeader>
        {groups.length === 0
          ? <View style={styles.block}><Soft>Nenhum grupo vinculado ainda.</Soft></View>
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
                  label='Vincular um grupo'
                  value={linkInput}
                  onChangeText={(t) => { setLinkInput(t); setLinkCheck(null); setLinkNote(''); link.clearError() }}
                  placeholder='/g/…'
                  mono
                />
                <Soft>O vínculo vale quando os dois lados aceitam: a comunidade e o grupo.</Soft>
                {linkStatus}
                {linkNote ? <Soft>{linkNote}</Soft> : null}
                <Btn label='Vincular' onPress={doLink} disabled={!linkKey || offline || linkCheck !== null} pending={link.pending} />
              </View>
              <View style={styles.block}>
                <Field
                  label='Adicionar administrador'
                  placeholder='nome, @nome ou código'
                  value={adminInput}
                  onChangeText={typeAdmin}
                  maxLength={80}
                  mono
                />
                <Soft>Administradores da comunidade podem banir, admitir e ocultar nos grupos vinculados.</Soft>
                {cls.kind === 'partial-key' ? <Soft>{PARTIAL_KEY_TEXT}</Soft> : null}
                {cls.kind === 'key' || cls.kind === 'handle'
                  ? <Btn label={cls.kind === 'key' ? 'Conferir pessoa' : 'Procurar @nome'} onPress={findPerson} pending={resolving} disabled={offline || adminUncertain} secondary />
                  : null}
                {candidate
                  ? (
                    <View style={styles.inline}>
                      <Text style={styles.name} numberOfLines={1}>{candidate.label}</Text>
                      <Btn label='Tornar administrador' onPress={() => grant(candidate.member, candidate.label)} pending={admin.pending && granting === candidate.member} disabled={offline || adminUncertain} />
                    </View>
                    )
                  : null}
                {localError ? <ErrorText>{localError}</ErrorText> : null}
                {searchable && (offline || search.phase === 'offline') ? <Soft>A busca precisa de internet.</Soft> : null}
                {searchable && search.phase === 'short' ? <Soft>Digite pelo menos 2 letras.</Soft> : null}
                {searchable && search.phase === 'error' ? <ErrorText>{search.error}</ErrorText> : null}
                {search.phase === 'loading' && hits.length === 0 ? <Skeleton rows={2} /> : null}
                {hits.map((hit) => {
                  const who = whoOf({ name: hit.name, username: hit.username })
                  const label = displayText(who.title)
                  return (
                    <View key={hit.author} style={styles.hit}>
                      <Pressable
                        style={({ pressed }) => [styles.hitWho, pressed && styles.pressed]}
                        accessibilityRole='link'
                        accessibilityLabel={'ver o perfil de ' + label}
                        disabled={typeof onOpenMember !== 'function'}
                        onPress={() => onOpenMember(hit.author, { name: hit.name, username: hit.username })}
                      >
                        <Avatar name={who.avatarName} publicKey={hit.author} size={44} />
                        <View style={styles.hitText}>
                          <Text style={styles.name} numberOfLines={1}>{label}</Text>
                          {who.subtitle ? <Text style={styles.handle} numberOfLines={1}>{displayText(who.subtitle)}</Text> : null}
                        </View>
                      </Pressable>
                      <Pill label='Tornar administrador' onPress={() => grant(hit.author, label)} pending={admin.pending && granting === hit.author} disabled={offline || adminUncertain || admin.pending} />
                    </View>
                  )
                })}
                {search.phase === 'ready' && hits.length === 0 && search.unchecked === 0 ? <Soft>Ninguém encontrado com esse nome.</Soft> : null}
                {adminUncertain ? <ErrorText>{UNCERTAIN}</ErrorText> : <ErrorText>{admin.error}</ErrorText>}
                {adminNote ? <Soft>{adminNote}</Soft> : null}
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
  name: { ...type.postName, color: colors.ink, flex: 1 },
  handle: { ...type.postMeta, color: colors.soft },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hitWho: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  hitText: { flex: 1 }
})
