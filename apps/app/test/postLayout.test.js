'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8')
const post = read('PostRow.js')
const pill = read('Pill.js')

test('head controls stay outside the hidden body, after the content and before the bar', (t) => {
  const body = post.indexOf('<View style={styles.content}>')
  const controls = post.indexOf('<View style={[styles.headActions, stackHead && { top: HEAD_LIFT }]}')
  t.ok(controls > body && body >= 0, 'head actions are inside the full-width content')
  const stack = []
  for (const match of post.slice(body, controls).matchAll(/<(\/)?(View|Pressable)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[0])
  }
  t.alike(stack, ['<View style={styles.content}>'], 'actions are siblings of the closed body pressable, outside hidden ancestors')
  const end = post.indexOf('<View style={styles.bar}>', controls)
  const buttons = post.slice(controls, end)
  t.ok(end > controls, 'controls precede the bar')
  t.ok(post.indexOf('{textOut ? textNode : null}') < controls && post.indexOf('<ClampControl') < controls && post.indexOf('{videoAbove ? null : previewNode}') >= 0 && post.indexOf('{videoAbove ? null : previewNode}') < controls, 'a screen reader reads the interactive caption, its clamp control and the replies before the controls')
  t.ok(buttons.includes("accessibilityLabel={'seguir ' + title}") && buttons.includes("label='mais ações'"), 'both labelled controls are in the visible accessibility tree')
  t.absent(/accessibilityElementsHidden|no-hide-descendants|accessible=\{false\}/.test(buttons), 'neither control is hidden')
  const followButtons = buttons.match(/<Pill\b[\s\S]*?\/>/g) || []
  const [follow = ''] = followButtons
  t.ok(follow.includes('onPress={otherPress(onFollow)}') && follow.includes('disabled={!!followPending}') && pill.includes('disabled: off'), 'follow retains its handler and announced pending state')
  t.ok(follow.includes("label='seguir'") && followButtons.length === 1, 'follow is one labelled pill')
  t.ok(post.includes('const ICON = 22') && post.includes('const FOLLOW_GUESS = 68'), 'actions are 22 pt and the head reserve guesses the padded pill')
  t.absent(/smallHit: \{[^}]*paddingHorizontal/.test(pill), 'the target adds no side padding, the face does')
  t.ok(follow.includes('weak') && pill.includes('weak: { backgroundColor: colors.accentSoft'), 'follow has a tinted face')
  t.ok(pill.includes('weak || link ? styles.textAccent') && pill.includes('textAccent: { color: colors.accent }'), 'follow uses the accent')
  t.ok(buttons.includes("onPress={otherPress(() => setSheet('more'))}"), 'more keeps the same sheet and cancels pending navigation')
})

test('head reserves the measured space of its absolute controls', (t) => {
  t.ok(post.includes("headActions: { position: 'absolute', top: 0, right: space.xl, flexDirection: 'row', alignItems: 'center' }"))
  t.ok(post.includes('onLayout={measureHeadActions}'), 'measurement includes text scaling')
  t.ok(post.includes('headActions && !stackHead && { paddingRight: headPad }'), 'name and date clear the width of the targets')
  t.ok(post.includes('const headPad = headReserve.width + (fn(onFollow) ? space.sm : 0)'), 'the date keeps 8 pt before the seguir pill, whose face starts at its target edge')
  t.absent(post.includes('paddingRight: headReserve.width'), 'no head padding skips the gap')
  t.ok(post.includes('const HEAD_LIFT = 12') && post.includes('paddingTop: HEAD_LIFT, minHeight: layout.hit') && post.includes('<View style={[styles.headActions, stackHead && { top: HEAD_LIFT }]}'), 'the 44 pt targets centre on the 20 pt name line')
  t.ok(post.includes('headActions && !stackHead && fn(onFollow) && { minHeight: headReserve.height - HEAD_LIFT }'), 'with seguir, the head is tall enough that its target never covers the caption')
  t.absent(post.includes('minHeight: headReserve.height }'), 'only ⋯: the head adds no height to the post')
  t.ok(post.includes('measured: headActionsSize,') && post.includes('guess: { width: (fn(onFollow) ? FOLLOW_GUESS : 0) + (hasMore ? layout.hit : 0), height: layout.hit }'), 'before measurement the targets reserve their usual size, never zero')
  t.ok(post.includes('const stackHead = headActions && (fontScale >= LARGE_TEXT || narrowHead)') && post.includes("headStacked: { flexWrap: 'wrap' }") && post.includes("stackHead && { width: '100%', paddingRight: headPad, minHeight: headReserve.height"), 'at large text the name keeps the first line beside the targets and the date wraps below them')
  t.ok(post.includes('const headActions = !!fn(onFollow) || hasMore'), 'only visible controls reserve space')
  t.ok(/<Pill\b[^/]*\bsmall\b[^/]*\/>/.test(post) && pill.includes('small ? styles.smallHit : face') && /smallHit: \{ minWidth: layout\.hit, minHeight: layout\.hit/.test(pill), 'follow keeps a 44 pt target')
  t.ok(/action: \{[^}]*minHeight: layout\.hit[^}]*minWidth: 44/.test(post), 'more keeps its Action target')
})

test('PostRow places media before the caption in both text branches', (t) => {
  t.ok(/\{videoOut \? null : mediaNode\}\s*\{textOut \|\| videoAbove \|\| videoOut \? null : textNode\}/.test(post), 'plain caption follows photos')
  t.is(post.split('{videoOut ? null : mediaNode}').length - 1, 1, 'photos keep one parent in both caption branches, so opening a caption never remounts the carousel')
  t.is(post.split('{videoOut ? mediaNode : null}').length - 1, 1, 'a video keeps one parent in both caption branches')
  t.absent(/const videoOut = [^\n]*(textOut|numberOfLines|control|hasText)/.test(post), 'caption expansion never moves the video')
  t.ok(post.indexOf('{textOut ? textNode : null}') > post.indexOf('{videoOut ? null : mediaNode}') && post.indexOf('{textOut ? textNode : null}') > post.indexOf('{videoOut ? mediaNode : null}'), 'interactive caption follows photos and the video')
  t.absent(/\{[^{}]*textOut[^{}]*mediaNode[^{}]*\}/.test(post), 'no caption branch decides where the photos render')
  t.ok(post.includes('const mediaNode = hasMedia ? <View style={styles.media}><MediaGrid'), 'text-only posts add no media')
})

test('PostRow places a video before the caption, outside the open area', async (t) => {
  t.ok(post.includes("const videoAbove = ownLink && embed.provider === 'youtube'"))
  t.absent(/const videoAbove = [^\n]*(textOut|numberOfLines|control|hasText)/.test(post), 'caption expansion never moves the player')
  t.ok(/<\/Pressable>\s*\{videoAbove \? <View style=\{styles.cards\}>\{previewNode\}<\/View> : null\}\s*\{videoOut \? mediaNode : null\}\s*\{textUnder\}\s*\{textOut \? textNode : null\}/.test(post), 'player precedes both caption branches outside the open area')
  const start = post.indexOf('<View style={styles.content}>')
  const end = post.indexOf('{videoAbove ? <View style={styles.cards}>{previewNode}</View> : null}')
  const stack = []
  for (const match of post.slice(start, end).matchAll(/<(\/)?(View|Pressable)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[0])
  }
  t.ok(start >= 0 && end > start, 'body and player found')
  t.alike(stack, ['<View style={styles.content}>'], 'player has no hidden or pressable ancestor within the body')
  t.is(post.split('{videoAbove ? <View style={styles.cards}>{previewNode}</View> : null}').length - 1, 1, 'one player slot above the caption')
  t.is(post.split('{videoAbove ? null : previewNode}').length - 1, 1, 'one lower slot for other cards')
  t.is(post.split('{previewNode}').length - 1, 1, 'the only bare player node is in the conditional upper gutter')
  t.ok(/const textUnder = \(videoAbove \|\| videoOut\) && hasText && !textOut \? <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>\{textNode\}<\/View> : null/.test(post), 'the plain caption is hidden from native and web screen readers')
  t.ok(post.includes('tabIndex={videoAbove || videoOut ? -1 : undefined}'), 'the hidden caption adds no keyboard stop')
  t.ok(post.includes("const label = textOut ? bodyParts.filter((part) => part !== shownText).join('. ') : bodyLabel"), 'the body label keeps the plain caption before the player')
  const { embedOf } = await import('../src/musicEmbed.js')
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'
  ]) t.is(embedOf(url).provider, 'youtube', url)
  for (const url of [
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=xyz',
    'https://soundcloud.com/artist-1/song_name',
    'https://music.apple.com/br/album/some-album/1440857781'
  ]) {
    const embed = embedOf(url)
    t.ok(embed !== null && embed.provider !== 'youtube', url)
  }
})

test('a posted video sits outside the hidden body layer, so screen readers reach its controls', async (t) => {
  t.ok(post.includes('const videoOut = hasMedia && videoPair(media) !== null'), 'only a poster and video pair moves out')
  const start = post.indexOf('<View style={styles.content}>')
  const end = post.indexOf('{videoOut ? mediaNode : null}')
  t.ok(start >= 0 && end > start, 'body and video slot found')
  const stack = []
  for (const match of post.slice(start, end).matchAll(/<(\/)?(View|Pressable)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[0])
  }
  t.alike(stack, ['<View style={styles.content}>'], 'the video has no hidden or pressable ancestor within the body')
  const photos = post.indexOf('{videoOut ? null : mediaNode}')
  const hidden = post.lastIndexOf("<View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>", photos)
  t.ok(hidden > start && photos > hidden, 'photos stay in the body, which speaks for them')
  const { videoPair } = await import('../src/media/plan.js')
  const poster = { mime: 'image/jpeg' }
  const video = { mime: 'video/mp4' }
  t.ok(videoPair([poster, video]) !== null, 'a poster and video pair')
  t.is(videoPair([poster]), null, 'one photo stays in the body')
  t.is(videoPair([poster, poster]), null, 'two photos stay in the body')
})

test('PostRow measures the caption column and forwards the expanded override', (t) => {
  t.ok(post.includes("import { ClampControl, captionEstimate, useClamp } from './ClampText'"))
  t.ok(post.includes('expanded = false'), 'rows clamp by default')
  t.ok(post.includes('const [captionWidth, setCaptionWidth] = useState(undefined)'), 'no zero width before layout')
  t.ok(/useClamp\(\{\s*text: shownText,\s*hasMedia,\s*width: captionWidth,\s*forceExpanded: expanded\s*\}\)/.test(post), 'sanitized caption, media, measured width and forced expansion reach the hook')
  t.ok(post.includes('<View style={styles.body} onLayout={measureCaption}>'), 'measure the text column, not the whole row')
  t.ok(/const measureCaption = \(event\) => \{\s*const next = captionWidthNext\(captionEstimate\(windowWidth\), event.nativeEvent.layout.width\)\s*if \(next !== captionWidth\) setCaptionWidth\(next\)\s*\}/.test(post), 'invalid, zero or estimated widths keep the hook fallback')
})

test('a clamped caption is plain sanitized Text and expansion restores interaction', (t) => {
  t.ok(post.includes('const textOut = hasText && numberOfLines === 0 &&'), 'links and mentions leave the body only when uncapped')
  t.ok(/<Text style=\{styles.text\} numberOfLines=\{numberOfLines\} onTextLayout=\{onTextLayout\}>\{shownText\}<\/Text>/.test(post), 'native layout refines the clamped caption')
  t.ok(post.includes('<MentionText text={body} onOpenMention={openMention} onOpenPlain={openTap} onLongPress={bodyLongPress} onTextLayout={onTextLayout} style={styles.text} hashtags />'), 'uncapped text keeps full interactive links and mentions')
  t.ok(post.includes('onTextLayout={onTextLayout} style={styles.text} hashtags />'), 'the expanded caption with links or mentions is measured too, so collapsing can drop a control it does not need')
  const mention = read('MentionText.js')
  t.is(mention.split('onTextLayout={onTextLayout}').length - 1, 2, 'MentionText hands onTextLayout to both of its root Text branches')
})

test('ClampControl is reachable outside hidden content and before the quote', (t) => {
  const control = '<ClampControl control={control} onPress={otherPress(toggle)} />'
  t.is(post.split(control).length - 1, 1, 'one control cancels pending double tap navigation')
  t.ok(post.includes('{textOut ? textNode : null}\n          <View style={styles.gutter}>' + control), 'control follows the caption')
  const start = post.indexOf('<View style={styles.content}>')
  const end = post.indexOf(control, start)
  const stack = []
  for (const match of post.slice(start, end).matchAll(/<(\/)?(View|Pressable)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[0])
  }
  t.ok(start >= 0 && end > start, 'body and control found')
  t.alike(stack, ['<View style={styles.content}>', '<View style={styles.gutter}>'], 'control has no hidden or pressable ancestor within the content gutter')
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

test('the reply line is a 44 pt replyChip and plain text without onOpenParent', (t) => {
  t.ok(post.includes("import { replyChip } from '../threadRows'"), 'chip copy comes from replyChip')
  t.ok(
    post.includes("const replyLabel = replyToName ? replyChip({ name: replyToName }) : ''") &&
    !post.includes('displayText(replyChip') &&
    !post.includes('displayText(replyLabel'),
    'the name PostRow receives, escaped inside replyChip, not twice'
  )
  t.ok(post.includes(': <Text style={styles.replyChipText} numberOfLines={1}>{replyLabel}</Text>'), 'plain text when onOpenParent is absent')
  const labelAt = post.indexOf('accessibilityLabel={replyLabel}')
  const press = post.slice(post.lastIndexOf('<Pressable', labelAt), post.indexOf('</Pressable>', labelAt))
  t.ok(
    labelAt > 0 &&
    press.includes("accessibilityRole='link'") &&
    press.includes('onPress={openParent}') &&
    press.includes('[styles.replyChip') &&
    !press.includes('hitSlop'),
    'link labelled with the chip text, no hitSlop'
  )
  t.ok(/replyChip: \{[^}]*minHeight: layout\.hit/.test(post), 'the chip box is at least 44 pt')
  t.ok(/replyChip: \{[^}]*marginVertical: -6/.test(post), 'negative margin pulls the 44 pt target in so the line costs about 32 pt')
  t.ok(post.includes('replyChipText: { ...type.meta, color: colors.soft'), 'reply line is soft meta text, and the plain branch uses it')
  const chipBox = /replyChip: \{([^}]*)\}/.exec(post)
  t.ok(chipBox && !/backgroundColor|borderRadius/.test(chipBox[1]), 'no pill behind the reply line')
  const chipAt = post.indexOf('accessibilityLabel={replyLabel}')
  t.ok(chipAt > 0 && chipAt < post.indexOf('{videoOut ? null : mediaNode}'), 'the chip stays before the photos')
})

test('reply previews are at most two sanitized lines in one Comentários button', (t) => {
  t.ok(post.includes('if (!Array.isArray(replyPreviews)) return []'), 'absent or empty renders nothing')
  t.ok(post.includes("if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue"), 'a non-object entry is ignored')
  t.ok(post.includes("if (text === '') continue"), 'an entry with empty text is ignored')
  t.ok(post.includes('oneLine(entry.text)') && post.includes('oneLine(entry.name)'), 'name and text are both sanitized')
  t.ok(post.includes('displayText(value, { multiline: true })'), 'displayText runs on each preview string')
  t.ok(post.includes('return lines.slice(0, 2)'), 'at most two previews')
  t.ok(post.includes("line.name !== '' ? line.name + ': ' + line.text : line.text"), 'Nome: texto')
  t.ok(post.includes('numberOfLines={1}>{previewLineText(line)}</Text>'), 'one line per preview')
  t.ok(!post.includes('styles.previewsLabel') && !post.includes('>Comentários</Text>'), 'no visible Comentários label: Ana comentou and the lines already say it')
  t.ok(post.includes("'Comentários. ' + previewLines.map(previewLineText)") && post.includes('.concat(moreText'), 'the button label starts with Comentários and reads each preview and the more line')
  t.is(post.split('{previewsBody}').length - 1, 2, 'the button and the plain view share one block')
  const at = post.indexOf('{previewsBody !== null')
  const block = post.slice(at, post.indexOf('<ActionsSheet', Math.max(at, 0)))
  t.ok(
    at > 0 &&
    block.split('<Pressable').length - 1 === 1 &&
    block.includes("accessibilityRole='button'") &&
    block.includes('accessibilityLabel={previewsLabel}') &&
    block.includes('onPress={openPreviews}') &&
    block.includes(': <View style={styles.previews}>{previewsBody}</View>') &&
    !block.includes('hitSlop'),
    'one button when onOpenPreviews is set, a plain view when it is absent'
  )
})

test('commentedBy header and previewsMore line', (t) => {
  t.ok(post.includes("const moreText = typeof previewsMore === 'string' ? displayText(previewsMore).trim() : ''"), 'previewsMore is sanitized and drawn with or without onOpenPreviews, so the cold-start preview keeps the live height')
  const at = post.indexOf('{previewsBody !== null')
  const block = post.slice(at, post.indexOf('<ActionsSheet', Math.max(at, 0)))
  const pressAt = block.indexOf('onPress={openPreviews}')
  const plainAt = block.indexOf(': <View style={styles.previews}>{previewsBody}</View>')
  t.ok(pressAt > 0 && block.indexOf('{previewsBody}', pressAt) < plainAt && plainAt > pressAt, 'the more line sits inside the button with onOpenPreviews and in the plain, unpressable view without it')
  t.ok(post.includes("previewsBody = previewLines.length === 0 && moreText === ''"), 'the block renders with only previewsMore')
  const previewsBlock = post.slice(post.indexOf('const previewsBody ='), post.indexOf('  return (', post.indexOf('const previewsBody =')))
  const linesAt = previewsBlock.indexOf('{previewLines.map(')
  const moreAt = previewsBlock.indexOf("{moreText !== '' ? <Text style={styles.previewLine} numberOfLines={1}>{moreText}</Text> : null}")
  t.ok(linesAt > 0 && moreAt > linesAt && moreAt < previewsBlock.lastIndexOf('</>'), 'the more line is last, inside previewsBody')
  t.ok(previewsBlock.includes('<Text key={index + \':\' + line.key} style={styles.previewLine} numberOfLines={1}>'), 'the more line has the preview lines\' style in both cases')
  t.ok(post.includes("const commenterLabel = !reposter && commentedBy && typeof commentedBy === 'object' && typeof commentedBy.label === 'string' ? displayText(commentedBy.label).trim() : ''"), 'repostedBy wins, and the label goes through displayText')
  const header = post.slice(post.indexOf('{reposter'), post.indexOf('<View style={styles.main}>'))
  const slot = header.indexOf(": commenterLabel !== ''")
  t.ok(slot > 0 && header.indexOf("<Icon name='resposta' size={14}", slot) > slot && header.indexOf('accessibilityLabel={commenterLabel}', slot) > slot, 'the header sits in the repost slot, with the resposta icon and its label spoken')
  t.ok(header.includes("accessibilityRole={openCommenter ? 'link' : 'text'}") && post.includes('otherPress(commentedBy && commentedBy.onOpen)'), 'pressable only with onOpen')
  t.ok(header.slice(slot).includes('hitSlop={repostedSlop}') && !post.includes('COMMENTER_SLOP'), 'the header takes the reposted line\'s computed slop')
  t.ok(post.includes("const headAbove = reposter || commenterLabel !== '' ? REPOSTED_GAP / 2 : ROW_PAD_TOP"), 'the head slop stops under the comentou line too')
})

test('reply preview lines: one line each, sanitized, blank and bad entries dropped, at most 2', (t) => {
  const { displayText } = require('@varanda/rpc')
  const slice = (name) => {
    const start = post.indexOf('function ' + name + ' (')
    const end = post.indexOf('\n}\n', start)
    return start === -1 || end === -1 ? '' : post.slice(start, end + 2)
  }
  const body = ['oneLine', 'replyPreviewLines', 'previewLineText'].map(slice).join('\n')
  // eslint-disable-next-line no-new-func
  const { replyPreviewLines, previewLineText } = new Function('displayText', body + '\nreturn { replyPreviewLines, previewLineText }')(displayText)
  const lines = replyPreviewLines([
    null,
    ['x'],
    { key: 'a:1', name: 'Ana', text: '   ' },
    { key: 'b:2', name: 'Bia\nSilva', text: 'oi\n\ntudo  bem' },
    { key: '', name: '', text: 'sem nome' },
    { key: 'c:3', name: 'Caio', text: 'terceira' }
  ])
  t.alike(lines, [
    { key: 'b:2', name: 'Bia Silva', text: 'oi tudo bem' },
    { key: 'p1', name: '', text: 'sem nome' }
  ])
  t.is(previewLineText(lines[0]), 'Bia Silva: oi tudo bem')
  t.is(previewLineText(lines[1]), 'sem nome', 'no name, no colon')
  t.alike(replyPreviewLines('nao'), [], 'not a list, no lines')
  const ctrl = replyPreviewLines([{ key: 'd:4', name: 'Di', text: 'a‮b' }])
  t.is(ctrl.length, 1)
  t.ok(!ctrl[0].text.includes('‮'), 'a bidi override does not reach the screen')
})

test('comment props: tag pill, reply quote and the level-driven reply label', (t) => {
  t.ok(/level, tag, replyQuote/.test(post), 'PostRow takes level, tag and replyQuote')
  t.ok(post.includes("typeof tag === 'string' ? displayText(tag).trim()"), 'the tag goes through displayText')
  t.ok(post.includes('tagText || null,'), 'the tag is part of the accessibility label')
  t.ok(post.includes('{tagText ? <Text style={styles.tag}'), 'the tag pill is drawn after the name')
  t.ok(post.includes("import { ReplyPreview } from './ReplyPreview'") && post.includes('<ReplyPreview'), 'the quote uses ReplyPreview')
  t.ok(/\{quoteShown\s*\? \([\s\S]*?: replyToName/.test(post), 'the quote takes the slot of the reply chip and replaces it')
  t.ok(post.includes("(level === 'post' ? 'comentar na publicação de ' : 'responder a ') + title"), 'only level post says comentar; undefined keeps responder a')
  t.absent(/level\s*=\s*replyToName|replyToName\s*\?\s*'comment'/.test(post), 'the level is never inferred from replyToName')
  t.ok(post.includes('quoteSpoken || (replyToName !== null'), 'screen readers hear the quote in the body label, the hidden layer does not speak it')
  t.ok(post.includes("'respondendo a ' + (quoteName ? quoteName + ': ' : '') + quoteText(replyQuote.text)"), 'the spoken quote is sanitized like the drawn one')
})

test('reply quote: screen readers reach its tap through a body action, beside activate', (t) => {
  const { compileFunction } = require('node:vm')
  const from = post.indexOf('  const bodyA11y = quotePress')
  const to = post.indexOf('  const bodyParts = [', from)
  t.ok(from >= 0 && to > from)
  const make = (quotePress, a11yOpen) => compileFunction(post.slice(from, to) + '\nreturn bodyA11y', ['quotePress', 'a11yOpen'])(quotePress, a11yOpen)
  const calls = []
  const event = (actionName) => ({ nativeEvent: { actionName } })
  const open = { onAccessibilityTap: () => calls.push('tap'), accessibilityActions: [{ name: 'activate' }], onAccessibilityAction: (e) => calls.push('open:' + e.nativeEvent.actionName) }
  const both = make(() => calls.push('quote'), open)
  t.alike(both.accessibilityActions, [{ name: 'activate' }, { name: 'mostrar a mensagem respondida', label: 'mostrar a mensagem respondida' }])
  t.is(both.onAccessibilityTap, open.onAccessibilityTap, 'the VoiceOver open stays')
  both.onAccessibilityAction(event('mostrar a mensagem respondida'))
  both.onAccessibilityAction(event('activate'))
  t.alike(calls, ['quote', 'open:activate'], 'each action reaches its own handler')
  const alone = make(() => calls.push('quote2'), null)
  t.alike(alone.accessibilityActions, [{ name: 'mostrar a mensagem respondida', label: 'mostrar a mensagem respondida' }])
  alone.onAccessibilityAction(event('activate'))
  alone.onAccessibilityAction(event('mostrar a mensagem respondida'))
  t.is(calls[calls.length - 1], 'quote2')
  t.is(make(undefined, open), open, 'no quote tap, the open actions unchanged')
  t.is(make(undefined, null), null)
  t.ok(post.includes("accessibilityHint={open ? 'abre a conversa' : undefined}\n            {...bodyA11y}"), 'on the body element')
  t.is(post.split('{...a11yOpen}').length - 1, 2, 'the hidden text and time keep the plain open actions')
})

test('the body of a row with no open is never announced as disabled', (t) => {
  t.absent(post.includes('mostrarRespondida'), 'VoiceOver speaks the action name, so it is words')
  const from = post.indexOf('<View style={styles.content}>')
  const to = post.indexOf('{...bodyA11y}', from)
  const body = post.slice(from, to)
  t.ok(from >= 0 && to > from)
  t.absent(/\bdisabled=/.test(body), 'a thread row (no open) with a reply quote or nothing at all is not dimmed')
  t.ok(body.includes("accessibilityRole={open ? 'link' : 'text'}"), 'with no open it is plain text')
  t.ok(body.includes('onPress={openTap}') && post.includes('const fn = (f) => (typeof f === \'function\' ? f : undefined)'), 'with no open, openTap is undefined and a tap does nothing')
})

test('the block gate masks the reply quote as it masks the quote', (t) => {
  const gate = post.slice(post.indexOf('function BlockGate (props) {'), post.indexOf('export const PostRow = memo(BlockGate)'))
  t.ok(gate.includes('<PostRowView {...props} quote={view.quote} replyQuote={view.replyQuote} onBlock={onBlock} />'))
})
