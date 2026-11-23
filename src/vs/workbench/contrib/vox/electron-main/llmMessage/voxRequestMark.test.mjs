// Segno della domanda attuale (`voxRequestChars`) messo dal convertitore dei messaggi del renderer per i modelli
// locali di Vox, e letto da `takeRequestMark` nel processo principale.
// Eseguire con Node >= 22.18, senza installare le dipendenze del worktree.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const source = await readFile(new URL('../../browser/convertToLLMMessageService.ts', import.meta.url), 'utf8');
// funzioni pure: costanti e funzioni d'appoggio, poi i convertitori fino a `prepareMessages`
const helpersStart = source.indexOf('const CHARS_PER_TOKEN =');
const helpersEnd = source.indexOf('// convert messages as if about to send to openai', helpersStart);
const start = source.indexOf('const prepareMessages_openai_tools =');
const end = source.indexOf('export interface IConvertToLLMMessageService', start);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && start >= 0 && end > start, 'funzioni di conversione disponibili');
const body = stripTypeScriptTypes(source.slice(helpersStart, helpersEnd) + source.slice(start, end));
const prompts = await readFile(new URL('../../common/prompt/prompts.ts', import.meta.url), 'utf8');
const xmlStart = prompts.indexOf('export const reParsedToolXMLString');
const xmlEnd = xmlStart + prompts.slice(xmlStart).search(/\r?\n\}\r?\n/) + 3;
assert.ok(xmlStart >= 0 && xmlEnd > xmlStart, 'reParsedToolXMLString disponibile');
const reParsedToolXMLString = evaluate(stripTypeScriptTypes(prompts.slice(xmlStart, xmlEnd).replace('export ', '')) + '; return reParsedToolXMLString;')();
// misura dei caratteri di un messaggio, dal modulo vero del pannello di contesto
const usageSource = await readFile(new URL('../../common/contextUsage.ts', import.meta.url), 'utf8');
const { promptCharsOf, systemPartsOf } = new Function(stripTypeScriptTypes(usageSource).replace(/^export /gm, '') + '; return { promptCharsOf, systemPartsOf };')();
const prepare = evaluate('deepClone', 'EMPTY_MESSAGE', 'reParsedToolXMLString', 'promptCharsOf', 'systemPartsOf', body + '; return prepareMessages;')(structuredClone, '(empty message)', reParsedToolXMLString, promptCharsOf, systemPartsOf);

const fitSource = await readFile(new URL('./localContextFit.ts', import.meta.url), 'utf8');
const { takeRequestMark } = new Function(stripTypeScriptTypes(fitSource).replace(/^export /gm, '') + '; return { takeRequestMark };')();

const options = (overrides = {}) => ({
	systemMessage: 'sistema', aiInstructions: '', supportsSystemMessage: 'system-role', specialToolFormat: undefined,
	contextWindow: 131072, reservedOutputTokenSpace: 4096, providerName: 'voxLocal', ...overrides,
});
const marked = messages => messages.map((message, index) => [index, message.voxRequestChars]).filter(([, chars]) => chars !== undefined);

test('formato XML: la domanda scritta subito dopo un risultato è segnata in fondo al messaggio fuso', () => {
	const question = 'spiega perché finisce con </read_file_result>';
	const result = prepare({
		...options(), messages: [
			{ role: 'user', content: 'leggi il file' },
			{ role: 'assistant', content: 'lo leggo' },
			{ role: 'tool', content: 'contenuto del file', id: '1', name: 'read_file', rawParams: { uri: '/a.ts' } },
			{ role: 'user', content: question },
		]
	});
	const last = result.messages.at(-1);
	assert.ok(last.content.startsWith('<read_file_result>\n') && last.content.endsWith('\n\n' + question));
	assert.deepEqual(marked(result.messages), [[result.messages.length - 1, question.length]]);
	// il processo principale ritrova esattamente la domanda e toglie il segno
	const { messages, mark } = takeRequestMark(result.messages);
	assert.equal(messages[mark.index].content.slice(-mark.chars), question);
	assert.equal(marked(messages).length, 0);
});

test('modalità agente: il segno resta sulla domanda e non sui risultati che la seguono', () => {
	const result = prepare({
		...options(), messages: [
			{ role: 'user', content: 'domanda attuale' },
			{ role: 'assistant', content: 'lo leggo' },
			{ role: 'tool', content: 'contenuto', id: '1', name: 'read_file', rawParams: { uri: '/a.ts' } },
		]
	});
	assert.equal(result.messages[0].role, 'system');
	assert.deepEqual(marked(result.messages), [[1, 'domanda attuale'.length]]);
	assert.equal(result.messages[1].content, 'domanda attuale');
	assert.ok(result.messages[3].content.startsWith('<read_file_result>'));
});

test('sistema fuso nella prima domanda: il segno passa al nuovo primo messaggio e indica ancora la domanda', () => {
	const result = prepare({ ...options({ supportsSystemMessage: false }), messages: [{ role: 'user', content: 'prima domanda' }] });
	assert.equal(result.messages.length, 1);
	assert.ok(result.messages[0].content.startsWith('<SYSTEM_MESSAGE>\n') && result.messages[0].content.endsWith('prima domanda'));
	assert.deepEqual(marked(result.messages), [[0, 'prima domanda'.length]]);
});

test('strumenti nativi: la domanda è un messaggio intero e porta il segno', () => {
	const result = prepare({
		...options({ specialToolFormat: 'openai-style' }), messages: [
			{ role: 'user', content: 'prima' },
			{ role: 'assistant', content: 'risposta' },
			{ role: 'user', content: 'domanda attuale' },
		]
	});
	assert.deepEqual(marked(result.messages), [[3, 'domanda attuale'.length]]);
});

test('le IA in CLI non ricevono il segno', () => {
	for (const providerName of ['cliAgent']) {
		const result = prepare({ ...options({ providerName }), messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
		assert.deepEqual(marked(result.messages), [], providerName);
	}
});

test('una chat salvata da una versione precedente arriva alle IA locali solo come testo, anche con un vecchio formato degli strumenti', async () => {
	// messaggi come li salvava una versione con i fornitori in cloud: ragionamento Anthropic e risultato di uno strumento
	const messages = [
		{ role: 'user', content: 'leggi il file' },
		{ role: 'assistant', content: '', anthropicReasoning: [{ type: 'thinking', thinking: 'ragionamento interno', signature: 'firma' }] },
		{ role: 'tool', content: 'contenuto del file', id: '1', name: 'read_file', rawParams: { uri: 'a.ts' } },
		{ role: 'user', content: 'ultima' },
	];
	const run = specialToolFormat => prepare({
		messages: structuredClone(messages), systemMessage: 'sistema', aiInstructions: '',
		supportsSystemMessage: 'system-role', specialToolFormat, contextWindow: 32768,
		reservedOutputTokenSpace: 4096, providerName: 'voxLocal',
	}).messages;
	const xml = run(undefined);
	// un valore salvato che Vox non riconosce più segue la stessa strada degli strumenti in XML
	assert.deepEqual(run('anthropic-style'), xml);
	assert.deepEqual(run('gemini-style'), xml);
	for (const message of xml) {
		assert.equal(typeof message.content, 'string', JSON.stringify(message));
		assert.ok(['system', 'user', 'assistant'].includes(message.role), message.role);
		assert.ok(!('anthropicReasoning' in message));
	}
	assert.ok(!JSON.stringify(xml).includes('ragionamento interno'));
	assert.ok(JSON.stringify(xml).includes('contenuto del file'));
	// il messaggio vuoto dell'assistente non arriva vuoto al modello
	assert.ok(xml.filter(m => m.role === 'assistant').every(m => m.content.length > 0));
});
