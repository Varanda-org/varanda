- Sobras da Espiadinha e dos Avisos (PR `perf/peek-leftovers`, parte da #539): o medidor de carga ganha `--no-discovery`, com as medidas de `peek.read` e `notices.list` com e sem descoberta num conjunto de 200 diários. Verificação em `docs/verification/perf-peek-leftovers.md`.

### Segurança

- Espiadinha e Avisos no navegador: um semeador que serve blocos assinados acima do tamanho esperado não leva mais o excesso em voo numa leitura a até cerca de 48 MiB na Espiadinha (16 diários x 3 blocos de até 1 MiB) e 32 MiB nos Avisos (8 x 4). Todo byte que o semeador manda na ligação da leitura conta: passado o orçamento mais um quadro (1 MiB) por diário em paralelo, a ligação fecha e a página fica incompleta.

### Corrigido

- Espiadinha: quem segue quase todos os cerca de 384 diários mais recentes não vê mais páginas vazias até aparecer "carregar mais". Uma página incompleta que não trouxe nada novo continua lendo a partir do cursor, no máximo mais 3 leituras por carga.
