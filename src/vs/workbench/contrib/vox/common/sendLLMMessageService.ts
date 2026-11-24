/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from './voxI18n.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, VoxLocalModelResponse, } from './sendLLMMessageTypes.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoxSettingsService } from './voxSettingsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IMCPService } from './mcpService.js';
import { providerNames } from './voxSettingsTypes.js';

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	abort: (requestId: string) => void;
	cliAgentList: () => Promise<string[]>;
	cliAgentModels: (agent: string) => Promise<string[]>;
	voxLocalList: (params: ServiceModelListParams<VoxLocalModelResponse>) => void;
}


// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks = {
		onText: {} as { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) },
		onFinalMessage: {} as { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) },
		onError: {} as { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) },
		onAbort: {} as { [eventId: string]: (() => void) }, // NOT sent over the channel, result is instant when we call .abort()
	}

	// list hooks
	private readonly listHooks = {
		voxLocal: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<VoxLocalModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<VoxLocalModelResponse>) => void) },
		}
	}

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		// @INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super()

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('vox-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('vox-channel-llmMessage')

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId)
		}))
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
			console.error('Error in LLMMessageService:', JSON.stringify(e))
		}))
		// .list()
		this._register((this.channel.listen('onSuccess_list_voxLocal') satisfies Event<EventModelListOnSuccessParams<VoxLocalModelResponse>>)(e => {
			this.listHooks.voxLocal.success[e.requestId]?.(e)
			this._clearChannelHooks(e.requestId) // VOX: un elenco ha una sola risposta
		}))
		this._register((this.channel.listen('onError_list_voxLocal') satisfies Event<EventModelListOnErrorParams<VoxLocalModelResponse>>)(e => {
			this.listHooks.voxLocal.error[e.requestId]?.(e)
			this._clearChannelHooks(e.requestId)
		}))

	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, ...proxyParams } = params;

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = t("Please choose a model in Vox's Settings.")
			onError({ message, fullError: null })
			return null
		}

		// solo IA locali e IA in CLI: il processo principale rifiuta comunque gli altri fornitori, ma così la richiesta non parte nemmeno
		if (!(providerNames as readonly string[]).includes(modelSelection.providerName)) {
			onError({ message: t("Please choose a model in Vox's Settings."), fullError: null })
			return null
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = t("No messages detected.")
			onError({ message, fullError: null })
			return null
		}

		const { settingsOfProvider, } = this.voxSettingsService.state

		const mcpTools = this.mcpService.getMCPTools()

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText
		this.llmMessageHooks.onFinalMessage[requestId] = onFinalMessage
		this.llmMessageHooks.onError[requestId] = onError
		this.llmMessageHooks.onAbort[requestId] = onAbort // used internally only

		// params will be stripped of all its functions over the IPC channel
		this.channel.call('sendLLMMessage', {
			...proxyParams,
			requestId,
			settingsOfProvider,
			modelSelection,
			mcpTools,
			workspaceFolder: params.workspaceFolder ?? this.workspaceContextService.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri.fsPath,
		} satisfies MainSendLLMMessageParams);

		return requestId
	}

	cliAgentList = (): Promise<string[]> => this.channel.call('cliAgentList', this.voxSettingsService.state.settingsOfProvider.cliAgent);

	// Modelli che la CLI dichiara disponibili per l'account (per ora solo codex); elenco vuoto se non si sanno.
	cliAgentModels = (agent: string): Promise<string[]> => this.channel.call<string[]>('cliAgentModels', { agent })
		.then(models => Array.isArray(models) ? models.filter(model => typeof model === 'string') : [], () => []);

	abort(requestId: string) {
		this.llmMessageHooks.onAbort[requestId]?.() // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		this._clearChannelHooks(requestId)
	}


	// i modelli delle IA locali di Vox: li legge il processo principale dal manifesto `modelli.json`
	voxLocalList = (params: ServiceModelListParams<VoxLocalModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.voxSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.voxLocal.success[requestId_] = onSuccess
		this.listHooks.voxLocal.error[requestId_] = onError

		this.channel.call('voxLocalList', {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<VoxLocalModelResponse>)
	}

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId]
		delete this.llmMessageHooks.onFinalMessage[requestId]
		delete this.llmMessageHooks.onError[requestId]

		delete this.listHooks.voxLocal.success[requestId]
		delete this.listHooks.voxLocal.error[requestId]
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);

