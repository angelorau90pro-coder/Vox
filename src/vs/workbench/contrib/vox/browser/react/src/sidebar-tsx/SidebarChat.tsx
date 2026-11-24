/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import React, { ButtonHTMLAttributes, FormEvent, FormHTMLAttributes, Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';


import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useSettingsState, useActiveURI, useCommandBarState, useFullChatThreadsStreamState } from '../util/services.js';
import { ScrollType } from '../../../../../../../editor/common/editorCommon.js';

import { ChatMarkdownRender, ChatMessageLocation, getApplyBoxId } from '../markdown/ChatMarkdownRender.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { BlockCode, TextAreaFns, VoxCustomDropdownBox, VoxInputBox2, VoxSlider, VoxSwitch, VoxDiffEditor } from '../util/inputs.js';
import { ModelDropdown, } from '../vox-settings-tsx/ModelDropdown.js';
import { PastThreadsList } from './SidebarThreadSelector.js';
import { VOX_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VOX_OPEN_SETTINGS_ACTION_ID } from '../../../voxSettingsPane.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, isFeatureNameDisabled } from '../../../../../../../workbench/contrib/vox/common/voxSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../vox-settings-tsx/WarningBox.js';
import { getModelCapabilities, getIsReasoningEnabledState } from '../../../../common/modelCapabilities.js';
import { AlertTriangle, File, Ban, Check, ChevronRight, Dot, FileIcon, Pencil, Undo, Undo2, X, Flag, Copy as CopyIcon, Info, CirclePlus, Ellipsis, CircleEllipsis, Folder, ALargeSmall, TypeOutline, Text, FileText, FolderOpen, FolderTree, Search, FilePlus, Trash2, FilePen, FileCode, SquareTerminal, Terminal, TextSearch, BookMarked, ListChecks, Plug, Brain, Sparkles, ArrowUp, History, Lightbulb, BookOpen } from 'lucide-react';
import { ChatMessage, CheckpointEntry, StagingSelectionItem, ToolMessage } from '../../../../common/chatThreadServiceTypes.js';
import { approvalTypeOfBuiltinToolName, builtinToolsThatAlwaysAsk, BuiltinToolCallParams, BuiltinToolName, ToolName, LintErrorItem, ToolApprovalType, toolApprovalTypes, urisOfBuiltinToolParams } from '../../../../common/toolsServiceTypes.js';
import { CopyButton, EditToolAcceptRejectButtonsHTML, IconShell1, JumpToFileButton, JumpToTerminalButton, StatusIndicator, StatusIndicatorForApplyButton, useApplyStreamState, useEditToolStreamState } from '../markdown/ApplyBlockHoverButtons.js';
import { IsRunningType } from '../../../chatThreadService.js';
import { acceptAllBg, acceptBorder, buttonFontSize, buttonTextColor, rejectAllBg, rejectBg, rejectBorder } from '../../../../common/helpers/colors.js';
import { builtinToolNames, isABuiltinToolName, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_INACTIVE_TIME } from '../../../../common/prompt/prompts.js';
import { LLMTokenStats, RawToolCallObj } from '../../../../common/sendLLMMessageTypes.js';
import { ContextUsageLine, setChatDraft } from './ChatContext.js';
import { ProjectTask } from '../../../../common/projectContext.js';
import ErrorBoundary from './ErrorBoundary.js';
import { ToolApprovalTypeSwitch } from '../vox-settings-tsx/Settings.js';

import { persistentTerminalNameOfId } from '../../../terminalToolService.js';
import { removeMCPToolNamePrefix } from '../../../../common/mcpServiceTypes.js';



export const IconX = ({ size, className = '', ...props }: { size: number, className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			xmlns='http://www.w3.org/2000/svg'
			width={size}
			height={size}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			className={className}
			{...props}
		>
			<path
				strokeLinecap='round'
				strokeLinejoin='round'
				d='M6 18 18 6M6 6l12 12'
			/>
		</svg>
	);
};

const IconSquare = ({ size, className = '', ...props }: { size: number, className?: string } & React.SVGProps<SVGSVGElement>) => {
	return (
		<svg
			className={className}
			{...props}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="2" y="2" width="20" height="20" rx="4" ry="4" />
		</svg>
	);
};


export const IconWarning = ({ size, className = '' }: { size: number, className?: string }) => {
	return (
		<svg
			className={className}
			stroke="currentColor"
			fill="currentColor"
			strokeWidth="0"
			viewBox="0 0 16 16"
			width={size}
			height={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"
			/>
		</svg>
	);
};


export const IconLoading = ({ className = '' }: { className?: string }) => {

	const [loadingText, setLoadingText] = useState('.');

	useEffect(() => {
		let intervalId;

		// Function to handle the animation
		const toggleLoadingText = () => {
			if (loadingText === '...') {
				setLoadingText('.');
			} else {
				setLoadingText(loadingText + '.');
			}
		};

		// Start the animation loop
		intervalId = setInterval(toggleLoadingText, 300);

		// Cleanup function to clear the interval when component unmounts
		return () => clearInterval(intervalId);
	}, [loadingText, setLoadingText]);

	return <div className={`${className}`}>{loadingText}</div>;

}



// SLIDER ONLY:
const ReasoningOptionSlider = ({ featureName }: { featureName: FeatureName }) => {
	const accessor = useAccessor()

	const voxSettingsService = accessor.get('IVoxSettingsService')
	const voxSettingsState = useSettingsState()

	const modelSelection = voxSettingsState.modelSelectionOfFeature[featureName]
	const overridesOfModel = voxSettingsState.overridesOfModel

	if (!modelSelection) return null

	const { modelName, providerName } = modelSelection
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel)
	const { canTurnOffReasoning, reasoningSlider: reasoningBudgetSlider } = reasoningCapabilities || {}

	const modelSelectionOptions = voxSettingsState.optionsOfModelSelection[featureName][providerName]?.[modelName]
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)

	if (canTurnOffReasoning && !reasoningBudgetSlider) { // if it's just a on/off toggle without a power slider
		return <div className='flex items-center gap-x-2'>
			<span className='text-vox-fg-3 text-xs pointer-events-none inline-block whitespace-nowrap pr-1'>{t("Thinking")}</span>
			<VoxSwitch
				size='xxs'
				value={isReasoningEnabled}
				ariaLabel={t("Thinking")}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && !newVal
					voxSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff })
				}}
			/>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'budget_slider') { // if it's a slider
		const { min: min_, max, default: defaultVal } = reasoningBudgetSlider

		const nSteps = 8 // only used in calculating stepSize, stepSize is what actually matters
		const stepSize = Math.round((max - min_) / nSteps)

		const valueIfOff = min_ - stepSize
		const min = canTurnOffReasoning ? valueIfOff : min_
		const value = isReasoningEnabled ? voxSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningBudget ?? defaultVal
			: valueIfOff

		return <div className='flex items-center gap-x-2'>
			<span className='text-vox-fg-3 text-xs pointer-events-none inline-block whitespace-nowrap pr-1'>{t("Thinking")}</span>
			<VoxSlider
				width={50}
				size='xs'
				min={min}
				max={max}
				step={stepSize}
				value={value}
				ariaLabel={t("Thinking")}
				ariaValueText={isReasoningEnabled ? t("{0} tokens", value) : t("Thinking disabled")}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voxSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningBudget: newVal })
				}}
			/>
			<span className='text-vox-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? t("{0} tokens", value) : t("Thinking disabled")}</span>
		</div>
	}

	if (reasoningBudgetSlider?.type === 'effort_slider') {

		const { values, default: defaultVal } = reasoningBudgetSlider

		const min = canTurnOffReasoning ? -1 : 0
		const max = values.length - 1

		const currentEffort = voxSettingsState.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]?.reasoningEffort ?? defaultVal
		const valueIfOff = -1
		const value = isReasoningEnabled && currentEffort ? values.indexOf(currentEffort) : valueIfOff

		const currentEffortCapitalized = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1, Infinity)

		return <div className='flex items-center gap-x-2'>
			<span className='text-vox-fg-3 text-xs pointer-events-none inline-block whitespace-nowrap pr-1'>{t("Thinking")}</span>
			<VoxSlider
				width={30}
				size='xs'
				min={min}
				max={max}
				step={1}
				value={value}
				ariaLabel={t("Thinking")}
				ariaValueText={isReasoningEnabled ? t(currentEffortCapitalized) : t("Thinking disabled")}
				onChange={(newVal) => {
					const isOff = canTurnOffReasoning && newVal === valueIfOff
					voxSettingsService.setOptionsOfModelSelection(featureName, modelSelection.providerName, modelSelection.modelName, { reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined })
				}}
			/>
			<span className='text-vox-fg-3 text-xs pointer-events-none'>{isReasoningEnabled ? t(currentEffortCapitalized) : t("Thinking disabled")}</span>
		</div>
	}

	return null
}



const nameOfChatMode = {
	'normal': 'Chat',
	'gather': t("Gather"),
	'agent': t("Agent"),
}

const detailOfChatMode = {
	'normal': t("Normal chat"),
	'gather': t("Reads files, but can't edit"),
	'agent': t("Edits files and uses tools"),
}


const ChatModeDropdown = ({ className }: { className: string }) => {
	const accessor = useAccessor()

	const voxSettingsService = accessor.get('IVoxSettingsService')
	const settingsState = useSettingsState()

	const options: ChatMode[] = useMemo(() => ['normal', 'gather', 'agent'], [])

	const onChangeOption = useCallback((newVal: ChatMode) => {
		voxSettingsService.setGlobalSetting('chatMode', newVal)
	}, [voxSettingsService])

	return <VoxCustomDropdownBox
		className={className}
		options={options}
		selectedOption={settingsState.globalSettings.chatMode}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => nameOfChatMode[val]}
		getOptionDropdownName={(val) => nameOfChatMode[val]}
		getOptionDropdownDetail={(val) => detailOfChatMode[val]}
		getOptionsEqual={(a, b) => a === b}
		ariaLabel={t("Chat mode")}
	/>

}





interface VoxChatAreaProps {
	// Required
	children: React.ReactNode; // This will be the input component

	// Form controls
	onSubmit: () => void;
	onAbort: () => void;
	isStreaming: boolean;
	isDisabled?: boolean;
	divRef?: React.RefObject<HTMLDivElement | null>;

	// UI customization
	className?: string;
	showModelDropdown?: boolean;
	showSelections?: boolean;
	showProspectiveSelections?: boolean;
	loadingIcon?: React.ReactNode;

	selections?: StagingSelectionItem[]
	setSelections?: (s: StagingSelectionItem[]) => void
	// selections?: any[];
	// onSelectionsChange?: (selections: any[]) => void;

	onClickAnywhere?: () => void;
	// Optional close button
	onClose?: () => void;

	featureName: FeatureName;
}

export const VoxChatArea: React.FC<VoxChatAreaProps> = ({
	children,
	onSubmit,
	onAbort,
	onClose,
	onClickAnywhere,
	divRef,
	isStreaming = false,
	isDisabled = false,
	className = '',
	showModelDropdown = true,
	showSelections = false,
	showProspectiveSelections = false,
	selections,
	setSelections,
	featureName,
	loadingIcon,
}) => {
	return (
		<div
			ref={divRef}
			className={`
				gap-x-1 gap-y-1.5
                flex flex-col px-2.5 pt-2 pb-2 relative input text-left shrink-0
                rounded-vox-xl
                bg-vox-bg-1
				shadow-vox-sm
				transition-[border-color,box-shadow] duration-200
				border border-vox-hairline-strong hover:border-vox-accent-border
				focus-within:border-vox-accent focus-within:ring-[3px] focus-within:ring-vox-accent-soft
				max-h-[80vh] overflow-y-auto
                ${className}
            `}
			onClick={(e) => {
				const target = e.target instanceof Element ? e.target : null;
				// i pulsanti tengono il proprio focus (per esempio la matita che apre un campo); dopo Stop il focus lo riporta onAbort
				if (target?.closest('button, [role="button"], [role="combobox"], [role="listbox"], [role="option"], [role="switch"], [role="slider"], input, select, textarea, a')) return;
				onClickAnywhere?.()
			}}
		>
			{/* Selections section */}
			{showSelections && selections && setSelections && (
				<SelectedFiles
					type='staging'
					selections={selections}
					setSelections={setSelections}
					showProspectiveSelections={showProspectiveSelections}
				/>
			)}

			{/* Input section */}
			<div className="relative w-full">
				{children}

				{/* Close button (X) if onClose is provided */}
				{onClose && (
					<button
						type='button'
						aria-label={t("Close")}
						onClick={onClose}
						className='absolute -top-0.5 -right-0.5 cursor-pointer z-1 flex items-center justify-center size-5 rounded-vox-sm bg-transparent border-0 p-0 text-vox-fg-3 hover:text-vox-fg-1 hover:bg-vox-surface-hover transition-colors'
					>
						<IconX
							size={12}
							className="stroke-[2]"
							aria-hidden="true"
						/>
					</button>
				)}
			</div>

			{/* Bottom row */}
			<div className='flex flex-row justify-between items-end gap-1'>
				{showModelDropdown && (
					<div className='flex flex-col gap-y-1'>
						<ReasoningOptionSlider featureName={featureName} />

						<div className='flex items-center flex-wrap gap-x-2 gap-y-1 text-nowrap '>
							{featureName === 'Chat' && <ChatModeDropdown className='text-xs text-vox-fg-2 bg-vox-surface hover:bg-vox-surface-hover border border-vox-hairline rounded-full py-0.5 px-2 transition-colors' />}
							<ModelDropdown featureName={featureName} className='text-xs text-vox-fg-3 bg-transparent hover:bg-vox-surface-hover rounded-full py-0.5 px-2 transition-colors' />
						</div>
					</div>
				)}

				<div className="flex items-center gap-2">

					{isStreaming && loadingIcon}

					{isStreaming ? (
						<ButtonStop onClick={onAbort} />
					) : (
						<ButtonSubmit
							onClick={onSubmit}
							disabled={isDisabled}
						/>
					)}
				</div>

			</div>
		</div>
	);
};




type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
const DEFAULT_BUTTON_SIZE = 22;
export const ButtonSubmit = ({ className, disabled, ...props }: ButtonProps & Required<Pick<ButtonProps, 'disabled'>>) => {

	return <button
		type='button'
		aria-label={t("Send")}
		className={`rounded-full flex-shrink-0 flex-grow-0 flex items-center justify-center size-[26px]
			transition-[background-color,transform,opacity] duration-150
			${disabled ? 'bg-vox-surface-hover text-vox-fg-4 cursor-default' : 'bg-vox-accent text-vox-accent-fg hover:bg-vox-accent-hover active:scale-95 cursor-pointer shadow-vox-sm'}
			${className ?? ''}
		`}
		aria-disabled={disabled || undefined}
		{...props}
	>
		<ArrowUp size={15} strokeWidth={2.5} aria-hidden />
	</button>
}

export const ButtonStop = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		className={`rounded-full flex-shrink-0 flex-grow-0 cursor-pointer flex items-center justify-center size-[26px]
			bg-vox-fg-1 text-vox-bg-1 hover:opacity-85 active:scale-95 transition-[opacity,transform] duration-150
			${className ?? ''}
		`}
		type='button'
		aria-label={t("Stop")}
		{...props}
	>
		<IconSquare size={DEFAULT_BUTTON_SIZE} className="p-[7px]" aria-hidden />
	</button>
}



const scrollToBottom = (divRef: { current: HTMLElement | null }) => {
	if (divRef.current) {
		divRef.current.scrollTop = divRef.current.scrollHeight;
	}
};



const ScrollToBottomContainer = ({ children, className, style, scrollContainerRef }: { children: React.ReactNode, className?: string, style?: React.CSSProperties, scrollContainerRef: React.MutableRefObject<HTMLDivElement | null> }) => {
	const [isAtBottom, setIsAtBottom] = useState(true); // Start at bottom

	const divRef = scrollContainerRef

	const onScroll = () => {
		const div = divRef.current;
		if (!div) return;

		const isBottom = Math.abs(
			div.scrollHeight - div.clientHeight - div.scrollTop
		) < 4;

		setIsAtBottom(isBottom);
	};

	// When children change (new messages added)
	useEffect(() => {
		if (isAtBottom) {
			scrollToBottom(divRef);
		}
	}, [children, isAtBottom]); // Dependency on children to detect new messages

	// Initial scroll to bottom
	useEffect(() => {
		scrollToBottom(divRef);
	}, []);

	return (
		<div
			ref={divRef}
			onScroll={onScroll}
			className={className}
			style={style}
		>
			{children}
		</div>
	);
};

export const getRelative = (uri: URI, accessor: ReturnType<typeof useAccessor>) => {
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	let path: string
	const isInside = workspaceContextService.isInsideWorkspace(uri)
	if (isInside) {
		// la cartella che contiene davvero il file: con un confronto per prefisso «E:\a» vinceva anche per «E:\ab\x»
		const f = workspaceContextService.getWorkspaceFolder(uri)
		if (f && uri.fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase())) { path = uri.fsPath.slice(f.uri.fsPath.length) }
		else { path = uri.fsPath }
	}
	else {
		path = uri.fsPath
	}
	return path || undefined
}

export const getFolderName = (pathStr: string) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const parts = pathStr.split('/') // split on /
	// Filter out empty parts (the last element will be empty if path ends with /)
	const nonEmptyParts = parts.filter(part => part.length > 0)
	if (nonEmptyParts.length === 0) return '/' // Root directory
	if (nonEmptyParts.length === 1) return nonEmptyParts[0] + '/' // Only one folder
	// Get the last two parts
	const lastTwo = nonEmptyParts.slice(-2)
	return lastTwo.join('/') + '/'
}

export const getBasename = (pathStr: string, parts: number = 1) => {
	// 'unixify' path
	pathStr = pathStr.replace(/[/\\]+/g, '/') // replace any / or \ or \\ with /
	const allParts = pathStr.split('/') // split on /
	if (allParts.length === 0) return pathStr
	return allParts.slice(-parts).join('/')
}



// Open file utility function
export const voxOpenFileFn = (
	uri: URI,
	accessor: ReturnType<typeof useAccessor>,
	range?: [number, number]
) => {
	const commandService = accessor.get('ICommandService')
	const editorService = accessor.get('ICodeEditorService')

	// Get editor selection from CodeSelection range
	let editorSelection = undefined;

	// If we have a selection, create an editor selection from the range
	if (range) {
		editorSelection = {
			startLineNumber: range[0],
			startColumn: 1,
			endLineNumber: range[1],
			endColumn: Number.MAX_SAFE_INTEGER,
		};
	}

	// open the file
	commandService.executeCommand('vscode.open', uri).then(() => {

		// select the text
		setTimeout(() => {
			if (!editorSelection) return;

			const editor = editorService.getActiveCodeEditor()
			if (!editor) return;

			editor.setSelection(editorSelection)
			editor.revealRange(editorSelection, ScrollType.Immediate)

		}, 50) // needed when document was just opened and needs to initialize

	})

};


export const SelectedFiles = (
	{ type, selections, setSelections, showProspectiveSelections, messageIdx, }:
		| { type: 'past', selections: StagingSelectionItem[]; setSelections?: undefined, showProspectiveSelections?: undefined, messageIdx: number, }
		| { type: 'staging', selections: StagingSelectionItem[]; setSelections: ((newSelections: StagingSelectionItem[]) => void), showProspectiveSelections?: boolean, messageIdx?: number }
) => {

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const modelReferenceService = accessor.get('IVoxModelService')




	// state for tracking prospective files
	const { uri: currentURI } = useActiveURI()
	const [recentUris, setRecentUris] = useState<URI[]>([])
	const maxRecentUris = 10
	const maxProspectiveFiles = 3
	useEffect(() => { // handle recent files
		if (!currentURI) return
		setRecentUris(prev => {
			const withoutCurrent = prev.filter(uri => uri.fsPath !== currentURI.fsPath) // remove duplicates
			const withCurrent = [currentURI, ...withoutCurrent]
			return withCurrent.slice(0, maxRecentUris)
		})
	}, [currentURI])
	const [prospectiveSelections, setProspectiveSelections] = useState<StagingSelectionItem[]>([])


	// handle prospective files
	useEffect(() => {
		const computeRecents = async () => {
			const prospectiveURIs = recentUris
				.filter(uri => !selections.find(s => s.type === 'File' && s.uri.fsPath === uri.fsPath))
				.slice(0, maxProspectiveFiles)

			const answer: StagingSelectionItem[] = []
			for (const uri of prospectiveURIs) {
				answer.push({
					type: 'File',
					uri: uri,
					language: (await modelReferenceService.getModelSafe(uri)).model?.getLanguageId() || 'plaintext',
					state: { wasAddedAsCurrentFile: false },
				})
			}
			return answer
		}

		// add a prospective file if type === 'staging' and if the user is in a file, and if the file is not selected yet
		// VOX: vale solo l'ultimo calcolo; uno più vecchio che finisce dopo (o dopo lo smontaggio) non rimette file superati
		let cancelled = false
		if (type === 'staging' && showProspectiveSelections) {
			computeRecents().then((a) => { if (!cancelled) setProspectiveSelections(a) }, () => { })
		}
		else {
			setProspectiveSelections([])
		}
		return () => { cancelled = true }
	}, [recentUris, selections, type, showProspectiveSelections])


	const allSelections = [...selections, ...prospectiveSelections]

	if (allSelections.length === 0) {
		return null
	}

	return (
		<div className='flex items-center flex-wrap text-left relative gap-x-1 gap-y-1 pb-0.5'>

			{allSelections.map((selection, i) => {

				const isThisSelectionProspective = i > selections.length - 1

				const thisKey = selection.type === 'CodeSelection' ? selection.type + selection.language + selection.range + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
					: selection.type === 'File' ? selection.type + selection.language + selection.state.wasAddedAsCurrentFile + selection.uri.fsPath
						: selection.type === 'Folder' ? selection.type + selection.language + selection.state + selection.uri.fsPath
							: i

				const SelectionIcon = (
					selection.type === 'File' ? File
						: selection.type === 'Folder' ? Folder
							: selection.type === 'CodeSelection' ? Text
								: (undefined as never)
				)

				return <div // container for summarybox and code
					key={thisKey}
					className={`flex flex-col space-y-[1px]`}
				>
					{/* tooltip for file path */}
					<span className="truncate overflow-hidden text-ellipsis"
						data-tooltip-id='vox-tooltip'
						data-tooltip-content={getRelative(selection.uri, accessor)}
						data-tooltip-place='top'
						data-tooltip-delay-show={3000}
					>
						{/* summarybox */}
						<div
							className={`
								flex items-center gap-1 relative
								pl-1.5 pr-1 py-px
								w-fit h-fit
								select-none cursor-pointer
								text-[11px] leading-[16px] text-nowrap
								border rounded-full
								${isThisSelectionProspective
									? 'bg-transparent text-vox-fg-3 border-dashed border-vox-hairline-strong hover:text-vox-fg-1 hover:border-vox-accent-border'
									: 'bg-vox-surface-hover text-vox-fg-1 border-vox-hairline hover:border-vox-hairline-strong'
								}
								transition-colors duration-150
							`}
							onClick={() => {
								if (type !== 'staging') return; // (never)
								if (isThisSelectionProspective) { // add prospective selection to selections
									setSelections([...selections, selection])
								}
								else if (selection.type === 'File') { // open files
									voxOpenFileFn(selection.uri, accessor);

									const wasAddedAsCurrentFile = selection.state.wasAddedAsCurrentFile
									if (wasAddedAsCurrentFile) {
										// make it so the file is added permanently, not just as the current file
										const newSelection: StagingSelectionItem = { ...selection, state: { ...selection.state, wasAddedAsCurrentFile: false } }
										setSelections([
											...selections.slice(0, i),
											newSelection,
											...selections.slice(i + 1)
										])
									}
								}
								else if (selection.type === 'CodeSelection') {
									voxOpenFileFn(selection.uri, accessor, selection.range);
								}
								else if (selection.type === 'Folder') {
									// TODO!!! reveal in tree
								}
							}}
						>
							{isThisSelectionProspective ? <CirclePlus size={11} className='flex-shrink-0 text-vox-fg-4' /> : <SelectionIcon size={11} className='flex-shrink-0 text-vox-accent-text' />}

							{ // file name and range
								getBasename(selection.uri.fsPath)
								+ (selection.type === 'CodeSelection' ? ` (${selection.range[0]}-${selection.range[1]})` : '')
							}

							{selection.type === 'File' && selection.state.wasAddedAsCurrentFile && messageIdx === undefined && currentURI?.fsPath === selection.uri.fsPath ?
								<span className={`text-[9.5px] text-vox-fg-4`}>
									{t("(Current File)")}
								</span>
								: null
							}

							{type === 'staging' && !isThisSelectionProspective ? // X button
								<div // box for making it easier to click
									className='cursor-pointer z-1 flex items-center justify-center size-4 rounded-full text-vox-fg-4 hover:text-vox-fg-1 hover:bg-vox-hairline-strong transition-colors'
									onClick={(e) => {
										e.stopPropagation(); // don't open/close selection
										if (type !== 'staging') return;
										setSelections([...selections.slice(0, i), ...selections.slice(i + 1)])
									}}
								>
									<IconX
										className='stroke-[2]'
										size={10}
									/>
								</div>
								: <></>
							}
						</div>
					</span>
				</div>

			})}


		</div>

	)
}


type ToolHeaderParams = {
	icon?: React.ReactNode;
	title: React.ReactNode;
	desc1: React.ReactNode;
	desc1OnClick?: () => void;
	desc2?: React.ReactNode;
	isError?: boolean;
	info?: string;
	desc1Info?: string;
	isRejected?: boolean;
	numResults?: number;
	hasNextPage?: boolean;
	children?: React.ReactNode;
	bottomChildren?: React.ReactNode;
	onClick?: () => void;
	desc2OnClick?: () => void;
	isOpen?: boolean;
	className?: string;
}

const ToolHeaderWrapper = ({
	icon,
	title,
	desc1,
	desc1OnClick,
	desc1Info,
	desc2,
	numResults,
	hasNextPage,
	children,
	info,
	bottomChildren,
	isError,
	onClick,
	desc2OnClick,
	isOpen,
	isRejected,
	className, // applies to the main content
}: ToolHeaderParams) => {

	const [isOpen_, setIsOpen] = useState(false);
	const isExpanded = isOpen !== undefined ? isOpen : isOpen_

	const isDropdown = children !== undefined // null ALLOWS dropdown
	const isClickable = !!(isDropdown || onClick)

	const isDesc1Clickable = !!desc1OnClick

	const desc1HTML = <span
		className={`text-vox-fg-3 text-[11.5px] font-mono truncate min-w-0
			${isDesc1Clickable ? 'cursor-pointer hover:text-vox-accent-text hover:underline underline-offset-2 transition-colors duration-150' : ''}
		`}
		onClick={desc1OnClick}
		{...desc1Info ? {
			'data-tooltip-id': 'vox-tooltip',
			'data-tooltip-content': desc1Info,
			'data-tooltip-place': 'top',
			'data-tooltip-delay-show': 1000,
		} : {}}
	>{desc1}</span>

	const onToggle = () => {
		if (isDropdown) { setIsOpen(v => !v); }
		if (onClick) { onClick(); }
	}
	// solo apri o chiudi: se l'apertura la decide chi usa la scheda (`isOpen`), è il suo `onClick` a cambiarla
	const onToggleOnly = () => {
		if (isOpen !== undefined) { onClick?.(); }
		else { setIsOpen(v => !v); }
	}

	return (<div className='@@vox-fade-up'>
		<div className={`w-full border border-vox-hairline rounded-vox-lg bg-vox-surface overflow-hidden transition-colors duration-150 ${isExpanded ? 'border-vox-hairline-strong' : ''} ${className}`}>
			{/* header */}
			<div className={`select-none flex items-center min-h-[32px] pl-1.5 pr-1.5 ${isClickable ? 'hover:bg-vox-surface-hover transition-colors duration-150' : ''}`}>
				<div className={`flex items-center w-full gap-x-2 overflow-hidden justify-between`}>
					{/* left */}
					<div // container for if desc1 is clickable
						className='flex items-center overflow-hidden gap-2 min-w-0'
					>
						{/* title eg "Edited file" */}
						<div className={`
							flex items-center gap-2 min-w-0 overflow-hidden
							${isClickable ? 'cursor-pointer' : ''}
						`}
							onClick={onToggle}
						>
							{icon ? <span aria-hidden='true' className={`flex-shrink-0 size-[22px] rounded-vox-sm flex items-center justify-center ${isError ? 'bg-vox-danger-soft text-vox-danger' : isRejected ? 'bg-vox-surface-hover text-vox-fg-4' : 'bg-vox-accent-soft text-vox-accent-text'}`}>{icon}</span> : null}
							<span className={`text-[12.5px] font-medium text-vox-fg-2 flex-shrink-0 ${isRejected ? 'line-through text-vox-fg-4' : ''}`}>{title}</span>

							{!isDesc1Clickable && desc1HTML}
						</div>
						{isDesc1Clickable && desc1HTML}
					</div>

					{/* right */}
					<div className="flex items-center gap-x-1.5 flex-shrink-0">

						{info && <CircleEllipsis
							className='ml-2 text-vox-fg-4 opacity-60 flex-shrink-0'
							size={14}
							data-tooltip-id='vox-tooltip'
							data-tooltip-content={info}
							data-tooltip-place='top-end'
						/>}

						{isError && <AlertTriangle
							className='text-vox-warning opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='vox-tooltip'
							data-tooltip-content={t("Error running tool")}
							data-tooltip-place='top'
						/>}
						{isRejected && <Ban
							className='text-vox-fg-4 opacity-90 flex-shrink-0'
							size={14}
							data-tooltip-id='vox-tooltip'
							data-tooltip-content={t("Canceled")}
							data-tooltip-place='top'
						/>}
						{desc2 && <span className="text-vox-fg-4 text-xs" onClick={desc2OnClick}>
							{desc2}
						</span>}
						{numResults !== undefined && (
							<span className="@@vox-chip !py-0 !text-[10.5px] text-vox-fg-3">
								{t(numResults === 1 ? "{0} result" : "{0} results", `${numResults}${hasNextPage ? '+' : ''}`)}
							</span>
						)}
						{/* la freccia apre o chiude soltanto: l'azione della riga (per esempio aprire il file) resta sul titolo */}
						{isDropdown && (<button
							type='button'
							aria-label={t(isExpanded ? "Hide details" : "Show details")}
							aria-expanded={isExpanded}
							// aperta per forza (per esempio un comando in corso) e senza chi la cambi: la freccia non può fare niente
							disabled={isOpen !== undefined && !onClick}
							onClick={onToggleOnly}
							className='flex items-center justify-center size-[22px] rounded-vox-sm text-vox-fg-4 hover:text-vox-fg-1 hover:bg-vox-surface-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-vox-fg-4'
						>
							<ChevronRight
								className={`
								h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]
								${isExpanded ? 'rotate-90' : ''}
							`}
							/>
						</button>)}
					</div>
				</div>
			</div>
			{/* children */}
			{<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isExpanded ? 'opacity-100 py-1.5 border-t border-vox-hairline bg-vox-bg-3' : 'max-h-0 opacity-0'}
					text-vox-fg-4 overflow-x-auto
				  `}
			>
				{children}
			</div>}
			{bottomChildren}
		</div>
	</div>);
};



const EditTool = ({ toolMessage, threadId, messageIdx, content }: Parameters<ResultWrapper<'edit_file' | 'rewrite_file'>>[0] & { content: string }) => {
	const accessor = useAccessor()
	const isError = false
	const isRejected = toolMessage.type === 'rejected'

	const title = getTitle(toolMessage)

	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
	const icon = <ToolIcon name={toolMessage.name} />

	const { rawParams, params, name } = toolMessage
	const desc1OnClick = () => voxOpenFileFn(params.uri, accessor)
	const componentParams: ToolHeaderParams = { title, desc1, desc1OnClick, desc1Info, isError, icon, isRejected, }


	const editToolType = toolMessage.name === 'edit_file' ? 'diff' : 'rewrite'
	if (toolMessage.type === 'running_now' || toolMessage.type === 'tool_request') {
		componentParams.children = <ToolChildrenWrapper className='bg-vox-bg-3'>
			<EditToolChildren
				uri={params.uri}
				code={content}
				type={editToolType}
			/>
		</ToolChildrenWrapper>
		// JumpToFileButton removed in favor of FileLinkText
	}
	else if (toolMessage.type === 'success' || toolMessage.type === 'rejected' || toolMessage.type === 'tool_error') {
		// add apply box
		const applyBoxId = getApplyBoxId({
			threadId: threadId,
			messageIdx: messageIdx,
			tokenIdx: t("N/A"),
		})
		componentParams.desc2 = <EditToolHeaderButtons
			applyBoxId={applyBoxId}
			uri={params.uri}
			codeStr={content}
			toolName={name}
			threadId={threadId}
		/>

		// add children
		componentParams.children = <ToolChildrenWrapper className='bg-vox-bg-3'>
			<EditToolChildren
				uri={params.uri}
				code={content}
				type={editToolType}
			/>
		</ToolChildrenWrapper>

		if (toolMessage.type === 'success' || toolMessage.type === 'rejected') {
			const { result } = toolMessage
			componentParams.bottomChildren = <BottomChildren title={t("Lint errors")}>
				{result?.lintErrors?.map((error, i) => (
					<div key={i} className='whitespace-nowrap'>{t("Lines")} {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
				))}
			</BottomChildren>
		}
		else if (toolMessage.type === 'tool_error') {
			// error
			const { result } = toolMessage
			componentParams.bottomChildren = <BottomChildren title={t("Error")}>
				<CodeChildren>
					{result}
				</CodeChildren>
			</BottomChildren>
		}
	}

	return <ToolHeaderWrapper {...componentParams} />
}

const SimplifiedToolHeader = ({
	title,
	children,
}: {
	title: string;
	children?: React.ReactNode;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const isDropdown = children !== undefined;
	return (
		<div>
			<div className="w-full">
				{/* header */}
				<div
					className={`select-none flex items-center min-h-[24px] ${isDropdown ? 'cursor-pointer' : ''}`}
					onClick={() => {
						if (isDropdown) { setIsOpen(v => !v); }
					}}
				>
					{isDropdown && (
						<ChevronRight
							className={`text-vox-fg-3 mr-0.5 h-4 w-4 flex-shrink-0 transition-transform duration-100 ease-[cubic-bezier(0.4,0,0.2,1)] ${isOpen ? 'rotate-90' : ''}`}
						/>
					)}
					<div className="flex items-center w-full overflow-hidden">
						<span className="text-vox-fg-3">{title}</span>
					</div>
				</div>
				{/* children */}
				{<div
					className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100' : 'max-h-0 opacity-0'} text-vox-fg-4`}
				>
					{children}
				</div>}
			</div>
		</div>
	);
};




const UserMessageComponent = ({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, _scrollToBottom }: { chatMessage: ChatMessage & { role: 'user' }, messageIdx: number, currCheckpointIdx: number | undefined, isCheckpointGhost: boolean, _scrollToBottom: (() => void) | null }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

	const onOpenEdit = () => {
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

	}

	const EditSymbol = mode === 'display' ? Pencil : X


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			<span className='px-0.5'>{chatMessage.displayContent}</span>
		</>
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId

			await chatThreadsService.abortRunning(threadId)

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			await chatThreadsService.focusCurrentChat()
			requestAnimationFrame(() => _scrollToBottom?.())
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
			await chatThreadsService.abortRunning(threadId)
			textAreaRefState?.focus()
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <VoxChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
		>
			<VoxInputBox2
				enableAtToMention
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5'
				placeholder={t("Edit your message...")}
				onChangeText={(text) => setIsDisabled(!text)}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</VoxChatArea>
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1

	return <div
		// align chatbubble accoridng to role
		className={`
        relative ml-auto
        ${mode === 'edit' ? 'w-full max-w-full'
				: mode === 'display' ? `self-end w-fit max-w-full whitespace-pre-wrap` : '' // user words should be pre
			}

        ${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50 pointer-events-none' : ''}
    `}
		onMouseEnter={() => setIsHovered(true)}
		onMouseLeave={() => setIsHovered(false)}
	>
		<div
			// style chatbubble according to role
			className={`
            text-left max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? 'px-3 py-2 gap-1 flex flex-col rounded-vox-lg rounded-br-[4px] bg-vox-accent-soft border border-transparent hover:border-vox-accent-border text-vox-fg-1 leading-relaxed overflow-x-auto cursor-pointer transition-colors duration-150' : ''
				}
        `}
			onClick={() => { if (mode === 'display') { onOpenEdit() } }}
		>
			{chatbubbleContents}
		</div>



		<div
			className="absolute -top-2 -right-1.5 translate-x-0 -translate-y-0 z-1"
		>
			<EditSymbol
				size={20}
				className={`
                    cursor-pointer
                    p-[4px]
                    text-vox-fg-2 hover:text-vox-accent-text
                    bg-vox-surface-raised border border-vox-hairline-strong rounded-full shadow-vox-sm
                    transition-[opacity,color] duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
			/>
		</div>


	</div>

}

const SmallProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-vox-fg-4
prose
prose-sm
break-words
max-w-none
leading-snug
text-[13px]

[&>:first-child]:!mt-0
[&>:last-child]:!mb-0

prose-h1:text-[14px]
prose-h1:my-4

prose-h2:text-[13px]
prose-h2:my-4

prose-h3:text-[13px]
prose-h3:my-3

prose-h4:text-[13px]
prose-h4:my-2

prose-p:my-2
prose-p:leading-snug
prose-hr:my-2

prose-ul:my-2
prose-ul:pl-4
prose-ul:list-outside
prose-ul:list-disc
prose-ul:leading-snug


prose-ol:my-2
prose-ol:pl-4
prose-ol:list-outside
prose-ol:list-decimal
prose-ol:leading-snug

marker:text-inherit

prose-blockquote:pl-2
prose-blockquote:my-2

prose-code:text-vox-fg-3
prose-code:text-[12px]
prose-code:before:content-none
prose-code:after:content-none

prose-pre:text-[12px]
prose-pre:p-2
prose-pre:my-2

prose-table:text-[13px]
'>
		{children}
	</div>
}

const ProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-vox-fg-2
prose
prose-sm
break-words
prose-p:block
prose-hr:my-4
prose-pre:my-2
marker:text-inherit
prose-ol:list-outside
prose-ol:list-decimal
prose-ul:list-outside
prose-ul:list-disc
prose-li:my-0
prose-code:before:content-none
prose-code:after:content-none
prose-headings:prose-sm
prose-headings:font-bold

prose-p:leading-normal
prose-ol:leading-normal
prose-ul:leading-normal

max-w-none
'
	>
		{children}
	</div>
}
// Token al secondo e token totali di una risposta (li riportano solo le IA locali). `≈`: stima, il motore non ha dato
// i conteggi esatti. I token del prompt si conoscono solo a fine risposta: durante la generazione manca il totale.
export const TokenStatsLine = ({ stats, className }: { stats: LLMTokenStats | undefined, className?: string }) => {
	if (!stats || !(stats.generated > 0)) return null
	const number = (value: number, digits = 0) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
	const approx = stats.exact ? '' : '≈ '
	const speedExact = stats.speedExact ?? stats.exact
	const parts = [
		stats.tokensPerSecond !== null ? t("{0} tokens/s", (speedExact ? '' : '≈ ') + number(stats.tokensPerSecond, 1)) : null,
		t("{0} tokens generated", approx + number(stats.generated)),
		stats.promptTokens !== null ? t("{0} total with the prompt", approx + number(stats.promptTokens + stats.generated)) : null,
	].filter(part => part !== null)
	return <div
		className={`text-xs text-vox-fg-3 select-text ${className ?? ''}`}
		data-vox-token-stats=''
		title={!stats.exact ? t("Estimate: the local model engine did not report exact counts.") : speedExact || stats.tokensPerSecond === null ? t("Counts reported by the local model engine.") : t("Counts reported by the local model engine; the speed is an estimate.")}
	>
		{parts.join(' · ')}
	</div>
}

const AssistantMessageComponent = ({ chatMessage, isCheckpointGhost, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }, isCheckpointGhost: boolean, messageIdx: number, isCommitted: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	const reasoningStr = chatMessage.reasoning?.trim() || null
	const hasReasoning = !!reasoningStr
	const isDoneReasoning = !!chatMessage.displayContent
	const thread = chatThreadsService.getCurrentThread()


	const chatMessageLocation: ChatMessageLocation = {
		threadId: thread.id,
		messageIdx: messageIdx,
	}

	// una risposta fatta della sola chiamata a uno strumento non ha testo, ma i suoi token si mostrano lo stesso
	const hasTokenStats = isCommitted && (chatMessage.tokenStats?.generated ?? 0) > 0
	const isEmpty = !chatMessage.displayContent && !chatMessage.reasoning && !hasTokenStats
	if (isEmpty) return null

	return <>
		{/* reasoning token */}
		{hasReasoning &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<ReasoningWrapper isDoneReasoning={isDoneReasoning} isStreaming={!isCommitted}>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={reasoningStr}
							chatMessageLocation={chatMessageLocation}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ReasoningWrapper>
			</div>
		}

		{/* assistant message */}
		{chatMessage.displayContent &&
			<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<ProseWrapper>
					<ChatMarkdownRender
						string={chatMessage.displayContent || ''}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
					/>
				</ProseWrapper>
			</div>
		}

		{/* token della risposta finita; durante la generazione la riga sta accanto all'indicatore in fondo */}
		{isCommitted ? <TokenStatsLine stats={chatMessage.tokenStats} className={`px-1 ${isCheckpointGhost ? 'opacity-50' : ''}`} /> : null}
	</>

}

const ReasoningWrapper = ({ isDoneReasoning, isStreaming, children }: { isDoneReasoning: boolean, isStreaming: boolean, children: React.ReactNode }) => {
	const isDone = isDoneReasoning || !isStreaming
	const isWriting = !isDone
	const [isOpen, setIsOpen] = useState(isWriting)
	useEffect(() => {
		if (!isWriting) setIsOpen(false) // if just finished reasoning, close
	}, [isWriting])
	return <ToolHeaderWrapper icon={<Brain size={13} className='flex-shrink-0' />} title={t("Reasoning")} desc1={isWriting ? <span className='@@vox-typing inline-flex items-center' aria-hidden='true'><span /><span /><span /></span> : ''} isOpen={isOpen} onClick={() => setIsOpen(v => !v)}>
		<ToolChildrenWrapper>
			<div className='!select-text cursor-auto'>
				{children}
			</div>
		</ToolChildrenWrapper>
	</ToolHeaderWrapper>
}




// should either be past or "-ing" tense, not present tense. Eg. when the LLM searches for something, the user expects it to say "I searched for X" or "I am searching for X". Not "I search X".

const loadingTitleWrapper = (item: React.ReactNode): React.ReactNode => {
	return <span className='flex items-center flex-nowrap'>
		{item}
		<IconLoading className='w-3 text-sm' />
	</span>
}

const titleOfBuiltinToolName = {
	'read_file': { done: t("Read file"), proposed: t("Read file"), running: loadingTitleWrapper(t("Reading file")) },
	'ls_dir': { done: t("Inspected folder"), proposed: t("Inspect folder"), running: loadingTitleWrapper(t("Inspecting folder")) },
	'get_dir_tree': { done: t("Inspected folder tree"), proposed: t("Inspect folder tree"), running: loadingTitleWrapper(t("Inspecting folder tree")) },
	'search_pathnames_only': { done: t("Searched by file name"), proposed: t("Search by file name"), running: loadingTitleWrapper(t("Searching by file name")) },
	'search_for_files': { done: t("Searched"), proposed: t("Search"), running: loadingTitleWrapper(t("Searching")) },
	'create_file_or_folder': { done: t("Created"), proposed: t("Create"), running: loadingTitleWrapper(t("Creating")) },
	'delete_file_or_folder': { done: t("Deleted"), proposed: t("Delete"), running: loadingTitleWrapper(t("Deleting")) },
	'edit_file': { done: t("Edited file"), proposed: t("Edit file"), running: loadingTitleWrapper(t("Editing file")) },
	'rewrite_file': { done: t("Wrote file"), proposed: t("Write file"), running: loadingTitleWrapper(t("Writing file")) },
	'run_command': { done: t("Ran terminal"), proposed: t("Run terminal"), running: loadingTitleWrapper(t("Running terminal")) },
	'run_persistent_command': { done: t("Ran terminal"), proposed: t("Run terminal"), running: loadingTitleWrapper(t("Running terminal")) },

	'open_persistent_terminal': { done: t("Opened terminal"), proposed: t("Open terminal"), running: loadingTitleWrapper(t("Opening terminal")) },
	'kill_persistent_terminal': { done: t("Killed terminal"), proposed: t("Kill terminal"), running: loadingTitleWrapper(t("Killing terminal")) },

	'read_lint_errors': { done: t("Read lint errors"), proposed: t("Read lint errors"), running: loadingTitleWrapper(t("Reading lint errors")) },
	'search_in_file': { done: t("Searched in file"), proposed: t("Search in file"), running: loadingTitleWrapper(t("Searching in file")) },

	'update_project_memory': { done: t("Saved to project memory"), proposed: t("Save to project memory"), running: loadingTitleWrapper(t("Saving to project memory")) },
	'update_task_list': { done: t("Updated task list"), proposed: t("Update task list"), running: loadingTitleWrapper(t("Updating task list")) },
} as const satisfies Record<BuiltinToolName, { done: any, proposed: any, running: any }>

// Vox: icona di ogni strumento, mostrata nella scheda dell'azione
const iconOfBuiltinToolName = {
	'read_file': FileText,
	'ls_dir': FolderOpen,
	'get_dir_tree': FolderTree,
	'search_pathnames_only': Search,
	'search_for_files': Search,
	'create_file_or_folder': FilePlus,
	'delete_file_or_folder': Trash2,
	'edit_file': FilePen,
	'rewrite_file': FileCode,
	'run_command': SquareTerminal,
	'run_persistent_command': SquareTerminal,
	'open_persistent_terminal': Terminal,
	'kill_persistent_terminal': Terminal,
	'read_lint_errors': AlertTriangle,
	'search_in_file': TextSearch,
	'update_project_memory': BookMarked,
	'update_task_list': ListChecks,
} as const satisfies Record<BuiltinToolName, React.ComponentType<{ size?: number, className?: string }>>

const ToolIcon = ({ name }: { name: string }) => {
	const Icon = (iconOfBuiltinToolName as Record<string, React.ComponentType<{ size?: number, className?: string }> | undefined>)[name] ?? Plug
	return <Icon size={13} className='flex-shrink-0' />
}


const getTitle = (toolMessage: Pick<ChatMessage & { role: 'tool' }, 'name' | 'type' | 'mcpServerName'>): React.ReactNode => {
	const tm = toolMessage

	// non-built-in title
	if (!builtinToolNames.includes(tm.name as BuiltinToolName)) {
		// descriptor of Running or Ran etc
		const descriptor =
			tm.type === 'success' ? t("Called")
				: tm.type === 'running_now' ? t("Calling")
					: tm.type === 'tool_request' ? t("Call")
						: tm.type === 'rejected' ? t("Call")
							: tm.type === 'invalid_params' ? t("Call")
								: tm.type === 'tool_error' ? t("Call")
									: t("Call")


		const title = `${descriptor} ${toolMessage.mcpServerName || 'MCP'}`
		if (tm.type === 'running_now' || tm.type === 'tool_request')
			return loadingTitleWrapper(title)
		return title
	}

	// built-in title
	else {
		const toolName = tm.name as BuiltinToolName
		if (tm.type === 'success') return titleOfBuiltinToolName[toolName].done
		if (tm.type === 'running_now') return titleOfBuiltinToolName[toolName].running
		return titleOfBuiltinToolName[toolName].proposed
	}
}


const toolNameToDesc = (toolName: BuiltinToolName, _toolParams: BuiltinToolCallParams[BuiltinToolName] | undefined, accessor: ReturnType<typeof useAccessor>): {
	desc1: React.ReactNode,
	desc1Info?: string,
} => {

	if (!_toolParams) {
		return { desc1: '', };
	}

	const x = {
		'read_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'ls_dir': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['ls_dir']
			return {
				desc1: getFolderName(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'search_pathnames_only': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_pathnames_only']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_for_files': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_for_files']
			return {
				desc1: `"${toolParams.query}"`,
			}
		},
		'search_in_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['search_in_file'];
			return {
				desc1: `"${toolParams.query}"`,
				desc1Info: getRelative(toolParams.uri, accessor),
			};
		},
		'create_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['create_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'delete_file_or_folder': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['delete_file_or_folder']
			return {
				desc1: toolParams.isFolder ? getFolderName(toolParams.uri.fsPath) ?? '/' : getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'rewrite_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['rewrite_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'edit_file': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['edit_file']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'run_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'run_persistent_command': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['run_persistent_command']
			return {
				desc1: `"${toolParams.command}"`,
			}
		},
		'open_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['open_persistent_terminal']
			return { desc1: '' }
		},
		'kill_persistent_terminal': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['kill_persistent_terminal']
			return { desc1: toolParams.persistentTerminalId }
		},
		'update_project_memory': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['update_project_memory']
			return { desc1: '', desc1Info: getRelative(toolParams.uri, accessor) }
		},
		'update_task_list': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['update_task_list']
			const numDone = toolParams.tasks.filter(task => task.status === 'completed').length
			return { desc1: `${numDone}/${toolParams.tasks.length}` }
		},
		'get_dir_tree': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['get_dir_tree']
			return {
				desc1: getFolderName(toolParams.uri.fsPath) ?? '/',
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		},
		'read_lint_errors': () => {
			const toolParams = _toolParams as BuiltinToolCallParams['read_lint_errors']
			return {
				desc1: getBasename(toolParams.uri.fsPath),
				desc1Info: getRelative(toolParams.uri, accessor),
			}
		}
	}

	try {
		return x[toolName]?.() || { desc1: '' }
	}
	catch {
		return { desc1: '' }
	}
}

const ToolRequestAcceptRejectButtons = ({ toolName, toolParams }: { toolName: ToolName, toolParams?: unknown }) => {
	const accessor = useAccessor()
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	// percorsi fuori dal progetto: vanno mostrati, perché gli strumenti di lettura non mostrano la richiesta
	const outsidePaths = isABuiltinToolName(toolName) && toolParams
		? urisOfBuiltinToolParams(toolParams as BuiltinToolCallParams[BuiltinToolName]).filter(uri => !workspaceContextService.isInsideWorkspace(uri)).map(uri => uri.fsPath)
		: []
	const chatThreadsService = accessor.get('IChatThreadService')
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const voxSettingsState = useSettingsState()

	const onAccept = useCallback(() => {
		try { // this doesn't need to be wrapped in try/catch anymore
			const threadId = chatThreadsService.state.currentThreadId
			chatThreadsService.approveLatestToolRequest(threadId)
		} catch (e) { console.error('Error while approving message in chat:', e) }
	}, [chatThreadsService])

	const onReject = useCallback(() => {
		try {
			const threadId = chatThreadsService.state.currentThreadId
			chatThreadsService.rejectLatestToolRequest(threadId)
		} catch (e) { console.error('Error while approving message in chat:', e) }
	}, [chatThreadsService])

	const approveButton = (
		<button
			type='button'
			onClick={onAccept}
			className='@@vox-btn @@vox-btn-primary'
		>
			<Check size={13} strokeWidth={2.5} aria-hidden='true' />
			{t("Approve")}</button>
	)

	const cancelButton = (
		<button
			type='button'
			onClick={onReject}
			className='@@vox-btn @@vox-btn-secondary'
		>
			{t("Cancel")}</button>
	)

	const approvalType = isABuiltinToolName(toolName) ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
	const approvalToggle = approvalType ? <div key={approvalType} className="flex items-center ml-2 gap-x-1">
		<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={t("Auto-approve {0}", t(approvalType))} />
	</div> : null

	// Con l'approvazione automatica attiva la richiesta compare solo se chatThreadService ha deciso di chiedere comunque:
	// il percorso passa da un collegamento, Vox non ha potuto controllarlo oppure sta nella cartella .vox del progetto.
	// Va spiegato, e l'interruttore non serve.
	const askedDespiteAutoApprove = !!approvalType && !!voxSettingsState.globalSettings.autoApprove[approvalType] && !builtinToolsThatAlwaysAsk.has(toolName) && outsidePaths.length === 0
	const buttons = <div className="flex flex-wrap gap-2 items-center">
		{approveButton}
		{cancelButton}
		{outsidePaths.length === 0 && !builtinToolsThatAlwaysAsk.has(toolName) && !askedDespiteAutoApprove ? approvalToggle : null}
	</div>
	if (outsidePaths.length === 0) {
		// Uno strumento di sola lettura con percorsi tutti dentro il progetto arriva qui solo se il percorso passa da un
		// collegamento simbolico o una giunzione, oppure se il disco non ha permesso di controllarlo (lo decide
		// chatThreadService): va detto, altrimenti i pulsanti restano senza spiegazione.
		const linkedPaths = isABuiltinToolName(toolName) && toolParams && !approvalTypeOfBuiltinToolName[toolName]
			? urisOfBuiltinToolParams(toolParams as BuiltinToolCallParams[BuiltinToolName]).map(uri => uri.fsPath)
			: []
		if (linkedPaths.length === 0 && askedDespiteAutoApprove) return <div className="flex flex-col gap-1">
			<div className="text-[11.5px] leading-snug text-vox-fg-1 bg-vox-warning-soft border border-vox-warning-border rounded-vox-md px-2.5 py-1.5">{t("This path always needs your approval: it is in the project's .vox folder, goes through a link, or Vox could not check it.")}</div>
			{buttons}
		</div>
		if (linkedPaths.length === 0) return buttons
		return <div className="flex flex-col gap-1">
			<div className="text-[11.5px] leading-snug text-vox-fg-1 bg-vox-warning-soft border border-vox-warning-border rounded-vox-md px-2.5 py-1.5">
				<div>{t("{0}: this path goes through a link that may point outside the project folder, or Vox could not check it. It always needs your approval.", titleOfBuiltinToolName[toolName as BuiltinToolName]?.proposed ?? toolName)}</div>
				{linkedPaths.map((p, i) => <div key={i} className="font-mono break-all !select-text cursor-auto">{p}</div>)}
			</div>
			{buttons}
		</div>
	}

	return <div className="flex flex-col gap-1">
		<div className="text-[11.5px] leading-snug text-vox-fg-1 bg-vox-warning-soft border border-vox-warning-border rounded-vox-md px-2.5 py-1.5">
			<div>{t("{0}: this path is outside the project folder and always needs your approval.", titleOfBuiltinToolName[toolName as BuiltinToolName]?.proposed ?? toolName)}</div>
			{outsidePaths.map((p, i) => <div key={i} className="font-mono break-all !select-text cursor-auto">{p}</div>)}
		</div>
		{buttons}
	</div>
}

export const ToolChildrenWrapper = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ? className : ''} cursor-default select-none`}>
		<div className='px-2 min-w-full overflow-hidden'>
			{children}
		</div>
	</div>
}
export const CodeChildren = ({ children, className }: { children: React.ReactNode, className?: string }) => {
	return <div className={`${className ?? ''} px-2 py-1.5 rounded-vox-md overflow-auto text-sm`}>
		<div className='!select-text cursor-auto'>
			{children}
		</div>
	</div>
}

export const ListableToolItem = ({ name, onClick, isSmall, className, showDot }: { name: React.ReactNode, onClick?: () => void, isSmall?: boolean, className?: string, showDot?: boolean }) => {
	return <div
		className={`
			${onClick ? 'hover:text-vox-fg-1 hover:bg-vox-surface-hover hover:cursor-pointer transition-colors duration-150 ' : ''}
			flex items-center flex-nowrap whitespace-nowrap rounded-vox-sm px-1.5 py-[3px] -mx-1 text-[12px]
			${className ? className : ''}
			`}
		onClick={onClick}
	>
		{showDot === false ? null : <span aria-hidden='true' className="flex-shrink-0 size-1 rounded-full bg-vox-fg-4 mr-2" />}
		<div className={`${isSmall ? 'text-vox-fg-4 flex items-center' : ''}`}>{name}</div>
	</div>
}



const EditToolChildren = ({ uri, code, type }: { uri: URI | undefined, code: string, type: 'diff' | 'rewrite' }) => {

	const content = type === 'diff' ?
		<VoxDiffEditor uri={uri} searchReplaceBlocks={code} />
		: <ChatMarkdownRender string={`\`\`\`\n${code}\n\`\`\``} codeURI={uri} chatMessageLocation={undefined} />

	return <div className='!select-text cursor-auto'>
		<SmallProseWrapper>
			{content}
		</SmallProseWrapper>
	</div>

}


const LintErrorChildren = ({ lintErrors }: { lintErrors: LintErrorItem[] }) => {
	return <div className="text-[11px] text-vox-fg-3 border-l-2 border-vox-warning rounded-r-vox-sm bg-vox-warning-soft px-2 py-1 flex flex-col gap-0.5 overflow-x-auto whitespace-nowrap">
		{lintErrors.map((error, i) => (
			<div key={i}>{t("Lines")} {error.startLineNumber}-{error.endLineNumber}: {error.message}</div>
		))}
	</div>
}

const BottomChildren = ({ children, title }: { children: React.ReactNode, title: string }) => {
	const [isOpen, setIsOpen] = useState(false);
	if (!children) return null;
	return (
		<div className="w-full px-2 py-1 border-t border-vox-hairline">
			<div
				className={`flex items-center gap-1 cursor-pointer select-none transition-colors duration-150 py-0.5 group`}
				onClick={() => setIsOpen(o => !o)}
			>
				<ChevronRight
					className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 text-vox-warning ${isOpen ? 'rotate-90' : ''}`}
				/>
				<span className="font-medium text-vox-fg-3 group-hover:text-vox-fg-1 text-[11px] transition-colors">{title}</span>
			</div>
			<div
				className={`overflow-hidden transition-all duration-200 ease-in-out ${isOpen ? 'opacity-100 mt-1' : 'max-h-0 opacity-0'} text-xs`}
			>
				<div className="overflow-x-auto text-vox-fg-3 border-l-2 border-vox-warning rounded-r-vox-sm bg-vox-warning-soft px-2 py-1">
					{children}
				</div>
			</div>
		</div>
	);
}


const EditToolHeaderButtons = ({ applyBoxId, uri, codeStr, toolName, threadId }: { threadId: string, applyBoxId: string, uri: URI, codeStr: string, toolName: 'edit_file' | 'rewrite_file' }) => {
	const { streamState } = useEditToolStreamState({ applyBoxId, uri })
	return <div className='flex items-center gap-1'>
		{/* <StatusIndicatorForApplyButton applyBoxId={applyBoxId} uri={uri} /> */}
		{/* <JumpToFileButton uri={uri} /> */}
		{streamState === 'idle-no-changes' && <CopyButton codeStr={codeStr} toolTipName={t("Copy")} />}
		<EditToolAcceptRejectButtonsHTML type={toolName} codeStr={codeStr} applyBoxId={applyBoxId} uri={uri} threadId={threadId} />
	</div>
}



const InvalidTool = ({ toolName, message, mcpServerName }: { toolName: ToolName, message: string, mcpServerName: string | undefined }) => {
	const accessor = useAccessor()
	const title = getTitle({ name: toolName, type: 'invalid_params', mcpServerName })
	const desc1 = t("Invalid parameters")
	const icon = <ToolIcon name={toolName} />
	const isError = true
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon }

	componentParams.children = <ToolChildrenWrapper>
		<CodeChildren className='bg-vox-bg-3'>
			{message}
		</CodeChildren>
	</ToolChildrenWrapper>
	return <ToolHeaderWrapper {...componentParams} />
}

const CanceledTool = ({ toolName, mcpServerName }: { toolName: ToolName, mcpServerName: string | undefined }) => {
	const accessor = useAccessor()
	const title = getTitle({ name: toolName, type: 'rejected', mcpServerName })
	const desc1 = ''
	const icon = <ToolIcon name={toolName} />
	const isRejected = true
	const componentParams: ToolHeaderParams = { title, desc1, icon, isRejected }
	return <ToolHeaderWrapper {...componentParams} />
}


const CommandTool = ({ toolMessage, type, threadId }: { threadId: string } & ({
	toolMessage: Exclude<ToolMessage<'run_command'>, { type: 'invalid_params' }>
	type: 'run_command'
} | {
	toolMessage: Exclude<ToolMessage<'run_persistent_command'>, { type: 'invalid_params' }>
	type: | 'run_persistent_command'
})) => {
	const accessor = useAccessor()

	const commandService = accessor.get('ICommandService')
	const terminalToolsService = accessor.get('ITerminalToolService')
	const toolsService = accessor.get('IToolsService')
	const isError = false
	const title = getTitle(toolMessage)
	const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
	const icon = <ToolIcon name={toolMessage.name} />
	const streamState = useChatThreadsStreamState(threadId)

	const divRef = useRef<HTMLDivElement | null>(null)

	const isRejected = toolMessage.type === 'rejected'
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }


	const effect = async (isDisposed: () => boolean): Promise<(() => void) | undefined> => {
		if (streamState?.isRunning !== 'tool') return
		if (type !== 'run_command' || toolMessage.type !== 'running_now') return;

		// wait for the interruptor so we know it's running

		await streamState?.interrupt
		if (isDisposed()) return
		const container = divRef.current;
		if (!container) return;

		const terminal = terminalToolsService.getTemporaryTerminal(toolMessage.params.terminalId);
		if (!terminal) return;

		try {
			terminal.attachToElement(container);
			terminal.setVisible(true)
		} catch {
		}

		// Listen for size changes of the container and keep the terminal layout in sync.
		const resizeObserver = new ResizeObserver((entries) => {
			const height = entries[0].borderBoxSize[0].blockSize;
			const width = entries[0].borderBoxSize[0].inlineSize;
			if (typeof terminal.layout === 'function') {
				terminal.layout({ width, height });
			}
		});

		resizeObserver.observe(container);
		return () => { try { terminal.detachFromElement() } catch { } resizeObserver.disconnect(); }
	}

	// VOX: la pulizia di `effect` arriva dentro una promessa: useEffect non la vedeva, e il terminale restava agganciato
	// a un elemento tolto (con il ResizeObserver mai scollegato). Si conserva e si chiama allo smontaggio o al cambio.
	useEffect(() => {
		let disposed = false
		let cleanup: (() => void) | undefined
		effect(() => disposed).then(c => { if (disposed) c?.(); else cleanup = c }, () => { })
		return () => { disposed = true; cleanup?.() }
	}, [terminalToolsService, toolMessage, toolMessage.type, type]);

	if (toolMessage.type === 'success') {
		const { result } = toolMessage

		// it's unclear that this is a button and not an icon.
		// componentParams.desc2 = <JumpToTerminalButton
		// 	onClick={() => { terminalToolsService.openTerminal(terminalId) }}
		// />

		let msg: string
		if (type === 'run_command') msg = toolsService.stringOfResult['run_command'](toolMessage.params, result)
		else msg = toolsService.stringOfResult['run_persistent_command'](toolMessage.params, result)

		if (type === 'run_persistent_command') {
			componentParams.info = persistentTerminalNameOfId(toolMessage.params.persistentTerminalId)
		}

		componentParams.children = <ToolChildrenWrapper className='whitespace-pre text-nowrap overflow-auto text-sm'>
			<div className='!select-text cursor-auto'>
				<BlockCode initValue={`${msg.trim()}`} language='shellscript' />
			</div>
		</ToolChildrenWrapper>
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage
		componentParams.bottomChildren = <BottomChildren title={t("Error")}>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>
	}
	else if (toolMessage.type === 'running_now') {
		if (type === 'run_command')
			componentParams.children = <div ref={divRef} className='relative h-[300px] text-sm' />
	}
	else if (toolMessage.type === 'rejected' || toolMessage.type === 'tool_request') {
	}

	return <>
		<ToolHeaderWrapper {...componentParams} isOpen={type === 'run_command' && toolMessage.type === 'running_now' ? true : undefined} />
	</>
}

type WrapperProps<T extends ToolName> = { toolMessage: Exclude<ToolMessage<T>, { type: 'invalid_params' }>, messageIdx: number, threadId: string }
const MCPToolWrapper = ({ toolMessage }: WrapperProps<string>) => {
	const accessor = useAccessor()
	const mcpService = accessor.get('IMCPService')

	const title = getTitle(toolMessage)
	const desc1 = removeMCPToolNamePrefix(toolMessage.name)
	const icon = <ToolIcon name={toolMessage.name} />


	if (toolMessage.type === 'running_now') return null // do not show running

	const isError = false
	const isRejected = toolMessage.type === 'rejected'
	const { rawParams, params } = toolMessage
	const componentParams: ToolHeaderParams = { title, desc1, isError, icon, isRejected, }

	const paramsStr = JSON.stringify(params, null, 2)
	componentParams.desc2 = <CopyButton codeStr={paramsStr} toolTipName={t("Copy inputs: {0}", paramsStr)} />

	componentParams.info = !toolMessage.mcpServerName ? t("MCP tool not found") : undefined

	// Add copy inputs button in desc2


	if (toolMessage.type === 'success' || toolMessage.type === 'tool_request') {
		const { result } = toolMessage
		const resultStr = result ? mcpService.stringifyResult(result) : 'null'
		componentParams.children = <ToolChildrenWrapper>
			<SmallProseWrapper>
				<ChatMarkdownRender
					string={`\`\`\`json\n${resultStr}\n\`\`\``}
					chatMessageLocation={undefined}
					isApplyEnabled={false}
					isLinkDetectionEnabled={true}
				/>
			</SmallProseWrapper>
		</ToolChildrenWrapper>
	}
	else if (toolMessage.type === 'tool_error') {
		const { result } = toolMessage
		componentParams.bottomChildren = <BottomChildren title={t("Error")}>
			<CodeChildren>
				{result}
			</CodeChildren>
		</BottomChildren>
	}

	return <ToolHeaderWrapper {...componentParams} />

}

// ---------- elenco dei compiti (strumento update_task_list) ----------

const TaskListItems = ({ tasks }: { tasks: ProjectTask[] }) => {
	return <div className='flex flex-col gap-1'>
		{tasks.map((task, i) => <div key={i} className='flex items-start gap-2'>
			<span className='flex-shrink-0 w-3.5 h-[1.45em] flex items-center justify-center'>
				{task.status === 'completed' ? <span className='size-3.5 rounded-full bg-vox-accent text-vox-accent-fg flex items-center justify-center'><Check size={9} strokeWidth={3.5} /></span>
					: task.status === 'in_progress' ? <span className='size-3.5 rounded-full border-2 border-vox-accent flex items-center justify-center'><span className='size-1.5 rounded-full bg-vox-accent' /></span>
						: <span className='size-3.5 rounded-full border-[1.5px] border-vox-hairline-strong' />}
			</span>
			<span className={task.status === 'completed' ? 'text-vox-fg-4 line-through' : task.status === 'in_progress' ? 'text-vox-fg-1' : 'text-vox-fg-3'}>
				{task.text}
			</span>
		</div>)}
	</div>
}

// ultimo elenco di compiti andato a buon fine nella chat; null se non c'è
const latestTaskListOfMessages = (messages: ChatMessage[], lastIdx: number): ProjectTask[] | null => {
	for (let i = Math.min(messages.length - 1, lastIdx); i >= 0; i--) {
		const m = messages[i]
		if (m.role === 'tool' && m.name === 'update_task_list' && m.type === 'success')
		{
			const tasks: unknown = (m as ToolMessage<'update_task_list'> & { type: 'success' }).params?.tasks
			// una chat salvata e poi guastata non deve far cadere il pannello
			return Array.isArray(tasks) ? tasks as ProjectTask[] : null
		}
	}
	return null
}

// pannello fisso sopra la casella di scrittura: mostra il piano finché resta qualcosa da fare
// (se l'utente è tornato a un checkpoint precedente contano solo i messaggi fino a quel punto)
const TaskListPanel = ({ messages, currCheckpointIdx }: { messages: ChatMessage[], currCheckpointIdx: number | undefined }) => {
	const tasks = useMemo(() => latestTaskListOfMessages(messages, currCheckpointIdx ?? Infinity), [messages, currCheckpointIdx])
	const [isOpen, setIsOpen] = useState(true)
	if (!tasks || tasks.length === 0) return null
	const numDone = tasks.filter(task => task.status === 'completed').length
	if (numDone === tasks.length) return null
	const current = tasks.find(task => task.status === 'in_progress')

	return <div className='mx-2 mb-1.5 px-2.5 py-2 text-xs @@vox-card shadow-vox-sm select-none @@vox-fade-up'>
		<div className='flex items-center gap-1.5 cursor-pointer text-vox-fg-2' onClick={() => setIsOpen(v => !v)}>
			<ListChecks size={13} className='flex-shrink-0 text-vox-accent-text' />
			<span className='flex-shrink-0 font-medium'>{t("Tasks")}</span>
			<span className='flex-shrink-0 text-vox-fg-4 tabular-nums'>{numDone}/{tasks.length}</span>
			{!isOpen && current ? <span className='truncate text-vox-fg-3'>· {current.text}</span> : <span className='flex-1' />}
			<ChevronRight size={13} className={`ml-auto flex-shrink-0 text-vox-fg-4 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} />
		</div>
		<div className='mt-1.5 h-1 w-full rounded-full bg-vox-hairline overflow-hidden' aria-hidden='true'>
			<div className='h-full rounded-full bg-vox-accent transition-[width] duration-300' style={{ width: `${Math.round(numDone / tasks.length * 100)}%` }} />
		</div>
		{isOpen ? <div className='mt-2 max-h-40 overflow-y-auto'>
			<TaskListItems tasks={tasks} />
		</div> : null}
	</div>
}


type ResultWrapper<T extends ToolName> =(props: WrapperProps<T>) => React.ReactNode

const builtinToolNameToComponent: { [T in BuiltinToolName]: { resultWrapper: ResultWrapper<T>, } } = {
	'read_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			let range: [number, number] | undefined = undefined
			if (toolMessage.params.startLine !== null || toolMessage.params.endLine !== null) {
				const start = toolMessage.params.startLine === null ? `1` : `${toolMessage.params.startLine}`
				const end = toolMessage.params.endLine === null ? `` : `${toolMessage.params.endLine}`
				const addStr = `(${start}-${end})`
				componentParams.desc1 += ` ${addStr}`
				range = [params.startLine || 1, params.endLine || 1]
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor, range) }
				if (result.hasNextPage && params.pageNumber === 1)  // first page
					componentParams.desc2 = t("(truncated after {0}k)", Math.round(MAX_FILE_CHARS_PAGE) / 1000)
				else if (params.pageNumber > 1) // subsequent pages
					componentParams.desc2 = t("(part {0})", params.pageNumber)
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'get_dir_tree': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = t("Only search in {0}", rel)
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.children = <ToolChildrenWrapper>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={`\`\`\`\n${result.str}\n\`\`\``}
							chatMessageLocation={undefined}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />

		}
	},
	'ls_dir': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const explorerService = accessor.get('IExplorerService')
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.uri) {
				const rel = getRelative(params.uri, accessor)
				if (rel) componentParams.info = t("Only search in {0}", rel)
			}

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.numResults = result.children?.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = !result.children || (result.children.length ?? 0) === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.children.map((child, i) => (<ListableToolItem key={i}
							name={`${child.name}${child.isDirectory ? '/' : ''}`}
							className='w-full overflow-auto'
							onClick={() => {
								voxOpenFileFn(child.uri, accessor)
								// commandService.executeCommand('workbench.view.explorer'); // open in explorer folders view instead
								// explorerService.select(child.uri, true);
							}}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={t("Results truncated ({0} remaining).", result.itemsRemaining)} isSmall={true} className='w-full overflow-auto' />
						}
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_pathnames_only': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.includePattern) {
				componentParams.info = t("Only search in {0}", params.includePattern)
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voxOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={t("Results truncated.")} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'search_for_files': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (params.searchInFolder || params.isRegex) {
				let info: string[] = []
				if (params.searchInFolder) {
					const rel = getRelative(params.searchInFolder, accessor)
					if (rel) info.push(t("Only search in {0}", rel))
				}
				if (params.isRegex) { info.push(t("Uses regex search")) }
				componentParams.info = info.join('; ')
			}

			if (toolMessage.type === 'success') {
				const { result, rawParams } = toolMessage
				componentParams.numResults = result.uris.length
				componentParams.hasNextPage = result.hasNextPage
				componentParams.children = result.uris.length === 0 ? undefined
					: <ToolChildrenWrapper>
						{result.uris.map((uri, i) => (<ListableToolItem key={i}
							name={getBasename(uri.fsPath)}
							className='w-full overflow-auto'
							onClick={() => { voxOpenFileFn(uri, accessor) }}
						/>))}
						{result.hasNextPage &&
							<ListableToolItem name={t("Results truncated.")} isSmall={true} className='w-full overflow-auto' />
						}

					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			return <ToolHeaderWrapper {...componentParams} />
		}
	},

	'search_in_file': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor();
			const toolsService = accessor.get('IToolsService');
			const title = getTitle(toolMessage);
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor);
			const icon = <ToolIcon name={toolMessage.name} />;

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const { rawParams, params } = toolMessage;
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected };

			const infoarr: string[] = []
			const uriStr = getRelative(params.uri, accessor)
			if (uriStr) infoarr.push(uriStr)
			if (params.isRegex) infoarr.push(t("Uses regex search"))
			componentParams.info = infoarr.join('; ')

			if (toolMessage.type === 'success') {
				const { result } = toolMessage; // result is array of snippets
				componentParams.numResults = result.lines.length;
				componentParams.children = result.lines.length === 0 ? undefined :
					<ToolChildrenWrapper>
						<CodeChildren className='bg-vox-bg-3'>
							<pre className='font-mono whitespace-pre'>
								{toolsService.stringOfResult['search_in_file'](params, result)}
							</pre>
						</CodeChildren>
					</ToolChildrenWrapper>
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage;
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />;
		}
	},

	'read_lint_errors': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')

			const title = getTitle(toolMessage)

			const { uri } = toolMessage.params ?? {}
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
				if (result.lintErrors)
					componentParams.children = <LintErrorChildren lintErrors={result.lintErrors} />
				else
					componentParams.children = t("No lint errors found.")

			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				// JumpToFileButton removed in favor of FileLinkText
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},

	// ---

	'create_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />


			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				// nothing more is needed
			}
			else if (toolMessage.type === 'tool_request') {
				// nothing more is needed
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'delete_file_or_folder': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const isFolder = toolMessage.params?.isFolder ?? false
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const title = getTitle(toolMessage)
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const icon = <ToolIcon name={toolMessage.name} />

			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			componentParams.info = getRelative(params.uri, accessor) // full path

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'rejected') {
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				if (params) { componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) } }
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}
			else if (toolMessage.type === 'running_now') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_request') {
				const { result } = toolMessage
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}

			return <ToolHeaderWrapper {...componentParams} />
		}
	},
	'rewrite_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.newContent} />
		}
	},
	'edit_file': {
		resultWrapper: (params) => {
			return <EditTool {...params} content={params.toolMessage.params.searchReplaceBlocks} />
		}
	},

	// ---

	'run_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_command' />
		}
	},

	'run_persistent_command': {
		resultWrapper: (params) => {
			return <CommandTool {...params} type='run_persistent_command' />
		}
	},
	'open_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			const relativePath = params.cwd ? getRelative(URI.file(params.cwd), accessor) : ''
			componentParams.info = relativePath ? t("Running in {0}", relativePath) : undefined

			if (toolMessage.type === 'success') {
				const { result } = toolMessage
				const { persistentTerminalId } = result
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'kill_persistent_terminal': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const terminalToolsService = accessor.get('ITerminalToolService')

			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = <ToolIcon name={toolMessage.name} />

			if (toolMessage.type === 'tool_request') return null // do not show past requests
			if (toolMessage.type === 'running_now') return null // do not show running

			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { rawParams, params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			if (toolMessage.type === 'success') {
				const { persistentTerminalId } = params
				componentParams.desc1 = persistentTerminalNameOfId(persistentTerminalId)
				componentParams.onClick = () => terminalToolsService.focusPersistentTerminal(persistentTerminalId)
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'update_project_memory': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const commandService = accessor.get('ICommandService')
			const { desc1, desc1Info } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = <ToolIcon name={toolMessage.name} />
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, desc1Info, isError, icon, isRejected, }

			// la nota si vede sempre, anche prima della conferma: l'utente deve sapere cosa viene ricordato
			componentParams.children = <ToolChildrenWrapper>
				<div className='whitespace-pre-wrap break-words'>{params.note}</div>
			</ToolChildrenWrapper>
			componentParams.isOpen = toolMessage.type === 'tool_request' || toolMessage.type === 'running_now' ? true : undefined

			if (toolMessage.type === 'success') {
				componentParams.onClick = () => { voxOpenFileFn(params.uri, accessor) }
			}
			else if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
	'update_task_list': {
		resultWrapper: ({ toolMessage }) => {
			const accessor = useAccessor()
			const { desc1 } = toolNameToDesc(toolMessage.name, toolMessage.params, accessor)
			const title = getTitle(toolMessage)
			const icon = <ToolIcon name={toolMessage.name} />
			const isError = false
			const isRejected = toolMessage.type === 'rejected'
			const { params } = toolMessage
			const componentParams: ToolHeaderParams = { title, desc1, isError, icon, isRejected, }

			componentParams.children = <ToolChildrenWrapper>
				<TaskListItems tasks={params.tasks} />
			</ToolChildrenWrapper>

			if (toolMessage.type === 'tool_error') {
				const { result } = toolMessage
				componentParams.bottomChildren = <BottomChildren title={t("Error")}>
					<CodeChildren>
						{result}
					</CodeChildren>
				</BottomChildren>
			}

			return <ToolHeaderWrapper {...componentParams} />
		},
	},
};


const Checkpoint = ({ message, threadId, messageIdx, isCheckpointGhost, threadIsRunning }: { message: CheckpointEntry, threadId: string; messageIdx: number, isCheckpointGhost: boolean, threadIsRunning: boolean }) => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const streamState = useFullChatThreadsStreamState()

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning
	const isDisabled = useMemo(() => {
		if (isRunning) return true
		return !!Object.keys(streamState).find((threadId2) => streamState[threadId2]?.isRunning)
	}, [isRunning, streamState])

	return <div
		className={`flex items-center gap-2 px-1 ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}`}
	>
		<span aria-hidden='true' className='flex-1 h-px bg-vox-hairline' />
		<div
			className={`
                    group inline-flex items-center gap-1.5
                    text-[11px] px-2 py-0.5 rounded-full
                    text-vox-fg-4 border border-vox-hairline
                    select-none transition-colors duration-150
					${isDisabled ? 'cursor-default' : 'cursor-pointer hover:text-vox-accent-text hover:border-vox-accent-border hover:bg-vox-accent-softer'}
                `}
			onClick={() => {
				if (threadIsRunning) return
				if (isDisabled) return
				chatThreadService.jumpToCheckpointBeforeMessageIdx({
					threadId,
					messageIdx,
					jumpToUserModified: messageIdx === (chatThreadService.state.allThreads[threadId]?.messages.length ?? 0) - 1
				})
			}}
			{...isDisabled ? {
				'data-tooltip-id': 'vox-tooltip',
				'data-tooltip-content': t("Disabled {0}", isRunning ? t("when running") : t("because another thread is running")),
				'data-tooltip-place': 'top',
			} : {}}
		>
			<Flag size={10} aria-hidden='true' className='flex-shrink-0' />
			{t("Checkpoint")}</div>
		<span aria-hidden='true' className='flex-1 h-px bg-vox-hairline' />
	</div>
}


type ChatBubbleMode = 'display' | 'edit'
type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	chatIsRunning: IsRunningType,
	threadId: string,
	currCheckpointIdx: number | undefined,
	_scrollToBottom: (() => void) | null,
}

const ChatBubble = (props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<_ChatBubble {...props} />
	</ErrorBoundary>
}

const _ChatBubble = ({ threadId, chatMessage, currCheckpointIdx, isCommitted, messageIdx, chatIsRunning, _scrollToBottom }: ChatBubbleProps) => {
	const role = chatMessage.role

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning // whether to show as gray (if chat is running, for good measure just dont show any ghosts)

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>
	}
	else if (role === 'tool') {

		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>
		}

		const toolName = chatMessage.name
		const isBuiltInTool = isABuiltinToolName(toolName)
		const ToolResultWrapper = isBuiltInTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: MCPToolWrapper as ResultWrapper<ToolName>

		if (ToolResultWrapper)
			return <>
				<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{chatMessage.type === 'tool_request' ?
					<div className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''}`}>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} toolParams={chatMessage.params} />
					</div> : null}
			</>
		return null
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>
	}

	else if (role === 'checkpoint') {
		return <Checkpoint
			threadId={threadId}
			message={chatMessage}
			messageIdx={messageIdx}
			isCheckpointGhost={isCheckpointGhost}
			threadIsRunning={!!chatIsRunning}
		/>
	}

}

const CommandBarInChat = () => {
	const { stateOfURI: commandBarStateOfURI, sortedURIs: sortedCommandBarURIs } = useCommandBarState()
	const numFilesChanged = sortedCommandBarURIs.length

	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')
	const commandService = accessor.get('ICommandService')
	const chatThreadsState = useChatThreadsState()
	const commandBarState = useCommandBarState()
	const chatThreadsStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)

	// (
	// 	<IconShell1
	// 		Icon={CopyIcon}
	// 		onClick={copyChatToClipboard}
	// 		data-tooltip-id='vox-tooltip'
	// 		data-tooltip-place='top'
	// 		data-tooltip-content='Copy chat JSON'
	// 	/>
	// )

	const [fileDetailsOpenedState, setFileDetailsOpenedState] = useState<'auto-opened' | 'auto-closed' | 'user-opened' | 'user-closed'>('auto-closed');
	const isFileDetailsOpened = fileDetailsOpenedState === 'auto-opened' || fileDetailsOpenedState === 'user-opened';


	useEffect(() => {
		// close the file details if there are no files
		// this converts 'user-closed' to 'auto-closed'
		if (numFilesChanged === 0) {
			setFileDetailsOpenedState('auto-closed')
		}
		// open the file details if it hasnt been closed
		if (numFilesChanged > 0 && fileDetailsOpenedState !== 'user-closed') {
			setFileDetailsOpenedState('auto-opened')
		}
	}, [fileDetailsOpenedState, setFileDetailsOpenedState, numFilesChanged])


	const isFinishedMakingThreadChanges = (
		// there are changed files
		commandBarState.sortedURIs.length !== 0
		// none of the files are streaming
		&& commandBarState.sortedURIs.every(uri => !commandBarState.stateOfURI[uri.fsPath]?.isStreaming)
	)

	// ======== status of agent ========
	// This icon answers the question "is the LLM doing work on this thread?"
	// assume it is single threaded for now
	// green = Running
	// orange = Requires action
	// dark = Done

	const threadStatus = (
		chatThreadsStreamState?.isRunning === 'awaiting_user' ? { title: t("Needs Approval"), color: 'yellow', } as const
			: chatThreadsStreamState?.isRunning ? { title: t("Running"), color: 'orange', } as const
				: { title: t("Done"), color: 'dark', } as const
	)


	const threadStatusHTML = <StatusIndicator className='mx-1' indicatorColor={threadStatus.color} title={threadStatus.title} />


	// ======== info about changes ========
	// num files changed
	// acceptall + rejectall
	// popup info about each change (each with num changes + acceptall + rejectall of their own)

	const numFilesChangedStr = numFilesChanged === 0 ? t("No files with changes")
		: t("{0} files with changes", sortedCommandBarURIs.length)




	const acceptRejectAllButtons = <div
		// do this with opacity so that the height remains the same at all times
		className={`flex items-center gap-0.5
			${isFinishedMakingThreadChanges ? '' : 'opacity-0 pointer-events-none'}`
		}
	>
		<IconShell1 // RejectAllButtonWrapper
			// nascosti finché la chat sta ancora modificando i file: disattivati, così il Tab non li raggiunge
			disabled={!isFinishedMakingThreadChanges}
			// text="Reject All"
			// className="text-xs"
			Icon={X}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "reject",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='vox-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={t("Reject all")}
		/>

		<IconShell1 // AcceptAllButtonWrapper
			// nascosti finché la chat sta ancora modificando i file: disattivati, così il Tab non li raggiunge
			disabled={!isFinishedMakingThreadChanges}
			// text="Accept All"
			// className="text-xs"
			Icon={Check}
			onClick={() => {
				sortedCommandBarURIs.forEach(uri => {
					editCodeService.acceptOrRejectAllDiffAreas({
						uri,
						removeCtrlKs: true,
						behavior: "accept",
						_addToHistory: true,
					});
				});
			}}
			data-tooltip-id='vox-tooltip'
			data-tooltip-place='top'
			data-tooltip-content={t("Accept all")}
		/>



	</div>


	// !select-text cursor-auto
	const fileDetailsContent = <div className="px-1 py-1 flex flex-col gap-px w-full overflow-y-auto">
		{sortedCommandBarURIs.map((uri, i) => {
			const basename = getBasename(uri.fsPath)

			const { sortedDiffIds, isStreaming } = commandBarStateOfURI[uri.fsPath] ?? {}
			const isFinishedMakingFileChanges = !isStreaming

			const numDiffs = sortedDiffIds?.length || 0

			const fileStatus = (isFinishedMakingFileChanges
				? { title: t("Done"), color: 'dark', } as const
				: { title: t("Running"), color: 'orange', } as const
			)

			const fileNameHTML = <div
				className="flex items-center gap-1.5 min-w-0 text-vox-fg-2 hover:text-vox-accent-text transition-colors duration-150 cursor-pointer"
				onClick={() => voxOpenFileFn(uri, accessor)}
			>
				<FileIcon size={12} className="flex-shrink-0 text-vox-fg-4" />
				<span className="truncate">{basename}</span>
			</div>




			const detailsContent = <div className='flex pl-2 flex-shrink-0'>
				<span className="text-vox-fg-4 tabular-nums">{t(numDiffs === 1 ? "{0} change" : "{0} changes", numDiffs)}</span>
			</div>

			const acceptRejectButtons = <div
				// do this with opacity so that the height remains the same at all times
				className={`flex items-center gap-0.5
					${isFinishedMakingFileChanges ? '' : 'opacity-0 pointer-events-none'}
				`}
			>
				{/* <JumpToFileButton
					uri={uri}
					data-tooltip-id='vox-tooltip'
					data-tooltip-place='top'
					data-tooltip-content='Go to file'
				/> */}
				<IconShell1 // RejectAllButtonWrapper
					Icon={X}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "reject", _addToHistory: true, }); }}
					data-tooltip-id='vox-tooltip'
					data-tooltip-place='top'
					data-tooltip-content={t("Reject file")}

				/>
				<IconShell1 // AcceptAllButtonWrapper
					Icon={Check}
					onClick={() => { editCodeService.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: true, behavior: "accept", _addToHistory: true, }); }}
					data-tooltip-id='vox-tooltip'
					data-tooltip-place='top'
					data-tooltip-content={t("Accept file")}
				/>

			</div>

			const fileStatusHTML = <StatusIndicator className='mx-1' indicatorColor={fileStatus.color} title={fileStatus.title} />

			return (
				// name, details
				<div key={i} className="flex justify-between items-center gap-2 px-1.5 py-0.5 rounded-vox-sm hover:bg-vox-surface-hover transition-colors duration-150">
					<div className="flex items-center min-w-0">
						{fileNameHTML}
						{detailsContent}
					</div>
					<div className="flex items-center gap-2">
						{acceptRejectButtons}
						{fileStatusHTML}
					</div>
				</div>
			)
		})}
	</div>

	const fileDetailsButton = (
		<button
			className={`flex items-center gap-1.5 rounded-vox-sm px-1 py-0.5 -ml-1 ${numFilesChanged === 0 ? 'cursor-default' : 'cursor-pointer text-vox-fg-2 hover:text-vox-fg-1 hover:bg-vox-surface-hover transition-colors duration-150'}`}
			onClick={() => isFileDetailsOpened ? setFileDetailsOpenedState('user-closed') : setFileDetailsOpenedState('user-opened')}
			type='button'
			disabled={numFilesChanged === 0}
		>
			<svg
				className="transition-transform duration-200 size-3.5"
				style={{
					transform: isFileDetailsOpened ? 'rotate(0deg)' : 'rotate(180deg)',
					transition: 'transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)'
				}}
				xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline>
			</svg>
			{numFilesChangedStr}
		</button>
	)

	return (
		<>
			{/* file details */}
			<div className='px-2'>
				<div
					className={`
						select-none
						flex w-full rounded-t-vox-lg bg-vox-surface
						text-vox-fg-3 text-xs text-nowrap
						border-vox-hairline
						overflow-hidden transition-all duration-200 ease-in-out
						${isFileDetailsOpened ? 'max-h-24 border-t border-l border-r' : 'max-h-0'}
					`}
				>
					{fileDetailsContent}
				</div>
			</div>
			{/* main content */}
			<div
				className={`
					select-none
					flex w-full rounded-t-vox-lg bg-vox-surface
					text-vox-fg-3 text-xs text-nowrap
					border-t border-l border-r border-vox-hairline

					px-2.5 py-1
					justify-between items-center
				`}
			>
				<div className="flex gap-2 items-center">
					{fileDetailsButton}
				</div>
				<div className="flex gap-2 items-center">
					{acceptRejectAllButtons}
					{threadStatusHTML}
				</div>
			</div>
		</>
	)
}



const EditToolSoFar = ({ toolCallSoFar, }: { toolCallSoFar: RawToolCallObj }) => {

	if (!isABuiltinToolName(toolCallSoFar.name)) return null

	const accessor = useAccessor()

	const uri = toolCallSoFar.rawParams.uri ? URI.file(toolCallSoFar.rawParams.uri) : undefined

	const title = titleOfBuiltinToolName[toolCallSoFar.name].proposed

	const uriDone = toolCallSoFar.doneParams.includes('uri')
	const desc1 = <span className='flex items-center'>
		{uriDone ?
			getBasename(toolCallSoFar.rawParams['uri'] ?? 'unknown')
			: t("Generating")}
		<IconLoading />
	</span>

	const desc1OnClick = () => { uri && voxOpenFileFn(uri, accessor) }

	// If URI has not been specified
	return <ToolHeaderWrapper
		title={title}
		desc1={desc1}
		desc1OnClick={desc1OnClick}
	>
		<EditToolChildren
			uri={uri}
			code={toolCallSoFar.rawParams.search_replace_blocks ?? toolCallSoFar.rawParams.new_content ?? ''}
			type={'rewrite'} // as it streams, show in rewrite format, don't make a diff editor
		/>
		<IconLoading />
	</ToolHeaderWrapper>

}


export const SidebarChat = () => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const currentThread = chatThreadsService.getCurrentThread()
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	// stream state
	const currThreadStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)
	const isRunning = currThreadStreamState?.isRunning
	const latestError = currThreadStreamState?.error
	const { displayContentSoFar, toolCallSoFar, reasoningSoFar, statusSoFar, tokenStatsSoFar } = currThreadStreamState?.llmInfo ?? {}

	// this is just if it's currently being generated, NOT if it's currently running
	const toolIsGenerating = toolCallSoFar && !toolCallSoFar.isDone // show loading for slow tools (right now just edit)

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = ''
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal)

	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState)

	const sidebarRef = useRef<HTMLDivElement>(null)
	const scrollContainerRef = useRef<HTMLDivElement | null>(null)
	const onSubmit = useCallback(async (_forceSubmit?: string) => {

		if (isDisabled && !_forceSubmit) return
		if (isRunning) return

		const threadId = chatThreadsService.state.currentThreadId

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''

		// il testo passa nella conversazione: da qui non è più la prossima richiesta del contesto (altrimenti, finché la
		// casella non si svuota dopo l'invio, la misura lo conterebbe due volte)
		clearTimeout(draftTimerRef.current)
		setChatDraft(threadId, '')

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		}

		setSelections([]) // clear staging
		textAreaFnsRef.current?.setValue('')
		textAreaRef.current?.focus() // focus input after submit

	}, [chatThreadsService, isDisabled, isRunning, textAreaRef, textAreaFnsRef, setSelections, settingsState])

	const onAbort = async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
		textAreaRef.current?.focus()
	}

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VOX_CTRL_L_ACTION_ID)?.getLabel()

	const threadId = currentThread.id
	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined  // if not exist, treat like checkpoint is last message (infinity)



	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: () => scrollToBottom(scrollContainerRef),
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollContainerRef, isResolved])




	const previousMessagesHTML = useMemo(() => {
		// const lastMessageIdx = previousMessages.findLastIndex(v => v.role !== 'checkpoint')
		// tool request shows up as Editing... if in progress
		return previousMessages.map((message, i) => {
			return <ChatBubble
				key={i}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={message}
				messageIdx={i}
				isCommitted={true}
				chatIsRunning={isRunning}
				threadId={threadId}
				_scrollToBottom={() => scrollToBottom(scrollContainerRef)}
			/>
		})
	}, [previousMessages, threadId, currCheckpointIdx, isRunning])

	const streamingChatIdx = previousMessagesHTML.length
	const currStreamingMessageHTML = reasoningSoFar || displayContentSoFar || isRunning ?
		<ChatBubble
			key={'curr-streaming-msg'}
			currCheckpointIdx={currCheckpointIdx}
			chatMessage={{
				role: 'assistant',
				displayContent: displayContentSoFar || (reasoningSoFar ? '' : statusSoFar) || '',
				reasoning: reasoningSoFar ?? '',
			}}
			messageIdx={streamingChatIdx}
			isCommitted={false}
			chatIsRunning={isRunning}

			threadId={threadId}
			_scrollToBottom={null}
		/> : null


	// the tool currently being generated
	const generatingTool = toolIsGenerating ?
		toolCallSoFar.name === 'edit_file' || toolCallSoFar.name === 'rewrite_file' ? <EditToolSoFar
			key={'curr-streaming-tool'}
			toolCallSoFar={toolCallSoFar}
		/>
			: null
		: null

	const messagesHTML = <ScrollToBottomContainer
		key={'messages' + chatThreadsState.currentThreadId} // force rerender on all children if id changes
		scrollContainerRef={scrollContainerRef}
		className={`
			flex flex-col
			px-4 py-4 space-y-4
			w-full h-full
			overflow-x-hidden
			overflow-y-auto
			${previousMessagesHTML.length === 0 && !displayContentSoFar ? 'hidden' : ''}
		`}
	>
		{/* previous messages */}
		{previousMessagesHTML}
		{currStreamingMessageHTML}

		{/* Generating tool */}
		{generatingTool}

		{/* loading indicator */}
		{isRunning === 'LLM' || isRunning === 'idle' && !toolIsGenerating ? <div className='flex items-center gap-3'>
			<div
				className='@@vox-typing flex items-center h-5 px-1'
				role='status'
				aria-label={t("Generating")}
			>
				<span /><span /><span />
			</div>
			{/* token al secondo e token generati mentre il modello scrive (anche durante una chiamata a uno strumento) */}
			{isRunning === 'LLM' ? <TokenStatsLine stats={tokenStatsSoFar} /> : null}
		</div> : null}


		{/* error message */}
		{latestError === undefined ? null :
			<div className='px-2 my-1'>
				<ErrorDisplay
					message={latestError.message}
					fullError={latestError.fullError}
					onDismiss={() => { chatThreadsService.dismissStreamError(currentThread.id) }}
					showDismiss={true}
				/>

				<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(VOX_OPEN_SETTINGS_ACTION_ID) }} text={t("Open settings")} />
			</div>
		}
	</ScrollToBottomContainer>


	// il testo scritto arriva al contesto della chat (la riga qui sotto e la scheda centrale) con un ritardo: niente
	// misure a ogni tasto. La bozza porta la sua conversazione; la casella rinasce vuota a ogni cambio di conversazione.
	const draftThreadIdRef = useRef(currentThread.id)
	draftThreadIdRef.current = currentThread.id
	const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => {
		clearTimeout(draftTimerRef.current)
		setChatDraft(currentThread.id, initVal)
	}, [currentThread.id])
	useEffect(() => () => clearTimeout(draftTimerRef.current), [])
	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
		clearTimeout(draftTimerRef.current)
		const threadId = draftThreadIdRef.current
		draftTimerRef.current = setTimeout(() => setChatDraft(threadId, newStr), 300)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isRunning])

	const inputChatArea = <VoxChatArea
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={!!isRunning}
		isDisabled={isDisabled}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { textAreaRef.current?.focus() }}
	>
		<VoxInputBox2
			enableAtToMention
			className={`min-h-[81px] px-0.5 py-0.5`}
			placeholder={keybindingString ? t("@ to mention, {0} to add a selection. Enter instructions...", keybindingString) : t("@ to mention, Enter instructions...")}
			onChangeText={onChangeText}
			onKeyDown={onKeyDown}
			onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
			ref={textAreaRef}
			fnsRef={textAreaFnsRef}
			multiline={true}
		/>

	</VoxChatArea>


	const isLandingPage = previousMessages.length === 0


	const initiallySuggestedPromptsHTML = <div className='flex flex-col gap-1.5 w-full select-none'>
		{([
			[t("Summarize my codebase"), BookOpen],
			[t("How do types work in Rust?"), Lightbulb],
			[t("Create a .voxrules file for Vox"), FilePlus],
		] as const).map(([text, Icon], index) => (
			<button
				type='button'
				key={index}
				className='@@vox-card @@vox-card-interactive group flex items-center gap-2.5 w-full text-left px-3 py-2 text-[12.5px] text-vox-fg-2'
				onClick={() => onSubmit(text)}
			>
				<span aria-hidden='true' className='flex-shrink-0 size-6 rounded-vox-sm bg-vox-accent-soft text-vox-accent-text flex items-center justify-center'>
					<Icon size={13} />
				</span>
				<span className='truncate group-hover:text-vox-fg-1 transition-colors'>{text}</span>
				<ArrowUp size={13} aria-hidden='true' className='ml-auto flex-shrink-0 rotate-45 text-vox-fg-4 opacity-0 group-hover:opacity-100 transition-opacity' />
			</button>
		))}
	</div>



	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId}>
		<TaskListPanel messages={previousMessages} currCheckpointIdx={currCheckpointIdx} />
		<ContextUsageLine threadId={chatThreadsState.currentThreadId} messages={previousMessages} selections={selections} />
		<div className='px-4'>
			<CommandBarInChat />
		</div>
		<div className='px-2 pb-2'>
			{inputChatArea}
		</div>
	</div>

	const landingPageInput = <div>
		<div className='pt-7 pb-4 flex flex-col items-start gap-2 select-none @@vox-fade-up'>
			<span aria-hidden='true' className='size-9 rounded-vox-lg bg-vox-accent-soft border border-vox-accent-border text-vox-accent-text flex items-center justify-center'>
				<Sparkles size={17} />
			</span>
			<div>
				<div className='text-[15px] font-semibold text-vox-fg-1 leading-tight'>{t("What are we building today?")}</div>
				<div className='text-[12px] text-vox-fg-3 mt-1 leading-snug'>{t("Ask a question, or switch to Agent mode to let Vox edit files and run commands for you.")}</div>
			</div>
		</div>
		<div>
			{inputChatArea}
		</div>
		<div className='flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 px-1 text-[11px] text-vox-fg-4 select-none'>
			<span className='inline-flex items-center gap-1'><kbd className='@@vox-kbd'>{t("Enter")}</kbd>{t("to send")}</span>
			<span className='inline-flex items-center gap-1'><kbd className='@@vox-kbd'>{t("Shift")}</kbd>+<kbd className='@@vox-kbd'>{t("Enter")}</kbd>{t("new line")}</span>
			<span className='inline-flex items-center gap-1'><kbd className='@@vox-kbd'>@</kbd>{t("to mention a file")}</span>
		</div>
	</div>

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full max-h-full flex flex-col overflow-auto px-4 pb-4'
	>
		<ErrorBoundary>
			{landingPageInput}
		</ErrorBoundary>

		{Object.keys(chatThreadsState.allThreads).length > 1 ? // show if there are threads
			<ErrorBoundary>
				<div className='pt-7 mb-2 @@vox-eyebrow flex items-center gap-1.5 select-none pointer-events-none'><History size={12} aria-hidden='true' />{t("Previous Threads")}</div>
				<PastThreadsList />
			</ErrorBoundary>
			:
			<ErrorBoundary>
				<div className='pt-7 mb-2 @@vox-eyebrow flex items-center gap-1.5 select-none pointer-events-none'><Lightbulb size={12} aria-hidden='true' />{t("Suggestions")}</div>
				{initiallySuggestedPromptsHTML}
			</ErrorBoundary>
		}
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full flex flex-col overflow-hidden'
	>

		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>


	return (
		<Fragment key={threadId} // force rerender when change thread
		>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	)
}
