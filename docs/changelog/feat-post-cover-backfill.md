### Adicionado

- RPC `post.uncovered`: lista até oito publicações próprias já compartilhadas na web que precisam de capa, sem gravar nada; o nó core recusa o método.
- Campo `uncovered` no status assinado de Páginas, com as publicações compartilhadas que ainda precisam de capa. Serviço antigo sem o campo não inicia tentativa.
- Capa automática de publicações antigas quando o app com instalação fica ocioso, com cadastro concluído, Termos aceitos e identidade desbloqueada, em primeiro plano e com conexão. No máximo quatro publicações por passagem, uma de Página, uma passagem por identidade em cada abertura e uma tentativa por publicação por aparelho, sem repetir falhas ou respostas incertas. Foto que não se decodifica não grava nada.
- Termos versão 104 descrevem a cópia reduzida automática da capa de publicações já liberadas na web. Verificação em `docs/verification/feat-post-cover-backfill.md`.
