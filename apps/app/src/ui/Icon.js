// The app's icons: Feather glyphs from @expo/vector-icons under Portuguese
// names. The mock draws the active tab with a thicker stroke (2.3); a font
// glyph has one fixed weight, so the colour and the label weight carry the
// active state instead.

import Feather from '@expo/vector-icons/Feather'
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
  seguir: 'user-plus'
}

// lineHeight = size: the glyph's box is exactly `size` tall (on the web the
// default line height adds about 10 %, which pushed the tab labels out).
export function Icon ({ name, size = 24, color = colors.ink, style }) {
  return <Feather name={GLYPHS[name] || name} size={size} color={color} style={[{ lineHeight: size }, style]} />
}

// Loads the icon font; resolves even when loading fails (glyphs then show
// as blanks rather than crashing the app).
export async function loadIcons () {
  try {
    await Feather.loadFont()
  } catch {}
}
