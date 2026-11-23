// File che Vox porta con sé per l'elenco consigliato (`localModelTemplates.ts`): testo identico al file provato e
// nessuna voce dell'elenco che chieda un file di `ia-locali` che Vox non sa creare.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const load = async (file, names) => new Function(stripTypeScriptTypes((await read(file)).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '') + `; return { ${names.join(', ')} };`)();
const { localModelBundledFiles } = await load('./localModelTemplates.ts', ['localModelBundledFiles']);
const { localModelCatalog } = await load('../../common/localModelCatalog.ts', ['localModelCatalog']);

test('modello di conversazione di qwen3.5-9b: identico, byte per byte, al file provato con Vox', () => {
	const text = localModelBundledFiles['avvia/qwen3.6-codex.jinja'];
	assert.equal(typeof text, 'string');
	assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), '5e738caa08ca95bcfd10171edb75e1861b622ada668f263cc4d3e28ef264319f');
});

test('ogni file di `ia-locali` chiesto dalle opzioni dell\'elenco consigliato è fra quelli che Vox porta con sé', () => {
	const asked = [];
	for (const entry of localModelCatalog) {
		for (const option of entry.opzioni) {
			if (!option.includes('{cartella}')) continue;
			assert.ok(option.startsWith('{cartella}/'), `${entry.id}: ${option}`);
			asked.push(option.slice('{cartella}/'.length));
		}
	}
	assert.ok(asked.length > 0);
	for (const file of asked) assert.ok(Object.prototype.hasOwnProperty.call(localModelBundledFiles, file), file);
	// solo percorsi relativi dentro la cartella, con `/`
	for (const file of Object.keys(localModelBundledFiles)) assert.match(file, /^(?!.*\.\.)[A-Za-z0-9._-]+(\/[A-Za-z0-9._ -]+)*$/);
});

test('il servizio principale passa al nucleo i file che Vox porta con sé e la creazione esclusiva', async () => {
	// senza questo collegamento il nucleo riceverebbe un elenco vuoto e il difetto di qwen3.5-9b tornerebbe identico,
	// con tutti gli altri test verdi
	// un clone con `core.autocrlf=true` ha il file con CRLF: `$` delle espressioni sotto non combacerebbe davanti a `\r`
	const service = (await read('./localModelLibraryMainService.ts')).replace(/\r\n/g, '\n');
	assert.match(service, /^import \{ createLocalModelFileIfMissing \} from '\.\/localModelFiles\.js';$/m);
	assert.match(service, /^import \{ localModelBundledFiles \} from '\.\/localModelTemplates\.js';$/m);
	assert.match(service, /^\t+bundledFiles: localModelBundledFiles,$/m);
	assert.match(service, /^\t+createFileIfMissing: \(file, content\) => createLocalModelFileIfMissing\(file, content\),$/m);
});
