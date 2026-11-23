import { evaluate } from '../../common/voxI18n.fixture.mjs';
// Verifica il trasporto senza avviare processi o usare account esterni.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { test } from 'node:test';

const source = stripTypeScriptTypes((await readFile(new URL(process.argv[2] || './cliAgents.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const cwd = path.dirname(new URL(import.meta.url).pathname);
const prompt = '\u00e0\u{1f600} "\\ & | %PATH% !VAR! '.repeat(5000);
function harness({ spawnError = false, exitCode = 0, chunks } = {}) {
	const files = new Map(), removed = [], calls = [];
	const spawn = (command, args, options) => {
		if (spawnError) throw new Error('avvio fallito');
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
		child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
		child.stdin = new EventEmitter(); child.stdin.end = data => { child.input = data; };
		calls.push({ command, args, options, child, files: new Map(files) });
		queueMicrotask(() => {
			for (const chunk of chunks ?? [args.includes('--json') ? '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}' : options.env.OPENCODE_CONFIG_CONTENT ? '{"type":"text","part":{"text":"ok"}}' : 'ok']) child.stdout.emit('data', chunk);
			child.emit('close', exitCode);
		});
		return child;
	};
	const names = ['spawn', 'execFile', 'access', 'readFile', 'mkdtemp', 'writeFile', 'rm', 'homedir', 'tmpdir', 'dirname', 'isAbsolute', 'join', 'resolve'];
	const values = [spawn, assert.fail, async () => {}, assert.fail, async () => path.join(cwd, 'temp-finto'), async (name, value) => { files.set(name, value); }, async name => { removed.push(name); files.clear(); }, () => cwd, () => cwd, path.dirname, path.isAbsolute, path.join, path.resolve];
	return { ...evaluate(...names, source + '; return { runCliAgent, CLI_AGENTS };')(...values), calls, files, removed };
}
const run = (h, agent, options = {}) => h.runCliAgent({ agent, prompt, cwd, command: process.execPath, onText() {}, ...options });

test('prompt lunghi integri via stdin per Codex e Claude', async () => {
	for (const agent of ['codex', 'claude']) {
		const h = harness();
		assert.equal(await run(h, agent), 'ok');
		const { args, child, options } = h.calls[0];
		assert.ok(child.input.endsWith(prompt), agent);
		assert.equal(options.stdio[0], 'pipe');
		assert.ok(args.join(' ').length < 30000);
		if (agent === 'codex') assert.equal(args.at(-1), '-');
		if (agent === 'claude') assert.equal(args[0], '-p');
	}
});

test('OpenCode allega il prompt e pulisce il file dopo successo o errore', async () => {
	for (const exitCode of [0, 1]) {
		const h = harness({ exitCode });
		if (exitCode) await assert.rejects(run(h, 'opencode'), /terminata con errore/);
		else assert.equal(await run(h, 'opencode'), 'ok');
		const call = h.calls[0];
		const file = call.args[call.args.indexOf('-f') + 1];
		assert.ok(call.files.get(file).endsWith(prompt));
		assert.equal(call.options.stdio[0], 'ignore');
		assert.equal(h.files.size, 0);
		assert.equal(h.removed.length, 1);
	}
	const failed = harness({ spawnError: true });
	await assert.rejects(run(failed, 'opencode'), /avvio fallito/);
	assert.equal(failed.files.size, 0);
	assert.equal(failed.removed.length, 1);
});

test('le CLI senza trasporto sicuro rifiutano prompt eccessivi prima dello spawn', async () => {
	for (const agent of ['agy', 'devin', 'kimi']) {
		const h = harness();
		await assert.rejects(run(h, agent), /troppo lunghi.*limite Windows/);
		assert.equal(h.calls.length, 0);
		assert.equal(h.files.size, 0);
	}
});

test('OpenCode consente write solo in agente con workspace e preserva Devin', async () => {
	for (const write of [false, true]) {
		const h = harness();
		await run(h, 'opencode', { prompt: 'breve', write });
		const permission = JSON.parse(h.calls[0].options.env.OPENCODE_CONFIG_CONTENT).agent.vox.permission;
		assert.equal(permission.write, write ? 'allow' : undefined);
		assert.equal(permission.edit, write ? 'allow' : undefined);
		assert.equal(permission['*'], 'deny');
	}
	const h = harness();
	await run(h, 'opencode', { prompt: 'breve', write: true, cwd: undefined });
	assert.equal(JSON.parse(h.calls[0].options.env.OPENCODE_CONFIG_CONTENT).agent.vox.permission.write, undefined);
	assert.deepEqual(h.CLI_AGENTS.devin.buildArgs('prompt', { cwd, profile: 'profilo' }), ['-p', '--permission-mode', 'auto', '--config', 'profilo', '--respect-workspace-trust', 'false', '--', 'prompt']);
});

test('Devin scrive solo con il consenso e senza terminale; Kimi resta in sola lettura', async () => {
	for (const write of [false, true]) {
		const devin = harness();
		await run(devin, 'devin', { prompt: 'breve', write });
		const { args, files } = devin.calls[0];
		assert.equal(args[args.indexOf('--permission-mode') + 1], write ? 'accept-edits' : 'auto');
		const deny = JSON.parse(files.get(args[args.indexOf('--config') + 1])).permissions.deny;
		assert.ok(deny.includes('exec'));
		assert.equal(deny.includes('write'), !write);
		assert.ok(args.at(-1).includes(write ? 'Modifica file solo nella cartella di lavoro.' : 'Leggi soltanto: non modificare file.'));

		const kimi = harness({ chunks: ['{"role":"assistant","content":"ok"}'] });
		await run(kimi, 'kimi', { prompt: 'breve', write });
		const call = kimi.calls[0];
		const profile = call.files.get(call.args[call.args.indexOf('--agent-file') + 1]);
		assert.match(profile, /^tools: Read, Glob, Grep$/m);
		assert.ok(call.args[call.args.indexOf('-p') + 1].includes('Leggi soltanto: non modificare file.'));
	}
	// senza cartella di lavoro anche Devin resta in sola lettura
	const noFolder = harness();
	await run(noFolder, 'devin', { prompt: 'breve', write: true, cwd: undefined });
	assert.equal(noFolder.calls[0].args[noFolder.calls[0].args.indexOf('--permission-mode') + 1], 'auto');
});


test('flag modello specifici e sandbox Codex Windows', () => {
	const h = harness();
	for (const [name, flag] of Object.entries({ codex: '-m', kimi: '-m', opencode: '-m', agy: '--model', devin: '--model', copilot: '--model', claude: '--model' })) {
		const args = h.CLI_AGENTS[name].buildArgs('prompt', { cwd, model: 'modello', profile: 'profilo' });
		assert.equal(args[args.indexOf(flag) + 1], 'modello', name);
		const defaultArgs = h.CLI_AGENTS[name].buildArgs('prompt', { cwd, profile: 'profilo' });
		assert.ok(!defaultArgs.includes(flag) && !defaultArgs.includes('default'), name + ': Predefinito non passa un modello');
		if (name === 'devin') assert.deepEqual(h.CLI_AGENTS.devin.buildArgs('prompt', { cwd, profile: 'profilo', model: 'default' }), defaultArgs);
		if (name === 'codex') {
			assert.ok(args.includes('--json'));
			assert.equal(args.includes('windows.sandbox=unelevated'), process.platform === 'win32');
		}
	}
});

test('Codex esclude banner, log, tool e ragionamento anche durante lo streaming', async () => {
	const chunks = ['banner\nnull\n[]\n', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'prima' } }) + '\n', JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'privato' } }) + '\n', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'finale' } }) + '\nlog'];
	const h = harness({ chunks });
	const updates = [];
	assert.equal(await run(h, 'codex', { prompt: 'breve', onText: text => updates.push(text) }), 'finale');
	assert.deepEqual(updates, ['finale']);
	assert.equal(h.CLI_AGENTS.codex.parseOutput('solo banner e log'), '');
});

test('ANSI spezzate: ogni confine conserva il risultato della pulizia completa', async () => {
	const raw = '  \x1b[31mciao\x1b[0m ?\n\x1b[2;1Hfine \x1b[ incompleta\x1b[';
	const expected = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
	for (let i = 1; i < raw.length; i++) {
		const h = harness({ chunks: [raw.slice(0, i), raw.slice(i)] });
		assert.equal(await run(h, 'copilot', { prompt: 'breve' }), expected, 'confine ' + i);
	}
});

test('agy vieta esplicitamente il terminale anche con modifica file consentita', async () => {
	for (const write of [false, true]) {
		const h = harness({ chunks: ['{"step_update":{"step_type":"agent_response","text_delta":"ok"}}'] });
		await run(h, 'agy', { prompt: 'breve', write });
		assert.match(h.calls[0].args[1], /Never run terminal commands: use only your file viewing, directory listing and search tools\./);
	}
});

test('Copilot oltre il limite dei comandi viene rifiutato e non parte in modo interattivo', async () => {
	const h = harness();
	const lungo = 'x'.repeat(40000);
	await assert.rejects(() => run(h, 'copilot', { prompt: lungo }), /troppo lunghi/);
	assert.equal(h.calls.length, 0);
});
