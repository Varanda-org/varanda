### Adicionado

- Foto parada em AVIF (PR `feat/media-avif-format`): publicações, momentos, grupos e mensagens diretas aceitam `image/avif` no perfil parado publicado (uma imagem `av01`, ou uma grade de 2 a 64 ladrilhos iguais), conferido por `mediaBounds` sobre o arquivo inteiro. Avatar, capa de vídeo e miniatura de link continuam como estavam. O app exibe um AVIF já publicado; a codificação em AVIF fica para os próximos PRs. Semeadores e o serviço de conta precisam desta versão antes de qualquer app publicar AVIF. Verificação em `docs/verification/feat-media-avif-format.md`.
- O app agora confere toda foto recebida com o leitor estrito antes de mostrá-la, e o serviço de contas e a CLI recusam no envio as fotos que ele recusaria (por exemplo, uma JPEG de 6000x4000).
