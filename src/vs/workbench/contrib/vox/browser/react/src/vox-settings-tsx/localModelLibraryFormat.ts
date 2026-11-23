/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Funzioni pure di formattazione, verifica del modulo e controlli sulla libreria dei modelli locali.
// Nessuna dipendenza da React così i test possono eseguirle direttamente in Node.
import { t } from '../../../../common/voxI18n.js';
import { isAllowedLocalModelDownloadURL, isDownloadableLocalModelFileName, isSameLocalModelFile, LOCAL_MODEL_MAX_CONTEXT, LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_NAME_PATTERN } from '../../../../common/localModelLibraryTypes.js';
import type { InstalledLocalModel, LocalModelCatalogEntry, LocalModelDownloadState, LocalModelUse } from '../../../../common/localModelLibraryTypes.js';

// Unità binarie con l'etichetta di Esplora file di Windows (1 GB = 1024³ byte), come le dimensioni scritte nelle
// descrizioni dell'elenco consigliato (`common/localModelCatalog.ts`) e nei messaggi dello scarico.
const MB = 1024 ** 2;
const GB = 1024 ** 3;

// riserva di spazio che lo scarico tiene libera sul disco (`electron-main/localModelLibrary/localModelDownload.ts`)
export const LOCAL_MODEL_RESERVED_BYTES = 512 * MB;
// Il pulsante della cancellazione definitiva si accende solo dopo questo tempo: un doppio clic o un doppio Invio sulla
// prima conferma non deve mai arrivare fino a lì.
export const PERMANENT_DELETE_DELAY_MS = 1000;

// La cancellazione definitiva (che non passa dal Cestino) parte solo dal suo passo, distinto dalla prima conferma,
// e solo quando il suo pulsante si è acceso.
export function canDeletePermanently(step: 'trash' | 'permanent' | null, armed: boolean): boolean {
	return step === 'permanent' && armed === true;
}

// Solo un avviso: un parziale da riprendere ha bisogno solo della parte mancante, e il controllo vero (con la riserva)
// lo fa il processo principale prima di scaricare. Senza il dato dello spazio libero non si avvisa.
export function mayNotFitOnDisk(bytes: number, liberi: number | null): boolean {
	return liberi !== null && Number.isFinite(bytes) && bytes + LOCAL_MODEL_RESERVED_BYTES > liberi;
}

// Testo di un errore arrivato dal processo principale, senza il prefisso tecnico del canale
// («Error invoking remote method …: Error: …»), che non dice niente all'utente.
export function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err ?? '');
	return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '').trim() || t("Unknown error");
}

export function formatGigabytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 MB';
	// sotto 1 GB si mostrano i MB: un modello piccolo non deve apparire come «0.0 GB»
	if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
	return `${(bytes / GB).toFixed(1)} GB`;
}

export function formatSpeedMBps(bytesPerSecond: number): string {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0.0 MB/s';
	return `${(bytesPerSecond / MB).toFixed(1)} MB/s`;
}

export function downloadPercent(ricevuti: number, totale: number | null): number | null {
	if (totale === null || !Number.isFinite(totale) || totale <= 0) return null;
	if (!Number.isFinite(ricevuti) || ricevuti <= 0) return 0;
	if (ricevuti >= totale) return 100;
	return Math.min(99, Math.round((ricevuti / totale) * 100));
}

export function formatRemainingTime(ricevuti: number, totale: number | null, bytesAlSecondo: number): string | null {
	if (totale === null || !Number.isFinite(totale) || totale <= 0) return null;
	if (!Number.isFinite(bytesAlSecondo) || bytesAlSecondo <= 0) return null;
	if (!Number.isFinite(ricevuti) || ricevuti < 0) return null;
	const remainingBytes = Math.max(0, totale - ricevuti);
	// simboli del Sistema internazionale (s, min, h): uguali in italiano e in inglese
	if (remainingBytes === 0) return '0 s';
	const seconds = Math.ceil(remainingBytes / bytesAlSecondo);
	if (seconds < 60) return `${seconds} s`;
	if (seconds < 3600) {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return secs > 0 ? `${mins} min ${secs} s` : `${mins} min`;
	}
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
}

export function formatLocalModelUse(uso: LocalModelUse): string {
	if (uso === 'completamento') return t("Completion");
	if (uso === 'embedding') return t("Embedding");
	return t("Chat");
}

export function isCatalogEntryInstalled(
	entry: Pick<LocalModelCatalogEntry, 'nome' | 'file'>,
	installati: readonly Pick<InstalledLocalModel, 'nome' | 'file'>[],
): boolean {
	// come il processo principale: nomi e file uguali a meno delle maiuscole valgono come lo stesso modello
	const entryFile = entry.file.toLowerCase(), entryName = entry.nome.toLowerCase();
	return installati.some(m => m.nome.toLowerCase() === entryName || m.file.toLowerCase() === entryFile);
}

// Voce dell'elenco consigliato da cui riscaricare il file di un modello installato rimasto senza file: stesso nome e
// stesso file (a meno delle maiuscole), come chiede il processo principale per riscaricare senza toccare la voce.
export function catalogEntryForMissingModel<T extends Pick<LocalModelCatalogEntry, 'nome' | 'file'>>(
	model: Pick<InstalledLocalModel, 'nome' | 'file' | 'bytes'>,
	catalog: readonly T[],
): T | null {
	if (model.bytes !== null) return null;
	return catalog.find(entry => entry.nome.toLowerCase() === model.nome.toLowerCase() && isSameLocalModelFile(entry.file, model.file)) ?? null;
}

// Modello installato toccato dallo scarico (o dal controllo) in corso: stesso nome a meno delle maiuscole o stesso file,
// come il processo principale, che ne rifiuta la rimozione. Il processo principale guarda anche la cartella dello
// scarico, che la pagina non conosce: qui si è più prudenti solo se lo scarico è in un'altra cartella.
export function isModelInDownload(
	model: Pick<InstalledLocalModel, 'nome' | 'file'>,
	scarico: LocalModelDownloadState,
): boolean {
	if (scarico.stato !== 'scarico' && scarico.stato !== 'controllo') return false;
	return scarico.nome.toLowerCase() === model.nome.toLowerCase() || isSameLocalModelFile(scarico.file, model.file);
}

export type LocalModelDetectionNotice = { tipo: 'errore'; testo: string } | { tipo: 'nonConfigurata' } | null;

// Riga della libreria con l'esito del rilevamento dei modelli della chat: l'errore, se non ripete uno di quelli che la
// libreria mostra già (libreria e chat cercano la cartella con lo stesso codice, quindi spesso il testo è identico),
// altrimenti «non configurata» se il rilevamento è finito senza cartella né modelli, altrimenti niente.
export function detectionNotice(
	detectionError: string | null,
	notConfigured: boolean,
	libraryErrors: readonly (string | null | undefined)[],
): LocalModelDetectionNotice {
	if (detectionError) return libraryErrors.includes(detectionError) ? null : { tipo: 'errore', testo: detectionError };
	return notConfigured ? { tipo: 'nonConfigurata' } : null;
}

// Riga calcolata l'ultima volta che il rilevamento aveva un esito, con lo stato della cartella di allora
// (`senzaCartella` null: la libreria non aveva ancora uno stato, quindi non si sapeva).
export type RememberedDetectionNotice = { notice: LocalModelDetectionNotice; senzaCartella: boolean | null };

// Riga da mostrare. Mentre la chat rilegge i modelli (`stale`) il rilevamento non ha un esito: resta la riga di prima,
// già calcolata, così non sparisce per poi ricomparire. Non si ricalcola con gli errori nuovi della libreria: un doppione
// tolto prima tornerebbe a vedersi proprio quando la libreria ha risolto il suo errore. La riga di prima non vale più se
// intanto la libreria ha trovato (o perso) la cartella, o se ora ripete un suo errore.
export function shownDetectionNotice(
	fresh: LocalModelDetectionNotice,
	remembered: RememberedDetectionNotice | null,
	stale: boolean,
	senzaCartella: boolean | null,
	libraryErrors: readonly (string | null | undefined)[],
): LocalModelDetectionNotice {
	if (!stale || !remembered) return fresh;
	// si confronta solo quando lo stato della cartella era noto sia allora sia adesso
	if (remembered.senzaCartella !== null && senzaCartella !== null && remembered.senzaCartella !== senzaCartella) return null;
	const notice = remembered.notice;
	if (notice?.tipo === 'errore' && libraryErrors.includes(notice.testo)) return null;
	return notice;
}

export function featuresUsingLocalModel<F extends string>(
	modelName: string,
	modelSelectionOfFeature: Record<string, { providerName: string, modelName: string } | null | undefined>,
	featureNames: readonly F[],
): F[] {
	return featureNames.filter(featureName => {
		const sel = modelSelectionOfFeature[featureName];
		return sel?.providerName === 'voxLocal' && sel.modelName === modelName;
	});
}

export type CustomModelFormErrors = {
	url?: string;
	nome?: string;
	contesto?: string;
};

export type CustomModelFormValidation =
	| { ok: true; url: string; nome: string; contesto: number }
	| { ok: false; errors: CustomModelFormErrors };

export function validateCustomModelForm(
	input: { url: string; nome: string; contestoText: string },
	installati: readonly Pick<InstalledLocalModel, 'nome' | 'file'>[],
): CustomModelFormValidation {
	const errors: CustomModelFormErrors = {};
	const url = input.url.trim();
	if (!url) {
		errors.url = t("Enter the URL of a .gguf file on huggingface.co.");
	} else if (!isAllowedLocalModelDownloadURL(url, true)) {
		errors.url = t("The URL must start with https://huggingface.co/ (no credentials or custom port).");
	} else {
		// Stessa regola del processo principale (`normalizeLocalModelDownloadURL`): conta il percorso, non ciò che segue
		// `?` o `#`; vale l'indirizzo del file (`/resolve/`) e quello della sua pagina (`/blob/`), che Vox converte.
		let segment: string | null = null;
		try {
			const parts = new URL(url).pathname.split('/');
			const last = decodeURIComponent(parts[parts.length - 1]);
			if (parts.length >= 6 && (parts[3] === 'resolve' || parts[3] === 'blob') && !parts.slice(1).some(part => part === '')
				&& isDownloadableLocalModelFileName(last) && !last.includes('..')) segment = last;
		} catch {
			segment = null;
		}
		if (segment === null) errors.url = t("The URL must point to a .gguf file.");
		// lo stesso file (anche con maiuscole diverse) già usato da un modello: il processo principale lo rifiuterebbe
		else if (installati.some(m => isSameLocalModelFile(m.file, segment!))) errors.url = t("A file named {0} is already in the models folder and Vox cannot tell whether it is the same model. Rename or move it, then try again.", segment);
	}

	const nome = input.nome.trim();
	if (!nome) {
		errors.nome = t("Enter a model name.");
	} else if (!LOCAL_MODEL_NAME_PATTERN.test(nome)) {
		errors.nome = t("Use 1–64 characters: letters, numbers, dots, hyphens, or underscores.");
	} else if (/^\.+$/.test(nome)) {
		errors.nome = t("Use 1–64 characters: letters, numbers, dots, hyphens, or underscores.");
	} else if (installati.some(m => m.nome.toLowerCase() === nome.toLowerCase())) {
		errors.nome = t("A model named {0} is already installed.", nome);
	}

	const parsedContext = parseContextText(input.contestoText);
	if (!parsedContext.ok) errors.contesto = parsedContext.error;

	if (errors.url || errors.nome || errors.contesto || !parsedContext.ok) {
		return { ok: false, errors };
	}
	return { ok: true, url, nome, contesto: parsedContext.contesto };
}

// Contesto scritto dall'utente (modulo «Altri modelli» e cambio del contesto di un modello installato): solo cifre,
// entro i limiti di `modelli.json`. Gli spazi ai lati non contano.
export function parseContextText(text: string): { ok: true; contesto: number } | { ok: false; error: string } {
	const trimmed = String(text ?? '').trim();
	const contesto = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
	if (!Number.isInteger(contesto) || contesto < LOCAL_MODEL_MIN_CONTEXT || contesto > LOCAL_MODEL_MAX_CONTEXT) {
		return { ok: false, error: t("Context must be a whole number between {0} and {1}.", LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_MAX_CONTEXT) };
	}
	return { ok: true, contesto };
}

// Contesto in forma breve: «32K» per i multipli di 1024 (come li chiamano i modelli), altrimenti il numero intero.
export function formatContextTokens(contesto: number): string {
	if (!Number.isFinite(contesto) || contesto <= 0) return '0';
	return contesto % 1024 === 0 ? `${contesto / 1024}K` : String(Math.round(contesto));
}

// Filtro dell'elenco: ogni parola scritta deve comparire in almeno uno dei campi (senza distinguere le maiuscole).
// Un filtro vuoto lascia passare tutto.
export function matchesModelFilter(filter: string, fields: readonly (string | null | undefined)[]): boolean {
	const words = String(filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const text = fields.filter(field => typeof field === 'string').join('\n').toLowerCase();
	return words.every(word => text.includes(word));
}

// Nome proposto per un file trovato su Hugging Face: il nome del file senza `.gguf`, in minuscolo, con i soli caratteri
// ammessi in `modelli.json`; se è già usato si aggiunge un numero.
export function suggestLocalModelName(file: string, installati: readonly Pick<InstalledLocalModel, 'nome'>[]): string {
	const base = String(file ?? '').replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60) || 'modello';
	const taken = new Set(installati.map(model => model.nome.toLowerCase()));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Contesto proposto: quello dichiarato dal modello, ma non oltre 32K (di più può non entrare nella scheda video;
// si alza poi dalla libreria). Senza il dato si propone 32K.
export const SUGGESTED_CONTEXT_LIMIT = 32768;
export function suggestContext(contestoMassimo: number | null): number {
	if (contestoMassimo === null || !Number.isInteger(contestoMassimo) || contestoMassimo < LOCAL_MODEL_MIN_CONTEXT) return SUGGESTED_CONTEXT_LIMIT;
	return Math.min(contestoMassimo, SUGGESTED_CONTEXT_LIMIT);
}

// Uso proposto dal nome: i modelli di embedding lo dicono nel nome; gli altri si propongono per la chat.
export function suggestLocalModelUse(repo: string, file: string): LocalModelUse {
	return /embed|bge-|e5-|gte-/i.test(`${repo}/${file}`) ? 'embedding' : 'chat';
}

// Numero in forma breve per scaricamenti e preferenze: 950, 1.2K, 3.4M.
export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '0';
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
	return String(Math.floor(value));
}
