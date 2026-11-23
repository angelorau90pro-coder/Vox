/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// VOX: contesto della chat. Una riga compatta sopra la casella della chat e una pagina con i dettagli nell'area
// centrale (scheda «Contesto della chat», vedi chatContextPane.ts). Le due viste stanno nello stesso bundle
// (sidebar-tsx/index.tsx), quindi condividono i moduli: la bozza e le misure qui sotto sono le stesse per entrambe.

import { t } from '../../../../common/voxI18n.js';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import '../styles.css'
import { useAccessor, useChatThreadsState, useIsDark, useSettingsState } from '../util/services.js';
import { ChatMessage, StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { calibrationOfLast, ContextPartKey, ContextUsage, contextUsageOf, formatTokens, LastEngineCount, lastEngineCountOf, messagesSentNext, percentOfBudget } from '../../../../common/contextUsage.js';
import { getModelCapabilities } from '../../../../common/modelCapabilities.js';
import type { IConvertToLLMMessageService } from '../../../convertToLLMMessageService.js';
import { VOX_OPEN_CHAT_CONTEXT_ACTION_ID } from '../../../actionIDs.js';
import ErrorBoundary from './ErrorBoundary.js';


// ---------------- bozza della chat ----------------

// Il testo che si sta scrivendo, con la conversazione a cui appartiene: la bozza di un'altra conversazione non conta.
// La scrive SidebarChat (con un ritardo, non a ogni tasto); la leggono la riga e la pagina.
type ChatDraft = { threadId: string, text: string }
let chatDraft: ChatDraft = { threadId: '', text: '' }
const chatDraftListeners = new Set<() => void>()
export const setChatDraft = (threadId: string, text: string) => {
	if (chatDraft.threadId === threadId && chatDraft.text === text) return
	chatDraft = { threadId, text }
	chatDraftListeners.forEach(listener => listener())
}
const subscribeChatDraft = (listener: () => void) => {
	chatDraftListeners.add(listener)
	return () => { chatDraftListeners.delete(listener) }
}
const useChatDraft = (threadId: string) => {
	const draft = useSyncExternalStore(subscribeChatDraft, () => chatDraft)
	return draft.threadId === threadId ? draft.text : ''
}


// ---------------- misura ----------------

// `error`: la misura non è riuscita (non resta in memoria: si riprova alla prossima modifica degli ingressi)
type MeasureResult = Awaited<ReturnType<IConvertToLLMMessageService['measureChatContext']>> | { kind: 'error' }
export type ChatContextMeasure = { kind: 'cli' } | { kind: 'error' } | { kind: 'local', usage: ContextUsage, lastCount: LastEngineCount | null }

// Una misura per firma degli ingressi: la riga e la pagina chiedono la stessa cosa e ricevono la stessa promessa,
// quindi un calcolo solo e gli stessi numeri. Le premesse che non si leggono dagli ingressi (regole, MCP, editor)
// entrano nella firma con la loro versione: una misura vecchia resta in memoria al più fino a uscire dalle ultime quattro.
const measureCache = new Map<string, Promise<MeasureResult>>()
const MEASURE_CACHE_SIZE = 4

// Impronta di un messaggio: i campi che la misura legge (convertToLLMMessageService, _chatMessagesToSimpleMessages),
// con lunghezza e FNV-1a, così un messaggio cambiato con la stessa lunghezza cambia la firma. Si calcola una volta
// per oggetto: i messaggi della conversazione non si modificano, si sostituiscono.
const fingerprints = new WeakMap<ChatMessage, string>()
const fingerprintOf = (m: ChatMessage): string => {
	const known = fingerprints.get(m)
	if (known !== undefined) return known
	const text = m.role === 'assistant' ? m.displayContent
		: m.role === 'user' ? `${m.content}\u0000${m.editorStateNote ?? ''}`
			: m.role === 'tool' ? `${m.type}\u0000${m.name}\u0000${m.id}\u0000${m.content}\u0000${JSON.stringify(m.rawParams ?? null)}`
				: ''
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
	const fingerprint = `${m.role[0]}${text.length}:${(hash >>> 0).toString(36)}`
	fingerprints.set(m, fingerprint)
	return fingerprint
}
const measureOnce = (key: string, run: () => Promise<MeasureResult>): Promise<MeasureResult> => {
	const cached = measureCache.get(key)
	if (cached) return cached
	// un errore non resta in memoria: la volta dopo si riprova
	const promise: Promise<MeasureResult> = run().catch(() => { if (measureCache.get(key) === promise) measureCache.delete(key); return { kind: 'error' } as const })
	measureCache.set(key, promise)
	while (measureCache.size > MEASURE_CACHE_SIZE) measureCache.delete(measureCache.keys().next().value!)
	return promise
}

// `enabled: false` quando la vista non mostrerebbe la misura (conversazione nuova, nessun modello): niente calcoli
const useChatContextMeasure = ({ threadId, messages, selections, draft, enabled }: { threadId: string, messages: ChatMessage[], selections: StagingSelectionItem[], draft: string, enabled: boolean }): ChatContextMeasure | null => {
	const accessor = useAccessor()
	const convertService = accessor.get('IConvertToLLMMessageService')
	const settingsState = useSettingsState()
	const modelSelection = settingsState.modelSelectionOfFeature['Chat']
	const chatMode = settingsState.globalSettings.chatMode
	// premesse che la firma non vede (contesto di progetto, MCP, cartelle del workspace, file salvati): la versione
	// viene dal servizio, che la fa crescere anche quando nessuna vista è aperta (la conversazione nuova non ha la
	// riga), così tornando a una conversazione una misura vecchia non risponde a una firma rimasta uguale
	const [premisesVersion, setPremisesVersion] = useState(() => convertService.contextPremisesVersion())
	useEffect(() => {
		setPremisesVersion(convertService.contextPremisesVersion())
		const disposable = convertService.onDidChangeContextPremises(() => setPremisesVersion(convertService.contextPremisesVersion()))
		return () => disposable.dispose()
	}, [convertService])

	// file aperti e file attivo come li vede il modello (messaggio di sistema e nota sui file aperti): una scheda di
	// Vox in primo piano non li cambia, quindi aprire «Contesto della chat» non rifà la misura
	const [editorKey, setEditorKey] = useState(() => convertService.editorSnapshotKey())
	useEffect(() => {
		setEditorKey(convertService.editorSnapshotKey())
		const disposable = convertService.onDidChangeEditorSnapshot(() => setEditorKey(convertService.editorSnapshotKey()))
		return () => disposable.dispose()
	}, [convertService])

	// firma dei messaggi: un'impronta per messaggio (un messaggio può cambiare senza che cambi il numero dei messaggi).
	// I conteggi del motore non servono alla misura: la taratura li legge a parte (`lastCount`).
	const messagesKey = useMemo(() => messages.map(fingerprintOf).join('|'), [messages])
	const selectionsKey = useMemo(() => JSON.stringify(selections), [selections])
	const { globalSettings, overridesOfModel, optionsOfModelSelection } = settingsState
	const settingsKey = JSON.stringify([
		modelSelection, chatMode, globalSettings.aiInstructions, globalSettings.disableSystemMessage,
		modelSelection ? overridesOfModel?.[modelSelection.providerName]?.[modelSelection.modelName] ?? null : null,
		modelSelection ? optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName] ?? null : null,
		// la finestra dei modelli locali viene dal manifesto (non dagli override): cambia quando la libreria la cambia
		modelSelection ? getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel).contextWindow : null,
	])
	const key = JSON.stringify([threadId, messagesKey, selectionsKey, draft, settingsKey, editorKey, premisesVersion])

	const latestRef = useRef({ messages, selections, draft, modelSelection, chatMode })
	latestRef.current = { messages, selections, draft, modelSelection, chatMode }
	// la misura vale per la chat e per le impostazioni con cui è fatta: cambiando modello (o finestra, istruzioni) quella
	// vecchia non si mostra mentre si aspetta la nuova; la bozza invece cambia a ogni tasto e la misura resta
	const [measured, setMeasured] = useState<{ threadId: string, settingsKey: string, result: MeasureResult } | null>(null)
	const versionRef = useRef(0)
	useEffect(() => {
		const version = ++versionRef.current
		if (!enabled) return
		// una misura già fatta (per esempio dalla riga della chat, quando si apre la scheda) arriva subito
		const timer = setTimeout(() => {
			const { messages, selections, draft, modelSelection, chatMode } = latestRef.current
			measureOnce(key, () => convertService.measureChatContext({ chatMessages: messages, chatMode, modelSelection, threadId, draft, selections }))
				.then(result => { if (versionRef.current === version) setMeasured({ threadId, settingsKey, result }) })
		}, measureCache.has(key) ? 0 : 400)
		return () => clearTimeout(timer)
	}, [convertService, threadId, key, enabled])

	const lastCount = useMemo(() => lastEngineCountOf(messages), [messages])
	const result = measured?.threadId === threadId && measured.settingsKey === settingsKey ? measured.result : null
	if (!result) return null
	if (result.kind === 'cli' || result.kind === 'error') return { kind: result.kind }
	return { kind: 'local', usage: contextUsageOf(result.measures, calibrationOfLast(lastCount, modelSelection?.modelName)), lastCount }
}


// ---------------- pezzi comuni ----------------

const CONTEXT_PART_LABEL: { [key in ContextPartKey]: () => string } = {
	system: () => t("Vox instructions and project context"),
	rules: () => t("Your instructions (.voxrules)"),
	tools: () => t("Tool definitions"),
	conversation: () => t("Conversation"),
	request: () => t("Next request (text, attachments, open files)"),
}

const hasConversationIn = (messages: ChatMessage[]) => messages.some(m => m.role === 'user' || m.role === 'assistant')

// (una finestra nota che la riserva per la risposta occupa tutta non ha spazio da mostrare in percentuale)
const hasBudget = (usage: ContextUsage) => usage.promptBudgetTokens > 0

const summaryOf = (usage: ContextUsage) => usage.level === 'sconosciuto' ? t("context window unknown")
	: !hasBudget(usage) ? t("the model's window leaves no room for the request")
		: t("≈ {0} of {1} for the request", formatTokens(usage.usedTokens), formatTokens(usage.promptBudgetTokens))

const contextNoticesOf = (usage: ContextUsage, lastCount: LastEngineCount | null): string[] => [
	usage.trimmedCount === 1 ? t("To make the next request fit, Vox shortens 1 older message.")
		: usage.trimmedCount > 1 ? t("To make the next request fit, Vox shortens {0} older messages.", usage.trimmedCount)
			: usage.level === 'pieno' ? t("The context is full: Vox will shorten the oldest messages.")
				: usage.level === 'avviso' ? t("The context is filling up: soon Vox will shorten the oldest messages.")
					: null,
	lastCount?.shortened ? t("At the last answer the local model refused the prompt: Vox shortened the conversation again.") : null,
].filter((notice): notice is string => notice !== null)

const calibrationNoteOf = (usage: ContextUsage) => usage.calibrated ? t("Estimate based on the count of the last answer.") : t("Estimate at 3 characters per token: the count arrives with the next answer.")

// barra sullo spazio per il prompt, letta dai lettori di schermo come misuratore
const ContextMeter = ({ usage, className }: { usage: ContextUsage, className: string }) => {
	const percent = percentOfBudget(usage.usedTokens, usage.promptBudgetTokens)
	return <div
		role='meter'
		aria-label={t("Context used by the next request")}
		aria-valuemin={0}
		aria-valuemax={usage.promptBudgetTokens}
		aria-valuenow={Math.min(usage.usedTokens, usage.promptBudgetTokens)}
		aria-valuetext={t("About {0} tokens of {1} available for the request ({2}%)", formatTokens(usage.usedTokens), formatTokens(usage.promptBudgetTokens), percent)}
		className={`w-full rounded-full bg-vox-hairline overflow-hidden ${className}`}
	>
		{/* i colori stanno dentro className: la build mette il prefisso `vox-` solo alle classi scritte qui */}
		<div className={`h-full rounded-full transition-[width] duration-300 ${usage.level === 'pieno' ? 'bg-vox-danger' : usage.level === 'avviso' ? 'bg-vox-warning' : 'bg-vox-accent'}`} style={{ width: `${percent}%` }} />
	</div>
}


// ---------------- riga nella chat ----------------

export const ContextUsageLine = ({ threadId, messages: allMessages, selections }: { threadId: string, messages: ChatMessage[], selections: StagingSelectionItem[] }) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const draft = useChatDraft(threadId)
	// dopo un ritorno a un checkpoint, solo i messaggi che l'invio non cancella
	const checkpointIdx = useChatThreadsState().allThreads[threadId]?.state.currCheckpointIdx
	const messages = useMemo(() => messagesSentNext(allMessages, checkpointIdx), [allMessages, checkpointIdx])
	const hasConversation = hasConversationIn(messages)
	const measure = useChatContextMeasure({ threadId, messages, selections, draft, enabled: hasConversation })
	// una misura non riuscita: nella chat niente riga (i dettagli lo dicono)
	if (!hasConversation || !measure || measure.kind === 'error') return null

	if (measure.kind === 'cli') return <div className='mx-2 mb-1.5 px-2.5 text-[11px] text-vox-fg-4 select-none' data-vox-context-usage='cli'>
		{t("Context: managed by the CLI AI")}
	</div>

	const { usage, lastCount } = measure
	const summary = summaryOf(usage)
	const notices = contextNoticesOf(usage, lastCount)
	return <div className='mx-2 mb-1.5 px-2.5 py-2 text-xs @@vox-card shadow-vox-sm select-none' data-vox-context-usage={usage.level}>
		<button
			type='button'
			onClick={() => { commandService.executeCommand(VOX_OPEN_CHAT_CONTEXT_ACTION_ID) }}
			aria-label={t("Context: {0}. Open the details in the editor area", summary)}
			title={t("Open the details in the editor area")}
			className='flex items-center gap-1.5 w-full text-left text-vox-fg-2 bg-transparent border-0 p-0 cursor-pointer'
		>
			<Gauge size={13} className='flex-shrink-0 text-vox-accent-text' aria-hidden='true' />
			<span className='flex-shrink-0 font-medium'>{t("Context")}</span>
			<span className='truncate text-vox-fg-3 tabular-nums'>{summary}</span>
			<ChevronRight size={13} aria-hidden='true' className='ml-auto flex-shrink-0 text-vox-fg-4' />
		</button>
		{hasBudget(usage) ? <ContextMeter usage={usage} className='mt-1.5 h-1' /> : null}
		{/* nella chat un avviso solo, su una riga: tutti gli avvisi sono nella pagina dei dettagli */}
		{notices.length > 0 ? <div role='status' className='mt-1.5 truncate text-vox-warning' title={notices.join('\n')}>{notices[0]}</div> : null}
	</div>
}


// ---------------- pagina nell'area centrale ----------------

const NO_MESSAGES: ChatMessage[] = []
const NO_SELECTIONS: StagingSelectionItem[] = []

const ChatContextPageBody = () => {
	const chatThreadsState = useChatThreadsState()
	const settingsState = useSettingsState()
	const threadId = chatThreadsState.currentThreadId
	const thread = chatThreadsState.allThreads[threadId]
	// dopo un ritorno a un checkpoint, solo i messaggi che l'invio non cancella (come nella riga della chat)
	const allMessages = thread?.messages ?? NO_MESSAGES
	const checkpointIdx = thread?.state.currCheckpointIdx
	const messages = useMemo(() => messagesSentNext(allMessages, checkpointIdx), [allMessages, checkpointIdx])
	const selections = thread?.state.stagingSelections ?? NO_SELECTIONS
	const draft = useChatDraft(threadId)
	const hasConversation = hasConversationIn(messages)
	const firstQuestion = messages.find(m => m.role === 'user')?.displayContent.trim() ?? ''
	const hasModel = !!settingsState.modelSelectionOfFeature['Chat']
	const measure = useChatContextMeasure({ threadId, messages, selections, draft, enabled: hasModel && hasConversation })

	const header = <header className='flex items-start gap-3 mb-6'>
		<span aria-hidden='true' className='size-9 flex-shrink-0 rounded-vox-md bg-vox-accent text-vox-accent-fg flex items-center justify-center shadow-vox-sm'>
			<Gauge size={18} />
		</span>
		<div className='min-w-0'>
			<h1 className='text-[18px] font-semibold text-vox-fg-1 leading-tight'>{t("Chat context")}</h1>
			<p className='mt-0.5 text-[12.5px] text-vox-fg-3 truncate' title={firstQuestion}>
				{hasConversation ? t("Conversation: {0}", firstQuestion.length > 90 ? firstQuestion.slice(0, 90) + '…' : firstQuestion || t("(no text)")) : t("New conversation")}
			</p>
		</div>
	</header>

	const card = (children: React.ReactNode) => <div className='@@vox-card shadow-vox-sm px-5 py-4 text-[13px] text-vox-fg-2 leading-relaxed'>{children}</div>

	let body: React.ReactNode
	if (!hasModel) body = card(t("Choose a model in the chat: here you will see how much of its context window the next request takes."))
	else if (!hasConversation) body = card(t("Write a message in the chat: here you will see how much of the model's context window the next request takes."))
	else if (!measure) body = card(<span className='text-vox-fg-3'>{t("Measuring…")}</span>)
	else if (measure.kind === 'error') body = <div role='status' data-vox-context-page='error'>{card(t("Vox could not measure the context: it will try again at the next change to the conversation, the attachments or the project rules."))}</div>
	else if (measure.kind === 'cli') body = <div data-vox-context-page='cli'>{card(t("CLI AIs manage their own context: Vox does not know how much of it they use and does not shorten the conversation for them."))}</div>
	else {
		const { usage, lastCount } = measure
		const known = hasBudget(usage)
		const percent = percentOfBudget(usage.usedTokens, usage.promptBudgetTokens)
		const notices = contextNoticesOf(usage, lastCount)
		body = <div className='flex flex-col gap-4' data-vox-context-page={usage.level}>
			<section className='@@vox-card shadow-vox-sm px-5 py-4'>
				<div className='flex items-baseline gap-3 flex-wrap'>
					<span className='text-[20px] font-semibold text-vox-fg-1 tabular-nums'>{summaryOf(usage)}</span>
					{known ? <span className='ml-auto text-[13px] text-vox-fg-3 tabular-nums'>{percent}%</span> : null}
				</div>
				{known ? <ContextMeter usage={usage} className='mt-3 h-2' /> : null}
				{notices.length > 0 ? <div role='status' className='mt-3 flex flex-col gap-1 text-[12.5px] text-vox-warning'>
					{notices.map((notice, i) => <span key={i}>{notice}</span>)}
				</div> : null}
			</section>

			<section className='@@vox-card shadow-vox-sm px-5 py-4'>
				<h2 className='text-[13px] font-semibold text-vox-fg-1 mb-3'>{t("What the next request contains")}</h2>
				<div className='flex flex-col gap-2.5'>
					{usage.parts.map(part => {
						const share = percentOfBudget(part.tokens, usage.promptBudgetTokens)
						return <div key={part.key} className='flex flex-col gap-1'>
							<div className='flex items-baseline gap-2 text-[12.5px]'>
								<span className='truncate text-vox-fg-2'>{CONTEXT_PART_LABEL[part.key]()}</span>
								<span className='ml-auto flex-shrink-0 tabular-nums text-vox-fg-3'>≈ {formatTokens(part.tokens)}</span>
								{known ? <span className='w-12 flex-shrink-0 text-right tabular-nums text-vox-fg-4'>{share === 0 ? '<1%' : `${share}%`}</span> : null}
							</div>
							{known ? <div aria-hidden='true' className='h-1 w-full rounded-full bg-vox-hairline overflow-hidden'>
								<div className='h-full rounded-full bg-vox-accent' style={{ width: `${Math.max(share, 1)}%` }} />
							</div> : null}
						</div>
					})}
				</div>
			</section>

			<section className='@@vox-card shadow-vox-sm px-5 py-4 flex flex-col gap-1.5 text-[12.5px] text-vox-fg-3'>
				{usage.contextWindow > 0 ? <span>{t("Model context window: {0} tokens, of which Vox keeps {1} free for the answer.", formatTokens(usage.contextWindow), formatTokens(usage.reservedTokens))}</span> : null}
				{/* dopo un cambio di modello l'ultimo conteggio è di quello di prima: si dice di chi è, perché non tara la stima */}
				<span>{!lastCount ? t("No count from the local model yet.")
					: lastCount.model !== null && lastCount.model !== settingsState.modelSelectionOfFeature['Chat']?.modelName ? t("Last request: {0} tokens counted by {1}, the model used before.", lastCount.promptTokens.toLocaleString(), lastCount.model)
						: t("Last request: {0} tokens counted by the local model.", lastCount.promptTokens.toLocaleString())}</span>
				<span>{calibrationNoteOf(usage)}</span>
				{/* come prepareMessages: prima i parametri delle chiamate a strumento, poi i messaggi più lunghi, con più peso alle
				risposte e ai messaggi meno recenti; si tiene l'inizio del testo; la domanda attuale non si accorcia */}
				<span className='text-vox-fg-4'>{t("When the request does not fit, Vox shortens the longest messages first, especially the AI's answers and the less recent ones: the model then sees only their beginning. Your current question is never shortened.")}</span>
			</section>
		</div>
	}

	return <div className='max-w-[760px] mx-auto px-6 py-8'>
		{header}
		{body}
	</div>
}

export const ChatContextPage = () => {
	const isDark = useIsDark()
	return <div className={`@@vox-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
		<div className='min-h-full w-full text-vox-fg-1'>
			<ErrorBoundary>
				<ChatContextPageBody />
			</ErrorBoundary>
		</div>
	</div>
}
