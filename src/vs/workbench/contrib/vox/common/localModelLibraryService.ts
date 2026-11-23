/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { LOCAL_MODEL_LIBRARY_CHANNEL, LocalModelCatalogEntry, LocalModelContextChange, LocalModelContextResult, LocalModelDownloadRequest, LocalModelLibraryState, LocalModelRemoval, LocalModelRemovalResult, LocalModelRepoFilesResponse, LocalModelSearchResponse } from './localModelLibraryTypes.js';

// Libreria dei modelli locali: scarica un modello nuovo nella cartella `ia-locali` e toglie quelli che non servono più.
// Il lavoro si fa nel processo principale (`electron-main/localModelLibrary/`); qui c'è solo il collegamento.
// `cartella` è quella scritta nelle Impostazioni (`settingsOfProvider.voxLocal.folder`), vuota per la ricerca automatica.
export interface ILocalModelLibraryService {
	readonly _serviceBrand: undefined;
	// cambia a ogni passo di uno scarico e dopo ogni aggiunta o rimozione
	readonly onDidChangeState: Event<LocalModelLibraryState>;
	// `ricontrolla`: la cartella si cerca di nuovo sul disco, senza l'esito degli ultimi secondi («Controlla di nuovo»)
	getState(cartella: string, ricontrolla?: boolean): Promise<LocalModelLibraryState>;
	getCatalog(): Promise<LocalModelCatalogEntry[]>;
	// Risolve quando lo scarico è partito; avanzamento, fine ed errori arrivano con `onDidChangeState`.
	// Rifiuta (con un messaggio già tradotto) se la richiesta non è valida o se c'è già uno scarico in corso.
	startDownload(cartella: string, request: LocalModelDownloadRequest): Promise<void>;
	// `tieniParziale`: lascia sul disco il file scaricato fin qui, così lo scarico può riprendere
	cancelDownload(tieniParziale: boolean): Promise<void>;
	removeModel(cartella: string, removal: LocalModelRemoval): Promise<LocalModelRemovalResult>;
	// cambia il contesto di un modello in `modelli.json`; un modello acceso si riavvia alla prossima richiesta
	setContext(cartella: string, change: LocalModelContextChange): Promise<LocalModelContextResult>;
	// Cerca su Hugging Face i repository con file GGUF. A Hugging Face arriva solo `testo`. Una ricerca nuova annulla la precedente.
	searchModels(testo: string): Promise<LocalModelSearchResponse>;
	// I file `.gguf` di un repository trovato dalla ricerca, con dimensione e revisione.
	getRepoFiles(repo: string): Promise<LocalModelRepoFilesResponse>;
}

export const ILocalModelLibraryService = createDecorator<ILocalModelLibraryService>('voxLocalModelLibraryService');

// lato finestra: inoltra tutto al processo principale
export class LocalModelLibraryService implements ILocalModelLibraryService {
	readonly _serviceBrand: undefined;
	private readonly _main: ILocalModelLibraryService;
	readonly onDidChangeState: Event<LocalModelLibraryState>;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this._main = ProxyChannel.toService<ILocalModelLibraryService>(mainProcessService.getChannel(LOCAL_MODEL_LIBRARY_CHANNEL));
		this.onDidChangeState = this._main.onDidChangeState;
	}

	getState(cartella: string, ricontrolla?: boolean) { return this._main.getState(cartella, ricontrolla === true) }
	getCatalog() { return this._main.getCatalog() }
	startDownload(cartella: string, request: LocalModelDownloadRequest) { return this._main.startDownload(cartella, request) }
	cancelDownload(tieniParziale: boolean) { return this._main.cancelDownload(tieniParziale) }
	removeModel(cartella: string, removal: LocalModelRemoval) { return this._main.removeModel(cartella, removal) }
	setContext(cartella: string, change: LocalModelContextChange) { return this._main.setContext(cartella, change) }
	searchModels(testo: string) { return this._main.searchModels(testo) }
	getRepoFiles(repo: string) { return this._main.getRepoFiles(repo) }
}

registerSingleton(ILocalModelLibraryService, LocalModelLibraryService, InstantiationType.Delayed);
