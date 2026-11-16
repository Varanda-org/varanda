# Vocabulário: comentar e comentário fora da conversa (branch feat/comment-vocabulary)

Regra: "comentar" e "comentário" para a resposta a uma publicação (item sem `replyTo`); "responder" e "resposta" só para a resposta a um comentário (item com `replyTo`). O botão de resposta do cartão (`PostRow`, "comentar na publicação de <nome>" ou "responder a <nome>") e o campo da Conversa já seguiam a regra na A Rua, na Conversa, na Espiadinha, na Busca e no Diário (`docs/verification/feat-roda-conversa.md` e `docs/verification/feat-feed-comment-fold.md`). Sem mudança de protocolo, RPC nem Termos.

Textos trocados (antes -> depois):

- `Membro.js`: o cartão no perfil de outra pessoa passa o nível ao `PostRow`, então lê "comentar na publicação de <nome>" numa publicação, em vez de "responder a <nome>".
- `ReplyBar.js` e `Conversa.js`: o botão de enviar lê "Comentar" quando o campo diz "Escreva um comentário" (resposta à publicação principal) e "Responder" numa resposta a um comentário.
- `postPreviewCopy.js` e `PostLinkPreviewRow.js`, prévia de link de uma publicação: o botão de resposta lê "Comentar" (`A11Y_REPLY`), ou "Responder" (`A11Y_ANSWER`) quando a publicação mostrada já é uma resposta ("Em resposta a outra publicação").
- `postActions.js`, ação `reply` (id e ícone iguais): "Comentar" numa publicação, "Responder" num comentário. Nenhuma tela chama `primaryActions` hoje, então isso só aparece quando alguma passar a chamar.
- `help.js`, ajuda da A Rua: "curtidas e respostas" -> "curtidas e comentários".
- `notices.js`, `EMPTY_TEXT` e `PAGE_EMPTY_TEXT`: "responder" -> "comentar" (o texto citado em `docs/app.md` acompanha).
- `push-state.js`, `PUSH_HINT`: "responder" -> "comentar".
- `App.js`, avisos "resposta publicada" -> "publicado": nenhum dos dois pontos (o `lastSent` do outbox e o `onPublished`) sabe se a publicação respondida tem `replyTo`, então o aviso fica neutro em vez de adivinhar.

Mantidos de propósito:

- `legal.js`: sem aumento da versão dos Termos.
- `Publicar.js` ("respondendo a") e `Diario.js`: nomeiam a pessoa ou o alvo, valem nos dois níveis.
- `noticeParts` do tipo reply em `notices.js` e `apps/cli/lib/account/push-text.js`: a linha do aviso não sabe se a publicação respondida é raiz; uma linha por nível é outra decisão.
- Telas de DM e de chat e a aba "Conversas" (`tabs.js`): são outro assunto.

Conferência no aparelho:

- [ ] Android e iOS, com TalkBack e VoiceOver: no perfil de outra pessoa, o botão de resposta de uma publicação lê "comentar na publicação de <nome>" e o de um comentário "responder a <nome>": pendente.
- [ ] Android e iOS: na Conversa, o botão de enviar lê "Comentar" sem alvo e "Responder" com um comentário como alvo: pendente.
- [ ] Web: na prévia de link, o botão de resposta lê "Comentar" numa publicação e "Responder" numa resposta: pendente.
- [ ] Android, iOS e web: depois de enviar uma publicação, um comentário ou uma resposta, inclusive pela fila, o aviso diz "publicado": pendente.
