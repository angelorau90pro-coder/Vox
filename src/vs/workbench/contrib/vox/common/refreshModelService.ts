/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IVoxSettingsService } from './voxSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RefreshableProviderName, refreshableProviderNames, SettingsOfProvider } from './voxSettingsTypes.js';
import { setVoxLocalContextWindows } from './modelCapabilities.js';
import { VOX_LOCAL_COMPLETION_MODELS_KEY, VOX_LOCAL_CONTEXT_WINDOWS_KEY } from './storageKeys.js';
import { parseSavedVoxLocalModelInfo, serializeVoxLocalModelInfo, VoxLocalModelInfo } from './voxLocalModelInfo.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';




type RefreshableState = ({
	state: 'init',
	manual: boolean, // true se l'ultimo aggiornamento è stato richiesto dall'utente (doNotFire falso)
} | {
	state: 'refreshing',
	manual: boolean,
} | {
	state: 'finished',
	manual: boolean,
	warning?: string, // avviso non bloccante dell'ultimo rilevamento (per esempio file di modelli mancanti)
} | {
	state: 'error',
	message: string, // la causa vera dell'errore, da mostrare all'utente
	manual: boolean,
})


/*

user click -> error -> fire(error)
		   \> success -> fire(success)
	finally: keep polling

poll -> do not fire

*/
export type RefreshModelStateOfProvider = Record<RefreshableProviderName, RefreshableState>



const refreshBasedOn: { [k in RefreshableProviderName]: (keyof SettingsOfProvider[k])[] } = {
	voxLocal: ['_didFillInProviderSettings', 'folder'],
}
const REFRESH_INTERVAL = 5_000
// const COOLDOWN_TIMEOUT = 300

const autoOptions = { enableProviderOnSuccess: true, doNotFire: true }

// element-wise equals
function eq<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
export interface IRefreshModelService {
	readonly _serviceBrand: undefined;
	startRefreshingModels: (providerName: RefreshableProviderName, options: { enableProviderOnSuccess: boolean, doNotFire: boolean }) => void;
	onDidChangeState: Event<RefreshableProviderName>;
	state: RefreshModelStateOfProvider;
}

export const IRefreshModelService = createDecorator<IRefreshModelService>('RefreshModelService');

export class RefreshModelService extends Disposable implements IRefreshModelService {
	// VOX: cartella di voxLocal appena salvata dal rilevamento stesso. Il suo salvataggio non deve far ripartire la
	// ricerca: il giro in più rileggerebbe lo stesso manifesto.
	// Lo stato cambia subito e la notifica arriva dopo la scrittura: per questo il segno si consuma alla prima notifica
	// di qualunque cambio, anche se la cartella è già un'altra (l'utente l'ha cambiata) o se la notifica del salvataggio
	// non arriva mai (scrittura fallita); un percorso scelto più avanti dall'utente fa sempre ripartire la ricerca
	private _voxLocalFolderSavedByRefresh: string | undefined = undefined
	private _isVoxLocalFolderSavedByRefresh(folder: string | undefined): boolean {
		const saved = this._voxLocalFolderSavedByRefresh
		this._voxLocalFolderSavedByRefresh = undefined
		return saved !== undefined && folder === saved
	}
	private readonly _refreshGeneration: Record<RefreshableProviderName, number> = Object.fromEntries(refreshableProviderNames.map(name => [name, 0])) as Record<RefreshableProviderName, number>;
	private readonly _timeoutIds: Record<RefreshableProviderName, ReturnType<typeof setTimeout> | null> = {
		voxLocal: null,
	}

	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<RefreshableProviderName>());
	readonly onDidChangeState: Event<RefreshableProviderName> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes


	constructor(
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super()

		this._loadVoxLocalModelInfo()

		const disposables: Set<IDisposable> = new Set()
		this._register(toDisposable(() => { disposables.forEach(d => d.dispose()); disposables.clear() }))

		const initializeAutoPollingAndOnChange = () => {
			this._clearAllTimeouts()
			disposables.forEach(d => d.dispose())
			disposables.clear()

			if (!voxSettingsService.state.globalSettings.autoRefreshModels) {
				// VOX: le IA locali si leggono dal manifesto (nessun server da interrogare), quindi le rileva
				// una volta anche con il rilevamento automatico spento; poi non ripete (autoPoll lo controlla)
				this.startRefreshingModels('voxLocal', autoOptions)
				let prevFolder = voxSettingsService.state.settingsOfProvider.voxLocal.folder
				disposables.add(voxSettingsService.onDidChangeState(() => {
					const folder = voxSettingsService.state.settingsOfProvider.voxLocal.folder
					const savedByRefresh = this._isVoxLocalFolderSavedByRefresh(folder)
					if (folder !== prevFolder) {
						prevFolder = folder
						if (!savedByRefresh) this.startRefreshingModels('voxLocal', autoOptions)
					}
				}))
				return
			}

			for (const providerName of refreshableProviderNames) {

				// const { '_didFillInProviderSettings': enabled } = this.voxSettingsService.state.settingsOfProvider[providerName]
				this.startRefreshingModels(providerName, autoOptions)

				// every time providerName.enabled changes, refresh models too, like a useEffect
				let relevantVals = () => refreshBasedOn[providerName].map(settingName => voxSettingsService.state.settingsOfProvider[providerName][settingName])
				let prevVals = relevantVals() // each iteration of a for loop has its own context and vars, so this is ok
				disposables.add(
					voxSettingsService.onDidChangeState(() => { // we might want to debounce this
						const newVals = relevantVals()
						const savedByRefresh = providerName === 'voxLocal' && this._isVoxLocalFolderSavedByRefresh(newVals[1] as string | undefined)
						if (!eq(prevVals, newVals)) {

							const prevEnabled = prevVals[0] as boolean
							const enabled = newVals[0] as boolean

							// if it was just enabled, or there was a change and it wasn't to the enabled state, refresh
							// VOX: per voxLocal il flag si ricava dalla cartella (non è un interruttore): conta il cambio di
							// cartella, così svuotarne una sbagliata fa ripartire subito la ricerca automatica
							if (providerName === 'voxLocal' ? prevVals[1] !== newVals[1] && !savedByRefresh : ((enabled && !prevEnabled) || (!enabled && !prevEnabled))) {
								// if user just clicked enable, refresh
								this.startRefreshingModels(providerName, autoOptions)
							}
							else {
								// else if user just clicked disable, don't refresh

								// //give cooldown before re-enabling (or at least re-fetching)
								// const timeoutId = setTimeout(() => this.refreshModels(providerName, !enabled), COOLDOWN_TIMEOUT)
								// this._timeoutIds[providerName] = timeoutId
							}
							prevVals = newVals
						}
					})
				)
			}
		}

		// on mount (when get init settings state), and if a relevant feature flag changes, start refreshing models
		voxSettingsService.waitForInitState.then(() => {
			// L'inizializzazione può terminare dopo la chiusura del servizio.
			if (this._store.isDisposed) return
			initializeAutoPollingAndOnChange()
			let prevAuto = voxSettingsService.state.globalSettings.autoRefreshModels
			this._register(
				voxSettingsService.onDidChangeState(() => {
					const newAuto = voxSettingsService.state.globalSettings.autoRefreshModels
					if (newAuto !== prevAuto) {
						prevAuto = newAuto
						initializeAutoPollingAndOnChange()
					}
				})
			)
		})

	}

	state: RefreshModelStateOfProvider = {
		voxLocal: { state: 'init', manual: false },
	}


	// start listening for models (and don't stop)
	startRefreshingModels: IRefreshModelService['startRefreshingModels'] = (providerName, options) => {
		if (this._store.isDisposed) return
		const generation = ++this._refreshGeneration[providerName]

		this._clearProviderTimeout(providerName)

		this._setRefreshState(providerName, 'refreshing', options)

		const autoPoll = () => {
			if (this.voxSettingsService.state.globalSettings.autoRefreshModels) {
				// resume auto-polling
				const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), REFRESH_INTERVAL)
				this._timeoutIds[providerName] = timeoutId
			}
		}
		this.llmMessageService.voxLocalList({
			providerName,
			onSuccess: ({ models, warning, folder }) => {
				if (generation !== this._refreshGeneration[providerName]) return
				// finestre di contesto e uso dei modelli: servono prima di aggiornare l'elenco, che fa ricontrollare i modelli scelti
				const modelInfo: VoxLocalModelInfo[] = models.map(model => ({ name: model.id, contextWindow: model.contextWindow, uso: model.uso }))
				setVoxLocalContextWindows(modelInfo)
				const modelInfoChanged = this._saveVoxLocalModelInfo(modelInfo)
				// cartella lasciata vuota: salva quella trovata, così l'utente la vede e resta la stessa ai prossimi avvii
				const foundFolder = folder ?? models.find(model => model.folder)?.folder
				if (foundFolder && !this.voxSettingsService.state.settingsOfProvider.voxLocal.folder?.trim()) {
					this._voxLocalFolderSavedByRefresh = foundFolder
					this.voxSettingsService.setSettingOfProvider('voxLocal', 'folder', foundFolder)
				}
				const descriptionOfModel = Object.fromEntries(models.filter(model => model.description).map(model => [model.id, model.description!]))
				// set the models to the detected models
				// `_didFillInProviderSettings` non si scrive qui: per le IA locali si ricava da cartella e modelli
				// (`isVoxLocalConfigured`), e chi non le ha resta non configurato senza scritture a ogni giro
				this.voxSettingsService.setAutodetectedModels(
					providerName,
					models.map(model => model.id),
					descriptionOfModel,
					modelInfoChanged,
				)

				this._setRefreshState(providerName, 'finished', options, warning)
				autoPoll()
			},
			onError: ({ error }) => {
				if (generation !== this._refreshGeneration[providerName]) return
				// main manda una stringa e l'Error si normalizza; il resto resta vuoto per non mostrare 'undefined' o '[object Object]'
				const err: unknown = error
				const message = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
				this._setRefreshState(providerName, 'error', options, message)
				autoPoll()
			}
		})


	}

	override dispose() {
		for (const providerName of refreshableProviderNames) this._refreshGeneration[providerName]++
		this._clearAllTimeouts()
		super.dispose()
	}

	// Finestre di contesto e uso dei modelli salvati, per averli già all'avvio (prima del primo rilevamento).
	// Li carica anche il servizio delle impostazioni, prima di ricontrollare i modelli scelti.
	private _loadVoxLocalModelInfo() {
		setVoxLocalContextWindows(parseSavedVoxLocalModelInfo(
			this.storageService.get(VOX_LOCAL_CONTEXT_WINDOWS_KEY, StorageScope.APPLICATION),
			this.storageService.get(VOX_LOCAL_COMPLETION_MODELS_KEY, StorageScope.APPLICATION),
		))
	}

	// Restituisce vero se qualcosa è cambiato rispetto a ciò che era salvato (per esempio l'uso di un modello).
	private _saveVoxLocalModelInfo(models: VoxLocalModelInfo[]): boolean {
		const { contextWindows, completionModels } = serializeVoxLocalModelInfo(models)
		let changed = false
		// il rilevamento gira ogni 5 secondi: si scrive solo quando cambia
		for (const [key, serialized] of [[VOX_LOCAL_CONTEXT_WINDOWS_KEY, contextWindows], [VOX_LOCAL_COMPLETION_MODELS_KEY, completionModels]]) {
			if (this.storageService.get(key, StorageScope.APPLICATION) === serialized) continue
			this.storageService.store(key, serialized, StorageScope.APPLICATION, StorageTarget.MACHINE)
			changed = true
		}
		return changed
	}

	_clearAllTimeouts() {
		for (const providerName of refreshableProviderNames) {
			this._clearProviderTimeout(providerName)
		}
	}

	_clearProviderTimeout(providerName: RefreshableProviderName) {
		// cancel any existing poll
		const timeoutId = this._timeoutIds[providerName]
		if (timeoutId !== null) {
			clearTimeout(timeoutId)
			this._timeoutIds[providerName] = null
		}
	}

	private _setRefreshState(providerName: RefreshableProviderName, state: RefreshableState['state'], options?: { doNotFire: boolean }, message?: string) {
		const prev = this.state[providerName]
		// il rilevamento automatico non mostra 'refreshing': lo stato resta sul risultato precedente
		if (options?.doNotFire && state === 'refreshing' && prev.state !== 'refreshing') return
		// un automatico che supera un manuale in corso eredita il suo flag, così il pulsante mostra la fine
		const manual = prev.state === 'refreshing' ? prev.manual || !options?.doNotFire : !options?.doNotFire
		const next: RefreshableState = state === 'error'
			? { state: 'error', message: message ?? '', manual }
			: state === 'refreshing'
				? { state: 'refreshing', manual }
				: state === 'init'
					? { state: 'init', manual }
					: { state: 'finished', manual, warning: message }
		// i giri automatici ripetono lo stesso esito: se stato, causa e origine non sono cambiati non si notifica
		const detailOf = (s: RefreshableState) => s.state === 'error' ? s.message : s.state === 'finished' ? s.warning : undefined
		if (prev.state === next.state && prev.manual === next.manual && detailOf(prev) === detailOf(next)) return
		// oggetti nuovi (anche il record): React deve vedere un riferimento diverso per ridisegnare
		this.state = { ...this.state, [providerName]: next }
		this._onDidChangeState.fire(providerName)
	}
}

registerSingleton(IRefreshModelService, RefreshModelService, InstantiationType.Eager);

