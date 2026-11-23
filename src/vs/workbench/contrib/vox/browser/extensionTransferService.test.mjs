// Il trasferimento delle impostazioni dagli altri editor è stato tolto; la pulizia delle estensioni all'avvio resta.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const service = await read('./extensionTransferService.ts');

test('nessun pulsante né testo di trasferimento nelle Impostazioni, nel primo avvio e nelle traduzioni', async () => {
	const settings = await read('./react/src/vox-settings-tsx/Settings.tsx');
	const onboarding = await read('./react/src/vox-onboarding/VoxOnboarding.tsx');
	const services = await read('./react/src/util/services.tsx');
	const i18n = await read('../common/voxI18n.ts');
	for (const [name, source] of [['Settings.tsx', settings], ['VoxOnboarding.tsx', onboarding], ['services.tsx', services], ['extensionTransferService.ts', service]]) {
		assert.equal(/OneClickSwitch|transferExtensions|TransferEditorType|extensionTransferTypes|One-Click Switch|Transfer from/.test(source), false, name);
	}
	assert.equal(/IExtensionTransferService/.test(settings + onboarding + services), false);
	for (const key of ['Transfer from {0}', 'Transferring', 'Settings Transferred', 'One-Click Switch', 'Transfer your editor settings into Vox.', 'Settings and Themes', 'Transfer your settings from an existing editor?', 'Error copying {0}: {1}', 'One-click switch is not possible in this environment.']) {
		assert.equal(i18n.includes(`"${key}"`), false, key);
	}
	// le cartelle degli altri editor non compaiono più
	assert.equal(/'Cursor'|'Windsurf'|'Code', 'User'|\.vscode|\.cursor|\.windsurf/.test(service), false);
});

test('la pulizia delle estensioni all\'avvio resta: una volta sola, sulla cartella delle estensioni di Vox', async () => {
	const contrib = await read('./miscWokrbenchContrib.ts');
	assert.match(contrib, /if \(!alreadyDeleted\) \{\s+this\.storageService\.store\(deleteExtensionsStorageId, 'true', StorageScope\.APPLICATION, StorageTarget\.MACHINE\)\s+this\.extensionTransferService\.deleteBlacklistExtensions\(os\)\s+\}/);
	assert.match(service, /deleteBlacklistExtensions\(os: 'mac' \| 'windows' \| 'linux' \| null\): Promise<void>/);
	assert.match(service, /const extensionsURI = getExtensionsFolder\(os\)/);
	assert.match(service, /await fileService\.del\(child\.resource, \{ recursive: true, useTrash: true \}\)/);

	const start = service.indexOf('const getExtensionsFolder = (');
	assert.notEqual(start, -1, 'getExtensionsFolder non trovata nel sorgente');
	const body = service.slice(start);
	const folderOf = env => new Function('env', 'URI', stripTypeScriptTypes(body) + '; return getExtensionsFolder;')(
		env, { from: value => [value.scheme], joinPath: (base, ...parts) => [...base, ...parts] });
	assert.deepEqual(folderOf({ USERPROFILE: 'C:\\Users\\prova', APPDATA: 'C:\\Users\\prova\\AppData\\Roaming' })('windows'), ['file', 'C:\\Users\\prova', '.vox', 'extensions']);
	assert.deepEqual(folderOf({ HOME: '/home/prova' })('linux'), ['file', '/home/prova', '.vox', 'extensions']);
	assert.deepEqual(folderOf({ HOME: '/Users/prova' })('mac'), ['file', '/Users/prova', '.vox', 'extensions']);
	assert.throws(() => folderOf({})('windows'), /USERPROFILE/);
	assert.throws(() => folderOf({})('linux'), /HOME/);
	assert.throws(() => folderOf({ HOME: '/home/prova' })(null));
});
