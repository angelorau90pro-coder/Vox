import { evaluate } from '../../common/voxI18n.fixture.mjs';
// Regressioni delle impostazioni e del selettore, senza account o rete (Node >= 22.18).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const [capabilities, types, settings, dropdown, inputs, removedProviders, service] = await Promise.all([
	read('../../common/modelCapabilities.ts'), read('../../common/voxSettingsTypes.ts'),
	read('../../common/voxSettingsService.ts'), read('../../browser/react/src/vox-settings-tsx/ModelDropdown.tsx'), read('../../browser/react/src/util/inputs.tsx'),
	read('../../common/removedProviders.ts'), read('../../common/sendLLMMessageService.ts'),
]);
const between = (source, start, end) => {
	assert.ok(source.includes(start) && source.includes(end), `Sezione di codice mancante: ${start}`);
	return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
};
const js = source => stripTypeScriptTypes(source.replaceAll('export ', ''));
const logic = [
	between(capabilities, 'export const defaultProviderSettings', 'export type VoxStaticModelInfo'),
	between(types, 'export const splitCliAgentModel', 'export const localProviderNames'),
	between(types, 'const defaultCustomSettings', 'export type ModelSelection ='),
	between(types, 'export const modelSelectionsEqual', 'export const displayInfoOfFeatureName'),
	between(types, 'export const defaultGlobalSettings', 'export type GlobalSettingName'),
	between(types, 'const overridesOfModel =', 'export interface MCPUserStateOfName'),
	between(types, 'export const isProviderNameDisabled', 'export type ChatMode'),
	between(settings, 'const _modelsWithSwappedInNewModels', 'export const IVoxSettingsService ='),
].join('\n');
const setter = between(settings, '\tsetModelSelectionOfFeature: SetModelSelectionOfFeatureFn =', '\n\tsetOptionsOfModelSelection')
	.replace('setModelSelectionOfFeature: SetModelSelectionOfFeatureFn', 'const setModelSelectionOfFeature');
const initialize = between(settings, '\tasync readAndInitializeState()', '\n\tprivate async _readState');
// la pulizia vera dei fornitori tolti: `readAndInitializeState` la esegue a ogni avvio
const { cleanRemovedProviders } = new Function(js(removedProviders) + '; return { cleanRemovedProviders };')();
const api = evaluate('deepClone', 'getModelCapabilities', 'isVoxLocalCompletionModel', 'cleanRemovedProviders', js(logic) + `
return { defaultState, _validatedModelState, _stateWithMergedDefaultModels, _modelsWithSwappedInNewModels,
 splitCliAgentModel, isFeatureNameDisabled,
 initialize: ${js('({' + initialize + '})')}.readAndInitializeState,
 setter: function() { ${js(setter)}; return setModelSelectionOfFeature; } };
`)(structuredClone, () => ({ supportsFIM: false }), () => false, cleanRemovedProviders);
const model = (modelName, type = 'autodetected', isHidden = false) => ({ modelName, type, isHidden });
const selection = modelName => ({ providerName: 'cliAgent', modelName });
const stateWithCli = (...models) => {
	const state = api.defaultState();
	state.settingsOfProvider.cliAgent.models = models;
	return state;
};
const serviceFor = async saved => {
	const service = {
		_readState: async () => structuredClone(saved), _resolver() {},
		_onDidChangeState: { fire() {} }, _onUpdate_syncApplyToChat() {}, _onUpdate_syncSCMToChat() {},
		async _storeState() { this.saved = JSON.parse(JSON.stringify(this.state)); },
		// il salvataggio della pulizia e l'avviso hanno i loro test (removedProvidersMigration.test.mjs)
		_loadVoxLocalModelInfo() {}, async _saveRemovedProvidersCleanup(cleanup) { this.cleanup = cleanup; },
	};
	service.setModelSelectionOfFeature = api.setter.call(service);
	await api.initialize.call(service);
	return service;
};
const chooseIA = service => evaluate('voxSettingsService', 'featureName', 'useCallback', 'splitCliAgentModel',
	js(between(dropdown, '\tconst onChangeIaOption =', '\n\tconst isCli =')) + '; return onChangeIaOption;'
)(service, 'Chat', fn => fn, api.splitCliAgentModel);

test('primo avvio senza CLI: elenco vuoto, Chat null e onboarding bloccato', async () => {
	const service = await serviceFor(api.defaultState());
	assert.deepEqual(service.state.settingsOfProvider.cliAgent.models, []);
	assert.equal(service.state.modelSelectionOfFeature.Chat, null);
	assert.ok(api.isFeatureNameDisabled('Chat', service.state));
});

test('le IA locali che perdono la configurazione non ripiegano su CLI, nemmeno alla rivalidazione', () => {
	const state = stateWithCli(model('codex'));
	state.settingsOfProvider.voxLocal.models = [model('qwen3.5-9b')];
	state.modelSelectionOfFeature.Chat = { providerName: 'voxLocal', modelName: 'qwen3.5-9b' };
	const configured = api._validatedModelState(state);
	assert.equal(configured.modelSelectionOfFeature.Chat.providerName, 'voxLocal');
	// la cartella non c'è più e il rilevamento non trova modelli
	configured.settingsOfProvider.voxLocal.models = [];
	const disabled = api._validatedModelState(configured);
	assert.equal(disabled.modelSelectionOfFeature.Chat, null);
	assert.equal(api._validatedModelState(disabled).modelSelectionOfFeature.Chat, null);
	assert.ok(disabled._modelOptions.some(o => o.selection.providerName === 'cliAgent'));
});

test('validazione: suffisso libero con IA visibile, personalizzati esatti e modelli nascosti esclusi', () => {
	const state = stateWithCli(model('codex'), model('codex:nascosto', 'custom', true));
	state.modelSelectionOfFeature.Chat = selection('codex:x');
	assert.deepEqual(api._validatedModelState(state).modelSelectionOfFeature.Chat, selection('codex:x'));
	state.modelSelectionOfFeature.Chat = selection('codex:nascosto');
	assert.equal(api._validatedModelState(state).modelSelectionOfFeature.Chat, null);
	state.settingsOfProvider.cliAgent.models[0].isHidden = true;
	state.modelSelectionOfFeature.Chat = selection('codex:x');
	assert.equal(api._validatedModelState(state).modelSelectionOfFeature.Chat, null);
	state.settingsOfProvider.cliAgent.models = [model('codex:manuale', 'custom')];
	assert.equal(api._validatedModelState(state).modelSelectionOfFeature.Chat, null);
	state.modelSelectionOfFeature.Chat = selection('codex:manuale');
	assert.deepEqual(api._validatedModelState(state).modelSelectionOfFeature.Chat, selection('codex:manuale'));
	// un fornitore che non esiste (tolto, o un valore rovinato) non resta scelto e non fa passare a una CLI
	state.modelSelectionOfFeature.Chat = { providerName: 'anthropic', modelName: 'inesistente' };
	assert.equal(api._validatedModelState(state).modelSelectionOfFeature.Chat, null);
});

test('avvio con le impostazioni di una versione precedente: il modello di un fornitore tolto passa alla CLI visibile', async () => {
	const saved = stateWithCli(model('codex'));
	saved.settingsOfProvider.anthropic = { apiKey: 'chiave-fittizia', models: [model('claude-opus-4-0', 'default')], _didFillInProviderSettings: true };
	saved.modelSelectionOfFeature.Chat = { providerName: 'anthropic', modelName: 'claude-opus-4-0' };
	saved.modelSelectionOfFeature.Autocomplete = { providerName: 'mistral', modelName: 'codestral-latest' };
	const service = await serviceFor(saved);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('codex'));
	assert.equal(service.state.modelSelectionOfFeature.Autocomplete, null);
	assert.equal('apiKey' in service.state.settingsOfProvider.anthropic, false);
	assert.deepEqual(service.cleanup, {
		changed: true, providersWithRemovedSecrets: ['anthropic'],
		// i messaggi di commit non avevano un modello: lo ereditano dalla chat prima della pulizia, e passano alla CLI come lei
		removedSelections: [{ featureName: 'Chat', providerName: 'anthropic', modelName: 'claude-opus-4-0' }, { featureName: 'Autocomplete', providerName: 'mistral', modelName: 'codestral-latest' }, { featureName: 'SCM', providerName: 'anthropic', modelName: 'claude-opus-4-0' }],
	});
	assert.deepEqual(service.state.modelSelectionOfFeature.SCM, selection('codex'));
	// i fornitori tolti non danno più modelli da scegliere
	assert.deepEqual(service.state._modelOptions.map(o => o.selection.providerName), ['cliAgent']);
});

test('memoria per IA: codex:x → agy → codex, Predefinito e riavvio', async () => {
	let service = await serviceFor(stateWithCli(model('codex'), model('agy')));
	await service.setModelSelectionOfFeature('Chat', selection('codex:x'));
	await chooseIA(service)({ selection: selection('agy') });
	await service.setModelSelectionOfFeature('Chat', selection('agy:y'));
	await chooseIA(service)({ selection: selection('codex') });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('codex:x'));
	assert.deepEqual(service.state.lastModelOfCliAgent, { codex: 'x', agy: 'y' });
	service = await serviceFor(service.saved);
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('codex:x'));
	await service.setModelSelectionOfFeature('Chat', selection('codex'));
	await chooseIA(service)({ selection: selection('agy') });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('agy:y'));
	service = await serviceFor(service.saved);
	await chooseIA(service)({ selection: selection('codex') });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('codex'));
	assert.equal(service.state.lastModelOfCliAgent.codex, '');
});

test('migrazione di memoria assente e rimozione dei vecchi predefiniti CLI senza doppioni', async () => {
	const saved = stateWithCli(model('codex', 'default'), model('codex'), model('agy', 'default'), model('codex:manuale', 'custom'));
	delete saved.lastModelOfCliAgent;
	saved.modelSelectionOfFeature.Chat = selection('codex:x');
	const service = await serviceFor(saved);
	assert.deepEqual(service.state.lastModelOfCliAgent, { codex: 'x' });
	assert.deepEqual(service.state.settingsOfProvider.cliAgent.models, [model('codex'), model('codex:manuale', 'custom')]);
	const merged = api._modelsWithSwappedInNewModels({ existingModels: [model('x'), model('x', 'default')], models: ['x'], type: 'default' });
	assert.deepEqual(merged, [model('x', 'default')]);
});

test('nomi con due punti e chiavi del prototipo non diventano valori ereditati', async () => {
	assert.deepEqual(api.splitCliAgentModel('opencode:provider:model'), { agent: 'opencode', subModel: 'provider:model' });
	const service = await serviceFor(stateWithCli(model('constructor', 'custom')));
	await chooseIA(service)({ selection: selection('constructor') });
	assert.deepEqual(service.state.modelSelectionOfFeature.Chat, selection('constructor'));
	assert.equal(service.state.lastModelOfCliAgent.constructor, '');
});

test('il sottomenu propone i modelli dell\'account, esclude i nascosti e accetta IA constructor', () => {
	const optionsSource = between(dropdown, '\tconst options = useMemo<CliModelItem[]>', '\n\tconst selectedOption');
	const optionsFor = (agent, models, accountModels = []) => evaluate('useMemo', 'agent', 'currentSubModel', 'settingsState', 'accountModels',
		js(optionsSource) + '; return options;'
	)(fn => fn(), agent, '', stateWithCli(...models), accountModels);
	// Senza cache dell'account nessun modello fisso: solo Predefinito e Personalizzato.
	assert.deepEqual(optionsFor('codex', []).map(o => o.id), ['', '__custom__']);
	const account = optionsFor('codex', [], ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-luna', '__custom__']);
	assert.deepEqual(account.map(o => o.id), ['', 'gpt-6-luna', 'gpt-5.6-terra', '__custom__']);
	assert.equal(account[1].detail, 'elencato da codex');
	// Un modello dell'account nascosto nelle impostazioni non si propone.
	assert.ok(!optionsFor('codex', [model('codex:gpt-6-luna', 'custom', true)], ['gpt-6-luna']).some(o => o.id === 'gpt-6-luna'));
	assert.deepEqual(optionsFor('constructor', []).map(o => o.id), ['', '__custom__']);
});

test('il sottomenu rilegge i modelli di codex a ogni apertura e tiene solo l\'ultima risposta', async () => {
	// La rilettura parte da onOpen del menu, chiamato a ogni passaggio ad aperto (clic o tastiera).
	assert.match(dropdown, /\n\t\t\t\tonOpen=\{reloadAccountModels\}\n/);
	assert.match(inputs, /useEffect\(\(\) => \{\r?\n\t\tif \(isOpen\) onOpenRef\.current\?\.\(\);\r?\n\t\}, \[isOpen\]\);/);
	// Con le opzioni nuove a menu aperto si ricalcolano posizione e larghezza (measureRef ha già l'elenco nuovo).
	assert.match(inputs, /\t\tif \(previous !== options\) update\(\);\r?\n\t\}, \[isOpen, options, selectedIndex, getOptionsEqual, update\]\);/);
	const source = between(dropdown, '\tconst lastRequest = useRef(0)', '\n\n\t// Costruisci le opzioni');
	const pending = [];
	let state = [];
	const cleanups = [];
	const mount = agent => evaluate('useRef', 'useCallback', 'useEffect', 'agent', 'llmMessageService', 'setAccountModels',
		js(source) + '; return { reloadAccountModels };'
	)(value => ({ current: value }), fn => fn, fn => { cleanups.push(fn()); }, agent,
		{ cliAgentModels: () => new Promise((resolve, reject) => { resolve.reject = reject; pending.push(resolve); }) },
		update => { state = typeof update === 'function' ? update(state) : update; });
	const settle = async (index, models) => { pending[index](models); await new Promise(resolve => setImmediate(resolve)); };
	// Il montaggio legge subito la cache; l'apertura successiva vede la cache aggiornata da codex.
	const { reloadAccountModels } = mount('codex');
	assert.equal(pending.length, 1);
	await settle(0, ['gpt-6-luna']);
	assert.deepEqual(state, ['gpt-6-luna']);
	reloadAccountModels();
	await settle(1, ['gpt-6-luna', 'gpt-5.6-terra']);
	assert.deepEqual(state, ['gpt-6-luna', 'gpt-5.6-terra']);
	// Due aperture ravvicinate: la risposta vecchia che arriva dopo non sovrascrive quella nuova.
	reloadAccountModels();
	reloadAccountModels();
	await settle(3, ['nuovo']);
	await settle(2, ['vecchio']);
	assert.deepEqual(state, ['nuovo']);
	// Un errore del canale non svuota i modelli già mostrati: il servizio non lo trasforma in un elenco vuoto.
	reloadAccountModels();
	pending[4].reject(new Error('canale'));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(state, ['nuovo']);
	assert.match(service, /this\.channel\.call<string\[\]>\('cliAgentModels', \{ agent \}\)\r?\n\t\t\.then\(models => Array\.isArray\(models\) \? models\.filter\(model => typeof model === 'string'\) : \[\]\);/);
	// Dopo lo smontaggio (la pulizia vera dello useEffect) una risposta in ritardo non cambia lo stato.
	reloadAccountModels();
	cleanups[0]();
	await settle(5, ['dopo lo smontaggio']);
	assert.deepEqual(state, ['nuovo']);
	// Le altre IA non chiedono niente al processo principale, nemmeno al montaggio.
	mount('claude').reloadAccountModels();
	assert.equal(pending.length, 6);
});

test('menu: dopo un cambio delle opzioni la voce attiva resta la stessa', () => {
	const { activeIndexAfterOptionsChange } = new Function(js(between(inputs, 'export const activeIndexAfterOptionsChange', 'export const VoxCustomDropdownBox')) + '; return { activeIndexAfterOptionsChange };')();
	const equal = (a, b) => a === b;
	const before = ['', 'gpt-6-luna', '__custom__'];
	// Un modello inserito prima di quello evidenziato: l'indice segue la voce, non la posizione.
	assert.equal(activeIndexAfterOptionsChange(1, before, ['', 'gpt-5.6-terra', 'gpt-6-luna', '__custom__'], 0, equal), 2);
	// La voce evidenziata sparisce: si torna alla voce scelta.
	assert.equal(activeIndexAfterOptionsChange(1, before, ['', '__custom__'], 0, equal), 0);
	// Stesse opzioni: l'indice resta entro i limiti; nessuna opzione: nessun indice; nessun indice: la voce scelta.
	assert.equal(activeIndexAfterOptionsChange(5, before, before, 0, equal), 2);
	assert.equal(activeIndexAfterOptionsChange(1, before, [], 0, equal), -1);
	assert.equal(activeIndexAfterOptionsChange(-1, before, before, 1, equal), 1);
});

const onboarding = await read('../../browser/react/src/vox-onboarding/VoxOnboarding.tsx');
const finishOnboarding = (service, detectedCli) => evaluate('voxSettingsService', 'detectedCli',
	js(between(onboarding, '\tconst finishOnboarding =', '\n\t// reset the page to page 0')) + '; return finishOnboarding;'
)(service, detectedCli);
test('primo avvio: due sole pagine; dalla pagina dei motori si entra in Vox, senza la pagina del trasferimento delle impostazioni', () => {
	const pages = between(onboarding, '\tconst contentOfIdx:', '\n\treturn <div key={pageIndex}');
	assert.deepEqual([...pages.matchAll(/^\t\t(\d+): <OnboardingPageShell/gm)].map(match => match[1]), ['0', '1']);
	assert.equal(/OneClickSwitchButton|Settings and Themes|Transfer your settings/.test(onboarding), false);
	// la pagina dei motori finisce il primo avvio, e solo se un motore è pronto
	assert.match(pages, /<AddProvidersPage [^>]*\bonFinish=\{finishOnboarding\}/s);
	const page = between(onboarding, 'const AddProvidersPage =', '\nconst PreviousButton =');
	assert.match(page, /if \(!isDisabled \|\| [^\n]+\) \{\s+setErrorMessage\(null\);\s+onFinish\(\);\s+\} else \{/);
	assert.equal(/setPageIndex\(pageIndex \+ 1\)/.test(onboarding), false);
});

const complete = async (service, detectedCli) => {
	service.setGlobalSetting = async (name, value) => { service.state.globalSettings[name] = value; };
	await finishOnboarding(service, detectedCli)();
	return service.state;
};

test('onboarding CLI: rilevamento non seleziona; il completamento configura le funzioni compatibili', async () => {
	const service = await serviceFor(stateWithCli(model('codex'), model('agy')));
	assert.equal(service.state.modelSelectionOfFeature.Chat, null);
	const state = await complete(service, ['agy', 'codex']);
	for (const feature of ['Chat', 'Ctrl+K', 'Apply', 'SCM']) {
		assert.deepEqual(state.modelSelectionOfFeature[feature], selection('agy'));
	}
	assert.equal(state.modelSelectionOfFeature.Autocomplete, null);
	assert.equal(state.globalSettings.isOnboardingComplete, true);
});

test('onboarding CLI: nessun ripiego senza rilevamento corrente o con modelli nascosti', async () => {
	for (const [models, detected] of [
		[[], []], [[model('codex')], []], [[model('codex', 'autodetected', true)], ['codex']],
		[[model('codex')], ['agy']],
	]) {
		const state = await complete(await serviceFor(stateWithCli(...models)), detected);
		assert.equal(state.modelSelectionOfFeature.Chat, null);
	}
});

test('onboarding CLI: conserva Chat e le selezioni esplicite delle altre funzioni', async () => {
	const saved = stateWithCli(model('codex'), model('agy'));
	saved.modelSelectionOfFeature.Chat = selection('agy');
	let service = await serviceFor(saved);
	assert.deepEqual((await complete(service, ['codex'])).modelSelectionOfFeature.Chat, selection('agy'));
	saved.modelSelectionOfFeature.Chat = null;
	saved.modelSelectionOfFeature['Ctrl+K'] = selection('agy');
	service = await serviceFor(saved);
	assert.deepEqual((await complete(service, ['codex'])).modelSelectionOfFeature['Ctrl+K'], selection('agy'));
});
