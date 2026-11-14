'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const more = read('ui/MoreButton.js')
const pill = read('ui/Pill.js')
const index = read('ui/index.js')
const sheet = read('ui/ActionsSheet.js')
const top = read('ui/TopActions.js')
const icons = read('ui/Icon.js')
const modal = read('ui/Sheet.js')
const bar = read('ui/TopBar.js')
const avatar = read('ui/Avatar.js')
const states = read('ui/States.js')
const row = read('ui/ConversationRow.js')

test('Sheet shows a grabber by default and only its panel header claims drags', (t) => {
  t.ok(modal.includes('grabber = true'), 'the grabber is opt-out')
  const panel = modal.slice(modal.indexOf('<Animated.View style={[styles.panel'))
  const header = panel.slice(panel.indexOf('<View style={[styles.dragHeader'), panel.indexOf('<View style={[styles.children'))
  t.ok(header.includes('{...drag.panHandlers}'), 'the header owns the responder')
  t.ok(header.startsWith('<View style={[styles.dragHeader, { paddingLeft: padL, paddingRight: padR }]} collapsable={false} {...drag.panHandlers}>'), 'Android keeps a native view for the header, so a touch on its empty part reaches the responder')
  t.ok(header.includes("{grabber ? <View style={styles.grabberRow} pointerEvents='none'>"), 'the decorative grabber shares the drag target')
  t.ok(header.includes('<TopRow onClose={onClose}'), 'header controls stay inside the target')
  t.is((modal.match(/\{\.\.\.drag.panHandlers\}/g) || []).length, 1, 'no responder on the panel or scrolling body')
  t.ok(panel.includes('onLayout={drag.handleLayout}'), 'the threshold uses measured panel height')
  t.ok(panel.includes('transform: [{ translateY: drag.y }]'), 'the whole panel follows the drag')
  const ios = modal.slice(modal.indexOf("if (Platform.OS === 'ios')"), modal.indexOf('// Landscape notch/cutout.'))
  t.ok(ios.includes("presentationStyle='pageSheet'") && ios.includes('allowSwipeDismissal={dismissable}'), 'iOS keeps native swipe dismissal')
  t.absent(ios.includes('panHandlers'), 'iOS has no competing responder')
  t.is((modal.match(/animationType=\{reduceMotion \? 'none' : 'slide'\}/g) || []).length, 2, 'both modals respect reduced motion')
})

function glyphTable (source, constName) {
  const match = source.match(new RegExp('const ' + constName + ' = \\{([^}]+)\\}'))
  if (!match) return null
  const table = {}
  for (const line of match[1].matchAll(/^\s+(\w+):\s+'([^']+)'/gm)) table[line[1]] = line[2]
  return table
}

test('new icon aliases resolve to glyphs in the set they render from', (t) => {
  // @expo/vector-icons is pinned exactly, so these maps are the fonts Icon draws.
  const iconsRoot = path.dirname(require.resolve('@expo/vector-icons/package.json'))
  const glyphMap = (set) => JSON.parse(fs.readFileSync(path.join(iconsRoot, 'build/vendor/react-native-vector-icons/glyphmaps', set + '.json'), 'utf8'))
  const maps = { Feather: glyphMap('Feather'), Ionicons: glyphMap('Ionicons') }
  const feather = glyphTable(icons, 'GLYPHS')
  const ion = glyphTable(icons, 'ION_GLYPHS')
  t.ok(feather && ion, 'both glyph tables parse')
  const body = icons.slice(icons.indexOf('export function Icon'), icons.indexOf('export async function loadIcons'))
  const ionGate = body.indexOf('if (ION_GLYPHS[name]) {')
  const ionReturn = body.indexOf('return <Ionicons name={ION_GLYPHS[name]}')
  const featherReturn = body.lastIndexOf('return <Feather name={GLYPHS[name] || name}')
  t.ok(ionGate >= 0 && ionReturn > ionGate && featherReturn > ionReturn, 'Ionicons aliases render before the Feather fallback')
  t.absent(body.slice(ionGate, ionReturn).includes('filled'), 'category icons are not gated on filled')
  t.is(feather.feira, 'shopping-bag', 'the Feira tab keeps its bag')
  const aliases = {
    codigo: ['Feather', 'code'],
    filtro: ['Feather', 'filter'],
    grade: ['Feather', 'grid'],
    lista: ['Feather', 'list'],
    mapa: ['Feather', 'map'],
    estrela: ['Feather', 'star'],
    cat_casa: ['Feather', 'home'],
    cat_roupa: ['Ionicons', 'shirt-outline'],
    cat_eletronicos: ['Feather', 'smartphone'],
    cat_moveis: ['Ionicons', 'bed-outline'],
    cat_infantil: ['Feather', 'smile'],
    cat_esporte: ['Feather', 'activity'],
    cat_veiculos: ['Feather', 'truck'],
    cat_comida: ['Feather', 'coffee'],
    cat_aulas: ['Feather', 'book-open'],
    cat_beleza: ['Feather', 'scissors'],
    cat_reparos: ['Feather', 'tool'],
    cat_outros: ['Feather', 'package']
  }
  for (const [name, [set, glyph]] of Object.entries(aliases)) {
    const table = set === 'Ionicons' ? ion : feather
    const other = set === 'Ionicons' ? feather : ion
    t.is(table[name], glyph, name + ' renders from ' + set)
    t.absent(other[name], name + ' is not also a ' + (set === 'Ionicons' ? 'Feather' : 'Ionicons') + ' alias')
    t.ok(Object.hasOwn(maps[set], glyph), name + ' exists in ' + set)
  }
  t.ok(ion.cat_roupa !== feather.feira, 'clothing is not the Feira bag')
  t.ok(ion.cat_moveis !== 'archive', 'furniture is not a storage box')
})

test('EmptyState renders an optional quiet secondary action', (t) => {
  const empty = states.slice(states.indexOf('export function EmptyState'), states.indexOf('export function ErrorState'))
  t.ok(empty.includes('secondaryLabel, onSecondary'), 'secondary props')
  t.ok(empty.includes('{actionLabel && onAction ? <Pill label={actionLabel} onPress={onAction} filled /> : null}'), 'primary action stays filled')
  t.ok(empty.includes('{secondaryLabel && onSecondary ? <Pill label={secondaryLabel} onPress={onSecondary} /> : null}'), 'quiet second button needs a label and a handler')
})

test('skeleton variants reuse Skeleton and its themed placeholders', (t) => {
  for (const name of ['SkeletonRow', 'SkeletonTile', 'SkeletonBubble']) {
    t.ok(states.includes('export function ' + name + ' ('), name + ' exported')
  }
  const rowFn = states.slice(states.indexOf('export function SkeletonRow'), states.indexOf('export function SkeletonTile'))
  const tile = states.slice(states.indexOf('export function SkeletonTile'), states.indexOf('export function SkeletonBubble'))
  const bubble = states.slice(states.indexOf('export function SkeletonBubble'), states.indexOf('export function EmptyState'))
  t.ok(rowFn.includes('return <Skeleton rows={1} />'), 'SkeletonRow is one row of Skeleton')
  t.ok(tile.includes('<Skeleton>') && tile.includes('styles.skTile') && tile.includes('styles.skImage'), 'SkeletonTile shares Skeleton')
  t.ok(bubble.includes('<Skeleton>') && bubble.includes('styles.skBubble'), 'SkeletonBubble shares Skeleton')
  t.ok(states.includes('skImage: { width: \'100%\', aspectRatio: 1, borderRadius: radius.md, backgroundColor: colors.skeleton }'), 'tile image uses the skeleton token')
  t.ok(states.includes('skBubble: { width: \'65%\', height: 56, margin: space.lg, borderRadius: radius.bubble, backgroundColor: colors.skeleton }'), 'bubble uses the skeleton token')
  t.ok(/export function Skeleton \(\{ rows = 3, children \}/.test(states), 'the default skeleton still takes rows')
})

test('skeletons share one pulse, and profile and media shapes are exported', (t) => {
  t.absent(states.includes('\u2014'), 'no em dash')
  t.ok(states.includes('export function SkeletonProfile ('), 'SkeletonProfile exported')
  t.ok(states.includes('export function SkeletonMedia ('), 'SkeletonMedia exported')
  const profile = states.slice(states.indexOf('export function SkeletonProfile'), states.indexOf('export function SkeletonMedia'))
  const media = states.slice(states.indexOf('export function SkeletonMedia'), states.indexOf('export function SkeletonRow'))
  t.ok(profile.includes('<Skeleton>') && profile.includes('styles.skBand') && profile.includes('styles.skProfileAvatar'), 'SkeletonProfile is a profile shape on Skeleton')
  t.ok(media.includes('<Skeleton>') && media.includes('styles.skMedia'), 'SkeletonMedia is a media shape on Skeleton')
  t.ok(states.includes('const pulse = new Animated.Value(0.5)'), 'one module-level pulse')
  t.ok(states.includes('if (pulseMounts !== 1) return'), 'the loop starts on the first mount')
  t.ok(states.includes('if (pulseMounts !== 0 || pulseLoop === null) return') && states.includes('pulseLoop.stop()'), 'the loop stops on the last unmount')
  t.ok(states.includes('const reduce = useReduceMotion()'), 'reduced motion comes from the shared hook')
  t.ok(states.includes('const Block = reduce ? View : Animated.View'), 'reduced motion draws a static block')
  t.ok(states.includes('skBand: { height: PROFILE_BAND, backgroundColor: colors.skeleton }'), 'the profile band uses the skeleton token')
  t.ok(states.includes('skProfileAvatar: { width: layout.hit * 2, height: layout.hit * 2, borderRadius: layout.hit, backgroundColor: colors.skeleton }'), 'the profile avatar uses the skeleton token')
  t.ok(states.includes('skMedia: { width: \'100%\', aspectRatio: 4 / 3, borderRadius: radius.bubble - 4, backgroundColor: colors.skeleton }'), 'the media block uses the skeleton token')
  t.is((states.match(/new Animated\.Value\(/g) || []).length, 2, 'the shared pulse and the new-items pill')
  t.is((states.match(/Animated\.loop\(/g) || []).length, 1, 'one loop in the file')
})

test('motion and type tokens extend the existing scale', async (t) => {
  const src = read('ui/theme.js').replace("import { Platform } from 'react-native'", 'const Platform = { select: (options) => options.default }')
  const { motion, type, fonts } = await import('data:text/javascript,' + encodeURIComponent(src))
  t.alike(motion, { fast: 150, normal: 250, press: 90, hold: 1600 })
  for (const name of ['caption', 'more', 'price', 'tileTitle', 'code']) {
    t.ok(type[name].fontSize > 0, name + ' has a font size')
    t.ok(type[name].lineHeight >= type[name].fontSize, name + ' has room for its text')
  }
  t.is(type.code.fontFamily, fonts.mono)
})

test('PressScale resolves a function style, keeps a caller transform and skips the native driver on the web', (t) => {
  const src = read('ui/PressScale.js')
  t.absent(src.includes('\u2014'), 'no em dash')
  t.ok(src.includes("const resolved = typeof style === 'function' ? style({ pressed: pressed && !disabled }) : style"), 'a function style receives { pressed } and its result is kept')
  t.ok(src.includes('StyleSheet.flatten(resolved)'), 'flatten sees the resolved style, not the function')
  t.ok(src.includes('const callerTransform = flat && Array.isArray(flat.transform) ? flat.transform : null'), 'a caller transform is taken from the resolved style')
  t.ok(src.includes('style={[resolved, pressed && !disabled ? { opacity: PRESSED_OPACITY } : null, { transform: callerTransform ? [...callerTransform, { scale }] : [{ scale }] }]}'), 'a caller transform survives ahead of the scale')
  t.absent(src.includes('style={[style,'), 'the raw style prop is not passed through')
  t.ok(src.includes("const NATIVE_DRIVER = Platform.OS !== 'web'"), 'web has no native driver')
  t.ok(src.includes('useNativeDriver: NATIVE_DRIVER'), 'timing uses NATIVE_DRIVER')
  t.absent(/useNativeDriver:\s*true/.test(src), 'the driver is not unconditional')
  t.ok(src.includes('react-native-web does not have'), 'the Platform.OS check names the missing API')
  t.ok(src.includes('pressScale({ pressed: pressed && !disabled, reduceMotion })'), 'scale follows press and reduced motion')
  t.ok(src.includes('pressTiming(reduceMotion, motion.press)'), 'duration comes from the caller')
  t.ok(src.includes('if (duration === 0)') && src.includes('scale.setValue(toValue)'), 'reduced motion sets the value and starts nothing')
  t.ok(src.includes('return () => run.stop()'), 'a new run stops the previous animation')
  t.ok(src.includes('if (disabled) setPressed(false)'), 'disabled clears a held press')
  t.ok(src.includes("accessibilityRole = 'button'"), 'button by default')
  t.ok(src.includes('accessibilityState={{ ...accessibilityState, disabled: !!disabled }}'), 'disabled reaches the accessibility state')
})

test('welcome building blocks', (t) => {
  const theme = read('ui/theme.js')
  const welcome = read('ui/Welcome.js')
  const options = read('ui/OptionRow.js')
  t.ok(index.includes('btnLarge: { minHeight: 52'), 'large button height')
  t.ok(index.includes('btnOutlineLarge: { paddingVertical: 14 }'), 'large outline padding')
  t.ok(index.includes('pageGrow: { flexGrow: 1 }'), 'page can fill the screen')
  t.ok(/export function Btn \(\{[^}]*icon[^}]*accessibilityLabel/.test(index), 'Btn keeps icon and label')
  t.ok(/export function Btn \(\{[^}]*expanded, large \}/.test(index), 'large is the last Btn parameter')
  t.ok(theme.includes('heroTitle: { fontSize: 28'), 'hero title token')
  t.ok(welcome.includes('export function WelcomeHeader'), 'welcome header export')
  t.ok(welcome.includes("accessibilityRole='header'"), 'accessible title')
  t.ok(welcome.includes('cadeira.png'), 'chair mark')
  t.absent(welcome.includes('numberOfLines'), 'welcome text wraps')
  for (const name of ['OptionsToggle', 'OptionList', 'OptionRow', 'OptionBlock']) {
    t.ok(options.includes('export function ' + name + ' ('), name + ' export')
  }
  t.ok(options.includes('aria-expanded'), 'web expanded state')
  t.ok(options.includes('accessibilityState={{ expanded'), 'native expanded state')
  for (const forbidden of ['setTimeout', 'numberOfLines', 'ActionsSheet', 'Promise']) {
    t.absent(options.includes(forbidden), 'options have no ' + forbidden)
  }
  t.ok(options.includes('minHeight: layout.hit + space.sm'), 'large option targets')
  t.ok(options.includes('onPress={onPress}'), 'tap callback passed directly')
})

test('onboarding step frame', (t) => {
  const stepper = read('ui/Stepper.js')
  for (const name of ['Stepper', 'StepLink', 'StepNotice']) {
    t.ok(stepper.includes('export function ' + name + ' ('), name + ' export')
  }
  t.ok(stepper.includes('type.heroTitle'), 'hero title token')
  t.ok(stepper.includes('minHeight: layout.hit'), 'link hit target')
  t.ok(stepper.includes("accessibilityRole='header'"), 'accessible title')
  t.ok(stepper.includes('paddingTop: space.lg, flexGrow: 1'), 'frame can fill the screen')
  t.ok(stepper.includes('spacer: { flexGrow: 1'), 'actions sit low')
  t.ok(stepper.includes('hero !== undefined'), 'a caller hero wins over the icon disc')
  t.ok(stepper.includes("children === ''"), 'an empty notice draws nothing')
  t.ok(stepper.includes("accessibilityLabel='Carregando'"), 'the busy disc is announced')
  t.ok(stepper.includes("importantForAccessibility='no-hide-descendants'"), 'decorative dots are hidden')
  t.ok(stepper.includes("typeof total === 'number'"), 'progress is optional')
  t.absent(stepper.includes('numberOfLines'), 'step text wraps')
  t.absent(stepper.includes('setTimeout'), 'no delayed actions')
})

test('MoreButton owns an ActionsSheet and hides when nothing is usable', (t) => {
  t.ok(/import \{[^}]*ActionsSheet[^}]*\} from '\.\/ActionsSheet'/.test(more), 'imports ActionsSheet')
  t.ok(/import \{[^}]*usableActions[^}]*\} from '\.\/ActionsSheet'/.test(more), 'imports usableActions')
  t.ok(more.includes('usableActions(actions)'), 'uses usableActions')
  t.ok(more.includes("icon='mais'"), 'mais icon')
})

test('nothing is clipped: no numberOfLines in Pill, Btn or sheet rows', (t) => {
  t.absent(pill.includes('numberOfLines'), 'Pill')
  const btn = index.slice(index.indexOf('export function Btn'), index.indexOf('export function Field'))
  t.absent(btn.includes('numberOfLines'), 'Btn and ConfirmStack')
  t.absent(sheet.split('\n').some((l) => l.includes('numberOfLines') && !l.includes('styles.title')), 'rows wrap')
})

test('ActionsSheet handles disabled, pending and description rows', (t) => {
  t.ok(sheet.includes('a.pending'), 'pending')
  t.ok(sheet.includes('a.disabled'), 'disabled')
  t.ok(sheet.includes('a.description'), 'description')
  t.ok(sheet.includes('accessibilityState'), 'accessibility state')
})

test('Pill and Btn take an icon, ConfirmStack is exported', (t) => {
  t.ok(pill.includes('icon'), 'Pill icon')
  t.ok(/export function Btn \(\{[^}]*icon[^}]*accessibilityLabel/.test(index), 'Btn icon and label')
  t.ok(index.includes('export function ConfirmStack'), 'ConfirmStack')
  t.ok(/IconAction \(\{[^}]*pending[^}]*danger/.test(top), 'IconAction pending and danger')
  for (const n of ['mensagem', 'esquerda', 'direita', 'baixo', 'info', 'sair']) t.ok(icons.includes(n + ':'), n)
})

test('ConfirmStack and buttons hold up on a phone', (t) => {
  t.ok(/confirmStack: \{[^}]*alignItems: 'stretch'/.test(index), 'the pair is full width')
  t.ok(index.includes('<Btn block {...confirm} />') && index.includes('cloneElement(el, { block: true })'), 'both forms of each side stretch')
  t.ok(/btnBlock: \{ alignSelf: 'stretch' \}/.test(index), 'block Btn')
  t.absent(/ {2}btn: \{[^}]*flexDirection: 'row'/.test(index), 'only a Btn with an icon is a row')
  t.ok(/btnText: \{[^}]*paddingHorizontal: 1/.test(index) && /text: \{[^}]*paddingHorizontal: 1/.test(pill), 'labels keep a pixel of slack inside the outline')
  t.ok(pill.includes('iconEnd') && icons.includes("escolher: 'chevron-down'"), 'a choice pill ends in a chevron')
})

test('large text: headers fit their room, avatars and badges hold their text', (t) => {
  t.ok(modal.includes('paddingHorizontal: pad') && modal.includes("onLayout={measure('left')}") && modal.includes("onLayout={measure('right')}"), 'sheet title padded by the measured side controls')
  t.absent(modal.includes('paddingHorizontal: 96'), 'no fixed title padding')
  t.ok(modal.includes('numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP}'), 'sheet title one line, capped')
  t.ok(bar.includes('numberOfLines: 1, adjustsFontSizeToFit: true') && !bar.includes('numberOfLines={2}'), 'top bar title never splits a word')
  t.ok(avatar.includes('allowFontScaling={false}') && avatar.includes('Math.round(size * 0.36)'), 'initials sized to the avatar')
  t.ok(row.includes('dot: { width: 8, height: 8, borderRadius: 4') && !row.includes('badgeText'), 'unread is a digitless 8 pt disc')
})

test('states, pills and section headers', (t) => {
  t.ok(states.includes('<Soft style={styles.emptyBody}>') && /emptyBody: \{ textAlign: 'center' \}/.test(states), 'empty body centred')
  t.absent(states.includes("'tentar de novo'"), 'retry label capitalised')
  t.ok(states.includes("label='Tentar de novo'"))
  t.ok(pill.includes('accessibilityLabel={accessibilityLabel || (iconOnly ? undefined : label)}'), 'worded pill read by its label')
  t.ok(index.includes('export function FlushSectionHeader') && /sectionFlush: \{ paddingHorizontal: 0 \}/.test(index), 'flush section header')
})

test('ActionsSheet title is a caption and the current choice gets a check', (t) => {
  t.ok(/titleBox: \{[^}]*borderBottomWidth/.test(sheet), 'divider under the title')
  t.ok(/title: \{ \.\.\.type\.replyMark/.test(sheet), 'caption-size title')
  t.ok(sheet.includes("selected ? <Icon name='ok'"), 'check on the selected row')
  t.ok(sheet.includes('off && !selected && styles.off'), 'the selected row is not dimmed')
})

test('a sheet row description is read with its label', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'ActionsSheet.js'), 'utf8')
  t.ok(src.includes("a.label + ', ' + a.description"), 'screen readers hear the explanation, not only the label')
})

test('a Sheet header pill is capped like the rest of the header', (t) => {
  t.ok(modal.includes('export const TEXT_CAP = 1.3'))
  t.ok(pill.includes('maxFontSizeMultiplier={maxFontSizeMultiplier}>'), 'Pill passes the cap to its label')
  for (const f of ['screens/Perfil.js', 'screens/Publicar.js']) {
    const src = read(f)
    t.ok(/right=\{(?:editor !== null \? null : )?<Pill .*maxFontSizeMultiplier=\{TEXT_CAP\} \/>\}/.test(src), f + ' caps its header pill')
  }
})

test('Sheet and ActionsSheet take web Escape through the shared layer stack', (t) => {
  t.ok(modal.includes("import { useEscapeLayer } from './escapeLayer'"), 'Sheet uses the layer hook')
  t.ok(modal.indexOf("useEscapeLayer(!!open, onClose, 'sheet')") < modal.indexOf("if (Platform.OS === 'ios')"), 'registered before any early return')
  t.ok(sheet.includes("useEscapeLayer(shown, onClose, 'actions')"), 'ActionsSheet uses the layer hook')
  t.absent(sheet.includes('addEventListener'), 'no listeners of its own')
  t.ok(sheet.includes("escapeLayerCount('actions') > 0"), 'actionsSheetOpen counts menu layers')
})

test('round 8: filled and outline pills share a height', (t) => {
  const pill = read('ui/Pill.js')
  t.ok(pill.includes('paddingVertical: 9.5, paddingHorizontal: 17'), 'filled 9.5 = outline 8 + 1.5 border')
})

test('the sheet Cancelar is a 44 pt target', (t) => {
  const fs = require('fs')
  const path = require('path')
  const sheet = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Sheet.js'), 'utf8')
  t.ok(sheet.includes("cancelHit: { minHeight: 44, justifyContent: 'center' }") && sheet.includes('style={styles.cancelHit}'))
})

test('round 10: backdrops leave the web tab order and narrow sheet titles use their room', (t) => {
  const fs = require('fs')
  const path = require('path')
  for (const f of ['Sheet.js', 'ActionsSheet.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8')
    t.ok(src.includes('<Backdrop style={styles.backdrop} onClose={onClose} />'), f + ' uses the shared backdrop')
  }
  const sheet = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Sheet.js'), 'utf8')
  t.ok(sheet.includes('sides.row < 360') && sheet.includes('paddingLeft: sides.left + TITLE_GAP'), 'asymmetric title padding under 360 pt')
  const editor = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'AvatarEditor.js'), 'utf8')
  t.ok(editor.includes("moveControls: { alignSelf: 'flex-start', gap: 8 }"), 'the arrow pad lines up with the editor')
})

test('a long menu scrolls inside a panel capped at 85% of the screen', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'ActionsSheet.js'), 'utf8')
  t.ok(src.includes('maxHeight: Math.round(height * 0.85)') && src.includes("<ScrollView bounces={false} style={styles.rows} keyboardShouldPersistTaps='handled'>"), 'every action stays reachable at large text')
})

test('the web backdrop is not a button, so the modal focus trap skips it', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'Backdrop.js'), 'utf8')
  const web = src.slice(src.indexOf("if (Platform.OS === 'web')"), src.indexOf('return <Pressable'))
  t.ok(web.includes('<View') && web.includes('onResponderRelease={onClose}'), 'a plain view takes the tap')
  t.absent(web.includes('accessibilityRole') || web.includes('Pressable') || web.includes('tabIndex'), 'no role, no tab stop')
})

test('small Btn and Pill keep a 32 pt face inside a 44 pt target', (t) => {
  t.absent(index.includes('\u2014') || pill.includes('\u2014'), 'no em dash')
  t.ok(/export function Btn \(\{[^}]*small, expanded, large \}/.test(index), 'small sits before expanded and large stays last')
  t.ok(index.includes('btnSmall: { minHeight: 32, paddingVertical: 0, paddingHorizontal: 12 }'), 'small button face and horizontal padding')
  t.ok(index.includes('btnTextSmall: { fontSize: 13, lineHeight: 16 }'), 'small button label is 13')
  t.ok(index.includes("btnSmallHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' }"), 'small button target is the 44 pt hit')
  t.ok(index.includes('btnPressed: { opacity: PRESSED_OPACITY }'), 'Btn uses the shared pressed opacity')
  const btn = index.slice(index.indexOf('export function Btn'), index.indexOf('export function ConfirmStack'))
  t.absent(btn.includes('haptics') || btn.includes('tap('), 'Btn has no haptic')
  t.ok(/export function Pill \(\{[^}]*small \}/.test(pill), 'Pill gains small')
  t.ok(pill.includes('small: { minHeight: 32, paddingVertical: 0, paddingHorizontal: 12 }'), 'small pill face and horizontal padding')
  t.ok(pill.includes('textSmall: { fontSize: 13, lineHeight: 16 }'), 'small pill label is 13')
  t.ok(pill.includes("smallHit: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' }"), 'small pill target is the 44 pt hit')
  t.ok(pill.includes('pressed: { opacity: PRESSED_OPACITY }'), 'Pill uses the shared pressed opacity')
  t.absent(pill.includes('haptics') || pill.includes('tap('), 'Pill has no haptic')
  t.ok(read('ui/PressScale.js').includes('pressed && !disabled ? { opacity: PRESSED_OPACITY } : null'), 'PressScale fades on press without skipping reduced motion')
})

test('a sheet title shrinks to fit at large text before it is cut', (t) => {
  t.ok(modal.includes("<Text style={[styles.title, fit]} numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP} adjustsFontSizeToFit minimumFontScale={narrow ? TITLE_MIN_SCALE_NARROW : TITLE_MIN_SCALE} accessibilityRole='header'>"), 'native shrink as a fallback')
  t.ok(modal.includes('const TITLE_MIN_SCALE = 0.7'), 'down to 70%')
  // react-native-web ignores adjustsFontSizeToFit: the font is scaled from a
  // hidden copy's measured width against the room the side padding leaves.
  t.ok(modal.includes('onLayout={measureTitle}') && modal.includes("importantForAccessibility='no-hide-descendants' accessibilityElementsHidden"), 'a hidden, unread measuring copy')
  t.ok(modal.includes('const scale = natural > 0 && room > 0 && natural > room ? Math.max(narrow ? TITLE_MIN_SCALE_NARROW : TITLE_MIN_SCALE, (room / natural) * TITLE_FIT_MARGIN) : 1'), 'scale only when it does not fit, with a margin')
  t.ok(modal.includes('const TITLE_FIT_MARGIN = 0.93') && modal.includes('const TITLE_MIN_SCALE_NARROW = 0.6'), 'margin and narrow floor')
  t.ok(modal.includes('fontSize: type.sheetTitle.fontSize * scale'), 'the font shrinks on every platform')
})

test('loadIcons loads each font apart, so a Feather failure still loads Ionicons', (t) => {
  const fs = require('fs')
  const path = require('path')
  const icon = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Icon.js'), 'utf8')
  const fn = icon.slice(icon.indexOf('export async function loadIcons'))
  t.ok(fn.includes('try { await Feather.loadFont() } catch {}'))
  t.ok(fn.includes('try { await Ionicons.loadFont() } catch {}'))
})
