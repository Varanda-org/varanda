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
// onDeleted(listing); onEditar(listing); onAvaliar(listing);
// onOffer(listing); onOpenListings(author).
//
// Every peer string reaching the screen already went through displayText
// (../feira listingView); the seller's name is passed through it again.

import { useEffect, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { actAs } from '../pages'
import { memberKeyOf } from './Conversa'
import { byAuthor, ratingRefs, ratings } from '../feiraClient'
import { detailChips, sellerSummary, stickyActions } from '../anuncioView'
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
import { ErrorText, Soft, Spinner, errorText, useAction } from '../ui'
import { MediaGrid } from '../ui/MediaGrid'
import { Avatar } from '../ui/Avatar'
import { SellerCard } from '../ui/SellerCard'
import { StickyBar } from '../ui/StickyBar'
import { PageNoticeSheet } from '../ui/PageNoticeSheet'
import { TopBar } from '../ui/TopBar'
import { Pill } from '../ui/Pill'
import { MoreButton } from '../ui/MoreButton'
import { ErrorState } from '../ui/States'
import { layout, space, type } from '../ui/theme'
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
  refresh = 0, onBack, onConversar, onDenunciar, onOpenAuthor, onDeleted, onEditar, onAvaliar, onOffer, onOpenListings
}) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
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
  const [pageNotice, setPageNotice] = useState(null)
  const contactAction = useRef(null)
  const [barHeight, setBarHeight] = useState(layout.hit + space.md * 2 + insets.bottom + 1)
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
  const seller = sellerSummary({ name: name || listing.name, since: trust?.certDate, trust })
  const sellerLines = listing.username
    ? [{ key: 'username', text: '@' + displayText(listing.username) }, ...seller.lines]
    : seller.lines
  const actions = stickyActions(listing, {
    owner,
    canTalk: acts.conversar && typeof onConversar === 'function',
    canOffer: acts.conversar && typeof onOffer === 'function'
  })
  const barActions = actions.filter((item) => item.id !== 'editar' || (typeof onEditar === 'function' && online))
    .map((item) => ({ ...item, disabled: action.pending, pending: item.id === contactAction.current && action.pending }))

  // Runs a request as the member (node) or as the page (pages.js).
  const send = async (req) => {
    if (req.method) return nodeRef.current.request(req.method, req.params)
    const member = await memberKeyOf(nodeRef.current.request, nodeRef.current)
    return actAs(nodeRef.current, { member, action: req.action, page: req.page, op: req.op })
  }

  const continueContact = async (id) => {
    if (action.pending || contactAction.current !== null) return
    if (!barActions.some((item) => item.id === id)) {
      setNote('Não deu para continuar agora. Tente de novo.')
      return
    }
    contactAction.current = id
    setNote('')
    try {
      if (id === 'oferta') await action.run(() => onOffer(listing))
      else if (id === 'conversar') await startConversation()
    } finally {
      contactAction.current = null
    }
  }
  // Both ways of contacting a Página share its one-time notice.
  const contactSeller = async (id) => {
    if (action.pending || !barActions.some((item) => item.id === id)) return
    if (listing.page === true && !pageNoticeSeen(pageNoticeStore(), listing.author)) {
      setPageNotice(id)
      return
    }
    await continueContact(id)
  }
  const conversar = () => contactSeller('conversar')
  const fazerOferta = () => contactSeller('oferta')
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
      <TopBar
        title={listing.kind === 'procura' ? 'Procura-se' : 'Anúncio'}
        onBack={onBack}
        right={acts.denunciar && typeof onDenunciar === 'function'
          ? <MoreButton title='Anúncio' actions={[{ icon: 'bandeira', label: 'Denunciar', danger: true, onPress: () => onDenunciar(reportTarget(listing)) }]} />
          : null}
      />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: barActions.length > 0 ? Math.max(space.lg, barHeight) : space.lg }]}>
        {listing.media.length > 0 ? <View style={styles.bleed}><MediaGrid author={listing.author} media={listing.media} persist={false} /></View> : null}
        <View style={styles.row}>
          <Text style={styles.price}>{listing.priceLabel}</Text>
          {badge !== '' ? <Text style={styles.badge}>{badge}</Text> : null}
        </View>
        <Text style={styles.title}>{listing.title}</Text>
        <View style={styles.secondaryActions}>
          {acts.compartilhar && url !== null ? <Pill icon='compartilhar' accessibilityLabel='Compartilhar' onPress={compartilhar} /> : null}
          {acts.salvar ? <Pill icon='estrela' accessibilityLabel={saved ? 'Salvo' : 'Salvar'} filled={saved} iconFilled={saved} onPress={salvar} /> : null}
          {typeof onAvaliar === 'function' && owner === null ? <Pill label='Avaliar' onPress={() => onAvaliar(listing)} /> : null}
        </View>
        <View style={styles.pills}>
          {detailChips(listing).map((chip) => <Text key={chip.id} style={styles.badge}>{chip.label}</Text>)}
        </View>
        {listing.place?.bairro ? <Soft>{displayText(listing.place.bairro)}</Soft> : null}
        {listing.text
          ? (
            <>
              <Text style={styles.section}>Descrição</Text>
              <Text style={styles.text}>{listing.text}</Text>
            </>
            )
          : null}
        <SellerCard
          avatar={<Avatar name={seller.avatarName} publicKey={listing.author} />}
          name={seller.name}
          lines={sellerLines}
          onOpenAuthor={typeof onOpenAuthor === 'function' ? () => onOpenAuthor(listing.author) : undefined}
          onOpenListings={typeof onOpenListings === 'function' ? () => onOpenListings(listing.author) : undefined}
        />

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

        <View style={styles.ownerActions}>
          {owner !== null
            ? (
              <View style={styles.pills}>
                {acts.statuses.map((b) => (
                  <Pill key={b.status} label={b.label} disabled={action.pending} onPress={() => setStatus(b.status)} />
                ))}
                {acts.apagar
                  ? <Pill label={confirmDelete ? 'Confirmar: apagar' : 'Apagar'} danger disabled={action.pending} onPress={apagar} />
                  : null}
              </View>
              )
            : null}
          {owner !== null && !online ? <Soft>Sem conexão. Para mudar o anúncio, conecte-se.</Soft> : null}
          {barActions.length === 0 && note !== '' ? <Soft>{note}</Soft> : null}
          {barActions.length === 0 && action.error !== '' ? <ErrorText>{action.error}</ErrorText> : null}
        </View>
      </ScrollView>
      <StickyBar
        actions={barActions}
        message={barActions.length > 0 ? { text: note, error: action.error } : undefined}
        onHeightChange={setBarHeight}
        onAction={(id) => {
          if (id === 'editar') onEditar(listing)
          else if (id === 'conversar') conversar()
          else if (id === 'oferta') fazerOferta()
        }}
      />
      <PageNoticeSheet
        open={pageNotice !== null}
        page={listing.author}
        onClose={() => setPageNotice(null)}
        onContinue={() => {
          setPageNotice(null)
          continueContact(pageNotice)
        }}
      />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.lg, gap: 10 },
  bleed: { marginHorizontal: -space.lg, marginTop: -space.lg },
  section: { ...type.section, color: colors.ink },
  title: { ...type.profileName, color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  price: { ...type.price, color: colors.ink },
  badge: { ...type.chip, color: colors.ink, borderColor: colors.outline, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  text: { ...type.postText, color: colors.ink },
  sellerName: { ...type.postName, color: colors.ink },
  ownerActions: { gap: 10 },
  secondaryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratings: { gap: 6, paddingVertical: 6 },
  rating: { gap: 2 },
  stars: { ...type.postName, color: colors.accent },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }
})
