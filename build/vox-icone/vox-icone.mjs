#!/usr/bin/env node
// Icone del marchio Vox: genera le immagini e verifica dimensioni/formati.
// Uso (da radice del repo):
//   node build/vox-icone/vox-icone.mjs            -> genera le immagini usando lo snapshot versionato (build/vox-icone/dimensioni-avanti.json); se manca lo crea dai file attuali
//   node build/vox-icone/vox-icone.mjs --aggiorna-riferimento -> riscrive lo snapshot dai file attuali (solo se si vuole cambiare davvero il riferimento)
//   node build/vox-icone/vox-icone.mjs --verifica -> confronta i file attuali con lo snapshot e riporta dimensioni/formati
// Nessuna dipendenza esterna: solo node:fs, node:zlib, node:path.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');
const SNAP = path.join(DIR, 'dimensioni-avanti.json');
const VERIFICA = process.argv.includes('--verifica');
const AGGIORNA_RIFERIMENTO = process.argv.includes('--aggiorna-riferimento');

// ---------- lettura intestazioni ----------

function readPNG(buf, file) {
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) throw new Error(`${file}: non è un PNG`);
	if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${file}: primo chunk non IHDR`);
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), format: 'png' };
}

function readBMP(buf, file) {
	if (buf.length < 54 || buf.readUInt16LE(0) !== 0x4d42) throw new Error(`${file}: non è un BMP`);
	const hSize = buf.readUInt32LE(14);
	if (hSize < 40) throw new Error(`${file}: header BMP non supportato (${hSize})`);
	const hRaw = buf.readInt32LE(22);
	const w = buf.readInt32LE(18);
	const bpp = buf.readUInt16LE(28);
	const planes = buf.readUInt16LE(26);
	const comp = buf.readUInt32LE(30);
	if (planes !== 1 || (bpp !== 8 && bpp !== 24 && bpp !== 32) || (comp !== 0 && comp !== 3)) {
		throw new Error(`${file}: BMP non supportato (bpp=${bpp}, comp=${comp})`);
	}
	return { w, h: Math.abs(hRaw), bpp, format: 'bmp' };
}

function readICO(buf, file) {
	if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
		throw new Error(`${file}: non è un ICO`);
	}
	const count = buf.readUInt16LE(4);
	const sizes = [];
	for (let i = 0; i < count; i++) {
		const e = 6 + i * 16;
		let w = buf.readUInt8(e), h = buf.readUInt8(e + 1);
		if (w === 0) w = 256;
		if (h === 0) h = 256;
		if (w !== h) throw new Error(`${file}: icona non quadrata ${w}x${h} non supportata`);
		sizes.push(w);
	}
	return { sizes: [...new Set(sizes)].sort((a, b) => a - b), format: 'ico' };
}

// Controlli di integrità: l'intestazione da sola non basta a escludere file troncati.
function checkPNG(buf, file) {
	let off = 8, sawIdat = false, sawIend = false;
	while (off + 12 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const end = off + 12 + len;
		if (end > buf.length) throw new Error(`${file}: chunk PNG troncato`);
		const type = buf.toString('ascii', off + 4, off + 8);
		if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(end - 4)) throw new Error(`${file}: CRC PNG errato (${type})`);
		if (type === 'IDAT') sawIdat = true;
		if (type === 'IEND') { sawIend = true; off = end; break; }
		off = end;
	}
	if (!sawIdat || !sawIend || off !== buf.length) throw new Error(`${file}: PNG incompleto`);
}

function checkBMP(buf, file, info) {
	const dataOff = buf.readUInt32LE(10);
	const rowSize = Math.ceil((info.w * info.bpp) / 32) * 4;
	if (buf.length < dataOff + rowSize * info.h) throw new Error(`${file}: dati BMP troncati`);
}

function checkICO(buf, file) {
	const count = buf.readUInt16LE(4);
	if (count === 0 || buf.length < 6 + count * 16) throw new Error(`${file}: directory ICO troncata`);
	for (let i = 0; i < count; i++) {
		const e = 6 + i * 16;
		const len = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
		if (off < 6 + count * 16 || off + len > buf.length) throw new Error(`${file}: voce ICO ${i} fuori dal file`);
		const png = buf.subarray(off, off + len);
		if (png.length >= 8 && png.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) checkPNG(png, `${file}#${i}`);
	}
}

function inspect(file) {
	const buf = fs.readFileSync(file);
	const ext = path.extname(file).toLowerCase();
	if (ext === '.png') { const r = readPNG(buf, file); checkPNG(buf, file); return r; }
	if (ext === '.bmp') { const r = readBMP(buf, file); checkBMP(buf, file, r); return r; }
	if (ext === '.ico') { const r = readICO(buf, file); checkICO(buf, file); return r; }
	throw new Error(`${file}: estensione non gestita`);
}

// ---------- codifiche ----------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td), 0);
	return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const stride = w * 4;
	const raw = Buffer.alloc(h * (1 + stride));
	for (let y = 0; y < h; y++) {
		const row = y * (1 + stride);
		raw[row] = 0; // filtro None
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, row + 1);
	}
	return Buffer.concat([
		sig,
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

function encodeBMP(w, h, bpp, rgba) {
	const bppBytes = bpp / 8;
	const rowSize = Math.ceil((w * bppBytes) / 4) * 4;
	const imgSize = rowSize * h;
	const buf = Buffer.alloc(54 + imgSize); // BITMAPFILEHEADER 14 + BITMAPINFOHEADER 40
	buf.write('BM', 0, 'ascii');
	buf.writeUInt32LE(buf.length, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18);
	buf.writeInt32LE(h, 22); // bottom-up
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(bpp, 28);
	buf.writeUInt32LE(0, 30); // BI_RGB
	buf.writeUInt32LE(imgSize, 34);
	buf.writeInt32LE(2835, 38); // 72 dpi
	buf.writeInt32LE(2835, 42);
	for (let y = 0; y < h; y++) {
		const srcY = h - 1 - y;
		const rowStart = 54 + y * rowSize;
		for (let x = 0; x < w; x++) {
			const si = (srcY * w + x) * 4;
			const di = rowStart + x * bppBytes;
			buf[di] = rgba[si + 2]; // B
			buf[di + 1] = rgba[si + 1]; // G
			buf[di + 2] = rgba[si]; // R
			if (bppBytes === 4) buf[di + 3] = rgba[si + 3]; // A
		}
	}
	return buf;
}

function encodeICO(images) {
	const count = images.length;
	const header = Buffer.alloc(6 + 16 * count);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(count, 4);
	let off = 6 + 16 * count;
	images.forEach((im, i) => {
		const e = 6 + i * 16;
		header[e] = im.w === 256 ? 0 : im.w;
		header[e + 1] = im.h === 256 ? 0 : im.h;
		header.writeUInt16LE(1, e + 4); // planes
		header.writeUInt16LE(32, e + 6); // bitcount
		header.writeUInt32LE(im.png.length, e + 8);
		header.writeUInt32LE(off, e + 12);
		off += im.png.length;
	});
	return Buffer.concat([header, ...images.map((i) => i.png)]);
}

// ---------- disegno del marchio ----------
// Identità Vox: quadrato/scudo grafite con una "V" chiara e tre barre
// verticali a diverse altezze (onda vocale). Colori sobri.

const DARK = {
	bgTop: [41, 47, 60],
	bgBot: [22, 25, 32],
	v: [233, 240, 246],
	barA: [78, 199, 186],
	barB: [118, 205, 230],
};
const LIGHT = { // per le BMP dell'installer su sfondo chiaro
	bgTop: [255, 255, 255],
	bgBot: [255, 255, 255],
	v: [45, 56, 78],
	barA: [28, 158, 140],
	barB: [52, 178, 164],
};

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
	const qx = Math.abs(px - cx) - hw + r;
	const qy = Math.abs(py - cy) - hh + r;
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSeg(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));
const lerp = (a, b, t) => a + (b - a) * t;

// output del glifo: gV/gB in 0..1, gBarX0/gBarW per la tinta delle barre
let gV = 0, gB = 0, gBarX0 = 0, gBarW = 1;
// Taglie piccole (<= 64 px): glifo più grande, tratto più spesso, barre staccate e senza dilatazione.
let gSmall = false;
function glyph(px, py, cx, cy, g) {
	const halfT = g * (gSmall ? 0.07 : 0.05);
	const ax = cx - g * 0.3, ay = cy - g * 0.36;
	const mx = cx, my = cy + g * 0.24;
	const bx = cx + g * 0.3, by = cy - g * 0.36;
	const dV = Math.min(sdSeg(px, py, ax, ay, mx, my), sdSeg(px, py, mx, my, bx, by)) - halfT;
	gV = cover(dV);
	const bw = g * (gSmall ? 0.075 : 0.05), gap = g * (gSmall ? 0.075 : 0.045);
	const heights = [0.1, 0.16, 0.12];
	const totalW = 3 * bw + 2 * gap;
	const base = cy + g * 0.5;
	gBarX0 = cx - totalW / 2;
	gBarW = totalW;
	let dB = Infinity;
	for (let i = 0; i < 3; i++) {
		const x0 = cx - totalW / 2 + i * (bw + gap);
		const top = base - heights[i] * g;
		dB = Math.min(dB, sdRoundBox(px, py, x0 + bw / 2, (top + base) / 2, bw / 2, (base - top) / 2, bw * 0.45));
	}
	gB = cover(dB - (gSmall ? 0 : g * 0.015));
}

// variant: 'app' (sfondo pieno), 'emblem' (badge arrotondato), 'circle' (badge tondo), 'wizard' (BMP chiaro)
function render(w, h, variant) {
	const pal = variant === 'wizard' ? LIGHT : DARK;
	const data = new Uint8ClampedArray(w * h * 4);
	const cx = w / 2, cy = h / 2, m = Math.min(w, h);
	const g = variant === 'app' ? m * 0.56
		: variant === 'wizard' ? m * 0.56
		: variant === 'circle' ? m * 0.46 : m * 0.5;
	gSmall = m <= 64;
	const gScale = gSmall ? 1.3 : 1;
	const gl = g * gScale;
	const badge = variant === 'emblem' ? { inset: m * 0.07, r: m * 0.2, round: true }
		: variant === 'circle' ? { r: m * 0.44, round: false } : null;
	for (let y = 0; y < h; y++) {
		const py = y + 0.5;
		const tBg = h > 1 ? y / (h - 1) : 0;
		const bgR = lerp(pal.bgTop[0], pal.bgBot[0], tBg);
		const bgG = lerp(pal.bgTop[1], pal.bgBot[1], tBg);
		const bgB = lerp(pal.bgTop[2], pal.bgBot[2], tBg);
		for (let x = 0; x < w; x++) {
			const px = x + 0.5;
			const i = (y * w + x) * 4;
			let aBg = 1;
			if (badge) {
				const d = badge.round
					? sdRoundBox(px, py, cx, cy, w / 2 - badge.inset, h / 2 - badge.inset, badge.r)
					: Math.hypot(px - cx, py - cy) - badge.r;
				aBg = cover(d);
			}
			if (aBg <= 0) { data[i + 3] = 0; continue; }
			glyph(px, py, cx, cy, gl);
			const aV = gV * aBg, aB = gB * aBg;
			// compositing: sfondo -> V -> barre (dall'alpha più bassa)
			let A = aBg, R = bgR, G = bgG, B = bgB;
			if (aV > 0) {
				const oa = aV + A * (1 - aV);
				R = (pal.v[0] * aV + R * A * (1 - aV)) / oa;
				G = (pal.v[1] * aV + G * A * (1 - aV)) / oa;
				B = (pal.v[2] * aV + B * A * (1 - aV)) / oa;
				A = oa;
			}
			if (aB > 0) {
				const t = Math.min(1, Math.max(0, (px - gBarX0) / gBarW));
				const oa = aB + A * (1 - aB);
				R = (lerp(pal.barA[0], pal.barB[0], t) * aB + R * A * (1 - aB)) / oa;
				G = (lerp(pal.barA[1], pal.barB[1], t) * aB + G * A * (1 - aB)) / oa;
				B = (lerp(pal.barA[2], pal.barB[2], t) * aB + B * A * (1 - aB)) / oa;
				A = oa;
			}
			data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = A * 255;
		}
	}
	return data;
}

// ---------- bersagli ----------

const REQUIRED_ICO = [16, 24, 32, 48, 64, 128, 256];

const TARGETS = [
	// PNG
	{ path: 'resources/win32/code_150x150.png', variant: 'app' },
	{ path: 'resources/win32/code_70x70.png', variant: 'app' },
	{ path: 'resources/win32/logo_cube_noshadow.png', variant: 'emblem' },
	{ path: 'resources/linux/code.png', variant: 'app' },
	{ path: 'resources/server/code-192.png', variant: 'app' },
	{ path: 'resources/server/code-512.png', variant: 'app' },
	{ path: 'vox_icons/cubecircled.png', variant: 'circle' },
	{ path: 'vox_icons/logo_cube_noshadow.png', variant: 'emblem' },
	{ path: 'vox_icons/slice_of_vox.png', variant: 'emblem' },
	{ path: 'src/vs/workbench/browser/media/vox-icon-sm.png', variant: 'emblem' },
	{ path: 'src/vs/workbench/browser/parts/editor/media/slice_of_vox.png', variant: 'emblem' },
	{ path: 'src/vs/workbench/browser/parts/editor/media/vox_cube_noshadow.png', variant: 'emblem' },
	{ path: 'scripts/appimage/vox.png', variant: 'app' },
	// ICO
	{ path: 'resources/win32/code.ico', kind: 'ico' },
	{ path: 'resources/server/favicon.ico', kind: 'ico' },
	{ path: 'vox_icons/code.ico', kind: 'ico' },
];
// BMP: inno-vox + varianti inno-big/inno-small
{
	const bmpPaths = ['resources/win32/inno-vox.bmp'];
	for (let s = 100; s <= 250; s += 25) {
		bmpPaths.push(`resources/win32/inno-big-${s}.bmp`, `resources/win32/inno-small-${s}.bmp`);
	}
	for (const p of bmpPaths) TARGETS.push({ path: p, kind: 'bmp' });
}

// Icona dell'app per macOS: un file ICNS con le immagini PNG alle taglie che macOS usa.
const ICNS_PATH = 'resources/darwin/code.icns';
const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];

function encodeICNS() {
	const entries = ICNS_TYPES.map(([type, s]) => {
		const png = encodePNG(s, s, render(s, s, 'app'));
		const head = Buffer.alloc(8);
		head.write(type, 0, 'ascii');
		head.writeUInt32BE(png.length + 8, 4);
		return Buffer.concat([head, png]);
	});
	const head = Buffer.alloc(8);
	head.write('icns', 0, 'ascii');
	head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
	return Buffer.concat([head, ...entries]);
}

// Legge l'indice di un file ICNS: tipo e dimensioni del PNG di ogni voce.
function readICNS(buf, file) {
	if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') throw new Error(`${file}: non è un ICNS`);
	if (buf.readUInt32BE(4) !== buf.length) throw new Error(`${file}: lunghezza dichiarata diversa da quella del file`);
	const entries = [];
	for (let o = 8; o < buf.length;) {
		const type = buf.toString('ascii', o, o + 4);
		const len = buf.readUInt32BE(o + 4);
		if (len < 8 || o + len > buf.length) throw new Error(`${file}: voce ${type} troncata`);
		const png = readPNG(buf.subarray(o + 8, o + len), `${file} (${type})`);
		entries.push([type, png.w, png.h]);
		o += len;
	}
	return entries;
}

function abs(rel) { return path.join(ROOT, rel); }

function describe(info) {
	if (info.format === 'ico') return `ico [${info.sizes.join(',')}]`;
	if (info.format === 'bmp') return `bmp ${info.w}x${info.h} ${info.bpp}bpp`;
	return `png ${info.w}x${info.h}`;
}

function generateIcoSizes(rel, info) {
	// I file chiamati code.ico devono contenere le taglie richieste (unione con le originali).
	if (path.basename(rel) === 'code.ico') {
		return [...new Set([...info.sizes, ...REQUIRED_ICO])].sort((a, b) => a - b);
	}
	return info.sizes;
}

function main() {
	if (VERIFICA) return verify();

	const esistente = fs.existsSync(SNAP) && !AGGIORNA_RIFERIMENTO;
	const snapshot = esistente ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : {};
	const errors = [];
	// prima passata: registra dimensioni/formati originali (solo se lo snapshot manca o è richiesto l'aggiornamento)
	for (const t of TARGETS) {
		if (esistente) {
			if (!snapshot[t.path]) errors.push(`${t.path}: assente nello snapshot (usare --aggiorna-riferimento)`);
			continue;
		}
		try {
			snapshot[t.path] = inspect(abs(t.path));
		} catch (e) {
			errors.push(e.message);
		}
	}
	if (errors.length) {
		console.error('File illeggibili, nessuna scrittura effettuata:');
		for (const e of errors) console.error(' -', e);
		process.exit(1);
	}
	if (!esistente) {
		fs.writeFileSync(SNAP, JSON.stringify(snapshot, null, '\t') + '\n', 'utf8');
		console.log(`Snapshot salvato: ${path.relative(ROOT, SNAP)}`);
	} else {
		console.log(`Snapshot esistente conservato: ${path.relative(ROOT, SNAP)}`);
	}

	// seconda passata: genera e sovrascrive
	for (const t of TARGETS) {
		const info = snapshot[t.path];
		const file = abs(t.path);
		let out;
		if (t.kind === 'ico') {
			const images = generateIcoSizes(t.path, info).map((s) => ({
				w: s, h: s,
				png: encodePNG(s, s, render(s, s, 'app')),
			}));
			out = encodeICO(images);
		} else if (t.kind === 'bmp') {
			// Le BMP dell'installer sono su sfondo chiaro: palette LIGHT e bianco pieno.
			const rgba = render(info.w, info.h, 'wizard');
			for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // alfa opaco per 32bpp
			out = encodeBMP(info.w, info.h, info.bpp === 8 ? 24 : info.bpp, rgba); // 8bpp originale -> 24bpp
		} else {
			out = encodePNG(info.w, info.h, render(info.w, info.h, t.variant));
		}
		fs.writeFileSync(file, out);
		console.log(`OK ${t.path} <- ${describe(info)}`);
	}
	fs.writeFileSync(abs(ICNS_PATH), encodeICNS());
	console.log(`OK ${ICNS_PATH} <- icns [${ICNS_TYPES.map(([type, s]) => `${type} ${s}`).join(', ')}]`);
	console.log('Fatto. Verifica con: node build/vox-icone/vox-icone.mjs --verifica');
}

function verify() {
	if (!fs.existsSync(SNAP)) {
		console.error(`Snapshot mancante: ${SNAP}. Eseguire prima la generazione.`);
		process.exit(1);
	}
	const snapshot = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
	let fail = 0;
	for (const t of TARGETS) {
		const exp = snapshot[t.path];
		if (!exp) {
			console.log(`FAIL ${t.path}: assente nello snapshot`);
			fail++;
			continue;
		}
		let got;
		try {
			got = inspect(abs(t.path));
		} catch (e) {
			console.log(`FAIL ${t.path}: ${e.message}`);
			fail++;
			continue;
		}
		const same = JSON.stringify(exp) === JSON.stringify(got) ||
			(exp.format === got.format && exp.w === got.w && exp.h === got.h &&
				(exp.bpp === undefined || exp.bpp === got.bpp || (exp.bpp === 8 && got.bpp === 24)) &&
				(exp.sizes === undefined || JSON.stringify(exp.sizes) === JSON.stringify(got.sizes)));
		if (same) {
			console.log(`OK   ${t.path} <- ${describe(got)}`);
		} else {
			console.log(`FAIL ${t.path}: atteso ${describe(exp)}, trovato ${describe(got)}`);
			fail++;
		}
		// vincolo esplicito sulle dimensioni ICO di code.ico
		if (path.basename(t.path) === 'code.ico' && got.format === 'ico') {
			for (const s of REQUIRED_ICO) {
				if (!got.sizes.includes(s)) {
					console.log(`FAIL ${t.path}: manca la taglia ${s}px`);
					fail++;
				}
			}
		}
	}
	try {
		const got = readICNS(fs.readFileSync(abs(ICNS_PATH)), ICNS_PATH);
		const want = ICNS_TYPES.map(([type, s]) => [type, s, s]);
		if (JSON.stringify(got) === JSON.stringify(want)) {
			console.log(`OK   ${ICNS_PATH} <- icns [${got.map(([type, w]) => `${type} ${w}`).join(', ')}]`);
		} else {
			console.log(`FAIL ${ICNS_PATH}: atteso ${JSON.stringify(want)}, trovato ${JSON.stringify(got)}`);
			fail++;
		}
	} catch (e) {
		console.log(`FAIL ${ICNS_PATH}: ${e.message}`);
		fail++;
	}
	console.log(fail === 0 ? 'VERIFICA SUPERATA' : `VERIFICA FALLITA (${fail} errori)`);
	process.exit(fail === 0 ? 0 : 1);
}

main();
