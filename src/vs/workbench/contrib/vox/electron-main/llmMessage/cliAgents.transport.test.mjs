import { evaluate } from '../../common/voxI18n.fixture.mjs';
// Verifica il trasporto senza avviare processi o usare account esterni.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { test } from 'node:test';

const source = stripTypeScriptTypes((await readFile(new URL(process.argv[2] || './cliAgents.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '')).replace(/export /g, '');
const cwd = path.dirname(new URL(import.meta.url).pathname);
const prompt = '\u00e0\u{1f600} "\\ & | %PATH% !VAR! '.repeat(5000);
// `realFs`: realpath e open veri, per riconoscere la versione della CLI da file installati in una cartella temporanea
// (lo spawn resta finto); altrimenti nessun file si trova e valgono i flag predefiniti.
function harness({ spawnError = false, exitCode = 0, chunks, stderr, realFs = false } = {}) {
	const files = new Map(), removed = [], calls = [];
	const spawn = (command, args, options) => {
		if (spawnError) throw new Error('avvio fallito');
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
		child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
		child.stdin = new EventEmitter(); child.stdin.end = data => { child.input = data; child.stdin.writableFinished = true; };
		calls.push({ command, args, options, child, files: new Map(files) });
		queueMicrotask(() => {
			for (const chunk of chunks ?? [args.includes('--json') ? '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}' : options.env.OPENCODE_CONFIG_CONTENT ? '{"type":"text","part":{"text":"ok"}}' : 'ok']) child.stdout.emit('data', chunk);
			if (stderr) child.stderr.emit('data', stderr);
			child.emit('close', exitCode);
		});
		return child;
	};
	const missing = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
	const names = ['spawn', 'execFile', 'access', 'readFile', 'mkdtemp', 'writeFile', 'rm', 'homedir', 'tmpdir', 'dirname', 'isAbsolute', 'join', 'resolve', 'realpath', 'open', 'fsConstants'];
	const values = [spawn, assert.fail, async () => {}, assert.fail, async () => path.join(cwd, 'temp-finto'), async (name, value) => { files.set(name, value); }, async name => { removed.push(name); files.clear(); }, () => cwd, () => cwd, path.dirname, path.isAbsolute, path.join, path.resolve, realFs ? realpath : missing, realFs ? open : missing, fsConstants];
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

// Installazione npm finta in una cartella temporanea: <radice>/node_modules/<nome>/package.json e il file del comando.
async function npmLayout(name, version, bin, content = 'binario finto') {
	const root = await mkdtemp(path.join(tmpdir(), 'vox-cli-layout-'));
	const dir = path.join(root, 'node_modules', ...name.split('/'));
	const file = path.join(dir, ...bin.split('/'));
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
	await writeFile(file, content);
	return { root, file };
}
// Ultima regola di OpenCode 2.x che corrisponde (come Permission.evaluate: «*» vale qualunque testo, anche con «/»).
const lastRule = (rules, action, resource) => rules.findLast(rule => (rule.action === '*' || rule.action === action)
	&& new RegExp('^' + rule.resource.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 's').test(resource))?.effect;

test('OpenCode 2.x riconosciuto dal package.json: server privato, cartella in PWD, regole native, niente --pure né --dir', async () => {
	const { root, file } = await npmLayout('@opencode/cli', '2.4.1', 'bin/opencode.exe');
	try {
		for (const write of [false, true]) {
			const h = harness({ realFs: true });
			assert.equal(await run(h, 'opencode', { command: file, write, model: 'anthropic/claude-sonnet' }), 'ok');
			const { args, options } = h.calls[0];
			const promptFile = args[args.indexOf('-f') + 1];
			assert.deepEqual(args, ['run', '--standalone', '--format', 'json', '--agent', 'vox', '-m', 'anthropic/claude-sonnet', '-f', promptFile, '--', 'Segui le istruzioni allegate.']);
			assert.equal(options.cwd, cwd);
			assert.equal(options.env.PWD, cwd);
			assert.equal(options.stdio[0], 'ignore');
			for (const name of ['OPENCODE_CONFIG_PROJECT_DISABLE', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_AUTOUPDATE']) assert.equal(options.env[name], '1', name);
			const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
			assert.equal(config.agent, undefined);
			assert.deepEqual([config.update, config.share, config.formatter, config.lsp], ['disable', 'disabled', false, false]);
			const rules = config.agents.vox.permissions;
			assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
			assert.equal(lastRule(rules, 'read', 'src/main.ts'), 'allow');
			assert.equal(lastRule(rules, 'read', '.env'), 'deny');
			assert.equal(lastRule(rules, 'read', 'config/.env.local'), 'deny');
			assert.equal(lastRule(rules, 'glob', '**/*.ts'), 'allow');
			assert.equal(lastRule(rules, 'edit', 'src/main.ts'), write ? 'allow' : 'deny');
			for (const action of ['shell', 'webfetch', 'websearch', 'external_directory', 'subagent', 'execute', 'skill', 'question', 'mcp_tool']) assert.equal(lastRule(rules, action, '*'), 'deny', action);
		}
		// senza workspace la home, in sola lettura
		const home = harness({ realFs: true });
		await run(home, 'opencode', { command: file, prompt: 'breve', write: true, cwd: undefined });
		assert.equal(home.calls[0].options.env.PWD, cwd);
		assert.equal(lastRule(JSON.parse(home.calls[0].options.env.OPENCODE_CONFIG_CONTENT).agents.vox.permissions, 'edit', 'a.ts'), 'deny');
		assert.deepEqual(home.calls[0].args.slice(-2), ['--', home.calls[0].args.at(-1)]);
		assert.ok(home.calls[0].args.at(-1).endsWith('breve'));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('OpenCode 1.x (opencode-ai) e installazione non riconosciuta: flag di opencode-ai 1.x', async () => {
	const { root, file } = await npmLayout('opencode-ai', '1.19.6', 'bin/opencode.exe');
	const unknown = await mkdtemp(path.join(tmpdir(), 'vox-cli-layout-'));
	try {
		const brew = path.join(unknown, 'opencode.exe');
		await writeFile(brew, 'binario finto');
		for (const command of [file, brew]) {
			const h = harness({ realFs: true });
			await run(h, 'opencode', { command, prompt: 'breve' });
			const { args, options } = h.calls[0];
			assert.deepEqual(args.slice(0, 8), ['run', '--pure', '--format', 'json', '--agent', 'vox', '--dir', cwd]);
			assert.ok(!args.includes('--standalone'));
			const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
			assert.equal(config.agent.vox.permission['*'], 'deny');
			assert.equal(config.agents, undefined);
		}
	} finally { await rm(root, { recursive: true, force: true }); await rm(unknown, { recursive: true, force: true }); }
});

test('un flag sconosciuto aggiunge un suggerimento sulla versione; senza flag sconosciuti il messaggio resta quello di prima', async () => {
	const pure = harness({ exitCode: 1, stderr: 'Unrecognized flag: --pure in command opencode run\n' });
	await assert.rejects(run(pure, 'opencode', { prompt: 'breve' }), error => /terminata con errore/.test(error.message) && /Vox non ha riconosciuto la versione di OpenCode installata/.test(error.message));
	const kimi = harness({ exitCode: 2, stderr: "Usage: kimi [OPTIONS]\nError: No such option: --agent-file\n" });
	await assert.rejects(run(kimi, 'kimi', { prompt: 'breve' }), error => error.message.includes('No such option: --agent-file') && error.message.includes('La versione installata di kimi potrebbe non supportare le opzioni usate da Vox'));
	const { root, file } = await npmLayout('@opencode/cli', '3.0.0', 'bin/opencode.exe');
	try {
		const future = harness({ realFs: true, exitCode: 1, stderr: 'Unrecognized flag: --standalone in command opencode run\n' });
		await assert.rejects(run(future, 'opencode', { command: file, prompt: 'breve' }), error => error.message.includes('La versione installata di opencode potrebbe') && !error.message.includes('opencode-ai 1.x'));
	} finally { await rm(root, { recursive: true, force: true }); }
	const quota = harness({ exitCode: 1, stderr: 'Error: quota reached\n' });
	await assert.rejects(run(quota, 'opencode', { prompt: 'breve' }), error => error.message === 'La CLI opencode è terminata con errore: Error: quota reached');
});

test('la vecchia kimi-cli in Python viene rifiutata prima di scrivere profili o avviare processi', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'vox-cli-layout-'));
	try {
		const file = path.join(root, 'uv', 'tools', 'kimi-cli', 'bin', process.platform === 'win32' ? 'kimi.exe' : 'kimi');
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `#!${path.join(path.dirname(file), 'python')}\n# -*- coding: utf-8 -*-\nimport sys\nfrom kimi_cli.__main__ import main\nif __name__ == "__main__":\n    sys.exit(main())\n`);
		const h = harness({ realFs: true });
		await assert.rejects(run(h, 'kimi', { command: file, prompt: 'breve' }), /vecchia Kimi CLI in Python \(kimi-cli\).*@moonshot-ai\/kimi-code/);
		assert.equal(h.calls.length, 0);
		assert.equal(h.files.size, 0);
		assert.equal(h.removed.length, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});
