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
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { LOG_LIMIT_MAX, MAX_BIO, MAX_NAME, displayText, profileExtra } from '@varanda/rpc'
import { useNode } from '../node'
import { useNames } from '../names'
import { profileVersions } from '../deletion'
import { countChars, relativeTime } from '../format'
import { STEP_HINTS, STEP_TITLES } from '../onboarding'
import { pickImage } from '../media/attach'
import { openImage } from '../media/avatarEncode'
import { AVATAR_SIDE, MAX_AVATAR_BYTES, checkAvatarBytes } from '../media/avatar'
import { revokeDeletedMedia } from '../media/cache'
import { revokeUrl, urlFromBytes } from '../media/display'
import { confirmSaved, draftFor, planSave, startFields } from '../profileSave'
import { Btn, ConfirmStack, ErrorText, Field, Label, Page, Row, SectionHeader, Soft, errorText, useAction } from '../ui'
import { refusalOf } from '../wordCheck'
import { Avatar, primeAvatar } from '../ui/Avatar'
import { AvatarEditor } from '../ui/AvatarEditor'
import { Icon } from '../ui/Icon'
import { KeyboardLift } from '../ui/KeyboardLift'
import { Pill } from '../ui/Pill'
import { PressScale } from '../ui/PressScale'
import { useProfileExtra } from '../ui/AboutCard'
import { ThemePicker } from '../ui/ThemePicker'
import {
  MOODS, TEXTS, aboutMatches, aboutParams, canDelete, deleteAsk, deleteParams, deletedNote, draftAfterDelete, draftFromRecord, emptyAboutDraft,
  isNothingToDelete, moodDraftFromRecord, moodMatches, moodParams
} from '../profileExtraView'
import { Sheet, TEXT_CAP } from '../ui/Sheet'
import { useStyles, useTheme } from '../ui/ThemeProvider'
import { StepLink, Stepper } from '../ui/Stepper'

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

const { MAX_ABOUT, MAX_CITY, MAX_WORK, MAX_STUDIES, MAX_INTERESTS, MAX_MOOD_TEXT } = profileExtra

const revokeDraft = (d) => {
  if (d && typeof d === 'object' && d.previewUrl) {
    revokeUrl(d.previewUrl)
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
// Every form avoids the keyboard (../ui/KeyboardLift). Android only: that is
// where the form sits under the keyboard; the iOS page sheet is unchanged
// until it is checked on a device. A full-screen stack layer sits in the main
// window, so its measured top is right on iOS too (inWindow).
export function KeyboardForm ({ children, inWindow = false }) {
  return <KeyboardLift measured={inWindow || Platform.OS === 'android'}>{children}</KeyboardLift>
}

function ProfileVersions ({ node, ownKey, shown }) {
  const styles = useStyles(makeStyles)
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
        <SectionHeader flush>Versões do perfil</SectionHeader>
        <ErrorText>{loadError}</ErrorText>
        <Pill label='Tentar de novo' onPress={load} />
      </View>
    )
  }
  if (versions === null) return null
  if (versions.length === 0 && !done) return null
  return (
    <View style={styles.versions}>
      <SectionHeader flush>Versões do perfil</SectionHeader>
      {done ? <Soft>versão apagada</Soft> : null}
      {versions.map((v, i) => (
        <View key={v.seq} style={[styles.version, i > 0 && styles.versionRule]}>
          <View style={styles.versionRow}>
            <View style={styles.versionText}>
              <Text style={styles.versionName}>{displayText(v.name)}</Text>
              <Soft>{(i === 0 ? 'atual · ' : '') + (relativeTime(v.at) ?? displayText(String(v.at))) + (v.avatar ? ' · com foto' : '')}</Soft>
            </View>
            {confirm === v.seq
              ? null
              : <Pill icon='lixeira' danger tonal accessibilityLabel='Apagar versão' onPress={() => { action.clearError(); setDone(false); setConfirm(v.seq) }} disabled={action.pending} />}
          </View>
          {confirm === v.seq
            ? (
              <View style={styles.versionConfirm}>
                <Soft>Apagar esta versão do perfil? Ela some do seu diário e dos feeds de quem te segue. A cópia da foto enviada continua na rede.</Soft>
                <ConfirmStack
                  confirm={<Btn label='Apagar versão' danger onPress={() => remove(v)} pending={action.pending} />}
                  cancel={<Btn label='Cancelar' secondary onPress={() => { action.clearError(); setConfirm(null) }} disabled={action.pending} />}
                />
              </View>
              )
            : null}
        </View>
      ))}
      {partial ? <Soft>Mostrando só as versões mais recentes.</Soft> : null}
      <ErrorText>{action.error}</ErrorText>
    </View>
  )
}

// Sobre mim (profile.about) and Humor do dia (profile.mood), hosted nodes only.
// Each part is one write on its own button. The form starts from the author's
// own records, read from the own diary (never a seeder pointer, which could
// name an older version), and stays locked until they are read, so a form that
// started empty can never overwrite a record that was not read. An uncertain
// failure is said plainly and held for the person: 'Conferir' re-reads the
// profile and compares, nothing is resent by itself. 'Apagar sobre mim' and
// 'Apagar humor' (profile.extra.delete) withdraw every version of that record
// after a confirm; nothing left to delete counts as done.
function ProfileExtraEditor ({ node, ownKey, shown, onSaved, onDeleted }) {
  const styles = useStyles(makeStyles)
  const hosted = node.hosted === true
  const key = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
  const extra = useProfileExtra({ author: key, enabled: hosted && shown && key !== null, request: node.request, own: true })
  const aboutAction = useAction()
  const moodAction = useAction()
  const deleteAction = useAction()
  const [confirm, setConfirm] = useState(null)
  const [deleteCheck, setDeleteCheck] = useState(null)
  const [draft, setDraft] = useState(emptyAboutDraft)
  const [mood, setMood] = useState({ emoji: '', text: '' })
  const [aboutNote, setAboutNote] = useState('')
  const [moodNote, setMoodNote] = useState('')
  const [aboutCheck, setAboutCheck] = useState(null)
  const [moodCheck, setMoodCheck] = useState(null)
  const [checking, setChecking] = useState(false)
  const seeded = useRef(false)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // Seeded once per opening, when the records have been read.
  useEffect(() => {
    if (!shown) {
      seeded.current = false
      setAboutNote('')
      setMoodNote('')
      setAboutCheck(null)
      setMoodCheck(null)
      setConfirm(null)
      setDeleteCheck(null)
      aboutAction.clearError()
      moodAction.clearError()
      deleteAction.clearError()
      return
    }
    if (seeded.current || extra.status !== 'ready') return
    seeded.current = true
    setDraft(draftFromRecord(extra.held.about ? extra.held.about.record : null))
    setMood(moodDraftFromRecord(extra.held.mood ? extra.held.mood.record : null, Date.now()))
  }, [shown, extra.status, extra.held])

  if (!hosted || key === null) return null

  const ready = extra.status === 'ready' && seeded.current
  const busy = aboutAction.pending || moodAction.pending || deleteAction.pending || checking
  const locked = !ready || busy
  const about = aboutParams(draft)
  const moodPlan = moodParams(mood)
  const set = (field) => (value) => { setAboutNote(''); setDraft((d) => ({ ...d, [field]: value })) }
  const len = (v) => countChars(v)

  const publish = async (kind, plan, action, setNote, setCheck, done) => {
    if (!plan.ok || busy) return
    setNote('')
    setCheck(null)
    const method = kind === 'about' ? 'profile.about' : 'profile.mood'
    const r = await action.run(() => node.request(method, plan.params))
    if (!aliveRef.current) return
    if (r.ok) {
      const seq = r.value && Number.isSafeInteger(r.value.seq) ? r.value.seq : null
      if (seq !== null) {
        await extra.apply(kind, seq)
        if (typeof onSaved === 'function') onSaved(kind, seq)
      }
      if (aliveRef.current) setNote(done)
    } else if (r.uncertain) {
      setCheck(plan.params)
    }
  }
  const saveAbout = () => publish('about', about, aboutAction, setAboutNote, setAboutCheck, TEXTS.aboutSaved)
  const saveMood = () => publish('mood', moodPlan, moodAction, setMoodNote, setMoodCheck, TEXTS.moodSaved)

  // A delete that is settled (done, or nothing was left): the held record, the
  // form of that kind and the parent's copy all let go of it.
  const deleted = (kind) => {
    extra.drop(kind)
    if (typeof onDeleted === 'function') onDeleted(kind)
    const next = draftAfterDelete(kind, draft, mood)
    setDraft(next.about)
    setMood(next.mood)
    if (kind === 'about') { setAboutCheck(null); setAboutNote(deletedNote(kind)) } else { setMoodCheck(null); setMoodNote(deletedNote(kind)) }
    setDeleteCheck(null)
    setConfirm(null)
  }
  const remove = async (kind) => {
    const plan = deleteParams(kind)
    if (!plan.ok || busy) return
    const setNote = kind === 'about' ? setAboutNote : setMoodNote
    setNote('')
    setDeleteCheck(null)
    const r = await deleteAction.run(async () => {
      try {
        return await node.request('profile.extra.delete', plan.params)
      } catch (err) {
        if (isNothingToDelete(err)) return { seq: null, deleted: [] }
        throw err
      }
    })
    if (!aliveRef.current) return
    if (r.ok) deleted(kind)
    else if (r.uncertain) { setConfirm(null); setDeleteCheck(kind) }
  }
  const verifyDelete = async (kind) => {
    if (busy) return
    const setNote = kind === 'about' ? setAboutNote : setMoodNote
    setChecking(true)
    try {
      const held = await extra.check([kind])
      if (!aliveRef.current) return
      if (held === null) { setNote(TEXTS.checkFailed); return }
      if (held[kind]) { setNote(TEXTS.checkedNotDeleted); return }
      deleted(kind)
      setNote(TEXTS.checkedDeleted)
    } finally {
      if (aliveRef.current) setChecking(false)
    }
  }
  // The confirm, the uncertain 'Conferir' and the trigger of one kind.
  const deleteBlock = (kind) => {
    const label = kind === 'about' ? TEXTS.aboutDelete : TEXTS.moodDelete
    if (confirm === kind) {
      return (
        <View style={styles.versionConfirm}>
          <Soft>{deleteAsk(kind)}</Soft>
          <ConfirmStack
            confirm={<Btn label={TEXTS.deleteConfirm} danger onPress={() => remove(kind)} pending={deleteAction.pending} />}
            cancel={<Btn label={TEXTS.deleteCancel} secondary onPress={() => { deleteAction.clearError(); setConfirm(null) }} disabled={deleteAction.pending} />}
          />
        </View>
      )
    }
    if (deleteCheck === kind) return <Pill label={TEXTS.check} onPress={() => verifyDelete(kind)} pending={checking} disabled={busy} />
    if (!canDelete(extra.held, kind)) return null
    return <Pill label={label} danger icon='lixeira' onPress={() => { deleteAction.clearError(); setConfirm(kind) }} disabled={locked} />
  }

  const verify = async (kind, params, setNote, setCheck) => {
    if (busy) return
    setChecking(true)
    try {
      const held = await extra.check()
      if (!aliveRef.current) return
      if (held === null) { setNote(TEXTS.checkFailed); return }
      const record = held[kind] ? held[kind].record : null
      const same = kind === 'about' ? aboutMatches(params, record) : moodMatches(params, record)
      setNote(same ? TEXTS.checkedSame : TEXTS.checkedDiffers)
      if (same) setCheck(null)
    } finally {
      if (aliveRef.current) setChecking(false)
    }
  }

  const aboutLen = len(draft.about)
  return (
    <View style={styles.extra}>
      <SectionHeader flush>{TEXTS.aboutTitle}</SectionHeader>
      {extra.status === 'failed' || extra.status === 'unsure'
        ? (
          <>
            <Soft>{extra.status === 'failed' ? 'Não deu para ler o seu perfil agora.' : 'Não deu para ler o seu diário inteiro agora.'}</Soft>
            <Pill label='Tentar de novo' onPress={() => extra.reload()} />
          </>
          )
        : null}
      <Field label={TEXTS.aboutTitle + ' (' + aboutLen + '/' + MAX_ABOUT + ')'} value={draft.about} onChangeText={set('about')} editable={!locked} multiline lines={4} />
      <Field label={'Cidade (' + len(draft.city) + '/' + MAX_CITY + ')'} value={draft.city} onChangeText={set('city')} editable={!locked} />
      <Field label={'Trabalho (' + len(draft.work) + '/' + MAX_WORK + ')'} value={draft.work} onChangeText={set('work')} editable={!locked} />
      <Field label={'Estudos (' + len(draft.studies) + '/' + MAX_STUDIES + ')'} value={draft.studies} onChangeText={set('studies')} editable={!locked} />
      <Field label={'Interesses (' + len(draft.interests) + '/' + MAX_INTERESTS + ')'} value={draft.interests} onChangeText={set('interests')} editable={!locked} />
      <Field label='Aniversário (dia/mês, sem ano)' value={draft.birthday} onChangeText={set('birthday')} editable={!locked} placeholder='15/03' plain />
      <Label>{TEXTS.themeTitle}</Label>
      <ThemePicker value={draft.theme} onChange={(id) => { setAboutNote(''); setDraft((d) => ({ ...d, theme: id })) }} disabled={locked} />
      <ErrorText>{about.error}</ErrorText>
      <ErrorText>{aboutAction.error}</ErrorText>
      {confirm === 'about' || deleteCheck === 'about' ? <ErrorText>{deleteAction.error}</ErrorText> : null}
      {aboutNote ? <Soft>{aboutNote}</Soft> : null}
      <Pill label={TEXTS.aboutSave} filled onPress={saveAbout} pending={aboutAction.pending} disabled={locked || !about.ok} />
      {aboutCheck !== null ? <Pill label={TEXTS.check} onPress={() => verify('about', aboutCheck, setAboutNote, setAboutCheck)} pending={checking} disabled={busy} /> : null}
      {deleteBlock('about')}

      <SectionHeader flush>{TEXTS.moodTitle}</SectionHeader>
      <Soft>{TEXTS.moodHint}</Soft>
      <View style={styles.moods}>
        {MOODS.map((m) => {
          const on = mood.emoji === m.e
          return (
            <PressScale
              key={m.e}
              accessibilityRole='button'
              accessibilityLabel={'Humor ' + m.name}
              accessibilityState={{ selected: on }}
              disabled={locked}
              onPress={() => { setMoodNote(''); setMood((v) => ({ ...v, emoji: on ? '' : m.e })) }}
              style={[styles.mood, on && styles.moodOn, locked && styles.moodOff]}
            >
              <Text style={styles.moodEmoji}>{m.e}</Text>
            </PressScale>
          )
        })}
      </View>
      <Field label={'Humor em palavras (' + len(mood.text) + '/' + MAX_MOOD_TEXT + ')'} value={mood.text} onChangeText={(v) => { setMoodNote(''); setMood((m) => ({ ...m, text: v })) }} editable={!locked} />
      <ErrorText>{moodPlan.error}</ErrorText>
      <ErrorText>{moodAction.error}</ErrorText>
      {confirm === 'mood' || deleteCheck === 'mood' ? <ErrorText>{deleteAction.error}</ErrorText> : null}
      {moodNote ? <Soft>{moodNote}</Soft> : null}
      <Pill label={TEXTS.moodPublish} filled onPress={saveMood} pending={moodAction.pending} disabled={locked || !moodPlan.ok || moodPlan.clears} />
      {moodCheck !== null ? <Pill label={TEXTS.check} onPress={() => verify('mood', moodCheck, setMoodNote, setMoodCheck)} pending={checking} disabled={busy} /> : null}
      {deleteBlock('mood')}
    </View>
  )
}

export default function Perfil ({ open, current, onClose, onSaved, onExtraSaved, onExtraDeleted, ownKey, page = false, embedded = false, index, total, onSkip }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const action = useAction()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  // What the person typed and has not saved: closing the sheet keeps it, a
  // successful save (or a plain profile reported on close) clears it.
  const textDraftRef = useRef(null)
  const editName = (value) => {
    textDraftRef.current = { ...draftFor(textDraftRef.current, ownKey), key: ownKey, name: value }
    setName(value)
  }
  const editBio = (value) => {
    textDraftRef.current = { ...draftFor(textDraftRef.current, ownKey), key: ownKey, bio: value }
    setBio(value)
  }
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

  // The form starts from the kept text draft, else from `current`, each time
  // the sheet opens; a reload while it is open never overwrites the draft.
  // Closing drops the photo draft but keeps the typed name and bio.
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
        textDraftRef.current = null
        onSaved(plain)
      }
      return
    }
    const start = startFields(draftFor(textDraftRef.current, ownKey), currentRef.current)
    setName(start.name)
    setBio(start.bio)
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
  const refused = refusalOf(name, bio)
  const valid = nameLen >= 1 && nameLen <= MAX_NAME && name.trim() !== '' && bioLen <= MAX_BIO && refused === ''
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
    let previewUrl
    try {
      previewUrl = urlFromBytes(encoded.bytes, encoded.mime)
    } catch {
      setEditorError('não foi possível preparar a foto')
      setEditorPending(false)
      return
    }
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
    textDraftRef.current = null
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
      ? 'Este perfil tem foto. Aqui dá para tirar a foto, ou mudar o nome e a bio mantendo a foto.'
      : 'A foto do perfil não pode ser colocada neste momento.'
  if (draft === null) soft = 'A foto sai quando você salvar.'

  const PhotoRow = page ? View : Row
  const photo = (
    <View style={page ? styles.photoPage : styles.photo}>
      <Avatar
        name={name}
        publicKey={ownKey || ''}
        size={88}
        persist
        picture={draft === null ? null : knownAvatar}
        localUri={draftIsPhoto ? draft.previewUrl : undefined}
      />
      <View ref={chooseRef}>
        <PhotoRow style={page ? styles.photoActions : undefined}>
          {photoLabel !== null ? <Pill label={photoLabel} onPress={choose} disabled={locked} /> : null}
          {draft === undefined && knownAvatar ? <Pill label='Remover foto' danger onPress={() => setDraft(null)} disabled={locked} /> : null}
          {draftIsPhoto ? <Pill label='Descartar foto' onPress={() => setDraft(undefined)} disabled={locked} /> : null}
          {draft === null ? <Pill label='Manter foto' onPress={() => setDraft(undefined)} disabled={locked} /> : null}
        </PhotoRow>
      </View>
      {!page || !hasUpload || draft === null ? <Soft style={page ? styles.photoHint : undefined}>{soft}</Soft> : null}
      <ErrorText>{photoError}</ErrorText>
    </View>
  )

  const inputs = (
    <>
      <Field label={'Nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={editName} editable={!locked} />
      <Field label={'Bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={editBio} editable={!locked} multiline lines={3} />
      <ErrorText>{refused}</ErrorText>
      <ErrorText>{action.error}</ErrorText>
    </>
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
        {inputs}
      </>
      )

  if (embedded) {
    return (
      <KeyboardForm>
        <Page>
          {fields}
          {/* The open photo editor has its own Cancelar and Usar foto. */}
          {editor === null
            ? (
              <>
                <Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid || locked} />
                <Soft>Seu perfil novo aparece para todo mundo assim que for publicado.</Soft>
                <ProfileExtraEditor node={node} ownKey={ownKey} shown={shown} onSaved={onExtraSaved} onDeleted={onExtraDeleted} />
                <ProfileVersions node={node} ownKey={ownKey} shown={shown} />
              </>
              )
            : null}
        </Page>
      </KeyboardForm>
    )
  }

  if (page) {
    return (
      <KeyboardForm>
        <Page flush grow padBottom={16}>
          <Stepper index={index} total={total} title={STEP_TITLES.perfil} hint={STEP_HINTS.perfil} hero={editor === null ? photo : null}>
            {editor !== null ? fields : inputs}
            {editor === null
              ? (
                <>
                  <Btn label='Continuar' block large onPress={save} pending={saving} disabled={!valid || locked} />
                  <StepLink label='Pular por enquanto' onPress={skip} disabled={locked} />
                </>
                )
              : null}
          </Stepper>
        </Page>
      </KeyboardForm>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      // Android back in the photo editor closes only the editor, as the
      // header chevron does, not the sheet with its draft.
      onBack={editor !== null ? closeEditor : undefined}
      title='Editar perfil'
      background={colors.bg}
      // While the photo editor is open its own Cancelar / Usar foto are the
      // only actions: a header Cancelar would drop the whole draft instead.
      left={editor !== null
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel='voltar ao perfil' onPress={closeEditor} hitSlop={8} style={styles.editorBack}>
            <Icon name='voltar' size={24} color={colors.ink} />
          </Pressable>
          )
        : undefined}
      right={editor !== null ? null : <Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid || locked} maxFontSizeMultiplier={TEXT_CAP} />}
    >
      <KeyboardForm>
        <Page>
          {fields}
          {editor === null
            ? (
              <>
                <Soft>Seu perfil novo aparece para todo mundo assim que for publicado.</Soft>
                <ProfileExtraEditor node={node} ownKey={ownKey} shown={shown} onSaved={onExtraSaved} onDeleted={onExtraDeleted} />
                <ProfileVersions node={node} ownKey={ownKey} shown={shown} />
              </>
              )
            : null}
        </Page>
      </KeyboardForm>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  // Same place as the Ajustes back chevron.
  editorBack: { minWidth: 40, minHeight: 40, justifyContent: 'center', marginLeft: -8 },
  fill: { flex: 1 },
  photo: { gap: 12, alignItems: 'flex-start' },
  photoPage: { gap: 12, alignItems: 'center' },
  photoActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'center' },
  photoHint: { textAlign: 'center' },
  extra: { gap: 12, marginTop: 8 },
  moods: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mood: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.line, backgroundColor: colors.card },
  moodOn: { borderColor: colors.accent, backgroundColor: colors.warm },
  moodOff: { opacity: 0.5 },
  moodEmoji: { fontSize: 22, lineHeight: 28 },
  versions: { gap: 8, marginTop: 8 },
  // The header draws the rule above the first version.
  version: { gap: 4, paddingVertical: 8 },
  versionRule: { borderTopWidth: 1, borderTopColor: colors.line },
  // The trash icon sits beside the version, so a red full-width button does not compete with Salvar.
  versionRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  versionText: { flex: 1, gap: 4 },
  versionName: { fontSize: 16, fontWeight: '600', color: colors.ink },
  versionConfirm: { gap: 8 }
})
