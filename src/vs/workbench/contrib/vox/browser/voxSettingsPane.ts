/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../common/voxI18n.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';


import { mountVoxSettings } from './react/out/vox-settings-tsx/index.js'
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';


// refer to preferences.contribution.ts keybindings editor

class VoxSettingsInput extends EditorInput {

	static readonly ID: string = 'workbench.input.vox.settings';

	static readonly RESOURCE = URI.from({ // I think this scheme is invalid, it just shuts up TS
		scheme: 'vox',  // Custom scheme for our editor (try Schemas.https)
		path: 'settings'
	})
	readonly resource = VoxSettingsInput.RESOURCE;

	constructor() {
		super();
	}

	override get typeId(): string {
		return VoxSettingsInput.ID;
	}

	override getName(): string {
		return t("Vox's Settings");
	}

	override getIcon() {
		return Codicon.checklist // symbol for the actual editor pane
	}

}


class VoxSettingsPane extends EditorPane {
	static readonly ID = 'workbench.test.myCustomPane';

	// private _scrollbar: DomScrollableElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(VoxSettingsPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const settingsElt = document.createElement('div');
		settingsElt.style.height = '100%';
		settingsElt.style.width = '100%';

		parent.appendChild(settingsElt);

		// this._scrollbar = this._register(new DomScrollableElement(scrollableContent, {}));
		// parent.appendChild(this._scrollbar.getDomNode());
		// this._scrollbar.scanDomNode();

		// Mount React into the scrollable content
		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountVoxSettings(settingsElt, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()))

			// setTimeout(() => { // this is a complete hack and I don't really understand how scrollbar works here
			// 	this._scrollbar?.scanDomNode();
			// }, 1000)
		});
	}

	layout(dimension: Dimension): void {
		// if (!settingsElt) return
		// settingsElt.style.height = `${dimension.height}px`;
		// settingsElt.style.width = `${dimension.width}px`;
	}


	override get minimumWidth() { return 700 }

}

// register Settings pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoxSettingsPane, VoxSettingsPane.ID, t("Vox's Settings Pane")),
	[new SyncDescriptor(VoxSettingsInput)]
);


// register the gear on the top right
export const VOX_TOGGLE_SETTINGS_ACTION_ID = 'workbench.action.toggleVoxSettings'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOX_TOGGLE_SETTINGS_ACTION_ID,
			title: ({ ...nls.localize2('voxSettings', "Vox: Toggle Settings"), value: t("Vox: Toggle Settings") }),
			icon: Codicon.settingsGear,
			menu: [
				{
					id: MenuId.LayoutControlMenuSubmenu,
					group: 'z_end',
				},
				{
					id: MenuId.LayoutControlMenu,
					when: ContextKeyExpr.equals('config.workbench.layoutControl.type', 'both'),
					group: 'z_end'
				}
			]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupService = accessor.get(IEditorGroupsService);

		const instantiationService = accessor.get(IInstantiationService);

		// if is open, close it
		const openEditors = editorService.findEditors(VoxSettingsInput.RESOURCE); // should only have 0 or 1 elements...
		if (openEditors.length !== 0) {
			const openEditor = openEditors[0].editor
			const isCurrentlyOpen = editorService.activeEditor?.resource?.fsPath === openEditor.resource?.fsPath
			if (isCurrentlyOpen)
				await editorService.closeEditors(openEditors)
			else
				await editorGroupService.activeGroup.openEditor(openEditor)
			return;
		}


		// else open it
		const input = instantiationService.createInstance(VoxSettingsInput);

		await editorGroupService.activeGroup.openEditor(input);
	}
})



export const VOX_OPEN_SETTINGS_ACTION_ID = 'workbench.action.openVoxSettings'
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOX_OPEN_SETTINGS_ACTION_ID,
			title: ({ ...nls.localize2('voxSettingsAction2', "Vox: Open Settings"), value: t("Vox: Open Settings") }),
			f1: true,
			icon: Codicon.settingsGear,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// close all instances if found
		const openEditors = editorService.findEditors(VoxSettingsInput.RESOURCE);
		if (openEditors.length > 0) {
			await editorService.closeEditors(openEditors);
		}

		// then, open one single editor
		const input = instantiationService.createInstance(VoxSettingsInput);
		await editorService.openEditor(input);
	}
})





// add to settings gear on bottom left
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '0_command',
	command: {
		id: VOX_TOGGLE_SETTINGS_ACTION_ID,
		title: t("Vox's Settings")
	},
	order: 1
});
