# Formulário de anúncio que não rolava com o teclado aberto (PR `fix/anuncio-form-scroll`)

Data: 2026-11-16.

Relato: no iOS, com um texto colado na Descrição do anúncio, a pessoa não conseguiu rolar até o fim do formulário.

Causa, uma inferência a partir da captura de um arrasto num iPhone real, não comprovada em código de produção: o `Field` (`apps/app/src/ui/index.js`) tinha só `minHeight`. No iOS e no Android o campo crescia até o texto inteiro (até 1000 caracteres) dentro do `ScrollView` do formulário, com o teclado aberto e sem como baixá-lo, e a Categoria e o resto ficavam fora do alcance.

Por que a web e o PWA não são afetados: o textarea do react-native-web não cresce, e a mudança só acrescenta um `maxHeight` acima do `minHeight` fixo. No Android o problema era uma degradação, provavelmente sem bloqueio: o `EditText` devolve o arrasto à página quando não pode rolar.

A correção:

- `fieldBounds` e `fieldFull` em `apps/app/src/ui/fieldHeight.js`: o campo tem de `lines` linhas até seis linhas (`FIELD_MAX_LINES`) e depois rola por dentro.
- `scrollEnabled` só quando o campo está cheio, e só onde o campo cresce sozinho (`GROWS_ITSELF`); antes disso o arrasto rola o formulário.
- `Keyboard.dismiss` no Continuar recusado (Anunciar) e no Salvar (AnuncioEditar).
- Padding da barra com `useKeyboardOpen`: com o teclado aberto, a barra não soma o inset da barra de gestos (mesmo padrão de `ReplyDock` em `Conversa.js`).

Testes automáticos novos:

- `apps/app/test/fieldGrow.test.js`: `fieldBounds gives a form field its least and most height`, `fieldFull is true once the laid out height reaches the maximum` e `the shared Field caps a multiline input and scrolls its text only when full`.
- `apps/app/test/feiraCompose.test.js`: `feiraCompose: a refusal or a save lowers the keyboard and the bar hugs an open keyboard`; dois testes existentes do mesmo arquivo tiveram a expectativa do padding da barra atualizada.

Comandos executados em 2026-11-16, todos passando:

- `node apps/app/test/fieldGrow.test.js`: 9 de 9 testes, 53 de 53 asserções.
- `node apps/app/test/feiraCompose.test.js`: 30 de 30 testes, 421 de 421 asserções.
- `node apps/app/test/uiKit.test.js`: 31 de 31 testes, 276 de 276 asserções.
- `node apps/app/test/depoimentos.test.js`: 33 de 33 testes, 290 de 290 asserções.

Conferência em aparelho:

- Simulador iOS (iPhone 16e, modo vitrine): antes da correção, a Descrição com cerca de 800 caracteres ocupava toda a área visível com o teclado aberto e a barra ficava cerca de 34 pt acima do teclado. Depois, o campo para em cerca de seis linhas e rola por dentro, a Categoria aparece logo abaixo e a barra encosta no teclado.
- Android: o AVD de referência estava em uso (não conferido em aparelho).
- PWA: a web abre no onboarding; conferido só no código (não conferido em aparelho).
- iPhone real (não conferido em aparelho).
- Editar anúncio (não conferido em aparelho).

Lista para uma pessoa conferir:

- [ ] iOS: em Anunciar, colar um texto longo na Descrição com o teclado aberto: o campo para em cerca de seis linhas e rola por dentro, e a Categoria aparece logo abaixo (não conferido em aparelho).
- [ ] iOS: arrastar fora do campo e dentro do campo antes de ele encher rola o formulário; depois de cheio, o arrasto rola o texto (não conferido em aparelho).
- [ ] iOS: Continuar recusado (campo obrigatório vazio) baixa o teclado e mostra o erro; a barra encosta no teclado aberto, sem faixa vazia (não conferido em aparelho).
- [ ] iOS: Editar anúncio com texto longo e Salvar: o teclado baixa e o resultado fica à vista (não conferido em aparelho).
- [ ] Android: os mesmos passos de Anunciar e Editar anúncio, e a barra encosta no teclado, sem a faixa da barra de gestos (não conferido em aparelho).
- [ ] PWA no iOS Safari: a Descrição continua com a altura fixa de antes e o formulário rola normalmente (não conferido em aparelho).
- [ ] PWA no Android Chrome: o mesmo que no iOS Safari (não conferido em aparelho).
