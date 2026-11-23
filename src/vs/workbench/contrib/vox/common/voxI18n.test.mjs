import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCliAgents, loadI18n } from './voxI18n.fixture.mjs';

test('dizionario senza chiavi vuote e con gli stessi segnaposto', () => {
	const { it } = loadI18n('it');
	const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
	assert.ok(Object.keys(it).length > 0);
	for (const [english, italian] of Object.entries(it)) {
		assert.ok(english.trim(), 'Chiave vuota');
		assert.ok(italian.trim(), english);
		assert.deepEqual(placeholders(italian), placeholders(english), english);
	}
});

test('italiano, fallback e parametri letterali', () => {
	const { t } = loadI18n('it');
	assert.equal(t('Quick Edit'), 'Modifica rapida');
	assert.equal(t('CLI AI'), 'IA in CLI');
	assert.equal(t('Gather'), 'Raccolta');
	assert.equal(t('Agent'), 'Agente');
	assert.equal(t('File {0} of {1}', 2, 3), 'File 2 di 3');
	assert.equal(t('Unknown {0}', '$&'), 'Unknown $&');
	assert.equal(t('Unknown {0}'), 'Unknown {0}');
	assert.equal(t('toString'), 'toString');
});

test('altre lingue usano sempre il testo inglese', () => {
	for (const language of ['en', 'de', 'fr', '']) {
		const { t } = loadI18n(language);
		assert.equal(t('Agent'), 'Agent');
		assert.equal(t('File {0} of {1}', 2, 3), 'File 2 of 3');
	}
});

test('la traduzione della diagnostica CLI conserva l’oscuramento', async () => {
	const { describeCliFailure } = await loadCliAgents();
	const message = describeCliFailure('codex', 'Error: quota reached. Authorization: Bearer abc123SEGRETO token=ghp_ABCDEFGHIJKL1234');
	assert.match(message, /quota reached/);
	assert.match(message, /oscurato/);
	assert.doesNotMatch(message, /abc123SEGRETO|ghp_ABCDEFGHIJKL1234/);
});
