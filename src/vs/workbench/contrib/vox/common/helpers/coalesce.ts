/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Due piccoli strumenti per non ripetere lo stesso lavoro a ogni token dello streaming:
// un avviso con frequenza limitata e una scrittura ritardata che tiene solo l'ultimo valore.
// I timer sono iniettabili per poterli provare senza aspettare.

export type CoalesceTimers = {
	set: (fn: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const defaultTimers: CoalesceTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Avvisa per chiave. `now` avvisa subito e annulla l'avviso in attesa per quella chiave;
// `later` garantisce un avviso entro `intervalMs`, uno solo anche se viene chiamato molte volte.
export const createThrottledNotifier = <K>(notify: (key: K) => void, intervalMs: number, timers: CoalesceTimers = defaultTimers) => {
	const pending = new Map<K, unknown>();
	const cancel = (key: K) => {
		if (!pending.has(key)) return;
		timers.clear(pending.get(key));
		pending.delete(key);
	};
	return {
		now(key: K) {
			cancel(key);
			notify(key);
		},
		later(key: K) {
			if (pending.has(key)) return;
			pending.set(key, timers.set(() => {
				pending.delete(key);
				notify(key);
			}, intervalMs));
		},
		dispose() {
			for (const key of [...pending.keys()]) cancel(key);
		},
	};
};

// Scrive l'ultimo valore ricevuto dopo `delayMs` dalla prima richiesta in attesa.
// `flush` scrive subito ciò che è in attesa (chiusura, salvataggio dello stato): non si perde niente.
export const createDelayedWriter = <T>(write: (value: T) => void, delayMs: number, timers: CoalesceTimers = defaultTimers) => {
	let waiting: { value: T } | undefined;
	let handle: unknown;
	const flush = () => {
		if (!waiting) return;
		const { value } = waiting;
		waiting = undefined;
		timers.clear(handle);
		handle = undefined;
		write(value);
	};
	return {
		schedule(value: T) {
			const alreadyWaiting = waiting !== undefined;
			waiting = { value };
			if (!alreadyWaiting) handle = timers.set(flush, delayMs);
		},
		flush,
		hasPending: () => waiting !== undefined,
	};
};
