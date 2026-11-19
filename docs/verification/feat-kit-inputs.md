# Campos sublinhados

Os campos que ainda eram caixas passam ao sublinhado do campo de texto (`Field`). As medidas estão em `apps/site/artwork/app-design.md`.

- Telefone: as seis células do código perdem fundo, cantos e bordas e ganham um sublinhado de 1 pt em `controlOff`, com 56 pt de altura (eram 52 pt). A célula ativa, com o campo em foco, tem a linha de 2 pt em `accent` e 1 pt a menos embaixo, então o dígito não se move. O campo único e invisível sobre as células, o teclado numérico, o limite de 12 caracteres e o pedido para não preencher sozinho continuam iguais.
- Enquete e evento: as opções da enquete e o nome e o lugar do evento são `Field`, com os mesmos limites, textos de exemplo e nomes para o leitor de tela. Cada opção da enquete ocupa a linha ao lado do botão de remover.
- Data e hora do evento: as cinco casas são sublinhadas, com 56 pt de altura e a linha de 2 pt em `accent` na casa em foco. Com uma data inválida, a linha de todas fica na cor de perigo, mesmo em foco.
- Filtros da Feira: De e Até são sublinhados, com 56 pt, e a linha cobre o "R$" e o campo juntos; em foco, 2 pt em `accent`.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 7 arquivos de teste que a mudança alcança passaram, cada um com `node` (dateTimeField, editorFields, feiraBrowse, phone, phoneEntry, phoneExplainer e uiKit), e também eventosScreen, events, polls, pollDraftGuard, feiraScreen, fieldGrow, usePhoneGate e themeUsage.
- [x] Regressões: com o estilo antigo, phoneEntry falha (7 de 8) e dateTimeField falha (1 de 2); antes da troca para `Field`, editorFields falha (0 de 2).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador.

- [ ] Telefone: digitar, colar e apagar o código; a célula ativa com a linha verde e o dígito parado; as células desligadas enquanto confere.
- [ ] Telefone: o teclado não sugere o código do SMS sozinho, no Android e no iOS.
- [ ] Publicar › Enquete: duas a quatro opções, remover uma, e o campo ocupando a linha toda ao lado do botão.
- [ ] Publicar › Evento: nome, lugar, as casas de data e hora com o foco, e uma data inválida em vermelho.
- [ ] Feira › Filtros: De e Até com o "R$" sob a mesma linha, e o foco em cada um.
- [ ] No claro e no escuro, com texto grande, e na web o contorno do navegador só some enquanto a linha verde aparece.
- [ ] Android (build de debug), simulador iOS, web e PWA.
