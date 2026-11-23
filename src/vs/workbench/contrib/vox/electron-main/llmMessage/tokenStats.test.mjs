// Conteggio dei token di una risposta in streaming: conteggi del motore, `usage` finale e stima dai pezzi.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const source = stripTypeScriptTypes((await read('./tokenStats.ts')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const { createTokenStatsTracker } = new Function(source + '; return { createTokenStatsTracker };')();
const piece = (delta, extra = {}) => ({ choices: [{ delta }], ...extra });

test('senza conteggi del motore: un pezzo con contenuto vale un token e la velocità parte dal primo pezzo', () => {
	let clock = 10_000;
	const tracker = createTokenStatsTracker(() => clock);
	assert.deepEqual(tracker.current(), { generated: 0, tokensPerSecond: null, promptTokens: null, exact: false, speedExact: false });
	// il ruolo iniziale e i pezzi vuoti non sono token
	tracker.onChunk(piece({ role: 'assistant', content: '' }));
	tracker.onChunk(piece({}));
	tracker.onChunk({ choices: [] });
	assert.equal(tracker.current().generated, 0);
	clock += 5000; // lettura del prompt: non conta nella velocità
	assert.deepEqual(tracker.onChunk(piece({ content: 'Ciao' })), { generated: 1, tokensPerSecond: null, promptTokens: null, exact: false, speedExact: false });
	clock += 100; tracker.onChunk(piece({ reasoning_content: 'penso' }));
	clock += 100; tracker.onChunk(piece({ reasoning: 'ancora' }));
	clock += 100; tracker.onChunk(piece({ tool_calls: [{ index: 0, function: { arguments: '{' } }] }));
	clock += 100;
	// 5 pezzi in 400 ms dal primo all'ultimo: 4 intervalli, 10 token al secondo
	assert.deepEqual(tracker.onChunk(piece({ content: '!' })), { generated: 5, tokensPerSecond: 10, promptTokens: null, exact: false, speedExact: false });
	// il tempo che passa senza pezzi nuovi non cambia la velocità già misurata
	clock += 60_000;
	assert.equal(tracker.current().tokensPerSecond, 10);
});

test('conteggi di llama-server a ogni pezzo: valgono quelli, non la stima', () => {
	let clock = 0;
	const tracker = createTokenStatsTracker(() => clock);
	tracker.onChunk(piece({ content: 'a' }, { timings: { predicted_n: 1, predicted_per_second: 1000000 } }));
	clock += 50;
	// un pezzo può portare più token (o nessun testo visibile): conta `predicted_n`
	assert.deepEqual(tracker.onChunk(piece({ content: 'bc' }, { timings: { prompt_n: 900, predicted_n: 7, predicted_per_second: 41.26 } })),
		{ generated: 7, tokensPerSecond: 41.3, promptTokens: null, exact: true, speedExact: true });
	// valori non validi non cancellano quelli buoni
	for (const timings of [null, 'x', {}, { predicted_n: 0, predicted_per_second: 0 }, { predicted_n: -3, predicted_per_second: Number.NaN }, { predicted_n: '9', predicted_per_second: Infinity }]) {
		assert.deepEqual(tracker.onChunk(piece({}, { timings })), { generated: 7, tokensPerSecond: 41.3, promptTokens: null, exact: true, speedExact: true });
	}
});

test('ultimo pezzo con `usage`: token generati e token del prompt esatti, anche senza `choices`', () => {
	let clock = 0;
	const tracker = createTokenStatsTracker(() => clock);
	for (let i = 0; i < 4; i++) { tracker.onChunk(piece({ content: 'x' })); clock += 250 }
	assert.deepEqual(tracker.current(), { generated: 4, tokensPerSecond: 4, promptTokens: null, exact: false, speedExact: false });
	// `usage` corregge il numero di token; la velocità resta quella stimata se il motore non la dà
	assert.deepEqual(tracker.onChunk({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 6, total_tokens: 1206 } }),
		{ generated: 6, tokensPerSecond: 4, promptTokens: 1200, exact: true, speedExact: false });
	// con i `timings` finali arriva anche la velocità del motore
	assert.deepEqual(tracker.onChunk({ choices: [], timings: { predicted_n: 6, predicted_per_second: 5.04 } }),
		{ generated: 6, tokensPerSecond: 5, promptTokens: 1200, exact: true, speedExact: true });
	// `usage` non valido non tocca niente
	for (const usage of [null, 7, { completion_tokens: 'sei', prompt_tokens: -1 }]) assert.equal(tracker.onChunk({ usage }).generated, 6);
});

test('pezzi che non sono oggetti o senza forma attesa non fanno cadere niente', () => {
	const tracker = createTokenStatsTracker(() => 0);
	for (const chunk of [null, undefined, 'testo', 42, {}, { choices: 'x' }, { choices: [null] }, { choices: [{ delta: 'x' }] }, { choices: [{ delta: { content: 5, tool_calls: [] } }] }]) {
		assert.deepEqual(tracker.onChunk(chunk), { generated: 0, tokensPerSecond: null, promptTokens: null, exact: false, speedExact: false });
	}
});

test('la richiesta a llama-server chiede i conteggi e la chat li riceve a ogni pezzo e a fine risposta', async () => {
	const impl = (await read('./sendLLMMessage.impl.ts')).replace(/\r\n/g, '\n');
	const send = impl.slice(impl.indexOf('const _sendOpenAICompatibleChat'), impl.indexOf('type CallFnOfProvider'));
	assert.match(send, /stream_options: \{ include_usage: true \},/);
	assert.match(send, /timings_per_token: true/);
	assert.match(send, /for await \(const chunk of response\) \{\n\t\t\t\ttokenStats\.onChunk\(chunk\)/);
	// i conteggi si agganciano prima degli adattatori di ragionamento e strumenti, che potrebbero non inoltrarli
	const hook = send.indexOf('onText = p => onTextWithoutStats(withTokenStats(p))');
	assert.ok(hook > 0 && hook < send.indexOf('extractReasoningWrapper(') && hook < send.indexOf('extractXMLToolsWrapper('));
	assert.match(send, /onFinalMessage = p => onFinalMessageWithoutStats\(withTokenStats\(p\)\)/);
	// senza token generati (per esempio solo uno stato di avvio) non si manda nessun conteggio
	// con i conteggi va anche la lunghezza del prompt inviato, che il pannello di contesto usa per la calibrazione
	assert.match(send, /return stats\.generated > 0 \? \{ \.\.\.p, tokenStats: \{ \.\.\.stats, promptChars, promptModel: modelName_ \} \} : p/);

	const chat = (await read('../../browser/chatThreadService.ts')).replace(/\r\n/g, '\n');
	assert.match(chat, /tokenStatsSoFar: tokenStats \}/);
	// la risposta finita, quella interrotta dall'utente e quella chiusa da un errore conservano i conteggi
	assert.equal(chat.match(/\.\.\.\(tokenStatsSoFar \? \{ tokenStats: tokenStatsSoFar \} : \{\}\)/g)?.length, 2);
	assert.match(chat, /\.\.\.\(info\.tokenStats \? \{ tokenStats: info\.tokenStats \} : \{\}\)/);

	const ui = (await read('../../browser/react/src/sidebar-tsx/SidebarChat.tsx')).replace(/\r\n/g, '\n');
	assert.match(ui, /if \(!stats \|\| !\(stats\.generated > 0\)\) return null/);
	assert.match(ui, /\{isRunning === 'LLM' \? <TokenStatsLine stats=\{tokenStatsSoFar\} \/> : null\}/);
	assert.match(ui, /\{isCommitted \? <TokenStatsLine stats=\{chatMessage\.tokenStats\}/);
	for (const text of ['{0} tokens/s', '{0} tokens generated', '{0} total with the prompt']) assert.ok(ui.includes(`t("${text}"`), text);
});
