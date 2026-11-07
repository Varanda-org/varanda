// Ajustes da página: what the owner and the administrators of one page can
// change. Everyone on the roster edits the name, the bio and the photo
// (profile statement, or the raw avatar upload when a new photo is chosen:
// the photo is a draft until Salvar, like Perfil). Only the owner invites and
// removes administrators, offers the page to another member (and cancels the
// offer) and renames the @nome (7 days between renames). People are found by
// @nome (lookupUsername) and shown by name, never by key.
//
// Every change is signed by the node (pages.js) and is never resent: an
// uncertain answer only shows the 'incerto' sentence and the page is read
// again. Props: { entry: { key }, onBack, onChanged, onOpenMember(key, seed) }.
// Gated on pagesOn.
//
// Only the owner closes the page or moves it to a new key. An uncertain
// close or move keeps its signed bytes: 'Tentar de novo' resends them and
// nothing is signed again.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { sha256 } from '@noble/hashes/sha2.js'
import { MAX_BIO, MAX_NAME, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { whoOf } from '../who'
import { formatNextChange, isUsername, lookupUsername } from '../account'
import { countChars } from '../format'
import { pickImage } from '../media/attach'
import { openImage } from '../media/avatarEncode'
import { AVATAR_SIDE, MAX_AVATAR_BYTES, avatarOf, checkAvatarBytes } from '../media/avatar'
import { fetchMember } from '../indexClient'
import { planPeeks } from '../thread'
import { peekAll, refOf } from './Conversa'
import { revokeUrl, urlFromBytes } from '../media/display'
import { TEXTS, actAs, pagesAvatar, pagesClose, pagesMove, pagesOrigin, pagesStart } from '../pages'
import { FRESH_FAILED, mergeProfile, profileOp } from '../pageProfile'
import { usePageMember } from './Paginas'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { MAX_ADMINS, cancelOfferOp, closeOp, inviteOp, moveOp, offerOp, removeOp, rosterRows } from '../pageRoster'
import { pagesOn } from '../pageGate'
import * as actingAs from '../actingAs'
import { Btn, ConfirmStack, ErrorText, Field, Notice, Page, Row, SectionHeader, Soft, errorText, useAction } from '../ui'
import { Avatar } from '../ui/Avatar'
import { AvatarEditor } from '../ui/AvatarEditor'
import { Pill } from '../ui/Pill'
import { Skeleton } from '../ui/States'
import { TopBar } from '../ui/TopBar'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

const KEY_RE = /^[0-9a-f]{64}$/
const SOON = 'Disponível em breve.'
const LOCKED = 'Desbloqueie a conta para ajustar a página.'
const NOT_ADMIN = 'Você não administra esta página.'
const NAME_RULE = '@nome inválido: de 3 a 20 letras minúsculas, números ou _, começando por letra'
const RENAME_RULE = 'Depois de trocar, você só poderá mudar de novo daqui a 7 dias.'
const ALREADY_ADMIN = 'Essa pessoa já participa da página.'
const OFFER_TTL_MS = 7 * 24 * 3600 * 1000 - 60 * 1000
const PHOTO_SOFT = 'A foto da página é pública. Ela é recortada em quadrado e enviada sem dados de localização.'
const TRANSFER_SOFT = 'Quem aceitar passa a ser a dona ou o dono. Você continua como administrador. A oferta vale por 7 dias.'

const PROFILE_FAILED = 'Não deu para carregar o perfil da página'
const ADMINS_UNAVAILABLE = 'lista de administradores indisponível'
const MOVE_SOFT = 'Use se desconfiar que a chave vazou. Quem segue continua vendo a página e pode seguir a chave nova.'
const MOVE_UNKNOWN = 'Não deu para ler o estado da página agora. Tente de novo antes de mudar a chave.'
const LIFECYCLE_UNCERTAIN = 'Não sabemos se o pedido chegou. Confira a página antes de tentar de novo.'

// The two steps of 'Encerrar página', naming the @nome.
const closeWarning = (handle) => 'Encerrar ' + (handle || 'esta página') + '? As publicações deixam de aparecer para quem estiver com o aplicativo em dia. Cópias que alguém já tenha guardado continuam existindo.'
const closeFinal = (handle) => 'O ' + (handle || '@nome') + ' nunca mais será dado a outra página ou pessoa. Não dá para desfazer.'

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

// The member behind an @nome, or an Error with the text to show. `origin`:
// the node's account origin (pagesOrigin), so a core node asks its own.
async function memberOf (handle, origin) {
  const username = isUsername(handle)
  if (username === null) throw new Error(NAME_RULE)
  let record
  try {
    record = await lookupUsername(username, { origin })
  } catch {
    throw new Error(TEXTS.indisponivel)
  }
  if (!record || typeof record.member !== 'string' || !KEY_RE.test(record.member)) throw new Error(TEXTS['nao-encontrado'])
  return record.member
}

const text = (v) => (typeof v === 'string' ? v : '')

// The page's CURRENT profile (name, bio, avatar) or null when it cannot be
// read: the node's own diary first, else a peek of the signed profile block
// the seeder index names (the way Membro opens a diary this device does not
// hold). Never a guess: a null keeps Salvar off, because a save built on a
// missing profile would drop the photo.
async function readProfileOf (node, page) {
  const local = await readLocalProfile(node, page)
  return local !== null ? local : readPeekedProfile(node, page)
}

async function readLocalProfile (node, page) {
  try {
    const r = await node.request('profile.read', { authors: [page] })
    const list = r && Array.isArray(r.profiles) ? r.profiles : []
    const p = list.find((x) => x && typeof x.author === 'string' && x.author.toLowerCase() === page)
    if (p) return { name: text(p.name), bio: text(p.bio), avatar: avatarOf(p.avatar) }
  } catch {}
  return null
}

// The freshest read the node offers right before a save: on the hosted node
// a peek over the seeder (diary.peek), never the local replica that may lag;
// on the core node the same read the screen loads with.
function readFreshProfile (node, page) {
  return node.hosted === true ? readPeekedProfile(node, page) : readProfileOf(node, page)
}

async function readPeekedProfile (node, page) {
  try {
    const res = await fetchMember(page)
    if (!res.ok || !Number.isSafeInteger(res.value.profileSeq) || res.value.profileSeq < 1) return null
    const hints = { [page]: { profileSeq: res.value.profileSeq, usernameSeq: res.value.usernameSeq } }
    const peeked = new Map()
    await peekAll(node.request, planPeeks({ refs: [refOf(page, res.value.profileSeq)], authors: hints }), peeked)
    const peek = peeked.get(page)
    const p = peek && peek.profile
    if (p && typeof p.name === 'string') return { name: p.name, bio: text(p.bio), avatar: avatarOf(p.avatar) }
  } catch {}
  return null
}

function PersonRow ({ personKey, profile, role, children }) {
  const styles = useStyles(makeStyles)
  const who = whoOf(profile)
  const title = displayText(who.title)
  return (
    <View style={styles.person}>
      <Avatar name={who.avatarName} publicKey={personKey} size={40} picture={(profile || {}).avatar} persist />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>{title}</Text>
        <Text style={styles.meta} numberOfLines={1}>{who.subtitle ? displayText(who.subtitle) + ' · ' + role : role}</Text>
      </View>
      {children}
    </View>
  )
}

export default function PaginaAjustes ({ entry, onBack, onChanged, onOpenMember }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const names = useNames()
  const { profileOf, resolveMany, invalidate } = names
  const page = entry && typeof entry.key === 'string' ? entry.key : ''
  const pageMember = usePageMember(node)
  const member = pageMember.member
  const retryMember = pageMember.retry
  const hosted = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin })

  const [read, setRead] = useState(null)
  const [status, setStatus] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [base, setBase] = useState(null) // the page's current { name, bio, avatar }, once read
  const [profileFailed, setProfileFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(null) // null | { kind: 'remove', key } | { kind: 'transfer' }
  const [inviteHandle, setInviteHandle] = useState('')
  const [transferHandle, setTransferHandle] = useState('')
  const [renameHandle, setRenameHandle] = useState('')
  const profileAct = useAction()
  const inviteAct = useAction()
  const removeAct = useAction()
  const transferAct = useAction()
  const renameAct = useAction()
  const lifeAct = useAction()
  const [life, setLife] = useState(null) // null | { kind: 'close' | 'move', step: 1 | 2 }
  const [lifeUncertain, setLifeUncertain] = useState(null) // { kind, err, to? }: err.retry() resends the same bytes
  const [movedKey, setMovedKey] = useState(null)
  const [copyNote, setCopyNote] = useState('')
  const seqRef = useRef(0)
  const aliveRef = useRef(true)
  const baseRef = useRef(null)

  const setBaseValue = (next) => {
    baseRef.current = next
    setBase(next)
  }

  const load = useCallback(async () => {
    if (!hosted || member === null || !KEY_RE.test(page)) return
    const seq = ++seqRef.current
    setLoadError('')
    try {
      const value = await node.request('page.read', { key: page })
      let st = null
      if (value.isOwner === true) {
        try {
          st = await actAs(node, { member, action: 'status', page, op: {} })
        } catch {
          st = null
        }
      }
      let current = baseRef.current
      if (current === null) current = await readProfileOf(node, page)
      if (seq !== seqRef.current) return
      if (baseRef.current === null && current !== null) setBaseValue(current)
      setProfileFailed(baseRef.current === null)
      setRead(value)
      setStatus(st)
      resolveMany([page, value.owner, ...rosterRows(value).admins, ...(st && st.offer ? [st.offer.to] : [])].filter(Boolean))
    } catch (err) {
      if (seq === seqRef.current) setLoadError(errorText(err))
    }
  }, [hosted, member, page, node, resolveMany])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { aliveRef.current = false; seqRef.current += 1 }, [])

  const changed = () => {
    invalidate([page])
    if (typeof onChanged === 'function') onChanged()
  }

  // Success, failure or an uncertain answer: the page is read again.
  const run = async (action, fn, done) => {
    setNotice('')
    const r = await action.run(fn)
    if (r.ok && aliveRef.current && done) setNotice(done(r.value))
    await load()
    return r
  }

  // ---- name, bio and photo ---------------------------------------------------

  const profile = read ? profileOf(page) : undefined
  const [form, setForm] = useState(null) // { name, bio } once the current profile is known
  const [draft, setDraft] = useState(undefined) // undefined keep, null remove, { encoded, previewUrl }
  const [editor, setEditor] = useState(null)
  const [editorPending, setEditorPending] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [photoError, setPhotoError] = useState('')
  const [picking, setPicking] = useState(false)
  const editorRef = useRef(null)
  const draftRef = useRef(undefined)

  useEffect(() => {
    if (form === null && base !== null) setForm({ name: base.name, bio: base.bio })
  }, [form, base])

  const releaseEditor = () => {
    const h = editorRef.current
    editorRef.current = null
    if (h) { try { h.release() } catch {} }
    setEditor(null)
    setEditorPending(false)
    setEditorError('')
  }

  const setDraftValue = (next) => {
    const prev = draftRef.current
    if (prev && typeof prev === 'object' && prev.previewUrl && prev !== next) revokeUrl(prev.previewUrl)
    draftRef.current = next
    setDraft(next)
  }

  useEffect(() => () => {
    const h = editorRef.current
    if (h) { try { h.release() } catch {} }
    const d = draftRef.current
    if (d && typeof d === 'object' && d.previewUrl) revokeUrl(d.previewUrl)
  }, [])

  const choose = async () => {
    if (picking || editorRef.current) return
    setPicking(true)
    setPhotoError('')
    try {
      const file = await pickImage()
      if (!file) return
      const handle = await openImage(file)
      if (!aliveRef.current) {
        try { handle.release() } catch {}
        return
      }
      editorRef.current = handle
      setEditorError('')
      setEditor(handle)
    } catch (err) {
      if (aliveRef.current) setPhotoError(errorText(err))
    } finally {
      if (aliveRef.current) setPicking(false)
    }
  }

  const confirmCrop = async (rect) => {
    const handle = editorRef.current
    if (!handle || editorPending) return
    setEditorPending(true)
    setEditorError('')
    let encoded
    try {
      encoded = await handle.encode(rect, MAX_AVATAR_BYTES)
    } catch (err) {
      if (editorRef.current === handle) {
        setEditorError(errorText(err))
        setEditorPending(false)
      }
      return
    }
    if (editorRef.current !== handle) return
    if (!encoded || !checkAvatarBytes(encoded.bytes, { mime: encoded.mime, width: AVATAR_SIDE, height: AVATAR_SIDE })) {
      setEditorError('não foi possível preparar a foto')
      setEditorPending(false)
      return
    }
    let previewUrl
    try {
      previewUrl = urlFromBytes(encoded.bytes, encoded.mime)
    } catch {
      setEditorError('não foi possível preparar a foto')
      setEditorPending(false)
      return
    }
    setDraftValue({ encoded, previewUrl })
    releaseEditor()
  }

  const nameLen = form ? countChars(form.name) : 0
  const bioLen = form ? countChars(form.bio) : 0
  const formValid = form !== null && nameLen >= 1 && nameLen <= MAX_NAME && form.name.trim() !== '' && bioLen <= MAX_BIO
  const photoDraft = !!draft && typeof draft === 'object'
  const dirty = form !== null && base !== null && (form.name !== base.name || form.bio !== base.bio || draft !== undefined)

  // A new photo goes up with its own statement (name and bio ride along);
  // otherwise one profile statement keeps the known photo unless removed.
  // Every field the person did not edit comes from a fresh read (pageProfile.js).
  const save = () => run(profileAct, async () => {
    if (base === null) throw new Error(PROFILE_FAILED)
    const fresh = await readFreshProfile(node, page)
    if (fresh === null) throw new Error(FRESH_FAILED)
    const merged = mergeProfile({ base, form, draft, fresh })
    const { name, bio } = merged
    const origin = pagesOrigin(node)
    if (photoDraft) {
      const bytes = draft.encoded.bytes
      const op = { sha256: hex(sha256(bytes)), mime: draft.encoded.mime, bytes: bytes.byteLength, name, bio }
      const { nonce } = await pagesStart({ member, action: 'avatar', page, origin })
      const signed = await node.request('page.sign', { action: 'avatar', nonce, page, op })
      const out = await pagesAvatar({ member, nonce, page, op, signature: signed.signature, bytes, origin })
      setDraftValue(undefined)
      const descriptor = avatarOf(out && out.descriptor)
      // No readable descriptor: forget the base so the next read fetches it.
      setBaseValue(descriptor === null ? null : { name, bio, avatar: descriptor })
      return out
    }
    const out = await actAs(node, { member, action: 'profile', page, op: profileOp(merged) })
    setDraftValue(undefined)
    setBaseValue(merged)
    setForm({ name, bio })
    return out
  }, () => { changed(); return 'Página salva.' })

  // ---- roster ----------------------------------------------------------------

  const roster = rosterRows(read)
  const rosterKnown = !!read && read.complete === true
  const isOwner = !!read && read.isOwner === true
  const isAdmin = !!read && (read.isAdmin === true || isOwner)

  const invite = () => run(inviteAct, async () => {
    if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
    const who = await memberOf(inviteHandle, pagesOrigin(node))
    if (roster.rows.some((r) => r.key === who)) throw new Error(ALREADY_ADMIN)
    if (roster.admins.length >= MAX_ADMINS) throw new Error(TEXTS.limite)
    return actAs(node, { member, action: 'invite', page, op: ({ nonce }) => inviteOp(read, who, { nonce }) })
  }, () => { setInviteHandle(''); changed(); return 'Convite enviado. A pessoa vê o convite em Páginas e tem 7 dias para aceitar.' })

  const remove = (key) => run(removeAct, async () => {
    setConfirm(null)
    if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
    return actAs(node, { member, action: 'remove', page, op: ({ nonce }) => removeOp(read, key, { nonce }) })
  }, () => { changed(); return 'Administrador removido.' })

  const offerPending = !!status && !!status.offer && Date.parse(status.offer.exp) > Date.now()

  const transfer = () => run(transferAct, async () => {
    setConfirm(null)
    if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
    const to = await memberOf(transferHandle, pagesOrigin(node))
    if (to === member) throw new Error(ALREADY_ADMIN)
    const exp = new Date(Date.now() + OFFER_TTL_MS).toISOString()
    return actAs(node, { member, action: 'offer', page, op: ({ nonce }) => offerOp(read, to, { exp, nonce }) })
  }, () => { setTransferHandle(''); changed(); return 'Oferta enviada. A página só muda de dono quando a pessoa aceitar.' })

  const cancelOffer = () => run(transferAct, async () => {
    if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
    return actAs(node, { member, action: 'offer', page, op: ({ nonce }) => cancelOfferOp(read, { nonce }) })
  }, () => { changed(); return 'Oferta cancelada.' })

  const rename = () => run(renameAct, async () => {
    const username = isUsername(renameHandle)
    if (username === null) throw new Error(NAME_RULE)
    return actAs(node, { member, action: 'rename', page, op: { username } })
  }, (data) => {
    setRenameHandle('')
    changed()
    const when = data && typeof data.nextChangeAt === 'string' ? formatNextChange(data.nextChangeAt) : ''
    return 'Pronto: o @nome da página mudou.' + (when ? ' A próxima troca fica liberada em ' + when + '.' : '')
  })

  // ---- close and move (owner only) -------------------------------------------

  const fromSeq = !!status && Number.isSafeInteger(status.length) && status.length >= 1 ? status.length - 1 : null

  const lifecycleDone = (kind, value) => {
    setLifeUncertain(null)
    const acting = actingAs.get()
    if (acting.kind === 'page' && acting.key === page) actingAs.reset()
    if (kind === 'move' && typeof value === 'string' && KEY_RE.test(value)) setMovedKey(value)
    changed()
    return kind === 'close' ? 'Página encerrada.' : 'Pronto: a página mudou para uma nova chave.'
  }

  // `attempt` throws the error itself so an uncertain one keeps its retry.
  const lifecycle = async (kind, attempt, to = null) => {
    let failed = null
    const r = await run(lifeAct, async () => {
      try {
        return await attempt()
      } catch (err) {
        failed = err
        throw err
      }
    }, (value) => lifecycleDone(kind, kind === 'move' ? (to || value) : value))
    if (!r.ok) setLifeUncertain(r.uncertain && failed ? { kind, err: failed, to } : null)
  }

  const closePage = () => {
    setLife(null)
    return lifecycle('close', () => {
      if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
      return pagesClose(node, { member, page, gen: closeOp(read, { nonce: '' }).gen })
    })
  }

  const movePage = () => {
    setLife(null)
    const box = { to: null }
    return lifecycle('move', async () => {
      if (!rosterKnown) throw new Error(ADMINS_UNAVAILABLE)
      if (fromSeq === null) throw new Error(MOVE_UNKNOWN)
      return pagesMove(node, {
        member,
        page,
        op: ({ nonce, to }) => {
          box.to = to
          return moveOp(read, to, { fromSeq, nonce })
        }
      }).catch((err) => {
        if (err && err.uncertain === true && box.to) err.movedTo = box.to
        throw err
      })
    })
  }

  // The same signed bytes again; a move's new key is the one it was built for.
  const retryLifecycle = () => {
    const u = lifeUncertain
    if (!u || !u.err || typeof u.err.retry !== 'function') return
    const to = u.kind === 'move' && typeof u.err.movedTo === 'string' ? u.err.movedTo : null
    return lifecycle(u.kind, async () => {
      try {
        return await u.err.retry()
      } catch (err) {
        if (err && err.uncertain === true && to) err.movedTo = to
        throw err
      }
    }, to)
  }

  // ---- view ------------------------------------------------------------------

  const busy = profileAct.pending || inviteAct.pending || removeAct.pending || transferAct.pending || renameAct.pending || lifeAct.pending
  const who = whoOf(profile)

  const photo = (
    <View style={styles.photo}>
      <Avatar
        name={form ? form.name : ''}
        publicKey={page}
        size={88}
        persist
        picture={draft === null || base === null ? null : base.avatar}
        localUri={photoDraft ? draft.previewUrl : undefined}
      />
      <Row>
        <Pill label={photoDraft || (base && base.avatar) ? 'Trocar foto' : 'Escolher foto'} onPress={choose} disabled={busy || picking} />
        {draft === undefined && base && base.avatar ? <Pill label='Remover foto' danger onPress={() => setDraftValue(null)} disabled={busy} /> : null}
        {photoDraft ? <Pill label='Descartar foto' onPress={() => setDraftValue(undefined)} disabled={busy} /> : null}
        {draft === null ? <Pill label='Manter foto' onPress={() => setDraftValue(undefined)} disabled={busy} /> : null}
      </Row>
      <Soft>{draft === null ? 'A foto sai quando você salvar.' : PHOTO_SOFT}</Soft>
      <ErrorText>{photoError}</ErrorText>
    </View>
  )

  const editing = editor !== null
    ? (
      <AvatarEditor
        source={{ uri: editor.uri, width: editor.width, height: editor.height }}
        pending={editorPending}
        error={editorError}
        onCancel={releaseEditor}
        onConfirm={confirmCrop}
      />
      )
    : null

  let body
  if (!hosted) body = <Soft>{SOON}</Soft>
  else if (pageMember.core && member === null) {
    body = pageMember.error
      ? <><ErrorText>{pageMember.error}</ErrorText><Pill label='Tentar de novo' onPress={retryMember} /></>
      : <Skeleton rows={2} />
  } else if (member === null) body = <Soft>{LOCKED}</Soft>
  else if (!KEY_RE.test(page)) body = <Soft>{TEXTS['nao-encontrado']}</Soft>
  else if (read === null) body = loadError ? <ErrorText>{loadError}</ErrorText> : <Skeleton rows={2} />
  else if (!isAdmin) body = <Soft>{NOT_ADMIN}</Soft>
  else if (editing) body = editing
  else {
    body = (
      <>
        <Notice>{notice}</Notice>
        <ErrorText>{loadError}</ErrorText>
        {read.closed ? <Soft>{TEXTS.encerrada}</Soft> : null}
        {!read.closed && read.movedTo ? <Soft>{TEXTS.movida}</Soft> : null}
        <SectionHeader>Perfil da página</SectionHeader>
        {form !== null
          ? (
            <>
              {photo}
              <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} editable={!busy} />
              <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={form.bio} onChangeText={(v) => setForm({ ...form, bio: v })} editable={!busy} multiline lines={3} />
              <ErrorText>{profileAct.error}</ErrorText>
              <Btn label='Salvar' onPress={save} disabled={!formValid || !dirty || read.closed === true} pending={profileAct.pending} />
            </>
            )
          : profileFailed
            ? (
              <>
                <ErrorText>{PROFILE_FAILED}</ErrorText>
                <Pill label='Tentar de novo' onPress={load} disabled={busy} />
              </>
              )
            : <Skeleton rows={1} />}

        <SectionHeader>Pessoas</SectionHeader>
        {rosterKnown
          ? null
          : (
            <>
              <Soft>{ADMINS_UNAVAILABLE}</Soft>
              <Pill label='Tentar de novo' onPress={load} disabled={busy} />
            </>
            )}
        {roster.rows.map((r) => (
          <PersonRow key={r.key} personKey={r.key} profile={profileOf(r.key)} role={r.role === 'owner' ? 'Dono' : 'Administrador'}>
            {isOwner && rosterKnown && r.role === 'admin'
              ? <Pill label='Remover' danger onPress={() => setConfirm({ kind: 'remove', key: r.key })} disabled={busy} />
              : null}
          </PersonRow>
        ))}
        {confirm && confirm.kind === 'remove'
          ? (
            <View style={styles.confirm}>
              <Soft>{'Remover ' + displayText(whoOf(profileOf(confirm.key)).title) + ' da administração da página?'}</Soft>
              <ConfirmStack
                confirm={<Btn label='Remover' danger onPress={() => remove(confirm.key)} pending={removeAct.pending} />}
                cancel={<Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={removeAct.pending} />}
              />
            </View>
            )
          : null}
        <ErrorText>{removeAct.error}</ErrorText>

        {isOwner
          ? (
            <>
              {rosterKnown
                ? (
                  <>
                    <Field label='Convidar administrador (@nome)' value={inviteHandle} onChangeText={setInviteHandle} editable={!busy} placeholder='@nome' />
                    <ErrorText>{inviteAct.error}</ErrorText>
                    <Btn label='Convidar' onPress={invite} disabled={inviteHandle.trim() === '' || read.closed === true} pending={inviteAct.pending} />
                  </>
                  )
                : null}

              <SectionHeader>Transferir a página</SectionHeader>
              {offerPending
                ? (
                  <>
                    <Soft>{'Oferta enviada para ' + displayText(whoOf(profileOf(status.offer.to)).title) + '. Ela vale até ' + formatNextChange(status.offer.exp) + '.'}</Soft>
                    <Btn label='Cancelar oferta' secondary onPress={cancelOffer} pending={transferAct.pending} />
                  </>
                  )
                : rosterKnown
                  ? (
                    <>
                      <Field label='Transferir para (@nome)' value={transferHandle} onChangeText={setTransferHandle} editable={!busy} placeholder='@nome' />
                      <Soft>{TRANSFER_SOFT}</Soft>
                      {confirm && confirm.kind === 'transfer'
                        ? (
                          <View style={styles.confirm}>
                            <Soft>Oferecer a página a essa pessoa?</Soft>
                            <ConfirmStack
                              confirm={<Btn label='Transferir' danger onPress={transfer} pending={transferAct.pending} />}
                              cancel={<Btn label='Cancelar' secondary onPress={() => setConfirm(null)} disabled={transferAct.pending} />}
                            />
                          </View>
                          )
                        : <Btn label='Transferir' secondary onPress={() => setConfirm({ kind: 'transfer' })} disabled={transferHandle.trim() === '' || read.closed === true} />}
                    </>
                    )
                  : <Soft>{ADMINS_UNAVAILABLE}</Soft>}
              <ErrorText>{transferAct.error}</ErrorText>

              <SectionHeader>@nome da página</SectionHeader>
              <Soft>{who.subtitle ? 'Agora: ' + displayText(who.subtitle) : 'Sem @nome ainda.'}</Soft>
              <Field label='Novo @nome' value={renameHandle} onChangeText={setRenameHandle} editable={!busy} placeholder='@nome' />
              <Soft>{RENAME_RULE}</Soft>
              <ErrorText>{renameAct.error}</ErrorText>
              <Btn label='Trocar @nome' secondary onPress={rename} disabled={renameHandle.trim() === '' || read.closed === true} pending={renameAct.pending} />

              {movedKey !== null
                ? (
                  <View style={styles.confirm}>
                    <SectionHeader>Chave nova</SectionHeader>
                    <Soft>A página continua com o mesmo @nome. Quem segue vê um aviso para seguir a chave nova.</Soft>
                    {typeof onOpenMember === 'function'
                      ? <Btn label='Ver a página nova' onPress={() => onOpenMember(movedKey, { page: true })} />
                      : null}
                    <Pill label='Copiar a chave nova' onPress={async () => setCopyNote((await copyText(shareNav(), movedKey)) ? 'chave copiada' : 'não foi possível copiar a chave')} />
                    {copyNote ? <Soft>{copyNote}</Soft> : null}
                  </View>
                  )
                : null}
              {lifeUncertain !== null
                ? (
                  <View style={styles.confirm}>
                    <Soft>{LIFECYCLE_UNCERTAIN}</Soft>
                    {typeof lifeUncertain.err.retry === 'function'
                      ? <Pill label='Tentar de novo' onPress={retryLifecycle} disabled={lifeAct.pending} pending={lifeAct.pending} />
                      : null}
                  </View>
                  )
                : null}
              {read.closed !== true && !read.movedTo && lifeUncertain === null
                ? (
                  <>
                    <SectionHeader>Mudar a chave</SectionHeader>
                    <Soft>{MOVE_SOFT}</Soft>
                    {fromSeq === null ? <Soft>{MOVE_UNKNOWN}</Soft> : null}
                    {life && life.kind === 'move'
                      ? (
                        <View style={styles.confirm}>
                          <Soft>Mudar a página para uma chave nova? A chave atual deixa de valer para publicar.</Soft>
                          <ConfirmStack
                            confirm={<Btn label='Mudar a chave' danger onPress={movePage} pending={lifeAct.pending} />}
                            cancel={<Btn label='Cancelar' secondary onPress={() => setLife(null)} disabled={lifeAct.pending} />}
                          />
                        </View>
                        )
                      : <Btn label='Mudar a chave' secondary onPress={() => setLife({ kind: 'move', step: 1 })} disabled={busy || !rosterKnown || fromSeq === null} />}

                    <SectionHeader>Encerrar página</SectionHeader>
                    {life && life.kind === 'close'
                      ? (
                        <View style={styles.confirm}>
                          <Soft>{life.step === 1 ? closeWarning(who.subtitle ? displayText(who.subtitle) : '') : closeFinal(who.subtitle ? displayText(who.subtitle) : '')}</Soft>
                          <ConfirmStack
                            confirm={life.step === 1
                              ? <Btn label='Continuar' danger onPress={() => setLife({ kind: 'close', step: 2 })} />
                              : <Btn label='Encerrar de vez' danger onPress={closePage} pending={lifeAct.pending} />}
                            cancel={<Btn label='Cancelar' secondary onPress={() => setLife(null)} disabled={lifeAct.pending} />}
                          />
                        </View>
                        )
                      : <Btn label='Encerrar página' danger onPress={() => setLife({ kind: 'close', step: 1 })} disabled={busy || !rosterKnown} />}
                  </>
                  )
                : null}
              <ErrorText>{lifeAct.error}</ErrorText>
            </>
            )
          : null}
      </>
    )
  }

  return (
    <View style={styles.flex}>
      <TopBar title='Ajustes da página' subtitle={read && profile ? displayText(who.title) : undefined} onBack={onBack} />
      <Page>{body}</Page>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  photo: { alignItems: 'flex-start', gap: 10 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  who: { flex: 1 },
  name: { ...type.postName, color: colors.ink },
  meta: { fontSize: 14, color: colors.soft },
  confirm: { gap: 8 }
})
