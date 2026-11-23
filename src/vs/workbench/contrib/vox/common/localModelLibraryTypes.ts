/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Contratti della libreria dei modelli locali: scaricare un modello nuovo nella cartella `ia-locali` e togliere
// quelli che non servono più. Questo file non importa niente: lo leggono il processo principale, il renderer e i test.
//
// Regola di sicurezza: lo scarico dei modelli è l'unico punto di Vox che parla con Internet, e non riceve mai
// conversazioni, codice o impostazioni dell'utente. Le richieste dell'IA restano solo verso questo PC
// (`electron-main/llmMessage/providerGuard.ts`).

export type LocalModelUse = 'chat' | 'completamento' | 'embedding'

// Canale IPC fra renderer e processo principale, separato da quello delle richieste dell'IA.
export const LOCAL_MODEL_LIBRARY_CHANNEL = 'vox-channel-local-model-library'

// Porta predefinita per uso, come in `ia-locali/LEGGIMI.md`: i modelli da chat condividono la stessa porta.
export const defaultPortOfLocalModelUse: Readonly<Record<LocalModelUse, number>> = { chat: 8192, completamento: 8193, embedding: 8194 }

// Stesse regole di `readManifest` in `electron-main/llmMessage/localModels.ts`.
export const LOCAL_MODEL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
export const LOCAL_MODEL_FILE_PATTERN = /^[^\\/:]+\.gguf$/i
// Nome di un file che Vox scarica: oltre alla regola qui sopra, niente caratteri che Windows rifiuta, niente caratteri
// di controllo e nessun nome di dispositivo (`NUL.gguf` scriverebbe nel nulla). Vale per i file nuovi: un file già
// scritto a mano in `modelli.json` resta valido con la regola di `readManifest`.
export const isDownloadableLocalModelFileName = (file: string): boolean =>
	typeof file === 'string' && file.length <= 200 && LOCAL_MODEL_FILE_PATTERN.test(file)
	&& !/[<>"|?*\x00-\x1f\x7f]/.test(file) && !/^[ .]/.test(file) && !/^\.+$/.test(file.slice(0, -5))
	&& !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(file.slice(0, -5))
// Due nomi di file indicano lo stesso file? Su Windows e macOS le maiuscole non contano: si confronta sempre senza,
// perché sbagliare da questa parte lascia un file in più, sbagliare dall'altra ne toglie uno ancora usato.
export const isSameLocalModelFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const LOCAL_MODEL_MIN_CONTEXT = 512
export const LOCAL_MODEL_MAX_CONTEXT = 1048576

// Un modello dell'elenco consigliato. `repo` e `file` indicano il file pubblico su Hugging Face
// (`https://huggingface.co/<repo>/resolve/<revisione>/<file>`); `bytes` e `sha256` servono al controllo dopo lo scarico.
export type LocalModelCatalogEntry = {
	id: string,
	nome: string,
	descrizione: string,
	uso: LocalModelUse,
	contesto: number,
	repo: string,
	revisione: string,
	file: string,
	bytes: number,
	sha256: string | null,
	// opzioni di llama-server, con le stesse regole di `modelli.json` (`{cartella}` vale la cartella `ia-locali`)
	opzioni: string[],
}

// Cosa scaricare: una voce dell'elenco consigliato, oppure l'indirizzo di un file `.gguf` incollato dall'utente.
// `bytes` e `sha256`: dimensione e SHA-256 che Hugging Face dichiara per un file scelto dalla ricerca; se ci sono, il
// file scaricato si controlla contro questi valori (come per l'elenco consigliato). Un indirizzo scritto a mano non li ha.
export type LocalModelDownloadRequest =
	| { tipo: 'catalogo', id: string }
	| { tipo: 'indirizzo', url: string, nome: string, uso: LocalModelUse, contesto: number, descrizione: string, bytes?: number | null, sha256?: string | null }

// Un modello di `modelli.json` come lo vede l'interfaccia.
export type InstalledLocalModel = {
	nome: string,
	descrizione: string,
	uso: LocalModelUse,
	file: string,
	// finestra di contesto in token (campo `contesto` di `modelli.json`), passata a llama-server con `-c`
	contesto: number,
	// dimensione del file, `null` se il file manca
	bytes: number | null,
	// acceso in questo momento da Vox
	acceso: boolean,
	// altri modelli di `modelli.json` che usano lo stesso file
	condivisoCon: string[],
}

export type LocalModelDownloadState =
	| { stato: 'fermo' }
	// `giaPresente`: il file c'era già nella cartella e si sta solo controllando; fermare il controllo non toglie niente
	| { stato: 'scarico' | 'controllo', nome: string, file: string, ricevuti: number, totale: number | null, bytesAlSecondo: number, giaPresente?: boolean }
	| { stato: 'finito', nome: string }
	// `parziale`: il file parziale è rimasto (pausa) e lo scarico si può riprendere; `false` dopo un annullo
	| { stato: 'annullato', nome: string, parziale: boolean }
	| { stato: 'errore', nome: string, messaggio: string }

export type LocalModelLibraryState = {
	// cartella `ia-locali` in uso, `null` se non c'è
	cartella: string | null,
	// spazio libero sul disco della cartella, `null` se non si riesce a leggerlo
	liberi: number | null,
	installati: InstalledLocalModel[],
	scarico: LocalModelDownloadState,
	// errore di lettura di `modelli.json`, già tradotto
	errore: string | null,
}

export type LocalModelRemoval = {
	nome: string,
	// `true`: cancellazione definitiva (quando il Cestino non c'è, dopo una seconda conferma dell'utente)
	definitiva: boolean,
}

// Esito di una rimozione. `cestinoAssente`: il file non è andato nel Cestino (manca su questo disco, oppure il file è
// bloccato) e non è stato tolto niente: la cancellazione definitiva parte solo con una seconda richiesta
// (`definitiva: true`), che l'interfaccia manda dopo una conferma esplicita e distinta dell'utente.
export type LocalModelRemovalResult =
	| { esito: 'tolto', fileTolto: boolean, nelCestino: boolean }
	| { esito: 'cestinoAssente' }
	| { esito: 'errore', messaggio: string }

// Nuovo contesto (token) per un modello installato, fra LOCAL_MODEL_MIN_CONTEXT e LOCAL_MODEL_MAX_CONTEXT.
export type LocalModelContextChange = {
	nome: string,
	contesto: number,
}

// Esito del cambio di contesto. `riavvio`: il modello era acceso e si riavvia con il valore nuovo alla prossima richiesta
// (subito se è libero, altrimenti appena finisce la risposta in corso).
export type LocalModelContextResult =
	| { esito: 'fatto', prima: number, riavvio: boolean }
	| { esito: 'errore', messaggio: string }

// Valori proposti nella libreria per il contesto (l'utente può scriverne anche altri, entro i limiti).
export const LOCAL_MODEL_CONTEXT_PRESETS: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072]

// Ricerca dei modelli su Hugging Face (`electron-main/localModelLibrary/localModelSearch.ts`). A Hugging Face arriva
// solo il testo cercato o il nome del repository scelto.
export const LOCAL_MODEL_SEARCH_MAX_LENGTH = 100
export const LOCAL_MODEL_SEARCH_MAX_RESULTS = 20
// `<utente>/<repository>` di Hugging Face, senza `..`
export const LOCAL_MODEL_REPO_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9._-]{1,96}$/

// Un repository trovato dalla ricerca.
export type LocalModelSearchResult = {
	repo: string,
	scaricamenti: number,
	preferenze: number,
}

// Un file `.gguf` di un repository; `sha256` è `null` se Hugging Face non lo dichiara.
export type LocalModelRepoFile = {
	file: string,
	bytes: number,
	sha256: string | null,
}

// I file di un repository alla revisione letta. `contestoMassimo`: il contesto con cui il modello è stato addestrato,
// `null` se Hugging Face non lo dichiara.
export type LocalModelRepoFiles = {
	repo: string,
	revisione: string,
	contestoMassimo: number | null,
	file: LocalModelRepoFile[],
}

export type LocalModelSearchResponse =
	| { esito: 'fatto', risultati: LocalModelSearchResult[] }
	| { esito: 'annullato' }
	| { esito: 'errore', messaggio: string }

export type LocalModelRepoFilesResponse =
	| { esito: 'fatto', repository: LocalModelRepoFiles }
	| { esito: 'annullato' }
	| { esito: 'errore', messaggio: string }

// Indirizzo di un file di un repository a una revisione precisa, nella forma che lo scarico accetta.
export const urlOfLocalModelRepoFile = (repo: string, revisione: string, file: string): string =>
	`https://huggingface.co/${repo}/resolve/${revisione}/${encodeURIComponent(file)}`

// Da dove si può scaricare un modello. Solo HTTPS, porta predefinita, nessuna credenziale nell'indirizzo.
// L'indirizzo di partenza deve essere su `huggingface.co`. Hugging Face reindirizza poi ai suoi server di
// distribuzione, che cambiano con la zona (per esempio `us.aws.cdn.hf.co`, `cas-bridge.xethub.hf.co`): per i
// reindirizzamenti vale quindi ogni host dei due domini di Hugging Face, e nessun altro.
export const LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST = 'huggingface.co'
export const LOCAL_MODEL_DOWNLOAD_DOMAINS: readonly string[] = ['huggingface.co', 'hf.co']
export const LOCAL_MODEL_DOWNLOAD_MAX_REDIRECTS = 5

// Vero se `url` è un indirizzo da cui Vox può scaricare: `origin` chiede l'host di partenza, altrimenti basta un host
// dei domini di distribuzione. Non lancia mai eccezioni.
export const isAllowedLocalModelDownloadURL = (url: string, origin: boolean): boolean => {
	try {
		const { protocol, hostname, port, username, password } = new URL(url)
		if (protocol !== 'https:' || port !== '' || username !== '' || password !== '') return false
		const host = hostname.toLowerCase()
		if (origin) return host === LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST
		return LOCAL_MODEL_DOWNLOAD_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
	} catch {
		return false
	}
}
