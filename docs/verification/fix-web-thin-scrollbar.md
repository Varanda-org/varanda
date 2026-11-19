# Barra de rolagem fina nas cores do tema, na web (branch fix/web-thin-scrollbar)

A partir de `6719f693`; as caminhadas na web e no celular abaixo rodaram sobre `16b61a19` (a diferença é só o #800, sem arquivo em comum com esta mudança). Não muda protocolo, RPC nem Termos. Só a web muda; Android e iOS ficam iguais.

## O que mudou

No macOS com "Mostrar barras de rolagem: Sempre" (ou com um mouse ligado) e no Windows, o navegador desenha a barra larga e cinza do sistema em toda área que rola. Como `html` e `body` não rolam (`overflow: hidden`), cada lista, página, folha e campo de texto tem a sua, e a da coluna de A Rua aparecia no meio da tela.

- `apps/app/public/index.html`, bloco `expo-reset`: `* { scrollbar-width: thin; }`. A largura não é herdada, por isso a regra é universal.
- `apps/app/src/appearanceStore.web.js`: `applySchemeToDocument` recebe `thumb` e põe `scrollbar-color: <thumb> <bg>` no `html`. A cor é herdada, então chega a todas as áreas que rolam e aos campos de texto.
- `apps/app/src/ui/ThemeProvider.js`: passa `thumb: colors.outline`. A troca de Aparência (Claro, Escuro, Sistema) repinta a barra sem recarregar, porque o efeito já roda a cada mudança de esquema.
- As faixas horizontais que escondem a barra (`showsHorizontalScrollIndicator={false}`) continuam sem barra: a classe do react-native-web tem mais especificidade que `*`.

## Como verificar

A partir da raiz:

- `node apps/app/test/appearance.test.js`: 13 testes, 98 asserções (antes 11 testes). Com os arquivos de `16b61a19` no lugar de `appearanceStore.web.js` e `index.html`, os dois testes novos falham (11/13).
- `npm run lint`, os testes de `apps/app` que leem `index.html`, `appearanceStore` ou `ThemeProvider` (16 arquivos, todos passam) e `npm run demo` ("DEMO OK").

Web (vitrine, `EXPO_PUBLIC_VARANDA_VITRINE=1`), Chrome 156 no macOS, conferido pelos estilos calculados:

- [x] Escuro: a lista de A Rua tem `scrollbar-width: thin` e `scrollbar-color: rgba(245, 245, 245, 0.32) rgb(16, 16, 16)`; ao rolar, aparece a barra fina na borda direita da coluna.
- [x] As três faixas horizontais de A Rua seguem com `scrollbar-width: none`.
- [x] A folha de Ajustes: barra fina com as mesmas cores.
- [x] Aparência em Claro, sem recarregar: `rgba(31, 42, 36, 0.3) rgb(251, 248, 243)`.
- [x] O campo de texto do compositor: barra fina com as cores do Claro.

Celular (build de debug, vitrine), para confirmar que nada mudou:

- [x] Simulador iOS (iPhone 17 Pro, iOS 26.2): A Rua rola como antes; Ajustes abre e rola; Aparência em Escuro repinta o app; de volta a Sistema.
- [x] Emulador Android (AVD `varanda-api36`): A Rua rola como antes; a folha de Ajustes mostra o indicador nativo de sempre; Aparência em Escuro repinta o app e A Rua rola no escuro; de volta a Sistema.
- [x] O Metro não mostrou erro novo (só os avisos de ciclo de `require` que já existiam).

## Fora desta mudança

- Não conferido: o puxar para atualizar com a roda do mouse no topo de A Rua (o código dele não mudou), o modo Sistema na web seguindo o sistema, Firefox e Safari.
- Safari não foi conferido: um navegador que não reconheça `scrollbar-width` ou `scrollbar-color` ignora a regra e continua com a barra do sistema.
- No macOS com barras sobrepostas, a barra continua aparecendo só ao rolar: muda a aparência de uma barra visível, não quando ela aparece.
- Os players incorporados (YouTube, Spotify e outros) são outros documentos e mantêm as barras deles.
- Esconder a barra não faz parte desta mudança.
