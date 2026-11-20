# Abas de 48 pt e controle segmentado em pílula

As abas de largura total (`Segmented`) passam a ter no mínimo 48 pt de altura e rótulo de 16 pt, peso 600 e entrelinha de 24 pt (`type.rowName`). Solta, a aba mostra o rótulo em texto suave; escolhida, o rótulo fica em verde (`accent`), com o fio verde de 2 pt embaixo, sobre o fio de 1 pt da fileira. Isso vale em todas as telas com `Segmented`: Diário e Membro (Publicações e Mural, e Depoimentos no nó hospedado), Seguindo, Feira, Publicar, Busca, Grupo e Curtidas e republicações.

Curtidas e republicações trocou as abas próprias pelo `Segmented`. O rótulo desenhado continua com a contagem curta ("Republicações · 12") e o leitor de tela continua com a contagem inteira. As abas ganham `aria-selected` na web e o toque de seleção ao trocar de aba.

Na web, onde o texto não encolhe sozinho, uma aba mais estreita que o rótulo perde o recuo lateral (fica com 2 pt) e o rótulo cai para 13 pt, igual em todas as abas. O piso passa de 112 para 124 pt por aba, por causa de "Depoimentos" em 16 pt. Um rótulo mais longo, como o de Curtidas com a contagem, é estimado em 9 pt por caractere mais 16 de recuo: a 320 px, "Republicações · 12" já usa o modo apertado, e a 390 px só um total como "1,2 mil" o usa. No app nativo, com três abas ou mais, o limite do texto grande do sistema cai de 1,2 para 1,1: o maior rótulo fica perto dos 18 pt de antes, e as três abas do perfil cabem com um só tamanho num celular de 390 pt.

O controle segmentado em pílula (`SegmentedControl`) substitui as abas sublinhadas na folha Música: na busca, quando há playlists, "Faixas | Playlists"; no editor de uma faixa, "15 s | Faixa inteira". A trilha tem no mínimo 48 pt, cantos de pílula e fundo de campo desligado (`inputOff`). A opção escolhida é uma pílula de cartão liso, sem sombra, a 4 pt da borda da trilha, com rótulo em tinta; a solta fica sem fundo, com rótulo em texto suave. O rótulo tem 14 pt, peso 600 e entrelinha de 20 pt (`type.more`), numa linha, e o texto grande para em 1,5. Cada opção ocupa a altura inteira da trilha, então o toque vale nos 48 pt, também na web. Pressionado, opacidade de 0,6. Os papéis `tablist` e `tab` e o estado escolhido seguem como no `Segmented`.

Só números e medidas do kit de referência; nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 9 arquivos de teste que a mudança alcança passaram, cada um com `node`: buscaGlobal, engagers, hapticsUse, muralGrid, muralScreen, musicPicker, segmentedControl, segmentedFit e uiKit.
- [x] Sem a estimativa pelo rótulo mais longo em `segmentedFit.js`, o teste novo de `segmentedFit.test.js` falha (17 de 19 asserções), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] No build de debug do Android, Diário e Membro: abas de 48 pt, o rótulo da escolhida em verde com o fio verde de 2 pt, as outras em texto suave. No nó hospedado, com Depoimentos e o texto do sistema no máximo, as três abas com um só tamanho de letra num celular de 390 pt.
- [ ] No Android, Curtidas e republicações: as duas abas com a contagem curta, o leitor de tela dizendo a contagem inteira, e a vibração curta só ao trocar de aba.
- [ ] No Android, as abas de Seguindo, Feira, Publicar, Busca e Grupo com 48 pt e nenhum rótulo cortado.
- [ ] No Android, folha Música: "Faixas | Playlists" na busca com playlists e "15 s | Faixa inteira" no editor; a escolhida em cartão liso com rótulo em tinta; um toque perto da borda de cima ou de baixo da trilha também escolhe.
- [ ] No simulador iOS, repetir os itens acima.
- [ ] Na web, a 320, 390 e 1280 px: Curtidas e republicações com "Republicações · 12" sem corte a 320 px; o perfil com três abas a 360 px no modo apertado, sem corte; a Feira com quatro abas a 320 px; a folha Música com o toque na altura inteira da trilha.
