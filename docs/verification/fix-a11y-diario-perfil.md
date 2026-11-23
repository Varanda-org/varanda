# Leitor de tela em Diário, Perfil e Seguindo (#155)

Branch `fix/a11y-diario-perfil`. Fecha parte da #155: o botão Seguindo e a fila de saída. O que exige leitor de tela num aparelho não foi conferido e segue aberto na issue.

## O que mudou

- `ui/FollowPill.js`: com o membro já seguido, o rótulo era "deixar de seguir X", só a ação. Agora é "seguindo X, toque para deixar de seguir". Sem seguir, continua "seguir X".
- `screens/Diario.js`: na fila "Aguardando envio", Enviar, Tentar de novo e apagar ganham o item no rótulo ("a publicação escrita 2 min", o tempo vem de `relativeTime`: "agora", "2 min", "3 h", "ontem" ou "5 nov"), porque com várias publicações na fila os botões eram idênticos.

## Como verificar

A partir da raiz:

- `node apps/app/test/a11yDiarioPerfil.test.js`
- `node apps/app/test/profileActions.test.js` (a asserção do rótulo "apagar" mudou)
- `npm test -w apps/app`
- `npm run lint`

Caminhada, a fazer com TalkBack (Android) e VoiceOver (iOS), e depois no navegador:

- [ ] Seguir alguém: o botão passa a ser lido como "seguindo [nome], toque para deixar de seguir" e abre a confirmação.
- [ ] Diário com duas publicações na fila: cada "apagar" e cada "Enviar" diz de qual se trata.

## Fora desta mudança

- Teste com VoiceOver e TalkBack, e com fonte ampliada (critérios de aceite da #155).
- Cabeçalho do perfil: fica como na `main`, com o nome como título (`accessibilityRole='header'`) e o @nome num `Text` à parte lido logo depois. O nome livre e o @nome verificado não se misturam (`who.js`), então não são juntados num só elemento.
- O passo do onboarding já anuncia "Passo N de M" no `Stepper`; não foi alterado. "Pular por enquanto" é um `Pill` de link e não foi medido contra o alvo de 44 pt.
- Reconferir o perfil depois da barra fixa (#335) e do Diário nos perfis (#306).
