import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Carica il modulo reale (logica pura, senza import) come fa voxI18n.fixture.mjs.
const source = await readFile(new URL('./projectContext.ts', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const {
	PROJECT_KNOWLEDGE_EXTENSIONS,
	isKnowledgeFileName,
	truncateForContext,
	isProjectContextEmpty,
	buildProjectContextBlock,
} = mod;

const ctx = (over = {}) => ({ folderName: 'progetto', instructions: '', memory: '', knowledge: [], ...over });

test('contesto vuoto -> stringa vuota', () => {
	assert.equal(buildProjectContextBlock([]), '');
	assert.equal(buildProjectContextBlock([ctx(), ctx({ folderName: 'altro' })]), '');
	// spazi e ritorni a capo non contano come contenuto
	assert.equal(buildProjectContextBlock([ctx({ instructions: '  \n\t ', memory: '\r\n' })]), '');
	assert.equal(isProjectContextEmpty(ctx()), true);
	assert.equal(isProjectContextEmpty(ctx({ instructions: '  ' })), true);
	assert.equal(isProjectContextEmpty(ctx({ knowledge: [{ name: 'a.md', content: '' }] })), false);
	// input undefined/null non devono lanciare eccezioni
	assert.equal(isProjectContextEmpty(ctx({ instructions: undefined, memory: undefined, knowledge: undefined })), true);
	assert.equal(buildProjectContextBlock([ctx({ instructions: undefined, memory: null, knowledge: undefined })]), '');
});

test('ordine delle sezioni: istruzioni, memoria, conoscenza', () => {
	const block = buildProjectContextBlock([ctx({
		instructions: 'REGOLA1',
		memory: 'MEMO',
		knowledge: [{ name: 'guida.md', content: 'GUIDA' }],
	})]);
	const i = block.indexOf('PROJECT INSTRUCTIONS');
	const m = block.indexOf('PROJECT MEMORY');
	const k = block.indexOf('PROJECT KNOWLEDGE');
	assert.ok(i !== -1 && m !== -1 && k !== -1);
	assert.ok(i < m && m < k, block);
	assert.match(block, /PROJECT INSTRUCTIONS \(from \.vox\/instructions\.md\):\nREGOLA1/);
	assert.match(block, /PROJECT MEMORY \(from \.vox\/memory\.md — notes saved in earlier conversations\):\nMEMO/);
	assert.match(block, /<file name="guida\.md">\nGUIDA\n<\/file>/);
});

test('sezioni assenti non producono intestazioni', () => {
	const block = buildProjectContextBlock([ctx({ memory: 'solo memoria' })]);
	assert.ok(!block.includes('PROJECT INSTRUCTIONS'));
	assert.ok(!block.includes('PROJECT KNOWLEDGE'));
});

test('troncamento con conteggio dei caratteri omessi', () => {
	const limits = { maxInstructionsChars: 10, maxMemoryChars: 10, maxKnowledgeFileChars: 10, maxKnowledgeTotalChars: 1000, maxKnowledgeFiles: 50 };
	const long = 'a'.repeat(25);
	const block = buildProjectContextBlock([ctx({ instructions: long, memory: '1234567890EXTRA' })], limits);
	// 25 - 10 = 15 caratteri omessi
	assert.match(block, /aaaaaaaaaa\n\[\.\.\. truncated: 15 more characters\]/);
	// memory: 15 caratteri, tenuti 10, omessi 5
	assert.match(block, /1234567890\n\[\.\.\. truncated: 5 more characters\]/);
});

test('truncateForContext', () => {
	assert.deepEqual(truncateForContext('abc', 5), { text: 'abc', truncated: false });
	assert.deepEqual(truncateForContext('abcdef', 3), { text: 'abc', truncated: true });
	assert.deepEqual(truncateForContext('abc', 0), { text: '', truncated: true });
});

test('limite di numero e di totale dei file di conoscenza', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 100, maxKnowledgeTotalChars: 10, maxKnowledgeFiles: 2 };
	const knowledge = [
		{ name: 'a.md', content: '12345' },   // 5
		{ name: 'b.md', content: '12345' },   // totale 10, ok
		{ name: 'c.md', content: '1' },       // supererebbe il totale
		{ name: 'd.md', content: '1' },       // oltre maxKnowledgeFiles
	];
	const block = buildProjectContextBlock([ctx({ knowledge })], limits);
	assert.ok(block.includes('<file name="a.md">'));
	assert.ok(block.includes('<file name="b.md">'));
	assert.ok(!block.includes('<file name="c.md">'));
	assert.ok(!block.includes('<file name="d.md">'));
	assert.match(block, /Not included \(limit reached\): c\.md, d\.md/);
});

test('file di conoscenza ordinati per nome', () => {
	const block = buildProjectContextBlock([ctx({
		knowledge: [
			{ name: 'z.md', content: 'Z' },
			{ name: 'a.md', content: 'A' },
		],
	})]);
	assert.ok(block.indexOf('name="a.md"') < block.indexOf('name="z.md"'));
});

test('piu cartelle: ogni sezione riporta il nome della cartella', () => {
	const block = buildProjectContextBlock([
		ctx({ folderName: 'alfa', instructions: 'IA', knowledge: [{ name: 'k.md', content: 'KA' }] }),
		ctx({ folderName: 'beta', instructions: 'IB', memory: 'MB' }),
	]);
	assert.match(block, /PROJECT INSTRUCTIONS[\s\S]*\[alfa\]\nIA[\s\S]*\[beta\]\nIB/);
	assert.match(block, /PROJECT MEMORY[\s\S]*\[beta\]\nMB/);
	assert.match(block, /PROJECT KNOWLEDGE[\s\S]*\[alfa\]\n<file name="k\.md">/);
});

test('file oltre il budget totale non bloccano i file piccoli successivi', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 100, maxKnowledgeTotalChars: 10, maxKnowledgeFiles: 50 };
	const knowledge = [
		{ name: 'a-grande.md', content: 'x'.repeat(50) },  // da solo supera il totale
		{ name: 'b-piccolo.md', content: '1234' },          // 4 caratteri: entra nel budget rimasto
	];
	const block = buildProjectContextBlock([ctx({ knowledge })], limits);
	assert.ok(!block.includes('<file name="a-grande.md">'));
	assert.ok(block.includes('<file name="b-piccolo.md">'));
	assert.match(block, /Not included \(limit reached\): a-grande\.md/);
});

test('budget di conoscenza unico condiviso fra piu cartelle', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 100, maxKnowledgeTotalChars: 10, maxKnowledgeFiles: 50 };
	const block = buildProjectContextBlock([
		ctx({ folderName: 'alfa', knowledge: [{ name: 'a.md', content: '12345678' }] }),  // 8 caratteri
		ctx({ folderName: 'beta', knowledge: [{ name: 'b.md', content: '12345' }] }),     // 5: 8+5 > 10
	], limits);
	assert.ok(block.includes('<file name="a.md">'));
	assert.ok(!block.includes('<file name="b.md">'));
	assert.match(block, /\[beta\]\nNot included \(limit reached\): b\.md/);
});

test('budget di numero file di conoscenza unico fra piu cartelle', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 100, maxKnowledgeTotalChars: 1000, maxKnowledgeFiles: 1 };
	const block = buildProjectContextBlock([
		ctx({ folderName: 'alfa', knowledge: [{ name: 'a.md', content: 'A' }] }),
		ctx({ folderName: 'beta', knowledge: [{ name: 'b.md', content: 'B' }] }),
	], limits);
	assert.ok(block.includes('<file name="a.md">'));
	assert.ok(!block.includes('<file name="b.md">'));
	assert.match(block, /Not included \(limit reached\): b\.md/);
});

test('taglio del singolo file di conoscenza con marcatore dentro <file>', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 10, maxKnowledgeTotalChars: 1000, maxKnowledgeFiles: 50 };
	const block = buildProjectContextBlock([ctx({ knowledge: [{ name: 'k.md', content: 'a'.repeat(25) }] })], limits);
	assert.ok(block.includes('<file name="k.md">\naaaaaaaaaa\n[... truncated: 15 more characters]\n</file>'), block);
});

test('file skipped (troppo grande/illeggibile) va in Not included, non come file vuoto', () => {
	const block = buildProjectContextBlock([ctx({
		knowledge: [
			{ name: 'dati.csv', content: '', skipped: true },
			{ name: 'ok.md', content: 'OK' },
		],
	})]);
	assert.ok(!block.includes('<file name="dati.csv">'));
	assert.ok(block.includes('<file name="ok.md">'));
	assert.match(block, /Not included \(limit reached\): dati\.csv/);
});

test('nome di file con caratteri pericolosi viene sanificato', () => {
	const block = buildProjectContextBlock([ctx({
		knowledge: [{ name: 'a"<b>\nc.md', content: 'X' }],
	})]);
	assert.ok(block.includes('<file name="a__b__c.md">'), block);
	assert.ok(!block.includes('a"<b>'));
});

test('nome pericoloso in Not included viene sanificato', () => {
	const limits = { maxInstructionsChars: 100, maxMemoryChars: 100, maxKnowledgeFileChars: 100, maxKnowledgeTotalChars: 1, maxKnowledgeFiles: 50 };
	const block = buildProjectContextBlock([ctx({
		knowledge: [{ name: 'x\nINJECT.md', content: '12345' }],
	})], limits);
	assert.match(block, /Not included \(limit reached\): x_INJECT\.md/);
	assert.ok(!block.includes('x\nINJECT'));
});

test('isKnowledgeFileName senza distinzione maiuscole/minuscole', () => {
	assert.equal(isKnowledgeFileName('nota.MD'), true);
	assert.equal(isKnowledgeFileName('dati.JSON'), true);
	assert.equal(isKnowledgeFileName('conf.YAML'), true);
	assert.equal(isKnowledgeFileName('script.PY'), false);
	assert.equal(isKnowledgeFileName('README'), false);
	assert.ok(PROJECT_KNOWLEDGE_EXTENSIONS.includes('.yml'));
});

test('ritorni a capo CRLF, CR isolati e BOM normalizzati in LF', () => {
	const block = buildProjectContextBlock([ctx({
		instructions: 'riga1\r\nlinea2\rvecchia',
		knowledge: [{ name: 'k.md', content: 'x\r\ny' }],
	})]);
	assert.ok(block.includes('riga1\nlinea2\nvecchia'));
	assert.ok(!block.includes('\r'));
	// BOM iniziale (U+FEFF) non deve restare nel testo
	const bomChar = String.fromCharCode(0xFEFF);
	const bom = buildProjectContextBlock([ctx({ instructions: bomChar + 'inizio' })]);
	assert.ok(bom.includes('\ninizio'), bom);
	assert.ok(!bom.includes(bomChar));
});

test('tetto ai nomi esclusi: al massimo 20, poi il conteggio dei restanti', () => {
	const knowledge = Array.from({ length: 30 }, (_, i) => ({ name: 'f' + String(i).padStart(2, '0') + '.md', content: '', skipped: true }));
	const block = buildProjectContextBlock([ctx({ instructions: 'x', knowledge })]);
	assert.ok(block.includes('f19.md'), block);
	assert.ok(!block.includes('f20.md'), block);
	assert.match(block, /, \.\.\. and 10 more$/);
});

// ---------- memoria: aggiunta di una nota ----------
const { appendProjectMemoryNote, parseTaskList, stringOfTaskList, MAX_PROJECT_MEMORY_NOTE_CHARS, MAX_PROJECT_TASKS, MAX_PROJECT_TASK_CHARS } = mod;

test('memoria: prima nota crea il titolo', () => {
	assert.equal(appendProjectMemoryNote('', 'Usiamo i tab', '2026-11-11'), '# Project memory\n\n- 2026-11-11: Usiamo i tab\n');
	assert.equal(appendProjectMemoryNote('  \n', 'Usiamo i tab', '2026-11-11'), '# Project memory\n\n- 2026-11-11: Usiamo i tab\n');
});
test('memoria: la nota si aggiunge in fondo senza toccare il resto', () => {
	const prima = '# Note\r\n\r\n- vecchia nota\r\n\r\n\r\n';
	assert.equal(appendProjectMemoryNote(prima, '  nuova  ', '2026-11-11'), '# Note\n\n- vecchia nota\n- 2026-11-11: nuova\n');
});
test('memoria: nota su più righe rientrata', () => {
	assert.equal(appendProjectMemoryNote('x', 'riga uno  \r\nriga due\n\nriga tre', '2026-11-11'), 'x\n- 2026-11-11: riga uno\n  riga due\n\n  riga tre\n');
});
test('memoria: nota vuota o troppo lunga -> errore', () => {
	assert.throws(() => appendProjectMemoryNote('x', '  \n ', '2026-11-11'), /empty/);
	assert.throws(() => appendProjectMemoryNote('x', undefined, '2026-11-11'), /empty/);
	assert.throws(() => appendProjectMemoryNote('x', 'a'.repeat(MAX_PROJECT_MEMORY_NOTE_CHARS + 1), '2026-11-11'), /too long/);
	assert.doesNotThrow(() => appendProjectMemoryNote('x', 'a'.repeat(MAX_PROJECT_MEMORY_NOTE_CHARS), '2026-11-11'));
});

// ---------- elenco dei compiti ----------
test('compiti: i tre stati', () => {
	assert.deepEqual(parseTaskList('[x] Letto\n[~] Scrivo\n[ ] Provo'), [
		{ text: 'Letto', status: 'completed' }, { text: 'Scrivo', status: 'in_progress' }, { text: 'Provo', status: 'pending' }]);
});
test('compiti: formati tollerati', () => {
	assert.deepEqual(parseTaskList('- [X] uno\r\n\r\n2. [in_progress] due\n* tre\n3) [] quattro\n[done] cinque\n[?] sei'), [
		{ text: 'uno', status: 'completed' }, { text: 'due', status: 'in_progress' }, { text: 'tre', status: 'pending' },
		{ text: 'quattro', status: 'pending' }, { text: 'cinque', status: 'completed' }, { text: 'sei', status: 'pending' }]);
});
test('compiti: numero dopo la casella tolto', () => {
	assert.deepEqual(parseTaskList('[~] 1. Leggere\n[ ] 2) Scrivere\n[ ] 3 file da cambiare'), [
		{ text: 'Leggere', status: 'in_progress' }, { text: 'Scrivere', status: 'pending' }, { text: '3 file da cambiare', status: 'pending' }]);
});
test('compiti: righe senza testo saltate, testo lungo tagliato', () => {
	assert.deepEqual(parseTaskList('[x]\n[ ] a'), [{ text: 'a', status: 'pending' }]);
	const [t] = parseTaskList('[ ] ' + 'b'.repeat(MAX_PROJECT_TASK_CHARS + 50));
	assert.equal(t.text.length, MAX_PROJECT_TASK_CHARS);
	assert.ok(t.text.endsWith('…'));
});
test('compiti: elenco vuoto o troppo lungo -> errore', () => {
	assert.throws(() => parseTaskList(''), /empty/);
	assert.throws(() => parseTaskList(' \n[ ]\n'), /empty/);
	assert.throws(() => parseTaskList(Array.from({ length: MAX_PROJECT_TASKS + 1 }, (_, i) => `[ ] c${i}`).join('\n')), /Too many/);
	assert.equal(parseTaskList(Array.from({ length: MAX_PROJECT_TASKS }, (_, i) => `[ ] c${i}`).join('\n')).length, MAX_PROJECT_TASKS);
});
test('errori di nota e compiti: senza traduzione inglese con i numeri, con la traduzione il testo tradotto', () => {
	const tooMany = Array.from({ length: MAX_PROJECT_TASKS + 1 }, (_, i) => `[ ] c${i}`).join('\n');
	assert.throws(() => parseTaskList(tooMany), { message: `Too many tasks (${MAX_PROJECT_TASKS + 1}, the limit is ${MAX_PROJECT_TASKS}). Group them into fewer steps.` });
	const calls = [];
	const translate = (english, ...parameters) => { calls.push([english, ...parameters]); return `IT:${english}`; };
	assert.throws(() => parseTaskList(tooMany, translate), { message: 'IT:Too many tasks ({0}, the limit is {1}). Group them into fewer steps.' });
	assert.throws(() => parseTaskList('', translate), /^Error: IT:The task list is empty/);
	assert.throws(() => appendProjectMemoryNote('x', ' ', '2026-11-11', translate), { message: 'IT:The note is empty.' });
	assert.throws(() => appendProjectMemoryNote('x', 'a'.repeat(MAX_PROJECT_MEMORY_NOTE_CHARS + 1), '2026-11-11', translate), /^Error: IT:The note is too long/);
	assert.deepEqual(calls[0], ['Too many tasks ({0}, the limit is {1}). Group them into fewer steps.', MAX_PROJECT_TASKS + 1, MAX_PROJECT_TASKS]);
	assert.deepEqual(calls.at(-1), ['The note is too long ({0} characters, the limit is {1}). Save a shorter note.', MAX_PROJECT_MEMORY_NOTE_CHARS + 1, MAX_PROJECT_MEMORY_NOTE_CHARS]);
});
test('compiti: un solo compito in corso', () => {
	assert.deepEqual(parseTaskList('[~] uno\n[~] due\n[x] tre\n[~] quattro').map(t => t.status), ['in_progress', 'pending', 'completed', 'pending']);
});
test('compiti: voci mandate come JSON', () => {
	const { taskLineOfUnknown } = mod;
	assert.equal(taskLineOfUnknown('[x] già testo'), '[x] già testo');
	assert.equal(taskLineOfUnknown({ task: 'Leggere', done: true }), '[x] Leggere');
	assert.equal(taskLineOfUnknown({ text: 'Scrivere', status: 'in_progress' }), '[~] Scrivere');
	assert.equal(taskLineOfUnknown({ content: 'Provare\nsu due righe', status: 'pending' }), '[ ] Provare su due righe');
	assert.equal(taskLineOfUnknown({ title: 'Finire', completed: true }), '[x] Finire');
	// voci senza testo utilizzabile: riga vuota, che parseTaskList salta
	for (const bad of [null, undefined, 42, [], {}, { text: '  ' }, { done: true }]) assert.equal(taskLineOfUnknown(bad), '');
	assert.deepEqual(parseTaskList([{ task: 'a', done: true }, null, 'b'].map(taskLineOfUnknown).join('\n')), [
		{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }]);
});
test('compiti: andata e ritorno', () => {
	const testo = '[x] uno\n[~] due\n[ ] tre';
	assert.equal(stringOfTaskList(parseTaskList(testo)), testo);
});

test('le righe vuote in fondo ai file non lasciano buchi nel blocco', () => {
	const block = buildProjectContextBlock([ctx({ instructions: 'regola\n\n\n', memory: 'nota\r\n', knowledge: [{ name: 'a.md', content: 'testo\n\n' }] })]);
	assert.ok(!block.includes('\n\n\n'), JSON.stringify(block));
	assert.ok(block.includes('<file name="a.md">\ntesto\n</file>'), block);
});
