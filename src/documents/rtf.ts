import { joinBlocks, type ConvertedDocument } from './common.js';

/**
 * Rich Text Format (`.rtf`): the text, paragraph by paragraph. Fonts, colours, styles,
 * pictures and document metadata are skipped; `\'hh` escapes are read as Windows-1252 and
 * `\uN` as Unicode.
 */

/** Groups whose content is not body text. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf',
  'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'mmathPr', 'fldinst', 'bkmkstart', 'bkmkend',
]);

const cp1252 = new TextDecoder('windows-1252');

export function rtfToText(rtf: string): string {
  let out = '';
  // Per group: whether it is skipped, and how many characters follow a \u escape (\ucN).
  const stack: { skip: boolean; uc: number }[] = [];
  let state = { skip: false, uc: 1 };
  let pendingSkip = 0;
  let i = 0;
  const emit = (text: string) => {
    if (state.skip) return;
    if (pendingSkip > 0) {
      const n = Math.min(pendingSkip, text.length);
      pendingSkip -= n;
      text = text.slice(n);
    }
    out += text;
  };
  while (i < rtf.length) {
    const c = rtf[i]!;
    if (c === '{') {
      stack.push(state);
      state = { ...state };
      i++;
      // `{\*\dest ...}` marks an optional destination a reader may skip.
      if (rtf.startsWith('\\*', i)) state.skip = true;
    } else if (c === '}') {
      state = stack.pop() ?? { skip: false, uc: 1 };
      i++;
    } else if (c === '\\') {
      const next = rtf[i + 1];
      if (next === undefined) break;
      if (next === "'") {
        const byte = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (Number.isFinite(byte)) emit(cp1252.decode(new Uint8Array([byte])));
        i += 4;
        continue;
      }
      if (!/[a-z]/i.test(next)) {
        // Control symbols: \\ \{ \} \~ (nbsp) \- (optional hyphen) \_ (non-breaking hyphen).
        if (next === '\\' || next === '{' || next === '}') emit(next);
        else if (next === '~') emit(' ');
        else if (next === '_') emit('-');
        else if (next === '\n' || next === '\r') emit('\n');
        i += 2;
        continue;
      }
      const m = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1, i + 40))!;
      const word = m[1]!;
      const param = m[2] === undefined ? undefined : Number(m[2]);
      i += 1 + m[0].length;
      if (SKIP_DESTINATIONS.has(word)) {
        state.skip = true;
        continue;
      }
      switch (word) {
        case 'par':
        case 'sect':
        case 'page':
          emit('\n\n');
          break;
        case 'line':
        case 'row':
          emit('\n');
          break;
        case 'tab':
        case 'cell':
          emit(word === 'cell' ? ' | ' : '\t');
          break;
        case 'uc':
          state.uc = param ?? 1;
          break;
        case 'u':
          if (param !== undefined) {
            emit(String.fromCharCode(param < 0 ? param + 65536 : param));
            pendingSkip = state.uc;
          }
          break;
        case 'emdash':
          emit('—');
          break;
        case 'endash':
          emit('–');
          break;
        case 'lquote':
        case 'rquote':
          emit(word === 'lquote' ? '‘' : '’');
          break;
        case 'ldblquote':
        case 'rdblquote':
          emit(word === 'ldblquote' ? '“' : '”');
          break;
        case 'bullet':
          emit('•');
          break;
      }
    } else if (c === '\n' || c === '\r') {
      i++;
    } else {
      let j = i;
      while (j < rtf.length && !'{}\\\r\n'.includes(rtf[j]!)) j++;
      emit(rtf.slice(i, j));
      i = j;
    }
  }
  return out;
}

export function convertRtf(bytes: Uint8Array): ConvertedDocument {
  const text = rtfToText(new TextDecoder('latin1').decode(bytes));
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim());
  return { markdown: joinBlocks(paragraphs), format: 'rtf' };
}
