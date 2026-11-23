// Chiavi di salvataggio, file di regole e terminale dell'agente (storageKeys.ts), senza avviare il workbench.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./storageKeys.ts', import.meta.url), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const { VOX_SETTINGS_STORAGE_KEY, THREAD_STORAGE_KEY, DELETED_BLACKLIST_KEY, RULES_FILE_NAMES, AGENT_TERMINAL_NAMES, idOfAgentTerminalName } = m;

test('le chiavi di salvataggio sono quelle di Vox', () => {
	// Se questi valori cambiano, i dati salvati non vengono piu' trovati.
	assert.equal(VOX_SETTINGS_STORAGE_KEY, 'vox.settingsServiceStorageII');
	assert.equal(THREAD_STORAGE_KEY, 'vox.chatThreadStorageII');
	assert.equal(DELETED_BLACKLIST_KEY, 'vox-deleted-blacklist-2');
});

test('niente compatibilita\' con i nomi del progetto di origine', () => {
	for (const nome of ['LEGACY_STORAGE_KEYS', 'LEGACY_THREAD_FIELDS', 'migrateLegacyStorageKey', 'renameLegacyThreadFields']) {
		assert.equal(nome in m, false, nome);
	}
});

test('il file di regole e\' solo .voxrules', () => {
	assert.deepEqual(RULES_FILE_NAMES, ['.voxrules']);
});

test('terminale dell\'agente: nome con e senza numero', () => {
	assert.deepEqual(AGENT_TERMINAL_NAMES, ['Vox Agent']);
	assert.equal(idOfAgentTerminalName('Vox Agent'), '1');
	assert.equal(idOfAgentTerminalName('Vox Agent (2)'), '2');
	assert.equal(idOfAgentTerminalName('Vox Agent (12)'), '12');
});

test('terminale dell\'agente: i nomi che non lo sono danno null', () => {
	for (const nome of ['', 'bash', 'Vox', 'Vox Agent (0)', 'Vox Agent ()', 'Vox Agent (x)', 'Agent (2)']) {
		assert.equal(idOfAgentTerminalName(nome), null, nome);
	}
});
