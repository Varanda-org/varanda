'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8')
const post = read('PostRow.js')

test('PostRow places media before the caption in both text branches', (t) => {
  t.ok(/\{mediaNode\}\s*\{textOut \? null : textNode\}/.test(post), 'plain caption follows photos')
  t.is(post.split('{mediaNode}').length - 1, 1, 'photos keep one parent in both caption branches, so opening a caption never remounts the carousel')
  t.ok(post.indexOf('{textOut ? textNode : null}') > post.indexOf('{mediaNode}'), 'interactive caption follows photos')
  t.absent(/\{[^{}]*textOut[^{}]*mediaNode[^{}]*\}/.test(post), 'no caption branch decides where the photos render')
  t.ok(post.includes('const mediaNode = hasMedia ? <MediaGrid'), 'text-only posts add no media')
})

test('PostRow measures the caption column and forwards the expanded override', (t) => {
  t.ok(post.includes("import { ClampControl, useClamp } from './ClampText'"))
  t.ok(post.includes('expanded = false'), 'rows clamp by default')
  t.ok(post.includes('const [captionWidth, setCaptionWidth] = useState(undefined)'), 'no zero width before layout')
  t.ok(/useClamp\(\{\s*text: shownText,\s*hasMedia,\s*width: captionWidth,\s*forceExpanded: expanded\s*\}\)/.test(post), 'sanitized caption, media, measured width and forced expansion reach the hook')
  t.ok(post.includes('<View style={styles.body} onLayout={measureCaption}>'), 'measure the text column, not the whole row')
  t.ok(/const measureCaption = \(event\) => \{\s*const width = event.nativeEvent.layout.width\s*setCaptionWidth\(Number.isFinite\(width\) && width > 0 \? width : undefined\)\s*\}/.test(post), 'invalid or zero widths keep the hook fallback')
})

test('a clamped caption is plain sanitized Text and expansion restores interaction', (t) => {
  t.ok(post.includes('const textOut = hasText && numberOfLines === 0 &&'), 'links and mentions leave the body only when uncapped')
  t.ok(/<Text style=\{styles.text\} numberOfLines=\{numberOfLines\} onTextLayout=\{onTextLayout\}>\{shownText\}<\/Text>/.test(post), 'native layout refines the clamped caption')
  t.ok(post.includes('<MentionText text={text} onOpenMention={openMention} onOpenPlain={openTap} onTextLayout={onTextLayout} style={styles.text} />'), 'uncapped text keeps full interactive links and mentions')
  t.ok(post.includes('onTextLayout={onTextLayout} style={styles.text} />'), 'the expanded caption with links or mentions is measured too, so collapsing can drop a control it does not need')
  const mention = read('MentionText.js')
  t.is(mention.split('onTextLayout={onTextLayout}').length - 1, 2, 'MentionText hands onTextLayout to both of its root Text branches')
})

test('ClampControl is reachable outside hidden content and before the quote', (t) => {
  const control = '<ClampControl control={control} onPress={otherPress(toggle)} />'
  t.is(post.split(control).length - 1, 1, 'one control cancels pending double tap navigation')
  t.ok(post.includes('{textOut ? textNode : null}\n          ' + control), 'control follows the caption')
  const start = post.indexOf('<View style={styles.body}')
  const end = post.indexOf(control, start)
  const stack = []
  for (const match of post.slice(start, end).matchAll(/<(\/)?(View|Pressable)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[0])
  }
  t.ok(start >= 0 && end > start, 'body and control found')
  t.alike(stack, ['<View style={styles.body} onLayout={measureCaption}>'], 'control has no hidden or pressable ancestor within the body')
  t.ok(post.indexOf('{quoteNode}', end) > end, 'quote stays after the caption control')
  t.ok(read('QuoteCard.js').includes('numberOfLines={6}'), 'quote keeps its own six-line limit')
})

test('screen readers retain the whole caption and reply context', (t) => {
  const parts = post.slice(post.indexOf('const bodyParts = ['), post.indexOf('const bodyLabel ='))
  t.ok(parts.includes("'respondendo a ' + displayText(replyToName)"))
  t.ok(parts.includes('shownText,'), 'the label uses the complete sanitized caption')
  t.absent(/slice|substring|numberOfLines/.test(parts), 'no truncation of the accessible caption')
  t.ok(post.includes("const label = textOut ? bodyParts.filter((part) => part !== shownText).join('. ') : bodyLabel"), 'only separately accessible text leaves the body label')
  t.ok(post.includes('accessibilityLabel={label}'))
})
