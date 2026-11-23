// Libreria dei modelli locali, lato processo principale: scarico, aggiunta a `modelli.json` e rimozione, con dipendenze finte.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadI18n } from '../../common/voxI18n.fixture.mjs';

const t = loadI18n('it').t;
const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const types = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(await read('../../common/localModelLibraryTypes.ts'))));
const coreSource = await read('./localModelLibraryCore.ts');
const source = stripTypeScriptTypes(coreSource.replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const names = ['defaultPortOfLocalModelUse', 'isAllowedLocalModelDownloadURL', 'isDownloadableLocalModelFileName', 'isSameLocalModelFile', 'LOCAL_MODEL_MAX_CONTEXT', 'LOCAL_MODEL_MIN_CONTEXT', 'LOCAL_MODEL_NAME_PATTERN'];
const api = new Function('join', 't', ...names, source + '; return { createLocalModelLibrary, normalizeLocalModelDownloadURL };')(path.join, t, ...names.map(name => types[name]));

const folder = path.resolve('ia-locali-di-prova');
const fileOf = name => path.join(folder, 'modelli', name);
const catalog = [
	{ id: 'piccolo', nome: 'piccolo', descrizione: 'Modello piccolo', uso: 'embedding', contesto: 2048, repo: 'utente/piccolo-GGUF', revisione: 'abc', file: 'piccolo.gguf', bytes: 1000, sha256: 'a'.repeat(64), opzioni: [] },
	{ id: 'conmodello', nome: 'conmodello', descrizione: 'Con file di opzione', uso: 'chat', contesto: 4096, repo: 'utente/con-GGUF', revisione: 'def', file: 'con.gguf', bytes: 2000, sha256: null, opzioni: ['--chat-template-file', '{cartella}/avvia/modello con spazio.jinja'] },
];
const abortError = () => Object.assign(new Error('annullato'), { name: 'AbortError' });

function harness(options = {}) {
	const manifest = options.manifest ?? [{ nome: 'vecchio', descrizione: 'Vecchio', uso: 'chat', file: 'vecchio.gguf', contesto: 4096, porta: 8192, opzioni: [] }];
	const files = new Map(options.files ?? [[fileOf('vecchio.gguf'), 500]]);
	const log = [], folderLog = [], states = [], running = new Set(options.running ?? []), blocked = new Set(), blockLog = [];
	let clock = 0, pending = null;
	const deps = {
		findFolder: async cartella => { folderLog.push(`cerca ${cartella}`); if (cartella === 'guasta') throw new Error('La cartella delle IA locali non risponde: X:\\ia'); return cartella === 'assente' ? null : folder },
		forgetFolder: cartella => { folderLog.push(`dimentica ${cartella}`) },
		isRunning: nome => running.has(nome),
		closeForRemoval: async nome => { log.push(`chiudi ${nome}`); if (options.closeFails) return false; running.delete(nome); return true },
		// registro a parte, così i test che confrontano `log` per intero restano quelli di prima
		blockStarts: nome => { blockLog.push(`blocca ${nome}`); blocked.add(nome); return () => { blockLog.push(`sblocca ${nome}`); blocked.delete(nome) } },
		listInstalled: async () => {
			if (options.manifestError) throw new Error(options.manifestError);
			return manifest.map(model => ({ nome: model.nome, descrizione: model.descrizione, uso: model.uso, file: model.file, bytes: files.get(fileOf(model.file)) ?? null, acceso: running.has(model.nome), condivisoCon: manifest.filter(other => other.file.toLowerCase() === model.file.toLowerCase() && other.nome !== model.nome).map(other => other.nome) }));
		},
		addToManifest: async (dir, entry) => { log.push(`aggiungi ${entry.nome}`); if (options.onAdd) await options.onAdd(); if (options.addWritesThenFails) { manifest.push(entry); throw new Error('scrittura lenta') } if (options.addFails) throw new Error('disco pieno'); manifest.push(entry) },
		removeFromManifest: async (dir, nome) => { log.push(`togli ${nome}`); await settle(); manifest.splice(manifest.findIndex(model => model.nome === nome), 1) },
		setContextInManifest: async (dir, nome, contesto) => {
			log.push(`contesto ${nome} ${contesto}`); await settle();
			if (options.contextFails) throw new Error(options.contextFails);
			const entry = manifest.find(model => model.nome === nome), prima = entry.contesto;
			entry.contesto = contesto;
			return { prima };
		},
		download: p => new Promise((resolve, reject) => {
			log.push(`scarica ${p.url}`);
			pending = {
				p,
				finish: () => { files.set(p.destination, p.expectedBytes ?? 123); resolve({ bytes: 123, sha256: '' }) },
				fail: error => reject(error),
			};
			p.signal.addEventListener('abort', () => { files.set(p.destination + '.parziale', 10); reject(abortError()) });
		}),
		verifyExisting: async p => { log.push(`controlla ${path.basename(p.file)}`); p.onProgress({ fase: 'controllo', ricevuti: p.expectedBytes ?? 0, totale: p.expectedBytes }); if (options.verifyFails) throw new Error('non è il modello atteso') },
		removePartial: async destination => { log.push('togli parziale'); files.delete(destination + '.parziale') },
		restorePartial: async destination => { log.push('rimetti parziale'); if (files.has(destination + '.parziale')) return; files.set(destination + '.parziale', files.get(destination)); files.delete(destination) },
		freeBytes: async () => 5000,
		sizeOf: async file => files.get(file) ?? null,
		bundledFiles: options.bundledFiles ?? {},
		createFileIfMissing: async (file, content) => { log.push(`crea ${path.relative(folder, file).replace(/\\/g, '/')}`); if (options.createFails) throw new Error(options.createFails); if (!options.createNothing && !files.has(file)) files.set(file, content.length) },
		trash: async file => { log.push(`cestino ${path.basename(file)}`); await settle(); if (options.noTrash) throw new Error('nessun cestino'); if (options.onTrash) options.onTrash(running); if (running.size && options.busy) throw new Error('EBUSY'); files.delete(file) },
		unlink: async file => { log.push(`cancella ${path.basename(file)}`); if (options.unlinkFails) throw new Error('EBUSY'); files.delete(file) },
		now: () => clock,
		catalog,
		urlOfCatalogEntry: entry => `https://huggingface.co/${entry.repo}/resolve/${entry.revisione}/${entry.file}`,
		emit: state => states.push(state),
	};
	return { library: api.createLocalModelLibrary(deps), deps, manifest, files, log, folderLog, blockLog, states, running, blocked, tick: ms => { clock += ms }, get pending() { return pending } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('indirizzo incollato: accetta ?download=true e la pagina /blob/, rifiuta il resto', () => {
	const ok = api.normalizeLocalModelDownloadURL;
	assert.deepEqual(ok('https://huggingface.co/utente/repo/resolve/main/modello.Q4.gguf?download=true'), { url: 'https://huggingface.co/utente/repo/resolve/main/modello.Q4.gguf', file: 'modello.Q4.gguf' });
	assert.deepEqual(ok(' https://huggingface.co/utente/repo/blob/main/cartella/Modello.GGUF#x '), { url: 'https://huggingface.co/utente/repo/resolve/main/cartella/Modello.GGUF', file: 'Modello.GGUF' });
	for (const bad of [
		'http://huggingface.co/u/r/resolve/main/m.gguf', 'https://esempio.it/u/r/resolve/main/m.gguf', 'https://cdn.hf.co/u/r/resolve/main/m.gguf',
		'https://utente:segreto@huggingface.co/u/r/resolve/main/m.gguf', 'https://huggingface.co:444/u/r/resolve/main/m.gguf',
		'https://huggingface.co/u/r/resolve/main/m.bin#.gguf', 'https://huggingface.co/u/r/resolve/main/m.bin?x=.gguf', 'https://huggingface.co/u/r/tree/main/m.gguf',
		'https://huggingface.co/u/r/resolve/main/a%2Fb.gguf', 'https://huggingface.co/u/r/resolve/main/a%5Cb.gguf', 'https://huggingface.co/u/r/resolve/main/%E0%A4%A.gguf',
		'https://huggingface.co/m.gguf', '', null,
	]) assert.throws(() => ok(bad), undefined, String(bad));
});

test('scarico dall\'elenco: la voce entra in modelli.json solo dopo lo scarico riuscito, con la porta del suo uso', async () => {
	const h = harness();
	await h.library.getState('');
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	assert.equal(h.pending.p.url, 'https://huggingface.co/utente/piccolo-GGUF/resolve/abc/piccolo.gguf');
	assert.equal(h.pending.p.destination, fileOf('piccolo.gguf'));
	assert.equal(h.pending.p.expectedBytes, 1000);
	assert.equal(h.pending.p.expectedSha256, 'a'.repeat(64));
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'scarico', nome: 'piccolo', file: 'piccolo.gguf', ricevuti: 0, totale: 1000, bytesAlSecondo: 0 });
	assert.equal(h.manifest.length, 1);
	// un secondo scarico non parte
	await assert.rejects(h.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), new RegExp(t('Another model download is already in progress.')));
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.at(-1), { nome: 'piccolo', descrizione: 'Modello piccolo', file: 'piccolo.gguf', contesto: 2048, porta: 8194, uso: 'embedding', opzioni: [] });
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'piccolo' });
	assert.deepEqual(h.states.at(-1).installati.map(model => model.nome), ['vecchio', 'piccolo']);
	assert.equal((await h.library.getState('')).liberi, 5000);
});

test('avanzamento: non più di un evento ogni 250 ms, sempre al cambio di fase, con la velocità', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	const before = h.states.length, progress = h.pending.p.onProgress;
	progress({ fase: 'scarico', ricevuti: 0, totale: 1000 });
	h.tick(100); progress({ fase: 'scarico', ricevuti: 100, totale: 1000 });
	h.tick(100); progress({ fase: 'scarico', ricevuti: 200, totale: 1000 });
	h.tick(100); progress({ fase: 'scarico', ricevuti: 300, totale: 1000 });
	assert.equal(h.states.length, before + 2);
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'scarico', nome: 'piccolo', file: 'piccolo.gguf', ricevuti: 300, totale: 1000, bytesAlSecondo: 1000 });
	h.tick(1); progress({ fase: 'controllo', ricevuti: 0, totale: 1000 });
	assert.equal(h.states.at(-1).scarico.stato, 'controllo');
	h.pending.finish();
	await settle();
});

test('errore dello scarico: stato di errore col messaggio, niente in modelli.json, e poi si può riprovare', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.fail(new Error('Scarico del modello non riuscito: errore di rete.'));
	await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'errore', nome: 'piccolo', messaggio: 'Scarico del modello non riuscito: errore di rete.' });
	assert.equal(h.manifest.length, 1);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle();
	assert.equal(h.manifest.length, 2);
});

test('pausa e annullamento: la pausa tiene il file parziale, l\'annullamento lo toglie', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await h.library.cancelDownload(true);
	// `parziale: true`: l'interfaccia può dire «riprendi»; dopo un annullo vero è `false`
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'annullato', nome: 'piccolo', parziale: true });
	assert.equal(h.files.has(fileOf('piccolo.gguf') + '.parziale'), true);
	assert.equal(h.log.includes('togli parziale'), false);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await h.library.cancelDownload(false);
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'annullato', nome: 'piccolo', parziale: false });
	assert.equal(h.files.has(fileOf('piccolo.gguf') + '.parziale'), false);
	assert.equal(h.manifest.length, 1);
	// senza scarico in corso non succede niente
	await h.library.cancelDownload(false);
});

test('richieste non valide: rifiutate prima di toccare la rete', async () => {
	const h = harness();
	const address = { tipo: 'indirizzo', url: 'https://huggingface.co/u/r/resolve/main/nuovo.gguf', nome: 'nuovo', uso: 'chat', contesto: 4096, descrizione: 'x' };
	for (const request of [
		{ tipo: 'catalogo', id: 'sconosciuto' }, null, { tipo: 'altro' },
		{ ...address, url: 'https://esempio.it/u/r/resolve/main/nuovo.gguf' }, { ...address, nome: 'nome con spazi' }, { ...address, nome: '../x' },
		{ ...address, uso: 'altro' }, { ...address, contesto: 100 }, { ...address, contesto: 4096.5 }, { ...address, contesto: '4096' },
		{ ...address, nome: 'vecchio' },
	]) await assert.rejects(h.library.startDownload('', request), undefined, JSON.stringify(request));
	await assert.rejects(h.library.startDownload('assente', address));
	assert.equal(h.log.some(line => line.startsWith('scarica')), false);
	// quella buona parte, con la descrizione ripulita e senza controlli di dimensione
	await h.library.startDownload('', { ...address, url: address.url.replace('/resolve/', '/blob/') + '?download=true', descrizione: '  due\n righe  ' });
	assert.equal(h.pending.p.url, address.url);
	assert.equal(h.pending.p.expectedBytes, null);
	assert.equal(h.pending.p.expectedSha256, null);
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.at(-1), { nome: 'nuovo', descrizione: 'due righe', file: 'nuovo.gguf', contesto: 4096, porta: 8192, uso: 'chat', opzioni: [] });
});

test('file delle opzioni: se manca lo scarico non parte; se c\'è, le opzioni arrivano in modelli.json', async () => {
	const h = harness();
	// l'opzione è un argomento a sé: il percorso comprende gli spazi
	await assert.rejects(h.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), /modello con spazio\.jinja/);
	assert.equal(h.log.some(line => line.startsWith('scarica')), false);
	h.files.set(path.join(folder, 'avvia', 'modello.jinja'), 1);
	await assert.rejects(h.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), /modello con spazio\.jinja/);
	h.files.set(path.join(folder, 'avvia', 'modello con spazio.jinja'), 1);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' });
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.at(-1).opzioni, ['--chat-template-file', '{cartella}/avvia/modello con spazio.jinja']);
});

test('cartella sparita durante uno scarico: lo stato lo dice ancora e pausa e annullo funzionano', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	const state = await h.library.getState('assente');
	assert.equal(state.cartella, null);
	assert.equal(state.scarico.stato, 'scarico');
	h.tick(300); h.pending.p.onProgress({ fase: 'scarico', ricevuti: 400, totale: 1000 });
	assert.deepEqual([h.states.at(-1).cartella, h.states.at(-1).scarico.ricevuti], [null, 400]);
	await h.library.cancelDownload(true);
	assert.deepEqual(h.states.at(-1), { cartella: null, liberi: null, installati: [], scarico: { stato: 'annullato', nome: 'piccolo', parziale: true }, errore: null });
});

test('cartella che dà errore: lo stato arriva con l\'errore e a fine scarico non resta fermo sull\'avanzamento', async () => {
	const h = harness();
	const broken = await h.library.getState('guasta');
	assert.deepEqual([broken.cartella, broken.errore, broken.scarico.stato], [null, 'La cartella delle IA locali non risponde: X:\\ia', 'fermo']);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	// la finestra ora chiede una cartella che non risponde: l'ultimo stato emesso dice comunque come è finito lo scarico
	await h.library.getState('guasta');
	h.pending.finish();
	await settle();
	assert.deepEqual([h.states.at(-1).cartella, h.states.at(-1).scarico], [null, { stato: 'finito', nome: 'piccolo' }]);
	assert.equal(h.manifest.at(-1).nome, 'piccolo');
});

test('«Controlla di nuovo»: solo quella lettura dimentica l\'esito di prima della cartella, e prima di cercarla', async () => {
	const h = harness();
	await h.library.getState('assente');
	await h.library.getState('assente', false);
	// dalla finestra può arrivare qualunque valore: conta solo true
	await h.library.getState('assente', 'sì');
	assert.deepEqual(h.folderLog, ['cerca assente', 'cerca assente', 'cerca assente']);
	h.folderLog.length = 0;
	const state = await h.library.getState('', true);
	assert.deepEqual(h.folderLog, ['dimentica ', 'cerca ']);
	assert.equal(state.cartella, folder);
	// anche con il ricontrollo un errore della cartella arriva nello stato, con la sua causa
	h.folderLog.length = 0;
	const broken = await h.library.getState('guasta', true);
	assert.deepEqual(h.folderLog, ['dimentica guasta', 'cerca guasta']);
	assert.deepEqual([broken.cartella, broken.errore], [null, 'La cartella delle IA locali non risponde: X:\\ia']);
});

test('voce dell\'elenco senza file: si riscarica solo il file, la voce resta quella dell\'utente', async () => {
	const voce = { nome: 'Piccolo', descrizione: 'mia', uso: 'embedding', file: 'PICCOLO.gguf', contesto: 8192, porta: 8194, opzioni: ['--embedding'] };
	const h = harness({ manifest: [voce], files: [] });
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	// il file prende il nome che la voce già usa, e si controlla come uno scarico dall'elenco
	assert.equal(h.pending.p.destination, fileOf('PICCOLO.gguf'));
	assert.equal(h.pending.p.expectedSha256, 'a'.repeat(64));
	assert.equal(h.states.at(-1).scarico.nome, 'Piccolo');
	h.pending.finish();
	await settle();
	assert.equal(h.log.some(line => line.startsWith('aggiungi')), false);
	assert.deepEqual(h.manifest, [voce]);
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'Piccolo' });
	assert.equal(h.states.at(-1).installati[0].bytes, 1000);

	// con il file presente, con un file diverso o da un indirizzo incollato il nome resta già usato
	for (const [manifest, files, request] of [
		[[voce], [[fileOf('PICCOLO.gguf'), 1000]], { tipo: 'catalogo', id: 'piccolo' }],
		[[{ ...voce, file: 'altro.gguf' }], [], { tipo: 'catalogo', id: 'piccolo' }],
		[[voce], [], { tipo: 'indirizzo', url: 'https://huggingface.co/u/r/resolve/main/PICCOLO.gguf', nome: 'Piccolo', uso: 'embedding', contesto: 2048, descrizione: '' }],
	]) {
		const other = harness({ manifest, files });
		await assert.rejects(other.library.startDownload('', request), new RegExp(t('A model named {0} is already installed.', request.tipo === 'catalogo' ? 'piccolo' : 'Piccolo')));
		assert.equal(other.log.some(line => line.startsWith('scarica')), false);
	}

	// acceso senza file: non si riscarica finché non è fermo
	const acceso = harness({ manifest: [voce], files: [], running: ['Piccolo'] });
	// resta acceso finché Vox non si chiude (non c'è uno spegnimento per inattività): la frase dice di riaprire Vox
	await assert.rejects(acceso.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' }), new RegExp(t('The model {0} is running without its file: close and reopen Vox, then try again.', 'Piccolo')));
	assert.equal(acceso.log.some(line => line.startsWith('scarica')), false);

	// voce tolta a mano durante lo scarico: alla fine si rimette, così il file non resta senza voce
	const tolta = harness({ manifest: [voce], files: [] });
	await tolta.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	tolta.manifest.length = 0;
	tolta.pending.finish();
	await settle();
	assert.deepEqual(tolta.manifest.map(model => [model.nome, model.file]), [['Piccolo', 'PICCOLO.gguf']]);
	assert.deepEqual(tolta.states.at(-1).scarico, { stato: 'finito', nome: 'Piccolo' });

	// voce tolta durante lo scarico e poi `modelli.json` che non si scrive: come per uno scarico nuovo il file torna
	// parziale, così il tentativo dopo lo riprende e rimette la voce (un file senza voce bloccherebbe ogni tentativo)
	const nonScritta = harness({ manifest: [{ ...voce }], files: [], addFails: true });
	await nonScritta.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	nonScritta.manifest.length = 0;
	nonScritta.pending.finish();
	await settle();
	assert.deepEqual(nonScritta.states.at(-1).scarico, { stato: 'errore', nome: 'Piccolo', messaggio: 'disco pieno' });
	assert.deepEqual(nonScritta.log.filter(line => /^(aggiungi|rimetti)/.test(line)), ['aggiungi Piccolo', 'rimetti parziale']);
	assert.deepEqual([nonScritta.files.has(fileOf('PICCOLO.gguf')), nonScritta.files.get(fileOf('PICCOLO.gguf') + '.parziale')], [false, 1000]);

	// voce che durante lo scarico cambia solo le maiuscole del nome: è la stessa, non se ne aggiunge una seconda
	const maiuscole = harness({ manifest: [{ ...voce }], files: [] });
	await maiuscole.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	maiuscole.manifest[0].nome = 'PICCOLO';
	maiuscole.pending.finish();
	await settle();
	assert.equal(maiuscole.log.some(line => line.startsWith('aggiungi')), false);
	assert.deepEqual(maiuscole.states.at(-1).scarico, { stato: 'finito', nome: 'Piccolo' });

	// voce che durante lo scarico passa (a mano) a un altro file: il file scaricato non lo usa nessuno, e lo si dice
	const cambiata = harness({ manifest: [{ ...voce }], files: [] });
	await cambiata.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	cambiata.manifest[0].file = 'altro.gguf';
	cambiata.pending.finish();
	await settle();
	assert.equal(cambiata.log.some(line => line.startsWith('aggiungi')), false);
	assert.deepEqual(cambiata.states.at(-1).scarico, { stato: 'errore', nome: 'Piccolo', messaggio: t('The entry {0} in modelli.json now uses another file ({1}): the downloaded file stays in the models folder, but no entry uses it.', 'Piccolo', 'altro.gguf') });
	assert.equal(cambiata.files.get(fileOf('PICCOLO.gguf')), 1000);

	// a fine scarico l'elenco non si legge: non si sa se la voce c'è, quindi l'esito è l'errore di lettura (non «scaricato»)
	// e non si aggiunge niente; il file resta, intero
	const options = { manifest: [voce], files: [] }, illeggibile = harness(options);
	await illeggibile.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	options.manifestError = 'modelli.json non si legge';
	illeggibile.pending.finish();
	await settle();
	assert.equal(illeggibile.log.some(line => line.startsWith('aggiungi')), false);
	assert.deepEqual(illeggibile.states.at(-1).scarico, { stato: 'errore', nome: 'Piccolo', messaggio: 'modelli.json non si legge' });
	assert.equal(illeggibile.files.get(fileOf('PICCOLO.gguf')), 1000);
});

test('riscarico di una voce senza file: un controllo non riuscito lascia la voce com\'era; in pausa si riprende senza voci nuove', async () => {
	const voce = { nome: 'Piccolo', descrizione: 'mia', uso: 'embedding', file: 'PICCOLO.gguf', contesto: 8192, porta: 8194, opzioni: ['--embedding'] };
	const sbagliato = harness({ manifest: [{ ...voce }], files: [] });
	await sbagliato.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	sbagliato.pending.fail(new Error('SHA-256 diverso da quello atteso'));
	await settle();
	assert.deepEqual(sbagliato.states.at(-1).scarico, { stato: 'errore', nome: 'Piccolo', messaggio: 'SHA-256 diverso da quello atteso' });
	assert.deepEqual(sbagliato.manifest, [voce]);
	assert.equal(sbagliato.log.some(line => line.startsWith('aggiungi')), false);
	assert.equal(sbagliato.files.has(fileOf('PICCOLO.gguf')), false);

	const pausa = harness({ manifest: [{ ...voce }], files: [] });
	await pausa.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await pausa.library.cancelDownload(true);
	await settle();
	assert.deepEqual(pausa.states.at(-1).scarico, { stato: 'annullato', nome: 'Piccolo', parziale: true });
	assert.equal(pausa.files.get(fileOf('PICCOLO.gguf') + '.parziale'), 10);
	// «Scarica di nuovo» riprende: stessa destinazione, stessa voce, nessuna voce aggiunta
	await pausa.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	assert.equal(pausa.pending.p.destination, fileOf('PICCOLO.gguf'));
	pausa.pending.finish();
	await settle();
	assert.deepEqual(pausa.states.at(-1).scarico, { stato: 'finito', nome: 'Piccolo' });
	assert.deepEqual(pausa.manifest, [voce]);
	assert.equal(pausa.log.some(line => line.startsWith('aggiungi')), false);

	// file ricomparso fra la lettura dell'elenco e l'avvio (per esempio la chiavetta rimessa): non si riscarica,
	// si controlla come un file già presente, e la voce resta quella dell'utente
	const ricomparso = (verifyFails) => {
		const h = harness({ manifest: [{ ...voce }], files: [[fileOf('PICCOLO.gguf'), 1000]], verifyFails });
		let letture = 0;
		h.library = api.createLocalModelLibrary({ ...h.deps, listInstalled: async folder => {
			const list = await h.deps.listInstalled(folder);
			return letture++ === 0 ? list.map(model => ({ ...model, bytes: null })) : list;
		} });
		return h;
	};
	const tornato = ricomparso(false);
	await tornato.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await settle();
	assert.deepEqual(tornato.log, ['controlla PICCOLO.gguf']);
	assert.deepEqual(tornato.states.at(-1).scarico, { stato: 'finito', nome: 'Piccolo' });
	assert.deepEqual(tornato.manifest, [voce]);
	// un controllo non riuscito lo dice e non toglie il file dell'utente
	const diverso = ricomparso(true);
	await diverso.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await settle();
	assert.deepEqual(diverso.states.at(-1).scarico, { stato: 'errore', nome: 'Piccolo', messaggio: 'non è il modello atteso' });
	assert.equal(diverso.files.get(fileOf('PICCOLO.gguf')), 1000);
	assert.deepEqual(diverso.log, ['controlla PICCOLO.gguf']);
	assert.deepEqual(diverso.manifest, [voce]);
});

test('file delle opzioni portato da Vox: su una cartella nuova si crea prima dello scarico; uno già presente non si tocca', async () => {
	const bundledFiles = { 'avvia/modello con spazio.jinja': 'contenuto del modello' };
	// riscarico di una voce senza file a cui manca anche il file portato da Vox: si crea, e la voce resta quella
	const voce = { nome: 'conmodello', descrizione: 'mia', uso: 'chat', file: 'con.gguf', contesto: 2048, porta: 8192, opzioni: ['--chat-template-file', '{cartella}/avvia/modello con spazio.jinja'] };
	const riscarico = harness({ bundledFiles, manifest: [{ ...voce }], files: [] });
	await riscarico.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' });
	assert.deepEqual(riscarico.log.slice(0, 2), ['crea avvia/modello con spazio.jinja', `scarica https://huggingface.co/utente/con-GGUF/resolve/def/con.gguf`]);
	riscarico.pending.finish();
	await settle();
	assert.deepEqual(riscarico.manifest, [voce]);
	assert.equal(riscarico.log.some(line => line.startsWith('aggiungi')), false);
	assert.deepEqual(riscarico.states.at(-1).scarico, { stato: 'finito', nome: 'conmodello' });
	// riscarico (nome con maiuscole diverse dall'elenco) in cui il file portato da Vox, dopo la creazione, risulta ancora
	// mancante (al suo posto c'è una cartella): si ferma con l'errore e non scarica niente
	const ancoraMancante = harness({ bundledFiles, manifest: [{ ...voce, nome: 'ConModello' }], files: [], createNothing: true });
	await assert.rejects(ancoraMancante.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), new RegExp(t('Local model option file not found: {0}', '').trim()));
	assert.deepEqual(ancoraMancante.log, ['crea avvia/modello con spazio.jinja']);
	// riscarico rifiutato perché il modello è acceso: si ferma prima di creare il file portato da Vox
	const acceso = harness({ bundledFiles, manifest: [{ ...voce }], files: [], running: ['conmodello'] });
	await assert.rejects(acceso.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), new RegExp(t('The model {0} is running without its file: close and reopen Vox, then try again.', 'conmodello')));
	assert.deepEqual(acceso.log, []);

	const nuova = harness({ bundledFiles });
	await nuova.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' });
	assert.deepEqual(nuova.log.slice(0, 2), ['crea avvia/modello con spazio.jinja', `scarica https://huggingface.co/utente/con-GGUF/resolve/def/con.gguf`]);
	nuova.pending.finish();
	await settle();
	assert.equal(nuova.manifest.at(-1).nome, 'conmodello');

	const presente = harness({ bundledFiles, files: [[path.join(folder, 'avvia', 'modello con spazio.jinja'), 7]] });
	await presente.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' });
	assert.equal(presente.log.some(line => line.startsWith('crea')), false);
	assert.equal(presente.files.get(path.join(folder, 'avvia', 'modello con spazio.jinja')), 7);
	presente.pending.finish();
	await settle();

	// richiesta rifiutata dopo il controllo delle opzioni (file del modello già presente ma di un'altra dimensione): non si crea niente
	const rifiutata = harness({ bundledFiles, files: [[fileOf('con.gguf'), 5]] });
	await assert.rejects(rifiutata.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), /con\.gguf/);
	assert.equal(rifiutata.log.some(line => line.startsWith('crea')), false);

	// creazione non riuscita: lo scarico non parte e l'errore dice perché
	const bloccata = harness({ bundledFiles, createFails: 'EACCES' });
	await assert.rejects(bloccata.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), /EACCES/);
	assert.equal(bloccata.log.some(line => line.startsWith('scarica')), false);
	// un file che Vox non porta con sé resta un errore come prima, senza creare niente
	const altro = harness({ bundledFiles: { 'avvia/altro.jinja': 'x' } });
	await assert.rejects(altro.library.startDownload('', { tipo: 'catalogo', id: 'conmodello' }), /modello con spazio\.jinja/);
	assert.equal(altro.log.some(line => line.startsWith('crea')), false);
});

test('file già presente (elenco consigliato): non si riscarica, ma entra in modelli.json solo dopo il controllo', async () => {
	const h = harness({ files: [[fileOf('piccolo.gguf'), 1000]] });
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await settle();
	assert.equal(h.log.some(line => line.startsWith('scarica')), false);
	assert.deepEqual(h.log, ['controlla piccolo.gguf', 'aggiungi piccolo']);
	assert.equal(h.manifest.at(-1).nome, 'piccolo');
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'piccolo' });
	assert.equal(h.states.some(state => state.scarico.stato === 'controllo'), true);
	// dimensione diversa da quella attesa: errore subito
	const other = harness({ files: [[fileOf('piccolo.gguf'), 999]] });
	await assert.rejects(other.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' }), /piccolo\.gguf/);
	assert.equal(other.manifest.length, 1);
	// stessa dimensione ma contenuto diverso (SHA-256): errore visibile, niente voce, e il file dell'utente resta dov'è
	const wrong = harness({ files: [[fileOf('piccolo.gguf'), 1000]], verifyFails: true });
	await wrong.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await settle();
	assert.deepEqual(wrong.states.at(-1).scarico, { stato: 'errore', nome: 'piccolo', messaggio: 'non è il modello atteso' });
	assert.equal(wrong.manifest.length, 1);
	assert.equal(wrong.files.get(fileOf('piccolo.gguf')), 1000);
	assert.equal(wrong.log.includes('togli parziale'), false);
});

test('file già presente (indirizzo incollato): non si riusa in silenzio un file con lo stesso nome', async () => {
	// prima: stesso nome di file da un altro repository → nessuno scarico e voce nuova sul file vecchio
	const h = harness({ files: [[fileOf('vecchio.gguf'), 500], [fileOf('nuovo.gguf'), 77]] });
	const address = { tipo: 'indirizzo', url: 'https://huggingface.co/altro/repo/resolve/main/nuovo.gguf', nome: 'nuovo', uso: 'chat', contesto: 4096, descrizione: '' };
	await assert.rejects(h.library.startDownload('', address), /nuovo\.gguf/);
	await assert.rejects(h.library.startDownload('', { ...address, url: 'https://huggingface.co/altro/repo/resolve/main/VECCHIO.gguf' }), /VECCHIO\.gguf|vecchio\.gguf/i);
	assert.deepEqual(h.log, []);
	assert.equal(h.manifest.length, 1);
});

test('indirizzo incollato: nomi di file pericolosi su Windows e pezzi vuoti rifiutati; embedding con la sua opzione', async () => {
	const ok = api.normalizeLocalModelDownloadURL;
	for (const bad of ['NUL.gguf', 'con.gguf', 'COM1.Q4.gguf', 'a%3Fb.gguf', 'a%2Ab.gguf', 'a%22b.gguf', 'a%3Cb.gguf', 'a%7Cb.gguf', 'a%00b.gguf', 'a%0Ab.gguf', '%20spazio.gguf', '..gguf']) {
		assert.throws(() => ok('https://huggingface.co/u/r/resolve/main/' + bad), undefined, bad);
	}
	for (const bad of ['https://huggingface.co///resolve//m.gguf', 'https://huggingface.co//r/resolve/main/m.gguf', 'https://huggingface.co/u/r/resolve//m.gguf']) assert.throws(() => ok(bad), undefined, bad);
	assert.equal(ok('https://huggingface.co/u/r/resolve/main/console.gguf').file, 'console.gguf');
	const h = harness();
	const address = { tipo: 'indirizzo', url: 'https://huggingface.co/u/r/resolve/main/emb.gguf', nome: 'emb', uso: 'embedding', contesto: 2048, descrizione: '' };
	for (const nome of ['.', '..', '...']) await assert.rejects(h.library.startDownload('', { ...address, nome }));
	// senza `--embedding` llama-server partirebbe come un modello da chat
	await h.library.startDownload('', address);
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.at(-1), { nome: 'emb', descrizione: '', file: 'emb.gguf', contesto: 2048, porta: 8194, uso: 'embedding', opzioni: ['--embedding'] });
	// un nome che cambia solo per le maiuscole è lo stesso modello (stesso file di registro su Windows)
	await assert.rejects(h.library.startDownload('', { ...address, nome: 'EMB', url: address.url.replace('emb.gguf', 'altro.gguf') }), /EMB/);
});

test('due avvii insieme: parte un solo scarico', async () => {
	const h = harness();
	const results = await Promise.allSettled([
		h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' }),
		h.library.startDownload('', { tipo: 'indirizzo', url: 'https://huggingface.co/u/r/resolve/main/nuovo.gguf', nome: 'nuovo', uso: 'chat', contesto: 4096, descrizione: '' }),
	]);
	assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
	assert.equal(h.log.filter(line => line.startsWith('scarica')).length, 1);
	assert.equal(h.states.at(-1).scarico.nome, 'piccolo');
	h.pending.finish();
	await settle();
});

test('aggiunta a modelli.json non riuscita: errore visibile; il file torna parziale e la prova successiva lo riprende', async () => {
	// Prima il file restava in `modelli/` senza voce: per l'elenco consigliato si ricontrollava, ma un indirizzo incollato
	// restava bloccato per sempre («c'è già un file con quel nome»). Ora torna parziale in tutti e due i casi: lo scarico
	// vero lo ricontrolla senza rete (`localModelDownload.test.mjs`, «un parziale già intero si controlla senza…»).
	for (const request of [{ tipo: 'catalogo', id: 'piccolo' }, { tipo: 'indirizzo', url: 'https://huggingface.co/utente/r/resolve/main/mio.gguf', nome: 'mio', uso: 'chat', contesto: 4096, descrizione: '' }]) {
		const options = { addFails: true };
		const h = harness(options);
		const file = request.tipo === 'catalogo' ? 'piccolo.gguf' : 'mio.gguf', nome = request.tipo === 'catalogo' ? 'piccolo' : 'mio';
		await h.library.startDownload('', request);
		h.pending.finish();
		await settle(); await settle();
		assert.deepEqual(h.states.at(-1).scarico, { stato: 'errore', nome, messaggio: 'disco pieno' });
		assert.equal(h.files.has(fileOf(file)), false);
		assert.equal(h.files.has(fileOf(file) + '.parziale'), true);
		options.addFails = false;
		await h.library.startDownload('', request);
		assert.notEqual(h.states.at(-1).scarico.stato, 'errore', 'la prova successiva non è bloccata');
		h.pending.finish();
		await settle(); await settle();
		assert.equal(h.manifest.at(-1).nome, nome);
	}
});

test('aggiunta a modelli.json scritta ma con errore: il modello c\'è e il file resta dov\'è', async () => {
	const h = harness({ addWritesThenFails: true });
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle(); await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'piccolo' });
	assert.equal(h.files.has(fileOf('piccolo.gguf')), true);
	assert.equal(h.log.includes('rimetti parziale'), false);
});

test('aggiunta a modelli.json con errore e elenco non leggibile: nel dubbio il file resta dov\'è', async () => {
	// prima l'elenco non leggibile valeva «voce non scritta» e il file finito tornava parziale anche se la voce c'era
	const options = { addWritesThenFails: true, onAdd: async () => { options.manifestError = 'modelli.json bloccato' } };
	const h = harness(options);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle(); await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'errore', nome: 'piccolo', messaggio: 'scrittura lenta' });
	assert.equal(h.files.has(fileOf('piccolo.gguf')), true);
	assert.equal(h.files.has(fileOf('piccolo.gguf') + '.parziale'), false);
	assert.equal(h.log.includes('rimetti parziale'), false);
});

test('annullo arrivato a scarico finito: il file entra lo stesso in modelli.json, e un errore di scrittura non viene nascosto', async () => {
	// prima: un annullo durante la scrittura di modelli.json dava «annullato» e lasciava il file da gigabyte senza voce
	let h;
	const options = { onAdd: async () => { void h.library.cancelDownload(false); await settle() } };
	h = harness(options);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle(); await settle(); await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'piccolo' });
	assert.equal(h.manifest.at(-1).nome, 'piccolo');
	assert.equal(h.files.has(fileOf('piccolo.gguf')), true);

	const failing = { addFails: true };
	let f;
	failing.onAdd = async () => { void f.library.cancelDownload(false); await settle() };
	f = harness(failing);
	await f.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	f.pending.finish();
	await settle(); await settle(); await settle();
	assert.deepEqual(f.states.at(-1).scarico, { stato: 'errore', nome: 'piccolo', messaggio: 'disco pieno' });
});

test('avanzamento: l\'ultimo evento di una fase passa anche se arriva subito dopo un altro', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	const progress = h.pending.p.onProgress;
	progress({ fase: 'scarico', ricevuti: 0, totale: 1000 });
	h.tick(300); progress({ fase: 'scarico', ricevuti: 900, totale: 1000 });
	h.tick(10); progress({ fase: 'scarico', ricevuti: 1000, totale: 1000 });
	assert.equal(h.states.at(-1).scarico.ricevuti, 1000);
	h.pending.finish();
	await settle();
});

test('rimozione: chiude il modello, mette il file nel Cestino e poi toglie la voce', async () => {
	const h = harness({ running: ['vecchio'] });
	assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio', definitiva: false }), { esito: 'tolto', fileTolto: true, nelCestino: true });
	assert.deepEqual(h.log, ['chiudi vecchio', 'cestino vecchio.gguf', 'togli vecchio']);
	assert.equal(h.files.has(fileOf('vecchio.gguf')), false);
	assert.deepEqual(h.states.at(-1).installati, []);
});

test('rimozione senza Cestino: non si tocca niente finché l\'utente non conferma la cancellazione definitiva', async () => {
	const h = harness({ noTrash: true });
	assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio', definitiva: false }), { esito: 'cestinoAssente' });
	assert.equal(h.files.has(fileOf('vecchio.gguf')), true);
	assert.equal(h.manifest.length, 1);
	assert.equal(h.log.includes('togli vecchio'), false);
	assert.equal(h.log.some(line => line.startsWith('cancella')), false);
	// la stessa richiesta ripetuta (doppio clic, doppio Invio) non diventa mai una cancellazione definitiva
	assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio', definitiva: false }), { esito: 'cestinoAssente' });
	for (const definitiva of [undefined, null, 'true', 1]) assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio', definitiva }), { esito: 'cestinoAssente' });
	assert.equal(h.log.some(line => line.startsWith('cancella')), false);
	assert.equal(h.files.has(fileOf('vecchio.gguf')), true);
	assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio', definitiva: true }), { esito: 'tolto', fileTolto: true, nelCestino: false });
	assert.deepEqual(h.log.slice(-3), ['chiudi vecchio', 'cancella vecchio.gguf', 'togli vecchio']);
	assert.equal(h.files.has(fileOf('vecchio.gguf')), false);
});

test('rimozione di un modello che condivide il file: si toglie solo la voce', async () => {
	const h = harness({ manifest: [
		{ nome: 'a', descrizione: '', uso: 'chat', file: 'comune.gguf', contesto: 4096, porta: 8192, opzioni: [] },
		{ nome: 'b', descrizione: '', uso: 'chat', file: 'comune.gguf', contesto: 8192, porta: 8192, opzioni: [] },
	], files: [[fileOf('comune.gguf'), 700]] });
	assert.deepEqual(await h.library.removeModel('', { nome: 'a', definitiva: false }), { esito: 'tolto', fileTolto: false, nelCestino: false });
	assert.deepEqual(h.log, ['chiudi a', 'togli a']);
	assert.equal(h.files.has(fileOf('comune.gguf')), true);
	// l'ultimo che lo usa porta via anche il file
	assert.deepEqual(await h.library.removeModel('', { nome: 'b', definitiva: false }), { esito: 'tolto', fileTolto: true, nelCestino: true });
});

test('rimozione: file già mancante, modello in uso, modello sconosciuto, file bloccato', async () => {
	const missing = harness({ files: [] });
	assert.deepEqual(await missing.library.removeModel('', { nome: 'vecchio', definitiva: false }), { esito: 'tolto', fileTolto: false, nelCestino: false });
	assert.equal(missing.manifest.length, 0);

	const busy = harness({ closeFails: true });
	const refused = await busy.library.removeModel('', { nome: 'vecchio', definitiva: false });
	assert.equal(refused.esito, 'errore');
	assert.match(refused.messaggio, /vecchio/);
	assert.equal(busy.manifest.length, 1);
	assert.equal(busy.files.has(fileOf('vecchio.gguf')), true);

	const unknown = await harness().library.removeModel('', { nome: 'nessuno', definitiva: true });
	assert.equal(unknown.esito, 'errore');
	assert.equal((await harness().library.removeModel('assente', { nome: 'vecchio', definitiva: true })).esito, 'errore');

	// una richiesta in coda riaccende il modello fra la chiusura e il Cestino: è «in uso», non «Cestino assente»
	const restarted = harness({ busy: true, onTrash: running => running.add('vecchio') });
	const again = await restarted.library.removeModel('', { nome: 'vecchio', definitiva: false });
	assert.equal(again.esito, 'errore');
	assert.equal(restarted.manifest.length, 1);

	const locked = harness({ unlinkFails: true });
	const failed = await locked.library.removeModel('', { nome: 'vecchio', definitiva: true });
	assert.equal(failed.esito, 'errore');
	assert.match(failed.messaggio, /vecchio\.gguf/);
	assert.equal(locked.manifest.length, 1);
});

test('rimozione durante uno scarico: rifiutata per lo stesso file, permessa per gli altri modelli', async () => {
	const h = harness({ manifest: [
		{ nome: 'vecchio', descrizione: '', uso: 'chat', file: 'vecchio.gguf', contesto: 4096, porta: 8192, opzioni: [] },
		{ nome: 'gemello', descrizione: '', uso: 'chat', file: 'PICCOLO.gguf', contesto: 4096, porta: 8192, opzioni: [] },
	] });
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	assert.equal((await h.library.removeModel('', { nome: 'gemello', definitiva: false })).esito, 'errore');
	assert.equal((await h.library.removeModel('', { nome: 'vecchio', definitiva: false })).esito, 'tolto');
	assert.equal(h.states.at(-1).scarico.stato, 'scarico');
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.map(model => model.nome), ['gemello', 'piccolo']);
});

test('stato: senza cartella, con modelli.json illeggibile, e chiusura di Vox che tiene il parziale', async () => {
	const h = harness();
	assert.deepEqual(await h.library.getState('assente'), { cartella: null, liberi: null, installati: [], scarico: { stato: 'fermo' }, errore: null });
	const broken = await harness({ manifestError: 'modelli.json non leggibile' }).library.getState('');
	assert.equal(broken.errore, 'modelli.json non leggibile');
	assert.equal(broken.cartella, folder);
	assert.deepEqual((await h.library.getCatalog()).map(entry => entry.id), ['piccolo', 'conmodello']);
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.library.dispose();
	await settle();
	assert.equal(h.files.has(fileOf('piccolo.gguf') + '.parziale'), true);
	assert.equal(h.log.includes('togli parziale'), false);
});

test('rimozione: file condivisi anche se i nomi cambiano solo per le maiuscole (Windows)', async () => {
	// prima: `Comune.gguf` e `comune.gguf` non risultavano condivisi e togliendo una voce spariva il file dell'altra
	const h = harness({ manifest: [
		{ nome: 'a', descrizione: '', uso: 'chat', file: 'Comune.gguf', contesto: 4096, porta: 8192, opzioni: [] },
		{ nome: 'b', descrizione: '', uso: 'chat', file: 'comune.gguf', contesto: 8192, porta: 8192, opzioni: [] },
	], files: [[fileOf('Comune.gguf'), 700]] });
	assert.deepEqual(await h.library.removeModel('', { nome: 'a', definitiva: false }), { esito: 'tolto', fileTolto: false, nelCestino: false });
	assert.equal(h.files.has(fileOf('Comune.gguf')), true);
	assert.equal(h.log.some(line => line.startsWith('cestino')), false);
});

test('due rimozioni insieme di voci che condividono il file: il file non resta sul disco senza voce', async () => {
	// prima: tutte e due leggevano «condiviso», toglievano solo la voce e il file restava orfano
	const h = harness({ manifest: [
		{ nome: 'a', descrizione: '', uso: 'chat', file: 'comune.gguf', contesto: 4096, porta: 8192, opzioni: [] },
		{ nome: 'b', descrizione: '', uso: 'chat', file: 'comune.gguf', contesto: 8192, porta: 8192, opzioni: [] },
	], files: [[fileOf('comune.gguf'), 700]] });
	const results = await Promise.all([h.library.removeModel('', { nome: 'a', definitiva: false }), h.library.removeModel('', { nome: 'b', definitiva: false })]);
	assert.deepEqual(results, [{ esito: 'tolto', fileTolto: false, nelCestino: false }, { esito: 'tolto', fileTolto: true, nelCestino: true }]);
	assert.equal(h.manifest.length, 0);
	assert.equal(h.files.has(fileOf('comune.gguf')), false);
});

test('rimozione e aggiunta insieme sullo stesso file: una alla volta, nessuna voce resta senza file', async () => {
	const h = harness({ manifest: [{ nome: 'vecchio', descrizione: '', uso: 'embedding', file: 'piccolo.gguf', contesto: 2048, porta: 8194, opzioni: [] }], files: [[fileOf('piccolo.gguf'), 1000]] });
	const [removed, started] = await Promise.allSettled([h.library.removeModel('', { nome: 'vecchio', definitiva: false }), h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' })]);
	assert.deepEqual(removed.value, { esito: 'tolto', fileTolto: true, nelCestino: true });
	// l'aggiunta parte dopo la rimozione: il file non c'è più, quindi si scarica davvero
	assert.equal(started.status, 'fulfilled');
	assert.equal(h.log.filter(line => line.startsWith('scarica')).length, 1);
	h.pending.finish();
	await settle();
	assert.deepEqual(h.manifest.map(model => model.nome), ['piccolo']);
	assert.equal(h.files.has(fileOf('piccolo.gguf')), true);
});

test('rimozione: il modello riacceso prima del Cestino non perde il file; dopo un errore del Cestino lo stato è riletto', async () => {
	let h;
	const options = {};
	h = harness(options);
	// si riaccende durante la chiusura (richiesta in coda)
	const close = h.library.removeModel('', { nome: 'vecchio', definitiva: true });
	h.running.add('vecchio');
	// la chiusura finta toglie `vecchio` da `running`: lo rimettiamo subito dopo, come farebbe una richiesta in coda
	const original = h.running.delete.bind(h.running);
	h.running.delete = name => { original(name); h.running.add(name); return true };
	const result = await close;
	assert.equal(result.esito, 'errore');
	assert.match(result.messaggio, /in uso/);
	assert.equal(h.files.has(fileOf('vecchio.gguf')), true);
	assert.equal(h.log.some(line => line.startsWith('cancella') || line.startsWith('cestino')), false);
	assert.equal(h.manifest.length, 1);

	// Cestino non riuscito: il modello era acceso ed è stato chiuso, la finestra lo deve sapere
	const t2 = harness({ noTrash: true, running: ['vecchio'] });
	const before = t2.states.length;
	assert.deepEqual(await t2.library.removeModel('', { nome: 'vecchio', definitiva: false }), { esito: 'cestinoAssente' });
	assert.equal(t2.states.length, before + 1);
	assert.equal(t2.states.at(-1).installati[0].acceso, false);
});

test('dopo aver tolto un modello appena scaricato il messaggio «scaricato» sparisce', async () => {
	const h = harness();
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle();
	assert.equal(h.states.at(-1).scarico.stato, 'finito');
	assert.equal((await h.library.removeModel('', { nome: 'piccolo', definitiva: false })).esito, 'tolto');
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'fermo' });
	// il messaggio di un altro modello resta
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	h.pending.finish();
	await settle();
	await h.library.removeModel('', { nome: 'vecchio', definitiva: false });
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'piccolo' });
});

test('durante la rimozione il modello non si può riavviare, e alla fine gli avvii tornano possibili', async () => {
	// Prima una richiesta poteva riaccendere il modello fra il controllo «non è acceso» e lo spostamento nel Cestino.
	let tried = 0;
	const h = harness({ running: ['vecchio'], onTrash: running => { tried++; if (!h.blocked.has('vecchio')) running.add('vecchio') } });
	assert.deepEqual(await h.library.removeModel('', { nome: 'vecchio' }), { esito: 'tolto', fileTolto: true, nelCestino: true });
	assert.equal(tried, 1);
	assert.equal(h.running.has('vecchio'), false, 'il riavvio a metà rimozione è stato rifiutato');
	assert.deepEqual(h.log.filter(line => /chiudi|cestino|togli /.test(line)), ['chiudi vecchio', 'cestino vecchio.gguf', 'togli vecchio']);
	assert.deepEqual(h.blockLog, ['blocca vecchio', 'sblocca vecchio']);
	assert.equal(h.blocked.size, 0);
	// anche quando la rimozione non riesce (modello in uso, Cestino assente) il blocco si toglie
	for (const options of [{ closeFails: true, running: ['vecchio'] }, { noTrash: true }]) {
		const f = harness(options);
		await f.library.removeModel('', { nome: 'vecchio' });
		assert.equal(f.blocked.size, 0);
		assert.deepEqual(f.blockLog, ['blocca vecchio', 'sblocca vecchio']);
	}
});

test('un file consigliato già presente: fermarne il controllo non toglie niente e il messaggio dice che si può riprendere', async () => {
	let h;
	h = harness({ files: [[fileOf('vecchio.gguf'), 500], [fileOf('piccolo.gguf'), 1000]] });
	h.library = api.createLocalModelLibrary({ ...h.deps, verifyExisting: p => new Promise((_, reject) => {
		p.onProgress({ fase: 'controllo', ricevuti: 10, totale: 1000 });
		p.signal.addEventListener('abort', () => reject(abortError()));
	}) });
	await h.library.startDownload('', { tipo: 'catalogo', id: 'piccolo' });
	await settle();
	const checking = h.states.findLast(state => state.scarico.stato === 'controllo');
	assert.equal(checking?.scarico.giaPresente, true, 'l\'interfaccia sa che il file c\'era già');
	await h.library.cancelDownload(false);
	await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'annullato', nome: 'piccolo', parziale: true });
	assert.equal(h.files.get(fileOf('piccolo.gguf')), 1000);
	assert.equal(h.log.includes('togli parziale'), false);
});

test('contesto: cambia il valore in modelli.json, rilegge lo stato e dice se il modello acceso si riavvia', async () => {
	const h = harness({ running: ['vecchio'] });
	assert.deepEqual(await h.library.setContext('', { nome: 'vecchio', contesto: 16384 }), { esito: 'fatto', prima: 4096, riavvio: true });
	assert.equal(h.manifest[0].contesto, 16384);
	assert.deepEqual(h.log, ['contesto vecchio 16384']);
	// il modello acceso non si chiude da qui: lo riavvia il gestore alla prossima richiesta
	assert.equal(h.running.has('vecchio'), true);
	assert.ok(h.states.length > 0);
	const spento = harness();
	assert.deepEqual(await spento.library.setContext('', { nome: 'vecchio', contesto: 2048 }), { esito: 'fatto', prima: 4096, riavvio: false });
	// stesso valore: niente riavvio
	const uguale = harness({ running: ['vecchio'] });
	assert.deepEqual(await uguale.library.setContext('', { nome: 'vecchio', contesto: 4096 }), { esito: 'fatto', prima: 4096, riavvio: false });
});

test('contesto: valori non validi, modello sconosciuto, cartella assente ed errore di scrittura non cambiano niente', async () => {
	const limits = t('Context must be a whole number between {0} and {1}.', 512, 1048576);
	for (const contesto of [511, 1048577, 4096.5, '8192', NaN, null, undefined]) {
		const h = harness();
		assert.deepEqual(await h.library.setContext('', { nome: 'vecchio', contesto }), { esito: 'errore', messaggio: limits }, String(contesto));
		assert.equal(h.manifest[0].contesto, 4096);
		assert.deepEqual(h.log, []);
	}
	const h = harness();
	assert.deepEqual(await h.library.setContext('', { nome: 'nessuno', contesto: 8192 }), { esito: 'errore', messaggio: t('Local model {0} was not found in the manifest.', 'nessuno') });
	assert.equal((await h.library.setContext('assente', { nome: 'vecchio', contesto: 8192 })).esito, 'errore');
	assert.equal((await h.library.setContext('', null)).esito, 'errore');
	assert.deepEqual(h.log, []);
	const failing = harness({ contextFails: 'disco pieno' });
	assert.deepEqual(await failing.library.setContext('', { nome: 'vecchio', contesto: 8192 }), { esito: 'errore', messaggio: 'disco pieno' });
	// dopo l'errore lo stato si rilegge comunque
	assert.ok(failing.states.length > 0);
});

test('contesto: passa in coda con le rimozioni, così non scrive su una voce che si sta togliendo', async () => {
	const h = harness();
	const removal = h.library.removeModel('', { nome: 'vecchio', definitiva: false });
	const change = h.library.setContext('', { nome: 'vecchio', contesto: 8192 });
	assert.equal((await removal).esito, 'tolto');
	assert.deepEqual(await change, { esito: 'errore', messaggio: t('Local model {0} was not found in the manifest.', 'vecchio') });
	assert.equal(h.log.some(line => line.startsWith('contesto')), false);
});

test('file scelto dalla ricerca: dimensione e SHA-256 dichiarati arrivano allo scarico; valori sbagliati rifiutati', async () => {
	const address = { tipo: 'indirizzo', url: 'https://huggingface.co/u/r/resolve/' + 'c'.repeat(40) + '/nuovo.gguf', nome: 'nuovo', uso: 'chat', contesto: 4096, descrizione: 'u/r' };
	const sha256 = 'AB'.repeat(32);
	const h = harness();
	const invalid = t('Invalid model size or SHA-256.');
	for (const extra of [
		{ bytes: 3, sha256 }, { bytes: -1, sha256 }, { bytes: 1.5, sha256 }, { bytes: '5000', sha256 }, { bytes: Number.MAX_SAFE_INTEGER + 1, sha256 },
		{ bytes: 5000, sha256: 'abc' }, { bytes: 5000, sha256: 'g'.repeat(64) }, { bytes: 5000, sha256: 7 }, { bytes: 5000, sha256: ' ' + 'a'.repeat(64) },
		// uno SHA-256 senza dimensione non si accetta: la ricerca li dà sempre insieme
		{ sha256 }, { bytes: null, sha256 },
	]) await assert.rejects(h.library.startDownload('', { ...address, ...extra }), error => error.message === invalid, JSON.stringify(extra));
	assert.deepEqual(h.log, []);
	await h.library.startDownload('', { ...address, bytes: 5000, sha256 });
	assert.equal(h.pending.p.url, address.url);
	assert.equal(h.pending.p.expectedBytes, 5000);
	assert.equal(h.pending.p.expectedSha256, sha256.toLowerCase());
	// la dimensione attesa si vede subito nell'avanzamento
	assert.equal(h.states.at(-1).scarico.totale, 5000);
	h.pending.finish();
	await settle();
	assert.deepEqual(h.states.at(-1).scarico, { stato: 'finito', nome: 'nuovo' });
	assert.equal(h.manifest.at(-1).nome, 'nuovo');
	// solo la dimensione (Hugging Face non dichiara lo SHA-256)
	const onlySize = harness();
	await onlySize.library.startDownload('', { ...address, bytes: 5000, sha256: null });
	assert.equal(onlySize.pending.p.expectedBytes, 5000);
	assert.equal(onlySize.pending.p.expectedSha256, null);
	// il controllo fallito dello scarico (SHA-256 diverso) diventa un errore e il modello non entra nell'elenco
	const wrong = harness();
	await wrong.library.startDownload('', { ...address, bytes: 5000, sha256 });
	wrong.pending.fail(new Error('il file non corrisponde'));
	await settle();
	assert.deepEqual(wrong.states.at(-1).scarico, { stato: 'errore', nome: 'nuovo', messaggio: 'il file non corrisponde' });
	assert.equal(wrong.manifest.some(model => model.nome === 'nuovo'), false);
});

test('file scelto dalla ricerca: anche con lo SHA-256 non si riusa un file già presente né quello di un altro modello', async () => {
	const extra = { bytes: 77, sha256: 'a'.repeat(64) };
	const address = { tipo: 'indirizzo', url: 'https://huggingface.co/altro/repo/resolve/main/nuovo.gguf', nome: 'nuovo', uso: 'chat', contesto: 4096, descrizione: '', ...extra };
	// file presente con la stessa dimensione dichiarata: per l'elenco consigliato si ricontrollerebbe, qui si rifiuta
	const h = harness({ files: [[fileOf('vecchio.gguf'), 500], [fileOf('nuovo.gguf'), 77]] });
	await assert.rejects(h.library.startDownload('', address), /nuovo\.gguf/);
	await assert.rejects(h.library.startDownload('', { ...address, url: 'https://huggingface.co/altro/repo/resolve/main/VECCHIO.gguf', bytes: 500 }), /VECCHIO\.gguf|vecchio\.gguf/i);
	assert.deepEqual(h.log, []);
	assert.equal(h.manifest.length, 1);
});
