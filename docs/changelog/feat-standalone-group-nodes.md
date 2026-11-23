### Adicionado

- Grupos sem comunidade no RPC (PR `feat/standalone-group-nodes`): `group.create` sem `community` cria um grupo avulso, que qualquer membro pode criar (limite de 64 grupos por diário); `group.join` aceita `standalone: true` para entrar num grupo avulso cuja raiz ainda não chegou; o método de leitura `group.standalone` (5.176) lista os grupos avulsos no formato das linhas de grupo de `community.info`. Verificação em `docs/verification/feat-standalone-group-nodes.md`.
- CLI: `group create` sem `--community` cria um grupo sem comunidade, e `group join <chave> --standalone` entra num grupo sem comunidade que ainda não chegou (`--standalone` junto com `--community`, ou fora de `group join`, é recusado). `group info` mostra `comunidade: nenhuma` para um grupo sem comunidade.
- Páginas: uma Página não cria, não entra e não lê grupo sem comunidade (o serviço de conta responde `indisponivel` antes de qualquer escrita); só a saída funciona.

### Alterado

- `community.info`, `community.list` e `community.join`: uma linha do catálogo cuja raiz o aparelho já tem e cujo cabeçalho não nomeia a comunidade (um grupo sem comunidade ou de outra comunidade) sai da lista de grupos; se for o Geral, `general` passa a `null`, e o passo do Geral de `community.join` não escreve nada e responde `group: null` (a entrada na comunidade continua valendo). Uma raiz que ainda não chegou continua listada.

### Corrigido

- Grupos: um aparelho cuja entrada pendente num grupo nomeava o membro errado (por exemplo, um catálogo de comunidade que aponta como Geral o grupo de outra comunidade) não fica mais preso em `limite do grupo atingido` quando a pessoa já participa por outro aparelho; `group.join` troca o escritor desse aparelho por um que nomeia o membro certo.
