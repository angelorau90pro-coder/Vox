import { evaluate } from '../../common/voxI18n.fixture.mjs';
// Eseguire con Node >= 22.18, senza installare le dipendenze del worktree.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const readSource = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8');
const types = await readSource('../../common/voxSettingsTypes.ts');
const splitCliAgentModel = evaluate(stripTypeScriptTypes(types.slice(types.indexOf('export const splitCliAgentModel'), types.indexOf('export type ProviderName')).replace('export ', '')) + '; return splitCliAgentModel;')();
// la guardia vera dei fornitori ammessi e `sendLLMMessage` senza importazioni, con l'elenco delle implementazioni dato dal test
const { isAllowedProviderName, allowedProviderNames } = new Function(stripTypeScriptTypes(await readSource('./providerGuard.ts')).replace(/^export /gm, '') + '; return { isAllowedProviderName, allowedProviderNames };')();
const loadSendLLMMessage = async implementations => {
	const source = (await readSource('./sendLLMMessage.ts')).replace(/^import .*;\r?\n/gm, '');
	const moduleSource = stripTypeScriptTypes(source).replace('export const sendLLMMessage', 'const sendLLMMessage');
	return evaluate('sendLLMMessageToProviderImplementation', 'isAllowedProviderName', moduleSource + '; return sendLLMMessage;')(implementations, isAllowedProviderName);
};

test('il provider passa workspace, cronologia, modello e abort senza chiamate Vox', async () => {
	const source = await readSource('./sendLLMMessage.impl.ts');
	const start = source.indexOf('const sendCliChat =');
	const end = source.indexOf('export const sendLLMMessageToProviderImplementation', start);
	assert.ok(start >= 0 && end > start);
	let received, abort, final;
	const send = evaluate('runCliAgent', 'isCliAgentName', 'splitCliAgentModel', stripTypeScriptTypes(source.slice(start, end)) + '; return sendCliChat;')(
		async options => { received = options; options.onText('risposta'); return 'risposta'; }, agent => agent === 'codex', splitCliAgentModel);
	await send({
		modelName: 'codex:modello', settingsOfProvider: { cliAgent: { timeoutSeconds: '12', codexCommand: 'comando' } },
		messages: [{ role: 'user', content: 'prima' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'privato' }, { type: 'text', text: 'risposta precedente' }] }, { role: 'user', content: 'ultima' }],
		separateSystemMessage: 'sistema', workspaceFolder: 'workspace', chatMode: 'normal',
		onText: update => assert.deepEqual(update, { fullText: 'risposta', fullReasoning: '' }),
		onFinalMessage: message => { final = message; }, onError: assert.fail,
		_setAborter: fn => { abort = fn; },
	});
	assert.equal(received.agent, 'codex');
	assert.equal(received.model, 'modello');
	assert.equal(received.cwd, 'workspace');
	assert.equal(received.write, false);
	assert.equal(received.timeoutMs, 12000);
	assert.equal(received.prompt, 'system:\nsistema\n\nuser:\nprima\n\nassistant:\n\nrisposta precedente\n\nuser:\nultima');
	assert.deepEqual(final, { fullText: 'risposta', fullReasoning: '' });
	abort();
	assert.equal(received.signal.aborted, true);
});

test('un abort anticipato raggiunge anche un aborter registrato dopo un await', async () => {
	let release, cancelled = false;
	const ready = new Promise(resolve => { release = resolve; });
	const send = await loadSendLLMMessage({
		cliAgent: { sendChat: async ({ _setAborter }) => { await ready; _setAborter(() => { cancelled = true; }); } },
	});
	const abortRef = { current: null };
	const request = send({
		messagesType: 'chatMessages', messages: [], modelSelection: { providerName: 'cliAgent', modelName: 'codex' },
		settingsOfProvider: { cliAgent: { models: [] } }, abortRef,
		onText: assert.fail, onFinalMessage: assert.fail, onError: assert.fail,
	});
	abortRef.current();
	release();
	await request;
	assert.equal(cancelled, true);
});

test('solo IA locali e IA in CLI: un altro fornitore è rifiutato prima di ogni implementazione, evento o impostazione', async () => {
	assert.deepEqual([...allowedProviderNames], ['voxLocal', 'cliAgent']);
	for (const name of ['anthropic', 'openAI', 'ollama', 'openAICompatible', 'lmStudio', 'VoxLocal', 'constructor', '__proto__', 'toString', '', null, undefined, 3, {}, ['voxLocal']]) {
		assert.equal(isAllowedProviderName(name), false, String(name));
	}
	const calls = [];
	const spy = name => ({ sendChat: async () => { calls.push(name + ':chat'); }, sendFIM: async () => { calls.push(name + ':fim'); } });
	// anche se un'implementazione esistesse ancora sotto quel nome, non deve essere raggiunta
	const send = await loadSendLLMMessage({ voxLocal: spy('voxLocal'), cliAgent: { ...spy('cliAgent'), sendFIM: null }, anthropic: spy('anthropic'), ollama: spy('ollama') });
	const request = (providerName, messagesType = 'chatMessages') => {
		const errors = [], abortRef = { current: null };
		const done = send({
			messagesType, messages: messagesType === 'chatMessages' ? [] : { prefix: 'a', suffix: 'b', stopTokens: [] },
			modelSelection: { providerName, modelName: 'modello' },
			// impostazioni di una versione precedente, con la chiave ancora dentro: non devono servire a niente
			settingsOfProvider: { voxLocal: { models: [] }, cliAgent: { models: [] }, anthropic: { apiKey: 'chiave-fittizia', models: [] } },
			abortRef, onText: assert.fail, onFinalMessage: assert.fail, onError: error => errors.push(error),
		});
		return done.then(() => ({ errors, abortRef }));
	};
	for (const providerName of ['anthropic', 'ollama', 'openAICompatible', '__proto__', 'constructor']) {
		for (const messagesType of ['chatMessages', 'FIMMessage']) {
			const { errors, abortRef } = await request(providerName, messagesType);
			assert.equal(errors.length, 1, providerName);
			assert.equal(errors[0].noRetry, true);
			assert.equal(errors[0].fullError, null);
			assert.match(errors[0].message, /Vox usa solo le IA locali e le IA in CLI/);
			assert.ok(errors[0].message.includes(`"${providerName}"`));
			assert.equal(abortRef.current, null);
		}
	}
	assert.deepEqual(calls, []);
	// i due motori rimasti passano; il completamento automatico con una CLI dà un errore chiaro, senza riprovare
	assert.deepEqual((await request('voxLocal')).errors, []);
	assert.deepEqual((await request('voxLocal', 'FIMMessage')).errors, []);
	assert.deepEqual((await request('cliAgent')).errors, []);
	const cliFim = await request('cliAgent', 'FIMMessage');
	assert.deepEqual(calls, ['voxLocal:chat', 'voxLocal:fim', 'cliAgent:chat']);
	assert.equal(cliFim.errors.length, 1);
	assert.equal(cliFim.errors[0].noRetry, true);
	assert.match(cliFim.errors[0].message, /completamento automatico funziona solo con il modello di completamento delle IA locali/);
});

test('le CLI ignorano override che abilitano tool, FIM o reasoning di Vox', async () => {
	const source = (await readSource('../../common/modelCapabilities.ts')).replace(/^import .*;\r?\n/gm, '');
	const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
	for (const agent of ['codex', 'agy', 'devin', 'copilot', 'opencode', 'kimi', 'claude']) {
		const modelName = agent + ':custom';
		const capabilities = module.getModelCapabilities('cliAgent', modelName, {
			cliAgent: { [modelName]: {
				supportsFIM: true,
				specialToolFormat: 'openai-style',
				reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
			} },
		});
		assert.equal(capabilities.supportsFIM, false, agent);
		assert.equal(capabilities.specialToolFormat, undefined, agent);
		assert.equal(capabilities.reasoningCapabilities, false, agent);
		assert.equal(capabilities.supportsSystemMessage, 'system-role', agent);
	}
});

test('la cronologia CLI conserva istruzioni e risultati senza tool XML o reasoning', async () => {
	const source = await readSource('../../browser/convertToLLMMessageService.ts');
	// Estrae la funzione pura per evitare le dipendenze browser e i decoratori dei servizi.
	const start = source.indexOf('const prepareMessages =');
	const end = source.indexOf('export interface IConvertToLLMMessageService', start);
	assert.ok(start >= 0 && end > start, 'Funzione di conversione disponibile');
	// costanti e funzioni d'appoggio della stima del contesto (caratteri per token, lunghezza dei parametri)
	const helpersStart = source.indexOf('const CHARS_PER_TOKEN =');
	const helpersEnd = source.indexOf('// convert messages as if about to send to openai', helpersStart);
	assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'Funzioni d’appoggio disponibili');
	const body = stripTypeScriptTypes(source.slice(helpersStart, helpersEnd) + source.slice(start, end));
	// misura dei caratteri di un messaggio, dal modulo vero del pannello di contesto
	const usageSource = await readSource('../../common/contextUsage.ts');
	const { promptCharsOf, systemPartsOf } = new Function(stripTypeScriptTypes(usageSource).replace(/^export /gm, '') + '; return { promptCharsOf, systemPartsOf };')();
	const prepare = evaluate('deepClone', 'EMPTY_MESSAGE', 'promptCharsOf', 'systemPartsOf', body + '; return prepareMessages;')(structuredClone, '(empty message)', promptCharsOf, systemPartsOf);
	const messages = [
		{ role: 'user', content: 'prima' },
		{ role: 'assistant', content: 'risposta', anthropicReasoning: [{ type: 'thinking', thinking: 'ragionamento interno' }] },
		{ role: 'tool', content: 'risultato lettura', id: '1', name: 'read_file', rawParams: {} },
		{ role: 'user', content: 'ultima' },
	];
	const original = structuredClone(messages);
	const result = prepare({
		messages, systemMessage: 'contesto di sistema', aiInstructions: 'regole utente',
		supportsSystemMessage: 'system-role', specialToolFormat: undefined,
		contextWindow: 32768,
		reservedOutputTokenSpace: 4096, providerName: 'cliAgent',
	});
	assert.deepEqual(result.messages.slice(1), [
		{ role: 'user', content: 'prima' },
		{ role: 'assistant', content: 'risposta' },
		{ role: 'user', content: 'risultato lettura' },
		{ role: 'user', content: 'ultima' },
	]);
	assert.equal(result.messages[0].role, 'system');
	assert.match(result.messages[0].content, /contesto di sistema/);
	assert.match(result.messages[0].content, /regole utente/);
	assert.deepEqual(messages, original);
});
