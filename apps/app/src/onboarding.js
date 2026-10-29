// First-run step machine. Pure: the screen passes what it knows and gets the
// step to show. A failed profile lookup is NOT evidence that the profile is
// absent: `profileKnown` is true only when the cache answered (profile or
// null) or the node is known not to support `profile.read`. Skipping the name
// ('Continuar mesmo assim', 'Pular por enquanto') bypasses both the loading and
// the name steps, so the user can always reach the tabs. Hosted members must
// confirm their age (`ageVerified === false` shows 'idade'), linked or not;
// the step comes after 'recuperando' so the screen stays mounted while the
// post-unlock recovery runs, and skipping the name never skips it. An absent
// `ageVerified` counts as verified, for callers that do not gate on age.
const TOTAL = 3

export const STEP_TITLES = {
  entrar: 'Bem-vindo à Varanda',
  recuperando: 'Buscando sua conta…',
  idade: 'Confirme sua idade',
  vinculo: 'Escolha seu @nome',
  identidade: 'Criar sua conta',
  // Native and manual setups only.
  certificado: 'Liberar sua conta',
  carregando: 'Um instante',
  perfil: 'Como você quer aparecer',
  pronto: 'Tudo pronto'
}

export const STEP_HINTS = {
  entrar: 'Entre com a passkey deste aparelho.',
  recuperando: 'Estamos trazendo de volta o que já é seu.',
  idade: 'A Varanda é para quem tem 16 anos ou mais. Só a sua faixa de idade fica guardada.',
  vinculo: 'Seu @nome é como as pessoas encontram você.',
  identidade: 'Sua conta é criada neste aparelho.',
  certificado: 'Envie o código à associação e cole o que ela devolver.',
  carregando: 'Só um instante.',
  perfil: 'Seu nome aparece em cada publicação. A bio é opcional.',
  pronto: 'Tudo certo para começar.'
}

const at = (step, index) => ({ step, index, total: TOTAL })

export function onboardingStep ({ mode, locked, recovering, hasIdentity, memberCert, profileKnown, hasName, skippedName, ageVerified = true }) {
  if (mode === 'hosted') {
    if (locked) return at('entrar', 0)
    if (recovering) return at('recuperando', 1)
    if (ageVerified === false) return at('idade', 1)
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
