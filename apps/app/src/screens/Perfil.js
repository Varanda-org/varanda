/* global Blob, URL */

// Perfil: the "Editar perfil" sheet and, with `page`, the onboarding step
// 'Como você quer aparecer' (no Sheet: a Stepper with the same form, 'Continuar'
// and 'Pular por enquanto'). Name (1..80 code points, not only whitespace) and
// bio (0..280 code points), published with profile.set. The draft lives here,
// outside the Sheet (its Modal unmounts the children when closed). With
// `embedded` (Ajustes) it renders as a plain page inside another sheet, with
// its own 'Salvar'; `open` then tells when the form restarts from `current`.
//
// The photo is a local draft until Salvar: choosing and cropping upload
// nothing; Salvar uploads the cropped bytes once and then sends one
// profile.set (../profileSave.js). An uploaded descriptor stays on the draft,
// so trying again after a failed profile.set never uploads again.
//
// An uncertain save is never resent: the own profile is re-read with
// profile.read (the whole log, verified name/bio/avatar) and only an equal
// result counts as saved; otherwise the draft stays for the person to decide.

import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { LOG_LIMIT_MAX, MAX_BIO, MAX_NAME, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { profileVersions } from '../deletion'
import { countChars, relativeTime } from '../format'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { pickImage } from '../media/attach'
import { openImage } from '../media/avatarEncode'
import { AVATAR_SIDE, MAX_AVATAR_BYTES, checkAvatarBytes } from '../media/avatar'
import { revokeDeletedMedia } from '../media/cache'
import { confirmSaved, planSave } from '../profileSave'
import { Btn, ErrorText, Field, Page, Row, SectionHeader, Soft, colors, errorText, useAction } from '../ui'
import { Avatar, primeAvatar } from '../ui/Avatar'
import { AvatarEditor } from '../ui/AvatarEditor'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { Stepper } from '../ui/Stepper'

// The own profile as the node shows it (profile.read, docs/rpc.md 5.21), or
// null when the node lists the own key as missing or does not know the method.
async function readOwnProfile (node, ownKey) {
  const key = typeof ownKey === 'string' ? ownKey : (await node.request('node.info', {})).publicKey
  if (typeof key !== 'string') return null
  const res = await node.request('profile.read', { authors: [key] })
  const lower = key.toLowerCase()
  for (const p of (res && res.profiles) || []) {
    if (p && typeof p.author === 'string' && p.author.toLowerCase() === lower) return p
  }
  return null
}

const revokeDraft = (d) => {
  if (d && typeof d === 'object' && d.previewUrl) {
    try { URL.revokeObjectURL(d.previewUrl) } catch {}
  }
}

const releaseHandle = (h) => {
  if (h) {
    try { h.release() } catch {}
  }
}

// Pages of the whole own log are read to list the versions; a diary longer
// than this many pages shows only the newest ones.
const VERSION_PAGES = 10

// The own profile versions, newest first, each with 'Apagar versão'
// (profile.delete once; the node deletes a compat pair as one version). After
// an uncertain failure the list is re-read before the button is offered again.
function ProfileVersions ({ node, ownKey, shown }) {
  const names = useNames()
  const action = useAction()
  const [versions, setVersions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [partial, setPartial] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [done, setDone] = useState(false)
  const aliveRef = useRef(true)
  const genRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const keyOf = async () => typeof ownKey === 'string' ? ownKey.toLowerCase() : (await node.request('node.info', {})).publicKey
  const load = async () => {
    const mine = ++genRef.current
    setVersions(null)
    setLoadError('')
    try {
      const entries = []
      let before
      let truncated = 0
      for (let i = 0; i < VERSION_PAGES; i++) {
        const params = before === undefined ? { limit: LOG_LIMIT_MAX } : { limit: LOG_LIMIT_MAX, before }
        const log = await node.request('log.read', params)
        entries.push(...log.entries)
        truncated = log.entriesTruncated
        if (truncated === 0) break
        const seqs = log.entries.map((e) => e.seq).concat((log.invalid || []).map((e) => e.seq))
        if (seqs.length === 0) break
        before = Math.min(...seqs)
      }
      if (!aliveRef.current || mine !== genRef.current) return
      setVersions(profileVersions(entries))
      setPartial(truncated !== 0)
    } catch (err) {
      if (aliveRef.current && mine === genRef.current) setLoadError(errorText(err))
    }
  }

  useEffect(() => {
    if (shown) {
      setConfirm(null)
      setDone(false)
      action.clearError()
      load()
    } else {
      genRef.current += 1
    }
  }, [shown])

  const remove = async (version) => {
    const key = await keyOf()
    if (typeof key !== 'string') return
    const r = await action.run(() => node.request('profile.delete', { to: key + ':' + version.seq }))
    if (r.ok) {
      const seqs = r.value && Array.isArray(r.value.deleted) && r.value.deleted.length > 0
        ? r.value.deleted
        : version.seqs
      // Confirmed: drop cached blobs for the tombstone's effective ranges
      // only. A range the current profile or a post still shows stays, so
      // that photo does not disappear.
      await revokeDeletedMedia((method, params) => node.request(method, params), seqs, LOG_LIMIT_MAX)
    }
    if (!aliveRef.current) return
    if (r.ok) {
      setConfirm(null)
      setDone(true)
      // A seed never overwrites a known name with null: ask the node again.
      names.invalidate([key])
      await load()
    } else if (r.uncertain) {
      setConfirm(null)
      await load()
    }
  }

  if (loadError) {
    return (
      <View style={styles.versions}>
        <SectionHeader>Versões do perfil</SectionHeader>
        <ErrorText>{loadError}</ErrorText>
        <Pill label='Tentar de novo' onPress={load} />
      </View>
    )
  }
  if (versions === null) return null
  if (versions.length === 0 && !done) return null
  return (
    <View style={styles.versions}>
      <SectionHeader>Versões do perfil</SectionHeader>
      {done ? <Soft>versão apagada</Soft> : null}
      {versions.map((v, i) => (
        <View key={v.seq} style={styles.version}>
          <Text style={styles.versionName}>{displayText(v.name)}</Text>
          <Soft>{(i === 0 ? 'atual · ' : '') + (relativeTime(v.at) ?? displayText(String(v.at))) + (v.avatar ? ' · com foto' : '')}</Soft>
          {confirm === v.seq
            ? (
              <View style={styles.versionConfirm}>
                <Soft>Apagar esta versão do perfil? Ela some do seu diário e dos feeds de quem te segue. A cópia da foto enviada continua na rede.</Soft>
                <Row>
                  <Btn label='Apagar versão' danger onPress={() => remove(v)} pending={action.pending} />
                  <Btn label='Cancelar' secondary onPress={() => { action.clearError(); setConfirm(null) }} disabled={action.pending} />
                </Row>
              </View>
              )
            : <Pill label='Apagar versão' danger onPress={() => { action.clearError(); setDone(false); setConfirm(v.seq) }} disabled={action.pending} />}
        </View>
      ))}
      {partial ? <Soft>Mostrando só as versões mais recentes.</Soft> : null}
      <ErrorText>{action.error}</ErrorText>
    </View>
  )
}

export default function Perfil ({ open, current, onClose, onSaved, ownKey, page = false, embedded = false, index, total, onSkip }) {
  const node = useNode()
  const action = useAction()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  // An uncertain save is being checked against the diary.
  const [checking, setChecking] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Set while a save runs, from the first click to the last answer.
  const lockRef = useRef(false)
  // The photo draft: undefined (unchanged), null (remove) or
  // { encoded, previewUrl, descriptor }; the ref is what a running save reads.
  const [draft, setDraftState] = useState(undefined)
  const draftRef = useRef(undefined)
  // The open crop editor's image handle (openImage), or null.
  const [editor, setEditorState] = useState(null)
  const editorRef = useRef(null)
  const [editorPending, setEditorPending] = useState(false)
  const [editorError, setEditorError] = useState('')
  const [photoError, setPhotoError] = useState('')
  // A running pick (file dialog and decode) holds a token here; hiding the
  // form drops it, so a pick that answers later only releases its handle.
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(null)
  const aliveRef = useRef(true)
  // A plain first profile was saved by a save whose upload then failed: the
  // diary has a profile now, so the next try needs no plain step.
  const plainDoneRef = useRef(false)
  const chooseRef = useRef(null)
  const refocusRef = useRef(false)
  const currentRef = useRef(current)
  currentRef.current = current
  // The page is always shown; the sheet only while open.
  const shown = page || open
  const shownRef = useRef(shown)
  shownRef.current = shown

  const media = node.media && typeof node.media.upload === 'function' ? node.media : null
  const hasUpload = typeof pickImage === 'function' && media !== null

  const setDraft = (next) => {
    if (draftRef.current !== next) revokeDraft(draftRef.current)
    draftRef.current = next
    setDraftState(next)
  }
  const closeEditor = () => {
    releaseHandle(editorRef.current)
    editorRef.current = null
    setEditorState(null)
    setEditorPending(false)
    setEditorError('')
    refocusRef.current = true
  }

  // The form starts from `current` each time the sheet opens; a reload
  // while it is open never overwrites the draft. Closing drops the photo draft.
  useEffect(() => {
    setDraft(undefined)
    releaseHandle(editorRef.current)
    editorRef.current = null
    setEditorState(null)
    setEditorPending(false)
    setEditorError('')
    setPhotoError('')
    pickingRef.current = null
    setPicking(false)
    if (!shown) {
      // Closed after a plain first profile was saved and its photo upload
      // failed: the caller still learns the name now in the diary.
      const plain = plainDoneRef.current
      if (plain && typeof plain === 'object' && !lockRef.current) {
        plainDoneRef.current = true
        onSaved(plain)
      }
      return
    }
    const c = currentRef.current || {}
    setName(c.name || '')
    setBio(c.bio || '')
    action.clearError()
  }, [shown])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      pickingRef.current = null
      revokeDraft(draftRef.current)
      draftRef.current = undefined
      releaseHandle(editorRef.current)
      editorRef.current = null
    }
  }, [])

  // Focus goes back to the photo button when the editor closes (web).
  useEffect(() => {
    if (editor !== null || !refocusRef.current) return
    refocusRef.current = false
    if (Platform.OS !== 'web') return
    try {
      const el = chooseRef.current
      const btn = el && typeof el.querySelector === 'function' ? el.querySelector('[role="button"]') : null
      if (btn) btn.focus()
    } catch {}
  }, [editor])

  const nameLen = countChars(name)
  const bioLen = countChars(bio)
  const valid = nameLen >= 1 && nameLen <= MAX_NAME && name.trim() !== '' && bioLen <= MAX_BIO
  // While a save, its upload or its uncertain re-read runs, or the crop
  // editor is open, the fields are locked: a success closes the sheet and the
  // next open restarts from the saved profile.
  const saving = action.pending || checking || uploading
  const locked = saving || picking || editor !== null

  const knownAvatar = current && current.avatar ? current.avatar : null
  const draftIsPhoto = !!draft && typeof draft === 'object'

  const choose = async () => {
    if (!hasUpload || lockRef.current || editorRef.current || pickingRef.current) return
    const token = {}
    pickingRef.current = token
    setPicking(true)
    setPhotoError('')
    try {
      const file = await pickImage()
      if (!file) return
      const handle = await openImage(file)
      if (!aliveRef.current || pickingRef.current !== token || !shownRef.current || lockRef.current || editorRef.current) {
        releaseHandle(handle)
        return
      }
      editorRef.current = handle
      setEditorError('')
      setEditorState(handle)
    } catch (err) {
      if (aliveRef.current && pickingRef.current === token) setPhotoError(errorText(err))
    } finally {
      if (pickingRef.current === token) {
        pickingRef.current = null
        if (aliveRef.current) setPicking(false)
      }
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
    // The same header check a viewer runs: a draft that would never be drawn
    // is never created, so nothing is uploaded for it.
    if (!encoded || !checkAvatarBytes(encoded.bytes, { mime: encoded.mime, width: AVATAR_SIDE, height: AVATAR_SIDE })) {
      setEditorError('não foi possível preparar a foto')
      setEditorPending(false)
      return
    }
    const previewUrl = URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime }))
    setDraft({ encoded, previewUrl, descriptor: null })
    closeEditor()
  }

  // An uncertain profile.set: read the own profile before letting the person
  // try again (a mutation is never resent).
  const recheck = async (sent) => {
    setChecking(true)
    try {
      return confirmSaved(sent, await readOwnProfile(node, ownKey))
    } catch {
      return false
    } finally {
      if (aliveRef.current) setChecking(false)
    }
  }

  const finish = (sent) => {
    const d = draftRef.current
    if (sent.avatar && typeof ownKey === 'string' && d && typeof d === 'object' && d.previewUrl) {
      // The cache owns the preview URL now: it shows the new photo at once.
      primeAvatar(ownKey, sent.avatar, d.previewUrl)
      draftRef.current = undefined
      setDraftState(undefined)
    }
    const values = { name: sent.name, bio: sent.bio }
    if (Object.hasOwn(sent, 'avatar')) values.avatar = sent.avatar
    // The plain profile is reported by this save: nothing left to report.
    if (plainDoneRef.current) plainDoneRef.current = true
    onSaved(values)
  }

  const save = async () => {
    if (!valid || lockRef.current || editorRef.current || pickingRef.current) return
    lockRef.current = true
    setPhotoError('')
    // The draft this save works on; once a plain step of this save is public,
    // a stop with the draft gone or replaced (sheet closed, unmounted) still
    // tells the caller the name it saved. A stop with the draft kept (upload
    // failed) does not: the person retries or skips from the form.
    let cur = draftRef.current
    let plainNow = false
    let reported = false
    try {
      const c = currentRef.current
      const known = {
        name: plainDoneRef.current ? name : (c && c.name) || '',
        avatar: c && c.avatar ? c.avatar : null
      }
      let plan = planSave({ name, bio, draft: cur, current: known })
      if (plan.needsUpload && media === null) {
        setPhotoError('Envio de foto indisponível agora. Desbloqueie o aparelho e tente de novo.')
        return
      }
      if (plan.firstPlain) {
        const plain = { name, bio }
        const r = await action.run(() => node.request('profile.set', plain))
        if (!r.ok) {
          if (!r.uncertain || !(await recheck(plain))) return
          if (aliveRef.current) action.clearError()
        }
        plainDoneRef.current = plain
        plainNow = true
      }
      if (plan.needsUpload) {
        const d = draftRef.current
        if (d !== cur || !(d && typeof d === 'object' && d.encoded)) return
        let descriptor
        setUploading(true)
        try {
          descriptor = await media.upload({ bytes: d.encoded.bytes, mime: d.encoded.mime, width: AVATAR_SIDE, height: AVATAR_SIDE })
        } catch (err) {
          if (aliveRef.current && draftRef.current === d) setPhotoError('Não foi possível enviar a foto. ' + errorText(err))
          return
        } finally {
          if (aliveRef.current) setUploading(false)
        }
        // Closing the sheet mid-upload dropped the draft (and its URL).
        if (draftRef.current !== d) return
        const next = { ...d, descriptor }
        draftRef.current = next
        cur = next
        if (aliveRef.current) setDraftState(next)
        plan = planSave({ name, bio, draft: next, current: known })
      }
      const sent = plan.params
      const r = await action.run(() => node.request('profile.set', sent))
      if (r.ok) {
        reported = true
        finish(sent)
        return
      }
      if (r.uncertain && await recheck(sent)) {
        reported = true
        finish(sent)
      }
    } finally {
      lockRef.current = false
      if (plainNow && !reported && draftRef.current !== cur) {
        plainDoneRef.current = true
        onSaved({ name, bio })
      }
    }
  }

  const skip = () => {
    if (lockRef.current || pickingRef.current) return
    setDraft(undefined)
    // A plain profile already saved by a save whose photo upload failed is
    // reported, so skipping the photo still teaches the caller the name.
    const plain = plainDoneRef.current
    if (plain && typeof plain === 'object') onSaved(plain)
    else onSkip()
  }

  let photoLabel = null
  if (hasUpload) photoLabel = draftIsPhoto || (draft === undefined && knownAvatar) ? 'Trocar foto' : 'Escolher foto'
  let soft = hasUpload
    ? 'A foto do perfil é pública. Ela é recortada em quadrado e enviada sem dados de localização. Tirar a foto deixa de mostrá-la no app, mas a cópia enviada continua na rede.'
    : knownAvatar
      ? 'Este perfil tem foto. Aqui dá para tirar a foto; para mudar o nome ou a bio mantendo a foto, use a versão web.'
      : 'A foto do perfil pode ser colocada na versão web.'
  if (draft === null) soft = 'A foto sai quando você salvar.'

  const photo = (
    <View style={styles.photo}>
      <Avatar
        name={name}
        publicKey={ownKey || ''}
        size={88}
        persist
        picture={draft === null ? null : knownAvatar}
        localUri={draftIsPhoto ? draft.previewUrl : undefined}
      />
      <View ref={chooseRef}>
        <Row>
          {photoLabel !== null ? <Pill label={photoLabel} onPress={choose} disabled={locked} /> : null}
          {draft === undefined && knownAvatar ? <Pill label='Remover foto' danger onPress={() => setDraft(null)} disabled={locked} /> : null}
          {draftIsPhoto ? <Pill label='Descartar foto' onPress={() => setDraft(undefined)} disabled={locked} /> : null}
          {draft === null ? <Pill label='Manter foto' onPress={() => setDraft(undefined)} disabled={locked} /> : null}
        </Row>
      </View>
      <Soft>{soft}</Soft>
      <ErrorText>{photoError}</ErrorText>
    </View>
  )

  const fields = editor !== null
    ? (
      <AvatarEditor
        source={{ uri: editor.uri, width: editor.width, height: editor.height }}
        pending={editorPending}
        error={editorError}
        onCancel={closeEditor}
        onConfirm={confirmCrop}
      />
      )
    : (
      <>
        {photo}
        <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={setName} editable={!locked} />
        <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={setBio} editable={!locked} multiline lines={3} />
        <ErrorText>{action.error}</ErrorText>
      </>
      )

  if (embedded) {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page>
          {fields}
          <Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid || locked} />
          <Soft>Seu perfil novo aparece para todo mundo assim que for publicado.</Soft>
          {editor === null ? <ProfileVersions node={node} ownKey={ownKey} shown={shown} /> : null}
        </Page>
      </KeyboardAvoidingView>
    )
  }

  if (page) {
    return (
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page flush padBottom={16}>
          <Stepper index={index} total={total} title={STEP_TITLES.perfil} hint={STEP_HINTS.perfil}>
            {fields}
            <Pill label='Continuar' filled onPress={save} pending={saving} disabled={!valid || locked} />
            <Pressable
              accessibilityRole='button'
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={skip}
              hitSlop={4}
              style={styles.skip}
            >
              <Text style={styles.skipText}>Pular por enquanto</Text>
            </Pressable>
          </Stepper>
        </Page>
      </KeyboardAvoidingView>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title='Editar perfil'
      background={colors.bg}
      right={<Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid || locked} />}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page>
          {fields}
          <Soft>Seu perfil novo aparece para todo mundo assim que for publicado.</Soft>
          {editor === null ? <ProfileVersions node={node} ownKey={ownKey} shown={shown} /> : null}
        </Page>
      </KeyboardAvoidingView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  photo: { gap: 12, alignItems: 'flex-start' },
  versions: { gap: 8, marginTop: 8 },
  version: { gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  versionName: { fontSize: 16, fontWeight: '600', color: colors.ink },
  versionConfirm: { gap: 8 },
  skip: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 4, minHeight: 44, justifyContent: 'center' },
  skipText: { fontSize: 15, fontWeight: '600', color: colors.accent }
})
