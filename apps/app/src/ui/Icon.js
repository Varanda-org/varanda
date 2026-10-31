// The app's icons: Feather glyphs from @expo/vector-icons under Portuguese
// names. The mock draws the active tab with a thicker stroke (2.3); a font
// glyph has one fixed weight, so the colour and the label weight carry the
// active state instead.

import Feather from '@expo/vector-icons/Feather'
import { View } from 'react-native'
import { colors } from './theme'

const GLYPHS = {
  casa: 'home',
  gente: 'users',
  pessoa: 'user',
  resposta: 'message-circle',
  lapis: 'edit-2',
  engrenagem: 'settings',
  sinc: 'refresh-cw',
  rede: 'wifi',
  semconexao: 'wifi-off',
  voltar: 'chevron-left',
  seta: 'chevron-right',
  fechar: 'x',
  bandeira: 'flag',
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
  lixeira: 'trash-2'
}

// lineHeight = size: the glyph's box is exactly `size` tall (on the web the
// default line height adds about 10 %, which pushed the tab labels out).
export function Icon ({ name, size = 24, color = colors.ink, style }) {
  // Feather has no chair: drawn on its 24-unit grid with the same 2-unit stroke.
  if (name === 'cadeira') {
    const unit = size / 24
    const stroke = { position: 'absolute', borderColor: color, borderWidth: 2 * unit, borderRadius: 2 * unit }
    const leg = { position: 'absolute', top: 15 * unit, width: 2 * unit, height: 6 * unit, borderRadius: unit, backgroundColor: color }
    return (
      <View style={[{ width: size, height: size }, style]}>
        <View style={{ ...stroke, left: 7 * unit, top: 3 * unit, width: 10 * unit, height: 10 * unit }} />
        <View style={{ ...stroke, left: 4 * unit, top: 11 * unit, width: 16 * unit, height: 6 * unit }} />
        <View style={{ ...leg, left: 5 * unit }} />
        <View style={{ ...leg, left: 17 * unit }} />
      </View>
    )
  }
  return <Feather name={GLYPHS[name] || name} size={size} color={color} style={[{ lineHeight: size }, style]} />
}

// Loads the icon font; resolves even when loading fails (glyphs then show
// as blanks rather than crashing the app).
export async function loadIcons () {
  try {
    await Feather.loadFont()
  } catch {}
}
