// The bottom tabs: four in every mode, five when the node is hosted. The fifth
// is Conversas, but its id stays 'comunidades' because callers compare that id.
// Avisos opens from the bell in the top bar, and Seguindo from the 'N seguindo'
// count on the Diário.
export const TABS = [
  { id: 'rua', label: 'A Rua', icon: 'rua' },
  { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
  { id: 'busca', label: 'Busca', icon: 'lupa' },
  { id: 'diario', label: 'Diário', icon: 'pessoa' }
]

const HOSTED_TABS = [
  ...TABS.slice(0, 2),
  { id: 'comunidades', label: 'Conversas', icon: 'conversas' },
  ...TABS.slice(2)
]

export function tabsFor (mode) {
  return mode === 'hosted' ? HOSTED_TABS : TABS
}

// Screens that belong to Conversas: a private conversation, a group, a
// community, the communities list and the request folder open on top of that tab. The publish
// button is for posts, so it stays hidden on all of them.
const CONVERSAS_SCREENS = new Set(['mensagem', 'grupo', 'comunidade', 'comunidade-info', 'comunidades', 'pedidos'])

// Screens with nothing to publish on: the Depoimentos management screen.
const NO_POST_SCREENS = new Set(['depoimentos'])

// The floating "publicar" button belongs to posts: it is hidden on the
// Conversas tab, on its screens and on NO_POST_SCREENS. `screen` is the top
// of the stack, or null when no screen is open above the tabs.
export function showPostButton ({ tab, screen }) {
  if (typeof screen === 'string') return !CONVERSAS_SCREENS.has(screen) && !NO_POST_SCREENS.has(screen)
  return tab !== 'comunidades'
}
