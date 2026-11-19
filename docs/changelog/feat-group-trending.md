### Adicionado

- Ordem "Em alta" na descoberta de grupos públicos (PR `feat/group-trending`): o semeador responde `GET /index/group-browse/trending` com os grupos públicos abertos em que pelo menos 2 diários servidos publicaram nos últimos 7 dias, do maior número para o menor, até 20 por página. Cada diário conta uma vez, Páginas e diários bloqueados não contam, e a contagem é uma dica baseada na data que o autor declara. A regra é fixa, pública e igual para todos. Verificação em `docs/verification/feat-group-trending.md`.
