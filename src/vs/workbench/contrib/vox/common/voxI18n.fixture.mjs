// Esegue il modulo reale con un locale controllato, senza avviare il workbench.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('./voxI18n.ts', import.meta.url), 'utf8');
const body = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/m, '').replace(/^export /gm, ''));
export const loadI18n = language => new Function('language', body + '; return { it, t };')(language);
export const evaluate = (...args) => new Function('t', ...args).bind(null, loadI18n('it').t);

export async function loadCliAgents() {
	const cli = await readFile(new URL('../electron-main/llmMessage/cliAgents.ts', import.meta.url), 'utf8');
	const code = stripTypeScriptTypes(cli.replace(/^import \{ t \}.*;\r?\n/m, ''));
	return import('data:text/javascript;base64,' + Buffer.from("const language = 'it';\n" + body + '\n' + code).toString('base64'));
}
