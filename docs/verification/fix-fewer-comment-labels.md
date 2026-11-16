# Menos "comentário" repetido (branch fix/fewer-comment-labels)

Duas repetições saem, sem mudança de protocolo, RPC nem Termos:

- `PostRow`: o rótulo em negrito "Comentários" acima das linhas de prévia do cartão dobrado. "Ana comentou" e as linhas "Nome: texto" já dizem o que são.
- `Conversa`: a linha "N comentários" embaixo da publicação em destaque. O número já aparece ao lado do ícone de comentar dela. `commentsTitle` sai de `roda.js`.

Ajustes de revisão em `Conversa`:

- O número de comentários na barra de ações da publicação em destaque tem o piso `Math.max(repliesTotal, comentários na tela)`: um comentário próprio que o índice ainda não contou continua aparecendo no número.
- "Esta publicação não pôde ser verificada agora." virou a primeira nota calma, então mantém a divisória do bloco de notas.
- `meta.repliesTotal` saiu do estado da tela (só o cabeçalho removido o lia).

Ficam: "Ana comentou", "Ver todos os N comentários" e "Ver comentários", o título "Comentários" da tela, as notas calmas, "Escreva um comentário" e a regra comentar/responder. O rótulo de acessibilidade do cartão continua começando com "Comentários.", e a publicação em destaque mantém a própria borda inferior como divisória.

Testes automáticos:

- `apps/app/test/postLayout.test.js`: o cartão não tem `styles.previewsLabel` nem `>Comentários</Text>`; o rótulo de acessibilidade `'Comentários. '` continua.
- `apps/app/test/conversaScreen.test.js`: a tela não tem `commentsTitle` nem `repliesTitle` nem `meta.repliesTotal`, só mostra o bloco quando `phase === 'ready' && notes.length > 0`, guarda o piso da contagem da raiz e põe a nota "não pôde ser verificada" no bloco de notas; o teste de envio confere que um comentário próprio sobe a contagem da raiz (3 para 4) e fica primeiro, e que um envio incerto não muda nada.
- `apps/app/test/group-flow.test.js`: a mesma condição, só notas, sem cabeçalho de contagem.
- `apps/app/test/roda.test.js`: `commentsTitle` não é mais testado; `AUTHOR_TAG` continua.

Comandos: `cd apps/app && node ../../scripts/run-tests.js test/conversaScreen.test.js test/postLayout.test.js test/group-flow.test.js test/roda.test.js test/themeUsage.test.js test/platformGate.test.js test/feedPreviews.test.js` (7 arquivos, 0 falhas; conversaScreen 76 testes e 649 asserções, postLayout 16 e 133, group-flow 61 e 473, roda 22 e 114), `node apps/cli/test/changelog.test.js` e `npm run lint`.

Conferência no aparelho (Android AVD `varanda-api36`, simulador iOS, Chrome a 390 px):

- [ ] Cartão da A Rua com dois comentários: sem rótulo em negrito, e as linhas ficam logo abaixo da barra de ações: pendente.
- [ ] Conversa: sem a linha "N comentários", as notas calmas continuam e a linha embaixo da publicação em destaque fica: pendente.
- [ ] TalkBack e VoiceOver leem "Comentários. ..." no cartão: pendente.
