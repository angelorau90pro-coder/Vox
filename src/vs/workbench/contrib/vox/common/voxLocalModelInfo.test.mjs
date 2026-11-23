// Dati dei modelli delle IA locali salvati per l'avvio: finestre di contesto e modelli di completamento.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./voxLocalModelInfo.ts', import.meta.url), 'utf8');
assert.equal(/^import /m.test(source), false, 'voxLocalModelInfo.ts deve restare senza importazioni: aggiornare il test');
const { parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo } = new Function(
	stripTypeScriptTypes(source).replace(/^export /gm, '') + '; return { parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo };',
)();

test('salvataggio e lettura restituiscono gli stessi dati, con un testo stabile da confrontare', () => {
	const models = [
		{ name: 'qwen3.5-9b', contextWindow: 8192, uso: 'chat' },
		{ name: 'qwen2.5-coder-7b', contextWindow: 4096, uso: 'completamento' },
		{ name: 'altro-completamento', contextWindow: undefined, uso: 'completamento' },
	];
	const saved = serializeVoxLocalModelInfo(models);
	assert.deepEqual(saved, {
		contextWindows: '{"qwen3.5-9b":8192,"qwen2.5-coder-7b":4096}',
		// in ordine alfabetico: lo stesso insieme dà sempre lo stesso testo, qualunque sia l'ordine del manifesto
		completionModels: '["altro-completamento","qwen2.5-coder-7b"]',
	});
	assert.equal(serializeVoxLocalModelInfo([...models].reverse()).completionModels, saved.completionModels);
	assert.deepEqual(parseSavedVoxLocalModelInfo(saved.contextWindows, saved.completionModels), [
		// l'uso "chat" non si salva: conta solo sapere quali sono di completamento
		{ name: 'qwen3.5-9b', contextWindow: 8192 },
		{ name: 'qwen2.5-coder-7b', contextWindow: 4096, uso: 'completamento' },
		{ name: 'altro-completamento', contextWindow: undefined, uso: 'completamento' },
	]);
	assert.deepEqual(serializeVoxLocalModelInfo([]), { contextWindows: '{}', completionModels: '[]' });
});

test('le finestre di contesto non valide non si salvano e non si leggono', () => {
	const saved = serializeVoxLocalModelInfo([{ name: 'a', contextWindow: 0 }, { name: 'b', contextWindow: -1 }, { name: 'c', contextWindow: NaN }, { name: 'd', contextWindow: '4096' }, { name: 'e', contextWindow: Infinity }, { name: 'f', contextWindow: 2048 }]);
	assert.equal(saved.contextWindows, '{"f":2048}');
	assert.deepEqual(parseSavedVoxLocalModelInfo('{"a":0,"b":"4096","c":null,"d":4096}', undefined), [
		{ name: 'a', contextWindow: undefined }, { name: 'b', contextWindow: undefined }, { name: 'c', contextWindow: undefined }, { name: 'd', contextWindow: 4096 },
	]);
});

test('un valore mancante, rovinato o di forma sbagliata vale come vuoto e non tocca l\'altro', () => {
	assert.deepEqual(parseSavedVoxLocalModelInfo(undefined, undefined), []);
	assert.deepEqual(parseSavedVoxLocalModelInfo('', ''), []);
	// solo le finestre di contesto, come le salvava la versione precedente
	assert.deepEqual(parseSavedVoxLocalModelInfo('{"a":4096}', undefined), [{ name: 'a', contextWindow: 4096 }]);
	assert.deepEqual(parseSavedVoxLocalModelInfo('{rotto', '["c"]'), [{ name: 'c', contextWindow: undefined, uso: 'completamento' }]);
	assert.deepEqual(parseSavedVoxLocalModelInfo('{"a":4096}', '{rotto'), [{ name: 'a', contextWindow: 4096 }]);
	assert.deepEqual(parseSavedVoxLocalModelInfo('[4096]', '{"c":true}'), []);
	assert.deepEqual(parseSavedVoxLocalModelInfo('null', 'null'), []);
	// nomi non validi nell'elenco dei modelli di completamento si saltano
	assert.deepEqual(parseSavedVoxLocalModelInfo('{}', '["c", 3, "", null, ["x"], "c"]'), [{ name: 'c', contextWindow: undefined, uso: 'completamento' }]);
});
