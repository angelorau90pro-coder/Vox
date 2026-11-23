/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Libreria dei modelli locali nel processo principale: collega il nucleo (`localModelLibraryCore.ts`) a rete, disco,
// Cestino e gestore dei modelli accesi. Lo scarico (`localModelDownload.ts`) è l'unico punto di Vox che parla con
// Internet e non riceve mai conversazioni, codice o impostazioni dell'utente.
import { shell } from 'electron';
import { stat, statfs, unlink } from 'node:fs/promises';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localModelCatalog, urlOfLocalModelCatalogEntry } from '../../common/localModelCatalog.js';
import { ILocalModelLibraryService } from '../../common/localModelLibraryService.js';
import { LocalModelCatalogEntry, LocalModelContextChange, LocalModelContextResult, LocalModelDownloadRequest, LocalModelLibraryState, LocalModelRemoval, LocalModelRemovalResult, LocalModelRepoFilesResponse, LocalModelSearchResponse } from '../../common/localModelLibraryTypes.js';
import { localModelManager } from '../llmMessage/localModels.js';
import { createLocalModelLibrary } from './localModelLibraryCore.js';
import { downloadLocalModel, removePartialDownload, restorePartialDownload, verifyLocalModelFile } from './localModelDownload.js';
import { listLocalModelRepoFiles, searchLocalModels } from './localModelSearch.js';
import { addLocalModelToManifest, listInstalledLocalModels, removeLocalModelFromManifest, setLocalModelContextInManifest } from './localModelManifest.js';
import { createLocalModelFileIfMissing } from './localModelFiles.js';
import { localModelBundledFiles } from './localModelTemplates.js';

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

export class LocalModelLibraryMainService extends Disposable implements ILocalModelLibraryService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<LocalModelLibraryState>());
	readonly onDidChangeState: Event<LocalModelLibraryState> = this._onDidChangeState.event;

	private readonly library = createLocalModelLibrary({
		findFolder: cartella => localModelManager.folderOf(typeof cartella === 'string' ? cartella : ''),
		forgetFolder: cartella => localModelManager.forgetFolder(typeof cartella === 'string' ? cartella : ''),
		isRunning: nome => localModelManager.isRunning(nome),
		// se il modello sta rispondendo si aspetta poco: meglio dire «in uso, riprova» che lasciare ferma la pagina per minuti
		closeForRemoval: nome => localModelManager.closeForRemoval(nome, AbortSignal.timeout(10000)),
		blockStarts: nome => localModelManager.blockStarts(nome),
		listInstalled: folder => listInstalledLocalModels(folder, nome => localModelManager.isRunning(nome)),
		addToManifest: (folder, entry) => addLocalModelToManifest(folder, entry),
		removeFromManifest: (folder, nome) => removeLocalModelFromManifest(folder, nome),
		setContextInManifest: (folder, nome, contesto) => setLocalModelContextInManifest(folder, nome, contesto),
		download: p => downloadLocalModel(p),
		verifyExisting: p => verifyLocalModelFile(p),
		removePartial: destination => removePartialDownload(destination),
		restorePartial: destination => restorePartialDownload(destination),
		freeBytes: async folder => { const disk = await statfs(folder); return Number(disk.bavail) * Number(disk.bsize) },
		// una cartella con quel nome non è un file: vale come assente (lo scarico poi la rifiuta, un file di opzione risulta mancante)
		sizeOf: async file => { try { const found = await stat(file); return found.isFile() ? found.size : null } catch (error) { if (missing(error)) return null; throw error } },
		bundledFiles: localModelBundledFiles,
		createFileIfMissing: (file, content) => createLocalModelFileIfMissing(file, content),
		trash: file => shell.trashItem(file),
		unlink: async file => { try { await unlink(file) } catch (error) { if (!missing(error)) throw error } },
		now: () => Date.now(),
		catalog: localModelCatalog,
		urlOfCatalogEntry: urlOfLocalModelCatalogEntry,
		emit: state => this._onDidChangeState.fire(state),
	});

	constructor() {
		super();
		// alla chiusura di Vox lo scarico si ferma e il file parziale resta, per riprendere la volta dopo
		this._register({ dispose: () => { this.library.dispose(); this.searching?.abort(); this.reading?.abort() } });
	}

	// dalla finestra arriva qualunque valore: conta solo `true`
	getState(cartella: string, ricontrolla?: boolean): Promise<LocalModelLibraryState> { return this.library.getState(cartella, ricontrolla === true) }
	getCatalog(): Promise<LocalModelCatalogEntry[]> { return this.library.getCatalog() }
	startDownload(cartella: string, request: LocalModelDownloadRequest): Promise<void> { return this.library.startDownload(cartella, request) }
	cancelDownload(tieniParziale: boolean): Promise<void> { return this.library.cancelDownload(tieniParziale) }
	removeModel(cartella: string, removal: LocalModelRemoval): Promise<LocalModelRemovalResult> { return this.library.removeModel(cartella, removal) }
	setContext(cartella: string, change: LocalModelContextChange): Promise<LocalModelContextResult> { return this.library.setContext(cartella, change) }

	// Una ricerca (o una lettura dei file) nuova annulla quella prima: conta solo l'ultima cosa chiesta dall'utente.
	private searching: AbortController | undefined;
	private reading: AbortController | undefined;
	async searchModels(testo: string): Promise<LocalModelSearchResponse> {
		this.searching?.abort();
		const controller = this.searching = new AbortController();
		try { return { esito: 'fatto', risultati: await searchLocalModels(testo, controller.signal) } }
		catch (error) { return controller.signal.aborted ? { esito: 'annullato' } : { esito: 'errore', messaggio: error instanceof Error && error.message ? error.message : String(error) } }
		finally { if (this.searching === controller) this.searching = undefined }
	}
	async getRepoFiles(repo: string): Promise<LocalModelRepoFilesResponse> {
		this.reading?.abort();
		const controller = this.reading = new AbortController();
		try { return { esito: 'fatto', repository: await listLocalModelRepoFiles(repo, controller.signal) } }
		catch (error) { return controller.signal.aborted ? { esito: 'annullato' } : { esito: 'errore', messaggio: error instanceof Error && error.message ? error.message : String(error) } }
		finally { if (this.reading === controller) this.reading = undefined }
	}
}
