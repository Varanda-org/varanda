// Chat text with *negrito*, _itálico_, ~riscado~, `código`, ||spoiler|| and
// fenced code blocks, as ../richText.js parseRich reads them. The text is a
// peer's: plain spans go through displayText and are never scanned for links
// or mentions again; only atoms (textSegments on the raw text, run once by the
// parser) become links or mentions, drawn by MentionText's SegmentSpan.
//
// Paragraphs are Texts and code blocks are Views between them. The last
// paragraph carries `trailer` (Bubble's hidden copy of the time); when the
// text ends in a code block the trailer gets a line of its own.
//
// Props: text (raw), blocks (parseRich(text), optional), onOpenMention(username),
// onLongPress, style (each paragraph's Text), trailer.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { parseRich } from '../richText'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { SegmentSpan } from './MentionText'
import { useStyles } from './ThemeProvider'
import { radius, space, type } from './theme'

export const CODE_LINES = 12
export const SPOILER_LABEL = 'spoiler, toque para mostrar'
export const COPY_CODE_LABEL = 'Copiar código'
export const SHOW_ALL_LABEL = 'ver tudo'

const COPIED_MS = 2000

// A covered spoiler draws figure spaces (U+2007, no break inside a word) in
// place of every other character, so neither the screen nor a screen reader
// has the hidden text before the tap; whitespace stays so it wraps alike.
// iOS names a nested Text button by its own text, not by its label, so the
// cover opens with the word 'spoiler' (ink on ink too) in place of the first
// covered characters: VoiceOver never announces a blank button.
function cover (text) {
  const word = 'spoiler'
  let out = ''
  for (const ch of text) out += ch === '\n' ? '\n' : /\s/.test(ch) ? ' ' : '\u2007'
  const first = out.search(/[ \n]|$/)
  return word + out.slice(Math.min(word.length, first))
}

function lookOf (span, styles) {
  const look = []
  if (span.bold) look.push(styles.bold)
  if (span.italic) look.push(styles.italic)
  if (span.strike) look.push(styles.strike)
  if (span.code) look.push(styles.code)
  if (span.spoiler) look.push(styles.spoilerOpen)
  return look
}

function CodeBlock ({ text, lang, onLongPress }) {
  const styles = useStyles(makeStyles)
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState(null)
  const alive = useRef(true)
  const timer = useRef(null)
  const copies = useRef(0)
  useEffect(() => () => {
    alive.current = false
    clearTimeout(timer.current)
  }, [])
  const shown = displayText(text, { multiline: true })
  const lines = shown.split('\n')
  const long = lines.length > CODE_LINES
  const body = long && !all ? lines.slice(0, CODE_LINES).join('\n') : shown
  // Only the latest tap's answer counts: an earlier copy that settles last
  // must not overwrite it.
  const done = (n, ok) => {
    if (!alive.current || n !== copies.current) return
    setCopied(ok)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (alive.current) setCopied(null) }, COPIED_MS)
  }
  const copy = () => {
    const n = ++copies.current
    let pending
    try {
      pending = copyText(shareNav(), shown)
    } catch {
      pending = false
    }
    Promise.resolve(pending).then((ok) => done(n, ok === true), () => done(n, false))
  }
  const copyLabel = copied === true ? 'Copiado' : copied === false ? 'Não deu para copiar' : COPY_CODE_LABEL
  return (
    <View style={styles.codeBox}>
      <View style={styles.codeHead}>
        <Text style={styles.codeLang} numberOfLines={1}>{typeof lang === 'string' ? displayText(lang) : ''}</Text>
        <Pressable accessibilityRole='button' accessibilityLabel={copyLabel} onPress={copy} onLongPress={onLongPress} hitSlop={8}>
          <Text style={styles.codeAction}>{copyLabel}</Text>
        </Pressable>
      </View>
      {/* A ScrollView grows by default (flexGrow 1). On Android that let the
          bubble around it take the list cell's whole height, far below
          its content and over the message before it. */}
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.codeScroll}>
        <Text style={styles.codeText}>{body}</Text>
      </ScrollView>
      {long && !all
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={SHOW_ALL_LABEL} onPress={() => setAll(true)} onLongPress={onLongPress} hitSlop={8} style={styles.showAll}>
            <Text style={styles.codeAction}>{SHOW_ALL_LABEL}</Text>
          </Pressable>
          )
        : null}
    </View>
  )
}

// A stored link card is built by the sender's app from the first link in the
// text, so it could show a link hidden in a spoiler before any tap. With a
// spoiler in the text, the card stays only when its url is the href of a
// link drawn outside every spoiler; revealing does not bring it back.
// blocks: parseRich output, or null for text that took the plain path.
// The sender stored card.url as new URL(href).href, which React Native's URL
// writes with a trailing slash and the web's with percent-encoding, so both
// sides are compared through that same step, decoded, without one final '/'.
// That loose key makes /final and /final/ alike, so a card whose key also
// matches a link inside a spoiler stays hidden: it may have been built from it.
export function cardBesideSpoilers (blocks, card) {
  if (card === null || !Array.isArray(blocks)) return card
  const key = (value) => {
    let out = value
    try {
      out = decodeURI(new URL(value).href)
    } catch {}
    return out.endsWith('/') ? out.slice(0, -1) : out
  }
  const target = card && typeof card.url === 'string' ? key(card.url) : null
  let spoiler = false
  let visible = false
  let hidden = false
  for (const block of blocks) {
    if (block.kind === 'code') continue
    for (const span of block.spans) {
      if (span.spoiler) spoiler = true
      const match = target !== null && span.atom && span.segment && typeof span.segment.href === 'string' && key(span.segment.href) === target
      if (match && span.spoiler) hidden = true
      else if (match) visible = true
    }
  }
  return !spoiler || (visible && !hidden) ? card : null
}

// blocks: the parse of `text` when the caller already has it.
export function RichText ({ text, blocks: parsed, onOpenMention, onLongPress, style, trailer = null }) {
  const styles = useStyles(makeStyles)
  // One tap shows every spoiler of this message, for as long as it is mounted.
  const [revealed, setRevealed] = useState(false)
  const blocks = useMemo(() => (Array.isArray(parsed) ? parsed : parseRich(text)), [parsed, text])
  const reveal = (e) => {
    if (e && e.stopPropagation) e.stopPropagation()
    setRevealed(true)
  }
  const spanNode = (span, key) => {
    const look = lookOf(span, styles)
    if (span.atom) {
      const atom = <SegmentSpan key={key} segment={span.segment} onOpenMention={onOpenMention} onLongPress={onLongPress} />
      return look.length > 0 ? <Text key={key} style={look}>{atom}</Text> : atom
    }
    return <Text key={key} style={look} onLongPress={onLongPress}>{displayText(span.text, { multiline: true })}</Text>
  }
  // A run of spoiler spans (split by an atom or a nested style) is one
  // covered button, so a screen reader announces it once.
  const spansOf = (spans) => {
    const nodes = []
    let i = 0
    while (i < spans.length) {
      if (spans[i].spoiler && !revealed) {
        let hidden = ''
        while (i < spans.length && spans[i].spoiler) hidden += spans[i++].text
        if (hidden === '') continue
        nodes.push(
          <Text
            key={nodes.length}
            style={styles.spoiler}
            accessible
            accessibilityRole='button'
            accessibilityLabel={SPOILER_LABEL}
            onPress={reveal}
            onLongPress={onLongPress}
            onKeyDown={(e) => {
              // react-native-web Text maps onPress to click only.
              if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey) return
              if (e.preventDefault) e.preventDefault()
              reveal(e)
            }}
          >
            {cover(hidden)}
          </Text>
        )
        continue
      }
      nodes.push(spanNode(spans[i], nodes.length))
      i++
    }
    return nodes
  }
  const out = blocks.map((block, b) => block.kind === 'code'
    ? <CodeBlock key={b} text={block.text} lang={block.lang} onLongPress={onLongPress} />
    : <Text key={b} style={style}>{spansOf(block.spans)}{b === blocks.length - 1 ? trailer : null}</Text>)
  if (trailer !== null && (blocks.length === 0 || blocks[blocks.length - 1].kind === 'code')) {
    out.push(<Text key='trailer' style={style}>{trailer}</Text>)
  }
  return out
}

const makeStyles = (colors) => StyleSheet.create({
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  code: { fontFamily: type.code.fontFamily, fontSize: type.code.fontSize, backgroundColor: colors.inputOff },
  spoiler: { color: colors.ink, backgroundColor: colors.ink },
  spoilerOpen: { backgroundColor: colors.skeleton },
  codeBox: {
    backgroundColor: colors.inputOff,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    marginVertical: space.xs,
    gap: space.xs
  },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  codeLang: { ...type.caption, color: colors.soft, flexShrink: 1 },
  codeAction: { ...type.caption, fontWeight: '600', color: colors.accent },
  codeScroll: { flexGrow: 0 },
  codeText: { ...type.code, color: colors.ink },
  showAll: { alignSelf: 'flex-start' }
})
