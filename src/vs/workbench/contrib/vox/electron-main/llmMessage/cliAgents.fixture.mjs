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
if (mode === 'quota') {
	process.stderr.write('altra riga\nError: Individual quota reached. Authorization: Bearer abc123SEGRETO token=ghp_ABCDEFGHIJKL1234\n');
	process.exitCode = 1;
}
