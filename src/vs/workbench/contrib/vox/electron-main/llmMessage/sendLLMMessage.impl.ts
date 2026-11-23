/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
import { t } from '../../common/voxI18n.js';
/* eslint-disable */
import OpenAI, { ClientOptions } from 'openai';
/* eslint-enable */

import { LLMChatMessage, LLMFIMMessage, ModelListParams, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj, VoxLocalModelResponse } from '../../common/sendLLMMessageTypes.js';
import { splitCliAgentModel, ChatMode, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voxSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, setVoxLocalContextWindows } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo, openAICompatibleToolOf } from '../../common/prompt/prompts.js';
import { runCliAgent, isCliAgentName } from './cliAgents.js';
import { localModelManager, LOCAL_MODELS_NOT_CONFIGURED } from './localModels.js';
import { requestVoxLocalFIM } from './voxLocalFIM.js';
import { isLoopbackURL, withoutRedirects } from './providerGuard.js';
import { charsOf, contextOverflowOf, shrinkToFit, takeRequestMark } from './localContextFit.js';
import { parseToolParamsLenient } from '../../common/toolParamsParse.js';
import { createTokenStatsTracker } from './tokenStats.js';

type InternalCommonMessageParams = {
	workspaceFolder?: string;
	cliAllowWrite?: boolean; // senza questo permesso le IA in CLI lavorano in sola lettura
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
	voxLocalBaseURL?: string; // solo voxLocal: l'indirizzo del modello locale avviato da Vox
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


// ------------ LLAMA-SERVER (API COMPATIBILE CON OPENAI) ------------

// L'unico server a cui Vox parla con l'SDK di OpenAI è llama-server avviato da Vox su questo PC: l'indirizzo deve
// essere di questa macchina (`isLoopbackURL`) e le richieste non seguono i reindirizzamenti (`withoutRedirects`).
const newVoxLocalSDK = ({ includeInPayload, voxLocalBaseURL }: { includeInPayload?: { [s: string]: any }, voxLocalBaseURL?: string }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	if (!voxLocalBaseURL) throw new Error(t("The local model has not been started."))
	if (!isLoopbackURL(voxLocalBaseURL)) throw new Error(t("Vox only talks to local models on this PC: {0} was refused.", voxLocalBaseURL))
	// llama-server non chiede una chiave: l'SDK ne vuole comunque una non vuota
	// il `fetch` di Node e quello dei tipi dell'SDK descrivono la stessa funzione con tipi diversi: da qui la conversione
	const localFetch = withoutRedirects(fetch) as unknown as ClientOptions['fetch']
	return new OpenAI({ ...commonPayloadOpts, baseURL: voxLocalBaseURL, apiKey: 'vox-locale', fetch: localFetch })
}


// VOX: la forma sta in common (openAICompatibleToolOf), perché il processo della finestra conti gli stessi caratteri
// (spazio per il prompt e pannello di contesto)
const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => openAICompatibleToolOf(toolInfo) satisfies OpenAI.Chat.Completions.ChatCompletionTool

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	// senza nome non c'è nessuna chiamata (il chiamante passa sempre nome e parametri, anche vuoti)
	if (!name) return null
	// lettura tollerante: i modelli locali a volte scrivono JSON quasi giusto (recinti di codice, virgole finali, nessun parametro)
	const input = parseToolParamsLenient(toolParamsStr)
	if (input === null) return null

	const rawParams = input as RawToolParamsObj
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}




const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, overridesOfModel, mcpTools, voxLocalBaseURL }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance
	const openai: OpenAI = newVoxLocalSDK({ includeInPayload, voxLocalBaseURL })
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messages as any,
		stream: true,
		// conteggi dei token: `usage` nell'ultimo pezzo e, da llama-server, `timings` a ogni pezzo (un motore che non
		// conosce `timings_per_token` lo ignora: allora i token si stimano dai pezzi ricevuti)
		stream_options: { include_usage: true },
		...({ timings_per_token: true } as {}),
		...nativeToolsObj,
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	}

	// I conteggi si aggiungono qui, prima degli adattatori qui sotto: così arrivano a chi ha chiamato qualunque cosa
	// gli adattatori facciano dei campi che non conoscono.
	const tokenStats = createTokenStatsTracker()
	// caratteri del prompt inviato, contati come `charsOf` (messaggi) più le definizioni degli strumenti: con i token
	// del prompt riportati da llama-server danno il rapporto caratteri/token di questo modello (pannello di contesto),
	// che si ricorda con il nome scelto nella chat: un altro modello ha un altro tokenizzatore
	const promptChars = (messages as Parameters<typeof charsOf>[0][]).reduce((sum, message) => sum + charsOf(message), 0)
		+ ('tools' in nativeToolsObj ? JSON.stringify(nativeToolsObj.tools).length : 0)
	const withTokenStats = <T extends object>(p: T): T => { const stats = tokenStats.current(); return stats.generated > 0 ? { ...p, tokenStats: { ...stats, promptChars, promptModel: modelName_ } } : p }
	const onTextWithoutStats = onText, onFinalMessageWithoutStats = onFinalMessage
	onText = p => onTextWithoutStats(withTokenStats(p))
	onFinalMessage = p => onFinalMessageWithoutStats(withTokenStats(p))

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	let toolName = ''
	let toolId = ''
	let toolParamsStr = ''

	// VOX: l'annullamento vale anche prima che arrivino le intestazioni della risposta
	// (per esempio mentre un modello locale legge un prompt lungo)
	const requestController = new AbortController()
	_setAborter(() => requestController.abort())
	openai.chat.completions
		.create(options, { signal: requestController.signal })
		.then(async response => {
			_setAborter(() => response.controller.abort())
			// when receive text
			for await (const chunk of response) {
				tokenStats.onChunk(chunk)
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// tool call
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index
					if (index !== 0) continue

					toolName += tool.function?.name ?? ''
					toolParamsStr += tool.function?.arguments ?? '';
					toolId += tool.id ?? ''
				}


				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				})

			}
			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				onError({ message: t("Vox: Response from model was empty."), fullError: null })
			}
			else {
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, ...toolCallObj });
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

const sendCliChat = async (params: SendChatParams_Internal): Promise<void> => {
	const { modelName, settingsOfProvider, messages, separateSystemMessage, chatMode, workspaceFolder, cliAllowWrite, onText, onFinalMessage, onError, _setAborter } = params;
	const { agent, subModel } = splitCliAgentModel(modelName);
	const model = modelName.includes(':') ? subModel : undefined;
	if (!isCliAgentName(agent) || model === '') { onError({ message: t("Select a CLI AI using ia or ia:model."), fullError: null, noRetry: true }); return; }
	const controller = new AbortController();
	_setAborter(() => controller.abort());
	try {
		// Conserva ordine e ruoli, escludendo i metadati di ragionamento e le chiamate agli strumenti.
		const prompt = [separateSystemMessage ? 'system:\n' + separateSystemMessage : '', ...messages.map(message => {
			const content: unknown = message.content;
			const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' ? 'text' in part ? part.text : 'type' in part && part.type === 'tool_result' ? part.content : '' : '').join('\n') : '';
			return message.role + ':\n' + (message.role === 'assistant' && !text.trim() ? '(risposta vuota)' : text);
		})].filter(Boolean).join('\n\n');
		const settings = settingsOfProvider.cliAgent;
		// Un valore salvato male non deve dare un errore incomprensibile: un testo vuoto, un valore mancante o di un
		// altro tipo valgono 600; un testo che non è un numero diventa NaN e viene rifiutato da `runCliAgent` con un
		// messaggio chiaro.
		const savedTimeout: unknown = settings.timeoutSeconds;
		const timeoutText = typeof savedTimeout === 'string' ? savedTimeout.trim() : typeof savedTimeout === 'number' ? String(savedTimeout) : '';
		const timeoutSeconds = timeoutText ? Number(timeoutText) : 600;
		const fullText = await runCliAgent({ agent, model, prompt, cwd: workspaceFolder, write: chatMode === 'agent' && cliAllowWrite === true, command: settings[`${agent}Command`], timeoutMs: timeoutSeconds * 1000, signal: controller.signal, onText: fullText => onText({ fullText, fullReasoning: '' }) });
		onFinalMessage({ fullText, fullReasoning: '' });
	} catch (error) {
		// Un errore di una CLI non si riprova da solo: comando mancante, accesso da fare, impostazione sbagliata e tempo
		// scaduto si ripetono uguali, e ogni tentativo consuma tempo e quota dell'abbonamento.
		if (!controller.signal.aborted) onError({ message: error instanceof Error ? error.message : t("CLI error."), fullError: null, noRetry: true });
	}
};

// ------------ IA LOCALI DI VOX ------------

// Elenca i modelli da chat e di completamento del manifesto (nessun server serve): finestra di contesto, uso e
// cartella viaggiano con ogni modello.
const voxLocalList = async ({ onSuccess, onError, settingsOfProvider }: ListParams_Internal<VoxLocalModelResponse>) => {
	try {
		const { folder, models, missing } = await localModelManager.listModels(settingsOfProvider.voxLocal.folder)
		setVoxLocalContextWindows(models.map(model => ({ name: model.nome, contextWindow: model.contesto, uso: model.uso })))
		// i file .gguf mancanti o irraggiungibili non bloccano l'elenco: si segnalano come avviso accanto ai modelli
		// trovati, ognuno con la sua causa (un timeout non è un file assente)
		// avviso e descrizioni hanno un limite: un manifesto con molti modelli mancanti o descrizioni lunghe non deve
		// riempire le Impostazioni né il menu (la descrizione completa resta in modelli.json)
		const MAX_LISTED = 5, MAX_DESCRIPTION = 200
		// con un solo file in più si elenca anche quello: "e altri 1" non direbbe niente di utile
		const listed = (items: string[]) => items.length > MAX_LISTED + 1 ? t('{0} and {1} more', items.slice(0, MAX_LISTED).join('; '), items.length - MAX_LISTED) : items.join('; ')
		// lunghezza in caratteri (punti di codice), non in unità UTF-16: il taglio non spezza un'emoji
		const oneLine = (text: string) => {
			const line = text.replace(/\s+/g, ' ').trim(), chars = Array.from(line)
			return chars.length > MAX_DESCRIPTION ? `${chars.slice(0, MAX_DESCRIPTION - 1).join('').trimEnd()}…` : line
		}
		const notFound = missing.filter(item => !item.error), unreachable = missing.filter(item => item.error)
		const warning = [
			notFound.length ? t('Local model files not found: {0}', listed(notFound.map(item => `${item.nome} (${item.file})`))) : '',
			unreachable.length ? t('Local model files not reachable: {0}', listed(unreachable.map(item => `${item.nome} (${item.error})`))) : '',
		].filter(Boolean).join('. ') || undefined
		// la cartella viaggia anche da sola: con zero modelli va comunque salvata e mostrata come trovata
		onSuccess({ models: models.map(model => ({ id: model.nome, created: 0, object: 'model' as const, owned_by: 'vox', contextWindow: model.contesto, folder, description: oneLine(model.descrizione) || undefined, uso: model.uso })), warning, folder })
	} catch (error) {
		// IA locali assenti (cartella vuota, nulla trovato): nessun modello, non un errore da mostrare
		if (error instanceof Error && error.name === LOCAL_MODELS_NOT_CONFIGURED) { setVoxLocalContextWindows([]); onSuccess({ models: [] }); return }
		onError({ error: error instanceof Error ? error.message : String(error) })
	}
}

// Avvia (o riusa) il modello locale e poi parla con llama-server, che espone la stessa API di OpenAI.
const sendVoxLocalChat = async (params: SendChatParams_Internal): Promise<void> => {
	const { modelName, settingsOfProvider, onText, onFinalMessage, onError, _setAborter } = params
	const controller = new AbortController()
	let aborted = false
	_setAborter(() => { aborted = true; controller.abort() })

	let lease: Awaited<ReturnType<typeof localModelManager.acquire>>
	try {
		lease = await localModelManager.acquire(settingsOfProvider.voxLocal.folder, modelName, {
			signal: controller.signal,
			onStatus: statusText => { if (!aborted) onText({ fullText: '', fullReasoning: '', statusText }) },
		})
	} catch (error) {
		if (aborted) return // annullata dall'utente: l'annullamento è già gestito da chi ha chiamato
		// un modello che non si avvia non si avvia nemmeno ritentando subito: niente nuovi tentativi automatici
		onError({ message: error instanceof Error ? error.message : String(error), fullError: error instanceof Error ? error : null, noRetry: true })
		return
	}

	let released = false
	const release = () => { if (!released) { released = true; lease.release() } }
	if (aborted) { release(); return }

	// il prestito si restituisce a fine risposta, con un errore o con l'annullamento
	// Se il prompt non entra nel contesto, llama-server lo dice con il conteggio esatto: si accorciano i messaggi
	// più vecchi e si riprova con lo stesso processo, al massimo `MAX_CONTEXT_RETRIES` volte.
	// il segno della domanda attuale messo dal renderer serve solo qui: si toglie prima di inviare a llama-server
	const { messages: unmarked, mark } = takeRequestMark(params.messages)
	let messages = unmarked
	let retries = 0
	const send = async (): Promise<void> => {
		await _sendOpenAICompatibleChat({
			...params,
			messages,
			voxLocalBaseURL: lease.baseURL,
			// dopo un accorciamento il conteggio lo dice: il pannello di contesto avvisa che il prompt non entrava
			onFinalMessage: p => { release(); onFinalMessage(retries > 0 && p.tokenStats ? { ...p, tokenStats: { ...p.tokenStats, shortened: true } } : p) },
			onError: p => {
				const overflow = aborted ? null : contextOverflowOf(p.fullError)
				if (!overflow) { release(); onError(p); return }
				const { messages: shorter, removed, fitted } = shrinkToFit(messages, overflow, mark)
				// si riprova solo se l'accorciamento, secondo la stima, basta: altrimenti l'errore chiaro subito
				if (removed > 0 && fitted && retries < MAX_CONTEXT_RETRIES) {
					retries += 1
					messages = shorter
					onText({ fullText: '', fullReasoning: '', statusText: t('The conversation is too long for the local model {0}: shortening the oldest messages…', modelName) })
					send().catch(error => {
						release()
						if (aborted) return // annullata dall'utente: l'annullamento è già gestito da chi ha chiamato
						onError({ message: error instanceof Error ? error.message : String(error), fullError: error instanceof Error ? error : null, noRetry: true })
					})
					return
				}
				release()
				// non entra nemmeno accorciando: ritentare uguale darebbe lo stesso errore
				onError({ message: t('The conversation is too long for the local model {0}: {1} tokens for a context of {2}. Start a new chat or increase the context in Settings > Local AI > Installed models.', modelName, overflow.promptTokens, overflow.contextTokens), fullError: p.fullError, noRetry: true })
			},
			// `aborted` anche qui: lo Stop può arrivare fra l'errore di contesto e il nuovo invio; se è già
			// arrivato prima che il nuovo invio registrasse il suo annullamento, la nuova richiesta si chiude subito
			_setAborter: aborter => {
				if (aborted) { aborter(); return }
				_setAborter(() => { aborted = true; release(); aborter() })
			},
		})
	}
	try {
		await send()
	} catch (error) {
		release()
		throw error
	}
}
const MAX_CONTEXT_RETRIES = 3

// Completamento automatico: il modello di completamento locale (`"uso": "completamento"` in modelli.json), tramite
// `/infill` di llama-server. Vox lo avvia alla prima richiesta e lo riusa per le successive.
const sendVoxLocalFIM = async ({ messages: { prefix, suffix, stopTokens }, modelName, settingsOfProvider, onFinalMessage, onError, _setAborter }: SendFIMParams_Internal): Promise<void> => {
	const controller = new AbortController()
	_setAborter(() => controller.abort())
	try {
		const fullText = await requestVoxLocalFIM({ folder: settingsOfProvider.voxLocal.folder, modelName, prefix, suffix, stopTokens, signal: controller.signal })
		if (controller.signal.aborted) return
		onFinalMessage({ fullText, fullReasoning: '' })
	} catch (error) {
		if (controller.signal.aborted) return // annullata (l'utente ha continuato a scrivere): non è un errore
		// un modello che non si avvia o non risponde non va ritentato a ogni tasto
		onError({ message: error instanceof Error ? error.message : String(error), fullError: error instanceof Error ? error : null, noRetry: true })
	}
}

// Vox ha solo questi due motori: le IA locali (llama-server su questo PC) e le IA in CLI installate.
// Non c'è nessun altro percorso verso un servizio di IA: aggiungerne uno qui è una scelta da discutere, non un dettaglio.
export const sendLLMMessageToProviderImplementation = {
	voxLocal: { sendChat: sendVoxLocalChat, sendFIM: sendVoxLocalFIM, list: voxLocalList },
	cliAgent: { sendChat: sendCliChat, sendFIM: null, list: null },
} satisfies CallFnOfProvider
