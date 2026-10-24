# Histórico de mudanças

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Ainda não há versões lançadas: todos os pacotes estão em `0.1.0` e nenhum foi publicado.

## [Não lançado]

### Adicionado

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
- Vínculo com a conta Google e @nome na versão web hospedada: o novo serviço `account` (`varanda account`, no Compose atrás do Caddy em `/account/*`) liga a chave da passkey a uma conta Google (OAuth com PKCE no servidor, escopos `openid` e `email`) e emite sozinho o certificado de membro v2 (faixa etária `unchecked`, assinado por uma chave de emissor que a associação certifica com `assoc certify-issuer`) e um registro de @nome no diário.
  O @nome pode ser trocado uma vez a cada 7 dias, e um nome já usado por um membro nunca é dado a outro. O serviço sobe sem emissor até a cerimônia do README (`account key`, `assoc certify-issuer`, `account cert add`); o semeador e os membros nativos e da CLI precisam estar atualizados antes da primeira emissão v2, e a identidade piloto mantém o certificado v1. Resultado e limites em `docs/verification.md` seção 11.

### Alterado

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
