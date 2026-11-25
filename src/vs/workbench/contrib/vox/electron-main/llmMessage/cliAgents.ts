/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../common/voxI18n.js';
import { spawn, execFile } from 'node:child_process';
import { access, readFile, mkdtemp, open, realpath, stat, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
// Come il filtro della documentazione di kimi (role assistant, content presente, nessun tool_calls): il testo che
// accompagna una chiamata a strumento è un passo intermedio, non la risposta.
const kimiAnswer = (stdout: string) => {
	let last = '';
	for (const event of events(stdout)) {
		if (event?.role === 'assistant' && !(Array.isArray(event.tool_calls) && event.tool_calls.length) && typeof event.content === 'string' && event.content.trim()) last = event.content.trim();
	}
	return last;
};
// Si uniscono i text_delta dell'ultimo tratto di risposta dopo l'ultimo strumento (step_type «tool» o, in alcune
// versioni, «tool_call»). Se non ce ne sono, vale la risposta dell'evento finale `result` (`result.response`).
const agyAnswer = (stdout: string) => {
	let answer = '', result = '';
	for (const event of events(stdout)) {
		const step = event.step_update;
		if (step?.step_type === 'tool' || step?.step_type === 'tool_call') answer = '';
		else if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') answer += step.text_delta;
		else if (typeof event.result?.response === 'string') result = event.result.response;
	}
	return answer.trim() || result.trim();
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

// Cerca il comando nelle cartelle del PATH, come where.exe e which ma senza avviare processi. where.exe scrive i percorsi
// nella code page OEM della console, non in UTF-8: un percorso con lettere accentate (C:\Users\Niccolò\AppData\...)
// arriverebbe rovinato e la CLI risulterebbe non trovata; inoltre where.exe cerca prima nella cartella corrente.
// Le cartelle relative del PATH si ignorano. Su Windows si provano il nome e le estensioni di PATHEXT (come where.exe,
// che elenca anche il file senza estensione: il chiamante lo scarta), sugli altri sistemi solo i file eseguibili.
// Come con where.exe, oltre 5 secondi (per esempio una cartella di rete irraggiungibile nel PATH) l'elenco è vuoto.
const where = (command: string): Promise<string[]> => {
	if (!command || /[\\/]/.test(command)) return Promise.resolve([]);
	const windows = process.platform === 'win32';
	const extensions = windows ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim()).filter(ext => /^\.[^.\\/]+$/.test(ext))] : [''];
	const dirs = [...new Set((process.env.PATH || '').split(delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => dir && isAbsolute(dir)))];
	const usable = async (file: string) => {
		try {
			if ((await stat(file)).isDirectory()) return false;
			if (!windows) await access(file, fsConstants.X_OK);
			return true;
		}
		// Gli alias di esecuzione di Windows (WindowsApps) possono non dare stat: basta che il file sia accessibile.
		catch { if (!windows) return false; try { await access(file); return true; } catch { return false; } }
	};
	const search = Promise.all(dirs.flatMap(dir => extensions.map(async ext => { const file = join(dir, command + ext); return await usable(file) ? [file] : []; })))
		.then(found => found.flat());
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([search, new Promise<string[]>(resolveEmpty => { timer = setTimeout(() => resolveEmpty([]), 5000); })]).finally(() => clearTimeout(timer));
};

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
	// «Copia come percorso» di Esplora file aggiunge le virgolette: "C:\Program Files\...\codex.exe".
	command = command.trim().replace(/^"(.+)"$/, '$1').trim();
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
				// Anche il percorso vero deve essere un file .exe: non una cartella con quel nome (installazione a metà) né un
				// collegamento verso un batch.
				if (!/\.exe$/i.test(realBinary) || !(await stat(realBinary)).isFile()) continue;
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

// Modelli che la CLI elenca per l'account dell'utente, da proporre nel sottomenu. Per ora solo codex, che tiene l'elenco
// in models_cache.json (in CODEX_HOME o in ~/.codex): si prendono i modelli visibili ("list") in ordine di priorità
// crescente. La cache la scrive codex per le credenziali con cui l'ha scaricata (campo `identity`, opaco: Vox non lo può
// confrontare senza leggere le credenziali), quindi dopo un cambio di account resta quella vecchia finché codex non la
// aggiorna al primo uso. Con qualunque errore l'elenco è vuoto; `codexHome` serve solo ai test e non arriva dal renderer.
const MODELS_CACHE_LIMIT = 1024 * 1024;
export const listCliAgentModels = async (agent: string, codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): Promise<string[]> => {
	if (agent !== 'codex') return [];
	// Un CODEX_HOME relativo codex lo risolve dalla sua cartella di lavoro (il workspace), Vox da quella dell'app: non si
	// indovina quale cache usi, quindi nessun suggerimento. Su Windows anche «\codex» o «/codex» dipendono dall'unità
	// corrente: valgono solo i percorsi con l'unità (C:\...) o UNC (\\server\condivisione\...).
	const absolute = process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(codexHome) : isAbsolute(codexHome);
	if (!absolute) return [];
	const cache = join(codexHome, 'models_cache.json');
	let text: string;
	try {
		// Il tipo si controlla prima di aprire e di nuovo sul file aperto; su POSIX l'apertura non bloccante evita di restare
		// fermi su una pipe messa al posto del file fra i due controlli. Si leggono al massimo MODELS_CACHE_LIMIT + 1 byte,
		// in ciclo (una lettura può restituire solo un blocco, per esempio da una cartella di rete), così un file cresciuto
		// nel frattempo non si carica per intero.
		if (!(await stat(cache)).isFile()) return [];
		const file = await open(cache, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > MODELS_CACHE_LIMIT) return [];
			const buffer = Buffer.allocUnsafe(MODELS_CACHE_LIMIT + 1);
			let total = 0;
			while (total < buffer.length) {
				const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
				if (bytesRead === 0) break;
				total += bytesRead;
			}
			if (total > MODELS_CACHE_LIMIT) return [];
			text = buffer.toString('utf8', 0, total);
		} finally { await file.close(); }
	} catch { return []; }
	let models: unknown;
	try { models = JSON.parse(text)?.models; } catch { return []; }
	if (!Array.isArray(models)) return [];
	// Lo slug diventa un argomento di --model: niente «-» iniziale (runCliAgent lo rifiuta) e niente «__custom__» (la voce
	// del sottomenu per scrivere un modello a mano).
	const listed = models.flatMap((entry, index) => entry && typeof entry === 'object' && entry.visibility === 'list'
		&& typeof entry.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(entry.slug)
		? [{ slug: entry.slug, priority: Number.isFinite(entry.priority) ? entry.priority as number : Infinity, index }] : []);
	listed.sort((a, b) => a.priority === b.priority ? a.index - b.index : a.priority < b.priority ? -1 : 1);
	return [...new Set(listed.map(model => model.slug))].slice(0, 20);
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
		// Prima si tolgono le sequenze ANSI, come per stderr: un colore dentro il nome della chiave ne impedirebbe l'oscuramento.
		const first = found ? redactSecrets(found.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()).split(/\r?\n/)[0] : '';
		// Un turno fallito senza messaggio cancella quello di un turno precedente: la causa attuale va cercata altrove.
		// Il messaggio di un turn.failed non finisce in `message`: se l'ultimo è vuoto, quello vecchio non torna dal ripiego.
		if (event.type === 'turn.failed') { failed = true; failedMessage = first; }
		else if (first) message = first;
	}
	return { message, failedMessage, failed };
};
const NO_JSON_FAILURE: ReturnType<typeof jsonFailure> = { message: '', failedMessage: '', failed: false };

// Oscura chiavi, token e password. Prima i valori dopo un nome di chiave (api key, SECRET_KEY, secretKey,
// AWS_SECRET_ACCESS_KEY, token, password...), così le sostituzioni dei token non toccano gli escape dentro le virgolette:
// un valore tra virgolette si oscura per intero, anche con spazi, virgole o a capo (fino a 4096 caratteri, così un JWT
// resta un valore solo e la causa scritta dopo si vede); se le virgolette non si chiudono entro il limite si oscura il
// resto del testo. I due rami dentro le virgolette sono disgiunti: la ricerca resta lineare.
const SECRET_VALUE = /((?:(?:api|secret|access|private|auth)[_ -]?(?:access[_ -]?)?key|token|secret|password|passwd)["']?\s*[:=]\s*)(?:(["'])(?:\\[\s\S]|(?!\2)[^\\]){0,4096}\2|(["'])[\s\S]*|[^\s"',}]+)/gi;
const redactSecrets = (text: string) => text
	.replace(SECRET_VALUE, (_match, prefix: string, closed?: string, openQuote?: string) => closed ? `${prefix}${closed}${t('[redacted]')}${closed}` : `${prefix}${openQuote ?? ''}${t('[redacted]')}`)
	.replace(/\b(?:sk|pk|gh[pousr]|github_pat|xox[bap]|AIza)[-_A-Za-z0-9]{8,}/g, t('[redacted]'))
	.replace(/(bearer\s+)[^\s"']+/gi, `$1${t('[redacted]')}`)
	// «Basic» solo dopo Authorization: da solo è una parola comune.
	.replace(/(authorization["']?\s*[:=]\s*["']?basic\s+)[^\s"']+/gi, `$1${t('[redacted]')}`);

// Riga breve e senza segreti che spiega perché la CLI è fallita (quota, login, modello non valido...).
// Ordine: il messaggio di un turno fallito (codex turn.failed), poi stderr, poi l'ultimo errore JSON di stdout, poi
// l'ultima riga del testo di stdout se spiega la causa (claude senza login scrive lì «Not logged in»): non si cerca
// nel resto della risposta, dove una frase con «error» o «invalid» non è la causa.
// `json` sono gli errori degli eventi JSON di stdout: chi li ha già letti li passa, e per le CLI a testo è vuoto (una riga
// JSON dentro la risposta non è la causa).
export const describeCliFailure = (agent: string, stderr: string, stdout = '', json = jsonFailure(stdout)): string => {
	const generic = t("CLI {0} exited with an error. Check login and model in your terminal.", agent);
	// Si oscura il testo intero prima di dividerlo in righe: un valore tra virgolette su più righe sparisce tutto.
	const plain = (text: string) => redactSecrets(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	// Le righe di stack («at funzione (file:riga)») non sono la causa anche se contengono «Error».
	const useful = (l: string) => !/^at\s/.test(l) && /error|quota|login|logged|auth|api key|unauthori[sz]ed|not found|invalid|limit/i.test(l);
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
			let stopError: Error | undefined, stdinFailed = false;
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
						// Se la CLI è già uscita da sola, taskkill fallisce perché il processo non c'è più: non è un problema di permessi.
						const exited = child.exitCode !== null || child.signalCode !== null;
						const result = killError && !exited ? new Error(t("{0} Unable to terminate the process tree: check taskkill permissions.", error.message)) : error;
						if (exited) { finish(result); return; }
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
			// Un discendente della CLI (un server, un processo staccato, un albero che taskkill non ha chiuso) può tenere aperti
			// stdout e stderr anche dopo l'uscita: 'close' non arriverebbe mai e la richiesta resterebbe appesa, anche dopo un
			// timeout o un annullamento. Poco dopo l'uscita si chiudono i flussi; quello che il discendente scrive dopo si perde.
			child.once('exit', () => { setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 2000); });
			child.on('error', () => finish(new Error(t("Unable to start CLI. Check path and installation."))));
			child.on('close', code => {
				if (finished) return;
				if (stopError) { if (process.platform !== 'win32') finish(stopError); return; }
				// L'errore di scrittura su stdin può arrivare dopo 'close': conta anche un prompt non scritto per intero.
				if (code !== 0 || stdinFailed || (stdin && !child.stdin!.writableFinished)) {
					if (code === 0) { finish(new Error(t("Unable to send prompt to CLI via stdin."))); return; }
					// Il testo già mostrato da una CLI a testo resta nella chat come risposta: se la CLI fallisce (spesso scrive
					// lì la causa), si sostituisce con la versione oscurata, così nella cronologia non restano segreti.
					// Senza `ansiTail`: una sequenza ANSI rimasta a metà non va nella cronologia né nel messaggio.
					if (!structured && stdout) onText(redactSecrets(stdout.trim()));
					finish(new Error(describeCliFailure(agent, stderrAll, stdout, structured ? jsonFailure(stdout) : NO_JSON_FAILURE))); return;
				}
				const answer = structured ? CLI_AGENTS[agent].parseOutput(stdout) : (stdout + ansiTail).trim();
				const failure = structured ? jsonFailure(stdout) : NO_JSON_FAILURE;
				// Un turno fallito (turn.failed) è un errore anche con codice 0 e una risposta parziale.
				if (failure.failed || (!answer && failure.message)) { finish(new Error(describeCliFailure(agent, stderrAll, stdout, failure))); return; }
				if (!answer) { finish(new Error(t("The CLI returned no text response."))); return; }
				onText(answer);
				finish(undefined, answer);
			});
			if (stdin) {
				// Una CLI che esce subito (login mancante, flag sconosciuto) chiude stdin prima di leggerlo: l'EPIPE che segue non
				// deve nascondere la causa vera, che si legge all'uscita. Con codice 0 il prompt non è arrivato per intero.
				child.stdin!.on('error', () => { stdinFailed = true; });
				child.stdin!.end(fullPrompt, 'utf8');
			}
			if (signal?.aborted) abort();
		});
	} finally {
		// Su Windows un file appena scritto può restare aperto per poco (antivirus, indicizzazione, un discendente della
		// CLI): si riprova, e una pulizia non riuscita non cambia l'esito della richiesta né nasconde la risposta.
		if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => { });
	}
}
