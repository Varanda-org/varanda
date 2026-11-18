# Cantos e alças das folhas

`Sheet` e `ActionsSheet` usam `layout.sheetRadius` para os cantos superiores. Em Publicar no iOS, a folha de página mantém o canto do sistema. O raio passa de 24 para 48 pt e vem da folha de ações do kit de referência. O raio da folha de altura total do kit não foi consultado. Só números de referência: nenhum arquivo, imagem ou ícone do kit entrou no repositório. A alça central de 48 × 5 pt usa a cor `colors.line` e tem pontas arredondadas. Na folha de Publicar, fica a 8 pt do topo.

## Testes

- [x] `npm run lint` passou.
- [x] Os 38 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles themeUsage, shellChrome, uiKit, sheetDrag e replyBar.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Com 320 pt de largura, abrir Publicar, digitar um texto e conferir se "Cancelar" e "Publicar" aparecem por inteiro e respondem ao toque. Em Conversas, pressionar e segurar uma mensagem para abrir a folha de mais ações e repetir a conferência nos botões de reação rápida e no botão "+". Em ambas as folhas, conferir que a curva de `layout.sheetRadius` deixa livres os controles do topo.

- [ ] No build de debug do Android, conferir os controles das duas folhas.
- [ ] Na web, repetir a conferência com a janela a 320 px.
