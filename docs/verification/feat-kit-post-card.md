# Publicação como cartão

A linha de publicação (`PostRow`) deixa a coluna do avatar e vira um cartão de borda a borda. As medidas estão em `apps/site/artwork/app-design.md`.

- Cabeçalho: avatar de 40 pt a 24 pt da borda, 12 pt até o nome e `@nome · tempo` na mesma linha. As ações ficam à direita, a 24 pt da borda. O "seguir" passa a ser a pílula verde suave pequena do `Pill`: face de 36 pt, alvo de 44 pt.
- Quando a data não cabe ao lado das ações, o cabeçalho empilha como no texto grande: o nome fica na primeira linha e o `@nome` e a data descem. Acontece, por exemplo, numa tela de 320 pt com "· 31 dez 2025", "seguir" e o botão de mais; sem isso, com o recuo de 24 pt, a data passava por baixo de "seguir" e um toque nela seguia o perfil. A primeira renderização decide pela largura da janela, e a largura medida do cabeçalho só renderiza a linha de novo quando decide outra coisa.
- Legenda, citação, prévias de respostas e barra de ações têm recuo de 24 pt dos dois lados e 12 pt entre os blocos. Os ícones da barra passam de 20 para 22 pt.
- Fotos e vídeos vão de borda a borda: o `MediaGrid` ganhou `bleed`, que tira os cantos arredondados. Fora da publicação, ele continua com cantos.
- Sem divisória entre publicações: 16 pt em cima e embaixo de cada uma.
- O corte da legenda em linhas mede só a largura do texto: o `ClampText` estima a coluna menos 24 pt de cada lado, sem o avatar.
- Prévia de link na linha (`PostLinkPreviewRow`): o texto começa a 24 pt da borda, abaixo do cabeçalho, e não mais a 68 pt, atrás da coluna do avatar. O cabeçalho e o texto formam um só alvo para o leitor de tela, então a exploração por toque encontra a publicação nos dois.
- Momentos: a fileira de rodinhas tem 24 pt nas laterais.
- Conversa: "ver mais respostas" começa a 24 pt, alinhado à legenda.

Onde entra: em toda tela que usa a linha de publicação, como A Rua, os perfis, a Espiadinha e Conversa.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 35 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles postRowLayout, postLayout, postOverflow, postClamp, feedRender, postLinkOpen, conversaScreen, hit e themeUsage.
- [x] Regressões: sem o empilhamento do cabeçalho, postRowLayout falha (45 de 47 asserções); com o texto da prévia de link fora do alvo do leitor de tela, postLinkOpen falha (117 de 118).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador.

- [ ] No claro e no escuro, com texto padrão e grande: uma publicação só com texto, uma com foto, uma com carrossel e uma com vídeo, com a mídia de borda a borda e sem cantos.
- [ ] A 320 pt, na Espiadinha ou na Busca: um perfil não seguido com nome e `@nome` longos e uma data com ano. O cabeçalho empilha, "seguir" e o botão de mais ficam separados do nome e da data, e o leitor de tela anuncia "seguir" com o nome. Tocar na pílula a deixa desabilitada durante o pedido.
- [ ] A 320 pt, uma republicação de um perfil não seguido: a linha "Nome republicou" e o "seguir" dela ficam acima da publicação, sem sobreposição.
- [ ] Em Conversa: o fio liga os avatares, o recuo das respostas aparece, e a legenda e a barra de ações cabem na largura.
- [ ] Prévia de link: o texto abaixo do cabeçalho, e o leitor de tela encontra a publicação tocando no cabeçalho e no texto.
- [ ] Momentos: a fileira de rodinhas alinhada aos 24 pt.
- [ ] Android (build de debug), simulador iOS, web e PWA, a 320 pt, 390 pt e 1280 px.
