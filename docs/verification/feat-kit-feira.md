# Cartão de anúncio da Feira

O tile de anúncio (`ListingTile`) vira um cartão com as medidas do kit, a grade da Feira ganha vão entre os cartões e o botão Anunciar troca o "+" de texto pelo ícone de mais. As medidas estão em `apps/site/artwork/app-design.md`.

- O tile passa a cartão: fundo `card`, cantos de 24 pt, fio de 1 pt, 8 pt de recuo interno e sombra leve. Antes, não tinha cantos nem fio.
- A foto continua em 4:5, agora com cantos de 16 pt.
- O preço e o título saem da faixa escura sobre a foto e vão para baixo dela, num bloco com 12 pt de recuo e 4 pt entre as linhas, na cor do texto (`ink`). O título continua numa linha. A faixa escura e o chip escuro do preço saem.
- O selo continua no canto superior esquerdo da foto. A estrela de Salvar continua num disco escuro, com alvo de 44 pt, agora alinhada ao canto da foto, e usa `onMedia`.
- A grade tem 8 pt de vão entre os cartões e entre as linhas (eram 2 pt). As colunas continuam as mesmas.
- O esqueleto de carga da grade tem o mesmo cartão, a foto em 4:5 e a altura do bloco de texto, para a grade não pular quando os anúncios chegam.
- O botão redondo Anunciar mostra o ícone `plus` do Feather, de 26 pt, na cor `accentInk`. Tamanho, lugar, sombra e rótulo não mudam.

Onde entra: na grade da Feira, nos anúncios de uma pessoa, em Salvos e na prévia do passo Revisão de Anunciar.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 10 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles feiraBrowse, feiraSaved, feiraScreen, feiraCompose e uiKit.
- [x] Regressão: com o esqueleto ainda quadrado e sem o bloco de texto, uiKit falha (285 de 287 asserções).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador. Conferir primeiro no Android (build de debug) e no simulador iOS, depois na web e no PWA, no claro e no escuro.

- [ ] A 320 pt, a Feira com anúncios em uma coluna; a 390 pt, em duas; a 1280 px, em três. Os cartões não se tocam, e o preço e o título ficam abaixo da foto.
- [ ] Com texto grande a 390 pt: uma coluna, preço inteiro e título cortado em "…" numa linha.
- [ ] Abrir a Feira com rede lenta: o esqueleto tem o mesmo tamanho do cartão carregado, sem salto na troca.
- [ ] Num anúncio com selo e estrela: os dois ficam sobre a foto, sem se encostar, e tocar na estrela salva sem abrir o anúncio.
- [ ] O botão Anunciar mostra o "+" centrado no círculo de 56 pt, e o leitor de tela lê "Anunciar". No passo Revisão, a prévia mostra o cartão novo.
