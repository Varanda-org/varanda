# test/seeder-trending-downloaded

Correção só de teste em `packages/core/test/seeder-group-trending.test.js`. O teste 1 ("two diaries that posted lately list an open group with active 2; ...") falhava de vez em quando rodando sozinho, nas asserções "D, E and F in G" (2 em vez de 3) e "most active first".

## Causa

Corrida do teste, não erro do semeador. O `setup()` esperava o `group-admitted` de cada núcleo e depois `settled()`, que espera a resposta "em alta" com `complete: true`. O semeador emite `group-admitted` antes de baixar o núcleo, confere o cabeçalho (`_gateGroup`) assim que o bloco 0 chega, e `complete` cobre só os blocos que ele já tem: `_activityBehind` compara a leitura de atividade com o prefixo contíguo (`contiguousLength`), não com o comprimento do núcleo. Se o bloco 0 de um núcleo chega antes do bloco 1, há um intervalo em que o núcleo conta, a leitura de atividade terminou e o post ainda não chegou. `settled()` podia aceitar a resposta nesse intervalo: G com 2 ativos sem o post de F, ou M fora da lista sem o de E. No registro de uma falha, o núcleo de E em M estava com 1 de 2 blocos e sem atividade.

O semeador faz o que está escrito (a lista "em alta" reflete o que ele guarda e se atualiza quando o bloco chega), então a mudança fica no teste.

## O que mudou

`setup()` espera, antes de `settled()`, que o semeador tenha baixado cada núcleo dos membros A, D, E e F até o comprimento do escritor, com o helper `downloaded` de `test/helpers/seeder-groups.js`, que outros arquivos já usam. Os outros testes do arquivo usam o mesmo `setup()` e ganham a mesma espera.

## Estresse (Node 24, 12 núcleos, 4 deles ocupados por laços de CPU, outra sessão rodando testes na máquina)

Cada execução é um processo novo com só o teste 1 (o arquivo cortado por um script local), 8 processos em paralelo por lote. As duas linhas forçadas usam um `--require` local que altera as faixas de download do Hypercore, só para medir e fora do PR.

| Cenário | Antes | Depois |
|---|---|---|
| Teste 1, processos novos | 7 falhas em 208 ("D, E and F in G" nas 7, "most active first" em 3) | 0 em 160 |
| Teste 1 com o post de F em G atrasado 3 s (o bloco 0 chega primeiro, o resto 3 s depois) | 5 falhas em 5 ("D, E and F in G", 2 em vez de 3) | 0 em 5 |
| Teste 1 com cada faixa de download começando até 800 ms atrasada, bloco 0 incluído | 0 em 40 | 0 em 40 |
| Arquivo inteiro, 8 em paralelo | não repetido | 0 testes falhos em 72 |

O atraso que inclui o bloco 0 não reproduz a falha: sem o bloco 0 o cabeçalho não confere e a resposta fica incompleta. A falha precisa do bloco 0 antes do post, como na segunda linha.

## Comandos

```sh
npx standard packages/core/test/seeder-group-trending.test.js
node packages/core/test/seeder-group-trending.test.js
```

A suíte inteira roda no GitHub CI (Node 20 e 24).
