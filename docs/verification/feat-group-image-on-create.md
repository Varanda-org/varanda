# Foto ao criar um grupo ou uma comunidade: verificação

## Testes executados

No Node.js 24, na cópia de trabalho local, com a DHT local dos testes:

- `npm run lint`: passou.
- `npm run demo`: terminou com `DEMO OK`.
- Os 526 arquivos de teste alcançados pelo diff contra `origin/main`, em quatro grupos paralelos: todos passaram (7955 testes, 137984 asserções).
- A suíte completa roda na CI do GitHub.

Arquivos de teste da mudança, com as contagens locais:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/groupImageCreate.test.js` | 6 | 103 |
| `apps/app/test/group-flow.test.js` | 94 | 776 |
| `apps/app/test/comunidadesRow.test.js` | 37 | 362 |
| `apps/app/test/chatSurfaces.test.js` | 13 | 199 |
| `apps/app/test/platformGate.test.js` | 6 | 848 |
| `apps/app/test/mediaHash.test.js` | 7 | 38 |

O que os testes cobrem:

- Fluxo puro (`groupImageCreate.test.js`): sem foto ou sem chave devolvida, nada acontece; com chave, um envio e depois um `group.image` ou `community.image` com a chave criada; grupo privado envia cifrado, pela visibilidade enviada; descritor inválido ou cifragem trocada não chega ao método; falha e incerteza nunca rejeitam nem repetem; tipo ou visibilidade desconhecidos falham antes do envio.
- Novo grupo (`group-flow.test.js`): grupo público e privado com foto mandam `group.create`, o envio e `group.image` uma vez cada, com os parâmetros de criação de sempre; criação com falha, incerta ou conferida pelo nome não envia a foto; falha da foto mantém o grupo e o aviso na comunidade; a linha de foto depende da capacidade de envio, tem alvo de 44 px e é opcional; cancelar ou fechar descarta o recorte; seletor ou recorte que termina depois de fechar é ignorado; recorte malformado ou fora de JPEG é recusado antes de criar; um envio que termina depois de a folha sair da tela não grava a foto.
- Nova comunidade (`comunidadesRow.test.js`): os mesmos casos para `community.create` e `community.image`; fechar e reabrir a folha com seleção, recorte ou criação pendentes da abertura anterior não muda a nova abertura nem envia nada.
- Nas duas folhas: o editor de recorte ocupa o lugar do formulário, o corpo da folha rola, e a folha não fecha por toque fora, arrasto ou gesto do iOS durante a criação e a foto.
- Telas que abrem as folhas (`Comunidade`, `Comunidades`, `Conversas`): depois de uma foto que falhou, o aviso aparece com o botão para abrir o grupo ou a comunidade; o botão abre e limpa o aviso; reabrir a folha também limpa. Sem falha, a navegação é a de antes.
- `chatSurfaces.test.js`: as ações dos estados vazios que abrem as folhas também limpam o aviso.
- `platformGate.test.js` e `mediaHash.test.js`: nenhuma API só do navegador nas telas compartilhadas e as leituras de mídia seguem as regras de antes.

## Conferência das regressões

Cada correção foi retirada uma vez e os testes correspondentes falharam:

- Sem a chamada a `imageAfterCreate` em `NovoGrupo`, os fluxos público e privado, o aviso de falha e a trava durante o envio falham.
- Sem o editor no lugar do formulário e sem `dismissable` ligado ao pedido em andamento, os quatro testes de código-fonte das duas folhas falham.
- Sem a sessão por abertura em `Nova comunidade`, os testes de reabrir com trabalho pendente falham.
- Sem a checagem da sessão antes de gravar a foto, os testes de envio que termina depois de fechar falham nas duas folhas.
- Sem o botão e a limpeza do aviso, os testes dos três chamadores falham.
- Com o corpo da folha num `View` em vez de `ScrollView`, os dois testes do editor falham.

## Verificações em dispositivos, não executadas

Não conferido em Android, iOS nem na web. Roteiro, primeiro no build de debug do Android e no simulador iOS (inclusive numa tela pequena, como 375 × 667), depois na web e no PWA:

1. Em **Comunidades**, abrir **Nova comunidade**, escolher uma foto, ajustar o recorte e tocar em **Usar foto**: o botão fica alcançável rolando a folha. Criar: a comunidade abre com a foto. O grupo Geral não copia a foto.
2. Dentro da comunidade, abrir **Novo grupo**: o alvo **Escolher foto** tem pelo menos 44 px, a foto é opcional, cancelar e fechar descartam o recorte e reabrir começa sem foto. Criar sem foto continua funcionando.
3. Criar um grupo público com foto e conferir a foto na lista e nos ajustes. Num grupo novo, trocar para **Privada** antes de criar: o aviso diz que só participantes veem a foto, e a foto aparece para participantes.
4. Com a gravação da foto falhando (por exemplo, sem rede depois da criação): o grupo ou a comunidade fica criado, a tela de origem mostra que a foto não foi salva e oferece abrir; abrir limpa o aviso, e a foto pode ser posta nos ajustes.
5. Durante a criação e a foto, tocar fora, arrastar a folha para baixo e, no iOS, fazer o gesto de fechar: a folha continua aberta. Toques rápidos em **Criar** e em **Usar foto** fazem uma só criação e no máximo uma gravação de foto.
6. Sem nó hospedado ou sem envio de mídia, a linha de foto não aparece.
