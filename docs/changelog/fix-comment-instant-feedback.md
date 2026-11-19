### Corrigido

- Comentário ou resposta enviados pela barra rápida aparecem na hora na conversa, marcados com Enviando…, e a lista vai até a linha. Quando o envio se completa, a linha fica destacada. Um envio sem confirmação sai da conversa, o texto fica na barra, com os mesmos avisos, e nada é reenviado sozinho (PR `fix/comment-instant-feedback`). Verificação em `docs/verification/fix-comment-instant-feedback.md`.
- Uma resposta publicada pela Publicar, em texto longo, com link, com fotos ou como Página, aparece na hora na conversa aberta, e a lista vai até ela.
- Na A Rua, o comentário recém-enviado aparece embaixo da publicação na hora, e a contagem de comentários nunca fica menor do que os comentários que o próprio cartão mostra.
- Na web e no nó do próprio app, uma resposta enviada enquanto a sincronização ainda alcança o diário espera essa mesma sincronização por até 5 s, em vez de pará-la e começar outra. O limite continua os mesmos 15 s. Se o semeador não confirmar, a resposta é recusada com a mesma mensagem e nada é escrito.
- A resposta rápida deixa de ler o diário inteiro antes de enviar quando o app já sabe o comprimento dele.
