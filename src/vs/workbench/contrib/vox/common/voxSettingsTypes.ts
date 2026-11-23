
/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from './voxI18n.js';
import { defaultModelsOfProvider, defaultProviderSettings, ModelOverrides } from './modelCapabilities.js';
import { ToolApprovalType } from './toolsServiceTypes.js';
import { VoxSettingsState } from './voxSettingsService.js'


type UnionOfKeys<T> = T extends T ? keyof T : never;



export const splitCliAgentModel = (modelName: string) => {
	const colon = modelName.indexOf(':')
	return { agent: colon < 0 ? modelName : modelName.slice(0, colon), subModel: colon < 0 ? '' : modelName.slice(colon + 1) }
}

export type ProviderName = keyof typeof defaultProviderSettings
export const providerNames = Object.keys(defaultProviderSettings) as ProviderName[]

// Vox usa solo questi due fornitori: le IA locali (llama.cpp, cartella `ia-locali`) e le IA in CLI installate.
// I fornitori delle versioni precedenti sono in `removedProviders.ts`, che serve solo a ripulire i dati salvati.
export const localProviderNames = ['voxLocal'] satisfies ProviderName[]

type CustomSettingName = UnionOfKeys<typeof defaultProviderSettings[ProviderName]>
type CustomProviderSettings<providerName extends ProviderName> = {
	[k in CustomSettingName]: k extends keyof typeof defaultProviderSettings[providerName] ? string : undefined
}
export const customSettingNamesOfProvider = (providerName: ProviderName) => {
	return Object.keys(defaultProviderSettings[providerName]) as CustomSettingName[]
}



export type VoxStatefulModelInfo = { // <-- STATEFUL
	modelName: string,
	type: 'default' | 'autodetected' | 'custom';
	isHidden: boolean, // whether or not the user is hiding it (switched off)
	description?: string, // solo per i modelli rilevati che ne hanno una
}



type CommonProviderSettings = {
	_didFillInProviderSettings: boolean | undefined, // undefined initially, computed when user types in all fields
	models: VoxStatefulModelInfo[],
}

export type SettingsAtProvider<providerName extends ProviderName> = CustomProviderSettings<providerName> & CommonProviderSettings

// part of state
export type SettingsOfProvider = {
	[providerName in ProviderName]: SettingsAtProvider<providerName>
}


export type SettingName = keyof SettingsAtProvider<ProviderName>

type DisplayInfoForProviderName = {
	title: string,
	desc?: string,
}

export const displayInfoOfProviderName = (providerName: ProviderName): DisplayInfoForProviderName => {
	if (providerName === 'voxLocal') return { title: t("Vox local AI") }
	if (providerName === 'cliAgent') return { title: t("CLI AI") }

	throw new Error(`descOfProviderName: Unknown provider name: "${providerName}"`)
}

export const subTextMdOfProviderName = (providerName: ProviderName): string => {

	if (providerName === 'voxLocal') return t("The models in Vox's local AI folder (`ia-locali`, described in `modelli.json`) run on this PC: Vox starts the chosen model when you use it (one at a time on each port) and closes it when you quit. Leave the folder empty to find it automatically: the folder found is then saved here.")
	if (providerName === 'cliAgent') return t("Use installed and authenticated CLIs. Model: `<ia>` or `<ia>:<model>`. Chat and Gather are read-only; Agent can modify the workspace only after you allow it.")

	throw new Error(`subTextMdOfProviderName: Unknown provider name: "${providerName}"`)
}

type DisplayInfo = {
	title: string;
	placeholder: string;
	isPasswordField?: boolean;
}
export const displayInfoOfSettingName = (providerName: ProviderName, settingName: SettingName): DisplayInfo => {
	if (settingName.endsWith('Command')) return { title: t("Command path for {0} (optional)", settingName.slice(0, -7)), placeholder: settingName.slice(0, -7) }
	if (settingName === 'timeoutSeconds') return { title: t("Timeout (seconds)"), placeholder: '600' }
	if (settingName === 'folder') return { title: t("Local AI folder (optional)"), placeholder: t("automatic: ia-locali next to Vox, in .vox in your user folder or in X:\\Vox") }
	if (settingName === '_didFillInProviderSettings') {
		return {
			title: '(never)',
			placeholder: '(never)',
		}
	}
	else if (settingName === 'models') {
		return {
			title: '(never)',
			placeholder: '(never)',
		}
	}

	throw new Error(`displayInfo: Unknown setting name: "${settingName}"`)
}


const defaultCustomSettings: Record<CustomSettingName, undefined> = {
	folder: undefined, // voxLocal
	codexCommand: undefined,
	agyCommand: undefined,
	devinCommand: undefined,
	copilotCommand: undefined,
	opencodeCommand: undefined,
	kimiCommand: undefined,
	claudeCommand: undefined,
	timeoutSeconds: undefined,
}


const modelInfoOfDefaultModelNames = (defaultModelNames: string[]): { models: VoxStatefulModelInfo[] } => {
	return {
		models: defaultModelNames.map((modelName, i) => ({
			modelName,
			type: 'default',
			isHidden: defaultModelNames.length >= 10, // hide all models if there are a ton of them, and make user enable them individually
		}))
	}
}

// used when waiting and for a type reference
export const defaultSettingsOfProvider: SettingsOfProvider = {
	voxLocal: {
		...defaultCustomSettings,
		...defaultProviderSettings.voxLocal,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.voxLocal),
		_didFillInProviderSettings: undefined,
	},
	cliAgent: {
		...defaultCustomSettings,
		...defaultProviderSettings.cliAgent,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.cliAgent),
		_didFillInProviderSettings: undefined,
	},
}


export type ModelSelection = { providerName: ProviderName, modelName: string }

export const modelSelectionsEqual = (m1: ModelSelection, m2: ModelSelection) => {
	return m1.modelName === m2.modelName && m1.providerName === m2.providerName
}

// this is a state
export const featureNames = ['Chat', 'Ctrl+K', 'Autocomplete', 'Apply', 'SCM'] as const
export type ModelSelectionOfFeature = Record<(typeof featureNames)[number], ModelSelection | null>
export type FeatureName = keyof ModelSelectionOfFeature

export const displayInfoOfFeatureName = (featureName: FeatureName) => {
	// editor:
	if (featureName === 'Autocomplete')
		return t("Autocomplete")
	else if (featureName === 'Ctrl+K')
		return t("Quick Edit")
	// sidebar:
	else if (featureName === 'Chat')
		return t("Chat")
	else if (featureName === 'Apply')
		return t("Apply")
	// source control:
	else if (featureName === 'SCM')
		return t("Commit Message Generator")
	else
		throw new Error(`Feature Name ${featureName} not allowed`)
}


// the models of these can be refreshed (in theory all can, but not all should)
export const refreshableProviderNames = localProviderNames
export type RefreshableProviderName = typeof refreshableProviderNames[number]

// use this in isFeatuerNameDissbled
export const isProviderNameDisabled = (providerName: ProviderName, settingsState: VoxSettingsState) => {

	const settingsAtProvider = settingsState.settingsOfProvider[providerName]
	const isAutodetected = (refreshableProviderNames as string[]).includes(providerName)

	const isDisabled = settingsAtProvider.models.length === 0
	if (isDisabled) {
		return isAutodetected ? 'providerNotAutoDetected' : (!settingsAtProvider._didFillInProviderSettings ? 'notFilledIn' : 'addModel')
	}
	return false
}

export const isFeatureNameDisabled = (featureName: FeatureName, settingsState: VoxSettingsState) => {
	// if has a selected provider, check if it's enabled
	const selectedProvider = settingsState.modelSelectionOfFeature[featureName]

	if (selectedProvider) {
		const { providerName } = selectedProvider
		return isProviderNameDisabled(providerName, settingsState)
	}

	// if there are any models they can turn on, tell them that
	const canTurnOnAModel = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName].models.filter(m => m.isHidden).length !== 0)
	if (canTurnOnAModel) return 'needToEnableModel'

	// if there are any providers filled in, then they just need to add a model
	const anyFilledIn = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName]._didFillInProviderSettings)
	if (anyFilledIn) return 'addModel'

	return 'addProvider'
}







export type ChatMode = 'agent' | 'gather' | 'normal'


export type GlobalSettings = {
	autoRefreshModels: boolean;
	aiInstructions: string;
	enableAutocomplete: boolean;
	syncApplyToChat: boolean;
	syncSCMToChat: boolean;
	enableFastApply: boolean;
	chatMode: ChatMode;
	autoApprove: { [approvalType in ToolApprovalType]?: boolean };
	showInlineSuggestions: boolean;
	includeToolLintErrors: boolean;
	isOnboardingComplete: boolean;
	disableSystemMessage: boolean;
	autoAcceptLLMChanges: boolean;
}

export const defaultGlobalSettings: GlobalSettings = {
	autoRefreshModels: true,
	aiInstructions: '',
	enableAutocomplete: false,
	syncApplyToChat: true,
	syncSCMToChat: true,
	enableFastApply: true,
	chatMode: 'agent',
	autoApprove: {},
	showInlineSuggestions: true,
	includeToolLintErrors: true,
	isOnboardingComplete: false,
	disableSystemMessage: false,
	autoAcceptLLMChanges: false,
}

export type GlobalSettingName = keyof GlobalSettings
export const globalSettingNames = Object.keys(defaultGlobalSettings) as GlobalSettingName[]












export type ModelSelectionOptions = {
	reasoningEnabled?: boolean;
	reasoningBudget?: number;
	reasoningEffort?: string;
}

export type OptionsOfModelSelection = {
	[featureName in FeatureName]: Partial<{
		[providerName in ProviderName]: {
			[modelName: string]: ModelSelectionOptions | undefined
		}
	}>
}





export type OverridesOfModel = {
	[providerName in ProviderName]: {
		[modelName: string]: Partial<ModelOverrides> | undefined
	}
}


const overridesOfModel = {} as OverridesOfModel
for (const providerName of providerNames) { overridesOfModel[providerName] = {} }
export const defaultOverridesOfModel = overridesOfModel



export interface MCPUserStateOfName {
	[serverName: string]: MCPUserState | undefined;
}

export interface MCPUserState {
	isOn: boolean;
}
