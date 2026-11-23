import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import {
	PROJECT_DIR_NAME,
	PROJECT_INSTRUCTIONS_FILE,
	PROJECT_KNOWLEDGE_DIR,
	PROJECT_MEMORY_FILE,
	ProjectContext,
	ProjectKnowledgeFile,
	buildProjectContextBlock,
	DEFAULT_PROJECT_CONTEXT_LIMITS,
	isKnowledgeFileName,
	isProjectContextEmpty,
} from '../common/projectContext.js';

// non leggere file piu' grandi di questo
const MAX_FILE_BYTES = 1_000_000;
// livelli massimi di sottocartelle sotto .vox/knowledge/
const MAX_KNOWLEDGE_DEPTH = 3;

export interface IProjectContextService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;                    // quando cambia qualcosa sotto .vox/ o cambiano le cartelle del workspace
	getProjectContexts(): Promise<ProjectContext[]>;      // uno per cartella del workspace che ha contenuto, con cache
	getProjectContextBlock(): Promise<string>;            // buildProjectContextBlock(await getProjectContexts())
	getProjectDirUri(folder: URI): URI;                   // <cartella>/.vox
}

export const IProjectContextService = createDecorator<IProjectContextService>('voxProjectContextService');

class ProjectContextService extends Disposable implements IProjectContextService {

	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _cacheKey = '';
	private _cache: Promise<ProjectContext[]> | null = null;
	// watcher delle .vox esistenti, chiave = uri.toString(); solo differenze, mai smontati e rimontati
	private readonly _watchers = this._register(new DisposableMap<string, IDisposable>());
	private _watchGeneration = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustService: IWorkspaceTrustManagementService,
	) {
		super();

		this._register(this._workspaceTrustService.onDidChangeTrust(() => { this._invalidate(); this._refreshWatchers(); }));

		this._register(this._fileService.onDidFilesChange(e => {
			const hit = this._workspaceContextService.getWorkspace().folders
				.some(folder => e.affects(this.getProjectDirUri(folder.uri)));
			if (hit) this._invalidate();
		}));

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._invalidate();
			this._refreshWatchers();
		}));

		this._refreshWatchers();
	}

	getProjectDirUri(folder: URI): URI {
		return URI.joinPath(folder, PROJECT_DIR_NAME);
	}

	async getProjectContexts(): Promise<ProjectContext[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		const key = folders.map(f => f.uri.toString()).join('|');
		if (this._cache === null || key !== this._cacheKey) {
			this._cacheKey = key;
			// un errore non resta in cache: alla prossima richiesta si riprova
			this._cache = this._computeContexts().catch(() => { this._cache = null; return [] as ProjectContext[]; });
		}
		return [...await this._cache];
	}

	async getProjectContextBlock(): Promise<string> {
		return buildProjectContextBlock(await this.getProjectContexts());
	}

	private _invalidate(): void {
		this._cache = null;
		this._onDidChange.fire();
	}

	private async _computeContexts(): Promise<ProjectContext[]> {
		// Cartella non attendibile (modalità con restrizioni): il suo .vox non entra nelle chat,
		// perché istruzioni scritte da altri finirebbero nel messaggio di sistema senza che l'utente lo sappia.
		if (!this._workspaceTrustService.isWorkspaceTrusted()) return [];
		const folders = this._workspaceContextService.getWorkspace().folders;
		const contexts = await Promise.all(folders.map(folder => this._readFolderContext(folder.uri, folder.name)));
		// aggiorna i watcher dopo ogni rilettura, cosi' anche un .vox appena creato viene sorvegliato
		this._refreshWatchers();
		return contexts.filter(ctx => !isProjectContextEmpty(ctx));
	}

	private async _readFolderContext(folderUri: URI, folderName: string): Promise<ProjectContext> {
		const ctx: ProjectContext = { folderName, instructions: '', memory: '', knowledge: [] };
		const projectDir = this.getProjectDirUri(folderUri);
		// .vox deve essere una cartella vera: un collegamento potrebbe portare nelle chat file esterni al progetto
		if (!await this._isRealPath(projectDir, true)) return ctx;
		const knowledgeDir = URI.joinPath(projectDir, PROJECT_KNOWLEDGE_DIR);
		ctx.instructions = await this._readTextFile(URI.joinPath(projectDir, PROJECT_INSTRUCTIONS_FILE));
		ctx.memory = await this._readTextFile(URI.joinPath(projectDir, PROJECT_MEMORY_FILE));
		ctx.knowledge = await this._isRealPath(knowledgeDir, true) ? await this._readKnowledge(knowledgeDir) : [];
		return ctx;
	}

	// vero solo se il percorso esiste, è del tipo atteso e NON è un collegamento simbolico o una giunzione:
	// i collegamenti non si seguono mai, perché il contenuto letto qui viene inviato al fornitore dell'IA senza conferma
	private async _isRealPath(uri: URI, directory: boolean): Promise<boolean> {
		try {
			const stat = await this._fileService.stat(uri);
			return !stat.isSymbolicLink && (directory ? stat.isDirectory : stat.isFile);
		} catch {
			return false;
		}
	}

	// legge un file di testo con tetto di 1 MB; qualsiasi errore (mancante, troppo grande, illeggibile) -> ''
	private async _readTextFile(uri: URI): Promise<string> {
		if (!await this._isRealPath(uri, false)) return '';
		try {
			const content = await this._fileService.readFile(uri, { limits: { size: MAX_FILE_BYTES } });
			return content.value.toString();
		} catch {
			return '';
		}
	}

	// elenca i file di conoscenza (solo nomi, via resolve), poi legge solo quelli che servono;
	// i file oltre i limiti di numero/byte o illeggibili restano con skipped: true
	private async _readKnowledge(dirUri: URI): Promise<ProjectKnowledgeFile[]> {
		const candidates = await this._listKnowledgeFiles(dirUri, '', 0);
		candidates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		const limits = DEFAULT_PROJECT_CONTEXT_LIMITS;
		const out: ProjectKnowledgeFile[] = [];
		let charsRead = 0;
		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i];
			// niente lettura oltre il tetto, ma il nome resta elencato come escluso
			if (i >= limits.maxKnowledgeFiles || charsRead > 4 * limits.maxKnowledgeTotalChars) {
				out.push({ name: c.name, content: '', skipped: true });
				continue;
			}
			try {
				const content = await this._fileService.readFile(c.uri, { limits: { size: MAX_FILE_BYTES } });
				const text = content.value.toString();
				charsRead += text.length;
				out.push({ name: c.name, content: text });
			} catch {
				out.push({ name: c.name, content: '', skipped: true });
			}
		}
		return out;
	}

	// raccoglie nome e uri dei file di conoscenza, senza leggerli; depth = livelli di sottocartelle sotto knowledge/
	private async _listKnowledgeFiles(dirUri: URI, relDir: string, depth: number): Promise<{ name: string; uri: URI }[]> {
		let children: IFileStat[];
		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.isDirectory || !stat.children) return [];
			children = stat.children;
		} catch {
			return [];
		}
		const out: { name: string; uri: URI }[] = [];
		for (const child of children) {
			const childRel = relDir ? `${relDir}/${child.name}` : child.name;
			const childUri = URI.joinPath(dirUri, child.name);
			if (child.isSymbolicLink) continue; // i collegamenti non si seguono (vedi _isRealPath)
			if (child.isDirectory) {
				if (depth < MAX_KNOWLEDGE_DEPTH) {
					out.push(...await this._listKnowledgeFiles(childUri, childRel, depth + 1));
				}
			} else if (child.isFile && isKnowledgeFileName(child.name)) {
				out.push({ name: childRel, uri: childUri });
			}
		}
		return out;
	}

	// sorveglia le cartelle .vox esistenti, aggiungendo o togliendo solo quando cambia l'insieme;
	// il contatore di generazione scarta le risposte di exists() arrivate dopo una nuova chiamata
	private _refreshWatchers(): void {
		const generation = ++this._watchGeneration;
		const folders = this._workspaceContextService.getWorkspace().folders;
		Promise.all(folders.map(async folder => {
			const projectDir = this.getProjectDirUri(folder.uri);
			try {
				// si sorveglia solo un .vox vero e solo nelle cartelle attendibili: un collegamento potrebbe puntare a una cartella enorme
				return this._workspaceTrustService.isWorkspaceTrusted() && await this._isRealPath(projectDir, true) ? projectDir : null;
			} catch {
				return null;
			}
		})).then(dirs => {
			if (generation !== this._watchGeneration || this._store.isDisposed) return;
			const wanted = new Set<string>();
			for (const dir of dirs) {
				if (!dir) continue;
				wanted.add(dir.toString());
				if (!this._watchers.has(dir.toString())) {
					this._watchers.set(dir.toString(), this._fileService.watch(dir, { recursive: true, excludes: [] }));
				}
			}
			for (const key of [...this._watchers.keys()]) {
				if (!wanted.has(key)) this._watchers.deleteAndDispose(key);
			}
		}).catch(() => { /* ignora: il watch e' best-effort */ });
	}
}

registerSingleton(IProjectContextService, ProjectContextService, InstantiationType.Delayed);
