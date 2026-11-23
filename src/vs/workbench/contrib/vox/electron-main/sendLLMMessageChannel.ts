/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts
// code convention is to make a service responsible for this stuff, and not a channel, but having fewer files is simpler...

import { t } from '../common/voxI18n.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, MainSendLLMMessageParams, AbortRef, SendLLMMessageParams, MainLLMMessageAbortParams, ModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, VoxLocalModelResponse, MainModelListParams, } from '../common/sendLLMMessageTypes.js';
import { listCliAgents } from './llmMessage/cliAgents.js';
import { sendLLMMessage } from './llmMessage/sendLLMMessage.js'
import { sendLLMMessageToProviderImplementation } from './llmMessage/sendLLMMessage.impl.js';

// NODE IMPLEMENTATION - calls actual sendLLMMessage() and returns listeners to it

export class LLMMessageChannel implements IServerChannel {

	// sendLLMMessage
	private readonly llmMessageEmitters = {
		onText: new Emitter<EventLLMMessageOnTextParams>(),
		onFinalMessage: new Emitter<EventLLMMessageOnFinalMessageParams>(),
		onError: new Emitter<EventLLMMessageOnErrorParams>(),
	}

	// aborters for above
	private readonly _infoOfRunningRequest: Record<string, { abortRef: AbortRef }> = {}


	// list
	private readonly listEmitters = {
		voxLocal: {
			success: new Emitter<EventModelListOnSuccessParams<VoxLocalModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<VoxLocalModelResponse>>(),
		},
	}

	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {
		// text
		if (event === 'onText_sendLLMMessage') return this.llmMessageEmitters.onText.event;
		else if (event === 'onFinalMessage_sendLLMMessage') return this.llmMessageEmitters.onFinalMessage.event;
		else if (event === 'onError_sendLLMMessage') return this.llmMessageEmitters.onError.event;
		// list
		else if (event === 'onSuccess_list_voxLocal') return this.listEmitters.voxLocal.success.event;
		else if (event === 'onError_list_voxLocal') return this.listEmitters.voxLocal.error.event;

		else throw new Error(`Event not found: ${event}`);
	}

	// browser uses this to call (see this.channel.call() in llmMessageService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		if (command === 'cliAgentList') return listCliAgents(params);
		try {
			if (command === 'sendLLMMessage') {
				this._callSendLLMMessage(params)
			}
			else if (command === 'abort') {
				await this._callAbort(params)
			}
			else if (command === 'voxLocalList') {
				this._callVoxLocalList(params)
			}
			else {
				throw new Error(`Vox sendLLM: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			console.log('llmMessageChannel: Call Error:', e)
		}
	}

	// the only place sendLLMMessage is actually called
	private _callSendLLMMessage(params: MainSendLLMMessageParams) {
		const { requestId } = params;

		if (!(requestId in this._infoOfRunningRequest))
			this._infoOfRunningRequest[requestId] = { abortRef: { current: null } }

		// VOX: la richiesta resta annullabile finché non arriva la risposta finale o un errore. La promessa di
		// `sendLLMMessage` non basta: per le IA locali si risolve appena parte lo stream.
		const finished = () => { delete this._infoOfRunningRequest[requestId] }
		const mainThreadParams: SendLLMMessageParams = {
			...params,
			onText: (p) => {
				this.llmMessageEmitters.onText.fire({ requestId, ...p });
			},
			onFinalMessage: (p) => {
				finished();
				this.llmMessageEmitters.onFinalMessage.fire({ requestId, ...p });
			},
			onError: (p) => {
				finished();
				console.log('sendLLM: firing err');
				this.llmMessageEmitters.onError.fire({ requestId, ...p });
			},
			abortRef: this._infoOfRunningRequest[requestId].abortRef,
		}
		void sendLLMMessage(mainThreadParams).catch(error => {
			mainThreadParams.onError({ message: error instanceof Error ? error.message : t("AI request failed."), fullError: null });
		})
	}

	private async _callAbort(params: MainLLMMessageAbortParams) {
		const { requestId } = params;
		if (!(requestId in this._infoOfRunningRequest)) return
		const { abortRef } = this._infoOfRunningRequest[requestId]
		// L'aborter viene registrato prima del primo await: non attendere la fine della CLI.
		abortRef?.current?.()
		delete this._infoOfRunningRequest[requestId]
	}





	// L'elenco esiste solo per le IA locali di Vox: il fornitore non si prende dai parametri arrivati dalla finestra.
	_callVoxLocalList = (params: MainModelListParams<VoxLocalModelResponse>) => {
		const { requestId } = params
		const emitters = this.listEmitters.voxLocal
		const mainThreadParams: ModelListParams<VoxLocalModelResponse> = {
			...params,
			providerName: 'voxLocal',
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		}
		sendLLMMessageToProviderImplementation.voxLocal.list(mainThreadParams)
	}





}
