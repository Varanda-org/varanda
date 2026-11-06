// Denunciar: the report sheet. A member reports another member's post, or the
// whole account, to the association's moderation. Only the hosted web-member
// session signs the statement, in the browser or in the native web kind (the
// worklet apps/app/worklet/web-node.js registers its handlers, report.sign
// included; packages/web-member/lib/session.js:1460). The core node and the
// CLI cannot sign (docs/verification.md:1025), and only a member whose Google
// account is linked may report (the account service refuses 'nao-vinculado').
// Flow: /account/status -> /account/report/start (nonce) -> report.sign ->
// /account/report. Nothing is stored: no localStorage, no diary write.
// `target` = { author, name, username, seq, text } with the RAW peer strings; they are
// rendered through displayText here (the PostRow rule). A group message adds
// { group, writer, private } (the text is then the one the reporter sees; for
// a private group, the locally decrypted one) and the sheet says what leaves
// the group before anything is sent.
// A private message: `target` = { dm: true, id, text, author } (author = the
// sender's diary key). Only that message and the sender's key leave the
// device, signed with dm.reportSign (docs/rpc.md 5.81).
// A message with photos or GIFs adds `media` (the raw item list of the
// dm.thread row, or of the group.read item). For a private message or a
// private group message the first image is opened from the device's own
// copy, re-encoded as JPEG (report.js prepareAnexo) and shown here as it will
// be sent; it goes to /account/report/anexo with its digest in the signed
// statement. Over the cap it is left out and the sheet says so. A public
// group post keeps pointing at the post, with no image attached.
// A voice note goes the same way, never re-encoded: its local copy is read
// as it is (media/reportAudio.*.js), checked with audioBounds and the same
// cap, and the sheet plays it (VoiceBubble) before anything is sent. In the
// background the player is released with the preview.

import { useEffect, useRef, useState } from 'react'
import { AppState, Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { accountStatus } from '../account'
import { ANEXO_AUDIO_NOTICE, ANEXO_AUDIO_TOO_BIG, ANEXO_AUDIO_UNAVAILABLE, ANEXO_NOTICE, ANEXO_TOO_BIG, ANEXO_UNAVAILABLE, NOT_LINKED_MESSAGE, REASONS, TEXT_MAX, anexoRef, isAudioItem, prepareAnexo, submitDmReport, submitReport, validateReportText, wellFormed } from '../report'
import { createChatMedia } from '../media/chatMedia'
import { revokeUrl, urlFromBytes } from '../media/display'
import { encodeReportImage } from '../media/reportImage'
import { readReportAudio } from '../media/reportAudio'
import { LABELS as DM_LABELS } from '../dm'
import { countChars } from '../format'
import { whoOf } from '../who'
import { HELP, SHORT } from '../help'
import { Btn, ErrorText, Field, Label, Soft, errorText, useAction } from '../ui'
import { HelpNote } from '../ui/Help'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'
import { VoiceBubble } from '../ui/VoiceBubble'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

const PRIVATE_GROUP_NOTICE = 'Este grupo é privado. Ao enviar, a moderação da associação vai ler o texto acima, que sai do grupo como a citação do denunciante. A associação não consegue ler o grupo, só o que você enviar aqui.'
const PUBLIC_GROUP_NOTICE = 'Este grupo é público. Ao enviar, a moderação da associação recebe o texto acima como citação do denunciante.'

const NOT_HOSTED_MESSAGE = 'Nesta versão, denúncias só pela versão web no site da associação.'
const ANEXO_LOADING = 'preparando a imagem…'
const ANEXO_AUDIO_LOADING = 'preparando o áudio…'
const NOTHING_TO_SEND = 'Sem texto e sem a imagem, esta mensagem não pode ser denunciada.'
const NOTHING_TO_SEND_AUDIO = 'Sem texto e sem o áudio, esta mensagem não pode ser denunciada.'

// Its own source, apart from the chat's: reading for a report never evicts
// or re-keys what the bubbles show. clearChatMedia (lock, sign-out) clears it
// too, and it holds one image at most.
const reportMedia = createChatMedia({ max: 1, concurrency: 1 })
const display = { urlFromBytes, revokeUrl }

export default function Denunciar ({ open, target, onClose, onSent }) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const hosted = node.hosted === true && node.passkey !== null
  const member = hosted && node.passkey.status ? node.passkey.status.publicKey : null
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [whole, setWhole] = useState(false)
  const [reason, setReason] = useState(null)
  const [note, setNote] = useState('')
  const send = useAction()
  const seqRef = useRef(0)
  // { status: 'none' | 'loading' | 'ok' | 'over' | 'unavailable', ... }
  const [anexo, setAnexo] = useState({ status: 'none' })
  const [preview, setPreview] = useState(null)

  // A new target (or reopening) starts a fresh form and a fresh status read.
  useEffect(() => {
    setWhole(false)
    setReason(null)
    setNote('')
    setStatus(null)
    setStatusError('')
    send.clearError()
    const mine = ++seqRef.current
    if (!open || target === null || !hosted || typeof member !== 'string') return
    accountStatus(member).then((s) => {
      if (mine === seqRef.current) setStatus(s)
    }, (err) => {
      if (mine === seqRef.current) setStatusError(errorText(err))
    })
  }, [open, target, hosted, member])

  const isDm = target !== null && target.dm === true && typeof target.author === 'string'
  const fromPost = !isDm && target !== null && target.seq !== null && target.seq !== undefined
  const postMode = fromPost && !whole
  const inGroup = fromPost && typeof target.group === 'string' && typeof target.writer === 'string'
  const ref = (isDm || (postMode && inGroup)) && open && hosted ? anexoRef(target) : null

  // Prepared when the sheet opens, before anything is sent: the person sees
  // the exact image that leaves the device. Local only (the node's copy and
  // the re-encode); the account service is reached only on 'enviar'.
  // In the background the decrypted preview is dropped (its file deleted,
  // its bytes zeroed) like every chat photo, and prepared again on return.
  const [awake, setAwake] = useState(true)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') setAwake(false)
      else if (state === 'active') setAwake(true)
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (ref === null || typeof member !== 'string' || !awake) {
      setAnexo({ status: 'none' })
      return
    }
    let live = true
    setAnexo({ status: 'loading' })
    prepareAnexo(ref, {
      source: (r) => reportMedia.sourceFor(r, { node, identity: member, display }),
      encode: encodeReportImage,
      readBytes: readReportAudio
    }).then((out) => { if (live) setAnexo(out) })
    return () => { live = false }
  }, [open, target, whole, hosted, member, awake])

  // The thumbnail is the re-encoded JPEG itself, not the chat's copy. A voice
  // note has none: it plays from the local copy whose bytes are sent.
  useEffect(() => {
    if (anexo.status !== 'ok' || anexo.kind === 'audio') {
      setPreview(null)
      return
    }
    let url = null
    try { url = urlFromBytes(anexo.bytes, 'image/jpeg') } catch {}
    setPreview(typeof url === 'string' ? { uri: url, width: anexo.width, height: anexo.height } : null)
    // Replaced (sent, closed, backgrounded): the preview file goes. The bytes
    // are left to the collector: a report already being sent still needs them.
    return () => { if (url !== null) revokeUrl(url) }
  }, [anexo])

  // The exact text that is signed and sent (lone surrogates normalized, D5).
  // A private message is quoted exactly as the sheet shows it, so the signed
  // quote never carries direction marks the reporter did not see.
  const quote = isDm
    ? displayText(wellFormed(target.text), { multiline: true })
    : postMode ? wellFormed(target.text) : ''
  const noteText = validateReportText(wellFormed(note))
  const attached = anexo.status === 'ok' ? { bytes: anexo.bytes, digest: anexo.digest } : null
  // dm.reportSign needs a quote or an image: a photo-only message whose
  // image cannot go has nothing to report.
  const nothing = isDm && quote === '' && attached === null && anexo.status !== 'loading'
  // Known before the bytes are read, so the loading line names it too.
  const audio = anexo.kind === 'audio' || (ref !== null && isAudioItem(ref.item))
  const shownName = target === null
    ? ''
    : displayText(whoOf({ name: target.name, username: target.username }).title)

  const submit = async () => {
    if (reason === null || noteText === null || target === null || typeof member !== 'string') return
    if (anexo.status === 'loading' || nothing) return
    // A close, a lock or a new target while this runs makes it stale: a stale
    // run stops before signing and before sending, not only before the toast.
    const mine = seqRef.current
    const r = await send.run(() => isDm
      ? submitDmReport({
        member,
        target: target.author,
        reason,
        text: noteText,
        quote,
        anexo: attached,
        sign: (params) => node.request('dm.reportSign', params),
        isStale: () => mine !== seqRef.current
      })
      // seq omitted (and quote empty) for a report of the whole account.
      : submitReport({
        member,
        target: target.author,
        seq: postMode ? target.seq : null,
        writer: postMode && inGroup ? target.writer : null,
        group: postMode && inGroup ? target.group : null,
        reason,
        text: noteText,
        quote,
        anexo: attached,
        sign: (params) => node.request('report.sign', params),
        isStale: () => mine !== seqRef.current
      }))
    if (r.ok && r.value !== null && mine === seqRef.current) onSent(r.value.duplicate ? 'você já tinha denunciado isso' : 'denúncia enviada')
  }

  let body
  if (!hosted) {
    body = <Soft>{NOT_HOSTED_MESSAGE}</Soft>
  } else if (statusError) {
    body = <ErrorText>{statusError}</ErrorText>
  } else if (status === null) {
    body = <Soft>carregando…</Soft>
  } else if (status.linked !== true) {
    body = <Soft>{NOT_LINKED_MESSAGE}</Soft>
  } else {
    body = (
      <>
        {isDm
          ? <Text style={styles.line}>Denunciar esta mensagem privada</Text>
          : (
            <Text style={styles.line}>
              {'Denunciar ' + (postMode ? 'a publicação de ' : 'a conta de ')}
              <Text style={styles.name}>{shownName}</Text>
            </Text>
            )}
        {fromPost
          ? (
            <View style={styles.pills}>
              <ChoicePill label='esta publicação' selected={!whole} onPress={() => setWhole(false)} />
              <ChoicePill label='a conta toda' selected={whole} onPress={() => setWhole(true)} />
            </View>
            )
          : null}
        {postMode || isDm
          ? (
            <View style={styles.quoteBox}>
              <Label>Texto que será enviado</Label>
              <Text style={styles.quote}>{quote === '' ? '(sem texto)' : displayText(quote, { multiline: true })}</Text>
              {anexo.status === 'ok' && anexo.kind === 'audio'
                ? <VoiceBubble state='ok' uri={anexo.uri} durationMs={anexo.ms} />
                : null}
              {preview !== null
                ? <Image source={{ uri: preview.uri }} style={[styles.thumb, { aspectRatio: preview.width / preview.height }]} resizeMode='contain' accessibilityLabel='Imagem que será enviada' />
                : null}
            </View>
            )
          : null}
        {anexo.status === 'loading' ? <Soft>{audio ? ANEXO_AUDIO_LOADING : ANEXO_LOADING}</Soft> : null}
        {anexo.status === 'ok' ? <Soft>{audio ? ANEXO_AUDIO_NOTICE : ANEXO_NOTICE}</Soft> : null}
        {anexo.status === 'over' ? <Soft>{audio ? ANEXO_AUDIO_TOO_BIG : ANEXO_TOO_BIG}</Soft> : null}
        {anexo.status === 'unavailable' ? <Soft>{audio ? ANEXO_AUDIO_UNAVAILABLE : ANEXO_UNAVAILABLE}</Soft> : null}
        {nothing ? <ErrorText>{audio ? NOTHING_TO_SEND_AUDIO : NOTHING_TO_SEND}</ErrorText> : null}
        {postMode && inGroup ? <Soft>{target.private === true ? PRIVATE_GROUP_NOTICE : PUBLIC_GROUP_NOTICE}</Soft> : null}
        {isDm ? <Soft>{DM_LABELS.reportNote}</Soft> : null}
        {!postMode && !isDm ? <Soft>Para denunciar o nome, a bio ou a foto do perfil, escolha a conta toda.</Soft> : null}
        <View style={styles.pills}>
          {REASONS.map(([id, label]) => (
            <ChoicePill key={id} label={label} selected={reason === id} onPress={() => setReason(id)} />
          ))}
        </View>
        {/* maxLength counts UTF-16 units and the limit is in characters
            (code points), so the input only caps at two units per character;
            the counter and validateReportText enforce TEXT_MAX. */}
        <Field label='observação (opcional)' value={note} onChangeText={setNote} maxLength={TEXT_MAX * 2} />
        <Text style={[styles.counter, noteText === null && styles.over]}>{String(countChars(note)) + '/' + String(TEXT_MAX)}</Text>
        <HelpNote doc={HELP.denuncia}><Soft>{SHORT.reportPrivacy}</Soft></HelpNote>
        <ErrorText>{send.error}</ErrorText>
        <Btn
          label='enviar denúncia'
          onPress={submit}
          pending={send.pending}
          disabled={reason === null || noteText === null || anexo.status === 'loading' || nothing}
        />
      </>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title='Denunciar'>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps='handled'>
        {body}
      </ScrollView>
    </Sheet>
  )
}

// A Pill whose wrapper carries the selection state (Pill sets only
// `disabled` in its own accessibilityState).
function ChoicePill ({ label, selected, onPress }) {
  return (
    <View accessibilityState={{ selected }}>
      <Pill label={label} filled={selected} onPress={onPress} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 12 },
  line: { ...type.postText, color: colors.ink },
  name: { fontWeight: '700' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quoteBox: { gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
  quote: { ...type.postText, color: colors.ink },
  thumb: { width: '100%', maxHeight: 240, borderRadius: 8, backgroundColor: colors.line },
  counter: { ...type.counter, color: colors.soft, alignSelf: 'flex-end' },
  over: { color: colors.danger }
})
