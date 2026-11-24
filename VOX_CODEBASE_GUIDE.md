# Guida al codice di Vox

Questa guida spiega come è organizzato il codice di Vox. Per i prerequisiti, l'avvio in modalità sviluppatore, i test e la creazione dei pacchetti, vedi [Come contribuire a Vox](./HOW_TO_CONTRIBUTE.md).

Quasi tutto il codice di Vox vive nella cartella `src/vs/workbench/contrib/vox/`.

---

## Architettura di VS Code (Electron)

VS Code è un'applicazione Electron divisa in due processi principali più un livello condiviso. Per una panoramica generale vedi anche la [documentazione sull'organizzazione dei sorgenti di VS Code](https://github.com/microsoft/vscode/wiki/Source-Code-Organization).

- **`browser/`**: gira nel processo renderer (la finestra HTML/DOM del workbench). Può usare `window`, gli editor Monaco e i widget dell'interfaccia, ma non può importare liberamente `node_modules` nativi.
- **`electron-main/`**: gira nel processo principale Node/Electron. Può importare `node_modules` (SDK dei modelli, `node:child_process`, `node:fs`) e gestisce le chiamate di rete locali evitando limiti CSP.
- **`common/`**: codice puro condiviso da entrambi i processi, senza import specifici di browser o Node.

Per usare librerie Node o accedere al sistema dal lato `browser/`, Vox adotta due strategie:
1. raggruppare i pacchetti frontend in un bundle browser (come avviene per React in `browser/react/`);
2. implementare la logica in `electron-main/` ed esporla al `browser/` tramite un canale IPC.

---

## Concetti chiave del workbench

- **Workbench**: il contenitore principale che ospita editor, barra laterale, pannelli e terminale.
- **Editor (`ICodeEditor`)** e **Modello (`ITextModel`)**: un editor mostra una o più schede; un modello rappresenta il contenuto di un file in memoria ed è condiviso tra più editor aperti sullo stesso file.
- **URI**: identifica una risorsa (file locale, remoto o schema interno).
- **Servizi**: singleton registrati con `registerSingleton` e iniettati nei costruttori tramite decoratori (`@IVoxSettingsService`, `@ILLMMessageService`, ecc.).
- **Azioni (Comandi)**: funzioni registrate con `registerAction2` e richiamabili dalla palette dei comandi (`Ctrl+Shift+P`) o tramite scorciatoie (`Ctrl+L`, `Ctrl+K`). Alcuni ID condivisi (Ctrl+L, Ctrl+K e quelli delle modifiche) sono in `browser/actionIDs.ts`; gli altri sono definiti accanto alle loro azioni.
- **Registrazione frontend**: `browser/vox.contribution.ts` importa tutti i contributi e i servizi principali di Vox all'avvio del workbench.

---

## Canali IPC e servizi principali

### Canali IPC (`browser`/`common` ↔ `electron-main`)

- **LLM e modelli**: `common/sendLLMMessageService.ts` (`ILLMMessageService`) comunica sul canale `vox-channel-llmMessage` con `electron-main/sendLLMMessageChannel.ts` (`LLMMessageChannel`). Espone i comandi `sendLLMMessage`, `abort`, `cliAgentList`, `cliAgentModels`, `voxLocalList` e gli eventi in streaming `onText_sendLLMMessage`, `onFinalMessage_sendLLMMessage`, `onError_sendLLMMessage`, oltre agli eventi di risposta dell'elenco dei modelli locali (`onSuccess_list_voxLocal`, `onError_list_voxLocal`).
- **Server MCP**: `common/mcpService.ts` (`IMCPService`) comunica sul canale `vox-channel-mcp` con `electron-main/mcpChannel.ts` (`MCPChannel`), che avvia i server di `~/.vox/mcp.json` (stdio, HTTP o SSE). Un server spento dall'utente non viene avviato; alla chiusura di Vox i server avviati si chiudono.
- **Source Control (messaggi di commit)**: `browser/voxSCMService.ts` comunica con `electron-main/voxSCMMainService.ts`, esposto come canale `vox-channel-scm` con `ProxyChannel`. Tutti i canali sono registrati in `src/vs/code/electron-main/app.ts`.
- **Informazioni di debug**: `common/voxDebugInfoService.ts` (`IVoxDebugInfoService`) usa `ProxyChannel.toService` sul canale `vox-channel-debug-info` con `electron-main/voxDebugInfoMainService.ts`, per il comando «Vox: Log Debug Info» (versione e sistema operativo, mostrati solo sul PC). Vox non raccoglie statistiche d'uso.

### Servizi di impostazioni, file, chat e modifiche

- **Impostazioni (`common/voxSettingsService.ts`, `common/voxSettingsTypes.ts`)**: `IVoxSettingsService` conserva lo stato `VoxSettingsState` con le configurazioni per fornitore (`settingsOfProvider`), il modello scelto per ogni `FeatureName` (`'Chat' | 'Ctrl+K' | 'Autocomplete' | 'Apply' | 'SCM'`), le opzioni per modello, gli override e le impostazioni globali (`GlobalSettings`, tra cui `ChatMode`: `'agent' | 'gather' | 'normal'`).
- **Modelli di testo (`common/voxModelService.ts`)**: `IVoxModelService` mantiene i riferimenti ai modelli `ITextModel` aperti tramite URI e gestisce lettura, scrittura e salvataggio sicuro (`saveModel`).
- **Applicazione delle modifiche (`browser/editCodeService.ts`)**: `IEditCodeService` gestisce **Apply** (chiamato dall'utente, dallo strumento di modifica dell'agente e da `Ctrl+K`) in due modalità:
  - **Fast Apply**: chiede al modello blocchi `<<<<<<< ORIGINAL` / `=======` / `>>>>>>> UPDATED` per aggiornare file lunghi senza riscriverli per intero;
  - **Slow Apply**: riscrive l'intero contenuto del file.
  Le modifiche sul file vengono tracciate tramite le `DiffArea`, le aree che seguono le righe modificate; la `DiffZone` è la sola in streaming e ha il suo token di annullamento.
- **Stato di approvazione (`browser/voxCommandBarService.ts`)**: `IVoxCommandBarService` legge i dati di `editCodeService` e mantiene lo stato ordinato per file e per diff, permettendo all'utente di scorrere, accettare o rifiutare le modifiche.
- **Chat, prompt e strumenti**: `browser/chatThreadService.ts` gestisce i thread e i checkpoint; `browser/convertToLLMMessageService.ts` prepara i messaggi e stima i token; `browser/toolsService.ts` implementa gli strumenti dell'agente; `browser/autocompleteService.ts` gestisce il completamento inline; `browser/projectContextService.ts` e `common/projectContext.ts` caricano e tengono in cache il contesto del progetto nella cartella `.vox/` (`instructions.md`, `memory.md` e `knowledge/`).

---

## Interfaccia React (`browser/react/`)

L'interfaccia utente di Vox è scritta in React + Tailwind CSS e viene compilata per il browser con una pipeline a tre stadi definita in `browser/react/build.js` (`npm run buildreact` o `npm run watchreact`):

```text
browser/react/src/  ──(scope-tailwind)──▶  browser/react/src2/  ──(tsup)──▶  browser/react/out/
```

1. **`src/`**: sorgenti TSX, componenti, stili e utilità di collegamento ai servizi VS Code (`src/util/services.tsx` e `mountFnGenerator.tsx`).
2. **`src2/`**: cartella intermedia generata da `scope-tailwind` con scope `vox-scope` e prefisso classi `vox-` (`npx scope-tailwind ./src -o src2/ -s vox-scope -c styles.css -p "vox-"`), per isolare gli stili Tailwind dal resto di VS Code.
3. **`out/`**: bundle ESM generati da `tsup` (`browser/react/tsup.config.js`), con CSS incorporato (`injectStyle: true`) e import verso il resto del workbench mantenuti esterni.

I punti di ingresso configurati in `tsup.config.js` sono:
- `vox-editor-widgets-tsx`
- `sidebar-tsx`
- `vox-settings-tsx`
- `vox-tooltip`
- `vox-onboarding`
- `quick-edit-tsx`
- `diff`

I file in `browser/` (ad esempio `sidebarPane.ts`, `voxSettingsPane.ts`, `voxCommandBarService.ts`, `editCodeService.ts`) importano le funzioni `mount...` da `./react/out/.../index.js` e montano i componenti passando il `ServicesAccessor` del workbench.

---

## Pipeline dei messaggi LLM (`electron-main/llmMessage/`)

Il flusso di una richiesta chat dalla sidebar o dall'editor al fornitore segue questo percorso:

```text
React / editCodeService
  └─▶ convertToLLMMessageService.ts
        └─▶ common/sendLLMMessageService.ts (IPC: vox-channel-llmMessage)
              └─▶ electron-main/sendLLMMessageChannel.ts
                    └─▶ electron-main/llmMessage/sendLLMMessage.ts
                          └─▶ electron-main/llmMessage/sendLLMMessage.impl.ts
```

- **`sendLLMMessage.ts`**: gestisce gli eventi `onText`, `onFinalMessage`, `onError` e la funzione di annullamento (`abortRef`). Non prepara né invia statistiche d'uso.
- **`sendLLMMessage.impl.ts`**: associa ogni `ProviderName` in `sendLLMMessageToProviderImplementation` (`sendChat`, `sendFIM`, `list`). I fornitori sono solo due:
  - `voxLocal`: chat, completamento automatico (`sendFIM`, in `voxLocalFIM.ts`, tramite `/infill` di llama-server) ed elenco dei modelli. Il client `openai` viene creato solo da `newVoxLocalSDK`, che accetta soltanto indirizzi di questo PC (`isLoopbackURL`) e non segue i reindirizzamenti (`withoutRedirects`, in `providerGuard.ts`); lo stesso vale per `/infill`.
  - `cliAgent`: solo chat (`sendFIM` e `list` sono `null`).
- **`providerGuard.ts`**: `isAllowedProviderName` è il primo controllo di `sendLLMMessage`: una richiesta per un fornitore diverso da `voxLocal` e `cliAgent` viene rifiutata prima di leggere impostazioni o avviare qualcosa.
- **Fornitori tolti (`common/removedProviders.ts`, `common/removedProvidersNotice.ts`)**: l'elenco dei sedici fornitori tolti da Vox (i servizi in cloud e i server locali come Ollama, LM Studio e vLLM), la pulizia delle loro chiavi API dalle impostazioni salvate (`cleanRemovedProviders`) e l'avviso mostrato una volta dopo l'aggiornamento (`browser/removedProvidersNoticeContrib.ts`). La prova `electron-main/llmMessage/onlyLocalAndCli.test.mjs` controlla che non tornino librerie, fornitori o indirizzi di servizi in cloud.
- **`common/modelCapabilities.ts`**: definisce `defaultProviderSettings`, i modelli predefiniti e le capacità dei modelli (finestra di contesto, ragionamento, FIM, supporto tool).

---

## Agenti CLI (`cliAgent`)

Il provider `cliAgent` permette di usare strumenti CLI già installati e autenticati dall'utente, senza chiavi API in Vox. L'implementazione è in `electron-main/llmMessage/cliAgents.ts`; la guida tecnica dettagliata è in `electron-main/llmMessage/CLI_AGENTS.md`.

- **CLI supportate in `CLI_AGENTS`**: `codex`, `agy`, `devin`, `copilot`, `opencode`, `kimi`, `claude`.
- **Rilevamento e formato modelli**: cerca gli eseguibili con `where.exe` (Windows) o `which` (altri sistemi) senza avviare le IA. Nel selettore della chat il valore salvato è `<ia>` oppure `<ia>:<modello>`.
- **Sicurezza dell'avvio**: usa sempre `spawn(..., { shell: false })`. Su Windows gli shim `.cmd` di npm vengono risolti allo script JS sottostante e lanciati con Node (`ELECTRON_RUN_AS_NODE`). I prompt lunghi oltre 12.000 caratteri passano via `stdin` per Codex e Claude o come allegato temporaneo per OpenCode.
- **Permessi**: chat normale e raccolta usano profili di sola lettura; la modalità agente abilita la modifica dei file nella prima cartella locale del workspace solo dopo consenso esplicito dell'utente (`kimi` resta sempre in sola lettura).
- **Timeout e output**: il timeout predefinito è 600 secondi e termina l'albero dei processi (`taskkill /T /F` su Windows). `devin`, `copilot` e `claude` inviano lo streaming stdout ripulito dalle sequenze ANSI; `codex`, `opencode`, `kimi` e `agy` restituiscono la risposta finale estratta dagli eventi JSON.

---

## IA locali (`voxLocal`)

Il provider `voxLocal` avvia e gestisce in locale modelli `.gguf` tramite `llama-server.exe` (`llama.cpp`). La logica è in `electron-main/llmMessage/localModels.ts` (`LocalModelManager`) insieme a `electron-main/llmMessage/localContextFit.ts`.

- **Ricerca della cartella `ia-locali`**: se nelle impostazioni il campo cartella è vuoto, Vox cerca `modelli.json` in:
  1. `<cartella dell'eseguibile di Vox>/ia-locali`
  2. `~/.vox/ia-locali`
  3. `X:\Vox\ia-locali` sulle unità Windows da `C:` a `Z:`
- **Manifesto `modelli.json`**: indica `motore` (percorso relativo alla cartella, es. `motore/llama-server.exe`) e la lista `modelli` con `nome`, `file` (nome del `.gguf` in `modelli/`), `contesto`, `porta`, `uso` (`chat`, `completamento` o `embedding`), `opzioni` e `descrizione` opzionale. Dalla chat Vox avvia soltanto i modelli con `"uso": "chat"`, uno alla volta per porta, e chiude i processi avviati alla chiusura dell'app.
- **Adattamento al contesto**: se `llama-server` segnala che il prompt supera il contesto configurato, `localContextFit.ts` accorcia i messaggi più vecchi preservando la richiesta corrente, e `sendLLMMessage.impl.ts` riprova fino a 3 volte (`MAX_CONTEXT_RETRIES`).
- **Aggiornamento periodico**: `common/refreshModelService.ts`, con l'opzione `autoRefreshModels` attiva, interroga periodicamente `voxLocal` per aggiornare la lista dei modelli disponibili, le finestre di contesto e i modelli di completamento (salvati con `common/voxLocalModelInfo.ts`).

---

## Localizzazione (`common/voxI18n.ts`)

`common/voxI18n.ts` esporta la funzione `t(english, ...parameters)` usata nei sorgenti di Vox: quando `language === 'it'` (da `base/common/platform.js`), restituisce la stringa italiana corrispondente dal dizionario `it` e sostituisce i segnaposto posizionali `{0}`, `{1}`, ecc.
