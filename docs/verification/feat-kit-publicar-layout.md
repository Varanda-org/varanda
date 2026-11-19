# Layout interno da folha de Publicar

A folha de Publicar (`Publicar.js`) passa às medidas do kit por dentro: um só recuo lateral de 24 pt, ícones de 24 pt na barra de ferramentas e cantos de 24 pt na foto escolhida. As medidas estão em `apps/site/artwork/app-design.md`.

- O recuo lateral passa de 16 pt para 24 pt em toda a folha: o corpo (avatar e texto), a linha "respondendo a" ou "citando", o texto respondido, o cartão de citação, a linha "Publicar como", os avisos e erros, o corpo de Momento e a linha das ferramentas e do contador.
- As miniaturas de foto continuam a começar na coluna do texto (24 + 40 + 12 pt) e continuam com 80 pt e cantos de 12 pt. O vão entre elas passa de 10 pt para 8 pt.
- Uma foto sozinha em Publicação e a prévia de Momento (160 x 200 pt) têm cantos de 24 pt (eram 12 pt).
- Os ícones da barra (vídeo, emoji, foto, enquete, evento e música) passam de 21 pt para 24 pt. Continuam três `PressScale` e o alvo de 44 pt.
- Com as seis ferramentas e o contador à mostra, a linha não cabe num celular: as últimas ferramentas descem para uma segunda linha, em vez de passar por baixo do anel do contador.
- O botão de remover foto mantém o alvo de 44 pt e o círculo de 24 pt, agora com o fundo `mediaScrim` e o X em `onMedia`.
- "cancelar resposta", "cancelar citação" e "Mostrar prévia do link" viram pílulas de link pequenas (`Pill` com `link` e `small`), com os mesmos rótulos e as mesmas ações. Os dois "cancelar" passam do cinza para o verde de link.

Onde entra: ao publicar, responder, citar e publicar um Momento, no app e na web.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 19 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles composePolish, musicDraft, shareShell, replyBar, pageMoment e a11yCompose.
- [x] Regressão: com a linha "respondendo a" e os avisos ainda a 16 pt, composePolish falha (203 de 204 asserções); sem a quebra de linha das ferramentas, também (203 de 204).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador. Conferir primeiro no Android (build de debug) e no simulador iOS, depois na web e no PWA, a 320 pt e a 390 pt, no claro e no escuro.

- [ ] Abrir Publicar: o avatar, o texto, os ícones da barra e o contador ficam a 24 pt das bordas, e a barra continua inteira acima do teclado com um rascunho longo.
- [ ] Responder e citar: "respondendo a" ou "citando", o texto respondido e o cartão de citação alinham com o avatar, e as pílulas "cancelar resposta" e "cancelar citação" respondem ao toque e cancelam.
- [ ] Escolher uma foto: cantos de 24 pt. Escolher três: cantos de 12 pt, 8 pt entre elas, e o X de cada uma remove só aquela.
- [ ] Colar um link com a prévia guardada: a pílula "Mostrar prévia do link" começa na coluna do texto e mostra a prévia.
- [ ] Em Momento: a prévia de 160 x 200 pt com cantos de 24 pt e o campo a 24 pt das bordas.
- [ ] A 390 pt e a 320 pt, com as seis ferramentas (na web hospedada com rede) e mais de 800 caracteres: nenhum ícone passa por baixo do contador; os que não cabem descem para a segunda linha e respondem ao toque.
