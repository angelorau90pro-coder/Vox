// Servizio delle richieste all'IA nella finestra (sendLLMMessageService.ts): gli ascoltatori di ogni richiesta si
// tolgono sempre, e una chiamata al canale che fallisce arriva a chi ha fatto la richiesta.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./sendLLMMessageService.ts', import.meta.url), 'utf8');

// La classe senza import e decoratori: il canale, le impostazioni e gli altri servizi sono finti.
const classStart = source.indexOf('export class LLMMessageService');
const classEnd = source.indexOf('registerSingleton(ILLMMessageService');
assert.ok(classStart > 0 && classEnd > classStart, 'forma di LLMMessageService cambiata: aggiornare il test');
const classBody = stripTypeScriptTypes(source.slice(classStart, classEnd)
	.replace(/^export /, '')
	.replace(/@I\w+ /g, ''), { mode: 'transform' }); // transform: il costruttore ha proprietà nei parametri
const LLMMessageService = new Function('Disposable', 't', 'generateUuid', 'providerNames', `${classBody}\nreturn LLMMessageService;`)(
	class { _register(x) { return x; } },
	s => s,
	(() => { let n = 0; return () => `req-${++n}`; })(),
	['voxLocal', 'cliAgent'],
);

const makeService = ({ callResult = () => Promise.resolve() } = {}) => {
	const listeners = {};
	const calls = [];
	const channel = {
		listen: event => cb => { listeners[event] = cb; return { dispose() { } }; },
		call: (command, params) => { calls.push({ command, params }); return callResult(command, params); },
	};
	const svc = new LLMMessageService(
		{ getChannel: () => channel },
		{ state: { settingsOfProvider: { cliAgent: {} } } },
		{ getMCPTools: () => undefined },
		{ getWorkspace: () => ({ folders: [] }) },
	);
	return { svc, listeners, calls };
};
const params = hooks => ({ messagesType: 'chatMessages', messages: [{ role: 'user', content: 'ciao' }], modelSelection: { providerName: 'cliAgent', modelName: 'codex' }, onText() { }, onFinalMessage() { }, onError() { }, onAbort() { }, ...hooks });
const hookCount = svc => Object.values(svc.llmMessageHooks).reduce((n, hooks) => n + Object.keys(hooks).length, 0);

test('risposta finale, errore e interruzione tolgono tutti gli ascoltatori della richiesta (anche onAbort)', async () => {
	const { svc, listeners } = makeService();
	const done = svc.sendLLMMessage(params());
	listeners.onFinalMessage_sendLLMMessage({ requestId: done, fullText: 'ok' });
	const failed = svc.sendLLMMessage(params());
	listeners.onError_sendLLMMessage({ requestId: failed, message: 'x', fullError: null });
	let aborted = 0;
	const stopped = svc.sendLLMMessage(params({ onAbort: () => aborted++ }));
	svc.abort(stopped);
	svc.abort(stopped);
	assert.equal(aborted, 1);
	await new Promise(r => setTimeout(r, 0));
	assert.equal(hookCount(svc), 0);
});

test('una chiamata al canale rifiutata arriva a onError e toglie gli ascoltatori', async () => {
	const { svc } = makeService({ callResult: command => command === 'sendLLMMessage' ? Promise.reject(new Error('canale chiuso')) : Promise.resolve() });
	const errors = [];
	const requestId = svc.sendLLMMessage(params({ onError: e => errors.push(e) }));
	await new Promise(r => setTimeout(r, 0));
	assert.equal(errors.length, 1);
	assert.equal(errors[0].message, 'canale chiuso');
	assert.equal(errors[0].requestId, requestId);
	assert.equal(hookCount(svc), 0);
});

test('elenco dei modelli locali: una chiamata rifiutata arriva a onError', async () => {
	const { svc } = makeService({ callResult: () => Promise.reject(new Error('no')) });
	const errors = [];
	svc.voxLocalList({ providerName: 'voxLocal', onSuccess() { }, onError: e => errors.push(e) });
	await new Promise(r => setTimeout(r, 0));
	assert.equal(errors.length, 1);
	assert.equal(errors[0].error, 'no');
	assert.equal(Object.keys(svc.listHooks.voxLocal.error).length, 0);
});

test('i nomi dei canali e dei comandi sono quelli del processo principale', async () => {
	const app = await readFile(new URL('../../../../code/electron-main/app.ts', import.meta.url), 'utf8');
	const mainChannel = await readFile(new URL('../electron-main/sendLLMMessageChannel.ts', import.meta.url), 'utf8');
	for (const name of ['vox-channel-llmMessage', 'vox-channel-scm', 'vox-channel-debug-info', 'vox-channel-mcp']) {
		assert.match(app, new RegExp(`registerChannel\\('${name}'`), name);
	}
	for (const command of [...source.matchAll(/this\.channel\.call(?:<[^>]+>)?\('(\w+)'/g)].map(m => m[1])) {
		assert.match(mainChannel, new RegExp(`command === '${command}'`), command);
	}
	for (const event of [...source.matchAll(/this\.channel\.listen\('(\w+)'\)/g)].map(m => m[1])) {
		assert.match(mainChannel, new RegExp(`event === '${event}'`), event);
	}
});
