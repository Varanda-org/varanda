# Aviso rápido compartilhado

Peça nova em `apps/app/src/ui/Toast.js`: só a face do aviso, sem posição. As medidas estão em `apps/site/artwork/app-design.md`.

O aviso é uma pílula com cantos de 24 pt, no mínimo 36 pt de altura, 8 pt em cima e embaixo, 16 pt à esquerda e 12 pt à direita, no fundo `toastBg` com um fio de 1 pt na cor do fio. O texto é alerta para o leitor de tela e não recebe toque. Com ação, ela é um botão de pelo menos 44 × 44 pt, sem área extra de toque.

Onde entra:

- Estrutura do app: o aviso acima do botão de publicar usa `Toast`. A posição, os 92% de largura máxima e a ocultação no visualizador continuam no `App.js`. Muda o fio de 1 pt, que não existia.
- A Rua e Diário: o `SocialToast` usa `Toast`. Os cantos passam de 18 pt para 24 pt, as laterais de 14 pt para 16 pt e 12 pt, e a ação ganha os 44 × 44 pt no lugar da área extra de 8 pt, então um aviso com ação fica mais alto.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 105 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles toast (três testes: a face sem ação, a ação de 44 pt sem área extra, e a ação só aparece com o rótulo e a função juntos), depoimentos, screensPolish, ruaChrome, diarioSnapshot e themeUsage.
- [x] Regressões: antes da troca, depoimentos falha (289 de 290 asserções) e screensPolish falha (264 de 265); sem os 8 pt em cima e embaixo, toast falha (2 de 3).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador.

- [ ] No claro e no escuro, com texto grande: um aviso curto, um longo que quebra em duas ou três linhas sem encostar na borda, e um com ação.
- [ ] Estrutura do app: o aviso acima do botão de publicar, junto à borda quando as barras somem, e escondido ao abrir o visualizador.
- [ ] A Rua e Diário: o aviso no topo, e "Desfazer" depois de republicar.
- [ ] Tocar na ação e no texto: só a ação recebe o toque, e o toque no texto passa para o que está embaixo.
- [ ] Android (build de debug), simulador iOS, web e PWA.
- [ ] Larguras de 320 px e 1280 px.
