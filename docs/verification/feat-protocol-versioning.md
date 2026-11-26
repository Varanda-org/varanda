# Verificação: política de versionamento do protocolo (#18)

Branch `feat/protocol-versioning`. A política normativa está na seção 18 do `docs/protocol.md` (regras V1 a V10, tabela por tipo e quebras conhecidas).

## Critérios de aceite

1. **Um leitor v1 pula um registro v2 e mantém o diário.**
   - `node packages/core/test/compat.test.js`: roda os validadores antigos de verdade, copiados byte a byte e presos por sha256 em `packages/core/test/fixtures/old-readers/` (`records.js` em `396d0a9ba`, antes do #115, e em `597705ee1`, antes do #218, do #241 e do #332). Sobre diários escritos com o código atual (perfil com foto, post com mídia, follow, like, `group-join`, `delete`, `page-*`), o leitor antigo pula cada registro que não conhece como `malformed`, no próprio seq, sem renumerar, e mantém o diário. O leitor anterior ao #218 ainda mostra o post apagado (resíduo documentado em V4).
   - O leitor atual, diante de um escritor futuro (tipo desconhecido, chave a mais em post, perfil e `delete`, `v` num post), pula cada bloco como `malformed`, mostra só os posts conhecidos e o `delete` com chave a mais não apaga nada.
   - `node packages/core/test/versioning-gate.test.js`, caso de ponta a ponta: semeador real e seguidor com `runSync --once` sobre um diário com esses blocos futuros. O seguidor baixa o diário inteiro, `log.read` lista os blocos futuros como inválidos nos seqs exatos e o feed mostra só os posts conhecidos.
2. **Um leitor incompatível com o certificado recebe recusa explícita.**
   - Um leitor de antes do #115 não pode ser alterado (quebra conhecida, seção 18). Daqui em diante, um certificado de membro com `v` inteiro acima de `CERT_VERSION_MAX` (2) recebe o motivo `unsupported-cert-version` em `validateCertShape`, `verifyCert`, `certForKey`, `validateRecord` (bloco 0), no portão do bloco 0 do semeador, do nó core e do nó do navegador, no `rejected` e no `skipped` do feed e da sincronização. O resto do tratamento não muda (não guarda, não serve, apaga a réplica, resultado não compartilhado).
   - `node packages/core/test/cert.test.js`, `node packages/core/test/records.test.js` (tabela com cert.js e records.js concordando em cada linha), `node packages/core/test/versioning-gate.test.js` (anúncio v3, bloco 0 v3, anúncio v3 forjado para uma chave já servida não derruba nada, seguidor, `rejected` de um par membro ignorado, feed) e `node packages/web-member/test/sync-gate.test.js`.
3. **Migração interrompida retoma sem perder identidade nem renumerar.**
   - `node packages/core/test/data-format.test.js`: queda em três pontos de um passo (logo depois da intenção, no meio, antes do commit). Depois da queda, `format.json` fica `{ v: 1, format: 1, migrating: 2 }`, a trava é liberada, a próxima abertura conclui, e a chave do diário, o comprimento e cada bloco bruto ficam idênticos. Uma versão anterior recusa o diretório migrado ou meio migrado (`DATA_FORMAT_NEWER`) sem tocar em nada. O contexto do passo recusa `store/`, `quarantine`, `format.json` (também com outra caixa), arquivos com ponto, nomes de arquivos de chave e de certificado (`seeder-key.json`, `dm-seed.json`, `passkeys.json`, `recovery.json`, `issuer-cert.json` e afins), e só lê arquivos regulares.

## Prova de regressão

Com a mudança de cada biblioteca desfeita à mão, os testes novos falham: `cert.test.js` e `records.test.js` (motivo volta a `malformed`), `data-format.test.js` (sem intenção e commit a retomada falha), `versioning-gate.test.js` e `sync-gate.test.js` (motivo volta a `not-in-log`).

## Comandos rodados

`npm run lint`, os arquivos de teste acima um a um com `node <arquivo>`, também `store.test.js`, `worklet-lock.test.js`, `bare-fs.test.js`, `bare-load.test.js` (no Bare), `seeder.test.js`, `sync.test.js`, `sync-groups-2..4.test.js`, `peek.test.js`, `web-member/test/seeder-link.test.js`, `apps/cli/test/readme-help.test.js`, `apps/cli/test/account-e2e.test.js`, e `npm run demo`. A suíte inteira roda na CI do GitHub.

## Limites e pendências

- Não há nada para conferir em aparelho: nenhuma tela muda.
- Reemissão de certificados depois de revogar um emissor e certificados v1 de piloto continuam fora (V5 fixa a forma: um tipo de registro novo, nunca reescrever o bloco 0).
- Nenhuma capacidade nova para certificado v2 ou `delete`: nós de antes dela já suportam os dois e não dariam para distinguir (V6).
- Os erros `DATA_FORMAT_*` chegam ao app como `INTERNAL` pela sessão; um código próprio entra junto com o primeiro passo de migração real.
- O nó do navegador não tem `format.json`; o `session-store.js` reabre um banco mais novo sem versão, e o primeiro upgrade desse banco precisa mudar isso (V10).
