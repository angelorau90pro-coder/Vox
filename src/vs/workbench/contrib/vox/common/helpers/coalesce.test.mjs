// Avviso con frequenza limitata e scrittura ritardata: quante volte si lavora e che non si perde l'ultimo valore.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const source = stripTypeScriptTypes(await read('./coalesce.ts')).replace(/export /g, '');
const { createThrottledNotifier, createDelayedWriter } = new Function(source + '; return { createThrottledNotifier, createDelayedWriter };')();

// timer finti: `run()` fa scattare quelli in attesa
const fakeTimers = () => {
	let next = 1;
	const waiting = new Map();
	return {
		set: (fn, ms) => { const id = next++; waiting.set(id, { fn, ms }); return id; },
		clear: id => { waiting.delete(id); },
		run: () => { const all = [...waiting.values()]; waiting.clear(); all.forEach(w => w.fn()); },
		size: () => waiting.size,
		delays: () => [...waiting.values()].map(w => w.ms),
	};
};

test('avviso limitato: mille richieste in un intervallo danno un solo avviso, e l\'ultimo arriva sempre', () => {
	const timers = fakeTimers();
	const seen = [];
	const notifier = createThrottledNotifier(key => seen.push(key), 50, timers);
	for (let i = 0; i < 1000; i++) notifier.later('a');
	assert.deepEqual(seen, []);
	assert.equal(timers.size(), 1);
	assert.deepEqual(timers.delays(), [50]);
	timers.run();
	assert.deepEqual(seen, ['a']);
	// dopo lo scatto si ricomincia: un altro avviso per l'intervallo successivo
	notifier.later('a');
	timers.run();
	assert.deepEqual(seen, ['a', 'a']);
});

test('avviso limitato: le chiavi sono indipendenti', () => {
	const timers = fakeTimers();
	const seen = [];
	const notifier = createThrottledNotifier(key => seen.push(key), 50, timers);
	notifier.later('a'); notifier.later('b'); notifier.later('a');
	assert.equal(timers.size(), 2);
	timers.run();
	assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('avviso immediato: parte subito e annulla quello in attesa, così uno stato vecchio non arriva dopo', () => {
	const timers = fakeTimers();
	const seen = [];
	const notifier = createThrottledNotifier(key => seen.push(key), 50, timers);
	notifier.later('a');
	notifier.later('b');
	notifier.now('a');
	assert.deepEqual(seen, ['a']);
	assert.equal(timers.size(), 1); // resta solo quello di 'b'
	timers.run();
	assert.deepEqual(seen, ['a', 'b']);
});

test('avviso limitato: dispose annulla tutto ciò che è in attesa', () => {
	const timers = fakeTimers();
	const seen = [];
	const notifier = createThrottledNotifier(key => seen.push(key), 50, timers);
	notifier.later('a'); notifier.later('b');
	notifier.dispose();
	assert.equal(timers.size(), 0);
	timers.run();
	assert.deepEqual(seen, []);
});

test('scrittura ritardata: molte richieste, una sola scrittura con l\'ultimo valore', () => {
	const timers = fakeTimers();
	const written = [];
	const writer = createDelayedWriter(value => written.push(value), 1000, timers);
	assert.equal(writer.hasPending(), false);
	writer.schedule(1); writer.schedule(2); writer.schedule(3);
	assert.equal(writer.hasPending(), true);
	assert.equal(timers.size(), 1);
	assert.deepEqual(timers.delays(), [1000]);
	assert.deepEqual(written, []);
	timers.run();
	assert.deepEqual(written, [3]);
	assert.equal(writer.hasPending(), false);
	// niente in attesa: né lo scatto né flush scrivono di nuovo
	timers.run(); writer.flush();
	assert.deepEqual(written, [3]);
});

test('scrittura ritardata: flush scrive subito l\'ultimo valore e annulla il timer', () => {
	const timers = fakeTimers();
	const written = [];
	const writer = createDelayedWriter(value => written.push(value), 1000, timers);
	writer.schedule('a'); writer.schedule('b');
	writer.flush();
	assert.deepEqual(written, ['b']);
	assert.equal(timers.size(), 0);
	// dopo flush si riparte da capo
	writer.schedule('c');
	assert.equal(timers.size(), 1);
	timers.run();
	assert.deepEqual(written, ['b', 'c']);
});

test('scrittura ritardata: anche undefined e null sono valori da scrivere', () => {
	const timers = fakeTimers();
	const written = [];
	const writer = createDelayedWriter(value => written.push(value), 1000, timers);
	writer.schedule(undefined);
	assert.equal(writer.hasPending(), true);
	writer.flush();
	writer.schedule(null);
	timers.run();
	assert.deepEqual(written, [undefined, null]);
});
