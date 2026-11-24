# Vox

Vox è un ambiente di sviluppo con l'intelligenza artificiale integrata, basato su Visual Studio Code 1.99.3. Si usa come un normale editor. In più ha una chat che legge e modifica il codice del progetto, la modifica rapida del codice selezionato e il completamento automatico.

L'IA di Vox gira sul PC, con modelli locali, oppure passa dagli agenti da riga di comando che l'utente ha già installato. Vox non ha fornitori in cloud da configurare con una chiave API.

**Versione attuale: 1.0.0** (vedi [CHANGELOG.md](CHANGELOG.md)).

## Cosa fa

- **Chat sul codice**, con tre modalità:
  - domanda semplice;
  - raccolta di informazioni, che legge il progetto senza cambiarlo;
  - agente, che usa gli strumenti: legge e scrive i file, usa il terminale e cerca nel progetto.

  Ogni messaggio ha un punto di ripristino: si può tornare indietro e rimettere com'erano i file che l'agente ha cambiato con `edit_file` e `rewrite_file`. I file creati o cancellati dall'agente, e quelli cambiati dal terminale o da un'IA in CLI, restano come sono. Una riga sopra la casella dei messaggi dice quanta parte della finestra di contesto del modello occupa la richiesta; un clic apre il dettaglio.
- **Modifica rapida** (Ctrl+K) del codice selezionato, con la revisione delle modifiche proposte: si accettano o si rifiutano una per una, o per file intero.
- **Completamento automatico** con un modello locale.
- **Messaggi di commit** proposti dall'IA nel controllo del codice sorgente.
- **Contesto del progetto**: le istruzioni per l'IA nel file `.voxrules` e nella cartella `.vox/` del progetto (`instructions.md`, `memory.md`, `knowledge/`).
- **Server MCP** aggiunti dall'utente, i cui strumenti l'agente può usare.
- **Interfaccia in italiano**, compresi i testi di Vox e il pacchetto della lingua di VS Code.

## I due motori dell'IA

### IA locali

Modelli GGUF eseguiti sul PC con [llama.cpp](https://github.com/ggml-org/llama.cpp). Le richieste restano sul PC: Vox parla con i modelli solo su `127.0.0.1` e non segue i reindirizzamenti.

I modelli stanno nella cartella `ia-locali`, che non fa parte del repository. La cartella contiene:

- `modelli.json`, l'elenco dei modelli;
- il motore di llama.cpp, indicato in `modelli.json` (di solito `motore/llama-server.exe`);
- i file `.gguf`, in `modelli/`.

Se nelle Impostazioni di Vox il campo della cartella è vuoto, Vox la cerca, nell'ordine:

1. accanto all'eseguibile di Vox;
2. in `~/.vox/ia-locali`;
3. in `X:\Vox\ia-locali`, sulle unità da `C:` a `Z:`.

Per cominciare:

1. crea la cartella `ia-locali` in uno dei posti qui sopra;
2. metti in `motore/` il `llama-server.exe` di una release di [llama.cpp](https://github.com/ggml-org/llama.cpp/releases), con le sue librerie;
3. scrivi `modelli.json`. All'inizio l'elenco dei modelli può essere vuoto:

   ```json
   {
     "motore": "motore/llama-server.exe",
     "modelli": []
   }
   ```

4. scarica i modelli dalla libreria, nelle Impostazioni di Vox, che aggiunge da sola le voci in `modelli.json`.

Ogni voce di `modelli.json` ha questi campi:

- `nome`;
- `file`, il `.gguf` in `modelli/`;
- `contesto`, in token;
- `porta`, la porta locale di llama-server;
- `uso`, che vale `chat`, `completamento` o `embedding`;
- `opzioni` e `descrizione`, facoltativi.

Le Impostazioni di Vox mostrano un esempio completo.

Vox avvia un modello quando serve e lo chiude all'uscita. Il completamento automatico usa il modello che in `modelli.json` ha `"uso": "completamento"`, attraverso l'endpoint `/infill` di llama.cpp.

La **libreria dei modelli**, nelle Impostazioni di Vox, fa queste cose:

- elenca i modelli installati;
- ne cambia il contesto;
- li toglie, mettendo i file nel Cestino;
- ne scarica di nuovi da Hugging Face, dall'elenco consigliato, da un indirizzo incollato o dalla ricerca. Ogni file scaricato si controlla con la dimensione e, quando è noto, con lo SHA-256.

### IA in CLI

Vox può usare come motore della chat gli agenti da riga di comando già installati e autenticati sul PC:

- Codex;
- Claude;
- Antigravity;
- Devin;
- Copilot;
- OpenCode;
- Kimi.

Le richieste passano dalla CLI scelta, che parla con il proprio servizio usando l'accesso dell'utente. In modalità agente la CLI può modificare i file solo nella prima cartella del progetto, e solo dopo il consenso dell'utente; Kimi resta sempre in sola lettura. I dettagli tecnici sono in [CLI_AGENTS.md](src/vs/workbench/contrib/vox/electron-main/llmMessage/CLI_AGENTS.md).

## Riservatezza

- Vox non invia statistiche d'uso e non cerca aggiornamenti di sé stesso su un server.
- Come VS Code, Vox calcola all'avvio alcuni identificativi della macchina e li conserva sul PC. Non li usa per statistiche e il programma impacchettato non li manda a nessuno: le richieste della vista Estensioni li aggiungerebbero solo con le statistiche d'uso attive, che Vox non ha. Fa eccezione la finestra di sviluppo (`scripts/code.bat`, `scripts/code.sh`), che come VS Code li aggiunge.
- Per l'IA, Vox parla solo con i modelli locali su `127.0.0.1` e con le CLI scelte dall'utente, che contattano i loro servizi.
- I server MCP aggiunti dall'utente possono essere remoti: in quel caso ricevono le chiamate agli strumenti che offrono.
- La libreria dei modelli usa Internet solo quando l'utente scarica o cerca un modello, e solo verso Hugging Face. A Hugging Face arrivano soltanto queste cose, senza conversazioni, codice o impostazioni:
  - l'indirizzo del file da scaricare;
  - il testo cercato;
  - il nome del repository.
- La chat non carica immagini da un indirizzo scritto nelle risposte dell'IA: un indirizzo `http` o `https` diventa un collegamento, che si apre solo con un clic. I collegamenti nelle risposte aprono solo pagine web e indirizzi di posta.
- La vista Estensioni è quella di VS Code, ma cerca, installa e aggiorna le estensioni da [Open VSX](https://open-vsx.org), il registro aperto della Eclipse Foundation, non dal Marketplace di Visual Studio, riservato ai prodotti Microsoft. Alcune estensioni di Microsoft (per esempio C#, Pylance e Remote) su Open VSX non ci sono. Open VSX si interroga anche per gli aggiornamenti delle estensioni installate: si può spegnere con le impostazioni `extensions.autoCheckUpdates` ed `extensions.autoUpdate`.

## Requisiti

- Node.js **20.18.2**, la versione indicata in [.nvmrc](.nvmrc), per installare le dipendenze e compilare.
- Node.js **22.18 o successivo** per i test di Vox.
- Windows: Visual Studio 2022 (o Build Tools) con i carichi di lavoro "Sviluppo di applicazioni desktop con C++" e "Strumenti di compilazione Node.js", più le librerie MSVC v143 con mitigazioni Spectre.
- macOS: Python e Xcode.
- Linux: `build-essential`, `g++`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`, `libkrb5-dev` (o gli equivalenti della distribuzione).

I dettagli sono in [HOW_TO_CONTRIBUTE.md](HOW_TO_CONTRIBUTE.md).

## Compilare e avviare in sviluppo

```sh
git clone https://github.com/angelorau90pro-coder/Vox.git
cd Vox
npm install
npm run buildreact
npm run watch
```

Quando `npm run watch` dice di aver finito la compilazione senza errori, apri un altro terminale e avvia Vox:

- Windows: `.\scripts\code.bat`
- macOS e Linux: `./scripts/code.sh`

Le modifiche al codice compaiono ricaricando la finestra (Ctrl+R). Le modifiche alla parte React (`src/vs/workbench/contrib/vox/browser/react/src`) richiedono di nuovo `npm run buildreact`, oppure `npm run watchreact` in un terminale a parte.

## Verifiche

I test di Vox, col Node di sistema versione 22.18 o successiva (il Node 20 di `.nvmrc` non ha `stripTypeScriptTypes`):

```sh
node --test $(git ls-files -co --exclude-standard 'src/vs/workbench/contrib/vox/*.test.mjs')
```

Il comando prende i test registrati in git e quelli nuovi non ancora aggiunti, ma non i file che git ignora, e funziona sia in PowerShell sia in bash. Un percorso con `**` prenderebbe anche le copie vecchie che `npm run buildreact` lascia in `browser/react/src2/` (ignorata da git), e quelle falliscono.

Il controllo dei tipi su tutto il codice, che richiede qualche minuto:

```sh
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p src/tsconfig.json --noEmit
```

I test leggono il TypeScript togliendo i tipi, quindi non vedono gli errori di tipo: il controllo con tsc va fatto sempre.

## Pacchetto e installer per Windows

Il repository non pubblica pacchetti pronti: l'app si costruisce dai sorgenti.

1. Dopo `npm install` non serve altro per l'interfaccia React: la compilazione del pacchetto (`compile-build`) esegue prima `npm run buildreact` da sola (il passo `vox-buildreact`). Per saltarlo, con un bundle appena compilato, imposta `VOX_SKIP_BUILDREACT=1`.
2. Su un PC senza Windows 10 SDK, dopo ogni `npm install`, esegui `node build/vox-pacchetto/gulp-electron-senza-sdk.mjs`.
3. `npm run gulp vscode-win32-x64` crea l'app in `..\VSCode-win32-x64` (circa 9 minuti). La variante `-min` oggi non funziona.
4. `npm run gulp vscode-win32-x64-inno-updater`, poi `npm run gulp vscode-win32-x64-user-setup`, crea `.build/win32-x64/user-setup/VoxSetup.exe`.

L'app si può usare anche senza installarla, come copia portatile: una cartella `data` accanto all'eseguibile tiene impostazioni, conversazioni ed estensioni, come nella modalità portatile di VS Code.

## Limiti noti

- L'installer non è firmato: Windows con Smart App Control attivo lo blocca.
- Vox è provato solo su Windows. I pacchetti per macOS e Linux, compresi gli script AppImage, non sono stati provati.
- Le connessioni remote (SSH e WSL) cercano il server di Vox fra le release del repository, che oggi non lo pubblica: non funzionano finché quei file non ci sono.
- Con più finestre di Vox aperte insieme, le conversazioni salvate da una finestra possono sovrascrivere quelle dell'altra, perché l'archivio delle conversazioni è unico.

## Versionamento

Vox segue il [versionamento semantico](https://semver.org/lang/it/) `MAGGIORE.MINORE.CORREZIONE`:

- **MAGGIORE** per i cambiamenti che rompono la compatibilità (dati salvati, impostazioni, comportamento atteso);
- **MINORE** per le funzioni nuove compatibili;
- **CORREZIONE** per le correzioni di errori.

Dove sta la versione:

- in `product.json`, nel campo `voxVersion` (la versione di Vox, mostrata in Guida → Informazioni su) e nel campo `voxRelease` (il numero progressivo della build, a quattro cifre);
- in `package.json`, nel campo `version`, che resta **1.99.3**: è la versione di VS Code su cui si basa Vox, e le estensioni e il sistema di build si appoggiano a quella;
- nei tag git `vMAGGIORE.MINORE.CORREZIONE` (per esempio `v1.0.0`), uno per ogni versione pubblicata;
- in [CHANGELOG.md](CHANGELOG.md), con le modifiche di ogni versione.

Per una nuova versione:

1. aggiorna `voxVersion` e `voxRelease`;
2. aggiorna la riga «Versione attuale» di questo file;
3. aggiungi la voce in `CHANGELOG.md`;
4. fai il commit e crea il tag.

## Struttura del codice

- `src/vs/workbench/contrib/vox/` contiene quasi tutto il codice di Vox:
  - `browser/`: i servizi dell'interfaccia (chat, modifiche, completamento, impostazioni) e la parte React, in `browser/react/`;
  - `common/`: tipi, impostazioni, prompt, localizzazione (`voxI18n.ts`) e servizi condivisi;
  - `electron-main/`: il processo principale, con le chiamate ai modelli (`llmMessage/`), gli agenti CLI, le IA locali e i server MCP.
- Il resto di `src/` è Visual Studio Code, con poche modifiche segnate da commenti `// Vox`.
- `extensions/open-remote-ssh` ed `extensions/open-remote-wsl` sono le connessioni remote.
- `build/vox-pacchetto/` e `build/vox-icone/` contengono l'adattamento del pacchetto e la generazione delle icone.

La guida completa è in [VOX_CODEBASE_GUIDE.md](VOX_CODEBASE_GUIDE.md).

## Licenza

Vox è distribuito con licenza Apache 2.0 ([LICENSE.txt](LICENSE.txt)). Contiene:

- codice di Glass Devtools, Inc., con licenza Apache 2.0;
- codice di Visual Studio Code di Microsoft Corporation, con licenza MIT ([LICENSE-VS-Code.txt](LICENSE-VS-Code.txt)).

Le attribuzioni sono in [NOTICE](NOTICE) e in [ThirdPartyNotices.txt](ThirdPartyNotices.txt). Vox non è un prodotto di Microsoft né di Glass Devtools.
