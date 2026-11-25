// CLI finta: nessun account, rete o segreto necessario.
import { spawn } from 'node:child_process';
const [, , mode, prompt] = process.argv;
if (mode === 'echo') {
	process.stdout.write('inizio');
	setTimeout(() => process.stdout.write('\n' + prompt), 150);
} else if (mode === 'tree' || mode === 'hold') {
	const child = mode === 'tree' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) : null;
	process.stdout.write(JSON.stringify(child ? [process.pid, child.pid] : [process.pid]));
	setInterval(() => {}, 1000);
} else if (mode === 'error') {
	process.stderr.write('DATO_RISERVATO');
	process.exitCode = 1;
}
if (mode === 'jsonerror') {
	// Come codex: l'errore vero sta negli eventi JSON di stdout; l'avviso "item.completed" non deve prevalere.
	process.stderr.write('Reading additional input from stdin...\n');
	process.stdout.write([
		{ type: 'thread.started', thread_id: 'x' },
		{ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata not found. Defaulting to fallback metadata.' } },
		{ type: 'error', message: "The 'modello-x' model is not supported. token=ghp_ABCDEFGHIJKL1234" },
		{ type: 'turn.failed', error: { message: "The 'modello-x' model is not supported. token=ghp_ABCDEFGHIJKL1234" } },
	].map(event => JSON.stringify(event)).join('\n') + '\n');
	process.exitCode = 1;
}
if (mode === 'jsonerror0') {
	process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Usage limit reached, try again later' } }) + '\n');
}
if (mode === 'partialfailed') {
	// Risposta parziale e poi turno fallito, con codice 0 e una password tra virgolette con spazi.
	process.stdout.write([
		{ type: 'item.completed', item: { type: 'agent_message', text: 'risposta a metà' } },
		{ type: 'turn.failed', error: { message: 'stream interrupted: password: "tre parole segrete", retry' } },
	].map(event => JSON.stringify(event)).join('\n') + '\n');
}
if (mode === 'failedstderr') {
	// Turno fallito senza messaggio, codice 0, causa solo su stderr.
	process.stdout.write(JSON.stringify({ type: 'turn.failed', error: {} }) + '\n');
	process.stderr.write('Error: model unavailable\n');
}
if (mode === 'failedvsstderr') {
	process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } }) + '\n');
	process.stderr.write('Error: retrying request\n');
}
if (mode === 'failedtwice') {
	process.stdout.write([{ type: 'turn.failed', error: { message: 'vecchia causa' } }, { type: 'turn.failed', error: {} }].map(event => JSON.stringify(event)).join('\n') + '\n');
	process.stderr.write('Error: model unavailable\n');
}
if (mode === 'stderrtwo') {
	process.stderr.write('Error: retrying request\nError: quota reached\n');
	process.exitCode = 1;
}
if (mode === 'stderrcut') {
	// L'ultima riga è un valore lungo (oltre 4000 caratteri): tagliato, il pezzo rimasto (che contiene «Error») resterebbe
	// senza il nome della chiave e non si potrebbe oscurare.
	process.stderr.write(`Error: quota reached\nError: password: "${'pezzo Error '.repeat(600)}"\n`);
	process.exitCode = 1;
}
if (mode === 'stderrmultiline') {
	// Valore su più righe che supera i 4000 caratteri: la sua ultima riga contiene «Error» e non deve uscire.
	process.stderr.write(`Error: quota reached\nError: password: "inizio\n${'riga\n'.repeat(1000)}fine Error segreta"\n`);
	process.exitCode = 1;
}
if (mode === 'stderrhuge') {
	// Oltre 1 MiB di stderr: non si usa per la diagnosi, quindi messaggio generico e nessun segreto.
	process.stderr.write(`Error: password: "${'x'.repeat(1100 * 1024)}\nError: ultima riga segreta"\n`);
	process.exitCode = 1;
}
if (mode === 'stacktrace') {
	// La causa viene prima delle righe di stack, che contengono anch'esse «Error».
	process.stderr.write('Error: model unavailable\n    at run (C:\\cli\\main.js:10:5)\n    at Error.handler (C:\\cli\\errors.js:3:1)\n');
	process.exitCode = 1;
}
if (mode === 'failedtwiceempty') {
	// Due turni falliti, l'ultimo senza messaggio, e stderr vuoto: la causa del primo turno non deve tornare.
	process.stdout.write([{ type: 'turn.failed', error: { message: 'vecchia causa' } }, { type: 'turn.failed', error: {} }].map(event => JSON.stringify(event)).join('\n') + '\n');
	process.exitCode = 1;
}
if (mode === 'erroronly') {
	// Solo un evento error, nessuna risposta, codice 0.
	process.stdout.write(JSON.stringify({ type: 'error', message: 'Reconnecting failed: quota exceeded' }) + '\n');
}
if (mode === 'jsonwarnstderr') {
	// Errore JSON non fatale e causa vera su stderr, uscita 1: vale stderr.
	process.stdout.write(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }) + '\n');
	process.stderr.write('Error: invalid model name\n');
	process.exitCode = 1;
}
if (mode === 'answerinvalid') {
	// Risposta con «invalid» a metà e ultima riga senza causa, uscita 1: messaggio generico, non una frase della risposta.
	process.stdout.write('the invalid token was rejected by the server\nho finito qui\n');
	process.exitCode = 1;
}
if (mode === 'multilinepw') {
	process.stdout.write('password: "prima riga\nseconda riga" fine\nNot logged in · Please run /login\n');
	process.exitCode = 1;
}
if (mode === 'stdoutlogin') {
	// Come claude senza login: la causa è su stdout e stderr è vuoto. Il token è spezzato fra due blocchi di stdout.
	process.stdout.write('Not logged in · Please run /login token=ghp_ABCD');
	setTimeout(() => { process.stdout.write('EFGHIJKL1234\n'); process.exitCode = 1; }, 150);
}
if (mode === 'jsonansi') {
	// Messaggio di turn.failed con colori ANSI, anche dentro il nome della chiave.
	process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: '\u001b[31mError:\u001b[0m quota reached pass\u001b[1mword=segretoansi123' } }) + '\n');
	process.exitCode = 1;
}
if (mode === 'textjson') {
	// CLI a testo la cui risposta contiene una riga JSON di turn.failed: la causa vera è su stderr.
	process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'finta causa nella risposta' } }) + '\n');
	process.stderr.write('Error: vera causa su stderr\n');
	process.exitCode = 1;
}
if (mode === 'longquoted') {
	// Un valore tra virgolette lungo come un JWT (1500 caratteri) e poi la causa vera.
	process.stderr.write(`Error: token: "${'a'.repeat(1500)}"\nError: quota exceeded\n`);
	process.exitCode = 1;
}
if (mode === 'quota') {
	process.stderr.write('altra riga\nError: Individual quota reached. Authorization: Bearer abc123SEGRETO token=ghp_ABCDEFGHIJKL1234\n');
	process.exitCode = 1;
}
if (mode === 'orphan') {
	// La CLI risponde ed esce, ma lascia un discendente staccato (altro gruppo di processi) che tiene aperto stdout.
	const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
	orphan.unref();
	process.stdout.write(`${orphan.pid}\nrisposta completa`);
}
if (mode === 'noread' || mode === 'noread0') {
	// Esce subito senza leggere il prompt da stdin (login mancante): la scrittura del prompt fallisce con EPIPE.
	if (mode === 'noread') { process.stderr.write('Error: Not logged in · Please run /login\n'); process.exitCode = 1; }
	else process.stdout.write('risposta senza prompt');
	process.stdin.destroy();
}
if (mode === 'stdinecho') {
	// Legge tutto il prompt da stdin e risponde con la sua lunghezza.
	let length = 0;
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', chunk => { length += chunk.length; });
	process.stdin.on('end', () => process.stdout.write(`letti ${length}`));
}
if (mode === 'run') {
	// Come `opencode run --format json`: un evento text con gli argomenti, PWD, la cartella corrente e la configurazione ricevuti.
	const received = { args: process.argv.slice(2), pwd: process.env.PWD, cwd: process.cwd(), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || 'null') };
	process.stdout.write(JSON.stringify({ type: 'step_start', part: {} }) + '\n' + JSON.stringify({ type: 'text', part: { text: JSON.stringify(received) } }) + '\n');
}
