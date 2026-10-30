# AGENTS.md

Guia para agentes de IA (Claude Code, Codex, Cursor, Copilot e similares) que ajudam alguém a contribuir com o Varanda. Leia antes de mexer em qualquer arquivo. Ele complementa o [CONTRIBUTING.md](CONTRIBUTING.md); se os dois divergirem, vale o CONTRIBUTING.md, e este arquivo deve ser corrigido.

## Regras obrigatórias

Autoria e responsabilidade:

- A pessoa que pediu o trabalho é a única autora e responde por ele. Commits e PRs saem na identidade git dela: nenhum agente como autor ou committer, nenhum `Co-Authored-By` de IA, nenhum rodapé do tipo "Generated with".
- Ao enviar um PR, a pessoa declara ter o direito de enviar a contribuição (veja "Licença" no CONTRIBUTING.md). Não copie código de outro projeto sem conferir a licença e sem citar a origem. O repositório é PolyForm Noncommercial 1.0.0.
- Sem travessão (em dash, U+2014) em texto novo: commits, PRs, docs, comentários e código. Use vírgula, dois-pontos ou ponto.
- Texto de commit e de PR curto, direto e sem enchimento, como uma pessoa escreveria.

Só com pedido explícito da pessoa, naquele momento (um "sim" anterior não vale para o próximo passo):

- commitar, dar push, abrir PR, comentar em issue ou PR, pedir para ser responsável por uma issue;
- reescrever histórico (rebase, amend, force push) de uma branch já revisada. Prefira commits novos.

Nunca, em nenhuma circunstância:

- fazer merge, dar push em `main` ou mudar configurações do repositório ou da organização (Pages, domínio, HTTPS);
- mexer em DNS ou contas de terceiros, rodar ou disparar workflows do GitHub Actions, criar releases ou implantações, publicar pacotes;
- ler, imprimir ou commitar segredos: `.env`, chaves privadas, certificados reais, `key.properties`, tokens, dados pessoais. Fixtures geram chaves na hora;
- relatar vulnerabilidade em issue, PR ou comentário público. Se achar uma, pare e avise a pessoa para seguir o [SECURITY.md](SECURITY.md). Detalhes de segurança que um mantenedor mandar em privado também ficam fora de comentários públicos;
- usar a DHT pública ou qualquer rede externa nos testes (eles usam uma DHT local presa a `127.0.0.1`).

Escolha de trabalho:

- Só issues sem responsável. Não pegue issue com `só-mantenedores`, `sensível:segurança` ou `bloqueado:externo`, nem a que tem selo "Blocked". Issue grande: pegue a sub-issue.
- Peça para ser responsável na issue e espere a atribuição de um mantenedor antes de começar. Depois, siga os critérios de aceite dela.
- Dúvida de escopo ou de produto: pergunte à pessoa, ou em [Discussions](https://github.com/Varanda-org/varanda/discussions). Não decida sozinho.

## O que é o projeto

Rede social ponto a ponto (Holepunch: Hypercore, Hyperswarm, HyperDHT). Cada pessoa tem um diário assinado no próprio aparelho; seguidores e semeadores guardam cópias. Fase 0, protótipo, sem versões lançadas. Monorepo npm (workspaces `packages/*` e `apps/*`, um só `package-lock.json` na raiz).

| Caminho | O que é |
|---|---|
| `packages/rpc` | Contrato JSON entre a interface e o nó. Sem dependências e sem módulos do Node. |
| `packages/core` | Registros, certificados, armazenamento, rede, sincronização, semeador e a sessão do nó. Roda no Node e no Bare. |
| `packages/web-member` | O nó no navegador (Hypercore 10 sobre IndexedDB). Privado. |
| `apps/cli` | `varanda`, `varanda-serve`, o semeador, o serviço de contas, a demo. |
| `apps/app` | Aplicativo Expo / React Native (iOS, Android, web) e o worklet Bare. |
| `apps/site` | Site estático. |
| `docs/` | `protocol.md` e `rpc.md` (normativos), `development.md`, `design.md`, `verification.md` e outros. Índice em [docs/README.md](docs/README.md). |

Princípios que não mudam sem decisão dos mantenedores: tudo que vem de um par é não confiável; o cliente nunca reenvia um pedido por conta própria (falha em método que altera estado vem com `uncertain: true`); nenhum comando imprime chave secreta. Não acrescente coleta de dados, rastreio ou telemetria: o tratamento de dados pessoais segue a seção LGPD de `docs/design.md` (hipóteses de desenho que ainda dependem de parecer jurídico).

## Comandos

Node.js 20 ou mais novo e npm, a partir da raiz:

```sh
npm ci --ignore-scripts     # como a CI; ou npm install
npm run lint                # standard
npm test                    # todos os workspaces (brittle)
npm run demo                # deve terminar com "DEMO OK"
npm test -w packages/core   # um workspace
node apps/cli/test/serve.test.js   # um arquivo
```

A CI roda `npm ci --ignore-scripts`, lint, test e demo no Node 20 e no 24, divididos em jobs paralelos e reunidos por `test (20)` e `test (24)`. Rode os quatro passos antes de abrir o PR. Depois de qualquer `npm install` ou `npm ci`, o build nativo do app precisa de `npm run prepare:native -w apps/app` de novo. Os testes de `packages/web-member` exigem Node 20.19 ou mais novo.

## Armadilhas

- `apps/app/ios/` e `apps/app/android/` são mantidos à mão e têm correções de segurança que o `expo prebuild` sobrescreveria. Nunca rode `expo prebuild`, nem para regenerar ícones.
- Arquivos gerados ficam fora do git e nunca se editam: `apps/app/public/varanda-node.js`, `apps/app/assets/worklet/`, `apps/app/dist/`, `packages/web-member/dist/`, `*.bundle`.
- Dependência: só com motivo claro, com versão exata (`npm install --save-exact <nome>@<versão> -w <workspace>`), sem `^`, `~` nem intervalos. Nunca crie lockfile dentro de um workspace.
- `docs/protocol.md` e `docs/rpc.md` são normativos: mudou formato, mensagem ou método, atualize o documento no mesmo PR. Método novo do RPC entra em `packages/rpc/lib/methods.js` e em `docs/rpc.md`.
- Opção nova na CLI: atualize `HELP` em `apps/cli/lib/cli.js`, o bloco "Ajuda" do `README.md` (o teste `readme-help.test.js` exige que sejam idênticos) e as expectativas de `apps/cli/test/cli.test.js`.
- Texto vindo de um par nunca vai cru para a tela ou para o terminal: use `displayText` (`@varanda/rpc`) e `safe` / `jsonLine` (`@varanda/core/lib/safe`).
- Não adicione repetição automática de pedidos que alteram estado, nem acesso a `fs`, `path` ou `process` fora dos `imports` (`#fs`, `#path`, `#process`) em `packages/core`.
- Testes de rede criam a DHT local com o helper de `helpers/net.js` e diretórios temporários com `tmpDir`. Teste que mede tempo depende de carga: não compare com um instante lido depois de uma espera por polling. Se um teste falhar, rode-o sozinho antes de culpar a sua mudança, e relate as duas saídas. Localmente os arquivos de um workspace rodam em paralelo por padrão, então "sozinho" quer dizer `node <arquivo>` ou `VARANDA_TEST_CONCURRENCY=1`; a CI usa `VARANDA_TEST_CONCURRENCY=1`.
- Triagem de denúncias com IA (`apps/cli/lib/account/ai/`, PR #176): roda só no serviço de conta, desligada por padrão (`VARANDA_AI` vazio; `sombra` só registra; `1` decide). Não leve inferência para o aparelho nem para o processo que guarda a chave do emissor: o modelo roda num processo filho com ambiente vazio, e `npm ci --ignore-scripts` não pode deixar de valer. Não afrouxe as constantes de `ai/triage.js`, os tetos diários nem a lista "sempre humano" (`ilegal`, `assedio`, denúncia de conta, post com foto ou citação, apelação) sem decisão dos mantenedores. A IA nunca desbloqueia, cancela, revoga nem assina, e `mod apply --yes` não publica bloqueio da IA. Os logs carregam só tokens, nunca o texto do post. Os testes usam o embedder falso (`test/helpers/fake-embed*.js`): não baixe pesos nem use rede. O teste com o modelo real só roda com `VARANDA_AI_MODEL_DIR` apontando para a saída de `scripts/fetch-ai-model.js`, que é tarefa do operador. `VARANDA_TRIAGE_TOKEN` é segredo, e a rota `/moderation-post/` do semeador não pode passar pelo Caddy (há teste). Mudou o formato do `pull` de moderação (`actor`), o servidor e a CLI do operador mudam juntos. Detalhes em `README.md` ("Triagem com IA") e `docs/verification.md` §27.
- Arquivos enormes: o `README.md` tem mais de 100 KB e o `docs/verification.md` quase 300 KB. Procure a seção com `grep -n '^#'` e leia só ela.

## Convenções de código

- Estilo `standard` (sem ponto e vírgula, dois espaços). `packages/*` e `apps/cli` são CommonJS (siga o cabeçalho do arquivo, a maioria começa com `'use strict'`); `apps/app/src` é ESM. Módulos puros do app não importam React, `react-native` nem built-ins do Node, para rodarem nos testes.
- Lógica pura separada de interface e de E/S, com teste. Comentário só explica o porquê, nunca o que o código já diz; não deixe comentário redundante.
- Texto que a pessoa usuária vê (telas do app, saídas e erros da CLI) é pt-BR. Identificadores, comentários e nomes de teste seguem o idioma do arquivo (hoje, inglês).
- Menor mudança que resolve o problema. Um assunto por PR. Não refatore, renomeie nem reformate o que não foi pedido, e não adicione funcionalidade além da issue.
- Teste novo fica no arquivo da área. Regressão tem de falhar sem a correção: confira removendo a correção e rodando de novo. Ao mover ou dividir testes, compare o número de testes e de asserções antes e depois.
- Mudança que o operador ou a pessoa usuária percebe pode merecer entrada no `CHANGELOG.md` (seção "Não lançado"). Na dúvida, pergunte no PR.

## Fluxo de PR

1. Branch `<tipo>/<slug>` a partir da `main` atualizada (`fix/fetch-socket-retention`). Nunca commite na `main`.
2. Commits no padrão Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`), em inglês, minúsculas, no imperativo, sem ponto final, como manda o CONTRIBUTING.md. Se a pessoa pedir outro idioma, siga o pedido dela. O título do PR segue o mesmo formato.
3. PR do fork para a `main` de `Varanda-org/varanda`, com o modelo de PR preenchido e `Closes #n` na descrição. Corpo em pt-BR e conciso: o que muda, por que, como verificar.
4. Só marque no checklist o que foi de fato executado. Diga o que não rodou e qualquer falha, inclusive intermitente, com a saída.
5. A CI de quem contribui pela primeira vez pode ficar em `action_required` até um mantenedor aprovar o workflow. Não tente contornar.
6. Em revisão, responda com commits novos e cite o hash. Não resolva as conversas dos revisores nem abra PR extra sem avisar.

## Antes de dizer que terminou

- `npm run lint`, `npm test` e `npm run demo` passam, ou você relatou exatamente o que falhou.
- Os critérios de aceite da issue estão cobertos por teste ou por verificação descrita no PR.
- O diff não tem segredo, dado pessoal, arquivo gerado nem texto com travessão.
- Documentos normativos, README e `HELP` estão em dia com o código.
