# Abertura de grupos fora da lista do aparelho

## Tela de grupo

- O teste do título cobre a prioridade do nome do nó, o nome do índice e os rótulos para visibilidade pública, privada e desconhecida. Em modo Página, o rótulo de privacidade continua dependendo da leitura do nó.
- Os testes da busca cobrem o indicador de carregamento, o aviso e o botão “Tentar de novo” para um grupo desconhecido. Um grupo pendente que o nó já carregou continua visível, com o aviso de sincronização. Os testes também cobrem a preservação do último resultado e o descarte de respostas atrasadas.
- `group-flow.test.js` verifica o caminho de entrada pela comunidade. O índice fornece os rótulos, enquanto o nó informa a função da pessoa na comunidade e a visibilidade para publicação.

| Comando | Testes | Asserções |
|---|---:|---:|
| `node apps/app/test/groupScreen.test.js` | 34/34 | 253/253 |
| `node apps/app/test/group-flow.test.js` | 94/94 | 776/776 |
| `node apps/app/test/groups.test.js` | 38/38 | 578/578 |
| `node apps/app/test/chatSurfaces.test.js` | 13/13 | 199/199 |

Ao reverter individualmente a condição do aviso, a condição do botão, o botão ou o indicador de carregamento, o teste correspondente falhou.

## Lista da comunidade

`communityRows.test.js` verifica a prioridade do nome, o rótulo “Grupo” e a ausência de rótulos de visibilidade quando ela é desconhecida. Também verifica que a tela busca nomes no índice sem trocar a lista local e que o detalhe das linhas do índice só diz “grupo privado” quando a visibilidade é privada.

| Comando | Testes | Asserções |
|---|---:|---:|
| `node apps/app/test/communityRows.test.js` | 6/6 | 40/40 |
| `node apps/cli/test/changelog.test.js` | 9/9 | 42/42 |

Ao reverter individualmente o uso da sugestão do índice, a condição que dispara a busca ou o detalhe das linhas do índice, o teste correspondente falhou.

Ficou pendente a conferência visual em Android, iOS, web e PWA.
