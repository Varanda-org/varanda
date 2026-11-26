# Resultados da pilha de carregamento de conteúdo (branch test/content-results)

Uma correção na bancada e a seção nova de `docs/performance.md` ("Resultados da pilha de carregamento de conteúdo"). Os números vêm da bancada, no Node num Mac (Apple M4 Pro, Node v24.22.1), em loopback, com outra sessão rodando testes (carga de 1 min entre 3,0 e 4,3). Nenhum é de celular.

## Correção

- `content-load.js` marcava o início das varreduras na etapa `índice de réplicas` e deixava `diários de grupo` de fora. Agora conta desde `diários de grupo`, a primeira das três.
- `content-load.test.js` ganhou o caso que prende isso: falha com o script antigo e passa com o novo.

## Como foi medido

- `content-load.js --clients 4 --duration-ms 20000 --json`, `--rtt-ms 0` e `--rtt-ms 100`, 3 execuções de cada lado, intercaladas (antes, depois, 0 ms, 100 ms).
- Antes: árvore de `test/content-timing` (3844627b7), com o `content-load.js` desta branch copiado só durante a medida e apagado depois. Depois: esta branch, sobre `feat/cdn-ready-app` (ffc8a4752).
- Saídas brutas, locais e não versionadas: `a23-{base,after}-rtt{0,100}-r{1,2,3}.json`, com as cargas em `*.load`.

## Resultado

- 12 execuções terminaram com saída 0, 0 erros internos, 0 fechamentos 1013 e 0 conexões deixadas abertas. Em 0 ms houve 67 a 99 respostas 503 do índice por execução (limite de taxa do próprio teste); em 100 ms, nenhuma.
- Nos caminhos padrão da bancada, antes e depois ficam dentro do ruído. Os ganhos medidos da pilha são os da seção dos nomes em lote.
- Portão G2 com o relógio corrigido: 0,05 ms de varreduras contra 16,1 ms de `first-content` p50 a 100 ms. Não se cumpre; A22 ficou de fora.

## Checagens

`npm run lint`, `content-load.test.js` e `npm run demo` na landing desta branch. Conferido: nenhum travessão (U+2014) no texto novo.
