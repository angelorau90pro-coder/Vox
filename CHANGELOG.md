# Registro delle modifiche

Tutte le modifiche importanti di Vox sono annotate qui. Il formato segue [Keep a Changelog](https://keepachangelog.com/it-IT/1.1.0/) e la numerazione segue il [versionamento semantico](https://semver.org/lang/it/).

## [Non rilasciato]

## [1.0.0] - 2026-11-23

Prima versione pubblica di Vox, basata su Visual Studio Code 1.99.3. Il repository riparte da qui con una storia nuova: le versioni di sviluppo precedenti non sono pubblicate.

### Chat e agente

- Chat sul codice con tre modalità: domanda semplice, raccolta di informazioni e agente che usa gli strumenti (lettura e scrittura dei file, terminale, ricerca, server MCP).
- Gli strumenti dell'agente lavorano dentro la cartella del progetto:
  - un percorso relativo si risolve nel progetto;
  - un percorso fuori dal progetto, o che passa da un collegamento, chiede conferma all'utente anche con l'approvazione automatica;
  - la cartella del progetto non si può cancellare;
  - i percorsi non validi (variabili da espandere, flussi nascosti di Windows, nomi di dispositivo) danno un errore che dice cosa passare.
- `rewrite_file` crea il file se manca. `edit_file` e `rewrite_file` non dicono mai «riuscito» se la modifica non è finita sul disco.
- Ogni messaggio ha un punto di ripristino. Tornandoci, Vox rimette il contenuto che avevano in quel momento i file del progetto cambiati dall'agente con `edit_file` e `rewrite_file`, anche quelli mai aperti in Vox. I file creati o cancellati dall'agente, e quelli cambiati dal terminale o da un'IA in CLI, restano come sono.
- Una riga sopra la casella dei messaggi dice quanta parte della finestra di contesto del modello occupa la prossima richiesta. Un clic apre la scheda «Contesto della chat», con le voci che la compongono e gli avvisi quando il contesto si riempie.
- Modifica rapida (Ctrl+K) del codice selezionato, con la revisione delle modifiche: si accettano o si rifiutano una per una, o per file intero.
- Messaggi di commit proposti dall'IA.
- Contesto del progetto: istruzioni per l'IA in `.voxrules` e nella cartella `.vox/` (`instructions.md`, `memory.md`, `knowledge/`).

### IA locali

- Modelli GGUF eseguiti sul PC con llama.cpp, dalla cartella `ia-locali` descritta da `modelli.json`. Le richieste partono solo verso `127.0.0.1` e non seguono i reindirizzamenti.
- Completamento automatico con il modello che ha `"uso": "completamento"`, attraverso l'endpoint `/infill`.
- Il messaggio di sistema si riusa nella conversazione finché non cambiano le sue premesse: llama-server non rilegge tutto il prompt a ogni richiesta.
- Quando la richiesta non entra nel contesto del modello, Vox accorcia i messaggi più vecchi e conserva la richiesta corrente.
- Sotto ogni risposta: token al secondo, token generati e totale con il prompt.
- Libreria dei modelli, nelle Impostazioni di Vox:
  - elenca i modelli installati, ne cambia il contesto e li toglie, mettendo i file nel Cestino;
  - scarica da Hugging Face dall'elenco consigliato, da un indirizzo incollato o dalla ricerca;
  - lo scarico si può mettere in pausa e riprendere, e il file si controlla con la dimensione e, quando è noto, con lo SHA-256;
  - un modello il cui file manca si può scaricare di nuovo senza cambiare la sua voce.

### IA in CLI

- Gli agenti da riga di comando già installati e autenticati sul PC fanno da motore della chat: Codex, Claude, Antigravity, Devin, Copilot, OpenCode e Kimi.
- Vox li avvia senza shell. In modalità agente possono modificare i file solo nella prima cartella del progetto, dopo il consenso dell'utente; Kimi resta sempre in sola lettura.

### Riservatezza

- Nessuna statistica d'uso.
- Nessun fornitore di IA in cloud: il processo principale rifiuta ogni richiesta che non sia per le IA locali o per le IA in CLI.
- Il codice di Vox fa partire da sé verso Internet solo lo scarico e la ricerca dei modelli, solo verso Hugging Face. In più contatta i server MCP remoti che l'utente aggiunge.
- La vista Estensioni è quella di VS Code, ma usa [Open VSX](https://open-vsx.org) al posto del Marketplace di Visual Studio, riservato ai prodotti Microsoft. Alcune estensioni di Microsoft su Open VSX non ci sono. Le sue richieste non portano gli identificativi della macchina.
- La chat non carica immagini da un indirizzo scritto dall'IA, e i collegamenti nelle risposte aprono solo pagine web e indirizzi di posta.

### Interfaccia

- Interfaccia in italiano, compresi i testi di Vox e il pacchetto della lingua di VS Code.
- Versione di Vox (`voxVersion` 1.0.0) e numero della build (`voxRelease` 0005) in Guida → Informazioni su.

### Dati salvati

- Vox legge soltanto le sue chiavi di salvataggio, i suoi nomi dei campi delle chat, il file `.voxrules` e il terminale «Vox Agent». I nomi usati dalle versioni di sviluppo prima della rinomina non si leggono più: chi ha ancora dati salvati con quei nomi li ritrova solo esportandoli prima da una versione di sviluppo.

### Limiti noti

- L'installer non è firmato: Windows con Smart App Control attivo lo blocca.
- Vox è provato solo su Windows. I pacchetti per macOS e Linux, compresi gli script AppImage, non sono stati provati.
- Le connessioni remote (SSH e WSL) cercano il server di Vox fra le release del repository, che oggi non lo pubblica: non funzionano finché quei file non ci sono.
- Con più finestre di Vox aperte insieme, le conversazioni salvate da una finestra possono sovrascrivere quelle dell'altra.
- Se l'utente cambia file mentre l'agente lavora, il modello lo viene a sapere al messaggio successivo.
