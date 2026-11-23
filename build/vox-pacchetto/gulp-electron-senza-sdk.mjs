// Adatta @vscode/gulp-electron ai PC senza Windows 10 SDK.
// Il modulo toglie la firma da electron.exe con signtool prima di cambiarne icona e versione;
// senza SDK il pacchetto si ferma. Con questa modifica, se l'SDK manca, la firma viene tolta qui
// (si azzera la voce "Security" dell'intestazione PE e si taglia la tabella dei certificati in coda).
// Uso, dopo ogni `npm install`:  node build/vox-pacchetto/gulp-electron-senza-sdk.mjs
// La modifica è ripetibile: se è già presente non cambia nulla.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../node_modules/@vscode/gulp-electron/src/win32.js', import.meta.url));
const mark = '// VOX: firma tolta senza Windows SDK';
let source = fs.readFileSync(file, 'utf8');
if (source.includes(mark)) { console.log('già adattato:', file); process.exit(0); }

const eol = source.includes('\r\n') ? '\r\n' : '\n';
const lines = text => text.split('\n').join(eol);

const oldCall = lines(`      const signToolPath = getSignTool();
      const {error} = spawnSync(signToolPath, ["remove", "/s", tempPath]);
      if (error) {
        return cb(error);
      }
`);
const newCall = lines(`      ${mark}
      try {
        if (fs.existsSync(windowsSDKBin)) {
          const {error} = spawnSync(getSignTool(), ["remove", "/s", tempPath]);
          if (error) {
            return cb(error);
          }
        } else {
          stripAuthenticode(tempPath);
        }
      } catch (e) {
        return cb(e);
      }
`);
const oldAnchor = lines(`function getSignTool() {
`);
const newAnchor = lines(`const windowsSDKBin = "C:\\\\Program Files (x86)\\\\Windows Kits\\\\10\\\\bin\\\\";

// Toglie la firma Authenticode da un eseguibile PE senza strumenti esterni.
function stripAuthenticode(file) {
  const data = fs.readFileSync(file);
  const pe = data.readUInt32LE(0x3c);
  if (data.toString("latin1", pe, pe + 4) !== "PE\\0\\0") {
    throw new Error("stripAuthenticode: non è un eseguibile PE: " + file);
  }
  const magic = data.readUInt16LE(pe + 24);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error("stripAuthenticode: intestazione PE sconosciuta: " + file);
  }
  // voce 4 della tabella delle directory: tabella dei certificati (posizione nel file, dimensione)
  const directories = pe + 24 + (magic === 0x20b ? 112 : 96);
  if (directories + 5 * 8 > data.length) {
    throw new Error("stripAuthenticode: intestazione PE troncata: " + file);
  }
  if (data.readUInt32LE(directories - 4) < 5) {
    return; // l'intestazione non dichiara la tabella dei certificati: non firmato
  }
  const entry = directories + 4 * 8;
  const offset = data.readUInt32LE(entry);
  const size = data.readUInt32LE(entry + 4);
  if (offset === 0 || size === 0) {
    return; // non firmato
  }
  if (offset + size > data.length || data.length - (offset + size) > 8) {
    throw new Error("stripAuthenticode: la tabella dei certificati non è in coda al file: " + file);
  }
  data.writeUInt32LE(0, entry);
  data.writeUInt32LE(0, entry + 4);
  fs.writeFileSync(file, data.subarray(0, offset));
}

function getSignTool() {
`);

for (const [from, to] of [[oldCall, newCall], [oldAnchor, newAnchor]]) {
	const count = source.split(from).length - 1;
	if (count !== 1) { console.error('testo atteso non trovato (occorrenze ' + count + '): la versione del modulo è cambiata, rivedere lo script'); process.exit(1); }
	source = source.replace(from, () => to);
}
fs.writeFileSync(file, source);
console.log('adattato:', file);
