/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from './voxI18n.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { localize2 } from '../../../../nls.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

// Informazioni locali per il comando "Vox: Log Debug Info" (versione, sistema operativo). Vox non invia statistiche
// d'uso: queste informazioni restano sul PC e si vedono solo quando l'utente lancia il comando.
export interface IVoxDebugInfoService {
	readonly _serviceBrand: undefined;
	getDebuggingProperties(): Promise<object>;
}

export const IVoxDebugInfoService = createDecorator<IVoxDebugInfoService>('voxDebugInfoService');


// chiama il servizio del processo principale (voxDebugInfoMainService.ts) attraverso il canale
export class VoxDebugInfoService implements IVoxDebugInfoService {

	readonly _serviceBrand: undefined;
	private readonly mainService: IVoxDebugInfoService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService // (only usable on client side)
	) {
		this.mainService = ProxyChannel.toService<IVoxDebugInfoService>(mainProcessService.getChannel('vox-channel-debug-info'));
	}

	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	async getDebuggingProperties(): Promise<object> {
		return this.mainService.getDebuggingProperties()
	}
}

registerSingleton(IVoxDebugInfoService, VoxDebugInfoService, InstantiationType.Delayed);


// debugging action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'voxDebugInfo',
			f1: true,
			title: ({ ...localize2('voxMetricsDebug', "Vox: Log Debug Info"), value: t("Vox: Log Debug Info") }),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const debugInfoService = accessor.get(IVoxDebugInfoService)
		const notifService = accessor.get(INotificationService)

		const debugProperties = await debugInfoService.getDebuggingProperties()
		console.log('Vox debug info:', debugProperties)
		notifService.info(t("Vox Debug info:\n{0}", JSON.stringify(debugProperties, null, 2)))
	}
})
