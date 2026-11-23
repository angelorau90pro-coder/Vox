/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import { language } from '../../../../../../../base/common/platform.js';
import { useMemo, useState } from 'react';
import { CopyButton, IconShell1 } from '../markdown/ApplyBlockHoverButtons.js';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useFullChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { IconX } from './SidebarChat.js';
import { Check, Copy, Icon, LoaderCircle, MessageCircleQuestion, MessageSquare, Trash2, UserCheck, X } from 'lucide-react';
import { IsRunningType, ThreadType, projectKeyOfWorkspace } from '../../../chatThreadService.js';


const numInitialThreads = 3

export const PastThreadsList = ({ className = '' }: { className?: string }) => {
	const [showAll, setShowAll] = useState(false);

	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

	// Progetto corrente: con una cartella aperta si vedono le sue chat, e su richiesta tutte le altre.
	const accessor = useAccessor()
	const projectKey = projectKeyOfWorkspace(accessor.get('IWorkspaceContextService'))
	const [showAllProjects, setShowAllProjects] = useState(false)

	const threadsState = useChatThreadsState()
	const { allThreads } = threadsState

	const streamState = useFullChatThreadsStreamState()

	const runningThreadIds: { [threadId: string]: IsRunningType | undefined } = {}
	for (const threadId in streamState) {
		const isRunning = streamState[threadId]?.isRunning
		if (isRunning) { runningThreadIds[threadId] = isRunning }
	}

	if (!allThreads) {
		return <div key="error" className="p-1">{t("Error accessing chat history.")}</div>;
	}

	// sorted by most recent to least recent
	const allSortedThreadIds = Object.keys(allThreads ?? {})
		.sort((threadId1, threadId2) => (allThreads[threadId1]?.lastModified ?? 0) > (allThreads[threadId2]?.lastModified ?? 0) ? -1 : 1)
		.filter(threadId => (allThreads![threadId]?.messages.length ?? 0) !== 0)

	const filterByProject = projectKey !== undefined && !showAllProjects
	const sortedThreadIds = filterByProject
		? allSortedThreadIds.filter(threadId => isThreadOfProject(allThreads![threadId], projectKey))
		: allSortedThreadIds
	const numOtherThreads = projectKey === undefined ? 0
		: allSortedThreadIds.filter(threadId => !isThreadOfProject(allThreads![threadId], projectKey)).length

	// Get only first 5 threads if not showing all
	const hasMoreThreads = sortedThreadIds.length > numInitialThreads;
	const displayThreads = showAll ? sortedThreadIds : sortedThreadIds.slice(0, numInitialThreads);

	return (
		<div className={`flex flex-col mb-2 gap-1.5 w-full text-nowrap text-vox-fg-3 select-none relative ${className}`}>
			{displayThreads.length === 0 // this should never happen
				? <></>
				: displayThreads.map((threadId, i) => {
					const pastThread = allThreads[threadId];
					if (!pastThread) {
						return <div key={i} className="p-1">{t("Error accessing chat history.")}</div>;
					}

					return (
						<PastThreadElement
							key={pastThread.id}
							pastThread={pastThread}
							showProject={!filterByProject && pastThread.workspaceFolder !== projectKey}
							idx={i}
							hoveredIdx={hoveredIdx}
							setHoveredIdx={setHoveredIdx}
							isRunning={runningThreadIds[pastThread.id]}
						/>
					);
				})
			}

			{hasMoreThreads && !showAll && (
				<div
					className="self-start text-vox-fg-3 hover:text-vox-accent-text cursor-pointer px-1 py-0.5 rounded-vox-sm text-[11.5px] transition-colors"
					onClick={() => setShowAll(true)}
				>
					{t("Show {0} more...", sortedThreadIds.length - numInitialThreads)}</div>
			)}
			{hasMoreThreads && showAll && (
				<div
					className="self-start text-vox-fg-3 hover:text-vox-accent-text cursor-pointer px-1 py-0.5 rounded-vox-sm text-[11.5px] transition-colors"
					onClick={() => setShowAll(false)}
				>
					{t("Show less")}</div>
			)}
			{numOtherThreads > 0 && (
				<div
					className="self-start text-vox-fg-3 hover:text-vox-accent-text cursor-pointer px-1 py-0.5 rounded-vox-sm text-[11.5px] transition-colors"
					onClick={() => setShowAllProjects(!showAllProjects)}
				>
					{showAllProjects ? t("Show only this project's chats") : t("Show chats from other projects ({0})", numOtherThreads)}</div>
			)}
		</div>
	);
};





// Format date to display as today, yesterday, or date
const formatDate = (date: Date) => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (date >= today) {
		return t("Today");
	} else if (date >= yesterday) {
		return t("Yesterday");
	} else {
		return `${date.toLocaleString(language, { month: 'short' })} ${date.getDate()}`;
	}
};

// Format time to 12-hour format
const formatTime = (date: Date) => {
	return date.toLocaleString(language, {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true
	});
};


const DuplicateButton = ({ threadId }: { threadId: string }) => {
	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	return <IconShell1
		Icon={Copy}
		className='size-[18px] p-[3px]'
		onClick={() => { chatThreadsService.duplicateThread(threadId); }}
		data-tooltip-id='vox-tooltip'
		data-tooltip-place='top'
		data-tooltip-content={t("Duplicate thread")}
	>
	</IconShell1>

}

const TrashButton = ({ threadId }: { threadId: string }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')


	const [isTrashPressed, setIsTrashPressed] = useState(false)

	return (isTrashPressed ?
		<div className='flex flex-nowrap text-nowrap gap-1'>
			<IconShell1
				Icon={X}
				className='size-[18px] p-[3px]'
				onClick={() => { setIsTrashPressed(false); }}
				data-tooltip-id='vox-tooltip'
				data-tooltip-place='top'
				data-tooltip-content={t("Cancel")}
			/>
			<IconShell1
				Icon={Check}
				className='size-[18px] p-[3px]'
				onClick={() => { chatThreadsService.deleteThread(threadId); setIsTrashPressed(false); }}
				data-tooltip-id='vox-tooltip'
				data-tooltip-place='top'
				data-tooltip-content={t("Confirm")}
			/>
		</div>
		: <IconShell1
			Icon={Trash2}
			className='size-[18px] p-[3px]'
			onClick={() => { setIsTrashPressed(true); }}
			data-tooltip-id='vox-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={t("Delete thread")}
		/>
	)
}

// Nome leggibile del progetto di una chat (ultima parte dell'URI della cartella).
// Le chat senza progetto (quelle create prima che le chat fossero legate al progetto, o senza cartella aperta)
// si vedono in ogni progetto: altrimenti dopo l'aggiornamento l'elenco sembrerebbe vuoto.
const isThreadOfProject = (thread: ThreadType | undefined, projectKey: string | undefined): boolean =>
	!thread?.workspaceFolder || thread.workspaceFolder === projectKey

const projectNameOfThread = (thread: ThreadType): string => {
	if (!thread.workspaceFolder) return t("General")
	const last = thread.workspaceFolder.replace(/\/+$/, '').split('/').pop() ?? ''
	try { return decodeURIComponent(last) || thread.workspaceFolder } catch { return last || thread.workspaceFolder }
}

const PastThreadElement = ({ pastThread, showProject, idx, hoveredIdx, setHoveredIdx, isRunning }: {
	pastThread: ThreadType,
	showProject: boolean,
	idx: number,
	hoveredIdx: number | null,
	setHoveredIdx: (idx: number | null) => void,
	isRunning: IsRunningType | undefined,
}

) => {


	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// const settingsState = useSettingsState()
	// const convertService = accessor.get('IConvertToLLMMessageService')
	// const chatMode = settingsState.globalSettings.chatMode
	// const modelSelection = settingsState.modelSelectionOfFeature?.Chat ?? null
	// const copyChatButton = <CopyButton
	// 	codeStr={async () => {
	// 		const { messages } = await convertService.prepareLLMChatMessages({
	// 			chatMessages: currentThread.messages,
	// 			chatMode,
	// 			modelSelection,
	// 		})
	// 		return JSON.stringify(messages, null, 2)
	// 	}}
	// 	toolTipName={modelSelection === null ? 'Copy As Messages Payload' : `Copy As ${displayInfoOfProviderName(modelSelection.providerName).title} Payload`}
	// />


	// const currentThread = chatThreadsService.getCurrentThread()
	// const copyChatButton2 = <CopyButton
	// 	codeStr={async () => {
	// 		return JSON.stringify(currentThread.messages, null, 2)
	// 	}}
	// 	toolTipName={`Copy As Vox Chat`}
	// />

	let firstMsg = null;
	const firstUserMsgIdx = pastThread.messages.findIndex((msg) => msg.role === 'user');

	if (firstUserMsgIdx !== -1) {
		const firsUsertMsgObj = pastThread.messages[firstUserMsgIdx];
		firstMsg = firsUsertMsgObj.role === 'user' && firsUsertMsgObj.displayContent || '';
	} else {
		firstMsg = '""';
	}

	const numMessages = pastThread.messages.filter((msg) => msg.role === 'assistant' || msg.role === 'user').length;

	const detailsHTML = <span
	// data-tooltip-id='vox-tooltip'
	// data-tooltip-content={`Last modified ${formatTime(new Date(pastThread.lastModified))}`}
	// data-tooltip-place='top'
	>
		{showProject && <span className='mr-1'>{projectNameOfThread(pastThread)} ·</span>}
		<span className='tabular-nums'>{numMessages}</span>
		{` · `}
		{formatDate(new Date(pastThread.lastModified))}
		{/* {` messages `} */}
	</span>

	return <div
		key={pastThread.id}
		className={`
			@@vox-card @@vox-card-interactive py-2 px-2.5 text-[12.5px] text-vox-fg-2 hover:text-vox-fg-1
		`}
		onClick={() => {
			chatThreadsService.switchToThread(pastThread.id);
		}}
		onMouseEnter={() => setHoveredIdx(idx)}
		onMouseLeave={() => setHoveredIdx(null)}
	>
		<div className="flex items-center justify-between gap-1">
			<span className="flex items-center gap-2 min-w-0 overflow-hidden">
				{/* spinner */}
				{isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'idle' ? <LoaderCircle className="animate-spin text-vox-accent-text flex-shrink-0 flex-grow-0" size={14} />
					:
					isRunning === 'awaiting_user' ? <MessageCircleQuestion className="text-vox-warning flex-shrink-0 flex-grow-0" size={14} />
						:
						<MessageSquare className="text-vox-fg-4 flex-shrink-0 flex-grow-0" size={13} aria-hidden='true' />}
				{/* name */}
				<span className="truncate overflow-hidden text-ellipsis"
					data-tooltip-id='vox-tooltip'
					data-tooltip-content={t(numMessages === 1 ? "{0} message" : "{0} messages", numMessages)}
					data-tooltip-place='top'
				>{firstMsg}</span>

				{/* <span className='opacity-60'>{`(${numMessages})`}</span> */}
			</span>

			<div className="flex items-center gap-x-1 flex-shrink-0 text-[11px] text-vox-fg-4">
				{idx === hoveredIdx ?
					<>
						{/* trash icon */}
						<DuplicateButton threadId={pastThread.id} />

						{/* trash icon */}
						<TrashButton threadId={pastThread.id} />
					</>
					: <>
						{detailsHTML}
					</>
				}
			</div>
		</div>
	</div>
}
