### Alterado

- O semeador guarda os envelopes das mensagens diretas por 14 dias em vez de 7, e o conjunto passa de 20000 para 40000 envelopes. Um aparelho que fica até duas semanas sem abrir o app ainda recebe o que chegou nesse tempo. O resumo de cada selo já usado continua 14 dias, e `DM_V3_STALE_MS` (mensagem de uma Página assinada por um administrador removido) passa de 8 para 15 dias. Verificação em `docs/verification/feat-dm-retention-14-days.md`.
- As fotos, GIFs e mensagens de voz das conversas e a mídia dos Momentos (o mesmo conjunto de blobs) ficam no semeador por 14 dias em vez de 7, e o teto de bytes padrão do conjunto passa de 2 GiB para 4 GiB (`seed --blob-bytes` continua mandando). Os Termos e a Política dizem 14 dias; a versão deles é subida no merge.
