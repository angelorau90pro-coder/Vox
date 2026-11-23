// Percorsi passati dal modello agli strumenti: analisi (funzioni pure) e uso in toolsService/editCodeService
// (controlli sul sorgente: la scrittura vera si prova nell'app).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const load = async (file, names) => new Function(stripTypeScriptTypes(await read(file)).replace(/^export /gm, '') + `; return { ${names} };`)();
const { toolPathKindOf, folderOfRelativePath, withoutRootFolderName, hasUriScheme } = await load('./toolPaths.ts', 'toolPathKindOf, folderOfRelativePath, withoutRootFolderName, hasUriScheme');

test('schema: solo in testa e lungo almeno due lettere', () => {
	for (const p of ['file:///c%3A/a.py', 'vscode-remote://wsl+Ubuntu/a', 'ab://x', 'a1+b.c-d://x']) assert.equal(hasUriScheme(p), true, p);
	for (const p of ['C://a.py', 'c:/a.py', 'note/http://x.txt', ' file://x', '1a://x', '://x', 'C:\\a.py']) assert.equal(hasUriScheme(p), false, p);
});

test('toolsService: validateURI sceglie fra URI.parse e URI.file con lo stesso controllo dello schema', async () => {
	const src = await read('../browser/toolsService.ts');
	const validate = src.slice(src.indexOf('const validateURI = '), src.indexOf('const validateOptionalStr = '));
	assert.match(validate, /if \(hasUriScheme\(absolute\)\) \{/);
	assert.doesNotMatch(validate, /includes\(':\/\/'\)/);
	// file://: query e frammento tolti (il disco li ignora, il confronto con le cartelle no) e percorso del disco
	// controllato come quello scritto a mano («file:///C:a.py», «file://», «file:///E:/a.py:10»)
	// anche con lo schema in maiuscolo («FILE:///…»); l'URI si ricrea dal percorso controllato, che non ha più il
	// prefisso dei percorsi lunghi («file://./E:/progetto»), così il confronto con le cartelle del progetto lo riconosce
	const file = validate.slice(validate.indexOf('if (parsed.scheme.toLowerCase() === Schemas.file) {'));
	assert.match(file, /^if \(parsed\.scheme\.toLowerCase\(\) === Schemas\.file\) \{\r?\n\t\t\tconst onDisk = parsed\.with\(\{ scheme: Schemas\.file \}\)\.fsPath\r?\n\t\t\tconst local = toolPathKindOf\(onDisk, \{ windows: windowsDisk \}\)\r?\n\t\t\tif \(local\.kind === 'invalid'\) throw pathProblemError\(local\.problem, uriStr\)\r?\n\t\t\treturn normalizePath\(URI\.file\(local\.kind === 'absolute' \? local\.path : onDisk\)\)/);
	assert.ok(validate.indexOf('parsed = URI.parse(absolute)') < validate.indexOf('if (parsed.scheme.toLowerCase() === Schemas.file) {'));
	assert.doesNotMatch(validate, /URI\.file\(parsed\.fsPath\)/);
});

test('percorsi assoluti: restano come sono (senza spazi ai lati)', () => {
	for (const p of ['C:\\Users\\a\\main.py', 'c:/progetto/a.py', 'D:\\', 'C://a.py', '/home/u/a.py', '\\a.py', '\\\\server\\share\\a.py', 'file:///c%3A/a.py', 'vscode-remote://wsl+Ubuntu/home/u/a.py'])
		assert.deepEqual(toolPathKindOf(p), { kind: 'absolute', path: p }, p);
	assert.deepEqual(toolPathKindOf('  C:\\a.py\n'), { kind: 'absolute', path: 'C:\\a.py' });
});

test('Windows: una barra sola in testa (radice dell\'unità) è un errore; UNC, «/C:/…» e lettera di unità restano assoluti', () => {
	const windows = { windows: true };
	for (const p of ['/main.py', '\\main.py', '/src/app.py', '\\src\\app.py', '/', '//', '\\\\', '///main.py', '\\\\\\main.py', '\\\\/src/a.py', '\\\\?\\UNC\\'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'driveRoot' }, p);
	for (const p of ['\\\\server\\share\\a.py', '//server/share/a.py', '/C:/progetto/a.py', 'C:\\a.py', 'file:///c%3A/a.py', 'vscode-remote://wsl+Ubuntu/home/u/a.py'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'absolute', path: p }, p);
	assert.deepEqual(toolPathKindOf('src/app.py', windows), { kind: 'relative', rel: 'src/app.py' });
	// «/C:a.py» e «/C:» sono «C:a.py» e «C:» scritti come negli URI: relativi all'unità, quindi lo stesso errore
	for (const p of ['/C:a.py', '/C:', '/c:src\\a.py'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'driveRelative' }, p);
	assert.deepEqual(toolPathKindOf('/C:\\a.py', windows), { kind: 'absolute', path: '/C:\\a.py' });
	// «:» fuori dalla lettera dell'unità è un flusso nascosto di NTFS (per esempio con il numero di riga): errore
	for (const p of ['src/a.py:10', 'a.py:stream', 'C:\\p\\a.py:x', 'c:/p/a.py:10', '/C:/p/a.py:3', '\\\\server\\share\\a.py:1', '\\\\:x.py', '//:x.py', 'file:/c:/a.py', 'note/http://x.txt'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'colon' }, p);
	// percorsi lunghi di Windows: lo stesso file senza il prefisso (così il confronto con le cartelle del progetto e il
	// blocco della cancellazione li vedono come quelli normali), con le stesse regole
	for (const [p, path] of [['\\\\?\\C:\\Users\\a.py', 'C:\\Users\\a.py'], ['\\\\.\\C:\\a.py', 'C:\\a.py'], ['//?/C:/a.py', 'C:/a.py'], ['\\\\?\\c:\\', 'c:\\'], ['\\\\?\\UNC\\server\\share\\a.py', '\\\\server\\share\\a.py'], ['\\\\?\\unc/server/a.py', '\\\\server/a.py']])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'absolute', path }, p);
	for (const p of ['\\\\?\\C:\\a.py:10', '\\\\.\\C:\\a.py:x', '\\\\x\\C:\\a.py', '\\\\?\\UNC\\server\\a.py:1'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'colon' }, p);
	assert.deepEqual(toolPathKindOf('\\\\?\\C:', windows), { kind: 'invalid', problem: 'driveRelative' });
	// senza la lettera dell'unità il prefisso indica un dispositivo, non un file
	for (const p of ['\\\\.\\PhysicalDrive0', '\\\\?\\:x.py', '\\\\.\\nul', '//./COM1', '\\\\?\\Volume{1}\\a.py', '\\\\.', '\\\\?', '//?', '\\\\?\\UNC\\?\\C:\\Windows\\win.ini', '\\\\?\\UNC\\.\\C:\\a.py', '\\\\?\\UNC\\?'])
		assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'device' }, p);
	// fuori da Windows il prefisso non ha significato: assoluto com'è
	assert.deepEqual(toolPathKindOf('//?/C:/a.py'), { kind: 'absolute', path: '//?/C:/a.py' });
	// fuori da Windows «:» sta bene in un nome
	assert.deepEqual(toolPathKindOf('src/a.py:10'), { kind: 'relative', rel: 'src/a.py:10' });
	assert.deepEqual(toolPathKindOf('/home/u/a:b.txt'), { kind: 'absolute', path: '/home/u/a:b.txt' });
	// fuori da Windows (o con un progetto remoto) «/home/u/a.py» è un percorso assoluto vero
	assert.deepEqual(toolPathKindOf('/home/u/a.py', { windows: false }), { kind: 'absolute', path: '/home/u/a.py' });
});

test('variabili come ${workspaceFolder}: errore (qui nessuno le espande), su Windows e fuori, anche dentro un indirizzo', () => {
	for (const windows of [{ windows: true }, { windows: false }])
		for (const p of ['${workspaceFolder}', '${workspaceFolder}/src/a.py', ' ${env:HOME}/a.py', 'src/${file}', 'C:\\${x}\\a.py', 'file:///${workspaceFolder}/a.py', '${}'])
			assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'variable' }, p);
	for (const windows of [{ windows: true }, { windows: false }])
		for (const p of ['%USERPROFILE%\\a.py', '%TEMP%', '$HOME/a.py', '$HOME', '$env:TEMP', '$env:USERPROFILE\\a.py', '$Env:TEMP\\a.py', '$ENV:x', '$_x/a'])
			assert.deepEqual(toolPathKindOf(p, windows), { kind: 'invalid', problem: 'variable' }, p);
	// un «$» o un «%» dentro un nome, o delle graffe da sole, sono nomi validi
	for (const p of ['a$b/c.py', 'src/{x}.py', 'a${b.py', '$RECYCLE.BIN/x', '50%.txt', 'src/%TEMP%/a', '%a b%/x', 'src/$HOME', '$1/a.py'])
		assert.equal(toolPathKindOf(p).kind, 'relative', p);
});

test('percorsi relativi: barre normalizzate e «./» tolti', () => {
	const cases = [
		['calcolo.py', 'calcolo.py'],
		['src/app.py', 'src/app.py'],
		['src\\app.py', 'src/app.py'],
		['./a.py', 'a.py'],
		['././a.py', 'a.py'],
		['.//a.py', 'a.py'],
		['.\\src\\a.py', 'src/a.py'],
		['../fuori.py', '../fuori.py'],
		['.', ''],
		['./', ''],
		// «://» in mezzo non è uno schema: resta un percorso (relativo, quindi dentro il progetto)
		['note/http://x.txt', 'note/http://x.txt'],
		['nome con spazi.txt', 'nome con spazi.txt'],
		['a<b.txt', 'a<b.txt'],
		['~nome.txt', '~nome.txt'],
	];
	for (const [raw, rel] of cases) assert.deepEqual(toolPathKindOf(raw), { kind: 'relative', rel }, raw);
});

test('non sono percorsi: contenuto incollato, vuoto, unità senza barra, «~»', () => {
	const cases = [
		['', 'empty'],
		['   ', 'empty'],
		['i:\\blenderkit\\debug_links.py\n<new_content>import asyncio', 'content'],
		['main.py\nimport os', 'content'],
		['a.py\r\nb', 'content'],
		['a\tb.py', 'content'],
		['a\u0000.py', 'content'],
		['main.py<new_content>', 'content'],
		['main.py</uri>', 'content'],
		['C:a.py', 'driveRelative'],
		['C:', 'driveRelative'],
		['~', 'home'],
		['~/a.py', 'home'],
		['~\\a.py', 'home'],
	];
	for (const [raw, problem] of cases) assert.deepEqual(toolPathKindOf(raw), { kind: 'invalid', problem }, JSON.stringify(raw));
});

test('più cartelle: il primo segmento uguale al nome di una cartella la sceglie', () => {
	const names = [['frontend'], ['Backend']];
	assert.deepEqual(folderOfRelativePath('backend/app.py', names), { index: 1, rel: 'app.py' });
	assert.deepEqual(folderOfRelativePath('FRONTEND/src/a.ts', names), { index: 0, rel: 'src/a.ts' });
	assert.deepEqual(folderOfRelativePath('Backend', names), { index: 1, rel: '' });
	assert.deepEqual(folderOfRelativePath('src/a.ts', names), { index: 0, rel: 'src/a.ts' });
	assert.deepEqual(folderOfRelativePath('backendx/a.py', names), { index: 0, rel: 'backendx/a.py' });
	// lo stesso nome per più cartelle («client/app» e «server/app»): non si sceglie, -1
	assert.deepEqual(folderOfRelativePath('app/config.ts', [['app'], ['App'], ['web']]), { index: -1, rel: 'app/config.ts' });
	assert.deepEqual(folderOfRelativePath('app/config.ts', [['client', 'app'], ['server', 'app']]), { index: -1, rel: 'app/config.ts' });
	assert.deepEqual(folderOfRelativePath('server/config.ts', [['client', 'app'], ['server', 'app']]), { index: 1, rel: 'config.ts' });
});

test('più cartelle: vale anche il nome su disco (quello dell\'albero dei file) quando il .code-workspace ne dà un altro', () => {
	const names = [['Frontend', 'web'], ['Backend', 'api']];
	assert.deepEqual(folderOfRelativePath('api/app.py', names), { index: 1, rel: 'app.py' });
	assert.deepEqual(folderOfRelativePath('backend/app.py', names), { index: 1, rel: 'app.py' });
	assert.deepEqual(folderOfRelativePath('WEB/src/a.ts', names), { index: 0, rel: 'src/a.ts' });
	assert.deepEqual(folderOfRelativePath('/a.ts', [['', 'web'], ['', 'api']]), { index: 0, rel: '/a.ts' });
});

test('una cartella sola: il percorso resta com\'è anche se comincia con il suo nome', () => {
	assert.deepEqual(folderOfRelativePath('programma/main.py', [['programma']]), { index: 0, rel: 'programma/main.py' });
	assert.deepEqual(folderOfRelativePath('', [['programma']]), { index: 0, rel: '' });
});

test('nome della cartella del progetto copiato dall\'albero: si riconosce il primo segmento, senza badare alle maiuscole', () => {
	assert.deepEqual(withoutRootFolderName('progetto/calcolo.py', ['progetto']), { first: 'progetto', rest: 'calcolo.py' });
	assert.deepEqual(withoutRootFolderName('Progetto/utilita/a.py', ['progetto']), { first: 'Progetto', rest: 'utilita/a.py' });
	assert.deepEqual(withoutRootFolderName('progetto', ['progetto']), { first: 'progetto', rest: '' });
	assert.deepEqual(withoutRootFolderName('progetto/', ['progetto']), { first: 'progetto', rest: '' });
	assert.equal(withoutRootFolderName('calcolo.py', ['progetto']), null);
	assert.equal(withoutRootFolderName('progetti/a.py', ['progetto']), null);
	assert.equal(withoutRootFolderName('src/progetto/a.py', ['progetto']), null);
	assert.equal(withoutRootFolderName('', ['progetto']), null);
});

test('nome della cartella: vale sia quello su disco sia quello del file .code-workspace; un nome vuoto non vale', () => {
	assert.deepEqual(withoutRootFolderName('web/app.ts', ['web', 'Frontend']), { first: 'web', rest: 'app.ts' });
	assert.deepEqual(withoutRootFolderName('frontend/app.ts', ['web', 'Frontend']), { first: 'frontend', rest: 'app.ts' });
	assert.equal(withoutRootFolderName('altro/app.ts', ['web', 'Frontend']), null);
	assert.equal(withoutRootFolderName('/app.ts', ['', 'web']), null);
	assert.equal(withoutRootFolderName('', ['']), null);
});

test('toolsService: con una cartella sola il nome della cartella in testa si toglie, salvo una sottocartella vera con quel nome', async () => {
	const src = await read('../browser/toolsService.ts');
	const uriOf = src.slice(src.indexOf('const resolveUri = async (uriStr: unknown) => {'), src.indexOf('const uriOf = async (uriStr: unknown) =>'));
	// la forma canonica (quella con cui VS Code ha aperto il file: «Calcolo.py» anche se il modello scrive «calcolo.py»),
	// altrimenti il servizio dei file non trova il modello e non salva
	assert.match(src, /const uriOf = async \(uriStr: unknown\) => uriIdentityService\.asCanonicalUri\(await resolveUri\(uriStr\)\)/);
	assert.match(src, /@IUriIdentityService uriIdentityService: IUriIdentityService,/);
	assert.equal(src.match(/resolveUri\(/g)?.length, 1);
	// il nome da solo indica la cartella del progetto; conta solo una sottocartella vera (fileKindOf, non fileService.exists,
	// che vale «non c'è» anche su un errore), e se il disco non risponde il percorso resta com'è
	const order = ['const uri = validateURI(uriStr, folders)', "if (folders.length !== 1 || typeof uriStr !== 'string') return uri", "if (pathKind.kind !== 'relative') return uri", 'const prefixed = withoutRootFolderName(pathKind.rel, [basename(folders[0].uri), folders[0].name])', 'if (prefixed === null) return uri', 'try { kind = await fileKindOf(joinPath(folders[0].uri, prefixed.first)) } catch { return uri }', "if (kind === 'folder') return uri", "if (kind === 'file' && prefixed.rest === '' && !pointsToFolder(uriStr)) return uri", "const candidate = normalizePath(prefixed.rest === '' ? folders[0].uri : joinPath(folders[0].uri, prefixed.rest))", 'if (!extUriBiasedIgnorePathCase.isEqualOrParent(candidate, folders[0].uri)) return uri', 'return candidate'];
	let at = -1;
	for (const piece of order) { const i = uriOf.indexOf(piece); assert.ok(i > at, piece); at = i; }
	assert.doesNotMatch(uriOf, /fileService\.exists/);
	// rewrite_file ed edit_file: una barra finale è una cartella, anche se non esiste ancora
	const validators = src.slice(src.indexOf('rewrite_file: async (params: RawToolParamsObj) => {'), src.indexOf('run_command: async (params: RawToolParamsObj) => {'));
	assert.equal(validators.match(/if \(typeof uriStr === 'string' && pointsToFolder\(uriStr\)\) throw new Error\(t\("\{0\} is a folder, not a file\.", uri\.fsPath\)\)/g)?.length, 2);
	// in un indirizzo con uno schema la barra finale si guarda sul percorso, non su query e frammento; nessun altro uso
	// di checkIfIsFolder rimasto sull'indirizzo intero
	assert.equal(src.match(/checkIfIsFolder\(/g)?.length, 3);
	assert.equal(src.match(/pointsToFolder\(uriStr\)/g)?.length, 5);
	const helpers = src.slice(src.indexOf('const pointsToFolder = '), src.indexOf('export interface IToolsService'));
	const URI = { parse: s => ({ path: new URL(s).pathname }) };
	const { pointsToFolder } = new Function('URI', 'hasUriScheme', stripTypeScriptTypes(helpers) + '; return { pointsToFolder };')(URI, hasUriScheme);
	for (const p of ['file:///E:/a.py#nota/', 'file:///E:/a.py?x=/', 'src/a.py', 'vscode-remote://wsl+u/home/a.py#/'])
		assert.equal(pointsToFolder(p), false, p);
	for (const p of ['file:///E:/src/', 'file:///E:/src/#x', 'src/', 'src\\', ' src/ ', 'vscode-remote://wsl+u/home/'])
		assert.equal(pointsToFolder(p), true, p);
	assert.match(src, /const isBlank = \(u: unknown\) => isFalsy\(u\) \|\| \(typeof u === 'string' && u\.trim\(\) === ''\)/);
	assert.match(src, /const optionalUriOf = async \(uriStr: unknown\) => isBlank\(uriStr\) \? null : uriOf\(uriStr\)/);
	assert.match(src, /const uri = await uriOf\(isBlank\(uriStr\) \? '\.' : uriStr\)/);
	// ls_dir senza percorso e senza cartelle aperte: un errore che non parla di un percorso «.» che il modello non ha scritto
	assert.match(src, /if \(isBlank\(uriStr\) && workspaceContextService\.getWorkspace\(\)\.folders\.length === 0\) throw new Error\(t\("No project folder is open: pass the full path of the folder to list\."\)\)\r?\n\t+const uri = await uriOf\(isBlank\(uriStr\) \? '\.' : uriStr\)/);
	// la validazione è asincrona e chi la chiama la attende (altrimenti i parametri sarebbero una promessa)
	assert.match(src, /type ValidateBuiltinParams = \{ \[T in BuiltinToolName\]: \(p: RawToolParamsObj\) => Promise<BuiltinToolCallParams\[T\]> \}/);
	const thread = await read('../browser/chatThreadService.ts');
	assert.match(thread, /const params = await this\._toolsService\.validateParams\[toolName\]\(opts\.unvalidatedToolParams\)/);
	const params = src.slice(src.indexOf('this.validateParams = {'), src.indexOf('this.callTool = {'));
	assert.equal(params.match(/= await uriOf\(/g)?.length, 9);
	assert.equal(params.match(/= await optionalUriOf\(/g)?.length, 1);
	assert.doesNotMatch(params, /= (uriOf|optionalUriOf|cwdOf)\(/);
});

test('toolsService: i percorsi relativi si risolvono nelle cartelle del progetto, non nella radice del disco', async () => {
	const src = await read('../browser/toolsService.ts');
	const validate = src.slice(src.indexOf('const validateURI = '), src.indexOf('const validateOptionalStr = '));
	assert.match(validate, /const windowsDisk = isWindows && folders\.every\(f => f\.uri\.scheme === 'file'\)\r?\n\tconst pathKind = toolPathKindOf\(uriStr, \{ windows: windowsDisk \}\)/);
	assert.match(validate, /if \(pathKind\.kind === 'invalid'\) throw pathProblemError\(pathKind\.problem, uriStr\)/);
	// nome di più cartelle: errore invece di scegliere la prima
	assert.ok(validate.indexOf('if (index < 0) throw new Error(t("The path {0} starts with a name shared by more than one project folder: use the full path."') > validate.indexOf('folderOfRelativePath(pathKind.rel'));
	assert.match(src, /import \{ isWindows \} from '\.\.\/\.\.\/\.\.\/\.\.\/base\/common\/platform\.js'/);
	assert.match(validate, /if \(folders\.length === 0\) throw new Error/);
	assert.match(validate, /folderOfRelativePath\(pathKind\.rel, folders\.map\(f => \[f\.name, basename\(f\.uri\)\]\)\)/);
	assert.match(validate, /normalizePath\(rel === '' \? folders\[index\]\.uri : joinPath\(folders\[index\]\.uri, rel\)\)/);
	const problems = src.slice(src.indexOf('const pathProblemError = '), src.indexOf('const validateURI = '));
	for (const problem of ['empty', 'content', 'driveRelative', 'driveRoot', 'home', 'colon', 'variable', 'device']) assert.match(problems, new RegExp(`case '${problem}': return new Error`));
	// tutti gli strumenti passano dalle cartelle aperte: nessuna chiamata diretta rimasta in validateParams
	const params = src.slice(src.indexOf('this.validateParams = {'), src.indexOf('this.callTool = {'));
	assert.doesNotMatch(params, /validateURI\(|validateOptionalStr\('cwd'/);
	assert.equal(params.match(/await cwdOf\(cwdUnknown\)/g)?.length, 2);
});

test('toolsService: cwd relativo diventa il percorso completo, quello assoluto resta com\'è', async () => {
	const src = await read('../browser/toolsService.ts');
	const cwd = src.slice(src.indexOf('const cwdOf = '), src.indexOf('const fileKindOf = '));
	assert.match(cwd, /if \(isBlank\(cwdUnknown\)\) return null/);
	assert.match(cwd, /const uri = await uriOf\(cwd\)/);
	// uno schema che non è il disco né quello delle cartelle aperte dà errore, prima di decidere il percorso
	const schemeCheck = cwd.indexOf("if (uri.scheme !== 'file' && !workspaceContextService.getWorkspace().folders.some(f => f.uri.scheme === uri.scheme)) throw new Error(t(\"The working directory {0} is not a folder on disk or in the project.\", shortPathForError(cwd)))");
	assert.ok(schemeCheck > cwd.indexOf('const uri = await uriOf(cwd)') && schemeCheck < cwd.indexOf('const resolved = '));
	// sempre il percorso dell'URI (assoluto, relativo o con uno schema): «/C:/progetto» diventa «c:\progetto» per il
	// terminale di Windows; niente più il percorso dato così com'è
	assert.match(cwd, /const resolved = uri\.scheme === 'file' \? uri\.fsPath : uri\.path/);
	assert.doesNotMatch(cwd, /return pathKind\.path|toolPathKindOf\(cwd\)/);
	// «file://» da solo dà una cartella vuota: errore invece di una stringa vuota al terminale
	assert.ok(cwd.indexOf("if (resolved.trim() === '') throw new Error(t(\"The working directory {0} is not a folder on disk or in the project.\", shortPathForError(cwd)))") < cwd.indexOf('return resolved'));
	assert.ok(cwd.includes("if (resolved.trim() === '') throw new Error"));
});

test('toolsService: create_file_or_folder sulla cartella del progetto dà errore invece di «creato» senza creare niente', async () => {
	const src = await read('../browser/toolsService.ts');
	const create = src.slice(src.indexOf('create_file_or_folder: async ({ uri, isFolder })'), src.indexOf('delete_file_or_folder: async ({ uri, isRecursive })'));
	const find = create.indexOf('const projectFolder = workspaceContextService.getWorkspace().folders.find(f => extUriBiasedIgnorePathCase.isEqual(removeTrailingPathSeparator(f.uri), removeTrailingPathSeparator(uri)))');
	// il consiglio è il percorso completo della sottocartella: «nome/nome/» varrebbe una volta sola
	const guard = create.indexOf('if (projectFolder) {');
	const order = ['const name = basename(projectFolder.uri)', 'if (!name || /^[A-Za-z]:$/.test(name)) throw new Error(t("{0} is the project folder, and it already exists: there is nothing to create.", uri.fsPath))', 'throw new Error(t("{0} is the project folder, and it already exists. To create a folder with the same name inside it, pass its full path: {1}", uri.fsPath, joinPath(projectFolder.uri, name).fsPath + (isWindows ? \'\\\\\' : \'/\')))', 'await fileService.createFolder(uri)'];
	let at = guard;
	assert.ok(find >= 0 && find < guard, 'guard');
	for (const piece of order) { const i = create.indexOf(piece); assert.ok(i > at, piece); at = i; }
	// con il progetto in «E:\» basename dà «E:»: il consiglio sarebbe «e:\E:\»
	const isDriveName = new RegExp(create.match(/if \(!name \|\| \/(.*)\/\.test\(name\)\)/)[1]);
	for (const n of ['E:', 'c:']) assert.ok(isDriveName.test(n), n);
	for (const n of ['progetto', 'E:x', 'share']) assert.ok(!isDriveName.test(n), n);
});

test('toolsService: read_file e search_in_file aprono il modello una volta sola (getModelSafe)', async () => {
	const src = await read('../browser/toolsService.ts');
	const call = src.slice(src.indexOf('this.callTool = {'));
	assert.doesNotMatch(call, /await voxModelService\.initializeModel\(uri\);?\r?\n\t+const \{ model \} = await voxModelService\.getModelSafe\(uri\)/);
	assert.equal(call.match(/const \{ model \} = await voxModelService\.getModelSafe\(uri\);? \/\/ apre il modello se serve/g)?.length, 2);
	// e poi controllano che il modello sia il file sul disco (non una cella di notebook o un confronto con git)
	assert.equal(call.match(/if \(model === null\) \{ throw new Error\(t\("No contents: the file does not exist\."\)\);? \}\r?\n\t+fileModelOrThrow\(uri, model\)/g)?.length, 2);
	const guard = src.slice(src.indexOf('const fileModelOrThrow = '), src.indexOf('const openForEditOrThrow = '));
	assert.match(guard, /if \(!extUriBiasedIgnorePathCase\.isEqual\(model\.uri, uri\)\) throw new Error\(t\("Vox has \{0\} open in another form/);
});

test('editCodeService: un modello chiuso libera il suo file, così il modello che lo riapre riceve gli ascoltatori', async () => {
	const src = await read('../browser/editCodeService.ts');
	const init = src.slice(src.indexOf('const registeredModelURIs = '), src.indexOf('// initialize all existing models'));
	// chiuso durante l'attesa: non si registra; gli ascoltatori stanno in un contenitore del modello, rilasciato alla chiusura
	const order = ['const registeredModelURIs = new Map<string, ITextModel>()', 'await this._voxModelService.initializeModel(model.uri)', 'if (model.isDisposed()) return', 'if (registeredModelURIs.has(model.uri.fsPath)) return', 'const fsPath = model.uri.fsPath', 'registeredModelURIs.set(fsPath, model)', 'const listeners = this._register(new DisposableStore())', 'listeners.add(model.onWillDispose(() => {', 'if (registeredModelURIs.get(fsPath) === model) registeredModelURIs.delete(fsPath)', 'this._store.delete(listeners)', 'listeners.add(\n\t\t\t\tmodel.onDidChangeContent('];
	let at = -1;
	for (const piece of order) { const i = init.replace(/\r\n/g, '\n').indexOf(piece); assert.ok(i > at, piece); at = i; }
	// nessun ascoltatore del modello registrato direttamente sul servizio, che lo terrebbe in memoria per sempre
	assert.doesNotMatch(init, /this\._register\(\s*model\./);
});

test('toolsService: una cartella del progetto, o una che la contiene, non si cancella (senza badare a maiuscole e barra finale)', async () => {
	const src = await read('../browser/toolsService.ts');
	const del = src.slice(src.indexOf('delete_file_or_folder: async ({ uri, isRecursive })'), src.indexOf('rewrite_file: async ({ uri, newContent })'));
	const target = del.indexOf('const target = removeTrailingPathSeparator(uri)');
	const guard = del.indexOf('if (workspaceContextService.getWorkspace().folders.some(f => extUriBiasedIgnorePathCase.isEqualOrParent(removeTrailingPathSeparator(f.uri), target))) throw new Error');
	assert.ok(target >= 0 && target < guard && guard < del.indexOf('await fileService.del('));
	// mai l'isEqual di resources.js da solo, che bada alle maiuscole (extUriBiasedIgnorePathCase.isEqual va bene)
	assert.doesNotMatch(src, /(?<![.\w])isEqual\(/);
});

test('voxModelService: getModelSafe riapre sempre, saveModel può forzare, initializeModel restituisce il motivo', async () => {
	const src = await read('./voxModelService.ts');
	const safe = src.slice(src.indexOf('getModelSafe = async'), src.indexOf('override dispose()'));
	assert.match(safe, /\n\t\tawait this\.initializeModel\(uri\);/);
	assert.doesNotMatch(safe, /in this\._modelRefOfURI/);
	assert.match(src, /saveModel = async \(uri: URI, options\?: \{ force\?: boolean \}\) => \{\r?\n\t\tconst saved = await this\._textFileService\.save\(uri, \{[^\n]*\r?\n\t\t\tforce: options\?\.force,/);
	// textFileService.save restituisce undefined quando non salva (sola lettura, modello non trovato, errore del disco)
	assert.match(src, /\}\)\r?\n\t\treturn saved !== undefined\r?\n\t\}/);
	assert.match(src, /saveModel\(uri: URI, options\?: \{ force\?: boolean \}\): Promise<boolean>;/);
	const init = src.slice(src.indexOf('initializeModel = async'), src.indexOf('getModelFromFsPath = '));
	assert.match(init, /catch \(e\) \{\r?\n\t\t\tconsole\.log\('InitializeModel error:', e\)\r?\n\t\t\treturn e instanceof Error \? e\.message : String\(e\)/);
});

test('voxModelService: un riferimento a un modello chiuso si riapre invece di restare «non apribile»', async () => {
	const src = await read('./voxModelService.ts');
	const init = src.slice(src.indexOf('initializeModel = async'), src.indexOf('getModelFromFsPath = '));
	// dopo l'attesa, se un'altra chiamata ha già aperto il file si rilascia il riferimento nuovo
	const order = ['const existing = this._modelRefOfURI[uri.fsPath]', 'if (this._keeps(existing, uri)) return', 'existing.dispose()', 'delete this._modelRefOfURI[uri.fsPath]', 'await this._textModelService.createModelReference(uri)', 'const current = this._modelRefOfURI[uri.fsPath]', 'if (current && this._keeps(current, uri)) {', 'editorModelRef.dispose()', 'if (current) current.dispose()', 'this._modelRefOfURI[uri.fsPath] = editorModelRef'];
	let at = -1;
	for (const piece of order) { const i = init.indexOf(piece); assert.ok(i > at, piece); at = i; }
});

test('voxModelService: il lato git di un confronto o una cella di notebook lascia il posto al file vero, non il contrario', async () => {
	const src = await read('./voxModelService.ts');
	assert.match(src, /import \{ Schemas \} from '\.\.\/\.\.\/\.\.\/\.\.\/base\/common\/network\.js';/);
	assert.match(src, /import \{ extUriBiasedIgnorePathCase \} from '\.\.\/\.\.\/\.\.\/\.\.\/base\/common\/resources\.js';/);
	const keeps = src.slice(src.indexOf('private _keeps = '), src.indexOf('initializeModel = async'));
	const body = keeps.slice(keeps.indexOf('=>') + 2, keeps.lastIndexOf('}') + 1);
	const fn = new Function('extUriBiasedIgnorePathCase', 'Schemas', stripTypeScriptTypes('const keeps = (ref, uri) => ' + body) + '; return keeps')(
		{ isEqual: (a, b) => a.scheme === b.scheme && a.path.toLowerCase() === b.path.toLowerCase() }, { file: 'file', vscodeRemote: 'vscode-remote' });
	const file = { scheme: 'file', path: '/e:/p/a.ts' }, fileUpper = { scheme: 'file', path: '/E:/P/a.ts' };
	const git = { scheme: 'git', path: '/e:/p/a.ts' }, cell = { scheme: 'vscode-notebook-cell', path: '/e:/p/a.ipynb' };
	const ref = (uri, disposed = false, modelDisposed = false) => ({ object: { textEditorModel: uri ? { uri, isDisposed: () => modelDisposed } : null, isDisposed: () => disposed } });
	assert.equal(fn(ref(file), file), true);
	assert.equal(fn(ref(file), fileUpper), true); // maiuscole come il disco di Windows
	assert.equal(fn(ref(git), file), false); // il file prende il posto del modello git
	assert.equal(fn(ref(cell), { scheme: 'file', path: '/e:/p/a.ipynb' }), false);
	assert.equal(fn(ref(file), git), true); // una richiesta per il modello git non toglie il file
	assert.equal(fn(ref(git), git), true);
	assert.equal(fn(ref(file, true), file), false); // modello chiuso
	assert.equal(fn(ref(file, false, true), file), false); // testo del modello chiuso
	// in un progetto remoto il file vero è «vscode-remote»: prende il posto del lato git come quello locale
	const remote = { scheme: 'vscode-remote', path: '/home/u/a.ts' }, remoteGit = { scheme: 'git', path: '/home/u/a.ts' };
	assert.equal(fn(ref(remoteGit), remote), false);
	assert.equal(fn(ref(remote), remoteGit), true);
	assert.equal(fn(ref(remote), remote), true);
	assert.equal(fn(ref(null), file), false);
});

test('toolsService: rewrite_file crea il file che manca con il contenuto, e nessuno strumento dice «riuscito» senza scrivere', async () => {
	const src = await read('../browser/toolsService.ts');
	const kindOf = src.slice(src.indexOf('const fileKindOf = '), src.indexOf('const saveOrThrow = '));
	assert.match(kindOf, /toFileOperationResult\(e\) === FileOperationResult\.FILE_NOT_FOUND\) return 'missing'/);
	assert.match(kindOf, /\n\t\t\t\tthrow e\r?\n/);
	// solo un file vero è «file»: un nome riservato di Windows («nul», «con») non è né file né cartella, e dà errore
	const kindOrder = ['stat = await fileService.stat(uri)', 'if (stat.isDirectory) return \'folder\'', 'if (stat.isFile) return \'file\'', 'if (stat.isSymbolicLink) throw new Error(t("{0} is a link that points to nothing (its target is missing): Vox does not change it.", uri.fsPath))', 'throw new Error(t("{0} is not a file or a folder (for example a Windows device name like nul or con).", uri.fsPath))'];
	let kindAt = -1;
	for (const piece of kindOrder) { const i = kindOf.indexOf(piece); assert.ok(i > kindAt, piece); kindAt = i; }
	assert.doesNotMatch(kindOf, /isDirectory \? 'folder' : 'file'/);
	// salvataggio: forzato per un file cancellato con il modello aperto; poi il file deve esserci sempre (anche se c'era:
	// cancellato dopo il controllo iniziale, con il testo uguale, il salvataggio non forzato non lo riscriverebbe)
	const save = src.slice(src.indexOf('const saveOrThrow = '), src.indexOf('const openForEditOrThrow = '));
	assert.match(save, /await voxModelService\.saveModel\(uri, \{ force: fileWasMissing \}\)/);
	assert.match(save, /const saved = await voxModelService\.saveModel\(uri, \{ force: fileWasMissing \}\)\r?\n\t\t\tif \(!saved \|\| textFileService\.isDirty\(uri\) \|\| await fileKindOf\(uri\) !== 'file'\) throw new Error/);
	// sola lettura: errore prima di toccare il modello o di creare il file
	assert.match(save, /const writableOrThrow = \(uri: URI\) => \{\r?\n\t\t\tif \(filesConfigurationService\.isReadonly\(uri\)\) throw new Error\(t\("\{0\} is read-only in Vox: Vox does not change it\.", uri\.fsPath\)\)/);
	// prima si apre il modello tenendo il motivo di un'apertura non riuscita, poi si controlla che ci sia (altrimenti
	// errore, con il motivo se c'è), e solo dopo callBeforeApplyOrEdit salva le modifiche precedenti
	const open = src.slice(src.indexOf('const openForEditOrThrow = '), src.indexOf('const lintErrorsLater = '));
	const openOrder = ['const reason = await voxModelService.initializeModel(uri)', 'const { model, editorModel } = voxModelService.getModel(uri)', 'if (!model) {', 'if (reason) throw new Error(t("Vox could not open {0} to change it: {1}", uri.fsPath, reason))', 'throw new Error(t("Vox could not open {0} to change it.", uri.fsPath))', 'fileModelOrThrow(uri, model)', 'if (editorModel?.isReadonly()) throw new Error(t("{0} is read-only in Vox: Vox does not change it.", uri.fsPath))', 'await editCodeService.callBeforeApplyOrEdit(uri)'];
	let openAt = -1;
	for (const piece of openOrder) { const i = open.indexOf(piece, openAt + 1); assert.ok(i > openAt, piece); openAt = i; }
	// una sola chiamata a callBeforeApplyOrEdit, dopo il controllo del modello
	assert.equal(open.split('callBeforeApplyOrEdit(').length, 2);

	const rewrite = src.slice(src.indexOf('rewrite_file: async ({ uri, newContent })'), src.indexOf('edit_file: async ({ uri, searchReplaceBlocks })'));
	// file mancante senza un modello aperto: creato con il contenuto e poi aperto (checkpoint della modifica successiva);
	// con un modello rimasto aperto di un file cancellato si passa dal modello, come per un file che esiste
	// il modello aperto conta solo se è il file: il lato git di un confronto rimasto in memoria non evita la creazione
	const order = ["getStreamState(uri) === 'streaming'", 'await fileKindOf(uri)', "kind === 'folder'", 'writableOrThrow(uri)', 'const open = voxModelService.getModel(uri).model', "if (kind === 'missing' && !(open && extUriBiasedIgnorePathCase.isEqual(open.uri, uri))) {", 'await textFileService.create([{ resource: uri, value: newContent, options: { overwrite: false } }])', 'await voxModelService.initializeModel(uri)', 'await openForEditOrThrow(uri)', 'editCodeService.instantlyRewriteFile', "await saveOrThrow(uri, kind === 'missing')"];
	let at = -1;
	for (const piece of order) { const i = rewrite.indexOf(piece); assert.ok(i > at, piece); at = i; }

	const edit = src.slice(src.indexOf('edit_file: async ({ uri, searchReplaceBlocks })'), src.indexOf('run_command: async ({ command, cwd, terminalId })'));
	const editOrder = ["getStreamState(uri) === 'streaming'", 'await fileKindOf(uri)', "kind === 'folder'", "if (kind === 'missing') throw new Error", 'writableOrThrow(uri)', 'await openForEditOrThrow(uri)', 'editCodeService.instantlyApplySearchReplaceBlocks', 'await saveOrThrow(uri)'];
	at = -1;
	for (const piece of editOrder) { const i = edit.indexOf(piece); assert.ok(i > at, piece); at = i; }
});

test('chatThreadService: il checkpoint di una modifica apre prima solo un file del progetto, e usa solo il file vero', async () => {
	const src = await read('../browser/chatThreadService.ts');
	// un segnaposto che manca darebbe -1, e la slice prenderebbe quasi tutto il file
	const between = (from, to) => {
		const a = src.indexOf(from), b = src.indexOf(to);
		assert.ok(a >= 0 && b > a, `${from} … ${to}`);
		return src.slice(a, b);
	};
	// il codice senza commenti (a blocchi e di riga): un controllo chiuso in un commento non deve contare
	const strip = (text) => text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
	// cerca i pezzi uno dopo l'altro, ciascuno dopo la fine del precedente, e ne restituisce le posizioni
	const inOrder = (text, pieces) => {
		let from = 0;
		return pieces.map(piece => { const i = text.indexOf(piece, from); assert.ok(i >= 0, piece); from = i + piece.length; return i; });
	};
	const opening = /initializeModel|getModelSafe|createModelReference|textFileService|readFile\(/;
	// la fase prima della conferma dell'utente, dalla convalida alla richiesta
	const preCode = strip(between('if (!opts.preapproved) {', 'return { awaitingUserApproval: true }'));
	// Un solo controllo dei percorsi, poi l'apertura e il checkpoint. Un percorso fuori dal progetto non si apre prima
	// della conferma (lettura dal disco, connessione a un percorso di rete): l'unica apertura è dentro il ramo «nessun
	// percorso fuori dal progetto». «Ferma» o un'altra esecuzione partita durante le attese fermano tutto
	const order = ['const params = await this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)', 'const touchesOutsideWorkspace = isBuiltInTool && (await Promise.all(', 'const touchesProjectDir = ', 'if (!stillOurs()) return { superseded: true }', "if (toolName === 'edit_file' || toolName === 'rewrite_file') {", "const editedUri = (toolParams as BuiltinToolCallParams['edit_file' | 'rewrite_file']).uri", 'if (!touchesOutsideWorkspace) {', 'const isRegularFile = await this._fileService.stat(editedUri).then(s => s.isFile && !s.isSymbolicLink, () => false)', 'if (!stillOurs()) return { superseded: true }', 'if (isRegularFile) {', 'await this._voxModelService.initializeModel(editedUri)', 'if (!stillOurs()) return { superseded: true }', 'this._addToolEditCheckpoint({ threadId, uri: editedUri })', "type: 'tool_request'"];
	const posOf = inOrder(preCode, order);
	// dopo una convalida riuscita, prima del controllo dei percorsi; e prima di registrare un errore di convalida
	// (dopo strip i fine riga sono solo \n)
	assert.match(preCode, /return \{\}\s*\}\s*if \(!stillOurs\(\)\) return \{ superseded: true \}[ \t]*\n/);
	assert.match(preCode, /catch \(error\) \{\s*if \(!stillOurs\(\)\) return \{ superseded: true \}\s*const errorMessage = getErrorMessage\(error\)/);
	// si apre solo un file vero (non un nome riservato di Windows, una FIFO, un file che manca o non controllabile), e
	// l'apertura è l'unica cosa nel suo ramo: niente può aprire altro o saltare il controllo dell'esecuzione
	assert.match(preCode, /if \(!touchesOutsideWorkspace\) \{\s*const isRegularFile = await this\._fileService\.stat\(editedUri\)\.then\(s => s\.isFile && !s\.isSymbolicLink, \(\) => false\)\s*if \(!stillOurs\(\)\) return \{ superseded: true \}\s*if \(isRegularFile\) \{\s*await this\._voxModelService\.initializeModel\(editedUri\)\s*if \(!stillOurs\(\)\) return \{ superseded: true \}\s*\}\s*\}\s*this\._addToolEditCheckpoint\(\{ threadId, uri: editedUri \}\)/);
	assert.equal(preCode.match(/isRegularFile/g)?.length, 2);
	// il controllo dei percorsi copre l'indirizzo del file modificato, e l'espressione intera è quella (un risultato
	// invertito manderebbe all'apertura proprio i percorsi fuori dal progetto)
	assert.match(preCode, /\n\t+const touchesOutsideWorkspace = isBuiltInTool && \(await Promise\.all\(\n\t+urisOfBuiltinToolParams\(toolParams as BuiltinToolCallParams\[BuiltinToolName\]\)\.map\(uri => this\._isOutsideWorkspace\(uri\)\)\n\t+\)\)\.some\(isOutside => isOutside\)\s*const touchesProjectDir = /);
	assert.equal(preCode.match(/touchesOutsideWorkspace =/g)?.length, 1);
	assert.match(strip(await read('./toolsServiceTypes.ts')), /if \(p\.uri\) uris\.push\(p\.uri\)/);
	// nessun'altra apertura o lettura e nessun'altra attesa: convalida, controllo dei percorsi, apertura
	assert.equal(preCode.match(/initializeModel/g)?.length, 1);
	assert.doesNotMatch(preCode, /getModelSafe|createModelReference|textFileService|readFile\(/);
	assert.equal(preCode.match(/fileService/g)?.length, 1); // solo la stat del file modificato, prima dell'apertura
	assert.equal(preCode.match(/await /g)?.length, 4);
	assert.equal(preCode.match(/stillOurs\(\)/g)?.length, 5);
	assert.equal(preCode.match(/\bstillOurs\b/g)?.length, 6); // la definizione e i cinque controlli: nessuna ridefinizione o ombra
	// dall'ultimo controllo dell'esecuzione alla richiesta di conferma nessuna attesa
	assert.doesNotMatch(preCode.slice(posOf[order.length - 3]), /await /);
	// le espressioni intere: niente può allungarle (un «|| true», un confronto sulla riga dopo) prima dell'istruzione seguente
	assert.match(preCode, /const \{ isStillValid \} = opts\s*const stillOurs = \(\) => !!this\.streamState\[threadId\]\?\.isRunning && isStillValid\(\)\s*try \{/);
	assert.equal(preCode.match(/isStillValid\b/g)?.length, 2); // nessuna ridefinizione o ombra più avanti
	// il ramo dopo la conferma (preapproved) non usa questi controlli: uno strumento già approvato non si blocca
	assert.equal(strip(between('private _runToolCall = async (', 'private async _runChatAgent(')).match(/stillOurs\(\)/g)?.length, 5);
	// il chiamante passa l'identità dell'esecuzione e, se è superata, esce senza toccare lo stato
	const caller = between('const { awaitingUserApproval, interrupted, superseded } = await this._runToolCall(', 'if (awaitingUserApproval) { isRunningWhenEnd');
	assert.match(caller, /\{ preapproved: false, unvalidatedToolParams: toolCall\.rawParams, isStillValid \}\)/);
	assert.ok(caller.indexOf('if (superseded) return') >= 0 && caller.indexOf('if (superseded) return') < caller.indexOf('if (interrupted) {'));
	assert.match(strip(between('private async _runChatAgent(', 'const { awaitingUserApproval, interrupted, superseded } = await this._runToolCall(')), /const isStillValid = \(\) => !interruptedWhenIdle && this\._agentRunSeq\.get\(threadId\) === runId\s*const cliWriteFolder = /);
	// _isOutsideWorkspace dà «fuori» anche per un collegamento simbolico o una giunzione nel progetto, e nel dubbio.
	// Un percorso fuori da ogni cartella del progetto esce prima di qualunque accesso al disco, e «dentro» si dice in
	// un punto solo: risalendo si è arrivati alla cartella del progetto senza incontrare collegamenti
	const outside = strip(between('private async _isOutsideWorkspace(', 'private _isInProjectDir('));
	inOrder(outside, ['const uri = normalizePath(uri0)', 'const folder = this._workspaceContextService.getWorkspaceFolder(uri)', 'if (!folder) return true', 'if (extUriBiasedIgnorePathCase.isEqual(current, folder.uri)) return false', 'if ((await this._fileService.stat(current)).isSymbolicLink) return true', 'FileOperationResult.FILE_NOT_FOUND)) return true', 'const parent = dirname(current)', 'return true']);
	assert.equal(outside.match(/return false/g)?.length, 1);
	assert.equal(outside.match(/await /g)?.length, 1);
	// solo «non trovato» (un file da creare) fa salire alla cartella che lo contiene; ogni altro errore dà «fuori»
	assert.match(outside, /\} catch \(e\) \{\s*if \(!\(e instanceof Error && toFileOperationResult\(e\) === FileOperationResult\.FILE_NOT_FOUND\)\) return true\s*\}/);
	assert.doesNotMatch(outside, /catch \{/);
	const add = strip(between('private _addToolEditCheckpoint(', 'private _getCheckpointBeforeMessage'));
	assert.doesNotMatch(add, opening); // il checkpoint non apre niente da sé: usa il modello già aperto
	assert.ok(add.indexOf('if (!model) return') >= 0);
	assert.ok(add.indexOf('if (!extUriBiasedIgnorePathCase.isEqual(model.uri, uri)) return') > add.indexOf('if (!model) return'));
	assert.ok(add.indexOf('if (!extUriBiasedIgnorePathCase.isEqual(model.uri, uri)) return') < add.indexOf('getVoxFileSnapshot(uri)'));
});

test('toolsService ed editCodeService: URI remoti senza query e frammento, sola lettura per creare e cancellare, ripristino dei checkpoint fino al disco', async () => {
	const tools = await read('../browser/toolsService.ts');
	// un URI non «file:» perde query e frammento (che il disco ignora) e ha lo schema in minuscolo
	assert.match(tools, /return normalizePath\(parsed\.with\(\{ scheme: parsed\.scheme\.toLowerCase\(\), query: '', fragment: '' \}\)\)/);
	const create = tools.slice(tools.indexOf('create_file_or_folder: async ({ uri, isFolder })'), tools.indexOf('delete_file_or_folder: async ({ uri, isRecursive })'));
	assert.ok(create.length > 0);
	assert.ok(create.indexOf('writableOrThrow(removeTrailingPathSeparator(uri))') >= 0 && create.indexOf('writableOrThrow(removeTrailingPathSeparator(uri))') < create.indexOf('await fileService.createFolder(uri)'));
	const del = tools.slice(tools.indexOf('delete_file_or_folder: async ({ uri, isRecursive })'), tools.indexOf('rewrite_file: async ({ uri, newContent })'));
	assert.ok(del.length > 0);
	assert.ok(del.indexOf('writableOrThrow(target)') >= 0 && del.indexOf('writableOrThrow(target)') < del.indexOf('await fileService.del(uri'));
	const edit = await read('../browser/editCodeService.ts');
	const restore = edit.slice(edit.indexOf('public restoreVoxFileSnapshot('), edit.indexOf('// delete diffOfId and diffArea._diffOfId'));
	assert.ok(restore.length > 0);
	// in fila per file (senza badare alle maiuscole), apertura se serve, solo il file vero, poi il salvataggio
	const order = ['const key = extUriBiasedIgnorePathCase.getComparisonKey(uri)', 'await this._voxModelService.initializeModel(uri)', 'if (!model || !extUriBiasedIgnorePathCase.isEqual(model.uri, uri))', 'await this._restoreVoxFileSnapshot(uri, snapshot)', 'await this._voxModelService.saveModel(uri)', '(this._restoreQueueOfURI.get(key) ?? Promise.resolve()).then(restore)'];
	let at = -1;
	for (const step of order) { const i = restore.indexOf(step); assert.ok(i > at, step); at = i; }
	// la cache dei modelli non restituisce un modello chiuso
	const models = await read('./voxModelService.ts');
	assert.match(models, /if \(editorModelRef\.object\.isDisposed\(\) \|\| editorModelRef\.object\.textEditorModel\?\.isDisposed\(\)\) \{\n\t\t\treturn \{ model: null, editorModel: null \};/);
});

test('editCodeService: le modifiche immediate senza modello sollevano un errore invece di uscire in silenzio', async () => {
	const src = await read('../browser/editCodeService.ts');
	for (const name of ['public instantlyApplySearchReplaceBlocks(', 'public instantlyRewriteFile(']) {
		const start = src.indexOf(name);
		const body = src.slice(start, src.indexOf('const { diffZone, onFinishEdit } = res', start));
		assert.match(body, /if \(!res\) throw new Error\(t\("Vox could not open \{0\} to change it\.", uri\.fsPath\)\)/, name);
	}
});

test('prompt: le descrizioni dicono che il percorso può essere relativo e che rewrite_file crea il file', async () => {
	const src = await read('./prompt/prompts.ts');
	assert.match(src, /The path to the \$\{object\}: full, or relative to the project folder\. Only the path: never put the contents here\./);
	assert.match(src, /Optional\. The path to the folder: full, or relative to the project folder\. Leave this empty for the project folder \(with more than one, the first: pass a folder name for the others\)\./);
	assert.doesNotMatch(src, /Leave this as empty or "" to search all folders/);
	assert.match(src, /Create an EMPTY file or a folder at the given path\..*To create a file with its contents, use rewrite_file instead\./);
	assert.match(src, /Writes the whole file: creates it \(with any missing folders\) if it does not exist/);
	assert.match(src, /full path, or relative to the project folder/);
	assert.match(src, /Edit the contents of an existing file\..*The file must already exist: to create a file with its contents, use rewrite_file\./);
});

test('traduzioni: i messaggi nuovi hanno la loro voce italiana', async () => {
	const src = await read('./voxI18n.ts');
	for (const key of ["This path always needs your approval: it is in the project's .vox folder, goes through a link, or Vox could not check it.", '{0}: this path goes through a link that may point outside the project folder, or Vox could not check it. It always needs your approval.', '{0} is a project folder, or contains one: Vox does not delete it.', 'Vox could not open {0} to change it: {1}', 'The working directory {0} is not a folder on disk or in the project.', '{0} is the project folder, and it already exists. To create a folder with the same name inside it, pass its full path: {1}', '{0} is the project folder, and it already exists: there is nothing to create.', '{0} is a link that points to nothing (its target is missing): Vox does not change it.', 'Invalid path: {0}. On Windows a path that starts with a single slash points to the root of the drive, not to the project: use a path relative to the project folder (without the initial slash) or the full path with the drive letter.', '{0} is a folder, not a file.', 'The change to {0} was made in the editor but could not be saved to disk.', 'Invalid path: {0}. Variables like ${workspaceFolder}, %USERPROFILE% or $HOME are not expanded here: use a path relative to the project folder or the full path.', 'Invalid path: {0}. Windows device paths (\\\\\\\\.\\\\… or \\\\\\\\?\\\\… without a drive letter) are not files: use the full path with the drive letter.', '{0} is not a file or a folder (for example a Windows device name like nul or con).', '{0} is read-only in Vox: Vox does not change it.', 'No project folder is open: pass the full path of the folder to list.']) assert.ok(src.includes(`"${key}": "`), key);
	assert.ok(!src.includes('"{0} is a project folder: Vox does not delete it."'));
	// le versioni di prima degli avvisi sui percorsi non restano fra le traduzioni
	for (const old of ["This path always needs your approval: it is in the project's .vox folder or goes through a link.", '{0}: this path goes through a link that may point outside the project folder and always needs your approval.', '{0}: this path goes through a link that may point outside the project folder, or Vox could not check it: it always needs your approval.']) assert.ok(!src.includes(`"${old}"`), old);
});
