/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../common/voxI18n.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { dirname, extUriBiasedIgnorePathCase, normalizePath } from '../../../../base/common/resources.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { getErrorMessage, LLMTokenStats, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voxSettingsTypes.js';
import { IVoxSettingsService } from '../common/voxSettingsService.js';
import { approvalTypeOfBuiltinToolName, builtinToolsThatAlwaysAsk, BuiltinToolCallParams, BuiltinToolName, ToolCallParams, ToolName, ToolResult, urisOfBuiltinToolParams } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoxModelService } from '../common/voxModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoxFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { splitCliAgentModel } from '../common/voxSettingsTypes.js';
import { PROJECT_DIR_NAME } from '../common/projectContext.js';
import { createDelayedWriter, createThrottledNotifier } from '../common/helpers/coalesce.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500
// VOX: durante lo streaming l'interfaccia viene avvisata al più 20 volte al secondo
const STREAM_NOTIFY_INTERVAL_MS = 50
// VOX: le conversazioni si scrivono su disco al più una volta al secondo
const THREADS_STORE_DELAY_MS = 1000


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	// Progetto a cui appartiene la chat: URI (stringa) della prima cartella del workspace quando è stata creata.
	// undefined = chat generale (nessuna cartella aperta, oppure chat creata prima dei progetti).
	workspaceFolder?: string;

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
			statusSoFar?: string; // stato provvisorio (non salvato), per esempio "Avvio del modello locale…"
			tokenStatsSoFar?: LLMTokenStats; // token generati e velocità della risposta in corso (IA locali)
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

// Chiave del progetto corrente: la prima cartella del workspace (undefined se non c'è una cartella aperta).
export const projectKeyOfWorkspace = (workspaceContextService: IWorkspaceContextService): string | undefined => {
	return workspaceContextService.getWorkspace().folders[0]?.uri.toString()
}

const newThreadObject = (workspaceFolder: string | undefined) => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		workspaceFolder,
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('voxChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	// chat in cui l'utente ha consentito alle IA in CLI di modificare i file della cartella indicata.
	// Non si salva: al riavvio si richiede. La chiave lega il permesso a chat, IA e cartella.
	private readonly _cliWriteAllowed = new Set<string>()

	// Le IA in CLI modificano i file da sole, fuori dalle richieste di approvazione di Vox: prima di lasciarle
	// scrivere si chiede all'utente, una volta per chat. Ritorna la cartella autorizzata (da passare tale e quale
	// alla CLI, così il permesso vale solo per quella) oppure undefined = sola lettura.
	// isStillValid dice se l'esecuzione che ha chiesto è ancora in corso: un consenso arrivato dopo l'interruzione non vale.
	private async _askCliWritePermission(threadId: string, modelSelection: ModelSelection | null, chatMode: string | null, isStillValid: () => boolean): Promise<string | undefined> {
		if (chatMode !== 'agent' || modelSelection?.providerName !== 'cliAgent') return undefined
		const folder = this._workspaceContextService.getWorkspace().folders.find(f => f.uri.scheme === 'file')
		if (!folder) return undefined // senza cartella la CLI non scrive comunque
		const folderPath = folder.uri.fsPath
		const { agent } = splitCliAgentModel(modelSelection.modelName)
		const key = [threadId, agent, folder.uri.toString()].join(' | ')
		if (this._cliWriteAllowed.has(key)) return folderPath
		// due richieste uguali in attesa condividono la stessa finestra
		let pending = this._cliWritePending.get(key)
		if (!pending) {
			pending = this._dialogService.confirm({
				type: Severity.Warning,
				message: t("Allow {0} to modify files in this project?", agent),
				detail: t("Folder: {0}\n\nCLI AIs edit files on their own: Vox cannot show each change for approval before it is made. If you choose read-only, the AI can read the project but cannot change it.", folderPath),
				primaryButton: t("Allow for this chat"),
				cancelButton: t("Read-only"),
			}).then(res => res.confirmed, () => false).finally(() => { this._cliWritePending.delete(key) })
			this._cliWritePending.set(key, pending)
		}
		const confirmed = await pending
		if (!confirmed || !isStillValid()) return undefined
		this._cliWriteAllowed.add(key)
		return folderPath
	}
	private readonly _cliWritePending = new Map<string, Promise<boolean>>()
	private readonly _agentRunSeq = new Map<string, number>() // numero dell'ultima esecuzione dell'agente per chat

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoxModelService private readonly _voxModelService: IVoxModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoxSettingsService private readonly _settingsService: IVoxSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super()
		this._register(this._storageService.onWillSaveState(() => this._threadsWriter.flush()))
		this._register({ dispose: () => { this._threadsWriter.flush(); this._streamStateNotifier.dispose() } })
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}

		// always be in a thread
		this.openNewThread()


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	// VOX: serializzare tutte le conversazioni (con le copie dei file dei checkpoint) a ogni messaggio e a ogni
	// passo di uno strumento blocca la finestra: si scrive l'ultimo stato al più una volta ogni THREADS_STORE_DELAY_MS.
	// Ciò che è in attesa viene scritto prima che l'archivio salvi (chiusura compresa) e alla distruzione del servizio.
	private readonly _threadsWriter = createDelayedWriter<ChatThreads>(threads => {
		try {
			this._storageService.store(
				THREAD_STORAGE_KEY,
				JSON.stringify(threads),
				StorageScope.APPLICATION,
				StorageTarget.USER
			);
		}
		catch (e) {
			// la scrittura parte da un timer: senza questo un errore sparirebbe senza traccia
			console.error('Vox: salvataggio delle conversazioni non riuscito', e)
		}
	}, THREADS_STORE_DELAY_MS)

	private _storeAllThreads(threads: ChatThreads) {
		this._threadsWriter.schedule(threads)
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Vox)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Vox), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private readonly _streamStateNotifier = createThrottledNotifier<string>(threadId => this._onDidChangeStreamState.fire({ threadId }), STREAM_NOTIFY_INTERVAL_MS)

	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		// avviso immediato: annulla quello in attesa dello streaming, che porterebbe lo stesso stato
		this._streamStateNotifier.now(threadId)
	}

	// VOX: per i pezzi dello streaming. Lo stato è aggiornato subito (chi interrompe o salva legge sempre l'ultimo testo),
	// ma l'avviso all'interfaccia parte al più una volta ogni STREAM_NOTIFY_INTERVAL_MS invece che a ogni token.
	private _setStreamStateWhileStreaming(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._streamStateNotifier.later(threadId)
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (a model can break if its thinking mode changes while it is using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar, tokenStatsSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, ...(tokenStatsSoFar ? { tokenStats: tokenStatsSoFar } : {}) })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: t("Tool call was rejected by the user."),
		interrupted: t("Tool call was interrupted by the user."),
		errWhenStringifying: (error: any) => t("Tool call succeeded, but there was an error converting the output to text.\n{0}", getErrorMessage(error))
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	// Vero se il percorso è fuori dalle cartelle del progetto, oppure ci sta dentro solo di nome perché passa da un
	// collegamento simbolico o una giunzione (che può puntare fuori). Nel dubbio si chiede conferma.
	private async _isOutsideWorkspace(uri0: URI): Promise<boolean> {
		const uri = normalizePath(uri0) // un percorso con ".." non deve sembrare dentro il progetto
		const folder = this._workspaceContextService.getWorkspaceFolder(uri)
		if (!folder) return true
		let current = uri
		for (let depth = 0; depth < 128; depth++) {
			if (extUriBiasedIgnorePathCase.isEqual(current, folder.uri)) return false
			try {
				if ((await this._fileService.stat(current)).isSymbolicLink) return true
			} catch (e) {
				// il percorso non esiste ancora (file da creare): si controlla la cartella che lo contiene. Un altro errore
				// (permessi, un collegamento verso un disco che non risponde) lascia il percorso non verificato: si chiede
				if (!(e instanceof Error && toFileOperationResult(e) === FileOperationResult.FILE_NOT_FOUND)) return true
			}
			const parent = dirname(current)
			if (extUriBiasedIgnorePathCase.isEqual(parent, current)) break
			current = parent
		}
		return true // cartella del progetto non raggiunta risalendo: nel dubbio si chiede
	}

	// La cartella .vox (istruzioni, memoria, conoscenza) entra in ogni chat futura: ogni strumento che la modifica chiede sempre
	// conferma, anche con l'approvazione automatica attiva, così una modifica non passa inosservata.
	private _isInProjectDir(uri0: URI): boolean {
		const uri = normalizePath(uri0)
		const folder = this._workspaceContextService.getWorkspaceFolder(uri)
		if (!folder) return false
		const projectDir = URI.joinPath(folder.uri, PROJECT_DIR_NAME)
		// dentro .vox, oppure una cartella che contiene .vox (per esempio cancellare l'intero progetto)
		return extUriBiasedIgnorePathCase.isEqualOrParent(uri, projectDir) || extUriBiasedIgnorePathCase.isEqualOrParent(projectDir, uri)
	}

	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		// isStillValid: l'esecuzione dell'agente che chiede lo strumento è ancora quella in corso sulla chat (vedi _runChatAgent)
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj, isStillValid: () => boolean },
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean, superseded?: boolean }> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)


		if (!opts.preapproved) { // skip this if pre-approved
			// VOX: prima della richiesta di conferma ci sono delle attese (convalida, apertura per il checkpoint, controllo dei
			// percorsi). Se nel frattempo si è premuto «Ferma» (abortRunning azzera lo stato) o è partita un'altra esecuzione,
			// questa si ferma senza checkpoint né richiesta, e senza toccare lo stato, che ora non è più suo
			const { isStillValid } = opts
			const stillOurs = () => !!this.streamState[threadId]?.isRunning && isStillValid()
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = await this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				if (!stillOurs()) return { superseded: true }
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
			if (!stillOurs()) return { superseded: true } // fermata durante la convalida: non si controllano i percorsi

			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			// un percorso fuori dalle cartelle del progetto chiede sempre conferma, anche in lettura e anche con l'approvazione automatica attiva
			const touchesOutsideWorkspace = isBuiltInTool && (await Promise.all(
				urisOfBuiltinToolParams(toolParams as BuiltinToolCallParams[BuiltinToolName]).map(uri => this._isOutsideWorkspace(uri))
			)).some(isOutside => isOutside)
			// vale per gli strumenti che modificano file; il terminale e gli strumenti MCP hanno una loro approvazione e non dichiarano i file che toccano
			const touchesProjectDir = isBuiltInTool && approvalType === 'edits' && urisOfBuiltinToolParams(toolParams as BuiltinToolCallParams[BuiltinToolName]).some(uri => this._isInProjectDir(uri))
			if (!stillOurs()) return { superseded: true }

			// once validated, add checkpoint for edit
			// VOX: un file del progetto non ancora aperto in Vox si apre qui, così il checkpoint ha il suo contenuto di prima e
			// «Torna al checkpoint» lo ripristina. Lo decide il controllo dei percorsi qui sopra, l'ultimo prima dell'apertura: un
			// percorso fuori dal progetto, che passa da un collegamento o che non si è potuto controllare non si apre prima della
			// conferma dell'utente (sarebbe una lettura dal disco, o una connessione a un percorso di rete, senza il suo consenso),
			// e il checkpoint usa solo il modello già aperto, se è il file. Dopo l'apertura nessun'altra attesa fino alla richiesta
			if (toolName === 'edit_file' || toolName === 'rewrite_file') {
				const editedUri = (toolParams as BuiltinToolCallParams['edit_file' | 'rewrite_file']).uri
				if (!touchesOutsideWorkspace) {
					// solo un file vero: un nome riservato di Windows («con», «nul») o una FIFO non si apre prima della conferma
					// (aprirli può bloccare); un file che manca o che il disco non lascia controllare nemmeno: niente checkpoint
					const isRegularFile = await this._fileService.stat(editedUri).then(s => s.isFile && !s.isSymbolicLink, () => false)
					if (!stillOurs()) return { superseded: true }
					if (isRegularFile) {
						await this._voxModelService.initializeModel(editedUri)
						if (!stillOurs()) return { superseded: true } // per esempio «Ferma» mentre un disco lento apre il file
					}
				}
				this._addToolEditCheckpoint({ threadId, uri: editedUri })
			}

			if (approvalType || touchesOutsideWorkspace) {
				const autoApprove = !touchesOutsideWorkspace && !touchesProjectDir && !builtinToolsThatAlwaysAsk.has(toolName) && !!approvalType && this._settingsService.state.globalSettings.autoApprove[approvalType]
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as any)
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 5. add to history and keep going
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		return {}
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })

			}
		}
		// IA in CLI in modalità Agente: possono scrivere solo se l'utente lo consente (una domanda per chat).
		// Si chiede dopo l'eventuale strumento già approvato e subito prima del primo invio; durante la domanda
		// la chat risulta già in corso e si può interrompere.
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
		// ogni esecuzione ha un numero: se nel frattempo ne parte un'altra sulla stessa chat, questa è superata
		const runId = (this._agentRunSeq.get(threadId) ?? 0) + 1
		this._agentRunSeq.set(threadId, runId)
		const isStillValid = () => !interruptedWhenIdle && this._agentRunSeq.get(threadId) === runId
		const cliWriteFolder = await this._askCliWritePermission(threadId, modelSelection, chatMode, isStillValid)
		// interrotta o superata: si esce senza toccare lo stato, che ora appartiene a chi ha interrotto o alla nuova esecuzione
		if (!isStillValid()) return
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			const { messages, separateSystemMessage } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				threadId,
			})

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, tokenStats?: LLMTokenStats } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; noRetry?: boolean } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					separateSystemMessage: separateSystemMessage,
					// la cartella autorizzata viaggia insieme al permesso: la CLI scrive solo lì
					...(cliWriteFolder !== undefined ? { cliAllowWrite: true, workspaceFolder: cliWriteFolder } : {}),
					onText: ({ fullText, fullReasoning, toolCall, statusText, tokenStats }) => {
						this._setStreamStateWhileStreaming(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null, statusSoFar: statusText, tokenStatsSoFar: tokenStats }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, tokenStats }) => {
						resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, tokenStats } }) // resolve with tool calls
					},
					onError: async (error) => {
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: t("There was an unexpected error when sending your chat message."), fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					// error, should retry (salvo gli errori che un nuovo tentativo non risolve)
					if (nAttempts < CHAT_RETRIES && !llmRes.error?.noRetry) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar, tokenStatsSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, ...(tokenStatsSoFar ? { tokenStats: tokenStatsSoFar } : {}) })
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						this._setStreamState(threadId, { isRunning: undefined, error })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				const { toolCall, info } = llmRes

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, ...(info.tokenStats ? { tokenStats: info.tokenStats } : {}) })

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool if there is one
				if (toolCall) {
					const mcpTools = this._mcpService.getMCPTools()
					const mcpTool = mcpTools?.find(t => t.name === toolCall.name)

					const { awaitingUserApproval, interrupted, superseded } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams, isStillValid })
					// fermata o superata prima della richiesta di conferma: lo stato è di chi l'ha fermata o della nuova esecuzione
					if (superseded) return
					if (interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
					if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
					else { shouldSendAnotherMessage = true }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

		// capture number of messages sent
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voxFileSnapshot = checkpointMessage.voxFileSnapshotOfURI ? checkpointMessage.voxFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voxFileSnapshot, } }

		const userModifiedMap = checkpointMessage.userModifications?.voxFileSnapshotOfURI
		const userModifiedVoxFileSnapshot = userModifiedMap && fsPath in userModifiedMap ? userModifiedMap[fsPath] ?? null : null
		return { voxFileSnapshot: userModifiedVoxFileSnapshot ?? voxFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voxFileSnapshotOfURI: { [fsPath: string]: VoxFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voxModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voxFileSnapshot: oldVoxFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voxFileSnapshot = this._editCodeService.getVoxFileSnapshot(URI.file(fsPath))
			if (oldVoxFileSnapshot === voxFileSnapshot) continue
			voxFileSnapshotOfURI[fsPath] = voxFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voxModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voxFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voxFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voxFileSnapshotOfURI: voxFileSnapshotOfURI ?? {},
			userModifications: { voxFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._voxModelService.getModel(uri)
		if (!model) return // file da creare, che non si apre, o fuori dal progetto e non aperto in Vox: nessun checkpoint
		// VOX: solo il file vero. Un modello di git o di un notebook con lo stesso percorso ha un altro contenuto, che il
		// ritorno al checkpoint riscriverebbe sul file: meglio nessun checkpoint, come per un file non aperto
		if (!extUriBiasedIgnorePathCase.isEqual(model.uri, uri)) return
		const diffAreasSnapshot = this._editCodeService.getVoxFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voxFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voxFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voxFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voxFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voxFileSnapshotOfURI: voxFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voxFileSnapshot } = res
					if (!voxFileSnapshot) continue
					this._editCodeService.restoreVoxFileSnapshot(URI.file(fsPath), voxFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voxFileSnapshot } = res
					if (!voxFileSnapshot) continue
					this._editCodeService.restoreVoxFileSnapshot(URI.file(fsPath), voxFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? t("Error: {0}", error) : t("A new Chat result is ready."),
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'vox.goToChat',
						enabled: true,
						label: t("Jump to Chat"),
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		// VOX: se i file aperti sono cambiati da quando il modello li ha visti, glielo dice questo messaggio
		// (il messaggio di sistema della conversazione non cambia più: vedi promptStability.ts)
		// (lo stato già detto si ricava dai messaggi rimasti: dopo una modifica o un ritorno a un checkpoint
		// il messaggio che portava la nota può non esserci più)
		const earlierNotes = (this.state.allThreads[threadId]?.messages ?? []).flatMap(m => m.role === 'user' ? [m.editorStateNote] : [])
		const editorStateNote = this._convertToLLMMessagesService.editorStateNoteForNewUserMessage(threadId, earlierNotes, this._currentModelSelectionProps().modelSelection)
		const contentForLLM = editorStateNote ? `${userMessageContent}\n\n${editorStateNote}` : userMessageContent
		const userHistoryElt: ChatMessage = { role: 'user', content: contentForLLM, displayContent: instructions, ...(editorStateNote ? { editorStateNote } : {}), selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voxModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		const projectKey = projectKeyOfWorkspace(this._workspaceContextService)
		for (const threadId in currentThreads) {
			const thread = currentThreads[threadId]!
			// una chat vuota si riusa solo se è dello stesso progetto: quella di un altro progetto può essere aperta in un'altra finestra
			if (thread.messages.length === 0 && thread.workspaceFolder === projectKey) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject(projectKey)

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
