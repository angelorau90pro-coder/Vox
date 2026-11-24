/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { FeatureName, ModelSelectionOptions, OverridesOfModel, ProviderName } from './voxSettingsTypes.js';





export const defaultProviderSettings = {
	// IA locali di Vox: modelli llama.cpp descritti in <cartella>/modelli.json, avviati da Vox quando servono.
	// Cartella vuota = ricerca automatica (vedi electron-main/llmMessage/localModels.ts).
	voxLocal: {
		folder: '',
	},
	cliAgent: {
		codexCommand: '',
		agyCommand: '',
		devinCommand: '',
		copilotCommand: '',
		opencodeCommand: '',
		kimiCommand: '',
		claudeCommand: '',
		timeoutSeconds: '600',
	},

} as const




export const defaultModelsOfProvider = {
	voxLocal: [], // autodetected (modelli.json)
	cliAgent: [],

} as const satisfies Record<ProviderName, string[]>



export type VoxStaticModelInfo = { // not stateful
	// Vox uses the information below to know how to handle each model.
	// for some examples, see openSourceModelOptions_assumingOAICompat (below).

	contextWindow: number; // input tokens
	reservedOutputTokenSpace: number | null; // reserve this much space in the context window for output, defaults to 4096 if null

	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated'; // typically you should use 'system-role'. 'separated' means the system message is passed as a separate field
	specialToolFormat?: 'openai-style', // typically you should use 'openai-style'. null means "can't call tools by default", and asks the LLM to output XML in agent mode
	supportsFIM: boolean; // whether the model was specifically designed for autocomplete or "FIM" ("fill-in-middle" format)

	additionalOpenAIPayload?: { [key: string]: string } // additional payload in the message body of the requests to llama-server (OpenAI-compatible)

	// reasoning options
	reasoningCapabilities: false | {
		readonly supportsReasoning: true; // for clarity, this must be true if anything below is specified
		readonly canTurnOffReasoning: boolean; // whether or not the user can disable reasoning mode (false if the model only supports reasoning)
		readonly canIOReasoning: boolean; // whether or not the model actually outputs reasoning (eg o1 lets us control reasoning but not output it)
		readonly reasoningReservedOutputTokenSpace?: number; // overrides normal reservedOutputTokenSpace
		readonly reasoningSlider?:
		| undefined
		| { type: 'budget_slider'; min: number; max: number; default: number } // reasoning budget
		| { type: 'effort_slider'; values: string[]; default: string } // reasoning effort (OpenAI-compatible)

		// if it's open source and specifically outputs think tags, put the think tags here and we'll parse them out
		readonly openSourceThinkTags?: [string, string];

		// the only other field related to reasoning is "providerReasoningIOSettings", which varies by provider.
	};


	// --- below is just informative, not used in sending / receiving, cannot be customized in settings ---
	cost: {
		input: number;
		output: number;
		cache_read?: number;
		cache_write?: number;
	}
	downloadable: false | {
		sizeGb: number | 'not-known'
	}
}
// if you change the above type, remember to update the Settings link



export const modelOverrideKeys = [
	'contextWindow',
	'reservedOutputTokenSpace',
	'supportsSystemMessage',
	'specialToolFormat',
	'supportsFIM',
	'reasoningCapabilities',
	'additionalOpenAIPayload'
] as const

export type ModelOverrides = Pick<
	VoxStaticModelInfo,
	(typeof modelOverrideKeys)[number]
>




type ProviderReasoningIOSettings = {
	// include this in payload to get reasoning
	input?: { includeInPayload?: (reasoningState: SendableReasoningInfo) => null | { [key: string]: any }, };
	// nameOfFieldInDelta: reasoning output is in response.choices[0].delta[deltaReasoningField]
	// needsManualParse: whether we must manually parse out the <think> tags
	output?:
	| { nameOfFieldInDelta?: string, needsManualParse?: undefined, }
	| { nameOfFieldInDelta?: undefined, needsManualParse?: true, };
}

type VoxStaticProviderInfo = { // doesn't change (not stateful)
	providerReasoningIOSettings?: ProviderReasoningIOSettings; // input/output settings around thinking (allowed to be empty) - only applied if the model supports reasoning output
	modelOptions: { [key: string]: VoxStaticModelInfo };
	modelOptionsFallback: (modelName: string, fallbackKnownValues?: Partial<VoxStaticModelInfo>) => (VoxStaticModelInfo & { modelName: string, recognizedModelName: string }) | null;
}



const defaultModelOptions = {
	contextWindow: 4_096,
	reservedOutputTokenSpace: 4_096,
	cost: { input: 0, output: 0 },
	downloadable: false,
	supportsSystemMessage: false,
	supportsFIM: false,
	reasoningCapabilities: false,
} as const satisfies VoxStaticModelInfo

// TODO!!! double check all context sizes below
// TODO!!! allow user to modify capabilities and tell them if autodetected model or falling back
const openSourceModelOptions_assumingOAICompat = {
	'deepseekR1': {
		supportsFIM: false,
		supportsSystemMessage: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'deepseekCoderV3': {
		supportsFIM: false,
		supportsSystemMessage: false, // unstable
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'deepseekCoderV2': {
		supportsFIM: false,
		supportsSystemMessage: false, // unstable
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'codestral': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'devstral': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 131_000, reservedOutputTokenSpace: 8_192,
	},
	'openhands-lm-32b': { // https://www.all-hands.dev/blog/introducing-openhands-lm-32b----a-strong-open-coding-agent-model
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false, // built on qwen 2.5 32B instruct
		contextWindow: 128_000, reservedOutputTokenSpace: 4_096
	},

	// really only phi4-reasoning supports reasoning... simpler to combine them though
	'phi4': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 16_000, reservedOutputTokenSpace: 4_096,
	},

	'gemma': { // https://news.ycombinator.com/item?id=43451406
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	// llama 4 https://ai.meta.com/blog/llama-4-multimodal-intelligence/
	'llama4-scout': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},
	'llama4-maverick': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},

	// llama 3
	'llama3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.1': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.2': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	// qwen
	'qwen2.5coder': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'qwq': {
		supportsFIM: false, // no FIM, yes reasoning
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'qwen3': {
		supportsFIM: false, // replaces QwQ
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_768, reservedOutputTokenSpace: 8_192,
	},
	// FIM only
	'starcoder2': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	'codegemma:2b': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	// modelli locali recenti che chiamano gli strumenti in formato nativo (llama.cpp con --jinja)
	'gpt-oss': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_768, reservedOutputTokenSpace: 8_192,
	},
	'qwen3.5+': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_768, reservedOutputTokenSpace: 8_192,
	},
} as const satisfies { [s: string]: Partial<VoxStaticModelInfo> }




// keep modelName, but use the fallback's defaults
const extensiveModelOptionsFallback: VoxStaticProviderInfo['modelOptionsFallback'] = (modelName, fallbackKnownValues) => {

	const lower = modelName.toLowerCase()

	const toFallback = <T extends { [s: string]: Omit<VoxStaticModelInfo, 'cost' | 'downloadable'> },>(obj: T, recognizedModelName: string & keyof T)
		: VoxStaticModelInfo & { modelName: string, recognizedModelName: string } => {

		const opts = obj[recognizedModelName]
		const supportsSystemMessage = opts.supportsSystemMessage === 'separated'
			? 'system-role'
			: opts.supportsSystemMessage

		return {
			recognizedModelName,
			modelName,
			...opts,
			supportsSystemMessage: supportsSystemMessage,
			cost: { input: 0, output: 0 },
			downloadable: false,
			...fallbackKnownValues
		};
	}

	if (lower.includes('deepseek-r1') || lower.includes('deepseek-reasoner')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekR1')
	if (lower.includes('deepseek') && lower.includes('v2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV2')
	if (lower.includes('deepseek')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV3')

	if (lower.includes('llama3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3')
	if (lower.includes('llama3.1')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.1')
	if (lower.includes('llama3.2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.2')
	if (lower.includes('llama3.3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.3')
	if (lower.includes('llama') || lower.includes('scout')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')
	if (lower.includes('llama') || lower.includes('maverick')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')
	if (lower.includes('llama')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')

	if (lower.includes('qwen') && lower.includes('2.5') && lower.includes('coder')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen2.5coder')
	if (/qwen-?3[.-][5-9]/.test(lower)) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3.5+')
	if (lower.includes('qwen') && lower.includes('3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3')
	if (lower.includes('qwen')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3')
	if (lower.includes('qwq')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwq') }
	if (lower.includes('phi4')) return toFallback(openSourceModelOptions_assumingOAICompat, 'phi4')
	if (lower.includes('codestral')) return toFallback(openSourceModelOptions_assumingOAICompat, 'codestral')
	if (lower.includes('devstral')) return toFallback(openSourceModelOptions_assumingOAICompat, 'devstral')

	if (lower.includes('gemma')) return toFallback(openSourceModelOptions_assumingOAICompat, 'gemma')

	if (lower.includes('starcoder2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'starcoder2')

	if (lower.includes('openhands')) return toFallback(openSourceModelOptions_assumingOAICompat, 'openhands-lm-32b') // max output uncler


	if (lower.includes('gpt-oss')) return toFallback(openSourceModelOptions_assumingOAICompat, 'gpt-oss')


	if (Object.keys(openSourceModelOptions_assumingOAICompat).map(k => k.toLowerCase()).includes(lower))
		return toFallback(openSourceModelOptions_assumingOAICompat, lower as keyof typeof openSourceModelOptions_assumingOAICompat)

	return null
}






// https://platform.openai.com/docs/guides/reasoning?api-mode=chat
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
	if (!reasoningInfo?.isReasoningEnabled) return null
	if (reasoningInfo.type === 'effort_slider_value') {
		return { reasoning_effort: reasoningInfo.reasoningEffort }
	}
	return null

}

// IA locali di Vox (llama-server): stesse chiamate di OpenAI-Compatible; il ragionamento arriva in `reasoning_content`.
const voxLocalSettings: VoxStaticProviderInfo = {
	// il completamento automatico (FIM) non si deduce dal nome: vale solo per i modelli che il manifesto indica
	// con `"uso": "completamento"` (vedi `withinLocalContext` in `getModelCapabilities`)
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName, { supportsFIM: false }),
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

// Finestra di contesto dei modelli locali, presa dal manifesto quando vengono rilevati. Nel renderer
// refreshModelService la salva e la ricarica all'avvio, così vale anche prima del primo rilevamento;
// le modifiche dell'utente restano in overridesOfModel.
const contextWindowOfVoxLocalModel = new Map<string, number>()
// Modelli locali che il manifesto indica con `"uso": "completamento"`: servono solo al completamento automatico
// (FIM, endpoint `/infill` di llama-server) e non compaiono fra i modelli da chat. Gli altri sono modelli da chat.
const completionVoxLocalModels = new Set<string>()
export type VoxLocalModelUse = 'chat' | 'completamento'
export const setVoxLocalContextWindows = (models: { name: string, contextWindow: number | undefined, uso?: VoxLocalModelUse }[]) => {
	contextWindowOfVoxLocalModel.clear()
	completionVoxLocalModels.clear()
	for (const { name, contextWindow, uso } of models) {
		if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) contextWindowOfVoxLocalModel.set(name, contextWindow)
		if (uso === 'completamento') completionVoxLocalModels.add(name)
	}
}
export const isVoxLocalCompletionModel = (modelName: string): boolean => completionVoxLocalModels.has(modelName)

// ---------------- model settings of everything above ----------------

const modelSettingsOfProvider: { [providerName in ProviderName]: VoxStaticProviderInfo } = {
	voxLocal: voxLocalSettings,
	cliAgent: { modelOptions: {}, modelOptionsFallback: () => null },
} as const


// ---------------- exports ----------------

// returns the capabilities and the adjusted modelName if it was a fallback
export const getModelCapabilities = (
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined
): VoxStaticModelInfo & (
	| { modelName: string; recognizedModelName: string; isUnrecognizedModel: false }
	| { modelName: string; recognizedModelName?: undefined; isUnrecognizedModel: true }
) => {

	// Le CLI gestiscono i propri strumenti: gli override non devono attivare tool o reasoning di Vox.
	if (providerName === 'cliAgent') return { ...defaultModelOptions, contextWindow: 32_768, supportsSystemMessage: 'system-role', modelName, recognizedModelName: modelName, isUnrecognizedModel: false }

	const lowercaseModelName = modelName.toLowerCase()

	const providerSettings = modelSettingsOfProvider[providerName]
	// un fornitore che non esiste più (arrivato da dati di una versione precedente): capacità predefinite, senza errori
	if (!providerSettings) return { modelName, ...defaultModelOptions, isUnrecognizedModel: true }
	const { modelOptions, modelOptionsFallback } = providerSettings

	// Get any override settings for this model
	const overrides = overridesOfModel?.[providerName]?.[modelName];

	// IA locali di Vox: la finestra di contesto del manifesto. Le scelte dell'utente vengono dopo, ma non possono
	// superarla: llama-server parte con `-c` uguale al manifesto e rifiuta i prompt più lunghi.
	const voxLocalContextWindow = providerName === 'voxLocal' ? contextWindowOfVoxLocalModel.get(modelName) : undefined
	const localKnownValues = voxLocalContextWindow ? { contextWindow: voxLocalContextWindow } : undefined
	// Dopo gli override, per voxLocal: contesto entro il manifesto, spazio riservato alla risposta al massimo metà
	// del contesto (altrimenti con un contesto piccolo non resterebbe spazio per il prompt). Il FIM lo decide solo
	// il manifesto (`"uso": "completamento"`): un override non lo attiva su un modello da chat né lo spegne su
	// quello di completamento, perché llama-server parte con un modello solo per porta e uso.
	// Formato degli strumenti: llama-server (con `--jinja`) capisce solo quello di OpenAI; un altro formato scelto
	// in un override non vale, e si usa l'XML nel prompt.
	// Ruolo del messaggio di sistema: il ruolo `developer` (scelto in un override) non è conosciuto da molti template
	// jinja locali; si usa `system`, che tutti capiscono (anche gpt-oss).
	// Anche `separated` (scelto in un override) diventa `system`: il percorso compatibile OpenAI non invia il messaggio
	// di sistema separato, e istruzioni e regole del progetto andrebbero perse senza avviso.
	const withinLocalContext = <T extends Pick<VoxStaticModelInfo, 'contextWindow' | 'reservedOutputTokenSpace' | 'supportsFIM' | 'reasoningCapabilities' | 'specialToolFormat' | 'supportsSystemMessage'>>(caps: T): T => {
		if (providerName !== 'voxLocal') return caps
		const contextWindow = voxLocalContextWindow && caps.contextWindow > voxLocalContextWindow ? voxLocalContextWindow : caps.contextWindow
		const half = Math.floor(contextWindow / 2)
		const cap = <N extends number | null | undefined>(value: N): N => (typeof value === 'number' && value > half ? half : value) as N
		const reasoning = caps.reasoningCapabilities
		return {
			...caps, contextWindow, supportsFIM: completionVoxLocalModels.has(modelName), reservedOutputTokenSpace: cap(caps.reservedOutputTokenSpace),
			specialToolFormat: caps.specialToolFormat === 'openai-style' ? 'openai-style' : undefined,
			supportsSystemMessage: caps.supportsSystemMessage === 'developer-role' || caps.supportsSystemMessage === 'separated' ? 'system-role' : caps.supportsSystemMessage,
			reasoningCapabilities: reasoning && typeof reasoning.reasoningReservedOutputTokenSpace === 'number' ? { ...reasoning, reasoningReservedOutputTokenSpace: cap(reasoning.reasoningReservedOutputTokenSpace) } : reasoning,
		}
	}

	// search model options object directly first
	for (const modelName_ in modelOptions) {
		const lowercaseModelName_ = modelName_.toLowerCase()
		if (lowercaseModelName === lowercaseModelName_) {
			return withinLocalContext({ ...modelOptions[modelName], ...localKnownValues, ...overrides, modelName, recognizedModelName: modelName, isUnrecognizedModel: false });
		}
	}

	const result = modelOptionsFallback(modelName)
	if (result) {
		return withinLocalContext({ ...result, ...localKnownValues, ...overrides, modelName: result.modelName, isUnrecognizedModel: false });
	}

	return withinLocalContext({ modelName, ...defaultModelOptions, ...localKnownValues, ...overrides, isUnrecognizedModel: true });
}

// non-model settings
export const getProviderCapabilities = (providerName: ProviderName) => {
	const providerReasoningIOSettings = modelSettingsOfProvider[providerName]?.providerReasoningIOSettings
	return { providerReasoningIOSettings }
}


export type SendableReasoningInfo = {
	type: 'budget_slider_value',
	isReasoningEnabled: true,
	reasoningBudget: number,
} | {
	type: 'effort_slider_value',
	isReasoningEnabled: true,
	reasoningEffort: string,
} | null



export const getIsReasoningEnabledState = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
) => {
	const { supportsReasoning, canTurnOffReasoning } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {}
	if (!supportsReasoning) return false

	// default to enabled if can't turn off, or if the featureName is Chat.
	const defaultEnabledVal = featureName === 'Chat' || !canTurnOffReasoning

	const isReasoningEnabled = modelSelectionOptions?.reasoningEnabled ?? defaultEnabledVal
	return isReasoningEnabled
}


export const getReservedOutputTokenSpace = (providerName: ProviderName, modelName: string, opts: { isReasoningEnabled: boolean, overridesOfModel: OverridesOfModel | undefined }) => {
	const {
		reasoningCapabilities,
		reservedOutputTokenSpace,
	} = getModelCapabilities(providerName, modelName, opts.overridesOfModel)
	return opts.isReasoningEnabled && reasoningCapabilities ? reasoningCapabilities.reasoningReservedOutputTokenSpace : reservedOutputTokenSpace
}

// used to force reasoning state (complex) into something simple we can just read from when sending a message
export const getSendableReasoningInfo = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
): SendableReasoningInfo => {

	const { reasoningSlider: reasoningBudgetSlider } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {}
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
	if (!isReasoningEnabled) return null

	// check for reasoning budget
	const reasoningBudget = reasoningBudgetSlider?.type === 'budget_slider' ? modelSelectionOptions?.reasoningBudget ?? reasoningBudgetSlider?.default : undefined
	if (reasoningBudget) {
		return { type: 'budget_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningBudget: reasoningBudget }
	}

	// check for reasoning effort
	const reasoningEffort = reasoningBudgetSlider?.type === 'effort_slider' ? modelSelectionOptions?.reasoningEffort ?? reasoningBudgetSlider?.default : undefined
	if (reasoningEffort) {
		return { type: 'effort_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningEffort: reasoningEffort }
	}

	return null
}
