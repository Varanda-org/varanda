// Anunciar: the Feira composer (create only; editing arrives in PR4 through
// ../feiraCompose editModel). Kind (Produto, Serviço, Procura-se with its
// budget label), title, description, price mode and value, a unit control
// that follows feira.unitAllowed, category, place, up to four photos and the
// required acknowledgement 'Público na web e em buscadores'.
//
// Photos follow Publicar: picked (../media/attach), encoded at once
// (../media/encode, which strips EXIF/GPS) and kept only in this screen;
// nothing is uploaded before Anunciar is pressed. Acting as a page, each
// photo is its own page statement (media) and the listing is the page's
// 'listing' action; otherwise the node uploads and listing.create writes.
// A change of identity during the uploads cancels the press, and the
// descriptors obtained for the old identity are dropped.
//
// No automatic retry: an unknown outcome locks the form with its bytes and
// offers 'Tentar de novo' (the same signed request) and 'Descartar'.
//
// Props: initialPlace ({ uf, city }), onBack, onPublished({ answer, dest }).

import { useEffect, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { sha256 } from '@noble/hashes/sha2.js'
import rpc from '@varanda/rpc'
import { useNode } from '../node'
import { actAs, pagesMedia, pagesOrigin, pagesStart } from '../pages'
import { pagesOn } from '../pageGate'
import { memberKeyOf, useActing } from './Conversa'
import { CAT_LABELS, UNIT_LABELS } from '../feira'
import {
  ACK_TEXT, UNKNOWN_PUBLICATION, destinationOf, emptyForm, holdsPublication, identityOf, kindChoices, photoRoom,
  photosFor, priceFieldLabel, priceModeChoices, retryUsable, submitListing, unitChoices, updateForm
} from '../feiraCompose'
import { validDescriptor } from '../media/fetch'
import { pickImages } from '../media/attach'
import { encodeFile } from '../media/encode'
import { revokeUrl, urlFromBytes } from '../media/display'
import { Btn, ErrorText, Field, Label, Soft, errorText } from '../ui'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { TopBar } from '../ui/TopBar'
import { useStyles, useTheme } from '../ui/ThemeProvider'

const { feira, MAX_TEXT } = rpc

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

let lastPhotoId = 0
const nextPhotoId = () => ++lastPhotoId

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

export default function Anunciar ({ initialPlace = null, onBack, onPublished }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const nodeRef = useRef(node)
  nodeRef.current = node
  const acting = useActing()
  const asPage = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && acting.kind === 'page' ? acting.key : null
  const dest = destinationOf({ actingPage: asPage })
  const identity = identityOf(dest)
  const identityRef = useRef(identity)
  identityRef.current = identity

  const [form, setForm] = useState(() => emptyForm(initialPlace || {}))
  const [ack, setAck] = useState(false)
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
  // An uncertain send: { retry, identity }. Only a press calls retry.
  const [pending, setPending] = useState(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const media = node.media && typeof node.media.upload === 'function' ? node.media : null
  const online = node.online !== false
  const canAttach = typeof pickImages === 'function' && (media !== null || asPage !== null) && online
  const locked = pending !== null || sending

  // Descriptors are valid only for the identity that uploaded them; a
  // pending retry only for the identity that signed it.
  useEffect(() => {
    setPhotos((list) => photosFor(list, identity))
    setPending((p) => (p !== null && p.identity !== identity ? null : p))
  }, [identity])

  useEffect(() => () => {
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
  }, [])

  const set = (patch) => {
    if (locked) return
    setForm((f) => updateForm(f, patch))
    setField('')
  }

  const attach = async () => {
    if (!canAttach || locked || encoding) return
    let files
    try {
      files = await pickImages()
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
        setPhotos((list) => (list.length >= 4 ? list : [...list, { id, encoded, thumb, descriptor: null, identity: null, retry: null }]))
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

  const settle = (answer, to) => {
    for (const url of thumbsRef.current.values()) revokeUrl(url)
    thumbsRef.current.clear()
    setPhotos([])
    setPending(null)
    // A form left before its answer arrived is gone: the late answer must not
    // replace whatever screen is on top now (another Anunciar, say).
    if (alive.current && typeof onPublished === 'function') onPublished({ answer, dest: to })
  }

  const publish = async () => {
    if (sendingRef.current || pending !== null || encoding) return
    sendingRef.current = true
    setSending(true)
    setError('')
    setField('')
    const to = dest
    try {
      const r = await submitListing({ form, ack, dest: to, photos: photosRef.current }, {
        uploadOne,
        validDescriptor,
        currentIdentity: () => identityRef.current,
        send
      })
      setPhotos(r.photos.map((p) => ({ ...p, thumb: thumbsRef.current.get(p.id) || null })))
      if (r.ok) { settle(r.answer, to); return }
      if (r.field) setField(r.field)
      setError(typeof r.error === 'string' ? r.error : errorText(r.error))
      // An identity switch during the send already ran the effect above: the
      // old identity's unknown outcome must not lock the new identity's form.
      if (holdsPublication(r) && r.identity === identityRef.current) setPending({ retry: typeof r.retry === 'function' ? r.retry : null, identity: r.identity, dest: to })
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
      settle(await pending.retry(), pending.dest)
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

  const procura = form.kind === 'procura'
  const units = unitChoices(form)
  const fieldError = (name) => (field === name && error !== '' ? <ErrorText>{error}</ErrorText> : null)

  return (
    <View style={styles.flex}>
      <TopBar title={asPage !== null ? 'Anunciar como página' : 'Anunciar'} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps='handled'>
        <Label>Tipo</Label>
        <Chips options={kindChoices().map((k) => ({ value: k.kind, label: k.label }))} value={form.kind} onPick={(kind) => set({ kind })} disabled={locked} />
        {fieldError('kind')}

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
              {p.thumb ? <Image source={{ uri: p.thumb }} style={styles.photoImg} /> : null}
              {!locked ? <View style={styles.photoX}><Icon name='fechar' size={14} color={colors.ink} /></View> : null}
            </Pressable>
          ))}
          {photos.length < 4 && canAttach
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='Adicionar foto' disabled={locked || encoding} onPress={attach} style={[styles.photo, styles.photoAdd]}>
                <Icon name='imagem' size={22} color={colors.soft} />
              </Pressable>
              )
            : null}
        </View>
        {!canAttach && online && media === null && asPage === null ? <Soft>Fotos só podem ser publicadas na versão web.</Soft> : null}
        {note !== '' ? <Soft>{note}</Soft> : null}

        <Pressable accessibilityRole='checkbox' accessibilityState={{ checked: ack }} disabled={locked} onPress={() => { setAck((v) => !v); setField('') }} style={styles.ack}>
          <View style={[styles.box, ack && styles.boxOn]}>{ack ? <Icon name='ok' size={14} color={colors.accentInk} /> : null}</View>
          <Text style={styles.ackText}>{ACK_TEXT}</Text>
        </Pressable>
        <Soft>Qualquer pessoa pode ver este anúncio pelo link, mesmo sem conta.</Soft>
        {fieldError('ack')}

        {error !== '' && field === '' ? <ErrorText>{error}</ErrorText> : null}
        {!online ? <Soft>Sem conexão. Anúncios precisam de internet.</Soft> : null}
        {pending !== null && typeof pending.retry !== 'function' ? <Soft>{UNKNOWN_PUBLICATION}</Soft> : null}
        {pending !== null
          ? (
            <View style={styles.chips}>
              {typeof pending.retry === 'function' ? <Btn label='Tentar de novo' onPress={retry} pending={sending} disabled={!online} /> : null}
              <Btn label='Descartar' secondary onPress={discard} disabled={sending} />
            </View>
            )
          : <Btn label='Anunciar' onPress={publish} pending={sending} disabled={!online || encoding} />}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photo: { width: 72, height: 72, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: colors.outline },
  photoAdd: { alignItems: 'center', justifyContent: 'center' },
  photoImg: { width: '100%', height: '100%' },
  photoX: { position: 'absolute', top: 4, right: 4, backgroundColor: colors.bg, borderRadius: 10, padding: 2 },
  ack: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.outline, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  ackText: { color: colors.ink, fontSize: 15, flexShrink: 1 }
})
