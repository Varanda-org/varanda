- Sobras do vídeo curto (PR `fix/short-video-leftovers`, issue #536). Verificação em `docs/verification/fix-short-video-leftovers.md`.

### Alterado

- O bloqueio de um diário apaga do semeador a foto ou o vídeo dos momentos dele: no drop de um diário bloqueado, em tempo de execução, na partida ou ao desfazer uma admissão que a lista alcançou no meio, o semeador lê os registros `moment` do diário e remove os blobs que eles nomeiam antes de purgar o núcleo. Uma falha nessa remoção é uma falha de purga: o diário continua listado e a próxima partida tenta de novo. Para quem opera: um diretório de blob que o semeador não consegue remover (permissão, erro de disco) agora para o semeador e impede a partida até ser corrigido. Um diário que copiou ids de momentos de outras pessoas leva esses blobs junto no bloqueio (risco aceito, `docs/protocol.md` seção 13). Termos e Política na versão 67.

### Corrigido

- Android: cancelar a preparação de um vídeo (prazo, arquivo grande demais ou fechamento do app) não deixa mais o MP4 parcial no cache quando o muxer termina de escrever depois do cancelamento.
- Web: o vídeo dentro do post tem nome para o leitor de tela ("vídeo de N segundos") e, ao tocar na capa, em "Tentar de novo" ou ao entrar e sair da tela cheia, o foco vai para o vídeo em vez de voltar ao topo da página.
- Android e iOS: o TalkBack e o VoiceOver chegam ao vídeo dentro do post, pelo deslize e pelo toque, e aos controles dele. Depois de tocar o vídeo, de "Tentar de novo" ou de fechar a tela cheia, o foco vai para "ver em tela cheia" em vez de pular para outro controle.
