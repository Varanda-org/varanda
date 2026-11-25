# Sincronizar só no Wi-Fi (issue #48)

Automático: `apps/app/test/autoSyncPolicy.test.js` (`wifiHold`, `shouldStopForMetered`, início e atualização manual), `onlineNative.test.js` (`meteredFromState`, `subscribeMetered`), `wifiOnly.test.js` (padrão ligado, persistência).

Não conferido em aparelho (a conferir no Android e no iOS):
1. Com dados móveis e a chave ligada, abrir o app não baixa nada; A Rua mostra a cópia local.
2. Sair do Wi-Fi com a sincronização rodando pausa a rodada; voltar ao Wi-Fi continua.
3. Puxar para atualizar com dados móveis sincroniza; trocar de rede volta a segurar.
4. Desligar a chave sincroniza com dados móveis.
5. Web: a chave não aparece e nada muda.
Limite: antes de o NetInfo responder (primeiro instante) o estado é tratado como Wi-Fi; segundo plano completo e preempção por publicação seguem em #66.
