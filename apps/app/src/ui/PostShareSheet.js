// "Página pública na web" for the member's own post (docs/rpc.md 5.121 to
// 5.123). It reads whether the post is published, asks before publishing,
// and after a write says only that it was sent: the node reports what this
// device wrote, not that the seeder holds it. Publishing never opens a share
// dialog; Compartilhar and Copiar link act only on their own tap. The caller
// passes the post's colon ref (`target`) and its public link (`link`), and may
// pass `notice`, taken at the opening and shown with the first read
// (firstReadView): a 'sent' notice never stands next to the offer to publish.
// A post already on the web with no cover, whose first still a crawler would
// drop (shareCover.js needsCover), gets one row: 'Adicionar uma capa à
// prévia'. Only its tap builds the cover from the stored still, uploads it
// and sends one post.cover (a Page: one 'post-cover'); nothing is written
// without that tap and nothing is retried. A failed download keeps the row
// for another tap; while an attempt for the post runs (this sheet's or one a
// closed sheet left going), the row is not offered. Only a node with an installation
// offers it (post.cover is the browser node's, docs/rpc.md 5.167).

import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { addCover, claimCover, coverInFlight, coverRowAfterWrite, coverRowStays, publish, readShared, releaseCover, sendCover, unpublish } from '../postShare'
import { firstReadView } from '../postShareCompose'
import { coverAsPage, pageSeqOf } from '../pageShare'
import { pagesPostCover, pagesUploadEncoded } from '../pages'
import { needsCover } from '../media/shareCover'
import { encodeThumbnail } from '../media/encode'
import { fetchMedia } from '../media/fetch'
import { isAppClient } from '../appClient'
import { diaryPeekSlots } from '../engagement'
import { memberKeyOf } from '../screens/Conversa'
import { fetch as expoFetch } from 'expo/fetch'
import { mediaHashDeps } from './MediaView'
import { canShare, copyText, shareUrl } from '../share'
import { shareNav } from '../shareNav'
import { Sheet } from './Sheet'
import { Btn, ErrorText, Mono, Soft, Spinner } from './index'
import { space } from './theme'

export const POST_SHARE_TITLE = 'Página pública na web'
export const POST_SHARE_CONSENT = 'Qualquer pessoa na web vai poder ver esta publicação, mesmo sem conta, e quem conhece o seu perfil pode encontrá-la. Você pode desfazer quando quiser. Cópias que outras pessoas já fizeram ficam fora do nosso alcance.'
export const POST_SHARE_ON = 'Esta publicação está liberada na web para qualquer pessoa, mesmo sem conta.'
export const POST_SHARE_SENT = 'Enviado para a web. Se o link ainda não mostrar a publicação, tente de novo em instantes.'
export const POST_SHARE_WITHDRAWN = 'Pedido enviado para tirar da web. Cópias já feitas ficam fora do nosso alcance.'
export const POST_SHARE_ADD_COVER = 'Adicionar uma capa à prévia'
const COPIED = 'Link copiado.'
const COPY_FAILED = 'Não deu para copiar. Selecione o link acima para copiar.'

const LOADING = { phase: 'loading', note: '', error: '' }

const mediaFetch = () => (isAppClient() ? expoFetch : undefined)
// A stalled read of the stored still would hold busyRef, and with it
// "Tirar da web", for as long as the sheet stays mounted.
const COVER_FETCH_MS = 30000

// The post record at `ref` ('<author>:<seq>'), read once, or null.
async function readPost (request, ref) {
  const author = ref.slice(0, 64).toLowerCase()
  const seq = Number(ref.slice(65))
  const peek = await diaryPeekSlots.run(() => request('diary.peek', { author, seqs: [seq] }), { front: true })
  const entry = peek && Array.isArray(peek.entries) ? peek.entries.find((e) => e && e.seq === seq) : null
  return entry && entry.record && entry.record.type === 'post' ? entry.record : null
}

// phase: 'loading', 'off', 'on' or 'unknown' (no action is offered while the
// state is not known: the person closes and opens the sheet again).
// `ops` (optional, pageShare.js pageShareOps) is a Page's: read from the page's
// status, write through the page actions, instead of the person's post.* methods.
export function PostShareSheet ({ open, target, link, notice = '', ops = null, onClose }) {
  const node = useNode()
  const { request, hosted } = node
  const nodeRef = useRef(node)
  nodeRef.current = node
  const [view, setView] = useState(LOADING)
  const [busy, setBusy] = useState(false)
  const [linkNote, setLinkNote] = useState('')
  // The cover row: the post record while it is offered, then the words of
  // the one attempt this opening made.
  const [coverPost, setCoverPost] = useState(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [coverNote, setCoverNote] = useState('')
  const busyRef = useRef(false)
  const noticeRef = useRef(notice)
  noticeRef.current = notice
  // Each opening (and each target) is a turn: an answer from an older one is
  // dropped.
  const turn = useRef(0)
  // The cover tap's download, aborted when the turn ends.
  const coverAbort = useRef(null)

  useEffect(() => {
    const mine = ++turn.current
    const lead = noticeRef.current
    setView(LOADING)
    setLinkNote('')
    setCoverPost(null)
    setCoverNote('')
    if (!open || typeof target !== 'string' || typeof request !== 'function') return
    const read = ops !== null ? ops.read : (t) => readShared(request, t)
    read(target).then(async (r) => {
      if (turn.current !== mine) return
      setView(firstReadView(lead, r))
      // A Page's older service sends no `covered` (cover null): no offer.
      if (hosted !== true || r.state !== 'on' || r.cover !== false) return
      let post = null
      try {
        post = await readPost(request, target)
      } catch {}
      if (turn.current === mine && post !== null && needsCover(post) && !coverInFlight(target)) setCoverPost(post)
    })
    return () => {
      turn.current++
      if (coverAbort.current !== null) coverAbort.current.abort()
    }
  }, [open, target, request, ops, hosted])

  // The one cover attempt of this opening, on the person's tap only.
  const addCoverTap = async () => {
    const post = coverPost
    if (busyRef.current || post === null || typeof target !== 'string') return
    // Held until the attempt settles, past this sheet's closing.
    if (!claimCover(target)) return
    const ref = target
    busyRef.current = true
    setCoverBusy(true)
    setCoverNote('')
    const mine = turn.current
    const n = nodeRef.current
    const author = target.slice(0, 64).toLowerCase()
    const page = ops !== null ? ops.page : null
    const member = () => memberKeyOf(n.request, n)
    const upload = page !== null
      ? async (b) => pagesUploadEncoded(n, { member: await member(), page, encoded: b })
      : (b) => n.media.upload({ bytes: b.bytes, mime: b.mime, width: b.width, height: b.height })
    const setCover = page !== null
      ? (image) => coverAsPage(async (op) => pagesPostCover(n, { member: await member(), page, op }), pageSeqOf(page, target), image)
      : (image) => addCover(n.request, target, image)
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    coverAbort.current = ctrl
    const timer = ctrl !== null ? setTimeout(() => ctrl.abort(), COVER_FETCH_MS) : null
    let r
    try {
      r = await sendCover({
        post,
        fetchStill: (d) => fetchMedia(author, d, { ...mediaHashDeps(), fetch: mediaFetch(), persist: false, signal: ctrl !== null ? ctrl.signal : null }),
        encodeThumbnail,
        upload,
        setCover
      })
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (coverAbort.current === ctrl) coverAbort.current = null
      releaseCover(ref)
      busyRef.current = false
      setCoverBusy(false)
    }
    if (turn.current !== mine) return
    if (!coverRowStays(r)) setCoverPost(null)
    setCoverNote(r.message)
  }

  // One write at a time, never repeated: a failure only shows its words.
  const write = (action) => async () => {
    if (busyRef.current || typeof target !== 'string' || typeof request !== 'function') return
    busyRef.current = true
    setBusy(true)
    setLinkNote('')
    setCoverNote('')
    setView((v) => ({ ...v, note: '', error: '' }))
    const mine = turn.current
    let r
    try {
      r = await (ops !== null ? ops[action] : (t) => (action === 'publish' ? publish : unpublish)(request, t))(target)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
    if (turn.current !== mine) return
    if (!coverRowAfterWrite(r)) setCoverPost(null)
    if (r.state === 'on') setView({ phase: 'on', note: POST_SHARE_SENT, error: '' })
    else if (r.state === 'off') setView({ phase: 'off', note: POST_SHARE_WITHDRAWN, error: '' })
    else if (r.state === 'uncertain') setView({ phase: 'unknown', note: r.message, error: '' })
    else setView((v) => ({ ...v, note: '', error: r.message }))
  }

  const nav = shareNav()
  const hasLink = typeof link === 'string' && link !== ''
  // shareUrl and copyText are called before any await in these handlers, so
  // the browser still sees the tap.
  const copy = () => {
    if (!hasLink) return
    setLinkNote('')
    copyText(nav, link).then((ok) => setLinkNote(ok ? COPIED : COPY_FAILED))
  }
  const share = () => {
    if (!hasLink) return
    setLinkNote('')
    shareUrl(nav, { url: link, title: 'Varanda' }).then((outcome) => {
      if (outcome === 'failed') return copyText(nav, link).then((ok) => setLinkNote(ok ? COPIED : COPY_FAILED))
    })
  }

  // A cover attempt holds the sheet like a publish does: "Tirar da web" waits
  // for it instead of a tap that does nothing.
  const writing = busy || coverBusy
  return (
    <Sheet open={open} onClose={onClose} title={POST_SHARE_TITLE} dismissable={!writing}>
      {/* Scrolls when large text makes the sheet taller than the screen. */}
      <ScrollView contentContainerStyle={styles.body}>
        {view.phase === 'loading' ? <View style={styles.loading}><Spinner /></View> : null}
        {view.note ? <Soft>{view.note}</Soft> : null}
        <ErrorText>{view.error}</ErrorText>
        {view.phase === 'off'
          ? (
            <>
              <Soft>{POST_SHARE_CONSENT}</Soft>
              <Btn block large label='Publicar na web' pending={busy} disabled={writing} onPress={write('publish')} />
            </>
            )
          : null}
        {view.phase === 'on'
          ? (
            <>
              {/* Right after a publish the node knows only what it wrote:
                  the sent note stands alone until the sheet reads again. */}
              {view.note !== POST_SHARE_SENT ? <Soft>{POST_SHARE_ON}</Soft> : null}
              {hasLink ? <Mono>{displayText(link)}</Mono> : null}
              {hasLink && canShare(nav) ? <Btn block large label='Compartilhar' disabled={busy} onPress={share} /> : null}
              {hasLink ? <Btn block large secondary label='Copiar link' disabled={busy} onPress={copy} /> : null}
              {linkNote ? <Soft>{linkNote}</Soft> : null}
              {coverPost !== null && (ops !== null ? ops.page !== null : node.media !== null)
                ? <Btn block large secondary label={POST_SHARE_ADD_COVER} pending={coverBusy} disabled={busy || coverBusy} onPress={addCoverTap} />
                : null}
              {coverNote ? <Soft>{coverNote}</Soft> : null}
              <Btn block large secondary label='Tirar da web' pending={busy} disabled={writing} onPress={write('unpublish')} />
            </>
            )
          : null}
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  loading: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }
})
