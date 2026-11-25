// Eseguire con Node >= 22.18: node --test src/vs/workbench/contrib/vox/electron-main/llmMessage/cliAgents.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, rmdir, symlink } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { loadCliAgents } from '../../common/voxI18n.fixture.mjs';
const { CLI_AGENTS, runCliAgent, resolveCliCommand, isCliAgentName, describeCliFailure, listCliAgentModels } = await loadCliAgents();

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
		// Shim reale di codex: il test "IF EXIST %dp0%\node.exe" non va scambiato per un eseguibile nativo.
		await writeFile(join(temp, 'node.exe'), '', 'utf8');
		await writeFile(shim, '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\entry.js" %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(shim), { command: process.execPath, args: [entry] });
		await writeFile(shim, '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  echo si\r\n)\r\n', 'utf8');
		await assert.rejects(resolveCliCommand(shim), /non supportato/);
		// Shim npm di un eseguibile nativo (claude 2.x): si avvia direttamente l'.exe del pacchetto.
		const binary = join(temp, 'bin', 'nativa.exe');
		await mkdir(dirname(binary), { recursive: true });
		await writeFile(binary, '', 'utf8');
		await writeFile(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\bin\\nativa.exe"   %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(shim), { command: binary, args: [] });
		// Una cartella che si chiama come l'eseguibile (installazione a metà) non è un eseguibile.
		await mkdir(join(temp, 'cartella.exe'), { recursive: true });
		await writeFile(shim, '@ECHO off\r\n"%dp0%\\cartella.exe" %*\r\n', 'utf8');
		await assert.rejects(resolveCliCommand(shim), /non supportato/);
		// Un commento che cita un altro eseguibile non conta, anche se quell'eseguibile esiste: vale la riga di avvio.
		const vecchia = join(temp, 'vecchia.exe');
		await writeFile(vecchia, '', 'utf8');
		for (const comment of ['REM "%dp0%\\vecchia.exe" %*', ':: "%dp0%\\vecchia.exe" %*', '@rem "%dp0%\\vecchia.exe" %*']) {
			await writeFile(shim, `@ECHO off\r\n${comment}\r\n"%dp0%\\bin\\nativa.exe"   %*\r\n`, 'utf8');
			assert.deepEqual(await resolveCliCommand(shim), { command: binary, args: [] });
			await writeFile(shim, `@ECHO off\r\n"%dp0%\\bin\\nativa.exe"   %*\r\n${comment}\r\n`, 'utf8');
			assert.deepEqual(await resolveCliCommand(shim), { command: binary, args: [] });
		}
		// Un batch qualunque che contiene la stessa sequenza (echo, una condizione) non è uno shim di avvio.
		for (const line of ['echo "%~dp0\\bin\\nativa.exe" %*', 'IF 1==1 "%dp0%\\bin\\nativa.exe" %*', 'start "" "%dp0%\\bin\\nativa.exe" %*']) {
			await writeFile(shim, `@ECHO off\r\n${line}\r\n`, 'utf8');
			await assert.rejects(resolveCliCommand(shim), /non supportato/, line);
		}
		// Varianti dello shim di avvio: %~dp0, barra, .EXE maiuscolo.
		for (const line of ['"%~dp0\\bin\\nativa.exe" %*', "'%dp0%/bin/nativa.EXE' %*"]) {
			await writeFile(shim, `@ECHO off\r\n${line}\r\n`, 'utf8');
			assert.deepEqual(await resolveCliCommand(shim), { command: line.includes('EXE') ? join(temp, 'bin', 'nativa.EXE') : binary, args: [] }, line);
		}
		// Un eseguibile fuori dalla cartella dello shim si rifiuta, anche se esiste.
		const fuori = join(dirname(temp), `${basename(temp)}-fuori.exe`);
		await writeFile(fuori, '', 'utf8');
		try {
			await writeFile(shim, `@ECHO off\r\n"%dp0%\\..\\${basename(fuori)}" %*\r\n`, 'utf8');
			await assert.rejects(resolveCliCommand(shim), /non supportato/);
		} finally { await rm(fuori, { force: true }); }
		// Uno shim in node_modules\.bin può risalire fino a quel node_modules, non oltre.
		const bin = join(temp, 'node_modules', '.bin');
		const pacchetto = join(temp, 'node_modules', 'pacchetto', 'nativa.exe');
		await mkdir(bin, { recursive: true });
		await mkdir(dirname(pacchetto), { recursive: true });
		await writeFile(pacchetto, '', 'utf8');
		const binShim = join(bin, 'nativa.cmd');
		await writeFile(binShim, '@ECHO off\r\n"%dp0%\\..\\pacchetto\\nativa.exe" %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(binShim), { command: pacchetto, args: [] });
		await writeFile(binShim, `@ECHO off\r\n"%dp0%\\..\\..\\bin\\nativa.exe" %*\r\n`, 'utf8');
		await assert.rejects(resolveCliCommand(binShim), /non supportato/);
		// L'eccezione vale solo per node_modules\.bin: da tools\.bin non si risale a tools.
		const toolsBin = join(temp, 'tools', '.bin');
		await mkdir(toolsBin, { recursive: true });
		await writeFile(join(temp, 'tools', 'nativa.exe'), '', 'utf8');
		const toolsShim = join(toolsBin, 'nativa.cmd');
		await writeFile(toolsShim, '@ECHO off\r\n"%dp0%\\..\\nativa.exe" %*\r\n', 'utf8');
		await assert.rejects(resolveCliCommand(toolsShim), /non supportato/);
		// Una cartella interna il cui nome comincia con «..» non è una risalita.
		const puntini = join(temp, '..pkg', 'nativa.exe');
		await mkdir(dirname(puntini), { recursive: true });
		await writeFile(puntini, '', 'utf8');
		await writeFile(shim, '@ECHO off\r\n"%dp0%\\..pkg\\nativa.exe" %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(shim), { command: puntini, args: [] });
		// Una giunzione dentro la cartella dello shim che punta fuori si rifiuta: conta il percorso vero.
		const esterna = await mkdtemp(join(folder, 'cli-esterna-'));
		try {
			await writeFile(join(esterna, 'nativa.exe'), '', 'utf8');
			await symlink(esterna, join(temp, 'giunzione'), 'junction');
			await writeFile(shim, '@ECHO off\r\n"%dp0%\\giunzione\\nativa.exe" %*\r\n', 'utf8');
			await assert.rejects(resolveCliCommand(shim), /non supportato/);
		} finally {
			// rmdir toglie solo la giunzione, non la cartella a cui punta.
			await rmdir(join(temp, 'giunzione')).catch(() => {});
			await rm(esterna, { recursive: true, force: true });
		}
		// Una riga di avvio dentro un blocco tra parentesi o dopo una continuazione con ^ non è l'avvio.
		// Anche con un numero dispari di ^ in fondo, dopo un commento che continua o con due righe di avvio (ambiguo).
		for (const body of ['IF 1==0 (\r\n"%dp0%\\bin\\nativa.exe" %*\r\n)', 'echo ^\r\n"%dp0%\\bin\\nativa.exe" %*', 'echo ^^^\r\n"%dp0%\\bin\\nativa.exe" %*',
			'REM nota ^\r\n"%dp0%\\bin\\nativa.exe" %*', '"%dp0%\\bin\\nativa.exe" %*\r\n"%dp0%\\bin\\nativa.exe" %*']) {
			await writeFile(shim, `@ECHO off\r\n${body}\r\n`, 'utf8');
			await assert.rejects(resolveCliCommand(shim), /non supportato/, body);
		}
		// «^^» in fondo e «^(» sono caratteri letterali: niente continuazione e nessun blocco aperto.
		for (const body of ['echo ^^\r\n"%dp0%\\bin\\nativa.exe" %*', 'echo ^(\r\n"%dp0%\\bin\\nativa.exe" %*']) {
			await writeFile(shim, `@ECHO off\r\n${body}\r\n`, 'utf8');
			assert.deepEqual(await resolveCliCommand(shim), { command: binary, args: [] }, body);
		}
		// Le parentesi dentro le virgolette o nei commenti non aprono un blocco.
		await writeFile(shim, '@ECHO off\r\nREM (nota\r\nSET "x=(a"\r\n"%dp0%\\bin\\nativa.exe" %*\r\n', 'utf8');
		assert.deepEqual(await resolveCliCommand(shim), { command: binary, args: [] });
		await writeFile(shim, '@ECHO off\r\n"%dp0%\\bin\\nativa.exe"   %*\r\n', 'utf8');
		await rm(binary);
		await assert.rejects(resolveCliCommand(shim), /non supportato/);
	} finally { await rm(temp, { recursive: true, force: true }); }
});

test('oscuramento: valori tra virgolette, a capo, non chiusi e «API key» con lo spazio', () => {
	const cases = [
		['Error: API key: "valore fittizio lungo"', /API key: "\[oscurato\]"$/],
		['Error: api_key=abc123def456', /api_key=\[oscurato\]$/],
		// Il testo si oscura prima di dividerlo in righe: il valore su più righe sparisce tutto.
		['Error: password: "prima riga\nseconda riga" fine', /password: "\[oscurato\]" fine$/],
		['Error: "password":"con \\"virgolette\\" dentro", altro', /"password":"\[oscurato\]", altro$/],
		['Error: secret: "non chiusa fino alla fine', /secret: "\[oscurato\]$/],
		["Error: token='a b c' dopo", /token='\[oscurato\]' dopo$/],
		['Error: SECRET_KEY=abcdefvalore', /SECRET_KEY=\[oscurato\]$/],
		['Error: secretKey: "abcdef valore"', /secretKey: "\[oscurato\]"$/],
		['Error: AWS_SECRET_ACCESS_KEY=abcdefvalore', /AWS_SECRET_ACCESS_KEY=\[oscurato\]$/],
		['Error: access_key: abcdefvalore', /access_key: \[oscurato\]$/],
		// Un «Bearer» dentro il valore non deve consumare l'escape della virgoletta e scoprire il resto.
		['Error: password: "x Bearer y\\"riga dopo virgolette" fine', /password: "\[oscurato\]" fine$/],
		// Credenziali Basic dopo Authorization e token GitHub ghu_/ghs_/ghr_; «basic» da solo resta.
		['Error: Authorization: Basic dXNlcjpwYXNzd29yZA== rejected', /Authorization: Basic \[oscurato\] rejected$/],
		['Error: bad credentials ghu_abcdef123456 ghs_abcdef123456 ghr_abcdef123456', /credentials \[oscurato\] \[oscurato\] \[oscurato\]$/],
	];
	for (const [stderr, expected] of cases) {
		const message = describeCliFailure('prova', stderr);
		assert.match(message, expected, stderr);
		assert.doesNotMatch(message, /fittizio|abc123|abcdef|riga|virgolette|chiusa|a b c/, stderr);
	}
	// Continuazione di un valore su più righe con una parola «utile»: l'ultima riga non esce in chiaro né da stdout né da stderr.
	const multi = 'password: "segreto\nancora invalid"\n';
	assert.doesNotMatch(describeCliFailure('prova', '', multi), /segreto|ancora/);
	assert.doesNotMatch(describeCliFailure('prova', 'Error: password: "segreto\nError ancora"\n'), /segreto|ancora/);
	// Virgolette chiuse oltre il limite di 4096 caratteri: si oscura tutto il resto, niente frammenti dopo la prima riga.
	const long = `Error: password: "${'x'.repeat(5000)}\nError riga segreta"\n`;
	assert.doesNotMatch(describeCliFailure('prova', long), /xxxx|riga segreta/);
	// Entro il limite il valore su più righe sparisce comunque per intero.
	assert.doesNotMatch(describeCliFailure('prova', `Error: password: "${'x'.repeat(600)}\nError riga segreta"\n`), /xxxx|riga segreta/);
	// Parole che contengono «key» ma non sono chiavi non si toccano, e nemmeno «basic» senza Authorization.
	assert.match(describeCliFailure('prova', 'Error: monkey=banana'), /monkey=banana/);
	assert.match(describeCliFailure('prova', 'Error: basic setup invalid'), /basic setup invalid/);
	// Gli errori JSON passati da chi li ha già letti valgono al posto di quelli ricavati da stdout.
	const noJson = { message: '', failedMessage: '', failed: false };
	assert.match(describeCliFailure('prova', 'Error: da stderr', '{"type":"turn.failed","error":{"message":"da stdout"}}', noJson), /da stderr/);
	assert.match(describeCliFailure('prova', 'Error: da stderr', '{"type":"turn.failed","error":{"message":"da stdout"}}'), /da stdout/);
});

test('ordine delle cause: turn.failed, poi stderr, poi errori JSON, poi l\'ultima riga di stdout', async () => {
	const original = CLI_AGENTS.codex.buildArgs;
	const runCodex = mode => { CLI_AGENTS.codex.buildArgs = fakeArgs(mode); return runCliAgent({ agent: 'codex', prompt: 'ciao', cwd: folder, command: process.execPath, onText: () => {} }); };
	try {
		await assert.rejects(runCodex('failedstderr'), /model unavailable/);
		await assert.rejects(runCodex('erroronly'), /quota exceeded/);
		await assert.rejects(runCodex('jsonwarnstderr'), error => /invalid model name/.test(error.message) && !/Reconnecting/.test(error.message));
		// turn.failed con un messaggio vince su una riga utile di stderr.
		await assert.rejects(runCodex('failedvsstderr'), error => /context window exceeded/.test(error.message) && !/retrying/.test(error.message));
		// Un ultimo turn.failed vuoto non riusa la causa di un turno precedente: vale stderr.
		await assert.rejects(runCodex('failedtwice'), error => /model unavailable/.test(error.message) && !/vecchia causa/.test(error.message));
		// Di stderr vale l'ultima riga utile.
		await assert.rejects(runCodex('stderrtwo'), error => /quota reached/.test(error.message) && !/retrying/.test(error.message));
		// stderr lungo con un valore oltre 4000 caratteri: si oscura per intero e non esce niente del valore.
		await assert.rejects(runCodex('stderrcut'), error => /password: "\[oscurato\]/.test(error.message) && !/pezzo/.test(error.message));
		await assert.rejects(runCodex('stderrmultiline'), error => /password: "\[oscurato\]/.test(error.message) && !/riga|segreta/.test(error.message));
		// Oltre 1 MiB stderr non si usa: messaggio generico, nessun pezzo del valore.
		await assert.rejects(runCodex('stderrhuge'), error => /Verificare il login/.test(error.message) && !/xxxx|segreta/.test(error.message));
		// Le righe di stack dopo la causa non la sostituiscono.
		await assert.rejects(runCodex('stacktrace'), error => /model unavailable/.test(error.message) && !/handler|main\.js/.test(error.message));
		// Ultimo turn.failed vuoto e stderr vuoto: la causa del turno precedente non torna dal ripiego.
		await assert.rejects(runCodex('failedtwiceempty'), error => /Verificare il login/.test(error.message) && !/vecchia causa/.test(error.message));
		// Colori ANSI nel messaggio JSON, anche dentro il nome della chiave: tolti prima di oscurare.
		await assert.rejects(runCodex('jsonansi'), error => /Error: quota reached password=\[oscurato\]/.test(error.message) && !/segretoansi|\x1b/.test(error.message));
		// Un valore tra virgolette di 1500 caratteri si oscura da solo: la causa scritta dopo resta visibile.
		await assert.rejects(runCodex('longquoted'), error => /quota exceeded/.test(error.message) && !/aaaa/.test(error.message));
	} finally { CLI_AGENTS.codex.buildArgs = original; }
	// CLI a testo: una riga JSON dentro la risposta non è la causa, vale stderr.
	CLI_AGENTS.copilot.buildArgs = fakeArgs('textjson');
	try { await assert.rejects(runFake({}), error => /vera causa su stderr/.test(error.message) && !/finta causa/.test(error.message)); }
	finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
	CLI_AGENTS.copilot.buildArgs = fakeArgs('answerinvalid');
	try { await assert.rejects(runFake({}), error => /Verificare il login/.test(error.message) && !/rejected/.test(error.message)); }
	finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});

test('errore negli eventi JSON di stdout (codex): mostra la causa e oscura i segreti', async () => {
	const original = CLI_AGENTS.codex.buildArgs;
	try {
		CLI_AGENTS.codex.buildArgs = fakeArgs('jsonerror');
		await assert.rejects(runCliAgent({ agent: 'codex', prompt: 'ciao', cwd: folder, command: process.execPath, onText: () => {} }),
			error => /model is not supported/.test(error.message) && !/metadata|stdin|ghp_ABCDEFGHIJKL1234/.test(error.message) && /oscurato/.test(error.message));
		// Uscita 0 ma turno fallito: niente "nessuna risposta" generico, si mostra la causa.
		CLI_AGENTS.codex.buildArgs = fakeArgs('jsonerror0');
		await assert.rejects(runCliAgent({ agent: 'codex', prompt: 'ciao', cwd: folder, command: process.execPath, onText: () => {} }), /Usage limit reached/);
		// Risposta parziale seguita da turn.failed con codice 0: è un errore, e la password tra virgolette sparisce per intero.
		CLI_AGENTS.codex.buildArgs = fakeArgs('partialfailed');
		const updates = [];
		await assert.rejects(runCliAgent({ agent: 'codex', prompt: 'ciao', cwd: folder, command: process.execPath, onText: text => updates.push(text) }),
			error => /stream interrupted/.test(error.message) && !/parole|segrete/.test(error.message) && /password: "\[oscurato\]", retry/.test(error.message) && /oscurato/.test(error.message) && /retry/.test(error.message));
		assert.deepEqual(updates, []);
	} finally { CLI_AGENTS.codex.buildArgs = original; }
});

test('causa su stdout con stderr vuoto (claude senza login), senza segreti nella cronologia', async () => {
	const original = CLI_AGENTS.claude.buildArgs;
	CLI_AGENTS.claude.buildArgs = fakeArgs('stdoutlogin');
	const updates = [];
	try {
		await assert.rejects(runCliAgent({ agent: 'claude', prompt: 'ciao', cwd: folder, command: process.execPath, onText: text => updates.push(text) }),
			error => /Not logged in/.test(error.message) && !/ghp_ABCD/.test(error.message));
		// L'ultimo testo è quello che la chat salva: oscurato, anche se il token era spezzato fra due blocchi.
		assert.ok(updates.length >= 2);
		assert.match(updates.at(-1), /Not logged in.*oscurato/);
		assert.doesNotMatch(updates.at(-1), /ghp_|EFGHIJKL1234/);
		// Nel testo completo salvato in chat una password tra virgolette su più righe sparisce per intero.
		CLI_AGENTS.claude.buildArgs = fakeArgs('multilinepw');
		updates.length = 0;
		await assert.rejects(runCliAgent({ agent: 'claude', prompt: 'ciao', cwd: folder, command: process.execPath, onText: text => updates.push(text) }), /Not logged in/);
		assert.match(updates.at(-1), /password: "\[oscurato\]" fine/);
		assert.doesNotMatch(updates.at(-1), /prima riga|seconda riga/);
	} finally { CLI_AGENTS.claude.buildArgs = original; }
});

test('l\'errore mostra la causa diagnostica ma oscura i segreti', async () => {
	CLI_AGENTS.copilot.buildArgs = fakeArgs('quota');
	try {
		await assert.rejects(runFake({}), error => /quota reached/.test(error.message) && !/abc123SEGRETO|ghp_ABCDEFGHIJKL1234/.test(error.message) && /oscurato/.test(error.message));
	} finally { CLI_AGENTS.copilot.buildArgs = originalArgs; }
});

test('modelli di codex dell\'account dalla sua cache (models_cache.json)', async () => {
	const home = await mkdtemp(join(folder, 'codex-home-'));
	const cache = join(home, 'models_cache.json');
	const write = models => writeFile(cache, JSON.stringify({ fetched_at: '2026-11-24T07:25:46Z', client_version: '0.171.0', models }), 'utf8');
	const savedHome = process.env.CODEX_HOME;
	try {
		// Visibili in ordine di priorità crescente; nascosti, slug non validi, voci non oggetto e duplicati si scartano;
		// una priorità non numerica va in fondo, a parità resta l'ordine del file.
		await write([
			{ slug: 'gpt-reserve', visibility: 'hide', priority: 1 },
			{ slug: 'gpt-5.6-luna', visibility: 'list', priority: 4 },
			{ slug: 'gpt-6-luna', visibility: 'list', priority: 2 },
			null, 'gpt-falso', 7,
			{ slug: '-c', visibility: 'list', priority: 0 },
			{ slug: '__custom__', visibility: 'list', priority: 0 },
			{ slug: 42, visibility: 'list', priority: 0 },
			{ slug: 'senza-priorita', visibility: 'list', priority: 'alta' },
			{ slug: 'gpt-5.6-terra', visibility: 'list', priority: 3 },
			{ slug: 'gpt-6-luna', visibility: 'list', priority: 9 },
			{ slug: 'ultimo', visibility: 'list' },
		]);
		assert.deepEqual(await listCliAgentModels('codex', home), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'senza-priorita', 'ultimo']);
		// Le altre IA non hanno una cache: elenco vuoto. Anche «constructor» non legge niente.
		assert.deepEqual(await listCliAgentModels('claude', home), []);
		assert.deepEqual(await listCliAgentModels('constructor', home), []);
		// CODEX_HOME vale come cartella predefinita.
		process.env.CODEX_HOME = home;
		assert.deepEqual((await listCliAgentModels('codex')).slice(0, 1), ['gpt-6-luna']);
		// Un CODEX_HOME relativo non si risolve dalla cartella dell'app: codex lo risolverebbe dal workspace. Il percorso
		// relativo punta davvero alla cache, quindi senza il controllo il test troverebbe i modelli.
		const relativeHome = relative(process.cwd(), home);
		assert.ok(relativeHome && !isAbsolute(relativeHome));
		process.env.CODEX_HOME = relativeHome;
		assert.deepEqual(await listCliAgentModels('codex'), []);
		assert.deepEqual(await listCliAgentModels('codex', relativeHome), []);
		if (process.platform === 'win32') {
			// «\cartella» senza unità dipende dall'unità corrente: anche se qui punta alla cache, non vale.
			assert.equal(home.slice(1, 2), ':');
			assert.deepEqual(await listCliAgentModels('codex', home.slice(2)), []);
			assert.deepEqual(await listCliAgentModels('codex', home.slice(2).replaceAll('\\', '/')), []);
			// Con l'unità valgono sia le barre rovesciate sia quelle normali.
			assert.deepEqual((await listCliAgentModels('codex', home.replaceAll('\\', '/'))).slice(0, 1), ['gpt-6-luna']);
		}
		// Esattamente 1 MiB si legge per intero; un byte in più no.
		const sized = async bytes => {
			const base = JSON.stringify({ models: [{ slug: 'limite', visibility: 'list', priority: 1 }], pad: '' });
			await writeFile(cache, base.replace('"pad":""', `"pad":"${'x'.repeat(bytes - base.length)}"`), 'utf8');
			return listCliAgentModels('codex', home);
		};
		assert.deepEqual(await sized(1024 * 1024), ['limite']);
		assert.deepEqual(await sized(1024 * 1024 + 1), []);
		// Al massimo 20 modelli.
		await write(Array.from({ length: 30 }, (_, index) => ({ slug: `m${index}`, visibility: 'list', priority: index })));
		assert.equal((await listCliAgentModels('codex', home)).length, 20);
		// JSON non valido, forma inattesa, file oltre 1 MiB, cartella al posto del file, file assente: elenco vuoto.
		await writeFile(cache, '{ non valido', 'utf8');
		assert.deepEqual(await listCliAgentModels('codex', home), []);
		await writeFile(cache, JSON.stringify({ models: { slug: 'x' } }), 'utf8');
		assert.deepEqual(await listCliAgentModels('codex', home), []);
		await writeFile(cache, JSON.stringify({ models: [{ slug: 'grande', visibility: 'list', priority: 1, pad: 'x'.repeat(1100 * 1024) }] }), 'utf8');
		assert.deepEqual(await listCliAgentModels('codex', home), []);
		await rm(cache);
		assert.deepEqual(await listCliAgentModels('codex', home), []);
		await mkdir(cache);
		assert.deepEqual(await listCliAgentModels('codex', home), []);
	} finally {
		if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
		await rm(home, { recursive: true, force: true });
	}
});

test('ricerca nel PATH senza where.exe/which: percorsi accentati, cartelle relative ignorate, percorso tra virgolette', async () => {
	// where.exe scriveva i percorsi nella code page OEM: una cartella con lettere accentate rendeva la CLI «non trovata».
	const temp = await mkdtemp(join(tmpdir(), 'vox-path-'));
	const savedPath = process.env.PATH;
	try {
		const accented = join(temp, 'Niccolò àèìòù');
		const other = join(temp, 'altra');
		await mkdir(accented); await mkdir(other);
		const name = 'cli-finta';
		const binary = join(accented, process.platform === 'win32' ? `${name}.exe` : name);
		await writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });
		// Una cartella con lo stesso nome e (fuori da Windows) un file non eseguibile non contano.
		await mkdir(join(other, process.platform === 'win32' ? `${name}.exe` : name));
		if (process.platform !== 'win32') { await mkdir(join(temp, 'noexec')); await writeFile(join(temp, 'noexec', name), '', { mode: 0o644 }); }
		process.env.PATH = ['relativa', join(temp, 'noexec'), `"${other}"`, accented, accented].join(delimiter);
		// Su Windows l'estensione arriva da PATHEXT (.EXE): il file system non distingue maiuscole e minuscole.
		const found = await resolveCliCommand(name);
		assert.deepEqual(process.platform === 'win32' ? { ...found, command: found.command.toLowerCase() } : found, { command: process.platform === 'win32' ? binary.toLowerCase() : binary, args: [] });
		// Un nome con separatori non si cerca nel PATH (i percorsi relativi non sono supportati).
		await assert.rejects(resolveCliCommand(join('Niccolò àèìòù', name)), /non trovata/);
		// «Copia come percorso» di Esplora file mette il percorso tra virgolette.
		assert.deepEqual(await resolveCliCommand(`  "${binary}" `), { command: binary, args: [] });
		process.env.PATH = '';
		await assert.rejects(resolveCliCommand(name), /non trovata/);
	} finally {
		process.env.PATH = savedPath;
		await rm(temp, { recursive: true, force: true });
	}
});

test('un discendente che tiene aperto stdout non blocca la risposta né il timeout', { skip: process.platform === 'win32' && 'su Windows il discendente staccato eredita la console, non la pipe' }, async () => {
	CLI_AGENTS.copilot.buildArgs = fakeArgs('orphan');
	let orphan;
	try {
		const started = Date.now();
		const answer = await runFake({ timeoutMs: 20000, onText: text => { orphan ??= Number(text.split('\n')[0]); } });
		assert.match(answer, /risposta completa$/);
		assert.ok(Date.now() - started < 10000, 'la risposta arriva poco dopo l’uscita della CLI');
	} finally {
		CLI_AGENTS.copilot.buildArgs = originalArgs;
		try { process.kill(orphan); } catch { }
	}
});

test('stdin chiuso da una CLI che esce subito: si vede la causa vera, non l’errore di scrittura', async () => {
	const original = CLI_AGENTS.claude.buildArgs;
	const prompt = 'x'.repeat(2_000_000);
	try {
		CLI_AGENTS.claude.buildArgs = () => [fixture, 'noread'];
		await assert.rejects(runCliAgent({ agent: 'claude', prompt, cwd: folder, command: process.execPath, onText: () => {} }), error => /Not logged in/.test(error.message) && !/stdin/.test(error.message));
		// Una CLI che legge tutto stdin risponde normalmente.
		CLI_AGENTS.claude.buildArgs = () => [fixture, 'stdinecho'];
		const answer = await runCliAgent({ agent: 'claude', prompt, cwd: folder, command: process.execPath, onText: () => {} });
		assert.ok(Number(answer.replace('letti ', '')) > prompt.length, answer);
		// Con codice 0 il prompt non è arrivato per intero: errore, non una risposta a un prompt troncato.
		CLI_AGENTS.claude.buildArgs = () => [fixture, 'noread0'];
		await assert.rejects(runCliAgent({ agent: 'claude', prompt, cwd: folder, command: process.execPath, onText: () => {} }), /stdin/);
	} finally { CLI_AGENTS.claude.buildArgs = original; }
});

test('parser kimi e agy: testo con tool_calls, step tool_call e result.response', () => {
	// kimi: il testo che accompagna una chiamata a strumento non è la risposta (filtro della documentazione di kimi).
	assert.equal(CLI_AGENTS.kimi.parseOutput([
		{ role: 'meta', type: 'system.version', version: '2.7.3' },
		{ role: 'assistant', content: 'finale' },
		{ role: 'assistant', content: 'Ora leggo il file', tool_calls: [{ type: 'function', id: '1', function: { name: 'Read', arguments: '{}' } }] },
		{ role: 'tool', tool_call_id: '1', content: 'nascosto' },
		{ role: 'meta', type: 'session.resume_hint', session_id: 's', command: 'kimi -r s', content: 'To resume this session: kimi -r s' },
	].map(event => JSON.stringify(event)).join('\r\n')), 'finale');
	// agy: «tool_call» azzera come «tool»; senza text_delta vale result.response; righe con CRLF.
	assert.equal(CLI_AGENTS.agy.parseOutput([
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Leggo ' } },
		{ event: 'step_update', step_update: { step_type: 'tool_call', tool_name: 'view_file' } },
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'fin' } },
		{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ale' } },
		{ event: 'result', result: { status: 'SUCCESS', response: 'Leggo finale' } },
	].map(event => JSON.stringify(event)).join('\r\n')), 'finale');
	assert.equal(CLI_AGENTS.agy.parseOutput(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: ' solo risultato ' } })), 'solo risultato');
	// codex con righe CRLF (Windows).
	assert.equal(CLI_AGENTS.codex.parseOutput('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}\r\n{"type":"turn.completed","usage":{}}\r\n'), 'ok');
});
