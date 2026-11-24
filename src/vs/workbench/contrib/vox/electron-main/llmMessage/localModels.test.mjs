import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { win32 as path } from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const source = stripTypeScriptTypes((await readFile(new URL('./localModels.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
// Il banco simula Windows (piattaforma predefinita 'win32', taskkill, unità C–Z): si usano sempre i percorsi win32,
// anche quando i test girano su Linux o macOS, così prodotto e attese usano lo stesso modulo dei percorsi.
const folder = path.resolve('local-model-fixture');
const timer = (callback, ms) => setTimeout(callback, ms);
const runtimeNames = ['spawn', 'execFile', 'access', 'readFile', 'mkdir', 'open', 'dirname', 'isAbsolute', 'join', 'resolve', 'relative', 'sep', 'homedir', 'process', 'fetch', 'setTimeout', 'clearTimeout'];

function harness({ manifest = mf(), responses = [], platform = 'win32', access: customAccess, readFile: customReadFile, spawnError, execFileError, logText = '' } = {}) {
	const files = new Map(), spawns = [], kills = [], accesses = [], execs = [], opens = [], children = new Map();
	files.set(path.join(folder, 'modelli.json'), JSON.stringify(manifest));
	files.set(path.join(folder, 'modelli', 'a.gguf'), 'model');
	files.set(path.join(folder, 'modelli', 'b.gguf'), 'model');
	files.set(path.join(folder, 'motore', 'llama-server.exe'), 'exe');
	files.set(path.join(folder, 'avvia', 'a.log'), logText);
	const fs = {
		access: async file => { accesses.push(file); if (customAccess) return customAccess(file, files); if (!files.has(file)) throw Error('ENOENT') },
		readFile: async file => { if (customReadFile) return customReadFile(file, files); if (!files.has(file)) throw Error('ENOENT'); return files.get(file) },
		mkdir: async () => {},
		// come il vero `open`: con 'w' il file si svuota
		open: async (file, mode) => { opens.push([file, mode]); if (mode === 'w') files.set(file, ''); return { fd: 1, close: async () => {} } },
	};
	const spawn = (command, args, options) => {
		const child = new EventEmitter(); child.pid = 500 + spawns.length; child.exitCode = null; child.signalCode = null;
		child.kill = signal => { kills.push([child.pid, signal]); child.exitCode = 1; child.emit('close', 1) };
		spawns.push({ command, args, options, child }); children.set(child.pid, child);
		if (spawnError) queueMicrotask(() => child.emit('error', spawnError));
		return child;
	};
	const execFile = (exe, args, opts, callback) => {
		execs.push({ exe, args, opts }); kills.push(args);
		const child = children.get(Number(args[1])); if (!execFileError && child) { child.exitCode = 1; child.emit('close', 1) }
		callback(execFileError ?? null);
	};
	const fetch = async (url, opts) => {
		const answer = responses.length ? await responses.shift()(url, opts) : null;
		if (answer === null) throw Error('ECONNREFUSED');
		return { status: typeof answer === 'object' ? answer.status : answer, json: async () => typeof answer === 'object' ? answer.body : answer === 200 ? { data: [{ id: 'a' }] } : {} };
	};
	let clock = 0;
	const setTimer = (callback, ms) => timer(() => { clock += ms; callback() }, ms);
	const values = [spawn, execFile, fs.access, fs.readFile, fs.mkdir, fs.open, path.dirname, path.isAbsolute, path.join, path.resolve, path.relative, path.sep, () => folder, { execPath: path.join(folder, 'app.exe'), platform }, fetch, setTimer, clearTimeout];
	const api = evaluate(...runtimeNames, source + '; return { readLocalManifest, findLocalModelsFolder, LocalModelManager, owned };')(...values);
	const manager = (extra = {}) => new api.LocalModelManager({ now: () => clock, setTimeout: setTimer, clearTimeout, probeTimeout: 0, ioTimeout: 50, logTimeout: 20, candidateTimeout: 20, cacheDuration: 60, switchTimeout: 4, healthTimeout: 12, healthInterval: 1, closeTimeout: 4, leaseTimeout: 4, ...extra });
	return { ...api, manager, files, spawns, kills, accesses, execs, opens, children, setClock: value => clock = value };
}

function mf(models = [model()]) { return { motore: 'motore/llama-server.exe', modelli: models } }
function model(overrides = {}) { return { nome: 'a', file: 'a.gguf', contesto: 4096, porta: 8192, uso: 'chat', opzioni: ['--chat-template-file', '{cartella}/avvia/a.jinja'], ...overrides } }
function answer(status, id = 'a') { return { status, body: status === 200 ? { data: [{ id }] } : {} } }
const fastRuntime = { fetch: async url => url.endsWith('/health') ? answer(200) : null };

test('Stop durante la sonda chiude il processo superato saltato dal rilevamento', async () => {
	let reachedProbe, releaseProbe;
	const reached = new Promise(resolve => reachedProbe = resolve), gate = new Promise(resolve => releaseProbe = resolve);
	const h = harness(), manager = h.manager({ ...fastRuntime }), controller = new AbortController();
	(await manager.acquire(folder, 'a')).release();
	manager.rt.fetch = async () => { reachedProbe(); await gate; return null };
	const pending = manager.acquire(folder, 'a', { signal: controller.signal });
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'c', porta: 8194 })])));
	await manager.listChatModels(folder);
	controller.abort(); releaseProbe();
	await assert.rejects(pending, error => error.name === 'AbortError');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.owned.size, 0);
	assert.equal(h.spawns.length, 1);
});

test('closeForRemoval aspetta il rilascio e chiude tutti i processi omonimi su porte diverse', async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime, leaseTimeout: 10000 });
	assert.equal(manager.isRunning('a'), false);
	const lease = await manager.acquire(folder, 'a');
	assert.equal(manager.isRunning('a'), true);
	const oldChild = new EventEmitter(); oldChild.pid = 999; oldChild.exitCode = null; oldChild.signalCode = null;
	h.owned.set(8193, { child: oldChild, nome: 'a', uso: 'chat', firma: 'superato', leases: 0 }); h.children.set(999, oldChild);
	const closing = manager.closeForRemoval('a');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(manager.isRunning('a'), true);
	assert.equal(h.execs.length, 0);
	lease.release();
	assert.equal(await closing, true);
	assert.equal(manager.isRunning('a'), false);
	assert.equal(h.owned.size, 0);
	assert.equal(await manager.closeForRemoval('manuale'), true);
	assert.equal(h.execs.length, 2);
});

test('closeForRemoval restituisce false e conserva il processo se la chiusura fallisce', async () => {
	const h = harness({ execFileError: Error('access denied') }), manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	assert.equal(await manager.closeForRemoval('a'), false);
	assert.equal(manager.isRunning('a'), true);
});

test('closeForRemoval si annulla durante l’attesa senza inviare comandi di chiusura', async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime, leaseTimeout: 10000 }), lease = await manager.acquire(folder, 'a'), controller = new AbortController();
	const closing = manager.closeForRemoval('a', controller.signal);
	await new Promise(resolve => setImmediate(resolve));
	controller.abort();
	assert.equal(await closing, false);
	assert.equal(h.execs.length, 0);
	assert.equal(manager.isRunning('a'), true);
	lease.release();
});

test('file cambiato e mancante chiude il processo di a superato', async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ file: 'missing.gguf' })])));
	await assert.rejects(manager.acquire(folder, 'a'), /missing\.gguf/);
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.owned.size, 0);
	assert.equal(h.spawns.length, 1);
});

for (const loading of [false, true]) {
	test(`Stop nel ricontrollo ${loading ? 'dopo health conserva il prestito attivo fino al rilascio' : 'del riuso pronto chiude il superato'}`, async () => {
		let blockRead = false, reachedRead, releaseRead;
		const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
		const h = harness({ readFile: async (file, files) => {
			if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate }
			return files.get(file);
		} });
		const manager = h.manager({ ...fastRuntime }), controller = new AbortController();
		const first = await manager.acquire(folder, 'a');
		if (!loading) first.release();
		manager.rt.fetch = async url => {
			if (!loading || url.endsWith('/health')) {
				blockRead = true;
				return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) };
			}
			return null;
		};
		const pending = manager.acquire(folder, 'a', { signal: controller.signal });
		await reached;
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
		// Lo Stop interrompe ora la lettura: il rilevamento registra prima il manifesto superato.
		await manager.listChatModels(folder);
		controller.abort(); releaseRead();
		await assert.rejects(pending, error => error.name === 'AbortError');
		if (loading) {
			assert.equal(h.execs.length, 0);
			assert.equal(h.owned.get(8192).leases, 1);
			first.release();
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
		assert.equal(h.owned.size, 0);
		assert.equal(h.spawns.length, 1);
	});
}

test('eccezione durante replaceOwned restituisce errore di chiusura senza un secondo taskkill', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf' })]) });
	const manager = h.manager({ ...fastRuntime, closeTimeout: 137, setTimeout: (callback, ms) => {
		if (ms === 137) throw Error('timer di chiusura non disponibile');
		return setTimeout(callback, ms);
	} });
	(await manager.acquire(folder, 'a')).release();
	await assert.rejects(manager.acquire(folder, 'b'), /Impossibile chiudere il modello locale a\./);
	assert.equal(h.spawns.length, 1);
	assert.equal(h.execs.length, 1);
});

test('riuso in caricamento superato durante la sonda riparte senza aspettare health vecchio', async () => {
	let reachedProbe, releaseProbe;
	const reached = new Promise(resolve => reachedProbe = resolve), gate = new Promise(resolve => releaseProbe = resolve);
	const h = harness(), controller = new AbortController();
	const manager = h.manager({ fetch: async url => { if (url.endsWith('/health')) { controller.abort(); return answer(503) } return null } });
	await assert.rejects(manager.acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
	let block = true;
	manager.rt.fetch = async url => {
		if (url.endsWith('/health')) return answer(h.spawns.length === 1 ? 503 : 200);
		if (block) { block = false; reachedProbe(); await gate; return answer(503) }
		return null;
	};
	const pending = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder);
	releaseProbe();
	const lease = await pending;
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	lease.release();
});

test('eccezione durante la chiusura per timeout conserva errore di tempo scaduto', async () => {
	const h = harness(), setTimer = h.manager().rt.setTimeout;
	const manager = h.manager({ fetch: async url => url.endsWith('/health') ? answer(503) : null, closeTimeout: 137, setTimeout: (callback, ms) => {
		if (ms === 137) throw Error('timer di chiusura non disponibile');
		return setTimer(callback, ms);
	} });
	await assert.rejects(manager.acquire(folder, 'a'), /Tempo scaduto/);
	assert.equal(h.execs.length, 1);
	assert.equal(h.spawns.length, 1);
});

for (const loading of [false, true]) {
	test(`manifesto di nuovo valido cancella il segno nel riuso ${loading ? 'dopo health' : 'pronto'}`, async () => {
		const h = harness(), manager = h.manager({ ...fastRuntime });
		const first = await manager.acquire(folder, 'a');
		let blockRead = false;
		manager.rt.readFile = async file => blockRead && file === path.join(folder, 'modelli.json')
			? JSON.stringify(mf([model({ contesto: 8192 })])) : h.files.get(file);
		const controller = new AbortController();
		manager.rt.fetch = async () => { blockRead = true; return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } };
		const readFile = manager.rt.readFile;
		manager.rt.readFile = async file => {
			const value = await readFile(file);
			if (blockRead) controller.abort();
			return value;
		};
		await assert.rejects(manager.acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
		assert.equal(h.execs.length, 0);
		blockRead = false;
		manager.rt.fetch = async url => loading && !url.endsWith('/health') ? null : { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) };
		const second = await manager.acquire(folder, 'a');
		first.release(); second.release();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(h.execs.length, 0);
		assert.equal(h.owned.get(8192).leases, 0);
	});
}

test('valida manifesto, sostituisce cartella e rifiuta tutti i campi non validi', async () => {
	const h = harness();
	const parsed = await h.readLocalManifest(folder);
	assert.equal(parsed.modelli[0].opzioni[1].replaceAll('/', '\\'), path.join(folder, 'avvia', 'a.jinja'));
	const invalid = [
		[{ file: 'dir/a.gguf' }, 'file'], [{ file: 'dir\\a.gguf' }, 'file'], [{ file: '..a.gguf' }, 'file'], [{ file: 'a:b.gguf' }, 'file'],
		[{ file: '.' }, 'file'], [{ file: 'a.bin' }, 'file'], [{ file: '.gguf' }, 'file'],
		[{ nome: '' }, 'nome'], [{ nome: 'bad name' }, 'nome'], [{ porta: 80 }, 'porta'], [{ porta: 1.5 }, 'porta'],
		[{ contesto: 1 }, 'contesto'], [{ contesto: 2.5 }, 'contesto'], [{ uso: 'other' }, 'uso'], [{ descrizione: 1 }, 'descrizione'],
		...[ '--host', '--host=x', '--port', '--port=1', '-m', '-m=x', '--model', '--model=x', '--alias', '--alias=x', '-a', '-a=x', '-c', '-c=8192', '--ctx-size', '--ctx-size=8192', ' --port', '--host ' ].map(value => [{ opzioni: [value] }, 'opzioni'])
	];
	for (const [patch, field] of invalid) {
		const bad = harness({ manifest: mf([model(patch)]) });
		await assert.rejects(bad.readLocalManifest(folder), new RegExp(`campo ${field}`, 'i'));
	}
	for (const motore of ['../outside.exe', '.']) {
		const bad = harness({ manifest: { ...mf(), motore } });
		await assert.rejects(bad.readLocalManifest(folder), /campo motore/i);
	}
	const duplicates = harness({ manifest: mf([model(), model({ file: 'b.gguf' })]) });
	await assert.rejects(duplicates.readLocalManifest(folder), /campo nome/i);
	// un nome che comincia con ".." ma resta nella cartella è valido
	const dotted = harness({ manifest: { ...mf(), motore: '..motore/x.exe' } });
	assert.equal((await dotted.readLocalManifest(folder)).motore, path.join(folder, '..motore', 'x.exe'));
});

test('cartella configurata con percorso relativo rifiutata; controllo bloccato non rilanciato finché non finisce', async () => {
	const h = harness();
	// la cartella di prova esiste davvero con questo nome relativo, ma un percorso relativo non vale
	await assert.rejects(h.manager().listChatModels('local-model-fixture'), /Cartella delle IA locali/i);
	assert.deepEqual((await h.manager().listChatModels(folder)).models, ['a'].map(nome => ({ nome, descrizione: '', contesto: 4096 })));
	const hung = path.join(folder, 'ia-locali', 'modelli.json');
	let calls = 0;
	const manager = h.manager({ execPath: path.join(folder, 'app.exe'), homedir: () => path.join(folder, 'home'), platform: 'linux', candidateTimeout: 2, cacheDuration: 0, missDuration: 0,
		access: async file => { if (file === hung) { calls++; return new Promise(() => {}) } throw Error('ENOENT') } });
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(calls, 1);
});

test('ricerca configurata non fa fallback; la ricerca automatica conserva ordine e cache', async () => {
	const h = harness({ access: async () => { throw Error() } });
	const configured = h.manager({ access: async file => { h.accesses.push(file); throw Error('ENOENT') } });
	await assert.rejects(configured.listChatModels(path.join(folder, 'configured')), /Cartella delle IA locali/i);
	assert.equal(h.accesses.length, 1);
	const first = path.join(folder, 'ia-locali'), second = path.join(folder, 'home', '.vox', 'ia-locali');
	h.files.set(path.join(first, 'modelli.json'), JSON.stringify(mf()));
	let firstFinished = false;
	const auto = h.manager({ execPath: path.join(folder, 'app.exe'), homedir: () => path.join(folder, 'home'), platform: 'linux', access: async file => {
		h.accesses.push(file);
		if (file === path.join(first, 'modelli.json')) { await new Promise(resolve => setTimeout(resolve, 10)); firstFinished = true; return }
		if (file === path.join(second, 'modelli.json')) return;
		throw Error('ENOENT');
	}, readFile: async file => { if (file === path.join(first, 'modelli.json')) return JSON.stringify(mf()); throw Error('ENOENT') } });
	assert.deepEqual((await auto.listChatModels('')).models, []);
	assert.ok(firstFinished);
	const candidateAccesses = () => h.accesses.filter(file => file.endsWith('modelli.json') && [first, second].includes(path.dirname(file))).length;
	const cachedAccesses = candidateAccesses();
	await auto.listChatModels(''); assert.equal(candidateAccesses(), cachedAccesses);
	auto.rt.now = () => 100;
	await auto.listChatModels(''); assert.ok(candidateAccesses() > cachedAccesses);
	const timedOut = h.manager({ execPath: path.join(folder, 'app.exe'), homedir: () => path.join(folder, 'home'), platform: 'linux', candidateTimeout: 5, access: async file => {
		if (file === path.join(first, 'modelli.json')) return new Promise(() => {});
		if (file === path.join(second, 'modelli.json')) return;
		throw Error('ENOENT');
	} });
	h.files.set(path.join(second, 'modelli.json'), JSON.stringify(mf()));
	await assert.deepEqual((await timedOut.listChatModels('')).models, []);
});

test('listChatModels filtra file mancanti e usi diversi; cartella assente dà errore tradotto', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'missing.gguf', uso: 'chat' }), model({ nome: 'c', uso: 'embedding' })]) });
	const { models, missing } = await h.manager({ ...fastRuntime }).listChatModels(folder);
	assert.deepEqual(models.map(item => item.nome), ['a']);
	assert.deepEqual(missing, [{ nome: 'b', file: path.join(folder, 'modelli', 'missing.gguf') }]);
	const absent = harness();
	await assert.rejects(absent.manager().listChatModels(path.join(folder, 'missing')), /Cartella delle IA locali/i);
});

test('listModels include chat e completamento con uso, mancanti inclusi, ma esclude embedding', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', uso: 'completamento', porta: 8193 }), model({ nome: 'c', uso: 'embedding', porta: 8194 }), model({ nome: 'missing', file: 'missing.gguf', uso: 'completamento', porta: 8195 }), model({ nome: 'chatMissing', file: 'chatMissing.gguf', porta: 8196 })]) });
	const manager = h.manager({ ...fastRuntime });
	const result = await manager.listModels(folder);
	assert.deepEqual(result.models, [{ nome: 'a', descrizione: '', contesto: 4096, uso: 'chat' }, { nome: 'b', descrizione: '', contesto: 4096, uso: 'completamento' }]);
	assert.deepEqual(result.missing.map(({ nome }) => nome), ['missing', 'chatMissing']);
	assert.deepEqual((await manager.listChatModels(folder)).models, [{ nome: 'a', descrizione: '', contesto: 4096 }]);
});

test('completion già acceso non viene chiuso quando si avvia la chat su un’altra porta', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', uso: 'completamento', porta: 8193 })]) });
	const manager = h.manager({ ...fastRuntime });
	const completion = await manager.acquire(folder, 'b', { uso: 'completamento' });
	const chat = await manager.acquire(folder, 'a');
	assert.equal(h.spawns.length, 2); assert.equal(h.execs.length, 0);
	completion.release(); chat.release();
});

test('acquire completion rispetta uso e mantiene processi chat e completion indipendenti', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', uso: 'completamento', porta: 8193 }), model({ nome: 'c', uso: 'embedding', porta: 8194 })]) });
	const manager = h.manager({ ...fastRuntime });
	const chat = await manager.acquire(folder, 'a');
	const completion = await manager.acquire(folder, 'b', { uso: 'completamento' });
	assert.equal(h.spawns.length, 2);
	assert.ok(h.spawns.some(item => item.args.includes('8192')));
	assert.ok(h.spawns.some(item => item.args.includes('8193')));
	await manager.listModels(folder); await manager.listChatModels(folder);
	assert.equal(h.execs.length, 0);
	await assert.rejects(manager.acquire(folder, 'b'), /non è un modello da chat/);
	await assert.rejects(manager.acquire(folder, 'a', { uso: 'completamento' }), /non è un modello di completamento/);
	await assert.rejects(manager.acquire(folder, 'c'), /non è un modello da chat/);
	await assert.rejects(manager.acquire(folder, 'c', { uso: 'completamento' }), /non è un modello di completamento/);
	chat.release(); completion.release();
});

test('completion diventa stale se cambia la firma e shutdown lo chiude', async () => {
	const h = harness({ manifest: mf([model({ nome: 'b', uso: 'completamento', porta: 8193 })]) });
	const manager = h.manager({ ...fastRuntime });
	const lease = await manager.acquire(folder, 'b', { uso: 'completamento' }); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'b', uso: 'completamento', porta: 8193, opzioni: ['--temp', '0.2'] })])));
	await manager.listModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 1);
	const second = await manager.acquire(folder, 'b', { uso: 'completamento' }); second.release();
	await manager.shutdown();
	assert.equal(h.execs.length, 2);
});

test('completion diventa stale anche se nel manifesto cambia solo uso', async () => {
	const h = harness({ manifest: mf([model({ nome: 'b', uso: 'completamento', porta: 8193 })]) });
	const manager = h.manager({ ...fastRuntime });
	const lease = await manager.acquire(folder, 'b', { uso: 'completamento' }); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'b', uso: 'chat', porta: 8193 })])));
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 1);
});

test('un .gguf mancante su due: models col presente e missing col nome e il percorso cercato', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'missing.gguf' })]) });
	const { models, missing } = await h.manager({ ...fastRuntime }).listChatModels(folder);
	assert.deepEqual(models.map(item => item.nome), ['a']);
	assert.deepEqual(missing, [{ nome: 'b', file: path.join(folder, 'modelli', 'missing.gguf') }]);
});

test('tutti i .gguf mancanti: zero modelli e una voce missing per modello chat', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf' })]) });
	h.files.delete(path.join(folder, 'modelli', 'a.gguf'));
	h.files.delete(path.join(folder, 'modelli', 'b.gguf'));
	const { models, missing } = await h.manager({ ...fastRuntime }).listChatModels(folder);
	assert.deepEqual(models, []);
	assert.deepEqual(missing, [
		{ nome: 'a', file: path.join(folder, 'modelli', 'a.gguf') },
		{ nome: 'b', file: path.join(folder, 'modelli', 'b.gguf') },
	]);
});

test('.gguf presente ma illeggibile (EACCES, EPERM): non raggiungibile con la causa; "non esiste" (ENOENT, ENOTDIR): mancante senza causa', async () => {
	const fsError = code => Object.assign(new Error(`${code}: operazione non riuscita`), { code });
	const files = { 'a.gguf': 'EACCES', 'b.gguf': 'EPERM', 'c.gguf': 'ENOENT', 'd.gguf': 'ENOTDIR' };
	const h = harness({
		manifest: mf(Object.keys(files).map(file => model({ nome: file[0], file }))),
		access: async (file, all) => { const code = files[path.basename(file)]; if (code) throw fsError(code); if (!all.has(file)) throw Error('ENOENT') },
	});
	const { folder: used, models, missing } = await h.manager({ ...fastRuntime }).listChatModels(folder);
	assert.equal(used, folder);
	assert.deepEqual(models, []);
	assert.deepEqual(missing, [
		{ nome: 'a', file: path.join(folder, 'modelli', 'a.gguf'), error: 'EACCES: operazione non riuscita' },
		{ nome: 'b', file: path.join(folder, 'modelli', 'b.gguf'), error: 'EPERM: operazione non riuscita' },
		{ nome: 'c', file: path.join(folder, 'modelli', 'c.gguf') },
		{ nome: 'd', file: path.join(folder, 'modelli', 'd.gguf') },
	]);
	// all'avvio dello stesso modello la causa vera arriva all'utente, non "file non trovato"
	await assert.rejects(h.manager({ ...fastRuntime }).acquire(folder, 'a'), /EACCES/);
});

test('cartella incollata con le virgolette ("Copia come percorso"): accettata come senza', async () => {
	const h = harness();
	const result = await h.manager({ ...fastRuntime }).listChatModels(`  "${folder}" `);
	assert.equal(result.folder, folder);
	assert.deepEqual(result.models.map(item => item.nome), ['a']);
});

test('percorso relativo configurato: errore che chiede un percorso assoluto', async () => {
	const h = harness();
	await assert.rejects(h.manager().listChatModels('local-model-fixture'), /percorso assoluto/i);
	await assert.rejects(h.manager().acquire('local-model-fixture', 'a'), /percorso assoluto/i);
});

test('avvia con argomenti attesi, shell disabilitata, bind loopback e attende health', async () => {
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const lease = await h.manager().acquire(folder, 'a');
	assert.equal(lease.baseURL, 'http://127.0.0.1:8192/v1');
	assert.deepEqual(h.spawns[0].args.map(value => value.replaceAll('/', '\\')), ['-m', path.join(folder, 'modelli', 'a.gguf'), '--alias', 'a', '-ngl', '99', '-c', '4096', '-fa', 'on', '-np', '1', '--jinja', '--host', '127.0.0.1', '--port', '8192', '--chat-template-file', path.join(folder, 'avvia', 'a.jinja')]);
	assert.equal(h.spawns[0].options.shell, false); assert.equal(h.spawns[0].options.windowsHide, true); assert.equal(h.spawns[0].options.cwd, path.join(folder, 'motore'));
	lease.release(); lease.release();
});

test('llama-server parte senza le variabili LLAMA_ARG_* e LLAMA_API_KEY del PC, con il resto dell\'ambiente', async () => {
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const env = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', LLAMA_API_KEY: 'segreta', llama_arg_ssl_key_file: 'k.pem', LLAMA_ARG_API_PREFIX: '/x', LLAMA_ARG_HF_REPO: 'altro/modello', LLAMA_CACHE: 'C:\\cache' };
	const lease = await h.manager({ env }).acquire(folder, 'a');
	assert.deepEqual(h.spawns[0].options.env, { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', LLAMA_CACHE: 'C:\\cache' });
	// l'ambiente di Vox non cambia
	assert.equal(env.LLAMA_API_KEY, 'segreta');
	lease.release();
});

test('un secondo errore del processo avviato non fa cadere Vox (nessun errore senza ascoltatori)', async () => {
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const lease = await h.manager().acquire(folder, 'a');
	const child = h.spawns[0].child;
	child.emit('error', Error('kill non riuscito'));
	child.emit('error', Error('ancora'));
	assert.equal(child.spawnError.message, 'kill non riuscito');
	assert.equal(h.owned.size, 0);
	lease.release();
});

test('riusa server esterno dello stesso modello senza avviarlo o chiuderlo', async () => {
	const h = harness({ responses: [async () => answer(200)] });
	const lease = await h.manager().acquire(folder, 'a'); lease.release();
	assert.equal(h.spawns.length, 0); assert.equal(h.execs.length, 0);
});

test('porta esterna occupata genera errore senza chiusure', async () => {
	const h = harness({ responses: [async () => answer(200, 'other')] });
	await assert.rejects(h.manager().acquire(folder, 'a'), /8192/);
	assert.equal(h.spawns.length, 0); assert.equal(h.execs.length, 0);
});

test('503 su porta esterna viene trattato come occupata', async () => {
	const h = harness({ responses: [async () => answer(503)] });
	await assert.rejects(h.manager().acquire(folder, 'a'), /occupata/);
	assert.equal(h.spawns.length, 0); assert.equal(h.execs.length, 0);
});

test('cambio modello chiude soltanto il PID proprio e avvia il nuovo', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', porta: 8192, opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(); const lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.acquire(folder, 'b');
	assert.deepEqual(h.execs[0].args, ['/PID', '500', '/T', '/F']);
	assert.equal(h.spawns.length, 2);
});

test('cambio verso un modello il cui file manca: errore e il modello in uso resta acceso', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => answer(200, 'a')] });
	h.files.delete(path.join(folder, 'modelli', 'b.gguf'));
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await assert.rejects(manager.acquire(folder, 'b'), /b\.gguf/);
	assert.equal(h.execs.length, 0); assert.equal(h.spawns.length, 1);
	// il modello a è ancora quello di Vox e si riusa senza riavvio
	(await manager.acquire(folder, 'a')).release();
	assert.equal(h.spawns.length, 1); assert.equal(h.execs.length, 0);
});

test('cambio con lease attivo: oltre il tempo massimo di attesa rifiuta senza terminare o avviare', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf' })]), responses: [async () => null, async () => answer(200), async () => answer(200, 'a')] });
	const manager = h.manager(); await manager.acquire(folder, 'a');
	await assert.rejects(manager.acquire(folder, 'b'), /ancora rispondendo/);
	assert.equal(h.execs.length, 0); assert.equal(h.spawns.length, 1);
});

test('cambio con lease attivo: aspetta che l\'altra richiesta finisca, poi chiude il vecchio e avvia il nuovo', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager({ leaseTimeout: 10000 }), lease = await manager.acquire(folder, 'a');
	const statuses = [];
	const second = manager.acquire(folder, 'b', { onStatus: text => statuses.push(text) });
	await new Promise(resolve => setTimeout(resolve, 15));
	// mentre la prima richiesta risponde non si chiude né si avvia niente
	assert.equal(h.execs.length, 0); assert.equal(h.spawns.length, 1);
	assert.ok(statuses.some(text => /In attesa che il modello locale a finisca un'altra richiesta/.test(text)), statuses.join(' | '));
	lease.release();
	(await second).release();
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.spawns.length, 2); assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('--alias') + 1], 'b');
	assert.match(statuses.at(-1), /Avvio del modello locale b/);
});

test('cambio con lease attivo: Stop durante l\'attesa dà AbortError, non chiude niente e la coda resta libera', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => answer(200, 'a'), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager({ leaseTimeout: 10000 }), lease = await manager.acquire(folder, 'a');
	const controller = new AbortController();
	const onStatus = text => { if (/In attesa/.test(text)) setTimeout(() => controller.abort(), 3) };
	await assert.rejects(manager.acquire(folder, 'b', { signal: controller.signal, onStatus }), error => error.name === 'AbortError');
	assert.equal(h.execs.length, 0); assert.equal(h.spawns.length, 1);
	// la richiesta annullata non tiene bloccata la porta: finita la prima, il cambio procede
	lease.release();
	(await manager.acquire(folder, 'b')).release();
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]); assert.equal(h.spawns.length, 2);
});

test('cambio con lease attivo: se il modello in uso esce durante l\'attesa si avvia subito il nuovo, senza taskkill', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager({ leaseTimeout: 10000 }); await manager.acquire(folder, 'a');
	const second = manager.acquire(folder, 'b');
	await new Promise(resolve => setTimeout(resolve, 5));
	const child = h.children.get(500); child.exitCode = 1; child.emit('close', 1);
	(await second).release();
	assert.equal(h.execs.length, 0); assert.equal(h.spawns.length, 2);
});

test('release doppia non blocca il successivo cambio modello', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf' })]), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release(); lease.release();
	await manager.acquire(folder, 'b'); assert.equal(h.spawns.length, 2);
});

test('acquire concorrenti sullo stesso modello fanno un solo spawn', async () => {
	let releaseHealth; const gate = new Promise(resolve => releaseHealth = resolve);
	const h = harness({ responses: [async () => null, async url => { if (url.endsWith('/health')) await gate; return answer(200) }, async () => answer(200)] });
	const manager = h.manager(), first = manager.acquire(folder, 'a');
	await new Promise(resolve => setTimeout(resolve, 1)); const second = manager.acquire(folder, 'a');
	await new Promise(resolve => setTimeout(resolve, 2)); releaseHealth(); await Promise.all([first, second]);
	assert.equal(h.spawns.length, 1);
});

test('annullamento durante l\'attesa di /health: AbortError, il processo resta acceso e viene riusato', async () => {
	const controller = new AbortController();
	const h = harness({ responses: [
		async () => null, // sonda: porta libera, si avvia
		async url => { assert.ok(url.endsWith('/health')); controller.abort(); return answer(503) }, // l'utente annulla mentre il modello carica
		async () => answer(503), // richiesta seguente: il modello di Vox sta ancora caricando
		async url => url.endsWith('/health') ? answer(200) : null,
	] });
	const manager = h.manager();
	await assert.rejects(manager.acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
	assert.equal(h.spawns.length, 1); assert.equal(h.execs.length, 0);
	const reused = await manager.acquire(folder, 'a'); reused.release();
	assert.equal(h.spawns.length, 1); assert.equal(h.execs.length, 0);
});

test('annullamento prima dell\'avvio: nessun processo; signal già annullato non cerca nemmeno la cartella', async () => {
	const controller = new AbortController();
	const h = harness({ responses: [async () => null] });
	await assert.rejects(h.manager().acquire(folder, 'a', { signal: controller.signal, onStatus: () => controller.abort() }), error => error.name === 'AbortError');
	assert.equal(h.spawns.length, 0);
	const accessesBefore = h.accesses.length;
	await assert.rejects(h.manager().acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
	assert.equal(h.accesses.length, accessesBefore);
});

test('annullamento mentre si aspetta che la porta si liberi: AbortError e nessun nuovo avvio', async () => {
	const controller = new AbortController();
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => { controller.abort(); return answer(200, 'a') }] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await assert.rejects(manager.acquire(folder, 'b', { signal: controller.signal }), error => error.name === 'AbortError');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]); assert.equal(h.spawns.length, 1);
});

test('sonda senza risposta con un altro modello di Vox: chiude il suo PID prima di avviare, o rifiuta se è in uso', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => null, async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.acquire(folder, 'b');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.spawns.length, 2);
	const busy = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => null] });
	const busyManager = busy.manager(); await busyManager.acquire(folder, 'a');
	await assert.rejects(busyManager.acquire(folder, 'b'), /ancora rispondendo/);
	assert.equal(busy.execs.length, 0); assert.equal(busy.spawns.length, 1);
});

test('annullamento in coda al mutex rifiuta subito e la richiesta seguente procede', async () => {
	let releaseModels; const gate = new Promise(resolve => releaseModels = resolve);
	const h = harness({ responses: [async () => { await gate; return null }, async url => url.endsWith('/health') ? answer(200) : null, async () => answer(200)] });
	const manager = h.manager(), first = manager.acquire(folder, 'a'); await new Promise(resolve => setTimeout(resolve, 1));
	const controller = new AbortController(), queued = manager.acquire(folder, 'a', { signal: controller.signal }); controller.abort();
	await assert.rejects(queued, error => error.name === 'AbortError');
	const later = manager.acquire(folder, 'a'); releaseModels(); await Promise.all([first, later]); assert.equal(h.spawns.length, 1);
});

test('errore spawn è gestito e restituisce un errore chiaro', async () => {
	const h = harness({ spawnError: Object.assign(Error('ENOENT'), { code: 'ENOENT' }), responses: [async () => null] });
	await assert.rejects(h.manager().acquire(folder, 'a'), /Impossibile avviare il modello locale a: ENOENT/);
});

test('motore mancante fallisce prima dello spawn', async () => {
	const h = harness(); h.files.delete(path.join(folder, 'motore', 'llama-server.exe'));
	await assert.rejects(h.manager().acquire(folder, 'a'), /Motore del modello locale non trovato/);
	assert.equal(h.spawns.length, 0);
});

test('uscita anticipata: il registro si riscrive all\'avvio e l\'errore mostra solo le righe di questo avvio', async () => {
	const h = harness({ logText: 'vecchia riga\n', responses: [async () => null] });
	const logPath = path.join(folder, 'avvia', 'a.log');
	const manager = h.manager({ spawn: (command, args, options) => {
		const child = new EventEmitter(); child.pid = 77; child.exitCode = null; child.signalCode = null; child.kill = () => {}; h.spawns.push({ command, args, options, child });
		queueMicrotask(() => { h.files.set(logPath, h.files.get(logPath) + 'nuova riga 1\nnuova riga 2\n'); child.exitCode = 1; child.emit('close', 1) });
		return child;
	} });
	await assert.rejects(manager.acquire(folder, 'a'), error => error.message.includes('nuova riga 1') && error.message.includes('nuova riga 2') && !error.message.includes('vecchia riga'));
	assert.deepEqual(h.opens, [[logPath, 'w']]);
});

test('processo ucciso da un segnale (exitCode null): errore subito con il registro, senza aspettare il tempo massimo', async () => {
	const h = harness({ platform: 'linux', responses: [async () => null] });
	const logPath = path.join(folder, 'avvia', 'a.log');
	const manager = h.manager({ healthTimeout: 1000, spawn: (command, args, options) => {
		const child = new EventEmitter(); child.pid = 78; child.exitCode = null; child.signalCode = null; child.kill = () => {}; h.spawns.push({ command, args, options, child });
		queueMicrotask(() => { h.files.set(logPath, 'CUDA error: out of memory\n'); child.signalCode = 'SIGSEGV'; child.emit('close', null, 'SIGSEGV') });
		return child;
	} });
	await assert.rejects(manager.acquire(folder, 'a'), error => error.message.includes('CUDA error: out of memory'));
});

test('timeout health chiude il PID; timeout del cambio non avvia un altro processo', async () => {
	const h = harness({ responses: [async () => null, async () => 503] });
	await assert.rejects(h.manager().acquire(folder, 'a'), /Tempo scaduto/);
	assert.deepEqual(h.execs[0].args, ['/PID', '500', '/T', '/F']);
	const models = [model(), model({ nome: 'b', file: 'b.gguf' })];
	const stuck = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(200, 'a'), async () => answer(200, 'a'), async () => answer(200, 'a'), async () => answer(200, 'a'), async () => answer(200, 'a')] });
	const manager = stuck.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await assert.rejects(manager.acquire(folder, 'b'), /occupata/); assert.equal(stuck.spawns.length, 1);
});

test('503 dello stesso motore con altro modello viene sostituito', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf' })]), responses: [async () => null, async () => answer(200), async () => answer(503), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release(); await manager.acquire(folder, 'b');
	assert.equal(h.execs.length, 1); assert.equal(h.spawns.length, 2);
});

test('processo Vox uscito viene rimosso e la richiesta successiva lo riavvia', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), first = await manager.acquire(folder, 'a'); first.release();
	const child = h.spawns[0].child; child.exitCode = 1; child.emit('close', 1);
	await manager.acquire(folder, 'a'); assert.equal(h.spawns.length, 2);
});

test('shutdown termina solo PID propri e assorbe errori di taskkill', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200), async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.acquire(folder, 'a');
	await manager.shutdown();
	assert.deepEqual(h.execs.map(item => item.args[1]), ['500']);
	const external = harness({ responses: [async () => answer(200)] }); await external.manager().acquire(folder, 'a'); await external.manager().shutdown();
	assert.equal(external.execs.length, 0);
	const failed = harness({ responses: [async () => null, async () => answer(200)], execFileError: Error('taskkill failed') });
	const failedManager = failed.manager(); const failedLease = await failedManager.acquire(folder, 'a'); failedLease.release();
	await assert.doesNotReject(failedManager.shutdown());
});

test('POSIX: chiusura con SIGKILL; un processo che non si chiude non blocca shutdown e resta da ritentare', async () => {
	const h = harness({ platform: 'linux', responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.shutdown();
	assert.deepEqual(h.kills, [[500, 'SIGKILL']]); assert.equal(h.execs.length, 0);
	const stuck = harness({ platform: 'linux', responses: [async () => null, async () => answer(200)] });
	const stuckManager = stuck.manager({ spawn: (command, args, options) => {
		const child = new EventEmitter(); child.pid = 90; child.exitCode = null; child.signalCode = null; child.kill = signal => stuck.kills.push([90, signal]);
		stuck.spawns.push({ command, args, options, child }); return child;
	} });
	const stuckLease = await stuckManager.acquire(folder, 'a'); stuckLease.release();
	await stuckManager.shutdown(); // finisce entro closeTimeout anche se il processo non si chiude
	await stuckManager.shutdown(); // il processo è ancora registrato: viene ritentato
	assert.deepEqual(stuck.kills, [[90, 'SIGKILL'], [90, 'SIGKILL']]);
});

test('shutdown durante un avvio in corso: il processo non parte e le richieste seguenti sono rifiutate', async () => {
	let reachedOpen, releaseOpen;
	const reached = new Promise(resolve => reachedOpen = resolve), gate = new Promise(resolve => releaseOpen = resolve);
	const h = harness({ responses: [async () => null] });
	const manager = h.manager({ open: async () => { reachedOpen(); await gate; return { fd: 1, close: async () => {} } } });
	const pending = manager.acquire(folder, 'a');
	await reached;
	await manager.shutdown(); releaseOpen();
	await assert.rejects(pending, /si sta chiudendo/);
	assert.equal(h.spawns.length, 0);
	await assert.rejects(manager.acquire(folder, 'a'), /si sta chiudendo/);
});

test('cartella non trovata: si ricontrolla dopo poco, non dopo la cache lunga', async () => {
	const h = harness();
	const configured = path.join(folder, 'nuova');
	const manager = h.manager({ cacheDuration: 60, missDuration: 5 });
	await assert.rejects(manager.listChatModels(configured), /Cartella delle IA locali/i);
	h.files.set(path.join(configured, 'modelli.json'), JSON.stringify(mf()));
	h.files.set(path.join(configured, 'modelli', 'a.gguf'), 'model');
	manager.rt.now = () => 6; // oltre il ricontrollo breve, prima della cache lunga
	assert.deepEqual((await manager.listChatModels(configured)).models.map(item => item.nome), ['a']);
});

test('cartella non trovata: le cartelle locali si ricontrollano dopo poco, le unità C–Z solo dopo la cache lunga', async () => {
	const h = harness();
	const local = path.join(folder, 'app', 'ia-locali');
	const driveChecks = () => h.accesses.filter(file => /^[C-Z]:\\Vox\\ia-locali\\modelli\.json$/.test(file)).length;
	const localChecks = () => h.accesses.filter(file => file === path.join(local, 'modelli.json')).length;
	let clock = 0;
	const manager = h.manager({ execPath: path.join(folder, 'app', 'app.exe'), homedir: () => path.join(folder, 'home'), platform: 'win32', now: () => clock, cacheDuration: 60, missDuration: 5,
		access: async file => { h.accesses.push(file); if (!h.files.has(file)) throw Error('ENOENT') } });
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(driveChecks(), 24); assert.equal(localChecks(), 1);
	clock = 6; // oltre il ricontrollo breve: solo le cartelle locali
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(driveChecks(), 24); assert.equal(localChecks(), 2);
	// la cartella creata accanto al programma si trova al ricontrollo breve
	h.files.set(path.join(local, 'modelli.json'), JSON.stringify(mf())); h.files.set(path.join(local, 'modelli', 'a.gguf'), 'model');
	clock = 12;
	assert.deepEqual((await manager.listChatModels('')).models.map(item => item.nome), ['a']);
	assert.equal(driveChecks(), 24);
	clock = 200; // la cartella locale valida salta le unità anche dopo la scadenza della cache lunga
	await manager.listChatModels('');
	assert.equal(driveChecks(), 24);
	h.files.delete(path.join(local, 'modelli.json'));
	clock = 261;
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(driveChecks(), 48);
});

test('unità che rifiutano l\'accesso (bloccate, permessi): risposta valida, la scansione resta in cache e non si ripete a ogni giro', async () => {
	const h = harness();
	const driveChecks = () => h.accesses.filter(file => /^[C-Z]:\\Vox\\ia-locali\\modelli\.json$/.test(file)).length;
	let clock = 0;
	const manager = h.manager({ execPath: path.join(folder, 'app', 'app.exe'), homedir: () => path.join(folder, 'home'), platform: 'win32', now: () => clock, cacheDuration: 60, missDuration: 5,
		access: async file => {
			h.accesses.push(file);
			if (/^[C-Z]:\\/.test(file)) throw Object.assign(new Error('EPERM: unità bloccata'), { code: /^Z:/.test(file) ? 'EPERM' : 'ENOENT' });
			if (!h.files.has(file)) throw Error('ENOENT');
		} });
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(driveChecks(), 24);
	clock = 6; // oltre il ricontrollo breve: l'unità Z: bloccata non fa ripetere la scansione
	await assert.rejects(manager.listChatModels(''), /Cartella delle IA locali/i);
	assert.equal(driveChecks(), 24);
});

test('un modello di completamento o embedding non si avvia dalla chat', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'c', uso: 'embedding' })]), responses: [async () => null] });
	await assert.rejects(h.manager().acquire(folder, 'c'), /non è un modello da chat/);
	assert.equal(h.spawns.length, 0);
});

test('manifesto cambiato con il modello acceso: Vox lo riavvia con i valori nuovi', async () => {
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null, async () => answer(200), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	const second = await manager.acquire(folder, 'a'); second.release();
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
});

test('acquire con una lettura vecchia riusa il processo avviato dal manifesto nuovo', async () => {
	let blockRead = false, releaseRead, reachedRead;
	const oldManifest = JSON.stringify(mf([model()]));
	const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null, async () => null, async () => null, async url => url.endsWith('/health') ? answer(200) : null], readFile: async (file, files) => {
		if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate; return oldManifest }
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager();
	blockRead = true;
	const oldAcquire = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	const newLease = await manager.acquire(folder, 'a');
	releaseRead();
	const oldLease = await oldAcquire;
	assert.equal(h.spawns.length, 1);
	assert.equal(h.spawns[0].args[h.spawns[0].args.indexOf('-c') + 1], '8192');
	assert.equal(h.execs.length, 0);
	newLease.release(); oldLease.release();
});

test('acquire rifiuta dopo tre manifesti cambiati durante l’avvio', async () => {
	let reads = 0;
	const h = harness({ readFile: async (file, files) => {
		if (file === path.join(folder, 'modelli.json')) return JSON.stringify(mf([model({ contesto: 4096 + reads++ })]));
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	await assert.rejects(h.manager().acquire(folder, 'a'), /riprova/i);
	assert.equal(reads, 6);
	assert.equal(h.spawns.length, 0);
});

test('cambio porta chiude il PID vecchio prima di avviare il modello sulla porta nuova', async () => {
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), responses: [async () => null, async () => answer(200), async () => null, async () => answer(200)] });
	const execsAtSpawn = [], recordSpawn = h.spawns.push.bind(h.spawns);
	h.spawns.push = (...items) => { execsAtSpawn.push(h.execs.length); return recordSpawn(...items) };
	const manager = h.manager(), first = await manager.acquire(folder, 'qwen'); first.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
	const next = await manager.acquire(folder, 'qwen'); next.release();
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.deepEqual(h.spawns.map(item => item.args[item.args.indexOf('--port') + 1]), ['8192', '8195']);
	assert.deepEqual(execsAtSpawn, [0, 1]);
	assert.deepEqual([...h.owned.keys()], [8195]);
});

test('acquire non avvia sulla nuova porta se fallisce la chiusura del processo superato', async () => {
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null], execFileError: Error('taskkill failed') });
	const manager = h.manager({ closeTimeout: 0 }), first = await manager.acquire(folder, 'qwen'); first.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
	await assert.rejects(manager.acquire(folder, 'qwen'), /Impossibile chiudere il modello locale qwen/i);
	assert.deepEqual(h.spawns.map(item => item.args[item.args.indexOf('--port') + 1]), ['8192']);
});

test('acquire procede se il processo superato ha un prestito attivo', async () => {
	let reads = 0;
	const firstNew = JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })]));
	const newest = JSON.stringify(mf([model({ nome: 'qwen', porta: 8196 })]));
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), responses: Array.from({ length: 10 }, () => async url => url.endsWith('/health') ? answer(200) : null), readFile: async (file, files) => {
		if (file === path.join(folder, 'modelli.json')) {
			reads++;
			if (reads === 4) return firstNew;
			if (reads >= 5) return newest;
		}
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager(), first = await manager.acquire(folder, 'qwen');
	h.files.set(path.join(folder, 'modelli.json'), newest);
	const next = await manager.acquire(folder, 'qwen');
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('--port') + 1], '8196');
	first.release(); next.release();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('listChatModels chiude un modello tolto dal manifesto senza aspettare la chiusura', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([])));
	assert.deepEqual((await manager.listChatModels(folder)).models, []);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('listChatModels chiude stesso nome e porta quando cambia la firma', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('listChatModels conserva il processo descritto dal manifesto', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 0); assert.deepEqual([...h.owned.keys()], [8192]);
});

test('un prestito attivo rimanda la chiusura al rilascio quando il manifesto è superato', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a');
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 0);
	lease.release(); await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('il rilascio non chiude un processo ancora descritto dal manifesto', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200), async () => answer(200)] });
	const manager = h.manager(), first = await manager.acquire(folder, 'a');
	first.release(); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 0); assert.deepEqual([...h.owned.keys()], [8192]);
	const second = await manager.acquire(folder, 'a');
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder); second.release(); await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('il doppio rilascio non chiude due volte e due prestiti aspettano l’ultimo rilascio', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200), async () => answer(200)] });
	const manager = h.manager(), first = await manager.acquire(folder, 'a'), second = await manager.acquire(folder, 'a');
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder);
	first.release(); first.release(); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 0);
	second.release(); await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('acquire chiude il processo del modello tolto dal manifesto prima di rifiutarlo', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([])));
	await assert.rejects(manager.acquire(folder, 'a'), /non trovato nel manifesto/i);
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('annullare acquire durante closeStale rifiuta prima del timeout senza avviare processi', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager({ closeTimeout: 1000, execFile: (exe, args, opts, callback) => {
		h.execs.push({ exe, args, opts });
		setTimeout(() => { const child = h.children.get(Number(args[1])); child.exitCode = 1; child.emit('close', 1); callback(null) }, 400);
	} });
	const lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'b', file: 'b.gguf', porta: 8195 })])));
	const controller = new AbortController(), started = Date.now();
	const pending = manager.acquire(folder, 'b', { signal: controller.signal });
	while (!h.execs.length) await new Promise(resolve => setTimeout(resolve, 0));
	controller.abort();
	const quick = await Promise.race([pending.then(() => 'done', error => error.name), new Promise(resolve => setTimeout(() => resolve('late'), 50))]);
	assert.equal(quick, 'AbortError');
	await assert.rejects(pending, error => error.name === 'AbortError');
	assert.ok(Date.now() - started < 200); assert.equal(h.spawns.length, 1);
});

test('acquire assegna il numero di lettura dopo una ricerca cartella lenta', async () => {
	let blockAccess = false, releaseAccess, reachedAccess;
	const reached = new Promise(resolve => reachedAccess = resolve), gate = new Promise(resolve => releaseAccess = resolve);
	const h = harness({ responses: [async () => null, async () => answer(200), async () => null, async () => answer(200)], access: async (file, files) => {
		if (blockAccess && file === path.join(folder, 'modelli.json')) { blockAccess = false; reachedAccess(); await gate }
		if (!files.has(file)) throw Error('ENOENT');
	} });
	const manager = h.manager(), first = await manager.acquire(folder, 'a'); first.release();
	blockAccess = true; const slowFolder = `${folder}${path.sep}.`, acquiring = manager.acquire(slowFolder, 'a'); await reached;
	await manager.listChatModels(folder);
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ porta: 8195 })])));
	releaseAccess(); const next = await acquiring; next.release();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.deepEqual([...h.owned.keys()], [8195]);
});

test('listChatModels salta il processo con lock attivo sulla porta superata', async () => {
	let releaseHealth; const healthGate = new Promise(resolve => releaseHealth = resolve);
	const h = harness({ responses: [async () => null, async url => { if (url.endsWith('/health')) await healthGate; return answer(200) }, async () => null, async () => null, async () => answer(200)] });
	const manager = h.manager(), pending = manager.acquire(folder, 'a');
	while (!h.spawns.length) await new Promise(resolve => setTimeout(resolve, 0));
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 0);
	releaseHealth(); const lease = await pending;
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
	lease.release();
	await manager.listChatModels(folder); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(h.execs.length, 1);
});

test('un manifesto illeggibile non chiude processi posseduti', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	h.files.set(path.join(folder, 'modelli.json'), '{');
	await assert.rejects(manager.listChatModels(folder), /Impossibile leggere il manifesto/i);
	assert.equal(h.execs.length, 0); assert.deepEqual([...h.owned.keys()], [8192]);
});

test('una lettura vecchia completata dopo acquire nuovo non chiude il processo nuovo', async () => {
	let blockRead = false, releaseRead, reachedRead;
	const oldManifest = JSON.stringify(mf([model()]));
	const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
	const h = harness({ responses: [async () => null, async () => answer(200), async () => null, async () => answer(200)], readFile: async (file, files) => {
		if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate; return oldManifest }
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager(), first = await manager.acquire(folder, 'a'); first.release();
	blockRead = true; const oldList = manager.listChatModels(folder); await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ porta: 8195 })])));
	const next = await manager.acquire(folder, 'a'); next.release();
	releaseRead(); await oldList; await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual([...h.owned.keys()], [8195]);
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
});

test('listChatModels e acquire concorrenti chiudono la porta superata', async () => {
	let controlReads = false, reachedReads = 0, releaseReads, resolveBoth;
	const bothReads = new Promise(resolve => resolveBoth = resolve), readGate = new Promise(resolve => releaseReads = resolve);
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), responses: [async () => null, async () => answer(200, 'qwen'), async () => null, async () => answer(200, 'qwen')], readFile: async (file, files) => {
		if (controlReads && file === path.join(folder, 'modelli.json')) {
			reachedReads++;
			if (reachedReads === 2) resolveBoth();
			await readGate;
			return files.get(file);
		}
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager(), first = await manager.acquire(folder, 'qwen'); first.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
	controlReads = true;
	const listing = manager.listChatModels(folder), acquiring = manager.acquire(folder, 'qwen');
	await bothReads;
	releaseReads(h.files.get(path.join(folder, 'modelli.json')));
	await Promise.all([listing, acquiring]).then(([, lease]) => lease.release());
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.deepEqual([...h.owned.keys()], [8195]);
});

test('stato di avvio mostrato anche quando si aspetta un modello già in caricamento', async () => {
	const controller = new AbortController();
	const h = harness({ responses: [async () => null, async () => { controller.abort(); return answer(503) }, async () => answer(503), async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager();
	await assert.rejects(manager.acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
	const statuses = [];
	const lease = await manager.acquire(folder, 'a', { onStatus: text => statuses.push(text) }); lease.release();
	assert.equal(h.spawns.length, 1);
	assert.deepEqual(statuses, ['Avvio del modello locale a…']);
});

test('risposte anomale: data non elenco è una porta occupata; un 500 dal processo di Vox non blocca il cambio', async () => {
	const odd = harness({ responses: [async () => ({ status: 200, body: { data: 'ok' } })] });
	await assert.rejects(odd.manager().acquire(folder, 'a'), /occupata/);
	assert.equal(odd.spawns.length, 0);
	const models = [model(), model({ nome: 'b', file: 'b.gguf', opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async () => answer(200), async () => answer(500), async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager(), lease = await manager.acquire(folder, 'a'); lease.release();
	await manager.acquire(folder, 'b');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.spawns.length, 2);
});

test('chiusure concorrenti dello stesso processo: un solo taskkill', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const manager = h.manager({ execFile: (exe, args, opts, callback) => { h.execs.push({ exe, args, opts }); setTimeout(() => { const child = h.children.get(Number(args[1])); child.exitCode = 1; child.emit('close', 1); callback(null) }, 2) } });
	const lease = await manager.acquire(folder, 'a'); lease.release();
	await Promise.all([manager.shutdown(), manager.shutdown()]);
	assert.equal(h.execs.length, 1);
});

test('il registro si chiude in Vox subito dopo l\'avvio: il file resta solo al processo del modello', async () => {
	let closed = 0;
	const h = harness({ responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null] });
	const manager = h.manager({ open: async () => ({ fd: 3, close: async () => { closed++ } }) });
	const lease = await manager.acquire(folder, 'a'); lease.release();
	assert.equal(closed, 1);
	assert.deepEqual(h.spawns[0].options.stdio, ['ignore', 3, 3]);
	assert.equal(h.spawns[0].child.exitCode, null); // il modello è ancora acceso
});

test('/health pronto ma il processo di Vox è già uscito: niente prestito, errore con il registro', async () => {
	const h = harness({ responses: [async () => null, async () => answer(200)] });
	const logPath = path.join(folder, 'avvia', 'a.log');
	const manager = h.manager({ spawn: (command, args, options) => {
		const child = new EventEmitter(); child.pid = 79; child.exitCode = null; child.signalCode = null; child.kill = () => {}; h.spawns.push({ command, args, options, child });
		queueMicrotask(() => { h.files.set(logPath, 'porta già in uso\n'); child.exitCode = 1; child.emit('close', 1) });
		return child;
	} });
	await assert.rejects(manager.acquire(folder, 'a'), error => error.message.includes('porta già in uso'));
});

for (const succeeds of [false, true]) {
	test(`chiusura in corso al cambio porta: taskkill lento ${succeeds ? 'riuscito' : 'fallito'}`, async () => {
		let reachedKill, finishKill;
		const reached = new Promise(resolve => reachedKill = resolve);
		const h = harness({ manifest: mf([model({ nome: 'qwen' })]) });
		const manager = h.manager({ ...fastRuntime, closeTimeout: succeeds ? 1000 : 1, execFile: (exe, args, opts, callback) => {
			h.execs.push({ exe, args, opts });
			finishKill = () => {
				if (succeeds) { const child = h.children.get(Number(args[1])); child.exitCode = 1; child.emit('close', 1) }
				callback(succeeds ? null : Error('taskkill failed'));
			};
			reachedKill();
		} });
		const first = await manager.acquire(folder, 'qwen'); first.release();
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
		await manager.listChatModels(folder);
		await reached;
		let settled = false;
		const pending = manager.acquire(folder, 'qwen').then(lease => { settled = true; return lease }, error => { settled = true; return error });
		await new Promise(resolve => setImmediate(resolve));
		const beforeClose = { settled, spawns: h.spawns.length };
		finishKill();
		const result = await pending;
		assert.deepEqual(beforeClose, { settled: false, spawns: 1 });
		assert.equal(h.execs.length, 1);
		if (succeeds) {
			assert.equal(h.spawns[0].child.exitCode, 1);
			assert.deepEqual(h.spawns.map(item => item.args[item.args.indexOf('--port') + 1]), ['8192', '8195']);
			result.release();
		} else {
			assert.ok(result instanceof Error);
			assert.match(result.message, /Impossibile chiudere il modello locale qwen/);
			assert.equal(h.spawns.length, 1);
		}
	});
}

test('riuso con manifesto superato durante la sonda riavvia con il contesto nuovo', async () => {
	let reachedProbe, releaseProbe, block = false;
	const reached = new Promise(resolve => reachedProbe = resolve), gate = new Promise(resolve => releaseProbe = resolve);
	const h = harness();
	const manager = h.manager({ fetch: async url => {
		if (url.endsWith('/health')) return answer(200);
		if (block) { block = false; reachedProbe(); await gate; return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } }
		return h.owned.has(8192) ? { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } : null;
	} });
	const first = await manager.acquire(folder, 'a');
	block = true;
	const pending = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder);
	first.release(); releaseProbe();
	const second = await pending;
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
	second.release();
});

for (const reuse of [false, true]) {
	test(`manifesto cambiato durante health: ricontrollo dopo ${reuse ? 'riuso in caricamento' : 'avvio'}`, async () => {
		let reachedHealth, releaseHealth, block = false;
		const reached = new Promise(resolve => reachedHealth = resolve), gate = new Promise(resolve => releaseHealth = resolve);
		const controller = new AbortController();
		const h = harness();
		const manager = h.manager({ fetch: async url => {
			if (url.endsWith('/health')) {
				if (reuse && !controller.signal.aborted) { controller.abort(); return answer(503) }
				if (block) { block = false; reachedHealth(); await gate }
				return answer(200);
			}
			return h.owned.has(8192) ? answer(503) : null;
		} });
		if (reuse) await assert.rejects(manager.acquire(folder, 'a', { signal: controller.signal }), error => error.name === 'AbortError');
		block = true;
		const pending = manager.acquire(folder, 'a');
		await reached;
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
		releaseHealth();
		const lease = await pending;
		assert.equal(h.spawns.length, 2);
		assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
		assert.equal(h.spawns[0].child.exitCode, 1);
		lease.release();
	});
}

test('manifesto ricontrollato dopo attesa dei prestiti: b parte con il contesto nuovo', async () => {
	let reachedWait;
	const reached = new Promise(resolve => reachedWait = resolve);
	const models = [model(), model({ nome: 'b', file: 'b.gguf' })];
	const h = harness({ manifest: mf(models) });
	const manager = h.manager({ leaseTimeout: 1000, fetch: async url => url.endsWith('/health') ? answer(200) : h.owned.has(8192) ? answer(200) : null });
	const first = await manager.acquire(folder, 'a');
	const pending = manager.acquire(folder, 'b', { onStatus: text => { if (/In attesa/.test(text)) reachedWait() } });
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([models[0], { ...models[1], contesto: 8192 }])));
	first.release();
	const second = await pending;
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('--alias') + 1], 'b');
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
	second.release();
});

test('manifesto invariato letto dal rilevamento durante acquire: riuso senza ripetizioni o riletture', async () => {
	let reads = 0, reachedRead, releaseRead, block = false;
	const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
	const h = harness({ readFile: async (file, files) => {
		const value = files.get(file);
		if (file === path.join(folder, 'modelli.json')) {
			reads++;
			if (block) { block = false; reachedRead(); await gate }
		}
		return value;
	} });
	const manager = h.manager({ fetch: async url => url.endsWith('/health') ? answer(200) : h.owned.has(8192) ? { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } : null });
	const first = await manager.acquire(folder, 'a');
	const before = reads;
	block = true;
	const pending = manager.acquire(folder, 'a');
	await reached;
	await manager.listChatModels(folder);
	releaseRead();
	const second = await pending;
	assert.equal(reads - before, 3); // acquire, listChatModels e ricontrollo prima del riuso
	assert.equal(h.spawns.length, 1);
	assert.equal(h.execs.length, 0);
	first.release(); second.release();
});

test('acquire con lettura vecchia aspetta la chiusura in corso e ne segnala il fallimento', async () => {
	let blockRead = false, releaseRead, reachedRead, reachedKill, finishKill;
	const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
	const killing = new Promise(resolve => reachedKill = resolve);
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), readFile: async (file, files) => {
		const value = files.get(file);
		if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate }
		return value;
	} });
	const manager = h.manager({ ...fastRuntime, closeTimeout: 1, execFile: (exe, args, opts, callback) => {
		h.execs.push({ exe, args, opts });
		finishKill = () => callback(Error('taskkill failed'));
		reachedKill();
	} });
	const first = await manager.acquire(folder, 'qwen'); first.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
	blockRead = true;
	let settled = false;
	const pending = manager.acquire(folder, 'qwen').then(lease => { settled = true; return lease }, error => { settled = true; return error });
	await reached;
	await manager.listChatModels(folder);
	await killing;
	releaseRead();
	await new Promise(resolve => setImmediate(resolve));
	const beforeClose = { settled, spawns: h.spawns.length };
	finishKill();
	const result = await pending;
	assert.deepEqual(beforeClose, { settled: false, spawns: 1 });
	assert.ok(result instanceof Error);
	assert.match(result.message, /Impossibile chiudere il modello locale qwen/);
	assert.equal(h.spawns.length, 1);
	assert.equal(h.execs.length, 1);
});

test('acquire elenca tutti i modelli superati che non riesce a chiudere', async () => {
	const h = harness({ manifest: mf([model(), model({ nome: 'b', file: 'b.gguf', porta: 8193 })]), execFileError: Error('taskkill failed') });
	const manager = h.manager({ ...fastRuntime, closeTimeout: 0 });
	(await manager.acquire(folder, 'a')).release();
	(await manager.acquire(folder, 'b')).release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'c', porta: 8195 })])));
	await assert.rejects(manager.acquire(folder, 'c'), /Impossibile chiudere i modelli locali (a, b|b, a)\./);
	assert.equal(h.execs.length, 2);
	assert.equal(h.spawns.length, 2);
});

test('stato di avvio assente se il modello sparisce prima del ricontrollo del manifesto', async () => {
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]), responses: [async url => {
		assert.ok(url.endsWith('/v1/models'));
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([])));
		return null;
	}] });
	const statuses = [];
	await assert.rejects(h.manager().acquire(folder, 'qwen', { onStatus: text => statuses.push(text) }), /Modello locale qwen non trovato nel manifesto\./);
	assert.deepEqual(statuses, []);
	assert.equal(h.spawns.length, 0);
});

test('tre cambi durante health chiudono tutti i processi anche senza rilevamento', async () => {
	let changes = 0;
	const h = harness();
	const manager = h.manager({ fetch: async url => {
		if (!url.endsWith('/health')) return null;
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 4096 + ++changes * 1024 })])));
		return answer(200);
	} });
	await assert.rejects(manager.acquire(folder, 'a'), /modelli.json è cambiato durante l'avvio del modello locale/);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(changes, 3);
	assert.equal(h.spawns.length, 3);
	assert.deepEqual(h.execs.map(item => item.args), h.spawns.map(({ child }) => ['/PID', String(child.pid), '/T', '/F']));
	assert.equal(h.owned.size, 0);
});

for (const detection of [false, true]) {
	test(`tre cambi durante la sonda chiudono il processo ${detection ? 'con' : 'senza'} rilevamento`, async () => {
		let changes = 0;
		const h = harness();
		const manager = h.manager({ ...fastRuntime });
		(await manager.acquire(folder, 'a')).release();
		manager.rt.fetch = async url => {
			assert.ok(url.endsWith('/v1/models'));
			h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 4096 + ++changes * 1024 })])));
			if (detection) await manager.listChatModels(folder);
			return h.owned.has(8192) ? { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } : null;
		};
		await assert.rejects(manager.acquire(folder, 'a'), /modelli.json è cambiato durante l'avvio del modello locale/);
		assert.equal(changes, 3);
		assert.equal(h.spawns.length, 1);
		assert.deepEqual(h.execs.map(item => item.args), [['/PID', String(h.spawns[0].child.pid), '/T', '/F']]);
		assert.equal(h.owned.size, 0);
	});
}

test('JSON troncato nel ricontrollo dopo health consuma solo un tentativo', async () => {
	let truncated = false, failures = 0;
	const h = harness({ readFile: async (file, files) => {
		if (truncated && file === path.join(folder, 'modelli.json')) { truncated = false; failures++; return '{' }
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager({ fetch: async url => {
		if (url.endsWith('/health')) { truncated = true; return answer(200) }
		return h.owned.has(8192) ? { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } : null;
	} });
	const lease = await manager.acquire(folder, 'a');
	assert.equal(failures, 1);
	assert.equal(h.spawns.length, 1);
	assert.equal(h.owned.get(8192).leases, 1);
	lease.release();
});

test('annullamento durante il ricontrollo dopo health rilascia il prestito', async () => {
	let blockRead = false, releaseRead, reachedRead;
	const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
	const h = harness({ readFile: async (file, files) => {
		if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate }
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager({ fetch: async url => {
		if (!url.endsWith('/health')) return null;
		blockRead = true; return answer(200);
	} });
	const controller = new AbortController();
	const pending = manager.acquire(folder, 'a', { signal: controller.signal });
	await reached;
	controller.abort(); releaseRead();
	await assert.rejects(pending, error => error.name === 'AbortError');
	assert.equal(h.owned.get(8192).leases, 0);
});

test('eccezione durante la chiusura della porta superata impedisce il nuovo avvio', async () => {
	const h = harness();
	const manager = h.manager({ ...fastRuntime, closeTimeout: 137, setTimeout: (callback, ms) => {
		if (ms === 137) throw Error('timer di chiusura non disponibile');
		return setTimeout(callback, ms);
	} });
	(await manager.acquire(folder, 'a')).release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ porta: 8195 })])));
	await assert.rejects(manager.acquire(folder, 'a'), /Impossibile chiudere il modello locale a\./);
	assert.equal(h.spawns.length, 1);
	assert.equal(h.spawns[0].args[h.spawns[0].args.indexOf('--port') + 1], '8192');
});


test('ricontrollo di a durante la lettura di c chiude b prima di avviare c', async () => {
	let reachedHealth, releaseHealth, reachedRead, releaseRead, blockRead = false;
	const healthReached = new Promise(resolve => reachedHealth = resolve), healthGate = new Promise(resolve => releaseHealth = resolve);
	const readReached = new Promise(resolve => reachedRead = resolve), readGate = new Promise(resolve => releaseRead = resolve);
	const a = model(), b = model({ nome: 'b', porta: 8193 }), c = model({ nome: 'c', porta: 8194 });
	const h = harness({ manifest: mf([a, b]), readFile: async (file, files) => {
		const value = files.get(file);
		if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await readGate }
		return value;
	} });
	const manager = h.manager({ fetch: async url => {
		if (!url.endsWith('/health')) return null;
		if (url.includes(':8192/')) { reachedHealth(); await healthGate }
		return answer(200);
	} });
	const spawn = manager.rt.spawn;
	manager.rt.spawn = (command, args, options) => {
		if (args[args.indexOf('--alias') + 1] === 'c') {
			assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
			assert.equal(h.spawns[0].child.exitCode, 1);
		}
		return spawn(command, args, options);
	};
	(await manager.acquire(folder, 'b')).release();
	const acquiringA = manager.acquire(folder, 'a');
	await healthReached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([a, c])));
	blockRead = true;
	const acquiringC = manager.acquire(folder, 'c');
	await readReached;
	releaseHealth();
	const leaseA = await acquiringA;
	releaseRead();
	const leaseC = await acquiringC;
	assert.deepEqual(h.spawns.map(item => item.args[item.args.indexOf('--alias') + 1]), ['b', 'a', 'c']);
	leaseA.release(); leaseC.release();
});

for (const lastAttempt of [false, true]) {
	test(`JSON non valido nel ricontrollo dopo health: ${lastAttempt ? 'ultimo tentativo' : 'errore permanente'}`, async () => {
		let healthChecks = 0;
		const h = harness();
		const manager = h.manager({ fetch: async url => {
			if (!url.endsWith('/health')) return null;
			healthChecks++;
			h.files.set(path.join(folder, 'modelli.json'), lastAttempt && healthChecks < 3
				? JSON.stringify(mf([model({ contesto: 4096 + healthChecks * 1024 })])) : '{');
			return answer(200);
		} });
		await assert.rejects(manager.acquire(folder, 'a'), error => {
			assert.match(error.message, /Impossibile leggere il manifesto dei modelli locali:/);
			assert.ok(!error.message.includes('è cambiato'));
			return true;
		});
		assert.equal(healthChecks, lastAttempt ? 3 : 1);
		assert.equal(h.owned.get(8192).leases, 0);
	});
}

test('chiusura in corso al cambio porta: eccezione nel timer impedisce il nuovo avvio', async () => {
	let finishKill, reachedKill;
	const reached = new Promise(resolve => reachedKill = resolve);
	const h = harness({ manifest: mf([model({ nome: 'qwen' })]) });
	const manager = h.manager({ ...fastRuntime, closeTimeout: 137, setTimeout: (callback, ms) => {
		if (ms === 137) throw Error('timer di chiusura non disponibile');
		return setTimeout(callback, ms);
	}, execFile: (exe, args, opts, callback) => {
		h.execs.push({ exe, args, opts });
		finishKill = () => callback(Error('taskkill failed'));
		reachedKill();
	} });
	(await manager.acquire(folder, 'qwen')).release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ nome: 'qwen', porta: 8195 })])));
	await manager.listChatModels(folder);
	await reached;
	let settled = false;
	const pending = manager.acquire(folder, 'qwen').then(lease => { settled = true; return lease }, error => { settled = true; return error });
	await new Promise(resolve => setImmediate(resolve));
	const beforeClose = { settled, spawns: h.spawns.length };
	finishKill();
	const result = await pending;
	assert.deepEqual(beforeClose, { settled: false, spawns: 1 });
	assert.ok(result instanceof Error);
	assert.match(result.message, /Impossibile chiudere il modello locale qwen\./);
	assert.equal(h.execs.length, 1);
	assert.equal(h.spawns.length, 1);
});

test('riuso pronto ricontrolla il manifesto cambiato durante la sonda senza rilevamento', async () => {
	let reachedProbe, releaseProbe, block = false;
	const reached = new Promise(resolve => reachedProbe = resolve), gate = new Promise(resolve => releaseProbe = resolve);
	const h = harness();
	const manager = h.manager({ fetch: async url => {
		if (url.endsWith('/health')) return answer(200);
		if (block) { block = false; reachedProbe(); await gate; return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } }
		return null;
	} });
	(await manager.acquire(folder, 'a')).release();
	block = true;
	const pending = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	releaseProbe();
	const lease = await pending;
	assert.equal(h.spawns.length, 2);
	assert.equal(h.spawns[0].child.exitCode, 1);
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', String(h.spawns[0].child.pid), '/T', '/F']]);
	assert.equal(h.spawns[1].args[h.spawns[1].args.indexOf('-c') + 1], '8192');
	lease.release();
});

for (const stale of [false, true]) {
	test(`annullamento durante health dopo acquire su altra porta: processo ${stale ? 'superato chiuso' : 'valido conservato'}`, async () => {
		let reachedHealth, releaseHealth;
		const reached = new Promise(resolve => reachedHealth = resolve), gate = new Promise(resolve => releaseHealth = resolve);
		const a = model(), c = model({ nome: 'c', porta: 8194 });
		const controller = new AbortController();
		const h = harness();
		const manager = h.manager({ fetch: async url => {
			if (!url.endsWith('/health')) return null;
			if (url.includes(':8192/')) { reachedHealth(); await gate }
			return answer(200);
		} });
		const pending = manager.acquire(folder, 'a', { signal: controller.signal });
		await reached;
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf(stale ? [c] : [a, c])));
		const leaseC = await manager.acquire(folder, 'c');
		assert.equal(h.execs.length, 0);
		controller.abort(); releaseHealth();
		await assert.rejects(pending, error => error.name === 'AbortError');
		assert.equal(h.spawns.length, 2);
		assert.equal(h.spawns[0].child.exitCode, stale ? 1 : null);
		assert.deepEqual(h.execs.map(item => item.args), stale ? [['/PID', String(h.spawns[0].child.pid), '/T', '/F']] : []);
		assert.equal(h.spawns[1].child.exitCode, null);
		leaseC.release();
	});
}

test('Stop durante l\'attesa dei prestiti in replaceOwned chiude il processo superato', async () => {
	const models = [model(), model({ nome: 'b', file: 'b.gguf', porta: 8192, opzioni: [] })];
	const h = harness({ manifest: mf(models), responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null, async () => null] });
	const manager = h.manager({ leaseTimeout: 2000, healthInterval: 1000 });
	const first = await manager.acquire(folder, 'a');
	let reachedWait;
	const reached = new Promise(resolve => reachedWait = resolve);
	const controller = new AbortController();
	const pending = manager.acquire(folder, 'b', { signal: controller.signal, onStatus: text => { if (/In attesa/.test(text)) reachedWait() } });
	await reached;
	first.release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([models[1]])));
	await manager.listChatModels(folder);
	controller.abort();
	await assert.rejects(pending, error => error.name === 'AbortError');
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.owned.size, 0);
	assert.equal(h.spawns.length, 1);
});

test('un solo taskkill se la chiusura in replaceOwned fallisce', async () => {
	const h = harness({ execFileError: Error('taskkill failed'), responses: [async () => null, async url => url.endsWith('/health') ? answer(200) : null, async () => null] });
	const manager = h.manager();
	(await manager.acquire(folder, 'a')).release();
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await assert.rejects(manager.acquire(folder, 'a'), /Impossibile chiudere il modello locale a\./);
	assert.equal(h.execs.length, 1);
	assert.equal(h.owned.size, 1);
	assert.equal(h.spawns.length, 1);
});

test('un solo taskkill dopo il timeout di waitUntilReady con processo superato', async () => {
	let releaseHealth, reachedHealth;
	const reached = new Promise(resolve => reachedHealth = resolve), gate = new Promise(resolve => releaseHealth = resolve);
	let holding = true;
	const h = harness({ execFileError: Error('taskkill failed') });
	const manager = h.manager({ healthTimeout: 50, fetch: async url => {
		if (!url.endsWith('/health')) return null;
		if (holding) { holding = false; reachedHealth(); await gate }
		return answer(503);
	} });
	const pending = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder);
	releaseHealth();
	await assert.rejects(pending, /Tempo scaduto/);
	assert.equal(h.execs.length, 1);
	assert.equal(h.spawns.length, 1);
});

for (const loading of [false, true]) {
	test(`segno tolto prima dei controlli: Stop dopo ricontrollo valido non chiude al rilascio (${loading ? 'dopo health' : 'riuso pronto'})`, async () => {
		const manifestFile = path.join(folder, 'modelli.json');
		const h = harness(), manager = h.manager({ ...fastRuntime });
		const first = await manager.acquire(folder, 'a');
		// seconda richiesta: ricontrollo con manifesto diverso e Stop, il processo resta segnato superato
		let blockRead = false;
		const second = new AbortController();
		manager.rt.readFile = async file => blockRead && file === manifestFile ? JSON.stringify(mf([model({ contesto: 8192 })])) : h.files.get(file);
		const innerRead = manager.rt.readFile;
		manager.rt.readFile = async file => { const value = await innerRead(file); if (blockRead) second.abort(); return value };
		manager.rt.fetch = async url => { blockRead = true; return loading && !url.endsWith('/health') ? null : { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } };
		await assert.rejects(manager.acquire(folder, 'a', { signal: second.signal }), error => error.name === 'AbortError');
		assert.equal(h.execs.length, 0);
		// terza richiesta: manifesto di nuovo valido, Stop subito dopo il ricontrollo (prima dei controlli)
		let reads = 0;
		const third = new AbortController();
		manager.rt.readFile = async file => {
			const value = h.files.get(file);
			if (file === manifestFile && ++reads === 2) third.abort();
			return value;
		};
		manager.rt.fetch = async url => loading && !url.endsWith('/health') ? null : { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) };
		await assert.rejects(manager.acquire(folder, 'a', { signal: third.signal }), error => error.name === 'AbortError');
		first.release();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(h.execs.length, 0);
		assert.equal(h.owned.get(8192).leases, 0);
	});
}

for (const loading of [false, true]) {
	test(`un solo taskkill se la chiusura del superato fallisce e la sezione esce con Stop (${loading ? 'dopo health' : 'riuso pronto'})`, async () => {
		let blockRead = false, reachedRead, releaseRead;
		const reached = new Promise(resolve => reachedRead = resolve), gate = new Promise(resolve => releaseRead = resolve);
		const h = harness({ execFileError: Error('taskkill failed'), readFile: async (file, files) => {
			if (blockRead && file === path.join(folder, 'modelli.json')) { blockRead = false; reachedRead(); await gate }
			return files.get(file);
		} });
		const manager = h.manager({ ...fastRuntime }), controller = new AbortController();
		(await manager.acquire(folder, 'a')).release();
		manager.rt.fetch = async url => {
			if (!loading || url.endsWith('/health')) {
				blockRead = true;
				return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) };
			}
			return null;
		};
		const pending = manager.acquire(folder, 'a', { signal: controller.signal });
		await reached;
		// il rilevamento legge il manifesto nuovo e salta la porta con il lock: all'uscita il processo risulta superato
		h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
		await manager.listChatModels(folder);
		controller.abort(); releaseRead();
		await assert.rejects(pending, error => error.name === 'AbortError');
		assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
		assert.equal(h.owned.size, 1);
		assert.equal(h.spawns.length, 1);
	});
}

test('riuso pronto con ricontrollo superato e chiusura fallita: un solo taskkill', async () => {
	let reread = false;
	const h = harness({ execFileError: Error('taskkill failed'), readFile: async (file, files) => {
		if (file === path.join(folder, 'modelli.json') && reread) return JSON.stringify(mf([model({ contesto: 8192 })]));
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	manager.rt.fetch = async () => { reread = true; return { ...answer(200), json: async () => ({ data: [{ id: 'a' }] }) } };
	await assert.rejects(manager.acquire(folder, 'a'), /Impossibile chiudere il modello locale a\./);
	assert.equal(h.execs.length, 1);
	assert.equal(h.owned.size, 1);
	assert.equal(h.spawns.length, 1);
});

test('dopo health con ricontrollo superato e chiusura fallita: un solo taskkill', async () => {
	let reread = false;
	const h = harness({ execFileError: Error('taskkill failed'), readFile: async (file, files) => {
		if (file === path.join(folder, 'modelli.json') && reread) return JSON.stringify(mf([model({ contesto: 8192 })]));
		if (!files.has(file)) throw Error('ENOENT'); return files.get(file);
	} });
	const manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	manager.rt.fetch = async url => { reread = true; return url.endsWith('/health') ? answer(200) : null };
	await assert.rejects(manager.acquire(folder, 'a'), /Impossibile chiudere il modello locale a\./);
	assert.equal(h.execs.length, 1);
	assert.equal(h.owned.size, 1);
	assert.equal(h.spawns.length, 1);
});

test('ritorno anticipato con processo superato e chiusura fallita: un solo taskkill', async () => {
	let reachedProbe, releaseProbe;
	const reached = new Promise(resolve => reachedProbe = resolve), gate = new Promise(resolve => releaseProbe = resolve);
	let probing = false;
	const h = harness({ execFileError: Error('taskkill failed') });
	const manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	manager.rt.fetch = async url => {
		if (probing && !url.endsWith('/health')) { probing = false; reachedProbe(); await gate; return null }
		return url.endsWith('/health') ? answer(200) : null;
	};
	probing = true;
	const pending = manager.acquire(folder, 'a');
	await reached;
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	await manager.listChatModels(folder);
	releaseProbe();
	await assert.rejects(pending, /Impossibile chiudere il modello locale a\./);
	assert.equal(h.execs.length, 1);
	assert.equal(h.owned.size, 1);
	assert.equal(h.spawns.length, 1);
});

test('processo segnato superato chiuso quando il ricontrollo dopo health non si legge e l\'ultimo prestito è già rilasciato', async () => {
	const manifestFile = path.join(folder, 'modelli.json');
	const h = harness(), manager = h.manager({ ...fastRuntime });
	const first = await manager.acquire(folder, 'a');
	// seconda richiesta: ricontrollo con manifesto diverso e Stop, il processo resta segnato superato (first è attivo)
	let changed = false;
	const second = new AbortController();
	manager.rt.readFile = async file => {
		if (changed && file === manifestFile) { second.abort(); return JSON.stringify(mf([model({ contesto: 8192 })])) }
		return h.files.get(file);
	};
	manager.rt.fetch = async url => { changed = true; return url.endsWith('/health') ? answer(200) : null };
	await assert.rejects(manager.acquire(folder, 'a', { signal: second.signal }), error => error.name === 'AbortError');
	assert.equal(h.execs.length, 0);
	// Lo Stop ora precede la validazione del manifesto: predisponiamo il processo superato da verificare.
	h.owned.get(8192).superseded = true;
	// terza richiesta: durante il ricontrollo first viene rilasciato, poi il manifesto non si legge più
	let reads = 0;
	manager.rt.readFile = async file => {
		if (file !== manifestFile) return h.files.get(file);
		if (++reads === 1) return h.files.get(file);
		if (reads === 2) first.release();
		return '{';
	};
	manager.rt.fetch = async url => url.endsWith('/health') ? answer(200) : null;
	await assert.rejects(manager.acquire(folder, 'a'), /Impossibile leggere il manifesto dei modelli locali:/);
	assert.deepEqual(h.execs.map(item => item.args), [['/PID', '500', '/T', '/F']]);
	assert.equal(h.owned.size, 0);
	assert.equal(h.spawns.length, 1);
});


test('manifesto: solo i rilevamenti evitano letture sovrapposte, acquire indipendente e rifiuti tardivi gestiti', async () => {
	let reads = 0, rejectRead;
	const blocked = new Promise((_, reject) => rejectRead = reject);
	const h = harness({ readFile: () => { reads++; return blocked } });
	const manager = h.manager({ ioTimeout: 5 });
	const timeout = error => error.name === 'TimeoutError' && error.message.includes(path.join(folder, 'modelli.json'));
	await Promise.all([
		assert.rejects(manager.listChatModels(folder), timeout),
		assert.rejects(manager.listChatModels(folder), timeout),
		assert.rejects(manager.acquire(folder, 'a'), timeout),
	]);
	assert.equal(reads, 2);
	const afterTimeout = manager.rt.now();
	await assert.rejects(manager.listChatModels(folder), timeout);
	// Ogni chiamata attende la propria scadenza sulla stessa lettura pendente.
	assert.equal(manager.rt.now(), afterTimeout + 5);
	assert.equal(reads, 2);
	await assert.rejects(manager.acquire(folder, 'a'), timeout);
	assert.equal(reads, 3);
	rejectRead(Error('errore tardivo'));
	await new Promise(resolve => setImmediate(resolve));
	manager.rt.readFile = async file => { reads++; return h.files.get(file) };
	assert.equal((await manager.listChatModels(folder)).models[0].nome, 'a');
	assert.equal(reads, 4);
	h.files.set(path.join(folder, 'modelli.json'), JSON.stringify(mf([model({ contesto: 8192 })])));
	assert.equal((await manager.listChatModels(folder)).models[0].contesto, 8192);
	assert.equal(reads, 5);
});

for (const target of ['modelli/a.gguf', 'motore/llama-server.exe']) {
	test(`access bloccato su ${target}: timeout distinguibile, deduplica e lock liberato`, async () => {
		let calls = 0;
		const h = harness({ access: async (file, files) => {
			if (file === path.join(folder, target)) { calls++; return new Promise(() => {}) }
			if (!files.has(file)) throw Error('ENOENT');
		} });
		const manager = h.manager({ ioTimeout: 5 });
		const timeout = error => error.name === 'TimeoutError' && error.message.includes(path.join(folder, target));
		const first = manager.acquire(folder, 'a'), second = manager.acquire(folder, 'a');
		await Promise.all([assert.rejects(first, timeout), assert.rejects(second, timeout)]);
		assert.equal(calls, 1);
		assert.equal(h.spawns.length, 0);
	});
}

for (const operation of ['mkdir', 'open']) {
	test(`${operation} bloccato: avvio senza registro e chiusura dell'handle tardivo`, async () => {
		let release, closed = 0;
		const blocked = new Promise(resolve => release = resolve);
		const h = harness(), manager = h.manager({ ...fastRuntime, logTimeout: 5, [operation]: () => blocked });
		const lease = await manager.acquire(folder, 'a');
		assert.equal(h.spawns[0].options.stdio, 'ignore');
		release(operation === 'open' ? { fd: 2, close: async () => { closed++ } } : undefined);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(closed, operation === 'open' ? 1 : 0);
		assert.equal(h.opens.length, 0);
		lease.release();
	});
}

test('registro bloccato dopo uscita: errore senza output entro logTimeout', async () => {
	const h = harness(), manager = h.manager({ logTimeout: 5, readFile: async file => file.endsWith('.log') ? new Promise(() => {}) : h.files.get(file) });
	const spawn = manager.rt.spawn;
	manager.rt.spawn = (...args) => { const child = spawn(...args); child.exitCode = 1; return child };
	await assert.rejects(manager.acquire(folder, 'a'), /Nessuna riga nel registro/);
	assert.equal(manager.rt.now(), 5);
});

for (const operation of ['manifesto', 'modello', 'registro']) {
	test(`Stop durante I/O bloccato: ${operation}`, async () => {
		let reached;
		const started = new Promise(resolve => reached = resolve), blocked = () => { reached(); return new Promise(() => {}) };
		const h = harness(), controller = new AbortController();
		const manager = h.manager({ ioTimeout: 20, logTimeout: 20,
			...(operation === 'manifesto' ? { readFile: blocked } : operation === 'modello'
				? { access: async file => file.endsWith('.gguf') ? blocked() : undefined } : { open: blocked }),
		});
		const pending = manager.acquire(folder, 'a', { signal: controller.signal });
		await started;
		const rejected = assert.rejects(pending, error => error.name === 'AbortError');
		controller.abort();
		await rejected;
		assert.equal(manager.rt.now(), 0);
		assert.equal(h.spawns.length, 0);
	});
}

test('cartella configurata bloccata: errore non risponde in cache breve senza accessi alle unità', async () => {
	const h = harness({ access: () => new Promise(() => {}) });
	const manager = h.manager({ configuredTimeout: 5, missDuration: 10 });
	await assert.rejects(manager.listChatModels(folder), error => error.name === 'TimeoutError' && /non risponde/.test(error.message));
	const afterTimeout = manager.rt.now();
	await assert.rejects(manager.listChatModels(folder), /non risponde/);
	assert.equal(manager.rt.now(), afterTimeout);
	assert.deepEqual(h.accesses, [path.join(folder, 'modelli.json')]);
	h.setClock(afterTimeout + 11);
	await assert.rejects(manager.listChatModels(folder), /non risponde/);
	assert.equal(manager.rt.now(), afterTimeout + 16);
	assert.equal(h.accesses.length, 1);
});

test('forgetFolder: la ricerca dopo guarda di nuovo il disco, anche per la ricerca automatica sulle unità', async () => {
	const h = harness(), manager = h.manager({ missDuration: 10, cacheDuration: 1000 });
	const other = path.resolve('cartella-creata-dopo');
	assert.equal(await manager.folderOf(other), null);
	h.files.set(path.join(other, 'modelli.json'), JSON.stringify(mf()));
	// l'esito «assente» vale ancora: senza forgetFolder la cartella appena creata non si vede
	assert.equal(await manager.folderOf(other), null);
	// stessa chiave anche con virgolette e spazi ("Copia come percorso")
	manager.forgetFolder(`  "${other}" `);
	assert.equal(await manager.folderOf(other), other);
	// ricerca automatica: si dimentica anche l'esito della scansione delle unità
	assert.equal(await manager.folderOf(''), null);
	h.files.set('C:\\Vox\\ia-locali\\modelli.json', JSON.stringify(mf()));
	assert.equal(await manager.folderOf(''), null);
	// dimenticare un'altra cartella non tocca la scansione delle unità: passato l'esito breve di «assente», vale ancora
	// quella (lunga) di prima
	manager.forgetFolder(other);
	h.setClock(20);
	assert.equal(await manager.folderOf(''), null);
	manager.forgetFolder('');
	assert.equal(await manager.folderOf(''), 'C:\\Vox\\ia-locali');
});

test('forgetFolder con un accesso ancora appeso (disco bloccato): nessuna richiesta in più al disco, si aspetta quella', async () => {
	const h = harness({ access: () => new Promise(() => {}) });
	const manager = h.manager({ configuredTimeout: 5, missDuration: 1000 });
	await assert.rejects(manager.folderOf(folder), error => error.name === 'TimeoutError');
	manager.forgetFolder(folder);
	await assert.rejects(manager.folderOf(folder), error => error.name === 'TimeoutError');
	assert.deepEqual(h.accesses, [path.join(folder, 'modelli.json')]);
});

test('ricerca unità con quattro accessi simultanei e precedenza alfabetica', async () => {
	let active = 0, maximum = 0, releaseC;
	const gateC = new Promise(resolve => releaseC = resolve);
	const h = harness(), manager = h.manager({ candidateTimeout: 30, access: async file => {
		if (!/^[C-Z]:\\Vox\\ia-locali\\modelli\.json$/.test(file)) throw Error('ENOENT');
		active++; maximum = Math.max(maximum, active);
		try {
			await Promise.resolve();
			if (file.startsWith('C:')) await gateC;
			if (file.startsWith('D:')) releaseC();
			if (!/^[CD]:/.test(file)) throw Error('ENOENT');
		} finally { active-- }
	} });
	assert.equal(await manager.folderOf(''), 'C:\\Vox\\ia-locali');
	assert.equal(maximum, 4);
	assert.equal(active, 0);
});

test('unità bloccate: ogni scansione avvia al massimo quattro nuovi accessi fs', async () => {
	let calls = 0;
	const h = harness(), manager = h.manager({ candidateTimeout: 3, cacheDuration: 0, missDuration: 0, access: async file => {
		if (!/^[C-Z]:\\Vox\\ia-locali\\modelli\.json$/.test(file)) throw Error('ENOENT');
		calls++;
		return new Promise(() => {});
	} });
	assert.equal(await manager.folderOf(''), null);
	assert.equal(calls, 4);
	assert.equal(await manager.folderOf(''), null);
	// La scansione successiva salta i quattro accessi pendenti e prova le unità seguenti.
	assert.equal(calls, 8);
});

test('cartella locale valida salta completamente le unità', async () => {
	const local = path.join(folder, 'ia-locali');
	const h = harness({ access: async file => { assert.ok(!/^[C-Z]:\\Vox\\ia-locali\\/.test(file)); if (file !== path.join(local, 'modelli.json')) throw Error('ENOENT') } });
	assert.equal(await h.manager().folderOf(''), local);
});

test('timeout nel ricontrollo: un solo ioTimeout e nessun nuovo tentativo', async () => {
	let reads = 0;
	const h = harness({ readFile: async (file, files) => ++reads === 1 ? files.get(file) : new Promise(() => {}) });
	const manager = h.manager({ ioTimeout: 5 });
	await assert.rejects(manager.acquire(folder, 'a'), error => error.name === 'TimeoutError');
	assert.equal(reads, 2);
	assert.equal(manager.rt.now(), 5);
	assert.equal(h.spawns.length, 0);
});


test("timeout dopo health chiude il processo segnato superato dopo l'ultimo prestito", async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime, ioTimeout: 5 });
	const first = await manager.acquire(folder, 'a');
	h.owned.get(8192).superseded = true;
	let reads = 0;
	manager.rt.readFile = async file => {
		if (++reads === 1) return h.files.get(file);
		first.release();
		return new Promise(() => {});
	};
	await assert.rejects(manager.acquire(folder, 'a'), error => error.name === 'TimeoutError');
	assert.equal(reads, 2);
	assert.equal(manager.rt.now(), 5);
	assert.equal(h.execs.length, 1);
	assert.equal(h.owned.size, 0);
});

for (const operation of ['listChatModels', 'acquire']) {
	test(`access gguf appeso poi risolto: ${operation} recupera dopo il timeout`, async () => {
		let releaseAccess, calls = 0;
		const blocked = new Promise(resolve => releaseAccess = resolve);
		const h = harness({ access: async (file, files) => {
			if (file.endsWith('.gguf') && ++calls === 1) await blocked;
			if (!files.has(file)) throw Error('ENOENT');
		} });
		const manager = h.manager({ ...fastRuntime, ioTimeout: 5 });
		// un .gguf irraggiungibile non blocca l'elenco ma resta fra i mancanti con la causa vera (il timeout sul
		// file); acquire invece rifiuta con lo stesso timeout
		if (operation === 'listChatModels') {
			const first = await manager.listChatModels(folder);
			assert.deepEqual(first.models, []);
			assert.equal(first.missing.length, 1);
			assert.equal(first.missing[0].nome, 'a');
			assert.equal(first.missing[0].file, path.join(folder, 'modelli', 'a.gguf'));
			assert.match(first.missing[0].error, /Tempo scaduto/);
			assert.ok(first.missing[0].error.includes('a.gguf'));
		} else {
			await assert.rejects(manager.acquire(folder, 'a'), error => error.name === 'TimeoutError' && error.message.includes('a.gguf'));
		}
		assert.equal(calls, 1);
		releaseAccess();
		await new Promise(resolve => setImmediate(resolve));
		const result = await manager[operation](folder, 'a');
		assert.equal(calls, 2);
		if (operation === 'acquire') result.release();
		else assert.equal(result.models[0].nome, 'a');
	});
}

test('scansione incompleta: le unità si ricontrollano dopo missDuration', async () => {
	let releaseAccess;
	const blocked = new Promise(resolve => releaseAccess = resolve);
	let stuck = true;
	const h = harness({ access: async file => {
		if (/^[C-Z]:\\Vox\\ia-locali\\/.test(file) && stuck) await blocked;
		throw Error('ENOENT');
	} });
	const manager = h.manager({ candidateTimeout: 3, cacheDuration: 60, missDuration: 5 });
	assert.equal(await manager.folderOf(''), null);
	assert.equal(h.accesses.filter(file => /^[C-Z]:\\Vox\\ia-locali\\/.test(file)).length, 4);
	const afterTimeout = manager.rt.now();
	stuck = false; releaseAccess();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(await manager.folderOf(''), null);
	assert.equal(h.accesses.filter(file => /^[C-Z]:\\Vox\\ia-locali\\/.test(file)).length, 4);
	h.setClock(afterTimeout + 6);
	assert.equal(await manager.folderOf(''), null);
	assert.equal(h.accesses.filter(file => /^[C-Z]:\\Vox\\ia-locali\\/.test(file)).length, 28);
});


test('due rilevamenti concorrenti condividono una lettura lenta ma sana', async () => {
	let reads = 0, releaseRead, reachedRead;
	const gate = new Promise(resolve => releaseRead = resolve), reached = new Promise(resolve => reachedRead = resolve);
	const h = harness({ readFile: async (file, files) => { reads++; reachedRead(); await gate; return files.get(file) } });
	const manager = h.manager({ ioTimeout: 1000 });
	const first = manager.listChatModels(folder);
	await reached;
	const second = manager.listChatModels(folder);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(reads, 1);
	releaseRead();
	const results = await Promise.all([first, second]);
	assert.deepEqual(results[0].models, [{ nome: 'a', descrizione: '', contesto: 4096 }]);
	assert.deepEqual(results[1], results[0]);
	assert.equal(reads, 1);
});

for (const ready of [false, true]) {
	test('Stop interrompe subito il ricontrollo appeso, server pronto: ' + ready, async () => {
		let reads = 0, reachedRead;
		const reached = new Promise(resolve => reachedRead = resolve);
		const h = harness({ readFile: async (file, files) => {
			if (++reads === 2) { reachedRead(); return new Promise(() => {}) }
			return files.get(file);
		} });
		let deadlines = 0;
		const manager = h.manager({ ioTimeout: 500, fetch: async () => ready ? { status: 200, json: async () => ({ data: [{ id: 'a' }] }) } : null,
			setTimeout: (callback, ms) => setTimeout(() => { deadlines++; callback() }, ms) });
		const controller = new AbortController();
		const pending = manager.acquire(folder, 'a', { signal: controller.signal });
		await reached;
		controller.abort();
		await assert.rejects(pending, error => error.name === 'AbortError');
		assert.equal(deadlines, 0);
		assert.equal(h.spawns.length, 0);
	});
}

test('C-F sempre appese: dopo missDuration la ricerca raggiunge Z', async () => {
	const h = harness();
	const manager = h.manager({ candidateTimeout: 3, missDuration: 5, access: async file => {
		h.accesses.push(file);
		if (/^[C-F]:\\Vox\\ia-locali\\modelli\.json$/.test(file)) return new Promise(() => {});
		if (file === path.join('Z:\\Vox\\ia-locali', 'modelli.json')) return;
		throw Error('ENOENT');
	} });
	assert.equal(await manager.folderOf(''), null);
	const afterTimeout = manager.rt.now();
	assert.equal(await manager.folderOf(''), null);
	h.setClock(afterTimeout + 6);
	assert.equal(await manager.folderOf(''), 'Z:\\Vox\\ia-locali');
	for (const drive of ['C', 'D', 'E', 'F']) assert.equal(h.accesses.filter(file => file === path.join(drive + ':\\Vox\\ia-locali', 'modelli.json')).length, 1);
});

test('manifesto illeggibile espone la causa JSON o il codice fs', async () => {
	const invalid = '{"motore":"motore/llama-server.exe",}';
	let cause;
	try { JSON.parse(invalid) } catch (error) { cause = error.message }
	const h = harness({ readFile: async () => invalid });
	await assert.rejects(h.manager().listChatModels(folder), error => {
		assert.equal(error.message, 'Impossibile leggere il manifesto dei modelli locali: ' + path.join(folder, 'modelli.json') + ' (' + cause + ')');
		return true;
	});
	const denied = harness({ readFile: async () => { throw Object.assign(Error('accesso negato'), { code: 'EACCES' }) } });
	await assert.rejects(denied.manager().listChatModels(folder), /Impossibile leggere il manifesto.*\(EACCES\)$/);
});

test('cartella vuota e nulla trovato: errore "non configurate"; cartella scelta che non esiste: errore vero', async () => {
	const h = harness();
	const auto = h.manager({ execPath: path.join(folder, 'altrove', 'app.exe'), homedir: () => path.join(folder, 'casa'), platform: 'linux' });
	await assert.rejects(auto.listChatModels(''), error => error.name === 'VoxLocalNotConfigured' && /Cartella delle IA locali/i.test(error.message));
	await assert.rejects(auto.listChatModels('   '), error => error.name === 'VoxLocalNotConfigured');
	const configured = h.manager();
	await assert.rejects(configured.listChatModels(path.join(folder, 'nessuna')), error => error.name !== 'VoxLocalNotConfigured' && /Cartella delle IA locali/i.test(error.message));
	// l'avvio di un modello senza cartella resta un errore vero anche con la cartella vuota
	await assert.rejects(auto.acquire('', 'a'), error => error.name !== 'VoxLocalNotConfigured');
});

test('blockStarts: durante la rimozione il modello non si avvia né si riusa; dopo lo sblocco sì', async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	const unblock = manager.blockStarts('a');
	// riuso del processo acceso
	await assert.rejects(manager.acquire(folder, 'a'), /si sta togliendo/);
	assert.equal(await manager.closeForRemoval('a'), true);
	// nuovo avvio
	await assert.rejects(manager.acquire(folder, 'a'), /si sta togliendo/);
	assert.equal(h.spawns.length, 1);
	assert.equal(manager.isRunning('a'), false);
	unblock(); unblock(); // la seconda chiamata non cambia niente
	(await manager.acquire(folder, 'a')).release();
	assert.equal(h.spawns.length, 2);
	// due blocchi insieme: serve toglierli tutti e due
	const first = manager.blockStarts('a'), second = manager.blockStarts('a');
	first();
	await assert.rejects(manager.acquire(folder, 'a'), /si sta togliendo/);
	second();
	(await manager.acquire(folder, 'a')).release();
});

test('blockStarts ferma anche un avvio già partito, prima di lanciare il processo', async () => {
	let unblock;
	const h = harness(), manager = h.manager({ ...fastRuntime, fetch: async url => {
		// la sonda della porta è già passata quando la libreria comincia a togliere il modello
		if (url.endsWith('/models') && !unblock) { unblock = manager.blockStarts('a'); return null }
		return url.endsWith('/health') ? answer(200) : null;
	} });
	await assert.rejects(manager.acquire(folder, 'a'), /si sta togliendo/);
	assert.equal(h.spawns.length, 0);
	unblock();
});

test('closeForRemoval: un processo già chiuso non diventa «in uso» se il tempo scade subito dopo', async () => {
	const h = harness(), manager = h.manager({ ...fastRuntime });
	(await manager.acquire(folder, 'a')).release();
	const controller = new AbortController();
	const execFile = manager.rt.execFile;
	// il tempo scade proprio mentre la chiusura finisce
	manager.rt.execFile = (...args) => { controller.abort(); return execFile(...args) };
	assert.equal(await manager.closeForRemoval('a', controller.signal), true);
	assert.equal(manager.isRunning('a'), false);
});

test('blockStarts arrivato mentre il modello si accende: niente prestito e il processo si chiude', async () => {
	let unblock;
	const h = harness(), manager = h.manager({ ...fastRuntime, fetch: async url => {
		if (url.endsWith('/health')) { unblock ??= manager.blockStarts('a'); return answer(200) }
		return null;
	} });
	await assert.rejects(manager.acquire(folder, 'a'), /si sta togliendo/);
	assert.equal(h.spawns.length, 1);
	assert.equal(manager.isRunning('a'), false, 'il processo appena acceso non resta senza prestito');
	unblock();
});
