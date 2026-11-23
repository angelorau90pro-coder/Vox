import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./removedProviders.ts', import.meta.url), 'utf8');
assert.equal(/^import /m.test(source), false, 'removedProviders.ts deve restare senza importazioni: aggiornare il test');
const body = stripTypeScriptTypes(source).replace(/^export /gm, '');
const { removedProviderNames, cleanRemovedProviders, isRemovedProviderName, titleOfRemovedProvider, endpointWithoutCredentials } = new Function(
	`${body}\nreturn { removedProviderNames, cleanRemovedProviders, isRemovedProviderName, titleOfRemovedProvider, endpointWithoutCredentials };`,
)();

// i fornitori che esistono ancora, letti dalla sorgente: nessuno di loro deve comparire fra quelli tolti
const capabilities = await readFile(new URL('./modelCapabilities.ts', import.meta.url), 'utf8');
const settingsStart = capabilities.indexOf('export const defaultProviderSettings = {');
const settingsEnd = capabilities.indexOf('} as const', settingsStart);
assert.ok(settingsStart !== -1 && settingsEnd > settingsStart, 'forma di defaultProviderSettings cambiata: aggiornare il test');
const currentProviderNames = [...capabilities.slice(settingsStart, settingsEnd).matchAll(/^\t([A-Za-z]+): \{/gm)].map(match => match[1]);

test('i fornitori rimasti sono solo le IA locali di Vox e le IA in CLI', () => {
	assert.deepEqual(currentProviderNames, ['voxLocal', 'cliAgent']);
	for (const name of currentProviderNames) assert.equal(isRemovedProviderName(name), false);
	assert.equal(removedProviderNames.length, 16);
	assert.equal(new Set(removedProviderNames).size, 16);
});

test('isRemovedProviderName e titleOfRemovedProvider non si fidano del valore ricevuto', () => {
	assert.equal(isRemovedProviderName('anthropic'), true);
	assert.equal(isRemovedProviderName('Anthropic'), false);
	assert.equal(isRemovedProviderName(undefined), false);
	assert.equal(isRemovedProviderName({ toString: () => 'anthropic' }), false);
	assert.equal(titleOfRemovedProvider('lmStudio'), 'LM Studio');
	assert.equal(titleOfRemovedProvider('toString'), 'toString');
	assert.equal(titleOfRemovedProvider('sconosciuto'), 'sconosciuto');
});

const oldState = () => ({
	settingsOfProvider: {
		voxLocal: { folder: 'E:\\Vox\\ia-locali', models: [{ modelName: 'qwen', type: 'autodetected', isHidden: false }], _didFillInProviderSettings: true },
		cliAgent: { codexCommand: '', timeoutSeconds: '600', models: [{ modelName: 'codex', type: 'custom', isHidden: false }], _didFillInProviderSettings: true },
		anthropic: { apiKey: 'sk-ant-segreta', models: [{ modelName: 'claude-opus-4-0', type: 'default', isHidden: false }], _didFillInProviderSettings: true },
		openAI: { apiKey: '', models: [], _didFillInProviderSettings: false },
		openAICompatible: { endpoint: 'https://esempio.it/v1', apiKey: 'sk-chiave', headersJSON: '{"Authorization":"Bearer abc"}', models: [{ modelName: 'mio', type: 'custom', isHidden: false }], _didFillInProviderSettings: true },
		ollama: { endpoint: 'http://127.0.0.1:11434', models: [{ modelName: 'llama3.1', type: 'autodetected', isHidden: false }], _didFillInProviderSettings: true },
		liteLLM: { endpoint: 'https://utente:parola@proxy.esempio.it', models: [] },
		awsBedrock: { apiKey: 'chiave-aws', region: 'us-east-1', endpoint: 'https://gw.esempio.it/openai?key=abc', models: [] },
		googleVertex: { region: 'us-west2', project: 'mio-progetto', models: [] },
		mistral: { apiKey: 12345, models: [] },
	},
	modelSelectionOfFeature: {
		Chat: { providerName: 'anthropic', modelName: 'claude-opus-4-0' },
		'Ctrl+K': { providerName: 'voxLocal', modelName: 'qwen' },
		Autocomplete: { providerName: 'ollama', modelName: 'qwen2.5-coder:3b' },
		Apply: { providerName: 'cliAgent', modelName: 'codex' },
		SCM: null,
	},
	optionsOfModelSelection: { Chat: { anthropic: { 'claude-opus-4-0': { reasoningEnabled: true } } } },
	overridesOfModel: { anthropic: { 'claude-opus-4-0': { contextWindow: 1000 } }, voxLocal: {} },
	globalSettings: { aiInstructions: 'non toccare i commenti', chatMode: 'agent' },
	mcpUserStateOfName: { server: { isOn: true } },
	lastModelOfCliAgent: { codex: '' },
});

test('endpointWithoutCredentials toglie utente, password e parametri e lascia il resto dell\'indirizzo', () => {
	for (const [endpoint, expected] of [
		['https://esempio.it/v1', 'https://esempio.it/v1'],
		['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
		['https://utente:parola@proxy.esempio.it/v1', 'https://proxy.esempio.it/v1'],
		['https://gettone@proxy.esempio.it', 'https://proxy.esempio.it'],
		['//utente:parola@proxy.esempio.it/v1', '//proxy.esempio.it/v1'],
		['https://gw.esempio.it/openai?key=abc', 'https://gw.esempio.it/openai'],
		['https://gw.esempio.it/openai?version=2', 'https://gw.esempio.it/openai'],
		['https://gw.esempio.it/openai?a=1\n&key=abc#x', 'https://gw.esempio.it/openai'],
		['https://gw.esempio.it/openai#key=abc', 'https://gw.esempio.it/openai'],
		['https://u:p@gw.esempio.it:8443/a/b?key=abc', 'https://gw.esempio.it:8443/a/b'],
		// una password con dentro una chiocciola: via tutto fino all'host
		['https://alice:secret@bob:other@esempio.invalid:8443/v1', 'https://esempio.invalid:8443/v1'],
		['https://utente:pa ss@esempio.invalid/v1', 'https://esempio.invalid/v1'],
		// barre mancanti, in più o rovesciate dopo lo schema: chi legge gli indirizzi le accetta
		['https:///alice:secret@esempio.invalid/v1', 'https:///esempio.invalid/v1'],
		['https:alice:secret@esempio.invalid/v1', 'https:esempio.invalid/v1'],
		['https:\\\\alice:secret@esempio.invalid/v1', 'https:\\\\esempio.invalid/v1'],
		['HTTP://alice:secret@esempio.invalid/v1', 'HTTP://esempio.invalid/v1'],
		[' https://alice:secret@esempio.invalid/v1', ' https://esempio.invalid/v1'],
		// senza schema
		['alice:secret@esempio.invalid/v1', 'esempio.invalid/v1'],
		// una tabulazione dentro lo schema viene ignorata da chi legge l'indirizzo: interviene la seconda rete
		['ht\ttps://alice:secret@esempio.invalid/v1', 'https://esempio.invalid/v1'],
		// altri schemi: solo dopo le due barre; una chiocciola nel percorso resta
		['ftp://alice:secret@esempio.invalid/v1', 'ftp://esempio.invalid/v1'],
		['file:///modelli@revisione/v1', 'file:///modelli@revisione/v1'],
		// una chiocciola nel percorso non è un nome utente
		['https://esempio.it/utenti/a@b', 'https://esempio.it/utenti/a@b'],
		['', ''],
	]) assert.equal(endpointWithoutCredentials(endpoint), expected, endpoint);
});

test('cleanRemovedProviders cancella chiavi, intestazioni e indirizzi con credenziali dei fornitori tolti', () => {
	const state = oldState();
	const cleanup = cleanRemovedProviders(state);

	assert.equal(cleanup.changed, true);
	assert.deepEqual(cleanup.providersWithRemovedSecrets, ['anthropic', 'openAICompatible', 'mistral', 'liteLLM', 'awsBedrock']);

	const s = state.settingsOfProvider;
	for (const name of removedProviderNames) {
		if (!s[name]) continue;
		assert.equal(Object.hasOwn(s[name], 'apiKey'), false, `apiKey di ${name} ancora presente`);
		assert.equal(Object.hasOwn(s[name], 'headersJSON'), false, `headersJSON di ${name} ancora presente`);
	}
	// nessuna chiave resta in nessun punto dello stato
	const text = JSON.stringify(state);
	for (const secret of ['sk-ant-segreta', 'sk-chiave', 'Bearer abc', 'chiave-aws', 'parola', 'key=abc', '12345']) {
		assert.equal(text.includes(secret), false, `segreto ancora presente: ${secret}`);
	}
	// gli indirizzi senza credenziali e il resto dei dati dei fornitori tolti restano
	assert.equal(s.openAICompatible.endpoint, 'https://esempio.it/v1');
	assert.equal(s.ollama.endpoint, 'http://127.0.0.1:11434');
	// gli indirizzi con credenziali restano senza: via utente e password, via i parametri dopo `?`
	assert.equal(s.liteLLM.endpoint, 'https://proxy.esempio.it');
	assert.equal(s.awsBedrock.endpoint, 'https://gw.esempio.it/openai');
	assert.equal(s.awsBedrock.region, 'us-east-1');
	assert.deepEqual(s.googleVertex, { region: 'us-west2', project: 'mio-progetto', models: [] });
	assert.deepEqual(s.anthropic.models, [{ modelName: 'claude-opus-4-0', type: 'default', isHidden: false }]);
	assert.deepEqual(s.openAICompatible.models, [{ modelName: 'mio', type: 'custom', isHidden: false }]);
});

test('cleanRemovedProviders non tocca i fornitori rimasti né le altre impostazioni', () => {
	const state = oldState();
	const before = oldState();
	cleanRemovedProviders(state);
	assert.deepEqual(state.settingsOfProvider.voxLocal, before.settingsOfProvider.voxLocal);
	assert.deepEqual(state.settingsOfProvider.cliAgent, before.settingsOfProvider.cliAgent);
	assert.deepEqual(state.optionsOfModelSelection, before.optionsOfModelSelection);
	assert.deepEqual(state.overridesOfModel, before.overridesOfModel);
	assert.deepEqual(state.globalSettings, before.globalSettings);
	assert.deepEqual(state.mcpUserStateOfName, before.mcpUserStateOfName);
	assert.deepEqual(state.lastModelOfCliAgent, before.lastModelOfCliAgent);
});

test('cleanRemovedProviders azzera solo i modelli scelti dei fornitori tolti e li elenca', () => {
	const state = oldState();
	const cleanup = cleanRemovedProviders(state);
	assert.deepEqual(cleanup.removedSelections, [
		{ featureName: 'Chat', providerName: 'anthropic', modelName: 'claude-opus-4-0' },
		{ featureName: 'Autocomplete', providerName: 'ollama', modelName: 'qwen2.5-coder:3b' },
	]);
	assert.deepEqual(state.modelSelectionOfFeature, {
		Chat: null,
		'Ctrl+K': { providerName: 'voxLocal', modelName: 'qwen' },
		Autocomplete: null,
		Apply: { providerName: 'cliAgent', modelName: 'codex' },
		SCM: null,
	});
});

test('cleanRemovedProviders è idempotente: la seconda volta non cambia niente', () => {
	const state = oldState();
	cleanRemovedProviders(state);
	const afterFirst = JSON.parse(JSON.stringify(state));
	const second = cleanRemovedProviders(state);
	assert.deepEqual(second, { changed: false, providersWithRemovedSecrets: [], removedSelections: [] });
	assert.deepEqual(state, afterFirst);
});

test('cleanRemovedProviders: uno stato nuovo o senza fornitori tolti non cambia', () => {
	const state = {
		settingsOfProvider: { voxLocal: { folder: '', models: [] }, cliAgent: { timeoutSeconds: '600', models: [] } },
		modelSelectionOfFeature: { Chat: null, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null },
	};
	const before = JSON.parse(JSON.stringify(state));
	assert.deepEqual(cleanRemovedProviders(state), { changed: false, providersWithRemovedSecrets: [], removedSelections: [] });
	assert.deepEqual(state, before);
});

test('cleanRemovedProviders regge uno stato rovinato senza lanciare eccezioni', () => {
	const empty = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] };
	for (const broken of [null, undefined, 'testo', 42, [], {}, { settingsOfProvider: null }, { settingsOfProvider: [], modelSelectionOfFeature: 'x' }, { settingsOfProvider: { anthropic: 'x', openAI: null, gemini: [] }, modelSelectionOfFeature: { Chat: 'anthropic', SCM: [] } }]) {
		assert.deepEqual(cleanRemovedProviders(broken), empty);
	}
	// una chiave con apiKey vuota si toglie (lo stato cambia) ma non conta come segreto cancellato
	const state = { settingsOfProvider: { openAI: { apiKey: '   ', models: [] }, openAICompatible: { headersJSON: ' {} ' } } };
	assert.deepEqual(cleanRemovedProviders(state), { changed: true, providersWithRemovedSecrets: [], removedSelections: [] });
	assert.deepEqual(state, { settingsOfProvider: { openAI: { models: [] }, openAICompatible: {} } });
	// modello scelto senza nome
	const noName = { modelSelectionOfFeature: { Chat: { providerName: 'gemini' } } };
	assert.deepEqual(cleanRemovedProviders(noName).removedSelections, [{ featureName: 'Chat', providerName: 'gemini', modelName: '' }]);
	assert.equal(noName.modelSelectionOfFeature.Chat, null);
});

test('cleanRemovedProviders con secretsOnly toglie solo i segreti e lascia i modelli scelti (copia sotto la chiave precedente)', () => {
	const state = {
		settingsOfProvider: {
			anthropic: { apiKey: 'chiave-fittizia', models: [{ modelName: 'claude-opus-4-0' }] },
			openAICompatible: { endpoint: 'https://esempio.invalid/v1', headersJSON: '{"Authorization":"Bearer x"}' },
			voxLocal: { folder: 'E:/ia-locali', models: [] },
		},
		modelSelectionOfFeature: { Chat: { providerName: 'anthropic', modelName: 'claude-opus-4-0' }, Autocomplete: { providerName: 'ollama', modelName: 'llama3' }, SCM: null },
	};
	const selections = JSON.parse(JSON.stringify(state.modelSelectionOfFeature));
	assert.deepEqual(cleanRemovedProviders(state, { secretsOnly: true }), { changed: true, providersWithRemovedSecrets: ['anthropic', 'openAICompatible'], removedSelections: [] });
	assert.deepEqual(state.modelSelectionOfFeature, selections);
	assert.deepEqual(state.settingsOfProvider, {
		anthropic: { models: [{ modelName: 'claude-opus-4-0' }] },
		openAICompatible: { endpoint: 'https://esempio.invalid/v1' },
		voxLocal: { folder: 'E:/ia-locali', models: [] },
	});
	// la seconda volta non c'è più niente da togliere, anche se i modelli scelti sono ancora quelli dei fornitori tolti
	assert.deepEqual(cleanRemovedProviders(state, { secretsOnly: true }), { changed: false, providersWithRemovedSecrets: [], removedSelections: [] });
	// senza l'opzione i modelli scelti si azzerano
	assert.equal(cleanRemovedProviders(state).removedSelections.length, 2);
});
