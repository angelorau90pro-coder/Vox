import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('./localContextFit.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
const { contextOverflowOf, shrinkToFit, charsOf, answerReserveOf, takeRequestMark, cutToolResults } = new Function(source + '; return { contextOverflowOf, shrinkToFit, charsOf, answerReserveOf, takeRequestMark, cutToolResults };')();

const total = messages => messages.reduce((sum, message) => sum + charsOf(message), 0);
const long = (letter, length) => letter.repeat(length);

test("riconosce l'errore di contesto di llama-server: corpo dell'APIError, corpo annidato e solo testo", () => {
	// come lo restituisce l'SDK OpenAI: `error` è il campo `error` del corpo JSON
	const apiError = Object.assign(new Error('400 request (16622 tokens) exceeds the available context size (16384 tokens), try increasing it'), {
		status: 400, error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 16622, n_ctx: 16384 },
	});
	assert.deepEqual(contextOverflowOf(apiError), { promptTokens: 16622, contextTokens: 16384 });
	assert.deepEqual(contextOverflowOf({ body: { error: { n_prompt_tokens: 9000, n_ctx: 8192 } } }), { promptTokens: 9000, contextTokens: 8192 });
	assert.deepEqual(contextOverflowOf(new Error('400 request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it')), { promptTokens: 5000, contextTokens: 4096 });
});

test('non scambia per errore di contesto gli altri errori', () => {
	assert.equal(contextOverflowOf(null), null);
	assert.equal(contextOverflowOf(new Error('fetch failed')), null);
	assert.equal(contextOverflowOf({ status: 400, error: { message: 'bad request' } }), null);
	// numeri incoerenti: il prompt entra, quindi non è questo errore
	assert.equal(contextOverflowOf({ error: { n_prompt_tokens: 100, n_ctx: 4096 } }), null);
	assert.equal(contextOverflowOf({ error: { n_prompt_tokens: '9000', n_ctx: 8192 } }), null);
	const loop = {}; loop.error = loop;
	assert.equal(contextOverflowOf(loop), null);
});

test('spazio per la risposta: un quarto del contesto, almeno 1024, mai più di metà', () => {
	assert.equal(answerReserveOf(16384), 4096);
	assert.equal(answerReserveOf(2048), 1024);
	assert.equal(answerReserveOf(1500), 750);
});

test('accorcia prima i messaggi vecchi e lascia intatti sistema e richiesta in corso quando basta', () => {
	const messages = [
		{ role: 'system', content: long('s', 4000) },
		{ role: 'user', content: long('u', 20000) },
		{ role: 'assistant', content: long('a', 20000) },
		{ role: 'user', content: 'domanda finale' },
	];
	const before = total(messages);
	// 44014 caratteri per 16622 token: il taglio deve portare il prompt sotto 16384 - 4096
	const { messages: result, fitted, removed } = shrinkToFit(messages, { promptTokens: 16622, contextTokens: 16384 });
	assert.equal(fitted, true);
	assert.equal(result.length, messages.length);
	assert.deepEqual(result.map(m => m.role), messages.map(m => m.role));
	assert.equal(result[0].content, messages[0].content);
	assert.equal(result[3].content, 'domanda finale');
	// dopo l'audit pro il taglio è proporzionale: dal più vecchio si toglie solo quanto serve (prima restavano
	// sempre 160 caratteri), quindi il messaggio successivo resta intero
	assert.ok(result[1].content.endsWith(' […]') && result[1].content.length < 20000 && result[1].content.length > 160);
	assert.equal(result[2].content, messages[2].content);
	const needed = (16622 - (16384 - 4096)) * (before / 16622);
	assert.ok(removed >= needed, `tolti ${removed}, servivano ${needed}`);
	// l'originale non cambia
	assert.equal(messages[1].content.length, 20000);
});

test('accorcia gli argomenti delle chiamate a strumento restando JSON valido, senza togliere chiamate o risultati', () => {
	const call = { type: 'function', id: 'c1', function: { name: 'rewrite_file', arguments: JSON.stringify({ uri: '/a.ts', new_content: long('x', 30000) }) } };
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: 'scrivi il file' },
		{ role: 'assistant', content: '', tool_calls: [call] },
		{ role: 'tool', tool_call_id: 'c1', content: 'fatto' },
		{ role: 'user', content: 'e adesso?' },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(fitted, true);
	const args = JSON.parse(result[2].tool_calls[0].function.arguments);
	assert.equal(args.uri, '/a.ts');
	assert.ok(args.new_content.length < 200);
	assert.equal(result[2].tool_calls[0].id, 'c1');
	assert.equal(result[3].tool_call_id, 'c1');
	assert.equal(result[4].content, 'e adesso?');
});

test('argomenti non JSON: accorciati come testo', () => {
	const messages = [
		{ role: 'user', content: 'x' },
		{ role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'c', function: { name: 'n', arguments: long('{', 10000) } }] },
		{ role: 'user', content: 'y' },
	];
	const { messages: result } = shrinkToFit(messages, { promptTokens: 5000, contextTokens: 4096 });
	assert.ok(result[1].tool_calls[0].function.arguments.length < 200);
});

// Comportamento cambiato di proposito dopo la revisione: la domanda dell'utente non si tronca mai di nascosto;
// se sistema e messaggi vecchi non bastano, `fitted` è falso e il chiamante dà l'errore chiaro.
test('se i vecchi non bastano accorcia il sistema tenendone l’inizio, ma la domanda dell’utente resta intera', () => {
	const messages = [
		{ role: 'system', content: 'ISTRUZIONI' + long('s', 30000) },
		{ role: 'user', content: 'breve' },
		{ role: 'user', content: 'RICHIESTA' + long('r', 30000) },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 30000, contextTokens: 8192 });
	assert.equal(fitted, false);
	assert.ok(result[0].content.startsWith('ISTRUZIONI') && result[0].content.length < 30010);
	assert.equal(result[2].content, messages[2].content);
	assert.equal(result[1].content, 'breve');
	// quando invece il sistema basta, la domanda lunga resta intera e `fitted` è vero
	const enough = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(enough.fitted, true);
	assert.equal(enough.messages[2].content, messages[2].content);
});

test('ultimo messaggio risultato di uno strumento (file letto molto lungo): si accorcia tenendone l’inizio', () => {
	const call = { type: 'function', id: 'r1', function: { name: 'read_file', arguments: '{"uri":"/a.ts"}' } };
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: 'leggi il file' },
		{ role: 'assistant', content: '', tool_calls: [call] },
		{ role: 'tool', tool_call_id: 'r1', content: 'INIZIO' + long('f', 40000) },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 16000, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.ok(result[3].content.startsWith('INIZIO') && result[3].content.endsWith(' […]') && result[3].content.length < 40000);
	assert.equal(result[3].tool_call_id, 'r1');
	assert.equal(result[1].content, 'leggi il file');
});

test('sistema fuso nel primo messaggio utente (modelli senza ruolo di sistema): protetto come il sistema', () => {
	const fused = '<SYSTEM_MESSAGE>\nISTRUZIONI' + long('s', 6000) + '\n</SYSTEM_MESSAGE>\nprima domanda';
	const messages = [
		{ role: 'user', content: fused },
		{ role: 'assistant', content: long('a', 20000) },
		{ role: 'user', content: long('u', 20000) },
		{ role: 'user', content: 'domanda finale' },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 16000, contextTokens: 16384 });
	assert.equal(fitted, true);
	// si taglia il messaggio intermedio più vecchio (solo quanto serve); il blocco di sistema resta intero
	assert.equal(result[0].content, fused);
	assert.ok(result[1].content.endsWith(' […]') && result[1].content.length < 20000);
	assert.equal(result[2].content, messages[2].content);
	assert.equal(result[3].content, 'domanda finale');
});

test('parti di testo in un contenuto a blocchi vengono contate e accorciate', () => {
	const messages = [
		{ role: 'user', content: 'x' },
		{ role: 'assistant', content: [{ type: 'text', text: long('t', 20000) }] },
		{ role: 'user', content: 'y' },
	];
	assert.equal(charsOf(messages[1]), 20000);
	const { messages: result } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.ok(result[1].content[0].text.endsWith(' […]') && result[1].content[0].text.length < 20000);
});

test('modalità agente: la domanda attuale resta intera anche se dopo ci sono chiamate e risultati di strumenti', () => {
	// caso riprodotto nell'audit pro: prima la domanda diventava di 164 caratteri e perdeva il vincolo finale
	const call = { type: 'function', id: 'r1', function: { name: 'read_file', arguments: '{"uri":"/a.ts"}' } };
	const request = 'RICHIESTA' + long('q', 2000) + ' VINCOLO FINALE';
	const messages = [
		{ role: 'system', content: long('s', 3000) },
		{ role: 'user', content: long('u', 9000) },
		{ role: 'assistant', content: long('a', 9000) },
		{ role: 'user', content: request },
		{ role: 'assistant', content: '', tool_calls: [call] },
		{ role: 'tool', tool_call_id: 'r1', content: long('f', 3000) },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 12000, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.equal(result[3].content, request);
	assert.ok(result[1].content.length < 9000);
});

test('formato XML: l’ultimo risultato di strumento (messaggio user) si accorcia, la domanda no', () => {
	const request = 'leggi il file grande';
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: request },
		{ role: 'assistant', content: '<read_file><uri>/a.ts</uri></read_file>' },
		{ role: 'user', content: '<read_file_result>\nINIZIO' + long('f', 40000) + '\n</read_file_result>' },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 16000, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.equal(result[1].content, request);
	// il blocco accorciato resta chiuso (scelta voluta: il modello vede un risultato completo e al nuovo tentativo
	// il messaggio è ancora riconosciuto come risultato)
	assert.ok(result[3].content.startsWith('<read_file_result>\nINIZIO') && result[3].content.endsWith(' […]\n</read_file_result>') && result[3].content.length < 40000);
});

test('formato XML: un tag di chiusura dentro il file letto non toglie la protezione alla domanda', () => {
	const request = long('q', 8000) + ' VINCOLO FINALE';
	const content = '<read_file_result>\nconst tag = "</read_file_result>";\n' + long('f', 20000) + '\n</read_file_result>';
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: request },
		{ role: 'assistant', content: '<read_file><uri>/a.ts</uri></read_file>' },
		{ role: 'user', content },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 8300, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.equal(result[1].content, request);
	assert.ok(result[3].content.length < content.length && result[3].content.endsWith('</read_file_result>'));
});

test('formato XML: ai nuovi tentativi il risultato già accorciato resta un risultato e la domanda resta intera', () => {
	const request = long('q', 8000) + ' VINCOLO FINALE';
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: request },
		{ role: 'assistant', content: '<read_file><uri>/a.ts</uri></read_file>' },
		{ role: 'user', content: '<read_file_result>\n' + long('f', 40000) + '\n</read_file_result>' },
	];
	// come `sendVoxLocalChat`: ogni nuovo tentativo parte dai messaggi già accorciati
	const first = shrinkToFit(messages, { promptTokens: 16000, contextTokens: 8192 }).messages;
	const second = shrinkToFit(first, { promptTokens: 8300, contextTokens: 8192 }).messages;
	for (const round of [first, second]) {
		assert.equal(round[1].content, request);
		assert.ok(round[3].content.endsWith('</read_file_result>'));
	}
	assert.ok(second[3].content.length < first[3].content.length);
});

test('formato XML: risultato e domanda fusi nello stesso messaggio (domanda scritta dopo Stop) restano interi', () => {
	// `prepareMessages_XML_tools` accoda la nuova domanda al risultato precedente: il messaggio comincia con il
	// risultato ma contiene la domanda attuale, quindi non è un risultato da accorciare
	const fused = '<read_file_result>\n' + long('f', 20000) + '\n</read_file_result>\n\nora riassumi SOLO la funzione main, in tre righe';
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: 'leggi il file grande' },
		{ role: 'assistant', content: long('a', 9000) + '<read_file><uri>/a.ts</uri></read_file>' },
		{ role: 'user', content: fused },
	];
	const { messages: result } = shrinkToFit(messages, { promptTokens: 16000, contextTokens: 8192 });
	assert.equal(result[3].content, fused);
	assert.ok(result[2].content.length < 9000, 'si accorcia la cronologia, non la domanda attuale');
});

test('formato XML: più risultati consecutivi sono ancora un risultato, un blocco senza chiusura no', () => {
	const results = '<read_file_result>\n' + long('f', 20000) + '\n</read_file_result>\n\n<ls_dir_result>\na.ts\n</ls_dir_result>\n';
	const base = [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'leggi' }, { role: 'assistant', content: '<ls_dir></ls_dir>' }];
	const shortened = shrinkToFit([...base, { role: 'user', content: results }], { promptTokens: 12000, contextTokens: 8192 }).messages;
	assert.equal(shortened[1].content, 'leggi');
	assert.ok(shortened[3].content.length < results.length);
	// senza chiusura il messaggio non è un risultato riconoscibile: conta come domanda e resta intero
	const open = '<read_file_result>\n' + long('f', 20000);
	const kept = shrinkToFit([...base, { role: 'user', content: open }], { promptTokens: 12000, contextTokens: 8192 }).messages;
	assert.equal(kept[3].content, open);
});

test('fitted conta quanto serve davvero: il margine del 25% non blocca un nuovo tentativo possibile', () => {
	// sistema da 8000 caratteri che si può accorciare fino a 2000: basta per la stima, non per il margine
	const messages = [{ role: 'system', content: long('s', 8000) }, { role: 'user', content: long('u', 400) }];
	// 8400 caratteri per 4200 token (2 caratteri per token), obiettivo 4096 - 1024 = 3072: servono 2256 caratteri
	const { fitted, removed } = shrinkToFit(messages, { promptTokens: 4200, contextTokens: 4096 });
	assert.ok(removed >= 2256);
	assert.equal(fitted, true);
});

test('non basta nemmeno accorciando tutto: fitted falso, ma il taglio fatto resta', () => {
	const messages = [{ role: 'system', content: long('s', 2100) }, { role: 'user', content: long('u', 400) }];
	const { fitted, removed } = shrinkToFit(messages, { promptTokens: 20000, contextTokens: 4096 });
	assert.equal(fitted, false);
	assert.ok(removed > 0);
});

test('nessun testo da togliere: removed 0, così il chiamante non ritenta all’infinito', () => {
	const messages = [{ role: 'user', content: '' }];
	const { removed, fitted } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(removed, 0);
	assert.equal(fitted, false);
});

test('segno della domanda: si legge e si toglie; un segno non valido si ignora', () => {
	const messages = [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'risultato\n\ndomanda', voxRequestChars: 7 }];
	const { messages: clean, mark } = takeRequestMark(messages);
	assert.deepEqual(mark, { index: 1, chars: 7 });
	assert.deepEqual(clean[1], { role: 'user', content: 'risultato\n\ndomanda' });
	assert.equal(messages[1].voxRequestChars, 7, 'i messaggi ricevuti non si modificano');
	for (const chars of [-1, 1.5, '7', 999]) {
		const result = takeRequestMark([{ role: 'user', content: 'domanda', voxRequestChars: chars }]);
		assert.equal(result.mark, undefined);
		assert.equal('voxRequestChars' in result.messages[0], false);
	}
	assert.equal(takeRequestMark([{ role: 'assistant', content: 'x', voxRequestChars: 1 }]).mark, undefined);
	// un segno sbagliato passato a mano non fa danni: si torna al ripiego sul testo
	const messagesForShrink = [{ role: 'system', content: long('s', 3000) }, { role: 'user', content: long('u', 9000) }, { role: 'user', content: 'domanda' }];
	for (const mark of [{ index: -1, chars: 1 }, { index: 1.5, chars: 1 }, { index: 9, chars: 1 }, { index: 2, chars: -3 }]) {
		const { messages: result } = shrinkToFit(messagesForShrink, { promptTokens: 6000, contextTokens: 4096 }, mark);
		assert.equal(result[2].content, 'domanda');
	}
});

test('segno della domanda: una domanda fusa che finisce con un tag XML resta intera, il risultato prima di lei si accorcia', () => {
	const question = 'perché il mio output finisce con </read_file_result>';
	const fused = '<read_file_result>\n' + long('f', 20000) + '\n</read_file_result>\n\n' + question;
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: 'leggi il file' },
		{ role: 'assistant', content: '<read_file><uri>/a.ts</uri></read_file>' },
		{ role: 'user', content: fused },
	];
	// senza segno il messaggio sembra un risultato (ripiego): con il segno la domanda è protetta
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 8300, contextTokens: 8192 }, { index: 3, chars: question.length });
	assert.equal(fitted, true);
	assert.ok(result[3].content.endsWith('\n</read_file_result>\n\n' + question));
	assert.ok(result[3].content.startsWith('<read_file_result>\n') && result[3].content.length < fused.length);
	assert.equal(result[1].content, 'leggi il file');
});

test('segno della domanda: con il sistema fuso nella prima domanda, del sistema restano almeno 2000 caratteri', () => {
	const question = 'prima domanda VINCOLO FINALE';
	const first = '<SYSTEM_MESSAGE>\n' + long('s', 9000) + '\n</SYSTEM_MESSAGE>\n' + question;
	const { messages: result } = shrinkToFit([{ role: 'user', content: first }], { promptTokens: 5000, contextTokens: 4096 }, { index: 0, chars: question.length });
	assert.ok(result[0].content.endsWith(question));
	assert.ok(result[0].content.startsWith('<SYSTEM_MESSAGE>'));
	assert.ok(result[0].content.length >= 2000 + question.length && result[0].content.length < first.length);
});

test('segno della domanda: dopo la domanda l’ultimo messaggio non dell’assistente è un risultato e si accorcia', () => {
	const request = long('q', 3000) + ' VINCOLO FINALE';
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: request },
		{ role: 'assistant', content: '<run_command><command>ls</command></run_command>' },
		// un risultato il cui testo non comincia con il tag (per esempio troncato altrove): conta la posizione, non il testo
		{ role: 'user', content: long('r', 20000) },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 }, { index: 1, chars: request.length });
	assert.equal(fitted, true);
	assert.equal(result[1].content, request);
	assert.ok(result[3].content.length < 20000);
});

test('risultati XML accorciati: il blocco tenuto si chiude con il suo tag e l’apertura resta intera', () => {
	const results = '<read_file_result>\n' + long('f', 20000) + '\n</read_file_result>\n\n<ls_dir_result>\na.ts\n</ls_dir_result>';
	const base = [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'leggi' }, { role: 'assistant', content: '<ls_dir></ls_dir>' }];
	const shortened = shrinkToFit([...base, { role: 'user', content: results }], { promptTokens: 12000, contextTokens: 8192 }).messages[3].content;
	assert.ok(shortened.endsWith(' […]\n</read_file_result>'), 'nessun tag di chiusura di un altro blocco');
	// taglio dentro il secondo blocco: si chiude il secondo, il primo resta intero e chiuso
	const second = '<read_file_result>\nbreve\n</read_file_result>\n\n<ls_dir_result>\n' + long('d', 20000) + '\n</ls_dir_result>';
	const inSecond = shrinkToFit([...base, { role: 'user', content: second }], { promptTokens: 12000, contextTokens: 8192 }).messages[3].content;
	assert.ok(inSecond.startsWith('<read_file_result>\nbreve\n</read_file_result>\n\n<ls_dir_result>\nddd'));
	assert.ok(inSecond.endsWith(' […]\n</ls_dir_result>') && inSecond.length < second.length);
	// taglio fra due blocchi (nella riga vuota o a metà del tag di apertura del secondo): resta il primo blocco intero
	const first = '<a_result>\n' + long('x', 100) + '\n</a_result>';
	const two = first + '\n\n<b_result>\n' + long('y', 1000) + '\n</b_result>';
	const closeLen = '\n</a_result>'.length;
	for (const visible of [first.length + 1, first.length + 4]) assert.equal(cutToolResults(two, visible + closeLen), first);
	assert.ok(cutToolResults(two, 300).endsWith(' […]\n</b_result>'));
	const name = 'x'.repeat(145);
	const longTag = `<${name}_result>\n` + long('f', 20000) + `\n</${name}_result>`;
	const kept = shrinkToFit([...base, { role: 'user', content: longTag }], { promptTokens: 12000, contextTokens: 8192 }).messages[3].content;
	assert.ok(kept.startsWith(`<${name}_result>`) && kept.endsWith(`</${name}_result>`));
});

test('accorciando un vecchio messaggio dell\'utente la nota sui file aperti in coda resta intera', () => {
	const note = "<editor_state>\nThe files open in the user's editor have changed since the start of this conversation. Current state:\n- Active file:\nb.py\n\n- Open files:\nb.py\n</editor_state>";
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: long('v', 30_000) + '\n\n' + note },
		{ role: 'assistant', content: long('r', 2000) },
		{ role: 'user', content: 'domanda attuale' },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.ok(result[1].content.length < messages[1].content.length);
	assert.ok(result[1].content.endsWith('\n\n' + note));
	assert.equal(result[3].content, 'domanda attuale');
	// un blocco qualunque in coda non è una nota: si taglia come il resto
	const plain = [messages[0], { role: 'user', content: long('v', 30_000) + '\n<editor_state>\nx\n</editor_state>' }, messages[2], messages[3]];
	assert.ok(!shrinkToFit(plain, { promptTokens: 9000, contextTokens: 8192 }).messages[1].content.endsWith('</editor_state>'));
});

test('con una nota lunga il vecchio messaggio cede comunque il suo testo: la nota conta nel limite', () => {
	const files = Array.from({ length: 45 }, (_, i) => 'e:\\progetti\\un-progetto-con-un-nome-lungo\\src\\cartella\\file-numero-' + i + '.ts').join('\n');
	const note = "<editor_state>\nThe files open in the user's editor have changed since the start of this conversation. Current state:\n- Active file:\na.ts\n\n- Open files:\n" + files + '\n</editor_state>';
	assert.ok(note.length > 3000);
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: long('v', 4000) + '\n\n' + note },
		{ role: 'assistant', content: long('r', 300) },
		{ role: 'user', content: 'domanda attuale' },
	];
	const { messages: result, fitted, removed } = shrinkToFit(messages, { promptTokens: 4500, contextTokens: 4096 });
	assert.equal(fitted, true);
	assert.ok(removed > 0);
	assert.ok(result[1].content.length < messages[1].content.length);
	assert.ok(result[1].content.endsWith('\n\n' + note));
	assert.equal(result[3].content, 'domanda attuale');
});

test('si conserva solo l\'ultima nota: quelle più vecchie e quelle troppo lunghe si tagliano come il resto', () => {
	const noteOf = files => "<editor_state>\nThe files open in the user's editor have changed since the start of this conversation. Current state:\n- Active file:\na.ts\n\n- Open files:\n" + files + '\n</editor_state>';
	const old = noteOf('vecchio.ts'), recent = noteOf('recente.ts');
	const messages = [
		{ role: 'system', content: 'sistema' },
		{ role: 'user', content: long('a', 15_000) + '\n\n' + old },
		{ role: 'assistant', content: long('r', 300) },
		{ role: 'user', content: long('b', 15_000) + '\n\n' + recent },
		{ role: 'assistant', content: long('s', 300) },
		{ role: 'user', content: 'domanda attuale' },
	];
	const { messages: result, fitted } = shrinkToFit(messages, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(fitted, true);
	assert.ok(result[3].content.endsWith('\n\n' + recent));
	assert.ok(!result[1].content.endsWith('</editor_state>'));
	// una nota (o un blocco incollato con la stessa forma) oltre la misura massima non è un costo fisso
	const huge = noteOf(long('x', 20_000));
	const withHuge = [messages[0], { role: 'user', content: long('a', 2000) + '\n\n' + huge }, messages[2], messages[5]];
	const shrunk = shrinkToFit(withHuge, { promptTokens: 9000, contextTokens: 8192 });
	assert.equal(shrunk.fitted, true);
	assert.ok(!shrunk.messages[1].content.endsWith('</editor_state>'));
});
