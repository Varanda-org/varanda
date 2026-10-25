# Histórico de mudanças

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Ainda não há versões lançadas: todos os pacotes estão em `0.1.0` e nenhum foi publicado.

## [Não lançado]

### Adicionado

- Primeira etapa da interface do app (PR `feat/ux-shell`): a sincronização é sempre automática (uma rodada contínua começa quando a identidade está desbloqueada e o certificado confirmado, com backoff de 2 s a 60 s em erro), a primeira configuração tem três passos ("Passo n de 3", com "Pular por enquanto" para o nome), nomes e @nomes aparecem no lugar de chaves, A Rua e o Diário paginam para trás com cursores e rolagem infinita, e puxar para atualizar funciona no app nativo e na web (na web com a ação "Atualizar" para o teclado).
  Contrato novo no RPC: cursores `before` em `feed.read` (`{ at, author, seq }`, páginas de 35) e em `log.read` (número de bloco, páginas de 42) e o método `profile.read`, que devolve nome, @nome e bio de até `PROFILE_LIMIT_MAX` (100) chaves por pedido, lendo o diário local inteiro com as regras de admissão do feed. Um nó antigo responde "método desconhecido" e o app mostra "sem nome". A pílula "ver novidades" é uma dica a partir das linhas `downloaded`, nunca uma contagem, e o chip do topo mostra o estado em uma expressão ("sincronização automática", "reconectando…" e as demais).
  Limites: toda leitura ainda interrompe a rodada contínua (issue #66, atenuado por lotes), a preferência por Wi-Fi não existe (issue #48), não há paginação para a frente (`since`), e perfis de outros membros, curtidas, republicações e mídia ficam para as próximas etapas. Detalhes e roteiro de verificação em `docs/verification.md` seção 15.
- Denúncias de dentro do app e painel de moderação (PR B3): na versão web hospedada, quem vinculou a conta Google denuncia uma publicação (A Rua) ou uma conta (A Rua e Seguindo) numa folha "Denunciar", assinada com a chave do membro (RPC `report.sign`) e guardada pelo serviço de conta; a pessoa denunciada não vê nada.
  Os moderadores listados em `VARANDA_MODERATOR_EMAILS` entram com o Google em `/account/mod/` (segundo URI de redirecionamento `/account/mod/callback`) e marcam bloquear ou descartar, desbloqueiam e cancelam mudanças pendentes. O painel só admite moderadores com a conta Google vinculada a um diário e esconde os casos do próprio diário. O painel não assina: o operador roda `mod apply --server <origem>` na própria máquina, que busca as decisões por pedidos assinados com a chave da moderação (presos à origem), mostra o que vai mudar e pede confirmação num terminal, assina uma lista nova, publica no semeador e só então confirma ao painel. Sem terminal, só `--yes` roda: aplica no máximo 100 bloqueios por vez e deixa os desbloqueios para uma revisão no terminal. `account reports [--member <chave>]` exporta as denúncias com os e-mails do vínculo, só no servidor.
  Limites: só a versão web hospedada denuncia (até 20 por pessoa a cada 24 h), o trecho citado não é conferido, sessões do painel acabam com o reinício do serviço, a retenção das denúncias segue em aberto (issue #38), e o painel usa a mesma origem do PWA, risco aceito e documentado (a correção seria um subdomínio próprio). Detalhes e roteiro de verificação em `docs/verification.md` seção 14.
- Lista de bloqueio assinada e revogação de emissor, aplicadas por todos os nós (PR B2): a associação certifica uma chave de moderação (`assoc certify-moderator`), e o operador publica listas numeradas com `mod block`, `mod unblock`, `mod revoke-issuer` e `mod unrevoke-issuer` (`mod init`, `mod cert add`, `mod show`; a chave secreta da moderação nunca sai da máquina do operador).
  Semeadores, membros da CLI e a versão web trocam a lista no canal `varanda/blocklist/1` (até 4096 contas e 64 emissores; uma lista por 10 s por conexão, 5 mensagens inválidas derrubam o par), guardam a mais nova que confere e purgam e recusam os diários bloqueados, e os de um emissor revogado. O semeador mostra `blocked` e `blocklistSeq` em `/health` e `lista de bloqueio` em `seed status`.
  `mod publish` reenvia ao semeador a lista gravada, sem mudar nada, quando a publicação não foi confirmada. `--seeder <chave>` (ou `mod init --seeder`) diz qual semeador recebe a lista: ela vai só a ele, pela chave, nunca ao tópico público, e só conta como entregue quando ele se prova semeador da associação e confirma tê-la guardado (o `have` traz o início da assinatura da lista; outra lista com o mesmo número é um conflito, código 1). `--new-list` começa a primeira lista da associação; numa troca de moderação, copie o `blocklist.json` anterior para o diretório novo.
  Limites: nós de antes desta versão não aplicam a lista, um app modificado ainda fala direto com a conta bloqueada, e o app da própria conta guarda o diário; certificados de membro individuais não são revogáveis. Resposta a uma chave de emissor roubada no README e em `docs/verification.md` seção 13.
- Vínculo com a conta Google e @nome na versão web hospedada: o novo serviço `account` (`varanda account`, no Compose atrás do Caddy em `/account/*`) liga a chave da passkey a uma conta Google (OAuth com PKCE no servidor, escopos `openid` e `email`) e emite sozinho o certificado de membro v2 (faixa etária `unchecked`, assinado por uma chave de emissor que a associação certifica com `assoc certify-issuer`) e um registro de @nome no diário.
  O @nome pode ser trocado uma vez a cada 7 dias, e um nome já usado por um membro nunca é dado a outro. O serviço sobe sem emissor até a cerimônia do README (`account key`, `assoc certify-issuer`, `account cert add`); o semeador e os membros nativos e da CLI precisam estar atualizados antes da primeira emissão v2, e a identidade piloto mantém o certificado v1. Resultado e limites em `docs/verification.md` seção 12.
- PWA hospedado abre sem rede depois de uma visita com rede, permite Entrar com a passkey e ler o que está no aparelho; o `sw.js` guarda a versão verificada do app e confere de novo o SHA-256 de cada arquivo guardado antes de entregá-lo, e a fila de saída guarda publicações e respostas para enviar quando a conexão voltar, com a identidade desbloqueada.
  A fila aparece no Diário; a data de cada publicação é a do envio efetivo ao diário, não a de quando o texto foi escrito. Um envio incerto espera a decisão da pessoa, sem repetição automática.
  Só sai sozinho o que foi escrito com a página aberta; o que ficou de uma visita anterior espera a pessoa tocar em "enviar" no Diário. Isso protege contra uma publicação plantada no aparelho enquanto a identidade estava bloqueada.
- Implantação automática pelo GitHub Actions: a cada push em `main`, o fluxo `deploy` repete o CI e roda `deploy/seeder/deploy.sh` no servidor por SSH (chave de comando forçado, `known_hosts` fixo, ambiente `producao`).
  O script só implanta a ponta de `main`, confere a saúde (semeador, app servido e WebSocket) e volta sozinho para a versão anterior se falhar. Fica pulado até `VARANDA_DEPLOY=true`.
- Versão web no ar no servidor do semeador: `seed --ws-origin` (ou `VARANDA_WS_ORIGIN`) libera a origem do PWA na entrada WebSocket;
  `deploy/seeder/compose.web.yaml` e `deploy/seeder/Caddyfile` sobem um Caddy com TLS automático que serve o app e repassa `wss://<domínio>/seeder`; o app web vira um PWA instalável (manifesto e ícones).
- Protótipo P2P da fase 0 no Holepunch: CLI com identidade, certificado de membro, perfil, publicações, respostas, seguir pessoas, feed e sincronização.
  Semeador com admissão por certificado e referência normativa em `docs/protocol.md`. ([#1](https://github.com/Varanda-org/varanda/pull/1))
- Monorepo com CLI, núcleo compartilhado, contrato RPC e app P2P para iOS, Android e web.
  O nó roda em um worklet Bare no celular. ([#3](https://github.com/Varanda-org/varanda/pull/3))
- Página de apresentação do varanda.app, logotipo de cadeira de praia e prévia do desenho do app. ([#4](https://github.com/Varanda-org/varanda/pull/4))
- CI em cada pull request, com lint, testes e demo no Node 20 e 24; teste que compara a ajuda da CLI com o README.
  Guias de contribuição, segurança e conduta, modelos de issue e de PR, e CODEOWNERS.
- Operação do semeador: `seed status`, `seed list` e `seed drop`; endpoint de saúde e métricas (`--health-port`, em `127.0.0.1` por padrão);
  imagem Docker, Compose e unidade systemd com reinício e SIGTERM; política de registros provisória. ([#34](https://github.com/Varanda-org/varanda/issues/34))
- Entrada WebSocket do semeador (`seed --ws-port`, desligada por padrão, só em `127.0.0.1`) e pacote experimental `@varanda/web-member`
  (membro com a chave no navegador, Hypercore 10, replicação pelo semeador e avaliação do dht-relay); resultado em `docs/verification.md` §8.
- Versão web com o nó no navegador: a interface web roda contra uma sessão do `@varanda/web-member` na própria página (Hypercore 10, chave e diários no IndexedDB),
  ligada ao contrato RPC em memória e sincronizada só pelo semeador (`seed --ws-port`), com as mesmas regras de quarentena, de certificado e de cota.
  A web ganhou a tela Conectar (associação e endereço do semeador); uma segunda aba é recusada; o modo `varanda-serve` continua. Resultado em `docs/verification.md` §9.

- Entrada com passkey (por exemplo, a conta Google) na versão web: a identidade do membro é derivada da passkey (WebAuthn com a extensão PRF) e a chave nunca é gravada, só existe na memória da página; a mesma passkey abre a mesma identidade em qualquer aparelho, e navegadores sem PRF não entram.
  Antes de escrever, o nó alcança o semeador e, depois, envia o diário; num aparelho novo, o diário e o certificado voltam do semeador. Um diário de antes das passkeys é apagado com "recomeçar". Resultado em `docs/verification.md` §10.
- Conexão automática da versão web: o Caddy serve `/varanda.json` com a associação (`VARANDA_ASSOCIATION` em `deploy/seeder/.env`, obrigatória) e o app se configura sozinho; a implantação confere o arquivo. Em desenvolvimento, a tela Conectar continua.

### Alterado

- Ajustes › Sincronizar virou Ajustes › Sincronização e é só leitura: sem botões de sincronizar ou parar, mostra o estado, a nova tentativa e as últimas 200 linhas. O "handle" de seis dígitos hexadecimais (`@` mais a chave) saiu do app: sem nome, aparece "sem nome", e a chave só é mostrada no próprio perfil (atrás de "mostrar chave"), em Ajustes › Identidade e na etapa do certificado. A fila de saída passa a ser esvaziada também durante a rodada contínua, nunca durante uma rodada única.
- O Caddy serve todos os arquivos de `/srv/web` com `Cache-Control: no-cache`, revalidado por ETag; arquivos ausentes com extensão dão 404 com `no-store`, e só caminhos sem extensão recebem `index.html` (`/varanda.json` continua com `no-store`).
  O build e a implantação conferem `sw.js`, com sonda byte a byte quando ele existe em `www` (a primeira implantação ainda roda o `deploy.sh` anterior); `expo.web.lang` passa a `pt-BR`, e o servidor do `varanda-serve` reconhece `.webmanifest`.
- A licença de distribuição passou de MIT para PolyForm Noncommercial 1.0.0, com Rodrigo Serviuc Pavezi como licenciante: uso não comercial é permitido; usos comerciais não abrangidos pela licença dependem de autorização prévia.
  Ao abrir um PR, quem contribui concede ao licenciante uma licença para distribuir a contribuição sob quaisquer termos, sem CLA; os trechos de terceiros recebidos antes, sob a MIT, mantêm o aviso em CONTRIBUTING.md. O site e os guias deixaram de descrever o código como aberto.
- O app ganhou o desenho da página de apresentação: três abas (A Rua, Seguindo, Diário), botão e folha de publicar, cabeçalho de perfil e ajustes.
  As funções e o protocolo são os mesmos; o desenho está em `apps/site/artwork/app-design.md`.

### Corrigido

- Um lock do diretório de dados com o pid do próprio processo, deixado por um processo morto que tinha o mesmo pid
  (um contêiner reiniciado), agora é retomado em vez de travar o semeador. ([#34](https://github.com/Varanda-org/varanda/issues/34))
- Liberação de referências a sockets fechados nas buscas em quarentena. ([#2](https://github.com/Varanda-org/varanda/pull/2))
- DHT pública com endereço local de loopback: o app e a sessão do nó recusam a combinação, que só terminava em tempo esgotado.
  Avisos de tela somem quando o nó encerra, quando a sincronização termina ou quando a resposta muda. ([#10](https://github.com/Varanda-org/varanda/issues/10))
