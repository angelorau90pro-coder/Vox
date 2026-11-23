import { CancellationToken } from '../../../../base/common/cancellation.js'
import { t } from '../common/voxI18n.js';
import { URI } from '../../../../base/common/uri.js'
import { FileOperationError, FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js'
import { ITextFileService } from '../../../services/textfile/common/textfiles.js'
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js'
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js'
import { folderOfRelativePath, hasUriScheme, ToolPathProblem, toolPathKindOf, withoutRootFolderName } from '../common/toolPaths.js'
import { Schemas } from '../../../../base/common/network.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoxModelService } from '../common/voxModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoxCommandBarService } from './voxCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { isWindows } from '../../../../base/common/platform.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { IVoxSettingsService } from '../common/voxSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { VSBuffer } from '../../../../base/common/buffer.js'
import { basename, extUriBiasedIgnorePathCase, joinPath, normalizePath, removeTrailingPathSeparator } from '../../../../base/common/resources.js'
import { taskLineOfUnknown, MAX_PROJECT_MEMORY_FILE_CHARS, appendProjectMemoryNote, DEFAULT_PROJECT_CONTEXT_LIMITS, parseTaskList, PROJECT_DIR_NAME, PROJECT_MEMORY_FILE, stringOfTaskList } from '../common/projectContext.js'


// tool use for AI
// asincrona: un percorso relativo può richiedere di guardare il disco (vedi uriOf)
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => Promise<BuiltinToolCallParams[T]> }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(t("Invalid model output: {0} was null.", argName))
	if (typeof value !== 'string') throw new Error(t('Invalid model output format: {0} must be a string, but its type is "{1}". Full value: {2}.', argName, typeof value, JSON.stringify(value)))
	return value
}


// il percorso nei messaggi d'errore: solo la prima riga e non troppo lungo (può contenere un file intero incollato)
const shortPathForError = (s: string) => {
	const firstLine = s.trim().split(/\r?\n/)[0]
	return JSON.stringify(firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine)
}

// il messaggio per il modello per ogni percorso non valido, che dice cosa passare
const pathProblemError = (problem: ToolPathProblem, uriStr: string): Error => {
	switch (problem) {
		case 'empty': return new Error(t("Invalid model output: the path is empty."))
		case 'content': return new Error(t("Invalid path: {0}. Pass only the path of the file or folder, without its contents, line breaks or tags.", shortPathForError(uriStr)))
		case 'driveRelative': return new Error(t("Invalid path: {0}. After the drive letter put a slash, for example C:\\folder\\file.txt, or use a path relative to the project folder.", shortPathForError(uriStr)))
		case 'driveRoot': return new Error(t("Invalid path: {0}. On Windows a path that starts with a single slash points to the root of the drive, not to the project: use a path relative to the project folder (without the initial slash) or the full path with the drive letter.", shortPathForError(uriStr)))
		case 'home': return new Error(t("Invalid path: {0}. \"~\" is not expanded: use the full path or a path relative to the project folder.", shortPathForError(uriStr)))
		case 'variable': return new Error(t("Invalid path: {0}. Variables like ${workspaceFolder}, %USERPROFILE% or $HOME are not expanded here: use a path relative to the project folder or the full path.", shortPathForError(uriStr)))
		case 'device': return new Error(t("Invalid path: {0}. Windows device paths (\\\\.\\… or \\\\?\\… without a drive letter) are not files: use the full path with the drive letter.", shortPathForError(uriStr)))
		case 'colon': return new Error(t("Invalid path: {0}. On Windows \":\" can only follow the drive letter: pass only the path of the file, without a line number (for example src/app.py, not src/app.py:10).", shortPathForError(uriStr)))
	}
}

// Qui non si controlla se il percorso sta nel workspace: lo fa chatThreadService, che per i percorsi esterni chiede sempre conferma.
// Un percorso relativo si risolve dentro la cartella del progetto (mai nella radice del disco); senza cartelle aperte è un errore.
const validateURI = (uriStr: unknown, folders: readonly IWorkspaceFolder[]) => {
	if (uriStr === null) throw new Error(t("Invalid model output: uri was null."))
	if (typeof uriStr !== 'string') throw new Error(t("Invalid model output format: the uri must be a string, but its type is \"{0}\". Full value: {1}.", typeof uriStr, JSON.stringify(uriStr)))

	// su Windows, con il progetto sul disco, «\main.py» indicherebbe la radice dell'unità: è un errore (toolPathKindOf)
	const windowsDisk = isWindows && folders.every(f => f.uri.scheme === 'file')
	const pathKind = toolPathKindOf(uriStr, { windows: windowsDisk })
	if (pathKind.kind === 'invalid') throw pathProblemError(pathKind.problem, uriStr)
	if (pathKind.kind === 'relative') {
		if (folders.length === 0) throw new Error(t("The path {0} is relative, but no project folder is open: use the full path.", shortPathForError(uriStr)))
		const { index, rel } = folderOfRelativePath(pathKind.rel, folders.map(f => [f.name, basename(f.uri)]))
		if (index < 0) throw new Error(t("The path {0} starts with a name shared by more than one project folder: use the full path.", shortPathForError(uriStr)))
		// normalizzato: un percorso con ".." che esce dal progetto deve risultare fuori (e chiedere conferma)
		return normalizePath(rel === '' ? folders[index].uri : joinPath(folders[index].uri, rel))
	}
	const absolute = pathKind.path

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (hasUriScheme(absolute)) {
		let parsed: URI
		try {
			parsed = URI.parse(absolute)
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(t("Invalid URI format: {0}. Error: {1}", absolute, e))
		}
		// Sul disco valgono solo il percorso e il server: query e frammento («file:///E:/progetto#x») il disco li ignora,
		// mentre il confronto con le cartelle del progetto li considera, e farebbero sembrare un'altra la cartella del
		// progetto (da non cancellare) o un file aperto. Il percorso del disco si controlla come quello scritto a mano
		// («file:///C:a.py» è «c:a.py», «file://» è la radice dell'unità). Lo schema vale anche scritto in maiuscolo
		// («FILE:///…», che URI.parse lascia com'è): il percorso del disco si calcola con «file». Si usa il percorso
		// controllato, che ha già perso il prefisso dei percorsi lunghi («file://./E:/progetto» è «E:\progetto»)
		if (parsed.scheme.toLowerCase() === Schemas.file) {
			const onDisk = parsed.with({ scheme: Schemas.file }).fsPath
			const local = toolPathKindOf(onDisk, { windows: windowsDisk })
			if (local.kind === 'invalid') throw pathProblemError(local.problem, uriStr)
			return normalizePath(URI.file(local.kind === 'absolute' ? local.path : onDisk))
		}
		// normalizzato: un percorso con ".." non deve sembrare dentro il progetto quando ne esce. Anche qui (per esempio
		// «vscode-remote://…») query e frammento si tolgono: il disco remoto li ignora, mentre con loro il confronto con le
		// cartelle del progetto farebbe sembrare un'altra la cartella del progetto, che così si potrebbe cancellare. Lo schema
		// va in minuscolo, come quello dei file system registrati («VSCODE-REMOTE://…» è «vscode-remote://…»)
		return normalizePath(parsed.with({ scheme: parsed.scheme.toLowerCase(), query: '', fragment: '' }))
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		return normalizePath(URI.file(absolute))
	}
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(t('Page number was not an integer: "{0}".', pageNumberUnknown))
	if (parsedInt < 1) throw new Error(t('Invalid model output format: the page number must be 1 or greater: "{0}".', pageNumberUnknown))
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(t("A value for terminalID must be specified, but the value was \"{0}\".", String(terminalIdUnknown)))
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


// In un indirizzo con uno schema la barra finale conta solo nel percorso: «file:///E:/a.py#nota/» è un file
const pointsToFolder = (uriStr: string) => {
	const trimmed = uriStr.trim()
	if (!hasUriScheme(trimmed)) return checkIfIsFolder(uriStr)
	try { return checkIfIsFolder(URI.parse(trimmed).path) } catch { return checkIfIsFolder(uriStr) }
}
const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	// fila delle aggiunte alla memoria di progetto: una alla volta
	private _memoryWriteQueue: Promise<unknown> = Promise.resolve()

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoxModelService voxModelService: IVoxModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoxCommandBarService private readonly commandBarService: IVoxCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		@ITextFileService textFileService: ITextFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		// i percorsi relativi si risolvono con le cartelle aperte al momento della chiamata
		// Con una cartella sola, un percorso che comincia con il nome della cartella stessa («progetto/calcolo.py», copiato
		// dall'albero dei file nel prompt) perde quel nome, a meno che lì dentro ci sia davvero una sottocartella che si chiama così.
		// Il nome da solo («progetto», «progetto/») indica la cartella del progetto, come «.»: cancellarla è impedito da
		// delete_file_or_folder, e rewrite_file ed edit_file la rifiutano perché è una cartella.
		const resolveUri = async (uriStr: unknown) => {
			const folders = workspaceContextService.getWorkspace().folders
			const uri = validateURI(uriStr, folders)
			if (folders.length !== 1 || typeof uriStr !== 'string') return uri
			const pathKind = toolPathKindOf(uriStr)
			if (pathKind.kind !== 'relative') return uri
			const prefixed = withoutRootFolderName(pathKind.rel, [basename(folders[0].uri), folders[0].name])
			if (prefixed === null) return uri
			// una sottocartella vera con quel nome vince; se il disco non risponde il percorso resta com'è
			let kind: 'file' | 'folder' | 'missing'
			try { kind = await fileKindOf(joinPath(folders[0].uri, prefixed.first)) } catch { return uri }
			if (kind === 'folder') return uri
			// un file vero che si chiama come la cartella («mytool/mytool») resta quel file; con la barra finale («mytool/»)
			// si chiede una cartella, quindi la cartella del progetto
			if (kind === 'file' && prefixed.rest === '' && !pointsToFolder(uriStr)) return uri
			const candidate = normalizePath(prefixed.rest === '' ? folders[0].uri : joinPath(folders[0].uri, prefixed.rest))
			// «progetto/../a.py»: senza il nome si uscirebbe dal progetto; vale la risoluzione di prima
			if (!extUriBiasedIgnorePathCase.isEqualOrParent(candidate, folders[0].uri)) return uri
			return candidate
		}
		// Sempre la forma canonica dell'indirizzo, cioè quella con cui VS Code ha già aperto il file: su Windows «calcolo.py»
		// e «Calcolo.py» sono lo stesso file, ma il servizio dei file salva e cerca i modelli per indirizzo esatto. Con la
		// forma del modello il salvataggio trova il file aperto, invece di non salvare niente
		const uriOf = async (uriStr: unknown) => uriIdentityService.asCanonicalUri(await resolveUri(uriStr))
		// un parametro facoltativo vuoto o di soli spazi vale come assente
		const isBlank = (u: unknown) => isFalsy(u) || (typeof u === 'string' && u.trim() === '')
		const optionalUriOf = async (uriStr: unknown) => isBlank(uriStr) ? null : uriOf(uriStr)
		// cartella di lavoro del terminale: un percorso relativo diventa quello completo dentro il progetto (così il terminale
		// parte lì e il controllo «fuori dal progetto» vede il percorso vero); un percorso assoluto diventa quello del disco
		// (senza spazi ai lati, «..» risolto); con uno schema davanti («file://», «vscode-remote://») si passa il solo percorso
		const cwdOf = async (cwdUnknown: unknown) => {
			if (isBlank(cwdUnknown)) return null
			const cwd = validateStr('cwd', cwdUnknown)
			const uri = await uriOf(cwd) // solleva l'errore per un percorso non valido
			// uno schema che non è il disco né quello delle cartelle aperte («http://…») non è una cartella in cui lavorare
			if (uri.scheme !== 'file' && !workspaceContextService.getWorkspace().folders.some(f => f.uri.scheme === uri.scheme)) throw new Error(t("The working directory {0} is not a folder on disk or in the project.", shortPathForError(cwd)))
			// sempre il percorso del disco dell'URI, anche per un percorso assoluto: «/C:/progetto» diventa «c:\progetto»,
			// che il terminale di Windows capisce, e «..» è già risolto come nel controllo «fuori dal progetto»
			const resolved = uri.scheme === 'file' ? uri.fsPath : uri.path
			// «file://» da solo non indica nessuna cartella: il terminale riceverebbe una stringa vuota
			if (resolved.trim() === '') throw new Error(t("The working directory {0} is not a folder on disk or in the project.", shortPathForError(cwd)))
			return resolved
		}

		// che cosa c'è al percorso: solo «non trovato» vale come assente, gli altri errori (permessi, disco) salgono
		const fileKindOf = async (uri: URI): Promise<'file' | 'folder' | 'missing'> => {
			let stat: { isFile: boolean, isDirectory: boolean, isSymbolicLink: boolean }
			try {
				stat = await fileService.stat(uri)
			} catch (e) {
				if (e instanceof Error && toFileOperationResult(e) === FileOperationResult.FILE_NOT_FOUND) return 'missing'
				throw e
			}
			if (stat.isDirectory) return 'folder'
			if (stat.isFile) return 'file'
			// un collegamento che non punta più a niente: né file né cartella, ma il motivo è un altro
			if (stat.isSymbolicLink) throw new Error(t("{0} is a link that points to nothing (its target is missing): Vox does not change it.", uri.fsPath))
			// un nome riservato di Windows («nul», «con»): né file né cartella, scriverci non cambia nessun file
			throw new Error(t("{0} is not a file or a folder (for example a Windows device name like nul or con).", uri.fsPath))
		}
		// la modifica è nel modello: va salvata su disco, e se il salvataggio non riesce lo strumento non dice «riuscito»
		// Con «fileWasMissing» (file cancellato dal disco, modello ancora aperto) il salvataggio è forzato: se il testo non è
		// cambiato il modello non risulta da salvare e senza forzare non si scriverebbe niente; poi si controlla che il file ci sia.
		const saveOrThrow = async (uri: URI, fileWasMissing = false) => {
			// il salvataggio deve risultare avvenuto (un file in sola lettura o un errore del disco lasciano il modello senza
			// modifiche da salvare, ma il file non cambia); il file deve esserci anche quando c'era già: cancellato dopo il
			// controllo iniziale, con il testo uguale il salvataggio non forzato non lo riscrive
			const saved = await voxModelService.saveModel(uri, { force: fileWasMissing })
			if (!saved || textFileService.isDirty(uri) || await fileKindOf(uri) !== 'file') throw new Error(t("The change to {0} was made in the editor but could not be saved to disk.", uri.fsPath))
		}
		// Vox tiene i modelli per percorso del disco: con un notebook aperto (le sue celle) o un confronto con git, sotto lo
		// stesso percorso può esserci un modello che non è il file sul disco. Scriverci darebbe «riuscito» senza toccare
		// il file, leggerlo darebbe un altro contenuto: meglio un errore.
		const fileModelOrThrow = (uri: URI, model: { uri: URI }) => {
			if (!extUriBiasedIgnorePathCase.isEqual(model.uri, uri)) throw new Error(t("Vox has {0} open in another form (for example as a notebook or in a comparison), not as the file on disk: ask the user to close it and try again.", uri.fsPath))
		}
		// un file in sola lettura (impostazioni, sessione, file system) non si modifica: la modifica resterebbe nell'editor,
		// che non la salva, e lo strumento risponderebbe «riuscito». Vale anche per un file da creare
		const writableOrThrow = (uri: URI) => {
			if (filesConfigurationService.isReadonly(uri)) throw new Error(t("{0} is read-only in Vox: Vox does not change it.", uri.fsPath))
		}
		// prepara il file per la modifica: modello aperto (altrimenti errore, con il motivo se c'è) e modifiche precedenti
		// salvate. Si apre prima qui, per avere il motivo di un'apertura non riuscita (file binario, permessi…); poi
		// callBeforeApplyOrEdit trova il modello già aperto e salva.
		const openForEditOrThrow = async (uri: URI) => {
			const reason = await voxModelService.initializeModel(uri)
			const { model, editorModel } = voxModelService.getModel(uri)
			if (!model) {
				if (reason) throw new Error(t("Vox could not open {0} to change it: {1}", uri.fsPath, reason))
				throw new Error(t("Vox could not open {0} to change it.", uri.fsPath))
			}
			fileModelOrThrow(uri, model)
			if (editorModel?.isReadonly()) throw new Error(t("{0} is read-only in Vox: Vox does not change it.", uri.fsPath))
			await editCodeService.callBeforeApplyOrEdit(uri)
		}
		const lintErrorsLater = (uri: URI) => Promise.resolve().then(async () => {
			await timeout(2000)
			const { lintErrors } = this._getLintErrors(uri)
			return { lintErrors }
		})

		this.validateParams = {
			read_file: async (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = await uriOf(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: async (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				// senza percorso: la cartella del progetto (come dice la descrizione dello strumento)
				if (isBlank(uriStr) && workspaceContextService.getWorkspace().folders.length === 0) throw new Error(t("No project folder is open: pass the full path of the folder to list."))
				const uri = await uriOf(isBlank(uriStr) ? '.' : uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: async (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = await uriOf(uriStr)
				return { uri }
			},
			search_pathnames_only: async (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: async (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = await optionalUriOf(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: async (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = await uriOf(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: async (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = await uriOf(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: async (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = await uriOf(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = pointsToFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: async (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = await uriOf(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = pointsToFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: async (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = await uriOf(uriStr)
				// una barra finale indica una cartella, anche se non esiste ancora
				if (typeof uriStr === 'string' && pointsToFolder(uriStr)) throw new Error(t("{0} is a folder, not a file.", uri.fsPath))
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: async (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = await uriOf(uriStr)
				if (typeof uriStr === 'string' && pointsToFolder(uriStr)) throw new Error(t("{0} is a folder, not a file.", uri.fsPath))
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: async (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = await cwdOf(cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: async (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: async (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = await cwdOf(cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: async (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},
			// ---
			update_project_memory: async (params: RawToolParamsObj) => {
				const note = validateStr('note', params.note)
				// la memoria sta sempre nella prima cartella del progetto: il modello non sceglie il percorso
				const folder = workspaceContextService.getWorkspace().folders[0]
				if (!folder) throw new Error(t("No project folder is open, so there is no project memory to update."))
				const uri = joinPath(folder.uri, PROJECT_DIR_NAME, PROJECT_MEMORY_FILE)
				// controlla subito la nota (vuota o troppo lunga), prima di chiedere conferma all'utente
				appendProjectMemoryNote('', note, '', t)
				return { uri, note }
			},
			update_task_list: async (params: RawToolParamsObj) => {
				// alcuni modelli mandano un elenco JSON invece del testo: si accetta lo stesso
				const raw: unknown = params.tasks
				const tasksStr = Array.isArray(raw) ? raw.map(taskLineOfUnknown).join('\n') : raw
				const tasks = parseTaskList(validateStr('tasks', tasksStr), t)
				return { tasks }
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				const { model } = await voxModelService.getModelSafe(uri) // apre il modello se serve
				if (model === null) { throw new Error(t("No contents: the file does not exist.")) }
				fileModelOrThrow(uri, model)

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				const { model } = await voxModelService.getModelSafe(uri); // apre il modello se serve
				if (model === null) { throw new Error(t("No contents: the file does not exist.")); }
				fileModelOrThrow(uri, model)
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				// «progetto/» indica la cartella del progetto, che esiste già: senza questo errore lo strumento direbbe «creato»
				// senza creare niente, anche quando il modello voleva una sottocartella con lo stesso nome
				const projectFolder = workspaceContextService.getWorkspace().folders.find(f => extUriBiasedIgnorePathCase.isEqual(removeTrailingPathSeparator(f.uri), removeTrailingPathSeparator(uri)))
				// il consiglio dà il percorso completo: «nome/nome/» funzionerebbe una volta sola, perché dopo la creazione
				// «nome/nome/a.py» indicherebbe un livello in più (il nome in testa non si toglie se la sottocartella c'è)
				if (projectFolder) {
					// con il progetto nella radice di un'unità il nome è «E:» (o vuoto): il consiglio non sarebbe un percorso
					const name = basename(projectFolder.uri)
					if (!name || /^[A-Za-z]:$/.test(name)) throw new Error(t("{0} is the project folder, and it already exists: there is nothing to create.", uri.fsPath))
					throw new Error(t("{0} is the project folder, and it already exists. To create a folder with the same name inside it, pass its full path: {1}", uri.fsPath, joinPath(projectFolder.uri, name).fsPath + (isWindows ? '\\' : '/')))
				}
				// la sola lettura vale anche per creare (un file nuovo in una cartella protetta) e per cancellare; senza la barra
				// finale, che le regole delle impostazioni non hanno («protetta/» è la cartella «protetta»)
				writableOrThrow(removeTrailingPathSeparator(uri))
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				// Una cartella del progetto, o una che la contiene, non si cancella da qui (per esempio con «progetto/» o con il
				// percorso completo). Il confronto non bada alle maiuscole né alla barra finale, come il file system di Windows.
				// È un confronto sui percorsi: un percorso che arriva al progetto attraverso un collegamento (giunzione) risulta
				// fuori dal progetto, quindi passa comunque dalla conferma esplicita dell'utente.
				const target = removeTrailingPathSeparator(uri)
				if (workspaceContextService.getWorkspace().folders.some(f => extUriBiasedIgnorePathCase.isEqualOrParent(removeTrailingPathSeparator(f.uri), target))) throw new Error(t("{0} is a project folder, or contains one: Vox does not delete it.", uri.fsPath))
				// (in una cartella si controlla la cartella, non i file che contiene)
				writableOrThrow(target)
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(t("Another model is currently making changes to this file. Stop for now and ask the user to resume later."))
				}
				const kind = await fileKindOf(uri)
				if (kind === 'folder') throw new Error(t("{0} is a folder, not a file.", uri.fsPath))
				writableOrThrow(uri)
				// File nuovo: creato già con il contenuto (anche le cartelle che mancano), invece di nascere vuoto e riempirsi
				// dopo. La scrittura non è atomica: un errore a metà (disco pieno) può lasciare un file incompleto. Se però Vox
				// tiene ancora aperto il modello di un file cancellato, si scrive attraverso quello: altrimenti il modello vecchio
				// resterebbe in memoria e il salvataggio della modifica successiva riscriverebbe il contenuto vecchio.
				const open = voxModelService.getModel(uri).model
				if (kind === 'missing' && !(open && extUriBiasedIgnorePathCase.isEqual(open.uri, uri))) {
					// textFileService rispetta la codifica impostata (files.encoding) e avvisa i servizi dei file di lavoro
					await textFileService.create([{ resource: uri, value: newContent, options: { overwrite: false } }])
					// aperto subito: così anche la modifica successiva ha il suo checkpoint
					await voxModelService.initializeModel(uri)
					return { result: lintErrorsLater(uri) }
				}
				await openForEditOrThrow(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				await saveOrThrow(uri, kind === 'missing')
				return { result: lintErrorsLater(uri) }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(t("Another model is currently making changes to this file. Stop for now and ask the user to resume later."))
				}
				const kind = await fileKindOf(uri)
				if (kind === 'folder') throw new Error(t("{0} is a folder, not a file.", uri.fsPath))
				if (kind === 'missing') throw new Error(t("The file {0} does not exist. To create it with its contents, use rewrite_file.", uri.fsPath))
				writableOrThrow(uri)
				await openForEditOrThrow(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })
				await saveOrThrow(uri)

				// at end, get lint errors
				const lintErrorsPromise = lintErrorsLater(uri)

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
			// ---
			update_project_memory: async ({ uri, note }) => {
				const d = new Date()
				const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
				// Nessuna nota deve andare persa: le aggiunte di questa finestra vanno in fila, e la scrittura
				// controlla che il file non sia cambiato dopo la lettura (un'altra finestra, l'utente); se è cambiato si rilegge e si riprova.
				const refuseLink = async (target: URI, what: string) => {
					let isLink = false
					try { isLink = (await fileService.stat(target)).isSymbolicLink } catch { /* non esiste ancora: verrà creato come file o cartella vera */ }
					if (isLink) throw new Error(what === '.vox'
						? t("{0} is a symbolic link or junction: the project memory is not written through links. Replace it with a real folder first.", what)
						: t("{0} is a symbolic link or junction: the project memory is not written through links. Replace it with a real file first.", what))
				}
				const appendOnce = async (): Promise<number> => {
					for (let attempt = 0; ; attempt++) {
						await refuseLink(joinPath(uri, '..'), '.vox')
						await refuseLink(uri, '.vox/memory.md')
						let existing = ''
						let version: { mtime: number, etag: string } | undefined = undefined
						try {
							const file = await fileService.readFile(uri)
							existing = file.value.toString()
							version = { mtime: file.mtime, etag: file.etag }
						} catch (e) {
							if (!(e instanceof FileOperationError) || e.fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) throw e
						}
						// tetto duro: oltre questa misura il file non cresce più, va prima riscritto in breve
						const updated = appendProjectMemoryNote(existing, note, dateStr, t)
						// tetto duro: la memoria non cresce oltre la parte mostrata nelle chat, altrimenti la nota verrebbe salvata ma mai più letta
						if (updated.length > MAX_PROJECT_MEMORY_FILE_CHARS) throw new Error(t("The project memory file is full ({0} characters, the limit with this note is {1}). Rewrite .vox/memory.md more concisely first (keep what still matters, drop the rest), then save the note again.", existing.length, MAX_PROJECT_MEMORY_FILE_CHARS))
						// il controllo di versione del file service non vede una modifica della stessa lunghezza: si rilegge e si confronta il testo
						if (version) {
							const again = (await fileService.readFile(uri)).value.toString()
							if (again !== existing) { if (attempt >= 4) throw new Error(t("The project memory file keeps changing while saving. Try again.")); continue }
						}
						try {
							if (version) await fileService.writeFile(uri, VSBuffer.fromString(updated), version)
							else await fileService.createFile(uri, VSBuffer.fromString(updated), { overwrite: false })
							return updated.length
						} catch (e) {
							const result = e instanceof FileOperationError ? e.fileOperationResult : undefined
							const changedMeanwhile = result === FileOperationResult.FILE_MODIFIED_SINCE
							if (!changedMeanwhile) throw e
							// stesso messaggio della rilettura: il conflitto può emergere in tutti e due i punti
							if (attempt >= 4) throw new Error(t("The project memory file keeps changing while saving. Try again."))
						}
					}
				}
				const run = this._memoryWriteQueue.then(appendOnce, appendOnce)
				this._memoryWriteQueue = run.catch(() => { })
				return { result: { memoryChars: await run } }
			},
			update_task_list: async () => {
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voxModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voxSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voxSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Vox after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(t("Unexpected internal error: the terminal command did not end with a valid reason."))
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(t("Unexpected internal error: the terminal command did not end with a valid reason."))
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
			update_project_memory: (_params, result) => {
				const max = DEFAULT_PROJECT_CONTEXT_LIMITS.maxMemoryChars
				const warning = result.memoryChars > max ? ` WARNING: the memory file is now ${result.memoryChars} characters long and only the first ${max} are shown in future conversations. Rewrite .vox/memory.md more concisely (keep what still matters, drop the rest).` : ''
				return `Note saved to the project memory.${warning}`
			},
			update_task_list: (params, _result) => {
				return `Task list updated:\n${stringOfTaskList(params.tasks)}`
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
