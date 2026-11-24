// Generatore dei messaggi di commit: i comandi git del processo principale (electron-main/voxSCMMainService.ts),
// provati su un repository vero in una cartella temporanea.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const sourceFile = new URL('../electron-main/voxSCMMainService.ts', import.meta.url);
const source = readFileSync(sourceFile, 'utf8');

// il file importa solo il tipo dell'interfaccia: si toglie, il resto si carica com'è
const work = mkdtempSync(join(tmpdir(), 'vox-scm-test-'));
const modulePath = join(work, 'voxSCMMainService.mjs');
writeFileSync(modulePath, stripTypeScriptTypes(source.replace(/^import \{ IVoxSCMService \}.*$/m, '')));
const { VoxSCMService, parseNumStatZ } = await import(pathToFileURL(modulePath).href);
const scm = new VoxSCMService();

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const newRepo = name => {
	const dir = join(work, name);
	execFileSync('git', ['init', '-q', dir]);
	for (const [k, v] of [['user.email', 'vox@example.invalid'], ['user.name', 'Vox'], ['commit.gpgsign', 'false']]) execFileSync('git', ['config', k, v], { cwd: dir });
	return dir;
};

test.after(() => rmSync(work, { recursive: true, force: true }));

test('nessuna shell: git si avvia con execFile e argomenti separati', () => {
	assert.doesNotMatch(source, /\bexec\s*\(|promisify\(_exec\)|shell:\s*true/);
	assert.match(source, /execFile\('git', args/);
	// il nome del file passa dopo `--`, come argomento a sé
	assert.match(source, /'--', file\]/);
});

test('parseNumStatZ: nomi con tabulazioni, spazi e virgolette, file binari, uscita vuota', () => {
	assert.deepEqual(parseNumStatZ(''), []);
	assert.deepEqual(parseNumStatZ('3\t1\ta b.txt\0-\t-\timg.png\0' + '2\t0\tx"y\tz.txt\0'), [
		{ file: 'a b.txt', added: 3, removed: 1 },
		{ file: 'img.png', added: 0, removed: 0 },
		{ file: 'x"y\tz.txt', added: 2, removed: 0 },
	]);
});

test('un nome di file con $(…) o virgolette non diventa un comando', { skip: !hasGit || process.platform === 'win32' }, async () => {
	const dir = newRepo('nomi');
	// un comando eseguito dalla shell (che parte nella cartella del repository) creerebbe questo file
	const marker = join(dir, 'ESEGUITO');
	const evil = 'a$(touch ESEGUITO).txt';
	const quoted = 'b"; touch ESEGUITO; ".txt';
	writeFileSync(join(dir, evil), 'uno\n');
	writeFileSync(join(dir, quoted), 'due\n');
	execFileSync('git', ['add', '-A'], { cwd: dir });
	const diffs = await scm.gitSampledDiffs(dir);
	assert.equal(existsSync(marker), false, 'il nome del file è stato eseguito dalla shell');
	assert.ok(diffs.includes(`==== ${evil} ====`), diffs);
	assert.ok(diffs.includes(`==== ${quoted} ====`), diffs);
	assert.match(diffs, /\+uno/);
	assert.match(await scm.gitStat(dir), /2 files changed/);
});

test('repository senza commit: la cronologia è vuota, non un errore', { skip: !hasGit }, async () => {
	const dir = newRepo('vuoto');
	writeFileSync(join(dir, 'a.txt'), 'x\n');
	execFileSync('git', ['add', 'a.txt'], { cwd: dir });
	assert.equal(await scm.gitLog(dir), '');
	assert.match(await scm.gitSampledDiffs(dir), /==== a\.txt ====/);
});

test('gli avvisi di git su stderr (fine riga CRLF) non fanno fallire la generazione', { skip: !hasGit }, async () => {
	const dir = newRepo('crlf');
	execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: dir });
	writeFileSync(join(dir, 'x.txt'), 'a\nb\n');
	execFileSync('git', ['add', 'x.txt'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['commit', '-qm', 'primo'], { cwd: dir, stdio: 'ignore' });
	writeFileSync(join(dir, 'x.txt'), 'a\nc\n');
	assert.match(await scm.gitStat(dir), /x\.txt/);
	assert.match(await scm.gitSampledDiffs(dir), /\+c/);
	assert.match(await scm.gitLog(dir), /\|primo\|/);
});

test('fuori da un repository git l\'errore arriva a chi chiama', { skip: !hasGit }, async () => {
	await assert.rejects(scm.gitStat(work));
});
