# Linhas, marcas de escolha, acordeão e cartão

Os grupos de Ajustes passam a ter cantos de 24 pt (`radius.bubble`), fundo de cartão e fio de 1 pt, com as linhas recortadas no canto e no mínimo 48 pt de altura. A primeira linha não tem divisória; as seguintes têm um fio fino no topo. O `Card` ganha o mesmo raio e o fio de 1 pt, com preenchimento de 12 pt e vão de 8 pt, e o `OptionList` (outras formas de entrar e os Termos antes de entrar) também fica com cantos de 24 pt. O grupo de motivos em Denunciar e o de "Quem pode deixar recado" continuam com 12 pt.

As linhas de escolha passam a mostrar as marcas do kit, sempre decorativas e escondidas do leitor de tela; o papel, o estado e o toque continuam na linha, sem papel aninhado:

- `RadioMark` no fim da linha em Aparência (só quando o item recebe `checked`), no motivo de Denunciar e em "Quem pode deixar recado".
- `CheckboxMark` no começo da linha na caixa "Público na web e em buscadores" da revisão do anúncio e em cada pessoa do cartão "Pessoas que você seguia neste aparelho", em Seguindo; no fim da linha em cada conversa de Encaminhar. Em Encaminhar a caixa vazia aparece nas conversas não escolhidas, e a marca continua depois que o envio começa (antes, o sinal sumia).
- Em Passkeys, "Anotei o código" é o `CheckRow` compartilhado. "Pronto" continua desligado até a caixa ser marcada, e só um toque ou a tecla Espaço na linha a marca. A linha perdeu o `hitSlop` de 8 pt, mas tem no mínimo 44 pt; o rótulo foi de 16 para 15,5 pt.

A barra de passos de Anunciar passa a ser a `ProgressBar`, com 3 pt de altura e trilha na cor do fio, e fica com as pontas arredondadas; o `View` em volta mantém o papel `progressbar` e o rótulo. Em Ajustes › Termos e privacidade, cada documento é um `Accordion` ("mostrar" e "esconder"); a tela guarda o estado (`openTerms`, `openPrivacy`) e o passa em `expanded` e `onToggle`, e o texto só existe enquanto o documento está aberto, com os mesmos 8 pt entre títulos e parágrafos que o cartão dava. No portão antes de entrar, as linhas agrupadas com "Ler" e "Fechar" não mudam. No formulário manual de Conexão, "DHT pública" é um `SwitchRow` dentro do cartão, gravando o mesmo `form.publicDht`.

## Testes

- [x] `npm run lint` passou.
- [x] Os 49 arquivos de teste que a mudança alcança passaram, cada um com `node`: a11yCompose, attachPlan, backgroundTask, chatActions, choiceControls, composePolish, composerReplyTap, connectText, conversasList, dayClock, devices, dm, embedFrame, feiraCompose, fieldGrow, followPill, forwardSheet, group-flow, hapticsUse, hardening, kitAtoms, linkPreview, linkReturn, metroBlocked, muralGrid, pageChoice, passkeysScreen, perfMarks, perfScroll, pessoas, phone, phoneEntry, postLayout, postOverflow, pressMotion, push-shell, push-switch, recadosView, replyBar, report, richTextView, sw, terms, termsCreate, themeUsage, uiKit, versionFooter, visibleNow e wordCheck.
- [x] Sem o `View` de 8 pt de vão dentro do acordeão de Termos, o teste novo de `terms.test.js` falha (367 de 368 asserções), como esperado.
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## Conferência visual

Em cada item, conferir no tema claro e no escuro e com o texto do sistema bem grande.

- [ ] No build de debug do Android, Ajustes: grupos com cantos de 24 pt e fio, linhas de 48 pt sem vazar do canto; em Aparência, o círculo da opção no fim da linha, cheio só na escolhida; o grupo Avançado com o mesmo canto.
- [ ] No Android, Denunciar e "Quem pode deixar recado": o círculo no fim de cada linha, um só marcado, e o grupo ainda com 12 pt.
- [ ] No Android, Passkeys: depois de ver o código, "Pronto" desligado até tocar em "Anotei o código"; tocar de novo desmarca e desliga "Pronto".
- [ ] No Android, Anunciar: a barra de passos fina, com pontas redondas, avançando a cada passo; na revisão, a caixa "Público na web e em buscadores" no começo da linha.
- [ ] No Android, Encaminhar: caixas vazias nas conversas, marcadas ao escolher, e ainda marcadas durante o envio. Em Seguindo, o cartão "Pessoas que você seguia neste aparelho" com a caixa no começo de cada linha.
- [ ] No Android, Ajustes › Termos e privacidade: "mostrar" abre o documento com espaço entre títulos e parágrafos, "esconder" fecha; o leitor de tela diz se está aberto. Antes de entrar, as duas linhas com "Ler" e "Fechar" e o botão de aceite ao alcance.
- [ ] No Android, Ajustes › Avançado › Conexão, formulário manual: a linha "DHT pública" liga e desliga, o campo de bootstrap fica desligado só com ela ligada, e o aviso aparece só nesse caso. A linha tem 16 pt de recuo dentro do cartão, que já tem 12: conferir se o rótulo fica alinhado o bastante com os rótulos dos campos.
- [ ] No simulador iOS, repetir os itens acima.
- [ ] Na web, a 390 e a 1280 px, repetir os itens de Ajustes, Denunciar, Recados, Anunciar, Encaminhar, Seguindo e Termos. A linha "DHT pública" só existe no app nativo.
