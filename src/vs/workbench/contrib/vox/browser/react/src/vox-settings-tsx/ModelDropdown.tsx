/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitCliAgentModel, FeatureName, isFeatureNameDisabled, modelSelectionsEqual, displayInfoOfProviderName } from '../../../../../../../workbench/contrib/vox/common/voxSettingsTypes.js'
import { useSettingsState, useAccessor } from '../util/services.js'
import { VoxCustomDropdownBox } from '../util/inputs.js'
import { VOX_OPEN_SETTINGS_ACTION_ID } from '../../../voxSettingsPane.js'
import { modelFilterOfFeatureName, ModelOption } from '../../../../../../../workbench/contrib/vox/common/voxSettingsService.js'
import { WarningBox } from './WarningBox.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { suggestedModelsOfCliAgent } from '../../../../../../../workbench/contrib/vox/common/modelCapabilities.js'
import { Pencil } from 'lucide-react'

const optionsEqual = (m1: ModelOption[], m2: ModelOption[]) => {
	if (m1.length !== m2.length) return false
	for (let i = 0; i < m1.length; i++) {
		if (!modelSelectionsEqual(m1[i].selection, m2[i].selection)) return false
		if (m1[i].description !== m2[i].description) return false
	}
	return true
}

type CliModelItem = {
	id: string; // '' per Predefinito, altrimenti nome modello oppure '__custom__'
	name: string;
	detail?: string;
}

const CliAgentModelSelector = ({
	agent,
	currentSubModel,
	onChangeSubModel,
	className,
}: {
	agent: string;
	currentSubModel: string;
	onChangeSubModel: (newSubModel: string) => void;
	className: string;
}) => {
	const settingsState = useSettingsState()
	const [isEditing, setIsEditing] = useState(false)
	const [customInput, setCustomInput] = useState('')

	// Costruisci le opzioni del modello per questa IA
	const options = useMemo<CliModelItem[]>(() => {
		const items: CliModelItem[] = [
			{ id: '', name: t("Default"), detail: t("no --model") },
		]

		// Modelli suggeriti per questa specifica IA
		const suggested = Object.hasOwn(suggestedModelsOfCliAgent, agent) ? suggestedModelsOfCliAgent[agent] : []
		for (const m of suggested) {
			items.push({ id: m, name: m, detail: t("suggested") })
		}

		// Eventuali modelli già salvati nelle impostazioni per questa IA (es. "codex:modello-custom")
		const cliModels = settingsState.settingsOfProvider.cliAgent?.models || []
		const prefix = `${agent}:`
		for (const cm of cliModels) {
			if (!cm.isHidden && cm.modelName.startsWith(prefix)) {
				const customName = cm.modelName.slice(prefix.length).trim()
				if (customName && !items.some(item => item.id === customName)) {
					items.push({ id: customName, name: customName, detail: t("configured") })
				}
			}
		}

		// Se il modello corrente non è tra quelli elencati, aggiungilo come personalizzato
		if (currentSubModel && !items.some(item => item.id === currentSubModel)) {
			items.push({ id: currentSubModel, name: currentSubModel, detail: t("custom") })
		}

		// Voce per scrivere un modello a mano
		items.push({ id: '__custom__', name: t("Custom..."), detail: t("Enter manually") })

		return items.filter(item => !cliModels.some(cm => cm.isHidden && cm.modelName === (item.id ? `${agent}:${item.id}` : agent)))
	}, [agent, currentSubModel, settingsState.settingsOfProvider.cliAgent?.models])

	const selectedOption = useMemo<CliModelItem>(() => {
		return options.find(opt => opt.id === currentSubModel) || options[0]
	}, [options, currentSubModel])

	const handleApplyCustom = useCallback(() => {
		onChangeSubModel(customInput)
		setIsEditing(false)
	}, [customInput, onChangeSubModel])

	const handleCancelCustom = useCallback(() => {
		setIsEditing(false)
	}, [])

	if (isEditing) {
		return (
			<div className="flex items-center gap-1" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
				<input
					type="text"
					autoFocus
					value={customInput}
					placeholder={t("Model name")}
					onChange={(e) => setCustomInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault()
							handleApplyCustom()
						} else if (e.key === 'Escape') {
							e.preventDefault()
							handleCancelCustom()
						}
					}}
					className="text-xs bg-vox-bg-1 border border-vox-hairline-strong rounded-vox-sm px-1.5 py-0.5 text-vox-fg-1 focus:border-vox-accent outline-none w-28 transition-colors"
				/>
				<button
					type="button"
					title={t("Apply model")}
					className="text-xs font-medium px-1.5 py-0.5 rounded-vox-sm cursor-pointer bg-vox-accent text-vox-accent-fg hover:bg-vox-accent-hover transition-colors"
					onClick={handleApplyCustom}
				>
					{t("OK")}
				</button>
				<button
					type="button"
					title={t("Cancel")}
					aria-label={t("Cancel")}
					className="text-xs text-vox-fg-3 hover:text-vox-fg-1 hover:bg-vox-surface-hover px-1 py-0.5 rounded-vox-sm cursor-pointer transition-colors"
					onClick={handleCancelCustom}
				>
					✕
				</button>
			</div>
		)
	}

	return (
		<div className="flex items-center gap-1">
			<VoxCustomDropdownBox
				options={options}
				selectedOption={selectedOption}
				onChangeOption={(opt) => {
					if (opt.id === '__custom__') {
						setCustomInput(currentSubModel)
						setIsEditing(true)
					} else {
						onChangeSubModel(opt.id)
					}
				}}
				getOptionDisplayName={(opt) => opt.name}
				getOptionDropdownName={(opt) => opt.name}
				getOptionDropdownDetail={(opt) => opt.detail}
				getOptionsEqual={(a, b) => a.id === b.id}
				className={className}
				matchInputWidth={false}
				ariaLabel={t("Model for {0}", agent)}
			/>
			<button
				type="button"
				title={t("Edit model manually")}
				aria-label={t("Edit model manually")}
				className="text-vox-fg-3 hover:text-vox-fg-1 hover:bg-vox-surface-hover p-1 rounded-full cursor-pointer flex items-center transition-colors"
				onClick={() => {
					setCustomInput(currentSubModel)
					setIsEditing(true)
				}}
			>
				<Pencil size={11} />
			</button>
		</div>
	)
}

const ModelSelectBox = ({ options, featureName, className }: { options: ModelOption[], featureName: FeatureName, className: string }) => {
	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')
	const settingsState = useSettingsState()

	const selection = settingsState.modelSelectionOfFeature[featureName]

	// Opzioni deduplicate per il menu principale delle IA / modelli
	const iaOptions = useMemo<ModelOption[]>(() => {
		const seenCliAgents = new Set<string>()
		const result: ModelOption[] = []
		for (const opt of options) {
			if (opt.selection.providerName === 'cliAgent') {
				const { agent } = splitCliAgentModel(opt.selection.modelName)
				if (!seenCliAgents.has(agent)) {
					seenCliAgents.add(agent)
					result.push({
						name: t("{0} (CLI AI)", agent),
						selection: opt.selection,
					})
				}
			} else {
				result.push(opt)
			}
		}
		return result
	}, [options])

	const selectedIaOption = useMemo<ModelOption>(() => {
		if (!selection) return iaOptions[0] || options[0]
		if (selection.providerName === 'cliAgent') {
			const { agent } = splitCliAgentModel(selection.modelName)
			return iaOptions.find(opt => opt.selection.providerName === 'cliAgent' && splitCliAgentModel(opt.selection.modelName).agent === agent) || iaOptions[0] || options[0]
		}
		return iaOptions.find(opt => modelSelectionsEqual(opt.selection, selection)) || iaOptions[0] || options[0]
	}, [iaOptions, selection, options])

	const onChangeIaOption = useCallback((newOption: ModelOption) => {
		if (newOption.selection.providerName === 'cliAgent') {
			const { agent } = splitCliAgentModel(newOption.selection.modelName)
			// Recupera l'ultimo modello ricordato per questa IA
			const memory = voxSettingsService.state.lastModelOfCliAgent
			const remembered = Object.hasOwn(memory, agent) ? memory[agent] : splitCliAgentModel(newOption.selection.modelName).subModel
			const targetModelName = remembered ? `${agent}:${remembered}` : agent
			voxSettingsService.setModelSelectionOfFeature(featureName, {
				providerName: 'cliAgent',
				modelName: targetModelName,
			})
		} else {
			voxSettingsService.setModelSelectionOfFeature(featureName, newOption.selection)
		}
	}, [voxSettingsService, featureName])

	const isCli = selection?.providerName === 'cliAgent'
	const { agent: currentAgent, subModel: currentSubModel } = splitCliAgentModel(isCli && selection ? selection.modelName : '')

	const onChangeSubModel = useCallback((newSubModel: string) => {
		if (!currentAgent) return
		const clean = newSubModel.trim().replace(/^[-]+/, '')
		const targetModelName = clean ? `${currentAgent}:${clean}` : currentAgent
		voxSettingsService.setModelSelectionOfFeature(featureName, {
			providerName: 'cliAgent',
			modelName: targetModelName,
		})
	}, [voxSettingsService, featureName, currentAgent])

	const iaSelectBox = (
		<VoxCustomDropdownBox
			options={iaOptions}
			selectedOption={selectedIaOption}
			onChangeOption={onChangeIaOption}
			getOptionDisplayName={(option) => {
				if (!selection) return t("Select AI or model")
				if (option.selection.providerName === 'cliAgent') {
					return splitCliAgentModel(option.selection.modelName).agent
				}
				return option.selection.modelName
			}}
			getOptionDropdownName={(option) => {
				if (option.selection.providerName === 'cliAgent') {
					return splitCliAgentModel(option.selection.modelName).agent
				}
				return option.selection.modelName
			}}
			getOptionDropdownDetail={(option) => {
				const title = displayInfoOfProviderName(option.selection.providerName).title
				return option.description ? `${title} · ${option.description}` : title
			}}
			getOptionsEqual={(a, b) => a.selection.providerName === b.selection.providerName && a.selection.modelName === b.selection.modelName}
			className={className}
			matchInputWidth={false}
			ariaLabel={t("Select AI or model")}
		/>
	)

	if (!isCli) {
		return iaSelectBox
	}

	return (
		<div className="flex items-center gap-1.5 flex-wrap">
			{iaSelectBox}
			<CliAgentModelSelector
				key={currentAgent}
				agent={currentAgent}
				currentSubModel={currentSubModel}
				onChangeSubModel={onChangeSubModel}
				className={className}
			/>
		</div>
	)
}


const MemoizedModelDropdown = ({ featureName, className }: { featureName: FeatureName, className: string }) => {
	const settingsState = useSettingsState()
	const oldOptionsRef = useRef<ModelOption[]>([])
	const [memoizedOptions, setMemoizedOptions] = useState(oldOptionsRef.current)

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName]

	useEffect(() => {
		const oldOptions = oldOptionsRef.current
		const newOptions = settingsState._modelOptions.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }))

		if (!optionsEqual(oldOptions, newOptions)) {
			setMemoizedOptions(newOptions)
		}
		oldOptionsRef.current = newOptions
	}, [settingsState._modelOptions, filter])

	if (memoizedOptions.length === 0) { // Pretty sure this will never be reached unless filter is enabled
		return <WarningBox text={emptyMessage?.message || t("No models available")} />
	}

	return <ModelSelectBox featureName={featureName} options={memoizedOptions} className={className} />

}

export const ModelDropdown = ({ featureName, className }: { featureName: FeatureName, className: string }) => {
	const settingsState = useSettingsState()

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')

	const openSettings = () => { commandService.executeCommand(VOX_OPEN_SETTINGS_ACTION_ID); };

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName]

	const isDisabled = isFeatureNameDisabled(featureName, settingsState)
	if (isDisabled && !settingsState._modelOptions.some(o => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel })))
		return <WarningBox onClick={openSettings} text={
			emptyMessage && emptyMessage.priority === 'always' ? emptyMessage.message :
				isDisabled === 'needToEnableModel' ? t("Enable a model")
					: isDisabled === 'addModel' ? t("Add a model")
						: (isDisabled === 'addProvider' || isDisabled === 'notFilledIn' || isDisabled === 'providerNotAutoDetected') ? t("Provider required")
							: t("Provider required")
		} />

	return <ErrorBoundary>
		<MemoizedModelDropdown featureName={featureName} className={className} />
	</ErrorBoundary>
}
