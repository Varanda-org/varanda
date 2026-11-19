# Barra de abas flutuante

A barra de abas (`TabBar`) deixa de ser uma faixa encostada nas bordas e vira uma pílula flutuante e escura. As medidas estão em `apps/site/artwork/app-design.md`.

- Pílula de 62 pt de altura, com 2 pt de respiro e borda de 1 pt, a 24 pt das laterais e 16 pt acima da área segura, até 640 pt de largura. Cantos de pílula e a sombra `elevation.lg`.
- Escura e opaca (`#101010`) no claro e no escuro, na web e no app nativo. Antes, só a web era sempre escura: o app nativo seguia o modo. O componente não decide mais nada por `Platform.OS`.
- O invólucro em volta da pílula não tem fundo nem borda e deixa os toques passarem (`pointerEvents='box-none'`): a faixa ao lado e abaixo da pílula mostra a tela e responde a ela.
- Cada aba tem 58 pt de altura. Com as seis abas do nó hospedado numa tela de 320 pt, cada uma tem 44 pt de largura, o mínimo de toque.
- A aba ativa ganha o fundo suave `accentSoft`, que agora ocupa a aba inteira, e não mais um retângulo de 48 por 32 pt atrás do ícone. O Diário com a foto ou as iniciais da pessoa continua sem esse fundo: o anel verde marca a seleção.
- Só ícones de 24 pt, sem rótulo visível. O leitor de tela continua lendo o nome de cada aba e "novidades" quando há o ponto.
- `layout.tabBar` passa de 49 para 78 pt (62 da pílula mais 16 de folga). O botão de publicar, o `+` da Feira, os cartões de música e o visualizador de fotos já somam esse valor, então sobem junto.
- No app web instalado, o `theme_color` do manifesto continua `#101010`, o mesmo tom da pílula.

Onde entra: em todas as telas com abas, na web, no PWA e no app nativo.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 35 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles tabBar, shellChrome, themeUsage, pwa, hapticsUse e musicPlayerCard.
- [x] Regressões: com os testes novos e o código antigo, shellChrome falha (57 de 59 asserções), themeUsage falha (1563 de 1564) e pwa falha (122 de 123).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador. Conferir primeiro no Android (build de debug) e no simulador iOS, depois na web e no PWA, nos temas claro e escuro.

- [ ] A 320 pt, no nó hospedado: as seis abas cabem na pílula, com os ícones inteiros e tocáveis e sem rótulo visível. Tocar nas abas mostra o fundo suave da aba ativa e, no Diário, o anel do avatar.
- [ ] Em A Rua, o botão de publicar fica acima da pílula, com espaço entre os dois. Na Feira, o mesmo com o `+` (Anunciar).
- [ ] Um cartão de música perto do fim da lista fica todo visível acima da pílula, com os controles usáveis. Um aviso rápido (`Toast`) também aparece acima dela.
- [ ] Tocar na faixa ao lado da pílula, ou logo abaixo dela, chega ao conteúdo da tela.
- [ ] Em A Rua, rolar para baixo esconde a barra e rolar para cima a traz de volta. Com Reduzir movimento, o fundo da aba ativa aparece de uma vez.
- [ ] No app web instalado no Android, no tema claro: a faixa entre a pílula e a barra de navegação do sistema mostra o fundo claro da tela, e a barra do sistema continua escura, no tom `#101010` da pílula.
- [ ] No app nativo, no tema claro: a pílula escura sobre o creme, com a sombra visível e sem faixa escura embaixo dela.
