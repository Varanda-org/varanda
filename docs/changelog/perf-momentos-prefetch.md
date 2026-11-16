### Alterado

- Os momentos abrem a próxima foto sem esperar: o app já deixa pronta a foto do próximo momento, e voltar para o anterior também é imediato (PR `perf/momentos-prefetch`). Verificação em `docs/verification/perf-momentos-prefetch.md`.
- A música do próximo momento começa mais cedo, porque o app já busca os dados da faixa seguinte enquanto o momento atual carrega.
