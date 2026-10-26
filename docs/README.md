# Documentação do Varanda

Índice de `docs/`. Os documentos normativos (protocol e rpc) mandam sobre o código: se um divergir, o erro está num dos dois.

| Documento | Idioma | O que é |
|---|---|---|
| [protocol.md](protocol.md) | inglês | Referência normativa da fase 0: identidade, armazenamento, registros, certificados, rede, sincronização, CLI, mapa de módulos e a sessão do nó. |
| [rpc.md](rpc.md) | inglês | Contrato JSON versão 1 entre a interface e o nó (IPC no app, WebSocket no `varanda-serve`): envelopes, limites, métodos, eventos, erros. |
| [design.md](design.md) | pt-BR | Documento de design exportado: objetivos, nomes no app, arquitetura, verificação de idade, LGPD, riscos, fases e perguntas em aberto. |
| [development.md](development.md) | inglês | Como desenvolver: pré-requisitos, workspaces, instalação, lint, testes, demo, `varanda-serve`, build do iOS, Android, teste do Bare. |
| [app.md](app.md) | pt-BR | O que o aplicativo faz hoje, as telas, o nó no app contra o cliente web, o que ficou fora do piloto. |
| [ios-gate.md](ios-gate.md) | inglês | A prova de que o nó real roda no worklet Bare do app no simulador iOS: como é montado, os passos, a evidência e os riscos restantes. |
| [verification.md](verification.md) | inglês | A verificação de ponta a ponta do monorepo: CLI, navegador pelo `varanda-serve` e simulador iOS sincronizando entre si, a DHT pública, as checagens de vazamento, o que não foi verificado e as correções da auditoria de segurança. |
| [site.md](site.md) | pt-BR | O site estático (varanda.app): como ver, atualizar e publicar na GitHub Pages, os passos de domínio e DNS que só o usuário faz, e a verificação depois de publicar. |

O README da raiz ([../README.md](../README.md)) descreve o programa de linha de comando e o `varanda-serve`.

## Onde ficam os pacotes

| Caminho | Pacote | README |
|---|---|---|
| `apps/cli` | `varanda`: o programa de linha de comando, o semeador, a demo e o `varanda-serve` | [apps/cli/README.md](../apps/cli/README.md) |
| `apps/app` | `@varanda/app`: o aplicativo Expo / React Native (iOS, Android e web) e o worklet Bare | [apps/app/README.md](../apps/app/README.md) |
| `apps/site` | `@varanda/site`: o site estático, o logotipo e os scripts de ícones | [apps/site/README.md](../apps/site/README.md) |
| `packages/core` | `@varanda/core`: registros, certificados, armazenamento, rede, sincronização e a sessão do nó | [packages/core/README.md](../packages/core/README.md) |
| `packages/rpc` | `@varanda/rpc`: o contrato JSON entre interface e nó | [packages/rpc/README.md](../packages/rpc/README.md) |
| `packages/web-member` | `@varanda/web-member`: o membro no navegador (Hypercore 10), o nó da versão web, e o spike | sem README; veja [development.md](development.md) |
