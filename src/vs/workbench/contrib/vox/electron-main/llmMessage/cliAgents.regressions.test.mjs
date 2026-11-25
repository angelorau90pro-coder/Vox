import { evaluate } from '../../common/voxI18n.fixture.mjs';
// Regressioni eseguibili senza dipendenze o account CLI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const readSource = path => readFile(new URL(path, import.meta.url), 'utf8');
const types = await readSource('../../common/voxSettingsTypes.ts');
const splitCliAgentModel = evaluate(stripTypeScriptTypes(types.slice(types.indexOf('export const splitCliAgentModel'), types.indexOf('export type ProviderName')).replace('export ', '')) + '; return splitCliAgentModel;')();
const cliChat = async run => {
	const source = await readSource('./sendLLMMessage.impl.ts');
	const body = source.slice(source.indexOf('const sendCliChat ='), source.indexOf('export const sendLLMMessageToProviderImplementation'));
	return evaluate('runCliAgent', 'isCliAgentName', 'splitCliAgentModel', stripTypeScriptTypes(body) + '; return sendCliChat;')(run, name => name === 'codex', splitCliAgentModel);
};
const params = overrides => ({
	modelName: 'codex', settingsOfProvider: { cliAgent: { timeoutSeconds: '' } },
	messages: [], onText: () => {}, onFinalMessage: () => {}, onError: assert.fail, _setAborter: () => {}, ...overrides,
});

test('contenuti null, mancanti o non array non bloccano la serializzazione CLI', async () => {
	let received;
	const send = await cliChat(async options => { received = options; return 'ok'; });
	await send(params({ messages: [
		{ role: 'assistant', content: null }, { role: 'user', content: 42 },
		{ role: 'assistant', content: {} }, { role: 'user' },
		{ role: 'user', content: [null, 42, { type: 'text', text: 'testo' }, { type: 'tool_result', content: 'risultato' }] },
	] }));
	assert.equal(received.prompt, 'assistant:\n(risposta vuota)\n\nuser:\n\n\nassistant:\n(risposta vuota)\n\nuser:\n\n\nuser:\n\n\ntesto\nrisultato');
});

test('un errore durante la serializzazione chiama onError senza avviare la CLI', async () => {
	const send = await cliChat(assert.fail);
	const error = new Error('serializzazione fallita');
	let reported;
	await send(params({ messages: [{ role: 'user', get content() { throw error; } }], onFinalMessage: assert.fail, onError: value => { reported = value; } }));
	assert.deepEqual(reported, { message: error.message, fullError: null, noRetry: true });
});

test('un errore della CLI non viene riprovato: noRetry arriva alla chat', async () => {
	const send = await cliChat(async () => { throw new Error('accesso da fare'); });
	let reported;
	await send(params({ onFinalMessage: assert.fail, onError: value => { reported = value; } }));
	assert.deepEqual(reported, { message: 'accesso da fare', fullError: null, noRetry: true });
	// la chat riprova solo se noRetry manca
	const chat = await readSource('../../browser/chatThreadService.ts');
	assert.match(chat, /if \(nAttempts < CHAT_RETRIES && !llmRes\.error\?\.noRetry\)/);
});

test('una IA in CLI scelta male non viene riprovata', async () => {
	const send = await cliChat(assert.fail);
	let reported;
	await send(params({ modelName: 'codex:', onFinalMessage: assert.fail, onError: value => { reported = value; } }));
	assert.deepEqual(reported, { message: 'Selezionare una IA CLI nel formato ia oppure ia:modello.', fullError: null, noRetry: true });
});

test('il tempo massimo delle CLI: vuoto, mancante o di un altro tipo vale 600 secondi; un testo non numerico arriva a runCliAgent come NaN', async () => {
	const seen = [];
	const send = await cliChat(async options => { seen.push(options.timeoutMs); return 'ok'; });
	for (const timeoutSeconds of ['', '   ', undefined, null, [12], {}, true, '12', 12, ' 30 ', '1e3', 'abc', '12abc', NaN]) {
		await send(params({ settingsOfProvider: { cliAgent: { timeoutSeconds } } }));
	}
	assert.deepEqual(seen, [600_000, 600_000, 600_000, 600_000, 600_000, 600_000, 600_000, 12_000, 12_000, 30_000, 1_000_000, NaN, NaN, NaN]);
	// runCliAgent rifiuta un tempo non valido prima di avviare qualunque processo
	const agents = await readSource('./cliAgents.ts');
	assert.match(agents, /if \(!Number\.isFinite\(timeoutMs\) \|\| timeoutMs <= 0 \|\| timeoutMs > 2_147_483_647\) throw new Error\(t\("Invalid CLI timeout\."\)\);/);
});

test('il servizio conserva il workspace esplicito e usa il primo locale solo come ripiego', async () => {
	const source = await readSource('../../common/sendLLMMessageService.ts');
	const start = source.indexOf('sendLLMMessage(params:');
	const end = source.indexOf('\n\tcliAgentList =', start);
	const send = evaluate('generateUuid', 'providerNames', 'return ' + stripTypeScriptTypes('({' + source.slice(start, end) + '})') + '.sendLLMMessage;')(() => 'id', ['voxLocal', 'cliAgent']);
	// un fornitore che non esiste più non arriva nemmeno al processo principale
	{
		const errors = [];
		const service = { channel: { call: () => assert.fail('la richiesta non deve partire') } };
		assert.equal(send.call(service, { modelSelection: { providerName: 'anthropic', modelName: 'claude-opus-4-0' }, onError: error => errors.push(error) }), null);
		assert.deepEqual(errors, [{ message: 'Scegli un modello nelle Impostazioni di Vox.', fullError: null }]);
	}
	for (const [workspaceFolder, expected] of [['esplicito', 'esplicito'], [undefined, 'locale'], [null, 'locale']]) {
		let forwarded, lookups = 0;
		const service = {
			voxSettingsService: { state: { settingsOfProvider: {} } }, mcpService: { getMCPTools: () => [] },
			llmMessageHooks: { onText: {}, onFinalMessage: {}, onError: {}, onAbort: {} },
			workspaceContextService: { getWorkspace: () => { lookups++; return { folders: [{ uri: { scheme: 'remote', fsPath: 'remoto' } }, { uri: { scheme: 'file', fsPath: 'locale' } }] }; } },
			// Come il canale IPC vero, call restituisce una promessa (il servizio ne intercetta il rifiuto).
			channel: { call: (_, value) => { forwarded = value; return Promise.resolve(); } },
		};
		assert.equal(send.call(service, { modelSelection: { providerName: 'cliAgent', modelName: 'codex' }, workspaceFolder }), 'id');
		assert.equal(forwarded.workspaceFolder, expected);
		assert.equal(lookups, workspaceFolder === 'esplicito' ? 0 : 1);
	}
});

test('la rilevazione ripristina gli autorilevati e preserva i modelli manuali', async () => {
	const source = await readSource('../../browser/react/src/vox-settings-tsx/Settings.tsx');
	const start = source.indexOf('const discover = async () =>', source.indexOf('const CliAgentDiscovery ='));
	const end = source.indexOf('\n\tuseEffect(', start);
	const manual = { modelName: 'codex:manuale', type: 'custom', isHidden: false };
	const settingsService = { state: { settingsOfProvider: { cliAgent: { models: [{ modelName: 'codex', type: 'autodetected', isHidden: true }, manual, { modelName: 'agy', type: 'default', isHidden: false }] } } },
		setSettingOfProvider: async (_, __, models) => { settingsService.state.settingsOfProvider.cliAgent.models = models; } };
	const detected = [];
	let found = ['codex'];
	const run = evaluate('llmMessageService', 'settingsService', 'setBusy', 'setError', 'setInstalled', 'splitCliAgentModel', 'onDetected', source.slice(start, end) + '; return discover;')(
		{ cliAgentList: async () => found }, settingsService, () => {}, message => { if (message) assert.fail(message); }, () => {}, splitCliAgentModel, agents => detected.push(agents));
	await run();
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[0].isHidden, false);
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[2].isHidden, true);
	found = [];
	await run();
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[0].isHidden, true);
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[1], manual);
	found = ['agy'];
	await run();
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[2].isHidden, false);
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[1], manual);
	found = ['codex'];
	await run();
	assert.equal(settingsService.state.settingsOfProvider.cliAgent.models[0].isHidden, false);
	assert.deepEqual(detected, [[], ['codex'], [], [], [], ['agy'], [], ['codex']]);
});


test('il canale segnala rejection inattese e rimuove la richiesta', async () => {
	const source = await readSource('../sendLLMMessageChannel.ts');
	const start = source.indexOf('private _callSendLLMMessage(');
	const end = source.indexOf('private async _callAbort(', start);
	const body = source.slice(start, end).replace('private ', '');
	const failure = new Error('richiesta fallita');
	const call = evaluate('sendLLMMessage', 'return ' + stripTypeScriptTypes('({' + body + '})') + '._callSendLLMMessage;')(() => Promise.reject(failure));
	const errors = [];
	const channel = { _infoOfRunningRequest: {}, llmMessageEmitters: { onError: { fire: value => errors.push(value) } } };
	call.call(channel, { requestId: 'id' });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(errors, [{ requestId: 'id', message: failure.message, fullError: null }]);
	assert.deepEqual(channel._infoOfRunningRequest, {});
});

test('il canale: Stop funziona anche dopo che sendLLMMessage si è risolto (stream in corso); la risposta finale rimuove la richiesta', async () => {
	const source = await readSource('../sendLLMMessageChannel.ts');
	const start = source.indexOf('private _callSendLLMMessage(');
	const end = source.indexOf('_callVoxLocalList', start);
	assert.ok(start >= 0 && end > start, 'forma di sendLLMMessageChannel.ts cambiata: aggiornare i confini del test');
	const body = source.slice(start, end).replaceAll('private ', '');
	let params, aborted = 0;
	// come i fornitori OpenAI-compatibili: registra l'annullamento e si risolve appena parte lo stream
	const fakeSend = async p => { params = p; p.abortRef.current = () => aborted++ };
	const api = evaluate('sendLLMMessage', 'return ' + stripTypeScriptTypes('(class {' + body + '})') + '.prototype;')(fakeSend);
	const finals = [];
	const channel = { _infoOfRunningRequest: {}, llmMessageEmitters: { onText: { fire() {} }, onFinalMessage: { fire: value => finals.push(value) }, onError: { fire() {} } } };
	api._callSendLLMMessage.call(channel, { requestId: 'uno' });
	await new Promise(resolve => setImmediate(resolve));
	assert.ok('uno' in channel._infoOfRunningRequest, 'la richiesta deve restare annullabile mentre lo stream è in corso');
	await api._callAbort.call(channel, { requestId: 'uno' });
	assert.equal(aborted, 1); assert.deepEqual(channel._infoOfRunningRequest, {});
	api._callSendLLMMessage.call(channel, { requestId: 'due' });
	await new Promise(resolve => setImmediate(resolve));
	params.onFinalMessage({ fullText: 'ok', fullReasoning: '' });
	assert.deepEqual(channel._infoOfRunningRequest, {}); assert.equal(finals.length, 1);
	// uno Stop arrivato dopo la fine non richiama l'annullamento
	await api._callAbort.call(channel, { requestId: 'due' });
	assert.equal(aborted, 1);
});
