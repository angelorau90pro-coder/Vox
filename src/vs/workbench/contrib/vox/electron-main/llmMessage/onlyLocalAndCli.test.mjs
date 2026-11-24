// Vox usa solo le IA locali e le IA in CLI: controlli sulla struttura del codice, perché un percorso verso un
// servizio di IA in cloud non torni per sbaglio (una libreria, un fornitore in più, un indirizzo non locale).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { evaluate } from '../../common/voxI18n.fixture.mjs';

const voxRoot = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, voxRoot), 'utf8');
// i sorgenti di Vox (non i test, non l'interfaccia compilata)
const sourceFiles = async (folder = '') => {
	const files = [];
	for (const entry of await readdir(new URL(folder || '.', voxRoot), { withFileTypes: true })) {
		const path = folder + entry.name;
		if (entry.isDirectory()) { if (!['node_modules', 'out', 'src2'].includes(entry.name)) files.push(...await sourceFiles(path + '/')); }
		else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
};
const REMOVED_PACKAGES = ['@anthropic-ai/sdk', '@google/genai', '@mistralai/mistralai', 'google-auth-library', 'groq-sdk', 'ollama'];
const packagesImportedBy = source => [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'".][^'"]*)['"]/g)].map(match => match[1]);

test('package.json non ha più le librerie dei servizi cloud; resta openai, per parlare con llama-server', async () => {
	const pkg = JSON.parse(await readFile(new URL('../../../../../package.json', voxRoot), 'utf8'));
	for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		for (const name of REMOVED_PACKAGES) assert.equal(Object.hasOwn(pkg[group] ?? {}, name), false, `${name} in ${group}`);
	}
	assert.ok(pkg.dependencies.openai);
});

test('nessun sorgente di Vox importa una libreria di un servizio cloud; i pacchetti esterni usati sono solo quelli attesi', async () => {
	const files = await sourceFiles();
	assert.ok(files.length > 80 && files.includes('electron-main/llmMessage/sendLLMMessage.impl.ts'), 'elenco dei sorgenti inatteso: aggiornare il test');
	const external = new Map();
	for (const file of files) {
		// l'interfaccia React ha le sue librerie (react, lucide, ...): qui contano i servizi e il processo principale
		if (file.startsWith('browser/react/')) {
			for (const name of packagesImportedBy(await read(file))) assert.equal(REMOVED_PACKAGES.some(removed => name === removed || name.startsWith(removed + '/')), false, `${file} importa ${name}`);
			continue;
		}
		for (const name of packagesImportedBy(await read(file))) {
			if (name.startsWith('node:') || ['util', 'child_process', 'fs', 'path', 'os', 'electron'].includes(name)) continue;
			external.set(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0], file);
		}
	}
	// openai: solo il client verso llama-server su questo PC; @modelcontextprotocol/sdk: i server MCP scelti dall'utente
	assert.deepEqual([...external.keys()].sort(), ['@modelcontextprotocol/sdk', 'openai']);
	assert.equal(external.get('openai'), 'electron-main/llmMessage/sendLLMMessage.impl.ts');
});

test('i fornitori sono due in ogni elenco: impostazioni, implementazioni, guardia e comandi del canale', async () => {
	const impl = await read('electron-main/llmMessage/sendLLMMessage.impl.ts');
	const map = impl.slice(impl.indexOf('export const sendLLMMessageToProviderImplementation = {'), impl.indexOf('} satisfies CallFnOfProvider'));
	assert.ok(map.length > 0, 'forma di sendLLMMessageToProviderImplementation cambiata: aggiornare il test');
	assert.deepEqual([...map.matchAll(/^\t(\w+): \{/gm)].map(match => match[1]), ['voxLocal', 'cliAgent']);
	// il completamento automatico esiste solo per le IA locali
	assert.match(map, /voxLocal: \{ sendChat: sendVoxLocalChat, sendFIM: sendVoxLocalFIM, list: voxLocalList \}/);
	assert.match(map, /cliAgent: \{ sendChat: sendCliChat, sendFIM: null, list: null \}/);

	const capabilities = await read('common/modelCapabilities.ts');
	const settings = capabilities.slice(capabilities.indexOf('export const defaultProviderSettings = {'), capabilities.indexOf('} as const', capabilities.indexOf('export const defaultProviderSettings = {')));
	assert.deepEqual([...settings.matchAll(/^\t([A-Za-z]+): \{/gm)].map(match => match[1]), ['voxLocal', 'cliAgent']);
	assert.equal(/apiKey|endpoint|headersJSON/.test(settings), false, 'nessuna chiave API né indirizzo fra le impostazioni dei fornitori');

	const guard = await read('electron-main/llmMessage/providerGuard.ts');
	assert.match(guard, /allowedProviderNames = \['voxLocal', 'cliAgent'\] as const/);

	const channel = await read('electron-main/sendLLMMessageChannel.ts');
	assert.deepEqual([...channel.matchAll(/command === '(\w+)'/g)].map(match => match[1]), ['cliAgentList', 'cliAgentModels', 'sendLLMMessage', 'abort', 'voxLocalList']);
	assert.deepEqual([...channel.matchAll(/event === '(\w+)'/g)].map(match => match[1]).sort(), ['onError_list_voxLocal', 'onError_sendLLMMessage', 'onFinalMessage_sendLLMMessage', 'onSuccess_list_voxLocal', 'onText_sendLLMMessage']);
});

test('sendLLMMessage controlla il fornitore prima di ogni altra cosa', async () => {
	const source = await read('electron-main/llmMessage/sendLLMMessage.ts');
	const guard = source.indexOf('if (!isAllowedProviderName(providerName)) {');
	assert.ok(guard > 0, 'guardia dei fornitori non trovata in sendLLMMessage.ts');
	for (const later of ['abortRef_.current =', 'sendLLMMessageToProviderImplementation[providerName]']) {
		const at = source.indexOf(later);
		assert.ok(at > guard, `"${later}" deve stare dopo la guardia dei fornitori`);
	}
	// la guardia esce subito, con un errore che non si riprova
	assert.match(source.slice(guard, guard + 400), /onError_\(\{.*noRetry: true \}\)\s*return\s*\}/);
});

test('il client dei modelli locali accetta solo indirizzi di questo PC', async () => {
	const impl = await read('electron-main/llmMessage/sendLLMMessage.impl.ts');
	const start = impl.indexOf('const newVoxLocalSDK'), end = impl.indexOf('const toOpenAICompatibleTool', start);
	assert.ok(start >= 0 && end > start, 'forma di sendLLMMessage.impl.ts cambiata: aggiornare i confini del test');
	const guard = await read('electron-main/llmMessage/providerGuard.ts');
	assert.equal(/^import /m.test(guard), false, 'providerGuard.ts deve restare senza importazioni: aggiornare il test');
	const created = [], fetched = [];
	class OpenAI { constructor(options) { created.push(options); } }
	const fakeFetch = async (...args) => { fetched.push(args); return 'risposta'; };
	const { isLoopbackURL, withoutRedirects, newVoxLocalSDK } = evaluate('OpenAI', 'fetch', stripTypeScriptTypes(guard + impl.slice(start, end)).replace(/^export /gm, '') + '; return { isLoopbackURL, withoutRedirects, newVoxLocalSDK };')(OpenAI, fakeFetch);
	for (const url of ['http://127.0.0.1:8192/v1', 'http://127.0.0.1:8193', 'http://localhost:8192/v1', 'http://[::1]:8194/v1']) assert.equal(isLoopbackURL(url), true, url);
	for (const url of [
		'https://api.openai.com/v1', 'https://api.anthropic.com', 'http://192.168.1.10:8192/v1', 'http://10.0.0.2:11434', 'http://0.0.0.0:8192/v1',
		'http://127.0.0.1.esempio.invalid/v1', 'http://localhost.esempio.invalid/v1', 'http://127.0.0.1@esempio.invalid/v1', 'http://esempio.invalid/?http://127.0.0.1',
		'https://127.0.0.1:8192/v1', 'file:///C:/modello', 'ftp://127.0.0.1/', '127.0.0.1:8192', 'localhost', '', 'non un indirizzo',
	]) assert.equal(isLoopbackURL(url), false, url);

	newVoxLocalSDK({ voxLocalBaseURL: 'http://127.0.0.1:8192/v1', includeInPayload: { timeout: 5 } });
	assert.equal(created.length, 1);
	assert.equal(created[0].baseURL, 'http://127.0.0.1:8192/v1');
	assert.equal(created[0].timeout, 5);
	// nessuna chiave vera: llama-server non ne chiede e quelle dei fornitori tolti non esistono più
	assert.equal(created[0].apiKey, 'vox-locale');
	// le richieste del client non seguono i reindirizzamenti: chi risponde sulla porta locale non le manda altrove
	assert.equal(await created[0].fetch('http://127.0.0.1:8192/v1/chat/completions', { method: 'POST', body: 'x', redirect: 'follow' }), 'risposta');
	assert.deepEqual(fetched, [['http://127.0.0.1:8192/v1/chat/completions', { method: 'POST', body: 'x', redirect: 'error' }]]);
	assert.equal(await withoutRedirects(fakeFetch)('http://127.0.0.1:8193/health'), 'risposta');
	assert.deepEqual(fetched[1], ['http://127.0.0.1:8193/health', { redirect: 'error' }]);
	// con il fetch vero: un reindirizzamento è un errore e la destinazione non riceve niente
	{
		const { createServer } = await import('node:http');
		const hits = [];
		const server = createServer((request, response) => {
			hits.push(request.url);
			if (request.url === '/v1/qui') { response.writeHead(307, { Location: '/altrove' }); response.end(); }
			else { response.writeHead(200); response.end('{}'); }
		});
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${server.address().port}/v1/qui`;
			await assert.rejects(withoutRedirects(globalThis.fetch)(url, { method: 'POST', body: 'codice riservato' }), TypeError);
			assert.deepEqual(hits, ['/v1/qui']);
			// senza la protezione la richiesta sarebbe proseguita: la prova distingue i due casi
			await globalThis.fetch(url, { method: 'POST', body: 'x' });
			assert.deepEqual(hits, ['/v1/qui', '/v1/qui', '/altrove']);
		} finally { await new Promise(resolve => server.close(resolve)); }
	}
	// anche il controllo delle porte dei modelli locali e il completamento automatico non li seguono
	assert.match(await read('electron-main/llmMessage/localModels.ts'), /rt\.fetch\(url, \{ signal: controller\.signal, redirect: 'error' \}\)/);
	assert.match(await read('electron-main/llmMessage/voxLocalFIM.ts'), /fetcher\(`\$\{origin\}\/infill`, \{[^}]*\}, body: JSON\.stringify\(body\), redirect: 'error', signal: timeout\.signal \}\)/);
	assert.throws(() => newVoxLocalSDK({ voxLocalBaseURL: 'https://api.openai.com/v1' }), /Vox parla solo con i modelli locali su questo PC: https:\/\/api\.openai\.com\/v1 è stato rifiutato\./);
	assert.throws(() => newVoxLocalSDK({ voxLocalBaseURL: 'http://192.168.1.10:8192/v1' }), /è stato rifiutato/);
	assert.throws(() => newVoxLocalSDK({}), /Il modello locale non è stato avviato|not been started/);
	assert.equal(created.length, 1);
	// l'unico client creato in tutto il file è questo
	assert.equal(impl.match(/new OpenAI\(/g).length, 1);
	assert.equal(/new (Anthropic|GoogleGenAI|Mistral|Groq|Ollama|AzureOpenAI)\b/.test(impl), false);
});

test('gli indirizzi dei modelli locali nascono solo da 127.0.0.1 e dalla porta del manifesto', async () => {
	const local = await read('electron-main/llmMessage/localModels.ts');
	const urls = [...local.matchAll(/https?:\/\/[^\s`'"]+/g)].map(match => match[0]);
	assert.ok(urls.length >= 2, 'indirizzi dei modelli locali non trovati: aggiornare il test');
	for (const url of urls) assert.match(url, /^http:\/\/127\.0\.0\.1:\$\{model\.porta\}\//, url);
	assert.match(local, /'--host', '127\.0\.0\.1'/);
	// il completamento usa lo stesso server, con un altro percorso
	const fim = await read('electron-main/llmMessage/voxLocalFIM.ts');
	assert.equal(/https?:\/\//.test(fim), false, 'voxLocalFIM.ts non deve contenere indirizzi: usa quello del modello avviato');
	assert.match(fim, /lease\.baseURL\.replace\(\/\\\/v1\\\/\?\$\/, ''\)/);
});

test('nessun indirizzo di un servizio di IA in cloud nei sorgenti di Vox (i collegamenti alla documentazione nei commenti non contano)', async () => {
	const hosts = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.groq\.com|api\.mistral\.ai|openrouter\.ai|api\.x\.ai|api\.deepseek\.com|amazonaws\.com|openai\.azure\.com|codestral\.mistral\.ai|:11434|:1234\/v1|:4000\/v1|:8000\/v1/;
	for (const file of await sourceFiles()) {
		const lines = (await read(file)).split('\n');
		lines.forEach((line, index) => {
			const match = hosts.exec(line);
			if (!match) return;
			// l'unica eccezione: l'elenco dei fornitori tolti e le sue prove non contengono indirizzi; qui non ne serve nessuna
			assert.fail(`${file}:${index + 1} contiene ${match[0]}`);
		});
	}
});

test('scarico e ricerca dei modelli sono gli unici accessi a Internet: solo Hugging Face, in una cartella loro, senza dati dell\'utente', async () => {
	const files = (await sourceFiles()).filter(file => !file.startsWith('browser/react/'));
	// Chi usa `fetch`: le richieste alle IA locali (su questo PC, provate qui sopra), lo scarico e la ricerca dei modelli. Nessun altro.
	// («fetch failed» in `sendLLMMessage.ts` è il testo di un errore, non una richiesta.)
	const users = [];
	for (const file of files) if (/\bfetch\b/.test((await read(file)).replace(/\/\/.*$/gm, '').replace(/fetch failed/g, ''))) users.push(file);
	assert.deepEqual(users.sort(), [
		'electron-main/llmMessage/localModels.ts', 'electron-main/llmMessage/sendLLMMessage.impl.ts',
		'electron-main/llmMessage/voxLocalFIM.ts', 'electron-main/localModelLibrary/localModelDownload.ts',
		'electron-main/localModelLibrary/localModelSearch.ts',
	]);

	// La ricerca (voluta dall'utente il 18/11/2026): non importa niente oltre ai contratti e alle traduzioni, quindi non
	// può leggere impostazioni, conversazioni o file. Una sola `fetch`, sempre GET e senza corpo, verso un indirizzo che
	// comincia con `https://huggingface.co/api/models`; i reindirizzamenti non si seguono; niente credenziali.
	const search = await read('electron-main/localModelLibrary/localModelSearch.ts');
	assert.deepEqual(packagesImportedBy(search), []);
	assert.deepEqual([...search.matchAll(/from '(\.[^']+)'/g)].map(match => match[1]), ['../../common/localModelLibraryTypes.js', '../../common/localModelLibraryTypes.js', '../../common/voxI18n.js']);
	assert.equal([...search.matchAll(/\bfetch\(/g)].length, 1);
	assert.match(search, /rt\.fetch\(url, \{ method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: \{ 'User-Agent': 'Vox', Accept: 'application\/json' \}, signal: controller\.signal \}\)/);
	assert.match(search, /const API = `https:\/\/\$\{LOCAL_MODEL_DOWNLOAD_ORIGIN_HOST\}\/api\/models`;/);
	assert.deepEqual([...search.matchAll(/getJSON\(([^,]+),/g)].map(match => match[1]), ['url: string', '`${API}?${params}`', '`${API}/${repo}?blobs=true`']);
	assert.equal(/\bbody:|method: '(?!GET')|Authorization|Cookie|node:fs|readFile|process\.env/i.test(search), false);
	// il nome del repository entra nell'indirizzo solo dopo il controllo della sua forma
	assert.match(search, /if \(typeof repo !== 'string' \|\| !LOCAL_MODEL_REPO_PATTERN\.test\(repo\)\) throw/);
	for (const file of files) assert.equal(/https?\.request\(|net\.request\(|XMLHttpRequest|new WebSocket\(/.test(await read(file)), false, file);

	// gli indirizzi di Hugging Face stanno solo nei contratti, nell'elenco consigliato e nella libreria
	for (const file of await sourceFiles()) {
		if (!/huggingface\.co|\bhf\.co\b/.test(await read(file))) continue;
		assert.ok(['common/localModelLibraryTypes.ts', 'common/localModelCatalog.ts', 'common/voxI18n.ts'].includes(file) || file.startsWith('electron-main/localModelLibrary/')
			|| file.startsWith('browser/react/src/vox-settings-tsx/LocalModelLibrary') || file === 'browser/react/src/vox-settings-tsx/localModelLibraryFormat.ts', `${file} nomina Hugging Face`);
	}

	// Lo scarico non conosce il codice delle richieste alle IA (né impostazioni, conversazioni o file dell'utente)…
	const download = await read('electron-main/localModelLibrary/localModelDownload.ts');
	assert.deepEqual(packagesImportedBy(download), ['node:fs/promises', 'node:path', 'node:crypto']);
	assert.deepEqual([...download.matchAll(/from '(\.[^']+)'/g)].map(match => match[1]), ['../../common/localModelLibraryTypes.js', '../../common/voxI18n.js']);
	// …e le richieste alle IA non conoscono la libreria
	for (const file of files.filter(name => name.startsWith('electron-main/llmMessage/') || name === 'electron-main/sendLLMMessageChannel.ts')) {
		assert.equal(/localModelLibrary|localModelCatalog/.test(await read(file)), false, file);
	}

	// Una sola richiesta, sempre GET e senza corpo; intestazioni: solo `User-Agent`, `Range` e `If-Range`.
	// I reindirizzamenti si seguono a mano e solo verso gli host ammessi.
	const requests = [...download.matchAll(/\bfetch\(/g)];
	assert.equal(requests.length, 1);
	assert.match(download, /rt\.fetch\(url, \{ method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',\s+headers: \{ 'User-Agent': 'Vox', \.\.\.\(range \? \{ Range: range, \.\.\.\(ifRange \? \{ 'If-Range': ifRange \} : \{\}\) \} : \{\}\) \}, signal: controller\.signal \}\)/);
	// il segnale della richiesta è uno solo per richiesta: segue l'annullo del chiamante e scade senza risposta
	assert.match(download, /if \(p\.signal\.aborted\) controller\.abort\(\); else p\.signal\.addEventListener\('abort', forward, \{ once: true \}\);/);
	assert.equal(/\bbody:|method: '(?!GET')|Authorization|Cookie/i.test(download), false);
	assert.match(download, /if \(!isAllowedLocalModelDownloadURL\(p\.url, true\)\) throw/);
	assert.match(download, /if \(!isAllowedLocalModelDownloadURL\(url, false\)\) throw/);

	// regole degli indirizzi: partenza solo da huggingface.co in HTTPS; reindirizzamenti solo ai domini di Hugging Face
	const types = await import('data:text/javascript,' + encodeURIComponent(stripTypeScriptTypes(await read('common/localModelLibraryTypes.ts'))));
	const allowed = types.isAllowedLocalModelDownloadURL;
	assert.equal(allowed('https://huggingface.co/u/r/resolve/main/m.gguf', true), true);
	assert.equal(allowed('https://us.aws.cdn.hf.co/x', false), true);
	for (const [url, origin] of [
		['https://us.aws.cdn.hf.co/x', true], ['http://huggingface.co/x', true], ['https://huggingface.co.esempio.it/x', false], ['https://esempiohf.co/x', false],
		['https://utente:segreto@huggingface.co/x', true], ['https://huggingface.co:8443/x', false], ['https://127.0.0.1/x', false], ['file:///c:/x', false], ['', false],
	]) assert.equal(allowed(url, origin), false, url);

	// il canale della libreria è separato da quello delle richieste alle IA
	assert.equal(types.LOCAL_MODEL_LIBRARY_CHANNEL, 'vox-channel-local-model-library');
	const app = await readFile(new URL('../../../code/electron-main/app.ts', voxRoot), 'utf8');
	assert.match(app, /registerChannel\(LOCAL_MODEL_LIBRARY_CHANNEL, localModelLibraryChannel\)/);
});
