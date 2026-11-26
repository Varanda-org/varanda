# Linha de base da cronometragem do primeiro conteúdo (branch test/content-timing)

Só documentação: a seção nova de `docs/performance.md` ("Linha de base da cronometragem do primeiro conteúdo e portão da onda 15"). Os números vêm da bancada, no Node num Mac (Apple M4 Pro, Node v24.22.1), em loopback, com outras sessões usando a máquina (carga de 1 min entre 4,6 e 6,2). Nenhum é de celular.

## Como foi medido

- `content-load.js`, 4 leitores, 20 s (reduzido do padrão para caber na máquina compartilhada), `--rtt-ms 0` e `--rtt-ms 100`, 3 execuções de cada, intercaladas, com o script já com as correções de revisão (`open` medido depois da sincronização e da espiadinha; `--media-rate` de pelo menos 1). Uma primeira série com o script anterior foi descartada e refeita.
- `startup-bench.js --follows 60 --blocks 150 --own 800 --file --issued --js-verify --steps --early-reads --reads --runs 5`, 3 execuções. Uma série sem `--reads` foi descartada: o leitor é publicado cedo e a bancada aborta a sincronização antes das etapas dos seguidos e das varreduras.
- Saídas brutas, locais e não versionadas: `rtt0-r1..3.json`, `rtt100-r1..3.json`, `startup-r1..3.json` (com as cargas em `*.load`).

## Resultado

- 6 execuções de `content-load.js` terminaram com saída 0, 0 erros internos, 0 respostas 429, 0 fechamentos 1013 e 0 tempos esgotados. Em 0 ms houve 130 a 164 respostas 503 do índice por execução (limite de taxa do índice do próprio teste); em 100 ms, nenhuma.
- Portão G2 (varreduras da partida: pelo menos 10 % do `first-content` e pelo menos 100 ms a 100 ms de ida e volta): não se cumpre na bancada. `sweepsMs` 0,04 ms contra `first-content` p50 13,4 ms; no `startup-bench.js` as três varreduras somam cerca de 11,5 ms. O G1 foi retirado do escopo.
- Limite: as varreduras são cronometradas sem rede e sem atraso simulado dentro delas; o resultado num aparelho com 100 ms de ida e volta fica por medir.

## Checagens

Sem código alterado. Conferido: nenhum travessão (U+2014) no texto novo.
