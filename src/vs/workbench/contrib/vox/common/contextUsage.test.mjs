// Pannello di contesto della chat: occupazione della finestra (funzione pura), caratteri contati come il processo
// principale, misure prese dalla stessa preparazione dell'invio e componente della chat (controlli sul sorgente).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const load = async (file, names) => new Function(stripTypeScriptTypes(await read(file)).replace(/^export /gm, '') + `; return { ${names} };`)();
const { calibrationOf, calibrationOfLast, lastEngineCountOf, levelOf, contextUsageOf, formatTokens, percentOfBudget, promptCharsOf, systemPartsOf, messagesSentNext, DEFAULT_CHARS_PER_TOKEN, WARNING_SHARE } = await load('./contextUsage.ts', 'calibrationOf, calibrationOfLast, lastEngineCountOf, levelOf, contextUsageOf, formatTokens, percentOfBudget, promptCharsOf, systemPartsOf, messagesSentNext, DEFAULT_CHARS_PER_TOKEN, WARNING_SHARE');
const { charsOf } = await load('../electron-main/llmMessage/localContextFit.ts', 'charsOf');

const measures = (over = {}) => ({ contextWindow: 65536, reservedTokens: 32768, systemChars: 0, rulesChars: 0, toolsChars: 0, conversationChars: 0, requestChars: 0, trimmedCount: 0, ...over });
const plain = { charsPerToken: 3, calibrated: false };

test('calibrazione: rapporto fra i caratteri e i token dello stesso prompt, entro i limiti', () => {
	assert.deepEqual(calibrationOf(25_000, 10_000), { charsPerToken: 2.5, calibrated: true });
	assert.deepEqual(calibrationOf(15_000, 10_000), { charsPerToken: 1.5, calibrated: true });
	assert.deepEqual(calibrationOf(60_000, 10_000), { charsPerToken: 6, calibrated: true });
	for (const [chars, tokens] of [[14_000, 10_000], [61_000, 10_000], [25_000, null], [25_000, undefined], [25_000, 0], [0, 10_000], [null, 10_000], [NaN, 10], [25_000, -5]])
		assert.deepEqual(calibrationOf(chars, tokens), { charsPerToken: DEFAULT_CHARS_PER_TOKEN, calibrated: false }, `${chars}/${tokens}`);
});

test("ultimo conteggio del motore: l'ultima risposta con i token del prompt; calibra solo se esatto, con i caratteri e dello stesso modello", () => {
	const stats = (promptTokens, over = {}) => ({ generated: 10, tokensPerSecond: 5, promptTokens, exact: true, promptModel: 'qwen', ...over });
	const messages = [
		{ role: 'user', content: 'a' },
		{ role: 'assistant', displayContent: 'b', tokenStats: stats(1000, { promptChars: 2500 }) },
		{ role: 'tool', content: 'c' },
		{ role: 'assistant', displayContent: 'd', tokenStats: stats(2000, { promptChars: 5600, shortened: true }) },
		{ role: 'assistant', displayContent: 'e', tokenStats: stats(null) },
		{ role: 'user', content: 'f' },
	];
	assert.deepEqual(lastEngineCountOf(messages), { promptTokens: 2000, promptChars: 5600, exact: true, shortened: true, model: 'qwen' });
	assert.deepEqual(calibrationOfLast(lastEngineCountOf(messages), 'qwen'), { charsPerToken: 2.8, calibrated: true });
	// dopo un cambio di modello nella conversazione il conteggio è di un altro tokenizzatore: non calibra
	assert.deepEqual(calibrationOfLast(lastEngineCountOf(messages), 'gemma'), { charsPerToken: DEFAULT_CHARS_PER_TOKEN, calibrated: false });
	assert.equal(calibrationOfLast(lastEngineCountOf(messages), undefined).calibrated, false);
	// risposta salvata prima di questa versione: niente caratteri né modello, quindi niente calibrazione
	const old = [{ role: 'assistant', displayContent: 'x', tokenStats: stats(1000, { promptModel: undefined }) }];
	assert.deepEqual(lastEngineCountOf(old), { promptTokens: 1000, promptChars: null, exact: true, shortened: false, model: null });
	assert.equal(calibrationOfLast(lastEngineCountOf(old), 'qwen').calibrated, false);
	// caratteri senza modello (o con un modello vuoto): non calibra
	for (const promptModel of [undefined, '', 7]) {
		const noModel = [{ role: 'assistant', displayContent: 'x', tokenStats: stats(1000, { promptChars: 2500, promptModel }) }];
		assert.equal(lastEngineCountOf(noModel).model, null, String(promptModel));
		assert.equal(calibrationOfLast(lastEngineCountOf(noModel), 'qwen').calibrated, false, String(promptModel));
	}
	// conteggio stimato (il motore non ha dato `usage`): non calibra
	const estimated = [{ role: 'assistant', displayContent: 'x', tokenStats: stats(1000, { exact: false, promptChars: 2500 }) }];
	assert.equal(calibrationOfLast(lastEngineCountOf(estimated), 'qwen').calibrated, false);
	assert.equal(lastEngineCountOf([{ role: 'user', content: 'x' }]), null);
	// conta solo una risposta dell'assistente, anche se un altro messaggio porta per sbaglio dei conteggi
	assert.equal(lastEngineCountOf([{ role: 'tool', content: 'x', tokenStats: stats(900, { promptChars: 2700 }) }]), null);
	assert.deepEqual(calibrationOfLast(null, 'qwen'), { charsPerToken: DEFAULT_CHARS_PER_TOKEN, calibrated: false });
});

test('messaggi della prossima richiesta: dopo un ritorno a un checkpoint quelli successivi non partono', () => {
	const messages = [{ role: 'checkpoint' }, { role: 'user' }, { role: 'assistant' }, { role: 'checkpoint' }, { role: 'user' }, { role: 'assistant', tokenStats: { promptTokens: 9 } }];
	// senza checkpoint, o sull'ultimo messaggio (o oltre): la stessa lista, con la stessa identità
	for (const idx of [null, undefined, 5, 9]) assert.equal(messagesSentNext(messages, idx), messages, String(idx));
	// come l'invio: `messages.slice(0, checkpointIdx + 1)`
	assert.deepEqual(messagesSentNext(messages, 3), messages.slice(0, 4));
	assert.deepEqual(messagesSentNext(messages, 0), [{ role: 'checkpoint' }]);
	assert.deepEqual(messagesSentNext(messages, 4), messages.slice(0, 5));
	assert.deepEqual(messagesSentNext([], 0), []);
	// il conteggio di una risposta cancellata non tara più
	assert.equal(lastEngineCountOf(messagesSentNext(messages, 3)), null);
});

test('livelli: avviso dal 75% dello spazio per il prompt, pieno a spazio finito, sconosciuto senza finestra', () => {
	assert.equal(WARNING_SHARE, 0.75);
	assert.equal(levelOf(0, 1000), 'ok');
	assert.equal(levelOf(749, 1000), 'ok');
	assert.equal(levelOf(750, 1000), 'avviso');
	assert.equal(levelOf(999, 1000), 'avviso');
	assert.equal(levelOf(1000, 1000), 'pieno');
	assert.equal(levelOf(5000, 1000), 'pieno');
	assert.equal(levelOf(0, 0), 'sconosciuto');
	assert.equal(levelOf(5, -3), 'sconosciuto');
	// una finestra nota che la riserva occupa tutta (4K con 4K riservati) non è sconosciuta: è piena
	assert.equal(levelOf(0, 0, 4096), 'pieno');
	assert.equal(levelOf(300, 0, 4096), 'pieno');
	assert.equal(levelOf(300, 0, 0), 'sconosciuto');
	assert.equal(contextUsageOf(measures({ contextWindow: 4096, reservedTokens: 4096, requestChars: 300 }), plain).level, 'pieno');
	assert.equal(contextUsageOf(measures({ contextWindow: 0, reservedTokens: 0, requestChars: 300 }), plain).level, 'sconosciuto');
});

test('messaggio di sistema: regole in testa, strumenti XML dove stanno, solo la parte rimasta dopo il taglio', () => {
	// intero: 100 di regole, poi «\n\n» e il messaggio integrato, con 400 di strumenti a partire da 250 (in tutto 1000)
	const whole = { sentChars: 1000, fullChars: 1000, rulesBlockChars: 100, xmlToolsAt: 250, xmlToolsChars: 400 };
	assert.deepEqual(systemPartsOf(whole), { systemChars: 500, rulesChars: 100, xmlChars: 400 });
	// accorciato a 303 (300 rimasti più «...»): il taglio cade dentro gli strumenti, di cui restano 50
	assert.deepEqual(systemPartsOf({ ...whole, sentChars: 303 }), { systemChars: 153, rulesChars: 100, xmlChars: 50 });
	// accorciato prima degli strumenti: nessun carattere di strumenti, il resto è sistema (con i «...»)
	assert.deepEqual(systemPartsOf({ ...whole, sentChars: 203 }), { systemChars: 103, rulesChars: 100, xmlChars: 0 });
	// accorciato dentro le regole
	assert.deepEqual(systemPartsOf({ ...whole, sentChars: 63 }), { systemChars: 3, rulesChars: 60, xmlChars: 0 });
	// posizione degli strumenti sconosciuta: subito dopo le regole, come prima
	assert.deepEqual(systemPartsOf({ ...whole, xmlToolsAt: -1 }), { systemChars: 500, rulesChars: 100, xmlChars: 400 });
	// senza regole e senza strumenti tutto è sistema; vuoto è vuoto
	assert.deepEqual(systemPartsOf({ sentChars: 700, fullChars: 700, rulesBlockChars: 0, xmlToolsAt: -1, xmlToolsChars: 0 }), { systemChars: 700, rulesChars: 0, xmlChars: 0 });
	assert.deepEqual(systemPartsOf({ sentChars: 0, fullChars: 0, rulesBlockChars: 0, xmlToolsAt: -1, xmlToolsChars: 0 }), { systemChars: 0, rulesChars: 0, xmlChars: 0 });
	// le voci sommano sempre il messaggio inviato, e nessuna è negativa
	for (const sentChars of [0, 2, 3, 50, 103, 150, 249, 250, 251, 649, 650, 651, 999, 1000]) {
		const parts = systemPartsOf({ ...whole, sentChars });
		assert.equal(parts.systemChars + parts.rulesChars + parts.xmlChars, sentChars, String(sentChars));
		assert.ok(parts.systemChars >= 0 && parts.rulesChars >= 0 && parts.xmlChars >= 0, String(sentChars));
	}
});

test('voci in token: caratteri divisi per il rapporto, solo quelle presenti, somma come totale', () => {
	const usage = contextUsageOf(measures({ systemChars: 3000, toolsChars: 600, conversationChars: 9000, requestChars: 1800 }), plain);
	assert.deepEqual(usage.parts, [
		{ key: 'system', tokens: 1000 },
		{ key: 'tools', tokens: 200 },
		{ key: 'conversation', tokens: 3000 },
		{ key: 'request', tokens: 600 },
	]);
	assert.equal(usage.usedTokens, 4800);
	assert.equal(usage.contextWindow, 65536);
	assert.equal(usage.reservedTokens, 32768);
	assert.equal(usage.promptBudgetTokens, 32768);
	assert.equal(usage.level, 'ok');
	assert.equal(usage.trimmedCount, 0);
	assert.equal(usage.calibrated, false);
	const rules = contextUsageOf(measures({ rulesChars: 300 }), plain);
	assert.deepEqual(rules.parts, [{ key: 'rules', tokens: 100 }]);
});

test('la calibrazione cambia i token, non le misure; un rapporto non valido torna a 3', () => {
	const usage = contextUsageOf(measures({ conversationChars: 50_000 }), { charsPerToken: 2.5, calibrated: true });
	assert.deepEqual(usage.parts, [{ key: 'conversation', tokens: 20_000 }]);
	assert.equal(usage.calibrated, true);
	assert.equal(contextUsageOf(measures({ conversationChars: 3000 }), { charsPerToken: 0, calibrated: false }).usedTokens, 1000);
	assert.equal(contextUsageOf(measures({ conversationChars: 3000 }), { charsPerToken: NaN, calibrated: false }).usedTokens, 1000);
});

test('livello sullo spazio per il prompt (metà finestra), messaggi accorciati riportati a parte', () => {
	const at = share => contextUsageOf(measures({ conversationChars: Math.round(32768 * share) * 3 }), plain);
	assert.equal(at(0.74).level, 'ok');
	assert.equal(at(0.75).level, 'avviso');
	assert.equal(at(1).level, 'pieno');
	// a metà finestra il livello è già pieno: è lo spazio del prompt che conta
	assert.equal(contextUsageOf(measures({ conversationChars: 32768 * 3 }), plain).level, 'pieno');
	const trimmed = contextUsageOf(measures({ conversationChars: 30, trimmedCount: 2 }), plain);
	assert.equal(trimmed.trimmedCount, 2);
	assert.equal(trimmed.level, 'ok');
});

test('valori strani: niente numeri negativi o non finiti', () => {
	const usage = contextUsageOf(measures({ contextWindow: 4096, reservedTokens: 9999, systemChars: -50, conversationChars: NaN, toolsChars: Infinity, requestChars: -3, trimmedCount: -1 }), plain);
	assert.equal(usage.reservedTokens, 4096);
	assert.equal(usage.promptBudgetTokens, 0);
	assert.deepEqual(usage.parts, []);
	assert.equal(usage.usedTokens, 0);
	// la finestra è nota (4K) ma la riserva la occupa tutta: piena, non sconosciuta
	assert.equal(usage.level, 'pieno');
	assert.equal(usage.trimmedCount, 0);
	const empty = contextUsageOf(measures({ contextWindow: 0, reservedTokens: 0 }), plain);
	assert.equal(empty.contextWindow, 0);
	assert.equal(empty.promptBudgetTokens, 0);
	assert.equal(empty.level, 'sconosciuto');
});

test('formato breve come la libreria: K = 1024 token, un decimale sotto 10K', () => {
	assert.equal(formatTokens(0, 'en-US'), '0');
	assert.equal(formatTokens(950, 'en-US'), '950');
	assert.equal(formatTokens(1023, 'en-US'), '1,023');
	assert.equal(formatTokens(1024, 'en-US'), '1K');
	assert.equal(formatTokens(1536, 'en-US'), '1.5K');
	assert.equal(formatTokens(1536, 'it-IT'), '1,5K');
	assert.equal(formatTokens(10_240, 'it-IT'), '10K');
	assert.equal(formatTokens(18_000, 'it-IT'), '18K');
	assert.equal(formatTokens(32_768, 'it-IT'), '32K');
	assert.equal(formatTokens(65_536, 'it-IT'), '64K');
	assert.equal(formatTokens(-5, 'it-IT'), '0');
	assert.equal(formatTokens(NaN, 'it-IT'), '0');
});

test('quota dello spazio per il prompt per la barra, fra 0 e 100', () => {
	assert.equal(percentOfBudget(8192, 32768), 25);
	assert.equal(percentOfBudget(0, 32768), 0);
	assert.equal(percentOfBudget(99_999, 32768), 100);
	// il 100% solo a spazio finito, come il livello `pieno` (visto nell'app: 32616 su 32768 segnava 100% in giallo)
	assert.equal(percentOfBudget(32616, 32768), 99);
	assert.equal(levelOf(32616, 32768), 'avviso');
	assert.equal(percentOfBudget(32768, 32768), 100);
	assert.equal(percentOfBudget(10, 0), 0);
	assert.equal(percentOfBudget(-10, 100), 0);
});

test('caratteri di un messaggio contati come il processo principale (charsOf)', () => {
	const samples = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: 'ciao' },
		{ role: 'user', content: [{ type: 'text', text: 'parte' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'due' }] },
		{ role: 'assistant', content: '', tool_calls: [{ type: 'function', id: '1', function: { name: 'read_file', arguments: '{"uri":"a.ts"}' } }, { type: 'function', id: '2', function: { name: 'ls', arguments: '{}' } }] },
		{ role: 'tool', content: 'risultato', tool_call_id: '1' },
		{ role: 'assistant' },
	];
	for (const message of samples) assert.equal(promptCharsOf(message), charsOf(message), JSON.stringify(message));
});

// --- controlli sul sorgente ---

// (righe normalizzate: alcuni file hanno CRLF nella copia di lavoro)
const readText = async file => (await read(file)).replace(/\r\n/g, '\n');
const service = await readText('../browser/convertToLLMMessageService.ts');
const impl = await readText('../electron-main/llmMessage/sendLLMMessage.impl.ts');
const chat = await readText('../browser/react/src/sidebar-tsx/SidebarChat.tsx');
const i18n = await readText('./voxI18n.ts');
const types = await readText('./sendLLMMessageTypes.ts');
const prompts = await readText('./prompt/prompts.ts');
const bodyOf = (source, start, end) => {
	const from = source.indexOf(start);
	assert.ok(from >= 0, `manca: ${start}`);
	const to = source.indexOf(end, from + start.length);
	assert.ok(to > from, `manca la fine: ${end}`);
	return source.slice(from, to);
};

test('prepareMessages restituisce le misure del prompt finale senza cambiare i messaggi', () => {
	const prepare = bodyOf(service, 'const prepareMessages = (', '\nexport interface IConvertToLLMMessageService');
	assert.match(prepare, /\): \{ messages: LLMChatMessage\[\], separateSystemMessage: string \| undefined, measures: ContextMeasures \} =>/);
	// sul risultato finale (dopo strumenti e sistema fuso), con il conteggio del processo principale
	assert.match(prepare, /const promptChars = llmMessages\.reduce\(\(sum, message\) => sum \+ promptCharsOf\(message\), 0\) \+ \(separateSystemMessageStr\?\.length \?\? 0\)/);
	// contati solo i messaggi davvero accorciati (anche il taglio parziale con cui il ciclo finisce e i soli parametri di
	// uno strumento), non quelli già corti né il messaggio di sistema
	assert.match(prepare, /trimmedCount: \[\.\.\.shortenedIdxes\]\.filter\(idx => idx !== 0\)\.length,/);
	assert.match(prepare, /if \(paramsLengthOf\(m\) < before\) shortenedIdxes\.add\(trimIdx\)/);
	assert.match(prepare, /\+ '\.\.\.' \+ tail\n\t\t\tshortenedIdxes\.add\(trimIdx\)\n\t\t\tbreak/);
	assert.match(prepare, /if \(numCharsWillTrim > 0\) \{\n\t\t\tm\.content = body\.substring\(0, TRIM_TO_LEN - '\.\.\.'\.length\) \+ '\.\.\.' \+ tail\n\t\t\tshortenedIdxes\.add\(trimIdx\)\n\t\t\}/);
	assert.equal((prepare.match(/shortenedIdxes\.add\(/g) ?? []).length, 3);
	// il messaggio di sistema diviso dalla funzione provata qui sopra, con la posizione degli strumenti nel messaggio intero
	assert.match(prepare, /const \{ systemChars, rulesChars, xmlChars \} = systemPartsOf\(\{\n\t\tsentChars: newSysMsg\.length,\n\t\tfullChars: combinedSystemMessage\.trim\(\)\.length,/);
	assert.ok(prepare.includes("if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voxrules file):\\n${aiInstructions}`)\n\tif (systemMessage) sysMsgParts.push(systemMessage)\n\tconst combinedSystemMessage = sysMsgParts.join('\\n\\n')"), 'regole in testa, poi il messaggio, uniti da due a capo');
	assert.ok(prepare.includes("const rulesBlockChars = aiInstructions ? `GUIDELINES (from the user's .voxrules file):\\n${aiInstructions}`.length : 0"), 'stesso blocco delle regole');
	assert.match(prepare, /xmlToolsAt: xmlToolsStart >= 0 \? \(rulesBlockChars > 0 && systemMessage \? rulesBlockChars \+ '\\n\\n'\.length : 0\) \+ xmlToolsStart : -1,/);
	// la richiesta vuota diventa EMPTY_MESSAGE, che all'invio non ci sarà: non conta nella conversazione
	assert.match(prepare, /const emptyRequestChars = requestChars === 0 && llmMessages\[llmMessages\.length - 1\]\?\.content === EMPTY_MESSAGE \? EMPTY_MESSAGE\.length : 0/);
	assert.match(prepare, /reservedTokens: reservedOutputTokenSpace,/);
	assert.match(prepare, /conversationChars: Math\.max\(0, promptChars - newSysMsg\.length - fusedSystemTagsChars - emptySystemChars - requestChars - emptyRequestChars\),/);
	// i tag del messaggio di sistema fuso vanno alle istruzioni di Vox, e sono quelli dell'invio
	assert.match(prepare, /systemChars: systemChars \+ fusedSystemTagsChars \+ emptySystemChars,/);
	// il messaggio di sistema vuoto che parte come EMPTY_MESSAGE è del sistema
	assert.match(prepare, /const emptySystemChars = \(supportsSystemMessage === 'system-role' \|\| supportsSystemMessage === 'developer-role'\) && !newSysMsg \? EMPTY_MESSAGE\.length : 0/);
	assert.match(prepare, /const fusedSystemTagsChars = supportsSystemMessage \? 0 : FUSED_SYSTEM_OPEN\.length \+ FUSED_SYSTEM_CLOSE\.length/);
	assert.match(prepare, /content: `\$\{FUSED_SYSTEM_OPEN\}\$\{newSysMsg\}\$\{FUSED_SYSTEM_CLOSE\}\$\{llmMessages\[0\]\.content\}`,/);
	assert.match(prepare, /toolsChars: xmlChars \+ nativeToolsChars,/);
	// le misure si calcolano dopo l'ultimo ritocco dei messaggi
	assert.ok(prepare.indexOf('// ================ measures') > prepare.indexOf('// ================ no empty message'));
	assert.match(prepare, /return \{\n\t\tmessages: llmMessages,\n\t\tseparateSystemMessage: separateSystemMessageStr,\n\t\tmeasures,\n\t\} as const/);
});

test('measureChatContext: stessa preparazione dell\'invio, senza toccare il messaggio di sistema della conversazione', () => {
	const service_ = service.replace(/\r\n/g, '\n');
	const measure = bodyOf(service_, "measureChatContext: IConvertToLLMMessageService['measureChatContext'] = async", '\n\t}\n');
	const send = bodyOf(service_, "prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async", '\n\t}\n');
	assert.match(measure, /if \(providerName === 'cliAgent'\) return \{ kind: 'cli' \}/);
	assert.match(measure, /if \(modelSelection === null\) return null/);
	assert.doesNotMatch(measure, /_generateChatMessagesSystemMessage|_latestSystemMessageRequest|_systemMessageMemo/);
	assert.match(measure, /disableSystemMessage \? '' : await this\._systemMessageForDisplay\(chatMode, specialToolFormat, providerName, threadId\)/);
	// gli stessi ingredienti dell'invio
	for (const line of [
		"const projectContextBlock = await this.projectContextService.getProjectContextBlock()",
		"const systemMessage = [fullSystemMessage, projectContextBlock].filter(s => !!s).join('\\n\\n')",
		'const aiInstructions = this._getCombinedAIInstructions()',
		'const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })',
		"const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)",
	]) {
		assert.ok(measure.includes(line), `misura: ${line}`);
		assert.ok(send.includes(line.replace('const aiInstructions = ', 'const aiInstructions = ')), `invio: ${line}`);
	}
	assert.match(send, /this\._chatMessagesToSimpleMessages\(chatMessages, providerName === 'voxLocal' && !disableSystemMessage\)/);
	assert.match(measure, /const withEditorStateNotes = providerName === 'voxLocal' && !disableSystemMessage\n\t\tconst llmMessages = this\._chatMessagesToSimpleMessages\(chatMessages, withEditorStateNotes\)/);
	for (const arg of ['systemMessage', 'aiInstructions', 'supportsSystemMessage', 'specialToolFormat', 'contextWindow', 'reservedOutputTokenSpace', 'providerName', 'nativeToolsChars'])
		assert.match(measure, new RegExp(`\\n\\t\\t\\t${arg},\\n`), `argomento: ${arg}`);
	// la richiesta in fondo come la scrive l'invio: testo, allegati, nota sui file aperti
	assert.match(measure, /const content = draft \+ \(selections\.length > 0 \? await this\._selectionsSuffixForDisplay\(selections\) : ''\)/);
	assert.match(measure, /const note = this\.editorStateNoteForNewUserMessage\(threadId, earlierNotes, modelSelection\)/);
	// la richiesta va in fondo sempre, anche vuota: altrimenti l'ultimo messaggio dell'utente della cronologia sarebbe
	// protetto come domanda attuale e una conversazione lunga sembrerebbe piena (visto nell'app il 20/11/2026)
	assert.match(measure, /\n\t\tllmMessages\.push\(\{ role: 'user', content: request \}\)\n/);
	assert.doesNotMatch(measure, /if \(request\) llmMessages\.push|if \(draft\.trim\(\)/);
	assert.match(measure, /requestChars: request\.length,/);
	// strumenti XML misurati solo dove stanno nel messaggio di sistema: le righe del servizio, eseguite davvero
	const xmlLines = measure.slice(measure.indexOf('\t\tconst xmlToolsAlone = '), measure.indexOf('\n', measure.indexOf('\t\tconst xmlToolsStart = ')));
	assert.match(xmlLines, /const xmlToolsStart = xmlTools \? fullSystemMessage\.indexOf\(xmlTools\) : -1$/);
	const xmlOf = new Function('specialToolFormat', 'disableSystemMessage', 'systemToolsXMLPrompt', 'chatMode', 'mcpTools', 'fullSystemMessage', `${xmlLines}\nreturn { xmlToolsChars, xmlToolsStart };`);
	const tools = '<tools>\n\t<read_file>legge\tun file</read_file>\n</tools>';
	const xml = (fullSystemMessage, over = {}) => xmlOf(over.specialToolFormat, over.disableSystemMessage ?? false, () => tools, 'agent', [], fullSystemMessage);
	// il primo tab del messaggio sta prima degli strumenti: le definizioni ci sono intatte
	assert.deepEqual(xml(`a  b\n${tools}\nfine`), { xmlToolsChars: tools.length, xmlToolsStart: 5 });
	// il primo tab del messaggio è negli strumenti (chat_systemMessage lo cambia in due spazi): si trovano lo stesso
	const changed = tools.replace('\t', '  ');
	assert.deepEqual(xml(`intro\n${changed}\nfine`), { xmlToolsChars: changed.length, xmlToolsStart: 6 });
	assert.match(prompts, /\.join\('\\n\\n\\n'\)\n\t\t\.trim\(\)\n\t\t\.replace\('\\t', '  '\)/);
	// strumenti nativi o messaggio integrato spento: niente XML; strumenti assenti dal messaggio: posizione sconosciuta
	assert.deepEqual(xml(`a\n${tools}`, { specialToolFormat: 'openai-style' }), { xmlToolsChars: 0, xmlToolsStart: -1 });
	assert.deepEqual(xml(`a\n${tools}`, { disableSystemMessage: true }), { xmlToolsChars: 0, xmlToolsStart: -1 });
	assert.equal(xml('niente strumenti').xmlToolsStart, -1);
	assert.match(measure, /\n\t\t\txmlToolsStart,\n/);
	assert.match(measure, /const nativeTools = specialToolFormat \? availableTools\(chatMode, mcpTools\) : undefined/);
});

test('cache del pannello: allegati letti una volta, messaggio di sistema calcolato a parte, svuotate quando cambiano le premesse', () => {
	const service_ = service.replace(/\r\n/g, '\n');
	// un errore di lettura non resta in memoria
	assert.match(service_, /try \{ suffix = await chat_userMessageContent\('', selections, \{ directoryStrService: this\.directoryStrService, fileService: this\.fileService \}\) \}\n\t\tcatch \{\n(\t\t\t[^\n]*\n)+\t\t\treturn ''\n\t\t\}\n\t\tfinally \{ this\._readingSelections\.delete\(reading\) \}\n(\t\t\/\/[^\n]*\n)+\t\tif \(version !== this\._contextPremisesVersion\) return suffix\n\t\tthis\._unreadSelections\.delete\(key\)\n\t\tthis\._selectionsSuffixes\.set/);
	assert.match(service_, /const cached = this\._selectionsSuffixes\.get\(key\)\n\t\tif \(cached !== undefined\) return cached\.suffix/);
	assert.match(service_, /this\._selectionsSuffixes\.set\(key, \{ suffix, uris: selections\.map\(s => s\.uri\) \}\)/);
	const display = bodyOf(service_, 'private async _systemMessageForDisplay(', '\n\t}\n');
	// il memo dell'invio si legge soltanto (peek: nemmeno l'ordine delle conversazioni cambia), con la stessa chiave
	assert.doesNotMatch(display, /_systemMessageMemo\.(get|set|noteForNewUserMessage)|_latestSystemMessageRequest|_systemMessageRequestCount/);
	assert.match(display, /const remembered = \(directoryStrForKey: string \| undefined\) => providerName !== 'voxLocal' \? undefined\r?\n\t\t\t: this\._systemMessageMemo\.peek\(threadId, this\._systemMessageMemoKey\(chatMode, providerName, specialToolFormat, workspaceFolders, mcpTools, persistentTerminalIDs, directoryStrForKey\)\)/);
	// fuori dalla chat normale il messaggio fissato si cerca prima di leggere l'albero (che lì non è una premessa);
	// in chat normale dopo, con l'albero
	assert.match(display, /if \(chatMode !== 'normal'\) \{\r?\n\t\t\tconst fixed = remembered\(undefined\)\r?\n\t\t\tif \(fixed !== undefined\) return fixed\r?\n\t\t\}/);
	assert.match(display, /if \(chatMode === 'normal'\) \{\r?\n\t\t\tconst fixed = remembered\(directoryStr\)\r?\n\t\t\tif \(fixed !== undefined\) return fixed\r?\n\t\t\}/);
	assert.ok(display.indexOf('remembered(undefined)') < display.indexOf('getAllDirectoriesStr'));
	assert.ok(display.indexOf('remembered(directoryStr)') > display.indexOf('getAllDirectoriesStr'));
	// le schede di Vox non diventano il file attivo comunicato al modello
	assert.match(service_, /const activeFile = active\?\.scheme !== VOX_EDITOR_SCHEME \? active\?\.fsPath\r?\n\t\t\t: this\.editorService\.getEditors\(EditorsOrder\.MOST_RECENTLY_ACTIVE\)\.map\(\(\{ editor \}\) => editor\.resource\)\.find\(resource => resource && resource\.scheme !== VOX_EDITOR_SCHEME\)\?\.fsPath/);
	assert.match(service_, /const VOX_EDITOR_SCHEME = 'vox'/);
	const generate = bodyOf(service_, 'private _generateChatMessagesSystemMessage = async', '\n\t}\n');
	assert.match(generate, /const memoKey = threadId === undefined \? '' : this\._systemMessageMemoKey\(chatMode, providerName, specialToolFormat, workspaceFolders, mcpTools, persistentTerminalIDs, directoryStrForKey\)/);
	assert.match(generate, /const directoryStrForKey = chatMode === 'normal' \? await directoryStr\(\) : undefined/);
	assert.equal((service_.match(/new Date\(\)\.toDateString\(\)/g) ?? []).length, 1, 'la chiave delle premesse si scrive in un posto solo');
	// in cache solo l'albero delle cartelle; il messaggio si ricompone con i file aperti di adesso
	assert.match(display, /const key = JSON\.stringify\(\[chatMode, workspaceFolders\]\)/);
	// l'albero si rilegge al più ogni minuto in tutte le modalità
	assert.match(display, /if \(cached && Date\.now\(\) - cached\.at < 60_000\) directoryStr = cached\.directoryStr/);
	// una lettura finita dopo un cambio delle premesse non torna in memoria (la misura che il cambio fa partire rilegge)
	assert.match(display, /const version = this\._contextPremisesVersion\n\t\t\tdirectoryStr = await this\.directoryStrService\.getAllDirectoriesStr\(\{ cutOffMessage: directoryCutOffMessage\(chatMode\) \}\)\n(\t\t\t\/\/[^\n]*\n)+\t\t\tif \(version === this\._contextPremisesVersion\) \{\n\t\t\t\tthis\._displayDirectoryStrs\.delete\(key\)\n\t\t\t\tthis\._displayDirectoryStrs\.set\(key, \{ directoryStr, at: Date\.now\(\) \}\)/);
	// (la versione si legge prima dell'`await`, e la lettura in corso si tiene d'occhio: un salvataggio durante la prima
	// lettura di un allegato fa crescere la versione anche se l'allegato non è ancora in memoria)
	assert.match(service_, /\t\tconst version = this\._contextPremisesVersion\n(\t\t\/\/[^\n]*\n)+\t\tconst reading = \{\}\n\t\tthis\._readingSelections\.set\(reading, selections\.map\(s => s\.uri\)\)\n\t\ttry \{ suffix = await chat_userMessageContent\(/);
	assert.match(service_, /private readonly _readingSelections = new Map<object, URI\[\]>\(\)/);
	assert.match(service_, /\n(\t\t\/\/[^\n]*\n)+\t\tif \(version !== this\._contextPremisesVersion\) return suffix\n\t\tthis\._unreadSelections\.delete\(key\)\n\t\tthis\._selectionsSuffixes\.set\(key/);
	assert.match(display, /return this\._computeChatMessagesSystemMessage\(chatMode, specialToolFormat, providerName, workspaceFolders, mcpTools, this\._editorSnapshot\(\), persistentTerminalIDs, directoryStr\)/);
	// la versione cresce prima dell'avviso: chi lo riceve legge già quella nuova
	assert.match(service_, /const premisesChanged = \(\) => \{ this\._displayDirectoryStrs\.clear\(\); this\._selectionsSuffixes\.clear\(\); this\._unreadSelections\.clear\(\); this\._contextPremisesVersion\+\+; this\._onDidChangeContextPremises\.fire\(\) \}/);
	assert.match(service_, /private _contextPremisesVersion = 0\n\tcontextPremisesVersion\(\): number \{\n\t\treturn this\._contextPremisesVersion\n\t\}/);
	// salvare le regole o un file allegato rimisura, anche un allegato che prima non si era potuto leggere
	assert.match(service_, /this\._register\(this\.fileService\.onDidFilesChange\(e => \{\n\t\t\tconst rulesChanged = this\.workspaceContextService\.getWorkspace\(\)\.folders\n\t\t\t\t\.some\(folder => RULES_FILE_NAMES\.some\(name => e\.contains\(URI\.joinPath\(folder\.uri, name\)\)\)\)\n\t\t\tconst attachedChanged = \[\.\.\.this\._selectionsSuffixes\.values\(\)\]\.some\(\(\{ uris \}\) => uris\.some\(uri => e\.affects\(uri\)\)\)\n\t\t\t\t\|\| \[\.\.\.this\._unreadSelections\.values\(\)\]\.some\(uris => uris\.some\(uri => e\.affects\(uri\)\)\)\n\t\t\t\t\|\| \[\.\.\.this\._readingSelections\.values\(\)\]\.some\(uris => uris\.some\(uri => e\.affects\(uri\)\)\)\n\t\t\tif \(rulesChanged \|\| attachedChanged\) premisesChanged\(\)/);
	// una lettura fallita: nessun testo in memoria, allegati tenuti d'occhio (al più cinque gruppi); una riuscita li toglie
	assert.match(service_, /\t\tcatch \{\n\t\t\tthis\._unreadSelections\.delete\(key\)\n\t\t\tthis\._unreadSelections\.set\(key, selections\.map\(s => s\.uri\)\)\n\t\t\twhile \(this\._unreadSelections\.size > 5\) this\._unreadSelections\.delete\(this\._unreadSelections\.keys\(\)\.next\(\)\.value!\)\n\t\t\treturn ''\n\t\t\}\n\t\tfinally \{ this\._readingSelections\.delete\(reading\) \}\n(\t\t\/\/[^\n]*\n)+\t\tif \(version !== this\._contextPremisesVersion\) return suffix\n\t\tthis\._unreadSelections\.delete\(key\)\n\t\tthis\._selectionsSuffixes\.set\(key, \{ suffix, uris: selections\.map\(s => s\.uri\) \}\)/);
	for (const event of ['this.projectContextService.onDidChange(premisesChanged)', 'this.mcpService.onDidChangeState(premisesChanged)', 'this.workspaceContextService.onDidChangeWorkspaceFolders(premisesChanged)'])
		assert.ok(service_.includes(`this._register(${event})`), event);
	// le due versioni dell'albero delle cartelle tagliato restano uguali per invio e misure
	assert.equal((service_.match(/directoryCutOffMessage\(chatMode\)/g) ?? []).length, 2);
});

test('il processo principale riporta i caratteri del prompt inviato e l\'accorciamento dopo un rifiuto', () => {
	assert.match(types, /promptChars\?: number;/);
	assert.match(types, /promptModel\?: string;/);
	assert.match(types, /shortened\?: boolean;/);
	assert.match(impl, /import \{ charsOf, contextOverflowOf, shrinkToFit, takeRequestMark \} from '\.\/localContextFit\.js';/);
	assert.match(impl, /const promptChars = \(messages as Parameters<typeof charsOf>\[0\]\[\]\)\.reduce\(\(sum, message\) => sum \+ charsOf\(message\), 0\)\n\t\t\+ \('tools' in nativeToolsObj \? JSON\.stringify\(nativeToolsObj\.tools\)\.length : 0\)/);
	// il modello è quello scelto nella chat (`modelName_`), non il nome che le capacità del modello mandano al motore
	assert.match(impl, /tokenStats: \{ \.\.\.stats, promptChars, promptModel: modelName_ \}/);
	assert.match(impl, /modelName: modelName_, _setAborter, providerName, chatMode/);
	assert.match(impl, /onFinalMessage: p => \{ release\(\); onFinalMessage\(retries > 0 && p\.tokenStats \? \{ \.\.\.p, tokenStats: \{ \.\.\.p\.tokenStats, shortened: true \} \} : p\) \},/);
	// i messaggi sono quelli di questo invio (dopo l'eventuale accorciamento): `send` passa `messages` aggiornati
	assert.match(impl, /await _sendOpenAICompatibleChat\(\{\n\t\t\t\.\.\.params,\n\t\t\tmessages,/);
});

// --- riga nella chat e scheda centrale (ChatContext.tsx) ---

const ui = await readText('../browser/react/src/sidebar-tsx/ChatContext.tsx');
const pane = await readText('../browser/chatContextPane.ts');
const contribution = await readText('../browser/vox.contribution.ts');
const actionIDs = await readText('../browser/actionIDs.ts');
const sidebarIndex = await readText('../browser/react/src/sidebar-tsx/index.tsx');
const line = bodyOf(ui, 'export const ContextUsageLine = (', '\n// ---------------- pagina');
const page = bodyOf(ui, 'const ChatContextPageBody = () => {', '\nexport const ChatContextPage = ');
const measureHook = bodyOf(ui, 'const useChatContextMeasure = (', '\n// ---------------- pezzi comuni');

// pezzi senza JSX del modulo, eseguiti davvero: lo store della bozza e la cache delle misure
const plainModule = stripTypeScriptTypes([bodyOf(ui, 'type ChatDraft = ', '\nconst useChatDraft = '), bodyOf(ui, 'const measureCache = ', '\nconst useChatContextMeasure = ')].join('\n').replace(/^export /gm, ''));
const loadPlain = () => new Function(plainModule + '\n; return { setChatDraft, subscribeChatDraft, getDraft: () => chatDraft, measureOnce, measureCache, MEASURE_CACHE_SIZE, fingerprintOf };')();

test('bozza condivisa: legata alla sua conversazione, avvisa solo quando cambia', () => {
	const { setChatDraft, subscribeChatDraft, getDraft } = loadPlain();
	let calls = 0;
	const unsubscribe = subscribeChatDraft(() => calls++);
	setChatDraft('a', 'ciao');
	assert.deepEqual(getDraft(), { threadId: 'a', text: 'ciao' });
	setChatDraft('a', 'ciao');
	assert.equal(calls, 1, 'stessa bozza: nessun avviso');
	setChatDraft('b', 'ciao');
	assert.equal(calls, 2, 'stesso testo di un\'altra conversazione: avviso');
	unsubscribe();
	setChatDraft('b', 'altro');
	assert.equal(calls, 2);
	// la bozza di un'altra conversazione non conta
	assert.match(ui, /const useChatDraft = \(threadId: string\) => \{\n\tconst draft = useSyncExternalStore\(subscribeChatDraft, \(\) => chatDraft\)\n\treturn draft\.threadId === threadId \? draft\.text : ''\n\}/);
});

test('misure condivise: una promessa per firma, errori non trattenuti, cache limitata', async () => {
	const { measureOnce, measureCache, MEASURE_CACHE_SIZE } = loadPlain();
	let runs = 0;
	const result = { kind: 'cli' };
	const first = measureOnce('k1', async () => { runs++; return result; });
	const second = measureOnce('k1', async () => { runs++; return result; });
	assert.equal(first, second, 'la riga e la pagina ricevono la stessa promessa');
	assert.equal(await first, result);
	assert.equal(runs, 1, 'un calcolo solo');
	// un errore dà null e non resta in memoria: la volta dopo si rimisura
	assert.deepEqual(await measureOnce('k2', async () => { throw new Error('no'); }), { kind: 'error' });
	assert.equal(measureCache.has('k2'), false);
	assert.equal(await measureOnce('k2', async () => result), result);
	for (let i = 0; i < 10; i++) measureOnce(`x${i}`, async () => result);
	assert.equal(measureCache.size, MEASURE_CACHE_SIZE);
	assert.equal(MEASURE_CACHE_SIZE, 4);
});

test('misura: stessi ingressi per la riga e la pagina, ritardo, premesse e file attivo', () => {
	assert.match(measureHook, /const key = JSON\.stringify\(\[threadId, messagesKey, selectionsKey, draft, settingsKey, editorKey, premisesVersion\]\)/);
	// file aperti e file attivo: letti dal servizio (che ignora le schede di Vox), riletti quando cambiano
	assert.match(measureHook, /const \[editorKey, setEditorKey\] = useState\(\(\) => convertService\.editorSnapshotKey\(\)\)\n\tuseEffect\(\(\) => \{\n\t\tsetEditorKey\(convertService\.editorSnapshotKey\(\)\)\n\t\tconst disposable = convertService\.onDidChangeEditorSnapshot\(\(\) => setEditorKey\(convertService\.editorSnapshotKey\(\)\)\)\n\t\treturn \(\) => disposable\.dispose\(\)\n\t\}, \[convertService\]\)/);
	// il file attivo non viene più dalla barra dei comandi (che non vede i cambi di gruppo né le schede di Vox)
	assert.doesNotMatch(ui, /useActiveURI|activeURI/);
	assert.match(measureHook, /const messagesKey = useMemo\(\(\) => messages\.map\(fingerprintOf\)\.join\('\|'\), \[messages\]\)/);
	assert.match(measureHook, /measureOnce\(key, \(\) => convertService\.measureChatContext\(\{ chatMessages: messages, chatMode, modelSelection, threadId, draft, selections \}\)\)/);
	assert.match(measureHook, /\}, measureCache\.has\(key\) \? 0 : 400\)\n\t\treturn \(\) => clearTimeout\(timer\)\n\t\}, \[convertService, threadId, key, enabled\]\)/);
	// spenta, nessuna misura (e una misura in corso non arriva più)
	assert.match(measureHook, /const version = \+\+versionRef\.current\n\t\tif \(!enabled\) return\n/);
	assert.match(measureHook, /if \(versionRef\.current === version\) setMeasured\(\{ threadId, settingsKey, result \}\)/);
	// cambiando modello la misura del modello di prima non si mostra mentre arriva la nuova
	assert.match(measureHook, /const result = measured\?\.threadId === threadId && measured\.settingsKey === settingsKey \? measured\.result : null/);
	// le premesse: la versione del servizio, letta al montaggio (un cambio a viste chiuse non lascia una misura vecchia)
	// e a ogni avviso; la firma la contiene, quindi la cache non va svuotata a mano
	assert.match(measureHook, /const \[premisesVersion, setPremisesVersion\] = useState\(\(\) => convertService\.contextPremisesVersion\(\)\)\n\tuseEffect\(\(\) => \{\n\t\tsetPremisesVersion\(convertService\.contextPremisesVersion\(\)\)\n\t\tconst disposable = convertService\.onDidChangeContextPremises\(\(\) => setPremisesVersion\(convertService\.contextPremisesVersion\(\)\)\)\n\t\treturn \(\) => disposable\.dispose\(\)\n\t\}, \[convertService\]\)/);
	assert.doesNotMatch(ui, /measureCache\.clear\(\)/);
	assert.match(measureHook, /globalSettings\.aiInstructions, globalSettings\.disableSystemMessage/);
	// la finestra dei modelli locali (dal manifesto) fa parte della firma; i conteggi del motore no
	assert.match(measureHook, /getModelCapabilities\(modelSelection\.providerName, modelSelection\.modelName, overridesOfModel\)\.contextWindow/);
	assert.doesNotMatch(measureHook, /tokenStats/);
	assert.doesNotMatch(ui.slice(ui.indexOf('const fingerprintOf'), ui.indexOf('const useChatContextMeasure')), /tokenStats/);
	assert.match(measureHook, /return \{ kind: 'local', usage: contextUsageOf\(result\.measures, calibrationOfLast\(lastCount, modelSelection\?\.modelName\)\), lastCount \}/);
	// hook prima delle uscite anticipate
	assert.ok(measureHook.indexOf('if (!result) return null') > measureHook.lastIndexOf('useEffect('));
	// la bozza la scrive la chat, con ritardo, legata alla conversazione; a ogni cambio di conversazione riparte vuota
	assert.match(chat, /import \{ ContextUsageLine, setChatDraft \} from '\.\/ChatContext\.js';/);
	assert.match(chat, /const threadId = draftThreadIdRef\.current\n\t\tdraftTimerRef\.current = setTimeout\(\(\) => setChatDraft\(threadId, newStr\), 300\)/);
	assert.match(chat, /useEffect\(\(\) => \{\n\t\tclearTimeout\(draftTimerRef\.current\)\n\t\tsetChatDraft\(currentThread\.id, initVal\)\n\t\}, \[currentThread\.id\]\)/);
	assert.match(chat, /useEffect\(\(\) => \(\) => clearTimeout\(draftTimerRef\.current\), \[\]\)/);
	assert.doesNotMatch(chat, /ContextUsagePanel|draftForContext/);
	// all'invio la bozza si azzera subito: il testo passa nella conversazione e non va contato due volte
	const submit = bodyOf(chat, 'const onSubmit = useCallback(async (_forceSubmit?: string) => {', '\n\t}, [');
	assert.match(submit, /clearTimeout\(draftTimerRef\.current\)\n\t\tsetChatDraft\(threadId, ''\)\n\n\t\ttry \{\n\t\t\tawait chatThreadsService\.addUserMessageAndStreamResponse/);
});

test('chat: una riga compatta sopra la casella, che apre i dettagli al centro', () => {
	assert.match(chat, /<TaskListPanel messages=\{previousMessages\} currCheckpointIdx=\{currCheckpointIdx\} \/>\n\t\t<ContextUsageLine threadId=\{chatThreadsState\.currentThreadId\} messages=\{previousMessages\} selections=\{selections\} \/>/);
	assert.equal((chat.match(/<ContextUsageLine\b/g) ?? []).length, 1);
	assert.match(line, /export const ContextUsageLine = \(\{ threadId, messages: allMessages, selections \}[^\n]*\n(\t[^\n]*\n){4}\tconst checkpointIdx = useChatThreadsState\(\)\.allThreads\[threadId\]\?\.state\.currCheckpointIdx\n\tconst messages = useMemo\(\(\) => messagesSentNext\(allMessages, checkpointIdx\), \[allMessages, checkpointIdx\]\)\n\tconst hasConversation = hasConversationIn\(messages\)\n/);
	assert.match(page, /\tconst allMessages = thread\?\.messages \?\? NO_MESSAGES\n\tconst checkpointIdx = thread\?\.state\.currCheckpointIdx\n\tconst messages = useMemo\(\(\) => messagesSentNext\(allMessages, checkpointIdx\), \[allMessages, checkpointIdx\]\)\n/);
	assert.doesNotMatch(page + line, /hasConversationIn\(allMessages\)|useChatContextMeasure\(\{ threadId, messages: allMessages/);
	assert.match(line, /const hasConversation = hasConversationIn\(messages\)\n\tconst measure = useChatContextMeasure\(\{ threadId, messages, selections, draft, enabled: hasConversation \}\)\n\t\/\/[^\n]*\n\tif \(!hasConversation \|\| !measure \|\| measure\.kind === 'error'\) return null/);
	// una misura non riuscita: la pagina lo dice (non resta su «Misura in corso…»); il gancio la passa così com'è
	assert.match(page, /else if \(measure\.kind === 'error'\) body = <div role='status' data-vox-context-page='error'>\{card\(t\("Vox could not measure the context: /);
	assert.match(measureHook, /if \(result\.kind === 'cli' \|\| result\.kind === 'error'\) return \{ kind: result\.kind \}/);
	assert.match(line, /if \(measure\.kind === 'cli'\) return <div[^>]*>\n\t\t\{t\("Context: managed by the CLI AI"\)\}/);
	assert.match(line, /onClick=\{\(\) => \{ commandService\.executeCommand\(VOX_OPEN_CHAT_CONTEXT_ACTION_ID\) \}\}/);
	assert.match(line, /aria-label=\{t\("Context: \{0\}\. Open the details in the editor area", summary\)\}/);
	// nella chat niente dettagli che si aprono sopra la conversazione
	assert.doesNotMatch(line, /aria-expanded|isOpen|CONTEXT_PART_LABEL/);
	assert.match(line, /\{hasBudget\(usage\) \? <ContextMeter usage=\{usage\} className='mt-1\.5 h-1' \/> : null\}/);
	assert.match(line, /<div role='status' className='mt-1\.5 truncate text-vox-warning' title=\{notices\.join\('\\n'\)\}>\{notices\[0\]\}<\/div>/);
});

test('barra accessibile e colorata, avvisi annunciati, pagina centrale con tutte le voci', () => {
	const meter = bodyOf(ui, 'const ContextMeter = (', '\n// ---------------- riga');
	assert.match(meter, /role='meter'/);
	assert.match(meter, /aria-valuemax=\{usage\.promptBudgetTokens\}/);
	assert.match(meter, /aria-valuenow=\{Math\.min\(usage\.usedTokens, usage\.promptBudgetTokens\)\}/);
	assert.match(meter, /aria-valuetext=\{t\("About \{0\} tokens of \{1\} available for the request \(\{2\}%\)", formatTokens\(usage\.usedTokens\), formatTokens\(usage\.promptBudgetTokens\), percent\)\}/);
	assert.match(meter, /const percent = percentOfBudget\(usage\.usedTokens, usage\.promptBudgetTokens\)/);
	// il colore della barra sta dentro className: la build mette il prefisso `vox-` solo alle classi scritte lì (una
	// mappa di classi fuori da className arrivava nell'app senza prefisso e la barra restava trasparente)
	assert.match(meter, /className=\{`h-full rounded-full transition-\[width\] duration-300 \$\{usage\.level === 'pieno' \? 'bg-vox-danger' : usage\.level === 'avviso' \? 'bg-vox-warning' : 'bg-vox-accent'\}`\}/);
	const outsideClassNames = ui.replace(/className=(\{`[^`]*`\}|'[^']*'|"[^"]*")/g, '');
	assert.doesNotMatch(outsideClassNames, /'(bg|text|border)-vox-/);
	assert.match(ui, /lastCount\?\.shortened \?/);
	// la pagina: tutti gli avvisi, tutte le voci con la loro quota, i casi senza modello, senza conversazione e CLI
	assert.match(page, /<div role='status' className='mt-3 flex flex-col gap-1 text-\[12\.5px\] text-vox-warning'>\n\t\t\t\t\t\{notices\.map\(\(notice, i\) => <span key=\{i\}>\{notice\}<\/span>\)\}/);
	assert.match(page, /\{usage\.parts\.map\(part => \{/);
	assert.match(page, /const share = percentOfBudget\(part\.tokens, usage\.promptBudgetTokens\)/);
	for (const key of ["Choose a model in the chat: here you will see how much of its context window the next request takes.", "Write a message in the chat: here you will see how much of the model's context window the next request takes.", "CLI AIs manage their own context: Vox does not know how much of it they use and does not shorten the conversation for them."])
		assert.ok(page.includes(`t(${JSON.stringify(key)})`), key);
	assert.match(page, /const thread = chatThreadsState\.allThreads\[threadId\]/);
	assert.match(page, /const draft = useChatDraft\(threadId\)/);
	assert.match(page, /const measure = useChatContextMeasure\(\{ threadId, messages, selections, draft, enabled: hasModel && hasConversation \}\)/);
	// barra e quote solo con spazio per il prompt; una finestra senza spazio lo dice nel riepilogo
	assert.match(page, /const known = hasBudget\(usage\)/);
	// con la finestra sconosciuta niente «Finestra del modello: 0 token»
	assert.match(page, /\{usage\.contextWindow > 0 \? <span>\{t\("Model context window: /);
	// dopo un cambio di modello l'ultimo conteggio dice di quale modello è (non tara la stima del modello di adesso)
	assert.match(page, /: lastCount\.model !== null && lastCount\.model !== settingsState\.modelSelectionOfFeature\['Chat'\]\?\.modelName \? t\("Last request: \{0\} tokens counted by \{1\}, the model used before\.", lastCount\.promptTokens\.toLocaleString\(\), lastCount\.model\)\n\t+: t\("Last request: \{0\} tokens counted by the local model\.", lastCount\.promptTokens\.toLocaleString\(\)\)/);
	assert.match(ui, /const hasBudget = \(usage: ContextUsage\) => usage\.promptBudgetTokens > 0/);
	assert.match(ui, /: !hasBudget\(usage\) \? t\("the model's window leaves no room for the request"\)/);
	// tutti i testi hanno la traduzione italiana
	const keys = [...(ui + pane).matchAll(/\bt\("([^"]+)"/g)].map(match => match[1]);
	assert.ok(keys.length >= 30, `testi trovati: ${keys.length}`);
	for (const key of keys) assert.ok(i18n.includes(`\t${JSON.stringify(key)}: "`), `traduzione mancante: ${key}`);
});

test('scheda centrale: registrata, aperta o portata davanti (mai chiusa), nello stesso bundle della chat', () => {
	assert.match(contribution, /import '\.\/chatContextPane\.js'/);
	assert.match(actionIDs, /export const VOX_OPEN_CHAT_CONTEXT_ACTION_ID = 'workbench\.action\.vox\.openChatContext'/);
	assert.match(sidebarIndex, /export const mountChatContext = mountFnGenerator\(ChatContextPage\)/);
	assert.match(pane, /import \{ mountChatContext \} from '\.\/react\/out\/sidebar-tsx\/index\.js'/);
	assert.match(pane, /static readonly RESOURCE = URI\.from\(\{ scheme: 'vox', path: 'chat-context' \}\)/);
	assert.match(pane, /EditorPaneDescriptor\.create\(VoxChatContextPane, VoxChatContextPane\.ID, t\("Chat context"\)\),\n\t\[new SyncDescriptor\(VoxChatContextInput\)\]/);
	assert.match(pane, /const \[open\] = editorService\.findEditors\(VoxChatContextInput\.RESOURCE\);\n\t\tif \(open\) \{\n\t\t\tawait editorService\.openEditor\(open\.editor, \{ pinned: true \}, open\.groupId\);\n\t\t\treturn;\n\t\t\}/);
	assert.doesNotMatch(pane, /closeEditors|minimumWidth/);
	// una scheda sola anche con due aperture ravvicinate
	assert.match(pane, /override matches\(other: EditorInput \| IUntypedEditorInput\): boolean \{\n\t\treturn other instanceof VoxChatContextInput \|\| super\.matches\(other\)\n\t\}/);
	assert.match(pane, /this\._register\(toDisposable\(\(\) => disposeFn\?\.\(\)\)\)/);
	assert.match(pane, /f1: true,/);
});

test('impronta dei messaggi: cambia con il contenuto anche a lunghezza uguale, una volta per oggetto', () => {
	const { fingerprintOf } = loadPlain();
	const assistant = text => ({ role: 'assistant', displayContent: text, reasoning: '', anthropicReasoning: null });
	const a = assistant('ciao'), b = assistant('cibo');
	assert.notEqual(fingerprintOf(a), fingerprintOf(b));
	assert.equal(fingerprintOf(a), fingerprintOf(assistant('ciao')));
	// i conteggi del motore non contano
	assert.equal(fingerprintOf(a), fingerprintOf({ ...assistant('ciao'), tokenStats: { promptTokens: 9 } }));
	// utente: testo e nota sui file aperti
	const user = (content, editorStateNote) => ({ role: 'user', content, displayContent: content, editorStateNote });
	assert.notEqual(fingerprintOf(user('abc')), fingerprintOf(user('abd')));
	// stesse lettere in altro ordine (un semplice XOR dei caratteri le confonderebbe)
	assert.notEqual(fingerprintOf(user('ab')), fingerprintOf(user('ba')));
	assert.notEqual(fingerprintOf(user('abc', 'x')), fingerprintOf(user('abc', 'y')));
	// strumenti: stato, risultato e parametri (stessa lunghezza)
	const tool = (type, content, rawParams) => ({ role: 'tool', type, name: 'read_file', id: '1', content, rawParams });
	assert.notEqual(fingerprintOf(tool('success', 'r', { uri: 'a.ts' })), fingerprintOf(tool('success', 'r', { uri: 'b.ts' })));
	assert.notEqual(fingerprintOf(tool('running_now', 'r', {})), fingerprintOf(tool('success', 'r', {})));
	assert.notEqual(fingerprintOf(tool('success', 'r1', {})), fingerprintOf(tool('success', 'r2', {})));
	// un oggetto già visto non si ricalcola
	const once = assistant('x');
	const first = fingerprintOf(once);
	once.displayContent = 'y';
	assert.equal(fingerprintOf(once), first);
	// checkpoint e simili: solo il ruolo
	assert.equal(fingerprintOf({ role: 'checkpoint' }), 'c0:' + (0x811c9dc5 >>> 0).toString(36));
});

test('editor: il servizio espone file aperti e file attivo con il loro evento (modelli dentro e fuori, editor attivo)', () => {
	const service_ = service.replace(/\r\n/g, '\n');
	assert.match(service_, /readonly onDidChangeEditorSnapshot: Event<void>\n\t\/\/ [^\n]+\n\teditorSnapshotKey\(\): string\n\}/);
	assert.match(service_, /readonly onDidChangeContextPremises: Event<void>\n\tcontextPremisesVersion\(\): number\n/);
	// la stessa istantanea del messaggio di sistema: file aperti e file attivo, senza le schede di Vox
	assert.match(service_, /editorSnapshotKey\(\): string \{\n\t\treturn JSON\.stringify\(this\._editorSnapshot\(\)\)\n\t\}/);
	assert.match(service_, /const watchAttached = \(model: ITextModel\) => attachedListeners\.set\(model, model\.onDidChangeAttached\(\(\) => this\._onDidChangeEditorSnapshot\.fire\(\)\)\)/);
	assert.match(service_, /for \(const model of this\.modelService\.getModels\(\)\) watchAttached\(model\)/);
	assert.match(service_, /this\._register\(this\.modelService\.onModelAdded\(watchAttached\)\)/);
	assert.match(service_, /this\._register\(this\.modelService\.onModelRemoved\(model => \{ attachedListeners\.deleteAndDispose\(model\); this\._onDidChangeEditorSnapshot\.fire\(\) \}\)\)/);
	// un clic su un altro gruppo di editor cambia il file attivo senza cambiare nessun modello
	assert.match(service_, /this\._register\(this\.editorService\.onDidActiveEditorChange\(\(\) => this\._onDidChangeEditorSnapshot\.fire\(\)\)\)/);
	assert.doesNotMatch(service_, /openFilesKey|onDidChangeOpenFiles/);
});
