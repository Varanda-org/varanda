# Leitor de tela em Diário, Perfil e Seguindo (#155)

Branch `fix/a11y-diario-perfil`. Fecha parte da #155: o cabeçalho do perfil, o botão Seguindo e a fila de saída. O que exige leitor de tela num aparelho não foi conferido e segue aberto na issue.

## O que mudou

- `ui/ProfileHeader.js`: o nome e o @nome ficam num só `View` acessível com papel de título, então o leitor para uma vez e lê os dois. A bio fica fora, porque as menções nela são links.
- `ui/FollowPill.js`: com o membro já seguido, o rótulo era "deixar de seguir X", só a ação. Agora é "seguindo X, toque para deixar de seguir". Sem seguir, continua "seguir X".
- `screens/Diario.js`: na fila "Aguardando envio", Enviar, Tentar de novo e apagar ganham o item no rótulo ("a publicação escrita há 2 min"), porque com várias publicações na fila os botões eram idênticos.

## Como verificar

A partir da raiz:

- `node apps/app/test/a11yDiarioPerfil.test.js`
- `node apps/app/test/profileActions.test.js` (a asserção do rótulo "apagar" mudou)
- `npm test -w apps/app`
- `npm run lint`

Caminhada, a fazer com TalkBack (Android) e VoiceOver (iOS), e depois no navegador:

- [ ] Perfil de outra pessoa: o nome e o @nome são lidos num só foco, como título; a bio é lida a seguir.
- [ ] Seguir alguém: o botão passa a ser lido como "seguindo [nome], toque para deixar de seguir" e abre a confirmação.
- [ ] Diário com duas publicações na fila: cada "apagar" e cada "Enviar" diz de qual se trata.

## Fora desta mudança

- Teste com VoiceOver e TalkBack, e com fonte ampliada (critérios de aceite da #155).
- O passo do onboarding já anuncia "Passo N de M" no `Stepper`; não foi alterado. "Pular por enquanto" é um `Pill` de link e não foi medido contra o alvo de 44 pt.
- Reconferir o perfil depois da barra fixa (#335) e do Diário nos perfis (#306).
