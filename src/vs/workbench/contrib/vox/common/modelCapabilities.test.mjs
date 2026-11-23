// Capacità dei modelli delle IA locali di Vox, senza avviare il workbench (Node >= 22.18).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = await readFile(new URL('./modelCapabilities.ts', import.meta.url), 'utf8');
const body = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')).replace(/^export /gm, '');
const load = () => new Function(body + '; return { getModelCapabilities, setVoxLocalContextWindows, getReservedOutputTokenSpace, isVoxLocalCompletionModel, defaultProviderSettings, defaultModelsOfProvider };')();

test('IA locali: la finestra di contesto viene dal manifesto e una scelta più grande non la supera', () => {
	const { getModelCapabilities, setVoxLocalContextWindows } = load();
	setVoxLocalContextWindows([{ name: 'qwen', contextWindow: 8192 }, { name: 'rotto', contextWindow: -1 }]);
	assert.equal(getModelCapabilities('voxLocal', 'qwen', undefined).contextWindow, 8192);
	// llama-server parte con -c 8192: un valore più grande nelle impostazioni del modello farebbe rifiutare i prompt lunghi
	assert.equal(getModelCapabilities('voxLocal', 'qwen', { voxLocal: { qwen: { contextWindow: 131072 } } }).contextWindow, 8192);
	// una scelta più piccola dell'utente resta valida
	assert.equal(getModelCapabilities('voxLocal', 'qwen', { voxLocal: { qwen: { contextWindow: 4096 } } }).contextWindow, 4096);
	// valore non valido nel manifesto: nessun tetto, vale la scelta dell'utente
	assert.equal(getModelCapabilities('voxLocal', 'rotto', { voxLocal: { rotto: { contextWindow: 20000 } } }).contextWindow, 20000);
});

test('i fornitori sono solo due: le IA locali di Vox e le IA in CLI', () => {
	const { defaultProviderSettings, defaultModelsOfProvider } = load();
	assert.deepEqual(Object.keys(defaultProviderSettings), ['voxLocal', 'cliAgent']);
	assert.deepEqual(Object.keys(defaultModelsOfProvider), ['voxLocal', 'cliAgent']);
	// nessuna chiave API né indirizzo di un servizio fra le impostazioni rimaste
	const settingNames = Object.values(defaultProviderSettings).flatMap(settings => Object.keys(settings));
	assert.deepEqual(settingNames.filter(name => /key|endpoint|header|region|project/i.test(name)), []);
});

test('IA locali: il completamento automatico (FIM) vale solo per i modelli che il manifesto indica come completamento', () => {
	const { getModelCapabilities, setVoxLocalContextWindows, isVoxLocalCompletionModel } = load();
	setVoxLocalContextWindows([
		{ name: 'qwen2.5-coder-7b', contextWindow: 8192, uso: 'completamento' },
		// stesso tipo di modello ma usato per la chat: il nome non basta ad attivare il completamento
		{ name: 'qwen2.5-coder', contextWindow: 2048, uso: 'chat' },
		{ name: 'senza-uso', contextWindow: 4096 },
	]);
	assert.equal(getModelCapabilities('voxLocal', 'qwen2.5-coder-7b', undefined).supportsFIM, true);
	assert.equal(getModelCapabilities('voxLocal', 'qwen2.5-coder-7b', undefined).contextWindow, 8192);
	assert.equal(getModelCapabilities('voxLocal', 'qwen2.5-coder', undefined).supportsFIM, false);
	assert.equal(getModelCapabilities('voxLocal', 'qwen2.5-coder', undefined).contextWindow, 2048);
	assert.equal(getModelCapabilities('voxLocal', 'senza-uso', undefined).supportsFIM, false);
	assert.equal(getModelCapabilities('voxLocal', 'mai-rilevato', undefined).supportsFIM, false);
	assert.equal(isVoxLocalCompletionModel('qwen2.5-coder-7b'), true);
	assert.equal(isVoxLocalCompletionModel('qwen2.5-coder'), false);
	// le IA in CLI non fanno mai il completamento automatico, nemmeno con lo stesso nome o con un override
	assert.equal(getModelCapabilities('cliAgent', 'qwen2.5-coder-7b', undefined).supportsFIM, false);
	assert.equal(getModelCapabilities('cliAgent', 'codex', { cliAgent: { codex: { supportsFIM: true } } }).supportsFIM, false);
	// un nuovo elenco sostituisce anche i modelli di completamento
	setVoxLocalContextWindows([{ name: 'qwen2.5-coder-7b', contextWindow: 8192, uso: 'chat' }]);
	assert.equal(getModelCapabilities('voxLocal', 'qwen2.5-coder-7b', undefined).supportsFIM, false);
	assert.equal(isVoxLocalCompletionModel('qwen2.5-coder-7b'), false);
});

test('IA locali: un override non cambia il FIM deciso dal manifesto e lo spazio per la risposta lascia metà contesto al prompt', () => {
	const { getModelCapabilities, setVoxLocalContextWindows, getReservedOutputTokenSpace } = load();
	setVoxLocalContextWindows([{ name: 'qwen3.5-9b', contextWindow: 8192 }, { name: 'gpt-oss-20b', contextWindow: 4096 }, { name: 'completa', contextWindow: 8192, uso: 'completamento' }]);
	// un modello da chat non diventa di completamento con un override (llama-server lo avvia per la chat)...
	assert.equal(getModelCapabilities('voxLocal', 'qwen3.5-9b', { voxLocal: { 'qwen3.5-9b': { supportsFIM: true } } }).supportsFIM, false);
	// ...e quello di completamento non lo perde
	assert.equal(getModelCapabilities('voxLocal', 'completa', { voxLocal: { completa: { supportsFIM: false } } }).supportsFIM, true);
	for (const [name, context] of [['qwen3.5-9b', 8192], ['gpt-oss-20b', 4096]]) {
		for (const isReasoningEnabled of [false, true]) {
			const reserved = getReservedOutputTokenSpace('voxLocal', name, { isReasoningEnabled, overridesOfModel: { voxLocal: { [name]: { reservedOutputTokenSpace: 100000 } } } });
			assert.ok(reserved == null || reserved <= context / 2, `${name} (ragionamento ${isReasoningEnabled}): riservati ${reserved} su ${context}`);
		}
	}
});

test('IA locali: un nuovo elenco sostituisce il precedente', () => {
	const { getModelCapabilities, setVoxLocalContextWindows } = load();
	setVoxLocalContextWindows([{ name: 'a', contextWindow: 1000 }]);
	setVoxLocalContextWindows([{ name: 'b', contextWindow: 2000 }]);
	assert.notEqual(getModelCapabilities('voxLocal', 'a', undefined).contextWindow, 1000);
	assert.equal(getModelCapabilities('voxLocal', 'b', undefined).contextWindow, 2000);
});

test('IA locali: il formato degli strumenti non viene dal nome del modello (solo OpenAI o XML per llama-server)', () => {
	const { getModelCapabilities } = load();
	// un GGUF con "claude" o "gemini" nel nome non diventa anthropic-style o gemini-style: llama-server non li capisce
	for (const name of ['claude-3.7-sonnet-distill-q4', 'claude-local', 'Claude-3-5-coder', 'gemini-2.5-flash-gguf', 'gemini-2-5-pro']) {
		assert.equal(getModelCapabilities('voxLocal', name, undefined).specialToolFormat, undefined, name);
	}
	// dove il formato OpenAI è già scelto resta (llama-server parte con --jinja)
	assert.equal(getModelCapabilities('voxLocal', 'gpt-oss-20b', undefined).specialToolFormat, 'openai-style');
	assert.equal(getModelCapabilities('voxLocal', 'qwen3.5-9b', undefined).specialToolFormat, 'openai-style');
	// un override con un formato che llama-server non capisce non vale; quello OpenAI sì
	assert.equal(getModelCapabilities('voxLocal', 'gpt-oss-20b', { voxLocal: { 'gpt-oss-20b': { specialToolFormat: 'anthropic-style' } } }).specialToolFormat, undefined);
	assert.equal(getModelCapabilities('voxLocal', 'mio-modello', { voxLocal: { 'mio-modello': { specialToolFormat: 'gemini-style' } } }).specialToolFormat, undefined);
	assert.equal(getModelCapabilities('voxLocal', 'mio-modello', { voxLocal: { 'mio-modello': { specialToolFormat: 'openai-style' } } }).specialToolFormat, 'openai-style');
});

test('IA locali: niente ruolo "developer" ereditato dal nome di un modello cloud (i template jinja locali conoscono "system")', () => {
	const { getModelCapabilities } = load();
	// un GGUF con il nome di un modello cloud non prende il ruolo developer: resta system, o nessuno se il nome è sconosciuto
	for (const name of ['gpt-4o-mini-gguf', 'o3-local', 'gpt-4.1-distill', 'gpt-oss-20b']) assert.notEqual(getModelCapabilities('voxLocal', name, undefined).supportsSystemMessage, 'developer-role', name);
	assert.equal(getModelCapabilities('voxLocal', 'gpt-oss-20b', undefined).supportsSystemMessage, 'system-role');
	// anche un override developer-role vale system per llama-server; gli altri valori restano
	assert.equal(getModelCapabilities('voxLocal', 'mio-modello', { voxLocal: { 'mio-modello': { supportsSystemMessage: 'developer-role' } } }).supportsSystemMessage, 'system-role');
	assert.equal(getModelCapabilities('voxLocal', 'mio-modello', { voxLocal: { 'mio-modello': { supportsSystemMessage: false } } }).supportsSystemMessage, false);
	// "separated" perderebbe il messaggio di sistema (il percorso compatibile OpenAI non lo invia): diventa system
	assert.equal(getModelCapabilities('voxLocal', 'mio-modello', { voxLocal: { 'mio-modello': { supportsSystemMessage: 'separated' } } }).supportsSystemMessage, 'system-role');
});
