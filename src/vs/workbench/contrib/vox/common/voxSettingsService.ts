/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from './voxI18n.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { getModelCapabilities, isVoxLocalCompletionModel, ModelOverrides, setVoxLocalContextWindows } from './modelCapabilities.js';
import { cleanRemovedProviders, RemovedModelSelection, RemovedProvidersCleanup } from './removedProviders.js';
import { parseRemovedProvidersNotice, removedProvidersNoticeOf, RemovedProvidersNotice, withCurrentReplacements } from './removedProvidersNotice.js';
import { VOX_LOCAL_COMPLETION_MODELS_KEY, VOX_LOCAL_CONTEXT_WINDOWS_KEY, VOX_REMOVED_PROVIDERS_NOTICE_KEY, VOX_SETTINGS_STORAGE_KEY } from './storageKeys.js';
import { parseSavedVoxLocalModelInfo } from './voxLocalModelInfo.js';
import { splitCliAgentModel, defaultSettingsOfProvider, FeatureName, ProviderName, ModelSelectionOfFeature, SettingsOfProvider, SettingName, providerNames, ModelSelection, modelSelectionsEqual, featureNames, VoxStatefulModelInfo, GlobalSettings, GlobalSettingName, defaultGlobalSettings, ModelSelectionOptions, OptionsOfModelSelection, ChatMode, OverridesOfModel, defaultOverridesOfModel, MCPUserStateOfName as MCPUserStateOfName, MCPUserState } from './voxSettingsTypes.js';


// name is the name in the dropdown
export type ModelOption = { name: string, selection: ModelSelection, description?: string }



type SetSettingOfProviderFn = <S extends SettingName>(
	providerName: ProviderName,
	settingName: S,
	newVal: SettingsOfProvider[ProviderName][S extends keyof SettingsOfProvider[ProviderName] ? S : never],
) => Promise<void>;

type SetModelSelectionOfFeatureFn = <K extends FeatureName>(
	featureName: K,
	newVal: ModelSelectionOfFeature[K],
) => Promise<void>;

type SetGlobalSettingFn = <T extends GlobalSettingName>(settingName: T, newVal: GlobalSettings[T]) => void;

type SetOptionsOfModelSelection = (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => void


export type VoxSettingsState = {
	readonly settingsOfProvider: SettingsOfProvider; // optionsOfProvider
	readonly modelSelectionOfFeature: ModelSelectionOfFeature; // stateOfFeature
	readonly optionsOfModelSelection: OptionsOfModelSelection;
	readonly overridesOfModel: OverridesOfModel;
	readonly globalSettings: GlobalSettings;
	readonly mcpUserStateOfName: MCPUserStateOfName; // user-controlled state of MCP servers
	readonly lastModelOfCliAgent: Record<string, string>;

	readonly _modelOptions: ModelOption[] // computed based on the two above items
}

// type RealVoxSettings = Exclude<keyof VoxSettingsState, '_modelOptions'>
// type EventProp<T extends RealVoxSettings = RealVoxSettings> = T extends 'globalSettings' ? [T, keyof VoxSettingsState[T]] : T | 'all'


export interface IVoxSettingsService {
	readonly _serviceBrand: undefined;
	readonly state: VoxSettingsState; // in order to play nicely with react, you should immutably change state
	readonly waitForInitState: Promise<void>;
	// Esito della pulizia dei fornitori tolti fatta alla lettura delle impostazioni (valido dopo `waitForInitState`);
	// null se non c'era niente da pulire. Chi lo mostra all'utente lo consuma con `takeRemovedProvidersNotice`:
	// una funzione rimasta senza modello all'avvio compare con quello che ha nel momento in cui l'avviso viene preso.
	takeRemovedProvidersNotice(): RemovedProvidersNotice | null;
	// Scatta quando un avviso viene salvato a finestra aperta: l'importazione di un file di impostazioni di una
	// versione precedente pulisce e sostituisce come l'avvio, e va detto subito.
	onDidStoreRemovedProvidersNotice: Event<void>;

	onDidChangeState: Event<void>;

	setSettingOfProvider: SetSettingOfProviderFn;
	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn;
	setOptionsOfModelSelection: SetOptionsOfModelSelection;
	setGlobalSetting: SetGlobalSettingFn;
	// setMCPServerStates: (newStates: MCPServerStates) => Promise<void>;

	// setting to undefined CLEARS it, unlike others:
	setOverridesOfModel(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined): Promise<void>;

	dangerousSetState(newState: VoxSettingsState): Promise<void>;
	resetState(): Promise<void>;

	// `modelInfoChanged`: è cambiato qualcosa che non sta nell'elenco (l'uso di un modello), e i modelli scelti vanno ricontrollati
	setAutodetectedModels(providerName: ProviderName, modelNames: string[], descriptionOfModel?: Record<string, string>, modelInfoChanged?: boolean): void;
	toggleModelHidden(providerName: ProviderName, modelName: string): void;
	addModel(providerName: ProviderName, modelName: string): void;
	deleteModel(providerName: ProviderName, modelName: string): boolean;

	addMCPUserStateOfNames(userStateOfName: MCPUserStateOfName): Promise<void>;
	removeMCPUserStateOfNames(serverNames: string[]): Promise<void>;
	setMCPServerState(serverName: string, state: MCPUserState): Promise<void>;
}




const _modelsWithSwappedInNewModels = (options: { existingModels: VoxStatefulModelInfo[], models: string[], type: 'autodetected' | 'default', descriptionOfModel?: Record<string, string> }) => {
	const { existingModels, models, type, descriptionOfModel } = options

	const existingModelsMap: Record<string, VoxStatefulModelInfo> = {}
	for (const existingModel of existingModels) {
		existingModelsMap[existingModel.modelName] = existingModel
	}

	const newDefaultModels: VoxStatefulModelInfo[] = models.map((modelName) => {
		const info: VoxStatefulModelInfo = { modelName, type, isHidden: !!existingModelsMap[modelName]?.isHidden }
		const description = type === 'autodetected' && descriptionOfModel && Object.hasOwn(descriptionOfModel, modelName) ? descriptionOfModel[modelName] : undefined
		if (description) info.description = description
		return info
	})

	return [
		...newDefaultModels, // swap out all the models of this type for the new models of this type
		...existingModels.filter(m => {
			const keep = m.type !== type && !models.includes(m.modelName)
			return keep
		})
	]
}


// I modelli locali con `"uso": "completamento"` servono solo al completamento automatico: non rispondono in chat.
const isCompletionOnlyModel = (o: ModelSelection) => o.providerName === 'voxLocal' && isVoxLocalCompletionModel(o.modelName)

export const modelFilterOfFeatureName: {
	[featureName in FeatureName]: {
		filter: (
			o: ModelSelection,
			opts: { chatMode: ChatMode, overridesOfModel: OverridesOfModel }
		) => boolean;
		emptyMessage: null | { message: string, priority: 'always' | 'fallback' }
	} } = {
	'Autocomplete': { filter: (o, opts) => getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel).supportsFIM, emptyMessage: { message: t("No models support FIM"), priority: 'always' } },
	'Chat': { filter: o => !isCompletionOnlyModel(o), emptyMessage: null, },
	'Ctrl+K': { filter: o => !isCompletionOnlyModel(o), emptyMessage: null, },
	'Apply': { filter: o => !isCompletionOnlyModel(o), emptyMessage: null, },
	'SCM': { filter: o => !isCompletionOnlyModel(o), emptyMessage: null, },
}


const _stateWithMergedDefaultModels = (state: VoxSettingsState): VoxSettingsState => {
	let newSettingsOfProvider = state.settingsOfProvider

	// recompute default models
	for (const providerName of providerNames) {
		const defaultModels = defaultSettingsOfProvider[providerName]?.models ?? []
		const currentModels = newSettingsOfProvider[providerName]?.models ?? []
		const defaultModelNames = defaultModels.map(m => m.modelName)
		const newModels = _modelsWithSwappedInNewModels({ existingModels: currentModels, models: defaultModelNames, type: 'default' })
		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...newSettingsOfProvider[providerName],
				models: newModels,
			},
		}
	}
	return {
		...state,
		settingsOfProvider: newSettingsOfProvider,
	}
}

// IA locali di Vox configurate: una cartella scelta (o salvata dal primo rilevamento riuscito) o almeno un modello
// rilevato. Senza nessuno dei due la ricerca automatica non ha trovato `ia-locali`: non è un errore, sono assenti.
export const isVoxLocalConfigured = (settings: Pick<SettingsOfProvider['voxLocal'], 'folder' | 'models'>): boolean =>
	!!settings.folder?.trim() || settings.models.length > 0

const _validatedModelState = (state: Omit<VoxSettingsState, '_modelOptions'>): VoxSettingsState => {

	let newSettingsOfProvider = state.settingsOfProvider

	// recompute _didFillInProviderSettings
	for (const providerName of providerNames) {
		const settingsAtProvider = newSettingsOfProvider[providerName]

		// cliAgent funziona senza campi obbligatori (i comandi si trovano da soli). voxLocal è configurato quando c'è una
		// cartella (scelta dall'utente o salvata dal primo rilevamento riuscito) o un modello rilevato: chi non ha le IA
		// locali non lo vede come un fornitore in errore. Il rilevamento all'avvio parte comunque (refreshModelService).
		const didFillInProviderSettings = providerName === 'cliAgent' || isVoxLocalConfigured(newSettingsOfProvider.voxLocal)

		if (didFillInProviderSettings === settingsAtProvider._didFillInProviderSettings) continue

		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...settingsAtProvider,
				_didFillInProviderSettings: didFillInProviderSettings,
			},
		}
	}

	// update model options
	let newModelOptions: ModelOption[] = []
	for (const providerName of providerNames) {
		const providerTitle = providerName // displayInfoOfProviderName(providerName).title.toLowerCase() // looks better lowercase, best practice to not use raw providerName
		if (!newSettingsOfProvider[providerName]._didFillInProviderSettings) continue // if disabled, don't display model options
		for (const { modelName, isHidden, description } of newSettingsOfProvider[providerName].models) {
			if (isHidden) continue
			const option: ModelOption = { name: `${modelName} (${providerTitle})`, selection: { providerName, modelName } }
			if (description) option.description = description
			newModelOptions.push(option)
		}
	}

	// now that model options are updated, make sure the selection is valid
	// if the user-selected model is no longer in the list, update the selection for each feature that needs it to something relevant (the 0th model available, or null)
	let newModelSelectionOfFeature = state.modelSelectionOfFeature
	for (const featureName of featureNames) {

		const { filter } = modelFilterOfFeatureName[featureName]
		const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel }
		const modelOptionsForThisFeature = newModelOptions.filter((o) => filter(o.selection, filterOpts))

		const modelSelectionAtFeature = newModelSelectionOfFeature[featureName]
		const selnIdx = modelSelectionAtFeature === null ? -1 : modelOptionsForThisFeature.findIndex(m => {
			if (modelSelectionsEqual(m.selection, modelSelectionAtFeature)) return true
			if (modelSelectionAtFeature.providerName === 'cliAgent' && m.selection.providerName === 'cliAgent') {
				const configured = newSettingsOfProvider.cliAgent.models.find(m => m.modelName === modelSelectionAtFeature.modelName)
				return !configured && m.selection.modelName === splitCliAgentModel(modelSelectionAtFeature.modelName).agent
			}
			return false
		})

		if (selnIdx !== -1) continue // no longer in list, so update to 1st in list or null

		// Ripiego: solo su un modello delle IA locali. Su una IA in CLI non si ripiega mai da soli: chi ha scelto un
		// modello locale non deve trovarsi le richieste inviate a un servizio esterno perché la cartella non risponde.
		// L'unica eccezione è il passaggio dai fornitori tolti (`withCliFallbackForRemovedSelections`), che lo dice all'utente.
		newModelSelectionOfFeature = {
			...newModelSelectionOfFeature,
			[featureName]: modelOptionsForThisFeature.find(o => o.selection.providerName !== 'cliAgent')?.selection ?? null
		}
	}


	const newState = {
		...state,
		settingsOfProvider: newSettingsOfProvider,
		modelSelectionOfFeature: newModelSelectionOfFeature,
		overridesOfModel: state.overridesOfModel,
		_modelOptions: newModelOptions,
	} satisfies VoxSettingsState

	return newState
}

// Passaggio dai fornitori tolti: una funzione il cui modello era di un fornitore tolto e che non ha trovato un
// modello delle IA locali passa alla prima IA in CLI visibile adatta a quella funzione (il completamento automatico
// no: le CLI non lo fanno). Vale solo per quelle funzioni e solo in quel momento; l'avviso lo dice all'utente.
export const withCliFallbackForRemovedSelections = (state: VoxSettingsState, removedSelections: RemovedModelSelection[]): VoxSettingsState => {
	let modelSelectionOfFeature = state.modelSelectionOfFeature
	const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel }
	for (const { featureName } of removedSelections) {
		const feature = featureNames.find(name => name === featureName)
		if (!feature || modelSelectionOfFeature[feature] !== null) continue // già sostituito con un modello locale
		const option = state._modelOptions.find(o => o.selection.providerName === 'cliAgent' && modelFilterOfFeatureName[feature].filter(o.selection, filterOpts))
		if (option) modelSelectionOfFeature = { ...modelSelectionOfFeature, [feature]: option.selection }
	}
	return modelSelectionOfFeature === state.modelSelectionOfFeature ? state : _validatedModelState({ ...state, modelSelectionOfFeature })
}



const defaultState = () => {
	const d: VoxSettingsState = {
		settingsOfProvider: deepClone(defaultSettingsOfProvider),
		modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null },
		globalSettings: deepClone(defaultGlobalSettings),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {} },
		overridesOfModel: deepClone(defaultOverridesOfModel),
		_modelOptions: [], // computed later
		mcpUserStateOfName: {},
		lastModelOfCliAgent: {},
	}
	return d
}


export const IVoxSettingsService = createDecorator<IVoxSettingsService>('VoxSettingsService');
class VoxSettingsService extends Disposable implements IVoxSettingsService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<void>();
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	private readonly _onDidStoreRemovedProvidersNotice = new Emitter<void>();
	readonly onDidStoreRemovedProvidersNotice: Event<void> = this._onDidStoreRemovedProvidersNotice.event;

	state: VoxSettingsState;

	// Funzioni passate a una IA in CLI perché, nel passaggio dai fornitori tolti, non c'era ancora un modello locale
	// noto: si ricontrollano al primo rilevamento dei modelli locali (`_preferLocalToCliFallback`).
	private _cliFallbackToRecheck: { feature: FeatureName, selection: ModelSelection }[] | null = null

	private readonly _resolver: () => void
	waitForInitState: Promise<void> // await this if you need a valid state initially

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		// could have used this, but it's clearer the way it is (+ slightly different eg StorageTarget.USER)
		// @ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
	) {
		super()

		// at the start, we haven't read the partial config yet, but we need to set state to something
		this.state = defaultState()
		let resolver: () => void = () => { }
		this.waitForInitState = new Promise((res, rej) => resolver = res)
		this._resolver = resolver

		this.readAndInitializeState()
	}




	dangerousSetState = async (newState: VoxSettingsState) => {
		// un file di impostazioni esportato da una versione precedente può contenere i fornitori tolti e le loro chiavi,
		// e può non avere le voci aggiunte dopo: si completa con i valori predefiniti prima di ricontrollarlo
		const imported = deepClone(newState), defaults = defaultState()
		newState = {
			...defaults, ...imported,
			settingsOfProvider: { ...defaults.settingsOfProvider, ...imported.settingsOfProvider },
			modelSelectionOfFeature: { ...defaults.modelSelectionOfFeature, ...imported.modelSelectionOfFeature },
			optionsOfModelSelection: { ...defaults.optionsOfModelSelection, ...imported.optionsOfModelSelection },
			overridesOfModel: { ...defaults.overridesOfModel, ...imported.overridesOfModel },
			globalSettings: { ...defaults.globalSettings, ...imported.globalSettings },
		}
		for (const providerName of providerNames) {
			newState.settingsOfProvider[providerName] = { ...defaults.settingsOfProvider[providerName], ...newState.settingsOfProvider[providerName] } as any
		}
		const cleanup = cleanRemovedProviders(newState)
		this._cliFallbackToRecheck = null
		this.state = withCliFallbackForRemovedSelections(_validatedModelState(newState), cleanup.removedSelections)
		await this._storeState()
		this._onDidChangeState.fire()
		// Applica e messaggi di commit seguono la chat solo se l'utente lo ha scelto (come in `setGlobalSetting`)
		if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
		if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()
		// come all'avvio: via le chiavi anche dalla copia precedente, e avviso all'utente (subito, la finestra è aperta)
		if (cleanup.changed) {
			await this._saveRemovedProvidersCleanup(cleanup)
			this._onDidStoreRemovedProvidersNotice.fire()
		}
	}
	async resetState() {
		await this.dangerousSetState(defaultState())
	}




	takeRemovedProvidersNotice(): RemovedProvidersNotice | null {
		const notice = parseRemovedProvidersNotice(this._storageService.get(VOX_REMOVED_PROVIDERS_NOTICE_KEY, StorageScope.APPLICATION))
		this._storageService.remove(VOX_REMOVED_PROVIDERS_NOTICE_KEY, StorageScope.APPLICATION)
		// da qui in poi i modelli scelti non cambiano più da soli: l'utente ha letto com'è andata
		this._cliFallbackToRecheck = null
		return notice && withCurrentReplacements(notice, featureName => this.state.modelSelectionOfFeature[featureName as FeatureName] ?? null)
	}

	// I modelli di completamento delle IA locali vanno conosciuti prima della prima convalida, altrimenti il modello
	// scelto per il completamento automatico sembrerebbe non adatto e la scelta salvata andrebbe persa a ogni avvio.
	private _loadVoxLocalModelInfo() {
		try {
			setVoxLocalContextWindows(parseSavedVoxLocalModelInfo(
				this._storageService.get(VOX_LOCAL_CONTEXT_WINDOWS_KEY, StorageScope.APPLICATION),
				this._storageService.get(VOX_LOCAL_COMPLETION_MODELS_KEY, StorageScope.APPLICATION),
			))
		} catch (e) { console.error('Vox: local model info could not be loaded', e) }
	}

	// Riscrive una copia salvata delle impostazioni togliendo solo i segreti dei fornitori tolti; il resto non cambia.
	// Serve per le impostazioni attuali quando non si riescono a caricare (si riparte da quelle predefinite, ma le
	// chiavi API non devono restare sul disco).
	private async _cleanStoredCopy(key: string | undefined): Promise<{ cleaned: boolean, providersWithRemovedSecrets: string[] }> {
		try {
			const encrypted = key ? this._storageService.get(key, StorageScope.APPLICATION) : undefined
			if (!key || !encrypted) return { cleaned: true, providersWithRemovedSecrets: [] }
			const storedState = JSON.parse(await this._encryptionService.decrypt(encrypted))
			const cleanup = cleanRemovedProviders(storedState, { secretsOnly: true })
			if (cleanup.changed) {
				this._storageService.store(key, await this._encryptionService.encrypt(JSON.stringify(storedState)), StorageScope.APPLICATION, StorageTarget.USER)
			}
			return { cleaned: true, providersWithRemovedSecrets: cleanup.providersWithRemovedSecrets }
		} catch (e) {
			console.error('Vox: a saved copy of the settings could not be cleaned', e)
			return { cleaned: false, providersWithRemovedSecrets: [] }
		}
	}

	// Passaggio dai fornitori tolti: i modelli locali si rilevano a finestra aperta. Se all'avvio non ce n'erano di
	// salvati e una funzione è passata a una IA in CLI, al primo rilevamento prende il modello locale adatto, come
	// avrebbe fatto se fosse stato già noto (prima un modello locale, altrimenti una CLI). Vale finché l'avviso non
	// viene mostrato (`takeRemovedProvidersNotice`): un rilevamento che non trova ancora niente lascia la funzione in
	// attesa del successivo. Una funzione per cui l'utente ha scelto un modello a mano non si tocca più
	// (`setModelSelectionOfFeature` la toglie dall'elenco).
	private _preferLocalToCliFallback() {
		const pending = this._cliFallbackToRecheck
		if (!pending || pending.length === 0) return
		let modelSelectionOfFeature = this.state.modelSelectionOfFeature
		const filterOpts = { chatMode: this.state.globalSettings.chatMode, overridesOfModel: this.state.overridesOfModel }
		const stillPending: typeof pending = []
		for (const item of pending) {
			const { feature, selection } = item
			const now = modelSelectionOfFeature[feature]
			if (!now || !modelSelectionsEqual(now, selection)) continue
			const local = this.state._modelOptions.find(o => o.selection.providerName === 'voxLocal' && modelFilterOfFeatureName[feature].filter(o.selection, filterOpts))
			if (local) modelSelectionOfFeature = { ...modelSelectionOfFeature, [feature]: local.selection }
			else stillPending.push(item)
		}
		this._cliFallbackToRecheck = stillPending
		if (modelSelectionOfFeature === this.state.modelSelectionOfFeature) return
		this.state = _validatedModelState({ ...this.state, modelSelectionOfFeature })
		this._storeState().catch(e => console.error('Vox: the settings could not be saved', e))
		this._onDidChangeState.fire()
	}

	// Dopo la pulizia dei fornitori tolti: le chiavi devono sparire subito dal disco (non al primo cambio di
	// impostazioni), e l'utente va avvisato. L'avviso si salva solo dopo la scrittura: se fallisce, la pulizia si
	// ripete al prossimo avvio e non si annuncia una cosa non fatta.
	private async _saveRemovedProvidersCleanup(cleanup: RemovedProvidersCleanup) {
		try {
			if (cleanup.changed) await this._storeState()
			const notice = removedProvidersNoticeOf({
				cleanup,
				selectionNow: featureName => this.state.modelSelectionOfFeature[featureName as FeatureName] ?? null,
				pending: parseRemovedProvidersNotice(this._storageService.get(VOX_REMOVED_PROVIDERS_NOTICE_KEY, StorageScope.APPLICATION)),
			})
			if (notice && cleanup.changed) {
				this._storageService.store(VOX_REMOVED_PROVIDERS_NOTICE_KEY, JSON.stringify(notice), StorageScope.APPLICATION, StorageTarget.MACHINE)
			}
		} catch (e) {
			console.error('Vox: the cleaned settings could not be saved', e)
		}
	}

	async readAndInitializeState() {
		this._loadVoxLocalModelInfo()

		let readS: VoxSettingsState
		let cleanup: RemovedProvidersCleanup = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] }
		let unusable = false
		try {
			readS = await this._readState();
			// 1.0.3 addition, remove when enough users have had this code run
			if (readS.globalSettings.includeToolLintErrors === undefined) readS.globalSettings.includeToolLintErrors = true

			// autoapprove is now an obj not a boolean (1.2.5)
			if (typeof readS.globalSettings.autoApprove === 'boolean') readS.globalSettings.autoApprove = {}

			// 1.3.5 add source control feature
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['SCM']) {
				readS.modelSelectionOfFeature['SCM'] = deepClone(readS.modelSelectionOfFeature['Chat'])
				readS.optionsOfModelSelection['SCM'] = deepClone(readS.optionsOfModelSelection['Chat'])
			}
			// fornitori tolti (in cloud e server locali di terzi): via le chiavi API salvate e i modelli scelti da loro.
			// Dopo la copia qui sopra: così una funzione senza modello che lo eredita dalla chat viene ripulita e sostituita
			// come la chat, e una che ne aveva uno suo non prende quello della chat al posto di un modello locale.
			cleanup = cleanRemovedProviders(readS)
			// add disableSystemMessage feature
			if (readS.globalSettings.disableSystemMessage === undefined) readS.globalSettings.disableSystemMessage = false;
			
			// add autoAcceptLLMChanges feature
			if (readS.globalSettings.autoAcceptLLMChanges === undefined) readS.globalSettings.autoAcceptLLMChanges = false;
		}
		catch (e) {
			// impostazioni illeggibili: si riparte da quelle predefinite, come prima, e non c'è niente da annunciare.
			// Le chiavi API però non restano sul disco: si tolgono più sotto dalla copia salvata, se si riesce a leggerla.
			readS = defaultState()
			cleanup = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] }
			unusable = true
		}

		// the stored data structure might be outdated, so we need to update it here
		try {
			const defaults = defaultState()
			readS = {
				...defaults,
				...readS,
				// no idea why this was here, seems like a bug
				// ...defaultSettingsOfProvider,
				// ...readS.settingsOfProvider,
				// VOX: come in `dangerousSetState`, le voci aggiunte dopo il salvataggio prendono il valore predefinito
				// (un'impostazione globale mancante sarebbe `undefined`, cioè spenta, anche se il default è acceso)
				settingsOfProvider: { ...defaults.settingsOfProvider, ...readS.settingsOfProvider },
				modelSelectionOfFeature: { ...defaults.modelSelectionOfFeature, ...readS.modelSelectionOfFeature },
				optionsOfModelSelection: { ...defaults.optionsOfModelSelection, ...readS.optionsOfModelSelection },
				globalSettings: { ...defaults.globalSettings, ...readS.globalSettings },
				lastModelOfCliAgent: { ...readS.lastModelOfCliAgent },
				mcpUserStateOfName: { ...readS.mcpUserStateOfName },
			}

			for (const providerName of providerNames) {
				readS.settingsOfProvider[providerName] = {
					...defaultSettingsOfProvider[providerName],
					...readS.settingsOfProvider[providerName],
				} as any

				// conversion from 1.0.3 to 1.2.5 (can remove this when enough people update)
				for (const m of readS.settingsOfProvider[providerName].models) {
					if (!m.type) {
						const old = (m as { isAutodetected?: boolean; isDefault?: boolean })
						if (old.isAutodetected)
							m.type = 'autodetected'
						else if (old.isDefault)
							m.type = 'default'
						else m.type = 'custom'
					}
				}

				// fornitori aggiunti dopo il salvataggio (per esempio voxLocal): senza la loro voce gli override non si salvano
				if (!readS.overridesOfModel?.[providerName]) {
					readS = { ...readS, overridesOfModel: { ...readS.overridesOfModel, [providerName]: {} } }
				}
			}

			for (const fn of featureNames) {
				const sel = readS.modelSelectionOfFeature?.[fn];
				if (sel && sel.providerName === 'cliAgent') {
					const { agent, subModel } = splitCliAgentModel(sel.modelName);
					if (!Object.hasOwn(readS.lastModelOfCliAgent, agent)) {
						readS = { ...readS, lastModelOfCliAgent: { ...readS.lastModelOfCliAgent, [agent]: subModel } };
					}
				}
			}
		}

		catch (e) {
			readS = defaultState()
			cleanup = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] }
			unusable = true
		}

		this.state = readS
		this.state = _stateWithMergedDefaultModels(this.state)
		this.state = _validatedModelState(this.state);
		this.state = withCliFallbackForRemovedSelections(this.state, cleanup.removedSelections)
		this._cliFallbackToRecheck = cleanup.removedSelections.flatMap(({ featureName }) => {
			const feature = featureNames.find(name => name === featureName)
			const selection = feature && this.state.modelSelectionOfFeature[feature]
			return feature && selection && selection.providerName === 'cliAgent' ? [{ feature, selection }] : []
		})

		if (unusable) await this._cleanStoredCopy(VOX_SETTINGS_STORAGE_KEY)
		await this._saveRemovedProvidersCleanup(cleanup)

		this._resolver();
		this._onDidChangeState.fire();

	}


	private async _readState(): Promise<VoxSettingsState> {
		const encryptedState = this._storageService.get(VOX_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)

		if (!encryptedState)
			return defaultState()

		const stateStr = await this._encryptionService.decrypt(encryptedState)
		const state = JSON.parse(stateStr)
		return state
	}


	private async _storeState() {
		const state = this.state
		const encryptedState = await this._encryptionService.encrypt(JSON.stringify(state))
		this._storageService.store(VOX_SETTINGS_STORAGE_KEY, encryptedState, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setSettingOfProvider: SetSettingOfProviderFn = async (providerName, settingName, newVal) => {

		const newModelSelectionOfFeature = this.state.modelSelectionOfFeature

		const newOptionsOfModelSelection = this.state.optionsOfModelSelection

		const newSettingsOfProvider: SettingsOfProvider = {
			...this.state.settingsOfProvider,
			[providerName]: {
				...this.state.settingsOfProvider[providerName],
				[settingName]: newVal,
			}
		}

		const newGlobalSettings = this.state.globalSettings
		const newOverridesOfModel = this.state.overridesOfModel
		const newMCPUserStateOfName = this.state.mcpUserStateOfName
		const newLastModelOfCliAgent = this.state.lastModelOfCliAgent

		const newState = {
			modelSelectionOfFeature: newModelSelectionOfFeature,
			optionsOfModelSelection: newOptionsOfModelSelection,
			settingsOfProvider: newSettingsOfProvider,
			globalSettings: newGlobalSettings,
			overridesOfModel: newOverridesOfModel,
			mcpUserStateOfName: newMCPUserStateOfName,
			lastModelOfCliAgent: newLastModelOfCliAgent,
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

	}


	private _onUpdate_syncApplyToChat() {
		// if sync is turned on, sync (call this whenever Chat model or !!sync changes)
		this.setModelSelectionOfFeature('Apply', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	private _onUpdate_syncSCMToChat() {
		this.setModelSelectionOfFeature('SCM', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	setGlobalSetting: SetGlobalSettingFn = async (settingName, newVal) => {
		const newState: VoxSettingsState = {
			...this.state,
			globalSettings: {
				...this.state.globalSettings,
				[settingName]: newVal
			}
		}
		this.state = _validatedModelState(newState)
		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
		if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()

	}


	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn = async (featureName, newVal) => {
		// una scelta fatta dopo l'avvio vale più del ripiego automatico: questa funzione non si ricontrolla più
		if (this._cliFallbackToRecheck) this._cliFallbackToRecheck = this._cliFallbackToRecheck.filter(item => item.feature !== featureName)
		let lastModelOfCliAgent = this.state.lastModelOfCliAgent
		if (newVal && newVal.providerName === 'cliAgent') {
			const { agent, subModel } = splitCliAgentModel(newVal.modelName)
			lastModelOfCliAgent = {
				...lastModelOfCliAgent,
				[agent]: subModel,
			}
		}

		const newState: VoxSettingsState = {
			...this.state,
			lastModelOfCliAgent,
			modelSelectionOfFeature: {
				...this.state.modelSelectionOfFeature,
				[featureName]: newVal
			}
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (featureName === 'Chat') {
			// When Chat model changes, update synced features
			this._onUpdate_syncApplyToChat()
			this._onUpdate_syncSCMToChat()
		}
	}


	setOptionsOfModelSelection = async (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => {
		const newState: VoxSettingsState = {
			...this.state,
			optionsOfModelSelection: {
				...this.state.optionsOfModelSelection,
				[featureName]: {
					...this.state.optionsOfModelSelection[featureName],
					[providerName]: {
						...this.state.optionsOfModelSelection[featureName][providerName],
						[modelName]: {
							...this.state.optionsOfModelSelection[featureName][providerName]?.[modelName],
							...newVal
						}
					}
				}
			}
		}
		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()
	}

	setOverridesOfModel = async (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined) => {
		const newState: VoxSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: {
					...this.state.overridesOfModel[providerName],
					[modelName]: overrides === undefined ? undefined : {
						...this.state.overridesOfModel[providerName][modelName],
						...overrides
					},
				}
			}
		};

		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

	}




	setAutodetectedModels(providerName: ProviderName, autodetectedModelNames: string[], descriptionOfModel?: Record<string, string>, modelInfoChanged?: boolean) {

		const { models } = this.state.settingsOfProvider[providerName]

		const newModels = _modelsWithSwappedInNewModels({ existingModels: models, models: autodetectedModelNames, type: 'autodetected', descriptionOfModel })
		// il rilevamento gira ogni 5 secondi: se non cambia nulla non si riscrivono le impostazioni
		const unchanged = newModels.length === models.length && newModels.every((m, i) => m.modelName === models[i].modelName && m.type === models[i].type && m.isHidden === models[i].isHidden && m.description === models[i].description)
		// l'uso di un modello (chat o completamento) non sta nell'elenco: se cambia solo quello, i modelli scelti si
		// ricontrollano lo stesso, altrimenti la chat terrebbe un modello diventato di completamento
		if (unchanged && !modelInfoChanged) { if (providerName === 'voxLocal') this._preferLocalToCliFallback(); return }
		this.setSettingOfProvider(providerName, 'models', newModels)
		if (providerName === 'voxLocal') this._preferLocalToCliFallback()
	}
	toggleModelHidden(providerName: ProviderName, modelName: string) {


		const { models } = this.state.settingsOfProvider[providerName]
		const modelIdx = models.findIndex(m => m.modelName === modelName)
		if (modelIdx === -1) return
		const newIsHidden = !models[modelIdx].isHidden
		const newModels: VoxStatefulModelInfo[] = [
			...models.slice(0, modelIdx),
			{ ...models[modelIdx], isHidden: newIsHidden },
			...models.slice(modelIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)


	}
	addModel(providerName: ProviderName, modelName: string) {
		const { models } = this.state.settingsOfProvider[providerName]
		const existingIdx = models.findIndex(m => m.modelName === modelName)
		if (existingIdx !== -1) return // if exists, do nothing
		const newModels = [
			...models,
			{ modelName, type: 'custom', isHidden: false } as const
		]
		this.setSettingOfProvider(providerName, 'models', newModels)


	}
	deleteModel(providerName: ProviderName, modelName: string): boolean {
		const { models } = this.state.settingsOfProvider[providerName]
		const delIdx = models.findIndex(m => m.modelName === modelName)
		if (delIdx === -1) return false
		const newModels = [
			...models.slice(0, delIdx), // delete the idx
			...models.slice(delIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)


		return true
	}

	// MCP Server State
	// VOX: `newStates` è già lo stato completo (chi chiama unisce): unirlo di nuovo a quello attuale rimetteva i server
	// appena tolti da `removeMCPUserStateOfNames`, che restavano salvati per sempre
	private _setMCPUserStateOfName = async (newStates: MCPUserStateOfName) => {
		const newState: VoxSettingsState = {
			...this.state,
			mcpUserStateOfName: newStates,
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
	}

	addMCPUserStateOfNames = async (newMCPStates: MCPUserStateOfName) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
			...newMCPStates,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
	}

	removeMCPUserStateOfNames = async (serverNames: string[]) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
		}
		serverNames.forEach(serverName => {
			if (serverName in newMCPServerStates) {
				delete newMCPServerStates[serverName]
			}
		})
		await this._setMCPUserStateOfName(newMCPServerStates)
	}

	setMCPServerState = async (serverName: string, state: MCPUserState) => {
		const { mcpUserStateOfName } = this.state
		const newMCPServerStates = {
			...mcpUserStateOfName,
			[serverName]: state,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
	}

}


registerSingleton(IVoxSettingsService, VoxSettingsService, InstantiationType.Eager);
