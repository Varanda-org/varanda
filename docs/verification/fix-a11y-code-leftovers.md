# Restos de acessibilidade em código (branch fix/a11y-code-leftovers)

Refs #153, #155, #55.

- Abas do seletor de emojis: `minHeight` de 32 para 44 pt.
- Linha "republicou" (UX-06): caixa de 28 pt (padding cancelado por margens negativas) mais `hitSlop` até 44 pt.
- Já corretos em `origin/main`, sem mudança: remover foto na Publicar (`remover foto N de M`), "Pular por enquanto" (`Pill` com papel de botão e rótulo), `ErrorState` (usa `ErrorText` com papel `alert`).
- `Sheet`: o `Modal` do React Native já leva o foco do leitor de tela para dentro e devolve ao fechar (iOS, Android; a web usa a armadilha de foco do react-native-web). Sem código novo.

Como verificar: `node apps/app/test/hit.test.js`. Falta, e é manual: VoiceOver e TalkBack em aparelho (foco do Sheet, toque da linha "republicou").
