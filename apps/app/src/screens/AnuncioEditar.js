// AnuncioEditar: the Anunciar form for an existing listing (stack entry
// 'editar-anuncio'). The kind is locked; title, description, price, unit,
// category, place and photos change. The current photos are kept as they
// are (their descriptors are sent again), removed, or joined by new ones,
// which are encoded here and uploaded only on Salvar. No photo at all drops
// them (media null).
//
// The listing is read from its owner's own source before the form opens:
// listing.mine for the member, the author route for the page acted as, so
// expectedRevision is the live edit. A 'conflito' answer (another device
// edited first) keeps the form and offers Recarregar. Before the first edit
// the person is told that the first version stays in the diary.
//
// No automatic retry: an unknown outcome locks the form with its bytes and
// offers 'Tentar de novo' (the same signed request) and 'Descartar'.
//
// Props: author, seq (the listing), me (own key), actingPage (page key or
// null), onBack, onSaved({ answer, author, seq }).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { sha256 } from '@noble/hashes/sha2.js'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { actAs, pagesMedia, pagesOrigin, pagesStart } from '../pages'
import { memberKeyOf } from './Conversa'
import { byAuthor } from '../feiraClient'
import { CAT_LABELS, KIND_LABELS, UNIT_LABELS } from '../feira'
import {
  EDIT_CONFLICT, FIRST_EDIT_NOTE, MAX_PHOTOS, UNKNOWN_EDIT, editModel, firstEdit, holdsPublication, identityOf, keptPhotos, ownerDest,
  photoRoom, photosFor, pickListing, priceFieldLabel, priceModeChoices, retryUsable, submitEdit, unitChoices, updateForm
} from '../feiraCompose'
import { validDescriptor } from '../media/fetch'
import { pickImages } from '../media/attach'
import { encodeFile } from '../media/encode'
import { revokeUrl, urlFromBytes } from '../media/display'
import { Btn, ErrorText, Field, Label, Soft, Spinner, errorText } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { ErrorState } from '../ui/States'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const { feira, MAX_TEXT } = rpc

const MAX_LOAD_PAGES = 5
const NOT_OWNER = 'Só quem publicou este anúncio pode editá-lo.'

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

let lastPhotoId = 0
const nextPhotoId = () => 'new:' + (++lastPhotoId)

// The listing as its owner's own source holds it, or null.
async function loadModel (request, dest, author, seq) {
  if (dest.kind === 'personal') {
    let before
    for (let i = 0; i < MAX_LOAD_PAGES; i++) {
      const r = await request('listing.mine', before === undefined ? {} : { before })
      const hit = pickListing(r && r.items, seq)
      if (hit) return editModel(hit, { author })
      if (!r || r.next === null || r.next === undefined) return null
      before = r.next
    }
    return null
  }
  let cursor = null
  for (let i = 0; i < MAX_LOAD_PAGES; i++) {
    const r = await byAuthor(request, author, cursor)
    if (!r.ok) throw new Error(r.off ? 'A Feira não está aberta nesta instalação.' : 'Não foi possível abrir o anúncio. Tente de novo.')
    const hit = pickListing(r.items, seq)
    if (hit) return editModel(hit)
    if (r.next === null || r.next === undefined) return null
    cursor = r.next
  }
  return null
}

function Chips ({ options, value, onPick, disabled }) {
  const styles = useStyles(makeStyles)
  return (
    <View style={styles.chips}>
      {options.map((o) => (
        <Pill key={String(o.value)} label={o.label} filled={o.value === value} disabled={disabled} onPress={() => onPick(o.value)} />
      ))}
    </View>
  )
}

export default function AnuncioEditar ({ author, seq, me = null, actingPage = null, onBack, onSaved }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const nodeRef = useRef(node)
  nodeRef.current = node
  const dest = ownerDest({ author, seq }, { me, actingPage })
  const identity = dest === null ? null : identityOf(dest)
  const identityRef = useRef(identity)
  identityRef.current = identity

  const [model, setModel] = useState(null)
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadTick, setLoadTick] = useState(0)
  const [photos, setPhotos] = useState([])
  const photosRef = useRef(photos)
  photosRef.current = photos
  const thumbsRef = useRef(new Map())
  const [encoding, setEncoding] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [error, setError] = useState('')
  const [field, setField] = useState('')
  const [note, setNote] = useState('')
  const [conflict, setConflict] = useState(false)
  // An uncertain send: { retry, identity }. Only a press calls retry.
  const [pending, setPending] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const media = node.media && typeof node.media.upload === 'function' ? node.media : null
  const online = node.online !== false
  const asPage = dest !== null && dest.kind === 'page'
  const canAttach = typeof pickImages === 'function' && (media !== null || asPage) && online
  const locked = pending !== null || sending || conflict

  const dropThumbs = useCallback(() => {
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
  }, [])

  useEffect(() => {
    if (dest === null || typeof author !== 'string' || !Number.isSafeInteger(seq)) { setLoading(false); return undefined }
    let live = true
    setLoading(true)
    setLoadError('')
    loadModel(nodeRef.current.request, dest, author, seq).then((m) => {
      if (!live) return
      if (m === null) { setLoadError('Este anúncio não está mais disponível.'); return }
      dropThumbs()
      setModel(m)
      setForm(m.form)
      setPhotos(keptPhotos(m, identityRef.current))
      setConflict(false)
      setPending(null)
      setError('')
      setField('')
    }, (err) => {
      if (live) setLoadError(errorText(err))
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [author, seq, dest && dest.kind, loadTick])

  // New photos' descriptors are valid only for the identity that uploaded
  // them; a pending retry only for the identity that signed it.
  useEffect(() => {
    setPhotos((list) => photosFor(list, identity))
    setPending((p) => (p !== null && p.identity !== identity ? null : p))
  }, [identity])

  useEffect(() => dropThumbs, [dropThumbs])

  if (dest === null) {
    return (
      <View style={styles.flex}>
        <TopBar title='Editar anúncio' onBack={onBack} />
        <View style={styles.body}><Soft>{NOT_OWNER}</Soft></View>
      </View>
    )
  }
  if (model === null || form === null) {
    return (
      <View style={styles.flex}>
        <TopBar title='Editar anúncio' onBack={onBack} />
        {loading
          ? <View style={styles.center}><Spinner /></View>
          : <ErrorState message={loadError || 'Este anúncio não está mais disponível.'} onRetry={() => setLoadTick((n) => n + 1)} />}
      </View>
    )
  }

  const set = (patch) => {
    if (locked) return
    setForm((f) => updateForm(f, patch))
    setField('')
  }

  const attach = async () => {
    if (!canAttach || locked || encoding) return
    let files
    try {
      files = await pickImages(MAX_PHOTOS)
    } catch {
      return
    }
    if (!Array.isArray(files) || files.length === 0) return
    const { take, note: full } = photoRoom(photosRef.current.length, files.length)
    setNote(full)
    if (take === 0) return
    setEncoding(true)
    try {
      // One at a time: decoding big photos in parallel uses a lot of memory.
      for (const file of files.slice(0, take)) {
        let encoded
        try {
          encoded = await encodeFile(file)
        } catch (err) {
          setNote(errorText(err))
          continue
        }
        const id = nextPhotoId()
        let thumb = null
        try {
          thumb = urlFromBytes(encoded.bytes, encoded.mime)
          thumbsRef.current.set(id, thumb)
        } catch {}
        setPhotos((list) => (list.length >= MAX_PHOTOS ? list : [...list, { id, encoded, thumb, descriptor: null, identity: null, retry: null }]))
      }
    } finally {
      setEncoding(false)
    }
  }

  const removePhoto = (id) => {
    if (locked) return
    revokeUrl(thumbsRef.current.get(id))
    thumbsRef.current.delete(id)
    setPhotos((list) => list.filter((p) => p.id !== id))
  }

  // One photo as the page: its own statement and the raw bytes.
  const uploadForPage = async (page, p) => {
    if (typeof p.retry === 'function') return (await p.retry()).descriptor
    const { encoded } = p
    const n = nodeRef.current
    const member = await memberKeyOf(n.request, n)
    const origin = pagesOrigin(n)
    const { nonce } = await pagesStart({ member, action: 'media', page, origin })
    const op = { sha256: hexOf(sha256(encoded.bytes)), mime: encoded.mime, width: encoded.width, height: encoded.height, bytes: encoded.bytes.byteLength }
    const signed = await n.request('page.sign', { action: 'media', nonce, page, op })
    const res = await pagesMedia({ member, nonce, page, op, signature: signed.signature, bytes: encoded.bytes, origin })
    return res.descriptor
  }

  const uploadOne = (p, to) => {
    if (to.kind === 'page') return uploadForPage(to.page, p)
    if (media === null) throw new Error('mídia disponível só na versão web')
    const { encoded } = p
    return media.upload({ bytes: encoded.bytes, mime: encoded.mime, width: encoded.width, height: encoded.height })
  }

  const send = async (req) => {
    const n = nodeRef.current
    if (req.method) return n.request(req.method, req.params)
    const member = await memberKeyOf(n.request, n)
    return actAs(n, { member, action: req.action, page: req.page, op: req.op })
  }

  const settle = (answer) => {
    dropThumbs()
    setPending(null)
    // A form left before its answer arrived is gone: the late answer must not
    // pop whatever screen is on top now.
    if (alive.current && typeof onSaved === 'function') onSaved({ answer, author, seq })
  }

  const save = async () => {
    if (sendingRef.current || pending !== null || conflict || encoding) return
    sendingRef.current = true
    setSending(true)
    setError('')
    setField('')
    try {
      const r = await submitEdit({ model, form, dest, photos: photosRef.current }, {
        uploadOne,
        validDescriptor,
        currentIdentity: () => identityRef.current,
        send
      })
      setPhotos(r.photos.map((p) => ({ ...p, thumb: thumbsRef.current.get(p.id) || null })))
      if (r.ok) { settle(r.answer); return }
      if (r.field) setField(r.field)
      setError(typeof r.error === 'string' ? r.error : errorText(r.error))
      if (r.conflict === true) setConflict(true)
      if (holdsPublication(r) && r.identity === identityRef.current) setPending({ retry: typeof r.retry === 'function' ? r.retry : null, identity: r.identity })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const retry = async () => {
    if (sendingRef.current || !retryUsable(pending, identityRef.current)) return
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

  const reload = () => {
    if (sending) return
    setLoadTick((n) => n + 1)
  }

  const procura = form.kind === 'procura'
  const units = unitChoices(form)
  const fieldError = (name) => (field === name && error !== '' ? <ErrorText>{error}</ErrorText> : null)

  return (
    <View style={styles.flex}>
      <TopBar title={asPage ? 'Editar anúncio da página' : 'Editar anúncio'} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps='handled'>
        {firstEdit(model) ? <Soft>{FIRST_EDIT_NOTE}</Soft> : null}

        <Label>Tipo</Label>
        <Soft>{(KIND_LABELS[model.kind] || '') + '. O tipo não muda depois de publicado.'}</Soft>

        <Field label={procura ? 'O que você procura' : 'Título'} value={form.title} onChangeText={(title) => set({ title })} maxLength={feira.MAX_LISTING_TITLE} editable={!locked} />
        {fieldError('title')}
        <Field label='Descrição' value={form.text} onChangeText={(text) => set({ text })} multiline maxLength={MAX_TEXT} editable={!locked} />
        {fieldError('text')}

        <Label>{priceFieldLabel(form.kind)}</Label>
        <Chips options={priceModeChoices(form.kind).map((m) => ({ value: m.mode, label: m.label }))} value={form.priceMode} onPick={(priceMode) => set({ priceMode })} disabled={locked} />
        {form.priceMode === 'valor'
          ? <Field label={procura ? 'Até (R$)' : 'Valor (R$)'} value={form.priceText} onChangeText={(priceText) => set({ priceText })} placeholder='25,00' editable={!locked} />
          : null}
        {fieldError('price')}
        {units.length > 1
          ? (
            <>
              <Label>Unidade</Label>
              <Chips options={units.map((u) => ({ value: u, label: u === null ? 'Sem unidade' : UNIT_LABELS[u] }))} value={form.unit} onPick={(unit) => set({ unit })} disabled={locked} />
            </>
            )
          : null}
        {fieldError('unit')}

        <Label>Categoria</Label>
        <Chips options={feira.CATS.map((c) => ({ value: c, label: CAT_LABELS[c] || c }))} value={form.cat} onPick={(cat) => set({ cat })} disabled={locked} />
        {fieldError('cat')}

        <Field label='Estado (UF)' value={form.uf} onChangeText={(uf) => set({ uf: uf.toUpperCase().slice(0, 2) })} placeholder='SP' editable={!locked} />
        {fieldError('uf')}
        <Field label='Cidade' value={form.city} onChangeText={(city) => set({ city })} maxLength={feira.MAX_PLACE} editable={!locked} />
        {fieldError('city')}
        <Field label='Bairro (opcional)' value={form.bairro} onChangeText={(bairro) => set({ bairro })} maxLength={feira.MAX_PLACE} editable={!locked} />
        {fieldError('bairro')}

        <Label>Fotos</Label>
        <View style={styles.photos}>
          {photos.map((p) => (
            <Pressable key={p.id} accessibilityRole='button' accessibilityLabel='Remover foto' disabled={locked} onPress={() => removePhoto(p.id)} style={styles.photo}>
              {p.thumb
                ? <Image source={{ uri: p.thumb }} style={styles.photoImg} />
                : <View style={styles.photoKept}><Icon name='imagem' size={20} color={colors.soft} /><Text style={styles.photoText}>atual</Text></View>}
              {!locked ? <View style={styles.photoX}><Icon name='fechar' size={14} color={colors.ink} /></View> : null}
            </Pressable>
          ))}
          {photos.length < MAX_PHOTOS && canAttach
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='Adicionar foto' disabled={locked || encoding} onPress={attach} style={[styles.photo, styles.photoAdd]}>
                <Icon name='imagem' size={22} color={colors.soft} />
              </Pressable>
              )
            : null}
        </View>
        {photos.length === 0 && model.media.length > 0 ? <Soft>Sem fotos: o anúncio fica sem nenhuma foto.</Soft> : null}
        {!canAttach && online && media === null && !asPage ? <Soft>Fotos novas só podem ser publicadas na versão web.</Soft> : null}
        {note !== '' ? <Soft>{note}</Soft> : null}

        {error !== '' && field === '' && !conflict ? <ErrorText>{error}</ErrorText> : null}
        {!online ? <Soft>Sem conexão. Anúncios precisam de internet.</Soft> : null}
        {conflict
          ? (
            <>
              <ErrorText>{EDIT_CONFLICT}</ErrorText>
              <Soft>Recarregar traz a versão atual e descarta o que você mudou aqui.</Soft>
              <Btn label='Recarregar' onPress={reload} pending={loading} disabled={!online} />
            </>
            )
          : null}
        {pending !== null && typeof pending.retry !== 'function' ? <Soft>{UNKNOWN_EDIT}</Soft> : null}
        {pending !== null
          ? (
            <View style={styles.chips}>
              {typeof pending.retry === 'function' ? <Btn label='Tentar de novo' onPress={retry} pending={sending} disabled={!online} /> : null}
              <Btn label='Descartar' secondary onPress={discard} disabled={sending} />
            </View>
            )
          : !conflict ? <Btn label='Salvar' onPress={save} pending={sending} disabled={!online || encoding} /> : null}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: colors.outline },
  photoAdd: { alignItems: 'center', justifyContent: 'center' },
  photoImg: { width: '100%', height: '100%' },
  photoKept: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  photoText: { color: colors.soft, fontSize: 12 },
  photoX: { position: 'absolute', top: 4, right: 4, backgroundColor: colors.bg, borderRadius: 10, padding: 2 }
})
