// Ricerca dei modelli su Hugging Face: richieste, filtri sulle risposte ed errori, con una rete finta.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { loadI18n } from '../../common/voxI18n.fixture.mjs';

const t = loadI18n('it').t;
const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const types = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(await read('../../common/localModelLibraryTypes.ts'))));
const source = stripTypeScriptTypes((await read('./localModelSearch.ts')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const names = ['isDownloadableLocalModelFileName', 'LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST', 'LOCAL_MODEL_REPO_PATTERN', 'LOCAL_MODEL_SEARCH_MAX_LENGTH', 'LOCAL_MODEL_SEARCH_MAX_RESULTS'];
const api = new Function('t', ...names, source + '; return { searchLocalModels, listLocalModelRepoFiles };')(t, ...names.map(name => types[name]));

const sha = 'a'.repeat(40), sha256 = 'b'.repeat(64);
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function net(answer) {
	const calls = [];
	return { calls, rt: { timeout: 1000, maxBytes: 100000, fetch: async (url, options) => { calls.push({ url, options }); return answer(url, options) } } };
}

test('ricerca: una sola richiesta GET a huggingface.co con il solo testo cercato, senza credenziali né reindirizzamenti', async () => {
	const n = net(() => reply([
		{ id: 'utente/modello-GGUF', downloads: 1200, likes: 7, private: false, gated: false },
		{ id: 'utente/modello-GGUF', downloads: 1 },
		{ id: 'utente/privato-GGUF', private: true },
		{ id: 'utente/con-accesso-GGUF', gated: 'auto' },
		{ id: '../fuori', downloads: 5 },
		{ id: 'senza-barra' },
		{ id: 'altro/secondo.GGUF', downloads: 'tanti', likes: -3 },
		null,
	]));
	const results = await api.searchLocalModels('  qwen\n coder  ', undefined, n.rt);
	assert.deepEqual(results, [{ repo: 'utente/modello-GGUF', scaricamenti: 1200, preferenze: 7 }, { repo: 'altro/secondo.GGUF', scaricamenti: 0, preferenze: 0 }]);
	assert.equal(n.calls.length, 1);
	const url = new URL(n.calls[0].url);
	assert.equal(url.origin + url.pathname, 'https://huggingface.co/api/models');
	assert.deepEqual(Object.fromEntries(url.searchParams), { search: 'qwen coder', filter: 'gguf', sort: 'downloads', direction: '-1', limit: '20' });
	const { signal, ...options } = n.calls[0].options;
	assert.ok(signal instanceof AbortSignal);
	assert.deepEqual(options, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'User-Agent': 'Vox', Accept: 'application/json' } });
});

test('ricerca: testo troppo corto o troppo lungo rifiutato prima di toccare la rete', async () => {
	const n = net(() => reply([]));
	const message = t('Write between 2 and {0} characters to search.', 100);
	for (const text of ['', ' a ', 'x'.repeat(101), null, undefined, 42]) {
		await assert.rejects(api.searchLocalModels(text, undefined, n.rt), error => error.message === message, String(text));
	}
	assert.equal(n.calls.length, 0);
	assert.deepEqual(await api.searchLocalModels('ab', undefined, n.rt), []);
});

test('ricerca: errori del server, della rete, risposta illeggibile, troppo grande, scadenza e annullo', async () => {
	const fails = async (answer, message, rt = {}) => {
		const n = net(answer);
		await assert.rejects(api.searchLocalModels('qwen', undefined, { ...n.rt, ...rt, fetch: n.rt.fetch }), error => error.message === message, message);
	};
	await fails(() => reply('{}', 429), t('Hugging Face is receiving too many requests: wait a moment and try again.'));
	await fails(() => reply('{}', 500), t('Model search failed: Hugging Face answered {0}.', 500));
	await fails(() => reply('non json'), t('Model search failed: unreadable answer.'));
	await fails(() => reply({ non: 'elenco' }), t('Model search failed: unreadable answer.'));
	await fails(() => reply('x'.repeat(2000)), t('Model search failed: the answer is too large.'), { maxBytes: 1000 });
	await fails(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }, t('Model search failed: network error ({0}).', 'ENOTFOUND'));
	await fails(() => { throw new TypeError('fetch failed') }, t('Model search failed: network error.'));
	const hang = (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('interrotto'), { name: 'AbortError' }))));
	await fails(hang, t('Hugging Face did not answer in time. Check the connection and try again.'), { timeout: 10 });
	const controller = new AbortController(), n = net(hang);
	const pending = api.searchLocalModels('qwen', controller.signal, n.rt);
	controller.abort();
	await assert.rejects(pending, error => error.name === 'AbortError');
	const already = new AbortController(); already.abort();
	const untouched = net(() => reply([]));
	await assert.rejects(api.searchLocalModels('qwen', already.signal, untouched.rt), error => error.name === 'AbortError');
	assert.equal(untouched.calls.length, 0);
});

test('file di un repository: solo .gguf singoli nella radice, con dimensione, SHA-256, revisione e contesto', async () => {
	const n = net(() => reply({
		id: 'utente/modello-GGUF', sha, private: false, gated: false, gguf: { context_length: 32768 },
		siblings: [
			{ rfilename: 'README.md', size: 10 },
			{ rfilename: 'grande.Q8_0.gguf', size: 9000, lfs: { sha256 } },
			{ rfilename: 'piccolo.Q4_K_M.gguf', size: 4000, lfs: { sha256: 'non valido' } },
			{ rfilename: 'sotto/cartella.gguf', size: 4000 },
			{ rfilename: 'diviso-00001-of-00002.gguf', size: 4000 },
			{ rfilename: 'NUL.gguf', size: 4000 },
			{ rfilename: 'senza-dimensione.gguf' },
			{ rfilename: 'vuoto.gguf', size: 0 },
			null,
		],
	}));
	const found = await api.listLocalModelRepoFiles('utente/modello-GGUF', undefined, n.rt);
	assert.deepEqual(found, { repo: 'utente/modello-GGUF', revisione: sha, contestoMassimo: 32768, file: [{ file: 'piccolo.Q4_K_M.gguf', bytes: 4000, sha256: null }, { file: 'grande.Q8_0.gguf', bytes: 9000, sha256 }] });
	assert.equal(n.calls[0].url, 'https://huggingface.co/api/models/utente/modello-GGUF?blobs=true');
	// l'indirizzo che ne esce è uno di quelli che lo scarico accetta
	const url = types.urlOfLocalModelRepoFile(found.repo, found.revisione, found.file[0].file);
	assert.equal(url, `https://huggingface.co/utente/modello-GGUF/resolve/${sha}/piccolo.Q4_K_M.gguf`);
	assert.equal(types.isAllowedLocalModelDownloadURL(url, true), true);
});

test('file di un repository: nomi non validi rifiutati senza rete; repository privati, mancanti o risposte incoerenti', async () => {
	const untouched = net(() => reply({}));
	const notFound = t('This model was not found on Hugging Face.');
	for (const repo of ['', 'senza-barra', 'a/b/c', '../x/y', 'a/..', 'utente/modello?x=1', 'utente/mod ello', 'https://esempio.it/a', null, 7]) {
		await assert.rejects(api.listLocalModelRepoFiles(repo, undefined, untouched.rt), error => error.message === notFound, String(repo));
	}
	assert.equal(untouched.calls.length, 0);
	const fails = async (answer, message) => assert.rejects(api.listLocalModelRepoFiles('utente/modello', undefined, net(answer).rt), error => error.message === message, message);
	const account = t('This model requires a Hugging Face account: Vox cannot download it.'), unreadable = t('Model search failed: unreadable answer.');
	await fails(() => reply('{}', 404), notFound);
	await fails(() => reply('{}', 401), account);
	await fails(() => reply({ id: 'utente/modello', sha, gated: 'manual', siblings: [] }), account);
	await fails(() => reply({ id: 'utente/modello', sha, private: true, siblings: [] }), account);
	await fails(() => reply({ id: 'altro/modello', sha, siblings: [] }), unreadable);
	await fails(() => reply({ id: 'utente/modello', sha: 'main', siblings: [] }), unreadable);
	await fails(() => reply(null), unreadable);
	// senza file adatti e senza contesto dichiarato: elenco vuoto, non un errore
	assert.deepEqual(await api.listLocalModelRepoFiles('utente/modello', undefined, net(() => reply({ id: 'utente/modello', sha })).rt), { repo: 'utente/modello', revisione: sha, contestoMassimo: null, file: [] });
});
