import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadI18n } from '../../common/voxI18n.fixture.mjs';

const t = loadI18n('it').t;
const modelSource = await readFile(new URL('../llmMessage/localModels.ts', import.meta.url), 'utf8');
const validatorSource = stripTypeScriptTypes(modelSource.slice(modelSource.indexOf('export function validateLocalModelManifest'), modelSource.indexOf('export function invalidateLocalModelsManifestCache')).replace('export function', 'function'));
const invalidatorSource = stripTypeScriptTypes(modelSource.slice(modelSource.indexOf('export function invalidateLocalModelsManifestCache'), modelSource.indexOf('\nfunction commandOf')).replace('export function', 'function'));
const validate = new Function('t', 'resolve', 'isAbsolute', 'relative', 'within', `${validatorSource}; return validateLocalModelManifest;`)(t, path.resolve, path.isAbsolute, path.relative, (base, file) => {
	const rel = path.relative(base, file);
	return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
});
const source = stripTypeScriptTypes((await readFile(new URL('./localModelManifest.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const folder = path.resolve('local-model-manifest-fixture');
const manifestPath = path.join(folder, 'modelli.json');
const model = (nome, file = `${nome}.gguf`) => ({ nome, descrizione: nome, file, contesto: 4096, porta: 8192, uso: 'chat', opzioni: [] });
const initial = () => ({ motore: 'motore/server.exe', custom: { keep: true }, modelli: [model('a', 'shared.gguf'), { ...model('b', 'shared.gguf'), customModel: 7 }] });

function harness({ raw = initial(), failWrite = false, failRename = false, readFile: customReadFile, readTimeout = 10000, renameDelay = async () => {} } = {}) {
	const files = new Map([[manifestPath, JSON.stringify(raw)], [path.join(folder, 'modelli', 'shared.gguf'), '12345'], [path.join(folder, 'templates', 'chat.jinja'), 'template']]);
	const fs = {
		readFile: async file => { if (customReadFile) return customReadFile(file, files); if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return files.get(file) },
		writeFile: async (file, value, options) => {
			if (options?.flag === 'wx' && files.has(file)) throw Object.assign(Error('esiste'), { code: 'EEXIST' });
			if (failWrite) throw Error('disk full');
			files.set(file, value);
		},
		rename: async (from, to) => { if (failRename) throw Error('rename failed'); files.set(to, files.get(from)); files.delete(from) },
		rm: async file => { files.delete(file) },
		stat: async file => { if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { size: files.get(file).length } },
		access: async file => { if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }) }
	};
	const pendingListReads = new Map();
	const invalidateCache = new Function('pendingListReads', 'join', 'resolve', `${invalidatorSource}; return invalidateLocalModelsManifestCache;`)(pendingListReads, path.join, path.resolve);
	const api = new Function('access', 'readFile', 'rename', 'rm', 'stat', 'writeFile', 'join', 'resolve', 'relative', 'isAbsolute', 'sep', 'isSameLocalModelFile', 't', 'validateLocalModelManifest', 'invalidateLocalModelsManifestCache', source + '; return { listInstalledLocalModels, addLocalModelToManifest, removeLocalModelFromManifest, setLocalModelContextInManifest, runtime };')(
		fs.access, fs.readFile, fs.rename, fs.rm, fs.stat, fs.writeFile, path.join, path.resolve, path.relative, path.isAbsolute, path.sep, (a, b) => a.toLowerCase() === b.toLowerCase(), t, validate, invalidateCache
	);
	api.runtime.readTimeout = readTimeout;
	api.runtime.renameDelay = renameDelay;
	api.runtime.platform = 'win32';
	return { ...api, files, pendingListReads };
}

test('elenco, aggiunta e rimozione preservano i campi sconosciuti e il formato', async () => {
	const h = harness();
	h.pendingListReads.set(manifestPath, Promise.resolve(JSON.stringify(initial())));
	const listed = await h.listInstalledLocalModels(folder, nome => nome === 'a', h);
	assert.deepEqual(listed.map(item => [item.bytes, item.acceso, item.condivisoCon]), [[5, true, ['b']], [5, false, ['a']]]);
	await h.addLocalModelToManifest(folder, { ...model('c'), opzioni: ['--chat-template-file', '{cartella}/templates/chat.jinja'] }, h);
	const written = h.files.get(manifestPath);
	const raw = JSON.parse(written);
	assert.equal(raw.custom.keep, true);
	assert.equal(raw.modelli[1].customModel, 7);
	assert.deepEqual(raw.modelli.map(x => x.nome), ['a', 'b', 'c']);
	assert.equal(raw.modelli[2].opzioni[1], '{cartella}/templates/chat.jinja');
	assert.equal(h.pendingListReads.has(manifestPath), false);
	assert.ok((await h.listInstalledLocalModels(folder, () => false, h)).some(item => item.nome === 'c'));
	assert.match(written, /^\{\n\t"motore"/);
	assert.ok(written.endsWith('\n'));
	assert.deepEqual(await h.removeLocalModelFromManifest(folder, 'a', h), { file: 'shared.gguf', condivisoCon: ['b'] });
	assert.deepEqual(JSON.parse(h.files.get(manifestPath)).modelli.map(x => x.nome), ['b', 'c']);
	assert.equal(h.files.has(path.join(folder, 'modelli', 'shared.gguf')), true);
});

test('le scritture concorrenti sono serializzate e una scrittura fallita lascia intatto l’originale', async () => {
	const h = harness(), original = h.files.get(manifestPath);
	await Promise.all([h.addLocalModelToManifest(folder, model('c'), h), h.addLocalModelToManifest(folder, model('d'), h)]);
	assert.deepEqual(JSON.parse(h.files.get(manifestPath)).modelli.map(x => x.nome), ['a', 'b', 'c', 'd']);
	const failing = harness({ failWrite: true }), before = failing.files.get(manifestPath);
	await assert.rejects(failing.addLocalModelToManifest(folder, model('c'), failing), /disk full/);
	assert.equal(failing.files.get(manifestPath), before);
	// nessun temporaneo rimasto (il nome ora è unico: `modelli.json.<tempo>-<caso>.nuovo`)
	assert.deepEqual([...failing.files.keys()].filter(name => name.endsWith('.nuovo')), []);
	assert.notEqual(original, h.files.get(manifestPath));
});

test('rifiuta manifesti e opzioni non validi, duplicati e file opzione mancanti senza scrivere', async () => {
	for (const entry of [model('a'), model('spazio non ammesso'), { ...model('x'), file: 'sub/model.gguf' }, { ...model('x'), contesto: 128 }, { ...model('x'), porta: 80 }, { ...model('x'), uso: 'sconosciuto' }, { ...model('x'), opzioni: ['--port=9000'] }, { ...model('x'), opzioni: ['-m'] }]) {
		const h = harness(), before = h.files.get(manifestPath);
		await assert.rejects(h.addLocalModelToManifest(folder, entry, h));
		assert.equal(h.files.get(manifestPath), before);
	}
	const missing = harness();
	await assert.rejects(missing.addLocalModelToManifest(folder, { ...model('x'), opzioni: ['--chat-template-file', '{cartella}/templates/missing.jinja'] }, missing), /templates\\missing\.jinja|templates\/missing\.jinja/);
	assert.equal(JSON.parse(missing.files.get(manifestPath)).modelli.length, 2);
	const invalid = harness({ raw: { motore: '../outside.exe', modelli: [] } });
	await assert.rejects(invalid.removeLocalModelFromManifest(folder, 'a', invalid));
	assert.equal(await invalid.removeLocalModelFromManifest(folder, 'absent', invalid).catch(error => error.message), t('Invalid local model manifest field {0} for model {1}.', 'motore', t('[manifest]')));
	const absent = harness();
	await assert.rejects(absent.removeLocalModelFromManifest(folder, 'absent', absent), error => error.message === t('Local model {0} was not found in the manifest.', 'absent'));
	const malformed = harness(); malformed.files.set(manifestPath, '{');
	await assert.rejects(malformed.removeLocalModelFromManifest(folder, 'a', malformed), /Impossibile leggere il manifesto dei modelli locali/);
});

test('la rinomina fallita mantiene l’originale e rimuove il temporaneo', async () => {
	const h = harness({ failRename: true }), before = h.files.get(manifestPath);
	await assert.rejects(h.removeLocalModelFromManifest(folder, 'a', h), /Impossibile aggiornare il manifesto/);
	assert.equal(h.files.get(manifestPath), before);
	assert.deepEqual([...h.files.keys()].filter(name => name.endsWith('.nuovo')), []);
});


test('ritenta rename soltanto per errori Windows temporanei e rende iniettabile l?attesa', async () => {
	let calls = 0, waits = 0;
	const h = harness({ renameDelay: async ms => { assert.equal(ms, 40); waits++ } });
	const rename = h.runtime.rename;
	h.runtime.rename = async (...args) => { if (++calls < 3) throw Object.assign(Error('busy'), { code: 'EPERM' }); return rename(...args) };
	await h.addLocalModelToManifest(folder, model('c'), h);
	assert.equal(calls, 3);
	assert.equal(waits, 2);
});

test('lettura in timeout o fallita libera la fila per la modifica successiva', async () => {
	let reads = 0;
	const h = harness({ readTimeout: 5, readFile: async (file, files) => {
		if (file === manifestPath && ++reads === 1) return new Promise(() => {});
		if (file === manifestPath && reads === 2) throw Object.assign(Error('disk error'), { code: 'EIO' });
		return files.get(file);
	} });
	await assert.rejects(h.addLocalModelToManifest(folder, model('x'), h), /Tempo scaduto durante la lettura/);
	await assert.rejects(h.addLocalModelToManifest(folder, model('x'), h), /Impossibile leggere il manifesto/);
	await h.addLocalModelToManifest(folder, model('x'), h);
	assert.ok(JSON.parse(h.files.get(manifestPath)).modelli.some(item => item.nome === 'x'));
});

test('aggiunge opzioni assenti come elenco vuoto e non salva campi non previsti', async () => {
	const h = harness(), entry = model('c');
	delete entry.opzioni;
	entry.inatteso = true;
	await h.addLocalModelToManifest(folder, entry, h);
	const saved = JSON.parse(h.files.get(manifestPath)).modelli.at(-1);
	assert.deepEqual(saved.opzioni, []);
	assert.equal(Object.hasOwn(saved, 'inatteso'), false);
});

test('controlla tutte le occorrenze di cartella e rifiuta i percorsi esterni', async () => {
	const escaped = harness();
	await assert.rejects(escaped.addLocalModelToManifest(folder, { ...model('c'), opzioni: ['{cartella}/templates/chat.jinja {cartella}/../x'] }, escaped), /fuori dalla sua cartella/);
	const missingSecond = harness();
	await assert.rejects(missingSecond.addLocalModelToManifest(folder, { ...model('c'), opzioni: ['{cartella}/templates/chat.jinja {cartella}/templates/missing.jinja'] }, missingSecond), /File dell/);
	// un'opzione è un argomento a sé: se è tutta un percorso, gli spazi ne fanno parte
	const spaced = harness();
	await assert.rejects(spaced.addLocalModelToManifest(folder, { ...model('c'), opzioni: ['--chat-template-file', '{cartella}/templates/con spazio.jinja'] }, spaced), /con spazio\.jinja/);
	spaced.files.set(path.join(folder, 'templates', 'con spazio.jinja'), 'template');
	await spaced.addLocalModelToManifest(folder, { ...model('c'), opzioni: ['--chat-template-file', '{cartella}/templates/con spazio.jinja'] }, spaced);
	assert.deepEqual(JSON.parse(spaced.files.get(manifestPath)).modelli.at(-1).opzioni, ['--chat-template-file', '{cartella}/templates/con spazio.jinja']);
});

test('un nome che differisce solo per le maiuscole è già nel manifesto (su Windows `avvia/A.log` è `avvia/a.log`)', async () => {
	const h = harness(), before = h.files.get(manifestPath);
	await assert.rejects(h.addLocalModelToManifest(folder, model('A', 'altro-file.gguf'), h));
	assert.equal(h.files.get(manifestPath), before);
});

test('un file dell\'utente che si chiama come il vecchio temporaneo non viene toccato', async () => {
	const h = harness();
	h.files.set(`${manifestPath}.nuovo`, 'appunti dell\'utente');
	await h.addLocalModelToManifest(folder, model('c'), h);
	await h.removeLocalModelFromManifest(folder, 'c', h);
	const failing = harness({ failRename: true });
	failing.files.set(`${manifestPath}.nuovo`, 'appunti dell\'utente');
	await assert.rejects(failing.removeLocalModelFromManifest(folder, 'a', failing));
	for (const run of [h, failing]) {
		assert.equal(run.files.get(`${manifestPath}.nuovo`), 'appunti dell\'utente');
		assert.deepEqual([...run.files.keys()].filter(name => name.endsWith('.nuovo')), [`${manifestPath}.nuovo`]);
	}
});

test('contesto: cambia solo il campo contesto della voce, conserva il resto e rifiuta i valori fuori dai limiti', async () => {
	const h = harness();
	const listed = await h.listInstalledLocalModels(folder, () => false, h);
	assert.deepEqual(listed.map(item => item.contesto), [4096, 4096]);
	assert.deepEqual(await h.setLocalModelContextInManifest(folder, 'b', 65536, h), { prima: 4096 });
	const raw = JSON.parse(h.files.get(manifestPath));
	assert.deepEqual(raw.modelli.map(item => item.contesto), [4096, 65536]);
	assert.equal(raw.modelli[1].customModel, 7);
	assert.equal(raw.custom.keep, true);
	assert.match(h.files.get(manifestPath), /^\{\n\t"motore"/);
	// stesso valore: il file non si riscrive
	const same = harness(), before = same.files.get(manifestPath);
	assert.deepEqual(await same.setLocalModelContextInManifest(folder, 'a', 4096, same), { prima: 4096 });
	assert.equal(same.files.get(manifestPath), before);
	for (const contesto of [511, 1048577, 1.5, '8192']) {
		const bad = harness(), original = bad.files.get(manifestPath);
		const invalid = t('Invalid local model manifest field {0} for model {1}.', 'contesto', 'a');
		await assert.rejects(bad.setLocalModelContextInManifest(folder, 'a', contesto, bad), error => error.message === invalid);
		assert.equal(bad.files.get(manifestPath), original);
	}
	const absent = harness();
	await assert.rejects(absent.setLocalModelContextInManifest(folder, 'nessuno', 8192, absent), error => error.message === t('Local model {0} was not found in the manifest.', 'nessuno'));
	const failing = harness({ failRename: true }), original = failing.files.get(manifestPath);
	await assert.rejects(failing.setLocalModelContextInManifest(folder, 'a', 8192, failing), /Impossibile aggiornare il manifesto/);
	assert.equal(failing.files.get(manifestPath), original);
	assert.deepEqual([...failing.files.keys()].filter(name => name.endsWith('.nuovo')), []);
});

test('contesto e aggiunta insieme sono serializzati: nessuna delle due scritture si perde', async () => {
	const h = harness();
	await Promise.all([h.setLocalModelContextInManifest(folder, 'a', 8192, h), h.addLocalModelToManifest(folder, model('c'), h)]);
	const raw = JSON.parse(h.files.get(manifestPath));
	assert.deepEqual(raw.modelli.map(item => [item.nome, item.contesto]), [['a', 8192], ['b', 4096], ['c', 4096]]);
});
