import { spawn, execFile } from 'node:child_process';
import { access, readFile, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { t } from '../../common/voxI18n.js';

export type LocalModelUse = 'chat' | 'completamento' | 'embedding';
export type LocalModelEntry = { nome: string, descrizione: string, file: string, contesto: number, porta: number, uso: LocalModelUse, opzioni: string[] };
export type LocalManifest = { cartella: string, motore: string, modelli: LocalModelEntry[] };
export type LocalModelLease = { baseURL: string, release: () => void };
// Nome dell'errore di `listChatModels` quando la cartella non è scelta e la ricerca automatica non la trova.
export const LOCAL_MODELS_NOT_CONFIGURED = 'VoxLocalNotConfigured';

type Runtime = {
	spawn: typeof spawn, execFile: typeof execFile, access: typeof access, readFile: typeof readFile,
	mkdir: typeof mkdir, open: typeof open, fetch: typeof fetch,
	homedir: typeof homedir, execPath: string, platform: string, now: () => number,
	setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
	ioTimeout: number, logTimeout: number, probeTimeout: number, candidateTimeout: number, configuredTimeout: number, cacheDuration: number, missDuration: number,
	switchTimeout: number, healthTimeout: number, healthInterval: number, closeTimeout: number, leaseTimeout: number
};
const runtime: Runtime = {
	spawn, execFile, access, readFile, mkdir, open, fetch, homedir,
	execPath: process.execPath, platform: process.platform, now: () => Date.now(),
	// una cartella non trovata si ricontrolla presto (l'utente può averla appena creata); quella scelta
	// nelle impostazioni ha più tempo per rispondere (unità di rete, antivirus)
	setTimeout, clearTimeout, ioTimeout: 10000, logTimeout: 2000, probeTimeout: 2000, candidateTimeout: 1500, configuredTimeout: 10000, cacheDuration: 60000, missDuration: 5000,
	// leaseTimeout: quanto si aspetta che un'altra chat finisca la sua risposta prima di cambiare modello
	switchTimeout: 15000, healthTimeout: 300000, healthInterval: 500, closeTimeout: 5000, leaseTimeout: 300000
};
// `firma`: motore e argomenti con cui il processo è partito; se il manifesto cambia, il processo va riavviato.
// `closing`: chiusura in corso, condivisa da chi la chiede insieme (mai due taskkill sullo stesso PID).
type OwnedModel = { child: any, nome: string, uso: 'chat' | 'completamento', firma: string, leases: number, closing?: Promise<boolean>, superseded?: boolean };
const within = (base: string, file: string) => {
	const rel = relative(base, file);
	return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const discovery = new Map<string, { until: number, value: string | null, error?: Error }>();
// voce della cache per la sola ricerca sulle unità C–Z (non può coincidere con un percorso configurato)
const DRIVES_KEY = '\0unità';
// Controlli delle cartelle ancora in corso: un'unità di rete scollegata può bloccare `access` a lungo,
// quindi lo stesso controllo non si rilancia finché il precedente non è finito. Windows lo chiude
// con errore dopo il proprio timeout sull’unità scollegata: a quel punto la voce si libera.
const pendingChecks = new Map<string, Promise<boolean>>();
// Solo i rilevamenti periodici evitano di accumulare letture fs ancora appese.
const pendingListReads = new Map<string, ReturnType<typeof readFile>>();
const owned = new Map<number, OwnedModel>();
const locks = new Map<number, Promise<unknown>>();
const delay = (ms: number, rt: Runtime) => new Promise<void>(resolveDelay => rt.setTimeout(resolveDelay, ms));
const abortError = () => Object.assign(new Error(t('Local model request canceled.')), { name: 'AbortError' });
const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError() };
const withAbort = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
	void promise.catch(() => { });
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const abort = () => rejectPromise(abortError());
		signal.addEventListener('abort', abort, { once: true });
		promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener('abort', abort));
	});
};

const withDeadline = async <T>(promise: Promise<T>, ms: number, rt: Runtime, message: string, signal?: AbortSignal): Promise<T> => {
	void promise.catch(() => { });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		throwIfAborted(signal);
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			abort = () => reject(abortError());
			signal?.addEventListener('abort', abort, { once: true });
			timer = rt.setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms);
		})]);
	} finally {
		if (timer !== undefined) rt.clearTimeout(timer);
		if (abort) signal?.removeEventListener('abort', abort);
	}
};

async function exists(file: string, rt: Runtime, timeout = rt.ioTimeout, signal?: AbortSignal): Promise<boolean> {
	let pending = pendingChecks.get(file);
	if (!pending) {
		// solo "non esiste" vale false: un file presente ma illeggibile (permessi, file bloccato, disco in errore)
		// fa fallire il controllo con la sua causa, così non viene presentato come assente
		pending = rt.access(file).then(() => true, (error: unknown) => {
			const code = (error as { code?: unknown } | null)?.code;
			if (typeof code === 'string' && code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
			return false;
		}).finally(() => pendingChecks.delete(file));
		pendingChecks.set(file, pending);
	}
	return withDeadline(pending, timeout, rt, t('Timed out while accessing local model file: {0}', file), signal);
}

// Solo per la ricerca automatica, un timeout del manifesto vale false (cartella assente).
async function hasManifest(folder: string, rt: Runtime, timeout: number): Promise<boolean> {
	try { return await exists(join(folder, 'modelli.json'), rt, timeout) } catch { return false }
}

// "Copia come percorso" di Esplora file aggiunge le virgolette: si tolgono, il percorso resta quello
const folderKey = (configured: string) => (configured || '').trim().replace(/^"(.*)"$/, '$1').trim();

async function findFolder(configured: string, rt: Runtime, cache = discovery): Promise<string | null> {
	const key = folderKey(configured);
	const cached = cache.get(key);
	if (cached && cached.until > rt.now()) { if (cached.error) throw cached.error; return cached.value }
	let value: string | null = null;
	if (key) {
		// solo percorsi assoluti: la cartella di lavoro del processo principale non è prevedibile
		if (!isAbsolute(key)) throw new Error(t('The local AI folder must be an absolute path (for example E:\\Vox\\ia-locali): {0}', key));
		try {
			value = await exists(join(resolve(key), 'modelli.json'), rt, rt.configuredTimeout) ? resolve(key) : null
		}
		catch (error) {
			if (error instanceof Error && error.name === 'TimeoutError') {
				const failure = Object.assign(new Error(t('Local AI folder is not responding: {0}', key)), { name: 'TimeoutError' });
				cache.set(key, { until: rt.now() + rt.missDuration, value: null, error: failure });
				throw failure;
			}
			throw error;
		}
	} else {
		const local = [join(dirname(rt.execPath), 'ia-locali'), join(rt.homedir(), '.vox', 'ia-locali')];
		const drives: string[] = [];
		if (rt.platform === 'win32') for (let drive = 67; drive <= 90; drive++) drives.push(`${String.fromCharCode(drive)}:\\Vox\\ia-locali`);
		// La ricerca sulle unità (anche di rete o scollegate) costa di più: il suo esito, anche negativo, vale per
		// la cache lunga solo se la scansione è completa. Le cartelle locali si ricontrollano presto se assenti.
		const cachedDrives = cache.get(DRIVES_KEY);
		const scanDrives = drives.length > 0 && !(cachedDrives && cachedDrives.until > rt.now());
		const check = (folder: string) => hasManifest(folder, rt, rt.candidateTimeout);
		const localResults = await Promise.all(local.map(check));
		value = local[localResults.findIndex(Boolean)] ?? null;
		if (!value) {
			const driveResults: boolean[] = [];
			let complete = true;
			if (scanDrives) {
				let next = 0;
				await Promise.all(Array.from({ length: 4 }, async () => {
					while (next < drives.length) {
						const index = next++;
						const file = join(drives[index], 'modelli.json');
						// I controlli appesi dalle scansioni precedenti non fermano i nuovi lavoratori.
						if (pendingChecks.has(file)) { driveResults[index] = false; complete = false; continue }
						try { driveResults[index] = await exists(file, rt, rt.candidateTimeout) }
						// un errore di accesso (unità bloccata, permessi) è una risposta: lì non c'è la cartella;
						// solo un controllo senza risposta (timeout) lascia la scansione incompleta
						catch (error) { driveResults[index] = false; if (typeof (error as { code?: unknown } | null)?.code !== 'string') complete = false }
						// Un timeout non libera il thread fs: questo lavoratore non lancia altri accessi.
						if (pendingChecks.has(file)) break;
					}
				}));
			}
			value = scanDrives ? drives[driveResults.findIndex(Boolean)] ?? null : cachedDrives?.value ?? null;
			if (scanDrives) {
				complete = complete && driveResults.length === drives.length;
				cache.set(DRIVES_KEY, { until: rt.now() + (value || complete ? rt.cacheDuration : rt.missDuration), value });
			}
		}
	}
	cache.set(key, { until: rt.now() + (value ? rt.cacheDuration : rt.missDuration), value });
	return value;
}

export async function findLocalModelsFolder(configured: string): Promise<string | null> { return findFolder(configured, runtime) }

async function readManifest(folder: string, rt: Runtime, signal?: AbortSignal, listing = false): Promise<LocalManifest> {
	const cartella = resolve(folder);
	let raw: any;
	const file = join(cartella, 'modelli.json');
	try {
		const message = t('Timed out while reading local model manifest: {0}', file);
		const pending = (listing ? pendingListReads.get(file) : undefined) ?? rt.readFile(file, 'utf8');
		if (listing && !pendingListReads.has(file)) {
			pendingListReads.set(file, pending);
			void pending.finally(() => { if (pendingListReads.get(file) === pending) pendingListReads.delete(file) }).catch(() => { });
		}
		raw = JSON.parse(String(await withDeadline(pending, rt.ioTimeout, rt, message, signal)));
	}
	catch (error) {
		if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
		const cause = error instanceof SyntaxError ? error.message : (error as NodeJS.ErrnoException)?.code ?? String(error);
		throw new Error(t('Unable to read local model manifest: {0} ({1})', file, cause));
	}
	return validateLocalModelManifest(raw, cartella);
}

export function validateLocalModelManifest(raw: any, folder: string): LocalManifest {
	const cartella = resolve(folder);
	const invalid = (field: string, name = ''): never => { throw new Error(t('Invalid local model manifest field {0} for model {1}.', field, name || t('[manifest]'))) };
	if (typeof raw?.motore !== 'string' || !raw.motore || isAbsolute(raw.motore)) invalid('motore');
	const motore = resolve(cartella, raw.motore), motoreRel = relative(cartella, motore);
	if (!motoreRel || motoreRel === '.' || !within(cartella, motore)) invalid('motore');
	if (!Array.isArray(raw.modelli)) invalid('modelli');
	const names = new Set<string>();
	const modelli = raw.modelli.map((model: any) => {
		const nome = typeof model?.nome === 'string' ? model.nome : '';
		const bad = (field: string): never => invalid(field, nome);
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(nome) || names.has(nome)) bad('nome');
		names.add(nome);
		// solo un file .gguf dentro modelli/, senza sottocartelle
		if (typeof model.file !== 'string' || !/^[^\\/:]+\.gguf$/i.test(model.file) || model.file.includes('..')) bad('file');
		if (!Number.isInteger(model.contesto) || model.contesto < 512 || model.contesto > 1048576) bad('contesto');
		if (!Number.isInteger(model.porta) || model.porta < 1024 || model.porta > 65535) bad('porta');
		if (!['chat', 'completamento', 'embedding'].includes(model.uso)) bad('uso');
		if (model.opzioni !== undefined && (!Array.isArray(model.opzioni) || model.opzioni.some((x: unknown) => typeof x !== 'string'))) bad('opzioni');
		const opzioni = (model.opzioni ?? []).map((x: string) => {
			// indirizzo, porta, file, nome e contesto li decide Vox
			if (/^(--host|--port|-m|--model|--alias|-a|-c|--ctx-size)(?:=|$)/.test(x.trim())) bad('opzioni');
			return x.replaceAll('{cartella}', cartella);
		});
		if (model.descrizione !== undefined && typeof model.descrizione !== 'string') bad('descrizione');
		return { nome, descrizione: model.descrizione ?? '', file: model.file, contesto: model.contesto, porta: model.porta, uso: model.uso, opzioni };
	});
	return { cartella, motore, modelli };
}

export function invalidateLocalModelsManifestCache(folder: string): void {
	pendingListReads.delete(join(resolve(folder), 'modelli.json'));
}

function commandOf(folder: string, manifest: LocalManifest, model: LocalModelEntry) {
	const modelFile = join(folder, 'modelli', model.file);
	const args = ['-m', modelFile, '--alias', model.nome, '-ngl', '99', '-c', String(model.contesto), '-fa', 'on', '-np', '1', '--jinja', '--host', '127.0.0.1', '--port', String(model.porta), ...model.opzioni];
	return { modelFile, args, firma: JSON.stringify([manifest.motore, args]) };
}

export async function readLocalManifest(folder: string): Promise<LocalManifest> { return readManifest(folder, runtime) }

async function probe(url: string, rt: Runtime, signal?: AbortSignal): Promise<{ status: number, body: any } | null> {
	const controller = new AbortController(), timer = rt.setTimeout(() => controller.abort(), rt.probeTimeout);
	const abort = () => controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	try {
		// nessun reindirizzamento seguito: il controllo riguarda solo la porta locale
		const response = await rt.fetch(url, { signal: controller.signal, redirect: 'error' });
		let body: any = null;
		try { body = await response.json() } catch { }
		return { status: response.status, body };
	} catch { return null } finally { rt.clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

const hasExited = (child: any) => child.exitCode != null || child.signalCode != null;

// Chiude il processo che Vox ha avviato su `port` (solo il suo PID, mai per nome dell'eseguibile).
// Vero se il processo risulta chiuso; altrimenti resta in `owned`, così `shutdown` lo ritenta.
function closeOwned(port: number, rt: Runtime): Promise<boolean> {
	const item = owned.get(port);
	if (!item) return Promise.resolve(true);
	if (!item.closing) item.closing = closeChild(port, item, rt).finally(() => { item.closing = undefined });
	return item.closing;
}

async function closeChild(port: number, item: OwnedModel, rt: Runtime): Promise<boolean> {
	const child = item.child;
	// senza PID il processo non è mai partito (errore di avvio): non c'è niente da chiudere
	if (hasExited(child) || child.pid == null) { if (owned.get(port)?.child === child) owned.delete(port); return true }
	let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
	const waitClose = new Promise<void>(resolveClose => {
		child.once('close', () => { closed = true; if (owned.get(port)?.child === child) owned.delete(port); resolveClose() });
		timer = rt.setTimeout(resolveClose, rt.closeTimeout);
	});
	// Il rifiuto resta gestito durante taskkill; l’errore si propaga all’attesa sotto.
	void waitClose.catch(() => { });
	try {
		if (rt.platform === 'win32') {
			await new Promise<void>(resolveExec => rt.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: rt.closeTimeout }, () => resolveExec()));
		} else child.kill('SIGKILL');
	} catch { }
	await waitClose;
	if (timer !== undefined) rt.clearTimeout(timer);
	return closed;
}

export class LocalModelManager {
	private readonly rt: Runtime;
	private readonly folderCache = new Map<string, { until: number, value: string | null, error?: Error }>();
	private closing = false;
	// Modelli che la libreria sta togliendo: finché la rimozione non finisce nessuna richiesta li avvia o li riusa,
	// così fra il controllo «non è acceso» e lo spostamento del file non può ripartire niente. La chiave è il nome
	// soltanto: un modello omonimo in un'altra cartella resta fermo per i pochi secondi della rimozione (voluto: un
	// falso «si sta togliendo» non perde dati, una cartella sbagliata sì).
	private readonly removing = new Map<string, number>();
	private manifestReads = 0;
	private newest: { seq: number, folder: string, manifest: LocalManifest } | undefined;
	constructor(options: Partial<Runtime> = {}) { this.rt = { ...runtime, ...options } }
	private async serialized<T>(port: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
		const previous = locks.get(port) ?? Promise.resolve();
		let unlock!: () => void;
		const current = new Promise<void>(resolveLock => unlock = resolveLock);
		const queued = previous.then(() => current);
		locks.set(port, queued);
		let entered = false;
		try { await withAbort(previous, signal); entered = true; return await work() }
		finally {
			if (entered) unlock();
			else void previous.finally(() => {
				unlock();
				if (locks.get(port) === queued) locks.delete(port);
			});
			if (entered && locks.get(port) === queued) locks.delete(port);
		}
	}
	private throwIfClosing() { if (this.closing) throw new Error(t('Vox is closing: the local model was not started.')) }
	// La cartella in uso (stessa cache di `listChatModels` e `acquire`): serve per mostrarla nelle impostazioni.
	async folderOf(configuredFolder: string): Promise<string | null> { return findFolder(configuredFolder, this.rt, this.folderCache) }
	// Dimentica l'ultimo esito per questa cartella (anche «assente» o «non risponde», che valgono per qualche secondo),
	// così la ricerca dopo guarda di nuovo il disco: serve a «Controlla di nuovo» della libreria, dopo che l'utente ha
	// creato la cartella. Per la ricerca automatica si ripete anche quella sulle unità. Un accesso ancora appeso non si
	// rilancia: `exists` riusa quello.
	forgetFolder(configuredFolder: string): void {
		const key = folderKey(configuredFolder);
		this.folderCache.delete(key);
		if (!key) this.folderCache.delete(DRIVES_KEY);
	}
	isRunning(nome: string): boolean { return [...owned.values()].some(item => item.nome === nome) }
	// Blocca gli avvii di `nome` fino alla chiamata della funzione restituita (una sola volta conta).
	blockStarts(nome: string): () => void {
		this.removing.set(nome, (this.removing.get(nome) ?? 0) + 1);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const left = (this.removing.get(nome) ?? 1) - 1;
			if (left > 0) this.removing.set(nome, left); else this.removing.delete(nome);
		};
	}
	private throwIfRemoving(nome: string) { if (this.removing.has(nome)) throw new Error(t('The local model {0} is being removed: it was not started.', nome)) }
	// Chiude tutti i processi di Vox che tengono acceso il modello, per poterne togliere il file. `true` solo se alla
	// fine nessuno è acceso. Una richiesta già in coda può riaccenderlo subito dopo: chi toglie il file lo ricontrolla
	// con `isRunning` e, se è di nuovo in uso, non cancella niente e chiede di riprovare.
	async closeForRemoval(nome: string, signal?: AbortSignal): Promise<boolean> {
		if (this.closing) return false;
		let closed = true;
		try {
			for (const [port, initial] of [...owned.entries()].filter(([, item]) => item.nome === nome)) {
				await this.serialized(port, signal, async () => {
					const item = owned.get(port);
					if (!item || item.nome !== nome) return;
					const deadline = this.rt.now() + this.rt.leaseTimeout;
					while (item.leases > 0 && !hasExited(item.child)) {
						if (this.closing || signal?.aborted || this.rt.now() >= deadline) return;
						await withAbort(delay(this.rt.healthInterval, this.rt), signal);
					}
					if (!this.closing && !signal?.aborted) await closeOwned(port, this.rt);
				});
				if (this.closing) return false;
				if (owned.get(port) === initial) { if (signal?.aborted) return false; closed = false }
			}
			return closed && !this.isRunning(nome);
		} catch { return false }
	}
	async listModels(configuredFolder: string): Promise<{ folder: string, models: { nome: string, descrizione: string, contesto: number, uso: 'chat' | 'completamento' }[], missing: { nome: string, file: string, error?: string }[] }> {
		const folder = await findFolder(configuredFolder, this.rt, this.folderCache);
		if (!folder) throw Object.assign(new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.')), { name: (configuredFolder || '').trim() ? 'Error' : LOCAL_MODELS_NOT_CONFIGURED });
		const seq = ++this.manifestReads;
		const manifest = await readManifest(folder, this.rt, undefined, true);
		void this.closeStale(folder, manifest, seq).catch(() => { });
		const modelsToList = manifest.modelli.filter(model => model.uso === 'chat' || model.uso === 'completamento');
		const present = await Promise.all(modelsToList.map(async model => {
			try { return await exists(join(folder, 'modelli', model.file), this.rt) }
			catch (error) { return error instanceof Error ? error : new Error(String(error)) }
		}));
		const models: { nome: string, descrizione: string, contesto: number, uso: 'chat' | 'completamento' }[] = [], missing: { nome: string, file: string, error?: string }[] = [];
		modelsToList.forEach((model, index) => {
			const found = present[index];
			if (found === true) models.push({ nome: model.nome, descrizione: model.descrizione, contesto: model.contesto, uso: model.uso as 'chat' | 'completamento' });
			else missing.push({ nome: model.nome, file: join(folder, 'modelli', model.file), ...(found instanceof Error ? { error: found.message } : {}) });
		});
		return { folder, models, missing };
	}
	async listChatModels(configuredFolder: string): Promise<{ folder: string, models: { nome: string, descrizione: string, contesto: number }[], missing: { nome: string, file: string, error?: string }[] }> {
		const folder = await findFolder(configuredFolder, this.rt, this.folderCache);
		// Cartella lasciata vuota e ricerca automatica senza esito: le IA locali non ci sono, non è un guasto.
		// Il nome dell'errore lo distingue da una cartella scelta che non esiste (vedi `voxLocalList`).
		if (!folder) throw Object.assign(new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.')), { name: (configuredFolder || '').trim() ? 'Error' : LOCAL_MODELS_NOT_CONFIGURED });
		const seq = ++this.manifestReads;
		const manifest = await readManifest(folder, this.rt, undefined, true);
		void this.closeStale(folder, manifest, seq).catch(() => { });
		const chatModels = manifest.modelli.filter(model => model.uso === 'chat');
		// un file irraggiungibile o in timeout non blocca gli altri modelli: resta fra i mancanti con la sua causa
		const present = await Promise.all(chatModels.map(async model => {
			try { return await exists(join(folder, 'modelli', model.file), this.rt) }
			catch (error) { return error instanceof Error ? error : new Error(String(error)) }
		}));
		const models: { nome: string, descrizione: string, contesto: number }[] = [], missing: { nome: string, file: string, error?: string }[] = [];
		chatModels.forEach((model, index) => {
			const found = present[index];
			if (found === true) models.push({ nome: model.nome, descrizione: model.descrizione, contesto: model.contesto });
			else missing.push({ nome: model.nome, file: join(folder, 'modelli', model.file), ...(found instanceof Error ? { error: found.message } : {}) });
		});
		// la cartella usata per l'elenco: chi chiama non deve cercarla di nuovo (la cache potrebbe essere scaduta)
		return { folder, models, missing };
	}
	async acquire(configuredFolder: string, nome: string, options: { signal?: AbortSignal, onStatus?: (text: string) => void, uso?: 'chat' | 'completamento' } = {}): Promise<LocalModelLease> {
		const { signal } = options;
		const uso = options.uso ?? 'chat';
		throwIfAborted(signal);
		this.throwIfClosing();
		const folder = await withAbort(findFolder(configuredFolder, this.rt, this.folderCache), signal);
		if (!folder) throw new Error(t('Vox local AI folder not found: create ia-locali with modelli.json or choose the folder in the settings.'));
		let readError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			readError = undefined;
			throwIfAborted(signal);
			this.throwIfClosing();
			this.throwIfRemoving(nome);
			const seq = ++this.manifestReads;
			const manifest = await readManifest(folder, this.rt, signal), model = manifest.modelli.find(entry => entry.nome === nome);
			const failedCloses = await withAbort(this.closeStale(folder, manifest, seq, model?.uso === uso ? model.porta : undefined), signal);
			if (failedCloses.length) throw new Error(t(failedCloses.length === 1 ? 'Unable to close the local model {0}.' : 'Unable to close the local models {0}.', failedCloses.join(', ')));
			if (!model) throw new Error(t('Local model {0} was not found in the manifest.', nome));
			// ogni modello si avvia solo per il suo uso: la chat non avvia un modello di completamento e viceversa;
			// i modelli di embedding non si avviano da qui
			if (model.uso !== uso) throw new Error(uso === 'completamento' ? t('Local model {0} is not a completion model.', nome) : t('Local model {0} is not a chat model.', nome));
			const { modelFile, args, firma } = commandOf(folder, manifest, model);
			const matchesManifest = async (): Promise<boolean | undefined> => {
				try {
					const newest = await readManifest(folder, this.rt, signal), newestModel = newest.modelli.find(entry => entry.nome === nome);
					return !!newestModel && newestModel.porta === model.porta && newestModel.uso === uso && commandOf(folder, newest, newestModel).firma === firma;
				} catch (error) { readError = error; return undefined }
			};
			// una chiusura fallita non si ritenta sui tentativi seguenti: stesso errore di `replaceOwned`
			let closeFailed: OwnedModel | undefined;
			const lease = await this.serialized(model.porta, signal, async () => {
				// mai due taskkill sullo stesso processo in una sezione: l'insieme ricorda chi ha già tentato la chiusura
				const closeTried = new Set<OwnedModel>();
				// La porta è già serializzata: si chiude il processo superato prima del prossimo tentativo.
				const closeSuperseded = async (item: OwnedModel): Promise<void> => {
					if (this.closing || owned.get(model.porta) !== item) return;
					if (item.leases > 0) { item.superseded = true; return }
					if (closeTried.has(item)) return;
					closeTried.add(item);
					if (!(await closeOwned(model.porta, this.rt).catch(() => false))) closeFailed = item;
				};
				const onClose = (item: OwnedModel) => { closeTried.add(item) };
				try {
					throwIfAborted(signal);
					this.throwIfClosing();
					this.throwIfRemoving(nome);
					const baseURL = `http://127.0.0.1:${model.porta}/v1`, modelsURL = `${baseURL}/models`, healthURL = `http://127.0.0.1:${model.porta}/health`;
					const response = await probe(modelsURL, this.rt, signal);
					throwIfAborted(signal);
					let current = owned.get(model.porta);
					// un processo di Vox già uscito non conta più come proprietario della porta
					if (current && hasExited(current.child)) { owned.delete(model.porta); current = undefined }
					// lo stesso modello avviato da Vox con lo stesso manifesto; se il manifesto è cambiato va riavviato
					const same = current?.nome === nome && current.uso === uso && current.firma === firma;
					if (current && same && this.isStale(model.porta, current)) { await closeSuperseded(current); return undefined }
					const waitForReady = async (item: OwnedModel): Promise<LocalModelLease | undefined> => {
						let ready: LocalModelLease | undefined;
						let valid = false, matches: boolean | undefined;
						try {
							ready = await this.waitUntilReady(baseURL, healthURL, model, item, folder, { ...options, onClose });
							matches = await matchesManifest();
							if (matches === true) delete item.superseded;
							throwIfAborted(signal); this.throwIfClosing();
							// la libreria ha cominciato a togliere il modello mentre si aspettava che fosse pronto: niente prestito
							this.throwIfRemoving(nome);
							valid = matches === true;
							return valid ? ready : undefined;
						} finally {
							if (!valid) {
								// il prestito nasce in questa sezione e non esce mai: si toglie senza `release`,
								// che metterebbe in coda una chiusura dopo quella tentata qui sotto
								if (ready) item.leases = Math.max(0, item.leases - 1);
								if (matches === false || item.superseded || this.isStale(model.porta, item) || this.removing.has(nome)) await closeSuperseded(item);
							}
						}
					};
					if (response?.status === 200) {
						const data = response.body?.data;
						const ids = Array.isArray(data) ? data.map((entry: any) => entry?.id) : [];
						if (ids.includes(nome) && (!current || same)) {
							const matches = await matchesManifest();
							if (matches === false && current) await closeSuperseded(current);
							if (matches === true && current) delete current.superseded;
							throwIfAborted(signal); this.throwIfClosing();
							if (matches === true) { this.throwIfRemoving(nome); return this.lease(baseURL, current, model.porta) }
							return undefined;
						}
						if (!current) throw new Error(t('Port {0} is occupied by another program ({1}); close it or change the port in modelli.json.', model.porta, ids[0] ?? t('unknown model')));
					} else if (response?.status === 503) {
						if (!current) throw new Error(t('Port {0} is occupied by another program ({1}); close it or change the port in modelli.json.', model.porta, t('a model is loading')));
					} else if (response && !current) {
						throw new Error(t('Port {0} is occupied by another program.', model.porta));
					}
					// Da qui la porta è libera oppure la occupa un processo avviato da Vox: in ogni caso c'è da aspettare.
					// Lo stesso modello ancora in avvio (503, o nessuna risposta mentre carica): si aspetta che sia pronto.
					if (current && same) {
						options.onStatus?.(t('Starting the local model {0}…', nome));
						return await waitForReady(current);
					}
					throwIfAborted(signal);
					this.throwIfClosing();
					if (!await matchesManifest()) return undefined;
					options.onStatus?.(t('Starting the local model {0}…', nome));
					// prima di chiudere il modello in uso: se il nuovo non può partire, quello resta acceso
					if (!await exists(modelFile, this.rt, this.rt.ioTimeout, signal)) throw new Error(t('Local model file not found: {0}', modelFile));
					if (!await exists(manifest.motore, this.rt, this.rt.ioTimeout, signal)) throw new Error(t('Local model engine not found: {0}', manifest.motore));
					throwIfAborted(signal);
					this.throwIfClosing();
					// Un altro modello di Vox (o lo stesso con un manifesto cambiato), anche se non ha risposto alla sonda:
					// va chiuso, mai lasciato orfano.
					if (current) {
						await this.replaceOwned(model.porta, modelsURL, current, nome, { ...options, onClose });
						if (!await matchesManifest()) return undefined;
					}
					throwIfAborted(signal);
					const logPath = join(folder, 'avvia', `${nome}.log`);
					let log: Awaited<ReturnType<typeof open>> | undefined;
					let abandoned = false;
					// Il registro si riscrive a ogni avvio; un handle arrivato dopo timeout o Stop va chiuso.
					const opening = (async () => {
						await this.rt.mkdir(join(folder, 'avvia'), { recursive: true });
						if (abandoned) return undefined;
						return this.rt.open(logPath, 'w');
					})();
					try { log = await withDeadline(opening, this.rt.logTimeout, this.rt, t('Timed out while opening local model log: {0}', logPath), signal) }
					catch {
						abandoned = true;
						void opening.then(handle => handle?.close().catch(() => { }), () => { });
						throwIfAborted(signal);
					}
					// Nessun `await` fra questi controlli e `owned.set`: `shutdown` vede il processo oppure ne impedisce l'avvio.
					if (signal?.aborted || this.closing || this.removing.has(nome)) { await log?.close(); throwIfAborted(signal); this.throwIfClosing(); this.throwIfRemoving(nome) }
					let child: any;
					try { child = this.rt.spawn(manifest.motore, args, { cwd: dirname(manifest.motore), shell: false, windowsHide: true, stdio: log ? ['ignore', log.fd, log.fd] : 'ignore' }) }
					catch { await log?.close(); throw new Error(t('Unable to start local model {0}.', nome)) }
					// il processo figlio ha già la sua copia del registro: Vox non tiene aperto il file
					if (log) void Promise.resolve(log.close()).catch(() => { });
					const item: OwnedModel = { child, nome, uso, firma, leases: 0 };
					owned.set(model.porta, item);
					child.once('close', () => { if (owned.get(model.porta)?.child === child) owned.delete(model.porta) });
					child.once('error', (error: Error) => { child.spawnError = error; if (owned.get(model.porta)?.child === child) owned.delete(model.porta) });
					return await waitForReady(item);
				} finally {
					const item = owned.get(model.porta);
					if (item && item.leases === 0 && !this.closing && this.isStale(model.porta, item)) await closeSuperseded(item);
				}
			});
			if (lease) return lease;
			if (closeFailed) throw new Error(t('Unable to close the local model {0}.', closeFailed.nome));
			if (readError instanceof Error && readError.name === 'TimeoutError') throw readError;
		}
		if (readError) throw readError;
		throw new Error(t('modelli.json changed while starting the local model {0}: try again.', nome));
	}
	private isStale(port: number, item: OwnedModel): boolean {
		const newest = this.newest;
		return !!newest && !newest.manifest.modelli.some(model =>
			model.uso === item.uso && model.nome === item.nome && model.porta === port && commandOf(newest.folder, newest.manifest, model).firma === item.firma);
	}
	private async closeStale(folder: string, manifest: LocalManifest, seq: number, skipPort?: number): Promise<string[]> {
		const closing: Promise<string | undefined>[] = [];
		if (!this.closing && seq >= (this.newest?.seq ?? 0)) {
			this.newest = { seq, folder, manifest };
			for (const [port, item] of owned) {
				if (port === skipPort || locks.has(port) || !this.isStale(port, item)) continue;
				closing.push(this.serialized(port, undefined, async () => {
					if (owned.get(port) !== item || this.closing || item.leases > 0 || !this.isStale(port, item)) return undefined;
					// il nome di un modello che non si è chiuso: `acquire` non ne avvia altri
					return await closeOwned(port, this.rt) ? undefined : item.nome;
				}).catch(() => item.nome));
			}
		}
		for (const [port, item] of owned) {
			if (port !== skipPort && item.closing) closing.push(item.closing.then(closed => closed ? undefined : item.nome).catch(() => item.nome));
		}
		const results = await Promise.allSettled(closing);
		return [...new Set(results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []))];
	}
	// Chiude il processo di Vox che occupa la porta con un altro modello e aspetta che la porta si liberi.
	private async replaceOwned(port: number, modelsURL: string, current: OwnedModel, nome: string, options: { signal?: AbortSignal, onStatus?: (text: string) => void, onClose?: (item: OwnedModel) => void }): Promise<void> {
		const { signal } = options;
		// Un'altra chat sta ancora ricevendo una risposta da quel modello: si aspetta che finisca (annullabile).
		// Le richieste per questa porta restano in coda dietro a questa; il rilascio del prestito non passa dalla coda.
		if (current.leases > 0) {
			options.onStatus?.(t('Waiting for the local model {0} to finish another request…', current.nome));
			const deadline = this.rt.now() + this.rt.leaseTimeout;
			while (current.leases > 0 && !hasExited(current.child)) {
				if (this.rt.now() >= deadline) throw new Error(t('Local model {0} is still serving another request: wait for it to finish and try again.', current.nome));
				await withAbort(delay(this.rt.healthInterval, this.rt), signal);
			}
			this.throwIfClosing();
			options.onStatus?.(t('Starting the local model {0}…', nome));
		}
		// la chiusura non si interrompe a metà: un secondo taskkill sullo stesso PID potrebbe colpire un processo nuovo
		options.onClose?.(current);
		const closed = await closeOwned(port, this.rt).catch(() => false);
		throwIfAborted(signal);
		if (!closed) throw new Error(t('Unable to close the local model {0}.', current.nome));
		const deadline = this.rt.now() + this.rt.switchTimeout;
		let response: { status: number, body: any } | null = null;
		while (this.rt.now() < deadline) {
			throwIfAborted(signal);
			response = await probe(modelsURL, this.rt, signal);
			throwIfAborted(signal);
			if (!response) break;
			await withAbort(delay(this.rt.healthInterval, this.rt), signal);
		}
		if (response) throw new Error(t('Port {0} is occupied by another program.', port));
	}
	private lease(baseURL: string, item?: OwnedModel, port?: number): LocalModelLease {
		if (item) item.leases++;
		let released = false;
		return { baseURL, release: () => {
			if (released) return;
			released = true;
			if (!item) return;
			item.leases = Math.max(0, item.leases - 1);
			if (!port || item.leases > 0 || this.closing || owned.get(port) !== item || !(item.superseded || this.isStale(port, item))) return;
			void this.serialized(port, undefined, async () => {
				if (this.closing || owned.get(port) !== item || item.leases !== 0 || !(item.superseded || this.isStale(port, item))) return;
				await closeOwned(port, this.rt);
			}).catch(() => { });
		} };
	}
	private async waitUntilReady(baseURL: string, healthURL: string, model: LocalModelEntry, item: OwnedModel, folder: string, options: { signal?: AbortSignal, onClose?: (item: OwnedModel) => void }): Promise<LocalModelLease> {
		const started = this.rt.now();
		while (this.rt.now() - started < this.rt.healthTimeout) {
			throwIfAborted(options.signal);
			if (item.child.spawnError) throw new Error(t('Unable to start local model {0}: {1}', model.nome, item.child.spawnError.message));
			if (hasExited(item.child)) {
				if (owned.get(model.porta)?.child === item.child) owned.delete(model.porta);
				let tail = '';
				try {
					const logPath = join(folder, 'avvia', `${model.nome}.log`);
					const log = await withDeadline(this.rt.readFile(logPath), this.rt.logTimeout, this.rt, t('Timed out while reading local model log: {0}', logPath), options.signal);
					tail = String(log).split(/\r?\n/).filter(Boolean).slice(-15).join('\n');
				} catch { }
				throwIfAborted(options.signal);
				throw new Error(t('Local model {0} exited before becoming ready. Log: {1}', model.nome, tail || t('No log output.')));
			}
			const ready = await probe(healthURL, this.rt, options.signal);
			throwIfAborted(options.signal);
			// pronto solo se a rispondere è ancora il processo di Vox (se è uscito, il giro dopo mostra il registro)
			if (ready?.status === 200 && !hasExited(item.child) && !item.child.spawnError) return this.lease(baseURL, item, model.porta);
			await withAbort(delay(this.rt.healthInterval, this.rt), options.signal);
		}
		options.onClose?.(item);
		await closeOwned(model.porta, this.rt).catch(() => false);
		throw new Error(t('Timed out while starting local model {0}.', model.nome));
	}
	// Chiude tutti e soli i processi avviati da Vox; da qui in poi non ne avvia altri. Non lancia eccezioni.
	async shutdown(): Promise<void> {
		this.closing = true;
		await Promise.all([...owned.keys()].map(port => closeOwned(port, this.rt).catch(() => false)));
	}
}

export const localModelManager = new LocalModelManager();
