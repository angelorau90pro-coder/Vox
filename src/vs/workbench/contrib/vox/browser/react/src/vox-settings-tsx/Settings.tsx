/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'; // Added useRef import just in case it was missed, though likely already present
import { splitCliAgentModel, ProviderName, SettingName, displayInfoOfSettingName, providerNames, VoxStatefulModelInfo, customSettingNamesOfProvider, RefreshableProviderName, refreshableProviderNames, displayInfoOfProviderName, GlobalSettingName, featureNames, displayInfoOfFeatureName, isProviderNameDisabled, FeatureName, subTextMdOfProviderName } from '../../../../common/voxSettingsTypes.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoxButtonBgDarken, VoxCustomDropdownBox, VoxInputBox2, VoxSimpleInputBox, VoxSwitch } from '../util/inputs.js'
import { useAccessor, useIsDark, useRefreshModelListener, useRefreshModelState, useSettingsState } from '../util/services.js'
import { X, RefreshCw, Loader2, Check, Asterisk, Plus, Boxes, Cpu, SquareTerminal, SlidersHorizontal, Settings2, Plug, LayoutList, Sparkles } from 'lucide-react'
import { URI } from '../../../../../../../base/common/uri.js'
import { ModelDropdown } from './ModelDropdown.js'
import { isVoxLocalConfigured } from '../../../../common/voxSettingsService.js'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js'
import Severity from '../../../../../../../base/common/severity.js'
import { getModelCapabilities, modelOverrideKeys, ModelOverrides } from '../../../../common/modelCapabilities.js';
import { MCPServer } from '../../../../common/mcpServiceTypes.js';
import { useMCPServiceState } from '../util/services.js';
import { LocalModelLibrary } from './LocalModelLibrary.js';

type Tab =
	| 'models'
	| 'localProviders'
	| 'providers'
	| 'featureOptions'
	| 'mcp'
	| 'general'
	| 'all';


const ButtonLeftTextRightOption = ({ text, leftButton, title }: { text: string, leftButton?: React.ReactNode, title?: string }) => {

	return <div className='flex items-center text-vox-fg-3 text-[12.5px] px-3 py-1 overflow-hidden gap-2'>
		{leftButton ? leftButton : null}
		<span title={title}>
			{text}
		</span>
	</div>
}

// models
const RefreshModelButton = ({ providerName }: { providerName: RefreshableProviderName }) => {

	const refreshModelState = useRefreshModelState()

	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')

	const [justFinished, setJustFinished] = useState<null | { result: 'finished' | 'error', message: string }>(null)

	useRefreshModelListener(
		useCallback((providerName2, refreshModelState) => {
			if (providerName2 !== providerName) return
			const providerState = refreshModelState[providerName]
			// solo gli aggiornamenti manuali fanno lampeggiare il pulsante, non i giri automatici
			if (!providerState.manual) return
			const { state } = providerState
			if (!(state === 'finished' || state === 'error')) return
			// ora sappiamo che per providerName è appena terminato un aggiornamento manuale
			setJustFinished({ result: state, message: providerState.state === 'error' ? providerState.message : '' })
			const tid = setTimeout(() => { setJustFinished(null) }, 2000)
			return () => clearTimeout(tid)
		}, [providerName])
	)

	const providerState = refreshModelState[providerName]
	const { state } = providerState
	const { title: providerTitle } = displayInfoOfProviderName(providerName)
	// voxLocal mostra l'errore finché dura lo stato attuale (un successo automatico lo toglie subito);
	// gli altri provider lo mostrano solo per il lampo dopo l'aggiornamento manuale
	const showError = providerName === 'voxLocal' ? state === 'error' : justFinished?.result === 'error'
	const errorMessage = providerName === 'voxLocal' && providerState.state === 'error' ? providerState.message : (justFinished?.message ?? '')
	const errorText = errorMessage || t("{0} not found!", providerTitle)
	// voxLocal: l'avviso non bloccante (file .gguf mancanti o irraggiungibili) compare anche qui, nella scheda che si
	// apre per prima, così chi vede meno modelli del previsto ne trova subito la causa
	const warning = providerName === 'voxLocal' && providerState.state === 'finished' ? providerState.warning : undefined

	return <>
	<ButtonLeftTextRightOption
		title={showError ? errorText : undefined}

		leftButton={
			<button
				type='button'
				// pulsante con la sola icona: il nome dice cosa fa, lo stato è nel testo accanto
				aria-label={t("Manually refresh {0} models.", providerTitle)}
				className='flex items-center'
				disabled={state === 'refreshing' || justFinished !== null}
				onClick={() => {
					refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false })
				}}
			>
				{showError ? <X className='stroke-red-500 size-3' />
					: justFinished?.result === 'finished' ? <Check className='stroke-green-500 size-3' />
						: state === 'refreshing' ? <Loader2 className='size-3 animate-spin' />
							: <RefreshCw className='size-3' />}
			</button>
		}

		text={showError ? errorText
			: justFinished?.result === 'finished' ? t("{0} Models are up-to-date!", providerTitle)
				: t("Manually refresh {0} models.", providerTitle)}
	/>
	{warning ? <WarningBox className="pl-2 mb-2" text={warning} /> : null}
	</>
}

const RefreshableModels = () => {
	const settingsState = useSettingsState()


	const buttons = refreshableProviderNames.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) return null
		return <RefreshModelButton key={providerName} providerName={providerName} />
	})

	return <>
		{buttons}
	</>

}



export const AnimatedCheckmarkButton = ({ text, className }: { text?: string, className?: string }) => {
	const [dashOffset, setDashOffset] = useState(40);

	useEffect(() => {
		const startTime = performance.now();
		const duration = 500; // 500ms animation

		const animate = (currentTime: number) => {
			const elapsed = currentTime - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const newOffset = 40 - (progress * 40);

			setDashOffset(newOffset);

			if (progress < 1) {
				requestAnimationFrame(animate);
			}
		};

		const animationId = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(animationId);
	}, []);

	return <div
		className={`flex items-center gap-1.5 w-fit
			${className ? className : `px-2.5 py-1 text-xs rounded-vox-md bg-vox-accent-soft text-vox-accent-text border border-vox-accent-border`}
		`}
	>
		<svg className="size-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path
				d="M5 13l4 4L19 7"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{
					strokeDasharray: 40,
					strokeDashoffset: dashOffset
				}}
			/>
		</svg>
		{text}
	</div>
}


const AddButton = ({ disabled, text = t("Add"), ...props }: { disabled?: boolean, text?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {

	return <button
		disabled={disabled}
		className='@@vox-btn @@vox-btn-primary'
		{...props}
	>{text}</button>

}

// ConfirmButton prompts for a second click to confirm an action, cancels if clicking outside
const ConfirmButton = ({ children, onConfirm, className }: { children: React.ReactNode, onConfirm: () => void, className?: string }) => {
	const [confirm, setConfirm] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!confirm) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setConfirm(false);
			}
		};
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [confirm]);
	return (
		<div ref={ref} className={`inline-block`}>
			<VoxButtonBgDarken className={className} onClick={() => {
				if (!confirm) {
					setConfirm(true);
				} else {
					onConfirm();
					setConfirm(false);
				}
			}}>
				{confirm ? t("Confirm Reset") : children}
			</VoxButtonBgDarken>
		</div>
	);
};

// ---------------- Simplified Model Settings Dialog ------------------

// keys of ModelOverrides we allow the user to override



// This new dialog replaces the verbose UI with a single JSON override box.
// VOX: l'uscita anticipata sta in un involucro: gli hook del dialogo non devono dipendere da `isOpen` (regole degli hook)
const SimpleModelSettingsDialog = (props: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' } | null;
}) => {
	if (!props.isOpen || !props.modelInfo) return null;
	return <OpenModelSettingsDialog isOpen={props.isOpen} onClose={props.onClose} modelInfo={props.modelInfo} />
}

const OpenModelSettingsDialog = ({
	isOpen,
	onClose,
	modelInfo,
}: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' };
}) => {
	const { modelName, providerName, type } = modelInfo;
	const accessor = useAccessor()
	const settingsState = useSettingsState()
	const mouseDownInsideModal = useRef(false); // Ref to track mousedown origin
	const settingsStateService = accessor.get('IVoxSettingsService')

	// current overrides and defaults
	const defaultModelCapabilities = getModelCapabilities(providerName, modelName, undefined);
	const currentOverrides = settingsState.overridesOfModel?.[providerName]?.[modelName] ?? undefined;
	const { recognizedModelName, isUnrecognizedModel } = defaultModelCapabilities

	// Create the placeholder with the default values for allowed keys
	const partialDefaults: Partial<ModelOverrides> = {};
	for (const k of modelOverrideKeys) { if (defaultModelCapabilities[k]) partialDefaults[k] = defaultModelCapabilities[k] as any; }
	const placeholder = JSON.stringify(partialDefaults, null, 2);

	const [overrideEnabled, setOverrideEnabled] = useState<boolean>(() => !!currentOverrides);

	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

	// reset when dialog toggles
	useEffect(() => {
		if (!isOpen) return;
		const cur = settingsState.overridesOfModel?.[providerName]?.[modelName];
		setOverrideEnabled(!!cur);
		setErrorMsg(null);
	}, [isOpen, providerName, modelName, settingsState.overridesOfModel, placeholder]);

	const onSave = async () => {
		// if disabled override, reset overrides
		if (!overrideEnabled) {
			await settingsStateService.setOverridesOfModel(providerName, modelName, undefined);
			onClose();
			return;
		}

		// enabled overrides
		// parse json
		let parsedInput: Record<string, unknown>

		if (textAreaRef.current?.value) {
			try {
				parsedInput = JSON.parse(textAreaRef.current.value);
			} catch (e) {
				setErrorMsg(t("Invalid JSON"));
				return;
			}
		} else {
			setErrorMsg(t("Invalid JSON"));
			return;
		}

		// only keep allowed keys
		const cleaned: Partial<ModelOverrides> = {};
		for (const k of modelOverrideKeys) {
			if (!(k in parsedInput)) continue
			const isEmpty = parsedInput[k] === '' || parsedInput[k] === null || parsedInput[k] === undefined;
			if (!isEmpty) {
				cleaned[k] = parsedInput[k] as any;
			}
		}
		await settingsStateService.setOverridesOfModel(providerName, modelName, cleaned);
		onClose();
	};

	return (
		<div // Backdrop
			className="fixed inset-0 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4 z-[9999999]"
			onMouseDown={() => {
				mouseDownInsideModal.current = false;
			}}
			onMouseUp={() => {
				if (!mouseDownInsideModal.current) {
					onClose();
				}
				mouseDownInsideModal.current = false;
			}}
		>
			{/* MODAL */}
			<div
				className="bg-vox-surface-raised border border-vox-hairline-strong rounded-vox-xl p-5 max-w-xl w-full shadow-vox-lg overflow-y-auto max-h-[90vh] @@vox-fade-up"
				onClick={(e) => e.stopPropagation()} // Keep stopping propagation for normal clicks inside
				onMouseDown={(e) => {
					mouseDownInsideModal.current = true;
					e.stopPropagation();
				}}
			>
				<div className="flex justify-between items-center mb-4">
					<h3 className="text-lg font-semibold text-vox-fg-1">
						{t("Change Defaults for")} {modelName} <span className='text-vox-fg-3 font-normal'>({displayInfoOfProviderName(providerName).title})</span>
					</h3>
					<button
						type='button'
						onClick={onClose}
						aria-label={t("Close")}
						className="flex items-center justify-center size-7 rounded-vox-md text-vox-fg-3 hover:text-vox-fg-1 hover:bg-vox-surface-hover transition-colors"
					>
						<X className="size-4" />
					</button>
				</div>

				{/* Display model recognition status */}
				<div className="text-sm text-vox-fg-3 mb-4">
					{type === 'default' ? t("{0} comes packaged with Vox, so you shouldn't need to change these settings.", modelName)
						: isUnrecognizedModel
							? t("Model not recognized by Vox.")
							: t("Vox recognizes {0} (\"{1}\").", modelName, recognizedModelName)}
				</div>


				{/* override toggle */}
				<div className="flex items-center gap-2 mb-4">
					<VoxSwitch size='xs' value={overrideEnabled} onChange={setOverrideEnabled} ariaLabel={t("Override model defaults")} />
					<span className="text-vox-fg-3 text-sm">{t("Override model defaults")}</span>
				</div>

				{/* Informational link */}
				{overrideEnabled && <div className="text-sm text-vox-fg-3 mb-4">
					<ChatMarkdownRender string={t("See the source code for a reference on how to set this JSON (advanced).")} chatMessageLocation={undefined} />
				</div>}

				<textarea
					key={overrideEnabled + ''}
					ref={textAreaRef}
					className={`w-full min-h-[200px] p-3 rounded-vox-md border border-vox-hairline-strong focus:border-vox-accent bg-vox-bg-1 resize-none font-mono text-sm transition-colors ${!overrideEnabled ? 'text-vox-fg-3' : ''}`}
					defaultValue={overrideEnabled && currentOverrides ? JSON.stringify(currentOverrides, null, 2) : placeholder}
					placeholder={placeholder}
					readOnly={!overrideEnabled}
				/>
				{errorMsg && (
					<div className="text-red-500 mt-2 text-sm">{errorMsg}</div>
				)}


				<div className="flex justify-end gap-2 mt-5">
					<VoxButtonBgDarken onClick={onClose}>
						{t("Cancel")}</VoxButtonBgDarken>
					<VoxButtonBgDarken
						onClick={onSave}
						variant='primary'
					>
						{t("Save")}</VoxButtonBgDarken>
				</div>
			</div>
		</div>
	);
};




export const ModelDump = ({ filteredProviders }: { filteredProviders?: ProviderName[] }) => {
	const accessor = useAccessor()
	const settingsStateService = accessor.get('IVoxSettingsService')
	const settingsState = useSettingsState()

	// State to track which model's settings dialog is open
	const [openSettingsModel, setOpenSettingsModel] = useState<{
		modelName: string,
		providerName: ProviderName,
		type: 'autodetected' | 'custom' | 'default'
	} | null>(null);

	// States for add model functionality
	const [isAddModelOpen, setIsAddModelOpen] = useState(false);
	const [showCheckmark, setShowCheckmark] = useState(false);
	const [userChosenProviderName, setUserChosenProviderName] = useState<ProviderName | null>(null);
	const [modelName, setModelName] = useState<string>('');
	const [errorString, setErrorString] = useState('');

	// a dump of all the enabled providers' models
	const modelDump: (VoxStatefulModelInfo & { providerName: ProviderName, providerEnabled: boolean })[] = []

	// Use either filtered providers or all providers
	const providersToShow = filteredProviders || providerNames;
	const addableProviders = providersToShow.filter(p => p !== 'voxLocal');

	for (let providerName of providersToShow) {
		const providerSettings = settingsState.settingsOfProvider[providerName]
		// if (!providerSettings.enabled) continue
		modelDump.push(...providerSettings.models.map(model => ({ ...model, providerName, providerEnabled: !!providerSettings._didFillInProviderSettings })))
	}

	// sort by hidden
	modelDump.sort((a, b) => {
		return Number(b.providerEnabled) - Number(a.providerEnabled)
	})

	// Add model handler
	const handleAddModel = () => {
		if (!userChosenProviderName) {
			setErrorString(t("Please select a provider."));
			return;
		}
		if (!modelName) {
			setErrorString(t("Please enter a model name."));
			return;
		}

		// Check if model already exists
		if (settingsState.settingsOfProvider[userChosenProviderName].models.find(m => m.modelName === modelName)) {
			setErrorString(t("This model already exists."));
			return;
		}

		settingsStateService.addModel(userChosenProviderName, modelName);
		setShowCheckmark(true);
		setTimeout(() => {
			setShowCheckmark(false);
			setIsAddModelOpen(false);
			setUserChosenProviderName(null);
			setModelName('');
		}, 1500);
		setErrorString('');
	};

	return <div className='@@vox-card p-1.5'>
		{modelDump.map((m, i) => {
			const { isHidden, type, modelName, providerName, providerEnabled } = m

			const isNewProviderName = (i > 0 ? modelDump[i - 1] : undefined)?.providerName !== providerName

			const providerTitle = displayInfoOfProviderName(providerName).title

			const disabled = !providerEnabled
			const value = disabled ? false : !isHidden

			const tooltipName = (
				disabled ? t("Add {0} to enable", providerTitle)
					: value === true ? t("Show in Dropdown")
						: t("Hide from Dropdown")
			)


			const detailAboutModel = type === 'autodetected' ?
				<Asterisk size={14} className="inline-block align-text-top stroke-[2] text-vox-accent-text" data-tooltip-id='vox-tooltip' data-tooltip-place='right' data-tooltip-content={t("Detected locally")} />
				: type === 'custom' ?
					<Asterisk size={14} className="inline-block align-text-top stroke-[2] text-vox-accent-text" data-tooltip-id='vox-tooltip' data-tooltip-place='right' data-tooltip-content={t("Custom model")} />
					: undefined

			const hasOverrides = !!settingsState.overridesOfModel?.[providerName]?.[modelName]

			return <div key={`${modelName}${providerName}`}
				className={`flex items-center justify-between gap-4 hover:bg-vox-surface-hover py-1.5 px-3 rounded-vox-md transition-colors overflow-hidden cursor-default truncate group
				`}
			>
				{/* left part is width:full */}
				<div className={`flex flex-grow items-center gap-4`}>
					<span className='w-full max-w-32'>{isNewProviderName ? providerTitle : ''}</span>
					<span className='w-fit max-w-[400px] truncate'>{modelName}</span>
				</div>

				{/* right part is anything that fits */}
				<div className="flex items-center gap-2 w-fit">

					{/* Advanced Settings button (gear). Hide entirely when provider/model disabled. */}
					{disabled ? null : (
						<div className="w-5 flex items-center justify-center">
							<button
								onClick={() => { setOpenSettingsModel({ modelName, providerName, type }) }}
								data-tooltip-id='vox-tooltip'
								data-tooltip-place='right'
								data-tooltip-content={t("Advanced Settings")}
								aria-label={`${modelName}: ${t("Advanced Settings")}`}
								className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} transition-opacity`}
							>
								<Plus size={12} className="text-vox-fg-3 opacity-50" />
							</button>
						</div>
					)}

					{/* Blue star */}
					{detailAboutModel}


					{/* Switch */}
					<VoxSwitch
						value={value}
						onChange={() => { settingsStateService.toggleModelHidden(providerName, modelName); }}
						disabled={disabled}
						size='sm'
						ariaLabel={`${modelName}: ${t("Show in Dropdown")}`}

						data-tooltip-id='vox-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={tooltipName}
					/>

					{/* X button */}
					<div className={`w-5 flex items-center justify-center`}>
						{type === 'default' || type === 'autodetected' ? null : <button
							onClick={() => { settingsStateService.deleteModel(providerName, modelName); }}
							data-tooltip-id='vox-tooltip'
							data-tooltip-place='right'
							data-tooltip-content={t("Delete")}
							aria-label={`${modelName}: ${t("Delete")}`}
							className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'} transition-opacity`}
						>
							<X size={12} className="text-vox-fg-3 opacity-50" />
						</button>}
					</div>
				</div>
			</div>
		})}

		{/* Add Model Section */}
		{addableProviders.length === 0 ? null : showCheckmark ? (
			<div className="mt-2 p-1.5">
				<AnimatedCheckmarkButton text={t("Added")} />
			</div>
		) : isAddModelOpen ? (
			<div className="mt-2 p-1.5">
				{/* Invio nel campo del nome aggiunge il modello invece di inviare il modulo */}
				<form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleAddModel(); }}>

					{/* Provider dropdown */}
					<ErrorBoundary>
						<VoxCustomDropdownBox
							options={addableProviders}
							selectedOption={userChosenProviderName}
							onChangeOption={(pn) => setUserChosenProviderName(pn)}
							getOptionDisplayName={(pn) => pn ? displayInfoOfProviderName(pn).title : t("Provider Name")}
							getOptionDropdownName={(pn) => pn ? displayInfoOfProviderName(pn).title : t("Provider Name")}
							getOptionsEqual={(a, b) => a === b}
							ariaLabel={t("Provider Name")}
							className="max-w-40 w-full resize-none bg-vox-bg-1 text-vox-fg-1 placeholder:text-vox-fg-3 border border-vox-hairline-strong hover:border-vox-accent-border py-1 px-2 rounded-vox-md transition-colors"
							arrowTouchesText={false}
						/>
					</ErrorBoundary>

					{/* Model name input */}
					<ErrorBoundary>
						<VoxSimpleInputBox
							value={modelName}
							compact={true}
							onChangeValue={setModelName}
							placeholder={t("Model Name")}
							className='max-w-32'
						/>
					</ErrorBoundary>

					{/* Add button */}
					<ErrorBoundary>
						<AddButton
							type='button'
							disabled={!modelName || !userChosenProviderName}
							onClick={handleAddModel}
						/>
					</ErrorBoundary>

					{/* X button to cancel */}
					<button
						type="button"
						onClick={() => {
							setIsAddModelOpen(false);
							setErrorString('');
							setModelName('');
							setUserChosenProviderName(null);
						}}
						aria-label={t("Cancel")}
						className='flex items-center justify-center size-7 rounded-vox-md text-vox-fg-4 hover:text-vox-fg-1 hover:bg-vox-surface-hover transition-colors'
					>
						<X className='size-4' />
					</button>
				</form>

				{errorString && (
					<div className='text-vox-danger text-sm truncate whitespace-nowrap mt-1.5'>
						{errorString}
					</div>
				)}
			</div>
		) : (
			<button
				type='button'
				className="@@vox-btn @@vox-btn-secondary mt-2 mx-1.5 mb-1.5"
				onClick={() => setIsAddModelOpen(true)}
			>
				<Plus size={14} aria-hidden='true' />
				<span>{t("Add a model")}</span>
			</button>
		)}

		{/* Model Settings Dialog */}
		<SimpleModelSettingsDialog
			isOpen={openSettingsModel !== null}
			onClose={() => setOpenSettingsModel(null)}
			modelInfo={openSettingsModel}
		/>
	</div>
}



// providers

const ProviderSetting = ({ providerName, settingName, subTextMd }: { providerName: ProviderName, settingName: SettingName, subTextMd: React.ReactNode }) => {

	const { title: settingTitle, placeholder, isPasswordField } = displayInfoOfSettingName(providerName, settingName)

	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const settingsState = useSettingsState()

	// Create a stable callback reference using useCallback with proper dependencies
	// (prima dell'uscita anticipata qui sotto: gli hook vanno chiamati sempre)
	const handleChangeValue = useCallback((newVal: string) => {
		voxSettingsService.setSettingOfProvider(providerName, settingName, newVal)
	}, [voxSettingsService, providerName, settingName]);

	const settingValue = settingsState.settingsOfProvider[providerName][settingName] as string // this should always be a string in this component
	if (typeof settingValue !== 'string') {
		console.log('Error: Provider setting had a non-string value.')
		return null
	}

	return <ErrorBoundary>
		<div className='my-1'>
			<VoxSimpleInputBox
				value={settingValue}
				onChangeValue={handleChangeValue}
				placeholder={`${settingTitle} (${placeholder})`}
				passwordBlur={isPasswordField}
				compact={true}
			/>
			{!subTextMd ? null : <div className='py-1 px-3 opacity-50 text-sm'>
				{subTextMd}
			</div>}
		</div>
	</ErrorBoundary>
}

export const CliAgentDiscovery = ({ autoDetect = false, onDetected }: { autoDetect?: boolean, onDetected?: (agents: string[]) => void }) => {
	const accessor = useAccessor()
	const llmMessageService = accessor.get('ILLMMessageService')
	const settingsService = accessor.get('IVoxSettingsService')
	const [installed, setInstalled] = useState<string[] | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const discover = async () => {
		setBusy(true)
		setError('')
		onDetected?.([])
		try {
			const found = await llmMessageService.cliAgentList()
			const current = settingsService.state.settingsOfProvider.cliAgent.models
			const models = current.map(model => model.type !== 'custom' ? { ...model, isHidden: !found.includes(splitCliAgentModel(model.modelName).agent) } : model)
			for (const agent of found) {
				if (!models.some(model => model.modelName === agent)) models.push({ modelName: agent, type: 'autodetected', isHidden: false })
			}
			await settingsService.setSettingOfProvider('cliAgent', 'models', models)
			setInstalled(found)
			onDetected?.(found)
		} catch {
			setError(t("Could not detect installed CLIs."))
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => {
		if (autoDetect) void discover()
	}, [])
	return <div className='px-2 mb-4'>
		<VoxButtonBgDarken disabled={busy} onClick={discover}>{busy ? t("Searching...") : t("Detect installed CLIs")}</VoxButtonBgDarken>
		{installed !== null && <div className='text-vox-fg-3 mt-2'>{installed.length ? t("Installed CLIs:") + " " + installed.join(', ') : t("No CLIs found. Specify the command path and try again.")}</div>}
		{error && <div role='alert' className='mt-2'>{error}</div>}
	</div>
}

export const SettingsForProvider = ({ providerName, showProviderTitle, showProviderSuggestions, showLocalModelLibrary }: { providerName: ProviderName, showProviderTitle: boolean, showProviderSuggestions: boolean, showLocalModelLibrary?: boolean }) => {
	const voxSettingsState = useSettingsState()
	const refreshModelState = useRefreshModelState()

	const needsModel = isProviderNameDisabled(providerName, voxSettingsState) === 'addModel'

	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const refreshModelService = accessor.get('IRefreshModelService')
	const localModelLibraryService = accessor.get('ILocalModelLibraryService')

	const { title: providerTitle } = displayInfoOfProviderName(providerName)
	const voxLocalRefreshState = providerName === 'voxLocal' ? refreshModelState.voxLocal : null
	const voxLocalError = voxLocalRefreshState?.state === 'error' ? (voxLocalRefreshState.message || t("{0} not found!", providerTitle)) : null
	const voxLocalWarning = voxLocalRefreshState?.state === 'finished' ? voxLocalRefreshState.warning : undefined
	const [isSearchingAgain, setIsSearchingAgain] = useState(false)
	const voxLocalManualRefreshing = voxLocalRefreshState?.state === 'refreshing' && voxLocalRefreshState.manual
	// con la libreria (solo nelle Impostazioni) l'esito del rilevamento sta in un blocco solo, quello della libreria
	const libraryShown = providerName === 'voxLocal' && !!showLocalModelLibrary
	const voxLocalNotConfigured = providerName === 'voxLocal' && voxLocalRefreshState?.state === 'finished' && !isVoxLocalConfigured(voxSettingsState.settingsOfProvider.voxLocal)
	// Durante un rilevamento lo stato è 'refreshing', senza esito. La libreria lo sa (`stale`) e tiene la riga che mostrava;
	// qui si tiene l'ultimo errore solo per decidere se offrire la ricerca, così il pulsante non sparisce intanto
	const voxLocalRefreshing = voxLocalRefreshState?.state === 'refreshing'
	const lastErrorRef = useRef<string | null>(null)
	if (!voxLocalRefreshing) lastErrorRef.current = voxLocalError
	const shownError = voxLocalRefreshing ? lastErrorRef.current : voxLocalError
	const voxLocalBusy = isSearchingAgain || voxLocalManualRefreshing
	// ricerca nei posti predefiniti partita dal pulsante: il pulsante resta (spento, con «Ricerca…») finché non finisce,
	// anche se intanto il campo si è svuotato
	const [searchInFlight, setSearchInFlight] = useState(false)
	useEffect(() => { if (!voxLocalBusy) setSearchInFlight(false) }, [voxLocalBusy])
	// la ricerca si offre solo per un errore con una cartella scritta: con il campo vuoto Vox cerca già da solo
	const canSearchDefaultPlaces = !!shownError && !!voxSettingsState.settingsOfProvider.voxLocal.folder?.trim()
	const searchDefaultPlaces = async () => {
		setSearchInFlight(true)
		setIsSearchingAgain(true)
		// la cartella scritta al clic: se durante la ricerca l'utente ne scrive un'altra, la ricerca si ferma e non la svuota
		const folderAtClick = voxSettingsService.state.settingsOfProvider.voxLocal.folder
		try {
			// la ricerca deve guardare davvero le unità: senza questo il rilevamento userebbe un esito «assente» tenuto in
			// memoria fino a un minuto (la cache delle cartelle è la stessa per la libreria e per la chat)
			try { await localModelLibraryService.getState('', true) }
			catch {
				// libreria non disponibile: la ricerca parte lo stesso, al più con l'esito tenuto in memoria
			}
			if (voxSettingsService.state.settingsOfProvider.voxLocal.folder !== folderAtClick) return
			// il cambio cartella fa partire un rilevamento automatico: il manuale deve partire dopo, per vincere la generazione
			try { await voxSettingsService.setSettingOfProvider('voxLocal', 'folder', '') }
			catch {
				// salvataggio fallito: la cartella in memoria è già vuota, quindi la ricerca automatica
				// parte lo stesso; se il problema resta, l'esito del rilevamento lo mostra
			}
			// enableProviderOnSuccess: se la cartella non era mai stata trovata, il successo deve attivare il fornitore
			refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: false })
		} finally {
			setIsSearchingAgain(false)
		}
	}

	// const { enabled } = voxSettingsState.settingsOfProvider[providerName]
	const settingNames = customSettingNamesOfProvider(providerName)

	return <div>

		<div className='flex items-center w-full gap-4'>
			{showProviderTitle && <h3 className='text-xl truncate'>{providerTitle}</h3>}

			{/* enable provider switch */}
			{/* <VoxSwitch
				value={!!enabled}
				onChange={
					useCallback(() => {
						const enabledRef = voxSettingsService.state.settingsOfProvider[providerName].enabled
						voxSettingsService.setSettingOfProvider(providerName, 'enabled', !enabledRef)
					}, [voxSettingsService, providerName])}
				size='sm+'
			/> */}
		</div>

		<div className='px-0'>
			{/* settings besides models */}
			{settingNames.map((settingName, i) => {

				return <ProviderSetting
					key={settingName}
					providerName={providerName}
					settingName={settingName}
					subTextMd={i !== settingNames.length - 1 ? null
						: <ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />}
				/>
			})}

			{providerName === 'cliAgent' && <CliAgentDiscovery />}
			{/* la libreria dei modelli (scarico e rimozione) sta solo nelle Impostazioni, non nel primo avvio */}
			{libraryShown && <LocalModelLibrary detection={{
				detectionError: voxLocalError,
				notConfigured: voxLocalNotConfigured,
				stale: voxLocalRefreshing,
				// anche la rilettura dei modelli dopo «Controlla di nuovo» è manuale: intanto i pulsanti restano spenti
				busy: voxLocalBusy,
				searchStarted: searchInFlight,
				onSearchDefaultPlaces: canSearchDefaultPlaces || searchInFlight ? () => { void searchDefaultPlaces() } : undefined,
			}} />}
			{/* voxLocal: ricerca finita senza cartella né modelli: le IA locali non ci sono, non è un errore.
			    Con la libreria lo dice la libreria */}
			{!libraryShown && voxLocalNotConfigured ?
				<div role='status' className='px-3 py-1 text-vox-fg-3 text-sm'>{t("Local AI is not configured: no ia-locali folder was found. You can use the CLI AI in the meantime, or set it up as described below.")}</div>
				: null}
			{providerName === 'voxLocal' && <VoxLocalSetupInstructions />}
			{/* i modelli delle IA locali vengono da modelli.json: non si aggiungono dalla sezione Modelli */}
			{showProviderSuggestions && needsModel && providerName !== 'voxLocal' ?
				<WarningBox className="pl-2 mb-4" text={t("Please add a model for {0} (Models section).", providerTitle)} />
				: null}

			{/* voxLocal: errore di rilevamento con la causa vera; se la cartella salvata non esiste più si può ritrovarla */}
			{/* con la libreria l'errore e la ricerca stanno nel suo blocco (vedi sopra) */}
			{!libraryShown && voxLocalError ? <>
				<WarningBox className="pl-2 mb-2" text={voxLocalError} />
				{canSearchDefaultPlaces ? (
					<div className="pl-2 mb-4">
						<VoxButtonBgDarken disabled={isSearchingAgain || voxLocalManualRefreshing} onClick={searchDefaultPlaces}>{t("Search the default places")}</VoxButtonBgDarken>
					</div>
				) : null}
			</> : null}

			{/* voxLocal: avviso non bloccante del rilevamento (per esempio file .gguf mancanti) */}
			{voxLocalWarning ? <WarningBox className="pl-2 mb-2" text={voxLocalWarning} /> : null}
		</div>
	</div >
}


export const VoxProviderSettings = ({ providerNames }: { providerNames: ProviderName[] }) => {
	return <>
		{providerNames.map(providerName =>
			<SettingsForProvider key={providerName} providerName={providerName} showProviderTitle={true} showProviderSuggestions={true} showLocalModelLibrary={true} />
		)}
	</>
}


type TabName = 'models' | 'general'
export const AutoDetectLocalModelsToggle = () => {
	const settingName: GlobalSettingName = 'autoRefreshModels'

	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')

	const voxSettingsState = useSettingsState()

	// right now this is just `enabled_autoRefreshModels`
	const enabled = voxSettingsState.globalSettings[settingName]

	return <ButtonLeftTextRightOption
		leftButton={<VoxSwitch
			size='xxs'
			value={enabled}
			ariaLabel={t("Automatically detect the local AI models.")}
			onChange={(newVal) => {
				voxSettingsService.setGlobalSetting(settingName, newVal)
			}}
		/>}
		text={t("Automatically detect the local AI models.")}
	/>


}

export const AIInstructionsBox = () => {
	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const voxSettingsState = useSettingsState()
	return <VoxInputBox2
		className='min-h-[81px] p-3 rounded-vox-md'
		initValue={voxSettingsState.globalSettings.aiInstructions}
		placeholder={t("Do not change my indentation or delete my comments. When writing TS or JS, do not add ;'s. Write new code using Rust if possible.")}
		multiline
		onChangeText={(newText) => {
			voxSettingsService.setGlobalSetting('aiInstructions', newText)
		}}
	/>
}

const FastApplyMethodDropdown = () => {
	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')

	const options = useMemo(() => [true, false], [])

	const onChangeOption = useCallback((newVal: boolean) => {
		voxSettingsService.setGlobalSetting('enableFastApply', newVal)
	}, [voxSettingsService])

	return <VoxCustomDropdownBox
		className='text-xs text-vox-fg-2 bg-vox-bg-1 border border-vox-hairline-strong hover:border-vox-accent-border rounded-vox-md py-1 px-2 transition-colors'
		options={options}
		selectedOption={voxSettingsService.state.globalSettings.enableFastApply}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => val ? t("Fast Apply") : t("Slow Apply")}
		getOptionDropdownName={(val) => val ? t("Fast Apply") : t("Slow Apply")}
		getOptionDropdownDetail={(val) => val ? t("Output Search/Replace blocks") : t("Rewrite whole files")}
		getOptionsEqual={(a, b) => a === b}
		ariaLabel={displayInfoOfFeatureName('Apply')}
	/>

}


const VOX_LOCAL_MANIFEST_EXAMPLE = `{
  "motore": "motore/llama-server.exe",
  "modelli": [
    { "nome": "qwen", "file": "qwen.gguf", "contesto": 32768, "porta": 8192, "uso": "chat" },
    { "nome": "qwen-coder", "file": "qwen-coder.gguf", "contesto": 8192, "porta": 8193, "uso": "completamento" }
  ]
}`

export const VoxLocalSetupInstructions = () => {
	return <details className='@@vox-card px-4 py-2.5 my-3 text-vox-fg-3 text-sm'>
		<summary className='cursor-pointer text-vox-fg-2 hover:text-vox-fg-1 font-medium transition-colors'>{t("Don't have the local AI folder yet?")}</summary>
		<div className='mt-2 space-y-2 select-text prose-p:my-0 prose-p:py-0 prose-span:my-0 prose-span:py-0'>
			<ChatMarkdownRender string={t("Engine and models are not included in Vox. Create the local AI folder (`ia-locali`) next to Vox, in `.vox` in your user folder, or in `X:\\Vox` on any drive, or enter any folder in the field above. Inside it, put llama.cpp's `llama-server.exe` in a subfolder (for example `motore/`), the `.gguf` files in `modelli/`, and a `modelli.json` like this:")} chatMessageLocation={undefined} />
			<pre className='p-3 rounded-vox-md bg-vox-bg-1 border border-vox-hairline text-vox-fg-2 text-xs font-mono overflow-x-auto select-text'>{VOX_LOCAL_MANIFEST_EXAMPLE}</pre>
			<ChatMarkdownRender string={t("`motore` is relative to the folder. For each model: `nome`, `file` (only the `.gguf` file name, without folders: the file is in `modelli/`), `contesto`, `porta` and `uso` (`chat`, `completamento` or `embedding`). Vox starts `chat` models from the chat and the `completamento` model for autocomplete; `embedding` models must be started manually.")} chatMessageLocation={undefined} />
		</div>
	</details>
}


const RedoOnboardingButton = ({ className }: { className?: string }) => {
	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	return <button
		type='button'
		className={`@@vox-btn @@vox-btn-ghost ${className ?? ''}`}
		onClick={() => { voxSettingsService.setGlobalSetting('isOnboardingComplete', false) }}
	>
		<Sparkles size={13} aria-hidden='true' />
		{t("Show the welcome screen")}</button>

}







export const ToolApprovalTypeSwitch = ({ approvalType, size, desc }: { approvalType: ToolApprovalType, size: "xxs" | "xs" | "sm" | "sm+" | "md", desc: string }) => {
	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const voxSettingsState = useSettingsState()

	const onToggleAutoApprove = useCallback((approvalType: ToolApprovalType, newValue: boolean) => {
		voxSettingsService.setGlobalSetting('autoApprove', {
			...voxSettingsService.state.globalSettings.autoApprove,
			[approvalType]: newValue
		})
	}, [voxSettingsService])

	return <>
		<VoxSwitch
			size={size}
			value={voxSettingsState.globalSettings.autoApprove[approvalType] ?? false}
			onChange={(newVal) => onToggleAutoApprove(approvalType, newVal)}
			ariaLabel={desc}
		/>
		<span className="text-vox-fg-3 text-xs">{desc}</span>
	</>
}



// full settings

// MCP Server component
const MCPServerComponent = ({ name, server }: { name: string, server: MCPServer }) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const voxSettings = useSettingsState()
	const isOn = voxSettings.mcpUserStateOfName[name]?.isOn

	const removeUniquePrefix = (name: string) => name.split('_').slice(1).join('_')

	return (
		<div className="@@vox-card py-3 px-4 my-2">
			<div className="flex items-center justify-between">
				{/* Left side - status and name */}
				<div className="flex items-center gap-2">
					{/* Status indicator */}
					<div className={`size-2 rounded-full
						${server.status === 'success' ? 'bg-vox-success'
							: server.status === 'error' ? 'bg-vox-danger'
								: server.status === 'loading' ? 'bg-vox-warning motion-safe:animate-pulse'
									: server.status === 'offline' ? 'bg-vox-fg-3'
										: ''}
					`}></div>

					{/* Server name */}
					<div className="text-sm font-medium text-vox-fg-1">{name}</div>
				</div>

				{/* Right side - power toggle switch */}
				<VoxSwitch
					value={isOn ?? false}
					size='xs'
					disabled={server.status === 'error'}
					onChange={() => mcpService.toggleServerIsOn(name, !isOn)}
					ariaLabel={name}
				/>
			</div>

			{/* Tools section */}
			{isOn && (
				<div className="mt-3">
					<div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
						{(server.tools ?? []).length > 0 ? (
							(server.tools ?? []).map((tool: { name: string; description?: string }) => (
								<span
									key={tool.name}
									className="@@vox-chip font-mono"

									data-tooltip-id='vox-tooltip'
									data-tooltip-content={tool.description || ''}
									data-tooltip-class-name='vox-max-w-[300px]'
								>
									{removeUniquePrefix(tool.name)}
								</span>
							))
						) : (
							<span className="text-xs text-vox-fg-3">{t("No tools available")}</span>
						)}
					</div>
				</div>
			)}

			{/* Command badge */}
			{isOn && server.command && (
				<div className="mt-3">
					<div className="text-xs text-vox-fg-3 mb-1">{t("Command:")}</div>
					<div className="px-2.5 py-1.5 bg-vox-bg-1 border border-vox-hairline text-xs font-mono overflow-x-auto whitespace-nowrap text-vox-fg-2 rounded-vox-md select-text">
						{server.command}
					</div>
				</div>
			)}

			{/* Error message if present */}
			{server.error && (
				<div className="mt-3">
					<WarningBox text={server.error} />
				</div>
			)}
		</div>
	);
};

// Main component that renders the list of servers
const MCPServersList = () => {
	const mcpServiceState = useMCPServiceState()

	let content: React.ReactNode
	if (mcpServiceState.error) {
		content = <div className="text-vox-fg-3 text-sm mt-2">
			{mcpServiceState.error}
		</div>
	}
	else {
		const entries = Object.entries(mcpServiceState.mcpServerOfName)
		if (entries.length === 0) {
			content = <div className="text-vox-fg-3 text-sm mt-2">
				{t("No servers found")}</div>
		}
		else {
			content = entries.map(([name, server]) => (
				<MCPServerComponent key={name} name={name} server={server} />
			))
		}
	}

	return <div className="my-2">{content}</div>
};

export const Settings = () => {
	const isDark = useIsDark()
	// ─── sidebar nav ──────────────────────────
	const [selectedSection, setSelectedSection] =
		useState<Tab>('models');

	const navItems: { tab: Tab; label: string; Icon: React.ComponentType<{ size?: number, className?: string }> }[] = [
		{ tab: 'models', label: t("Models"), Icon: Boxes },
		{ tab: 'localProviders', label: t("Local AI"), Icon: Cpu },
		{ tab: 'providers', label: t("CLI AI"), Icon: SquareTerminal },
		{ tab: 'featureOptions', label: t("Feature Options"), Icon: SlidersHorizontal },
		{ tab: 'general', label: t("General"), Icon: Settings2 },
		{ tab: 'mcp', label: 'MCP', Icon: Plug },
		{ tab: 'all', label: t("All Settings"), Icon: LayoutList },
	];
	const shouldShowTab = (tab: Tab) => selectedSection === 'all' || selectedSection === tab;
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const environmentService = accessor.get('IEnvironmentService')
	const nativeHostService = accessor.get('INativeHostService')
	const settingsState = useSettingsState()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const chatThreadsService = accessor.get('IChatThreadService')
	const notificationService = accessor.get('INotificationService')
	const mcpService = accessor.get('IMCPService')

	const onDownload = (kind: 'Chats' | 'Settings') => {
		let dataStr: string
		let downloadName: string
		if (kind === 'Chats') {
			// Export chat threads
			dataStr = JSON.stringify(chatThreadsService.state, null, 2)
			downloadName = 'vox-chats.json'
		}
		else if (kind === 'Settings') {
			// Export user settings
			dataStr = JSON.stringify(voxSettingsService.state, null, 2)
			downloadName = 'vox-settings.json'
		}
		else {
			dataStr = ''
			downloadName = ''
		}

		const blob = new Blob([dataStr], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = downloadName
		a.click()
		URL.revokeObjectURL(url)
	}


	// Add file input refs
	const fileInputSettingsRef = useRef<HTMLInputElement>(null)
	const fileInputChatsRef = useRef<HTMLInputElement>(null)

	const [s, ss] = useState(0)

	const handleUpload = (kind: 'Chats' | 'Settings') => (e: React.ChangeEvent<HTMLInputElement>,) => {
		const files = e.target.files
		if (!files) return;
		const file = files[0]
		if (!file) return

		const reader = new FileReader();
		reader.onload = () => {
			try {
				const json = JSON.parse(reader.result as string);

				if (kind === 'Chats') {
					chatThreadsService.dangerousSetState(json as any)
				}
				else if (kind === 'Settings') {
					voxSettingsService.dangerousSetState(json as any)
				}

				notificationService.info(t("{0} imported successfully!", t(kind)))
			} catch (err) {
				notificationService.notify({ message: t("Failed to import {0}", t(kind)), source: err + '', severity: Severity.Error, })
			}
		};
		reader.readAsText(file);
		e.target.value = '';

		ss(s => s + 1)
	}


	return (
		<div className={`@@vox-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
			<div className="flex flex-col md:flex-row w-full gap-2 md:gap-8 max-w-[1040px] mx-auto mb-32 px-2" style={{ minHeight: '80vh' }}>
				{/* ──────────────  SIDEBAR  ────────────── */}

				<aside className="md:w-56 w-full pt-6 md:pt-10 px-4 md:px-0 shrink-0">
					<div className='md:sticky md:top-10'>
						{/* brand */}
						<div className='flex items-center gap-2.5 mb-6 px-2 select-none'>
							<span aria-hidden='true' className='size-8 rounded-vox-md bg-vox-accent text-vox-accent-fg flex items-center justify-center shadow-vox-sm'>
								<Settings2 size={16} />
							</span>
							<div className='leading-tight'>
								<div className='text-[14px] font-semibold text-vox-fg-1'>Vox</div>
								<div className='text-[11.5px] text-vox-fg-3'>{t("Settings")}</div>
							</div>
						</div>
						{/* vertical tab list */}
						<nav aria-label={t("Settings")} className="flex flex-row flex-wrap md:flex-col gap-1">
							{navItems.map(({ tab, label, Icon }) => (
								<button
									type='button'
									key={tab}
									aria-current={selectedSection === tab ? 'page' : undefined}
									onClick={() => {
										if (tab === 'all') {
											setSelectedSection('all');
											window.scrollTo({ top: 0, behavior: 'smooth' });
										} else {
											setSelectedSection(tab);
										}
									}}
									className={`
										group relative flex items-center gap-2.5 py-1.5 px-2.5 rounded-vox-md text-left text-[13px] transition-colors duration-150
										${selectedSection === tab
											? 'bg-vox-accent-soft text-vox-fg-1 font-medium'
											: 'text-vox-fg-3 hover:text-vox-fg-1 hover:bg-vox-surface-hover'}
									`}
								>
									{selectedSection === tab && <span aria-hidden='true' className='hidden md:block absolute -left-2 top-1.5 bottom-1.5 w-[3px] rounded-full bg-vox-accent' />}
									<Icon size={15} className={`flex-shrink-0 ${selectedSection === tab ? 'text-vox-accent-text' : 'text-vox-fg-4 group-hover:text-vox-fg-2'}`} />
									{label}
								</button>
							))}
						</nav>
					</div>
				</aside>

				{/* ───────────── MAIN PANE ───────────── */}
				<main className="flex-1 min-w-0 px-4 md:px-0 pt-6 md:pt-10 select-none">



					<div className='max-w-3xl'>

						<div className='flex flex-wrap items-end justify-between gap-3 pb-5 mb-8 border-b border-vox-hairline'>
							<div>
								<h1 className='text-[22px] font-semibold tracking-tight text-vox-fg-1'>{t("Vox's Settings")}</h1>
								<div className='text-[13px] text-vox-fg-3 mt-1'>{t("Models, local AI, tools and preferences in one place.")}</div>
							</div>
							<ErrorBoundary>
								<RedoOnboardingButton />
							</ErrorBoundary>
						</div>

						{/* All sections in flex container with gap-12 */}
						<div className='flex flex-col gap-12'>
							{/* Models section (formerly FeaturesTab) */}
							<div className={shouldShowTab('models') ? `` : 'hidden'}>
								<ErrorBoundary>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("Models")}</h2>
									<ModelDump />
									<div className='w-full h-[1px] my-4' />
									<AutoDetectLocalModelsToggle />
									<RefreshableModels />
								</ErrorBoundary>
							</div>

							{/* Local AI section */}
							<div className={shouldShowTab('localProviders') ? `` : 'hidden'}>
								<ErrorBoundary>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("Local AI")}</h2>
									<h3 className='text-[13px] text-vox-fg-3 mb-4'>{t("Vox runs the models in its local AI folder on this PC: nothing leaves your computer.")}</h3>

									<VoxProviderSettings providerNames={['voxLocal']} />
								</ErrorBoundary>
							</div>

							{/* CLI AI section */}
							<div className={shouldShowTab('providers') ? `` : 'hidden'}>
								<ErrorBoundary>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("CLI AI")}</h2>
									<h3 className='text-[13px] text-vox-fg-3 mb-4'>{t("Vox can use the AI command-line tools installed and signed in on this PC.")}</h3>

									<VoxProviderSettings providerNames={['cliAgent']} />
								</ErrorBoundary>
							</div>

							{/* Feature Options section */}
							<div className={shouldShowTab('featureOptions') ? `` : 'hidden'}>
								<ErrorBoundary>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("Feature Options")}</h2>

									<div className='flex flex-col gap-3 my-2'>
										<ErrorBoundary>
											{/* FIM */}
											<div className='@@vox-card px-5 py-4'>
												<h4 className='text-[14px] font-semibold text-vox-fg-1'>{displayInfoOfFeatureName('Autocomplete')}</h4>
												<div className='text-sm text-vox-fg-3 mt-1'>
													<span>
														{t("Experimental.")}{' '}
													</span>
													<span
														className='hover:brightness-110'
														data-tooltip-id='vox-tooltip'
														data-tooltip-content={t("Uses the completion model of Vox's local AI folder (\"uso\": \"completamento\" in modelli.json), for example qwen2.5-coder.")}
														data-tooltip-class-name='vox-max-w-[300px]'
													>
														{t("Only works with FIM models.*")}</span>
												</div>

												<div className='my-2'>
													{/* Enable Switch */}
													<ErrorBoundary>
														<div className='flex items-center gap-x-2 my-2'>
															<VoxSwitch
																size='xs'
																value={settingsState.globalSettings.enableAutocomplete}
																onChange={(newVal) => voxSettingsService.setGlobalSetting('enableAutocomplete', newVal)}
																ariaLabel={displayInfoOfFeatureName('Autocomplete')}
															/>
															<span className='text-vox-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.enableAutocomplete ? t("Enabled") : t("Disabled")}</span>
														</div>
													</ErrorBoundary>

													{/* Model Dropdown */}
													<ErrorBoundary>
														<div className={`my-2 ${!settingsState.globalSettings.enableAutocomplete ? 'hidden' : ''}`}>
															<ModelDropdown featureName={'Autocomplete'} className='text-xs text-vox-fg-2 bg-vox-bg-1 border border-vox-hairline-strong hover:border-vox-accent-border rounded-vox-md py-1 px-2 transition-colors' />
														</div>
													</ErrorBoundary>

												</div>

											</div>
										</ErrorBoundary>

										{/* Apply */}
										<ErrorBoundary>

											<div className='w-full @@vox-card px-5 py-4'>
												<h4 className='text-[14px] font-semibold text-vox-fg-1'>{displayInfoOfFeatureName('Apply')}</h4>
												<div className='text-sm text-vox-fg-3 mt-1'>{t("Settings that control the behavior of the Apply button.")}</div>

												<div className='my-2'>
													{/* Sync to Chat Switch */}
													<div className='flex items-center gap-x-2 my-2'>
														<VoxSwitch
															size='xs'
															value={settingsState.globalSettings.syncApplyToChat}
															onChange={(newVal) => voxSettingsService.setGlobalSetting('syncApplyToChat', newVal)}
															ariaLabel={`${displayInfoOfFeatureName('Apply')}: ${t("Same as Chat model")}`}
														/>
														<span className='text-vox-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.syncApplyToChat ? t("Same as Chat model") : t("Different model")}</span>
													</div>

													{/* Model Dropdown */}
													<div className={`my-2 ${settingsState.globalSettings.syncApplyToChat ? 'hidden' : ''}`}>
														<ModelDropdown featureName={'Apply'} className='text-xs text-vox-fg-2 bg-vox-bg-1 border border-vox-hairline-strong hover:border-vox-accent-border rounded-vox-md py-1 px-2 transition-colors' />
													</div>
												</div>


												<div className='my-2'>
													{/* Fast Apply Method Dropdown */}
													<div className='flex items-center gap-x-2 my-2'>
														<FastApplyMethodDropdown />
													</div>
												</div>

											</div>
										</ErrorBoundary>




										{/* Tools Section */}
										<div className='@@vox-card px-5 py-4'>
											<h4 className='text-[14px] font-semibold text-vox-fg-1'>{t("Tools")}</h4>
											<div className='text-sm text-vox-fg-3 mt-1'>{t("Tools are functions that LLMs can call. Some tools require user approval.")}</div>

											<div className='my-2'>
												{/* Auto Accept Switch */}
												<ErrorBoundary>
													{[...toolApprovalTypes].map((approvalType) => {
														return <div key={approvalType} className="flex items-center gap-x-2 my-2">
															<ToolApprovalTypeSwitch size='xs' approvalType={approvalType} desc={t("Auto-approve {0}", t(approvalType))} />
														</div>
													})}

												</ErrorBoundary>

												{/* Tool Lint Errors Switch */}
												<ErrorBoundary>

													<div className='flex items-center gap-x-2 my-2'>
														<VoxSwitch
															size='xs'
															value={settingsState.globalSettings.includeToolLintErrors}
															onChange={(newVal) => voxSettingsService.setGlobalSetting('includeToolLintErrors', newVal)}
															ariaLabel={t("Fix lint errors")}
														/>
														<span className='text-vox-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.includeToolLintErrors ? t("Fix lint errors") : t("Fix lint errors")}</span>
													</div>
												</ErrorBoundary>

												{/* Auto Accept LLM Changes Switch */}
												<ErrorBoundary>
													<div className='flex items-center gap-x-2 my-2'>
														<VoxSwitch
															size='xs'
															value={settingsState.globalSettings.autoAcceptLLMChanges}
															onChange={(newVal) => voxSettingsService.setGlobalSetting('autoAcceptLLMChanges', newVal)}
															ariaLabel={t("Auto-accept LLM changes")}
														/>
														<span className='text-vox-fg-3 text-xs pointer-events-none'>{t("Auto-accept LLM changes")}</span>
													</div>
												</ErrorBoundary>
											</div>
										</div>



										<div className='w-full @@vox-card px-5 py-4'>
											<h4 className='text-[14px] font-semibold text-vox-fg-1'>{t("Editor")}</h4>
											<div className='text-sm text-vox-fg-3 mt-1'>{t("Settings that control the visibility of Vox suggestions in the code editor.")}</div>

											<div className='my-2'>
												{/* Auto Accept Switch */}
												<ErrorBoundary>
													<div className='flex items-center gap-x-2 my-2'>
														<VoxSwitch
															size='xs'
															value={settingsState.globalSettings.showInlineSuggestions}
															onChange={(newVal) => voxSettingsService.setGlobalSetting('showInlineSuggestions', newVal)}
															ariaLabel={t("Show suggestions on select")}
														/>
														<span className='text-vox-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.showInlineSuggestions ? t("Show suggestions on select") : t("Show suggestions on select")}</span>
													</div>
												</ErrorBoundary>
											</div>
										</div>

										{/* SCM */}
										<ErrorBoundary>

											<div className='w-full @@vox-card px-5 py-4'>
												<h4 className='text-[14px] font-semibold text-vox-fg-1'>{displayInfoOfFeatureName('SCM')}</h4>
												<div className='text-sm text-vox-fg-3 mt-1'>{t("Settings that control the behavior of the commit message generator.")}</div>

												<div className='my-2'>
													{/* Sync to Chat Switch */}
													<div className='flex items-center gap-x-2 my-2'>
														<VoxSwitch
															size='xs'
															value={settingsState.globalSettings.syncSCMToChat}
															onChange={(newVal) => voxSettingsService.setGlobalSetting('syncSCMToChat', newVal)}
															ariaLabel={`${displayInfoOfFeatureName('SCM')}: ${t("Same as Chat model")}`}
														/>
														<span className='text-vox-fg-3 text-xs pointer-events-none'>{settingsState.globalSettings.syncSCMToChat ? t("Same as Chat model") : t("Different model")}</span>
													</div>

													{/* Model Dropdown */}
													<div className={`my-2 ${settingsState.globalSettings.syncSCMToChat ? 'hidden' : ''}`}>
														<ModelDropdown featureName={'SCM'} className='text-xs text-vox-fg-2 bg-vox-bg-1 border border-vox-hairline-strong hover:border-vox-accent-border rounded-vox-md py-1 px-2 transition-colors' />
													</div>
												</div>

											</div>
										</ErrorBoundary>
									</div>
								</ErrorBoundary>
							</div>

							{/* General section */}
							<div className={`${shouldShowTab('general') ? `` : 'hidden'} flex flex-col gap-12`}>
								{/* Import/Export section */}
								<div>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("Import/Export")}</h2>
									<h4 className='text-[13px] text-vox-fg-3 mb-4'>{t("Transfer Vox's settings and chats in and out of Vox.")}</h4>
									<div className='flex flex-wrap gap-3'>
										{/* Settings Subcategory */}
										<div className='@@vox-card p-3 flex flex-col gap-2 w-full max-w-56'>
											<input key={2 * s} ref={fileInputSettingsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Settings')} />
											<VoxButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputSettingsRef.current?.click() }}>
												{t("Import Settings")}</VoxButtonBgDarken>
											<VoxButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Settings')}>
												{t("Export Settings")}</VoxButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { voxSettingsService.resetState(); }}>
												{t("Reset Settings")}</ConfirmButton>
										</div>

										{/* Chats Subcategory */}
										<div className='@@vox-card p-3 flex flex-col gap-2 w-full max-w-56'>
											<input key={2 * s + 1} ref={fileInputChatsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Chats')} />
											<VoxButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputChatsRef.current?.click() }}>
												{t("Import Chats")}</VoxButtonBgDarken>
											<VoxButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Chats')}>
												{t("Export Chats")}</VoxButtonBgDarken>
											<ConfirmButton className='px-4 py-1 w-full' onConfirm={() => { chatThreadsService.resetState(); }}>
												{t("Reset Chats")}</ConfirmButton>
										</div>
									</div>
								</div>



								{/* Built-in Settings section */}
								<div>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("Built-in Settings")}</h2>
									<h4 className='text-[13px] text-vox-fg-3 mb-4'>{t("IDE settings, keyboard settings, and theme customization.")}</h4>

									<ErrorBoundary>
										<div className='@@vox-card p-3 flex flex-col gap-2 justify-center w-full max-w-56'>
											<VoxButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openSettings') }}>
												{t("General Settings")}</VoxButtonBgDarken>
											<VoxButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings') }}>
												{t("Keyboard Settings")}</VoxButtonBgDarken>
											<VoxButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.selectTheme') }}>
												{t("Theme Settings")}</VoxButtonBgDarken>
											<VoxButtonBgDarken className='px-4 py-1' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath) }}>
												{t("Open Logs")}</VoxButtonBgDarken>
										</div>
									</ErrorBoundary>
								</div>


								{/* AI Instructions section */}
								<div className='max-w-[600px]'>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>{t("AI Instructions")}</h2>
									<h4 className='text-[13px] text-vox-fg-3 mb-4'>
										<ChatMarkdownRender inPTag={true} string={t("System instructions to include with all AI requests. Alternatively, place a `.voxrules` file in the root of your workspace.")} chatMessageLocation={undefined} />
									</h4>
									<ErrorBoundary>
										<AIInstructionsBox />
									</ErrorBoundary>
									{/* --- Disable System Message Toggle --- */}
									<div className='my-4'>
										<ErrorBoundary>
											<div className='flex items-center gap-x-2'>
												<VoxSwitch
													size='xs'
													value={!!settingsState.globalSettings.disableSystemMessage}
													ariaLabel={t("Disable system message")}
													onChange={(newValue) => {
														voxSettingsService.setGlobalSetting('disableSystemMessage', newValue);
													}}
												/>
												<span className='text-vox-fg-3 text-xs pointer-events-none'>
													{t("Disable system message")}
												</span>
											</div>
										</ErrorBoundary>
										<div className='text-vox-fg-3 text-xs mt-1'>
											{t("When disabled, Vox will not include anything in the system message except for content you specified above.")}
										</div>
									</div>
								</div>

							</div>



							{/* MCP section */}
							<div className={shouldShowTab('mcp') ? `` : 'hidden'}>
								<ErrorBoundary>
									<h2 className='text-[18px] font-semibold tracking-tight text-vox-fg-1 mb-1'>MCP</h2>
									<h4 className='text-[13px] text-vox-fg-3 mb-4'>
										<ChatMarkdownRender inPTag={true} string={t("Use Model Context Protocol to provide Agent mode with more tools.")} chatMessageLocation={undefined} />
									</h4>
									<div className='my-2'>
										<VoxButtonBgDarken className='px-4 py-1 w-full max-w-48' onClick={async () => { await mcpService.revealMCPConfigFile() }}>
											{t("Add MCP Server")}</VoxButtonBgDarken>
									</div>

									<ErrorBoundary>
										<MCPServersList />
									</ErrorBoundary>
								</ErrorBoundary>
							</div>





						</div>

					</div>
				</main>
			</div>
		</div>
	);
}
