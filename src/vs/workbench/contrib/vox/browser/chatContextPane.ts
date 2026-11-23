/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// VOX: la scheda «Contesto della chat» nell'area centrale degli editor, con i dettagli di quanta parte della finestra
// di contesto del modello occupa la prossima richiesta. La apre la riga «Contesto» sopra la casella della chat (o il
// comando nella tavolozza). Come le Impostazioni di Vox non ha un serializzatore: dopo un riavvio non si riapre da
// sola, si riapre dalla chat.

import { t } from '../common/voxI18n.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions, EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { VOX_OPEN_CHAT_CONTEXT_ACTION_ID } from './actionIDs.js';

// la pagina sta nel bundle della chat: così condivide con la riga della chat la bozza e le misure
import { mountChatContext } from './react/out/sidebar-tsx/index.js'


class VoxChatContextInput extends EditorInput {

	static readonly ID: string = 'workbench.input.vox.chatContext';

	static readonly RESOURCE = URI.from({ scheme: 'vox', path: 'chat-context' })
	readonly resource = VoxChatContextInput.RESOURCE;

	override get typeId(): string {
		return VoxChatContextInput.ID;
	}

	override getName(): string {
		return t("Chat context");
	}

	override getIcon() {
		return Codicon.dashboard
	}

	// una scheda sola anche con «Dividi editor» o trascinandola in un altro gruppo: la pagina si monta una volta
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton
	}

	// la scheda è una sola: due clic ravvicinati sulla riga della chat, prima che la prima apertura finisca, non
	// devono aprirne due (di base due istanze diverse non coincidono)
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof VoxChatContextInput || super.matches(other)
	}
}


class VoxChatContextPane extends EditorPane {
	static readonly ID = 'workbench.editor.vox.chatContext';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(VoxChatContextPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		// il documento della finestra che ospita la scheda (anche una finestra separata), non quello della principale
		const element = parent.ownerDocument.createElement('div');
		element.style.height = '100%';
		element.style.width = '100%';
		parent.appendChild(element);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountChatContext(element, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()))
		});
	}

	// la pagina si adatta da sola alla larghezza (niente larghezza minima: va anche in un gruppo stretto)
	layout(_dimension: Dimension): void { }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoxChatContextPane, VoxChatContextPane.ID, t("Chat context")),
	[new SyncDescriptor(VoxChatContextInput)]
);


// apre la scheda, o la porta in primo piano nel gruppo dove è già aperta; non la chiude mai
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VOX_OPEN_CHAT_CONTEXT_ACTION_ID,
			title: ({ ...nls.localize2('voxChatContext', "Vox: Show Chat Context"), value: t("Vox: Show Chat Context") }),
			f1: true,
			icon: Codicon.dashboard,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		const [open] = editorService.findEditors(VoxChatContextInput.RESOURCE);
		if (open) {
			await editorService.openEditor(open.editor, { pinned: true }, open.groupId);
			return;
		}
		await editorService.openEditor(instantiationService.createInstance(VoxChatContextInput), { pinned: true });
	}
})
