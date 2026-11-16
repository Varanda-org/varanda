// Profile themes: eight palettes for the profile band and its accents, one set
// per scheme. Pure (no react-native). The id travels in the profile-about
// record, so an unknown id from a peer falls back to the default.
import { contrastRatio } from './appearance.js'

export const DEFAULT_THEME = 'varanda'

// band/bandInk: the band behind the name and its text. accent/accentInk: a
// button or chip on a card and its label. tint: a soft wash for chips.
function theme (id, label, lightColors, darkColors) {
  return Object.freeze({
    id,
    label,
    light: Object.freeze(lightColors),
    dark: Object.freeze(darkColors)
  })
}

export const THEMES = Object.freeze([
  theme('varanda', 'Varanda',
    { band: '#fde3c4', bandInk: '#4a2a0c', accent: '#1d6b4f', accentInk: '#ffffff', tint: '#e3f1ea' },
    { band: '#3a2a1c', bandInk: '#fbe9d3', accent: '#5dcaa0', accentInk: '#10241c', tint: '#23352d' }),
  theme('floresta', 'Floresta',
    { band: '#d5ead9', bandInk: '#143524', accent: '#1d6b4f', accentInk: '#ffffff', tint: '#e3f1ea' },
    { band: '#1d3328', bandInk: '#d9f1e3', accent: '#5dcaa0', accentInk: '#10241c', tint: '#23352d' }),
  theme('mar', 'Mar',
    { band: '#d3e8f5', bandInk: '#0f2e47', accent: '#1b5e8c', accentInk: '#ffffff', tint: '#e1eef7' },
    { band: '#1a2f40', bandInk: '#d8ecfa', accent: '#7cc0ea', accentInk: '#0d2233', tint: '#22384a' }),
  theme('por-do-sol', 'Pôr do sol',
    { band: '#fbd5c4', bandInk: '#4d1f0c', accent: '#b04a1a', accentInk: '#ffffff', tint: '#fbe7dc' },
    { band: '#40241a', bandInk: '#fde0d2', accent: '#f0966a', accentInk: '#2b1105', tint: '#4a2e24' }),
  theme('ipe', 'Ipê',
    { band: '#fbefb8', bandInk: '#453400', accent: '#7a5a00', accentInk: '#ffffff', tint: '#fbf3d2' },
    { band: '#3a3112', bandInk: '#fdf1bd', accent: '#e6c447', accentInk: '#2a2000', tint: '#473d1a' }),
  theme('flor', 'Flor',
    { band: '#f7d6e4', bandInk: '#4a1230', accent: '#a02a62', accentInk: '#ffffff', tint: '#f9e4ee' },
    { band: '#3d1f2f', bandInk: '#fbdbe9', accent: '#ee8fba', accentInk: '#2b0a1b', tint: '#4a2a3b' }),
  theme('lavanda', 'Lavanda',
    { band: '#e4dcf6', bandInk: '#2a1b55', accent: '#5b3fb0', accentInk: '#ffffff', tint: '#ece6f9' },
    { band: '#2b2444', bandInk: '#e6dffa', accent: '#b8a2f0', accentInk: '#1a1035', tint: '#372f55' }),
  theme('terra', 'Terra',
    { band: '#ead9c8', bandInk: '#3a2414', accent: '#8a4a22', accentInk: '#ffffff', tint: '#f0e4d6' },
    { band: '#35291f', bandInk: '#f0e0cf', accent: '#d9a06c', accentInk: '#261507', tint: '#43362a' })
])

export const THEME_IDS = Object.freeze(THEMES.map((t) => t.id))

export function isThemeId (id) {
  return typeof id === 'string' && THEME_IDS.includes(id)
}

export function themeFor (id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME)
}

export function themeColors (id, scheme) {
  const t = themeFor(id)
  return scheme === 'dark' ? t.dark : t.light
}

// Text pairs that must stay readable, for the tests and for any picker.
export function textPairs (palette) {
  return [[palette.bandInk, palette.band], [palette.accentInk, palette.accent]]
}

export function worstContrast (palette) {
  return Math.min(...textPairs(palette).map(([a, b]) => contrastRatio(a, b)))
}
