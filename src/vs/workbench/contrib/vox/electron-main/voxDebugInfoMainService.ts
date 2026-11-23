/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

import { IVoxDebugInfoService } from '../common/voxDebugInfoService.js';


const os = isWindows ? 'windows' : isMacintosh ? 'mac' : isLinux ? 'linux' : null
const _getOSInfo = () => {
	try {
		const { platform, arch } = process // see platform.ts
		return { platform, arch }
	}
	catch (e) {
		return { platform: '??', arch: '??' }
	}
}
const osInfo = _getOSInfo()


// Vox non invia statistiche d'uso: nessun servizio esterno, nessun identificativo della macchina o dell'utente.
// Restano solo le informazioni locali mostrate dal comando "Vox: Log Debug Info".
export class VoxDebugInfoMainService extends Disposable implements IVoxDebugInfoService {
	_serviceBrand: undefined;

	private readonly _debugProperties: object

	constructor(
		@IProductService productService: IProductService,
		@IEnvironmentMainService envMainService: IEnvironmentMainService,
	) {
		super()
		const { commit, version, voxVersion, voxRelease, quality } = productService
		this._debugProperties = {
			commit,
			vscodeVersion: version,
			voxVersion,
			voxRelease,
			os,
			quality,
			isDevMode: !envMainService.isBuilt, // found in abstractUpdateService.ts
			...osInfo,
		}
	}

	async getDebuggingProperties() {
		return this._debugProperties
	}
}
