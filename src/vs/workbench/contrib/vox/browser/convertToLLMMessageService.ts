import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { ChatMessage, StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { createSystemMessageMemo, EditorSnapshot, indexOfEditorStateNoteToKeep, stableTrimLength, trailingEditorStateNote, withoutEditorStateNote } from '../common/promptStability.js';
import { Schemas } from '../../../../base/common/network.js';
import { reParsedToolXMLString, chat_systemMessage, availableTools, chat_userMessageContent, systemToolsXMLPrompt, nativeToolsCharsOf } from '../common/prompt/prompts.js';
import { LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoxSettingsService } from '../common/voxSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/voxSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoxModelService } from '../common/voxModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { IProjectContextService } from './projectContextService.js';
import { RULES_FILE_NAMES } from '../common/storageKeys.js';
import { ContextMeasures, promptCharsOf, systemPartsOf } from '../common/contextUsage.js';

export const EMPTY_MESSAGE = '(empty message)'



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
}



const CHARS_PER_TOKEN = 4 // assume abysmal chars per token
const VOX_LOCAL_CHARS_PER_TOKEN = 3
const TRIM_TO_LEN = 120
// VOX: il messaggio di sistema fuso nel primo messaggio, per i modelli che non ne accettano uno (le misure del
// pannello di contesto contano questi tag con le istruzioni di Vox)
const FUSED_SYSTEM_OPEN = '<SYSTEM_MESSAGE>\n'
const FUSED_SYSTEM_CLOSE = '\n</SYSTEM_MESSAGE>\n'
// VOX: lo schema delle schede di Vox nell'area degli editor (voxSettingsPane.ts, chatContextPane.ts): non sono file
const VOX_EDITOR_SCHEME = 'vox'
// VOX: con i modelli locali il taglio parziale di un messaggio avanza a passi (vedi promptStability.ts):
// al più 4000 caratteri, e mai più di un ventesimo dello spazio del prompt (contesti piccoli)
const VOX_LOCAL_TRIM_STEP = 4_000

// VOX: i parametri delle chiamate a strumento vanno al modello insieme al risultato (come `arguments` della
// chiamata): contano nel contesto e si possono accorciare come il testo.
const paramsLengthOf = (message: { role: string, rawParams?: RawToolParamsObj }) => message.role === 'tool' && message.rawParams ? JSON.stringify(message.rawParams).length : 0
const lengthOf = (message: { role: string, content: string, rawParams?: RawToolParamsObj }) => message.content.length + paramsLengthOf(message)
const shortenedParams = (rawParams: RawToolParamsObj): RawToolParamsObj => {
	const result: Record<string, string | undefined> = {}
	for (const [name, value] of Object.entries(rawParams)) result[name] = typeof value === 'string' && value.length > TRIM_TO_LEN ? value.substring(0, TRIM_TO_LEN - '...'.length) + '...' : value
	return result as RawToolParamsObj
}

// VOX: segna il messaggio che contiene la domanda attuale con la lunghezza della domanda, che ne è la parte finale
// (vedi `voxRequestChars` in sendLLMMessageTypes.ts): così il processo principale la protegge senza indovinarla dal testo
const markRequest = (message: { role: string } | undefined, requestChars: number) => {
	if (message?.role === 'user') (message as OpenAILLMChatMessage & { role: 'user' }).voxRequestChars = requestChars
}



// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): OpenAILLMChatMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// VOX: `requestIdx` è l'indice della domanda attuale in `messages` (-1 se non serve): il messaggio che la riceve
// porta `voxRequestChars`, perché la domanda può essere fusa con un risultato di strumento che la precede
const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], requestIdx = -1): OpenAILLMChatMessage[] => {

	const llmChatMessages: OpenAILLMChatMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
			// la domanda è sempre l'ultima parte del messaggio che la riceve (dopo arriva l'assistente)
			if (i === requestIdx) markRequest(llmChatMessages[llmChatMessages.length - 1], c.content.length)
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	contextWindow,
	reservedOutputTokenSpace,
	providerName,
	nativeToolsChars = 0,
	xmlToolsChars = 0,
	xmlToolsStart = -1,
	requestChars = 0,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | undefined,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	// VOX: caratteri delle definizioni degli strumenti mandate a parte (formato nativo): occupano contesto anche loro
	nativeToolsChars?: number,
	// VOX: solo per le misure del pannello di contesto (non cambiano i messaggi): caratteri delle definizioni XML
	// degli strumenti dentro il messaggio di sistema, e della richiesta in fondo non ancora inviata
	xmlToolsChars?: number,
	// dove cominciano quelle definizioni dentro `systemMessage` (-1 se non si sa): serve quando il messaggio di
	// sistema viene accorciato, per contare solo la parte rimasta di ogni blocco
	xmlToolsStart?: number,
	requestChars?: number,
	providerName: ProviderName,
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined, measures: ContextMeasures } => {

	reservedOutputTokenSpace = Math.max(
		contextWindow * 1 / 2, // reserve at least 1/4 of the token window length
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .voxrules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	// VOX: per il pannello di contesto, i messaggi che il taglio ha davvero accorciato (testo o parametri di uno
	// strumento). Non coincide con `alreadyTrimmedIdxes`, che serve ai pesi: quello non segna il taglio parziale con
	// cui il ciclo finisce e segna anche i messaggi già corti, che restano come sono.
	const shortenedIdxes = new Set<number>()
	// VOX: indice della domanda attuale (l'ultimo messaggio dell'utente), protetta solo per i modelli locali
	const currentRequestIdx = providerName === 'voxLocal' ? messages.map(m => m.role).lastIndexOf('user') : -1
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = lengthOf(message)

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// VOX: con i modelli locali la domanda attuale non si tronca di nascosto: se il resto non basta,
		// llama-server lo dice e Vox mostra un errore chiaro (vedi localContextFit.ts)
		if (idx === currentRequestIdx) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += lengthOf(m) }
	// VOX: quanti caratteri può occupare il prompt
	const charsBudget = (contextWindow - reservedOutputTokenSpace) * (providerName === 'voxLocal' ? VOX_LOCAL_CHARS_PER_TOKEN : CHARS_PER_TOKEN) - nativeToolsChars
	const charsNeedToTrim = totalLen - Math.max(
		// VOX: con i modelli locali (contesto piccolo) la stima è più prudente: su codice e italiano llama.cpp
		// conta circa 2,5-3 caratteri per token; se non basta, llama-server lo dice e i messaggi si accorciano di nuovo
		charsBudget, // can be 0, in which case charsNeedToTrim=everything, bad
		// ensure we don't trim at least 5k chars (just a random small value)
		// VOX: con i modelli locali il minimo è più basso, perché con un contesto piccolo 5000 caratteri
		// (più gli strumenti) non entrerebbero già al primo invio
		providerName === 'voxLocal' ? 1_000 : 5_000
	)


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingCharsToTrim = charsNeedToTrim
	let i = 0
	// VOX: l'unica nota sui file aperti che il taglio conserva (vedi sotto)
	let keptNoteIdx: number | undefined // (si cerca solo se c'è da tagliare)

	while (remainingCharsToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		// VOX: i parametri di una chiamata a strumento (per esempio un file intero da scrivere) si accorciano per primi
		// (una cronologia vecchia può avere un messaggio di strumento senza parametri)
		if (m.role === 'tool' && m.rawParams) {
			const before = paramsLengthOf(m)
			m.rawParams = shortenedParams(m.rawParams)
			if (paramsLengthOf(m) < before) shortenedIdxes.add(trimIdx)
			remainingCharsToTrim -= before - paramsLengthOf(m)
			if (remainingCharsToTrim <= 0) break
		}

		// VOX: l'ultima nota sui file aperti in coda a un messaggio dell'utente non si taglia: la conversazione la dà
		// per detta (non viene ripetuta), quindi si accorcia solo il testo che la precede. Le note più vecchie sono
		// superate da quella e si tagliano come il resto.
		keptNoteIdx ??= indexOfEditorStateNoteToKeep(messages)
		const note = trimIdx === keptNoteIdx ? trailingEditorStateNote(m.content) : ''
		const body = note ? m.content.slice(0, m.content.length - note.length).trimEnd() : m.content
		const tail = note ? '\n\n' + note : ''

		// if can finish here, do
		const numCharsWillTrim = body.length - TRIM_TO_LEN
		if (numCharsWillTrim > remainingCharsToTrim) {
			// trim remainingCharsToTrim + '...'.length chars
			const charsToCut = providerName === 'voxLocal' ? stableTrimLength(remainingCharsToTrim, numCharsWillTrim, Math.max(1, Math.min(VOX_LOCAL_TRIM_STEP, Math.ceil(charsBudget / 20)))) : remainingCharsToTrim
			m.content = body.slice(0, body.length - charsToCut - '...'.length).trim() + '...' + tail
			shortenedIdxes.add(trimIdx)
			break
		}

		remainingCharsToTrim -= Math.max(0, numCharsWillTrim)
		if (numCharsWillTrim > 0) {
			m.content = body.substring(0, TRIM_TO_LEN - '...'.length) + '...' + tail
			shortenedIdxes.add(trimIdx)
		}
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	// VOX: indice della domanda attuale ora che il messaggio di sistema è stato tolto (-1 se non è voxLocal)
	const requestIdx = currentRequestIdx > 0 ? currentRequestIdx - 1 : -1

	let llmChatMessages: OpenAILLMChatMessage[] = []
	if (providerName === 'cliAgent') {
		llmChatMessages = messages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content }))
	}
	// XML tool behavior, anche per un formato salvato che non è più riconosciuto (per esempio un vecchio 'anthropic-style')
	else if (specialToolFormat !== 'openai-style') {
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], requestIdx)
	}
	else {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
		// VOX: qui i messaggi dell'utente passano così come sono, quindi la domanda è un messaggio intero
		const request = requestIdx >= 0 ? messages[requestIdx] : undefined
		if (request) markRequest(llmChatMessages.find(m => (m as unknown) === request), request.content.length)
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		// VOX: il sistema va davanti, quindi la domanda resta in fondo e il suo segno vale ancora
		const firstRequestChars = (llmMessages[0] as { voxRequestChars?: number }).voxRequestChars
		const newFirstMessage: OpenAILLMChatMessage = {
			role: 'user',
			content: `${FUSED_SYSTEM_OPEN}${newSysMsg}${FUSED_SYSTEM_CLOSE}${llmMessages[0].content}`,
			...(firstRequestChars !== undefined ? { voxRequestChars: firstRequestChars } : {}),
		}
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (const currMsg of llmMessages) {
		if (currMsg.role === 'tool') continue
		currMsg.content = currMsg.content || EMPTY_MESSAGE
	}

	// ================ measures (pannello di contesto) ================
	// Sul prompt finale, contato come lo conta il processo principale: il messaggio di sistema (accorciato o no) con
	// le istruzioni dell'utente in testa e gli strumenti XML dentro, gli strumenti nativi a parte, la richiesta in
	// fondo (che il taglio non tocca) e il resto, cioè la conversazione con il segno del messaggio di sistema fuso.
	const promptChars = llmMessages.reduce((sum, message) => sum + promptCharsOf(message), 0) + (separateSystemMessageStr?.length ?? 0)
	// Il messaggio di sistema si divide fra regole (in testa), definizioni XML (a `xmlToolsStart` dentro `systemMessage`,
	// che segue le regole e i due a capo) e il resto, contando solo ciò che il taglio ha lasciato.
	const rulesBlockChars = aiInstructions ? `GUIDELINES (from the user's .voxrules file):\n${aiInstructions}`.length : 0
	const { systemChars, rulesChars, xmlChars } = systemPartsOf({
		sentChars: newSysMsg.length,
		fullChars: combinedSystemMessage.trim().length,
		rulesBlockChars,
		xmlToolsAt: xmlToolsStart >= 0 ? (rulesBlockChars > 0 && systemMessage ? rulesBlockChars + '\n\n'.length : 0) + xmlToolsStart : -1,
		xmlToolsChars,
	})
	// la richiesta vuota (casella vuota, niente allegati né nota) è diventata EMPTY_MESSAGE: all'invio non ci sarà
	const emptyRequestChars = requestChars === 0 && llmMessages[llmMessages.length - 1]?.content === EMPTY_MESSAGE ? EMPTY_MESSAGE.length : 0
	// i tag che racchiudono il messaggio di sistema fuso nel primo messaggio (modelli senza messaggio di sistema)
	// sono istruzioni di Vox, non conversazione
	const fusedSystemTagsChars = supportsSystemMessage ? 0 : FUSED_SYSTEM_OPEN.length + FUSED_SYSTEM_CLOSE.length
	// un messaggio di sistema vuoto (integrato disattivato, nessuna regola né contesto di progetto) parte come
	// EMPTY_MESSAGE: anche quello è del sistema
	const emptySystemChars = (supportsSystemMessage === 'system-role' || supportsSystemMessage === 'developer-role') && !newSysMsg ? EMPTY_MESSAGE.length : 0
	const measures: ContextMeasures = {
		contextWindow,
		reservedTokens: reservedOutputTokenSpace,
		systemChars: systemChars + fusedSystemTagsChars + emptySystemChars,
		rulesChars,
		toolsChars: xmlChars + nativeToolsChars,
		conversationChars: Math.max(0, promptChars - newSysMsg.length - fusedSystemTagsChars - emptySystemChars - requestChars - emptyRequestChars),
		requestChars,
		// (in posizione 0 c'era il messaggio di sistema, che non è un messaggio della conversazione)
		trimmedCount: [...shortenedIdxes].filter(idx => idx !== 0).length,
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
		measures,
	} as const
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	// `threadId`: se c'è, il messaggio di sistema si calcola una volta per conversazione e poi resta quello
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, threadId?: string }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	// la nota da accodare al nuovo messaggio dell'utente se i file aperti sono cambiati rispetto a ciò che il modello sa ('' se non serve)
	// `earlierNotes`: le note (`editorStateNote`) dei messaggi dell'utente rimasti nella conversazione, in ordine.
	// Vuota se l'IA scelta non è locale o se il messaggio di sistema integrato è disattivato.
	editorStateNoteForNewUserMessage(threadId: string, earlierNotes: (string | undefined)[], modelSelection: ModelSelection | null): string
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
	// VOX: misure del pannello di contesto. La stessa preparazione dell'invio, con la richiesta che si sta scrivendo
	// (`draft` e i file allegati) in fondo; non tocca il messaggio di sistema fissato per la conversazione.
	// `null` senza modello; `cli` per le IA in CLI, che gestiscono da sé il proprio contesto.
	measureChatContext(opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, threadId: string, draft: string, selections: StagingSelectionItem[] }): Promise<{ kind: 'cli' } | { kind: 'local', measures: ContextMeasures } | null>
	// cambiano le premesse delle misure che la pagina non vede: contesto di progetto (.vox/), strumenti MCP, cartelle del workspace.
	// `contextPremisesVersion()` cresce a ogni cambio, anche quando nessuna vista è aperta ad ascoltare l'evento
	readonly onDidChangeContextPremises: Event<void>
	contextPremisesVersion(): number
	// file aperti (i modelli mostrati in un editor) e file attivo, che il messaggio di sistema e la nota sui file aperti
	// elencano: i file aperti cambiano anche senza che cambi il file attivo (una divisione dell'editor chiusa), e il file
	// attivo cambia anche senza aprire niente (un clic su un altro gruppo di editor)
	readonly onDidChangeEditorSnapshot: Event<void>
	// file aperti e file attivo come li vede il modello (le schede di Vox non contano)
	editorSnapshotKey(): string
}

const directoryCutOffMessage = (chatMode: ChatMode) => chatMode === 'agent' || chatMode === 'gather' ?
	`...Directories string cut off, use tools to read more...`
	: `...Directories string cut off, ask user for more if necessary...`

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		@IVoxModelService private readonly voxModelService: IVoxModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IProjectContextService private readonly projectContextService: IProjectContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super()
		const premisesChanged = () => { this._displayDirectoryStrs.clear(); this._selectionsSuffixes.clear(); this._unreadSelections.clear(); this._contextPremisesVersion++; this._onDidChangeContextPremises.fire() }
		this._register(this.projectContextService.onDidChange(premisesChanged))
		this._register(this.mcpService.onDidChangeState(premisesChanged))
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(premisesChanged))
		// file salvati su disco: le regole (.voxrules) e i file allegati entrano nelle misure con il
		// loro contenuto. (Le modifiche non ancora salvate di .voxrules contano alla prossima misura, come all'invio.)
		this._register(this.fileService.onDidFilesChange(e => {
			const rulesChanged = this.workspaceContextService.getWorkspace().folders
				.some(folder => RULES_FILE_NAMES.some(name => e.contains(URI.joinPath(folder.uri, name))))
			const attachedChanged = [...this._selectionsSuffixes.values()].some(({ uris }) => uris.some(uri => e.affects(uri)))
				|| [...this._unreadSelections.values()].some(uris => uris.some(uri => e.affects(uri)))
				|| [...this._readingSelections.values()].some(uris => uris.some(uri => e.affects(uri)))
			if (rulesChanged || attachedChanged) premisesChanged()
		}))
		// un modello che entra in un editor o ne esce cambia i file aperti; un altro editor in primo piano il file attivo
		this._register(this.editorService.onDidActiveEditorChange(() => this._onDidChangeEditorSnapshot.fire()))
		const attachedListeners = this._register(new DisposableMap<ITextModel>())
		const watchAttached = (model: ITextModel) => attachedListeners.set(model, model.onDidChangeAttached(() => this._onDidChangeEditorSnapshot.fire()))
		for (const model of this.modelService.getModels()) watchAttached(model)
		this._register(this.modelService.onModelAdded(watchAttached))
		this._register(this.modelService.onModelRemoved(model => { attachedListeners.deleteAndDispose(model); this._onDidChangeEditorSnapshot.fire() }))
	}

	// --- pannello di contesto ---

	private readonly _onDidChangeContextPremises = this._register(new Emitter<void>())
	readonly onDidChangeContextPremises = this._onDidChangeContextPremises.event
	private _contextPremisesVersion = 0
	contextPremisesVersion(): number {
		return this._contextPremisesVersion
	}
	private readonly _onDidChangeEditorSnapshot = this._register(new Emitter<void>())
	readonly onDidChangeEditorSnapshot = this._onDidChangeEditorSnapshot.event
	editorSnapshotKey(): string {
		return JSON.stringify(this._editorSnapshot())
	}
	// Il messaggio di sistema per le misure: calcolato a parte, senza toccare il memo dell'invio (e senza registrarsi
	// come ultima richiesta della conversazione: una misura durante un invio impedirebbe di fissarlo). Con le IA
	// locali la conversazione tiene quello della prima richiesta: questo differisce al più per i file aperti.
	// Si conserva solo l'albero delle cartelle, la parte che costa leggere: il messaggio si ricompone a ogni misura con
	// i file aperti di adesso, come lo comporrebbe una conversazione nuova.
	private readonly _displayDirectoryStrs = new Map<string, { directoryStr: string, at: number }>()
	// il testo dei file allegati, come lo scrive l'invio: letto una volta per gruppo di allegati (le cartelle costano),
	// con i file da cui viene, per rileggerlo quando cambiano
	private readonly _selectionsSuffixes = new Map<string, { suffix: string, uris: URI[] }>()
	// allegati che non si sono potuti leggere: la misura li conta vuoti, e quando tornano leggibili su disco si rifà
	private readonly _unreadSelections = new Map<string, URI[]>()
	// allegati che una misura sta leggendo adesso (una voce per lettura, tolta quando finisce)
	private readonly _readingSelections = new Map<object, URI[]>()

	// La chiave delle premesse del messaggio di sistema fissato per una conversazione (vedi
	// _generateChatMessagesSystemMessage): la stessa per l'invio e per le misure, che la usano per ritrovarlo.
	private _systemMessageMemoKey(chatMode: ChatMode, providerName: ProviderName, specialToolFormat: 'openai-style' | undefined, workspaceFolders: string[], mcpTools: ReturnType<IMCPService['getMCPTools']>, persistentTerminalIDs: string[], directoryStrForKey: string | undefined): string {
		return JSON.stringify([chatMode, providerName, specialToolFormat ?? '', workspaceFolders, mcpTools ?? [], persistentTerminalIDs, directoryStrForKey ?? '', new Date().toDateString()])
	}

	private async _systemMessageForDisplay(chatMode: ChatMode, specialToolFormat: 'openai-style' | undefined, providerName: ProviderName, threadId: string): Promise<string> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)
		const mcpTools = this.mcpService.getMCPTools()
		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		// Con le IA locali una conversazione già avviata manda il messaggio fissato alla sua prima richiesta, finché le
		// premesse restano quelle: si legge senza toccarlo. Fuori dalla chat normale l'albero delle cartelle non fa
		// parte delle premesse, quindi si cerca prima di leggerlo; in chat normale sì, e l'albero letto qui può avere
		// fino a un minuto: se non coincide con quello di allora, il messaggio si ricompone come farebbe l'invio.
		const remembered = (directoryStrForKey: string | undefined) => providerName !== 'voxLocal' ? undefined
			: this._systemMessageMemo.peek(threadId, this._systemMessageMemoKey(chatMode, providerName, specialToolFormat, workspaceFolders, mcpTools, persistentTerminalIDs, directoryStrForKey))
		if (chatMode !== 'normal') {
			const fixed = remembered(undefined)
			if (fixed !== undefined) return fixed
		}
		// l'albero dipende solo dalle cartelle e dal messaggio di taglio (cioè dalla modalità)
		const key = JSON.stringify([chatMode, workspaceFolders])
		const cached = this._displayDirectoryStrs.get(key)
		// l'albero può cambiare (in chat normale è l'unica vista sui file; nelle altre modalità l'invio lo rilegge quando
		// la conversazione non ha un messaggio fissato): si rilegge al più ogni minuto
		let directoryStr: string
		if (cached && Date.now() - cached.at < 60_000) directoryStr = cached.directoryStr
		else {
			const version = this._contextPremisesVersion
			directoryStr = await this.directoryStrService.getAllDirectoriesStr({ cutOffMessage: directoryCutOffMessage(chatMode) })
			// premesse cambiate durante la lettura: l'albero vale per questa misura, ma non si tiene (la misura che il
			// cambio fa partire deve rileggerlo)
			if (version === this._contextPremisesVersion) {
				this._displayDirectoryStrs.delete(key)
				this._displayDirectoryStrs.set(key, { directoryStr, at: Date.now() })
				while (this._displayDirectoryStrs.size > 10) this._displayDirectoryStrs.delete(this._displayDirectoryStrs.keys().next().value!)
			}
		}
		if (chatMode === 'normal') {
			const fixed = remembered(directoryStr)
			if (fixed !== undefined) return fixed
		}
		// altrimenti come lo comporrebbe adesso l'invio: i file aperti e quello attivo di adesso
		return this._computeChatMessagesSystemMessage(chatMode, specialToolFormat, providerName, workspaceFolders, mcpTools, this._editorSnapshot(), persistentTerminalIDs, directoryStr)
	}

	private async _selectionsSuffixForDisplay(selections: StagingSelectionItem[]): Promise<string> {
		if (selections.length === 0) return ''
		const key = JSON.stringify(selections)
		const cached = this._selectionsSuffixes.get(key)
		if (cached !== undefined) return cached.suffix
		let suffix = ''
		// lo stesso testo dell'invio, senza le istruzioni: `chat_userMessageContent('', …)` è il solo seguito degli allegati
		// Un errore che la lettura solleva (una cartella che non si riesce a elencare) non resta in memoria: la misura
		// successiva riprova, e gli allegati si tengono d'occhio, così la misura si rifà anche quando cambiano su disco.
		// Un singolo file illeggibile invece non solleva errori (`readFile` di prompts.ts dà `null`): si conta vuoto, come
		// lo manderebbe l'invio, e si rilegge quando cambia su disco, perché i suoi URI restano in `_selectionsSuffixes`.
		const version = this._contextPremisesVersion
		// gli allegati in lettura si tengono d'occhio anche loro: un salvataggio durante la prima lettura fa crescere la
		// versione come per quelli già in memoria
		const reading = {}
		this._readingSelections.set(reading, selections.map(s => s.uri))
		try { suffix = await chat_userMessageContent('', selections, { directoryStrService: this.directoryStrService, fileService: this.fileService }) }
		catch {
			this._unreadSelections.delete(key)
			this._unreadSelections.set(key, selections.map(s => s.uri))
			while (this._unreadSelections.size > 5) this._unreadSelections.delete(this._unreadSelections.keys().next().value!)
			return ''
		}
		finally { this._readingSelections.delete(reading) }
		// un allegato salvato durante la lettura: il testo letto vale per questa misura, ma non si tiene (la misura che
		// il salvataggio fa partire deve rileggerlo)
		if (version !== this._contextPremisesVersion) return suffix
		this._unreadSelections.delete(key)
		this._selectionsSuffixes.set(key, { suffix, uris: selections.map(s => s.uri) })
		while (this._selectionsSuffixes.size > 5) this._selectionsSuffixes.delete(this._selectionsSuffixes.keys().next().value!)
		return suffix
	}

	measureChatContext: IConvertToLLMMessageService['measureChatContext'] = async ({ chatMessages, chatMode, modelSelection, threadId, draft, selections }) => {
		if (modelSelection === null) return null
		const { providerName, modelName } = modelSelection
		if (providerName === 'cliAgent') return { kind: 'cli' }

		const { overridesOfModel } = this.voxSettingsService.state
		const { specialToolFormat, contextWindow, supportsSystemMessage } = getModelCapabilities(providerName, modelName, overridesOfModel)
		const { disableSystemMessage } = this.voxSettingsService.state.globalSettings
		// come prepareLLMChatMessages, con il messaggio di sistema per le misure
		const fullSystemMessage = disableSystemMessage ? '' : await this._systemMessageForDisplay(chatMode, specialToolFormat, providerName, threadId)
		const projectContextBlock = await this.projectContextService.getProjectContextBlock()
		const systemMessage = [fullSystemMessage, projectContextBlock].filter(s => !!s).join('\n\n')
		const modelSelectionOptions = this.voxSettingsService.state.optionsOfModelSelection['Chat'][providerName]?.[modelName]
		const aiInstructions = this._getCombinedAIInstructions()
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const withEditorStateNotes = providerName === 'voxLocal' && !disableSystemMessage
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages, withEditorStateNotes)

		// la prossima richiesta, scritta come la scrive chatThreadService all'invio: testo, allegati e nota sui file
		// aperti. Si mette sempre, anche con la casella vuota: all'invio arriva un messaggio nuovo, e senza questo l'ultimo
		// messaggio dell'utente della cronologia risulterebbe la domanda attuale, che non si accorcia, e una
		// conversazione lunga sembrerebbe piena anche quando all'invio ci starebbe.
		const content = draft + (selections.length > 0 ? await this._selectionsSuffixForDisplay(selections) : '')
		const earlierNotes = chatMessages.flatMap(m => m.role === 'user' ? [m.editorStateNote] : [])
		const note = this.editorStateNoteForNewUserMessage(threadId, earlierNotes, modelSelection)
		const request = (note ? `${content}\n\n${note}` : content).trim()
		llmMessages.push({ role: 'user', content: request })

		const mcpTools = this.mcpService.getMCPTools()
		const nativeTools = specialToolFormat ? availableTools(chatMode, mcpTools) : undefined
		const nativeToolsChars = nativeToolsCharsOf(nativeTools)
		const xmlToolsAlone = !specialToolFormat && !disableSystemMessage ? systemToolsXMLPrompt(chatMode, mcpTools) ?? '' : ''
		// `chat_systemMessage` cambia il primo tab del messaggio in due spazi: se cade nelle definizioni (la descrizione
		// di uno strumento MCP), nel messaggio ci sono così
		const xmlTools = !xmlToolsAlone || fullSystemMessage.includes(xmlToolsAlone) ? xmlToolsAlone : xmlToolsAlone.replace('\t', '  ')
		const xmlToolsChars = xmlTools.length
		// (il messaggio di sistema delle misure comincia con quello integrato, che contiene le definizioni)
		const xmlToolsStart = xmlTools ? fullSystemMessage.indexOf(xmlTools) : -1

		const { measures } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
			nativeToolsChars,
			xmlToolsChars,
			xmlToolsStart,
			requestChars: request.length,
		})
		return { kind: 'local', measures }
	}

	// Read .voxrules files from workspace folders
	private _getVoxRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voxRules = '';
			for (const folder of workspaceFolders) {
				// il primo file di regole che esiste e non e' vuoto
				for (const fileName of RULES_FILE_NAMES) {
					const { model } = this.voxModelService.getModel(URI.joinPath(folder.uri, fileName))
					if (!model) continue
					const rules = model.getValue(EndOfLinePreference.LF)
					if (!rules.trim()) continue
					voxRules += rules + '\n\n';
					break
				}
			}
			return voxRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .voxrules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voxSettingsService.state.globalSettings.aiInstructions;
		const voxRulesFileContent = this._getVoxRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (voxRulesFileContent) ans.push(voxRulesFileContent)
		return ans.join('\n\n')
	}


	// VOX: il messaggio di sistema di ogni conversazione, calcolato una volta sola (vedi promptStability.ts)
	private readonly _systemMessageMemo = createSystemMessageMemo()
	// l'ultima richiesta di messaggio di sistema partita per ogni conversazione: solo lei può fissarlo nel memo
	private readonly _latestSystemMessageRequest = new Map<string, number>()
	private _systemMessageRequestCount = 0

	// VOX: senza i blocchi di codice della chat, che sono editor con un modello in memoria: finivano nell'elenco
	// dei file aperti come «\3», e ogni risposta con del codice cambiava il messaggio di sistema.
	// I file senza nome e quelli remoti restano, come prima.
	private _editorSnapshot(): EditorSnapshot {
		// (in ordine alfabetico: l'ordine dei modelli non è una novità da comunicare)
		const openFiles = this.modelService.getModels()
			.filter(m => m.isAttachedToEditor() && !m.isForSimpleWidget && m.uri.scheme !== Schemas.inMemory)
			.map(m => m.uri.fsPath)
			.sort()
		// Le schede di Vox (Impostazioni, Contesto della chat) non sono file: con una di loro in primo piano il file
		// attivo resta l'ultimo editor di un file, altrimenti aprire i dettagli del contesto cambierebbe il file attivo
		// comunicato al modello (e la misura stessa, con una nota sui file aperti in più).
		const active = this.editorService.activeEditor?.resource
		const activeFile = active?.scheme !== VOX_EDITOR_SCHEME ? active?.fsPath
			: this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).map(({ editor }) => editor.resource).find(resource => resource && resource.scheme !== VOX_EDITOR_SCHEME)?.fsPath
		return { openFiles, activeFile }
	}

	// Il messaggio di sistema resta fermo solo con le IA locali (è llama-server che ne trae vantaggio): le IA in CLI
	// lo ricevono aggiornato a ogni richiesta, come prima, e non hanno bisogno di note. Con il messaggio di sistema
	// integrato disattivato Vox non comunica i file aperti, quindi nemmeno la nota.
	// Limite noto: durante un giro dell'agente (più richieste per un messaggio) il modello locale non viene avvisato
	// se l'utente cambia file; lo saprà dal messaggio successivo, e intanto ha gli strumenti per leggere i file.
	editorStateNoteForNewUserMessage: IConvertToLLMMessageService['editorStateNoteForNewUserMessage'] = (threadId, earlierNotes, modelSelection) => {
		if (modelSelection?.providerName !== 'voxLocal' || this.voxSettingsService.state.globalSettings.disableSystemMessage) return ''
		return this._systemMessageMemo.noteForNewUserMessage(threadId, this._editorSnapshot(), earlierNotes)
	}

	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | undefined, providerName: ProviderName, threadId: string | undefined) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)
		const mcpTools = this.mcpService.getMCPTools()
		// solo con le IA locali: vedi editorStateNoteForNewUserMessage
		if (providerName !== 'voxLocal') threadId = undefined
		const requestId = ++this._systemMessageRequestCount
		if (threadId !== undefined) {
			this._latestSystemMessageRequest.delete(threadId)
			this._latestSystemMessageRequest.set(threadId, requestId)
			// (stessa misura del memo: le conversazioni più vecchie si dimenticano)
			while (this._latestSystemMessageRequest.size > 30) this._latestSystemMessageRequest.delete(this._latestSystemMessageRequest.keys().next().value!)
		}

		const directoryStr = async () => this.directoryStrService.getAllDirectoriesStr({ cutOffMessage: directoryCutOffMessage(chatMode) })

		// VOX: finché le premesse restano le stesse, la conversazione tiene il messaggio di sistema della sua prima
		// richiesta: i file aperti sono quelli di allora, e le novità arrivano al modello nel messaggio dell'utente
		// (editorStateNoteForNewUserMessage). Le premesse sono modalità, IA, cartelle, strumenti e terminali
		// persistenti (il modello deve conoscerne gli ID), le definizioni degli strumenti MCP (non solo i nomi: un
		// server ricaricato può cambiarne descrizione e parametri) e la data di oggi, che sta nel messaggio. L'albero delle cartelle resta quello dell'inizio solo
		// dove il modello ha gli strumenti per guardare da sé; in chat normale è l'unica vista sui file, quindi fa
		// parte delle premesse (lì c'è una sola richiesta per messaggio: rileggerlo non costa attese in più).
		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		const directoryStrForKey = chatMode === 'normal' ? await directoryStr() : undefined
		const memoKey = threadId === undefined ? '' : this._systemMessageMemoKey(chatMode, providerName, specialToolFormat, workspaceFolders, mcpTools, persistentTerminalIDs, directoryStrForKey)
		const remembered = threadId !== undefined ? this._systemMessageMemo.get(threadId, memoKey) : undefined
		if (remembered !== undefined) return remembered

		const editorSnapshot = this._editorSnapshot()
		const systemMessage = await this._computeChatMessagesSystemMessage(chatMode, specialToolFormat, providerName, workspaceFolders, mcpTools, editorSnapshot, persistentTerminalIDs, directoryStrForKey ?? await directoryStr())
		if (threadId !== undefined) {
			// mentre si leggeva l'albero può essere partita un'altra richiesta della stessa conversazione (questa può
			// essere stata interrotta): il memo lo fissa solo l'ultima partita, così non torna a uno stato superato,
			// né con le stesse premesse né con premesse cambiate nel frattempo
			if (this._latestSystemMessageRequest.get(threadId) !== requestId) return this._systemMessageMemo.get(threadId, memoKey) ?? systemMessage
			this._systemMessageMemo.set(threadId, memoKey, systemMessage, editorSnapshot)
		}
		return systemMessage
	}

	private _computeChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | undefined, providerName: ProviderName, workspaceFolders: string[], mcpTools: ReturnType<IMCPService['getMCPTools']>, editorSnapshot: EditorSnapshot, persistentTerminalIDs: string[], directoryStr: string) => {
		const openedURIs = editorSnapshot.openFiles
		const activeURI = editorSnapshot.activeFile

		// La CLI riceve contesto e permessi, senza istruzioni per invocare gli strumenti di Vox.
		if (providerName === 'cliAgent') return [
			'Usa soltanto gli strumenti della tua CLI e restituisci la risposta finale in testo.',
			chatMode === 'agent' ? 'Puoi modificare i file, e soltanto nel workspace, solo se i tuoi permessi lo consentono: se sei in sola lettura non modificare nulla e descrivi le modifiche da fare.' : 'Modalità sola lettura: non modificare file.',
			'Workspace: ' + workspaceFolders.join(', '),
			'File attivo: ' + (activeURI || ''),
			'File aperti: ' + openedURIs.join(', '),
			directoryStr,
		].join('\n\n')

		const includeXMLToolDefinitions = !specialToolFormat

		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions })
		return systemMessage
	}




	// --- LLM Chat messages ---

	// `withEditorStateNotes: false`: i messaggi dell'utente partono senza la nota sui file aperti che Vox vi ha accodato
	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[], withEditorStateNotes: boolean): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: withEditorStateNotes ? m.content : withoutEditorStateNote(m.content, m.editorStateNote),
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voxSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voxSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, threadId }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voxSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voxSettingsService.state.globalSettings;
		// (se è disattivato non si calcola: niente albero delle cartelle letto a vuoto e niente stato dell'editor in memoria)
		const fullSystemMessage = disableSystemMessage ? '' : await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat, providerName, threadId)
		// Il contesto di progetto (.vox/: istruzioni, memoria, conoscenza) vale per ogni IA, CLI comprese,
		// e resta anche quando il messaggio di sistema integrato è disattivato, come le istruzioni dell'utente.
		const projectContextBlock = await this.projectContextService.getProjectContextBlock()
		const systemMessage = [fullSystemMessage, projectContextBlock].filter(s => !!s).join('\n\n');

		const modelSelectionOptions = this.voxSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		// VOX: le note sui file aperti scritte per un'IA locale restano nella conversazione salvata, ma non vanno a
		// un'IA in CLI scelta più tardi né a chi ha disattivato il messaggio di sistema integrato: lì si tolgono
		// (percorsi di file aperti in passato, e uno stato che può contraddire quello attuale)
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages, providerName === 'voxLocal' && !disableSystemMessage)
		// VOX: con il formato nativo le definizioni degli strumenti viaggiano fuori dai messaggi (con il formato XML
		// sono già nel messaggio di sistema): la loro misura si toglie dallo spazio disponibile
		const nativeTools = specialToolFormat && providerName !== 'cliAgent' ? availableTools(chatMode, this.mcpService.getMCPTools()) : undefined
		const nativeToolsChars = nativeToolsCharsOf(nativeTools)

		const { messages, separateSystemMessage } = prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
			nativeToolsChars,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);
