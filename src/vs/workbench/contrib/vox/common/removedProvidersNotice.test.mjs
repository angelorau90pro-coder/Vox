// Avviso mostrato una volta dopo la pulizia dei fornitori tolti: cosa contiene, come si salva e che cosa dice.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate, loadI18n } from './voxI18n.fixture.mjs';

const pure = async file => stripTypeScriptTypes((await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^import [^;]*;?[ \t]*\r?\n/gm, '')).replace(/^export /gm, '');
const body = await pure('./removedProviders.ts') + '\n' + await pure('./removedProvidersNotice.ts');
const exports = '; return { removedProvidersNoticeOf, parseRemovedProvidersNotice, textOfRemovedProvidersNotice, withCurrentReplacements };';
const { removedProvidersNoticeOf, parseRemovedProvidersNotice, textOfRemovedProvidersNotice, withCurrentReplacements } = evaluate(body + exports)();
const english = new Function('t', body + exports)(loadI18n('en').t);

const noCleanup = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] };
const names = { featureTitle: name => ({ Chat: 'Chat', 'Ctrl+K': 'Modifica rapida', Apply: 'Applica', Autocomplete: 'Completamento automatico', SCM: 'Messaggi di commit' })[name] ?? name, providerTitle: name => ({ voxLocal: 'IA locali', cliAgent: 'IA in CLI' })[name] ?? name };
const removed = (featureName, providerName, modelName) => ({ featureName, providerName, modelName });
const local = modelName => ({ providerName: 'voxLocal', modelName });

test('niente da dire: nessun avviso', () => {
	assert.equal(removedProvidersNoticeOf({ cleanup: noCleanup, selectionNow: () => assert.fail('nessun modello da cercare'), pending: null }), null);
});

test('l\'avviso dice le chiavi cancellate, senza ripetizioni, con il modello che ogni funzione ha adesso', () => {
	const now = { Chat: local('qwen3.5-9b'), Apply: null };
	const notice = removedProvidersNoticeOf({
		cleanup: { changed: true, providersWithRemovedSecrets: ['anthropic', 'gemini', 'anthropic'], removedSelections: [removed('Chat', 'anthropic', 'claude-opus-4-0'), removed('Apply', 'gemini', 'gemini-2.5-pro')] },
		selectionNow: featureName => now[featureName] ?? null,
		pending: null,
	});
	assert.deepEqual(notice, {
		providersWithRemovedSecrets: ['anthropic', 'gemini'],
		replacedSelections: [
			{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') },
			{ ...removed('Apply', 'gemini', 'gemini-2.5-pro'), replacement: null },
		],
	});
});

test('un avviso non ancora mostrato si unisce a quello nuovo: restano le sue voci, quelle della stessa funzione si aggiornano', () => {
	const pending = {
		providersWithRemovedSecrets: ['anthropic'],
		replacedSelections: [{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: null }, { ...removed('SCM', 'openAI', 'gpt-4o'), replacement: local('qwen3.5-9b') }],
	};
	// secondo avvio senza niente di nuovo: l'avviso in attesa resta uguale
	assert.deepEqual(removedProvidersNoticeOf({ cleanup: noCleanup, selectionNow: () => null, pending }), pending);
	// un'importazione successiva porta altre voci
	const merged = removedProvidersNoticeOf({
		cleanup: { changed: true, providersWithRemovedSecrets: ['mistral', 'anthropic'], removedSelections: [removed('Chat', 'mistral', 'codestral-latest')] },
		selectionNow: () => ({ providerName: 'cliAgent', modelName: 'codex' }), pending,
	});
	assert.deepEqual(merged.providersWithRemovedSecrets, ['anthropic', 'mistral']);
	assert.deepEqual(merged.replacedSelections, [
		{ ...removed('SCM', 'openAI', 'gpt-4o'), replacement: local('qwen3.5-9b') },
		{ ...removed('Chat', 'mistral', 'codestral-latest'), replacement: { providerName: 'cliAgent', modelName: 'codex' } },
	]);
});

test('prima di mostrarlo, ogni funzione compare con il modello che ha adesso; le altre voci non cambiano', () => {
	const notice = {
		providersWithRemovedSecrets: ['mistral'],
		replacedSelections: [
			{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') },
			{ ...removed('Autocomplete', 'mistral', 'codestral-latest'), replacement: null },
			{ ...removed('SCM', 'openAI', 'gpt-4o'), replacement: null },
			{ ...removed('Apply', 'openAI', 'gpt-4o'), replacement: { providerName: 'cliAgent', modelName: 'codex' } },
		],
	};
	const copy = structuredClone(notice);
	// la chat è passata a un altro modello (per esempio da una CLI al modello locale appena rilevato), Applica è rimasta senza
	const now = { Chat: local('gpt-oss-20b'), Autocomplete: { ...local('qwen2.5-coder-7b'), altro: 'non va nell\'avviso' }, SCM: null, Apply: null };
	assert.deepEqual(withCurrentReplacements(notice, featureName => now[featureName]), {
		providersWithRemovedSecrets: ['mistral'],
		replacedSelections: [
			{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('gpt-oss-20b') },
			{ ...removed('Autocomplete', 'mistral', 'codestral-latest'), replacement: local('qwen2.5-coder-7b') },
			{ ...removed('SCM', 'openAI', 'gpt-4o'), replacement: null },
			{ ...removed('Apply', 'openAI', 'gpt-4o'), replacement: null },
		],
	});
	assert.deepEqual(notice, copy, 'l\'avviso ricevuto non viene modificato');
});

test('l\'avviso salvato si rilegge uguale; un valore rovinato o di forma diversa vale come assente', () => {
	const notice = {
		providersWithRemovedSecrets: ['anthropic'],
		replacedSelections: [{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') }, { ...removed('Apply', 'gemini', ''), replacement: null }],
	};
	assert.deepEqual(parseRemovedProvidersNotice(JSON.stringify(notice)), notice);
	// un avviso salvato da una versione precedente, con un campo in piu', si legge ancora e il campo si ignora
	assert.deepEqual(parseRemovedProvidersNotice(JSON.stringify({ ...notice, legacyCopyCleaned: false })), notice);
	for (const broken of [undefined, '', '{rotto', 'null', '[]', '"testo"', '{}', '{"providersWithRemovedSecrets":"x","replacedSelections":[]}', '{"providersWithRemovedSecrets":[]}',
		// senza voci, anche dopo aver saltato quelle di forma sbagliata: niente avviso
		'{"providersWithRemovedSecrets":[],"replacedSelections":[],"legacyCopyCleaned":false}', '{"providersWithRemovedSecrets":[3],"replacedSelections":[null]}']) {
		assert.equal(parseRemovedProvidersNotice(broken), null, String(broken));
	}
	// le voci di forma sbagliata si saltano, le altre restano
	assert.deepEqual(parseRemovedProvidersNotice(JSON.stringify({
		providersWithRemovedSecrets: ['openAI', 3, null],
		replacedSelections: [null, { featureName: 'Chat' }, { ...removed('Chat', 'openAI', 'gpt-4o'), replacement: 'x' }, { ...removed('SCM', 'openAI', 'gpt-4o'), replacement: { providerName: 'voxLocal' } }, { ...removed('Apply', 'openAI', 'gpt-4o'), replacement: null }],
	})), { providersWithRemovedSecrets: ['openAI'], replacedSelections: [{ ...removed('Apply', 'openAI', 'gpt-4o'), replacement: null }] });
});

test('il testo in italiano: chiavi cancellate, funzioni con lo stesso cambio nella stessa frase e modello mancante', () => {
	const text = textOfRemovedProvidersNotice({
		providersWithRemovedSecrets: ['anthropic', 'xAI', 'sconosciuto'],
		replacedSelections: [
			{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') },
			{ ...removed('Autocomplete', 'mistral', 'codestral-latest'), replacement: null },
			{ ...removed('Ctrl+K', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') },
			{ ...removed('Apply', 'anthropic', 'claude-opus-4-0'), replacement: { providerName: 'cliAgent', modelName: 'codex' } },
			{ ...removed('SCM', 'lmStudio', ''), replacement: null },
		],
	}, names);
	assert.equal(text, [
		'Vox ora usa solo le IA locali e le IA in CLI installate su questo PC: gli altri fornitori sono stati tolti.',
		'Le chiavi API e le altre credenziali salvate di questi fornitori sono state cancellate dalle impostazioni: Anthropic, Grok (xAI), sconosciuto.',
		'Chat, Modifica rapida: claude-opus-4-0 (Anthropic) è stato sostituito con qwen3.5-9b (IA locali).',
		'Completamento automatico: codestral-latest (Mistral) non è più disponibile e non c\'è un modello con cui sostituirlo. Scegline uno nelle Impostazioni di Vox.',
		'Applica: claude-opus-4-0 (Anthropic) è stato sostituito con codex (IA in CLI).',
		'Messaggi di commit: LM Studio non è più disponibile e non c\'è un modello con cui sostituirlo. Scegline uno nelle Impostazioni di Vox.',
	].join(' '));
	// solo le chiavi: una frase in più e basta
	assert.equal(textOfRemovedProvidersNotice({ providersWithRemovedSecrets: ['openAI'], replacedSelections: [] }, names),
		'Vox ora usa solo le IA locali e le IA in CLI installate su questo PC: gli altri fornitori sono stati tolti. Le chiavi API e le altre credenziali salvate di questi fornitori sono state cancellate dalle impostazioni: OpenAI.');
});

test('il testo in inglese ha le stesse parti e nessun segnaposto rimasto', () => {
	const notice = { providersWithRemovedSecrets: ['anthropic'], replacedSelections: [{ ...removed('Chat', 'anthropic', 'claude-opus-4-0'), replacement: local('qwen3.5-9b') }, { ...removed('Apply', 'gemini', 'gemini-2.5-pro'), replacement: null }] };
	const text = english.textOfRemovedProvidersNotice(notice, { featureTitle: name => name, providerTitle: () => 'Local AI' });
	assert.equal(text, 'Vox now uses only the local AI and the CLI AI installed on this PC: the other providers were removed.'
		+ ' The saved API keys and other credentials of these providers were deleted from the settings: Anthropic.'
		+ ' Chat: claude-opus-4-0 (Anthropic) was replaced with qwen3.5-9b (Local AI).'
		+ ' Apply: gemini-2.5-pro (Gemini) is no longer available and there is no model to replace it. Choose one in Vox\'s Settings.');
	for (const output of [text, textOfRemovedProvidersNotice(notice, names)]) assert.equal(/\{\d\}/.test(output), false);
});
