// La chat non carica immagini da un indirizzo: disegna solo quelle che stanno dentro il messaggio.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { marked } from 'marked';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const source = await read('./inlineImage.ts');
assert.equal(/^import /m.test(source), false, 'inlineImage.ts deve restare senza importazioni');
const { isInlineImageSrc, imageFallback, externalLinkHref } = new Function(stripTypeScriptTypes(source).replace(/^export /gm, '') + '; return { isInlineImageSrc, imageFallback, externalLinkHref };')();

const png = 'data:image/png;base64,iVBORw0KGgo=';

test('si disegna solo un\'immagine che sta tutta nel messaggio', () => {
	assert.equal(isInlineImageSrc(png), true);
	assert.equal(isInlineImageSrc('data:image/jpeg;base64,/9j/4AAQ'), true);
	assert.equal(isInlineImageSrc('data:image/gif;base64,R0lGODlh'), true);
	assert.equal(isInlineImageSrc('data:image/webp;base64,UklGRg=='), true);
});

test('nessun indirizzo viene caricato, qualunque sia lo schema', () => {
	for (const href of [
		'https://esempio.example/a.png', 'http://esempio.example/a.png', '//esempio.example/a.png', 'HTTPS://esempio.example/a.png',
		'https://esempio.example/a.png?dati=segreto', ' https://esempio.example/a.png', 'a.png', './a.png', '/a.png',
		'file:///C:/a.png', 'vscode-file://vscode-app/a.png', 'vscode-remote-resource://host/a.png', 'vscode-managed-remote-resource://host/a.png',
		'blob:vscode-file://vscode-app/1', 'javascript:alert(1)', '',
	]) assert.equal(isInlineImageSrc(href), false, href);
});

test('un `data:` che non è un\'immagine semplice e ben formata non si disegna', () => {
	for (const href of [
		// SVG e HTML possono contenere altri indirizzi
		'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', 'data:text/html;base64,PGI+', 'data:text/html,<img src=https://esempio.example>',
		// forme diverse da quella attesa
		'data:image/png,grezzo', 'data:image/png;base64,', 'data:image/png;base64,iVBOR w0K', 'data:image/png;base64,iVBOR\nhttps://esempio.example', 'data:image/png;charset=utf-8;base64,iVBO',
		'DATA:image/png;base64,iVBO', 'data:image/png;base64,iVBO#https://esempio.example', 'x' + png, png + '"', 'data:image/png&#59;base64,iVBO',
		// base64 con lunghezza o riempimento sbagliati
		'data:image/png;base64,A=', 'data:image/png;base64,iVBOR', 'data:image/png;base64,iVBO=', 'data:image/png;base64,iV==BO', 'data:image/png;base64,====',
	]) assert.equal(isInlineImageSrc(href), false, href);
	for (const href of [undefined, null, 0, {}, [png]]) assert.equal(isInlineImageSrc(href), false);
});

test('con il Markdown vero: conta l\'indirizzo come lo legge marked', () => {
	const images = markdown => {
		const found = [];
		marked.walkTokens(marked.lexer(markdown), token => { if (token.type === 'image') found.push(token); });
		return found;
	};
	const drawn = markdown => images(markdown).map(token => isInlineImageSrc(token.href));
	assert.deepEqual(drawn(`![a](${png})`), [true]);
	assert.deepEqual(drawn(`![a](${png} "titolo")`), [true]);
	// parentesi angolari, riferimenti, immagine dentro un collegamento, entità, barre rovesciate, spazi
	assert.deepEqual(drawn('![a](<https://esempio.example/a b.png>)'), [false]);
	assert.deepEqual(drawn('![a][1]\n\n[1]: https://esempio.example/a.png'), [false]);
	assert.deepEqual(drawn('[![a](https://esempio.example/a.png)](https://esempio.example)'), [false]);
	assert.deepEqual(drawn('![a](data:image/png&#59;base64,iVBO)'), [false]);
	assert.deepEqual(drawn('![a](https\\://esempio.example/a.png)'), [false]);
	assert.deepEqual(drawn('![a](//esempio.example/a.png) ![b](a.png) ![c](data:image/svg+xml;base64,PHN2Zz4=)'), [false, false, false]);
	// un indirizzo incollato dopo un `data:` valido non passa
	assert.deepEqual(drawn(`![a](<${png} https://esempio.example/a.png>)`), [false]);
	assert.equal(images('![a](https://esempio.example/a.png)')[0].href, 'https://esempio.example/a.png');
});

test('al posto dell\'immagine: collegamento solo per http(s), testo accorciato per tutto il resto', () => {
	assert.deepEqual(imageFallback('https://esempio.example/a.png', 'grafico', '![grafico](https://esempio.example/a.png)'), { kind: 'link', href: 'https://esempio.example/a.png', label: 'grafico', title: 'https://esempio.example/a.png' });
	// senza testo alternativo (o con soli spazi) si vede l'indirizzo
	assert.equal(imageFallback('http://esempio.example/a.png', '   ', 'x').label, 'http://esempio.example/a.png');
	// gli altri schemi non diventano cliccabili: prima erano un <img> inerte
	for (const href of ['javascript:alert(1)', 'mailto:a@esempio.example', 'file:///C:/a.png', 'vscode://estensione/comando', 'data:text/html;base64,PGI+', '//esempio.example/a.png', 'a.png', '', 'https://', 'https:// esempio', undefined]) {
		assert.equal(imageFallback(href, 'apri', '![apri](x)').kind, 'text', String(href));
	}
	assert.deepEqual(imageFallback('', '', '![][manca]'), { kind: 'text', label: '![][manca]' });
	// un `data:` rifiutato e lunghissimo non finisce intero nella chat né nel suggerimento
	const huge = 'data:image/svg+xml;base64,' + 'A'.repeat(100_000);
	assert.ok(imageFallback(huge, '', `![](${huge})`).label.length <= 201);
	assert.ok(imageFallback(huge, 'a'.repeat(5000), 'x').label.length <= 201);
	const long = imageFallback('https://esempio.example/' + 'a'.repeat(1500), '', 'x');
	assert.ok(long.label.length <= 201 && long.title.length <= 201);
	assert.equal(long.href.length, 1524); // l'indirizzo vero del collegamento non si accorcia
	assert.ok(long.title.startsWith('https://esempio.example/')); // e il suggerimento ne mostra l'inizio, cioè il dominio
	// un indirizzo smisurato, malformato o che nasconde il dominio vero resta testo
	for (const href of ['https://esempio.example/' + 'a'.repeat(5000), 'https://fidato.example@altro.example/a.png', 'https://utente:parola@altro.example/a.png', 'https://esempio.example:65536/a.png', 'https://?q=1', 'https://#x', 'https://:80', 'https://esempio.example/a b.png']) {
		assert.equal(imageFallback(href, 'apri', 'x').kind, 'text', href);
	}
	// passando dal lexer vero
	const token = marked.lexer('![grafico](<https://esempio.example/a b.png>) ![due](https://fidato.example@altro.example/a.png)')[0].tokens.filter(t => t.type === 'image');
	assert.deepEqual(token.map(t => imageFallback(t.href, t.text, t.raw)), [{ kind: 'text', label: 'grafico' }, { kind: 'text', label: 'due' }]);
});

test('un clic su un collegamento apre solo pagine web e, per i collegamenti normali, indirizzi di posta', () => {
	for (const href of ['https://esempio.example', 'https://esempio.example/', 'http://esempio.example/a?b=c#d', 'HTTPS://Esempio.example/a', 'https://esempio.example:8080/a', 'http://127.0.0.1:3000/', 'https://[::1]/a', 'https://esempio.example/a@b']) {
		assert.equal(externalLinkHref(href, true), href, href);
		assert.equal(externalLinkHref(href, false), href, href);
	}
	assert.equal(externalLinkHref('mailto:nome@esempio.example', true), 'mailto:nome@esempio.example');
	assert.equal(externalLinkHref('mailto:nome@esempio.example', false), null);
	for (const href of [
		// altri schemi: finirebbero al sistema operativo
		'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'vscode://estensione/comando', 'vscode-file://vscode-app/a', 'ms-msdt:/id', 'data:text/html;base64,PGI+', 'blob:https://esempio.example/1', 'about:blank', 'ftp://esempio.example/a', 'command:workbench.action.terminal.new', 'mailto:', 'mailto:nome', 'mailto:nome@esempio.example?attach=C:/segreto.txt',
		// senza schema, malformati, con spazi o caratteri di controllo
		'//esempio.example/a', 'esempio.example', 'a.png', '/a', '', 'https://', 'https:/esempio.example', 'https:\\esempio.example', ' https://esempio.example', 'https://esempio.example/a b', 'https://esempio.example/\n', 'https://esempio.example/\u0000', 'https://esempio.example:65536/', 'https://?q=1', 'https://#x', 'https://:80',
		// il dominio vero nascosto dietro un nome utente
		'https://fidato.example@altro.example/', 'https://fidato.example:x@altro.example/', 'https://@altro.example/',
		'https://esempio.example/' + 'a'.repeat(2000),
	]) assert.equal(externalLinkHref(href, true), null, JSON.stringify(href));
	for (const href of [undefined, null, 0, {}, ['https://esempio.example']]) assert.equal(externalLinkHref(href, true), null);
});

test('l\'interfaccia di Vox ha un solo <img>, quello della chat, dietro il controllo', async () => {
	const root = new URL('../', import.meta.url);
	const files = (await readdir(root, { recursive: true })).filter(file => /\.(?:tsx?|jsx?|css)$/.test(file)).map(file => file.replace(/\\/g, '/')).sort();
	assert.ok(files.includes('markdown/ChatMarkdownRender.tsx'));
	const withImg = [];
	for (const file of files) {
		// (si tolgono solo i commenti a inizio riga o dopo uno spazio: `https://…` dentro una stringa resta)
		const text = (await readFile(new URL(file, root), 'utf8')).replace(/(^|\s)\/\/.*$/gm, '$1');
		if (/<img\b|createElement\(\s*['"`]img['"`]|new Image\(/.test(text)) withImg.push(file);
		// niente altri modi di far caricare un indirizzo, né di disegnare HTML scritto dal modello
		assert.equal(/<(?:iframe|video|audio|source|embed|object|picture|link|script)\b|dangerouslySetInnerHTML\s*=|\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|srcSet=|\burl\(/.test(text), false, file);
		// né richieste fatte dall'interfaccia (il test di sicurezza del processo principale non guarda questa cartella)
		assert.equal(/\bfetch\(|XMLHttpRequest|new WebSocket\(|EventSource|sendBeacon|https?\.request\(|net\.request\(/.test(text), false, file);
	}
	assert.deepEqual(withImg, ['markdown/ChatMarkdownRender.tsx']);
	const render = (await read('./ChatMarkdownRender.tsx')).replace(/\r\n/g, '\n');
	assert.equal([...render.matchAll(/<img\b/g)].length, 1);
	// l'immagine si disegna solo dopo il controllo (senza, si esce prima di arrivarci) e con lo stesso indirizzo controllato
	assert.match(render, /if \(t\.type === 'image'\) \{\n\t\tif \(!isInlineImageSrc\(t\.href\)\) \{\n\t\t\treturn <ImageNotDrawn [^\n]*\n\t\t\}\n\t\treturn <img\n\t\t\tsrc=\{t\.href\}\n/);
	// il collegamento che la sostituisce apre solo l'indirizzo passato dal controllo, e solo al clic
	assert.match(render, /const fallback = imageFallback\(href, text, raw\)\n\tif \(fallback\.kind === 'text'\) return <span>\{fallback\.label\}<\/span>\n/);
	assert.match(render, /onClick=\{\(e\) => \{ e\.preventDefault\(\); window\.open\(fallback\.href\) \}\}\n\t\t\thref=\{fallback\.href\}/);
	// lo stesso vale per i collegamenti normali; nessun altro `window.open` né `<a href>` nell'interfaccia della chat
	assert.match(render, /const linkHref = externalLinkHref\(t\.href, true\)\n\t\tif \(linkHref === null\) \{\n\t\t\treturn <span>\{t\.text\}<\/span>\n\t\t\}\n/);
	assert.match(render, /onClick=\{\(e\) => \{ e\.preventDefault\(\); window\.open\(linkHref\) \}\}\n\t\t\t\thref=\{linkHref\}\n\t\t\t\ttitle=\{linkHref\}/);
	assert.deepEqual([...render.matchAll(/window\.open\(([^)]*)\)/g)].map(match => match[1]), ['fallback.href', 'linkHref']);
	assert.deepEqual([...render.matchAll(/\n\t+href=\{([^}]*)\}/g)].map(match => match[1]), ['fallback.href', 'linkHref']);
	for (const file of files) if (file !== 'markdown/ChatMarkdownRender.tsx') assert.equal(/window\.open\(/.test(await readFile(new URL(file, root), 'utf8')), false, file);
});
