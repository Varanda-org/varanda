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
  t.ok(/badge: \{[^}]*minHeight: 20/.test(row) && !/badge: \{[^}]*\n {4}height: 20/.test(row), 'unread badge grows with its digits')
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
