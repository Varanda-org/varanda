// Design tokens of the app (docs: apps/site/artwork/app-design.md): colors,
// avatar stripes, the sunset gradient, fonts, text styles and layout sizes.

import { Platform } from 'react-native'

export const colors = {
  bg: '#fbf8f3',
  card: '#ffffff',
  ink: '#1f2a24',
  soft: '#4a554e',
  line: 'rgba(31,42,36,0.10)',
  accent: '#1d6b4f',
  accentSoft: 'rgba(29,107,79,0.10)',
  accentInk: '#ffffff',
  warm: '#fff4e0',
  outline: 'rgba(31,42,36,0.30)',
  ring: 'rgba(31,42,36,0.12)',
  dim: 'rgba(31,42,36,0.35)',
  tabBar: 'rgba(251,248,243,0.94)',
  danger: '#a3201a',
  warn: '#8a5a00',
  placeholder: '#616c67',
  skeleton: 'rgba(31,42,36,0.08)',
  pillBg: '#1d6b4f',
  pillInk: '#ffffff'
}

// Animation durations in milliseconds.
export const motion = { fast: 150, normal: 250 }

// Avatar colors by the first key byte mod 5: azul, laranja, amarelo,
// vermelho, verde.
export const stripes = [
  { bg: '#2576b0', ink: '#ffffff' },
  { bg: '#e8805a', ink: '#1f2a24' },
  { bg: '#f2b705', ink: '#1f2a24' },
  { bg: '#c23528', ink: '#ffffff' },
  { bg: '#1d6b4f', ink: '#ffffff' }
]

export const sunsetStops = [['#f7b267', 0], ['#e8805a', 0.42], ['#8a4e7a', 0.78], ['#2b2a4a', 1]]

export const sunset = 'linear-gradient(170deg, #f7b267 0%, #e8805a 42%, #8a4e7a 78%, #2b2a4a 100%)'

export const fonts = {
  title: Platform.select({
    ios: 'ui-rounded',
    web: 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    default: undefined
  }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
}

export const type = {
  barTitle: { fontSize: 21, fontWeight: '800', lineHeight: 25, letterSpacing: -0.2 },
  profileName: { fontSize: 22, fontWeight: '800', lineHeight: 26, letterSpacing: -0.2 },
  postName: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  postMeta: { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  postText: { fontSize: 15.5, fontWeight: '400', lineHeight: 21 },
  replyMark: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  compose: { fontSize: 18, fontWeight: '400', lineHeight: 24 },
  pill: { fontSize: 15, fontWeight: '700', lineHeight: 18 },
  chip: { fontSize: 12, fontWeight: '600', lineHeight: 14 },
  tab: { fontSize: 10, fontWeight: '600', lineHeight: 12 },
  counter: { fontSize: 13, fontWeight: '600', lineHeight: 16 },
  section: { fontSize: 13, fontWeight: '700', lineHeight: 16, letterSpacing: 0.5, textTransform: 'uppercase' },
  cancel: { fontSize: 17, fontWeight: '400', lineHeight: 22 },
  sheetTitle: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  emptyTitle: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  stepLabel: { fontSize: 13, fontWeight: '700', lineHeight: 16, letterSpacing: 0.5, textTransform: 'uppercase' }
}

export const layout = {
  topBar: 52,
  tabBar: 49,
  fabSize: 56,
  fabRight: 20,
  fabAboveTabs: 17,
  sheetTop: 52,
  sheetRadius: 18,
  sheetTopRow: 56,
  band: 150,
  column: 640
}
