/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { InternalToolInfo } from './prompt/prompts.js'
import { ToolName, ToolParamName } from './toolsServiceTypes.js'
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel, ProviderName, RefreshableProviderName, SettingsOfProvider } from './voxSettingsTypes.js'


export const errorDetails = (fullError: Error | null): string | null => {
	if (fullError === null) {
		return null
	}
	else if (typeof fullError === 'object') {
		if (Object.keys(fullError).length === 0) return null
		return JSON.stringify(fullError, null, 2)
	}
	else if (typeof fullError === 'string') {
		return null
	}
	return null
}

export const getErrorMessage: (error: unknown) => string = (error) => {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	return error + ''
}



export type OpenAILLMChatMessage = {
	role: 'system' | 'user' | 'developer';
	content: string;
	// VOX: solo per i modelli locali, sul messaggio che contiene la domanda attuale: quanti caratteri in fondo al
	// messaggio sono la domanda (prima può esserci un risultato di strumento fuso nello stesso messaggio).
	// Lo legge e lo toglie `sendVoxLocalChat` (vedi `takeRequestMark` in localContextFit.ts): non arriva al modello.
	voxRequestChars?: number;
} | {
	role: 'assistant',
	content: string;
	tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string; } }[];
} | {
	role: 'tool',
	content: string;
	tool_call_id: string;
}

export type LLMChatMessage = OpenAILLMChatMessage



export type LLMFIMMessage = {
	prefix: string;
	suffix: string;
	stopTokens: string[];
}


export type RawToolParamsObj = {
	[paramName in ToolParamName<ToolName>]?: string;
}
export type RawToolCallObj = {
	name: ToolName;
	rawParams: RawToolParamsObj;
	doneParams: ToolParamName<ToolName>[];
	id: string;
	isDone: boolean;
};

// Token di una risposta. Li riportano solo le IA locali (llama-server); le IA in CLI non li comunicano.
export type LLMTokenStats = {
	generated: number; // token generati finora in questa risposta (testo, ragionamento e chiamate agli strumenti)
	tokensPerSecond: number | null; // velocità di generazione, `null` finché non si può calcolare
	promptTokens: number | null; // token del prompt (istruzioni e conversazione inviata): si sa solo a fine risposta
	exact: boolean; // `true`: conteggi del motore; `false`: stima (un pezzo ricevuto vale un token)
	speedExact?: boolean; // `true`: velocità misurata dal motore; `false`: stimata dai pezzi ricevuti (assente nelle risposte salvate prima: vale `exact`)
	promptModel?: string; // modello che ha contato i token del prompt (il nome scelto nella chat): il pannello calibra solo con lo stesso modello
	promptChars?: number; // caratteri del prompt inviato (messaggi e definizioni degli strumenti): con `promptTokens` calibra il pannello di contesto
	shortened?: boolean; // `true`: llama-server ha rifiutato il prompt e il processo principale ha accorciato ancora la conversazione
}

// statusText: stato provvisorio da mostrare finché non arriva il testo (per esempio l'avvio di un modello locale); non viene salvato nella chat
export type OnText = (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj; statusText?: string; tokenStats?: LLMTokenStats }) => void
export type OnFinalMessage = (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj; tokenStats?: LLMTokenStats }) => void // id is tool_use_id
// noRetry: errore che un nuovo tentativo non risolve (per esempio un modello locale che non si avvia)
export type OnError = (p: { message: string; fullError: Error | null; noRetry?: boolean }) => void
export type OnAbort = () => void
export type AbortRef = { current: (() => void) | null }


// service types
type SendLLMType = {
	messagesType: 'chatMessages';
	messages: LLMChatMessage[]; // the type of raw chat messages that we send to the local model or the CLI
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
} | {
	messagesType: 'FIMMessage';
	messages: LLMFIMMessage;
	separateSystemMessage?: undefined;
	chatMode?: undefined;
}
export type ServiceSendLLMMessageParams = {
	workspaceFolder?: string; // cartella di lavoro per le IA in CLI; se manca la ricava il servizio dal workspace aperto
	cliAllowWrite?: boolean; // le IA in CLI possono modificare i file solo se true (permesso dato dall'utente); altrimenti sola lettura
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	modelSelection: ModelSelection | null;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	onAbort: OnAbort;
} & SendLLMType;

// params to the true sendLLMMessage function
export type SendLLMMessageParams = {
	workspaceFolder?: string;
	cliAllowWrite?: boolean;
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	abortRef: AbortRef;

	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;

	settingsOfProvider: SettingsOfProvider;
	mcpTools: InternalToolInfo[] | undefined;
} & SendLLMType



// can't send functions across a proxy, use listeners instead
export type BlockedMainLLMMessageParams = 'onText' | 'onFinalMessage' | 'onError' | 'abortRef'
export type MainSendLLMMessageParams = Omit<SendLLMMessageParams, BlockedMainLLMMessageParams> & { requestId: string } & SendLLMType

export type MainLLMMessageAbortParams = { requestId: string }

export type EventLLMMessageOnTextParams = Parameters<OnText>[0] & { requestId: string }
export type EventLLMMessageOnFinalMessageParams = Parameters<OnFinalMessage>[0] & { requestId: string }
export type EventLLMMessageOnErrorParams = Parameters<OnError>[0] & { requestId: string }

// service -> main -> internal -> event (back to main)
// (browser)









// Un modello delle IA locali di Vox, come lo descrive `modelli.json`
export type VoxLocalModelResponse = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
	contextWindow?: number; // la finestra di contesto del manifesto
	folder?: string; // la cartella delle IA locali in uso
	description?: string; // la descrizione di modelli.json
	uso?: 'chat' | 'completamento'; // a cosa serve il modello: solo quelli di completamento fanno il completamento automatico
}



// params to the true list fn
export type ModelListParams<ModelResponse> = {
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	onSuccess: (param: { models: ModelResponse[]; warning?: string; folder?: string }) => void; // warning: avviso non bloccante; folder: cartella in uso
	onError: (param: { error: string }) => void;
}

// params to the service
export type ServiceModelListParams<modelResponse> = {
	providerName: RefreshableProviderName;
	onSuccess: (param: { models: modelResponse[]; warning?: string; folder?: string }) => void;
	onError: (param: { error: string }) => void;
}

type BlockedMainModelListParams = 'onSuccess' | 'onError'
export type MainModelListParams<modelResponse> = Omit<ModelListParams<modelResponse>, BlockedMainModelListParams> & { providerName: RefreshableProviderName, requestId: string }

export type EventModelListOnSuccessParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onSuccess']>[0] & { requestId: string }
export type EventModelListOnErrorParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onError']>[0] & { requestId: string }




