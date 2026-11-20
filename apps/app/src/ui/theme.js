// Design tokens of the app (docs: apps/site/artwork/app-design.md): colors,
// avatar stripes, the sunset gradient, fonts, text styles, spacing, radii
// and layout sizes.

import { Platform } from 'react-native'

// Animation durations in milliseconds.
export const motion = { fast: 150, normal: 250, press: 90, hold: 1600 }

// Avatar colors by the first key byte mod 8: azul, laranja, amarelo,
// vermelho, verde, ameixa, azul-petroleo, rosa. ReplyPreview keeps a name
// colour per entry, in the same order.
export const stripes = [
  { bg: '#2576b0', ink: '#ffffff' },
  { bg: '#e8805a', ink: '#1f2a24' },
  { bg: '#f2b705', ink: '#1f2a24' },
  { bg: '#c23528', ink: '#ffffff' },
  { bg: '#1d6b4f', ink: '#ffffff' },
  { bg: '#8a4e7a', ink: '#ffffff' },
  { bg: '#0e7a82', ink: '#ffffff' },
  { bg: '#b03a6e', ink: '#ffffff' }
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

// The browser draws its own focus ring inside our rounded fields; those
// fields show focus on the whole pill instead (searchFocus below). Web only:
// native text fields have no such ring.
export const webInputReset = Platform.OS === 'web' ? { outlineStyle: 'none' } : {}

// The font scale from which the @nome leaves post and quote headers. Android's
// 1.3 step arrives as 1.2999999523, so it sits just under 1.3.
export const LARGE_TEXT = 1.29

export const type = {
  heroTitle: { fontSize: 28, fontWeight: '800', lineHeight: 34, letterSpacing: -0.4 },
  barTitle: { fontSize: 24, fontWeight: '600', lineHeight: 32, letterSpacing: -0.24 },
  profileName: { fontSize: 22, fontWeight: '800', lineHeight: 26, letterSpacing: -0.2 },
  postName: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  postMeta: { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  postText: { fontSize: 15.5, fontWeight: '400', lineHeight: 21 },
  replyMark: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  meta: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  more: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  price: { fontSize: 20, fontWeight: '800', lineHeight: 26 },
  tileTitle: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  code: { fontSize: 14, fontWeight: '400', lineHeight: 20, fontFamily: fonts.mono },
  compose: { fontSize: 18, fontWeight: '400', lineHeight: 24 },
  pill: { fontSize: 15, fontWeight: '600', lineHeight: 18 },
  chip: { fontSize: 12, fontWeight: '600', lineHeight: 14 },
  tab: { fontSize: 10, fontWeight: '600', lineHeight: 12 },
  counter: { fontSize: 13, fontWeight: '600', lineHeight: 16 },
  section: { fontSize: 13, fontWeight: '700', lineHeight: 16, letterSpacing: 0.5, textTransform: 'uppercase' },
  cancel: { fontSize: 17, fontWeight: '400', lineHeight: 22 },
  sheetTitle: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  emptyTitle: { fontSize: 18, fontWeight: '600', lineHeight: 24 },
  rowName: { fontSize: 16, fontWeight: '600', lineHeight: 24 },
  threadTitle: { fontSize: 20, fontWeight: '600', lineHeight: 28 },
  stepLabel: { fontSize: 13, fontWeight: '700', lineHeight: 16, letterSpacing: 0.5, textTransform: 'uppercase' }
}

// Pair raised with colors.shadow for scheme-aware color. The kit levels carry their own colors.
export const elevation = {
  xs: '0px 4px 4px 0px rgba(0,0,0,0.01), 0px 1px 2px 0px rgba(0,0,0,0.04)',
  sm: '0px 3px 5px -2px rgba(0,0,0,0.05), 0px 9px 10px -2px rgba(0,0,0,0.03)',
  md: '0px 4px 6px -4px rgba(0,0,0,0.08), 0px 10px 15px -3px rgba(0,0,0,0.05)',
  lg: '0px 5px 6px -5px rgba(0,0,0,0.05), 0px 12px 18px -3px rgba(0,0,0,0.08)',
  xl: '0px 6px 10px -5px rgba(0,0,0,0.10), 0px 14px 20px -5px rgba(0,0,0,0.08)',
  xxl: '0px 8px 10px -6px rgba(0,0,0,0.12), 0px 25px 30px -6px rgba(0,0,0,0.12)',
  edge: '6px 0px 12px -4px rgba(0,0,0,0.08)',
  raised: '0px 6px 16px'
}

// The scale below is frozen so one screen cannot resize it for the rest.
export const space = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
})

export const radius = Object.freeze({
  sm: 8,
  md: 12,
  lg: 18,
  bubble: 24,
  pill: 999
})

export const layout = Object.freeze({
  topBar: 64,
  tabBar: 78,
  fabSize: 56,
  fabRight: 20,
  fabAboveTabs: 17,
  sheetTop: 52,
  sheetRadius: 48,
  sheetTopRow: 56,
  band: 150,
  column: 640,
  hit: 44
})
