# feat/reopen-complete-copies

Na reabertura, A Rua, o Diário, as Conversas e os Avisos pintam nomes, fotos e originais citados a partir do aparelho. A lista de bloqueio deixa de segurar as linhas salvas de outras pessoas. Termos versão 115. Empilhado sobre `fix/push-lists-sair`.

## Comandos

No pouso rodam `npm run lint`, os testes direcionados sobre o diff do PR (cada arquivo de `apps/app/test`, `packages/core/test` e `apps/site/test` que importa ou lê por caminho um arquivo de `git diff --name-only origin/main...HEAD`, um por vez com `node <arquivo>`) e `npm run demo`. A suíte inteira roda no GitHub CI (Node 20 e 24). Nenhum `npm test` local.

Resultados: preenchidos na entrega

O diff não toca `apps/app/ios/`, `apps/app/android/`, `apps/app/assets/worklet/`, `dist/`, `*.bundle` nem `apps/app/public/varanda-node.js` (conferido na entrega).

## O que pinta do aparelho na reabertura

| Tela | Pinta do aparelho | Ainda espera a rede |
|---|---|---|
| A Rua | Linhas, nomes, fotos de perfil, fotos das publicações, originais citados, respondidos ou repostados (inclusive de quem não se segue). Linhas de outras pessoas aparecem sem esperar a lista de bloqueio. | Publicações novas, contadores e a conferência da lista de bloqueio. |
| Diário | Publicações, nomes, fotos e reposts guardados de quem não se segue. A limpeza só tira quem está bloqueado. | Publicações novas e a lista atual. |
| Membro | Página de quem se segue, com reposts e citações de quem não se segue, nomes e fotos. A página de quem só se visita nunca é guardada. | Posts novos e qualquer página visitada. |
| Conversas | Linhas, nomes, @nome, fotos de perfil, imagens de grupos públicos e a foto dos grupos privados, guardada decifrada. | Verificação ao vivo dos nomes e a foto privada atual. |
| Avisos | Linhas com nome, @nome e foto de perfil. | Avisos novos. |
| Refresh em segundo plano (nativo) | Salva a cópia de A Rua com até 6 pessoas que você não segue lidas por `diary.peek`. | A leitura em si, enquanto houver tempo no prazo. |
| PWA (web) | Fotos de quem se segue vêm do navegador (`varanda-kept-photos`, 64 MiB, 2000 arquivos, 30 dias), mais as listas de bloqueio e de silêncio. | Fotos de quem não se segue além da cópia (8 MiB, 200 arquivos, 14 dias). |

## Limites conhecidos

- Conversas: o `verifiedAt` de um nome é aproximado. Um nome salvo estável mantém o carimbo antigo e, passados 14 dias, cai por uma reabertura (conservador).
- Web: o "só manter quem se segue" cancela escritas enfileiradas a cada reconciliação de seguidos.
- Fotos de grupos privados só vêm das linhas de Conversas, nunca de outro lugar. Chave, nonce e núcleo ficam no nó.
- Refresh em segundo plano só no app nativo (a web não tem tarefa de fundo) e no máximo 6 pessoas desconhecidas por passagem. Uma falha de leitura pula aquela pessoa, sem nova tentativa.
- Se `block.list` falha, só as linhas da própria pessoa aparecem, como hoje.
- Membro: a página que só se visita continua sem cópia.
- A foto de quem não se segue só é guardada depois que a lista de bloqueio e a de seguidos desta abertura são conhecidas. Um bloqueio feito em outro aparelho vale quando a lista desta abertura chega.

## Conferência no aparelho (não feita)

Android, iOS e PWA, depois de uma abertura normal e de fechar o app por completo.

- [ ] 1. Reabrir em modo avião A Rua, o Diário, as Conversas e os Avisos mostra nomes, fotos de perfil, originais e fotos.
- [ ] 2. Com uma pessoa bloqueada, as linhas das outras aparecem de uma vez e a prévia não pisca.
- [ ] 3. Um bloqueio feito em um segundo aparelho some no primeiro na primeira atualização.
- [ ] 4. Depois de Sair, não sobra lista, cópia nem foto de cópia.
- [ ] 5. Nada novo é gravado antes de aceitar os novos Termos.
- [ ] 6. Reabrir em modo avião o Membro de alguém que se segue mostra os reposts e citações de desconhecidos, e as Conversas mostram a foto dos grupos privados.
- [ ] 7. No PWA, sem rede, as fotos de quem se segue vêm do armazenamento do navegador.
- [ ] 8. No Android e no iOS, depois de um refresh em segundo plano com um desconhecido citado em A Rua, a próxima abertura em modo avião mostra a citação.
