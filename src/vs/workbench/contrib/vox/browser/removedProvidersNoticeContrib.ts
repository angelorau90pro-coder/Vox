/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IRefreshModelService } from '../common/refreshModelService.js';
import { textOfRemovedProvidersNotice } from '../common/removedProvidersNotice.js';
import { t } from '../common/voxI18n.js';
import { IVoxSettingsService } from '../common/voxSettingsService.js';
import { displayInfoOfFeatureName, displayInfoOfProviderName, FeatureName, featureNames, ProviderName, providerNames } from '../common/voxSettingsTypes.js';
import { VOX_OPEN_SETTINGS_ACTION_ID } from './voxSettingsPane.js';

// Dopo l'aggiornamento a una versione che usa solo le IA locali e le IA in CLI, dice una volta all'utente che cosa è
// cambiato nelle sue impostazioni: chiavi API cancellate e modelli sostituiti. L'avviso resta finché non lo chiude.
export class RemovedProvidersNoticeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voxRemovedProvidersNotice';

	constructor(
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		@IRefreshModelService private readonly refreshModelService: IRefreshModelService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.voxSettingsService.waitForInitState.then(() => this._firstLocalDetection()).then(() => {
			if (this._store.isDisposed) return
			this._showNotice()
			// un file di impostazioni di una versione precedente importato a finestra aperta: l'avviso si mostra subito
			this._register(this.voxSettingsService.onDidStoreRemovedProvidersNotice(() => this._showNotice()))
		})
	}

	private _showNotice() {
		const notice = this.voxSettingsService.takeRemovedProvidersNotice()
		if (!notice) return
		const message = textOfRemovedProvidersNotice(notice, {
			featureTitle: featureName => (featureNames as readonly string[]).includes(featureName) ? displayInfoOfFeatureName(featureName as FeatureName) : featureName,
			providerTitle: providerName => (providerNames as string[]).includes(providerName) ? displayInfoOfProviderName(providerName as ProviderName).title : providerName,
		})
		this.notificationService.notify({
			severity: Severity.Info,
			message,
			sticky: true,
			actions: {
				primary: [{
					id: 'vox.removedProvidersNotice.openSettings',
					enabled: true,
					label: t("Open Vox's Settings"),
					tooltip: '',
					class: undefined,
					run: () => { this.commandService.executeCommand(VOX_OPEN_SETTINGS_ACTION_ID) },
				}],
			},
		})
	}

	// I modelli locali si rilevano a finestra aperta: l'avviso aspetta il primo rilevamento (al massimo dieci secondi),
	// così una funzione che riceve il suo modello solo allora non viene data per rimasta senza.
	private _firstLocalDetection(): Promise<void> {
		const done = () => { const { state } = this.refreshModelService.state.voxLocal; return state === 'finished' || state === 'error' }
		if (done()) return Promise.resolve()
		return new Promise<void>(resolve => {
			const finish = () => { clearTimeout(timer); listener.dispose(); resolve() }
			const listener = this._register(this.refreshModelService.onDidChangeState(() => { if (done()) finish() }))
			const timer = setTimeout(finish, FIRST_DETECTION_TIMEOUT)
			this._register({ dispose: finish })
		})
	}
}

const FIRST_DETECTION_TIMEOUT = 10_000

registerWorkbenchContribution2(RemovedProvidersNoticeContribution.ID, RemovedProvidersNoticeContribution, WorkbenchPhase.Eventually);
