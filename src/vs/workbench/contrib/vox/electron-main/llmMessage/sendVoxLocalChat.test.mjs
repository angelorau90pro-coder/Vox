import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const source = await readFile(new URL('./sendLLMMessage.impl.ts', import.meta.url), 'utf8');
const start = source.indexOf('const sendVoxLocalChat =');
const end = source.indexOf('const MAX_CONTEXT_RETRIES', start);
assert.ok(start >= 0 && end > start);
const retryLimit = /const MAX_CONTEXT_RETRIES = (\d+)/.exec(source);
assert.ok(retryLimit);
const MAX_CONTEXT_RETRIES = Number(retryLimit[1]);
const fitSource = await readFile(new URL('./localContextFit.ts', import.meta.url), 'utf8');
const { contextOverflowOf, shrinkToFit, takeRequestMark } = evaluate(stripTypeScriptTypes(fitSource).replace(/^export /gm, '') + '; return { contextOverflowOf, shrinkToFit, takeRequestMark };')();
const overflow = { message: 'contesto esaurito', fullError: { error: { n_prompt_tokens: 11000, n_ctx: 10000 } } };
const messages = () => [{ role: 'system', content: 'istruzioni '.repeat(10000) }, { role: 'user', content: 'domanda' }];

function harness(transport, initialMessages = messages()) {
	const calls = [], texts = [], finals = [], errors = [];
	let releases = 0, acquisitions = 0, abort;
	const send = evaluate('localModelManager', '_sendOpenAICompatibleChat', 'contextOverflowOf', 'shrinkToFit', 'takeRequestMark', 'MAX_CONTEXT_RETRIES',
		stripTypeScriptTypes(source.slice(start, end)) + '; return sendVoxLocalChat;')({
		acquire: async () => { acquisitions++; return { baseURL: 'http://127.0.0.1:8192/v1', release: () => { releases++ } } },
	}, async params => { calls.push(params); await transport(params, calls.length) }, contextOverflowOf, shrinkToFit, takeRequestMark, MAX_CONTEXT_RETRIES);
	const params = {
		modelName: 'a', settingsOfProvider: { voxLocal: { folder: 'locale' } }, messages: initialMessages,
		onText: update => texts.push(update), onFinalMessage: result => finals.push(result), onError: error => errors.push(error),
		_setAborter: fn => { abort = fn },
	};
	return { calls, texts, finals, errors, params, run: () => send(params), stop: () => abort(),
		get releases() { return releases }, get acquisitions() { return acquisitions } };
}

// I tentativi successivi partono dalle callback e possono terminare dopo la promessa iniziale.
const flush = () => new Promise(resolve => setImmediate(resolve));

test('contesto esaurito: accorcia, segnala lo stato e conclude con un solo rilascio', async () => {
	const result = { fullText: 'risposta' };
	const h = harness(async (params, attempt) => {
		params._setAborter(() => {});
		if (attempt === 1) params.onError(overflow);
		else params.onFinalMessage(result);
	});
	await h.run(); await flush();
	assert.equal(h.calls.length, 2);
	assert.equal(h.acquisitions, 1);
	assert.ok(h.calls[1].messages[0].content.length < h.calls[0].messages[0].content.length);
	assert.equal(h.calls[1].messages[1].content, 'domanda');
	assert.equal(h.calls[1].voxLocalBaseURL, 'http://127.0.0.1:8192/v1');
	assert.equal(h.texts.length, 1);
	assert.match(h.texts[0].statusText, /accorcio i messaggi/);
	assert.deepEqual(h.finals, [result]);
	assert.deepEqual(h.errors, []);
	assert.equal(h.releases, 1);
});

test('contesto sempre esaurito: tre nuovi invii al massimo e noRetry', async () => {
	const h = harness(async params => params.onError(overflow));
	await h.run(); await flush();
	assert.equal(MAX_CONTEXT_RETRIES, 3);
	assert.equal(h.calls.length, 4);
	assert.equal(h.texts.length, 3);
	assert.deepEqual(h.finals, []);
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0].noRetry, true);
	assert.equal(h.errors[0].fullError, overflow.fullError);
	assert.equal(h.releases, 1);
	assert.equal(h.acquisitions, 1);
});

test('fitted falso: errore immediato senza nuovi invii', async () => {
	const initial = [{ role: 'user', content: 'domanda '.repeat(10000) }];
	assert.equal(shrinkToFit(initial, contextOverflowOf(overflow.fullError)).fitted, false);
	const h = harness(async params => params.onError(overflow), initial);
	await h.run(); await flush();
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.texts, []);
	assert.deepEqual(h.finals, []);
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0].noRetry, true);
	assert.equal(h.releases, 1);
});

test('Stop fra errore e nuovo invio annulla subito la nuova richiesta senza callback finali', async () => {
	let canceled = 0;
	const h = harness(async (params, attempt) => {
		let aborted = false;
		if (attempt === 2) await Promise.resolve();
		params._setAborter(() => { aborted = true; canceled++ });
		if (attempt === 1) params.onError(overflow);
		else {
			assert.equal(aborted, true);
			// Come il trasporto reale, una richiesta annullata non emette callback terminali.
			if (!aborted) params.onFinalMessage({ fullText: 'tardiva' });
		}
	});
	h.params.onText = update => { h.texts.push(update); h.stop() };
	await h.run(); await flush();
	assert.equal(h.calls.length, 2);
	assert.equal(canceled, 2);
	assert.deepEqual(h.finals, []);
	assert.deepEqual(h.errors, []);
	assert.equal(h.releases, 1);
});

test('errore diverso dal contesto passa invariato e rilascia una volta', async () => {
	const error = { message: 'connessione persa', fullError: Error('ECONNRESET') };
	const h = harness(async params => params.onError(error));
	await h.run(); await flush();
	assert.equal(h.calls.length, 1);
	assert.equal(h.errors.length, 1);
	assert.equal(h.errors[0], error);
	assert.deepEqual(h.finals, []);
	assert.deepEqual(h.texts, []);
	assert.equal(h.releases, 1);
});

test('segno della domanda: non arriva a llama-server e protegge la domanda fusa con un risultato a ogni tentativo', async () => {
	// come `prepareMessages_XML_tools` dopo un errore o uno Stop: il risultato e la nuova domanda nello stesso messaggio;
	// la domanda finisce con un tag XML, quindi dal solo testo sembrerebbe un risultato
	const question = 'spiega perché il mio output finisce con </read_file_result>';
	const fused = '<read_file_result>\n' + 'f'.repeat(60000) + '\n</read_file_result>\n\n' + question;
	const initial = [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'leggi il file' }, { role: 'assistant', content: '<read_file><uri>/a.ts</uri></read_file>' }, { role: 'user', content: fused, voxRequestChars: question.length }];
	const h = harness(async (params, attempt) => {
		if (attempt < 3) params.onError({ message: 'contesto esaurito', fullError: { error: { n_prompt_tokens: attempt === 1 ? 20000 : 9000, n_ctx: 8192 } } });
		else params.onFinalMessage({ fullText: 'ok' });
	}, initial);
	await h.run(); await flush();
	assert.equal(h.calls.length, 3);
	for (const call of h.calls) {
		assert.ok(call.messages.every(message => !('voxRequestChars' in message)), 'il segno non va al modello');
		assert.ok(call.messages[3].content.endsWith('\n\n' + question), 'la domanda resta intera');
	}
	assert.ok(h.calls[2].messages[3].content.length < h.calls[1].messages[3].content.length && h.calls[1].messages[3].content.length < fused.length);
	assert.ok(h.calls[2].messages[3].content.startsWith('<read_file_result>\n'));
	assert.equal(initial[3].voxRequestChars, question.length, 'i messaggi del chiamante non si modificano');
	assert.deepEqual(h.finals, [{ fullText: 'ok' }]);
	assert.equal(h.releases, 1);
});
