// First-run step machine. Pure: the screen passes what it knows and gets the
// step to show. A failed profile lookup is NOT evidence that the profile is
// absent: `profileKnown` is true only when the cache answered (profile or
// null) or the node is known not to support `profile.read`. Skipping the name
// ('Continuar mesmo assim', 'Pular por enquanto') bypasses both the loading and
// the name steps, so the user can always reach the tabs.
const TOTAL = 3

export const STEP_TITLES = {
  entrar: 'Bem-vindo à Varanda',
  recuperando: 'Buscando sua conta…',
  vinculo: 'Escolha seu @nome',
  identidade: 'Sua identidade',
  // Native and manual setups only.
  certificado: 'Certificado de membro',
  carregando: 'Um instante',
  perfil: 'Como você quer aparecer',
  pronto: 'Tudo pronto'
}

export const STEP_HINTS = {
  entrar: 'Entre com a passkey do seu aparelho: sem senha, sem e-mail.',
  recuperando: 'Estamos trazendo de volta o que já é seu.',
  vinculo: 'Seu @nome é como as pessoas encontram você. Vamos confirmar sua conta Google uma única vez.',
  identidade: 'Sua identidade é criada neste aparelho.',
  certificado: 'Cole o certificado emitido pela associação para publicar e sincronizar.',
  carregando: 'Só um instante.',
  perfil: 'Seu nome aparece em cada publicação; a bio é opcional.',
  pronto: 'Tudo certo para começar.'
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
