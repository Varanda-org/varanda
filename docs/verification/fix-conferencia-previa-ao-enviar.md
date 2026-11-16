# Conferência da prévia de link no envio (branch fix/conferencia-previa-ao-enviar)

Duas sugestões da revisão do #652, sem mudança de protocolo, semeador nem RPC. Nada sai do aparelho.

- Publicar e Grupo: a conferência da prévia deixa de ler `linkDraft.view`, que vem do último desenho da tela, e passa a ler `linkDraft.take(text)` (`take(draft)` em Grupo), o mesmo estado que o envio congela logo depois. Sem cartão pronto, `take` devolve `null` e nada é recusado, como antes.
- `docs/design.md`, "Onde não vale": o cartão de música (Audius) não é conferido, porque o título e o artista vêm do catálogo. O teste `post, reply and quote send the music card with no image or provider text check` segue fixando isso.

Como verificar, a partir da raiz:

- `node apps/app/test/wordCheck.test.js` (22 testes; antes 21). As duas afirmações de "a link preview is checked before a public post and a public group message" falham sem a mudança nas telas. O teste novo "the card a send will use is the one checked, even if the view is stale" mostra que o cartão congelado por `take` é recusado onde a vista antiga não era; ele não depende das telas.
- `node apps/app/test/musicDraft.test.js` e `node apps/app/test/videoCompose.test.js`: o `linkDraft` falso agora responde `take: () => null`, porque a conferência chama `take` antes do envio; música e vídeo não levam cartão de link.
- `npm run lint` e `npm test -w apps/app`.

Limites:

- Os testes de tela leem o texto do código; a corrida em si (prévia montada entre o último desenho e o toque) não é montada num teste de tela, só o efeito do `take` sobre um estado já pronto.
- Nada foi conferido no celular nem na web nesta documentação.
