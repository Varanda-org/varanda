// Novo grupo: the sheet that creates a group inside a community, or without
// one when `standalone` is set (group.create, docs/rpc.md 5.36), and hands the
// new group to the caller.
// Props: community (hex64 root key, ignored when standalone), standalone,
// visible, onClose(), onCreated(group, notice)
// where group is the hex64 root key (null when the check found it already
// made). A create that comes back uncertain is never resent: the sheet asks
// the person to check ("conferir") before trying again: group.create always
// makes a new root, so a resend could leave two groups. Only that check or
// closing the sheet lifts the lock.

import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { readStandalone, reconcile } from '../groups'
import { STANDALONE_UNKNOWN_NOTE, createdStandaloneKey, standaloneCreateView } from '../newGroup'
import { Btn, ErrorText, Field, Label, Soft, UNCERTAIN, errorText, useAction } from '../ui'
import { imageAfterCreate, words } from '../groupImageCreate'
import { pickImage } from '../media/attach'
import { openImage } from '../media/avatarEncode'
import { AVATAR_SIDE, MAX_AVATAR_BYTES, checkAvatarBytes } from '../media/avatar'
import { Avatar } from '../ui/Avatar'
import { AvatarEditor } from '../ui/AvatarEditor'
import { publicGroupRefusal } from '../wordCheck'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { useEscapeLayer } from '../ui/escapeLayer'
import { useNode } from '../node'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

// MAX_GROUP_NAME (rpc 5.36, also the community name limit) counts code points.
export const NAME_MAX = rpc.MAX_GROUP_NAME

export function nameLength (text) {
  return Array.from(text).length
}

// Escape closes only this sheet: the shared Escape layers (src/ui/escapeLayer.js)
// keep App's Escape from also popping the screen underneath.
export function useEscapeClose (visible, onClose) {
  useEscapeLayer(!!visible, onClose, 'sheet')
}

export function Choice ({ label, options, value, onChange, disabled }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.choice}>
      <Label>{label}</Label>
      <View style={styles.pills} accessibilityRole='radiogroup' accessibilityLabel={label}>
        {options.map((o) => (
          <Pill
            key={o.value}
            label={o.label}
            filled={value === o.value}
            disabled={disabled}
            accessibilityLabel={o.label + (value === o.value ? ', escolhido' : '')}
            onPress={() => onChange(o.value)}
          />
        ))}
      </View>
    </View>
  )
}

// What the community says about its groups, for the reconcile of an
// uncertain create (community.info lists each group by name and role).
async function communityView (request, community) {
  const info = await request('community.info', { community })
  return { community: info && info.community, groups: info && info.groups, incomplete: !!info && info.incomplete === true }
}

export function NovoGrupo ({ community, standalone = false, visible, onClose, onCreated }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const [name, setName] = useState('')
  const [join, setJoin] = useState('open')
  const [visibility, setVisibility] = useState('public')
  // After an uncertain create: { name }, the name that was sent.
  const [uncertain, setUncertain] = useState(null)
  const [checkNote, setCheckNote] = useState('')
  const [editor, setEditor] = useState(null)
  const [hasPhoto, setHasPhoto] = useState(false)
  const [photoError, setPhotoError] = useState('')
  const [pending, setPending] = useState(false)
  const sessionRef = useRef(null)
  const action = useAction()
  const check = useAction()
  const clearRef = useRef(action.clearError)
  clearRef.current = action.clearError

  const releasePhoto = (session) => {
    if (!session) return
    try { session.handle?.release() } catch {}
    session.handle = null
    session.picked = null
  }

  const close = () => {
    if (sessionRef.current?.busy) return
    if (sessionRef.current) sessionRef.current.open = false
    releasePhoto(sessionRef.current)
    setEditor(null)
    setHasPhoto(false)
    onClose()
  }

  // A fresh form every time the sheet opens.
  useEffect(() => {
    if (!visible) return
    const session = { open: true, busy: false, done: false, handle: null, picked: null, before: null }
    sessionRef.current = session
    setName('')
    setJoin('open')
    setVisibility('public')
    setUncertain(null)
    setCheckNote('')
    setEditor(null)
    setHasPhoto(false)
    setPhotoError('')
    setPending(false)
    clearRef.current()
    return () => { session.open = false; releasePhoto(session) }
  }, [visible])

  useEscapeClose(visible, close)

  const canUpload = node.hosted === true && typeof node.media?.upload === 'function'
  const cancelPhoto = () => {
    const session = sessionRef.current
    if (!session?.open || session.busy) return
    releasePhoto(session)
    setEditor(null)
    setHasPhoto(false)
    setPhotoError('')
  }

  const choosePhoto = async () => {
    const session = sessionRef.current
    if (!session?.open || session.busy || session.done || session.handle || !canUpload || node.online === false) return
    session.busy = true
    releasePhoto(session)
    setHasPhoto(false)
    setPhotoError('')
    setPending(true)
    try {
      const file = await pickImage()
      if (!file || !session.open) return
      const handle = await openImage(file)
      if (!session.open) { handle.release(); return }
      session.handle = handle
      setEditor(handle)
    } catch (err) {
      if (session.open) setPhotoError(errorText(err))
    } finally {
      session.busy = false
      if (session.open) setPending(false)
    }
  }

  const cropPhoto = async (rect) => {
    const session = sessionRef.current
    if (!session?.open || session.busy || !session.handle) return
    session.busy = true
    setPending(true)
    setPhotoError('')
    try {
      const encoded = await session.handle.encode(rect, MAX_AVATAR_BYTES, { format: 'jpeg' })
      if (!session.open) return
      if (!encoded || encoded.mime !== 'image/jpeg' || !checkAvatarBytes(encoded.bytes, { mime: encoded.mime, width: AVATAR_SIDE, height: AVATAR_SIDE })) throw new Error('Não foi possível preparar a foto.')
      releasePhoto(session)
      session.picked = { bytes: encoded.bytes, mime: encoded.mime }
      setHasPhoto(true)
      setEditor(null)
    } catch (err) {
      if (session.open) setPhotoError(errorText(err))
    } finally {
      session.busy = false
      if (session.open) setPending(false)
    }
  }

  const priv = visibility === 'private'
  const trimmed = name.trim()
  const tooLong = nameLength(trimmed) > NAME_MAX
  const offline = node.online === false
  const refused = publicGroupRefusal(visibility, trimmed)
  const ready = trimmed.length > 0 && !tooLong && refused === '' && !offline && uncertain === null && (standalone === true || typeof community === 'string')

  const create = async () => {
    const session = sessionRef.current
    if (!ready || !session?.open || session.busy || session.done || session.handle) return
    session.busy = true
    setPending(true)
    setCheckNote('')
    // The keys held before the create: only a new key can confirm an
    // uncertain create without community.
    session.before = standalone === true ? await readStandalone(node.request) : null
    if (!session.open) return
    const params = { name: trimmed, join: priv ? 'approval' : join, visibility }
    if (standalone !== true) params.community = community
    const res = await action.run(() => node.request('group.create', params))
    if (!session.open) return
    if (res.ok && res.value && typeof res.value.group === 'string') {
      session.done = true
      const result = await imageAfterCreate({
        key: res.value.group,
        kind: 'group',
        visibility,
        picked: canUpload ? session.picked : null,
        upload: (input) => node.media.upload(input),
        setImage: (method, params) => {
          if (!session.open) throw new Error('A criação foi fechada.')
          return node.request(method, params)
        }
      })
      releasePhoto(session)
      if (!session.open) return
      setHasPhoto(false)
      session.busy = false
      setPending(false)
      if (typeof onCreated === 'function') onCreated(res.value.group, result === 'failed' || result === 'uncertain' ? words.groupFailed : '')
      return
    }
    session.busy = false
    setPending(false)
    if (res.uncertain) {
      session.done = true
      releasePhoto(session)
      setHasPhoto(false)
      setUncertain({ name: trimmed })
    }
  }

  // A private group's name can read null (locked), so only a group with the
  // sent name and the caller as creator counts as the new one.
  const confirm = async () => {
    const session = sessionRef.current
    if (uncertain === null || !session?.open) return
    const alone = standalone === true
    const res = await check.run(async () => alone
      ? standaloneCreateView(session.before, await readStandalone(node.request))
      : communityView(node.request, community))
    if (!res.ok || !session.open) return
    const verdict = reconcile({ action: 'create', community: alone ? null : community, name: uncertain.name }, res.value)
    if (verdict === 'landed') {
      if (typeof onCreated === 'function') onCreated(alone ? createdStandaloneKey(res.value, uncertain.name) : null)
      return
    }
    if (verdict === 'unknown') {
      setCheckNote(alone ? STANDALONE_UNKNOWN_NOTE : 'Não dá para conferir agora. Espere um pouco e confira a lista de grupos da comunidade antes de tentar de novo.')
      return
    }
    setUncertain(null)
    session.done = false
    setCheckNote('O grupo não foi criado. Você pode tentar de novo.')
  }

  const fields = editor !== null
    ? <AvatarEditor source={editor} pending={pending} error={photoError} onCancel={cancelPhoto} onConfirm={cropPhoto} />
    : (
      <>
        <Field
          label='Nome'
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX * 2}
          placeholder='Nome do grupo'
        />
        {tooLong ? <ErrorText>{'O nome pode ter até ' + NAME_MAX + ' caracteres.'}</ErrorText> : null}
        <ErrorText>{refused}</ErrorText>
        {canUpload
          ? (
            <View style={styles.choice}>
              <Label>{words.groupLabel}</Label>
              <View style={styles.photoRow}>
                <Avatar name={trimmed} size={44} shape='square' />
                <Pressable accessibilityRole='button' accessibilityLabel='Escolher foto' accessibilityState={{ disabled: pending || uncertain !== null || editor !== null || offline }} disabled={pending || uncertain !== null || editor !== null || offline} onPress={choosePhoto} style={styles.photoTarget}>
                  <Text style={styles.photoLabel}>Escolher foto</Text>
                </Pressable>
                {hasPhoto ? <Btn label='Remover foto' secondary onPress={cancelPhoto} disabled={pending} /> : null}
              </View>
              {hasPhoto ? <Soft>Foto escolhida.</Soft> : null}
              <ErrorText>{photoError}</ErrorText>
            </View>
            )
          : null}
        <Choice
          label='Visibilidade'
          value={visibility}
          onChange={setVisibility}
          disabled={pending || uncertain !== null}
          options={[{ value: 'public', label: 'Pública' }, { value: 'private', label: 'Privada' }]}
        />
        {canUpload ? <Soft>{priv ? words.groupPrivate : words.groupPublic}</Soft> : null}
        {priv
          ? <Soft>As mensagens de um grupo privado são cifradas de ponta a ponta: só os membros leem. Ele não aparece na busca e sempre pede aprovação para entrar.</Soft>
          : <Soft>Qualquer pessoa pode encontrar um grupo público na busca e ler as mensagens.</Soft>}
        <Choice
          label='Entrada'
          value={priv ? 'approval' : join}
          onChange={setJoin}
          disabled={priv}
          options={[{ value: 'open', label: 'Aberta' }, { value: 'approval', label: 'Com aprovação' }]}
        />
        {offline ? <Text style={styles.note}>Sem internet: conecte-se para criar o grupo.</Text> : null}
        {uncertain !== null
          ? (
            <View style={styles.check}>
              <ErrorText>{UNCERTAIN + '. Confira se o grupo já foi criado antes de tentar de novo.'}</ErrorText>
              <ErrorText>{check.error}</ErrorText>
              <Btn label='Conferir' onPress={confirm} pending={check.pending} secondary />
            </View>
            )
          : <ErrorText>{action.error}</ErrorText>}
        {checkNote ? <Soft>{checkNote}</Soft> : null}
        <Btn label='Criar grupo' onPress={create} disabled={!ready || editor !== null} pending={pending} />
      </>
      )

  return (
    <Sheet open={!!visible} onClose={close} dismissable={!pending} title='Novo grupo'>
      {/* The crop editor is taller than a small phone's sheet. */}
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
        {fields}
      </ScrollView>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  body: { padding: 16, gap: 12 },
  choice: { gap: 6 },
  photoRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  photoTarget: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 },
  photoLabel: { ...type.postMeta, color: colors.accent },
  check: { gap: 8 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { ...type.postMeta, color: colors.soft }
})
