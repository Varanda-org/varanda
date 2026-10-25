// First-run step machine. Pure: the screen passes what it knows and gets the
// step to show. A failed profile lookup is NOT evidence that the profile is
// absent: `profileKnown` is true only when the cache answered (profile or
// null) or the node is known not to support `profile.read`. Skipping the name
// ('Continuar mesmo assim', 'Pular por enquanto') bypasses both the loading and
// the name steps, so the user can always reach the tabs.
const TOTAL = 3

export const STEP_TITLES = {
  entrar: 'Bem-vindo à Varanda',
  recuperando: 'Recuperando seu diário',
  vinculo: 'Sua conta e seu @nome',
  identidade: 'Sua identidade',
  certificado: 'Certificado de membro',
  carregando: 'Um instante',
  perfil: 'Como você quer aparecer',
  pronto: 'Tudo pronto'
}

export const STEP_HINTS = {
  entrar: 'Sua identidade vem da passkey: sem senha, sem e-mail.',
  recuperando: 'Buscando no semeador o que já existe desta identidade.',
  vinculo: 'A associação liga sua chave a uma conta Google e emite seu certificado de membro.',
  identidade: 'A identidade é a chave do seu diário, criada neste aparelho.',
  certificado: 'Cole o certificado emitido pela associação para publicar e sincronizar.',
  carregando: 'Lendo seu diário.',
  perfil: 'Seu nome aparece em cada publicação; a bio é opcional.',
  pronto: 'Seu diário está pronto.'
}

const at = (step, index) => ({ step, index, total: TOTAL })

export function onboardingStep ({ mode, locked, recovering, hasIdentity, memberCert, profileKnown, hasName, skippedName }) {
  if (mode === 'hosted') {
    if (locked) return at('entrar', 0)
    if (recovering) return at('recuperando', 1)
    if (!memberCert) return at('vinculo', 1)
  } else {
    if (!hasIdentity) return at('identidade', 0)
    if (!memberCert) return at('certificado', 1)
  }
  if (skippedName) return at('pronto', 3)
  if (!profileKnown) return at('carregando', 2)
  if (!hasName) return at('perfil', 2)
  return at('pronto', 3)
}
