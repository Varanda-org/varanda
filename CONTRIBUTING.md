# Como contribuir

Para contribuir com o Varanda, faça um fork, crie uma branch e abra um pull request.

## Como escolher uma issue

Veja as tarefas no [quadro do projeto](https://github.com/orgs/Varanda-org/projects/1) (Project "Varanda"). Cada issue tem um Status (Todo, In Progress, Done) e uma Fase.
As fases também são milestones: "Fase 0 — Protótipo: pendências", "Fase 1 — Piloto 18+", "Fase 2 — Ondas do canal" e "Fase 3 — Menores de 16". Issues com o rótulo `sem-fase` estão adiadas ou sem decisão e ficam fora de qualquer fase.

Filtros úteis na [lista de issues](https://github.com/Varanda-org/varanda/issues). Cada linha é uma busca separada: cole uma de cada vez.

```text
is:open no:assignee label:"good first issue" -label:só-mantenedores
is:open no:assignee label:"help wanted" -label:só-mantenedores
is:open no:assignee label:"dificuldade:pequena" -label:só-mantenedores
```

- Prefira issues sem responsável (`no:assignee`) e sem o rótulo `só-mantenedores`.
- Evite issues com o selo "Blocked" (aparece quando a issue é "bloqueada por" outra ainda aberta): espere as bloqueadoras fecharem.
- Issues grandes são divididas em sub-issues; pegue uma sub-issue, não a issue-mãe.
- Cada issue segue o mesmo roteiro: Contexto, Escopo, Critérios de aceite, Depende de e Fontes, com "Fase" e "Dificuldade" no rodapé. Quando parte do trabalho já foi entregue, as seções Já feito e Falta dizem o que os PRs fizeram e o que resta. Os critérios de aceite dizem como verificar que o trabalho terminou.

Tire dúvidas em [Discussions](https://github.com/Varanda-org/varanda/discussions).

## Como pegar uma issue

1. Comente na issue pedindo para ser responsável por ela.
2. Um mantenedor atribui a issue a você. Issue atribuída é issue tomada: não comece antes disso, para não duplicar trabalho.
3. Abra o PR e coloque `Closes #n` na descrição (o modelo de PR já traz a linha).
4. Se não houver PR nem atualização em cerca de 2 semanas, a issue pode ser desatribuída para outra pessoa. Avisar que você precisa de mais tempo ou que desistiu ajuda.

Sem `Closes #n`, a issue não fecha com o merge e o quadro fica desatualizado. Isso já aconteceu várias vezes: confira antes de enviar.

## O que significam os rótulos

| Rótulo | Significado |
|---|---|
| `área:*` | Parte do projeto: `protocolo`, `app`, `web` (app web/PWA em `apps/app` e o nó no navegador em `packages/web-member`), `conta` (serviço de contas e painel de moderação, `apps/cli/lib/account`), `cli`, `rpc`, `nativo`, `semeadores`, `idade`, `infra`, `identidade`, `push`, `jurídico`, `moderação`, `operações`, `parceiros`, `segurança`, `testes`, `docs`, `repositório`, `produto` |
| `tipo:*` | Natureza do trabalho: `funcionalidade`, `correção`, `verificação`, `decisão`, `operação` (não técnico: contratos, registros, equipe), `documentação` (documentos e políticas que o projeto precisa, em geral jurídicos), `pesquisa` |
| `portão:1`, `portão:2`, `portão:3` | A issue é critério de passagem do portão que abre a próxima fase |
| `sem-fase` | Adiada ou sem decisão; fora de qualquer fase |
| `dificuldade:pequena`, `dificuldade:média`, `dificuldade:grande` | Repete a "Dificuldade" do rodapé da issue |
| `só-mantenedores` | Exige a associação (jurídico, contratos, segredos ou acesso à produção). Você pode comentar, mas não pegar |
| `bloqueado:externo` | Espera um parecer jurídico, um parceiro ou um serviço externo |
| `sensível:segurança` | Mexe em chaves, certificados ou superfície de ataque; a revisão é mais rigorosa |
| `good first issue`, `help wanted`, `accessibility` | Boa para quem chega, ajuda bem-vinda, acessibilidade |

Ao abrir uma issue pelos formulários, o rótulo `tipo:*` já vem preenchido; os mantenedores completam o resto na triagem.

## Ambiente

Você precisa de Node.js 20 ou superior (`>=20`) e npm.
Instale as dependências na raiz do repositório:

```sh
npm install
```

O monorepo usa npm workspaces e um único `package-lock.json`, na raiz.
Não crie um lockfile dentro de um workspace.

Veja a seção “Estrutura do repositório” do [README](README.md).
Para compilar o app, siga as seções “iOS” e “Android” de [docs/development.md](docs/development.md).
Para rodar o app web com o nó no navegador (`npm run web -w apps/app`), veja a seção “The web app with the node in the browser” do mesmo arquivo.

## Antes de abrir o PR

Execute na raiz, nesta ordem:

```sh
npm ci
npm run lint
npm test
npm run demo
```

O `npm ci` é opcional localmente; ele apaga `node_modules` e reinstala tudo conforme o `package-lock.json`.
O lint usa `standard`. Os testes usam `brittle` nos workspaces que têm testes.
A demo deve terminar imprimindo `DEMO OK`.

A CI executa esses mesmos quatro passos, divididos em jobs paralelos, nas versões 20 e 24 do Node em cada pull request.

## Convenções

Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:` ou `ci:`.
Escreva em inglês, como o resto do histórico, em minúsculas, no imperativo e sem ponto final. O título do PR segue o mesmo formato. Exemplos:

```text
feat: add a filter to the feed
fix: release closed sockets from quarantine fetches
docs: explain the installation
```

Nomeie a branch como `<tipo>/<slug>`, por exemplo `fix/fetch-socket-retention`.

Toda dependência deve ter versão exata, sem `^`, `~` ou intervalos.
Na raiz, troque `<nome>`, `<versão>` e `<workspace>` pelos valores reais (por exemplo, `-w packages/core`):

```sh
npm install --save-exact <nome>@<versão> -w <workspace>
```

Escreva em pt-BR todo texto que a pessoa usuária vê, inclusive as saídas da CLI e as telas do app. As issues também são em pt-BR; commits e títulos de PR, em inglês (Conventional Commits).

[docs/protocol.md](docs/protocol.md) e [docs/rpc.md](docs/rpc.md) são normativos.
Se código e documento divergem, um dos dois está errado.
Mudanças em formatos, mensagens ou métodos devem atualizar o documento correspondente no mesmo PR.

## Pull requests

Abra o PR a partir do seu fork, com destino à branch `main` do repositório do Varanda.

- Trate um assunto por PR.
- Descreva o que mudou e por quê.
- Referencie a issue com `Closes #n`, substituindo `n` pelo número. Não esqueça: é isso que fecha a issue e atualiza o quadro.
- Espere a CI passar antes do merge.
- Aguarde a revisão de @Varanda-org/mantenedores, equipe responsável pelos arquivos no CODEOWNERS.

Os mantenedores fazem o merge. Quem contribui nunca envia alterações diretamente para `main`.

## Trabalho fora do código

Os mantenedores coordenam o trabalho jurídico, de parcerias, de moderação e com fornecedores de verificação de idade.
As etiquetas dessas áreas são `área:jurídico`, `área:parceiros`, `área:moderação` e `área:operações`; essas issues costumam levar também `só-mantenedores`.

Ofereça ajuda na issue correspondente ou em [Discussions](https://github.com/Varanda-org/varanda/discussions).

## Quem ajuda com frequência

Quem contribui regularmente pode receber um convite para ajudar na triagem de etiquetas, issues e tarefas do quadro.
Com o tempo, pode receber um convite para a equipe de mantenedores.

## Agentes de IA

Se um agente de IA ajuda você, leia o [AGENTS.md](AGENTS.md): ele reúne as regras e as armadilhas do repositório para agentes.
A pessoa que envia o PR continua sendo a autora e responde pelo que foi enviado.

## Segurança

Nunca relate uma vulnerabilidade em uma issue pública.
Siga o canal privado descrito em [SECURITY.md](SECURITY.md).

## Conduta

Ao participar, siga o [Código de Conduta](CODE_OF_CONDUCT.md).

## Licença

O repositório é distribuído sob a [PolyForm Noncommercial 1.0.0](LICENSE) (SPDX `PolyForm-Noncommercial-1.0.0`): usar, copiar e modificar é permitido para fins não comerciais; usos comerciais não abrangidos pela licença dependem de autorização prévia do licenciante, Rodrigo Serviuc Pavezi.
Ao abrir um PR, você declara que tem o direito de enviar a contribuição e concede a Rodrigo Serviuc Pavezi uma licença perpétua, mundial, gratuita, não exclusiva e irrevogável para usar, copiar, modificar, distribuir e sublicenciar a contribuição sob quaisquer termos, inclusive a PolyForm Noncommercial 1.0.0 e licenças comerciais.
Você continua titular dos direitos autorais da sua contribuição.
Não há acordo de licença de contribuição (CLA) para assinar.

### Contribuições anteriores, sob a MIT

Até a troca de licença, as contribuições eram aceitas sob a MIT.
As contribuições de terceiros recebidas assim são os commits `b863d4f`, `6a40d2b` e `601d5f6`, de Karik-ribasu, em `README.md` e `docs/design.md`.
O aviso da MIT abaixo cobre apenas os trechos desses commits; o restante do repositório é distribuído só sob a PolyForm Noncommercial 1.0.0.

```text
Este aviso cobre apenas as contribuições de Karik-ribasu nos commits b863d4f, 6a40d2b e 601d5f6 (README.md e docs/design.md).

MIT License

Copyright (c) 2026 Varanda contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
