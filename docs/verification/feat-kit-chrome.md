# Ícones de 24 pt na barra e ponto de 6 pt

Os ícones da barra de abas passam de 27 pt para 24 pt. A aba com novidade desenha o `Badge` compartilhado (`ui/Badge.js`), um ponto de 6 pt sem número, com a cor de destaque das cores da própria barra. Na web a barra usa o conjunto escuro, então o ponto mantém o contraste enquanto o tema está claro.

A altura da barra continua 49 pt, a forma continua encostada nas bordas, a pílula `accentSoft` continua 48 por 32 pt e a cor escura só da web não muda.

Os outros sete pontos passam de 8 pt para 6 pt, nas mesmas condições e nas mesmas âncoras, também pelo `Badge`: o sino (`BellButton`) e a ação de ícone (`IconAction`) na barra do topo, e a contagem numérica dessa ação continua com 18 pt; a linha de conversa (`ConversationRow`); ir para o fim (`JumpToEnd`); a faixa de Conversas; a linha de Comunidades; a linha de grupo na Comunidade; o botão Filtros da Feira.

Só números e medidas do kit de referência; nenhum arquivo, imagem ou ícone dele entrou no repositório. Os ícones continuam Feather, por `ui/Icon.js`.

## Testes

- [x] `npm run lint` passou.
- [x] Os 26 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles hapticsUse, tabBar, shellChrome, pwa, uiKit, chatGestures, conversas, postOverflow, conversasList, comunidadesRow, feiraScreen e groupScreen. O `kitAtoms` segue fixando o tamanho de 6 pt do `Badge`.
- [x] Sem `color={colors.accent}` no `Badge` da aba, o pin novo de `hapticsUse.test.js` falha (77 de 78 asserções), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] No build de debug do Android, o ponto de 6 pt visível em cada um dos oito lugares: a aba com novidade; a barra do topo (o sino e a ação de ícone; a contagem numérica continua com 18 pt); a linha de conversa; ir para o fim; a faixa de Conversas; a linha de Comunidades; a linha de grupo na Comunidade; o botão Filtros da Feira. Os ícones da barra medem 24 pt. A barra continua com 49 pt, encostada nas bordas, com a pílula de 48 por 32 pt.
- [ ] No simulador iOS, repetir o item acima.
- [ ] Na web, a 390 e a 1280 px, no claro e no escuro, repetir os oito lugares. No tema claro, o ponto da aba continua visível sobre a barra escura.
