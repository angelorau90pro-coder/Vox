import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./voxSettingsService.ts', import.meta.url), 'utf8');

const swapStart = source.indexOf('const _modelsWithSwappedInNewModels =');
const swapEnd = source.indexOf('export const modelFilterOfFeatureName:');
assert.notEqual(swapStart, -1, 'forma di _modelsWithSwappedInNewModels cambiata: aggiornare la trasformazione del test');
assert.ok(swapEnd > swapStart, 'fine di _modelsWithSwappedInNewModels non trovata: aggiornare la trasformazione del test');
const swapBody = stripTypeScriptTypes(source.slice(swapStart, swapEnd));

// _validatedModelState usa isVoxLocalConfigured, definita subito prima: si parte da lì
const valStart = source.indexOf('export const isVoxLocalConfigured =');
const valEnd = source.indexOf('const defaultState = () =>');
assert.notEqual(valStart, -1, 'forma di _validatedModelState cambiata: aggiornare la trasformazione del test');
assert.ok(valEnd > valStart, 'fine di _validatedModelState non trovata: aggiornare la trasformazione del test');
const valBody = stripTypeScriptTypes(source.slice(valStart, valEnd)).replace(/^export /gm, '');

// il metodo della classe, non la sua dichiarazione nell'interfaccia (stesso nome, finisce con `;`)
const setStart = source.indexOf('\tsetAutodetectedModels(providerName: ProviderName, autodetectedModelNames');
const setEnd = source.indexOf('\ttoggleModelHidden(', setStart);
assert.notEqual(setStart, -1, 'forma di setAutodetectedModels cambiata: aggiornare la trasformazione del test');
assert.ok(setEnd > setStart, 'fine di setAutodetectedModels non trovata: aggiornare la trasformazione del test');
const setBody = stripTypeScriptTypes(`const _svc = {\n${source.slice(setStart, setEnd)}\n};`);

const { _modelsWithSwappedInNewModels, _validatedModelState, setAutodetectedModels } = new Function(
	'providerNames',
	'defaultProviderSettings',
	'featureNames',
	'modelFilterOfFeatureName',
	'modelSelectionsEqual',
	'splitCliAgentModel',
	`${swapBody}\n${valBody}\n${setBody}\nreturn { _modelsWithSwappedInNewModels, _validatedModelState, setAutodetectedModels: _svc.setAutodetectedModels };`,
)(
	['voxLocal', 'cliAgent'],
	{ voxLocal: { folder: '' }, cliAgent: {} },
	['Chat'],
	{ Chat: { filter: () => true } },
	(a, b) => a.providerName === b.providerName && a.modelName === b.modelName,
	s => ({ agent: s, subModel: '' }),
);

test('_modelsWithSwappedInNewModels assegna, aggiorna, rimuove le descrizioni e conserva isHidden', () => {
	const initial = _modelsWithSwappedInNewModels({
		existingModels: [
			{ modelName: 'a', type: 'autodetected', isHidden: true },
			{ modelName: 'b', type: 'autodetected', isHidden: false, description: 'vecchia' },
			{ modelName: 'custom-1', type: 'custom', isHidden: false },
		],
		models: ['a', 'b', 'c'],
		type: 'autodetected',
		descriptionOfModel: { a: 'prima', c: '' },
	});

	assert.deepEqual(initial, [
		{ modelName: 'a', type: 'autodetected', isHidden: true, description: 'prima' },
		{ modelName: 'b', type: 'autodetected', isHidden: false },
		{ modelName: 'c', type: 'autodetected', isHidden: false },
		{ modelName: 'custom-1', type: 'custom', isHidden: false },
	]);
	assert.equal(Object.hasOwn(initial[1], 'description'), false);
	assert.equal(Object.hasOwn(initial[2], 'description'), false);

	const updated = _modelsWithSwappedInNewModels({
		existingModels: initial,
		models: ['a', 'b'],
		type: 'autodetected',
		descriptionOfModel: { a: 'seconda', b: 'nuova' },
	});
	assert.deepEqual(updated, [
		{ modelName: 'a', type: 'autodetected', isHidden: true, description: 'seconda' },
		{ modelName: 'b', type: 'autodetected', isHidden: false, description: 'nuova' },
		{ modelName: 'custom-1', type: 'custom', isHidden: false },
	]);

	const defaultModels = _modelsWithSwappedInNewModels({
		existingModels: [],
		models: ['a'],
		type: 'default',
		descriptionOfModel: { a: 'ignorata' },
	});
	assert.deepEqual(defaultModels, [{ modelName: 'a', type: 'default', isHidden: false }]);
	assert.equal(Object.hasOwn(defaultModels[0], 'description'), false);
});

test('setAutodetectedModels riscrive le impostazioni quando cambia la descrizione e salta se è identica', () => {
	const writes = [];
	const fakeService = {
		state: {
			settingsOfProvider: {
				voxLocal: { models: [] },
			},
		},
		setSettingOfProvider(providerName, settingName, newVal) {
			this.state.settingsOfProvider[providerName][settingName] = newVal;
			writes.push(newVal);
		},
		_preferLocalToCliFallback() { rechecks++; },
	};
	let rechecks = 0;

	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen'], { qwen: 'v1' });
	assert.equal(writes.length, 1);

	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen'], { qwen: 'v1' });
	assert.equal(writes.length, 1);

	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen'], { qwen: 'v2' });
	assert.equal(writes.length, 2);
	assert.equal(fakeService.state.settingsOfProvider.voxLocal.models[0].description, 'v2');

	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen']);
	assert.equal(writes.length, 3);
	assert.equal(Object.hasOwn(fakeService.state.settingsOfProvider.voxLocal.models[0], 'description'), false);

	// stesso elenco ma è cambiato l'uso di un modello: le impostazioni si riscrivono, così i modelli scelti si ricontrollano
	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen'], undefined, false);
	assert.equal(writes.length, 3);
	setAutodetectedModels.call(fakeService, 'voxLocal', ['qwen'], undefined, true);
	assert.equal(writes.length, 4);
	// a ogni rilevamento dei modelli locali si ricontrolla il ripiego verso le CLI, anche se l'elenco non cambia
	assert.equal(rechecks, 6);
});

test('_validatedModelState propaga description nelle ModelOption solo se presente', () => {
	const validated = _validatedModelState({
		settingsOfProvider: {
			voxLocal: {
				folder: '',
				_didFillInProviderSettings: undefined,
				models: [
					{ modelName: 'qwen', type: 'autodetected', isHidden: false, description: 'Chat veloce' },
					{ modelName: 'nascosto', type: 'autodetected', isHidden: true, description: 'Non visibile' },
					{ modelName: 'nudo', type: 'autodetected', isHidden: false },
				],
			},
			cliAgent: { _didFillInProviderSettings: true, models: [] },
		},
		modelSelectionOfFeature: { Chat: null },
		globalSettings: { chatMode: 'normal' },
		optionsOfModelSelection: { Chat: {} },
		overridesOfModel: { voxLocal: {}, cliAgent: {} },
		mcpUserStateOfName: {},
		lastModelOfCliAgent: {},
	});

	assert.deepEqual(validated._modelOptions, [
		{ name: 'qwen (voxLocal)', selection: { providerName: 'voxLocal', modelName: 'qwen' }, description: 'Chat veloce' },
		{ name: 'nudo (voxLocal)', selection: { providerName: 'voxLocal', modelName: 'nudo' } },
	]);
	assert.equal(Object.hasOwn(validated._modelOptions[1], 'description'), false);
});

test('lettura delle impostazioni salvate: le voci aggiunte dopo prendono il valore predefinito, come nell\'importazione', () => {
	const readStart = source.indexOf('\tasync readAndInitializeState() {');
	const readEnd = source.indexOf('\tprivate async _readState()', readStart);
	assert.ok(readStart > 0 && readEnd > readStart, 'forma di readAndInitializeState cambiata: aggiornare il test');
	const read = source.slice(readStart, readEnd);
	for (const key of ['settingsOfProvider', 'modelSelectionOfFeature', 'optionsOfModelSelection', 'globalSettings']) {
		assert.match(read, new RegExp(`${key}: \\{ \\.\\.\\.defaults\\.${key}, \\.\\.\\.readS\\.${key} \\}`), key);
	}
});
