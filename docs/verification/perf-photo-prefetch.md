# Verificação: perf/photo-prefetch

Busca antecipada das miniaturas das próximas linhas.

## Testes direcionados (`cd apps/app && node test/<arquivo>`)

- `mediaPrefetch` (25 testes):
  - as miniaturas das seis linhas seguintes vêm depois das visíveis;
  - nunca mais de duas ao mesmo tempo;
  - um pedido visível começa antes delas e mantém as quatro vagas normais;
  - a carga visível adota uma busca já iniciada da mesma chave, sem novo pedido;
  - mover a lista uma linha mantém as buscas que continuam na janela;
  - uma rajada só começa depois de 150 ms sem mudança;
  - nada começa antes da primeira janela visível;
  - desligar ou desmontar cancela;
  - falhas definitivas ficam lembradas (até 128 chaves);
  - uma lista sem regra de guarda não busca nada antes;
  - uma chave que outra lista tinha é buscada de novo quando essa lista desiste;
  - a fábrica `prefetchLoad` lê cópias guardadas, guarda conforme a política da linha (inclusive os limites da Espiadinha) e confere hash e tamanho antes do cache.
- Os demais arquivos que leem os arquivos alterados (`mediaCache`, `mediaVariant`, `mediaKeptLoad`, `visibleFirst`, `ruaSnapshot`, `platformGate` e outros).
- Cada correção retirada faz falhar o teste dela, por exemplo `not ok 10 - a visible load takes over a prefetched key and survives list cancellation` e `not ok 15 - moving one row keeps the running key and unchanged updates keep the timer`; sem as duas últimas correções, `not ok 18 - a list without a keep policy never prefetches` e `not ok 19 - a key skipped while another list owned it is retried on the next update`.

## Aterrissagem

`npm run lint`, os arquivos de teste direcionados sobre o diff contra `origin/main` e `npm run demo` ("DEMO OK"). A suíte inteira roda na CI do GitHub (Node 20 e 24).

## Não conferido

Sem verificação manual em Android, iOS ou web: transporte, relógio e armazenamento foram simulados.
