import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const source = stripTypeScriptTypes((await readFile(new URL('./voxLocalFIM.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const guard = stripTypeScriptTypes(await readFile(new URL('./providerGuard.ts', import.meta.url), 'utf8')).replace(/export /g, '');
const load = acquire => evaluate('localModelManager', 'LocalModelLease', 'fetch', guard + source + '; return requestVoxLocalFIM;')({ acquire }, undefined, globalThis.fetch);
const params = overrides => ({ folder: '', modelName: 'fim', prefix: 'a ', suffix: ' + b', stopTokens: ['\n\n'], ...overrides });

test('requestVoxLocalFIM invia infill con suffisso e restituisce il testo e il lease', async () => {
	let released = 0, request;
	const fn = load(async (...args) => { assert.deepEqual(args, ['', 'fim', { signal: undefined, uso: 'completamento' }]); return { baseURL: 'http://127.0.0.1:8193/v1', release: () => released++ } });
	assert.equal(await fn(params({ maxTokens: 64 }), { fetch: async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ content: 'return a + b' }) } } }), 'return a + b');
	assert.equal(request.url, 'http://127.0.0.1:8193/infill');
	assert.deepEqual(JSON.parse(request.options.body), { input_prefix: 'a ', input_suffix: ' + b', n_predict: 64, stop: ['\n\n'], stream: false, cache_prompt: true });
	assert.equal(request.options.method, 'POST'); assert.equal(released, 1);
	// un reindirizzamento non viene seguito: il codice non lascia la porta locale
	assert.equal(request.options.redirect, 'error');
});

test('requestVoxLocalFIM rifiuta un indirizzo che non è di questo PC senza inviare niente, e restituisce il lease', async () => {
	for (const baseURL of ['http://192.168.1.50:8080/v1', 'https://api.esempio.invalid/v1', 'https://127.0.0.1:8193/v1', 'non un indirizzo']) {
		let released = 0;
		const fn = load(async () => ({ baseURL, release: () => released++ }));
		await assert.rejects(fn(params(), { fetch: () => assert.fail('nessuna richiesta deve partire') }), error => error.name !== 'AbortError' && error.message === `Vox parla solo con i modelli locali su questo PC: ${baseURL} è stato rifiutato.`);
		assert.equal(released, 1);
	}
});

test('requestVoxLocalFIM omette stop vuoto, usa 300 token se non indicati e restituisce il lease su ogni errore', async () => {
	const noText = 'La risposta del server non contiene testo.';
	for (const [response, detail] of [
		[{ ok: false, status: 500, json: async () => ({ error: 'server failure' }) }, 'server failure'],
		[{ ok: false, status: 400, json: async () => ({ error: { message: 'prompt troppo lungo' } }) }, 'prompt troppo lungo'],
		[{ ok: false, status: 404, json: async () => ({ message: 'non trovato' }) }, 'non trovato'],
		[{ ok: false, status: 503, json: async () => { throw Error('invalid json') } }, 'HTTP 503'],
		[{ ok: false, status: 500, json: async () => ({ error: 'x'.repeat(1000) }) }, 'x'.repeat(300)],
		[{ ok: true, status: 200, json: async () => ({}) }, noText],
		[{ ok: true, status: 200, json: async () => ({ content: 3 }) }, noText],
		[{ ok: true, status: 200, json: async () => { throw Error('invalid json') } }, noText],
	]) {
		let released = 0, body;
		const fn = load(async () => ({ baseURL: 'http://127.0.0.1:8193/v1', release: () => released++ }));
		await assert.rejects(fn(params({ stopTokens: [] }), { fetch: async (_url, options) => { body = JSON.parse(options.body); return response } }),
			error => error.message === `Il modello locale fim non ha potuto completare il codice: ${detail}`);
		assert.equal('stop' in body, false); assert.equal(body.n_predict, 300); assert.equal(released, 1);
	}
});

test('requestVoxLocalFIM: guasto di rete e tempo scaduto diventano un errore chiaro, non un annullamento', async () => {
	let released = 0;
	const fn = load(async () => ({ baseURL: 'http://127.0.0.1:8193/v1/', release: () => released++ }));
	await assert.rejects(fn(params(), { fetch: async () => { throw TypeError('fetch failed') } }), error => error.name !== 'AbortError' && /non ha potuto completare il codice: fetch failed$/.test(error.message));
	assert.equal(released, 1);
	// il server non risponde: scade il tempo, la richiesta viene chiusa e il modello torna libero
	let url, signal;
	const hanging = async (requestUrl, options) => { url = requestUrl; signal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))) };
	await assert.rejects(fn(params(), { fetch: hanging, timeoutMs: 20 }), error => error.name !== 'AbortError' && /non ha potuto completare il codice: nessuna risposta entro \d+ secondi\.$/.test(error.message));
	assert.equal(url, 'http://127.0.0.1:8193/infill'); assert.equal(signal.aborted, true); assert.equal(released, 2);
	// anche se il tempo scade mentre arriva il corpo della risposta
	const slowBody = async (_url, options) => ({ ok: true, status: 200, json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))) });
	await assert.rejects(fn(params(), { fetch: slowBody, timeoutMs: 20 }), /nessuna risposta entro \d+ secondi\.$/);
	assert.equal(released, 3);
});

test('requestVoxLocalFIM: un annullamento resta AbortError anche prima di avviare il modello e durante la lettura della risposta', async () => {
	let acquired = 0, fetches = 0, released = 0;
	const fn = load(async () => { acquired++; return { baseURL: 'http://127.0.0.1:8193/v1', release: () => released++ } });
	// già annullata: il modello non viene nemmeno avviato
	const before = new AbortController(); before.abort();
	await assert.rejects(fn(params({ signal: before.signal }), { fetch: async () => { fetches++ } }), error => error.name === 'AbortError');
	assert.deepEqual([acquired, fetches, released], [0, 0, 0]);
	// annullata mentre il modello si avvia: niente richiesta, il lease torna
	const during = new AbortController();
	const starting = load(async () => { acquired++; during.abort(); return { baseURL: 'http://127.0.0.1:8193/v1', release: () => released++ } });
	await assert.rejects(starting(params({ signal: during.signal }), { fetch: async () => { fetches++ } }), error => error.name === 'AbortError');
	assert.deepEqual([acquired, fetches, released], [1, 0, 1]);
	// annullata mentre arriva il corpo della risposta
	const reading = new AbortController();
	const slowBody = async (_url, options) => ({ ok: true, status: 200, json: () => new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))); reading.abort(); }) });
	await assert.rejects(fn(params({ signal: reading.signal }), { fetch: slowBody }), error => error.name === 'AbortError');
	assert.deepEqual([acquired, released], [2, 2]);
});

test('requestVoxLocalFIM non esegue fetch se acquire fallisce e conserva AbortError durante fetch', async () => {
	let fetches = 0;
	const failing = load(async () => { throw Error('acquire failed') });
	await assert.rejects(failing(params(), { fetch: async () => { fetches++ } }), /acquire failed/); assert.equal(fetches, 0);
	let released = 0;
	const controller = new AbortController();
	const pending = load(async () => ({ baseURL: 'http://127.0.0.1:8193/v1', release: () => released++ }));
	const request = pending(params({ signal: controller.signal }), { fetch: async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))) }); controller.abort();
	await assert.rejects(request, error => error.name === 'AbortError'); assert.equal(released, 1);
	const before = new AbortController(); before.abort();
	await assert.rejects(pending(params({ signal: before.signal }), { fetch: async () => { fetches++ } }), error => error.name === 'AbortError');
});
