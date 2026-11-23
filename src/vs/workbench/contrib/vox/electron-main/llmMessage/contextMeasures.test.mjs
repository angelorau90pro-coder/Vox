// Misure del pannello di contesto prese da `prepareMessages` eseguita davvero (non controlli sul sorgente): messaggi
// accorciati, richiesta vuota, messaggio di sistema accorciato con regole e strumenti XML.
// Eseguire con Node >= 22.18, senza installare le dipendenze del worktree.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

// le stesse funzioni di voxRequestMark.test.mjs: costanti e appoggi, poi i convertitori fino a `prepareMessages`
const source = await readFile(new URL('../../browser/convertToLLMMessageService.ts', import.meta.url), 'utf8');
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
const usageSource = await readFile(new URL('../../common/contextUsage.ts', import.meta.url), 'utf8');
const { promptCharsOf, systemPartsOf } = new Function(stripTypeScriptTypes(usageSource).replace(/^export /gm, '') + '; return { promptCharsOf, systemPartsOf };')();
// il taglio usa le funzioni di promptStability.ts (note sui file aperti, taglio a passi): quelle vere
const stabilitySource = stripTypeScriptTypes(await readFile(new URL('../../common/promptStability.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const { stableTrimLength, trailingEditorStateNote, indexOfEditorStateNoteToKeep } = new Function(stabilitySource + '; return { stableTrimLength, trailingEditorStateNote, indexOfEditorStateNoteToKeep };')();
const EMPTY_MESSAGE = '(empty message)';
const prepare = evaluate('deepClone', 'EMPTY_MESSAGE', 'reParsedToolXMLString', 'promptCharsOf', 'systemPartsOf', 'stableTrimLength', 'trailingEditorStateNote', 'indexOfEditorStateNoteToKeep', body + '; return prepareMessages;')(structuredClone, EMPTY_MESSAGE, reParsedToolXMLString, promptCharsOf, systemPartsOf, stableTrimLength, trailingEditorStateNote, indexOfEditorStateNoteToKeep);

// finestra di 4000 token: la riserva è la metà, quindi il prompt ha (4000 - 2000) × 3 = 6000 caratteri
const options = (overrides = {}) => ({
	systemMessage: 'sistema', aiInstructions: '', supportsSystemMessage: 'system-role', specialToolFormat: undefined,
	contextWindow: 4000, reservedOutputTokenSpace: 0, providerName: 'voxLocal', ...overrides,
});
const text = (letter, length) => letter.repeat(length);

test('un solo messaggio accorciato in parte conta 1 (il taglio con cui il ciclo finisce)', () => {
	const messages = [
		{ role: 'user', content: text('a', 100) },
		{ role: 'assistant', content: text('b', 6500) },
		{ role: 'user', content: text('c', 100) },
		{ role: 'assistant', content: text('d', 100) },
		{ role: 'user', content: text('e', 100) },
		{ role: 'assistant', content: text('f', 100) },
		{ role: 'user', content: text('g', 50) },
	];
	const { messages: sent, measures } = prepare({ ...options(), messages, requestChars: 50 });
	// la risposta lunga è stata davvero accorciata, le altre no
	const long = sent.find(m => m.content.startsWith('bbb'));
	assert.ok(long.content.length < 6500 && long.content.endsWith('...'), String(long.content.length));
	assert.equal(measures.trimmedCount, 1);
});

test('i soli parametri di uno strumento accorciati contano come un messaggio accorciato', () => {
	const messages = [
		{ role: 'user', content: 'scrivi il file' },
		{ role: 'assistant', content: 'scrivo' },
		{ role: 'tool', type: 'success', content: 'fatto', id: '1', name: 'rewrite_file', rawParams: { uri: 'a.ts', new_content: text('x', 7000) } },
		{ role: 'assistant', content: 'ecco' },
		{ role: 'user', content: text('c', 100) },
		{ role: 'assistant', content: text('d', 100) },
		{ role: 'user', content: 'e adesso?' },
	];
	const { messages: sent, measures } = prepare({ ...options(), messages, requestChars: 'e adesso?'.length });
	// i parametri lunghi non arrivano più interi al modello
	assert.ok(!sent.some(m => m.content.includes(text('x', 200))));
	assert.equal(measures.trimmedCount, 1);
});

test('i messaggi già corti, che il taglio non può accorciare, non contano', () => {
	// la sola domanda supera lo spazio: con i modelli locali non si accorcia, e il resto è già corto
	const messages = [
		{ role: 'user', content: 'ciao' },
		{ role: 'assistant', content: 'salve' },
		{ role: 'user', content: text('r', 20000) },
	];
	const { messages: sent, measures } = prepare({ ...options(), messages, requestChars: 20000 });
	assert.ok(sent.some(m => m.content.includes(text('r', 20000))), 'la domanda resta intera');
	assert.equal(measures.trimmedCount, 0);
	assert.equal(measures.requestChars, 20000);
});

test('senza bisogno di tagliare nessun messaggio è accorciato', () => {
	const messages = [{ role: 'user', content: 'domanda' }, { role: 'assistant', content: 'risposta' }, { role: 'user', content: 'altra' }];
	assert.equal(prepare({ ...options(), messages, requestChars: 5 }).measures.trimmedCount, 0);
});

test('la richiesta vuota (EMPTY_MESSAGE) non conta nella conversazione', () => {
	const messages = [{ role: 'user', content: 'domanda' }, { role: 'assistant', content: 'risposta' }, { role: 'user', content: '' }];
	const { messages: sent, measures } = prepare({ ...options(), messages, requestChars: 0 });
	assert.equal(sent[sent.length - 1].content, EMPTY_MESSAGE);
	assert.equal(measures.conversationChars, 'domanda'.length + 'risposta'.length);
	assert.equal(measures.requestChars, 0);
	assert.equal(measures.systemChars, 'sistema'.length);
	// con una richiesta scritta la conversazione è la stessa
	const written = prepare({ ...options(), messages: [...messages.slice(0, 2), { role: 'user', content: 'nuova' }], requestChars: 5 }).measures;
	assert.equal(written.conversationChars, 'domanda'.length + 'risposta'.length);
	assert.equal(written.requestChars, 5);
});

test('messaggio di sistema accorciato: regole intere, del blocco degli strumenti solo la parte rimasta', () => {
	// regole in testa, poi il messaggio integrato: 1000 di istruzioni e 19000 di definizioni XML degli strumenti
	const aiInstructions = 'usa i tab';
	const rulesBlock = `GUIDELINES (from the user's .voxrules file):\n${aiInstructions}`;
	const systemMessage = text('A', 1000) + text('X', 19000);
	const messages = [{ role: 'user', content: 'domanda' }];
	const { messages: sent, measures } = prepare({ ...options({ systemMessage, aiInstructions }), messages, xmlToolsChars: 19000, xmlToolsStart: 1000, requestChars: 'domanda'.length });
	const sentSystem = sent[0];
	assert.equal(sentSystem.role, 'system');
	assert.ok(sentSystem.content.length < rulesBlock.length + 2 + 20000 && sentSystem.content.endsWith('...'), 'il messaggio di sistema è stato accorciato');
	assert.ok(sentSystem.content.startsWith(rulesBlock + '\n\n' + text('A', 1000) + 'X'));
	// le istruzioni restano intere (con i due a capo e i «...»), le regole intere, gli strumenti quanto ne resta
	assert.equal(measures.rulesChars, rulesBlock.length);
	assert.equal(measures.systemChars, 1000 + '\n\n'.length + '...'.length);
	assert.equal(measures.toolsChars, sentSystem.content.length - rulesBlock.length - 1005);
	assert.equal(measures.systemChars + measures.rulesChars + measures.toolsChars, sentSystem.content.length);
	// il messaggio di sistema non è un messaggio della conversazione
	assert.equal(measures.trimmedCount, 0);
});

test('messaggio di sistema intero: le voci sono i blocchi interi', () => {
	const aiInstructions = 'usa i tab';
	const rulesBlock = `GUIDELINES (from the user's .voxrules file):\n${aiInstructions}`;
	const systemMessage = text('A', 300) + text('X', 500) + text('B', 200);
	const { measures } = prepare({ ...options({ systemMessage, aiInstructions }), messages: [{ role: 'user', content: 'domanda' }], xmlToolsChars: 500, xmlToolsStart: 300, requestChars: 7 });
	assert.deepEqual([measures.rulesChars, measures.toolsChars, measures.systemChars], [rulesBlock.length, 500, 300 + 200 + '\n\n'.length]);
});

test('modello senza messaggio di sistema: i tag del sistema fuso vanno alle istruzioni, non alla conversazione', () => {
	const messages = [{ role: 'user', content: 'domanda' }, { role: 'assistant', content: 'risposta' }, { role: 'user', content: 'altra' }];
	const { messages: sent, measures } = prepare({ ...options({ supportsSystemMessage: false }), messages, requestChars: 5 });
	assert.equal(sent[0].role, 'user');
	assert.ok(sent[0].content.startsWith('<SYSTEM_MESSAGE>\nsistema\n</SYSTEM_MESSAGE>\ndomanda'), sent[0].content);
	const tags = sent[0].content.length - 'sistema'.length - 'domanda'.length;
	assert.equal(measures.systemChars, 'sistema'.length + tags);
	assert.equal(measures.conversationChars, 'domanda'.length + 'risposta'.length);
	// le voci sommano tutto ciò che si manda
	const total = sent.reduce((sum, m) => sum + promptCharsOf(m), 0);
	assert.equal(measures.systemChars + measures.rulesChars + measures.toolsChars + measures.conversationChars + measures.requestChars, total);
});

test('messaggio di sistema separato: conta come istruzioni anche se non è fra i messaggi', () => {
	const messages = [{ role: 'user', content: 'domanda' }, { role: 'assistant', content: 'risposta' }, { role: 'user', content: 'altra' }];
	const { messages: sent, measures } = prepare({ ...options({ supportsSystemMessage: 'separated' }), messages, requestChars: 5 });
	assert.ok(!sent.some(m => m.content.includes('sistema')), 'il sistema non è fra i messaggi');
	assert.equal(measures.systemChars, 'sistema'.length);
	assert.equal(measures.conversationChars, 'domanda'.length + 'risposta'.length);
	assert.equal(measures.requestChars, 5);
});

// Definizioni native degli strumenti: la finestra (spazio per il prompt e pannello) conta la stessa forma che il
// processo principale manda e conta nel rapporto caratteri/token. Con due forme diverse il pannello sottostimava
// di 66 caratteri per strumento (circa il 9% su un modello locale in modalità agente).
const toolsStart = prompts.indexOf('export const openAICompatibleToolOf');
const toolsEnd = prompts.indexOf('\n', prompts.indexOf('JSON.stringify(tools.map(openAICompatibleToolOf)).length : 0', toolsStart));
assert.ok(toolsStart >= 0 && toolsEnd > toolsStart, 'openAICompatibleToolOf e nativeToolsCharsOf disponibili');
const { openAICompatibleToolOf, nativeToolsCharsOf } = new Function(stripTypeScriptTypes(prompts.slice(toolsStart, toolsEnd)).replace(/^export /gm, '') + '; return { openAICompatibleToolOf, nativeToolsCharsOf };')();

test('strumenti nativi: la forma è quella del formato OpenAI, e i caratteri sono quelli inviati', () => {
	const tools = [
		{ name: 'read_file', description: 'Legge un file.', params: { uri: { description: 'Il percorso.' } } },
		{ name: 'ls_dir', description: 'Elenca.', params: {} },
	];
	assert.deepEqual(openAICompatibleToolOf(tools[0]), { type: 'function', function: { name: 'read_file', description: 'Legge un file.', parameters: { type: 'object', properties: { uri: { description: 'Il percorso.' } } } } });
	const sent = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params } } }));
	assert.equal(nativeToolsCharsOf(tools), JSON.stringify(sent).length);
	// non la forma interna, più corta
	assert.ok(nativeToolsCharsOf(tools) > JSON.stringify(tools).length);
	// senza strumenti all'invio non va nessuna definizione
	assert.equal(nativeToolsCharsOf([]), 0);
	assert.equal(nativeToolsCharsOf(undefined), 0);
});

test('strumenti nativi: invio, spazio per il prompt e pannello usano la stessa funzione', async () => {
	const impl = await readFile(new URL('./sendLLMMessage.impl.ts', import.meta.url), 'utf8');
	assert.match(impl, /const toOpenAICompatibleTool = \(toolInfo: InternalToolInfo\) => openAICompatibleToolOf\(toolInfo\) satisfies OpenAI\.Chat\.Completions\.ChatCompletionTool/);
	assert.match(impl, /openAITools\.push\(toOpenAICompatibleTool\(allowedTools\[t\]\)\)/);
	assert.match(impl, /\+ \('tools' in nativeToolsObj \? JSON\.stringify\(nativeToolsObj\.tools\)\.length : 0\)/);
	const uses = source.match(/const nativeToolsChars = nativeToolsCharsOf\(nativeTools\)/g) ?? [];
	assert.equal(uses.length, 2, 'prepareLLMChatMessages e measureChatContext');
	assert.doesNotMatch(source, /JSON\.stringify\(nativeTools\)/);
});

test('messaggio di sistema vuoto: parte come EMPTY_MESSAGE e conta come istruzioni, non come conversazione', () => {
	const messages = [{ role: 'user', content: 'domanda' }, { role: 'assistant', content: 'risposta' }, { role: 'user', content: 'altra' }];
	for (const supportsSystemMessage of ['system-role', 'developer-role']) {
		const { messages: sent, measures } = prepare({ ...options({ systemMessage: '', supportsSystemMessage }), messages, requestChars: 5 });
		assert.equal(sent[0].content, EMPTY_MESSAGE, supportsSystemMessage);
		assert.equal(measures.systemChars, EMPTY_MESSAGE.length, supportsSystemMessage);
		assert.equal(measures.conversationChars, 'domanda'.length + 'risposta'.length, supportsSystemMessage);
		const total = sent.reduce((sum, m) => sum + promptCharsOf(m), 0);
		assert.equal(measures.systemChars + measures.rulesChars + measures.toolsChars + measures.conversationChars + measures.requestChars, total);
	}
	// separato: il sistema vuoto non parte, e non si conta
	const separated = prepare({ ...options({ systemMessage: '', supportsSystemMessage: 'separated' }), messages, requestChars: 5 }).measures;
	assert.equal(separated.systemChars, 0);
	assert.equal(separated.conversationChars, 'domanda'.length + 'risposta'.length);
});

test('definizioni native: entrano fra gli strumenti e tolgono spazio al prompt, così il taglio scatta prima', () => {
	const messages = [
		{ role: 'user', content: text('a', 100) },
		{ role: 'assistant', content: text('b', 4000) },
		{ role: 'user', content: 'domanda' },
	];
	// senza definizioni ci sta tutto (6000 caratteri di spazio)
	const without = prepare({ ...options(), messages, requestChars: 7 });
	assert.equal(without.measures.trimmedCount, 0);
	assert.equal(without.measures.toolsChars, 0);
	// con 3000 caratteri di definizioni native lo spazio scende a 3000: la risposta lunga si accorcia
	const withTools = prepare({ ...options({ specialToolFormat: 'openai-style' }), messages, requestChars: 7, nativeToolsChars: 3000 });
	assert.equal(withTools.measures.toolsChars, 3000);
	assert.equal(withTools.measures.trimmedCount, 1);
	const long = withTools.messages.find(m => m.content.startsWith('bbb'));
	assert.ok(long.content.length < 4000 && long.content.endsWith('...'), String(long.content.length));
	// le definizioni più grandi di tutto lo spazio non fanno sparire la domanda
	const huge = prepare({ ...options({ specialToolFormat: 'openai-style' }), messages, requestChars: 7, nativeToolsChars: 50_000 });
	assert.ok(huge.messages.some(m => m.content === 'domanda'));
	assert.equal(huge.measures.toolsChars, 50_000);
});
