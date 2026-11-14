// "Página pública na web" for the member's own post (docs/rpc.md 5.121 to
// 5.123). It reads whether the post is published, asks before publishing,
// and after a write says only that it was sent: the node reports what this
// device wrote, not that the seeder holds it. Publishing never opens a share
// dialog; Compartilhar and Copiar link act only on their own tap. The caller
// passes the post's colon ref (`target`) and its public link (`link`).

import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { publish, readShared, unpublish } from '../postShare'
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
const COPIED = 'Link copiado.'
const COPY_FAILED = 'Não deu para copiar. Selecione o link acima para copiar.'

const LOADING = { phase: 'loading', note: '', error: '' }

// phase: 'loading', 'off', 'on' or 'unknown' (no action is offered while the
// state is not known: the person closes and opens the sheet again).
export function PostShareSheet ({ open, target, link, onClose }) {
  const { request } = useNode()
  const [view, setView] = useState(LOADING)
  const [busy, setBusy] = useState(false)
  const [linkNote, setLinkNote] = useState('')
  const busyRef = useRef(false)
  // Each opening (and each target) is a turn: an answer from an older one is
  // dropped.
  const turn = useRef(0)

  useEffect(() => {
    const mine = ++turn.current
    setView(LOADING)
    setLinkNote('')
    if (!open || typeof target !== 'string' || typeof request !== 'function') return
    readShared(request, target).then((r) => {
      if (turn.current !== mine) return
      if (r.state === 'on' || r.state === 'off') setView({ phase: r.state, note: '', error: '' })
      else if (r.state === 'uncertain') setView({ phase: 'unknown', note: r.message, error: '' })
      else setView({ phase: 'unknown', note: '', error: r.message })
    })
    return () => { turn.current++ }
  }, [open, target, request])

  // One write at a time, never repeated: a failure only shows its words.
  const write = (action) => async () => {
    if (busyRef.current || typeof target !== 'string' || typeof request !== 'function') return
    busyRef.current = true
    setBusy(true)
    setLinkNote('')
    setView((v) => ({ ...v, note: '', error: '' }))
    const mine = turn.current
    let r
    try {
      r = await action(request, target)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
    if (turn.current !== mine) return
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

  return (
    <Sheet open={open} onClose={onClose} title={POST_SHARE_TITLE} dismissable={!busy}>
      {/* Scrolls when large text makes the sheet taller than the screen. */}
      <ScrollView contentContainerStyle={styles.body}>
        {view.phase === 'loading' ? <View style={styles.loading}><Spinner /></View> : null}
        {view.note ? <Soft>{view.note}</Soft> : null}
        <ErrorText>{view.error}</ErrorText>
        {view.phase === 'off'
          ? (
            <>
              <Soft>{POST_SHARE_CONSENT}</Soft>
              <Btn block large label='Publicar na web' pending={busy} disabled={busy} onPress={write(publish)} />
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
              <Btn block large secondary label='Tirar da web' pending={busy} disabled={busy} onPress={write(unpublish)} />
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
