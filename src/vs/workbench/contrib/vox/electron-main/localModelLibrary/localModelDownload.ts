import { open, stat, rename, unlink, mkdir, statfs, link, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isAllowedLocalModelDownloadURL, LOCAL_MODEL_DOWNLOAD_MAX_REDIRECTS, LocalModelDownloadState } from '../../common/localModelLibraryTypes.js';
import { t } from '../../common/voxI18n.js';

export type DownloadRuntime = {
	fetch: typeof fetch, open: typeof open, stat: typeof stat, rename: typeof rename,
	link: typeof link, readFile: typeof readFile, writeFile: typeof writeFile,
	unlink: typeof unlink, mkdir: typeof mkdir, statfs?: typeof statfs, now: () => number, createHash: typeof createHash,
	// quanto si aspetta un blocco di dati prima di dichiarare ferma la connessione (i test lo accorciano)
	idleTimeout?: number,
};
const runtime: DownloadRuntime = { fetch, open, stat, rename, unlink, mkdir, statfs, link, readFile, writeFile, now: () => Date.now(), createHash };
type ActiveState = Extract<LocalModelDownloadState, { stato: 'scarico' | 'controllo' }>;
type Progress = Pick<ActiveState, 'ricevuti' | 'totale'> & { fase: ActiveState['stato'] };
const abortError = () => Object.assign(new Error(t('Local model request canceled.')), { name: 'AbortError' });
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortError() };
const IDLE_TIMEOUT_MS = 120000;
const RESERVED_BYTES = 512 * 1024 * 1024, SPACE_CHECK_BYTES = 256 * 1024 * 1024;
// L'errore di rete porta con sé il codice della causa (per esempio ENOTFOUND o un errore di certificato), se c'è.
const networkError = (error: unknown) => {
	const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
	return new Error(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? t('Model download failed: network error ({0}).', code) : t('Model download failed: network error.'));
};
const verificationFailed = () => new Error(t('Model verification failed (GGUF, size or SHA-256). The partial file was removed.'));
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const sizeOf = async (file: string, rt: DownloadRuntime) => {
	try { return (await rt.stat(file)).size } catch (error) { if (missing(error)) return null; throw error }
};

// Rimette il file appena pubblicato al posto del parziale (per esempio se `modelli.json` non si è potuto scrivere):
// così il prossimo scarico lo riprende o lo ricontrolla invece di trovare un file senza voce che blocca tutto.
export async function restorePartialDownload(destination: string, rt: DownloadRuntime = runtime): Promise<void> {
	if (await sizeOf(destination + '.parziale', rt) !== null) return;
	await rt.rename(destination, destination + '.parziale');
}

export async function removePartialDownload(destination: string, rt: DownloadRuntime = runtime): Promise<void> {
	for (const suffix of ['.parziale', '.parziale.json']) {
		try { await rt.unlink(destination + suffix) } catch (error) { if (!missing(error)) throw error }
	}
}

// Legge il file per intero: byte letti, SHA-256 e i primi quattro byte (`GGUF` per un modello).
async function hashFile(file: string, total: number | null, signal: AbortSignal, onProgress: (progress: Progress) => void, rt: DownloadRuntime): Promise<{ bytes: number, sha256: string, magic: string }> {
	let lastProgress = rt.now();
	const input = await rt.open(file, 'r');
	const hash = rt.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
	let bytes = 0, magic = '';
	try {
		for (;;) {
			checkAbort(signal);
			const { bytesRead } = await input.read(buffer, 0, buffer.length, bytes);
			if (!bytesRead) break;
			if (bytes < 4) magic += buffer.subarray(0, Math.min(4 - bytes, bytesRead)).toString('latin1');
			hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
			const now = rt.now();
			if (now - lastProgress >= 250) { lastProgress = now; onProgress({ fase: 'controllo', ricevuti: bytes, totale: total }) }
		}
	} finally { await input.close() }
	onProgress({ fase: 'controllo', ricevuti: bytes, totale: total });
	return { bytes, sha256: hash.digest('hex'), magic };
}

// Controlla un file che è già in `modelli/` prima di aggiungerlo a `modelli.json` senza scaricarlo. Non tocca il file:
// se non è quello atteso lo dice e basta, perché è un file dell'utente.
export async function verifyLocalModelFile(p: {
	file: string, expectedBytes: number | null, expectedSha256: string | null,
	signal: AbortSignal, onProgress: (progress: Progress) => void,
}, rt: DownloadRuntime = runtime): Promise<{ bytes: number, sha256: string }> {
	checkAbort(p.signal);
	p.onProgress({ fase: 'controllo', ricevuti: 0, totale: p.expectedBytes });
	const { bytes, sha256, magic } = await hashFile(p.file, p.expectedBytes, p.signal, p.onProgress, rt);
	checkAbort(p.signal);
	if (magic !== 'GGUF' || (p.expectedBytes !== null && bytes !== p.expectedBytes) || (p.expectedSha256 !== null && sha256 !== p.expectedSha256.toLowerCase())) {
		throw new Error(t('The file {0} is already there but it is not the expected model (GGUF, size or SHA-256). Move it elsewhere and try again.', p.file));
	}
	return { bytes, sha256 };
}

export async function downloadLocalModel(p: {
	url: string, destination: string, expectedBytes: number | null, expectedSha256: string | null,
	signal: AbortSignal, onProgress: (progress: Progress) => void,
}, rt: DownloadRuntime = runtime): Promise<{ bytes: number, sha256: string }> {
	checkAbort(p.signal);
	if (!isAllowedLocalModelDownloadURL(p.url, true)) throw new Error(t('Model download URL is not allowed.'));
	if ((p.expectedBytes !== null && (!Number.isSafeInteger(p.expectedBytes) || p.expectedBytes < 4)) ||
		(p.expectedSha256 !== null && !/^[a-f0-9]{64}$/i.test(p.expectedSha256))) throw new Error(t('Invalid model size or SHA-256.'));
	const refuseExisting = async () => {
		if (await sizeOf(p.destination, rt) !== null) throw new Error(t('Model file already exists: {0}', p.destination));
	};
	await refuseExisting();
	const folder = dirname(p.destination), partial = p.destination + '.parziale';
	await rt.mkdir(folder, { recursive: true });
	const partialSize = await sizeOf(partial, rt) ?? 0;
	let received = partialSize, ifRange: string | null = null, savedTotal: number | null = null;
	if (received) {
		let saved: any = null;
		try { saved = JSON.parse(await rt.readFile(partial + '.json', 'utf8')) } catch { /* Metadati assenti o illeggibili. */ }
		if (saved !== null && typeof saved === 'object') {
			ifRange = typeof saved.etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(saved.etag) ? saved.etag :
				typeof saved.lastModified === 'string' && Number.isFinite(Date.parse(saved.lastModified)) && !/[\r\n]/.test(saved.lastModified) ? saved.lastModified : null;
			savedTotal = Number.isSafeInteger(saved.totale) && saved.totale >= received ? saved.totale : null;
		} else saved = null;
		const sameURL = saved !== null && typeof saved.url === 'string' && saved.url === p.url;
		// un parziale cominciato da un altro indirizzo (stesso nome di file, altro repository) non si continua, neanche
		// per l'elenco consigliato (prima lo si riprendeva e l'errore arrivava solo al controllo finale, dopo gigabyte)
		if (saved !== null && typeof saved.url === 'string' && !sameURL) received = 0;
		// più lungo del file atteso: non può essere suo
		else if (p.expectedBytes !== null && received > p.expectedBytes) received = 0;
		// Senza SHA-256 atteso si continua solo con un validatore del server, oppure se il parziale dello stesso indirizzo
		// è già intero (allora lo si controlla e basta: prima lo si scaricava di nuovo da capo).
		else if (!p.expectedSha256 && !ifRange && !(sameURL && savedTotal !== null && received === savedTotal)) received = 0;
	}
	// Il parziale è già intero (pausa, annullo o chiusura di Vox durante il controllo): si controlla e basta, senza
	// chiedere niente alla rete. Prima il server rispondeva 416 e tutto il file veniva scaricato di nuovo.
	const knownTotal = p.expectedBytes ?? (received ? savedTotal : null);
	const complete = received > 0 && knownTotal !== null && received === knownTotal;
	p.onProgress({ fase: 'scarico', ricevuti: received, totale: p.expectedBytes ?? (complete ? knownTotal : null) });
	const request = async (range: string | null): Promise<Response> => {
		let url = p.url;
		for (let redirects = 0; ; redirects++) {
			checkAbort(p.signal);
			let response: Response;
			// anche la risposta (intestazioni comprese) ha un tempo massimo: un server muto non tiene fermo lo scarico
			const controller = new AbortController();
			const forward = () => controller.abort();
			if (p.signal.aborted) controller.abort(); else p.signal.addEventListener('abort', forward, { once: true });
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; controller.abort() }, rt.idleTimeout ?? IDLE_TIMEOUT_MS);
			try {
				response = await rt.fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
					headers: { 'User-Agent': 'Vox', ...(range ? { Range: range, ...(ifRange ? { 'If-Range': ifRange } : {}) } : {}) }, signal: controller.signal });
			} catch (error) {
				p.signal.removeEventListener('abort', forward);
				if (p.signal.aborted) throw abortError();
				if (timedOut) throw new Error(t('Model download failed: the server did not answer. Download again to resume.'));
				throw networkError(error);
			} finally { clearTimeout(timer) }
			// Il corpo si ferma da sé all'annullo (`cancelRead` più sotto): l'ascoltatore non serve più e, con i
			// reindirizzamenti, non se ne accumulano.
			p.signal.removeEventListener('abort', forward);
			if (![301, 302, 303, 307, 308].includes(response.status)) return response;
			await response.body?.cancel().catch(() => {});
			const location = response.headers.get('location');
			if (redirects >= LOCAL_MODEL_DOWNLOAD_MAX_REDIRECTS) throw new Error(t('Too many model download redirects.'));
			try { url = location ? new URL(location, url).href : '' } catch { url = '' }
			if (!isAllowedLocalModelDownloadURL(url, false)) throw new Error(t('Model download redirect is not allowed.'));
		}
	};
	// Scarica nel file parziale quello che manca e restituisce la dimensione totale, se il server l'ha detta.
	const receive = async (): Promise<number | null> => {
	let response = await request(received ? `bytes=${received}-` : null);
	try {
		if (response.status === 416) {
			await response.body?.cancel().catch(() => {});
			received = 0;
			response = await request(null);
		}
		if (response.status !== 200 && response.status !== 206) throw new Error(t('Model download failed (HTTP {0}).', response.status));
		let total = p.expectedBytes;
		if (response.status === 206) {
			const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
			// Una risposta che non continua il parziale (file cambiato sul server, o non è il file atteso): il parziale non
			// serve più e si toglie, altrimenti ogni nuovo tentativo chiederebbe lo stesso pezzo e fallirebbe per sempre.
			const mismatch = async () => {
				await response.body?.cancel().catch(() => {});
				await removePartialDownload(p.destination, rt);
				return new Error(t('Model download failed: the server sent a different file. The partial file was removed: download again to start over.'));
			};
			if (!range || Number(range[1]) !== received || Number(range[2]) < received || Number(range[2]) !== Number(range[3]) - 1 ||
				!Number.isSafeInteger(Number(range[3])) || (total !== null && total !== Number(range[3]))) throw await mismatch();
			total ??= Number(range[3]);
			if (received && !p.expectedSha256 && savedTotal !== null && total !== savedTotal) throw await mismatch();
		} else {
			received = 0;
			const length = response.headers.get('content-length');
			if (length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) {
				if (total !== null && total !== Number(length)) {
					await removePartialDownload(p.destination, rt);
					throw verificationFailed();
				}
				total ??= Number(length);
			}
		}
		let free: number | undefined;
		try { const disk = await rt.statfs?.(folder); if (disk) free = Number(disk.bavail) * Number(disk.bsize) } catch { /* Lo scarico resta possibile sui dischi senza statfs. */ }
		if (!received && free !== undefined) free += partialSize;
		if (total !== null && free !== undefined && total - received > free - RESERVED_BYTES) {
			throw new Error(t('Not enough disk space: {0} GB needed, {1} GB free (512 MB reserved).', ((total - received) / 1024 ** 3).toFixed(2), (free / 1024 ** 3).toFixed(2)));
		}
		checkAbort(p.signal);
		if (!response.body) throw new Error(t('Model download failed: network error.'));
		if (!received) {
			try { await rt.unlink(partial + '.json') } catch (error) { if (!missing(error)) throw error }
		}
		const file = await rt.open(partial, received ? 'a' : 'w');
		const reader = response.body.getReader();
		const cancelRead = () => { void reader.cancel().catch(() => {}) };
		p.signal.addEventListener('abort', cancelRead, { once: true });
		let lastProgress = rt.now(), overflow = false;
		// Senza dimensione nota il controllo iniziale dello spazio non si può fare: lo si ripete ogni 256 MB ricevuti.
		let nextSpaceCheck = total === null ? received : Infinity;
		try {
			if (!received && !p.expectedSha256) await rt.writeFile(partial + '.json', JSON.stringify({
				etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), totale: total, url: p.url,
			}), 'utf8');
			for (;;) {
				checkAbort(p.signal);
				let chunk: ReadableStreamReadResult<Uint8Array>;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					// una connessione che resta aperta senza mandare dati non deve tenere fermo lo scarico per sempre
					const pending = reader.read();
					void pending.catch(() => {});
					chunk = await Promise.race([pending, new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(Object.assign(new Error('stall'), { name: 'StallError' })), rt.idleTimeout ?? IDLE_TIMEOUT_MS);
					})]);
				} catch (error) {
					if (p.signal.aborted) throw abortError();
					if ((error as Error | null)?.name === 'StallError') throw new Error(t('Model download failed: the server stopped sending data. Download again to resume.'));
					throw networkError(error);
				} finally { clearTimeout(timer) }
				if (chunk.done) break;
				checkAbort(p.signal);
				// più dati di quelli dichiarati: non è il file atteso, e non si riempie il disco per scoprirlo alla fine
				if (total !== null && received + chunk.value.length > total) { overflow = true; break }
				if (received >= nextSpaceCheck) {
					nextSpaceCheck = received + SPACE_CHECK_BYTES;
					let left: number | undefined;
					try { const disk = await rt.statfs?.(folder); if (disk) left = Number(disk.bavail) * Number(disk.bsize) } catch { /* dischi senza statfs */ }
					// il parziale resta: liberato lo spazio, lo scarico riprende da qui
					if (left !== undefined && left - chunk.value.length < RESERVED_BYTES) throw new Error(t('Not enough disk space: the download stopped with {0} GB free (512 MB are kept free). The partial file was kept: free some space and download again to resume.', (left / 1024 ** 3).toFixed(2)));
				}
				for (let offset = 0; offset < chunk.value.length;) {
					checkAbort(p.signal);
					const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.length - offset);
					if (!bytesWritten) throw new Error(t('Unable to write the partial model.'));
					offset += bytesWritten; received += bytesWritten;
					const now = rt.now();
					if (now - lastProgress >= 250) { lastProgress = now; p.onProgress({ fase: 'scarico', ricevuti: received, totale: total }) }
				}
			}
			if (!overflow) { checkAbort(p.signal); p.onProgress({ fase: 'scarico', ricevuti: received, totale: total }) }
		} finally { p.signal.removeEventListener('abort', cancelRead); try { await reader.cancel().catch(() => {}) } finally { await file.close() } }
		if (overflow) { await removePartialDownload(p.destination, rt); throw verificationFailed() }
		return total;
	} finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}) }
	};
	try {
		const total = complete ? knownTotal : await receive();
		p.onProgress({ fase: 'controllo', ricevuti: 0, totale: total });
		const { bytes, sha256, magic } = await hashFile(partial, total, p.signal, p.onProgress, rt);
		checkAbort(p.signal);
		if (magic !== 'GGUF' || (total !== null && bytes !== total) || (p.expectedSha256 !== null && sha256 !== p.expectedSha256.toLowerCase())) {
			await removePartialDownload(p.destination, rt);
			throw verificationFailed();
		}
		await refuseExisting();
		checkAbort(p.signal);
		try { await rt.link(partial, p.destination) } catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EEXIST') throw new Error(t('Model file already exists: {0}', p.destination));
			if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(code ?? '')) throw error;
			// Disco senza hard link (FAT32 o exFAT, come le chiavette della versione portabile). Su Windows `rename`
			// sostituirebbe un file comparso nel frattempo: prima si crea il file finale vuoto in modo esclusivo ('wx',
			// che fallisce se esiste già) e solo dopo lo si sostituisce col parziale. Si rimpiazza solo un file nostro.
			let placeholder: Awaited<ReturnType<typeof rt.open>>;
			try { placeholder = await rt.open(p.destination, 'wx') } catch (openError) {
				if ((openError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(t('Model file already exists: {0}', p.destination));
				throw openError;
			}
			await placeholder.close();
			try { await rt.rename(partial, p.destination) } catch (renameError) {
				// il segnaposto vuoto bloccherebbe ogni nuovo tentativo («esiste già»): si toglie, solo se è ancora vuoto
				try { if (await sizeOf(p.destination, rt) === 0) await rt.unlink(p.destination) } catch { /* resta: lo dirà il prossimo tentativo */ }
				throw renameError;
			}
		}
		await removePartialDownload(p.destination, rt);
		return { bytes, sha256 };
	} catch (error) { if (p.signal.aborted) throw abortError(); throw error }
}
