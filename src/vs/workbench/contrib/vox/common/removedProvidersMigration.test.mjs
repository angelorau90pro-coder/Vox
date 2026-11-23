// Passaggio alle sole IA locali e IA in CLI con le impostazioni di una versione precedente: il servizio delle
// impostazioni vero (moduli comuni interi e metodi della classe), con salvataggio e cifratura finti in memoria.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from './voxI18n.fixture.mjs';

const read = async file => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const withoutImports = source => source.replace(/^import [^;]*;?[ \t]*\n/gm, '');
const between = (source, start, end) => {
	const from = source.indexOf(start), to = source.indexOf(end, from);
	assert.ok(from >= 0 && to > from, `forma di voxSettingsService.ts cambiata, sezione non trovata: ${start}`);
	return source.slice(from, to);
};
const settings = await read('./voxSettingsService.ts');
// i moduli comuni per intero, più le funzioni pure e i metodi della classe che leggono, puliscono e salvano
const modules = (await Promise.all(['./modelCapabilities.ts', './voxSettingsTypes.ts', './storageKeys.ts', './removedProviders.ts', './voxLocalModelInfo.ts', './removedProvidersNotice.ts'].map(read))).map(withoutImports);
const serviceClass = `class Service {
	constructor(storageService, encryptionService) {
		this._storageService = storageService; this._encryptionService = encryptionService
		this.state = defaultState(); this.changes = 0
		this._resolver = () => { }; this._onDidChangeState = { fire: () => { this.changes++ } }
		this.notices = 0; this._onDidStoreRemovedProvidersNotice = { fire: () => { this.notices++ } }
		this.syncs = []; this._onUpdate_syncApplyToChat = () => { this.syncs.push('Apply') }; this._onUpdate_syncSCMToChat = () => { this.syncs.push('SCM') }
		this._cliFallbackToRecheck = null
	}
${between(settings, '\tdangerousSetState = async', '\n\tprivate _onUpdate_syncApplyToChat()')}
${between(settings, '\tsetModelSelectionOfFeature: SetModelSelectionOfFeatureFn =', '\n\tsetOptionsOfModelSelection =')}
${between(settings, '\tsetAutodetectedModels(providerName: ProviderName, autodetectedModelNames', '\n\ttoggleModelHidden(')}
}`;
const body = stripTypeScriptTypes([...modules, between(settings, 'const _modelsWithSwappedInNewModels', 'export const IVoxSettingsService ='), serviceClass].join('\n')).replace(/^export /gm, '');
const load = () => evaluate('deepClone', 'StorageScope', 'StorageTarget', body + `
return { Service, defaultState, textOfRemovedProvidersNotice, removedProviderNames, getModelCapabilities, setVoxLocalContextWindows,
	VOX_SETTINGS_STORAGE_KEY, VOX_REMOVED_PROVIDERS_NOTICE_KEY, VOX_LOCAL_CONTEXT_WINDOWS_KEY, VOX_LOCAL_COMPLETION_MODELS_KEY };`,
)(structuredClone, { APPLICATION: 'application' }, { USER: 'user', MACHINE: 'machine' });

const api = load();
const KEY = api.VOX_SETTINGS_STORAGE_KEY, NOTICE_KEY = api.VOX_REMOVED_PROVIDERS_NOTICE_KEY;
assert.ok(KEY && NOTICE_KEY);

// cifratura finta: reversibile, riconoscibile e che rifiuta ciò che non ha cifrato lei
const encryption = {
	encrypt: async text => 'cifrato:' + Buffer.from(text, 'utf8').toString('base64'),
	decrypt: async text => { if (!text.startsWith('cifrato:')) throw new Error('non decifrabile'); return Buffer.from(text.slice('cifrato:'.length), 'base64').toString('utf8'); },
};
const encrypted = value => 'cifrato:' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const decrypted = text => JSON.parse(Buffer.from(text.slice('cifrato:'.length), 'base64').toString('utf8'));
const storageOf = (initial = {}) => {
	const map = new Map(Object.entries(initial)), writes = [], removals = [];
	return {
		map, writes, removals,
		get: (key, scope) => { assert.equal(scope, 'application'); return map.get(key); },
		store: (key, value, scope, target) => { assert.equal(scope, 'application'); writes.push([key, target]); map.set(key, value); },
		remove: (key, scope) => { assert.equal(scope, 'application'); removals.push(key); map.delete(key); },
	};
};
const start = async (storage, modules = api) => {
	const service = new modules.Service(storage, encryption);
	await service.readAndInitializeState();
	return service;
};
// per i casi in cui il servizio segnala un problema sulla console: lo raccoglie invece di sporcare l'uscita dei test
const quietly = async fn => {
	const errors = [], consoleError = console.error;
	console.error = (...args) => errors.push(args);
	try { return { result: await fn(), errors }; } finally { console.error = consoleError; }
};
const names = { featureTitle: name => `«${name}»`, providerTitle: name => ({ voxLocal: 'IA locali', cliAgent: 'IA in CLI' })[name] ?? name };
const model = (modelName, type = 'autodetected', isHidden = false) => ({ modelName, type, isHidden });
const SECRETS = ['sk-ant-segreta', 'sk-openai-segreta', 'Bearer segreta', 'utente:parola', 'AIza-segreta'];

// Impostazioni come le salvava la versione con i fornitori in cloud: chiavi, modelli scelti, opzioni e modifiche.
const oldSettings = ({ local = [], cli = [model('codex'), model('claude')], folder = '' } = {}) => {
	const state = api.defaultState();
	state.settingsOfProvider.voxLocal = { ...state.settingsOfProvider.voxLocal, folder, models: local };
	state.settingsOfProvider.cliAgent = { ...state.settingsOfProvider.cliAgent, models: cli };
	Object.assign(state.settingsOfProvider, {
		anthropic: { apiKey: SECRETS[0], models: [model('claude-opus-4-0', 'default'), model('mio-claude', 'custom')], _didFillInProviderSettings: true },
		openAI: { apiKey: SECRETS[1], models: [model('gpt-4o', 'default')], _didFillInProviderSettings: true },
		openAICompatible: { endpoint: 'https://esempio.invalid/v1', apiKey: '', headersJSON: `{"Authorization":"${SECRETS[2]}"}`, models: [model('mio-modello', 'custom')], _didFillInProviderSettings: true },
		liteLLM: { endpoint: `https://${SECRETS[3]}@esempio.invalid/v1`, models: [], _didFillInProviderSettings: true },
		gemini: { apiKey: SECRETS[4], models: [model('gemini-2.5-pro', 'default')], _didFillInProviderSettings: true },
		ollama: { endpoint: 'http://127.0.0.1:11434', models: [model('llama3')], _didFillInProviderSettings: true },
		mistral: { apiKey: '', models: [model('codestral-latest', 'default')], _didFillInProviderSettings: false },
	});
	state.modelSelectionOfFeature = {
		Chat: { providerName: 'anthropic', modelName: 'claude-opus-4-0' },
		'Ctrl+K': { providerName: 'anthropic', modelName: 'claude-opus-4-0' },
		Autocomplete: { providerName: 'ollama', modelName: 'llama3' },
		Apply: { providerName: 'openAI', modelName: 'gpt-4o' },
		SCM: { providerName: 'cliAgent', modelName: 'claude' },
	};
	state.optionsOfModelSelection.Chat = { anthropic: { 'claude-opus-4-0': { reasoningEnabled: true } } };
	state.overridesOfModel = { ...state.overridesOfModel, anthropic: { 'mio-claude': { contextWindow: 200000 } } };
	state.globalSettings = { ...state.globalSettings, aiInstructions: 'rispondi in italiano', isOnboardingComplete: true };
	state.mcpUserStateOfName = { mioServer: { isOn: true } };
	state.lastModelOfCliAgent = { codex: 'gpt-x' };
	delete state._modelOptions;
	return state;
};
const withoutSecrets = text => SECRETS.every(secret => !text.includes(secret));

test('la prova usa il codice vero: solo due fornitori e nessuna chiave fra le impostazioni predefinite', () => {
	const state = api.defaultState();
	assert.deepEqual(Object.keys(state.settingsOfProvider), ['voxLocal', 'cliAgent']);
	assert.equal(JSON.stringify(state).includes('apiKey'), false);
	assert.equal(api.removedProviderNames.length, 16);
});

test('primo avvio con impostazioni vecchie e modelli locali: chiavi via dal disco, il resto resta, i modelli passano a quelli locali', async () => {
	const old = oldSettings({ folder: 'E:\\Vox\\ia-locali', local: [model('qwen2.5-coder-7b'), model('qwen3.5-9b')] });
	const storage = storageOf({
		[KEY]: encrypted(old),
		[api.VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"qwen2.5-coder-7b":8192,"qwen3.5-9b":8192}', [api.VOX_LOCAL_COMPLETION_MODELS_KEY]: '["qwen2.5-coder-7b"]',
	});
	const service = await start(storage);

	// modelli scelti: i fornitori tolti passano a un modello locale adatto; la CLI scelta dall'utente resta
	const local = modelName => ({ providerName: 'voxLocal', modelName });
	assert.deepEqual(service.state.modelSelectionOfFeature, {
		Chat: local('qwen3.5-9b'), 'Ctrl+K': local('qwen3.5-9b'), Autocomplete: local('qwen2.5-coder-7b'), Apply: local('qwen3.5-9b'),
		SCM: { providerName: 'cliAgent', modelName: 'claude' },
	});
	// nel menu restano solo i due motori
	assert.deepEqual([...new Set(service.state._modelOptions.map(option => option.selection.providerName))], ['voxLocal', 'cliAgent']);

	// sul disco, sotto la chiave attuale: nessun segreto, e tutto il resto com'era
	const saved = decrypted(storage.map.get(KEY));
	assert.ok(withoutSecrets(JSON.stringify(saved)));
	for (const providerName of ['anthropic', 'openAI', 'gemini', 'mistral']) assert.equal('apiKey' in saved.settingsOfProvider[providerName], false, providerName);
	assert.equal('headersJSON' in saved.settingsOfProvider.openAICompatible, false);
	// l'indirizzo con utente e password resta, senza di loro
	assert.equal(saved.settingsOfProvider.liteLLM.endpoint, 'https://esempio.invalid/v1');
	assert.equal(saved.settingsOfProvider.openAICompatible.endpoint, 'https://esempio.invalid/v1');
	assert.equal(saved.settingsOfProvider.ollama.endpoint, 'http://127.0.0.1:11434');
	assert.deepEqual(saved.settingsOfProvider.anthropic.models, old.settingsOfProvider.anthropic.models);
	assert.deepEqual(saved.settingsOfProvider.ollama.models, old.settingsOfProvider.ollama.models);
	assert.deepEqual(saved.optionsOfModelSelection.Chat, old.optionsOfModelSelection.Chat);
	assert.deepEqual(saved.overridesOfModel.anthropic, old.overridesOfModel.anthropic);
	assert.equal(saved.globalSettings.aiInstructions, 'rispondi in italiano');
	assert.equal(saved.globalSettings.isOnboardingComplete, true);
	assert.deepEqual(saved.mcpUserStateOfName, old.mcpUserStateOfName);
	assert.deepEqual(saved.lastModelOfCliAgent, { codex: 'gpt-x', claude: '' });
	assert.equal(saved.settingsOfProvider.voxLocal.folder, 'E:\\Vox\\ia-locali');

	assert.deepEqual(storage.removals, []);
	// nessun segreto in nessun valore salvato, nemmeno nell'avviso
	for (const [key, value] of storage.map) assert.ok(withoutSecrets(key.startsWith('vox.voxLocal') || key === NOTICE_KEY ? value : JSON.stringify(decrypted(value))), key);
	assert.ok(withoutSecrets(storage.map.get(NOTICE_KEY)));

	// l'avviso: salvato, mostrato una volta sola, con chiavi cancellate e sostituzioni
	const notice = service.takeRemovedProvidersNotice();
	assert.deepEqual(notice.providersWithRemovedSecrets, ['anthropic', 'openAI', 'openAICompatible', 'gemini', 'liteLLM']);
	assert.deepEqual(notice.replacedSelections.map(s => [s.featureName, s.providerName, s.replacement?.modelName]), [
		['Chat', 'anthropic', 'qwen3.5-9b'], ['Ctrl+K', 'anthropic', 'qwen3.5-9b'], ['Autocomplete', 'ollama', 'qwen2.5-coder-7b'], ['Apply', 'openAI', 'qwen3.5-9b'],
	]);
	const text = api.textOfRemovedProvidersNotice(notice, names);
	assert.equal(text, 'Vox ora usa solo le IA locali e le IA in CLI installate su questo PC: gli altri fornitori sono stati tolti.'
		+ ' Le chiavi API e le altre credenziali salvate di questi fornitori sono state cancellate dalle impostazioni: Anthropic, OpenAI, OpenAI-Compatible, Gemini, LiteLLM.'
		+ ' «Chat», «Ctrl+K»: claude-opus-4-0 (Anthropic) è stato sostituito con qwen3.5-9b (IA locali).'
		+ ' «Autocomplete»: llama3 (Ollama) è stato sostituito con qwen2.5-coder-7b (IA locali).'
		+ ' «Apply»: gpt-4o (OpenAI) è stato sostituito con qwen3.5-9b (IA locali).');
	assert.equal(service.takeRemovedProvidersNotice(), null);
	assert.equal(storage.map.has(NOTICE_KEY), false);
});

test('senza modelli locali le funzioni passano alla CLI visibile; il completamento automatico resta senza modello', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings({ cli: [model('codex', 'autodetected', true), model('claude'), model('agy')] })) });
	const service = await start(storage);
	const cli = { providerName: 'cliAgent', modelName: 'claude' };
	assert.deepEqual(service.state.modelSelectionOfFeature, { Chat: cli, 'Ctrl+K': cli, Autocomplete: null, Apply: cli, SCM: cli });
	const text = api.textOfRemovedProvidersNotice(service.takeRemovedProvidersNotice(), names);
	assert.ok(text.includes('«Chat», «Ctrl+K»: claude-opus-4-0 (Anthropic) è stato sostituito con claude (IA in CLI).'), text);
	assert.ok(text.includes('«Autocomplete»: llama3 (Ollama) non è più disponibile e non c\'è un modello con cui sostituirlo. Scegline uno nelle Impostazioni di Vox.'), text);
	// la scelta salvata è quella che l'avviso dichiara
	assert.deepEqual(decrypted(storage.map.get(KEY)).modelSelectionOfFeature.Chat, cli);
});

test('primo avvio dopo l\'aggiornamento: il modello di completamento si scopre a finestra aperta e l\'avviso lo riporta', async () => {
	// la versione precedente non salvava quali modelli locali sono di completamento: all'avvio non se ne conosce nessuno
	const old = oldSettings({ folder: 'E:\\Vox\\ia-locali', local: [model('qwen3.5-9b')] });
	const storage = storageOf({ [KEY]: encrypted(old), [api.VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"qwen3.5-9b":8192}' });
	const service = await start(storage);
	assert.equal(service.state.modelSelectionOfFeature.Autocomplete, null);
	const saved = JSON.parse(storage.map.get(NOTICE_KEY));
	assert.equal(saved.replacedSelections.find(s => s.featureName === 'Autocomplete').replacement, null);
	// il rilevamento trova il modello di completamento e la funzione lo prende, prima che l'avviso venga mostrato
	const completion = { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' };
	service.state = { ...service.state, modelSelectionOfFeature: { ...service.state.modelSelectionOfFeature, Autocomplete: completion } };
	const notice = service.takeRemovedProvidersNotice();
	assert.deepEqual(notice.replacedSelections.find(s => s.featureName === 'Autocomplete').replacement, completion);
	const text = api.textOfRemovedProvidersNotice(notice, names);
	assert.ok(text.includes('«Autocomplete»: llama3 (Ollama) è stato sostituito con qwen2.5-coder-7b (IA locali).'), text);
	assert.equal(text.includes('non c\'è un modello con cui sostituirlo'), false, text);
	// le altre funzioni compaiono con il modello che hanno in quel momento
	assert.deepEqual(notice.replacedSelections.find(s => s.featureName === 'Chat').replacement, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
	assert.equal(service.takeRemovedProvidersNotice(), null);
});

test('senza modelli locali né CLI: nessun errore, le funzioni restano senza modello e l\'avviso lo dice', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings({ cli: [] })) });
	const service = await start(storage);
	assert.deepEqual(service.state.modelSelectionOfFeature, { Chat: null, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null });
	assert.deepEqual(service.state._modelOptions, []);
	const notice = service.takeRemovedProvidersNotice();
	assert.ok(notice.replacedSelections.every(s => s.replacement === null));
	assert.match(api.textOfRemovedProvidersNotice(notice, names), /non è più disponibile e non c'è un modello con cui sostituirlo/);
});

test('secondo avvio: niente da pulire, nessuna scrittura e nessun avviso; lo stato è lo stesso', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings({ local: [model('qwen3.5-9b')] })) });
	const first = await start(storage);
	first.takeRemovedProvidersNotice();
	const savedAfterFirst = new Map(storage.map);
	storage.writes.length = 0;
	const second = await start(storage);
	assert.deepEqual(storage.writes, []);
	assert.deepEqual(new Map(storage.map), savedAfterFirst);
	assert.equal(second.takeRemovedProvidersNotice(), null);
	assert.deepEqual(second.state.modelSelectionOfFeature, first.state.modelSelectionOfFeature);
	assert.deepEqual(second.state.settingsOfProvider, first.state.settingsOfProvider);
});

test('un avviso non ancora mostrato non si perde se Vox viene chiuso subito, e non si ripete dopo essere stato mostrato', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings()) });
	await start(storage); // chiuso senza mostrare l'avviso
	const second = await start(storage);
	const notice = second.takeRemovedProvidersNotice();
	assert.deepEqual(notice.providersWithRemovedSecrets, ['anthropic', 'openAI', 'openAICompatible', 'gemini', 'liteLLM']);
	assert.equal(notice.replacedSelections.length, 4);
	assert.equal((await start(storage)).takeRemovedProvidersNotice(), null);
});

test('impostazioni senza fornitori tolti: avvio senza scritture e senza avviso', async () => {
	const state = api.defaultState();
	state.settingsOfProvider.cliAgent.models = [model('codex')];
	state.modelSelectionOfFeature.Chat = { providerName: 'cliAgent', modelName: 'codex' };
	const storage = storageOf({ [KEY]: encrypted(state) });
	const service = await start(storage);
	assert.deepEqual(storage.writes, []);
	assert.equal(service.takeRemovedProvidersNotice(), null);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
	// primo avvio in assoluto: niente di salvato, niente da scrivere
	const empty = storageOf();
	await start(empty);
	assert.deepEqual(empty.writes, []);
	assert.equal(empty.map.size, 0);
});

test('impostazioni attuali illeggibili: si parte da quelle predefinite senza sovrascrivere niente e senza avviso', async () => {
	for (const broken of ['non cifrato', await encryption.encrypt('{json rotto'), await encryption.encrypt('null')]) {
		const storage = storageOf({ [KEY]: broken });
		const service = await start(storage);
		assert.deepEqual(service.state.modelSelectionOfFeature, api.defaultState().modelSelectionOfFeature);
		assert.equal(storage.map.get(KEY), broken, 'il valore illeggibile resta sul disco finché l\'utente non cambia un\'impostazione');
		assert.deepEqual(storage.writes, []);
		assert.equal(service.takeRemovedProvidersNotice(), null);
	}
});

test('se il salvataggio della pulizia fallisce l\'avvio riesce lo stesso e non si annuncia niente', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings()) });
	const original = storage.map.get(KEY);
	const failing = { ...storage, store: () => { throw new Error('disco pieno'); } };
	const service = new api.Service(failing, encryption);
	const { errors } = await quietly(() => service.readAndInitializeState());
	assert.equal(errors.length, 1);
	// in memoria le chiavi non ci sono già più e nessuna richiesta può partire verso i fornitori tolti
	assert.ok(withoutSecrets(JSON.stringify(service.state)));
	assert.equal(service.state.modelSelectionOfFeature.Chat.providerName, 'cliAgent');
	assert.equal(storage.map.get(KEY), original);
	assert.equal(storage.map.has(NOTICE_KEY), false);
	// al prossimo avvio, con il disco che funziona, la pulizia si ripete e l'avviso arriva
	const next = await start(storage);
	assert.ok(withoutSecrets(JSON.stringify(decrypted(storage.map.get(KEY)))));
	assert.equal(next.takeRemovedProvidersNotice().providersWithRemovedSecrets.length, 5);
});

test('il modello di completamento scelto sopravvive al riavvio grazie ai dati salvati; senza quei dati aspetta il rilevamento', async () => {
	const state = api.defaultState();
	state.settingsOfProvider.voxLocal.models = [model('qwen2.5-coder-7b'), model('qwen3.5-9b')];
	state.modelSelectionOfFeature.Chat = { providerName: 'voxLocal', modelName: 'qwen3.5-9b' };
	state.modelSelectionOfFeature.Autocomplete = { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' };
	// ogni avvio è un processo nuovo: le capacità dei modelli ripartono vuote
	const withInfo = load();
	const service = await start(storageOf({ [KEY]: encrypted(state), [api.VOX_LOCAL_COMPLETION_MODELS_KEY]: '["qwen2.5-coder-7b"]', [api.VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"qwen2.5-coder-7b":8192}' }), withInfo);
	assert.deepEqual(service.state.modelSelectionOfFeature.Autocomplete, { providerName: 'voxLocal', modelName: 'qwen2.5-coder-7b' });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
	assert.equal(withInfo.getModelCapabilities('voxLocal', 'qwen2.5-coder-7b', undefined).contextWindow, 8192);
	// dati salvati rovinati: l'avvio riesce, la scelta del completamento torna dopo il primo rilevamento
	const withoutInfo = load();
	const broken = await start(storageOf({ [KEY]: encrypted(state), [api.VOX_LOCAL_COMPLETION_MODELS_KEY]: '{rotto' }), withoutInfo);
	assert.equal(broken.state.modelSelectionOfFeature.Autocomplete, null);
	assert.deepEqual(broken.state.modelSelectionOfFeature.Chat, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
});

test('importare un file di impostazioni di una versione precedente: chiavi tolte e modelli sostituiti, senza modificare il file letto', async () => {
	const storage = storageOf();
	const service = await start(storage);
	const imported = { ...oldSettings({ cli: [model('codex')] }), _modelOptions: [] };
	const copy = structuredClone(imported);
	await service.dangerousSetState(imported);
	assert.deepEqual(imported, copy);
	assert.ok(withoutSecrets(JSON.stringify(service.state)));
	assert.ok(withoutSecrets(JSON.stringify(decrypted(storage.map.get(KEY)))));
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
	assert.equal(service.state.modelSelectionOfFeature.Autocomplete, null);
	assert.deepEqual(service.state.modelSelectionOfFeature.SCM, null, 'la CLI scelta nel file non è fra quelle visibili qui');
	assert.equal(service.changes, 2);
	// come all'avvio: l'avviso viene salvato e segnalato subito, e dice che cosa è cambiato
	assert.equal(service.notices, 1);
	const notice = service.takeRemovedProvidersNotice();
	assert.deepEqual(notice.providersWithRemovedSecrets, ['anthropic', 'openAI', 'openAICompatible', 'gemini', 'liteLLM']);
	assert.deepEqual(notice.replacedSelections.find(s => s.featureName === 'Chat').replacement, { providerName: 'cliAgent', modelName: 'codex' });
	assert.equal(service.takeRemovedProvidersNotice(), null);
	// Applica e messaggi di commit seguono la chat (scelta predefinita del file importato)
	assert.deepEqual(service.syncs, ['Apply', 'SCM']);
	// riportare le impostazioni a quelle predefinite continua a funzionare, senza avvisi
	await service.resetState();
	assert.deepEqual(Object.keys(service.state.settingsOfProvider), ['voxLocal', 'cliAgent']);
	assert.equal(service.notices, 1);
	assert.equal(storage.map.has(NOTICE_KEY), false);
});

test('importare un file di impostazioni: rispetta chi non fa seguire la chat e completa le voci mancanti', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings()) });
	const service = await start(storage);
	service.takeRemovedProvidersNotice();
	const imported = { ...oldSettings({ cli: [model('codex')] }) };
	imported.globalSettings = { ...imported.globalSettings, syncApplyToChat: false, syncSCMToChat: false };
	// un file senza le voci delle IA locali e senza le modifiche ai modelli: non deve dare errori
	delete imported.settingsOfProvider.voxLocal;
	delete imported.overridesOfModel;
	await service.dangerousSetState(imported);
	assert.ok(withoutSecrets(JSON.stringify(decrypted(storage.map.get(KEY)))));
	assert.deepEqual(service.syncs, []);
	assert.deepEqual(service.state.settingsOfProvider.voxLocal.models, []);
	assert.deepEqual(service.state.overridesOfModel, api.defaultState().overridesOfModel);
	assert.deepEqual(service.state.modelSelectionOfFeature.Apply, { providerName: 'cliAgent', modelName: 'codex' });
	assert.equal(service.notices, 1);
	assert.ok(storage.map.has(NOTICE_KEY));
});

test('una funzione passata a una CLI all\'avvio prende il modello locale trovato dal primo rilevamento, e l\'avviso lo riporta', async () => {
	// nessun modello locale salvato: la versione precedente non li aveva ancora rilevati
	const storage = storageOf({ [KEY]: encrypted(oldSettings()) });
	const service = await start(storage);
	const codex = { providerName: 'cliAgent', modelName: 'codex' }, local = modelName => ({ providerName: 'voxLocal', modelName });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, codex);
	assert.deepEqual(service.state.modelSelectionOfFeature.Apply, codex);
	// prima del rilevamento l'utente sceglie a mano un altro modello della CLI per Applica
	await service.setModelSelectionOfFeature('Apply', { providerName: 'cliAgent', modelName: 'codex:mio' });
	// un rilevamento che non trova ancora niente non chiude la questione
	service.setAutodetectedModels('voxLocal', [], undefined, false);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, codex);
	// primo rilevamento con dei modelli: uno da chat e uno di completamento
	api.setVoxLocalContextWindows([{ name: 'qwen3.5-9b', contextWindow: 8192, uso: 'chat' }, { name: 'qwen2.5-coder-7b', contextWindow: 8192, uso: 'completamento' }]);
	service.setAutodetectedModels('voxLocal', ['qwen2.5-coder-7b', 'qwen3.5-9b'], undefined, true);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, local('qwen3.5-9b'));
	assert.deepEqual(service.state.modelSelectionOfFeature['Ctrl+K'], local('qwen3.5-9b'));
	assert.deepEqual(service.state.modelSelectionOfFeature.Autocomplete, local('qwen2.5-coder-7b'));
	assert.deepEqual(service.state.modelSelectionOfFeature.Apply, { providerName: 'cliAgent', modelName: 'codex:mio' }, 'la scelta fatta a mano resta');
	assert.deepEqual(service.state.modelSelectionOfFeature.SCM, { providerName: 'cliAgent', modelName: 'claude' }, 'la CLI scelta prima dell\'aggiornamento resta');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(decrypted(storage.map.get(KEY)).modelSelectionOfFeature.Chat, local('qwen3.5-9b'));
	const text = api.textOfRemovedProvidersNotice(service.takeRemovedProvidersNotice(), names);
	assert.ok(text.includes('«Chat», «Ctrl+K»: claude-opus-4-0 (Anthropic) è stato sostituito con qwen3.5-9b (IA locali).'), text);
	// vale una volta sola: dopo l'avviso, o dopo il primo rilevamento, una CLI non viene più sostituita da sola
	await service.setModelSelectionOfFeature('Chat', codex);
	service.setAutodetectedModels('voxLocal', ['qwen2.5-coder-7b', 'qwen3.5-9b', 'altro'], undefined, false);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, codex);
});

test('una CLI scelta di nuovo a mano dopo l\'avvio non viene sostituita dal modello locale', async () => {
	const service = await start(storageOf({ [KEY]: encrypted(oldSettings()) }));
	const codex = { providerName: 'cliAgent', modelName: 'codex' };
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, codex);
	await service.setModelSelectionOfFeature('Chat', { providerName: 'cliAgent', modelName: 'claude' });
	await service.setModelSelectionOfFeature('Chat', codex);
	api.setVoxLocalContextWindows([{ name: 'qwen3.5-9b', contextWindow: 8192, uso: 'chat' }]);
	service.setAutodetectedModels('voxLocal', ['qwen3.5-9b'], undefined, true);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, codex);
	assert.deepEqual(service.state.modelSelectionOfFeature['Ctrl+K'], { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
});

test('importare un file con le mappe incomplete (senza messaggi di commit, modifiche ai modelli solo dei vecchi fornitori) non dà errori', async () => {
	const service = await start(storageOf());
	const imported = oldSettings({ cli: [model('codex')] });
	delete imported.modelSelectionOfFeature.SCM;
	delete imported.optionsOfModelSelection.SCM;
	imported.overridesOfModel = { anthropic: { 'mio-claude': { contextWindow: 200000 } } };
	delete imported.globalSettings.syncSCMToChat;
	await service.dangerousSetState(imported);
	assert.equal(service.state.modelSelectionOfFeature.SCM, null);
	assert.deepEqual(service.state.overridesOfModel.voxLocal, {});
	assert.deepEqual(service.state.overridesOfModel.anthropic, { 'mio-claude': { contextWindow: 200000 } });
	assert.equal(service.state.globalSettings.syncSCMToChat, api.defaultState().globalSettings.syncSCMToChat);
});

test('dopo che l\'avviso è stato mostrato, la CLI presa all\'avvio non cambia più da sola', async () => {
	const storage = storageOf({ [KEY]: encrypted(oldSettings({ cli: [model('codex')] })) });
	const service = await start(storage);
	service.takeRemovedProvidersNotice();
	api.setVoxLocalContextWindows([{ name: 'qwen3.5-9b', contextWindow: 8192, uso: 'chat' }]);
	service.setAutodetectedModels('voxLocal', ['qwen3.5-9b'], undefined, true);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
});

test('se in modelli.json cambia solo l\'uso di un modello, i modelli scelti si ricontrollano', async () => {
	const local = modelName => ({ providerName: 'voxLocal', modelName });
	const state = api.defaultState();
	state.settingsOfProvider.voxLocal = { ...state.settingsOfProvider.voxLocal, folder: 'E:\\Vox\\ia-locali', models: [model('a'), model('b')] };
	state.modelSelectionOfFeature = { ...state.modelSelectionOfFeature, Chat: local('a'), 'Ctrl+K': local('b') };
	delete state._modelOptions;
	const storage = storageOf({ [KEY]: encrypted(state), [api.VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"a":8192,"b":8192}', [api.VOX_LOCAL_COMPLETION_MODELS_KEY]: '[]' });
	const service = await start(storage);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, local('a'));
	assert.equal(service.state.modelSelectionOfFeature.Autocomplete, null);
	// `a` diventa il modello di completamento: stesso elenco di nomi
	api.setVoxLocalContextWindows([{ name: 'a', contextWindow: 8192, uso: 'completamento' }, { name: 'b', contextWindow: 8192, uso: 'chat' }]);
	service.setAutodetectedModels('voxLocal', ['a', 'b'], undefined, false);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, local('a'), 'senza la segnalazione del cambio non succede niente');
	service.setAutodetectedModels('voxLocal', ['a', 'b'], undefined, true);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, local('b'));
	assert.deepEqual(service.state.modelSelectionOfFeature['Ctrl+K'], local('b'));
	assert.deepEqual(service.state.modelSelectionOfFeature.Autocomplete, local('a'));
});

test('messaggi di commit con un fornitore tolto e chat su una CLI: passano a un modello locale, non alla CLI della chat', async () => {
	const old = oldSettings({ folder: 'E:\\Vox\\ia-locali', local: [model('qwen3.5-9b')] });
	old.globalSettings = { ...old.globalSettings, syncSCMToChat: false };
	old.modelSelectionOfFeature.Chat = { providerName: 'cliAgent', modelName: 'codex' };
	old.modelSelectionOfFeature.SCM = { providerName: 'openAI', modelName: 'gpt-4o' };
	const service = await start(storageOf({ [KEY]: encrypted(old), [api.VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"qwen3.5-9b":8192}' }));
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, { providerName: 'cliAgent', modelName: 'codex' });
	assert.deepEqual(service.state.modelSelectionOfFeature.SCM, { providerName: 'voxLocal', modelName: 'qwen3.5-9b' });
});

test('impostazioni salvate che non si riescono a caricare: si riparte da quelle predefinite, ma le chiavi non restano sul disco', async () => {
	// leggibili e decifrabili, ma senza le parti che il caricamento si aspetta
	const unusable = { settingsOfProvider: { anthropic: { apiKey: SECRETS[0], models: [model('claude-opus-4-0', 'default')] }, liteLLM: { endpoint: `https://${SECRETS[3]}@esempio.invalid/v1` } }, modelSelectionOfFeature: { Chat: { providerName: 'anthropic', modelName: 'claude-opus-4-0' } } };
	const storage = storageOf({ [KEY]: encrypted(unusable) });
	const service = await start(storage);
	assert.deepEqual(Object.keys(service.state.settingsOfProvider), ['voxLocal', 'cliAgent']);
	const saved = decrypted(storage.map.get(KEY));
	assert.ok(withoutSecrets(JSON.stringify(saved)));
	// il resto della copia salvata resta com'era: solo i segreti sono stati tolti
	assert.deepEqual(saved, { settingsOfProvider: { anthropic: { models: [model('claude-opus-4-0', 'default')] }, liteLLM: { endpoint: 'https://esempio.invalid/v1' } }, modelSelectionOfFeature: unusable.modelSelectionOfFeature });
	assert.equal(service.takeRemovedProvidersNotice(), null);
});
