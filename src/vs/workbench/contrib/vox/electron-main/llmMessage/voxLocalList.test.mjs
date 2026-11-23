// Elenco dei modelli delle IA locali (voxLocalList): IA locali assenti, errori veri e dati passati al menu.
// Il gestore finto ha solo `listModels`: l'elenco non deve usare altro (un elenco dei soli modelli da chat
// lascerebbe fuori il modello di completamento).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const source = await readFile(new URL('./sendLLMMessage.impl.ts', import.meta.url), 'utf8');
const start = source.indexOf('const voxLocalList =');
const end = source.indexOf('const sendVoxLocalChat =', start);
assert.ok(start >= 0 && end > start, 'forma di sendLLMMessage.impl.ts cambiata: aggiornare i confini del test');
const localSource = await readFile(new URL('./localModels.ts', import.meta.url), 'utf8');
const notConfigured = /export const LOCAL_MODELS_NOT_CONFIGURED = '([^']+)'/.exec(localSource);
assert.ok(notConfigured, 'LOCAL_MODELS_NOT_CONFIGURED non trovato in localModels.ts');
const LOCAL_MODELS_NOT_CONFIGURED = notConfigured[1];

function run(manager, folder = '') {
	const successes = [], errors = [], windows = [];
	const list = evaluate('localModelManager', 'setVoxLocalContextWindows', 'LOCAL_MODELS_NOT_CONFIGURED',
		stripTypeScriptTypes(source.slice(start, end)) + '; return voxLocalList;')(manager, value => windows.push(value), LOCAL_MODELS_NOT_CONFIGURED);
	return list({ settingsOfProvider: { voxLocal: { folder } }, onSuccess: value => successes.push(value), onError: value => errors.push(value) })
		.then(() => ({ successes, errors, windows }));
}

test('IA locali assenti (cartella vuota, nulla trovato): zero modelli e nessun errore', async () => {
	const missing = Object.assign(new Error('Cartella delle IA locali di Vox non trovata'), { name: LOCAL_MODELS_NOT_CONFIGURED });
	const result = await run({ listModels: async () => { throw missing } });
	assert.deepEqual(result.errors, []);
	assert.equal(result.successes.length, 1);
	assert.deepEqual(result.successes[0].models, []);
	// le finestre di contesto dei modelli spariti non restano nel processo principale
	assert.deepEqual(result.windows, [[]]);
});

test('cartella scelta che non esiste o manifesto rotto: errore vero con la sua causa', async () => {
	for (const error of [new Error('Cartella delle IA locali di Vox non trovata'), Object.assign(new Error('Campo nome non valido'), { name: 'TimeoutError' })]) {
		const result = await run({ listModels: async () => { throw error }, folderOf: async () => null }, 'E:\\nessuna');
		assert.deepEqual(result.successes, []);
		assert.deepEqual(result.errors, [{ error: error.message }]);
	}
});

test('modelli trovati: descrizione e contesto al menu, cartella anche da sola, cause dei file mancanti distinte', async () => {
	const result = await run({
		listModels: async () => ({
			// la cartella usata arriva con l'elenco: nessuna seconda ricerca
			folder: 'D:/ia',
			// descrizione su più righe: nel menu va su una riga sola
			models: [{ nome: 'qwen', descrizione: ' Chat\n\t veloce ', contesto: 8192, uso: 'chat' }, { nome: 'nudo', descrizione: '   ', contesto: 4096, uso: 'chat' }, { nome: 'coder', descrizione: 'Completamento', contesto: 8192, uso: 'completamento' }],
			missing: [{ nome: 'b', file: 'D:/ia/modelli/b.gguf' }, { nome: 'c', file: 'D:/ia/modelli/c.gguf', error: 'Tempo scaduto durante l\'accesso al file del modello locale: D:/ia/modelli/c.gguf' }],
		}),
	});
	assert.deepEqual(result.errors, []);
	const [success] = result.successes;
	// il modello di completamento arriva insieme a quelli da chat, con il suo uso: serve al completamento automatico
	assert.deepEqual(success.models.map(model => [model.id, model.contextWindow, model.description, model.folder, model.uso]),
		[['qwen', 8192, 'Chat veloce', 'D:/ia', 'chat'], ['nudo', 4096, undefined, 'D:/ia', 'chat'], ['coder', 8192, 'Completamento', 'D:/ia', 'completamento']]);
	assert.equal(success.folder, 'D:/ia');
	assert.equal(success.warning, 'File dei modelli locali non trovati: b (D:/ia/modelli/b.gguf). File dei modelli locali non raggiungibili: c (Tempo scaduto durante l\'accesso al file del modello locale: D:/ia/modelli/c.gguf)');
	assert.deepEqual(result.windows, [[{ name: 'qwen', contextWindow: 8192, uso: 'chat' }, { name: 'nudo', contextWindow: 4096, uso: 'chat' }, { name: 'coder', contextWindow: 8192, uso: 'completamento' }]]);
});

test('cartella trovata con zero modelli e niente mancanti: nessun avviso, ma la cartella arriva', async () => {
	const result = await run({ listModels: async () => ({ folder: 'D:/ia', models: [], missing: [] }) });
	assert.deepEqual(result.successes, [{ models: [], warning: undefined, folder: 'D:/ia' }]);
});

test('molti file mancanti e descrizione lunga: avviso con i primi cinque e il conto degli altri, descrizione accorciata', async () => {
	const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
	const long = 'x'.repeat(150) + ' ' + 'y'.repeat(150);
	const result = await run({
		listModels: async () => ({
			folder: 'D:/ia',
			models: [{ nome: 'lungo', descrizione: long, contesto: 4096, uso: 'chat' }, { nome: 'giusto', descrizione: 'z'.repeat(200), contesto: 4096, uso: 'chat' }],
			missing: names.map(nome => ({ nome, file: `D:/ia/modelli/${nome}.gguf` })),
		}),
	});
	const [success] = result.successes;
	assert.equal(success.warning, `File dei modelli locali non trovati: ${names.slice(0, 5).map(nome => `${nome} (D:/ia/modelli/${nome}.gguf)`).join('; ')} e altri 2`);
	const [lungo, giusto] = success.models.map(model => model.description);
	assert.equal(lungo.length, 200);
	assert.ok(lungo.endsWith('…') && lungo.startsWith('x'.repeat(150)), lungo);
	// esattamente al limite: resta intera
	assert.equal(giusto, 'z'.repeat(200));
	// cinque o sei mancanti: tutti elencati, nessun "e altri" (con sei sarebbe "e altri 1")
	for (const count of [5, 6]) {
		const few = await run({ listModels: async () => ({ folder: 'D:/ia', models: [], missing: names.slice(0, count).map(nome => ({ nome, file: `${nome}.gguf` })) }) });
		const warning = few.successes[0].warning;
		assert.ok(!warning.includes('altri') && warning.includes(`${names[count - 1]} (`), warning);
	}
});

test('descrizione lunga con emoji al punto di taglio: la lunghezza conta i caratteri e il taglio non spezza l\'emoji', async () => {
	// 198 lettere e poi emoji (due unità UTF-16 ciascuna): il taglio cade su un'emoji
	const description = 'a'.repeat(198) + '😀'.repeat(5);
	const result = await run({ listModels: async () => ({ folder: 'D:/ia', models: [{ nome: 'emoji', descrizione: description, contesto: 4096, uso: 'chat' }], missing: [] }) });
	const cut = result.successes[0].models[0].description;
	assert.equal(cut, 'a'.repeat(198) + '😀…');
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'surrogata alta senza la sua coppia');
	// 200 caratteri con emoji (oltre 200 unità UTF-16): resta intera
	const exact = 'b'.repeat(195) + '😀'.repeat(5);
	const whole = await run({ listModels: async () => ({ folder: 'D:/ia', models: [{ nome: 'esatta', descrizione: exact, contesto: 4096, uso: 'chat' }], missing: [] }) });
	assert.equal(whole.successes[0].models[0].description, exact);
});
