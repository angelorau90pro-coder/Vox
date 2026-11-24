/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// registered in app.ts
// can't make a service responsible for this, because it needs
// to be connected to the main process and node dependencies

import { t } from '../common/voxI18n.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, RawMCPToolCall, MCPToolErrorResponse, MCPServerEventResponse, MCPToolCallParams, removeMCPToolNamePrefix } from '../common/mcpServiceTypes.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPUserStateOfName } from '../common/voxSettingsTypes.js';

const getClientConfig = (serverName: string) => {
	return {
		name: `${serverName}-client`,
		version: '0.1.0',
		// debug: true,
	}
}

type MCPServerNonError = MCPServer & { status: Omit<MCPServer['status'], 'error'> }
type MCPServerError = MCPServer & { status: 'error' }



type ClientInfo = {
	_client: Client, // _client is the client that connects with an mcp client. We're calling mcp clients "server" everywhere except here for naming consistency.
	mcpServerEntryJSON: MCPConfigFileEntryJSON,
	mcpServer: MCPServerNonError,
} | {
	// VOX: server spento dall'utente: non si avvia (nessun processo, nessuna connessione) finché non lo riaccende
	_client?: undefined,
	mcpServerEntryJSON: MCPConfigFileEntryJSON,
	mcpServer: MCPServerNonError,
} | {
	_client?: undefined,
	mcpServerEntryJSON: MCPConfigFileEntryJSON,
	mcpServer: MCPServerError,
}

type InfoOfClientId = {
	[clientId: string]: ClientInfo
}

// VOX: l'ambiente del server MCP: quello di Vox, con sopra le variabili scritte in mcp.json (non il contrario,
// altrimenti PATH, chiavi e opzioni scelte dall'utente verrebbero coperte da quelle del processo principale).
// Le variabili senza valore si tolgono: il processo figlio riceve solo testi.
export const mcpServerEnv = (serverEnv: Record<string, string> | undefined, baseEnv: Record<string, string | undefined>): Record<string, string> => {
	const env: Record<string, string> = {}
	for (const [name, value] of Object.entries({ ...baseEnv, ...serverEnv })) {
		if (typeof value === 'string') env[name] = value
	}
	return env
}

// VOX: il testo da mostrare per un errore qualsiasi. Un `Error` serializzato con JSON.stringify diventa «{}»
// (message e stack non sono enumerabili): l'utente e il modello non saprebbero mai perché lo strumento è fallito.
export const mcpErrorText = (err: unknown): string => {
	if (typeof err === 'string') return err
	if (err instanceof Error) return err.message || err.name
	try { return JSON.stringify(err, null, 2) ?? String(err) } catch { return String(err) }
}

// VOX: il risultato di uno strumento MCP come testo. Tutte le parti di testo, nell'ordine (non solo la prima);
// le altre parti (immagini, audio, risorse) si indicano senza il contenuto. Un risultato senza contenuto è valido.
export const mcpToolResultText = (content: readonly { type: string, text?: unknown }[] | undefined): { text: string, unsupportedTypes: string[] } => {
	const texts: string[] = []
	const unsupportedTypes: string[] = []
	for (const part of content ?? []) {
		if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
		else unsupportedTypes.push(String(part?.type))
	}
	return { text: texts.join('\n'), unsupportedTypes }
}

export class MCPChannel implements IServerChannel {

	private readonly infoOfClientId: InfoOfClientId = {}
	private readonly _refreshingServerNames: Set<string> = new Set()

	// mcp emitters
	private readonly mcpEmitters = {
		serverEvent: {
			onAdd: new Emitter<MCPServerEventResponse>(),
			onUpdate: new Emitter<MCPServerEventResponse>(),
			onDelete: new Emitter<MCPServerEventResponse>(),
		}
	} satisfies {
		serverEvent: {
			onAdd: Emitter<MCPServerEventResponse>,
			onUpdate: Emitter<MCPServerEventResponse>,
			onDelete: Emitter<MCPServerEventResponse>,
		}
	}

	constructor(
	) { }

	// browser uses this to listen for changes
	listen(_: unknown, event: string): Event<any> {

		// server events
		if (event === 'onAdd_server') return this.mcpEmitters.serverEvent.onAdd.event;
		else if (event === 'onUpdate_server') return this.mcpEmitters.serverEvent.onUpdate.event;
		else if (event === 'onDelete_server') return this.mcpEmitters.serverEvent.onDelete.event;
		// else if (event === 'onLoading_server') return this.mcpEmitters.serverEvent.onChangeLoading.event;

		// tool call events

		// handle unknown events
		else throw new Error(`Event not found: ${event}`);
	}

	// browser uses this to call (see this.channel.call() in mcpConfigService.ts for all usages)
	async call(_: unknown, command: string, params: any): Promise<any> {
		try {
			if (command === 'refreshMCPServers') {
				await this._refreshMCPServers(params)
			}
			else if (command === 'closeAllMCPServers') {
				await this._closeAllMCPServers()
			}
			else if (command === 'toggleMCPServer') {
				await this._toggleMCPServer(params.serverName, params.isOn)
			}
			else if (command === 'callTool') {
				const p: MCPToolCallParams = params
				const response = await this._safeCallTool(p.serverName, p.toolName, p.params)
				return response
			}
			else {
				throw new Error(`Vox MCP: command "${command}" not recognized.`)
			}
		}
		catch (e) {
			console.error('mcp channel: Call Error:', e)
		}
	}

	// server functions


	private async _refreshMCPServers(params: { mcpConfigFileJSON: MCPConfigFileJSON, userStateOfName: MCPUserStateOfName, addedServerNames: string[], removedServerNames: string[], updatedServerNames: string[] }) {

		const {
			mcpConfigFileJSON,
			userStateOfName,
			addedServerNames,
			removedServerNames,
			updatedServerNames,
		} = params

		const { mcpServers: mcpServersJSON } = mcpConfigFileJSON

		const allChanges: { type: 'added' | 'removed' | 'updated', serverName: string }[] = [
			...addedServerNames.map(n => ({ serverName: n, type: 'added' }) as const),
			...removedServerNames.map(n => ({ serverName: n, type: 'removed' }) as const),
			...updatedServerNames.map(n => ({ serverName: n, type: 'updated' }) as const),
		]

		await Promise.all(
			allChanges.map(async ({ serverName, type }) => {

				// check if already refreshing
				if (this._refreshingServerNames.has(serverName)) return
				this._refreshingServerNames.add(serverName)

				const prevServer = this.infoOfClientId[serverName]?.mcpServer;

				// close and delete the old client
				// VOX: anche per un server «aggiunto» che il canale ha già: una finestra ricaricata (o una seconda finestra)
				// riparte da zero e lo chiede di nuovo; senza chiuderlo, il processo del server restava acceso per sempre
				if (type === 'removed' || type === 'updated' || this.infoOfClientId[serverName]) {
					await this._closeClient(serverName)
					delete this.infoOfClientId[serverName]
					this.mcpEmitters.serverEvent.onDelete.fire({ response: { prevServer, name: serverName, } })
				}

				// create a new client
				if (type === 'added' || type === 'updated') {
					const clientInfo = await this._createClient(mcpServersJSON[serverName], serverName, userStateOfName[serverName]?.isOn)
					this.infoOfClientId[serverName] = clientInfo
					this.mcpEmitters.serverEvent.onAdd.fire({ response: { newServer: clientInfo.mcpServer, name: serverName, } })
				}
			})
		)

		allChanges.forEach(({ serverName, type }) => {
			this._refreshingServerNames.delete(serverName)
		})

	}

	private async _createClientUnsafe(server: MCPConfigFileEntryJSON, serverName: string, isOn: boolean): Promise<ClientInfo> {

		const clientConfig = getClientConfig(serverName)
		let client = new Client(clientConfig)
		let transport: Transport;
		let info: MCPServerNonError;

		if (!isOn) {
			// VOX: spento dall'utente: non si avvia. Gli strumenti si leggono quando lo riaccende (`_toggleMCPServer`).
			const command = server.url ? server.url.toString() : server.command ? `${server.command} ${server.args?.join(' ') || ''}` : ''
			if (!server.url && !server.command) throw new Error(t("No url or command for server {0}", serverName));
			return { mcpServerEntryJSON: server, mcpServer: { status: 'offline', tools: [], command } }
		}

		if (server.url) {
			// VOX: in mcp.json l'indirizzo è un testo; i trasporti vogliono un URL (quello SSE legge `url.href`).
			// Le intestazioni scritte in mcp.json (per esempio Authorization) vanno su ogni richiesta.
			const url = new URL(server.url.toString())
			const headers = server.headers ?? {}
			// first try HTTP, fall back to SSE
			try {
				transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
				await client.connect(transport);
				console.log(`Connected via HTTP to ${serverName}`);
				const { tools } = await client.listTools()
				const toolsWithUniqueName = tools.map(({ name, ...rest }) => ({ name: this._addUniquePrefix(name), ...rest }))
				info = {
					status: isOn ? 'success' : 'offline',
					tools: toolsWithUniqueName,
					command: server.url.toString(),
				}
			} catch (httpErr) {
				console.warn(`HTTP failed for ${serverName}, trying SSE…`, httpErr);
				// VOX: un client nuovo, perché quello del primo tentativo resta legato al trasporto fallito
				await client.close().catch(() => { })
				client = new Client(clientConfig)
				// (le intestazioni vanno sui messaggi inviati; il flusso SSE in arrivo usa quelle predefinite dell'SDK)
				transport = new SSEClientTransport(url, { requestInit: { headers } });
				await client.connect(transport);
				const { tools } = await client.listTools()
				const toolsWithUniqueName = tools.map(({ name, ...rest }) => ({ name: this._addUniquePrefix(name), ...rest }))
				console.log(`Connected via SSE to ${serverName}`);
				info = {
					status: isOn ? 'success' : 'offline',
					tools: toolsWithUniqueName,
					command: server.url.toString(),
				}
			}
		} else if (server.command) {
			// console.log('ENV DATA: ', server.env)
			transport = new StdioClientTransport({
				command: server.command,
				args: server.args,
				env: mcpServerEnv(server.env, process.env),
			});

			await client.connect(transport)

			// Get the tools from the server
			const { tools } = await client.listTools()
			const toolsWithUniqueName = tools.map(({ name, ...rest }) => ({ name: this._addUniquePrefix(name), ...rest }))

			// Create a full command string for display
			const fullCommand = `${server.command} ${server.args?.join(' ') || ''}`

			// Format server object
			info = {
				status: isOn ? 'success' : 'offline',
				tools: toolsWithUniqueName,
				command: fullCommand,
			}

		} else {
			throw new Error(t("No url or command for server {0}", serverName));
		}


		return { _client: client, mcpServerEntryJSON: server, mcpServer: info }
	}

	private _addUniquePrefix(base: string) {
		return `${Math.random().toString(36).slice(2, 8)}_${base}`;
	}

	private async _createClient(serverConfig: MCPConfigFileEntryJSON, serverName: string, isOn = true): Promise<ClientInfo> {
		try {
			const c: ClientInfo = await this._createClientUnsafe(serverConfig, serverName, isOn)
			return c
		} catch (err) {
			console.error(`❌ Failed to connect to server "${serverName}":`, err)
			const fullCommand = !serverConfig.command ? '' : `${serverConfig.command} ${serverConfig.args?.join(' ') || ''}`
			const c: MCPServerError = { status: 'error', error: mcpErrorText(err), command: fullCommand, }
			return { mcpServerEntryJSON: serverConfig, mcpServer: c, }
		}
	}

	// VOX: alla chiusura di Vox (app.ts) si chiudono i server avviati, invece di lasciarli al sistema operativo
	closeAll(): Promise<void> {
		return this._closeAllMCPServers().catch(e => console.error('Vox MCP: closing the servers failed', e))
	}

	private async _closeAllMCPServers() {
		for (const serverName in this.infoOfClientId) {
			await this._closeClient(serverName)
			delete this.infoOfClientId[serverName]
		}
		console.log('Closed all MCP servers');
	}

	private async _closeClient(serverName: string) {
		const info = this.infoOfClientId[serverName]
		if (!info) return
		const { _client: client } = info
		if (client) {
			// VOX: un server già caduto può fallire anche la chiusura: non deve fermare l'aggiornamento degli altri
			try { await client.close() } catch (e) { console.error(`Vox MCP: closing ${serverName} failed`, e) }
		}
		console.log(`Closed MCP server ${serverName}`);
	}


	private async _toggleMCPServer(serverName: string, isOn: boolean) {
		const info = this.infoOfClientId[serverName]
		// VOX: un server che non c'è (mcp.json cambiato nel frattempo) non si accende né si spegne
		if (!info) return
		const prevServer = info.mcpServer
		// Handle turning on the server
		if (isOn) {
			// this.mcpEmitters.serverEvent.onChangeLoading.fire(getLoadingServerObject(serverName, isOn))
			// VOX: il client nuovo si salva (altrimenti ogni chiamata dopo la riaccensione trovava «client non trovato»)
			// e quello vecchio si chiude; se l'avvio fallisce, il server mostra l'errore invece di restare in caricamento
			await this._closeClient(serverName)
			const clientInfo = await this._createClient(info.mcpServerEntryJSON, serverName, isOn)
			this.infoOfClientId[serverName] = clientInfo
			this.mcpEmitters.serverEvent.onUpdate.fire({
				response: {
					name: serverName,
					newServer: clientInfo.mcpServer,
					prevServer: prevServer,
				}
			})
		}
		// Handle turning off the server
		else {
			// this.mcpEmitters.serverEvent.onChangeLoading.fire(getLoadingServerObject(serverName, isOn))
			await this._closeClient(serverName)
			this.infoOfClientId[serverName] = { mcpServerEntryJSON: info.mcpServerEntryJSON, mcpServer: { status: 'offline', tools: [], command: '' } }

			this.mcpEmitters.serverEvent.onUpdate.fire({
				response: {
					name: serverName,
					newServer: {
						status: 'offline',
						tools: [],
						command: '',
						// Explicitly set error to undefined to reset the error state
						error: undefined,
					},
					prevServer: prevServer,
				}
			})
		}
	}

	// tool call functions

	private async _callTool(serverName: string, toolName: string, params: any): Promise<RawMCPToolCall> {
		const server = this.infoOfClientId[serverName]
		if (!server) throw new Error(t("Server {0} not found", serverName))
		const { _client: client } = server
		if (!client) throw new Error(t("Client for server {0} not found", serverName))

		// Call the tool with the provided parameters
		const response = await client.callTool({
			name: removeMCPToolNamePrefix(toolName),
			arguments: params
		})
		const { content } = response as CallToolResult
		// VOX: tutte le parti di testo (non solo la prima); un risultato vuoto è un risultato, non un errore interno
		const { text, unsupportedTypes } = mcpToolResultText(content)

		if (response.isError) {
			throw new Error(t("Tool call error: {0}", text || unsupportedTypes.join(', ')))
		}

		if (text || unsupportedTypes.length === 0) {
			// handle success
			return {
				event: 'text',
				text,
				toolName,
				serverName,
			}
		}
		const returnValue = { type: unsupportedTypes[0] }

		// if (returnValue.type === 'audio') {
		// 	// handle audio response
		// }

		// if (returnValue.type === 'image') {
		// 	// handle image response
		// }

		// if (returnValue.type === 'resource') {
		// 	// handle resource response
		// }

		throw new Error(t("Tool call error: We don't support {0} tool response yet for tool {1} on server {2}", returnValue.type, toolName, serverName))
	}

	// tool call error wrapper
	private async _safeCallTool(serverName: string, toolName: string, params: any): Promise<RawMCPToolCall> {
		try {
			const response = await this._callTool(serverName, toolName, params)
			return response
		} catch (err) {

			let errorMessage: string;

			if (typeof err === 'object' && err !== null && err['code']) {
				const code = err.code
				let codeDescription = ''
				if (code === -32700)
					codeDescription = t("Parse Error");
				if (code === -32600)
					codeDescription = t("Invalid Request");
				if (code === -32601)
					codeDescription = t("Method Not Found");
				if (code === -32602)
					codeDescription = t("Invalid Parameters");
				if (code === -32603)
					codeDescription = t("Internal Error");
				// VOX: il messaggio dell'errore (per esempio il tempo scaduto) non è enumerabile: si aggiunge a parte
				errorMessage = t("{0}. Full response:\n{1}", codeDescription || mcpErrorText(err), JSON.stringify({ message: err instanceof Error ? err.message : undefined, ...err }, null, 2))
			}
			// Check if it's an MCP error with a code
			else if (typeof err === 'string') {
				// String error
				errorMessage = err;
			} else {
				// Unknown error format (VOX: per un Error il messaggio, non «{}»)
				errorMessage = mcpErrorText(err);
			}

			const fullErrorMessage = t("❌ Failed to call tool \"{0}\" on server \"{1}\": {2}", toolName, serverName, errorMessage);
			const errorResponse: MCPToolErrorResponse = {
				event: 'error',
				text: fullErrorMessage,
				toolName,
				serverName,
			}
			return errorResponse
		}
	}
}


