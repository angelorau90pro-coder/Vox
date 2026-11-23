/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// VOX: la chat non carica immagini da un indirizzo. Il testo delle risposte lo scrive il modello: un'immagine
// Markdown con un indirizzo `https` farebbe partire una richiesta verso un server scelto da lui, senza che
// l'utente faccia niente, e nell'indirizzo potrebbe esserci qualunque cosa il modello abbia letto.
// Si disegna solo un'immagine che sta tutta dentro il messaggio (`data:`), nei formati che non possono
// contenere altri indirizzi; un indirizzo `http(s)` diventa un collegamento, che parte solo con un clic;
// tutto il resto (altri schemi, `data:` non ammessi, indirizzi vuoti) resta testo.
// Anche i collegamenti Markdown passano da qui (`externalLinkHref`): un clic su un testo scritto dal modello
// viene consegnato al sistema operativo, quindi si aprono solo pagine web e indirizzi di posta, mai altri
// schemi (`file:`, `vscode:`, `javascript:`, gestori di protocollo installati sul PC).
// (Questo file non importa niente: il suo test lo carica da solo.)

const INLINE_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;

export const isInlineImageSrc = (href: unknown): href is string =>
	typeof href === 'string' && INLINE_IMAGE_SRC.test(href);

// L'indirizzo che un clic può aprire, oppure `null`: solo `http(s)` ben formato (e `mailto:` per i collegamenti
// normali), senza spazi né caratteri di controllo, non smisurato e senza nome utente davanti al dominio
// (`https://sito-fidato@altro.example` porta ad altro.example), così l'inizio dell'indirizzo, che è ciò che si
// vede nel suggerimento, dice davvero dove si va
const LINK_MAX_CHARS = 2000;
export const externalLinkHref = (href: unknown, allowMailto: boolean): string | null => {
	if (typeof href !== 'string' || href.length > LINK_MAX_CHARS || /[\s\u0000-\u001f\u007f]/.test(href)) return null;
	if (allowMailto && /^mailto:[^?#]+@[^?#]+$/i.test(href)) return href;
	if (!/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(href)) return null;
	try {
		const url = new URL(href);
		return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '' ? href : null;
	} catch {
		return null;
	}
};

// Quanto testo scritto dal modello può finire nell'etichetta o nel suggerimento di un'immagine non disegnata
const FALLBACK_MAX_CHARS = 200;
const shortened = (s: string) => s.length > FALLBACK_MAX_CHARS ? s.slice(0, FALLBACK_MAX_CHARS) + '…' : s;

export type ImageFallback =
	| { kind: 'link', href: string, label: string, title: string }
	| { kind: 'text', label: string };

// Cosa mostrare al posto di un'immagine che non si disegna: `raw` è il Markdown com'era scritto
export const imageFallback = (href: unknown, text: unknown, raw: unknown): ImageFallback => {
	const alt = typeof text === 'string' ? text.trim() : '';
	const address = externalLinkHref(href, false);
	if (address !== null) return { kind: 'link', href: address, label: shortened(alt || address), title: shortened(address) };
	return { kind: 'text', label: shortened(alt || (typeof raw === 'string' ? raw.trim() : '') || (typeof href === 'string' ? href : '')) };
};
