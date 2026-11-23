// Scrittura dei file che Vox porta con sé (`localModelFiles.ts`), su una cartella temporanea vera.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const source = stripTypeScriptTypes((await fs.readFile(new URL('./localModelFiles.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/^export /gm, '');
const { createLocalModelFileIfMissing } = new Function('mkdir', 'open', 'unlink', 'dirname', source + '; return { createLocalModelFileIfMissing };')(fs.mkdir, fs.open, fs.unlink, dirname);

const tempFolder = async t => { const folder = await fs.mkdtemp(join(tmpdir(), 'vox-file-portati-')); t.after(() => fs.rm(folder, { recursive: true, force: true })); return folder };

test('crea il file e la cartella `avvia/` se mancano, con il testo esatto (fine riga compresi)', async t => {
	const folder = await tempFolder(t), file = join(folder, 'avvia', 'modello.jinja');
	await createLocalModelFileIfMissing(file, 'riga 1\r\nriga «2»\r\n');
	assert.equal(await fs.readFile(file, 'utf8'), 'riga 1\r\nriga «2»\r\n');
});

test('un file già presente, anche diverso, non si sovrascrive', async t => {
	const folder = await tempFolder(t), file = join(folder, 'avvia', 'modello.jinja');
	await fs.mkdir(dirname(file));
	await fs.writeFile(file, 'versione dell\'utente');
	await createLocalModelFileIfMissing(file, 'versione di Vox');
	assert.equal(await fs.readFile(file, 'utf8'), 'versione dell\'utente');
});

test('una cartella con quel nome resta una cartella; un percorso impossibile dà errore', async t => {
	const folder = await tempFolder(t), file = join(folder, 'avvia', 'modello.jinja');
	await fs.mkdir(file, { recursive: true });
	await createLocalModelFileIfMissing(file, 'x').catch(() => { });
	assert.equal((await fs.stat(file)).isDirectory(), true);
	// `avvia` è un file: dentro non si può creare niente
	const other = await tempFolder(t);
	await fs.writeFile(join(other, 'avvia'), 'file');
	await assert.rejects(createLocalModelFileIfMissing(join(other, 'avvia', 'modello.jinja'), 'x'));
	assert.equal(await fs.readFile(join(other, 'avvia'), 'utf8'), 'file');
});

test('scrittura fermata a metà (disco pieno): il file creato da Vox si toglie, così il tentativo dopo lo riscrive intero', async t => {
	const folder = await tempFolder(t), file = join(folder, 'avvia', 'modello.jinja'), removed = [];
	const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
	const ops = {
		mkdir: fs.mkdir,
		// il file si apre davvero e se ne scrive una parte, poi il disco è pieno
		open: async (path, flag) => { const handle = await fs.open(path, flag); return { writeFile: async content => { await handle.writeFile(content.slice(0, 3)); throw full }, close: () => handle.close() } },
		unlink: async path => { removed.push(path); await fs.unlink(path) },
	};
	await assert.rejects(createLocalModelFileIfMissing(file, 'testo intero', ops), error => error === full);
	assert.deepEqual(removed, [file]);
	await assert.rejects(fs.stat(file), { code: 'ENOENT' });
	await createLocalModelFileIfMissing(file, 'testo intero');
	assert.equal(await fs.readFile(file, 'utf8'), 'testo intero');
});

test('chiusura che fallisce dopo la scrittura: il file si toglie e l\'errore arriva', async t => {
	const folder = await tempFolder(t), file = join(folder, 'modello.jinja');
	const broken = Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
	let closes = 0;
	const ops = { mkdir: fs.mkdir, unlink: fs.unlink, open: async (path, flag) => { const handle = await fs.open(path, flag); return { writeFile: content => handle.writeFile(content), close: async () => { closes++; await handle.close().catch(() => { }); if (closes === 1) throw broken } } } };
	await assert.rejects(createLocalModelFileIfMissing(file, 'x', ops), error => error === broken);
	await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('apertura che fallisce (permessi): non si toglie niente, perché il file non l\'ha creato Vox', async t => {
	const folder = await tempFolder(t), file = join(folder, 'modello.jinja'), removed = [];
	const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
	const ops = { mkdir: fs.mkdir, open: async () => { throw denied }, unlink: async path => { removed.push(path) } };
	await assert.rejects(createLocalModelFileIfMissing(file, 'x', ops), error => error === denied);
	assert.deepEqual(removed, []);
});
