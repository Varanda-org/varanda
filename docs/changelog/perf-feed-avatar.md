### Alterado

- A Rua carrega as fotos dos autores já na primeira leitura do feed: cada item de `feed.read` e `page.feed` passa a trazer o `avatar` do autor, do mesmo perfil de onde vem o nome, em vez de esperar a leitura de perfis em lote. Por causa da foto em cada item, a página do feed passa de 26 para 25 itens (`FEED_LIMIT_MAX` e `FEED_LIMIT_DEFAULT`). Parte da #353. Verificação em `docs/verification/perf-feed-avatar.md`.
