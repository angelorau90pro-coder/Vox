import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Il modulo vero, con le dipendenze del workbench sostituite: gli strumenti disponibili sono quelli dati qui.
const source = stripTypeScriptTypes((await readFile(new URL('./extractGrammar.ts', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '')).replace(/^export /gm, '');
const helpers = await readFile(new URL('../../common/helpers/extractCodeFromResult.ts', import.meta.url), 'utf8');
const helpersStart = helpers.indexOf('export const endsWithAnyPrefixOf');
const helpersEnd = helpers.indexOf('// guarantees if you keep adding text', helpersStart);
const removerStart = helpers.indexOf('export class SurroundingsRemover');
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && removerStart >= 0, 'forma di extractCodeFromResult.ts cambiata: aggiornare il test');
const removerEnd = helpers.indexOf('\n}\n', removerStart) + 3;
const helperCode = stripTypeScriptTypes(helpers.slice(helpersStart, helpersEnd) + helpers.slice(removerStart, removerEnd)).replace(/^export /gm, '');
const tools = [{ name: 'read_file', params: { uri: {} } }];
const { extractXMLToolsWrapper } = new Function('generateUuid', 'availableTools', helperCode + source + '; return { extractXMLToolsWrapper };')(() => 'id', () => tools);

const run = (pieces) => {
	const texts = [], finals = [];
	const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(p => texts.push(p), p => finals.push(p), 'agent', undefined);
	let full = '';
	for (const piece of pieces) { full += piece; newOnText({ fullText: full, fullReasoning: '' }) }
	newOnFinalMessage({ fullText: full, fullReasoning: '' });
	return { texts, final: finals[0] };
};

test('risposta che finisce con l\'inizio possibile di un tag: a fine risposta il testo trattenuto non si perde', () => {
	assert.equal(run(['Usa sempre a ', '<']).final.fullText, 'Usa sempre a <');
	assert.equal(run(['Il confronto è x ', '<r']).final.fullText, 'Il confronto è x <r');
	assert.equal(run(['Tutto qui']).final.toolCall, undefined);
});

test('una chiamata a strumento in XML resta riconosciuta e il suo testo non finisce nella risposta', () => {
	const { final } = run(['Leggo il file. <read', '_file>\n<uri>\na.ts\n</uri>\n</read_file>']);
	assert.equal(final.fullText, 'Leggo il file.');
	assert.equal(final.toolCall.name, 'read_file');
	assert.equal(final.toolCall.rawParams.uri.trim(), 'a.ts');
	assert.equal(final.toolCall.isDone, true);
});
