# Controles do kit (feat/kit-controls)

O desenho em `apps/site/artwork/app-design.md` ganha o papel controle desligado (`controlOff`) e uma entrada por componente novo ou mudado: interruptor, chips de filtro, caixa de seleção, opção, selo, barra de progresso e acordeão. Selo, barra e acordeão ainda não aparecem em nenhuma tela; entram nos PRs seguintes da pilha. Só números e medidas. Nenhum arquivo, imagem ou ícone do kit de referência entrou no repositório. Os ícones continuam Feather, por `ui/Icon.js`.

## Testes

Rodados localmente nesta branch, sobre `origin/main@16b61a19`:

- [x] `npm run lint`: passou.
- [x] Os testes do app que a mudança alcança, um arquivo por vez (15): `ageMemory`, `appearance`, `chatSurfaces`, `choiceControls`, `feiraScreen`, `hapticsUse`, `kitAtoms`, `preSplash`, `profileExtraView`, `profileThemes`, `renderOg`, `searchField`, `senderPalette`, `switchRow` e `themeUsage`. Todos passaram.
- [x] `npm run demo`: terminou com "DEMO OK".
- [ ] A suíte inteira (`npm test`) não rodou localmente: roda na CI do GitHub, no Node 20 e no 24.

O que os testes novos e mudados cobrem:

- `apps/app/test/appearance.test.js`: `controlOff` a 3:1 ou mais sobre fundo, cartão e campo desligado, nos dois modos.
- `apps/app/test/switchRow.test.js`: trilha de 44 por 28 pt, bolinha de 22 pt, recuo de 3 pt e canto de pílula; um só papel de interruptor; linha desabilitada a 0,45, sem a trilha esmaecer de novo.
- `apps/app/test/choiceControls.test.js`: caixa de 24 pt com canto de 8 pt, opção de 22 pt com ponto de 10 pt, marcas sem papel nem toque; `CheckRow` com um só papel de caixa, a barra de espaço alternando uma vez mesmo segurada, linha desabilitada a 0,45 e barra de espaço sem `onPress` sem erro.
- `apps/app/test/kitAtoms.test.js`: selo decorativo de 6 pt, com cor própria; barra de progresso vazia, parcial e cheia, e com valor ausente, inválido ou fora de 0 a 1; acordeão com cartão, botão, `aria-expanded`, dica, seta e conteúdo mudando juntos, o mesmo fio aberto e fechado, e o estado guardado por quem o usa (`expanded` e `onToggle`).
- `apps/app/test/hapticsUse.test.js`: chip escolhido preenchido em tinta, rótulo na cor do fundo, folga vertical de 6 pt.

## O que não foi conferido no visual

Nada foi aberto no aparelho nem no navegador.

- [ ] Interruptor ligado, desligado e desabilitado, no claro e no escuro.
- [ ] Chip de filtro solto e escolhido, inclusive numa fileira que precisa rolar.
- [ ] Caixa de seleção e opção, marcadas, soltas e desabilitadas, no claro e no escuro.
- [ ] Contraste de `controlOff` na tela. Os números do desenho saíram da fórmula de `contrastRatio` em `apps/app/src/appearance.js` (a mesma do teste), com uma casa decimal, e não de um aparelho.
- [ ] Android (build de debug), simulador iOS, web e PWA.
- [ ] Texto grande e larguras de 320 px e 1280 px.
