// Anúncio: one Feira listing. Photos (MediaGrid), title, price with its
// unit, status badge, place, 'Procura-se' header for a procura, the seller
// row with its trust lines, and the actions of ../feiraCompose detailActions:
// Conversar (hands the shell a draft and the listing card snapshot with its
// thumbnail, never uploads here), Compartilhar (the public link of the root
// seq), Salvar (on this device), Denunciar (the shell opens the report
// sheet with the listing target). The owner, as the member or as the page
// acted as, gets the status buttons and Apagar. Editar and Avaliar are slots
// the shell fills (onEditar, onAvaliar). On the hosted app the listing's
// verified ratings (../feiraReview collectRatings over the seeder's hints
// and listing.ratings) show as a count, an average and the newest rows.
//
// Props: listing (a verified ../feiraClient row) or author + seq to load it
// through the author route; me (own key); actingPage (page key or null);
// trust ({ certDate, verifiedName, mutuals }); name; onBack;
// onConversar({ peer, draft, card }); onDenunciar(target); onOpenAuthor(key);
// onDeleted(listing); onEditar(listing); onAvaliar(listing).
//
// Every peer string reaching the screen already went through displayText
// (../feira listingView); the seller's name is passed through it again.

import { useEffect, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { actAs } from '../pages'
import { memberKeyOf } from './Conversa'
import { byAuthor, ratingRefs, ratings } from '../feiraClient'
import { trustLines } from '../feira'
import { draftText, listingCard } from '../feiraChat'
import { shareUrlOf } from '../feiraLink'
import { isSaved, toggleSaved } from '../feiraSavedStore'
import { SAVED_FULL_TEXT } from '../feiraSaved'
import { detailActions, deleteRequest, ownerDest, pickListing, reportTarget, statusBadge, statusRequest } from '../feiraCompose'
import { mineView } from '../feiraScreen'
import { RATINGS_NOTE, collectRatings, reviewModel, starsLabel, summaryLabel } from '../feiraReview'
import { installationOrigin } from '../installation'
import { pageNoticeSeen } from '../pageNotice'
import { pageNoticeStore } from '../pageNoticeStore'
import { isAppClient } from '../appClient'
import { fetchMedia, validDescriptor } from '../media/fetch'
import { encodeThumbnail } from '../media/encode'
import { canShare, copyText, shareUrl } from '../share'
import { shareNav } from '../shareNav'
import { Btn, ErrorText, Soft, Spinner, errorText, useAction } from '../ui'
import { MediaGrid } from '../ui/MediaGrid'
import { PageNoticeSheet } from '../ui/PageNoticeSheet'
import { TopBar } from '../ui/TopBar'
import { Pill } from '../ui/Pill'
import { ErrorState } from '../ui/States'
import { type } from '../ui/theme'
import { useStyles } from '../ui/ThemeProvider'

// The author route is paged; a listing further back than this is not
// searched for (the shell normally hands the row it showed).
const MAX_LOAD_PAGES = 5
// Newest verified ratings shown under the listing.
const SHOWN_RATINGS = 5
// Own listing or the page acted as, not in the index yet: it is on its way.
const ARRIVING_TEXT = 'O anúncio ainda está chegando à Feira. Tente de novo em instantes.'

const mediaFetch = () => (isAppClient() ? expoFetch : undefined)

// The owner's own diary folds the current status (listing.mine), which the
// index may not know yet (a stale row).
// The owner's own listing straight from the diary (listing.mine), for one
// the index has not reached yet (just published, say).
async function ownListing (request, author, seq) {
  let before
  for (let i = 0; i < MAX_LOAD_PAGES; i++) {
    const r = await request('listing.mine', before === undefined ? {} : { before })
    const hit = pickListing(r && r.items, seq)
    if (hit) return mineView(author, hit)
    if (!r || r.next === null || r.next === undefined) return null
    before = r.next
  }
  return null
}

async function ownStatus (request, seq) {
  let before
  for (let i = 0; i < MAX_LOAD_PAGES; i++) {
    const r = await request('listing.mine', before === undefined ? {} : { before })
    const hit = pickListing(r && r.items, seq)
    if (hit) return hit.status
    if (!r || r.next === null || r.next === undefined) return null
    before = r.next
  }
  return null
}

export default function Anuncio ({
  listing: given = null, author = null, seq = null, me = null, actingPage = null, trust = null, name = '',
  refresh = 0, onBack, onConversar, onDenunciar, onOpenAuthor, onDeleted, onEditar, onAvaliar
}) {
  const styles = useStyles(makeStyles)
  const node = useNode()
  const nodeRef = useRef(node)
  nodeRef.current = node
  const [listing, setListing] = useState(given)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(given === null)
  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [loadTick, setLoadTick] = useState(0)
  const [pageNotice, setPageNotice] = useState(false)
  const [rated, setRated] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const action = useAction()
  // The hosted web keeps no installation record: the page's own origin is it.
  const origin = installationOrigin() || globalThis.location?.origin || null
  const key = listing ? listing.author : author
  const atSeq = listing ? listing.seq : seq

  useEffect(() => { if (given) setListing(given) }, [given])

  // Loads the listing when the shell only knows its link.
  useEffect(() => {
    if (given !== null || typeof author !== 'string' || !Number.isSafeInteger(seq)) return undefined
    let live = true
    const load = async () => {
      setLoading(true)
      setLoadError('')
      let cursor = null
      try {
        // Right after the owner's own edit the index may not have it yet:
        // the diary (listing.mine, local) already does.
        if (refresh > 0 && typeof me === 'string' && author === me) {
          const own = await ownListing(nodeRef.current.request, author, seq)
          if (!live) return
          if (own) { setListing(own); return }
        }
        for (let i = 0; i < MAX_LOAD_PAGES; i++) {
          const r = await byAuthor(nodeRef.current.request, author, cursor)
          if (!live) return
          if (r.off) { setLoadError('A Feira não está aberta nesta instalação.'); return }
          if (!r.ok) { setLoadError('Não foi possível abrir o anúncio. Tente de novo.'); return }
          const hit = pickListing(r.items, seq)
          if (hit) { setListing(hit); return }
          if (r.next === null || r.next === undefined) break
          cursor = r.next
        }
        if (live && typeof me === 'string' && author === me) {
          const own = await ownListing(nodeRef.current.request, author, seq)
          if (!live) return
          if (own) { setListing(own); return }
        }
        if (live) setLoadError(author === me || author === actingPage ? ARRIVING_TEXT : 'Este anúncio não está mais disponível.')
      } catch (err) {
        if (live) setLoadError(errorText(err))
      } finally {
        if (live) setLoading(false)
      }
    }
    load()
    return () => { live = false }
  }, [given, author, seq, loadTick, me, actingPage, refresh])

  const owner = ownerDest(listing, { me, actingPage })

  // The owner of a stale row reads the status from their own diary.
  useEffect(() => {
    if (!listing || listing.stale !== true || !owner || owner.kind !== 'personal') return undefined
    let live = true
    ownStatus(nodeRef.current.request, listing.seq).then((status) => {
      if (live && status) setListing((l) => (l && l.seq === listing.seq ? { ...l, status, stale: false } : l))
    }, () => {})
    return () => { live = false }
  }, [listing && listing.seq, listing && listing.stale, owner && owner.kind])

  useEffect(() => {
    if (typeof key !== 'string' || !Number.isSafeInteger(atSeq)) return undefined
    let live = true
    isSaved(origin, { author: key, seq: atSeq }).then((v) => { if (live) setSaved(v === true) }, () => {})
    return () => { live = false }
  }, [origin, key, atSeq])

  // Read once per listing; a failure only hides the block.
  const hosted = node.hosted === true
  useEffect(() => {
    setRated(null)
    if (!hosted || typeof key !== 'string' || !Number.isSafeInteger(atSeq)) return undefined
    let live = true
    collectRatings({ author: key, seqs: [atSeq] }, {
      refsPage: (cursor) => ratingRefs(key, cursor),
      verify: (q) => ratings(nodeRef.current.request, q)
    }).then((r) => { if (live) setRated(r) }, () => {})
    return () => { live = false }
  }, [hosted, key, atSeq])

  if (!listing) {
    return (
      <View style={styles.flex}>
        <TopBar title='Anúncio' onBack={onBack} />
        {loading
          ? <View style={styles.center}><Spinner /></View>
          : <ErrorState message={loadError || 'Este anúncio não está mais disponível.'} onRetry={() => setLoadTick((n) => n + 1)} />}
      </View>
    )
  }

  const online = node.online !== false
  const acts = detailActions(listing, { owner, online })
  const url = shareUrlOf(origin, listing.author, listing.seq)
  const badge = statusBadge(listing)
  const lines = trustLines(trust || {})
  const seller = displayText(typeof name === 'string' && name !== '' ? name : (listing.name || ''))

  // Runs a request as the member (node) or as the page (pages.js).
  const send = async (req) => {
    if (req.method) return nodeRef.current.request(req.method, req.params)
    const member = await memberKeyOf(nodeRef.current.request, nodeRef.current)
    return actAs(nodeRef.current, { member, action: req.action, page: req.page, op: req.op })
  }

  // A Página's inbox is kept by the account service: the same one-time
  // notice as the page's profile comes before the first message.
  const conversar = async () => {
    if (typeof onConversar !== 'function') return
    if (listing.page === true && !pageNoticeSeen(pageNoticeStore(), listing.author)) {
      setPageNotice(true)
      return
    }
    await startConversation()
  }
  const startConversation = async () => {
    await action.run(async () => {
      const first = listing.media.find(validDescriptor) || null
      let photo = null
      if (first) {
        try {
          photo = { bytes: await fetchMedia(listing.author, first, { fetch: mediaFetch(), persist: false }), mime: first.mime }
        } catch {
          photo = null
        }
      }
      const card = await listingCard({ origin, listing, photo, encodeThumbnail })
      onConversar({ peer: listing.author, draft: draftText(listing, url), card })
    })
  }

  const compartilhar = async () => {
    if (url === null) return
    const nav = shareNav()
    if (canShare(nav) && (await shareUrl(nav, { url, title: listing.title })) !== 'failed') return
    setNote((await copyText(nav, url)) ? 'Link copiado.' : url)
  }

  const salvar = async () => {
    const r = await toggleSaved(origin, { author: listing.author, seq: listing.seq })
    if (r.full) { setNote(SAVED_FULL_TEXT); return }
    setSaved(r.saved)
    setNote(r.persisted === false ? 'Não foi possível salvar neste aparelho.' : '')
  }

  const setStatus = async (status) => {
    const r = await action.run(() => send(statusRequest(listing, status, owner)))
    if (r.ok) setListing((l) => ({ ...l, status, stale: false, statusLabel: null }))
  }

  const apagar = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    const r = await action.run(() => send(deleteRequest(listing, owner)))
    setConfirmDelete(false)
    // A screen left before the answer must not pop whatever is on top now.
    if (r.ok && alive.current && typeof onDeleted === 'function') onDeleted(listing)
  }

  return (
    <View style={styles.flex}>
      <TopBar title={listing.kind === 'procura' ? 'Procura-se' : 'Anúncio'} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {listing.kind === 'procura' ? <Text style={styles.kicker}>Procura-se</Text> : null}
        {listing.media.length > 0 ? <MediaGrid author={listing.author} media={listing.media} persist={false} /> : null}
        <Text style={styles.title}>{listing.title}</Text>
        <View style={styles.row}>
          <Text style={styles.price}>{listing.priceLabel}</Text>
          {badge !== '' ? <Text style={styles.badge}>{badge}</Text> : null}
        </View>
        {listing.place && listing.place.label ? <Soft>{listing.place.label}</Soft> : null}
        {listing.catLabel ? <Soft>{listing.catLabel}</Soft> : null}
        {listing.text ? <Text style={styles.text}>{listing.text}</Text> : null}

        <Pressable
          accessibilityRole='button'
          disabled={typeof onOpenAuthor !== 'function'}
          onPress={() => onOpenAuthor(listing.author)}
          style={styles.seller}
        >
          <Text style={styles.sellerName}>{seller !== '' ? seller : 'Quem anunciou'}</Text>
          {listing.username ? <Soft>{'@' + displayText(listing.username)}</Soft> : null}
          {lines.map((l) => <Soft key={l.key}>{l.text}</Soft>)}
        </Pressable>

        {rated && rated.summary.count > 0
          ? (
            <View style={styles.ratings}>
              <Text style={styles.sellerName}>{summaryLabel(rated.summary)}</Text>
              <Soft>{RATINGS_NOTE}</Soft>
              {rated.rows.slice(0, SHOWN_RATINGS).map(reviewModel).filter(Boolean).map((r) => (
                <View key={r.key} style={styles.rating}>
                  <Text style={styles.stars} accessibilityLabel={r.stars === 1 ? '1 estrela' : r.stars + ' estrelas'}>{starsLabel(r.stars)}</Text>
                  {r.text !== '' ? <Text style={styles.text}>{r.text}</Text> : null}
                </View>
              ))}
            </View>
            )
          : null}

        <View style={styles.actions}>
          {acts.conversar && typeof onConversar === 'function'
            ? <Btn label='Conversar' onPress={conversar} pending={action.pending} />
            : null}
          <View style={styles.pills}>
            {acts.compartilhar && url !== null ? <Pill label='Compartilhar' onPress={compartilhar} /> : null}
            {acts.salvar ? <Pill label={saved ? 'Salvo' : 'Salvar'} filled={saved} onPress={salvar} /> : null}
            {acts.denunciar && typeof onDenunciar === 'function'
              ? <Pill label='Denunciar' onPress={() => onDenunciar(reportTarget(listing))} />
              : null}
            {typeof onAvaliar === 'function' && owner === null ? <Pill label='Avaliar' onPress={() => onAvaliar(listing)} /> : null}
          </View>
          {owner !== null
            ? (
              <View style={styles.pills}>
                {acts.statuses.map((b) => (
                  <Pill key={b.status} label={b.label} disabled={action.pending} onPress={() => setStatus(b.status)} />
                ))}
                {typeof onEditar === 'function' && online ? <Pill label='Editar' onPress={() => onEditar(listing)} /> : null}
                {acts.apagar
                  ? <Pill label={confirmDelete ? 'Confirmar: apagar' : 'Apagar'} danger disabled={action.pending} onPress={apagar} />
                  : null}
              </View>
              )
            : null}
          {owner !== null && !online ? <Soft>Sem conexão. Para mudar o anúncio, conecte-se.</Soft> : null}
          {note !== '' ? <Soft>{note}</Soft> : null}
          {action.error !== '' ? <ErrorText>{action.error}</ErrorText> : null}
        </View>
      </ScrollView>
      <PageNoticeSheet
        open={pageNotice}
        page={listing.author}
        onClose={() => setPageNotice(false)}
        onContinue={() => {
          setPageNotice(false)
          startConversation()
        }}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10 },
  kicker: { ...type.section, color: colors.accent },
  title: { ...type.profileName, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  price: { ...type.postName, color: colors.ink },
  badge: { ...type.chip, color: colors.ink, borderColor: colors.outline, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  text: { ...type.postText, color: colors.ink },
  seller: { paddingVertical: 10, gap: 2 },
  sellerName: { ...type.postName, color: colors.ink },
  actions: { gap: 10 },
  ratings: { gap: 6, paddingVertical: 6 },
  rating: { gap: 2 },
  stars: { ...type.postName, color: colors.accent },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
