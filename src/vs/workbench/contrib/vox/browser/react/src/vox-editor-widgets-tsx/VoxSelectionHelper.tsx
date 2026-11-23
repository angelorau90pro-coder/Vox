/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


import { t } from '../../../../common/voxI18n.js';
import { useAccessor, useActiveURI, useIsDark, useSettingsState } from '../util/services.js';

import '../styles.css'
import { VOX_CTRL_K_ACTION_ID, VOX_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { Circle, MoreVertical } from 'lucide-react';
import { useEffect, useState } from 'react';

import { VoxSelectionHelperProps } from '../../../../../../contrib/vox/browser/voxSelectionHelperWidget.js';
import { VOX_OPEN_SETTINGS_ACTION_ID } from '../../../voxSettingsPane.js';


export const VoxSelectionHelperMain = (props: VoxSelectionHelperProps) => {

	const isDark = useIsDark()

	return <div
		className={`@@vox-scope ${isDark ? 'dark' : ''}`}
	>
		<VoxSelectionHelper {...props} />
	</div>
}



const VoxSelectionHelper = ({ rerenderKey }: VoxSelectionHelperProps) => {


	const accessor = useAccessor()
	const keybindingService = accessor.get('IKeybindingService')
	const commandService = accessor.get('ICommandService')

	const ctrlLKeybind = keybindingService.lookupKeybinding(VOX_CTRL_L_ACTION_ID)
	const ctrlKKeybind = keybindingService.lookupKeybinding(VOX_CTRL_K_ACTION_ID)

	const dividerHTML = <div className='w-px my-1 bg-vox-hairline-strong'></div>

	const [reactRerenderCount, setReactRerenderKey] = useState(rerenderKey)
	const [clickState, setClickState] = useState<'init' | 'clickedOption' | 'clickedMore'>('init')

	useEffect(() => {
		const disposable = commandService.onWillExecuteCommand(e => {
			if (e.commandId === VOX_CTRL_L_ACTION_ID || e.commandId === VOX_CTRL_K_ACTION_ID) {
				setClickState('clickedOption')
			}
		});

		return () => {
			disposable.dispose();
		};
	}, [commandService, setClickState]);


	// rerender when the key changes
	if (reactRerenderCount !== rerenderKey) {
		setReactRerenderKey(rerenderKey)
		setClickState('init')
	}
	// useEffect(() => {
	// }, [rerenderKey, reactRerenderCount, setReactRerenderKey, setClickState])

	// if the user selected an option, close


	if (clickState === 'clickedOption') {
		return null
	}

	const defaultHTML = <>
		{ctrlLKeybind &&
			<div
				className='
					flex items-center px-2 py-1.5
					cursor-pointer hover:bg-vox-surface-hover hover:text-vox-fg-1 transition-colors
				'
				onClick={() => {
					commandService.executeCommand(VOX_CTRL_L_ACTION_ID)
					setClickState('clickedOption');
				}}
			>
				<span>{t("Add to Chat")}</span>
				<span className='ml-1.5 @@vox-kbd'>
					{ctrlLKeybind.getLabel()}
				</span>
			</div>
		}
		{ctrlLKeybind && ctrlKKeybind &&
			dividerHTML
		}
		{ctrlKKeybind &&
			<div
				className='
					flex items-center px-2 py-1.5
					cursor-pointer hover:bg-vox-surface-hover hover:text-vox-fg-1 transition-colors
				'
				onClick={() => {
					commandService.executeCommand(VOX_CTRL_K_ACTION_ID)
					setClickState('clickedOption');
				}}
			>
				<span className='ml-1'>{t("Edit Inline")}</span>
				<span className='ml-1.5 @@vox-kbd'>
					{ctrlKKeybind.getLabel()}
				</span>
			</div>
		}

		{dividerHTML}

		<div
			className='
				flex items-center px-0.5
				cursor-pointer hover:bg-vox-surface-hover hover:text-vox-fg-1 transition-colors
			'
			onClick={() => {
				setClickState('clickedMore');
			}}
		>
			<MoreVertical className="w-4" />
		</div>
	</>


	const moreOptionsHTML = <>
		<div
			className='
				flex items-center px-2 py-1.5
				cursor-pointer hover:bg-vox-surface-hover hover:text-vox-fg-1 transition-colors
			'
			onClick={() => {
				commandService.executeCommand(VOX_OPEN_SETTINGS_ACTION_ID);
				setClickState('clickedOption');
			}}
		>
			{t("Disable Suggestions?")}</div>

		{dividerHTML}

		<div
			className='
				flex items-center px-0.5
				cursor-pointer hover:bg-vox-surface-hover hover:text-vox-fg-1 transition-colors
			'
			onClick={() => {
				setClickState('init');
			}}
		>
			<MoreVertical className="w-4" />
		</div>
	</>

	return <div className='
		pointer-events-auto select-none
		z-[1000]
		rounded-vox-md shadow-vox-md flex flex-nowrap text-nowrap overflow-hidden text-[12px]
		border border-vox-hairline-strong bg-vox-surface-raised text-vox-fg-2
		transition-all duration-200
	'>
		{clickState === 'init' ? defaultHTML
			: clickState === 'clickedMore' ? moreOptionsHTML
				: <></>
		}
	</div>
}
