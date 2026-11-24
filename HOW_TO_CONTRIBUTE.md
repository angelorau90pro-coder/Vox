# Come contribuire a Vox

Benvenuto nella guida per contribuire a Vox, un IDE AI basato su Visual Studio Code 1.99.3.

- Repository: `https://github.com/angelorau90pro-coder/Vox`
- Segnalazioni e richieste: [Issues su GitHub](https://github.com/angelorau90pro-coder/Vox/issues)
- Architettura del codice: [Guida al codice di Vox](./VOX_CODEBASE_GUIDE.md)

La maggior parte del codice di Vox si trova in `src/vs/workbench/contrib/vox/`.

---

## Prerequisiti

In tutti i sistemi operativi serve **Node.js `20.18.2`** (la versione indicata in `.nvmrc`) per installare le dipendenze e compilare. Per i test di Vox serve anche un Node **22.18 o successivo** (vedi «Verifiche e test»). Con [nvm](https://github.com/nvm-sh/nvm) puoi attivarla localmente senza cambiare la versione globale:

```bash
nvm install
nvm use
```

### Windows

Installa [Visual Studio 2022](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=Community) (consigliato) oppure [VS Build Tools](https://visualstudio.microsoft.com/thank-you-downloading-visual-studio/?sku=BuildTools).

Nella scheda **Workloads** seleziona:
- `Desktop development with C++`
- `Node.js build tools`

Nella scheda **Individual Components** seleziona:
- `MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)`
- `C++ ATL for latest build tools with Spectre Mitigations`
- `C++ MFC for latest build tools with Spectre Mitigations`

### macOS

Servono Python e Xcode (di solito già presenti o installabili tramite Xcode Command Line Tools).

### Linux

Installa prima `node-gyp` (`npm install -g node-gyp`), poi i pacchetti di sviluppo della tua distribuzione:

- **Debian / Ubuntu**:
  `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
- **Red Hat / Fedora**:
  `sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel`
- **SUSE / openSUSE**:
  `sudo zypper install patterns-devel-C-C++-devel_C_C++ krb5-devel libsecret-devel libxkbfile-devel libX11-devel`
- **Altre distribuzioni**: consulta la guida ufficiale [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) di VS Code.

---

## Avvio in modalità sviluppatore

1. Clona il repository:
   ```bash
   git clone https://github.com/angelorau90pro-coder/Vox.git
   ```
2. Installa le dipendenze:
   ```bash
   npm install
   ```
3. Avvia la compilazione continua (la prima esecuzione richiede qualche minuto):
   - Da VS Code / Vox: premi `Ctrl+Shift+B` (Windows/Linux) oppure `Cmd+Shift+B` (macOS).
   - Da terminale: esegui prima `npm run buildreact` (la parte React di Vox, che `watch` non compila), poi `npm run watch`. La compilazione iniziale è pronta quando entrambi i watcher mostrano `Finished compilation ... with 0 errors`.
4. Avvia la finestra di sviluppo di Vox:
   - Windows: `./scripts/code.bat`
   - macOS / Linux: `./scripts/code.sh`
   - Per isolare dati utente ed estensioni di prova (cancellabili eliminando `.tmp`), aggiungi `--user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions`.
5. Dopo aver modificato il codice:
   - Ricarica la finestra di sviluppo con `Ctrl+R` (`Cmd+R` su macOS) oppure con `Reload Window` dalla palette dei comandi (`Ctrl+Shift+P` / `Cmd+Shift+P`).
   - Se modifichi i componenti React in `src/vs/workbench/contrib/vox/browser/react/`, compila il bundle con `npm run buildreact` (oppure avvia `npm run watchreact` durante lo sviluppo).
   - Per fermare gli script nel terminale premi `Ctrl+D` (`Ctrl+C` può lasciare processi di build in background).

---

## Problemi comuni

- **Versione di Node errata**: verifica di usare `20.18.2` (`.nvmrc`).
- **Spazi nel percorso**: assicurati che il percorso della cartella del progetto non contenga spazi.
- **`TypeError: Failed to fetch dynamically imported module`**: controlla che tutti gli `import` TypeScript usino l'estensione `.js`.
- **Errore di memoria in React**: esegui `npm run buildreact` con più memoria:
  - Bash/zsh: `NODE_OPTIONS="--max-old-space-size=8192" npm run buildreact`
  - PowerShell: `$env:NODE_OPTIONS="--max-old-space-size=8192"; npm run buildreact`
- **Stili mancanti**: attendi qualche secondo dopo il caricamento e ricarica la finestra (`Ctrl+R`).
- **macOS (`libtool: error: unrecognised option: '-static'`)**: installa e usa GNU `libtool` al posto di BSD `libtool` predefinito su macOS.
- **Linux (`The SUID sandbox helper binary was found, but is not configured correctly`)**:
  ```bash
  sudo chown root:root .build/electron/chrome-sandbox && sudo chmod 4755 .build/electron/chrome-sandbox
  ```

---

## Verifiche e test

- **Controllo dei tipi TypeScript** (dalla root del progetto):
  ```bash
  node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p src/tsconfig.json --noEmit
  ```
- **Test unitari di Vox**: esegui `node --test` sui file `*.test.mjs` dentro `src/vs/workbench/contrib/vox/` usando un **Node 22.18 o successivo**: i test usano `stripTypeScriptTypes` di `node:module`, che non esiste in Node 20. Il Node 20.18.2 di `.nvmrc` serve per `npm install` e per la compilazione. Ad esempio in PowerShell:
  ```powershell
  node --test $(git ls-files -co --exclude-standard 'src/vs/workbench/contrib/vox/*.test.mjs')
  ```
  Il comando prende i test registrati in git e quelli nuovi non ancora aggiunti, ma non i file che git ignora: una ricerca su tutta la cartella troverebbe anche le copie vecchie che `npm run buildreact` lascia in `browser/react/src2/` (ignorata da git).

---

## Creazione dell'eseguibile e dell'installer

### Preparazione su Windows senza Windows 10 SDK

Se il PC Windows non ha il Windows 10 SDK installato, il modulo `@vscode/gulp-electron` non trova `signtool` per rimuovere la firma da `electron.exe`. Prima di impacchettare (e dopo ogni `npm install`), esegui:

```bash
node build/vox-pacchetto/gulp-electron-senza-sdk.mjs
```

### Eseguibile locale

Per generare l'eseguibile Windows x64 (nella cartella `VSCode-win32-x64` accanto al repository):

```bash
npm run gulp vscode-win32-x64
```

> **Nota**: usa `vscode-win32-x64` e non la variante `-min` (`vscode-win32-x64-min`), perché oggi la variante `-min` fallisce nel mangler.

<details>
<summary>Altri target di piattaforma</summary>

- Windows ARM64: `npm run gulp vscode-win32-arm64`
- macOS Apple Silicon: `npm run gulp vscode-darwin-arm64`
- macOS Intel: `npm run gulp vscode-darwin-x64`
- Linux x64: `npm run gulp vscode-linux-x64`
- Linux ARM64: `npm run gulp vscode-linux-arm64`

</details>

### Installer Windows (Inno Setup)

Dopo aver generato l'eseguibile con `npm run gulp vscode-win32-x64`:

1. Prepara l'updater di Inno Setup:
   ```bash
   npm run gulp vscode-win32-x64-inno-updater
   ```
2. Genera l'installer utente:
   ```bash
   npm run gulp vscode-win32-x64-user-setup
   ```

Il comando produce l'installer in `.build/win32-x64/user-setup/VoxSetup.exe`.

`npm run gulp vscode-win32-x64` (come gli altri pacchetti) ricompila da solo l'interfaccia React prima di compilare il resto (passo `vox-buildreact` di `build/gulpfile.compile.js`), così da un clone pulito non manca `browser/react/out` e non si impacchetta un'interfaccia vecchia. Se hai appena eseguito `npm run buildreact` puoi saltare il passo con la variabile d'ambiente `VOX_SKIP_BUILDREACT=1`.

### Icone e immagini

Le immagini del marchio Vox si generano con `node build/vox-icone/vox-icone.mjs` e si controllano con `--verifica`, che confronta dimensioni e formati con quelli attesi.

Prima di distribuire un pacchetto vanno controllate a vista:

- le immagini dell'installer (`resources/win32/inno-*.bmp`);
- le icone `.ico` alle dimensioni piccole;
- l'icona macOS `resources/darwin/code.icns`, rigenerata ma mai provata su un Mac.

### Server remoto (SSH e WSL)

Le connessioni remote scaricano il server di Vox da un indirizzo del tipo `https://github.com/angelorau90pro-coder/Vox/releases/download/${version}/vox-reh-${os}-${arch}-${version}.tar.gz`. Oggi il repository non pubblica quei file, quindi le connessioni SSH e WSL non funzionano. Per pubblicarli:

- nell'indirizzo, `${version}` è la versione di VS Code (1.99.3), non quella di Vox: la release che contiene i file deve avere quel nome, oppure va cambiato il modello dell'indirizzo, in `extensions/open-remote-ssh` ed `extensions/open-remote-wsl`;
- chi usa un server proprio può impostare `remote.SSH.serverDownloadUrlTemplate` o `remote.WSL.serverDownloadUrlTemplate`.

### Cose non ancora provate

- La compilazione, l'avvio e la verifica a vista su macOS e Linux, compresi gli script AppImage in `scripts/appimage/`.
- In `package-lock.json` sono aggiornati solo il nome e la licenza; il resto dei metadati va riallineato alla prossima manutenzione delle dipendenze.

---

## Linee guida per le Pull Request

- Per nuove funzionalità ampie o modifiche su più file, apri prima una segnalazione su [Issues](https://github.com/angelorau90pro-coder/Vox/issues).
- Prima di inviare una pull request, esegui il controllo `tsc --noEmit` e i test `node --test` descritti sopra.
