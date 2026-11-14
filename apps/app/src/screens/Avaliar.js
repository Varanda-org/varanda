// Avaliar: rate a listing after its author accepted an offer (stack entry
// 'avaliar', params.offer the 32-hex offer id). The consent is not stored
// anywhere: the screen re-reads the conversation with the seller (dm.thread,
// a bounded number of pages) and folds it with ../feiraOffer offerState. The
// form shows only when ../feiraReview canRate holds for that same offer.
//
// Stars 1 to 5 (required) and a text of up to 280 characters. listing.rate
// goes out once per press; an unknown outcome locks the form until 'Tentar
// de novo' (the same signed request) or 'Descartar'. A page does not rate in
// v1.
//
// Props: author, seq (the listing), offer (offer id), me (own key),
// actingPage (page key or null), onBack, onRated({ answer, author, seq }).

import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { byAuthor } from '../feiraClient'
import { pickListing } from '../feiraCompose'
import { offerState } from '../feiraOffer'
import { NOT_PAYMENT, canRate, rateParams, starsLabel } from '../feiraReview'
import { installationOrigin } from '../installation'
import { Btn, ErrorText, Field, Soft, Spinner, errorText } from '../ui'
import { refusalOf } from '../wordCheck'
import { TopBar } from '../ui/TopBar'
import { Icon } from '../ui/Icon'
import { tap } from '../ui/haptics'
import { type } from '../ui/theme'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const { feira } = rpc

const HEX32 = /^[0-9a-f]{32}$/
const MAX_LOAD_PAGES = 5
// Pages of the conversation read to find the offer and its aceite.
const MAX_THREAD_PAGES = 4
const CANNOT_RATE = 'Esta oferta não pode ser avaliada agora.'
const PAGE_NO_RATE = 'Uma página não avalia anúncios por enquanto. Para avaliar, use o seu perfil.'
const UNKNOWN_RATING = 'Não sabemos se a avaliação foi publicada. Confira o anúncio antes de avaliar de novo.'
const STARS = [1, 2, 3, 4, 5]

// The newest pages of the thread with `peer`, oldest first, as offerState
// reads them.
async function readThread (request, peer) {
  let messages = []
  let before = null
  for (let i = 0; i < MAX_THREAD_PAGES; i++) {
    const r = await request('dm.thread', before === null ? { peer } : { peer, before })
    const page = r && Array.isArray(r.messages) ? r.messages : []
    messages = [...page.map((m) => ({ id: m.id, from: m.from, mine: m.mine === true, text: m.text, card: m.card || null, replyTo: m.replyTo || null, at: m.at, deleted: m.deleted === true })), ...messages]
    if (!r || typeof r.next !== 'string') break
    before = r.next
  }
  return messages
}

async function findListing (request, author, seq) {
  let cursor = null
  for (let i = 0; i < MAX_LOAD_PAGES; i++) {
    const r = await byAuthor(request, author, cursor)
    if (!r.ok) return null
    const hit = pickListing(r.items, seq)
    if (hit) return hit
    if (r.next === null || r.next === undefined) return null
    cursor = r.next
  }
  return null
}

export default function Avaliar ({ author, seq, offer: offerId, me = null, actingPage = null, onBack, onRated }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const nodeRef = useRef(node)
  nodeRef.current = node
  const origin = installationOrigin() || globalThis.location?.origin || null
  const asPage = typeof actingPage === 'string' && actingPage !== ''
  const listing = { author, seq }

  const [offer, setOffer] = useState(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [stars, setStars] = useState(0)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [error, setError] = useState('')
  // An uncertain send: { retry }. Only a press calls retry.
  const [pending, setPending] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    if (asPage || typeof author !== 'string' || !Number.isSafeInteger(seq) || typeof me !== 'string' || !HEX32.test(offerId || '')) {
      setLoading(false)
      return undefined
    }
    let live = true
    setLoading(true)
    setLoadError('')
    const request = nodeRef.current.request
    Promise.all([
      readThread(request, author),
      findListing(request, author, seq).catch(() => null)
    ]).then(([messages, found]) => {
      if (!live) return
      setOffer(offerState(messages, me, { author, seq }, origin))
      setTitle(found && typeof found.title === 'string' ? found.title : '')
    }, (err) => {
      if (live) setLoadError(errorText(err))
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [author, seq, me, offerId, asPage, origin])

  const ratable = !asPage && offer !== null && offer.id === offerId && canRate({ offer, listing, me })
  const online = node.online !== false
  const locked = pending !== null || sending

  const settle = (answer) => {
    setPending(null)
    // A screen left before the answer must not pop whatever is on top now.
    if (alive.current && typeof onRated === 'function') onRated({ answer, author, seq })
  }

  const send = async () => {
    if (sendingRef.current || pending !== null) return
    const refused = refusalOf(text)
    if (refused !== '') {
      setError(refused)
      return
    }
    const params = rateParams({ offer, listing, me, stars, text })
    if (params === null) {
      setError(feira.isStars(stars) ? 'Confira o texto da avaliação.' : 'Escolha de 1 a 5 estrelas.')
      return
    }
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      settle(await nodeRef.current.request('listing.rate', params))
    } catch (err) {
      setError(errorText(err))
      if (err && err.uncertain === true) setPending({ retry: typeof err.retry === 'function' ? err.retry : null })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const retry = async () => {
    if (sendingRef.current || !pending || typeof pending.retry !== 'function') return
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      settle(await pending.retry())
    } catch (err) {
      setError(errorText(err))
      // A refusal ends the pending send; an unknown outcome keeps it.
      if (!(err && err.uncertain === true)) setPending(null)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const discard = () => {
    if (sending) return
    setPending(null)
    setError('')
  }

  let body
  if (asPage) {
    body = <Soft>{PAGE_NO_RATE}</Soft>
  } else if (loading) {
    body = <View style={styles.center}><Spinner /></View>
  } else if (loadError !== '') {
    body = <ErrorText>{loadError}</ErrorText>
  } else if (!ratable) {
    body = (
      <>
        <Soft>{CANNOT_RATE}</Soft>
        <Btn label='Voltar' secondary onPress={onBack} />
      </>
    )
  } else {
    body = (
      <>
        {title !== '' ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.label}>Sua nota</Text>
        <View style={styles.stars} accessibilityRole='radiogroup'>
          {STARS.map((n) => (
            <Pressable
              key={n}
              accessibilityRole='radio'
              accessibilityLabel={n === 1 ? '1 estrela' : n + ' estrelas'}
              accessibilityState={{ checked: stars === n }}
              disabled={locked}
              onPress={() => { if (n !== stars) tap('select'); setStars(n); setError('') }}
              style={styles.star}
            >
              <Icon name='estrela' size={36} filled={n <= stars} color={n <= stars ? colors.accent : colors.soft} />
            </Pressable>
          ))}
        </View>
        {stars > 0 ? <Soft>{starsLabel(stars)}</Soft> : null}
        <Field label='Comentário (opcional)' value={text} onChangeText={setText} multiline maxLength={feira.MAX_RATE_TEXT} editable={!locked} />
        <Soft>{'A avaliação fica pública no anúncio. Ela ' + NOT_PAYMENT + '.'}</Soft>
        {error !== '' ? <ErrorText>{error}</ErrorText> : null}
        {!online ? <Soft>Sem conexão. Avaliar precisa de internet.</Soft> : null}
        {pending !== null && typeof pending.retry !== 'function' ? <Soft>{UNKNOWN_RATING}</Soft> : null}
        {pending !== null
          ? (
            <View style={styles.row}>
              {typeof pending.retry === 'function' ? <Btn label='Tentar de novo' onPress={retry} pending={sending} disabled={!online} /> : null}
              <Btn label='Descartar' secondary onPress={discard} disabled={sending} />
            </View>
            )
          : <Btn label='Avaliar' onPress={send} pending={sending} disabled={!online} />}
      </>
    )
  }

  return (
    <View style={styles.flex}>
      <TopBar title='Avaliar' onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps='handled'>
        {body}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  body: { padding: 16, gap: 10 },
  title: { ...type.postName, color: colors.ink },
  label: { ...type.section, color: colors.ink },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stars: { flexDirection: 'row', gap: 4 },
  star: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }
})
