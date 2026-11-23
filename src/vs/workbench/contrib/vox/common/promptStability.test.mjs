// Stabilità dell'inizio del prompt: messaggio di sistema calcolato una volta per conversazione,
// novità dell'editor nel messaggio dell'utente, taglio dei messaggi a passi.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const source = stripTypeScriptTypes(await read('./promptStability.ts')).replace(/export /g, '');
const { createSystemMessageMemo, editorStateNote, stableTrimLength, trailingEditorStateNote, withoutEditorStateNote, indexOfEditorStateNoteToKeep, EDITOR_NOTE_MAX_KEPT } = new Function(source + '; return { createSystemMessageMemo, editorStateNote, stableTrimLength, trailingEditorStateNote, withoutEditorStateNote, indexOfEditorStateNoteToKeep, EDITOR_NOTE_MAX_KEPT };')();

const editor = (activeFile, ...openFiles) => ({ activeFile, openFiles });
// le note dei messaggi dell'utente rimasti nella conversazione: `undefined` per un messaggio senza nota
const none = undefined;

test('il messaggio di sistema resta quello della prima richiesta finché le premesse non cambiano', () => {
	const memo = createSystemMessageMemo();
	assert.equal(memo.get('t1', 'agent'), undefined);
	memo.set('t1', 'agent', 'SISTEMA 1', editor('a.py', 'a.py'));
	assert.equal(memo.get('t1', 'agent'), 'SISTEMA 1');
	assert.equal(memo.get('t1', 'agent'), 'SISTEMA 1');
	// altra modalità o altri strumenti: va ricalcolato
	assert.equal(memo.get('t1', 'normal'), undefined);
	// le conversazioni sono indipendenti
	assert.equal(memo.get('t2', 'agent'), undefined);
});

test('nessuna nota al primo messaggio né se l\'editor non è cambiato', () => {
	const memo = createSystemMessageMemo();
	assert.equal(memo.noteForNewUserMessage('t1', editor('a.py', 'a.py'), []), '');
	memo.set('t1', 'agent', 'SISTEMA', editor('a.py', 'a.py'));
	assert.equal(memo.noteForNewUserMessage('t1', editor('a.py', 'a.py'), [none]), '');
});

test('se l\'utente cambia file la nota arriva una volta sola, con lo stato nuovo', () => {
	const memo = createSystemMessageMemo();
	memo.set('t1', 'agent', 'SISTEMA', editor('a.py', 'a.py'));
	const b = editor('b.py', 'a.py', 'b.py');
	const note = memo.noteForNewUserMessage('t1', b, [none]);
	assert.equal(note, editorStateNote(b));
	assert.match(note, /- Active file:\nb\.py\n/);
	assert.match(note, /- Open files:\na\.py\nb\.py\n<\/editor_state>$/);
	// la nota ora sta nella cronologia: niente ripetizioni, e il messaggio di sistema non è cambiato
	const history = [none, note];
	assert.equal(memo.noteForNewUserMessage('t1', b, history), '');
	assert.equal(memo.get('t1', 'agent'), 'SISTEMA');
	// tornare allo stato iniziale è di nuovo una novità rispetto all'ultima nota
	assert.equal(memo.noteForNewUserMessage('t1', editor('a.py', 'a.py'), history), editorStateNote(editor('a.py', 'a.py')));
});

test('se il messaggio con la nota viene tolto (modifica, ritorno a un checkpoint) la nota riparte', () => {
	const memo = createSystemMessageMemo();
	memo.set('t1', 'agent', 'SISTEMA', editor('a.py', 'a.py'));
	const b = editor('b.py', 'b.py');
	const note = memo.noteForNewUserMessage('t1', b, [none]);
	assert.notEqual(note, '');
	// il secondo messaggio (con la nota) non c'è più: il modello conosce solo lo stato del messaggio di sistema
	assert.equal(memo.noteForNewUserMessage('t1', b, [none]), note);
	// e se nel frattempo l'editor è tornato com'era all'inizio non c'è niente da dire
	assert.equal(memo.noteForNewUserMessage('t1', editor('a.py', 'a.py'), [none]), '');
});

test('conta l\'ultima nota della cronologia, anche senza messaggio di sistema in memoria', () => {
	const memo = createSystemMessageMemo();
	const b = editor('b.py', 'b.py');
	const c = editor('c.py', 'c.py');
	const history = [editorStateNote(c), editorStateNote(b), none];
	// dopo un riavvio: l'ultima nota dice b
	assert.equal(memo.noteForNewUserMessage('t9', b, history), '');
	assert.equal(memo.noteForNewUserMessage('t9', c, history), editorStateNote(c));
	// senza note e senza messaggio di sistema in memoria non c'è niente da dire: lo stato finirà nel messaggio di sistema
	assert.equal(memo.noteForNewUserMessage('t9', b, [none, '']), '');
});

test('la nota dice anche quando non c\'è nessun file', () => {
	const note = editorStateNote(editor(undefined));
	assert.match(note, /NO ACTIVE FILE/);
	assert.match(note, /NO OPENED FILES/);
});

test('dopo un ricalcolo il modello conosce lo stato scritto nel nuovo messaggio di sistema', () => {
	const memo = createSystemMessageMemo();
	memo.set('t1', 'agent', 'SISTEMA', editor('a.py', 'a.py'));
	memo.set('t1', 'normal', 'SISTEMA 2', editor('b.py', 'b.py'));
	assert.equal(memo.get('t1', 'normal'), 'SISTEMA 2');
	assert.equal(memo.noteForNewUserMessage('t1', editor('b.py', 'b.py'), []), '');
	assert.notEqual(memo.noteForNewUserMessage('t1', editor('a.py', 'a.py'), []), '');
});

test('oltre il limite si dimentica la conversazione usata meno di recente', () => {
	const memo = createSystemMessageMemo(2);
	memo.set('t1', 'k', 'S1', editor('a'));
	memo.set('t2', 'k', 'S2', editor('a'));
	assert.equal(memo.get('t1', 'k'), 'S1'); // t1 torna la più recente
	memo.set('t3', 'k', 'S3', editor('a'));
	assert.equal(memo.get('t2', 'k'), undefined);
	assert.equal(memo.get('t1', 'k'), 'S1');
	assert.equal(memo.get('t3', 'k'), 'S3');
});

test('peek legge come get (stesse premesse) senza rendere la conversazione la più recente', () => {
	const memo = createSystemMessageMemo(2);
	memo.set('t1', 'k', 'S1', editor('a'));
	memo.set('t2', 'k', 'S2', editor('a'));
	assert.equal(memo.peek('t1', 'k'), 'S1');
	assert.equal(memo.peek('t1', 'altre premesse'), undefined);
	assert.equal(memo.peek('t9', 'k'), undefined);
	memo.set('t3', 'k', 'S3', editor('a'));
	// t1 era la meno recente e la lettura del pannello non l'ha cambiata: è lei a uscire
	assert.equal(memo.peek('t1', 'k'), undefined);
	assert.equal(memo.peek('t2', 'k'), 'S2');
});

test('taglio a passi: il punto del taglio cambia solo quando si supera un passo', () => {
	assert.equal(stableTrimLength(1, 50_000, 4000), 4000);
	assert.equal(stableTrimLength(3999, 50_000, 4000), 4000);
	assert.equal(stableTrimLength(4000, 50_000, 4000), 4000);
	assert.equal(stableTrimLength(4001, 50_000, 4000), 8000);
	// mai più di quanto il messaggio può cedere, mai meno del necessario
	assert.equal(stableTrimLength(4001, 5000, 4000), 5000);
	for (const need of [1, 777, 4000, 9999, 12_345]) assert.ok(stableTrimLength(need, 50_000, 4000) >= need);
	assert.equal(stableTrimLength(0, 50_000, 4000), 0);
});

test('quali note ha scritto Vox lo dice il campo del messaggio, non il testo', () => {
	const memo = createSystemMessageMemo();
	const b = editor('b.py', 'b.py');
	const note = editorStateNote(b);
	// l'utente ha incollato una nota uguale nel suo messaggio (che non ha il campo): il modello conosce ancora
	// solo lo stato del messaggio di sistema (a), quindi la nota vera parte
	memo.set('t1', 'agent', 'SISTEMA', editor('a.py', 'a.py'));
	assert.equal(memo.noteForNewUserMessage('t1', b, [none]), note);
	// per le IA che non la devono ricevere si toglie solo la nota del campo, in coda; il testo dell'utente resta
	assert.equal(withoutEditorStateNote('domanda\n\n' + note, note), 'domanda');
	assert.equal(withoutEditorStateNote('spiega questo:\n' + note, undefined), 'spiega questo:\n' + note);
	assert.equal(withoutEditorStateNote('domanda senza nota', undefined), 'domanda senza nota');
	assert.equal(withoutEditorStateNote('guarda: ' + note + ' che ne pensi?', note), 'guarda: ' + note + ' che ne pensi?');
});

test('il taglio dei messaggi riconosce la nota in coda dalla forma, per non toglierla', () => {
	const note = editorStateNote(editor('b.py', 'b.py'));
	assert.equal(trailingEditorStateNote('domanda\n\n' + note), note);
	assert.equal(trailingEditorStateNote('guarda: ' + note + ' che ne pensi?'), '');
	assert.equal(trailingEditorStateNote('niente nota'), '');
	// un blocco <editor_state> qualunque in fondo al messaggio non è una nota di Vox
	assert.equal(trailingEditorStateNote('esempio:\n<editor_state>\nqualcosa\n</editor_state>'), '');
});

test('il taglio di recupero del processo principale riconosce la stessa nota', async () => {
	// localContextFit.ts non importa niente (il suo test lo carica da solo): l'inizio della nota vi è ripetuto
	const fit = await read('../electron-main/llmMessage/localContextFit.ts');
	const start = /const EDITOR_NOTE_START = `([^`]+)`;/.exec(fit)[1].replace(/\r\n/g, '\n');
	assert.ok(editorStateNote(editor('a.py')).startsWith(start));
	assert.match(start, /^<editor_state>\nThe files open/);
});

test('togliendo la nota il testo dell\'utente resta identico, spazi finali compresi', () => {
	const note = editorStateNote(editor('b.py', 'b.py'));
	assert.equal(withoutEditorStateNote('codice con spazi  \n\n\n' + note, note), 'codice con spazi  \n');
	assert.equal(withoutEditorStateNote('riga\n\n\n\n' + note, note), 'riga\n\n');
});

test('il taglio conserva solo l\'ultima nota, e solo se non è troppo lunga', async () => {
	const user = content => ({ role: 'user', content });
	const a = editorStateNote(editor('a.py', 'a.py')), b = editorStateNote(editor('b.py', 'b.py'));
	const messages = [{ role: 'system', content: 's' }, user('uno\n\n' + a), { role: 'assistant', content: 'r' }, user('due\n\n' + b), user('tre')];
	assert.equal(indexOfEditorStateNoteToKeep(messages), 3);
	assert.equal(indexOfEditorStateNoteToKeep([user('uno'), user('due')]), -1);
	const huge = editorStateNote(editor('a.py', 'b.py')).replace('b.py', 'x'.repeat(7000)); // un blocco con la stessa forma incollato dall'utente
	assert.ok(huge.length > EDITOR_NOTE_MAX_KEPT);
	assert.equal(indexOfEditorStateNoteToKeep([user('uno\n\n' + a), user('due\n\n' + huge)]), -1);
	// la stessa misura vale nel taglio di recupero del processo principale
	const fit = await read('../electron-main/llmMessage/localContextFit.ts');
	assert.equal(Number(/const EDITOR_NOTE_MAX_KEPT = (\d+);/.exec(fit)[1]), EDITOR_NOTE_MAX_KEPT);
});

test('con moltissimi file aperti la nota ne elenca solo una parte e dice quanti ne mancano', () => {
	const files = Array.from({ length: 300 }, (_, i) => 'e:/progetto/cartella/file-con-un-nome-lungo-' + i + '.ts');
	const note = editorStateNote(editor(files[0], ...files));
	assert.ok(note.length < EDITOR_NOTE_MAX_KEPT);
	assert.match(note, /file-con-un-nome-lungo-0\.ts/);
	assert.match(note, /\(and \d+ more open files\)\n<\/editor_state>$/);
	// pochi file: elenco completo, senza aggiunte
	assert.doesNotMatch(editorStateNote(editor('a.py', 'a.py', 'b.py')), /more open files/);
	// un percorso fuori misura non entra nella nota, né come file attivo né nell'elenco
	const long = editorStateNote(editor('x'.repeat(7000), 'x'.repeat(7000)));
	assert.ok(long.length < 500);
	assert.doesNotMatch(long, /xxx/);
});
