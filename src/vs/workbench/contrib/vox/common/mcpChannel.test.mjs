// Server MCP: il canale del processo principale (electron-main/mcpChannel.ts) provato con un server MCP vero,
// avviato in stdio come farebbe Vox, e il servizio della finestra (common/mcpService.ts) nei punti che lo usano.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const channelSource = read('../electron-main/mcpChannel.ts');
const serviceSource = read('./mcpService.ts');
const settingsSource = read('./voxSettingsService.ts');

const sdk = path => pathToFileURL(fileURLToPath(new URL(`../../../../../../node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`, import.meta.url))).href;
const work = mkdtempSync(join(tmpdir(), 'vox-mcp-test-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

// Il canale senza le dipendenze di VS Code: t() in inglese e un Emitter minimo; l'SDK è quello vero.
const preamble = `
import { Client } from '${sdk('client/index.js')}';
import { StdioClientTransport } from '${sdk('client/stdio.js')}';
import { StreamableHTTPClientTransport } from '${sdk('client/streamableHttp.js')}';
import { SSEClientTransport } from '${sdk('client/sse.js')}';
const t = (s, ...p) => s.replace(/\\{(\\d+)\\}/g, (m, i) => p[+i] === undefined ? m : String(p[+i]));
class Emitter { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() { } }; }; } fire(e) { for (const f of this.l) f(e); } }
const removeMCPToolNamePrefix = name => name.split('_').slice(1).join('_');
`;
const channelModule = join(work, 'mcpChannel.mjs');
writeFileSync(channelModule, preamble + stripTypeScriptTypes(channelSource.replace(/^import [\s\S]*?;$/gm, '')));
const { MCPChannel, mcpServerEnv, mcpErrorText, mcpToolResultText } = await import(pathToFileURL(channelModule).href);

// Server MCP di prova: legge una variabile d'ambiente, restituisce due parti di testo, un risultato vuoto e un errore
const serverScript = join(work, 'server.mjs');
writeFileSync(serverScript, `
import { McpServer } from '${sdk('server/mcp.js')}';
import { StdioServerTransport } from '${sdk('server/stdio.js')}';
const server = new McpServer({ name: 'prova', version: '1.0.0' });
server.tool('ambiente', async () => ({ content: [{ type: 'text', text: String(process.env.VOX_MCP_PROVA) }] }));
server.tool('due_parti', async () => ({ content: [{ type: 'text', text: 'uno' }, { type: 'text', text: 'due' }] }));
server.tool('vuoto', async () => ({ content: [] }));
server.tool('pid', async () => ({ content: [{ type: 'text', text: String(process.pid) }] }));
server.tool('fallisce', async () => ({ isError: true, content: [{ type: 'text', text: 'motivo vero' }] }));
await server.connect(new StdioServerTransport());
`);

test('ambiente del server: le variabili di mcp.json vincono su quelle di Vox; quelle senza valore si tolgono', () => {
	assert.deepEqual(mcpServerEnv({ PATH: '/mio', KEY: 'k' }, { PATH: '/vox', HOME: '/h', VUOTA: undefined }), { PATH: '/mio', HOME: '/h', KEY: 'k' });
	assert.deepEqual(mcpServerEnv(undefined, { A: '1' }), { A: '1' });
	assert.doesNotMatch(channelSource, /\.\.\.server\.env,\s*\.\.\.process\.env/);
});

test('errori: il messaggio di un Error, non «{}»', () => {
	assert.equal(mcpErrorText(new Error('Request timed out')), 'Request timed out');
	assert.equal(mcpErrorText('testo'), 'testo');
	assert.equal(mcpErrorText({ a: 1 }), '{\n  "a": 1\n}');
	const circular = {}; circular.self = circular;
	assert.equal(mcpErrorText(circular), '[object Object]');
});

test('risultato: tutte le parti di testo; un risultato vuoto è testo vuoto; le altre parti si contano a parte', () => {
	assert.deepEqual(mcpToolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), { text: 'a\nb', unsupportedTypes: ['image'] });
	assert.deepEqual(mcpToolResultText([]), { text: '', unsupportedTypes: [] });
	assert.deepEqual(mcpToolResultText(undefined), { text: '', unsupportedTypes: [] });
});

test('indirizzi: i trasporti ricevono un URL (non il testo di mcp.json) e le intestazioni', () => {
	assert.match(channelSource, /const url = new URL\(server\.url\.toString\(\)\)/);
	assert.match(channelSource, /new StreamableHTTPClientTransport\(url, \{ requestInit: \{ headers \} \}\)/);
	assert.match(channelSource, /new SSEClientTransport\(url, \{ requestInit: \{ headers \} \}\)/);
});

test('canale con un server stdio vero: chiamate, ambiente, errori, spegnimento e riaccensione', { timeout: 60_000 }, async () => {
	const channel = new MCPChannel();
	const events = [];
	for (const name of ['onAdd_server', 'onUpdate_server', 'onDelete_server']) channel.listen(null, name)(e => events.push({ kind: name, ...e.response }));
	const mcpConfigFileJSON = { mcpServers: { prova: { command: process.execPath, args: [serverScript], env: { VOX_MCP_PROVA: 'da mcp.json' } } } };
	try {
		await channel.call(null, 'refreshMCPServers', { mcpConfigFileJSON, userStateOfName: { prova: { isOn: true } }, addedServerNames: ['prova'], removedServerNames: [], updatedServerNames: [] });
		const added = events.find(e => e.kind === 'onAdd_server');
		assert.equal(added.newServer.status, 'success', added.newServer.error);
		const toolName = short => added.newServer.tools.find(tool => tool.name.endsWith(`_${short}`)).name;
		const call = short => channel.call(null, 'callTool', { serverName: 'prova', toolName: toolName(short), params: {} });

		assert.deepEqual(await call('ambiente'), { event: 'text', text: 'da mcp.json', toolName: toolName('ambiente'), serverName: 'prova' });
		assert.equal((await call('due_parti')).text, 'uno\ndue');
		assert.deepEqual(await call('vuoto'), { event: 'text', text: '', toolName: toolName('vuoto'), serverName: 'prova' });
		const failed = await call('fallisce');
		assert.equal(failed.event, 'error');
		assert.match(failed.text, /motivo vero/);
		assert.doesNotMatch(failed.text, /: \{\}$/);

		// spento: niente client; riacceso: il client nuovo si usa davvero (prima: «Client for server prova not found»)
		await channel.call(null, 'toggleMCPServer', { serverName: 'prova', isOn: false });
		assert.equal(events.at(-1).newServer.status, 'offline');
		assert.equal((await call('ambiente')).event, 'error');
		await channel.call(null, 'toggleMCPServer', { serverName: 'prova', isOn: true });
		assert.equal(events.at(-1).newServer.status, 'success');
		const reTool = events.at(-1).newServer.tools.find(tool => tool.name.endsWith('_ambiente')).name;
		assert.equal((await channel.call(null, 'callTool', { serverName: 'prova', toolName: reTool, params: {} })).text, 'da mcp.json');

		// un server che non c'è (mcp.json cambiato nel frattempo) non fa cadere il canale
		await channel.call(null, 'toggleMCPServer', { serverName: 'sconosciuto', isOn: true });
	} finally {
		await channel.call(null, 'closeAllMCPServers');
	}
});

test('canale: un server spento in mcp.json all\'avvio non parte (nessun processo) finché non si riaccende', { timeout: 60_000 }, async () => {
	const channel = new MCPChannel();
	const events = [];
	channel.listen(null, 'onAdd_server')(e => events.push(e.response));
	channel.listen(null, 'onUpdate_server')(e => events.push(e.response));
	const marker = join(work, 'avviato');
	const script = join(work, 'segna.mjs');
	writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); await import(${JSON.stringify(pathToFileURL(serverScript).href)});`);
	const mcpConfigFileJSON = { mcpServers: { spento: { command: process.execPath, args: [script] } } };
	try {
		await channel.call(null, 'refreshMCPServers', { mcpConfigFileJSON, userStateOfName: { spento: { isOn: false } }, addedServerNames: ['spento'], removedServerNames: [], updatedServerNames: [] });
		assert.deepEqual(events[0].newServer, { status: 'offline', tools: [], command: `${process.execPath} ${script}` });
		assert.throws(() => readFileSync(marker), /ENOENT/);
		await channel.call(null, 'toggleMCPServer', { serverName: 'spento', isOn: true });
		assert.equal(events.at(-1).newServer.status, 'success', events.at(-1).newServer.error);
		assert.equal(readFileSync(marker, 'utf8'), 'x');
	} finally {
		await channel.call(null, 'closeAllMCPServers');
	}
});

test('canale: una finestra ricaricata chiede di nuovo i server «aggiunti»: quelli vecchi si chiudono', { timeout: 60_000 }, async () => {
	const channel = new MCPChannel();
	const added = [];
	channel.listen(null, 'onAdd_server')(e => added.push(e.response.newServer));
	const refresh = () => channel.call(null, 'refreshMCPServers', { mcpConfigFileJSON: { mcpServers: { prova: { command: process.execPath, args: [serverScript] } } }, userStateOfName: {}, addedServerNames: ['prova'], removedServerNames: [], updatedServerNames: [] });
	const pidOf = async server => Number((await channel.call(null, 'callTool', { serverName: 'prova', toolName: server.tools.find(tool => tool.name.endsWith('_pid')).name, params: {} })).text);
	const isRunning = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
	try {
		await refresh();
		const firstPid = await pidOf(added[0]);
		await refresh();
		const secondPid = await pidOf(added[1]);
		assert.notEqual(firstPid, secondPid);
		for (let i = 0; i < 50 && isRunning(firstPid); i++) await new Promise(r => setTimeout(r, 100));
		assert.equal(isRunning(firstPid), false, 'il server della finestra precedente è rimasto acceso');
		await channel.closeAll();
		for (let i = 0; i < 50 && isRunning(secondPid); i++) await new Promise(r => setTimeout(r, 100));
		assert.equal(isRunning(secondPid), false, 'closeAll non ha chiuso il server');
	} finally {
		await channel.closeAll();
	}
});

test('app.ts: alla chiusura di Vox il canale MCP chiude i server', () => {
	const app = readFileSync(new URL('../../../../code/electron-main/app.ts', import.meta.url), 'utf8');
	assert.match(app, /Event\.once\(this\.lifecycleMainService\.onWillShutdown\)\(e => e\.join\('vox\.mcpServers', mcpChannel\.closeAll\(\)\)\)/);
});

test('canale: un server che non si avvia mostra l\'errore vero', { timeout: 60_000 }, async () => {
	const channel = new MCPChannel();
	const events = [];
	channel.listen(null, 'onAdd_server')(e => events.push(e.response));
	await channel.call(null, 'refreshMCPServers', { mcpConfigFileJSON: { mcpServers: { rotto: { command: join(work, 'non-esiste') } } }, userStateOfName: {}, addedServerNames: ['rotto'], removedServerNames: [], updatedServerNames: [] });
	assert.equal(events[0].newServer.status, 'error');
	assert.match(events[0].newServer.error, /ENOENT|not found|spawn/i);
	await channel.call(null, 'closeAllMCPServers');
});

test('servizio: al modello solo gli strumenti dei server accesi; una risposta mancante del canale è un errore chiaro', () => {
	const getTools = serviceSource.slice(serviceSource.indexOf('public getMCPTools()'), serviceSource.indexOf('private _transformInputSchemaToParams'));
	assert.match(getTools, /if \(server\.status !== 'success'\) continue/);
	assert.match(serviceSource, /if \(!result\) throw new Error\(t\("Failed to call tool/);
	// le chiamate al canale non lasciano promesse rifiutate senza gestione
	assert.match(serviceSource, /this\.channel\.call\('refreshMCPServers', \{[\s\S]*?\}\)\.catch\(/);
	assert.match(serviceSource, /await this\.channel\.call\('toggleMCPServer', \{ serverName, isOn \}\)\.catch\(/);
});

test('impostazioni: removeMCPUserStateOfNames toglie davvero i server (prima venivano rimessi dall\'unione)', async () => {
	const start = settingsSource.indexOf('\tprivate _setMCPUserStateOfName = ');
	const end = settingsSource.indexOf('\tsetMCPServerState = ', start);
	assert.ok(start > 0 && end > start, 'forma dei metodi MCP cambiata: aggiornare il test');
	const body = stripTypeScriptTypes(`class S {\n${settingsSource.slice(start, end)}\n}`);
	const S = new Function('_validatedModelState', `${body}\nreturn S;`)(s => s);
	const svc = new S();
	svc.state = { mcpUserStateOfName: { a: { isOn: true }, b: { isOn: false } } };
	svc._storeState = async () => { };
	svc._onDidChangeState = { fire() { } };
	await svc.removeMCPUserStateOfNames(['b']);
	assert.deepEqual(svc.state.mcpUserStateOfName, { a: { isOn: true } });
	await svc.addMCPUserStateOfNames({ c: { isOn: true } });
	assert.deepEqual(svc.state.mcpUserStateOfName, { a: { isOn: true }, c: { isOn: true } });
});
