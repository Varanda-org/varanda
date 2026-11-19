# Campo de texto em linha (`Field`) e recuo do campo de busca

O `Field` deixa de ser uma caixa com contorno: fica só uma linha de 1 pt embaixo do texto, na cor de controle desligado (`controlOff`), que vira 2 pt em verde (`accent`) com o campo em foco. O preenchimento de baixo perde 1 pt no foco, então o texto não se move. Desligado, a linha fica na cor do fio (`line`) e o texto em texto suave. O campo de uma linha tem altura mínima de 56 pt, e o rótulo é 14/20, peso normal, em texto suave. Na web, o contorno de foco do navegador some só enquanto a linha verde aparece, como no campo de busca; um campo desligado, que ainda recebe o foco do teclado, ou um campo religado ainda em foco continua com o contorno do navegador. Ao desligar um campo, o `Field` esquece o foco, porque o Android não avisa a perda de foco nesse caso, e a linha verde não volta sozinha quando o campo é religado.

O `Field` ganha `inputProps`, espalhado por último no `TextInput`, depois dos padrões do campo. Telefone e "Excluir conta sem a passkey" passam a usar o `Field` com `inputProps={NO_AUTOFILL}`, então todas as chaves que desligam o preenchimento automático (`autoComplete`, `autoCorrect`, `autoCapitalize`, `spellCheck`, `importantForAutofill`, `textContentType`) continuam chegando ao `TextInput`. As seis casas de 52 pt do código no passo Telefone continuam como antes. O campo de busca (`SearchField`) passa de 12 para 16 pt de recuo nas laterais.

## Testes

- [x] `npm run lint` passou.
- [x] Os 36 arquivos de teste que a mudança alcança passaram, cada um com `node`: attachPlan, backgroundTask, buscaGlobal, choiceControls, composerReplyTap, conversas, conversasList, dayClock, devices, embedFrame, feiraCompose, fieldGrow, followPill, group-flow, hapticsUse, hardening, kitAtoms, metroBlocked, muralGrid, pageChoice, perfMarks, perfScroll, phone, phoneEntry, phoneExplainer, postLayout, pressMotion, push-shell, replyBar, richTextView, screensPolish, searchField, sw, themeUsage, uiKit e visibleNow.
- [x] Sem o `inputProps={NO_AUTOFILL}` em "Excluir conta sem a passkey", o teste novo de `phoneEntry.test.js` falha (170 de 171 asserções), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] No build de debug do Android, abrir um formulário com `Field` (Editar perfil, por exemplo): sem foco, só a linha fina cinza embaixo do texto, sem fundo nem contorno; ao tocar, a linha vira verde e mais grossa, e o texto e o rótulo não se movem; um campo desligado mostra a linha na cor do fio e o texto suave.
- [ ] No Android, o passo Telefone: o campo "Seu celular com DDD" na linha nova, sem sugestão de preenchimento automático nem de correção do teclado; depois de enviar, o campo desligado e as seis casas do código com 52 pt, a casa ativa em verde só com o foco.
- [ ] No Android, "Excluir conta sem a passkey": os campos "Seu @nome", "Celular confirmado" e "Código do SMS" na linha nova, sem preenchimento automático nem sugestões, e desligados enquanto um pedido está em andamento.
- [ ] No Android, o campo de busca da aba Busca e o de Seguindo: 16 pt entre a borda e a lupa e entre o texto e a borda direita.
- [ ] No Android, no passo Telefone, tocar "Enviar código" com o campo do celular em foco e depois "Trocar número": a linha do campo volta fina e cinza, sem ficar verde sem foco.
- [ ] No simulador iOS, repetir os cinco itens acima. No passo Telefone e em "Excluir conta sem a passkey", a barra acima do teclado não deve sugerir números nem códigos salvos.
- [ ] Na web, a 320 e a 390 px de largura, repetir os cinco itens: a linha de foco sem o contorno do navegador num campo ligado, o navegador sem oferecer preenchimento automático nos campos de Telefone e de "Excluir conta sem a passkey", e o campo de busca sem passar da borda.

## Conferido na web, com a vitrine

Expo web com `EXPO_PUBLIC_VARANDA_VITRINE=1`, no tema claro e no escuro, a 390, 320 e 195 px de largura (195 px faz as vezes do zoom de 200%, o texto grande da web). Este PR já inclui o de botões e pílulas (`feat/kit-buttons`), então a conferência cobre os dois.

- [x] `Field` em Editar perfil e no campo "Cidade" da Feira: sem caixa, sem fundo e sem recuo nas laterais. A linha sem foco tem 1 px, `rgb(127,136,130)` no claro e `rgb(117,117,117)` no escuro; com o foco, 2 px, `rgb(29,107,79)` no claro e `rgb(93,202,160)` no escuro, sem o contorno do navegador. O texto não se move: o preenchimento de baixo passa de 10 para 9, e a posição e a altura do campo ficam iguais, no campo de uma linha e no de várias. O rótulo tem 14/20, peso normal.
- [x] Campo de busca da aba Busca: 16 px de recuo mais o contorno de 1,5 px; o texto não é cortado a 390 nem a 320 px.
- [x] "Trocar passkey" cabe em uma linha dentro do contorno de 44 px a 390, 320 e 195 px, no claro e no escuro.
- [x] Nenhum rótulo de botão ou pílula quebra ou é cortado a 390 e a 320 px em Diário, A Rua, Seguindo, Busca, Feira e Ajustes. A 195 px vários quebram em duas ou três linhas e o botão cresce, sem corte.
- [x] Filtros da Feira: "Limpar" tem 88 x 44 px e fica dentro da margem de 16 px a 390 e a 320 px.
- Limites medidos, sem correção neste PR:
  - "Editar perfil" no Diário entra 4 px na faixa do perfil a 1280 px. A 390 e a 320 px não entra. A 195 px o rótulo quebra em duas linhas, a pílula fica com 67 px e entra 19 px.
  - A 195 px, o título "Filtros da Feira" some: "Cancelar" e "Limpar" ocupam a fileira toda. A 390 e a 320 px o topo está certo.
  - A 195 px, o campo de busca da aba Busca tem 100 px, e o texto de exemplo "nome, @nome ou código" (175 px) é cortado.
- Não alcançados com a vitrine:
  - o cartão de Seguindo com "Agora não" e "Publicar selecionados";
  - um `Field` desligado (o "Cidade" da vitrine está sempre ligado);
  - o passo Telefone e "Excluir conta sem a passkey", que pedem uma conta.
