// Completezza della traduzione italiana: ogni testo passato a t() nel codice di Vox deve avere la sua voce
// nel dizionario, il dizionario non deve tenere voci che nessuno usa, e i componenti React non devono
// mostrare testi inglesi scritti direttamente negli attributi visibili.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadI18n } from './voxI18n.fixture.mjs';

const voxRoot = fileURLToPath(new URL('..', import.meta.url));
const { it } = loadI18n('it');

// src2 è la copia generata da buildreact: si controlla solo il sorgente
const skippedFolders = new Set(['src2', 'out', 'node_modules']);
const sourceFiles = [];
const walk = folder => {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) { if (!skippedFolders.has(name)) walk(path); }
		else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) sourceFiles.push(path);
	}
};
walk(voxRoot);

// t() si usa anche fuori dal codice di Vox (per esempio nella schermata vuota dell'editor): si leggono anche
// i file di src/vs che importano il dizionario
const vsRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const externalFiles = [];
const walkImporters = folder => {
	for (const name of readdirSync(folder)) {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) { if (!skippedFolders.has(name) && relative(path, voxRoot) !== '') walkImporters(path); }
		else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && readFileSync(path, 'utf8').includes('contrib/vox/common/voxI18n.js')) externalFiles.push(path);
	}
};
walkImporters(vsRoot);
sourceFiles.push(...externalFiles);

const relativePath = path => relative(voxRoot, path).split(sep).join('/');
// Toglie i commenti, così il codice commentato non conta. Le stringhe si saltano intere, così un '/*' o un '//'
// scritto dentro una stringa non apre un commento; un // conta come commento a inizio riga o dopo uno spazio.
const withoutComments = source => {
	let out = '', i = 0;
	while (i < source.length) {
		const c = source[i];
		if (c === '"' || c === '\'' || c === '\x60') {
			let j = i + 1;
			while (j < source.length && source[j] !== c && (c === '\x60' || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
			out += source.slice(i, j + 1); i = j + 1;
		} else if (c === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2), stop = end < 0 ? source.length : end + 2;
			out += source.slice(i, stop).replace(/[^\n]/g, ' '); i = stop;
		} else if (c === '/' && source[i + 1] === '/' && (i === 0 || /\s/.test(source[i - 1]))) {
			const end = source.indexOf('\n', i);
			i = end < 0 ? source.length : end;
		} else { out += c; i++; }
	}
	return out.replace(/\r\n/g, '\n');
};
const sources = sourceFiles
	.filter(path => !path.endsWith(join('common', 'voxI18n.ts')))
	.map(path => ({ file: relativePath(path), code: withoutComments(readFileSync(path, 'utf8')) }));

const literal = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\$]|\\.)*\x60`;
const evaluateLiteral = text => new Function(`return ${text}`)();
const lineOf = (code, index) => code.slice(0, index).split('\n').length;

// t("testo") e t(condizione ? "uno" : "più"), anche con uno spazio prima della parentesi
const directCall = new RegExp(String.raw`(?<![\w.$])t\s*\(\s*(${literal})\s*[,)]`, 'g');
const ternaryCall = new RegExp(String.raw`(?<![\w.$])t\s*\(\s*[^"'\x60()?]+\?\s*(${literal})\s*:\s*(${literal})\s*[,)]`, 'g');
const anyCall = /(?<![\w.$'’])t\s*\(/g;

const literalKeys = new Map();
const dynamicCalls = [];
for (const { file, code } of sources) {
	const covered = new Set();
	for (const match of code.matchAll(directCall)) {
		covered.add(match.index);
		literalKeys.set(evaluateLiteral(match[1]), `${file}:${lineOf(code, match.index)}`);
	}
	for (const match of code.matchAll(ternaryCall)) {
		covered.add(match.index);
		for (const text of [match[1], match[2]]) literalKeys.set(evaluateLiteral(text), `${file}:${lineOf(code, match.index)}`);
	}
	for (const match of code.matchAll(anyCall)) {
		if (covered.has(match.index)) continue;
		const after = match.index + match[0].length;
		const argument = code.slice(after).match(/^\s*([\w.]+)\s*\)/);
		dynamicCalls.push(`${file} t(${argument ? argument[1] : code.slice(after, after + 38).split('\n')[0]})`);
	}
}

const sourceOf = file => sources.find(source => source.file === file)?.code ?? assert.fail(`File mancante: ${file}`);
const quotedValues = text => [...text.matchAll(/'([^'\n]+)'/g)].map(match => match[1]);

// Testi passati a t() attraverso una variabile: per ognuno, da dove arrivano i valori possibili
const dynamicSources = {
	// tipi di approvazione automatica degli strumenti
	'browser/react/src/sidebar-tsx/SidebarChat.tsx t(approvalType)': () => {
		const types = sourceOf('common/toolsServiceTypes.ts');
		const block = types.match(/approvalTypeOfBuiltinToolName[^=]*=\s*\{([\s\S]*?)\n\}/)[1];
		const values = block.split('\n').map(line => line.split(':')[1]).filter(Boolean).flatMap(quotedValues);
		const extra = quotedValues(types.match(/toolApprovalTypes\s*=[\s\S]*?\]\)/)[0]);
		return [...values, ...extra];
	},
	'browser/react/src/vox-settings-tsx/Settings.tsx t(approvalType)': () => dynamicSources['browser/react/src/sidebar-tsx/SidebarChat.tsx t(approvalType)'](),
	// schede della prima configurazione
	'browser/react/src/vox-onboarding/VoxOnboarding.tsx t(tab)': () => quotedValues(sourceOf('browser/react/src/vox-onboarding/VoxOnboarding.tsx').match(/const tabNames = \[[^\]]*\]/)[0]),
	'browser/react/src/vox-onboarding/VoxOnboarding.tsx t(currentTab)': () => dynamicSources['browser/react/src/vox-onboarding/VoxOnboarding.tsx t(tab)'](),
	// importazione ed esportazione di impostazioni e chat
	'browser/react/src/vox-settings-tsx/Settings.tsx t(kind)': () => quotedValues(sourceOf('browser/react/src/vox-settings-tsx/Settings.tsx').match(/const onDownload = \(kind: ([^)]*)\)/)[1]),
	// livello di ragionamento scelto dal cursore (OpenAI: low, medium, high), con l'iniziale maiuscola
	'browser/react/src/sidebar-tsx/SidebarChat.tsx t(currentEffortCapitalized)': () => ['Low', 'Medium', 'High'],
};

const dynamicKeys = new Map();
for (const call of new Set(dynamicCalls)) {
	const source = dynamicSources[call];
	if (!source) continue;
	for (const key of source()) dynamicKeys.set(key, call);
}

test('ogni chiamata a t() con un testo variabile ha i suoi valori noti', () => {
	const unknown = [...new Set(dynamicCalls)].filter(call => !dynamicSources[call]);
	assert.deepEqual(unknown, [], 'Testo variabile senza elenco dei valori nel test: aggiungilo a dynamicSources');
	const stale = Object.keys(dynamicSources).filter(call => !dynamicCalls.includes(call));
	assert.deepEqual(stale, [], 'Voce di dynamicSources che non corrisponde più al codice');
	assert.ok(literalKeys.size > 400, `Troppo poche chiavi trovate (${literalKeys.size}): il test non legge più i sorgenti`);
	assert.ok(externalFiles.length > 0, 'Nessun file fuori da Vox importa il dizionario: controllare la ricerca degli importatori');
});

test('ogni testo passato a t() ha la traduzione italiana', () => {
	const missing = [...literalKeys, ...dynamicKeys].filter(([key]) => !Object.hasOwn(it, key)).map(([key, where]) => `${JSON.stringify(key)} (${where})`);
	assert.deepEqual(missing, []);
});

test('il dizionario non tiene voci che nessuno usa', () => {
	const unused = Object.keys(it).filter(key => !literalKeys.has(key) && !dynamicKeys.has(key));
	assert.deepEqual(unused, []);
});

test('i testi passati a t() sono fissi', () => {
	const templates = [];
	for (const { file, code } of sources) {
		for (const match of code.matchAll(/(?<![\w.$])t\s*\(\s*\x60[^\x60]*\$\{/g)) templates.push(`${file}:${lineOf(code, match.index)}`);
	}
	assert.deepEqual(templates, [], 'Usa i segnaposto {0} invece di ${...}: il dizionario cerca il testo esatto');
});

// Attributi che l'utente vede o che legge il lettore di schermo, scritti come title="..." o title={"..."}
const visibleAttribute = /\b(placeholder|title|aria-label|ariaLabel|data-tooltip-content|toolTipName|tooltipName|desc)\s*=\s*\{?\s*(["'\x60])([^"'\x60\n]*)\2/g;
// title={...}: l'espressione può andare a capo e contenere graffe (template con ${...}, oggetti) fino a tre livelli
const visibleAttributeExpression = /\b(placeholder|title|aria-label|ariaLabel|data-tooltip-content|toolTipName|tooltipName|desc)\s*=\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
// Esempi di valori da scrivere, che restano uguali in ogni lingua
const untranslatableValues = new Set(['https://huggingface.co/.../model.gguf', 'qwen2.5-7b']);
// parole del codice che possono stare fra } e { o fra > e { senza essere testo visibile (} else {, Foo<T> implements Bar {)
const codeKeywords = /^\s*(else|catch|finally|extends|implements|as|satisfies)\b/;
// svuota il contenuto delle stringhe (stessa lunghezza, così i numeri di riga restano giusti): le regole sul testo
// fra i tag non devono leggere dentro t("Diff {0} of {1}")
const withoutStrings = code => code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60/g, text => text[0] + text.slice(1, -1).replace(/[^\n]/g, ' ') + text.at(-1));
const hasWords = text => /[A-Za-z]{2,}/.test(text);
// i pezzi ${...} di un template vengono da valori già tradotti altrove: conta solo il testo fisso che resta
const withoutPlaceholders = text => text.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}?/g, '');

// Testi inglesi scritti direttamente in un componente (codice già senza commenti): restituisce [indice, descrizione]
const englishInComponent = code => {
	const found = [];
	for (const match of code.matchAll(visibleAttribute)) {
		const value = match[3];
		if (hasWords(withoutPlaceholders(value)) && !untranslatableValues.has(value)) found.push([match.index, `${match[1]}="${value}"`]);
	}
	// un attributo calcolato che attacca un testo fisso, come title={n + ' messages'}: si tolgono le chiamate a t()
	// intere (anche con un ternario o altri argomenti), i confronti (typeof x === 'string') e gli argomenti delle
	// funzioni (nome('Apply'))
	for (const match of code.matchAll(visibleAttributeExpression)) {
		const rest = match[2]
			.replace(/(?<![\w.$])t\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, '')
			.replace(/[!=]==?\s*(["'])(?:[^"'\\]|\\.)*\1/g, '')
			.replace(/[\w$]\s*\(\s*(["'])(?:[^"'\\]|\\.)*\1\s*\)/g, '');
		const texts = [...rest.matchAll(/(["'\x60])((?:[^"'\x60\\]|\\.)*)\1/g)].map(text => withoutPlaceholders(text[2])).filter(hasWords);
		if (texts.length) found.push([match.index, `${match[1]}={… ${texts.map(text => JSON.stringify(text)).join(', ')} …}`]);
	}
	const visible = withoutStrings(code);
	// testo fra due tag JSX, come <span>Testo</span>
	for (const match of visible.matchAll(/>\s*([A-Za-z][A-Za-z'’ ,.!?:-]*[A-Za-z.!?])\s*<\//g)) {
		// sigle e il nome del programma restano uguali in ogni lingua
		if (!['MCP', 'Vox'].includes(match[1])) found.push([match.index, `testo "${match[1]}"`]);
	}
	// testo dopo un'espressione JSX, come <span>{n} diff{…}</span> o {n} diffs seguito da un a capo e </span>
	for (const match of visible.matchAll(/\}([ \t]*[A-Za-z][A-Za-z'’ ,.!?:-]*?)\s*(?:\{|<)/g)) {
		if (!codeKeywords.test(match[1])) found.push([match.index, `testo "${match[1].trim()}"`]);
	}
	// testo prima di un'espressione JSX, come <span>Total {n}</span>
	for (const match of visible.matchAll(/>[ \t]*([A-Za-z][A-Za-z'’ ,.!?:-]*?)[ \t]*\{/g)) {
		if (!codeKeywords.test(match[1])) found.push([match.index, `testo "${match[1].trim()}"`]);
	}
	return found;
};

test('il controllo dei testi inglesi riconosce i casi noti e lascia passare quelli tradotti', () => {
	const flagged = code => englishInComponent(withoutComments(code)).length > 0;
	for (const sample of [
		'<span title={n + \' messages\'} />',
		'<span\n\tdata-tooltip-content={n +\n\t\t\' messages\'}\n/>',
		'<span title={t("{0} files", n) + \' left\'} />',
		'<span>{n} diff{n !== 1 ? "s" : ""}</span>',
		'<span>{n} diffs\n</span>',
		'<span>Total {n}</span>',
		'<span>{i} of {n}</span>',
		'<span>Done</span>',
		'<div ariaLabel={`${modelName}: Show in Dropdown`} />',
		'<div title="Delete" />',
		'<div title={"Delete"} />',
	]) assert.equal(flagged(sample), true, sample);
	for (const sample of [
		'<span title={t("{0} messages", n)} />',
		'<span title={t(open ? "Close" : "Open")} />',
		'<span title={t("Delete {0}", \'nome file\')} />',
		'<span>{t(n === 1 ? "{0} change" : "{0} changes", n)}</span>',
		'<div aria-label={typeof tip === \'string\' ? tip : undefined} />',
		'<div ariaLabel={displayInfoOfFeatureName(\'Apply\')} />',
		'<div data-tooltip-content={`${label ? `${label}` : \'\'}`} />',
		'<div placeholder={`${title} (${placeholder})`} />',
		'if (a) { x() } else { y() }',
		'try { x() } catch { y() }',
		'class A extends B<T> implements C { }',
		'<span>{t("Diff {0} of {1}", i, n)}</span>',
		'const m = { a: 1 } as const satisfies Record<string, number>',
		'// <span>Commented</span>',
		'<span>MCP</span>',
		'<div>Vox</div>',
	]) assert.equal(flagged(sample), false, sample);
});

test('i componenti React non mostrano testi inglesi scritti direttamente', () => {
	const found = [];
	for (const { file, code } of sources.filter(source => source.file.endsWith('.tsx'))) {
		for (const [index, what] of englishInComponent(code)) found.push(`${file}:${lineOf(code, index)} ${what}`);
	}
	assert.deepEqual(found, []);
});
