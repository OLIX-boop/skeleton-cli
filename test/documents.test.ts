import { describe, expect, it } from 'vitest';
import { convertDocx } from '../src/documents/docx.js';
import { convertEml, decodeHeader } from '../src/documents/eml.js';
import { convertEpub } from '../src/documents/epub.js';
import { convertHtml, htmlToMarkdown } from '../src/documents/html.js';
import { decodeEntities, parseMarkup, textOf } from '../src/documents/markup.js';
import { convertOdf } from '../src/documents/odf.js';
import { convertPptx } from '../src/documents/pptx.js';
import { convertRtf } from '../src/documents/rtf.js';
import { convertXlsx, serialToIso, toCsv } from '../src/documents/xlsx.js';
import { markdownTable } from '../src/documents/common.js';
import { docx, para, zip } from './documents-fixtures.js';

describe('markup parser', () => {
  it('parses XML with namespaces, entities and CDATA', () => {
    const root = parseMarkup('<?xml version="1.0"?><a:x k="1 &amp; 2"><b>Tom &amp; &#x41;</b><![CDATA[<raw>]]><c/></a:x>');
    const x = root.children[0] as { name: string; attrs: Record<string, string> };
    expect(x.name).toBe('a:x');
    expect(x.attrs.k).toBe('1 & 2');
    expect(textOf(root)).toBe('Tom & A<raw>');
  });

  it('is lenient with HTML: void elements, implied closes, raw script text', () => {
    const root = parseMarkup('<ul><li>a<li>b</ul><p>x<br>y<script>if (a < b) {}</script>', { html: true });
    const ul = root.children[0] as { children: unknown[] };
    expect(ul.children).toHaveLength(2);
    expect(textOf(root)).toContain('if (a < b) {}');
  });

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('&eacute;t&eacute; &#8364;5 &unknown;')).toBe('été €5 &unknown;');
  });
});

describe('markdown tables', () => {
  it('escapes pipes, drops empty trailing columns and rows', () => {
    expect(markdownTable([['a', 'b|c', ''], ['1', '2', ''], ['', '', '']])).toBe('| a | b\\|c |\n| --- | --- |\n| 1 | 2 |');
  });
});

describe('DOCX', () => {
  it('converts headings, lists, tables, footnotes and image descriptions', () => {
    const body = [
      para('Quarterly Review', 'Title'),
      para('Results', 'Heading1'),
      '<w:p><w:r><w:t>Revenue grew</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> this year.</w:t></w:r></w:p>',
      para('Faster checkout', undefined, 1),
      para('Lower churn', undefined, 1),
      para('First step', undefined, 2),
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>EU</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><wp:docPr id="1" name="Picture 1" descr="Sales chart"/></wp:inline></w:drawing></w:r></w:p>',
      '<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>',
    ].join('');
    const footnotes = `<w:footnotes xmlns:w="w"><w:footnote w:type="separator" w:id="0"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Unaudited.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const { markdown } = convertDocx(docx(body, { 'word/footnotes.xml': footnotes }));
    expect(markdown).toBe(
      [
        '# Quarterly Review',
        '## Results',
        'Revenue grew[^1] this year.',
        '- Faster checkout\n- Lower churn\n1. First step',
        '| Region | Total |\n| --- | --- |\n| EU | 12 |',
        '[image: Sales chart]',
        'kept',
        '[^1]: Unaudited.',
      ].join('\n\n') + '\n',
    );
  });

  it('rejects files that are not Word documents', () => {
    expect(() => convertDocx(zip({ 'a.txt': 'x' }))).toThrow(/document\.xml/);
    expect(() => convertDocx(new Uint8Array([1, 2, 3]))).toThrow(/ZIP/);
  });
});

describe('PPTX', () => {
  const P = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"';
  const slide = (title: string, bullets: string[]) => `<p:sld ${P}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${bullets.map((b, i) => `<a:p><a:pPr lvl="${i % 2}"/><a:r><a:t>${b}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const rel = (id: string, target: string) => `<Relationship Id="${id}" Target="${target}"/>`;

  it('lists slides in presentation order with titles, bullets and notes', () => {
    const deck = zip({
      'ppt/presentation.xml': `<p:presentation ${P}><p:sldIdLst><p:sldId r:id="rId3"/><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships>${rel('rId2', 'slides/slide1.xml')}${rel('rId3', 'slides/slide2.xml')}</Relationships>`,
      'ppt/slides/slide1.xml': slide('Second', ['Only point']),
      'ppt/slides/slide2.xml': slide('First', ['Point A', 'Detail']),
      'ppt/slides/_rels/slide2.xml.rels': `<Relationships>${rel('rId1', '../notesSlides/notesSlide1.xml')}</Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': `<p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    });
    const result = convertPptx(deck);
    expect(result.pages).toBe(2);
    expect(result.markdown).toBe('## Slide 1: First\n\n- Point A\n  - Detail\n\n> Notes: Say hello\n\n## Slide 2: Second\n\n- Only point\n');
  });
});

describe('XLSX', () => {
  it('converts sheets to CSV with shared strings, dates, booleans and quoting', () => {
    const book = zip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Sales" r:id="rId1"/><sheet name="Secret" state="hidden" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Date</t></si><si><r><t>Smith, </t></r><r><t>J</t></r></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Paid</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45658</v></c><c r="C2" t="b"><v>1</v></c><c r="E2"><v>3.5</v></c></row>
      </sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    });
    const result = convertXlsx(book);
    expect(result.markdown).toBe('## Sheet: Sales (2 rows)\n\n```csv\nName,Date,Paid,,\n"Smith, J",2025-01-01,TRUE,,3.5\n```\n');
  });

  it('formats serial dates and trims CSV', () => {
    expect(serialToIso(45658.5)).toBe('2025-01-01 12:00:00');
    expect(toCsv([['a', '', ''], ['', '', ''], []])).toBe('a');
  });
});

describe('OpenDocument', () => {
  const O = 'xmlns:office="o" xmlns:text="t" xmlns:table="tb" xmlns:draw="d" xmlns:presentation="p"';
  const odf = (body: string) => zip({ 'content.xml': `<office:document-content ${O}><office:body>${body}</office:body></office:document-content>` });

  it('reads text documents: headings, paragraphs, lists, spaces', () => {
    const doc = odf('<office:text><text:h text:outline-level="2">Intro</text:h><text:p>a<text:s text:c="2"/>b<text:line-break/>c</text:p><text:list><text:list-item><text:p>one</text:p></text:list-item></text:list></office:text>');
    expect(convertOdf(doc, 'odt').markdown).toBe('## Intro\n\na b\nc\n\n- one\n');
  });

  it('reads spreadsheets, capping repeated empty cells', () => {
    const doc = odf('<office:spreadsheet><table:table table:name="T"><table:table-row><table:table-cell office:value-type="float" office:value="2"><text:p>2.00</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16384"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row></table:table></office:spreadsheet>');
    expect(convertOdf(doc, 'ods').markdown).toBe('## Sheet: T (1 row)\n\n```csv\n2\n```\n');
  });

  it('reads presentations', () => {
    const doc = odf('<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:p>Body</text:p></draw:text-box></draw:frame></draw:page></office:presentation>');
    expect(convertOdf(doc, 'odp').markdown).toBe('## Slide 1: Title\n\nBody\n');
  });
});

describe('EPUB', () => {
  it('follows the spine and skips non-linear items', () => {
    const book = zip({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf': `<package><metadata><dc:title>The Book</dc:title><dc:creator>Ann</dc:creator></metadata>
        <manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two%20b.xhtml"/><item id="cover" href="cover.xhtml"/></manifest>
        <spine><itemref idref="cover" linear="no"/><itemref idref="c2"/><itemref idref="c1"/></spine></package>`,
      'OEBPS/one.xhtml': '<html><body><h1>One</h1><p>First.</p></body></html>',
      'OEBPS/two b.xhtml': '<html><body><h1>Two</h1><p>Second.</p></body></html>',
      'OEBPS/cover.xhtml': '<html><body><p>Cover</p></body></html>',
    });
    expect(convertEpub(book).markdown).toBe('# The Book\n\n*Ann*\n\n# Two\n\nSecond.\n\n# One\n\nFirst.\n');
  });
});

describe('HTML', () => {
  it('keeps the content and drops chrome, scripts and styles', () => {
    const html = `<html><head><title>Page</title><style>p{}</style></head><body><nav>Menu</nav>
      <main><h2>Guide</h2><p>Hello <a href="x">world</a>.<script>evil()</script></p>
      <ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol>
      <pre><code class="language-js">let a = 1;</code></pre>
      <table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>
      <blockquote><p>Quote</p></blockquote><img alt="Logo"></main><footer>©</footer></body></html>`;
    expect(htmlToMarkdown(html)).toBe(
      '## Guide\n\nHello world.\n\n1. one\n1. two\n  - nested\n\n```js\nlet a = 1;\n```\n\n| k | v |\n| --- | --- |\n| a | 1 |\n\n> Quote\n\n[image: Logo]\n',
    );
    expect(convertHtml(Buffer.from('<title>T</title><p>x</p>')).markdown).toBe('# T\n\nx\n');
  });
});

describe('RTF', () => {
  it('extracts text, skipping tables of fonts and colours, decoding escapes', () => {
    // A plain string: esbuild expands \u escapes even inside String.raw.
    const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Word;}\\f0 Caf\\'e9 \\b bold\\b0\\par Second \\u8364?5 line\\line next\\par}";
    expect(convertRtf(Buffer.from(rtf, 'latin1')).markdown).toBe('Café bold\n\nSecond €5 line\nnext\n');
  });
});

describe('E-mail', () => {
  it('reads headers, prefers the plain-text alternative and lists attachments', () => {
    const eml = [
      'From: Ann <ann@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: =?utf-8?B?UmU6IENhZmXDqQ==?=',
      'Date: Mon, 1 Sep 2025 10:00:00 +0000',
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      '--mix',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Price: 5 =E2=82=AC, see=',
      ' you.',
      '--alt',
      'Content-Type: text/html',
      '',
      '<p>HTML version</p>',
      '--alt--',
      '--mix',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('x'.repeat(2048)).toString('base64'),
      '--mix--',
    ].join('\r\n');
    expect(convertEml(Buffer.from(eml)).markdown).toBe(
      '# Re: Cafeé\n\n**From:** Ann <ann@example.com>  \n**To:** Bob <bob@example.com>  \n**Date:** Mon, 1 Sep 2025 10:00:00 +0000\n\nPrice: 5 €, see you.\n\n[attachment: invoice.pdf, 2 KB]\n'.replace('Cafeé', 'Cafeé'),
    );
  });

  it('decodes RFC 2047 headers', () => {
    expect(decodeHeader('=?iso-8859-1?Q?Gr=FC=DFe?= aus')).toBe('Grüße aus');
  });
});
