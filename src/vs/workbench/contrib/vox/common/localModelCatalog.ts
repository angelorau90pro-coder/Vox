/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { LocalModelCatalogEntry } from './localModelLibraryTypes.js';

// Elenco consigliato dei modelli che Vox sa scaricare da solo. Ogni voce è un file pubblico su Hugging Face, fissato
// a una revisione precisa: dimensione e impronta SHA-256 sono quelle lette da Hugging Face il 17/11/2026 e coincidono
// con i file provati con Vox. Per aggiungere una voce: revisione, dimensione e impronta si leggono da
// `https://huggingface.co/api/models/<repo>?blobs=true` (campi `sha`, `siblings[].size`, `siblings[].lfs.sha256`).
export const localModelCatalog: readonly LocalModelCatalogEntry[] = [
	{
		id: 'qwen3.5-9b',
		nome: 'qwen3.5-9b',
		descrizione: 'Chat e agente, veloce, contesto lungo (5,3 GB)',
		uso: 'chat',
		contesto: 65536,
		repo: 'unsloth/Qwen3.5-9B-GGUF',
		revisione: '3885219b6810b007914f3a7950a8d1b469d598a5',
		file: 'Qwen3.5-9B-Q4_K_M.gguf',
		bytes: 5680522464,
		sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
		opzioni: ['--chat-template-file', '{cartella}/avvia/qwen3.6-codex.jinja'],
	},
	{
		id: 'gpt-oss-20b',
		nome: 'gpt-oss-20b',
		descrizione: 'Chat e agente (11,1 GB)',
		uso: 'chat',
		contesto: 32768,
		repo: 'unsloth/gpt-oss-20b-GGUF',
		revisione: 'd449b42d93e1c2c7bda5312f5c25c8fb91dfa9b4',
		file: 'gpt-oss-20b-UD-Q4_K_XL.gguf',
		bytes: 11872347328,
		sha256: '10fe673de12c20b74b8d670a9fdf0fd36b43b0a86ffc04daeb175c0a2b98c4f9',
		opzioni: [],
	},
	{
		id: 'qwen3.8-27b',
		nome: 'qwen3.8-27b',
		descrizione: 'Chat e agente, il più forte (12,2 GB)',
		uso: 'chat',
		contesto: 32768,
		repo: 'unsloth/Qwen3.8-27B-GGUF',
		revisione: '4af51b3542f775b0a8e4b310bfb3f17e01c306c9',
		file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
		bytes: 13146393504,
		sha256: '7b20f0679da6f5c6ec7971e241630f44fe1e123e5c99bfea90c433268b355723',
		opzioni: ['-ctk', 'q8_0', '-ctv', 'q8_0'],
	},
	{
		id: 'qwen3.8-27b-uncensored',
		nome: 'qwen3.8-27b-uncensored',
		descrizione: 'Come qwen3.8-27b, senza rifiuti (12,4 GB)',
		uso: 'chat',
		contesto: 32768,
		repo: 'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF',
		revisione: 'c4b90228246aef7ecc6cb2be9d80575a911a0f3a',
		file: 'Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf',
		bytes: 13326125984,
		sha256: 'c6e144d78595c4656946187c2cee42f9062b3b4fa9874bc1be3e9263396253da',
		opzioni: ['-ctk', 'q8_0', '-ctv', 'q8_0'],
	},
	{
		id: 'qwen2.5-coder-7b',
		nome: 'qwen2.5-coder-7b',
		descrizione: 'Completamento del codice (4,4 GB)',
		uso: 'completamento',
		contesto: 8192,
		repo: 'QuantFactory/Qwen2.5-Coder-7B-GGUF',
		revisione: '16ba6b11abac189c8f28fa0ddfa5619c4243a0db',
		file: 'Qwen2.5-Coder-7B.Q4_K_M.gguf',
		bytes: 4683073824,
		sha256: '06464f568e707c24e1decee3827a0fae01071734f054892a1f3ec071099f1794',
		opzioni: [],
	},
	{
		id: 'nomic-embed',
		nome: 'nomic-embed',
		descrizione: 'Embedding per la ricerca nei file (139 MB)',
		uso: 'embedding',
		contesto: 2048,
		repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
		revisione: '0188c9bf409793f810680a5a431e7b899c46104c',
		file: 'nomic-embed-text-v1.5.Q8_0.gguf',
		bytes: 146146432,
		sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7',
		opzioni: ['--embedding'],
	},
]

// Indirizzo del file di una voce dell'elenco, fissato alla sua revisione.
export const urlOfLocalModelCatalogEntry = (entry: LocalModelCatalogEntry): string =>
	`https://huggingface.co/${entry.repo}/resolve/${entry.revisione}/${encodeURIComponent(entry.file)}`
