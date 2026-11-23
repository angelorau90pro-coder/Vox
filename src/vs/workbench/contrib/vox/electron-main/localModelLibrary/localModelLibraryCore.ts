/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Libreria dei modelli locali, lato processo principale: mette insieme cartella `ia-locali`, elenco consigliato,
// scarico, `modelli.json` e rimozione. Qui non c'è né rete né disco: tutto arriva da `LocalModelLibraryDeps`,
// così i test lo provano per intero con dipendenze finte. Il collegamento vero è in `localModelLibraryMainService.ts`.
import { join } from 'node:path';
import { defaultPortOfLocalModelUse, isAllowedLocalModelDownloadURL, isDownloadableLocalModelFileName, isSameLocalModelFile, LOCAL_MODEL_MAX_CONTEXT, LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_NAME_PATTERN } from '../../common/localModelLibraryTypes.js';
import type { InstalledLocalModel, LocalModelCatalogEntry, LocalModelContextChange, LocalModelContextResult, LocalModelDownloadRequest, LocalModelDownloadState, LocalModelLibraryState, LocalModelRemoval, LocalModelRemovalResult, LocalModelUse } from '../../common/localModelLibraryTypes.js';
import { t } from '../../common/voxI18n.js';

type ManifestEntry = { nome: string, descrizione: string, file: string, contesto: number, porta: number, uso: LocalModelUse, opzioni: string[] };
type DownloadProgress = { fase: 'scarico' | 'controllo', ricevuti: number, totale: number | null };

export type LocalModelLibraryDeps = {
	// cartella `ia-locali` in uso per la cartella scritta nelle Impostazioni, `null` se non c'è
	findFolder(cartella: string): Promise<string | null>,
	// dimentica l'ultimo esito di `findFolder` per questa cartella: la ricerca dopo guarda di nuovo il disco
	forgetFolder(cartella: string): void,
	isRunning(nome: string): boolean,
	// chiude il processo di Vox che tiene acceso il modello; `false` se non ci riesce
	closeForRemoval(nome: string): Promise<boolean>,
	// blocca gli avvii del modello finché non si chiama la funzione restituita
	blockStarts(nome: string): () => void,
	listInstalled(folder: string): Promise<InstalledLocalModel[]>,
	addToManifest(folder: string, entry: ManifestEntry): Promise<void>,
	removeFromManifest(folder: string, nome: string): Promise<unknown>,
	// cambia il campo `contesto` della voce; restituisce il valore di prima
	setContextInManifest(folder: string, nome: string, contesto: number): Promise<{ prima: number }>,
	download(p: { url: string, destination: string, expectedBytes: number | null, expectedSha256: string | null, signal: AbortSignal, onProgress: (progress: DownloadProgress) => void }): Promise<unknown>,
	// controlla un file già presente in `modelli/` (intestazione GGUF, dimensione e SHA-256 attesi) senza toccarlo
	verifyExisting(p: { file: string, expectedBytes: number | null, expectedSha256: string | null, signal: AbortSignal, onProgress: (progress: DownloadProgress) => void }): Promise<unknown>,
	removePartial(destination: string): Promise<void>,
	// rimette il file appena scaricato al posto del parziale
	restorePartial(destination: string): Promise<void>,
	// spazio libero sul disco della cartella, `null` se non si riesce a leggerlo
	freeBytes(folder: string): Promise<number | null>,
	// dimensione del file, `null` se non c'è
	sizeOf(file: string): Promise<number | null>,
	// File che Vox porta con sé per le voci dell'elenco consigliato (per esempio il modello di conversazione di
	// `qwen3.5-9b`): percorso relativo alla cartella `ia-locali`, con `/`, → contenuto.
	bundledFiles: Readonly<Record<string, string>>,
	// crea il file (e le cartelle che mancano) solo se non c'è: un file già presente non si sovrascrive mai
	createFileIfMissing(file: string, content: string): Promise<void>,
	// sposta nel Cestino; lancia se non ci riesce: il Cestino non c'è (per esempio su una chiavetta), il file è in uso
	// o mancano i permessi. Da qui le cause non si distinguono.
	trash(file: string): Promise<void>,
	// cancella per sempre; un file che non c'è non è un errore
	unlink(file: string): Promise<void>,
	now(): number,
	catalog: readonly LocalModelCatalogEntry[],
	urlOfCatalogEntry(entry: LocalModelCatalogEntry): string,
	emit(state: LocalModelLibraryState): void,
};

// ogni quanto l'avanzamento di uno scarico arriva alle finestre
const PROGRESS_INTERVAL_MS = 250;
const USES: readonly LocalModelUse[] = ['chat', 'completamento', 'embedding'];
const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : String(error);
const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === 'AbortError';

// Indirizzo incollato dall'utente: solo un file `.gguf` di huggingface.co. Si accetta anche l'indirizzo della pagina
// del file (`/blob/`), che diventa quello del file (`/resolve/`); la parte dopo `?` e `#` non serve e si toglie.
export function normalizeLocalModelDownloadURL(text: string): { url: string, file: string } {
	const invalid = () => new Error(t('Model download URL is not allowed.'));
	if (typeof text !== 'string' || !isAllowedLocalModelDownloadURL(text.trim(), true)) throw invalid();
	const parsed = new URL(text.trim());
	parsed.search = ''; parsed.hash = '';
	const parts = parsed.pathname.split('/');
	// /<utente>/<repo>/(resolve|blob)/<revisione>/<file…>, senza pezzi vuoti (`//`)
	if (parts.length < 6 || (parts[3] !== 'resolve' && parts[3] !== 'blob') || parts.slice(1).some(part => part === '')) throw new Error(t('The URL must point to a .gguf file.'));
	parts[3] = 'resolve';
	let file: string;
	try { file = decodeURIComponent(parts[parts.length - 1]) } catch { throw new Error(t('The URL must point to a .gguf file.')) }
	// il nome diventa un file in `modelli/`: niente caratteri che Windows rifiuta, di controllo o nomi di dispositivo
	if (!isDownloadableLocalModelFileName(file) || file.includes('..')) throw new Error(t('The URL must point to a .gguf file.'));
	parsed.pathname = parts.join('/');
	return { url: parsed.toString(), file };
}

// `incollato`: viene da un indirizzo e non dall'elenco consigliato. Anche quando porta dimensione e SHA-256 (file scelto
// dalla ricerca) non riusa mai un file già presente in `modelli/`.
type Spec = ManifestEntry & { url: string, bytes: number | null, sha256: string | null, incollato: boolean };
// `existing`: il file c'è già in `modelli/`, quindi non si scarica: si controlla soltanto
// `voceEsistente`: la voce è già in `modelli.json` (mancava solo il file): alla fine non se ne aggiunge un'altra
type Active = { folder: string, spec: Spec, destination: string, controller: AbortController, done: Promise<void>, tieniParziale: boolean, existing: boolean, voceEsistente: boolean };

export function createLocalModelLibrary(deps: LocalModelLibraryDeps) {
	let active: Active | null = null;
	let scarico: LocalModelDownloadState = { stato: 'fermo' };
	// ultima cartella chiesta da una finestra: gli eventi descrivono quella
	let lastCartella = '';
	let lastState: LocalModelLibraryState | null = null;
	// Avvio di uno scarico e rimozione passano uno alla volta: tutti e due leggono `modelli.json`, decidono e poi
	// scrivono, e in mezzo ci sono attese. Senza questa coda due rimozioni di voci che condividono il file lo lasciavano
	// sul disco senza voce, e un'aggiunta poteva arrivare fra il controllo di condivisione e lo spostamento nel Cestino.
	let queue: Promise<unknown> = Promise.resolve();
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work, work);
		queue = next.catch(() => { });
		return next;
	};

	const readState = async (cartella: string): Promise<LocalModelLibraryState> => {
		lastCartella = cartella;
		// La ricerca della cartella può anche fallire (percorso non assoluto, disco che non risponde): lo stato arriva lo
		// stesso, con l'errore. Prima l'errore si perdeva in `emitFresh` e a fine scarico l'interfaccia restava ferma
		// sull'avanzamento, con Pausa e Annulla che non facevano più niente.
		let folder: string | null;
		try { folder = await deps.findFolder(cartella) }
		catch (error) { return lastState = { cartella: null, liberi: null, installati: [], scarico, errore: messageOf(error) } }
		if (!folder) return lastState = { cartella: null, liberi: null, installati: [], scarico, errore: null };
		let installati: InstalledLocalModel[] = [], errore: string | null = null;
		try { installati = await deps.listInstalled(folder) } catch (error) { errore = messageOf(error) }
		let liberi: number | null = null;
		try { liberi = await deps.freeBytes(folder) } catch { /* lo spazio libero è solo un'informazione */ }
		return lastState = { cartella: folder, liberi, installati, scarico, errore };
	};
	// dopo un cambiamento (fine di uno scarico, rimozione) si rilegge tutto; durante lo scarico cambia solo l'avanzamento
	const emitFresh = async () => { try { deps.emit(await readState(lastCartella)) } catch { /* nessuna finestra deve restare senza risposta per questo */ } };
	const emitProgress = () => { if (lastState) deps.emit(lastState = { ...lastState, scarico }) };

	const specOf = (request: LocalModelDownloadRequest): Spec => {
		if (request?.tipo === 'catalogo') {
			const entry = deps.catalog.find(item => item.id === request.id);
			if (!entry) throw new Error(t('This model is not in the recommended list.'));
			return { nome: entry.nome, descrizione: entry.descrizione, file: entry.file, contesto: entry.contesto, porta: defaultPortOfLocalModelUse[entry.uso], uso: entry.uso, opzioni: [...entry.opzioni], url: deps.urlOfCatalogEntry(entry), bytes: entry.bytes, sha256: entry.sha256, incollato: false };
		}
		if (request?.tipo !== 'indirizzo') throw new Error(t('Invalid model download request.'));
		const { url, file } = normalizeLocalModelDownloadURL(request.url);
		if (typeof request.nome !== 'string' || !LOCAL_MODEL_NAME_PATTERN.test(request.nome) || /^\.+$/.test(request.nome)) throw new Error(t('Use 1–64 characters: letters, numbers, dots, hyphens, or underscores.'));
		if (!USES.includes(request.uso)) throw new Error(t('Invalid model download request.'));
		if (!Number.isInteger(request.contesto) || request.contesto < LOCAL_MODEL_MIN_CONTEXT || request.contesto > LOCAL_MODEL_MAX_CONTEXT) throw new Error(t('Context must be a whole number between {0} and {1}.', LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_MAX_CONTEXT));
		const descrizione = typeof request.descrizione === 'string' ? request.descrizione.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
		// Dimensione e SHA-256 dichiarati da Hugging Face (file scelto dalla ricerca): valori sbagliati si rifiutano qui,
		// non si ignorano, altrimenti lo scarico partirebbe senza il controllo che l'interfaccia ha promesso.
		const bytes = request.bytes ?? null, sha256 = request.sha256 ?? null;
		if ((bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 4)) || (sha256 !== null && (bytes === null || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)))) throw new Error(t('Invalid model size or SHA-256.'));
		return { nome: request.nome, descrizione, file, contesto: request.contesto, porta: defaultPortOfLocalModelUse[request.uso], uso: request.uso, opzioni: request.uso === 'embedding' ? ['--embedding'] : [], url, bytes, sha256: sha256 === null ? null : sha256.toLowerCase(), incollato: true };
	};

	const entryOf = ({ nome, descrizione, file, contesto, porta, uso, opzioni }: Spec): ManifestEntry => ({ nome, descrizione, file, contesto, porta, uso, opzioni });

	const run = async (current: Active) => {
		const { spec, folder, destination, controller } = current;
		let lastEmit = 0, lastBytes = 0, lastTime = deps.now(), speed = 0, lastPhase: DownloadProgress['fase'] | null = null;
		const onProgress = (progress: DownloadProgress) => {
			if (active !== current) return;
			const now = deps.now(), phaseChanged = progress.fase !== lastPhase;
			// l'ultimo evento di una fase (tutto ricevuto) passa sempre: chi chiama lo manda una volta sola
			const last = progress.totale !== null && progress.ricevuti >= progress.totale;
			if (!phaseChanged && !last && now - lastEmit < PROGRESS_INTERVAL_MS) return;
			if (phaseChanged) { lastBytes = progress.ricevuti; lastTime = now; speed = 0 }
			else if (now > lastTime) {
				// media mobile: la velocità non salta a ogni blocco
				const instant = Math.max(0, progress.ricevuti - lastBytes) * 1000 / (now - lastTime);
				speed = speed ? speed * 0.7 + instant * 0.3 : instant;
				lastBytes = progress.ricevuti; lastTime = now;
			}
			lastPhase = progress.fase; lastEmit = now;
			scarico = { stato: progress.fase, nome: spec.nome, file: spec.file, ricevuti: progress.ricevuti, totale: progress.totale, bytesAlSecondo: Math.round(speed), ...(current.existing ? { giaPresente: true } : {}) };
			emitProgress();
		};
		let ready = false;
		try {
			if (current.existing) await deps.verifyExisting({ file: destination, expectedBytes: spec.bytes, expectedSha256: spec.sha256, signal: controller.signal, onProgress });
			else await deps.download({ url: spec.url, destination, expectedBytes: spec.bytes, expectedSha256: spec.sha256, signal: controller.signal, onProgress });
			ready = true;
		} catch (error) {
			if (isAbort(error) || controller.signal.aborted) {
				// `parziale`: resta qualcosa da cui riprendere. Di un file già presente non si toglie mai niente.
				let parziale = current.existing;
				if (!current.existing) {
					if (current.tieniParziale) parziale = true;
					else { try { await deps.removePartial(destination) } catch { parziale = true /* resta un file `.parziale`: lo riusa o lo sostituisce il prossimo scarico */ } }
				}
				scarico = { stato: 'annullato', nome: spec.nome, parziale };
			} else scarico = { stato: 'errore', nome: spec.nome, messaggio: messageOf(error) };
		}
		// File riscaricato per una voce che c'era già: se la voce c'è ancora non si aggiunge niente. Se nel frattempo è stata
		// tolta (a mano in `modelli.json`) si rimette come per uno scarico nuovo, così il file non resta senza voce. Se
		// l'elenco non si legge non si sa se la voce c'è: l'esito è l'errore di lettura, non «scaricato», e il file resta
		// dov'è (intero e controllato). Il tentativo dopo lo ricontrolla e, se la voce non c'è più, la rimette.
		// Se la voce c'è ma nel frattempo usa un altro file (cambiato a mano), il file scaricato non lo usa nessuno: si dice.
		if (ready && current.voceEsistente) {
			try {
				const still = (await deps.listInstalled(folder)).find(model => model.nome.toLowerCase() === spec.nome.toLowerCase());
				if (still) {
					ready = false;
					scarico = isSameLocalModelFile(still.file, spec.file) ? { stato: 'finito', nome: spec.nome } : { stato: 'errore', nome: spec.nome, messaggio: t('The entry {0} in modelli.json now uses another file ({1}): the downloaded file stays in the models folder, but no entry uses it.', still.nome, still.file) };
				}
			} catch (error) { ready = false; scarico = { stato: 'errore', nome: spec.nome, messaggio: messageOf(error) } }
		}
		if (ready) {
			// Il file è intero e controllato: entra in `modelli.json` anche se nel frattempo è arrivato un annullo, e un
			// errore qui si vede sempre (prima un annullo in questo momento lo nascondeva e il file restava senza voce).
			try { await deps.addToManifest(folder, entryOf(spec)); scarico = { stato: 'finito', nome: spec.nome } }
			catch (error) {
				// la voce può essere stata scritta prima dell'errore: allora il modello c'è e il file resta dov'è
				// `null`: non si sa (l'elenco non si legge). Nel dubbio il file resta dov'è: meglio un file senza voce, che il
				// prossimo tentativo segnala, che una voce col suo file trasformato in parziale.
				let added: boolean | null = null;
				try { added = (await deps.listInstalled(folder)).some(model => model.nome === spec.nome) } catch { /* resta null */ }
				if (added === true) scarico = { stato: 'finito', nome: spec.nome };
				else if (added === null) scarico = { stato: 'errore', nome: spec.nome, messaggio: messageOf(error) };
				else {
					// Un file scaricato ora e senza voce bloccherebbe ogni nuovo tentativo (un file già presente non si
					// sovrascrive): torna parziale, e il prossimo scarico lo riprende o lo ricontrolla. Un file che c'era già resta.
					if (!current.existing) { try { await deps.restorePartial(destination) } catch { /* resta il file: lo dice l'errore di sotto alla prossima prova */ } }
					scarico = { stato: 'errore', nome: spec.nome, messaggio: messageOf(error) };
				}
			}
		}
		if (active === current) active = null;
		await emitFresh();
	};

	return {
		// `ricontrolla`: «Controlla di nuovo» della pagina, dopo che l'utente ha creato o collegato la cartella
		getState: (cartella: string, ricontrolla?: boolean) => { if (ricontrolla === true) deps.forgetFolder(cartella); return readState(cartella) },
		getCatalog: async () => deps.catalog.map(entry => ({ ...entry, opzioni: [...entry.opzioni] })),

		async startDownload(cartella: string, request: LocalModelDownloadRequest): Promise<void> {
			if (active) throw new Error(t('Another model download is already in progress.'));
			const requested = specOf(request);
			return exclusive(async () => {
				if (active) throw new Error(t('Another model download is already in progress.'));
				const folder = await deps.findFolder(cartella);
				if (!folder) throw new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.'));
				const installati = await deps.listInstalled(folder);
				let spec = requested, voceEsistente = false;
				const sameName = installati.find(model => model.nome.toLowerCase() === spec.nome.toLowerCase());
				if (sameName) {
					// Una voce dell'elenco consigliato rimasta senza file (spostato, cancellato a mano) si può riscaricare: si
					// scarica solo il file, col nome che la voce già usa, e la voce resta com'è (contesto e opzioni dell'utente).
					// Un indirizzo incollato, un file presente o un file diverso restano un nome già usato.
					if (spec.incollato || sameName.bytes !== null || !isSameLocalModelFile(sameName.file, spec.file)) throw new Error(t('A model named {0} is already installed.', spec.nome));
					// acceso senza file (cancellato mentre girava, dove il sistema lo permette): prima va fermato
					if (deps.isRunning(sameName.nome)) throw new Error(t('The model {0} is running without its file: close and reopen Vox, then try again.', sameName.nome));
					spec = { ...spec, nome: sameName.nome, file: sameName.file };
					voceEsistente = true;
				}
				// i file delle opzioni (per esempio il modello di conversazione) si controllano prima di scaricare dei gigabyte.
				// Quelli che mancano e che Vox porta con sé si scrivono solo dopo tutti i controlli, a scarico deciso.
				// (Per un riscarico valgono le opzioni dell'elenco, non quelle della voce: al più si crea un file che manca.)
				const toCreate: { file: string, content: string }[] = [];
				for (const option of spec.opzioni) {
					// stessa regola di `addLocalModelToManifest`: un'opzione che comincia con `{cartella}` è tutta un percorso
					for (const match of option.startsWith('{cartella}') && option.lastIndexOf('{cartella}') === 0 ? [[option, option.slice('{cartella}'.length).replace(/^[\/\\]/, '')]] : option.matchAll(/\{cartella\}[\/\\]?([^\s"']+)/g)) {
						const optionFile = join(folder, match[1]);
						if (match[1].split(/[\/\\]/).includes('..')) throw new Error(t('Local model option file not found: {0}', optionFile));
						if (await deps.sizeOf(optionFile) !== null) continue;
						// Un file che Vox porta con sé (solo per l'elenco consigliato) si scrive, se manca: una cartella
						// `ia-locali` nuova non lo ha. Un file già presente resta quello dell'utente.
						const bundledKey = match[1].replace(/\\/g, '/');
						if (spec.incollato || !Object.prototype.hasOwnProperty.call(deps.bundledFiles, bundledKey)) throw new Error(t('Local model option file not found: {0}', optionFile));
						toCreate.push({ file: optionFile, content: deps.bundledFiles[bundledKey] });
					}
				}
				// un indirizzo incollato non deve finire su un file che un altro modello usa già (anche con maiuscole diverse):
				// toglierne uno poi toglierebbe il file dell'altro, e non si sa se sono lo stesso modello
				if (spec.incollato && installati.some(model => isSameLocalModelFile(model.file, spec.file))) throw new Error(t('A file named {0} is already in the models folder and Vox cannot tell whether it is the same model. Rename or move it, then try again.', spec.file));
				const destination = join(folder, 'modelli', spec.file);
				const present = await deps.sizeOf(destination);
				if (present !== null) {
					// Il file c'è già. Per un indirizzo incollato non si può sapere se è lo stesso modello (stesso nome, altro
					// repository): non lo si riusa in silenzio. Per l'elenco consigliato lo si riusa solo dopo il controllo di
					// dimensione, intestazione GGUF e SHA-256, fatto in `run` come uno scarico (si vede e si può annullare).
					if (spec.incollato || spec.bytes === null) throw new Error(t('A file named {0} is already in the models folder and Vox cannot tell whether it is the same model. Rename or move it, then try again.', spec.file));
					if (present !== spec.bytes) throw new Error(t('Model file already exists: {0}', destination));
				}
				for (const { file, content } of toCreate) {
					try { await deps.createFileIfMissing(file, content) }
					catch (error) { throw new Error(t('Unable to create the local model option file {0}: {1}', file, messageOf(error))) }
					if (await deps.sizeOf(file) === null) throw new Error(t('Local model option file not found: {0}', file));
				}
				lastCartella = cartella;
				const current: Active = { folder, spec, destination, controller: new AbortController(), done: Promise.resolve(), tieniParziale: true, existing: present !== null, voceEsistente };
				active = current;
				scarico = { stato: current.existing ? 'controllo' : 'scarico', nome: spec.nome, file: spec.file, ricevuti: 0, totale: spec.bytes, bytesAlSecondo: 0, ...(current.existing ? { giaPresente: true } : {}) };
				lastState = { cartella: folder, liberi: lastState?.cartella === folder ? lastState.liberi : null, installati, scarico, errore: null };
				deps.emit(lastState);
				current.done = run(current);
			});
		},

		async cancelDownload(tieniParziale: boolean): Promise<void> {
			const current = active;
			if (!current) return;
			current.tieniParziale = tieniParziale === true;
			current.controller.abort();
			await current.done;
		},

		removeModel(cartella: string, removal: LocalModelRemoval): Promise<LocalModelRemovalResult> {
			return exclusive(async () => {
				try {
					const nome = removal?.nome;
					if (typeof cartella === 'string') lastCartella = cartella;
					const folder = await deps.findFolder(cartella);
					if (!folder) throw new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.'));
					const find = async () => (await deps.listInstalled(folder)).find(item => item.nome === nome);
					let model = await find();
					if (!model) throw new Error(t('Local model {0} was not found in the manifest.', String(nome)));
					if (active && active.folder === folder && (active.spec.nome.toLowerCase() === model.nome.toLowerCase() || isSameLocalModelFile(active.spec.file, model.file))) throw new Error(t('This model is being downloaded: stop the download first.'));
					// da qui alla fine nessuna richiesta può riaccendere il modello (prima poteva farlo fra il controllo e il Cestino)
					const unblock = deps.blockStarts(model.nome);
					try {
						if (!await deps.closeForRemoval(model.nome)) throw new Error(t('The model {0} is in use: wait for the answer to finish and try again.', model.nome));
						// la chiusura può aver aspettato dei secondi: la condivisione del file si decide su una lettura fresca
						model = await find();
						if (!model) throw new Error(t('Local model {0} was not found in the manifest.', String(nome)));
						// Ordine: prima il file, poi la voce. Se qualcosa va storto a metà resta una voce col file mancante,
						// che si vede nell'elenco e si può togliere di nuovo; mai un file da gigabyte senza voce.
						const file = join(folder, 'modelli', model.file);
						let fileTolto = false, nelCestino = false;
						if (model.condivisoCon.length === 0 && await deps.sizeOf(file) !== null) {
							// una richiesta in coda può aver riacceso il modello: il file non si tocca
							if (deps.isRunning(model.nome)) throw new Error(t('The model {0} is in use: wait for the answer to finish and try again.', model.nome));
							if (removal.definitiva === true) {
								try { await deps.unlink(file) } catch (error) { throw new Error(t('Unable to delete the model file {0}: {1}', file, messageOf(error))) }
							} else {
								try { await deps.trash(file); nelCestino = true } catch {
									if (deps.isRunning(model.nome)) throw new Error(t('The model {0} is in use: wait for the answer to finish and try again.', model.nome));
									// Non è stato tolto niente. La cancellazione definitiva non parte mai da qui: serve una seconda
									// richiesta con `definitiva: true`, dopo una conferma esplicita. Lo stato si rilegge: il modello è stato chiuso.
									await emitFresh();
									return { esito: 'cestinoAssente' };
								}
							}
							fileTolto = true;
						}
						await deps.removeFromManifest(folder, model.nome);
						// «scaricato X» o «scarico di X fermato» non hanno più senso dopo aver tolto X
						if ((scarico.stato === 'finito' || scarico.stato === 'annullato' || scarico.stato === 'errore') && scarico.nome === model.nome) scarico = { stato: 'fermo' };
						// dove un file aperto si può togliere, una richiesta in coda può aver riacceso il modello: lo si richiude
						if (deps.isRunning(model.nome)) { try { await deps.closeForRemoval(model.nome) } catch { /* si chiuderà all'uscita da Vox */ } }
						await emitFresh();
						return { esito: 'tolto', fileTolto, nelCestino };
					} finally { unblock() }
				} catch (error) {
					await emitFresh();
					return { esito: 'errore', messaggio: messageOf(error) };
				}
			});
		},

		// Cambia il contesto di un modello installato. In coda con scarichi e rimozioni (tutti leggono e scrivono
		// `modelli.json`). Il modello acceso non si ferma qui: `LocalModelManager` vede che la sua firma non coincide più
		// col manifesto e lo riavvia con il valore nuovo alla prossima richiesta, senza interrompere una risposta in corso.
		setContext(cartella: string, change: LocalModelContextChange): Promise<LocalModelContextResult> {
			return exclusive(async () => {
				try {
					const nome = change?.nome, contesto = change?.contesto;
					if (typeof cartella === 'string') lastCartella = cartella;
					if (!Number.isInteger(contesto) || contesto < LOCAL_MODEL_MIN_CONTEXT || contesto > LOCAL_MODEL_MAX_CONTEXT) throw new Error(t('Context must be a whole number between {0} and {1}.', LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_MAX_CONTEXT));
					const folder = await deps.findFolder(cartella);
					if (!folder) throw new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.'));
					const model = (await deps.listInstalled(folder)).find(item => item.nome === nome);
					if (!model) throw new Error(t('Local model {0} was not found in the manifest.', String(nome)));
					const { prima } = await deps.setContextInManifest(folder, model.nome, contesto);
					await emitFresh();
					return { esito: 'fatto', prima, riavvio: prima !== contesto && deps.isRunning(model.nome) };
				} catch (error) {
					await emitFresh();
					return { esito: 'errore', messaggio: messageOf(error) };
				}
			});
		},

		// alla chiusura di Vox: lo scarico si ferma e il file parziale resta, per riprendere la volta dopo
		dispose() { if (active) { active.tieniParziale = true; active.controller.abort() } },
	};
}
