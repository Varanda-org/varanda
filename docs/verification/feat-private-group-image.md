# Foto de grupo privado: verificação

## Testes executados

No Node.js 24, na cópia de trabalho local, com a DHT local dos testes:

- `npm run lint`: passou.
- `npm run demo`: terminou com `DEMO OK`.
- Os 333 arquivos de teste alcançados pelo diff contra `origin/main`, em quatro grupos paralelos: 331 passaram. `apps/app/test/comunidadesRow.test.js` e `apps/app/test/gruposSnapshot.test.js` conferem o texto das telas e ainda esperavam as linhas antigas (`pictureProps` sem `visibility` e o snapshot sem `rowsForStorage`); as expectativas foram atualizadas e os dois passam (2 testes e 14 asserções; 13 testes e 68 asserções).
- `packages/core/test/sync-groups-2.test.js` falha às vezes no caso 8 sob carga, também na `main`; aqui passou no grupo e sozinho três vezes (31 testes, 122 asserções).
- A suíte completa roda na CI do GitHub.

Arquivos de teste da mudança, com as contagens locais:

| Arquivo | Testes | Asserções |
| --- | --- | --- |
| `packages/core/test/group.test.js` | 163 | 1371 |
| `packages/core/test/group-private.test.js` | 136 | 1011 |
| `packages/core/test/group-member.test.js` | 17 | 178 |
| `packages/core/test/seeder-groups.test.js` | 66 | 479 |
| `packages/core/test/terms.test.js` | 8 | 126 |
| `packages/rpc/test/methods.test.js` | 176 | 8336 |
| `packages/web-member/test/private-ops.test.js` | 29 | 315 |
| `packages/web-member/test/group-ops.test.js` | 66 | 525 |
| `apps/cli/test/seed-ws-link.test.js` | 9 | 372 |
| `apps/app/test/mediaAvatar.test.js` | 22 | 463 |
| `apps/app/test/groupImage.test.js` | 6 | 226 |
| `apps/app/test/group-flow.test.js` | 82 | 659 |
| `apps/app/test/conversas.test.js` | 45 | 294 |
| `apps/app/test/vitrine.test.js` | 66 | 4804 |
| `apps/app/test/legal.test.js` | 76 | 2460 |
| `apps/site/test/legal.test.js` | 7 | 115 |

O que eles cobrem: o fold antigo e o novo concordam em membros, publicações, nome, ordem e `last`, também quando o envelope da foto é o mais novo; o item aberto nunca entra nos registros causais; descritor público dentro do selo e item privado em registro aberto são recusados; o construtor `groupImage({ sealed: true })` monta o interno. No nó do navegador e no nó core, `group.info`, `group.list` e as linhas de `community.info` só mostram a foto de um grupo privado enquanto o nó lê o grupo (bloqueado ou com troca de chave pendente: `null`). O semeador nunca abre a foto. No app, o editor só envia com `sealed: true` num grupo privado, uma resposta incerta leva a uma só releitura, linhas salvas não guardam o item privado e o avatar tenta de novo, poucas vezes, uma leitura que pode passar.

## Conferência das regressões

No editor do app (tarefa N14), cada retirada temporária foi restaurada, sem alterar os arquivos das tarefas anteriores. Os comandos foram executados por arquivo, isoladamente:

- Sem `sealed: true` no upload do editor, `group-flow.test.js` saiu com código 1: falharam a imagem confirmada, o autor e o controle de troca no grupo privado. A execução terminou ao tentar acessar o controle de remoção ausente, sem contagem final.
- Devolvendo as linhas originais no lugar da forma limpa para armazenamento, `conversas.test.js` saiu com código 1: 44 de 45 testes e 285 de 294 asserções passaram. O teste novo detectou os campos privados salvos.
- Sem o tratamento específico do texto de rekey, `group-flow.test.js` saiu com código 1: 81 de 82 testes e 657 de 659 asserções passaram. Definir e remover mostraram o texto genérico em vez de `aguardando nova chave`.

Depois de restaurar as correções, os quatro arquivos de teste e o lint passaram com as contagens da tabela.

## Verificações em dispositivos, não executadas

Não foram executados build Android, simulador iOS, interface web/PWA, cliente antigo nem inspeção da rota de mídia de um semeador real. A suíte completa roda na CI do GitHub.

Executar na ordem abaixo, usando uma instalação de teste e contas de teste, sem DHT pública:

1. **Android, build de debug:** abrir Ajustes de um grupo privado como criador, escolher uma foto, recortar, salvar, trocar e remover. Conferir os dois avisos sobre participantes e permanência dos dados cifrados. Conferir a foto no cabeçalho do grupo, nas linhas de Comunidade e em Conversas. Um segundo membro deve ver as alterações e não deve ter o controle. O build de debug não entra por passkey numa instalação de produção; usar ambiente compatível e registrar qualquer impedimento de autenticação.
2. **Simulador iOS:** repetir o fluxo completo com criador e segundo membro. Conferir recorte, alvos de toque, cabeçalho e listas. Registrar se o domínio associado da conta Apple Developer impedir a entrada.
3. **Web e PWA:** repetir o mesmo fluxo depois das verificações móveis, incluindo recarregar e bloquear a sessão. Conferir que listas e snapshots persistidos não contêm o item privado nem sua chave; após bloquear, a foto privada deixa de aparecer, e volta somente após desbloqueio e leitura autorizada.

Em cada plataforma, conferir também:

- Um build anterior a esta mudança mostra exatamente uma `mensagem cifrada` adicional por alteração da foto, inclusive troca e remoção, e nada mais relativo à foto: nenhum descritor, chave, legenda ou imagem expostos.
- Na rota `/media` do semeador de teste, os blocos da foto contêm apenas dados cifrados, sem assinatura JPEG `ff d8 ff`. O membro autorizado abre a foto pelo leitor privado. Não há cópia pública criada antes do upload cifrado.
- Bloquear durante a leitura e durante o envio não deixa a foto visível nem dispara reenvio. Ao desbloquear, conferir o estado por leitura, sem repetir uma escrita incerta.
- Com rekey pendente, definir ou remover mostra `aguardando nova chave` e não faz outro pedido. Depois de obter a nova chave, uma nova ação explícita do criador funciona e o segundo membro vê a foto. Uma resposta incerta provoca só um `group.info`, sem repetir `group.image` ou o upload.
- Busca, catálogo e prévia de link não mostram a foto privada. Trocar ou remover deixa de mostrá-la, mas não apaga os dados cifrados já enviados.
