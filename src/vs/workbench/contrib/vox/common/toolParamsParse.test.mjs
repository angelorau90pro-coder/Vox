import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./toolParamsParse.ts', import.meta.url), 'utf8');
const { parseToolParamsLenient: p } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('JSON corretto', () => {
	assert.deepEqual(p('{"uri":"a.js","page_number":2}'), { uri: 'a.js', page_number: 2 });
});
test('stringa vuota o di soli spazi -> nessun parametro', () => {
	assert.deepEqual(p(''), {});
	assert.deepEqual(p('  \n'), {});
	assert.deepEqual(p(undefined), {});
});
test('recinto di codice', () => {
	assert.deepEqual(p('```json\n{"uri":"a.js"}\n```'), { uri: 'a.js' });
	assert.deepEqual(p('```\n{"uri":"a.js"}```'), { uri: 'a.js' });
});
test('testo attorno all\'oggetto', () => {
	assert.deepEqual(p('Ecco i parametri: {"uri":"a.js"} fine'), { uri: 'a.js' });
});
test('virgola finale', () => {
	assert.deepEqual(p('{"uri":"a.js",}'), { uri: 'a.js' });
	assert.deepEqual(p('{"a":[1,2,],"b":{"c":1,},}'), { a: [1, 2], b: { c: 1 } });
});
test('oggetto codificato due volte', () => {
	assert.deepEqual(p(JSON.stringify('{"uri":"a.js"}')), { uri: 'a.js' });
});
test('le graffe dentro le stringhe non rompono la lettura', () => {
	assert.deepEqual(p('{"new_content":"function f() { return {a: 1}; }"}'), { new_content: 'function f() { return {a: 1}; }' });
});
test('una virgola dentro una stringa valida resta com\'è', () => {
	assert.deepEqual(p('{"command":"echo [1,]"}'), { command: 'echo [1,]' });
});
test('non recuperabile -> null', () => {
	assert.equal(p('non è json'), null);
	assert.equal(p('{"uri": '), null);
	assert.equal(p('[1,2]'), null);
	assert.equal(p('42'), null);
	assert.equal(p('null'), null);
});

// ---------- casi segnalati in revisione ----------
const { removeTrailingCommas } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('la virgola finale si toglie senza toccare il contenuto delle stringhe', () => {
	assert.deepEqual(p('{"command":"echo [1,]",}'), { command: 'echo [1,]' });
	assert.deepEqual(p('{"new_content":"const a = [1, 2,];\\nconst o = {x: 1,};",}'), { new_content: 'const a = [1, 2,];\nconst o = {x: 1,};' });
	assert.deepEqual(p('{"a":"virgolette \\" , ] dentro",}'), { a: 'virgolette " , ] dentro' });
	assert.deepEqual(p('{"a":"barra finale \\\\",}'), { a: 'barra finale \\' });
	assert.equal(removeTrailingCommas('{"a":"x,}" , }'), '{"a":"x,}"  }');
});
test('un elenco al livello più alto non diventa una chiamata', () => {
	assert.equal(p('[{"command":"echo test"}]'), null);
	assert.equal(p('[{"command":"echo test"},]'), null);
	assert.equal(p('```json\n[{"command":"echo test"}]\n```'), null);
	assert.equal(p('"[1,2]"'), null);
});
test('recinto di codice con virgola finale', () => {
	assert.deepEqual(p('```json\n{"uri":"a.js",}\n```'), { uri: 'a.js' });
});
