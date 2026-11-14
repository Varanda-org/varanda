// Appearance: the two palettes, the device record of the chosen mode and the
// scheme resolution. Pure on purpose (no react-native) so it runs in tests.
export const STORAGE_KEY = 'varanda-aparencia'
export const FILE_NAME = 'varanda-aparencia.json'

export const MODES = ['system', 'light', 'dark']
export const MODE_LABELS = Object.freeze({ system: 'Sistema', light: 'Claro', dark: 'Escuro' })

export const light = Object.freeze({
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
  // dim stays a dark scrim in both schemes: it is drawn behind white icons on
  // the sunset band (ProfileHeader, Diario).
  dim: 'rgba(31,42,36,0.35)',
  tabBar: 'rgba(251,248,243,1)',
  danger: '#a3201a',
  warn: '#8a5a00',
  placeholder: '#616c67',
  skeleton: 'rgba(31,42,36,0.08)',
  pillBg: '#1d6b4f',
  pillInk: '#ffffff',
  inputOff: '#efece5',
  toastBg: '#1f2a24',
  toastInk: '#ffffff',
  // The own chat bubble: a clear mint, so an own message reads at a glance.
  bubbleMine: '#d9efe2',
  shadow: 'rgba(31,42,36,0.28)'
})

export const dark = Object.freeze({
  bg: '#1c2622',
  card: '#24302b',
  ink: '#f4f0e6',
  soft: '#b7c4bb',
  line: 'rgba(244,240,230,0.14)',
  accent: '#5dcaa0',
  accentSoft: 'rgba(93,202,160,0.18)',
  accentInk: '#10241c',
  warm: '#3a3328',
  outline: 'rgba(244,240,230,0.30)',
  ring: 'rgba(244,240,230,0.12)',
  dim: 'rgba(16,22,19,0.55)',
  tabBar: 'rgba(28,38,34,1)',
  danger: '#ff8f87',
  warn: '#e7c36a',
  placeholder: '#9aaba2',
  skeleton: 'rgba(244,240,230,0.10)',
  pillBg: '#5dcaa0',
  pillInk: '#10241c',
  inputOff: '#17211d',
  toastBg: '#f4f0e6',
  toastInk: '#1c2622',
  bubbleMine: '#2c4a3d',
  shadow: 'rgba(0,0,0,0.45)'
})

export function paletteFor (scheme) {
  return scheme === 'dark' ? dark : light
}

function luminance (hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

export function contrastRatio (hexA, hexB) {
  const a = luminance(hexA)
  const b = luminance(hexB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const RECORD_KEYS = ['v', 'mode']

export function appearanceRecordOf (value) {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== RECORD_KEYS.length || !keys.every((key) => RECORD_KEYS.includes(key))) return null
    const { v, mode } = value
    if (v !== 1 || !MODES.includes(mode)) return null
    return { v: 1, mode }
  } catch {
    return null
  }
}

export function withMode (mode) {
  return { v: 1, mode }
}

export function resolveScheme ({ mode, system } = {}) {
  if (mode === 'dark') return 'dark'
  if (mode === 'system' && system === 'dark') return 'dark'
  return 'light'
}

export function statusBarStyle (scheme, { overBand = false } = {}) {
  return scheme === 'dark' || overBand ? 'light' : 'dark'
}
