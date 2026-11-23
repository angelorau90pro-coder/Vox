// Eseguire con Node >= 22.18: node --test src/vs/workbench/contrib/vox/electron-main/llmMessage/cliAgents.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { loadCliAgents } from '../../common/voxI18n.fixture.mjs';
const { CLI_AGENTS, runCliAgent, resolveCliCommand, isCliAgentName } = await loadCliAgents();

const folder = dirname(fileURLToPath(import.meta.url));
const fixture = fileURLToPath(new URL('./cliAgents.fixture.mjs', import.meta.url));
const originalArgs = CLI_AGENTS.copilot.buildArgs;
const fakeArgs = mode => (prompt) => [fixture, mode, prompt];
const runFake = options => runCliAgent({ agent: 'copilot', prompt: 'ciao', cwd: folder, command: process.execPath, onText: () => {}, ...options });

test('spawn, streaming UTF-8 e prompt letterale senza shell', async () => {
	CLI_AGENTS.copilot.buildArgs = fakeArgs('echo');
	const updates = [];
	const prompt = 'Ciao à\n" & | %PATH% !VAR! $(echo rischio) `comando`';
	try {
		const answer = await runFake({ prompt, onText: text => updates.push(text) });
		assert.match(answer, /inizio/);
		assert.ok(answer.endsWith(prompt));
		assert.ok(updates.some(text => text === 'inizio'), 'Streaming prima della risposta completa');
	} finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});

for (const kind of ['timeout', 'abort']) {
	test(`${kind}: interrompe la CLI`, async () => {
		CLI_AGENTS.copilot.buildArgs = fakeArgs('hold');
		const controller = new AbortController();
		let pids;
		try {
			const request = runFake({ signal: controller.signal, timeoutMs: kind === 'timeout' ? 1000 : 10000, onText: text => {
				pids = JSON.parse(text);
				if (kind === 'abort') controller.abort();
			} });
			await assert.rejects(request, kind === 'timeout' ? /Timeout/ : /annullata/);
			assert.ok(pids, 'La CLI finta deve essere partita');
			for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
		} finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
	});
}

test('terminazione dell’albero con taskkill', { skip: process.platform !== 'win32' }, async t => {
	// La sandbox può negare taskkill persino sui processi appena creati dal test.
	const probe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
	const allowed = await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(probe.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => resolve(!error)));
	if (!allowed) { probe.kill(); t.skip('taskkill non autorizzato nell’ambiente: albero non verificabile'); return; }
	CLI_AGENTS.copilot.buildArgs = fakeArgs('tree');
	let pids;
	try {
		await assert.rejects(runFake({ timeoutMs: 1000, onText: text => { pids = JSON.parse(text); } }), /Timeout/);
		assert.ok(pids);
		for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
	} finally {
		CLI_AGENTS.copilot.buildArgs = originalArgs;
		// Pulizia solo dei PID della CLI finta, anche in caso di regressione del runner.
		for (const pid of pids || []) { try { process.kill(pid); } catch {} }
	}
});

test('abort preventivo, comando mancante ed errore senza stderr sensibile', async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runFake({ signal: controller.signal }), /annullata/);
	await assert.rejects(runFake({ command: join(folder, 'inesistente.exe') }), /non trovata/);
	CLI_AGENTS.copilot.buildArgs = fakeArgs('error');
	try {
		await assert.rejects(runFake({}), error => !error.message.includes('DATO_RISERVATO') && /terminata con errore/.test(error.message));
	} finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});

test('parser JSON ignorano righe non valide e restituiscono solo l’ultimo risultato', () => {
	const junk = 'null\n[]\n42\nlog non JSON\n';
	assert.equal(CLI_AGENTS.opencode.parseOutput(junk + '{"type":"text","part":{"text":"prima"}}\n{"type":"step_start"}\n{"type":"text","part":{"text":"finale"}}'), 'finale');
	assert.equal(CLI_AGENTS.kimi.parseOutput(junk + '{"role":"assistant","content":"prima"}\n{"role":"tool","content":"nascosto"}\n{"role":"assistant","content":"finale"}'), 'finale');
	assert.equal(CLI_AGENTS.agy.parseOutput(junk + '{"step_update":{"step_type":"agent_response","text_delta":"prima"}}\n{"step_update":{"step_type":"tool"}}\n{"step_update":{"step_type":"agent_response","text_delta":"finale"}}'), 'finale');
	assert.equal(isCliAgentName('__proto__'), false);
});

test('permessi separati e nessuna approvazione indiscriminata', () => {
	for (const agent of Object.values(CLI_AGENTS)) {
		for (const write of [false, true]) {
			const args = agent.buildArgs('prompt', { cwd: folder, write, profile: 'profilo' });
			assert.ok(!args.some(arg => /^--(?:yolo|dangerously-|allow-all)/.test(arg)));
		}
	}
	assert.ok(CLI_AGENTS.codex.buildArgs('p', { cwd: folder }).includes('read-only'));
	assert.ok(CLI_AGENTS.codex.buildArgs('p', { cwd: folder, write: true }).includes('workspace-write'));
});

test('senza workspace non concede scrittura nella home', async () => {
	let received;
	CLI_AGENTS.copilot.buildArgs = (prompt, options) => { received = options; return fakeArgs('echo')(prompt); };
	try { await runFake({ cwd: undefined, write: true }); assert.equal(received.write, false); }
	finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});

test('Windows: risolve shim npm e rifiuta batch generici', { skip: process.platform !== 'win32' }, async () => {
	const temp = await mkdtemp(join(folder, 'cli-test-'));
	try {
		const entry = join(temp, 'entry.js');
		const shim = join(temp, 'fake.cmd');
		await writeFile(entry, '', 'utf8');
		await writeFile(shim, '@ECHO off\r\n"node.exe" "%dp0%\\entry.js" %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(shim), { command: process.execPath, args: [entry] });
		for (const prefix of ['%dp0%', '%~dp0']) {
			for (const quote of ['"', "'"]) {
				await writeFile(shim, `@ECHO off\r\n"node.exe" ${quote}${prefix}\\entry.js${quote} %*\r\n`, 'utf8');
				assert.deepEqual(await resolveCliCommand(shim), { command: process.execPath, args: [entry] });
			}
		}
		await writeFile(shim, '@ECHO off\r\necho %*\r\n', 'utf8');
		await assert.rejects(resolveCliCommand(shim), /non supportato/);
	} finally { await rm(temp, { recursive: true, force: true }); }
});

test('l\'errore mostra la causa diagnostica ma oscura i segreti', async () => {
	CLI_AGENTS.copilot.buildArgs = fakeArgs('quota');
	try {
		await assert.rejects(runFake({}), error => /quota reached/.test(error.message) && !/abc123SEGRETO|ghp_ABCDEFGHIJKL1234/.test(error.message) && /oscurato/.test(error.message));
	} finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});
