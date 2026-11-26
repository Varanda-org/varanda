### Adicionado

- Descrição de fotos e vídeos para leitores de tela: no Publicar, cada foto (ou o vídeo) ganha um campo curto, de até 140 caracteres, com a explicação atrás do (i). A descrição vai num registro novo, `post-alt`, ao lado da publicação, que leitores antigos ignoram (protocolo, seção 18, V3). O app a lê como rótulo de acessibilidade no feed, no carrossel, na foto ampliada e nas citações, e a página pública `/p/` a usa como `alt` da imagem. Apagar a publicação apaga a descrição junto, e Páginas também podem descrever as suas (PR `feat/media-alt-text`, parte de #80).
