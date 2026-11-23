/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useCommandBarState, useCommandBarURIListener, useSettingsState } from '../util/services.js'
import { usePromise, useRefState } from '../util/helpers.js'
import { isFeatureNameDisabled } from '../../../../common/voxSettingsTypes.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { FileSymlink, LucideIcon, RotateCw, Terminal } from 'lucide-react'
import { Check, X, Square, Copy, Play, } from 'lucide-react'
import { getBasename, ListableToolItem, voxOpenFileFn, ToolChildrenWrapper } from '../sidebar-tsx/SidebarChat.js'
import { PlacesType, VariantType } from 'react-tooltip'

enum CopyButtonText {
	Idle = 'Copy',
	Copied = 'Copied!',
	Error = 'Could not copy',
}


type IconButtonProps = {
	Icon: LucideIcon
}

export const IconShell1 = ({ onClick, Icon, disabled, className, ...props }: IconButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	// VOX: un pulsante con la sola icona prende come nome accessibile il testo del suo suggerimento
	const tooltip = (props as Record<string, unknown>)['data-tooltip-content']
	// misura e spazio interno predefiniti solo se chi lo usa non ne dà altri: due classi `size-` insieme non si sa quale vinca.
	// scope-tailwind aggiunge il prefisso `vox-` alle classi scritte nei componenti, quindi qui arrivano come `vox-size-…`
	const hasOwnSize = /(^|\s)(vox-)?size-/.test(className ?? '')

	return <button
		aria-label={typeof tooltip === 'string' && tooltip ? tooltip : undefined}
		disabled={disabled}
		onClick={(e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick?.(e);
		}}
		// border border-vox-border-1 rounded
		className={`
		${hasOwnSize ? '' : 'size-[22px] p-[4px]'}
		flex items-center justify-center
		rounded-vox-sm
		text-sm text-vox-fg-3
		hover:text-vox-fg-1 hover:bg-vox-surface-hover
		transition-colors duration-150
		disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent
		${className}
        `}
		{...props}
	>
		{/* l'icona riempie lo spazio interno del pulsante, invece dei suoi 24px predefiniti che uscivano dal bordo */}
		<Icon className='size-full' />
	</button>
}


// export const IconShell2 = ({ onClick, title, Icon, disabled, className }: IconButtonProps) => (
// 	<button
// 		title={title}
// 		disabled={disabled}
// 		onClick={onClick}
// 		className={`
//             size-[24px]
//             flex items-center justify-center
//             text-sm
//             hover:opacity-80
//             disabled:opacity-50 disabled:cursor-not-allowed
//             ${className}
//         `}
// 	>
// 		<Icon size={16} />
// 	</button>
// )

const COPY_FEEDBACK_TIMEOUT = 1500 // amount of time to say 'Copied!'

export const CopyButton = ({ codeStr, toolTipName }: { codeStr: string | (() => Promise<string> | string), toolTipName: string }) => {
	const accessor = useAccessor()

	const clipboardService = accessor.get('IClipboardService')
	const [copyButtonText, setCopyButtonText] = useState(CopyButtonText.Idle)

	useEffect(() => {
		if (copyButtonText === CopyButtonText.Idle) return
		setTimeout(() => {
			setCopyButtonText(CopyButtonText.Idle)
		}, COPY_FEEDBACK_TIMEOUT)
	}, [copyButtonText])

	const onCopy = useCallback(async () => {
		clipboardService.writeText(typeof codeStr === 'string' ? codeStr : await codeStr())
			.then(() => { setCopyButtonText(CopyButtonText.Copied) })
			.catch(() => { setCopyButtonText(CopyButtonText.Error) })
	}, [clipboardService, codeStr, setCopyButtonText])

	return <IconShell1
		Icon={copyButtonText === CopyButtonText.Copied ? Check : copyButtonText === CopyButtonText.Error ? X : Copy}
		onClick={onCopy}
		{...tooltipPropsForApplyBlock({ tooltipName: toolTipName })}
	/>
}




export const JumpToFileButton = ({ uri, ...props }: { uri: URI | 'current' } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')

	const jumpToFileButton = uri !== 'current' && (
		<IconShell1
			Icon={FileSymlink}
			onClick={() => {
				voxOpenFileFn(uri, accessor)
			}}
			{...tooltipPropsForApplyBlock({ tooltipName: t("Go to file") })}
			{...props}
		/>
	)
	return jumpToFileButton
}



export const JumpToTerminalButton = ({ onClick }: { onClick: () => void }) => {
	return (
		<IconShell1
			Icon={Terminal}
			onClick={onClick}
		/>
	)
}


// state persisted for duration of react only
// TODO change this to use type `ChatThreads.applyBoxState[applyBoxId]`
const _applyingURIOfApplyBoxIdRef: { current: { [applyBoxId: string]: URI | undefined } } = { current: {} }

const getUriBeingApplied = (applyBoxId: string) => {
	return _applyingURIOfApplyBoxIdRef.current[applyBoxId] ?? null
}


export const useApplyStreamState = ({ applyBoxId }: { applyBoxId: string }) => {
	const accessor = useAccessor()
	const voxCommandBarService = accessor.get('IVoxCommandBarService')

	const getStreamState = useCallback(() => {
		const uri = getUriBeingApplied(applyBoxId)
		if (!uri) return 'idle-no-changes'
		return voxCommandBarService.getStreamState(uri)
	}, [voxCommandBarService, applyBoxId])


	const [currStreamStateRef, setStreamState] = useRefState(getStreamState())

	const setApplying = useCallback((uri: URI | undefined) => {
		_applyingURIOfApplyBoxIdRef.current[applyBoxId] = uri ?? undefined
		setStreamState(getStreamState())
	}, [setStreamState, getStreamState, applyBoxId])

	// listen for stream updates on this box
	useCommandBarURIListener(useCallback((uri_) => {
		const uri = getUriBeingApplied(applyBoxId)
		if (uri?.fsPath === uri_.fsPath) {
			setStreamState(getStreamState())
		}
	}, [setStreamState, applyBoxId, getStreamState]))


	return { currStreamStateRef, setApplying }
}


type IndicatorColor = 'green' | 'orange' | 'dark' | 'yellow' | null
export const StatusIndicator = ({ indicatorColor, title, className, ...props }: { indicatorColor: IndicatorColor, title?: React.ReactNode, className?: string } & React.HTMLAttributes<HTMLDivElement>) => {
	return (
		<div className={`flex flex-row text-vox-fg-3 text-xs items-center gap-1.5 ${className}`} {...props}>
			{title && <span className='opacity-80'>{title}</span>}
			<div
				className={` size-2 rounded-full border
					${indicatorColor === 'dark' ? 'bg-transparent border-vox-hairline-strong' :
						indicatorColor === 'orange' ? 'bg-vox-accent border-vox-accent shadow-[0_0_0_3px_var(--vox-accent-soft)] motion-safe:animate-pulse' :
							indicatorColor === 'green' ? 'bg-vox-success border-vox-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--vox-success)_20%,transparent)]' :
								indicatorColor === 'yellow' ? 'bg-vox-warning border-vox-warning shadow-[0_0_0_3px_var(--vox-warning-soft)] motion-safe:animate-pulse' :
									'bg-vox-hairline-strong border-vox-hairline-strong'
					}
				`}
			/>
		</div>
	);
};

const tooltipPropsForApplyBlock = ({ tooltipName, color = undefined, position = 'top', offset = undefined }: { tooltipName: string, color?: IndicatorColor, position?: PlacesType, offset?: number }) => ({
	'data-tooltip-id': color === 'orange' ? `vox-tooltip-orange` : color === 'green' ? 'vox-tooltip-green' : 'vox-tooltip',
	'data-tooltip-place': position as PlacesType,
	'data-tooltip-content': `${tooltipName}`,
	'data-tooltip-offset': offset,
})

export const useEditToolStreamState = ({ applyBoxId, uri }: { applyBoxId: string, uri: URI }) => {
	const accessor = useAccessor()
	const voxCommandBarService = accessor.get('IVoxCommandBarService')
	const [streamState, setStreamState] = useState(voxCommandBarService.getStreamState(uri))
	// listen for stream updates on this box
	useCommandBarURIListener(useCallback((uri_) => {
		const shouldUpdate = uri.fsPath === uri_.fsPath
		if (shouldUpdate) { setStreamState(voxCommandBarService.getStreamState(uri)) }
	}, [voxCommandBarService, applyBoxId, uri]))

	return { streamState, }
}

export const StatusIndicatorForApplyButton = ({ applyBoxId, uri }: { applyBoxId: string, uri: URI | 'current' } & React.HTMLAttributes<HTMLDivElement>) => {

	const { currStreamStateRef } = useApplyStreamState({ applyBoxId })
	const currStreamState = currStreamStateRef.current


	const color = (
		currStreamState === 'idle-no-changes' ? 'dark' :
			currStreamState === 'streaming' ? 'orange' :
				currStreamState === 'idle-has-changes' ? 'green' :
					null
	)

	const tooltipName = (
		currStreamState === 'idle-no-changes' ? t("Done") :
			currStreamState === 'streaming' ? t("Applying") :
				currStreamState === 'idle-has-changes' ? t("Done") : // also 'Done'? 'Applied' looked bad
					''
	)

	const statusIndicatorHTML = <StatusIndicator
		key={currStreamState}
		className='mx-2'
		indicatorColor={color}
		{...tooltipPropsForApplyBlock({ tooltipName, color, position: 'top', offset: 12 })}
	/>
	return statusIndicatorHTML
}


const terminalLanguages = new Set([
	'bash',
	'shellscript',
	'shell',
	'powershell',
	'bat',
	'zsh',
	'sh',
	'fish',
	'nushell',
	'ksh',
	'xonsh',
	'elvish',
])

const ApplyButtonsForTerminal = ({
	codeStr,
	applyBoxId,
	uri,
	language,
}: {
	codeStr: string,
	applyBoxId: string,
	language?: string,
	uri: URI | 'current';
}) => {
	const accessor = useAccessor()
	const terminalToolService = accessor.get('ITerminalToolService')

	const settingsState = useSettingsState()

	const [isShellRunning, setIsShellRunning] = useState<boolean>(false)
	const interruptToolRef = useRef<(() => void) | null>(null)
	const isDisabled = isShellRunning

	const onClickSubmit = useCallback(async () => {
		if (isShellRunning) return
		try {
			setIsShellRunning(true)
			const terminalId = await terminalToolService.createPersistentTerminal({ cwd: null })
			const { interrupt } = await terminalToolService.runCommand(
				codeStr,
				{ type: 'persistent', persistentTerminalId: terminalId }
			);
			interruptToolRef.current = interrupt
		} catch (e) {
			setIsShellRunning(false)
			console.error('Failed to execute in terminal:', e)
		}
	}, [codeStr, uri, applyBoxId, terminalToolService, isShellRunning])

	if (isShellRunning) {
		return (
			<IconShell1
				Icon={X}
				onClick={() => {
					interruptToolRef.current?.();
					setIsShellRunning(false);
				}}
				{...tooltipPropsForApplyBlock({ tooltipName: t("Stop") })}
			/>
		);
	}
	if (isDisabled) {
		return null
	}
	return <IconShell1
		Icon={Play}
		onClick={onClickSubmit}
		{...tooltipPropsForApplyBlock({ tooltipName: t("Apply") })}
	/>
}



const ApplyButtonsForEdit = ({
	codeStr,
	applyBoxId,
	uri,
	language,
}: {
	codeStr: string,
	applyBoxId: string,
	language?: string,
	uri: URI | 'current';
}) => {
	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')
	const notificationService = accessor.get('INotificationService')

	const settingsState = useSettingsState()
	const isDisabled = !!isFeatureNameDisabled('Apply', settingsState) || !applyBoxId

	const { currStreamStateRef, setApplying } = useApplyStreamState({ applyBoxId })

	const onClickSubmit = useCallback(async () => {
		if (currStreamStateRef.current === 'streaming') return

		await editCodeService.callBeforeApplyOrEdit(uri)

		const [newApplyingUri, applyDonePromise] = editCodeService.startApplying({
			from: 'ClickApply',
			applyStr: codeStr,
			uri: uri,
			startBehavior: 'reject-conflicts',
		}) ?? []
		setApplying(newApplyingUri)

		if (!applyDonePromise) {
			notificationService.info(t("Vox Error: We couldn't run Apply here. {0}", uri === 'current' ? t("This Apply block wants to run on the current file, but you might not have a file open.") : t("This Apply block wants to run on {0}, but it might not exist.", uri.fsPath)))
		}

		// catch any errors by interrupting the stream
		applyDonePromise?.catch(e => {
			const uri = getUriBeingApplied(applyBoxId)
			if (uri) editCodeService.interruptURIStreaming({ uri: uri })
			notificationService.info(t("Vox Error: There was a problem running Apply: {0}.", e))

		})

	}, [setApplying, currStreamStateRef, editCodeService, codeStr, uri, applyBoxId, notificationService])


	const onClickStop = useCallback(() => {
		if (currStreamStateRef.current !== 'streaming') return
		const uri = getUriBeingApplied(applyBoxId)
		if (!uri) return

		editCodeService.interruptURIStreaming({ uri })
	}, [currStreamStateRef, applyBoxId, editCodeService])

	const onAccept = useCallback(() => {
		const uri = getUriBeingApplied(applyBoxId)
		if (uri) editCodeService.acceptOrRejectAllDiffAreas({ uri: uri, behavior: 'accept', removeCtrlKs: false })
	}, [uri, applyBoxId, editCodeService])

	const onReject = useCallback(() => {
		const uri = getUriBeingApplied(applyBoxId)
		if (uri) editCodeService.acceptOrRejectAllDiffAreas({ uri: uri, behavior: 'reject', removeCtrlKs: false })
	}, [uri, applyBoxId, editCodeService])

	const currStreamState = currStreamStateRef.current
	if (currStreamState === 'streaming') {
		return <IconShell1
			Icon={Square}
			onClick={onClickStop}
			{...tooltipPropsForApplyBlock({ tooltipName: t("Stop") })}
		/>
	}
	if (isDisabled) {
		return null
	}
	if (currStreamState === 'idle-no-changes') {
		return <IconShell1
			Icon={Play}
			onClick={onClickSubmit}
			{...tooltipPropsForApplyBlock({ tooltipName: t("Apply") })}
		/>
	}
	if (currStreamState === 'idle-has-changes') {
		return <Fragment>
			<IconShell1
				Icon={X}
				onClick={onReject}
				{...tooltipPropsForApplyBlock({ tooltipName: t("Remove") })}
			/>
			<IconShell1
				Icon={Check}
				onClick={onAccept}
				{...tooltipPropsForApplyBlock({ tooltipName: t("Keep") })}
			/>
		</Fragment>
	}
}





export const ApplyButtonsHTML = (params: {
	codeStr: string,
	applyBoxId: string,
	language?: string,
	uri: URI | 'current';
}) => {
	const { language } = params
	const isShellLanguage = !!language && terminalLanguages.has(language)

	if (isShellLanguage) {
		return <ApplyButtonsForTerminal {...params} />
	}
	else {
		return <ApplyButtonsForEdit {...params} />
	}
}





export const EditToolAcceptRejectButtonsHTML = ({
	codeStr,
	applyBoxId,
	uri,
	type,
	threadId,
}: {
	codeStr: string,
	applyBoxId: string,
} & ({
	uri: URI,
	type: 'edit_file' | 'rewrite_file',
	threadId: string,
})
) => {
	const accessor = useAccessor()
	const editCodeService = accessor.get('IEditCodeService')

	const { streamState } = useEditToolStreamState({ applyBoxId, uri })
	const settingsState = useSettingsState()

	const chatThreadsStreamState = useChatThreadsStreamState(threadId)
	const isRunning = chatThreadsStreamState?.isRunning

	const isDisabled = !!isFeatureNameDisabled('Chat', settingsState) || !applyBoxId

	const onAccept = useCallback(() => {
		editCodeService.acceptOrRejectAllDiffAreas({ uri, behavior: 'accept', removeCtrlKs: false })
	}, [uri, applyBoxId, editCodeService])

	const onReject = useCallback(() => {
		editCodeService.acceptOrRejectAllDiffAreas({ uri, behavior: 'reject', removeCtrlKs: false })
	}, [uri, applyBoxId, editCodeService])

	if (isDisabled) return null

	if (streamState === 'idle-no-changes') {
		return null
	}

	if (streamState === 'idle-has-changes') {
		if (isRunning === 'LLM' || isRunning === 'tool') return null

		return <>
			<IconShell1
				Icon={X}
				onClick={onReject}
				{...tooltipPropsForApplyBlock({ tooltipName: t("Remove") })}
			/>
			<IconShell1
				Icon={Check}
				onClick={onAccept}
				{...tooltipPropsForApplyBlock({ tooltipName: t("Keep") })}
			/>
		</>
	}

}

export const BlockCodeApplyWrapper = ({
	children,
	codeStr,
	applyBoxId,
	language,
	canApply,
	uri,
}: {
	codeStr: string;
	children: React.ReactNode;
	applyBoxId: string;
	canApply: boolean;
	language: string;
	uri: URI | 'current',
}) => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const { currStreamStateRef } = useApplyStreamState({ applyBoxId })
	const currStreamState = currStreamStateRef.current


	const name = uri !== 'current' ?
		<ListableToolItem
			name={<span className='not-italic'>{getBasename(uri.fsPath)}</span>}
			isSmall={true}
			showDot={false}
			onClick={() => { voxOpenFileFn(uri, accessor) }}
		/>
		: <span>{language}</span>


	return <div className='border border-vox-hairline rounded-vox-lg overflow-hidden bg-vox-bg-3 my-2 shadow-vox-sm'>
		{/* header */}
		<div className=" select-none flex justify-between items-center py-1 pl-1 pr-1.5 bg-vox-surface border-b border-vox-hairline cursor-default">
			<div className="flex items-center min-w-0">
				<StatusIndicatorForApplyButton uri={uri} applyBoxId={applyBoxId} />
				<span className="text-xs font-medium text-vox-fg-3 truncate">
					{name}
				</span>
			</div>
			<div className={`${canApply ? '' : 'hidden'} flex items-center gap-0.5`}>
				<JumpToFileButton uri={uri} />
				{currStreamState === 'idle-no-changes' && <CopyButton codeStr={codeStr} toolTipName={t("Copy")} />}
				<ApplyButtonsHTML uri={uri} applyBoxId={applyBoxId} codeStr={codeStr} language={language} />
			</div>
		</div>

		{/* contents */}
		<ToolChildrenWrapper>
			{children}
		</ToolChildrenWrapper>
	</div>

}
