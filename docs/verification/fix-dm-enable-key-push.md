# Chave de mensagens que não subiu numa sessão anterior (branch fix/dm-enable-key-push, parte da #351)

A #351 junta as sobras das mensagens privadas. Este PR cuida do item do #326: uma chave de mensagens (`dm-key`) gravada numa sessão anterior cujo envio ao semeador falhou só subia quando a sincronização contínua rodava. Os outros itens vão em outros PRs (lista abaixo).

## Decisões da #351

Tomadas pelo mantenedor (Rodrigo) em 16/11/2026, antes da implementação:

| Item | Decisão |
|---|---|
| Cada aparelho baixa e testa o pool inteiro | Dividir o pool agora, em baldes que crescem com a rede: um balde enquanto o semeador serve menos de 1000 membros, depois 2, 4, 8 e assim por diante, para cada balde ficar com cerca de 500 membros; o app aceita no máximo 64 baldes. Builds antigos continuam baixando tudo. A pista de visitas (`'varanda/visit/1'`) também ganha baldes. O semeador é implantado antes do app. |
| Aparelho fora do ar por mais de 7 dias perde mensagens | O semeador guarda as mensagens por 14 dias. Todos os blobs também (fotos e áudios das conversas e a mídia dos momentos). Teto do pool de 20000 para 40000 envelopes; teto padrão dos blobs de 2 GiB para 4 GiB. Termos e Privacidade mudam. |
| Texto apagado continua no núcleo local | Liberar os blocos das mensagens apagadas 15 dias depois de guardadas (a retenção mais um dia, para uma cópia atrasada não voltar); as fotos guardadas dessas mensagens saem na hora. |
| Chave gravada numa sessão anterior que não subiu | O `dm.enable` envia de novo, também numa sessão nova (este PR). |
| Aparelho novo só recebe a janela do semeador | Copiar o histórico: começa à mão no aparelho antigo ("Copiar conversas para outro aparelho"), com o texto e as fotos guardadas, cifrado para a própria conta; todo aparelho da mesma passkey importa. O semeador dá uma cota extra de selos de blob para essa cópia, uma vez por semana. |

PRs: `fix/dm-enable-key-push` (este), `feat/dm-retention-14-days`, `feat/dm-local-compaction`, `feat/dm-pool-buckets` e `feat/dm-history-copy` (o último fecha a #351).

## O que muda

- `dmEnable` em `packages/web-member/lib/session.js`: antes de enviar uma `dm-key` recém-gravada, o nó guarda em kv `dmKey` o campo `push`, o comprimento do diário logo depois desse bloco. Uma rodada desta sessão que confirma que o semeador tem o comprimento local apaga o campo. Enquanto ele existe, também numa sessão nova, o `dm.enable` envia mesmo sem gravar nada (uma rodada única, como depois de qualquer escrita; com a sincronização contínua ligada ela não roda, porque a contínua já envia).
- `readDmKey` / `writeDmKey` em `packages/web-member/lib/node-store.js` leem e gravam o campo `push`. Um build anterior lê o mesmo `{ v: 1, gen }` e ignora o campo.
- Um semeador que nunca confirma (fora do ar, ou que recusa o diário) custa uma rodada por chamada de `dm.enable`, no máximo o tempo limite do envio (15 s), enquanto o campo existir. É o mesmo custo de qualquer escrita que não subiu na sessão.
- Nada é gravado nem assinado de novo: o envio leva o bloco que já existe, e só a chamada `dm.enable` do próprio cliente envia, nunca um temporizador. Não acrescenta repetição automática de pedido.
- `docs/rpc.md` 5.73 descreve o campo e o envio.

## Testes

Cada arquivo rodou sozinho (`node <arquivo>` em `packages/web-member`), Node v24.22.1.

| Arquivo | Branch | Sem a correção |
|---|---|---|
| `test/sync-gate.test.js` | 15/15, 126 asserções | sem a mudança em `session.js` (com a de `node-store.js`): "dm.enable pushes a dm-key appended in an earlier session whose push the seeder never confirmed" falha em "marked as not pushed" e em "one push run on a fresh start" |
| `test/dm.test.js` | 65/65, 713 | sem mudança no arquivo |
| `test/read-while-sync.test.js` | 13/13, 83 | sem mudança no arquivo |
| `test/dm-e2e.test.js` | 5/5, 317 | sem mudança no arquivo |
| `test/session-dm-unlock.test.js` | 19/19, 112 | sem mudança no arquivo |
| `test/page-dm.test.js` | 19/19, 213 | sem mudança no arquivo |

## Conferência em aparelho

Nada que a pessoa veja muda: o efeito é a chave chegar ao semeador mais cedo. Não conferido no Android, no iOS nem na web: o caminho pede uma conta com passkey cuja chave não subiu na sessão anterior, o que o modo Vitrine e o build de debug não alcançam.
