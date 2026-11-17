# feat/diary-signer-proof

Parte de #352: a prova do canal de selos (`varanda/dm-stamp/1`) passa a servir também ao diário de um nó core (Hypercore 11). A chave desse diário é o hash do manifesto de um assinante, não a chave pública dele, então a prova v1 (assinada "pela chave do diário") nunca podia valer e o pedido de selos de um nó core falhava. Nada no app nem na sessão do navegador usa a prova v2 ainda: um PR seguinte liga os nós core. Sem mudança no RPC (`docs/rpc.md` intacto) nem nos Termos.

## O que mudou

- `packages/core/lib/diary-signer.js` (novo, sem hypercore nem corestore, só b4a, compact-encoding e sodium-universal): `diaryKeyOfSigner(signer)` reproduz `Hypercore.key(Verifier.defaultSignerManifest(signer))`, o BLAKE2b-256 da constante `MANIFEST` do Hypercore (entrada 3 de `namespace('hypercore', 6)`) seguida do manifesto padrão de um assinante codificado como em `lib/messages.js`; `isDiaryOfSigner(keyHex, signerHex)` nunca lança e é falso quando a chave é o próprio assinante.
- `packages/core/lib/dm-stamp-net.js`: prova v2 `{ type: 'proof', key, sig, signer }` sobre `'varanda-dm-stamp-v2' LF nonce LF Noise LF key LF signer`. O semeador aceita só quando `diaryKeyOfSigner(signer)` é `key` e a assinatura confere com `signer`; recusa `signer === key`. A cota e todo o resto continuam pela chave do diário (`key`). Uma prova por canal, e a recusada conta como mensagem ruim, como na v1. A v1 de três chaves continua igual, byte a byte. O membro manda v2 só com `ownSigner`, e recusa na criação um `ownSigner` que não é o assinante de `ownKey`.
- `packages/web-member/lib/dm-link.js`: `openStampLink` aceita `diary` (hex64) opcional; com ele, `ownKey` é o diário e a prova é v2. Um `diary` que o par de chaves não assina é recusado antes de conectar (`diário inválido`).
- `docs/protocol.md`: seção 1 (como um verificador chega do assinante à chave do diário) e "Stamp channel" (prova v2, regra do semeador, chave da cota, implantação).

## Testes

- `packages/core/test/diary-signer.test.js` (novo, 6 testes, 39 asserções): vetor fixo; 256 assinantes aleatórios iguais ao Hypercore 11.40.4; três diários reais do Corestore 7.15.0 (`store.get({ name: 'diary' })`, chave do diário diferente da chave pública do assinante); 64 assinantes iguais ao Hypercore 10.38.2 do `web-member`; entradas ruins lançam `TypeError`; `isDiaryOfSigner` nunca lança.
- `packages/core/test/browser-safe.test.js`: `diary-signer.js` carrega sem hypercore, corestore, `fs` nem `crypto` (15 testes, 164 asserções).
- `packages/core/test/dm-stamp-net.test.js`: de 26 testes e 165 asserções para 34 e 240. Novos: bytes da v1 iguais a um vetor fixo e mensagem de três chaves sem `ownSigner`; payload v2 e mensagem de quatro chaves; `verifyProofV2` nunca lança; diário real do Corestore prova com v2 e recebe selos contados na chave do diário; recusas (assinante errado, assinante de outro diário, `signer === key`, assinatura v1 com quatro chaves, campos v2 com o prefixo v1, assinatura v2 com três chaves, prova de outra chave Noise, `signer` malformado, e a prova v1 de um diário de manifesto, que é por que o core não conseguia selos); uma prova recusada é a única do canal; formatos da mensagem; `ownSigner` inválido no membro.
- `packages/web-member/test/dm-link.test.js`: de 6 testes e 37 asserções para 8 e 45. `openStampLink` com `diary` recebe selos contados no diário; `diary` que o par não assina, igual ao assinante ou malformado é recusado sem nenhuma prova.

## Falha sem a correção

Com a escolha da v2 tirada do semeador (só `verifyProof`, a validação de quatro chaves mantida), `node packages/core/test/dm-stamp-net.test.js` para em "a core diary proves with v2 and gets stamps charged to the diary" depois de `ok 1`: o semeador recusa a prova e o pedido de chave termina em `Error: dm stamp request timed out` (`dm-stamp-net.js`, `startRequest`). O arquivo foi restaurado e voltou a passar (34 de 34).

## Comandos

```sh
node packages/core/test/diary-signer.test.js
node packages/core/test/dm-stamp-net.test.js
node packages/core/test/browser-safe.test.js
node packages/web-member/test/dm-link.test.js
npm test -w packages/core
npm test -w packages/web-member
npx standard packages/core/lib/diary-signer.js packages/core/lib/dm-stamp-net.js packages/web-member/lib/dm-link.js
```

Resultado: `npm test -w packages/core` com 173 arquivos e 0 falhas (2878 testes, 43731 asserções); `npm test -w packages/web-member` com 127 arquivos e 0 falhas (1565 testes, 14729 asserções), incluindo o build do bundle do navegador com `diary-signer.js` dentro; `standard` sem apontamentos nos arquivos alterados. `npm run demo` não rodou.

## Nota para o operador

Implante o semeador antes. Um semeador anterior a esta mudança trata a prova de quatro chaves como mensagem ruim: o pedido de selos do membro fica sem resposta, expira, o link fecha e a recarga é tentada de novo no horário de sempre (60 s depois de uma falha). Os diários do navegador continuam com a v1 e não percebem nada.

## O que não foi conferido

- Nenhum nó core pede selos ainda (um PR seguinte passa `ownSigner` / `diary`), então não houve teste com semeador real em produção nem em aparelho.
- Nenhuma tela mudou.
