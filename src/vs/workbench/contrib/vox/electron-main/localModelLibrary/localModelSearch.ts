/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Ricerca dei modelli su Hugging Face per la libreria dei modelli locali. Insieme allo scarico
// (`localModelDownload.ts`) è l'unico punto di Vox che parla con Internet. A Hugging Face arriva solo il testo
// scritto dall'utente nella casella di ricerca (o il nome del repository scelto fra i risultati): mai conversazioni,
// codice, impostazioni o file. Solo richieste GET a `https://huggingface.co/api/models`, senza credenziali, senza
// seguire reindirizzamenti e con un limite alla dimensione della risposta.
import { isDownloadableLocalModelFileName, LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST, LOCAL_MODEL_REPO_PATTERN, LOCAL_MODEL_SEARCH_MAX_LENGTH, LOCAL_MODEL_SEARCH_MAX_RESULTS } from '../../common/localModelLibraryTypes.js';
import type { LocalModelRepoFile, LocalModelRepoFiles, LocalModelSearchResult } from '../../common/localModelLibraryTypes.js';
import { t } from '../../common/voxI18n.js';

export type SearchRuntime = { fetch: typeof fetch, timeout: number, maxBytes: number };
const runtime: SearchRuntime = { fetch, timeout: 15000, maxBytes: 4 * 1024 * 1024 };
const API = `https://${LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST}/api/models`;
const abortError = () => Object.assign(new Error(t('Local model request canceled.')), { name: 'AbortError' });
// un modello diviso in più file (`-00001-of-00003.gguf`) non si può usare: Vox avvia un file solo
const SPLIT_FILE = /-\d{5}-of-\d{5}\.gguf$/i;
const MAX_FILES = 200;

// Una richiesta GET che restituisce JSON, con scadenza e limite di dimensione. `signal` è l'annullo del chiamante.
async function getJSON(url: string, signal: AbortSignal | undefined, rt: SearchRuntime): Promise<any> {
	if (signal?.aborted) throw abortError();
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort() }, rt.timeout);
	const forward = () => controller.abort();
	signal?.addEventListener('abort', forward, { once: true });
	try {
		let response: Response;
		try { response = await rt.fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'User-Agent': 'Vox', Accept: 'application/json' }, signal: controller.signal }) }
		catch (error) {
			if (signal?.aborted) throw abortError();
			if (timedOut) throw new Error(t('Hugging Face did not answer in time. Check the connection and try again.'));
			const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
			throw new Error(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? t('Model search failed: network error ({0}).', code) : t('Model search failed: network error.'));
		}
		if (response.status === 404) throw new Error(t('This model was not found on Hugging Face.'));
		if (response.status === 401 || response.status === 403) throw new Error(t('This model requires a Hugging Face account: Vox cannot download it.'));
		if (response.status === 429) throw new Error(t('Hugging Face is receiving too many requests: wait a moment and try again.'));
		if (!response.ok) throw new Error(t('Model search failed: Hugging Face answered {0}.', response.status));
		// la risposta si legge a blocchi e si ferma al limite: un server che risponde senza fine non riempie la memoria
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body?.getReader();
		if (!reader) throw new Error(t('Model search failed: unreadable answer.'));
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > rt.maxBytes) { controller.abort(); throw new Error(t('Model search failed: the answer is too large.')) }
				chunks.push(value);
			}
		} catch (error) {
			if (signal?.aborted) throw abortError();
			if (timedOut) throw new Error(t('Hugging Face did not answer in time. Check the connection and try again.'));
			throw error;
		}
		try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
		catch { throw new Error(t('Model search failed: unreadable answer.')) }
	} finally { clearTimeout(timer); signal?.removeEventListener('abort', forward) }
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

// Cerca i repository con file GGUF, dal più scaricato. Il testo è quello scritto dall'utente, senza altro.
export async function searchLocalModels(text: string, signal?: AbortSignal, rt: SearchRuntime = runtime): Promise<LocalModelSearchResult[]> {
	const query = typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
	if (query.length < 2 || query.length > LOCAL_MODEL_SEARCH_MAX_LENGTH) throw new Error(t('Write between 2 and {0} characters to search.', LOCAL_MODEL_SEARCH_MAX_LENGTH));
	const params = new URLSearchParams({ search: query, filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(LOCAL_MODEL_SEARCH_MAX_RESULTS) });
	const raw = await getJSON(`${API}?${params}`, signal, rt);
	if (!Array.isArray(raw)) throw new Error(t('Model search failed: unreadable answer.'));
	const results: LocalModelSearchResult[] = [];
	for (const item of raw) {
		const repo = item?.id;
		// i repository privati o con accesso a richiesta non si possono scaricare senza un account
		if (typeof repo !== 'string' || !LOCAL_MODEL_REPO_PATTERN.test(repo) || item.private === true || (item.gated !== undefined && item.gated !== false)) continue;
		if (results.some(found => found.repo === repo)) continue;
		results.push({ repo, scaricamenti: count(item.downloads), preferenze: count(item.likes) });
		if (results.length >= LOCAL_MODEL_SEARCH_MAX_RESULTS) break;
	}
	return results;
}

// I file `.gguf` di un repository, con dimensione e SHA-256, alla revisione letta ora (così lo scarico prende
// esattamente quei file anche se il repository cambia).
export async function listLocalModelRepoFiles(repo: string, signal?: AbortSignal, rt: SearchRuntime = runtime): Promise<LocalModelRepoFiles> {
	if (typeof repo !== 'string' || !LOCAL_MODEL_REPO_PATTERN.test(repo)) throw new Error(t('This model was not found on Hugging Face.'));
	const raw = await getJSON(`${API}/${repo}?blobs=true`, signal, rt);
	if (raw === null || typeof raw !== 'object' || raw.id !== repo) throw new Error(t('Model search failed: unreadable answer.'));
	if (raw.private === true || (raw.gated !== undefined && raw.gated !== false)) throw new Error(t('This model requires a Hugging Face account: Vox cannot download it.'));
	if (typeof raw.sha !== 'string' || !/^[a-f0-9]{40}$/.test(raw.sha)) throw new Error(t('Model search failed: unreadable answer.'));
	const file: LocalModelRepoFile[] = [];
	for (const item of Array.isArray(raw.siblings) ? raw.siblings : []) {
		const name = item?.rfilename, bytes = item?.size;
		// solo file nella radice del repository, con un nome che Vox può scrivere in `modelli/`
		if (typeof name !== 'string' || !isDownloadableLocalModelFileName(name) || name.includes('..') || SPLIT_FILE.test(name)) continue;
		if (!Number.isSafeInteger(bytes) || bytes < 4) continue;
		const sha256 = typeof item.lfs?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.lfs.sha256) ? item.lfs.sha256 : null;
		file.push({ file: name, bytes, sha256 });
		if (file.length >= MAX_FILES) break;
	}
	file.sort((a, b) => a.bytes - b.bytes);
	const context = raw.gguf?.context_length;
	return { repo, revisione: raw.sha, contestoMassimo: Number.isSafeInteger(context) && context > 0 ? context : null, file };
}
