# Sombras do kit e papéis da paleta

`elevation` em `apps/app/src/ui/theme.js` ganha os níveis do kit (`xs`, `sm`, `md`, `lg`, `xl`, `xxl`, `edge`). Cada string já traz as duas camadas e a cor, e entra sozinha no `boxShadow`. `edge` tem uma camada só. `raised` continua `0px 6px 16px` e segue junto de `colors.shadow`. A tabela, com o uso de cada nível no kit, está em `apps/site/artwork/app-design.md`.

As duas paletas ganham quatro papéis. `onMedia` é `#ffffff`, `mediaBg` é `#000000` e `mediaScrim` é `rgba(0,0,0,0.55)`, iguais no claro e no escuro. `dangerSoft` é `rgba(163,32,26,0.10)` no claro e `rgba(255,143,135,0.16)` no escuro. Os alfas de `dangerSoft` são do app.

Nenhuma tela consome as chaves novas neste PR. Só números de referência: nenhum arquivo, imagem ou ícone do kit entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 33 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles appearance, themeUsage, profileThemes, shellChrome, uiKit e screensPolish.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Nada para ver neste PR, porque nenhuma tela lê as chaves novas ainda.
