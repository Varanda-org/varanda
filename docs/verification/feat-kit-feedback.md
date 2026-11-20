# Aviso rápido e linhas da folha de mais ações

O aviso rápido é uma pílula de cantos de 24 pt, com pelo menos 36 pt de altura, preenchimento de 8 pt acima e abaixo, 16 pt à esquerda e 12 pt à direita, e no máximo 92% da largura. As cores continuam balão no fundo e texto do balão no texto. A ação continua com alvo de 44 pt na altura e na largura.

Na folha de mais ações, cada linha tem no mínimo 56 pt, fica a 8 pt da borda do painel e tem 16 pt de preenchimento nas laterais. Pressionada, a linha mostra o preenchimento de esqueleto com cantos de 24 pt. O rótulo usa o nome de linha (16/600/24). Quando alguma ação tem ícone, toda linha ganha uma coluna de 22 pt, também a que não tem ícone, e o título alinha com os rótulos. O visto da escolha, o cabeçalho, os cantos da folha e a espera de fechar antes de agir continuam.

O pin do estilo do aviso entrou em screensPolish. Os pins da linha (56 pt, recuo, cantos da linha pressionada, nome de linha, coluna do ícone e título alinhado) estão em shellChrome.

Só números e medidas de referência; nenhum arquivo, imagem ou ícone de referência entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 99 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles screensPolish, depoimentos, ruaChrome, themeUsage, shellChrome, uiKit, chatActions, postSheetHost, sheetHandover e scrollerFocus.
- [x] Com o `ActionsSheet.js` anterior, os pins novos de `shellChrome.test.js` falham (três asserções: linha de 56 pt, recuo e cantos da linha pressionada com o nome de linha, coluna do ícone e título alinhado), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] No build de debug do Android, um aviso rápido com ação e outro sem ação, um deles com texto longo que quebra de linha: pílula de cantos de 24 pt, pelo menos 36 pt de altura, 16 pt à esquerda e 12 pt à direita, nas cores balão e texto do balão, ação com alvo de 44 pt. A folha de mais ações da publicação e a da mensagem: linhas de 56 pt, cantos de 24 pt no preenchimento de esqueleto da linha pressionada, uma linha de perigo, uma linha indisponível, o visto na escolhida, uma folha com cabeçalho e uma folha em que uma ação não tem ícone, com os rótulos na mesma borda esquerda e o título alinhado a eles.
- [ ] No simulador iOS, repetir o item acima.
- [ ] Na web, a 390 e a 1280 px, no claro e no escuro, repetir o item acima.
