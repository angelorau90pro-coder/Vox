/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../common/voxI18n.js';
import { spawn, execFile } from 'node:child_process';
import { access, readFile, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

type AgentOptions = { model?: string; cwd: string; write?: boolean; profile?: string; stdin?: boolean; promptFile?: string };
type CliAgent = { command: string; buildArgs: (prompt: string, options: AgentOptions) => string[]; parseOutput: (stdout: string) => string };
const modelArgs = (model?: string, flag = '--model') => model ? [flag, model] : [];
const clean = (stdout: string) => stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
const events = (stdout: string): any[] => stdout.split('\n').flatMap(line => {
	try { const event = JSON.parse(line); return event && typeof event === 'object' && !Array.isArray(event) ? [event] : []; } catch { return []; }
});

const codexAnswer = (stdout: string) => {
	let last = '';
	for (const event of events(stdout)) {
		if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string' && event.item.text.trim()) last = event.item.text.trim();
	}
	return last;
};

// Conserva solo il testo dell'ultimo passo, senza mostrare tool o ragionamento.
const opencodeAnswer = (stdout: string) => {
	let step: string[] = [], last: string[] = [];
	for (const event of events(stdout)) {
		if (event.type === 'step_start') step = [];
		else if (event.type === 'text' && event.part?.text?.trim()) { step.push(event.part.text.trim()); last = step; }
	}
	return last.join('\n\n');
};
const kimiAnswer = (stdout: string) => {
	let last = '';
	for (const event of events(stdout)) {
		if (event?.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) last = event.content.trim();
	}
	return last;
};
const agyAnswer = (stdout: string) => {
	let answer = '';
	for (const event of events(stdout)) {
		const step = event.step_update;
		if (step?.step_type === 'tool') answer = '';
		else if (step?.step_type === 'agent_response' && step.text_delta) answer += step.text_delta;
	}
	return answer.trim();
};

export const CLI_AGENTS = {
	codex: {
		command: 'codex',
		buildArgs: (prompt, { model, cwd, write, stdin }) => ['exec', '--json', '-c', 'features.hooks=false', ...(process.platform === 'win32' ? ['-c', 'windows.sandbox=unelevated'] : []), '--sandbox', write ? 'workspace-write' : 'read-only', '--skip-git-repo-check', '-C', cwd, ...modelArgs(model, '-m'), '--', stdin ? '-' : prompt],
		parseOutput: codexAnswer,
	},
	agy: {
		command: 'agy',
		buildArgs: (prompt, { model, write }) => ['-p', prompt, '--output-format', 'stream-json', '--mode', write ? 'accept-edits' : 'plan', '--sandbox', ...modelArgs(model)],
		parseOutput: agyAnswer,
	},
	devin: {
		command: 'devin',
		buildArgs: (prompt, { model, write, profile }) => ['-p', '--permission-mode', write ? 'accept-edits' : 'auto', '--config', profile!, '--respect-workspace-trust', 'false', ...modelArgs(model === 'default' ? undefined : model), '--', prompt],
		parseOutput: clean,
	},
	copilot: {
		command: 'copilot',
		buildArgs: (prompt, { model, write, stdin }) => ['-p', prompt, `--available-tools=view,grep,glob${write ? ',create,edit,apply_patch' : ''}`, write ? '--allow-tool=write' : '--deny-tool=write', '-s', '--no-ask-user', '--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps', '--no-auto-update', '--disallow-temp-dir', ...['.env', '.env.local', '.env.development', '.env.production'].map(f => `--deny-tool=read(${f})`), ...modelArgs(model)],
		parseOutput: clean,
	},
	opencode: {
		command: 'opencode',
		buildArgs: (prompt, { model, cwd, promptFile }) => ['run', '--pure', '--format', 'json', '--agent', 'vox', '--dir', cwd, ...modelArgs(model, '-m'), ...(promptFile ? ['-f', promptFile] : []), '--', promptFile ? 'Segui le istruzioni allegate.' : prompt],
		parseOutput: opencodeAnswer,
	},
	kimi: {
		command: 'kimi',
		buildArgs: (prompt, { model, profile }) => ['-p', prompt, '--output-format', 'stream-json', '--agent-file', profile!, ...modelArgs(model, '-m')],
		parseOutput: kimiAnswer,
	},
	claude: {
		command: 'claude',
		buildArgs: (prompt, { model, write, stdin }) => ['-p', ...(stdin ? [] : [prompt]), '--restricted', '--strict-mcp-config', '--tools', `Read,Grep,Glob${write ? ',Edit,Write' : ''}`, '--permission-mode', write ? 'acceptEdits' : 'dontAsk', '--no-session-persistence', '--output-format', 'text', ...modelArgs(model)],
		parseOutput: clean,
	},
} satisfies Record<string, CliAgent>;

export type CliAgentName = keyof typeof CLI_AGENTS;
export const isCliAgentName = (agent: string): agent is CliAgentName => Object.prototype.hasOwnProperty.call(CLI_AGENTS, agent);

const where = (command: string): Promise<string[]> => new Promise(resolvePaths => {
	execFile(process.platform === 'win32' ? 'where.exe' : 'which', [command], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
		resolvePaths(error ? [] : stdout.trim().split(/\r?\n/).filter(Boolean));
	});
});

// Riga di avvio di uno shim nativo: deve essere per intero «"%dp0%\...\x.exe" %*», quindi non conta dentro un echo,
// una condizione su una riga o un commento; deve stare fuori da blocchi tra parentesi (IF ... ( ... )) e non seguire una
// riga che continua con ^. Con più righe di avvio valide lo shim è ambiguo (rami diversi, GOTO) e si rifiuta.
const nativeLaunch = (shim: string): string | undefined => {
	let depth = 0, continued = false;
	const found: string[] = [];
	for (const line of shim.split(/\r?\n/)) {
		const launch = line.match(/^\s*(["'])%(?:dp0|~dp0)%?[/\\]([^"'\r\n]+\.exe)\1[ \t]+%\*\s*$/i)?.[2];
		if (launch && depth === 0 && !continued) found.push(launch);
		// Parentesi e continuazioni contano solo fuori dalle virgolette. Un numero dispari di ^ in fondo continua la riga
		// (anche in un commento: per prudenza si rifiuta la riga dopo); «^^» e «^(» sono caratteri letterali.
		const unquoted = line.replace(/"[^"]*"?/g, '');
		continued = /(?:^|[^^])(?:\^\^)*\^\s*$/.test(unquoted);
		if (/^\s*(?:@?rem\b|::)/i.test(line)) continue;
		const bare = unquoted.replace(/\^./g, '');
		depth = Math.max(0, depth + (bare.match(/\(/g)?.length ?? 0) - (bare.match(/\)/g)?.length ?? 0));
	}
	return found.length === 1 ? found[0] : undefined;
};

// Nessuna shell: gli shim npm .cmd sono risolti al loro entry point JavaScript.
// Gli altri batch vengono rifiutati: cmd.exe non preserva in sicurezza prompt arbitrari.
export const resolveCliCommand = async (command: string): Promise<{ command: string; args: string[] }> => {
	const paths = isAbsolute(command) ? [command] : await where(command);
	for (const path of paths) {
		try {
			await access(path);
			if (/\.(cmd|bat)$/i.test(path)) {
				const shim = await readFile(path, 'utf8');
				const entry = shim.match(/(["'])%(?:dp0|~dp0)%?[/\\]([^"'\r\n]+\.(?:js|cjs|mjs))\1/i)?.[2];
				if (entry && /node(?:\.exe)?/i.test(shim)) {
					const script = resolve(dirname(path), entry);
					await access(script);
					// Il runtime incorporato nell'app (Electron) può essere più vecchio di quello richiesto dalla CLI
					// (per esempio kimi usa API di Node recenti): si usa il node di sistema e solo in mancanza quello dell'app.
					const systemNode = (await where('node')).find(candidate => process.platform !== 'win32' || /\.exe$/i.test(candidate));
					return { command: systemNode ?? process.execPath, args: [script] };
				}
				// Shim npm che avvia un eseguibile nativo del pacchetto (per esempio claude 2.x: "%dp0%\...\claude.exe" %*):
				// si avvia direttamente l'.exe.
				const native = nativeLaunch(shim);
				if (!native || process.platform !== 'win32') continue;
				const binary = resolve(dirname(path), native);
				// L'eseguibile deve stare nel pacchetto: sotto la cartella dello shim (npm globale) oppure, per uno shim in
				// node_modules\.bin, sotto quel node_modules. Si confrontano i percorsi veri (realpath), così né un percorso
				// che risale oltre ("..\..\Windows\...") né una giunzione verso l'esterno passano.
				const shimDir = dirname(path);
				const root = basename(shimDir).toLowerCase() === '.bin' && basename(dirname(shimDir)).toLowerCase() === 'node_modules' ? dirname(shimDir) : shimDir;
				const [realRoot, realBinary] = await Promise.all([realpath(root), realpath(binary)]);
				const inside = relative(realRoot, realBinary);
				if (!inside || /^\.\.(?:[\\/]|$)/.test(inside) || isAbsolute(inside)) continue;
				return { command: binary, args: [] };
			}
			if (process.platform === 'win32' && !/\.exe$/i.test(path)) continue;
			return { command: path, args: [] };
		} catch { /* Prova il prossimo risultato di where. */ }
	}
	throw new Error(t("CLI not found or unsupported command. Specify an executable or npm shim."));
};

export const listCliAgents = async (commands: Partial<Record<`${CliAgentName}Command`, string>>): Promise<string[]> => {
	const found = await Promise.all((Object.keys(CLI_AGENTS) as CliAgentName[]).map(async agent => {
		try { await resolveCliCommand(commands[`${agent}Command`]?.trim() || CLI_AGENTS[agent].command); return agent; }
		catch { return null; }
	}));
	return found.filter((agent): agent is CliAgentName => agent !== null);
};

// Le CLI con output JSON (per esempio codex) scrivono l'errore negli eventi di stdout, non su stderr:
// Gli elementi "item.completed" di tipo error sono avvisi e non contano. `failedMessage` è il messaggio dell'ultimo
// turn.failed, `message` quello dell'ultimo evento "error" (anche un errore non fatale).
// `failed` dice se il turno è fallito: allora è un errore anche con codice 0 e una risposta parziale.
const jsonFailure = (stdout: string): { message: string; failedMessage: string; failed: boolean } => {
	let message = '', failedMessage = '', failed = false;
	for (const event of events(stdout)) {
		if (event.type !== 'error' && event.type !== 'turn.failed') continue;
		const found = [event.message, event.error?.message, event.error?.data?.message, typeof event.error === 'string' ? event.error : undefined]
			.find(candidate => typeof candidate === 'string' && candidate.trim());
		// Si oscura il messaggio intero prima di prenderne la prima riga: un valore su più righe sparisce tutto.
		const first = found ? redactSecrets(found.trim()).split(/\r?\n/)[0] : '';
		// Un turno fallito senza messaggio cancella quello di un turno precedente: la causa attuale va cercata altrove.
		// Il messaggio di un turn.failed non finisce in `message`: se l'ultimo è vuoto, quello vecchio non torna dal ripiego.
		if (event.type === 'turn.failed') { failed = true; failedMessage = first; }
		else if (first) message = first;
	}
	return { message, failedMessage, failed };
};

// Oscura chiavi, token e password. Prima i valori dopo un nome di chiave (api key, SECRET_KEY, secretKey,
// AWS_SECRET_ACCESS_KEY, token, password...), così le sostituzioni dei token non toccano gli escape dentro le virgolette:
// un valore tra virgolette si oscura per intero, anche con spazi, virgole o a capo (fino a 500 caratteri); se le
// virgolette non si chiudono entro il limite si oscura il resto del testo.
const SECRET_VALUE = /((?:(?:api|secret|access|private|auth)[_ -]?(?:access[_ -]?)?key|token|secret|password|passwd)["']?\s*[:=]\s*)(?:(["'])(?:\\[\s\S]|(?!\2)[^\\]){0,500}\2|(["'])[\s\S]*|[^\s"',}]+)/gi;
const redactSecrets = (text: string) => text
	.replace(SECRET_VALUE, (_match, prefix: string, closed?: string, open?: string) => closed ? `${prefix}${closed}${t('[redacted]')}${closed}` : `${prefix}${open ?? ''}${t('[redacted]')}`)
	.replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[bap]|AIza)[-_A-Za-z0-9]{8,}/g, t('[redacted]'))
	.replace(/(bearer\s+)[^\s"']+/gi, `$1${t('[redacted]')}`);

// Riga breve e senza segreti che spiega perché la CLI è fallita (quota, login, modello non valido...).
// Ordine: il messaggio di un turno fallito (codex turn.failed), poi stderr, poi l'ultimo errore JSON di stdout, poi
// l'ultima riga del testo di stdout se spiega la causa (claude senza login scrive lì «Not logged in»): non si cerca
// nel resto della risposta, dove una frase con «error» o «invalid» non è la causa.
export const describeCliFailure = (agent: string, stderr: string, stdout = ''): string => {
	const generic = t("CLI {0} exited with an error. Check login and model in your terminal.", agent);
	// Si oscura il testo intero prima di dividerlo in righe: un valore tra virgolette su più righe sparisce tutto.
	const plain = (text: string) => redactSecrets(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	// Le righe di stack («at funzione (file:riga)») non sono la causa anche se contengono «Error».
	const useful = (l: string) => !/^at\s/.test(l) && /error|quota|login|logged|auth|api key|unauthori[sz]ed|not found|invalid|limit/i.test(l);
	const json = jsonFailure(stdout);
	// L'ultima riga di stdout si calcola solo se serve: oscurare e dividere una risposta lunga ha un costo.
	const lastLine = () => { const last = plain(stdout).filter(l => !l.startsWith('{')).pop(); return last && useful(last) ? last : undefined; };
	// Di stderr vale l'ultima riga utile: le prime sono spesso tentativi ripetuti, la causa finale viene dopo.
	const line = json.failedMessage || plain(stderr).filter(useful).pop() || json.message || lastLine();
	if (!line) return generic;
	// Già oscurata; si ripete per sicurezza prima di tagliare.
	const safe = redactSecrets(line).slice(0, 240);
	return t("CLI {0} exited with an error: {1}", agent, safe);
};

export async function runCliAgent({ agent, model, prompt, cwd: workspaceFolder, onText, signal, command, timeoutMs = 600_000, write = false }: {
	agent: CliAgentName; model?: string; prompt: string; cwd?: string;
	onText: (text: string) => void; signal?: AbortSignal; command?: string; timeoutMs?: number; write?: boolean;
}): Promise<string> {
	if (!isCliAgentName(agent)) throw new Error(t("Unknown CLI AI."));
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error(t("Invalid CLI timeout."));
	if (prompt.includes('\0') || model?.includes('\0') || model?.startsWith('-')) throw new Error(t("Invalid CLI prompt or model."));
	// Senza workspace il ripiego nella home resta sempre in sola lettura.
	write = write && !!workspaceFolder;
	// Kimi resta in sola lettura: il suo profilo elenca gli strumenti ma non ha un limite verificato alla cartella di lavoro.
	// Devin invece è stato provato (3000.11.234): con accept-edits scrive nella cartella e rifiuta, senza conferma interattiva,
	// i percorsi assoluti esterni, quelli con ".." e quelli che passano da una giunzione.
	if (agent === 'kimi') write = false;
	const cwd = workspaceFolder ?? homedir();
	const aborted = () => new Error(t("CLI request canceled."));
	if (signal?.aborted) throw aborted();
	const executable = await resolveCliCommand(command?.trim() || CLI_AGENTS[agent].command);
	const env: NodeJS.ProcessEnv = { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: '1' };
	// Solo se manca un node di sistema si usa l'eseguibile dell'app (Electron), che per fare da Node vuole questa variabile.
	if (executable.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
	let profileDir: string | undefined;
	try {
		let profile: string | undefined;
		if (agent === 'kimi' || agent === 'devin') {
			profileDir = await mkdtemp(join(tmpdir(), 'vox-cli-'));
			profile = join(profileDir, agent === 'kimi' ? 'agent.md' : 'permissions.json');
			await writeFile(profile, agent === 'kimi'
				? `---\nname: vox\ndescription: Assistente Vox con strumenti limitati\ntools: Read, Glob, Grep${write ? ', Write, Edit' : ''}\n---\nOpera solo nella cartella di lavoro. Non aprire segreti o credenziali. Non eseguire comandi.\n`
				: JSON.stringify({ shell: { setup_complete: true }, permissions: { deny: write ? ['exec'] : ['write', 'edit', 'notebook_edit', 'Write(/**)', 'exec'] }, version: 1 }), 'utf8');
		}
		if (agent === 'opencode') {
			Object.assign(env, {
				OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', agent: { vox: { description: 'Vox', mode: 'primary', permission: { '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' }, glob: 'allow', grep: 'allow', list: 'allow', ...(write ? { edit: 'allow', write: 'allow' } : {}) } } } }),
				OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_SHARE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
			});
		}
		const policy = `Opera solo nella cartella ${cwd}. Non aprire file .env, chiavi private o credenziali. Non usare strumenti MCP o web. ${write ? 'Modifica file solo nella cartella di lavoro.' : 'Leggi soltanto: non modificare file.'} Non eseguire comandi di terminale. Usa i tuoi strumenti; rispondi con testo, senza chiamate a strumenti Vox.\n\n`;
		const fullPrompt = policy + (agent === 'agy' ? 'Never run terminal commands: use only your file viewing, directory listing and search tools.\n\n' : '') + prompt;
		const longPrompt = fullPrompt.length > 12000;
		const stdin = longPrompt && (agent === 'codex' || agent === 'claude');
		let promptFile: string | undefined;
		if (longPrompt && agent === 'opencode') {
			profileDir = await mkdtemp(join(tmpdir(), 'vox-cli-'));
			promptFile = join(profileDir, 'prompt.md');
			await writeFile(promptFile, fullPrompt, { encoding: 'utf8', mode: 0o600 });
		}
		const args = [...executable.args, ...CLI_AGENTS[agent].buildArgs(fullPrompt, { model, cwd, write, profile, stdin, promptFile })];
		// Margine per quoting, percorso eseguibile e terminatore rispetto al limite CreateProcess.
		const commandLength = executable.command.length + args.reduce((length, arg) => length + arg.length + (arg.match(/[\\"]/g)?.length ?? 0) + 3, 1);
		if (commandLength > 30000) throw new Error(t("CLI prompt or arguments too long for {0} (Windows limit). Reduce history or choose a CLI with stdin/file input.", agent));
		if (signal?.aborted) throw aborted();
		return await new Promise<string>((resolveAnswer, reject) => {
			const child = spawn(executable.command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
			let stdout = '', ansiTail = '', outputLength = 0, finished = false;
			const structured = agent === 'codex' || agent === 'opencode' || agent === 'kimi' || agent === 'agy';
			let stopError: Error | undefined;
			const finish = (error?: Error, answer?: string) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				if (error) reject(error); else resolveAnswer(answer!);
			};
			const stop = (error: Error) => {
				if (finished || stopError) return;
				stopError = error;
				if (!child.pid) { finish(error); return; }
				if (process.platform === 'win32') {
					execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, killError => {
						const result = killError ? new Error(t("{0} Unable to terminate the process tree: check taskkill permissions.", error.message)) : error;
						if (child.exitCode !== null || child.signalCode !== null) { finish(result); return; }
						child.once('close', () => finish(result));
						child.kill();
					});
				} else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
			};
			const abort = () => stop(aborted());
			const timer = setTimeout(() => stop(new Error(t("CLI timeout exceeded."))), timeoutMs);
			signal?.addEventListener('abort', abort, { once: true });
			child.stdout!.setEncoding('utf8');
			child.stdout!.on('data', (chunk: string) => {
				if (finished || stopError) return;
				outputLength += chunk.length;
				if (outputLength > 16 * 1024 * 1024) { stop(new Error(t("CLI response too large."))); return; }
				// Le CLI JSON mostrano solo il risultato finale: i passi intermedi possono contenere tool.
				if (structured) { stdout += chunk; return; }
				const piece = ansiTail + chunk;
				// Conserva solo una CSI incompleta per il prossimo chunk.
				ansiTail = piece.match(/\x1b(?:\[[0-?]*[ -/]*)?$/)?.[0] ?? '';
				stdout += piece.slice(0, piece.length - ansiTail.length).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
				onText(stdout.trim());
			});
			// stderr serve solo a spiegare l'errore (quota, login, modello) e si oscura per intero prima dell'uso: un taglio
			// potrebbe lasciare un pezzo di valore senza il nome della chiave che lo fa oscurare. Oltre 1 MiB non si conserva
			// e non si usa per la diagnosi: la causa si cerca negli altri canali o resta il messaggio generico.
			let stderrAll = '', stderrOverflow = false;
			child.stderr!.setEncoding('utf8');
			child.stderr!.on('data', (chunk: string) => {
				if (stderrOverflow) return;
				stderrAll += chunk;
				if (stderrAll.length > 1024 * 1024) { stderrAll = ''; stderrOverflow = true; }
			});
			child.on('error', () => finish(new Error(t("Unable to start CLI. Check path and installation."))));
			child.on('close', code => {
				if (finished) return;
				if (stopError) { if (process.platform !== 'win32') finish(stopError); return; }
				if (code !== 0) {
					// Il testo già mostrato da una CLI a testo resta nella chat come risposta: se la CLI fallisce (spesso scrive
					// lì la causa), si sostituisce con la versione oscurata, così nella cronologia non restano segreti.
					// Senza `ansiTail`: una sequenza ANSI rimasta a metà non va nella cronologia né nel messaggio.
					if (!structured && stdout) onText(redactSecrets(stdout.trim()));
					finish(new Error(describeCliFailure(agent, stderrAll, stdout))); return;
				}
				const answer = structured ? CLI_AGENTS[agent].parseOutput(stdout) : (stdout + ansiTail).trim();
				const failure = structured ? jsonFailure(stdout) : undefined;
				// Un turno fallito (turn.failed) è un errore anche con codice 0 e una risposta parziale.
				if (failure?.failed || (!answer && failure?.message)) { finish(new Error(describeCliFailure(agent, stderrAll, stdout))); return; }
				if (!answer) { finish(new Error(t("The CLI returned no text response."))); return; }
				onText(answer);
				finish(undefined, answer);
			});
			if (stdin) {
				child.stdin!.on('error', () => stop(new Error(t("Unable to send prompt to CLI via stdin."))));
				child.stdin!.end(fullPrompt, 'utf8');
			}
			if (signal?.aborted) abort();
		});
	} finally {
		if (profileDir) await rm(profileDir, { recursive: true, force: true });
	}
}
