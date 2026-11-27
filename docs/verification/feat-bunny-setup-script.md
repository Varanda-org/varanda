# Script de configuração do Bunny

Branch `feat/bunny-setup-script`. `scripts/bunny.js` faz pela API do Bunny os passos 1 a 6 e 8 de `docs/cdn.md`, seção "Bunny": zona, ajustes, hostname, as três Edge Rules, registros e purga, além do certificado (`cert`) depois do DNS. O mantenedor roda; a chave e o segredo nunca aparecem na saída.

## Conferido

- `node apps/cli/test/bunny.test.js` (19 testes, 569 asserções) contra um Bunny falso em `127.0.0.1`, com o script rodando como processo filho e uma chave e um segredo aleatórios:
  - `plan` numa conta vazia lista cada mudança e não faz nenhum pedido que não seja `GET`;
  - `apply` cria a zona (o 201 sem corpo, depois a busca por nome), grava as três regras (a de bloqueio primeiro) antes dos ajustes que ligam a origem, depois o hostname, lê a zona de novo e confere; um segundo `apply` não escreve nada, e `plan` diz "Nada a mudar." e "segredo: igual";
  - `status` sem `--hostname` diz "padrão não conferido" nas regras de bloqueio e de cache, em vez de só "ok";
  - numa zona que já existe, regras ou ajustes que mudam levam a uma limpeza do cache da zona inteira (`purgeCache`), depois das escritas; troca só do segredo não limpa, e um segundo `apply` também não; uma limpeza que falha, ou uma parada antes dela (aqui, o hostname que falha), diz para rodar `apply --purge`, que limpa sem escrever mais nada; o `apply` seguinte sem `--purge` só adiciona o hostname, por isso o aviso; `--purge` fora do `apply` é recusado;
  - Perma-Cache, edge script ou middleware ligados na zona param `plan` e `apply` com zero escritas, e `status` os lista; um id 0 conta como desligado;
  - uma regra `varanda:` com um segredo antigo é atualizada pelo `Guid` dela, `plan` diz "segredo: muda" sem mostrar nenhum dos dois valores, e uma regra de fora é listada pela descrição e mantida;
  - duas regras com a mesma descrição param o script com zero escritas;
  - um ajuste que o Bunny falso descarta faz a conferência falhar (saída 1) com o nome do campo;
  - um 400 cuja `Message` traz a chave e o segredo sai com `***` nos dois lugares, sem nova tentativa, e avisa que o estado pode ter ficado pela metade; com o segredo cruzando o corte de uma mensagem longa, nem o começo dele aparece (a máscara vem antes do corte);
  - uma resposta 2xx cortada no meio do corpo é erro, não sucesso;
  - uma lista de zonas num formato inesperado é erro, não "zona ausente": nenhuma zona é criada;
  - chave errada dá 401 e para; sem chave e sem terminal, saída 1; `--api-key=` é recusado;
  - `VARANDA_BUNNY_API` diferente de `http://127.0.0.1:<porta>` (`http://example.com`, `http://127.0.0.1.evil:1`, `https://127.0.0.1:1/x` e outros) é recusado antes de qualquer pedido;
  - segredo fora do formato (maiúsculas, tamanho errado, aspas) é recusado sem ser impresso;
  - `purge` recusa `/seeder`, `..`, `//`, `?`, `#`, `%`, `\`, espaço e `*` no meio, sem nenhum pedido, e aceita `/media/a/b` e `/media/a/*`, um pedido por caminho;
  - `cert` (função exportada, resolvedor falso) não faz pedido nenhum quando o CNAME falta ou aponta para outro lugar; com o CNAME certo, recusa sem escrever quando as regras faltam ou são de outro hostname, e pede o certificado e depois o ForceSSL quando as três regras estão lá;
  - em todo caso, stdout e stderr nunca contêm a chave nem o segredo, o cabeçalho `AccessKey` é a chave em todo pedido e a chave nunca está numa URL;
  - funções puras: a leitura do `.env` (comentário, CRLF, última linha vale, espaços, forma `export` ignorada) e o diff de ajustes e de regras. A leitura do `.env` deu o mesmo resultado que o pipeline de `deploy.sh` num arquivo com CRLF, espaços e comentário.
- Falha sem a mudança, uma mutação de cada vez, com o arquivo restaurado depois (conferido com `cmp`):
  - sem a máscara (`redact` sem a troca por `***`): falharam "an error whose message carries the key and the secret prints neither" e "input checks";
  - com a guarda de `VARANDA_BUNNY_API` afrouxada para qualquer `http(s)://127.0.0.1` com porta ou caminho: falharam "VARANDA_BUNNY_API other than http://127.0.0.1:<port> is refused before any request" e "input checks". A guarda não foi removida de todo nessa conferência porque o teste mandaria pedidos a `example.com`, e os testes não usam rede externa;
  - ajustes gravados antes das regras: falhou "the rules go in before the origin is set"; regra de bloqueio fora da primeira posição: falhou "apply sets up the zone";
  - corte antes da máscara: falhou "an error whose message carries the key and the secret prints neither";
  - corpo cortado tratado como sucesso: falhou "a response cut off after a 2xx status is an error";
  - sem `purgeCache`: falhou "the purge comes after the rules"; `apply --purge` sem forçar a limpeza: falhou "--purge purges and writes nothing else"; sem o aviso de limpeza falha: falhou "a failed purge says how to finish it";
  - `apply` sem a recusa de Perma-Cache e scripts: falhou "Perma-Cache or a script on the zone stops plan and apply";
  - `status` sem o aviso de padrão: falhou "apply sets up the zone";
  - sem o aviso de limpeza pendente numa parada antes dela: falharam "a failed purge says how to finish it" e "a stop before the purge says --purge";
  - `cert` sem conferir as regras: falhou "cert needs the CNAME on the zone".
- `npx standard scripts/bunny.js apps/cli/test/bunny.test.js`.

## Não conferido

- Nenhuma conta real do Bunny. O primeiro uso deve ser `plan`, depois `apply` numa zona descartável (`--name varanda-media-test`) conferida no painel, antes da zona de verdade.
- A especificação do Bunny não diz o que `ActionParameter1` e `ActionParameter2` significam para cada tipo de ação. Nome e valor do cabeçalho, e os segundos do cache, seguem os exemplos do Bunny; a conferência depois do `apply` e um olhar no painel é que confirmam.
- Se o Bunny exige `OriginUrl` já na criação da zona (o script manda só `Name`, como a especificação), o `apply` para com o erro dele e pode rodar de novo.
- A pergunta da chave sem eco, num terminal de verdade, não roda nos testes.
- Se a regra de cache de 60 s vale também para respostas de erro e para pedidos com `?` (com `IgnoreQueryStrings` ligado, `/media/x?y` divide a entrada de `/media/x`). Na zona descartável, `/media/<item>?x`, um 404 e um 429 nunca devem sair do cache; se saírem, a regra de cache precisa de um gatilho de status 200. O efeito seria o CDN ignorado por até 60 s para um item, sem bytes errados.
- Ásia e África ficam desligadas (`EnableGeoZoneASIA` e `EnableGeoZoneAF`). A especificação diz só que o campo liga "a entrega" daquela região; não está conferido se quem está lá é atendido por outra região ou recusado. Na recusa, o app cai na instalação.
- `CacheControlMaxAgeOverride` da zona fica como o Bunny cria; o limite de 60 s depende da regra de cache e do `s-maxage` da origem.
