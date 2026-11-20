# Controles da folha de Publicar

Publicação e Momento usam o controle segmentado em pílula (`SegmentedControl`). A opção "Publicar também na web" usa a marca de caixa compartilhada (`CheckboxMark`), e a linha anuncia o estado da caixa e fica desabilitada durante o envio. A miniatura da foto mostra a barra de progresso compartilhada (`ProgressBar`), de 4 pt, com trilha branca translúcida.

## Testes

- [x] `npm run lint` passou.
- [x] Os 18 arquivos de teste que a mudança alcança passaram, cada um com `node`, e também os 24 que leem `Publicar.js` como texto: postShareCompose, feiraCompose, shareShell, postShare, replyBar, videoCompose, pageChoice, legal, keyboardLift, fieldGrow, sharedIntent, hardening, muralScreen, composePolish, a11yCompose, conversaScreen, uiKit, momentosScreen, musicDraft, pollDraftGuard, pageMoment, replySend, wordCheck e linkCardBuild.
- [x] Com o `Publicar.js` anterior, o pin novo de `momentosScreen.test.js` (caixa e barra de progresso compartilhadas) e o pin do seletor falham, como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.
- [ ] A conferência renderizada na web não foi feita neste PR (economia de créditos); fica para os itens de conferência visual abaixo.

## Conferência visual

Em cada plataforma, conferir no tema claro e no escuro, inclusive com texto grande. Alternar entre Publicação e Momento e conferir a opção selecionada. Marcar e desmarcar "Publicar também na web" e conferir que a caixa fica desabilitada durante o envio. Conferir na miniatura a barra enquanto a foto é enviada e a mensagem "falhou · tentar de novo" se o envio falhar. Com o leitor de tela, conferir o nome e o estado da caixa e a opção selecionada no controle segmentado.

- [ ] No build de debug do Android, conferir com TalkBack.
- [ ] No simulador iOS, repetir com VoiceOver.
- [ ] Na web, repetir a 390 e a 1280 px, com leitor de tela.
