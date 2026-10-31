// CadeiraAjustes: the administration sheet of one Cadeira, opened from
// Cadeira. Props: { group, visible, onClose, onLeft(), onOpenMember(diary),
// onOpenCommunity(community) }. Sections by role (groups.js can): the join
// link, Nome (creator only, group.meta), Membros (paged), Pedidos (admit or refuse), Administradores (creator
// only grants or revokes), Banidos, the community link (creator only), Gerar
// nova chave (private groups) and Sair da cadeira, with a confirm that says a
// group with approval needs a new approval to come back. Names come from the
// node's rows through displayText; a key is only ever an 8-hex short key,
// except the /g/<hex> link the person copies on purpose. A mutation answered
// UNCERTAIN is never resent: the sheet re-reads and asks reconcile first.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { MAX_GROUP_NAME, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars, shortKey } from '../format'
import { can, joinLink, reconcile, roleOf } from '../groups'
import { Btn, ErrorText, Field, Label, Mono, Notice, SectionHeader, Soft, colors, errorText, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { Skeleton } from '../ui/States'
import { type } from '../ui/theme'

const PAGE = 100
const HEX64 = /^[0-9a-f]{64}$/
const CHECK_UNKNOWN = 'Não deu para confirmar se isso foi aplicado. Confira antes de tentar de novo.'
const CHECK_NOT_LANDED = 'Não foi aplicado. Você pode tentar de novo.'
const LEAVE_PRIVATE = 'Ao sair de uma cadeira privada, você deixa de receber as novas mensagens. Para voltar, um administrador precisa aprovar você de novo.'
const LEAVE_APPROVAL = 'Esta cadeira tem entrada com aprovação: para voltar, um administrador precisa aprovar você de novo.'
const LEAVE_OPEN = 'Você pode voltar quando quiser pelo link da cadeira.'

function nameOf (row) {
  const n = typeof row.name === 'string' ? displayText(row.name).trim() : ''
  if (n) return n
  const u = typeof row.username === 'string' ? displayText(row.username).trim() : ''
  if (u) return '@' + u
  return shortKey(row.member || '')
}

function origin () {
  return typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string' ? window.location.origin : ''
}

function PersonRow ({ row, label, onOpenMember, children }) {
  const name = nameOf(row)
  return (
    <View style={styles.person}>
      <View style={styles.personText}>
        {typeof onOpenMember === 'function'
          ? <Text style={styles.name} accessibilityRole='link' accessibilityLabel={name + ', ver perfil'} onPress={() => onOpenMember(row.member)} numberOfLines={1}>{name}</Text>
          : <Text style={styles.name} numberOfLines={1}>{name}</Text>}
        {label ? <Text style={styles.meta}>{label}</Text> : null}
      </View>
      <View style={styles.inline}>{children}</View>
    </View>
  )
}

export function CadeiraAjustes ({ group, visible, onClose, onLeft, onOpenMember, onOpenCommunity }) {
  const node = useNode()
  const { request } = node
  const ownKey = node.passkey && node.passkey.status ? node.passkey.status.publicKey : null
  const version = node.getGroupVersion(group)
  const [info, setInfo] = useState(null)
  const [members, setMembers] = useState({ rows: [], total: 0 })
  const [requests, setRequests] = useState({ rows: [], total: 0 })
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [check, setCheck] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [communityKey, setCommunityKey] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const act = useAction()
  const more = useAction()
  const seqRef = useRef(0)

  const role = roleOf(info, ownKey)
  const isPrivate = info !== null && info.visibility === 'private'
  const staff = can('admit', role)

  const load = useCallback(async () => {
    const mine = ++seqRef.current
    setLoading(true)
    setLoadError('')
    try {
      const value = await request('group.info', { group })
      if (mine !== seqRef.current) return
      setInfo(value)
      const m = await request('group.members', { group, offset: 0, limit: PAGE })
      if (mine !== seqRef.current) return
      setMembers({ rows: Array.isArray(m.members) ? m.members : [], total: m.total || 0 })
      if (can('admit', roleOf(value, ownKey))) {
        const q = await request('group.requests', { group, offset: 0, limit: PAGE })
        if (mine !== seqRef.current) return
        setRequests({ rows: Array.isArray(q.requests) ? q.requests : [], total: q.total || 0 })
      } else {
        setRequests({ rows: [], total: 0 })
      }
    } catch (err) {
      if (mine === seqRef.current) setLoadError(errorText(err))
    } finally {
      if (mine === seqRef.current) setLoading(false)
    }
  }, [request, group, ownKey])

  useEffect(() => {
    if (!visible) {
      setConfirm(null)
      setCheck(null)
      return
    }
    load()
  }, [visible, version, load])

  useEffect(() => () => { seqRef.current += 1 }, [])

  // App's web Escape handler pops the screen stack unless the event was
  // handled: while this sheet is open, Escape closes only the sheet.
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (typeof onClose === 'function') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  const loadMore = async (kind) => {
    const current = kind === 'members' ? members : requests
    const r = await more.run(() => request(kind === 'members' ? 'group.members' : 'group.requests', { group, offset: current.rows.length, limit: PAGE }))
    if (!r.ok) return
    const rows = kind === 'members' ? r.value.members : r.value.requests
    const next = { rows: current.rows.concat(Array.isArray(rows) ? rows : []), total: r.value.total || 0 }
    if (kind === 'members') setMembers(next)
    else setRequests(next)
  }

  // Re-reads what an uncertain change touched and asks reconcile.
  const verify = async (change) => {
    try {
      if (change.action === 'leave') {
        const value = await request('group.info', { group })
        setInfo(value)
        return reconcile(change, { state: value.state })
      }
      if (change.action === 'meta') {
        const value = await request('group.info', { group })
        setInfo(value)
        return reconcile(change, { info: value })
      }
      if (change.action === 'link') {
        const value = await request('group.info', { group })
        setInfo(value)
        return reconcile(change, { info: value })
      }
      if (change.action === 'rekey') {
        return reconcile(change, await request('group.read', { group }))
      }
      const m = await request('group.members', { group, offset: 0, limit: PAGE })
      const rows = Array.isArray(m.members) ? m.members : []
      setMembers({ rows, total: m.total || 0 })
      const found = rows.some((r) => r && r.member === change.member)
      if (!found && Number.isSafeInteger(m.total) && m.total > rows.length) return 'unknown'
      const view = { members: rows }
      if (change.action === 'admit') {
        const q = await request('group.requests', { group, offset: 0, limit: PAGE })
        const reqs = Array.isArray(q.requests) ? q.requests : []
        setRequests({ rows: reqs, total: q.total || 0 })
        if (change.on && reqs.some((r) => r && r.member === change.member)) return 'not-landed'
        // The writer an admission covers is not known here: never a blind "landed".
        view.requests = reqs
        view.writers = []
      }
      return reconcile(change, view)
    } catch {
      return 'unknown'
    }
  }

  const settle = async (change, retry) => {
    const verdict = await verify(change)
    if (verdict === 'landed') {
      setCheck(null)
      if (change.action === 'meta') setNameDraft('')
      if (change.action === 'leave' && typeof onLeft === 'function') onLeft()
      return
    }
    setCheck({ change, verdict, retry })
  }

  const mutate = async (method, params, change) => {
    setCheck(null)
    setConfirm(null)
    const r = await act.run(() => request(method, params))
    if (r.ok) {
      if (change.action === 'meta') setNameDraft('')
      if (change.action === 'leave') {
        if (typeof onLeft === 'function') onLeft()
        return
      }
      load()
    } else if (r.uncertain) {
      settle(change, () => mutate(method, params, change))
    }
  }

  const admit = (member, on) => mutate('group.admit', { group, member, on }, { action: 'admit', member, on })
  const ban = (member, on) => mutate('group.ban', { group, member, on }, { action: 'ban', member, on })
  const admin = (member, on) => mutate('group.admin', { group, member, on }, { action: 'admin', member, on })
  const leave = () => mutate('group.leave', { group }, { action: 'leave' })
  const rename = (name) => mutate('group.meta', { group, name }, { action: 'meta', name })
  const link = (community, on) => mutate('community.link', { community, group, on }, { action: 'link', community, on })
  const rekey = async () => {
    let epoch = null
    try {
      epoch = (await request('group.read', { group, limit: 1 })).epoch || null
    } catch {}
    // A failed pre-read leaves epoch null: reconcile then answers 'unknown'
    // for an uncertain rekey, so the sheet offers "conferir", never success.
    mutate('group.rekey', { group }, { action: 'rekey', epoch })
  }

  const creator = info ? info.creator : null
  const isOwn = (m) => typeof ownKey === 'string' && m === ownKey
  const live = members.rows.filter((m) => m && m.banned !== true)
  const admins = live.filter((m) => m.admin === true || m.member === creator)
  const banned = members.rows.filter((m) => m && m.banned === true)
  const communities = info && Array.isArray(info.communities) ? info.communities : []
  const link0 = joinLink(group)
  const typedKey = communityKey.trim().toLowerCase()
  const newName = nameDraft.trim()
  const nameOk = newName !== '' && countChars(newName) <= MAX_GROUP_NAME && newName !== info?.name

  // On the web the sheet's Modal is a portal that would stay over the
  // destination: close it before navigating.
  const close = () => { if (typeof onClose === 'function') onClose() }
  const openMember = typeof onOpenMember === 'function' ? (diary) => { close(); onOpenMember(diary) } : undefined
  const openCommunity = typeof onOpenCommunity === 'function' ? (community) => { close(); onOpenCommunity(community) } : undefined

  const confirmBox = confirm
    ? (
      <View style={styles.box}>
        <Soft>{confirm.text}</Soft>
        <View style={styles.inline}>
          <Btn label={confirm.label} danger onPress={() => confirm.run()} pending={act.pending} />
          <Btn label='Cancelar' secondary onPress={() => setConfirm(null)} />
        </View>
      </View>
      )
    : null

  const checkBox = check
    ? (
      <View style={styles.box}>
        <Notice>{check.verdict === 'not-landed' ? CHECK_NOT_LANDED : CHECK_UNKNOWN}</Notice>
        <View style={styles.inline}>
          {check.verdict === 'not-landed'
            ? <Pill label='tentar de novo' onPress={() => { setCheck(null); check.retry() }} />
            : <Pill label='conferir' onPress={() => settle(check.change, check.retry)} />}
          <Pill label='dispensar' onPress={() => setCheck(null)} />
        </View>
      </View>
      )
    : null

  const memberActions = (m) => {
    if (m.member === creator || isOwn(m.member)) return null
    return (
      <>
        {can('admin', role) ? <Pill label={m.admin ? 'tirar admin' : 'tornar admin'} onPress={() => admin(m.member, !m.admin)} pending={act.pending} /> : null}
        {staff && !m.admin
          ? <Pill label='banir' danger pending={act.pending} onPress={() => setConfirm({ text: 'Banir ' + nameOf(m) + ' desta cadeira?', label: 'Banir', run: () => ban(m.member, true) })} />
          : null}
      </>
    )
  }

  let body
  if (loading && info === null) {
    body = <Skeleton />
  } else if (info === null) {
    body = (
      <View style={styles.box}>
        <ErrorText>{loadError}</ErrorText>
        <Pill label='tentar de novo' onPress={load} />
      </View>
    )
  } else {
    body = (
      <>
        <ErrorText>{loadError}</ErrorText>
        <ErrorText>{act.error}</ErrorText>
        {checkBox}
        {confirmBox}

        {link0
          ? (
            <View style={styles.box}>
              <Label>Link da cadeira</Label>
              <Mono>{origin() + link0}</Mono>
              <Soft>{isPrivate ? 'Cadeira privada: quem abrir o link pede para entrar, e um administrador aprova.' : 'Quem abrir o link pode entrar na cadeira.'}</Soft>
            </View>
            )
          : null}

        {can('meta', role)
          ? (
            <View>
              <SectionHeader>Nome</SectionHeader>
              <View style={styles.box}>
                <Field label='Novo nome' value={nameDraft} onChangeText={setNameDraft} maxLength={MAX_GROUP_NAME * 2} placeholder={typeof info.name === 'string' ? displayText(info.name) : ''} />
                {countChars(newName) > MAX_GROUP_NAME ? <Soft>{'No máximo ' + MAX_GROUP_NAME + ' caracteres.'}</Soft> : null}
                <Btn label='Renomear' onPress={() => rename(newName)} disabled={!nameOk || !node.online} pending={act.pending} />
              </View>
            </View>
            )
          : null}

        {staff
          ? (
            <View>
              <SectionHeader>Pedidos</SectionHeader>
              {requests.rows.length === 0 ? <View style={styles.box}><Soft>Nenhum pedido agora.</Soft></View> : null}
              {requests.rows.map((r) => (
                <PersonRow key={r.member} row={r} onOpenMember={openMember}>
                  <Pill label='aprovar' filled onPress={() => admit(r.member, true)} pending={act.pending} />
                  <Pill label='recusar' onPress={() => admit(r.member, false)} pending={act.pending} />
                </PersonRow>
              ))}
              {requests.rows.length < requests.total ? <View style={styles.box}><Pill label='mais pedidos' onPress={() => loadMore('requests')} pending={more.pending} /></View> : null}
            </View>
            )
          : null}

        <SectionHeader>Membros</SectionHeader>
        {live.map((m) => (
          <PersonRow key={m.member} row={m} label={m.member === creator ? 'criador' : (m.admin ? 'administrador' : '')} onOpenMember={openMember}>
            {memberActions(m)}
          </PersonRow>
        ))}
        {members.rows.length < members.total ? <View style={styles.box}><Pill label='mais membros' onPress={() => loadMore('members')} pending={more.pending} /></View> : null}
        <ErrorText>{more.error}</ErrorText>

        <SectionHeader>Administradores</SectionHeader>
        {admins.length === 0 ? <View style={styles.box}><Soft>Nenhum administrador listado.</Soft></View> : null}
        {admins.map((m) => (
          <PersonRow key={'a' + m.member} row={m} label={m.member === creator ? 'criador' : 'administrador'} onOpenMember={openMember}>
            {can('admin', role) && m.member !== creator ? <Pill label='tirar admin' onPress={() => admin(m.member, false)} pending={act.pending} /> : null}
          </PersonRow>
        ))}

        {staff || banned.length > 0
          ? (
            <View>
              <SectionHeader>Banidos</SectionHeader>
              {banned.length === 0 ? <View style={styles.box}><Soft>Ninguém banido.</Soft></View> : null}
              {banned.map((m) => (
                <PersonRow key={'b' + m.member} row={m} onOpenMember={openMember}>
                  {staff ? <Pill label='desbanir' onPress={() => ban(m.member, false)} pending={act.pending} /> : null}
                </PersonRow>
              ))}
            </View>
            )
          : null}

        {can('link', role) || communities.length > 0
          ? (
            <View>
              <SectionHeader>Comunidade</SectionHeader>
              <View style={styles.box}>
                {communities.map((c) => (
                  <View key={c} style={styles.inline}>
                    <Pill label={'comunidade ' + shortKey(c)} onPress={openCommunity ? () => openCommunity(c) : undefined} />
                    {can('link', role) ? <Pill label='desvincular' danger onPress={() => link(c, false)} pending={act.pending} /> : null}
                  </View>
                ))}
                {can('link', role) && communities.length === 0
                  ? (
                    <>
                      <Soft>O vínculo só vale quando a cadeira e a comunidade concordam: os dois lados precisam vincular.</Soft>
                      <Field label='Chave da comunidade' value={communityKey} onChangeText={setCommunityKey} mono />
                      <Btn label='Vincular' onPress={() => link(typedKey, true)} disabled={!HEX64.test(typedKey) || !node.online} pending={act.pending} />
                    </>
                    )
                  : null}
              </View>
            </View>
            )
          : null}

        {isPrivate && can('rekey', role)
          ? (
            <View>
              <SectionHeader>Chave</SectionHeader>
              <View style={styles.box}>
                <Soft>Gerar nova chave abre uma nova época: as próximas mensagens só podem ser lidas por quem está na cadeira agora.</Soft>
                <Btn label='Gerar nova chave' secondary onPress={rekey} pending={act.pending} disabled={!node.online} />
              </View>
            </View>
            )
          : null}

        {can('leave', role)
          ? (
            <View style={styles.box}>
              <Btn
                label='Sair da cadeira'
                danger
                pending={act.pending}
                onPress={() => setConfirm({
                  text: isPrivate ? LEAVE_PRIVATE : (info.join === 'approval' ? LEAVE_APPROVAL : LEAVE_OPEN),
                  label: 'Sair',
                  run: leave
                })}
              />
            </View>
            )
          : null}
      </>
    )
  }

  return (
    <Sheet open={visible} onClose={onClose} title='Ajustes da cadeira'>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.content}>{body}</ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  content: { gap: 4, paddingBottom: 24 },
  box: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line
  },
  personText: { flex: 1, minWidth: 0 },
  name: { ...type.postName, color: colors.ink },
  meta: { ...type.postMeta, color: colors.soft }
})
