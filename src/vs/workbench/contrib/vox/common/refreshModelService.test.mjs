import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./refreshModelService.ts', import.meta.url), 'utf8');
const withoutImports = source.replace(/^import .*;\r?\n/gm, '');
const withoutDecorators = withoutImports.replace(/@(?:IVoxSettingsService|ILLMMessageService|IStorageService) /g, '');
assert.equal((withoutImports.match(/@(IVoxSettingsService|ILLMMessageService|IStorageService) /g) ?? []).length, 3, 'forma dei decoratori del costruttore cambiata: aggiornare la trasformazione del test');
const withoutParameterProperties = withoutDecorators.replace(
	/constructor\(\s*private readonly voxSettingsService: IVoxSettingsService,\s*private readonly llmMessageService: ILLMMessageService,\s*private readonly storageService: IStorageService,\s*\) \{\s*super\(\)/,
	'constructor(voxSettingsService: IVoxSettingsService, llmMessageService: ILLMMessageService, storageService: IStorageService) {\n\t\tsuper()\n\t\tthis.voxSettingsService = voxSettingsService\n\t\tthis.llmMessageService = llmMessageService\n\t\tthis.storageService = storageService',
);
assert.notEqual(withoutParameterProperties, withoutDecorators, 'forma delle parameter property cambiata: aggiornare la trasformazione del test');
const body = stripTypeScriptTypes(withoutParameterProperties).replace(/^export /gm, '');

// si rilevano solo le IA locali di Vox: non ci sono altri fornitori con un elenco di modelli
const providerNames = ['voxLocal'];
// i dati dei modelli locali salvati passano dal codice vero, con i nomi veri delle chiavi
const pure = async file => stripTypeScriptTypes(await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^export /gm, '');
const { parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo } = new Function(await pure('./voxLocalModelInfo.ts') + '; return { parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo };')();
const { VOX_LOCAL_CONTEXT_WINDOWS_KEY, VOX_LOCAL_COMPLETION_MODELS_KEY } = new Function(await pure('./storageKeys.ts') + '; return { VOX_LOCAL_CONTEXT_WINDOWS_KEY, VOX_LOCAL_COMPLETION_MODELS_KEY };')();
class Emitter {
	listeners = new Set();
	event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
	fire(value) { for (const listener of this.listeners) listener(value); }
	dispose() { this.listeners.clear(); }
}
class Disposable {
	_store = { isDisposed: false };
	disposables = [];
	_register(value) { this.disposables.push(value); return value; }
	dispose() { this._store.isDisposed = true; for (const value of this.disposables) value.dispose(); }
}
const timers = () => {
	let next = 0;
	const active = new Map();
	return { active, setTimeout(fn) { const id = ++next; active.set(id, fn); return id; }, clearTimeout(id) { active.delete(id); } };
};
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function load({ auto = true, saved = {} } = {}) {
	const settingsEmitter = new Emitter();
	const init = deferred();
	const calls = [];
	const models = [];
	const setAutodetectedCalls = [];
	const settings = { voxLocal: { folder: '', _didFillInProviderSettings: false } };
	const settingsService = {
		state: { globalSettings: { autoRefreshModels: auto }, settingsOfProvider: settings },
		waitForInitState: init.promise,
		onDidChangeState: settingsEmitter.event,
		setAutodetectedModels: (...args) => { setAutodetectedCalls.push(args); models.push([args[0], args[1]]); },
		setSettingOfProvider: (provider, key, value) => { settings[provider][key] = value; },
	};
	const storage = new Map(Object.entries(saved));
	const storageWrites = [];
	const storageService = { get: key => storage.get(key), store: (key, value, scope, target) => { storageWrites.push([key, value, scope, target]); storage.set(key, value); } };
	const clock = timers();
	const ctor = new Function('Disposable', 'Emitter', 'toDisposable', 'registerSingleton', 'createDecorator', 'InstantiationType', 'StorageScope', 'StorageTarget', 'refreshableProviderNames', 'setVoxLocalContextWindows', 'VOX_LOCAL_CONTEXT_WINDOWS_KEY', 'VOX_LOCAL_COMPLETION_MODELS_KEY', 'parseSavedVoxLocalModelInfo', 'serializeVoxLocalModelInfo', 'setTimeout', 'clearTimeout', `${body}; return RefreshModelService;`)(
		Disposable, Emitter, fn => ({ dispose: fn }), () => {}, () => () => {}, { Eager: 1 }, { APPLICATION: 1 }, { MACHINE: 1 }, providerNames, value => { load.contexts = value; }, VOX_LOCAL_CONTEXT_WINDOWS_KEY, VOX_LOCAL_COMPLETION_MODELS_KEY, parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo, clock.setTimeout, clock.clearTimeout,
	);
	// l'unico elenco che esiste: un servizio con altri elenchi non deve servire
	const service = new ctor(settingsService, { voxLocalList: args => calls.push(args) }, storageService);
	return { service, calls, models, setAutodetectedCalls, settingsService, settingsEmitter, clock, storageService, storage, storageWrites, init };
}
const opts = { enableProviderOnSuccess: false, doNotFire: true };
const respond = (call, models) => call.onSuccess({ models });
const local = (id, contextWindow = 4096, uso = 'chat') => ({ id, contextWindow, uso });

test('risposte voxLocal fuori ordine non sovrascrivono modelli o finestre e lasciano un solo timer', async () => {
	const f = load({ auto: true });
	f.service.startRefreshingModels('voxLocal', opts);
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('B', 8192)]);
	respond(f.calls[0], [local('A', 4096)]);
	assert.deepEqual(f.models, [['voxLocal', ['B']]]);
	assert.deepEqual(load.contexts, [{ name: 'B', contextWindow: 8192, uso: 'chat' }]);
	assert.equal(f.clock.active.size, 1);
	f.service.dispose();
});

test('onError obsoleto non cambia lo stato né programma un timer aggiuntivo', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('B')]);
	f.calls[0].onError({ error: new Error('obsoleto') });
	// scelta voluta: anche i giri automatici aggiornano lo stato, quindi il successo di calls[1] chiude il ciclo
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.notEqual(f.service.state.voxLocal.state, 'error');
	assert.equal(f.service.state.voxLocal.message, undefined);
	assert.equal(f.clock.active.size, 1);
	f.service.dispose();
});

test('una richiesta applica i modelli e pianifica un timer', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [local('A')]);
	assert.deepEqual(f.models, [['voxLocal', ['A']]]);
	assert.equal(f.clock.active.size, 1);
	f.service.dispose();
});

test('un automatico che supera un manuale chiude lo stato refreshing e notifica', () => {
	const f = load();
	let changes = 0;
	f.service.onDidChangeState(() => changes++);
	f.service.startRefreshingModels('voxLocal', { ...opts, doNotFire: false });
	f.service.startRefreshingModels('voxLocal', opts);
	const changesBeforeResponse = changes;
	respond(f.calls[1], [local('B')]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(changes, changesBeforeResponse + 1);
	f.service.dispose();
});

test('dispose invalida le risposte pendenti', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.service.dispose();
	respond(f.calls[0], [local('A')]);
	assert.deepEqual(f.models, []);
	assert.equal(f.clock.active.size, 0);
});

test("dispose prima dell'inizializzazione impedisce il rilevamento", async () => {
	const f = load();
	f.service.dispose();
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.calls, []);
	assert.equal(f.clock.active.size, 0);
});

test('il cambio effettivo dell’interruttore riavvia il rilevamento, un evento invariato no', async () => {
	const f = load({ auto: false });
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal']);
	f.settingsEmitter.fire();
	assert.equal(f.calls.length, 1);
	f.settingsService.state.globalSettings.autoRefreshModels = true;
	f.settingsEmitter.fire();
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal', ...providerNames]);
	f.service.dispose();
});

test('dispose rimuove gli ascolti automatici e impedisce nuove richieste', async () => {
	const f = load();
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	const callsBeforeDispose = f.calls.length;
	f.service.dispose();
	// nessun ascolto delle impostazioni sopravvive alla chiusura del servizio
	assert.equal(f.settingsEmitter.listeners.size, 0);
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'C:/models';
	f.settingsEmitter.fire();
	assert.equal(f.calls.length, callsBeforeDispose);
	assert.equal(f.clock.active.size, 0);
});

test('con rilevamento spento si rilegge voxLocal solo quando cambia la cartella', async () => {
	const f = load({ auto: false });
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal']);
	f.settingsEmitter.fire();
	assert.equal(f.calls.length, 1);
	f.settingsService.state.settingsOfProvider.voxLocal._didFillInProviderSettings = true;
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'C:/models';
	f.settingsEmitter.fire();
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal', 'voxLocal']);
	assert.equal(f.clock.active.size, 0);
	f.service.dispose();
});

test('riaccendere il rilevamento rimuove l’ascolto spento', async () => {
	const f = load({ auto: false });
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'C:/models';
	f.settingsEmitter.fire();
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal', 'voxLocal']);
	f.settingsService.state.globalSettings.autoRefreshModels = true;
	f.settingsEmitter.fire();
	const callsAfterEnable = f.calls.length;
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'D:/models';
	f.settingsEmitter.fire();
	assert.equal(f.calls.length, callsAfterEnable + 1);
	assert.equal(f.calls.at(-1).providerName, 'voxLocal');
	f.service.dispose();
});

// Scelta voluta: la risposta già partita è un dato valido (sarebbe arrivata un istante prima dello spegnimento);
// scartarla lascerebbe lo stato in 'refreshing' e scarterebbe anche un aggiornamento manuale in corso.
test('spegnere il rilevamento con una richiesta automatica in volo: la risposta si applica una volta, senza nuovi timer', async () => {
	const f = load();
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	const pending = f.calls.find(call => call.providerName === 'voxLocal');
	f.settingsService.state.globalSettings.autoRefreshModels = false;
	f.settingsEmitter.fire();
	// spegnendo parte il giro unico delle IA locali: la risposta di prima è superata, vale quella nuova
	const afterSwitch = f.calls.at(-1);
	assert.notEqual(afterSwitch, pending);
	respond(pending, [local('vecchia')]);
	respond(afterSwitch, [local('A')]);
	assert.deepEqual(f.models, [['voxLocal', ['A']]]);
	assert.notEqual(f.service.state.voxLocal.state, 'refreshing');
	assert.equal(f.clock.active.size, 0);
	f.service.dispose();
});

test('startRefreshingModels dopo dispose non cambia stato né emette eventi', () => {
	const f = load();
	let changes = 0;
	f.service.onDidChangeState(() => changes++);
	f.service.dispose();
	f.service.startRefreshingModels('voxLocal', opts);
	assert.deepEqual(f.calls, []);
	assert.equal(f.service.state.voxLocal.state, 'init');
	assert.equal(changes, 0);
	assert.equal(f.clock.active.size, 0);
});

test('dispose con rilevamento spento rimuove gli ascolti e il cambio cartella non fa richieste', async () => {
	const f = load({ auto: false });
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.calls.map(call => call.providerName), ['voxLocal']);
	f.service.dispose();
	assert.equal(f.settingsEmitter.listeners.size, 0);
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'C:/models';
	f.settingsEmitter.fire();
	assert.equal(f.calls.length, 1);
});

test('onError conserva il messaggio vero (stringa o Error) nello stato', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onError({ error: 'cartella non trovata' });
	assert.equal(f.service.state.voxLocal.state, 'error');
	assert.equal(f.service.state.voxLocal.message, 'cartella non trovata');
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[1].onError({ error: new Error('manifesto illeggibile') });
	assert.equal(f.service.state.voxLocal.state, 'error');
	assert.equal(f.service.state.voxLocal.message, 'manifesto illeggibile');
	f.service.dispose();
});

test('un errore in un giro automatico aggiorna lo stato e notifica; un successo lo riporta a finished', () => {
	const f = load();
	const states = [];
	f.service.onDidChangeState(providerName => states.push(f.service.state[providerName].state));
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onError({ error: 'cartella sparita' });
	assert.equal(f.service.state.voxLocal.state, 'error');
	assert.deepEqual(states, ['error']);
	// il giro automatico successivo (autoPoll) riprova e, riuscito, cancella l'errore
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('A')]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.deepEqual(states, ['error', 'finished']);
	f.service.dispose();
});

test('ogni cambiamento produce un nuovo oggetto di stato e distingue i manuali', () => {
	const f = load();
	const before = f.service.state.voxLocal;
	f.service.startRefreshingModels('voxLocal', { ...opts, doNotFire: false });
	assert.notEqual(f.service.state.voxLocal, before);
	assert.equal(f.service.state.voxLocal.state, 'refreshing');
	assert.equal(f.service.state.voxLocal.manual, true);
	const refreshing = f.service.state.voxLocal;
	respond(f.calls[0], [local('A')]);
	assert.notEqual(f.service.state.voxLocal, refreshing);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.manual, true);
	f.service.dispose();
});

test('giri automatici identici consecutivi non emettono eventi ripetuti', () => {
	const f = load();
	let changes = 0;
	f.service.onDidChangeState(() => changes++);
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [local('A')]);
	assert.equal(changes, 1); // init -> finished
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('A')]);
	assert.equal(changes, 1); // stesso esito: nessun evento
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[2].onError({ error: 'stessa causa' });
	const afterError = changes;
	assert.equal(afterError, 2); // finished -> error
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[3].onError({ error: 'stessa causa' });
	assert.equal(changes, afterError); // stesso errore: nessun evento
	f.service.dispose();
});

test('errore manuale seguito da successo automatico: finished senza flag manuale né messaggio', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', { ...opts, doNotFire: false });
	f.calls[0].onError({ error: 'errore manuale' });
	assert.equal(f.service.state.voxLocal.state, 'error');
	assert.equal(f.service.state.voxLocal.manual, true);
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('A')]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.manual, false);
	assert.equal(f.service.state.voxLocal.message, undefined);
	f.service.dispose();
});

test('un giro automatico produce manual false', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [local('A')]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.manual, false);
	f.service.dispose();
});

test('un automatico che parte durante un manuale refreshing lascia manual true sul risultato', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', { ...opts, doNotFire: false });
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('B')]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.manual, true);
	f.service.dispose();
});

test('onError con error undefined produce un messaggio vuoto, non "undefined"', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onError({ error: undefined });
	assert.equal(f.service.state.voxLocal.state, 'error');
	assert.equal(f.service.state.voxLocal.message, '');
	f.service.dispose();
});

test('svuotare la cartella di voxLocal e poi avviare il manuale applica una sola risposta, quella manuale', async () => {
	const f = load({ auto: true });
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'C:/vecchia';
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	f.settingsService.state.settingsOfProvider.voxLocal.folder = '';
	f.settingsEmitter.fire();
	const autoCall = f.calls.at(-1);
	f.service.startRefreshingModels('voxLocal', { ...opts, doNotFire: false });
	const manualCall = f.calls.at(-1);
	respond(manualCall, [{ ...local('M'), folder: 'D:/trovata' }]);
	respond(autoCall, [{ ...local('A'), folder: 'E:/vecchia' }]);
	assert.deepEqual(f.models, [['voxLocal', ['M']]]);
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.manual, true);
	assert.equal(f.settingsService.state.settingsOfProvider.voxLocal.folder, 'D:/trovata');
	f.service.dispose();
});

test('voxLocal: il successo non forza "configurato" (si ricava da cartella e modelli), con o senza modelli', () => {
	const f = load();
	const writes = [];
	const set = f.settingsService.setSettingOfProvider;
	f.settingsService.setSettingOfProvider = (provider, key, value) => { writes.push([provider, key, value]); set(provider, key, value); };
	// IA locali assenti: zero modelli a ogni giro, senza scritture del flag
	for (let i = 0; i < 3; i++) {
		f.service.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: true });
		respond(f.calls.at(-1), []);
	}
	assert.deepEqual(writes.filter(([, key]) => key === '_didFillInProviderSettings'), []);
	f.service.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: true });
	respond(f.calls.at(-1), [{ ...local('A'), folder: 'D:/trovata' }]);
	// si scrive solo la cartella trovata, mai il flag
	assert.deepEqual(writes, [['voxLocal', 'folder', 'D:/trovata']]);
	f.service.dispose();
});

test('onSuccess con warning: stato finished conserva l\'avviso', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onSuccess({ models: [local('A')], warning: 'File dei modelli locali non trovati: b (x)' });
	assert.equal(f.service.state.voxLocal.state, 'finished');
	assert.equal(f.service.state.voxLocal.warning, 'File dei modelli locali non trovati: b (x)');
	f.service.dispose();
});

test('stesso avviso ripetuto in automatico non rinotifica; avviso tolto sì', () => {
	const f = load();
	let changes = 0;
	f.service.onDidChangeState(() => changes++);
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onSuccess({ models: [local('A')], warning: 'stesso avviso' });
	assert.equal(changes, 1);
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[1].onSuccess({ models: [local('A')], warning: 'stesso avviso' });
	assert.equal(changes, 1);
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[2].onSuccess({ models: [local('A')] });
	assert.equal(changes, 2);
	assert.equal(f.service.state.voxLocal.warning, undefined);
	f.service.dispose();
});

test('il rilevamento dice a setAutodetectedModels se è cambiato l\'uso o il contesto di un modello, anche con lo stesso elenco', () => {
	const f = load();
	const rounds = [[local('qwen')], [local('qwen')], [local('qwen', 4096, 'completamento')], [local('qwen', 4096, 'completamento')], [local('qwen', 8192, 'completamento')]];
	rounds.forEach((models, i) => { f.service.startRefreshingModels('voxLocal', opts); respond(f.calls[i], models); });
	assert.deepEqual(f.setAutodetectedCalls.map(args => args[3]), [true, false, true, false, true]);
});

test('onSuccess di voxLocal passa la mappa delle descrizioni a setAutodetectedModels, vuota se nessuna', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [
		{ ...local('qwen'), description: 'Chat veloce' },
		{ ...local('vuoto'), description: '' },
		local('senza'),
	]);
	assert.deepEqual(f.setAutodetectedCalls[0], [
		'voxLocal',
		['qwen', 'vuoto', 'senza'],
		{ qwen: 'Chat veloce' },
		true,
	]);
	// senza descrizioni la mappa arriva vuota, così quelle del giro precedente spariscono
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('qwen')]);
	assert.deepEqual(f.setAutodetectedCalls[1], ['voxLocal', ['qwen'], {}, true]);
	f.service.dispose();
});

test('il modello di completamento arriva con quelli da chat e il suo uso passa alle capacità prima dell\'elenco', () => {
	const f = load();
	let contextsAtUpdate;
	const set = f.settingsService.setAutodetectedModels;
	f.settingsService.setAutodetectedModels = (...args) => { contextsAtUpdate = load.contexts; set(...args); };
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [local('qwen3.5-9b', 8192), local('qwen2.5-coder-7b', 4096, 'completamento')]);
	assert.deepEqual(f.models, [['voxLocal', ['qwen3.5-9b', 'qwen2.5-coder-7b']]]);
	const expected = [{ name: 'qwen3.5-9b', contextWindow: 8192, uso: 'chat' }, { name: 'qwen2.5-coder-7b', contextWindow: 4096, uso: 'completamento' }];
	// l'aggiornamento dell'elenco fa ricontrollare i modelli scelti: a quel punto l'uso deve già essere noto
	assert.deepEqual(contextsAtUpdate, expected);
	assert.deepEqual(load.contexts, expected);
	f.service.dispose();
});

test('finestre di contesto e modelli di completamento: letti all\'avvio dalle due chiavi e riscritti solo quando cambiano', () => {
	const f = load({ saved: { [VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"a":4096,"c":8192}', [VOX_LOCAL_COMPLETION_MODELS_KEY]: '["c"]' } });
	// già alla costruzione, prima di qualunque rilevamento
	assert.deepEqual(load.contexts, [{ name: 'a', contextWindow: 4096 }, { name: 'c', contextWindow: 8192, uso: 'completamento' }]);
	assert.deepEqual(f.calls, []);
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[0], [local('a'), local('c', 8192, 'completamento')]);
	assert.deepEqual(f.storageWrites, [], 'stessi dati: nessuna scrittura (il rilevamento gira ogni 5 secondi)');
	// cambia solo l'uso: si riscrive solo la chiave dei modelli di completamento
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[1], [local('a', 4096, 'completamento'), local('c', 8192, 'completamento')]);
	assert.deepEqual(f.storageWrites, [[VOX_LOCAL_COMPLETION_MODELS_KEY, '["a","c"]', 1, 1]]);
	// cambia una finestra di contesto: si riscrive solo quella chiave
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[2], [local('a', 2048, 'completamento'), local('c', 8192, 'completamento')]);
	assert.deepEqual(f.storageWrites.slice(1), [[VOX_LOCAL_CONTEXT_WINDOWS_KEY, '{"a":2048,"c":8192}', 1, 1]]);
	// IA locali sparite: restano due valori vuoti, non quelli vecchi
	f.service.startRefreshingModels('voxLocal', opts);
	respond(f.calls[3], []);
	assert.equal(f.storage.get(VOX_LOCAL_CONTEXT_WINDOWS_KEY), '{}');
	assert.equal(f.storage.get(VOX_LOCAL_COMPLETION_MODELS_KEY), '[]');
	f.service.dispose();
});

test('valori salvati rovinati o di una versione precedente non bloccano l\'avvio', () => {
	// la versione precedente salvava solo le finestre di contesto
	load({ saved: { [VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{"a":4096}' } }).service.dispose();
	assert.deepEqual(load.contexts, [{ name: 'a', contextWindow: 4096 }]);
	load({ saved: { [VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '{rotto', [VOX_LOCAL_COMPLETION_MODELS_KEY]: '["c", 3, ""]' } }).service.dispose();
	assert.deepEqual(load.contexts, [{ name: 'c', contextWindow: undefined, uso: 'completamento' }]);
	load({ saved: { [VOX_LOCAL_CONTEXT_WINDOWS_KEY]: '[1]', [VOX_LOCAL_COMPLETION_MODELS_KEY]: '{"c":true}' } }).service.dispose();
	assert.deepEqual(load.contexts, []);
	load().service.dispose();
	assert.deepEqual(load.contexts, []);
});

test('voxLocal trovata senza modelli chat: la cartella si salva lo stesso (non risulta "non trovata")', () => {
	const f = load();
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[0].onSuccess({ models: [], warning: 'File dei modelli locali non trovati: a (D:/trovata/modelli/a.gguf)', folder: 'D:/trovata' });
	assert.equal(f.settingsService.state.settingsOfProvider.voxLocal.folder, 'D:/trovata');
	assert.equal(f.service.state.voxLocal.warning, 'File dei modelli locali non trovati: a (D:/trovata/modelli/a.gguf)');
	// una cartella scelta dall'utente non viene sovrascritta
	f.settingsService.state.settingsOfProvider.voxLocal.folder = 'E:/scelta';
	f.service.startRefreshingModels('voxLocal', opts);
	f.calls[1].onSuccess({ models: [], folder: 'D:/trovata' });
	assert.equal(f.settingsService.state.settingsOfProvider.voxLocal.folder, 'E:/scelta');
	f.service.dispose();
});

test('rilevamento acceso: cambiare o svuotare la cartella di voxLocal riavvia subito la ricerca, anche se il flag passa a falso', async () => {
	const f = load();
	f.init.resolve();
	await new Promise(resolve => setImmediate(resolve));
	const voxCalls = () => f.calls.filter(call => call.providerName === 'voxLocal').length;
	const before = voxCalls();
	const vox = f.settingsService.state.settingsOfProvider.voxLocal;
	// cartella sbagliata scelta: configurato (flag vero)
	vox.folder = 'E:/sbagliata'; vox._didFillInProviderSettings = true;
	f.settingsEmitter.fire();
	assert.equal(voxCalls(), before + 1);
	// svuotata per tornare alla ricerca automatica: il flag ricavato torna falso, ma la ricerca riparte
	vox.folder = ''; vox._didFillInProviderSettings = false;
	f.settingsEmitter.fire();
	assert.equal(voxCalls(), before + 2);
	// solo il flag cambia (per esempio modelli rilevati): nessun giro in più
	vox._didFillInProviderSettings = true;
	f.settingsEmitter.fire();
	assert.equal(voxCalls(), before + 2);
	f.service.dispose();
});

test('cartella trovata e salvata dal rilevamento: nessun giro in più, né acceso né spento; un cambio dell\'utente sì', async () => {
	for (const auto of [true, false]) {
		const f = load({ auto });
		// come il servizio vero: salvare un'impostazione notifica il cambio di stato
		const set = f.settingsService.setSettingOfProvider;
		f.settingsService.setSettingOfProvider = (provider, key, value) => { set(provider, key, value); f.settingsEmitter.fire(); };
		f.init.resolve();
		await new Promise(resolve => setImmediate(resolve));
		const voxCalls = () => f.calls.filter(call => call.providerName === 'voxLocal');
		const before = voxCalls().length;
		voxCalls().at(-1).onSuccess({ models: [local('A')], folder: 'D:/trovata' });
		assert.equal(f.settingsService.state.settingsOfProvider.voxLocal.folder, 'D:/trovata', `auto ${auto}`);
		assert.equal(voxCalls().length, before, `auto ${auto}: il salvataggio della cartella trovata non riavvia la ricerca`);
		// poi l'utente sceglie un'altra cartella: la ricerca riparte
		f.settingsService.state.settingsOfProvider.voxLocal.folder = 'E:/scelta';
		f.settingsEmitter.fire();
		assert.equal(voxCalls().length, before + 1, `auto ${auto}: il cambio dell'utente riavvia la ricerca`);
		f.service.dispose();
	}
});

test('salvataggio della cartella trovata senza notifica (scrittura fallita) o superato dall\'utente: il segno non sopprime le scelte successive', async () => {
	for (const auto of [true, false]) {
		const f = load({ auto });
		// come il servizio vero quando la scrittura fallisce: lo stato cambia subito, la notifica non arriva
		f.init.resolve();
		await new Promise(resolve => setImmediate(resolve));
		const voxCalls = () => f.calls.filter(call => call.providerName === 'voxLocal');
		const vox = f.settingsService.state.settingsOfProvider.voxLocal;
		const before = voxCalls().length;
		voxCalls().at(-1).onSuccess({ models: [local('A')], folder: 'D:/trovata' });
		assert.equal(vox.folder, 'D:/trovata');
		// l'utente la svuota prima che arrivi una notifica: la ricerca riparte una volta sola
		vox.folder = '';
		f.settingsEmitter.fire();
		const afterClear = voxCalls().length;
		// poi sceglie proprio quel percorso a mano: la ricerca riparte, il vecchio segno non la sopprime
		vox.folder = 'D:/trovata';
		f.settingsEmitter.fire();
		assert.equal(voxCalls().length, afterClear + 1, `auto ${auto}: la scelta dell'utente riavvia la ricerca`);
		assert.ok(afterClear <= before + 1, `auto ${auto}`);
		f.service.dispose();
	}
});
