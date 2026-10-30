import { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput } from 'react-native'
import { displayText } from '@varanda/rpc'
import { canShare, copyText, shareUrl, visibleUrl } from '../share'
import { shareNav } from '../shareNav'
import { Mono, Row, Soft } from './index'
import { Pill } from './Pill'
import { colors, fonts } from './theme'

const PROFILE_LABELS = Object.freeze({
  field: 'link do perfil',
  copy: 'copiar link',
  copyLabel: 'copiar link do perfil',
  share: 'compartilhar',
  shareLabel: 'compartilhar perfil'
})

// labels: other wording for another kind of link (missing keys keep the
// profile's). showUrl: draw any link, not only a /@ profile URL.
export function ShareProfile ({ url, labels, showUrl = false }) {
  const text = labels ? { ...PROFILE_LABELS, ...labels } : PROFILE_LABELS
  const [note, setNote] = useState('')
  const [manual, setManual] = useState(false)
  // One action at a time: a second tap while the clipboard or the share
  // sheet is pending would race the first one's note.
  const busy = useRef(false)
  const manualRef = useRef(null)
  const [selectTick, setSelectTick] = useState(0)

  // Clipboard refused: the link in a field, focused and selected, again on
  // every failed attempt (as CertificateStep in Identidade.js).
  useEffect(() => {
    if (!manual) return
    const el = manualRef.current
    if (!el) return
    try {
      el.focus()
      if (typeof el.select === 'function') el.select()
    } catch {}
  }, [manual, selectTick])

  if (typeof url !== 'string') return null

  const nav = shareNav()
  const shown = showUrl ? url : visibleUrl(url)
  const copyOrSelect = async () => {
    if (await copyText(nav, url)) {
      setManual(false)
      setNote('link copiado')
    } else {
      setManual(true)
      setSelectTick((n) => n + 1)
      setNote('não foi possível copiar: o link está selecionado abaixo')
    }
  }
  const run = (action) => async () => {
    if (busy.current) return
    busy.current = true
    setNote('')
    try { await action() } finally { busy.current = false }
  }
  const copy = run(copyOrSelect)
  // shareUrl calls navigator.share before its first await, so the click's
  // user activation still holds; a failed share falls back to the copy.
  const share = run(async () => {
    if ((await shareUrl(nav, { url, title: 'Varanda' })) === 'failed') await copyOrSelect()
  })

  return (
    <>
      {shown !== null ? <Mono>{displayText(url)}</Mono> : null}
      <Row>
        <Pill label={text.copy} accessibilityLabel={text.copyLabel} onPress={copy} />
        {canShare(nav)
          ? <Pill label={text.share} accessibilityLabel={text.shareLabel} onPress={share} />
          : null}
      </Row>
      {manual
        ? (
          <TextInput
            style={styles.manual}
            value={url}
            ref={manualRef}
            selectTextOnFocus
            multiline
            onChangeText={() => {}}
            autoCapitalize='none'
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel={text.field}
          />
          )
        : null}
      {note ? <Soft>{note}</Soft> : null}
    </>
  )
}

const styles = StyleSheet.create({
  manual: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.ink,
    minHeight: 40
  }
})
