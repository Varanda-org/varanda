# Imagens de grupos públicos e comunidades

## Escopo do P3

O registro lateral `group-image` define, troca ou remove a imagem sem mudar o cabeçalho, `group-meta`, a ordem causal ou `last`. O fold de grupos e comunidades aplica os cortes e a autoridade da raiz; a reparação da comunidade pelo escritor do criador segue a mesma autorização dos metadados. Imagens são JPEG de 512 × 512, até 256 KiB e oito blocos. Grupos privados não aceitam imagem.

Os RPCs `group.image` e `community.image` verificam o descritor e a mídia do criador. `image` e `imageAuthor` aparecem nas respostas de info e nas linhas de listas, inclusive no catálogo da comunidade. Ambos ficam nulos sem imagem ou sem raiz disponível; uma raiz já disponível conserva os campos quando apenas o papel é `pending`. `rootHere` identifica a raiz criada neste aparelho e `rootAuthority` informa a autoridade da raiz da comunidade. A vitrine fornece esses campos e imagens de exemplo, com definição, troca e remoção nas projeções.

O índice do semeador lê `group-image` nas raízes públicas. `groupImagePublic` retorna o descritor e o diário autor somente para uma raiz pública disponível, vinculada e com leitura concluída. A entrega dos bytes usa a rota existente `/media/<D>/<K>/<start>/<blocks>`, com o diário de `imageAuthor`, sem uma nova rota neste diff. Instalar o semeador atualizado antes do app.

`GrupoAjustes` e `ComunidadeInfo` usam o editor compartilhado, recorte quadrado, JPEG forçado e `node.media.upload`. Remover envia `image: null`. A edição depende do papel de criador, da autoridade local e da capacidade de upload. As imagens aparecem nos avatares das listas, nos cabeçalhos e na caixa de comunidades. Fechar a tela ou perder o papel durante o upload impede a gravação posterior; uma resposta incerta exige leitura de confirmação, sem reenvio automático.

Termos e Privacidade do app e do site, a versão de aceite no core e a seção LGPD de `docs/design.md` descrevem a imagem como pública, armazenada na mídia do criador e nos semeadores. Trocar ou remover deixa de exibir a anterior, mas não apaga os bytes nem cópias já obtidas.

Limitação conhecida: no app nativo, o JPEG forçado transforma pixels transparentes em preto. O manipulador nativo não compõe a imagem sobre branco.

## Testes automatizados por área

Os arquivos abaixo cobrem o P3; a lista de cobertura não afirma execução neste ciclo.

| Área | Arquivos |
| --- | --- |
| Validação, fold e compatibilidade | `packages/core/test/group.test.js`, `community-fold.test.js`, `group-private.test.js`, `group-seen.test.js` |
| Operações e sessão do core | `packages/core/test/group-member.test.js`, `group-member-4.test.js`, `community-member.test.js`, `session-groups.test.js` |
| Índice e semeador | `packages/core/test/group-index.test.js`, `seeder-groups.test.js`, `seeder-communities.test.js` |
| Rota de mídia existente | `apps/cli/test/seed-ws.test.js` |
| Contrato RPC | `packages/rpc/test/methods.test.js` e os demais arquivos de `packages/rpc/test/` |
| Nó web | `packages/web-member/test/group-ops.test.js`, `community-ops.test.js`, `private-ops.test.js`, `session-groups.test.js`, `group-seen.test.js`, `devices-e2e.test.js` |
| Editor, codificação e projeções do app | `apps/app/test/groupImage.test.js`, `group-flow.test.js`, `mediaAvatar.test.js`, `avatarParity.test.js`, `conversas.test.js`, `communitiesBox.test.js`, `comunidadesRow.test.js` |
| Vitrine | `apps/app/test/vitrine.test.js`, `vitrineLarge.test.js`, `vitrineIndex.test.js`, `vitrineGuard.test.js`, `vitrineFeira.test.js` |
| Termos e Privacidade | `apps/app/test/legal.test.js`, `terms-version.test.js`, `apps/site/test/legal.test.js`, `packages/core/test/terms.test.js` |

A regressão `vitrine creators can edit community and public group images` cria uma comunidade e um grupo público e verifica `canEdit` com upload disponível. Sem os novos campos nas respostas, os controles não são autorizados e o teste falha.

A regressão `group-image tail at a root cut matches the real HEAD reader` carrega o código real de `git show HEAD:packages/core/lib/group.js` e compara o estado completo, retirando somente os campos de imagem. O caso tem publicação em seq 1, imagem em seq 2 e corte 3. P3 retira a raiz de `authorityWriters`, pois seu próximo bloco é o corte; HEAD a mantém, pois ignora a imagem ao calcular esse bloco. A igualdade falha. Preservar a correção de `lastCoreSeq` e exigir igualdade desse campo com esse HEAD são requisitos incompatíveis; a decisão de compatibilidade está pendente. A proteção de cortes e reentradas foi preservada.

## Execução deste ciclo

Execução direta com `node <arquivo>`, sem `npm test` nem instalação. Foram selecionados os testes do core que importam `lib/group` ou `helpers/groups`, mais `group-seen.test.js`, todos os `vitrine*.test.js`, `groupImage.test.js`, `group-flow.test.js` e todos os testes de RPC.

- Passaram os testes selecionados do core, exceto a comparação com HEAD e os casos de socket abaixo. `group-member-3.test.js` teve timeout de 30 segundos em `an own writer beyond the writer cap refuses to post, hide, moderate or leave` na execução paralela e passou isoladamente.
- Todos os testes selecionados do app passaram. A regressão de edição da vitrine foi executada antes da correção e falhou; passou após incluir os campos ausentes.
- `packages/rpc/test/dm-budget.test.js` e `link-card.test.js` falharam também isoladamente por comparar referências de cópias distintas dos módulos. O `@varanda/core` resolvido pelos links de dependências vinha de outra worktree. Ambos passaram com um carregador temporário que direciona `@varanda/core` e `@varanda/rpc` para esta cópia, sem mudar arquivos do projeto. Os demais testes de RPC passaram, exceto `leak.test.js`, cujo processo não encerrou após concluir as asserções: limite de 180 segundos na rodada e de 45 segundos na repetição isolada, também com as importações direcionadas para esta cópia.
- `npx --no-install standard` em `group.js`, `group.test.js`, `vitrine/request.js` e `vitrine.test.js`: saída vazia, código zero. `git diff --check`: saída vazia, código zero. Nenhuma linha nova contém U+2014.

Erro de socket `Error: operation not permitted`, `code: 'EPERM'`, reproduzido isoladamente nos seguintes arquivos de `packages/core/test/`: `seeder-communities.test.js`, `seeder-groups.test.js`, `seeder-groups-3.test.js`, `seeder-groups-cuts.test.js`, `seeder-groups-gone.test.js`, `seeder-groups-header-stubs.test.js`, `seeder-groups-waits.test.js`, `seeder-private.test.js`, `seeder-storage-budget.test.js`, `page-groups-core.test.js`, `store.test.js`, `sync-communities.test.js`, `sync-groups.test.js`, `sync-groups-2.test.js`, `sync-groups-3.test.js`, `sync-groups-4.test.js`, `sync-groups-5.test.js`, `sync-groups-6.test.js`, `sync-groups-7.test.js`, `sync-groups-8.test.js`, `sync-groups-9.test.js`, `sync-groups-sparse.test.js` e `sync-private.test.js`. O orquestrador precisa executá-los fora do sandbox.

Os testes do nó web, da rota HTTP, de outras projeções do app e dos textos legais listados na cobertura acima não foram executados neste ciclo.

## Conferência manual pendente, celular primeiro

Nenhum build ou sessão de conta foi iniciado neste ciclo. Roteiro ainda devido:

1. Android, build de debug: conferir recorte, texto, alvos de pelo menos 44 px e fechamento. Como criador, definir, trocar e remover a imagem de um grupo público e de uma comunidade. Outra conta deve vê-la após sincronizar, nas listas, cabeçalhos e caixa de comunidades. Conferir ausência do controle como membro, administrador e em grupo privado. Perder o papel ou fechar a tela durante o upload não pode gravar. Para uma passkey de produção, usar o APK de preview EAS, pois o debug não entra nessa instalação.
2. Simulador iOS: repetir o roteiro, incluindo cancelamento do recorte e fonte transparente para conferir a limitação do JPEG. A entrada com passkey depende do domínio associado da conta Apple Developer.
3. Depois dos dois nativos, web: repetir definição, troca, remoção, sincronização com outra conta, teclado e recorte.
4. PWA instalada: repetir o roteiro, incluindo fechamento da tela durante o upload.
5. Build anterior: listar e abrir o mesmo grupo público após definir, trocar e remover a imagem. Conferir nome, membros, publicações e ordem; incluir o caso com corte descrito acima, cuja divergência de autoridade continua pendente.

Instalação de dependências, suíte completa via npm, demo e builds não foram executados. Os testes deste ciclo não usam rede externa.
