// IA locali di Vox non configurate e configurate: stato del fornitore nelle impostazioni, senza avviare il workbench.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from './voxI18n.fixture.mjs';

const source = await readFile(new URL('./voxSettingsService.ts', import.meta.url), 'utf8');
// solo le funzioni pure fra la gestione dei modelli e lo stato predefinito; se i confini cambiano, il test lo dice
const start = source.indexOf('const _modelsWithSwappedInNewModels =');
const end = source.indexOf('const defaultState = () =>', start);
assert.ok(start >= 0 && end > start, 'forma di voxSettingsService.ts cambiata: aggiornare i confini del test');
const body = stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, '');

const providerNames = ['voxLocal', 'cliAgent'];
const featureNames = ['Chat', 'Autocomplete'];
const defaultProviderSettings = { voxLocal: { folder: '' }, cliAgent: { codexCommand: '' } };
// il modello di completamento delle IA locali, come lo indica il manifesto
const completionModels = new Set(['qwen2.5-coder-7b']);
const load = () => evaluate('providerNames', 'featureNames', 'defaultProviderSettings', 'defaultSettingsOfProvider', 'getModelCapabilities', 'isVoxLocalCompletionModel', 'modelSelectionsEqual', 'splitCliAgentModel',
	body + '; return { isVoxLocalConfigured, _validatedModelState, withCliFallbackForRemovedSelections };')(
	providerNames, featureNames, defaultProviderSettings, {},
	(providerName, modelName) => ({ supportsFIM: providerName === 'voxLocal' && completionModels.has(modelName) }),
	modelName => completionModels.has(modelName),
	(a, b) => !!a && !!b && a.providerName === b.providerName && a.modelName === b.modelName,
	modelName => ({ agent: modelName.split(':')[0], subModel: modelName.split(':')[1] ?? '' }),
);

const model = (modelName, isHidden = false) => ({ modelName, type: 'autodetected', isHidden });
const state = ({ folder = '', models = [], flag = true, chat = null, autocomplete = null, cli = [model('codex')] } = {}) => ({
	settingsOfProvider: {
		voxLocal: { folder, models, _didFillInProviderSettings: flag },
		cliAgent: { codexCommand: '', models: cli, _didFillInProviderSettings: true },
	},
	modelSelectionOfFeature: { Chat: chat, Autocomplete: autocomplete },
	globalSettings: { chatMode: 'normal' },
	overridesOfModel: {},
});

test('IA locali: cartella vuota e nessun modello rilevato = non configurate (senza errore); cartella o modelli = configurate', () => {
	const { isVoxLocalConfigured } = load();
	assert.equal(isVoxLocalConfigured({ folder: '', models: [] }), false);
	assert.equal(isVoxLocalConfigured({ folder: '   ', models: [] }), false);
	assert.equal(isVoxLocalConfigured({ folder: undefined, models: [] }), false);
	assert.equal(isVoxLocalConfigured({ folder: 'E:\\Vox\\ia-locali', models: [] }), true);
	assert.equal(isVoxLocalConfigured({ folder: '', models: [model('qwen3.5-9b')] }), true);
});

test('IA locali assenti: il fornitore non risulta configurato, non dà modelli e la chat resta senza modello (mai una CLI da sola)', () => {
	const { _validatedModelState } = load();
	// stato salvato dalla versione precedente, che considerava voxLocal sempre configurato
	const result = _validatedModelState(state({ chat: { providerName: 'voxLocal', modelName: 'qwen3.5-9b' } }));
	assert.equal(result.settingsOfProvider.voxLocal._didFillInProviderSettings, false);
	assert.ok(!result._modelOptions.some(option => option.selection.providerName === 'voxLocal'));
	// c'è una CLI visibile, ma chi aveva scelto un modello locale non viene spostato su un servizio esterno
	assert.ok(result._modelOptions.some(option => option.selection.providerName === 'cliAgent'));
	assert.equal(result.modelSelectionOfFeature.Chat, null);
	// le IA in CLI non cambiano
	assert.equal(result.settingsOfProvider.cliAgent._didFillInProviderSettings, true);
});

test('un modello locale sparito si sostituisce solo con un altro modello locale adatto alla funzione', () => {
	const { _validatedModelState } = load();
	const models = [model('qwen2.5-coder-7b'), model('qwen3.5-9b')];
	const result = _validatedModelState(state({
		models,
		chat: { providerName: 'voxLocal', modelName: 'non-più-nel-manifesto' },
		autocomplete: { providerName: 'voxLocal', modelName: 'non-più-nel-manifesto' },
	}));
	// la chat salta il modello di completamento, che è il primo dell'elenco; il completamento prende solo quello
	assert.deepEqual(result.modelSelectionOfFeature.Chat, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
	assert.deepEqual(result.modelSelectionOfFeature.Autocomplete, { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' });
	// con il solo modello di completamento la chat resta senza modello, non passa alla CLI
	const onlyCompletion = _validatedModelState(state({ models: [model('qwen2.5-coder-7b')], chat: { providerName: 'voxLocal', modelName: 'qwen3.5-9b' } }));
	assert.equal(onlyCompletion.modelSelectionOfFeature.Chat, null);
	// una CLI scelta dall'utente resta; un modello di completamento scelto per la chat non è valido
	const cliChosen = _validatedModelState(state({ models, chat: { providerName: 'cliAgent', modelName: 'codex' } }));
	assert.deepEqual(cliChosen.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
	const completionInChat = _validatedModelState(state({ models, chat: { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' } }));
	assert.deepEqual(completionInChat.modelSelectionOfFeature.Chat, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
	// il completamento automatico non accetta né un modello da chat né una CLI
	const wrongAutocomplete = _validatedModelState(state({ models: [model('qwen3.5-9b')], autocomplete: { providerName: 'cliAgent', modelName: 'codex' } }));
	assert.equal(wrongAutocomplete.modelSelectionOfFeature.Autocomplete, null);
});

test('passaggio dai fornitori tolti: senza un modello locale la funzione passa alla prima CLI visibile, il completamento mai', () => {
	const { _validatedModelState, withCliFallbackForRemovedSelections } = load();
	const removed = [
		{ featureName: 'Chat', providerName: 'anthropic', modelName: 'claude-opus-4-0' },
		{ featureName: 'Autocomplete', providerName: 'mistral', modelName: 'codestral-latest' },
	];
	// la pulizia ha già messo a null i modelli dei fornitori tolti; la convalida non trova modelli locali
	const noLocal = _validatedModelState(state({ cli: [model('nascosta', true), model('codex'), model('claude')] }));
	const withCli = withCliFallbackForRemovedSelections(noLocal, removed);
	assert.deepEqual(withCli.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
	assert.equal(withCli.modelSelectionOfFeature.Autocomplete, null);
	assert.equal(noLocal.modelSelectionOfFeature.Chat, null, 'lo stato di partenza non va modificato');

	// se la convalida ha già trovato un modello locale, quello resta
	const local = _validatedModelState(state({ models: [model('qwen3.5-9b'), model('qwen2.5-coder-7b')] }));
	assert.deepEqual(local.modelSelectionOfFeature, { Chat: { providerName: 'voxLocal', modelName: 'qwen3.5-9b' }, Autocomplete: { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' } });
	assert.equal(withCliFallbackForRemovedSelections(local, removed), local);

	// senza modelli locali né CLI visibili la funzione resta senza modello, senza errori
	const nothing = _validatedModelState(state({ cli: [model('codex', true)] }));
	assert.equal(withCliFallbackForRemovedSelections(nothing, removed).modelSelectionOfFeature.Chat, null);

	// vale solo per le funzioni che avevano un fornitore tolto: le altre restano come sono, e un nome sconosciuto si ignora
	const onlyAutocomplete = withCliFallbackForRemovedSelections(noLocal, [removed[1], { featureName: 'Inesistente', providerName: 'openAI', modelName: 'gpt-4o' }]);
	assert.equal(onlyAutocomplete, noLocal);
	assert.equal(withCliFallbackForRemovedSelections(noLocal, []), noLocal);
});

test('IA locali presenti: configurate con i modelli rilevati o con la cartella salvata, e la scelta resta', () => {
	const { _validatedModelState } = load();
	const found = _validatedModelState(state({ flag: false, models: [model('qwen3.5-9b')], chat: { providerName: 'voxLocal', modelName: 'qwen3.5-9b' } }));
	assert.equal(found.settingsOfProvider.voxLocal._didFillInProviderSettings, true);
	assert.ok(found._modelOptions.some(option => option.selection.providerName === 'voxLocal' && option.selection.modelName === 'qwen3.5-9b'));
	assert.deepEqual(found.modelSelectionOfFeature.Chat, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
	// cartella scelta ma ancora senza modelli (per esempio file mancanti): configurate, così l'errore vero si vede
	const chosen = _validatedModelState(state({ flag: false, folder: 'E:\\Vox\\ia-locali' }));
	assert.equal(chosen.settingsOfProvider.voxLocal._didFillInProviderSettings, true);
});
