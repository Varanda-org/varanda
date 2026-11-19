# Visualizador de Momentos

O visualizador de Momentos (`Momentos.js`) passa às cores de mídia do tema e às medidas do kit para a barra de progresso e a sobreposição do topo. As medidas estão em `apps/site/artwork/app-design.md`.

- O fundo da tela e do palco usa `mediaBg`, e não mais `#000000` escrito à mão. Continua preto nos dois temas.
- O nome, a legenda, as reações, o texto de foto indisponível e os ícones de fechar, de som e de mais usam `onMedia`, e não mais `#ffffff`. Continuam brancos nos dois temas.
- Os segmentos de progresso passam de 3 pt para 2 pt de altura, com cantos de pílula, 4 pt entre eles, trilha branca a 40% (era 35%) e preenchimento em `onMedia`.
- A sobreposição do topo tem 24 pt nas laterais (eram 8 pt, e os segmentos tinham mais 8 pt), 12 pt acima, somados à área segura (eram 8 pt), 12 pt abaixo e 12 pt entre a barra e a linha de controles (eram 4 pt).
- O avatar de 32 pt, os véus do topo e de baixo e a sombra do texto não mudam.

Onde entra: ao abrir um momento pela faixa de A Rua, pelo Diário ou por uma Página.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 4 arquivos de teste que a mudança alcança passaram, cada um com `node`: momentosScreen, composePolish, mediaKeptLoad e pageMoment. themeUsage também passou.
- [x] Regressão: com os segmentos ainda de 3 pt e a trilha a 35%, momentosScreen falha (1439 de 1440 asserções).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador. Conferir primeiro no Android (build de debug) e no simulador iOS, depois na web e no PWA, no claro e no escuro.

- [ ] Abrir um momento com legenda sobre uma foto branca que cubra o topo e o pé da tela: o nome, a hora, a legenda e os ícones continuam legíveis com os véus e a sombra.
- [ ] Abrir uma pessoa com três momentos: o segmento já visto, o atual em progresso e a trilha do próximo se distinguem, e os 2 pt aparecem inteiros, sem sumir numa tela de densidade baixa.
- [ ] Num aparelho com entalhe ou ilha: a barra de progresso fica abaixo da área segura, e o botão de fechar responde ao toque.
