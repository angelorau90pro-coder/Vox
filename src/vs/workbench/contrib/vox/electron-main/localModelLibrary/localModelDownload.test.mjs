import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const contracts = stripTypeScriptTypes(await fs.readFile(new URL('../../common/localModelLibraryTypes.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const source = stripTypeScriptTypes((await fs.readFile(new URL('./localModelDownload.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/^export /gm, '');
const { downloadLocalModel, removePartialDownload, restorePartialDownload, verifyLocalModelFile } = evaluate('open', 'stat', 'rename', 'unlink', 'mkdir', 'statfs', 'link', 'readFile', 'writeFile', 'dirname', 'createHash',
	contracts + source + '; return { downloadLocalModel, removePartialDownload, restorePartialDownload, verifyLocalModelFile };')(fs.open, fs.stat, fs.rename, fs.unlink, fs.mkdir, fs.statfs, fs.link, fs.readFile, fs.writeFile, dirname, createHash);
const model = Buffer.from('GGUFcontenuto del modello');
const sha = data => createHash('sha256').update(data).digest('hex');
const reply = (data = model, status = 200, headers = {}) => new Response(data, { status, headers });
const absent = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
async function setup(t, responses, overrides = {}) {
	const folder = await fs.mkdtemp(join(tmpdir(), 'vox-download-'));
	t.after(() => fs.rm(folder, { recursive: true, force: true }));
	const calls = [], progress = [], controller = new AbortController();
	const p = { url: 'https://huggingface.co/repo/resolve/main/model.gguf', destination: join(folder, 'modelli', 'model.gguf'),
		expectedBytes: model.length, expectedSha256: sha(model), signal: controller.signal, onProgress: item => progress.push(item) };
	const rt = { ...fs, now: () => 0, createHash, statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
		fetch: async (url, options) => {
			calls.push({ url, ...options });
			assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
			// ogni richiesta ha un segnale suo (tempo massimo della risposta) che segue sempre quello del chiamante;
			// prima era lo stesso oggetto
			assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, controller.signal.aborted); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
			assert.equal(options.body, undefined);
			assert.equal(options.headers['User-Agent'], 'Vox');
			for (const name of Object.keys(options.headers)) assert.ok(['Range', 'If-Range', 'User-Agent'].includes(name), name);
			const next = responses.shift(); assert.ok(next, 'richiesta inattesa');
			return typeof next === 'function' ? next(url, options) : next;
		}, ...overrides };
	return { p, rt, calls, progress, controller, partial: p.destination + '.parziale',
		seed: async data => { await fs.mkdir(dirname(p.destination), { recursive: true }); await fs.writeFile(p.destination + '.parziale', data) } };
}

test('scarica, controlla e rinomina soltanto dopo il controllo; calcola sempre SHA-256', async t => {
	const s = await setup(t, [reply(model, 200, { 'Content-Length': String(model.length) })]);
	s.p.expectedBytes = null; s.p.expectedSha256 = null;
	const link = s.rt.link;
	s.rt.link = async (...args) => {
		assert.equal(s.progress.at(-1).fase, 'controllo'); await absent(s.p.destination);
		assert.deepEqual(await fs.readFile(s.partial), model); return link(...args);
	};
	assert.deepEqual(await downloadLocalModel(s.p, s.rt), { bytes: model.length, sha256: sha(model) });
	assert.deepEqual(await fs.readFile(s.p.destination), model); await absent(s.partial);
	assert.deepEqual(s.progress.at(-1), { fase: 'controllo', ricevuti: model.length, totale: model.length });
	assert.equal(s.calls.length, 1);
});

test('rifiuta indirizzi iniziali e metadati non validi senza rete', async t => {
	const s = await setup(t, []);
	for (const url of ['https://cdn.hf.co/model.gguf', 'http://huggingface.co/a', 'https://u:p@huggingface.co/a', 'file:///a', 'errato']) {
		await assert.rejects(downloadLocalModel({ ...s.p, url }, s.rt), /Indirizzo.*non consentito/);
	}
	for (const meta of [{ expectedBytes: -1 }, { expectedBytes: Infinity }, { expectedBytes: 2.5 }, { expectedSha256: 'errato' }]) {
		await assert.rejects(downloadLocalModel({ ...s.p, ...meta }, s.rt), /non validi/);
	}
	assert.equal(s.calls.length, 0);
});

test('segue redirect relativi e CDN consentiti con sole intestazioni ammesse', async t => {
	const s = await setup(t, [reply(null, 302, { Location: '../other.gguf' }), reply(null, 307, { Location: 'https://cdn.hf.co/file' }), reply()]);
	await downloadLocalModel(s.p, s.rt);
	assert.deepEqual(s.calls.map(c => c.url), [s.p.url, 'https://huggingface.co/repo/resolve/other.gguf', 'https://cdn.hf.co/file']);
});

test('blocca redirect non consentiti prima della richiesta e limita la catena a cinque', async t => {
	for (const location of ['https://evil.invalid/file', 'https://hf.co.evil.invalid/file', 'http://hf.co/file', 'https://u:p@hf.co/file', 'https://hf.co:444/file', 'http://127.0.0.1/file', 'https://[', null]) {
		const s = await setup(t, [reply(null, 302, location ? { Location: location } : {})]);
		await assert.rejects(downloadLocalModel(s.p, s.rt), /Reindirizzamento.*non consentito/);
		assert.equal(s.calls.length, 1);
	}
	const s = await setup(t, Array.from({ length: 6 }, () => reply(null, 302, { Location: '/again' })));
	await assert.rejects(downloadLocalModel(s.p, s.rt), /Troppi reindirizzamenti/); assert.equal(s.calls.length, 6);
	const ok = await setup(t, [...Array.from({ length: 5 }, () => reply(null, 308, { Location: '/again' })), reply()]);
	await downloadLocalModel(ok.p, ok.rt); assert.equal(ok.calls.length, 6);
});

test('non sovrascrive un modello esistente, anche se compare durante lo scarico', async t => {
	const s = await setup(t, []);
	await fs.mkdir(dirname(s.p.destination), { recursive: true }); await fs.writeFile(s.p.destination, 'originale');
	await assert.rejects(downloadLocalModel(s.p, s.rt), /esiste già/); assert.equal(s.calls.length, 0);
	await fs.unlink(s.p.destination);
	s.rt.fetch = async () => { await fs.writeFile(s.p.destination, 'originale'); return reply() };
	await assert.rejects(downloadLocalModel(s.p, s.rt), /esiste già/);
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'originale');
});

test('riprende con Range e 206 senza riscaricare il prefisso, anche dopo redirect', async t => {
	const n = 7;
	const s = await setup(t, [reply(null, 302, { Location: 'https://cdn.hf.co/model' }),
		reply(model.subarray(n), 206, { 'Content-Range': `bytes ${n}-${model.length - 1}/${model.length}` })]);
	await s.seed(model.subarray(0, n));
	await downloadLocalModel(s.p, s.rt);
	// La nuova regola affida allo SHA finale il controllo: nessuna richiesta del prefisso.
	assert.deepEqual(s.calls.map(c => c.headers.Range), [`bytes=${n}-`, `bytes=${n}-`]);
	assert.deepEqual(await fs.readFile(s.p.destination), model);
});

test('rifiuta Content-Range errato e rimuove un prefisso diverso al controllo SHA finale', async t => {
	for (const range of [null, 'bytes 0-23/24', 'bytes 5-9/24', 'bytes 5-23/25', 'bytes 5-23/*']) {
		const s = await setup(t, [reply(model.subarray(5), 206, range ? { 'Content-Range': range } : {})]);
		await s.seed(model.subarray(0, 5));
		// Prima il parziale restava e ogni nuovo tentativo chiedeva lo stesso pezzo, fallendo per sempre: ora si toglie e
		// lo scarico seguente ricomincia da capo.
		await assert.rejects(downloadLocalModel(s.p, s.rt), /server ha mandato un file diverso.*tolto/);
		await absent(s.partial);
	}
	const s = await setup(t, [reply(model.subarray(5), 206, { 'Content-Range': `bytes 5-${model.length - 1}/${model.length}` })]);
	await s.seed(Buffer.from('GGUF!'));
	// Ora il prefisso diverso viene rilevato dallo SHA dopo aver accodato il solo suffisso.
	await assert.rejects(downloadLocalModel(s.p, s.rt), /Controllo.*rimosso/);
	assert.equal(s.calls.length, 1); await absent(s.partial); await absent(s.partial + '.json');
});

test('con 200 tronca il parziale; con 416 riparte senza Range una volta sola', async t => {
	for (const statuses of [[200], [416, 200], [416, 416]]) {
		const s = await setup(t, statuses.map(status => reply(status === 200 ? model : null, status)));
		// più corto del modello (24 byte): uno più lungo non si riprende nemmeno (test più sotto)
		await s.seed(Buffer.from('vecchio contenuto'));
		if (statuses.at(-1) === 416) {
			await assert.rejects(downloadLocalModel(s.p, s.rt), /HTTP 416/);
			assert.equal(await fs.readFile(s.partial, 'utf8'), 'vecchio contenuto');
		} else { await downloadLocalModel(s.p, s.rt); assert.deepEqual(await fs.readFile(s.p.destination), model) }
		assert.ok(s.calls[0].headers.Range); if (statuses.length > 1) assert.equal(s.calls[1].headers.Range, undefined);
	}
});

test('controlla lo spazio con margine, dimensione attesa o Content-Length; statfs facoltativo', async t => {
	for (const known of [true, false]) {
		// i GB del messaggio sono quelli di Esplora file (1024³ byte), come nel resto della libreria: prima erano decimali
		const s = await setup(t, [reply(model, 200, { 'Content-Length': String(1024 ** 3) })], { statfs: async () => ({ bavail: 1024 ** 3, bsize: 1 }) });
		s.p.expectedBytes = known ? 1024 ** 3 : null;
		await assert.rejects(downloadLocalModel(s.p, s.rt), /servono 1.00 GB, disponibili 1.00 GB/); await absent(s.partial);
	}
	for (const statfs of [undefined, async () => { throw Error('non supportato') }]) {
		const s = await setup(t, [reply()], { statfs }); await downloadLocalModel(s.p, s.rt);
	}
	// La ripresa richiede soltanto lo spazio ancora mancante, oltre al margine.
	const s = await setup(t, [reply(model.subarray(5), 206, { 'Content-Range': `bytes 5-${model.length - 1}/${model.length}` }), reply()],
		{ statfs: async () => ({ bavail: 512 * 1024 * 1024 + model.length - 5, bsize: 1 }) });
	await s.seed(model.subarray(0, 5)); await downloadLocalModel(s.p, s.rt);
});

test('elimina il parziale dopo controlli GGUF, dimensione o SHA falliti', async t => {
	for (const [data, meta] of [[Buffer.from('HTMLerrore'), {}], [Buffer.from([0xc7, 0xc7, 0xd5, 0xc6]), {}], [Buffer.from('GG'), {}], [model, { expectedBytes: model.length + 1 }], [model, { expectedSha256: '0'.repeat(64) }]]) {
		const s = await setup(t, [reply(data)]); Object.assign(s.p, meta);
		await assert.rejects(downloadLocalModel(s.p, s.rt), /Controllo.*file parziale è stato rimosso/);
		await absent(s.partial); await absent(s.p.destination); assert.equal(s.progress.at(-1).fase, 'controllo');
	}
});

test('errori HTTP, rete e corpo mantengono il parziale e producono un errore tradotto', async t => {
	for (const response of [reply(null, 503), () => { throw TypeError('rete rotta') }, reply(new ReadableStream({ start(c) { c.error(Error('corpo rotto')) } }))]) {
		const s = await setup(t, [response]); await s.seed(Buffer.from('GGUF'));
		await assert.rejects(downloadLocalModel(s.p, s.rt), /Scarico del modello non riuscito(?: \(HTTP 503\)|: errore di rete)\./);
		await fs.stat(s.partial); await absent(s.p.destination);
	}
});

test('annullamento prima della richiesta, durante fetch, durante il corpo e durante il controllo', async t => {
	for (const stage of ['prima', 'fetch', 'corpo', 'controllo']) {
		const s = await setup(t, []); await s.seed(Buffer.from('GGUF'));
		if (stage === 'prima') s.controller.abort();
		else if (stage === 'fetch') s.rt.fetch = async (_url, options) => {
			assert.equal(options.signal.aborted, false); s.controller.abort(); assert.equal(options.signal.aborted, true, 'l\'annullo del chiamante arriva alla richiesta'); throw Error('annullato');
		};
		else if (stage === 'corpo') s.rt.fetch = async () => reply(new ReadableStream({ pull(c) { s.controller.abort(); c.error(Error('annullato')) } }));
		else { s.rt.fetch = async () => reply(); s.p.onProgress = item => { if (item.fase === 'controllo') s.controller.abort() } }
		await assert.rejects(downloadLocalModel(s.p, s.rt), { name: 'AbortError' });
		await fs.stat(s.partial); await absent(s.p.destination);
	}
});

test('streaming con scritture corte e avanzamento ogni 250 ms più la chiamata finale', async t => {
	let i = 0, now = 0;
	const s = await setup(t, [reply(new ReadableStream({ pull(c) {
		if (i === model.length) { c.close(); return }
		now = i * 100; const end = Math.min(i + 3, model.length); c.enqueue(model.subarray(i, end)); i = end;
	} }))], { now: () => now });
	const realOpen = s.rt.open;
	s.rt.open = async (...args) => {
		const file = await realOpen(...args);
		if (args[1] === 'w') { const write = file.write.bind(file); file.write = (data, offset, length) => write(data, offset, Math.min(1, length)) }
		return file;
	};
	const times = []; s.p.onProgress = item => { if (item.fase === 'scarico') times.push(now); s.progress.push(item) };
	await downloadLocalModel(s.p, s.rt);
	for (let i = 1; i < times.length - 1; i++) assert.ok(times[i] - times[i - 1] >= 250);
	assert.ok(times.length < model.length); assert.equal(s.progress.filter(p => p.fase === 'scarico').at(-1).ricevuti, model.length);
	assert.deepEqual(await fs.readFile(s.p.destination), model);
});

test('removePartialDownload rimuove solo il parziale ed è idempotente; propaga gli altri errori', async t => {
	const s = await setup(t, []); await s.seed(model); await fs.writeFile(s.partial + '.json', '{}'); await fs.writeFile(s.p.destination, 'finale');
	await removePartialDownload(s.p.destination, s.rt); await removePartialDownload(s.p.destination, s.rt);
	await absent(s.partial); await absent(s.partial + '.json');
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'finale');
	await assert.rejects(removePartialDownload(s.p.destination, { ...s.rt, unlink: async () => { throw Object.assign(Error('permesso'), { code: 'EACCES' }) } }), /permesso/);
});

test('senza SHA salva i validatori della prima risposta e riprende con If-Range dopo redirect', async t => {
	const date = 'Tue, 17 Nov 2026 18:00:00 GMT';
	for (const [etag, lastModified, validator] of [['"versione1"', date, '"versione1"'], ['W/"debole"', date, date]]) {
		let s, sent = false;
		const first = new ReadableStream({ pull(c) {
			if (!sent) { sent = true; c.enqueue(model.subarray(0, 5)) }
			else c.error(Error('connessione interrotta'));
		} });
		s = await setup(t, [reply(first, 200, { ETag: etag, 'Last-Modified': lastModified, 'Content-Length': String(model.length) }),
			reply(null, 302, { Location: 'https://cdn.hf.co/model' }),
			reply(model.subarray(5), 206, { 'Content-Range': `bytes 5-${model.length - 1}/${model.length}` })]);
		s.p.expectedSha256 = null;
		await assert.rejects(downloadLocalModel(s.p, s.rt), /errore di rete/);
		assert.deepEqual(JSON.parse(await fs.readFile(s.partial + '.json', 'utf8')), { etag, lastModified, totale: model.length, url: s.p.url });
		await downloadLocalModel(s.p, s.rt);
		for (const call of s.calls.slice(1)) {
			assert.equal(call.headers.Range, 'bytes=5-'); assert.equal(call.headers['If-Range'], validator);
		}
		assert.deepEqual(await fs.readFile(s.p.destination), model); await absent(s.partial + '.json');
	}
});

test('senza SHA riparte da zero con metadati assenti, illeggibili o privi di validatore', async t => {
	for (const metadata of [undefined, '{', 'null', '{}', '{"etag":"W/\"debole\""}', JSON.stringify({ lastModified: 'data errata' }), JSON.stringify({ etag: '"invalido\r\n"' }), 'illeggibile']) {
		const s = await setup(t, [reply(model, 200, { ETag: '"nuovo"' })]);
		s.p.expectedSha256 = null; await s.seed(Buffer.from('vecchio parziale'));
		if (metadata !== undefined) await fs.writeFile(s.partial + '.json', metadata);
		if (metadata === 'illeggibile') s.rt.readFile = async () => { throw Object.assign(Error('permesso'), { code: 'EACCES' }) };
		await downloadLocalModel(s.p, s.rt);
		assert.equal(s.calls[0].headers.Range, undefined); assert.equal(s.calls[0].headers['If-Range'], undefined);
		assert.deepEqual(await fs.readFile(s.p.destination), model); await absent(s.partial + '.json');
	}
});

test('If-Range con risposta 200 sostituisce parziale e metadati della vecchia versione', async t => {
	const s = await setup(t, [reply(new ReadableStream({ start(c) { c.enqueue(model); }, pull(c) { c.error(Error('rete')) } }), 200,
		{ ETag: '"nuovo"', 'Content-Length': String(model.length) })]);
	s.p.expectedSha256 = null; await s.seed(Buffer.from('vecchio'));
	await fs.writeFile(s.partial + '.json', JSON.stringify({ etag: '"vecchio"', totale: 7 }));
	await assert.rejects(downloadLocalModel(s.p, s.rt), /errore di rete/);
	assert.equal(s.calls[0].headers['If-Range'], '"vecchio"');
	assert.deepEqual(await fs.readFile(s.partial), model);
	assert.equal(JSON.parse(await fs.readFile(s.partial + '.json', 'utf8')).etag, '"nuovo"');
});

test('una sola risposta aperta: chiude redirect e 416 prima della richiesta successiva', async t => {
	let active = false;
	const closedReply = (status, headers) => {
		assert.equal(active, false); active = true;
		return reply(new ReadableStream({ cancel() { active = false } }), status, headers);
	};
	const s = await setup(t, [() => closedReply(302, { Location: '/model' }), () => closedReply(416), () => {
		assert.equal(active, false); return reply();
	}]);
	await s.seed(model.subarray(0, 5)); await downloadLocalModel(s.p, s.rt);
	assert.equal(s.calls.length, 3);
});

test('con 200 o 416 conta lo spazio liberato dal troncamento del vecchio parziale', async t => {
	for (const statuses of [[200], [416, 200]]) {
		const s = await setup(t, statuses.map(status => reply(status === 200 ? model : null, status)),
			{ statfs: async () => ({ bavail: 512 * 1024 * 1024 + model.length - 5, bsize: 1 }) });
		await s.seed(Buffer.alloc(10)); await downloadLocalModel(s.p, s.rt);
		assert.deepEqual(await fs.readFile(s.p.destination), model);
	}
});

test('Content-Length 200 diverso dalla dimensione attesa fallisce prima di leggere o scrivere', async t => {
	let canceled = false;
	const s = await setup(t, [reply(new ReadableStream({ cancel() { canceled = true } }, { highWaterMark: 0 }), 200,
		{ 'Content-Length': String(model.length + 1) })]);
	await s.seed(Buffer.from('GGUF')); await fs.writeFile(s.partial + '.json', '{}');
	s.rt.open = async () => assert.fail('non deve aprire il parziale');
	await assert.rejects(downloadLocalModel(s.p, s.rt), /Controllo.*rimosso/);
	assert.equal(canceled, true); await absent(s.partial); await absent(s.partial + '.json');
});

test('link impedisce sovrascritture anche nella finestra dopo il controllo di esistenza', async t => {
	const s = await setup(t, [reply()]);
	s.rt.link = async (...args) => { await fs.writeFile(s.p.destination, 'concorrente'); return fs.link(...args) };
	s.rt.rename = async () => assert.fail('EEXIST non ammette ripiego');
	await assert.rejects(downloadLocalModel(s.p, s.rt), /esiste gi?/);
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'concorrente');
	assert.deepEqual(await fs.readFile(s.partial), model);
});

test('ripiega su rename solo per hard link non supportati, ricontrollando la destinazione', async t => {
	for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EACCES']) {
		const s = await setup(t, [reply()]);
		s.rt.link = async () => { throw Object.assign(Error('link fallito'), { code }) };
		if (code === 'EACCES') {
			await assert.rejects(downloadLocalModel(s.p, s.rt), /link fallito/); await absent(s.p.destination);
		} else {
			await downloadLocalModel(s.p, s.rt); assert.deepEqual(await fs.readFile(s.p.destination), model); await absent(s.partial);
		}
	}
	const s = await setup(t, [reply()]);
	s.rt.link = async () => { await fs.writeFile(s.p.destination, 'concorrente'); throw Object.assign(Error('link fallito'), { code: 'ENOTSUP' }) };
	await assert.rejects(downloadLocalModel(s.p, s.rt), /esiste gi?/);
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'concorrente');
});

test('errore dopo un blocco del corpo mantiene il parziale e segnala rete, senza HTTP 200', async t => {
	let sent = false;
	const s = await setup(t, [reply(new ReadableStream({ pull(c) {
		if (!sent) { sent = true; c.enqueue(model.subarray(0, 5)) } else c.error(Error('interrotto'));
	} }))]);
	await assert.rejects(downloadLocalModel(s.p, s.rt), { message: 'Scarico del modello non riuscito: errore di rete.' });
	assert.deepEqual(await fs.readFile(s.partial), model.subarray(0, 5));
});

test('annullamento durante reader.read sospeso cancella il corpo senza errore del flusso', async t => {
	const s = await setup(t, []);
	let canceled = false, pending;
	const reading = new Promise(resolve => { pending = resolve });
	s.rt.fetch = async () => reply(new ReadableStream({ pull() { pending() }, cancel() { canceled = true } }, { highWaterMark: 0 }));
	const download = downloadLocalModel(s.p, s.rt);
	await reading; s.controller.abort();
	await assert.rejects(download, { name: 'AbortError' });
	assert.equal(canceled, true); await fs.stat(s.partial); await absent(s.p.destination);
});

test('il controllo SHA di un file grande pubblica avanzamento periodico', async t => {
	// il controllo legge a blocchi da 1 MiB (prima 64 KB): servono più blocchi per vedere l'avanzamento
	const data = Buffer.concat([model, Buffer.alloc(5 * 1024 * 1024)]);
	let now = 0;
	const s = await setup(t, [reply(data)], { now: () => now });
	s.p.expectedBytes = data.length; s.p.expectedSha256 = sha(data);
	const realOpen = s.rt.open;
	s.rt.open = async (...args) => {
		const file = await realOpen(...args);
		if (args[1] === 'r') { const read = file.read.bind(file); file.read = (...params) => { now += 300; return read(...params) } }
		return file;
	};
	await downloadLocalModel(s.p, s.rt);
	const progress = s.progress.filter(p => p.fase === 'controllo');
	assert.ok(progress.length > 3);
	assert.equal(progress[0].ricevuti, 0); assert.equal(progress.at(-1).ricevuti, data.length);
	assert.ok(progress.some(p => p.ricevuti > 0 && p.ricevuti < data.length));
});

test('un parziale già intero si controlla senza chiedere niente alla rete (pausa durante il controllo)', async t => {
	// elenco consigliato: dimensione e SHA noti. Prima partiva `Range: bytes=<tutto>-`, il server rispondeva 416 e si riscaricava da zero.
	const s = await setup(t, []);
	await s.seed(model);
	assert.deepEqual(await downloadLocalModel(s.p, s.rt), { bytes: model.length, sha256: sha(model) });
	assert.equal(s.calls.length, 0);
	assert.deepEqual(await fs.readFile(s.p.destination), model); await absent(s.partial);
	assert.deepEqual(s.progress[0], { fase: 'scarico', ricevuti: model.length, totale: model.length });

	// stesso numero di byte ma contenuto diverso: il controllo lo scarta e toglie il parziale, sempre senza rete
	const bad = await setup(t, []);
	await bad.seed(Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(model.length - 4, 1)]));
	await assert.rejects(downloadLocalModel(bad.p, bad.rt), /Controllo del modello fallito/);
	assert.equal(bad.calls.length, 0); await absent(bad.partial); await absent(bad.p.destination);

	// indirizzo incollato: la dimensione totale è quella salvata accanto al parziale
	const custom = await setup(t, []);
	custom.p.expectedBytes = null; custom.p.expectedSha256 = null;
	await custom.seed(model);
	await fs.writeFile(custom.partial + '.json', JSON.stringify({ etag: '"v1"', lastModified: null, totale: model.length, url: custom.p.url }));
	assert.deepEqual(await downloadLocalModel(custom.p, custom.rt), { bytes: model.length, sha256: sha(model) });
	assert.equal(custom.calls.length, 0); await absent(custom.partial + '.json');
});

test('un parziale cominciato da un altro indirizzo non viene continuato', async t => {
	const s = await setup(t, [reply(model, 200, { 'Content-Length': String(model.length) })]);
	s.p.expectedBytes = null; s.p.expectedSha256 = null;
	await s.seed(Buffer.from('GGUFaltro'));
	await fs.writeFile(s.partial + '.json', JSON.stringify({ etag: '"v1"', lastModified: null, totale: model.length, url: 'https://huggingface.co/altro/resolve/main/model.gguf' }));
	await downloadLocalModel(s.p, s.rt);
	assert.equal(s.calls.length, 1); assert.equal(s.calls[0].headers.Range, undefined);
	assert.deepEqual(await fs.readFile(s.p.destination), model);
});

test('più dati di quelli attesi fermano lo scarico e tolgono il parziale', async t => {
	const s = await setup(t, [reply(Buffer.concat([model, Buffer.alloc(1000)]))]);
	await assert.rejects(downloadLocalModel(s.p, s.rt), /Controllo del modello fallito/);
	await absent(s.partial); await absent(s.p.destination);
});

test('una connessione che non manda più dati diventa un errore e il parziale resta per riprendere', async t => {
	let sent = false;
	const stuck = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(model.subarray(0, 5)) } /* poi niente, per sempre */ } });
	const s = await setup(t, [reply(stuck, 200, { 'Content-Length': String(model.length) })], { idleTimeout: 40 });
	await assert.rejects(downloadLocalModel(s.p, s.rt), /ha smesso di inviare dati/);
	assert.deepEqual(await fs.readFile(s.partial), model.subarray(0, 5));
});

test('l\'errore di rete riporta il codice della causa', async t => {
	const s = await setup(t, [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }]);
	await assert.rejects(downloadLocalModel(s.p, s.rt), { message: 'Scarico del modello non riuscito: errore di rete (ENOTFOUND).' });
});

test('il controllo di un file già presente non lo tocca mai', async t => {
	const s = await setup(t, []);
	const file = join(dirname(s.p.destination), 'presente.gguf');
	await fs.mkdir(dirname(file), { recursive: true }); await fs.writeFile(file, model);
	const progress = [];
	const p = { file, expectedBytes: model.length, expectedSha256: sha(model), signal: s.controller.signal, onProgress: item => progress.push(item) };
	assert.deepEqual(await verifyLocalModelFile(p, s.rt), { bytes: model.length, sha256: sha(model) });
	assert.deepEqual(progress.at(-1), { fase: 'controllo', ricevuti: model.length, totale: model.length });
	// senza SHA atteso bastano intestazione GGUF e dimensione
	await verifyLocalModelFile({ ...p, expectedSha256: null }, s.rt);
	for (const wrong of [{ expectedSha256: 'b'.repeat(64) }, { expectedBytes: model.length + 1 }]) {
		await assert.rejects(verifyLocalModelFile({ ...p, ...wrong }, s.rt), /presente\.gguf è già lì ma non è il modello atteso/);
	}
	await fs.writeFile(file, Buffer.from('ZZZZnon un modello'));
	await assert.rejects(verifyLocalModelFile({ ...p, expectedBytes: null, expectedSha256: null }, s.rt), /non è il modello atteso/);
	assert.deepEqual(await fs.readFile(file), Buffer.from('ZZZZnon un modello'));
	s.controller.abort();
	await assert.rejects(verifyLocalModelFile(p, s.rt), { name: 'AbortError' });
});

test('un parziale più lungo del file atteso non si riprende', async t => {
	const s = await setup(t, [reply(model, 200, { 'Content-Length': String(model.length) })]);
	await s.seed(Buffer.concat([model, Buffer.from('in più')]));
	await downloadLocalModel(s.p, s.rt);
	assert.equal(s.calls.length, 1); assert.equal(s.calls[0].headers.Range, undefined);
	assert.deepEqual(await fs.readFile(s.p.destination), model);
});

test('un parziale di un indirizzo incollato non viene ripreso da un modello consigliato con lo stesso nome di file', async t => {
	const s = await setup(t, [reply(model, 200, { 'Content-Length': String(model.length) })]);
	await s.seed(Buffer.from('GGUFaltro'));
	await fs.writeFile(s.partial + '.json', JSON.stringify({ etag: '"v1"', lastModified: null, totale: model.length, url: 'https://huggingface.co/altro/resolve/main/model.gguf' }));
	// con SHA-256 atteso (elenco consigliato) prima i metadati non si leggevano e si chiedeva il resto con Range
	await downloadLocalModel(s.p, s.rt);
	assert.equal(s.calls.length, 1); assert.equal(s.calls[0].headers.Range, undefined);
	assert.deepEqual(await fs.readFile(s.p.destination), model);
});

test('un parziale intero dello stesso indirizzo, senza validatori del server, si controlla senza rete', async t => {
	const s = await setup(t, []);
	s.p.expectedBytes = null; s.p.expectedSha256 = null;
	await s.seed(model);
	await fs.writeFile(s.partial + '.json', JSON.stringify({ etag: null, lastModified: null, totale: model.length, url: s.p.url }));
	assert.deepEqual(await downloadLocalModel(s.p, s.rt), { bytes: model.length, sha256: sha(model) });
	assert.equal(s.calls.length, 0, 'prima lo si riscaricava da capo');
	assert.deepEqual(await fs.readFile(s.p.destination), model);
	// lo stesso parziale ma non ancora intero, senza validatori: si riparte da zero (nessun modo di sapere se è cambiato)
	const s2 = await setup(t, [reply(model, 200, { 'Content-Length': String(model.length) })]);
	s2.p.expectedBytes = null; s2.p.expectedSha256 = null;
	await s2.seed(model.subarray(0, 5));
	await fs.writeFile(s2.partial + '.json', JSON.stringify({ etag: null, lastModified: null, totale: model.length, url: s2.p.url }));
	await downloadLocalModel(s2.p, s2.rt);
	assert.equal(s2.calls[0].headers.Range, undefined);
});

test('un server che non risponde affatto diventa un errore e il parziale resta', async t => {
	const s = await setup(t, [(_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))], { idleTimeout: 40 });
	await s.seed(model.subarray(0, 5));
	await assert.rejects(downloadLocalModel(s.p, s.rt), /server non ha risposto/);
	assert.deepEqual(await fs.readFile(s.partial), model.subarray(0, 5));
	// l'annullo del chiamante resta un annullo, non un errore di tempo
	const s2 = await setup(t, [(_url, options) => new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); setTimeout(() => s2.controller.abort(), 5) })], { idleTimeout: 10000 });
	await assert.rejects(downloadLocalModel(s2.p, s2.rt), { name: 'AbortError' });
});

test('senza hard link il file finale non sostituisce mai un file comparso nel frattempo', async t => {
	const s = await setup(t, [reply()]);
	s.rt.link = async () => {
		// un altro programma crea il file finale proprio adesso
		await fs.writeFile(s.p.destination, 'di qualcun altro');
		throw Object.assign(new Error('non supportato'), { code: 'EPERM' });
	};
	await assert.rejects(downloadLocalModel(s.p, s.rt), /esiste già/);
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'di qualcun altro');
	assert.deepEqual(await fs.readFile(s.partial), model, 'il parziale controllato resta per riprovare');
});

test('restorePartialDownload rimette il file al posto del parziale, mai sopra un parziale esistente', async t => {
	const s = await setup(t, []);
	await fs.mkdir(dirname(s.p.destination), { recursive: true });
	await fs.writeFile(s.p.destination, model);
	await restorePartialDownload(s.p.destination, s.rt);
	await absent(s.p.destination); assert.deepEqual(await fs.readFile(s.partial), model);
	await fs.writeFile(s.p.destination, 'altro');
	await restorePartialDownload(s.p.destination, s.rt);
	assert.equal(await fs.readFile(s.p.destination, 'utf8'), 'altro'); assert.deepEqual(await fs.readFile(s.partial), model);
});

test('senza hard link, se la sostituzione fallisce il segnaposto vuoto si toglie e il parziale resta', async t => {
	const s = await setup(t, [reply()]);
	s.rt.link = async () => { throw Object.assign(new Error('non supportato'), { code: 'EPERM' }) };
	s.rt.rename = async () => { throw Object.assign(new Error('occupato'), { code: 'EBUSY' }) };
	await assert.rejects(downloadLocalModel(s.p, s.rt), { code: 'EBUSY' });
	await absent(s.p.destination);
	assert.deepEqual(await fs.readFile(s.partial), model);
});

test('dopo le richieste riuscite (anche con reindirizzamenti) non restano ascoltatori sul segnale del chiamante', async t => {
	const { getEventListeners } = await import('node:events');
	const s = await setup(t, [reply(null, 302, { Location: 'https://cdn-lfs.huggingface.co/x/model.gguf' }), reply()]);
	await downloadLocalModel(s.p, s.rt);
	assert.equal(getEventListeners(s.controller.signal, 'abort').length, 0);
});

test('senza dimensione nota lo spazio si ricontrolla durante lo scarico e il parziale resta', async t => {
	const s = await setup(t, [reply(model)], { statfs: async () => ({ bavail: 100, bsize: 1024 * 1024 }) });
	s.p.expectedBytes = null; s.p.expectedSha256 = null;
	// prima uno scarico senza Content-Length poteva riempire il disco fino all'errore di scrittura
	await assert.rejects(downloadLocalModel(s.p, s.rt), /Spazio su disco insufficiente.*0\.10 GB liberi.*parziale è rimasto/);
	await fs.stat(s.partial);
	await absent(s.p.destination);
	// con spazio sufficiente lo stesso scarico va a buon fine
	const ok = await setup(t, [reply(model)], { statfs: async () => ({ bavail: 4096, bsize: 1024 * 1024 }) });
	ok.p.expectedBytes = null; ok.p.expectedSha256 = null;
	await downloadLocalModel(ok.p, ok.rt);
	assert.deepEqual(await fs.readFile(ok.p.destination), model);
});
