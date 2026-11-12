// The app's icons: Feather glyphs from @expo/vector-icons under Portuguese
// names. The mock draws the active tab with a thicker stroke (2.3); a font
// glyph has one fixed weight, so the colour carries the active state instead.

import Feather from '@expo/vector-icons/Feather'
import Ionicons from '@expo/vector-icons/Ionicons'
import { View } from 'react-native'
import { useTheme } from './ThemeProvider'

const GLYPHS = {
  casa: 'home',
  gente: 'users',
  pessoa: 'user',
  resposta: 'message-circle',
  conversas: 'message-square',
  feira: 'shopping-bag',
  lapis: 'edit-2',
  engrenagem: 'settings',
  sinc: 'refresh-cw',
  rede: 'wifi',
  semconexao: 'wifi-off',
  voltar: 'chevron-left',
  seta: 'chevron-right',
  fechar: 'x',
  bandeira: 'flag',
  bloquear: 'slash',
  seta_cima: 'arrow-up',
  copiar: 'copy',
  chave: 'key',
  ok: 'check',
  atualizar: 'rotate-cw',
  olho: 'eye',
  olho_fechado: 'eye-off',
  seguir: 'user-plus',
  sino: 'bell',
  coracao: 'heart',
  republicar: 'repeat',
  citar: 'edit-3',
  lixeira: 'trash-2',
  lupa: 'search',
  mais: 'more-horizontal',
  compartilhar: 'share',
  link: 'link',
  microfone: 'mic',
  camera: 'camera',
  imagem: 'image',
  encaminhar: 'corner-up-right',
  responder: 'corner-up-left',
  tocar: 'play',
  pausar: 'pause',
  parar: 'square',
  sorriso: 'smile',
  clipe: 'paperclip',
  mensagem: 'mail',
  esquerda: 'arrow-left',
  direita: 'arrow-right',
  baixo: 'arrow-down',
  escolher: 'chevron-down',
  info: 'info',
  codigo: 'code',
  filtro: 'filter',
  grade: 'grid',
  lista: 'list',
  mapa: 'map',
  estrela: 'star',
  cat_casa: 'home',
  cat_eletronicos: 'smartphone',
  cat_infantil: 'smile',
  cat_esporte: 'activity',
  cat_veiculos: 'truck',
  cat_comida: 'coffee',
  cat_aulas: 'book-open',
  cat_beleza: 'scissors',
  cat_reparos: 'tool',
  cat_outros: 'package',
  sair: 'log-out'
}

// The Feira tab already uses Feather's bag, and Feather's archive reads as a
// storage box. Clothing and furniture use Ionicons outlines (the set already
// loaded for the filled heart).
const ION_GLYPHS = {
  cat_roupa: 'shirt-outline',
  cat_moveis: 'bed-outline'
}

// lineHeight = size: the glyph's box is exactly `size` tall (on the web the
// default line height adds about 10 %, which pushed the tab labels out).
export function Icon ({ name, size = 24, color, style, filled }) {
  const { colors } = useTheme()
  const tint = color === undefined ? colors.ink : color
  // Feather has no chair: drawn on its 24-unit grid with the same 2-unit stroke.
  if (name === 'cadeira') {
    const unit = size / 24
    const stroke = { position: 'absolute', borderColor: tint, borderWidth: 2 * unit, borderRadius: 2 * unit }
    const leg = { position: 'absolute', top: 15 * unit, width: 2 * unit, height: 6 * unit, borderRadius: unit, backgroundColor: tint }
    return (
      <View style={[{ width: size, height: size }, style]}>
        <View style={{ ...stroke, left: 7 * unit, top: 3 * unit, width: 10 * unit, height: 10 * unit }} />
        <View style={{ ...stroke, left: 4 * unit, top: 11 * unit, width: 16 * unit, height: 6 * unit }} />
        <View style={{ ...leg, left: 5 * unit }} />
        <View style={{ ...leg, left: 17 * unit }} />
      </View>
    )
  }
  // Feather has no street, so it is drawn on its 24-unit grid with the same
  // stroke; the scene is the street seen from the veranda (road to the horizon,
  // dashed centre line). End points (3,20)-(10,6) and (21,20)-(14,6).
  if (name === 'rua') {
    const unit = size / 24
    const bar = { position: 'absolute', backgroundColor: tint, borderRadius: unit }
    const edge = { ...bar, top: (13 - 15.65 / 2) * unit, width: 2 * unit, height: 15.65 * unit }
    const dash = { ...bar, left: 11 * unit, width: 2 * unit }
    return (
      <View style={[{ width: size, height: size }, style]}>
        <View style={{ ...bar, left: 8 * unit, top: 4 * unit, width: 8 * unit, height: 2 * unit }} />
        <View style={{ ...edge, left: (6.5 - 1) * unit, transform: [{ rotate: '26.57deg' }] }} />
        <View style={{ ...edge, left: (17.5 - 1) * unit, transform: [{ rotate: '-26.57deg' }] }} />
        <View style={{ ...dash, top: 15 * unit, height: 4 * unit }} />
        <View style={{ ...dash, top: 10.5 * unit, height: 3 * unit }} />
        <View style={{ ...dash, top: 7.5 * unit, height: 2 * unit }} />
      </View>
    )
  }
  // Feather has outline glyphs only: a liked heart is the solid Ionicons one.
  if (name === 'coracao' && filled) {
    return <Ionicons name='heart' size={size} color={tint} style={[{ lineHeight: size }, style]} />
  }
  if (ION_GLYPHS[name]) {
    return <Ionicons name={ION_GLYPHS[name]} size={size} color={tint} style={[{ lineHeight: size }, style]} />
  }
  return <Feather name={GLYPHS[name] || name} size={size} color={tint} style={[{ lineHeight: size }, style]} />
}

// Loads the icon fonts; resolves even when loading fails (glyphs then show
// as blanks rather than crashing the app).
export async function loadIcons () {
  try {
    await Feather.loadFont()
    await Ionicons.loadFont()
  } catch {}
}
