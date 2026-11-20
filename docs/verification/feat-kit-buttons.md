# Alturas e rótulos de `Btn` e `Pill`

Os tamanhos mínimos são 44 pt no padrão, 56 pt no `Btn` grande e 36 pt nas versões compactas, cujo alvo de toque continua com pelo menos 44 pt. A pílula só com ícone tem diâmetro de 44 pt ou 36 pt na versão compacta. Os rótulos usam 16/600/24 no padrão e 14/600/20 no compacto, com 1 pt de folga de cada lado do texto.

As pílulas do topo das folhas (Limpar nos filtros da Feira, Voltar e Concluído no editor de música) param de crescer em `TEXT_CAP`, como as outras do topo: a 44 pt e com o texto do sistema bem grande, o rótulo passaria da fileira de 56 pt.

## Testes

- [x] `npm run lint` passou.
- [x] Os 37 arquivos de teste que a mudança alcança passaram, cada um com `node`: a11yCompose, anuncioView, attachPlan, backgroundTask, choiceControls, composerReplyTap, conversasList, dayClock, devices, embedFrame, feiraBrowse, feiraCompose, fieldGrow, followPill, group-flow, hapticsUse, hardening, kitAtoms, metroBlocked, muralGrid, muralScreen, musicPicker, pageChoice, perfMarks, perfScroll, pessoas, postLayout, pressMotion, profileActions, profilePolish, push-shell, replyBar, richTextView, sw, themeUsage, uiKit e visibleNow.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

- [ ] No Android e no simulador iOS, abrir Ajustes, entrar em **Passkeys e recuperação** e conferir a linha **Trocar passkey** a 320 pt de largura. O rótulo deve caber inteiro em uma linha dentro do contorno, com a escala de texto padrão. O ADB e o CoreSimulator ficaram indisponíveis no ambiente local.
- [ ] Na web, repetir a conferência a 320 px de largura, em zoom de 100%. O Chromium headless encerrou antes de renderizar.

Estimativa, sem tela renderizada: o botão **Trocar passkey** ocupa a largura toda, e dos 320 px sobram 253 px para o texto depois dos recuos da página, do contorno e do rótulo; "Trocar passkey" em negrito a 16 px deve ocupar perto de 118 px. Por isso o rótulo fica em 16 pt, com a conferência visual pendente.

- [ ] Em Seguindo, no cartão de quem você seguia antes, as pílulas **Agora não** e **Publicar selecionados** lado a lado a 320 e a 360 pt. A 16 pt elas somam perto de 318 pt (estimativa), e a fileira agora pode quebrar em duas linhas, alinhadas à direita, em vez de passar da borda.
- [ ] Na web larga (640 px ou mais), a pílula **Editar perfil** no canto do topo do Diário: com 44 pt ela pode entrar uns 4 pt na faixa do perfil.
