// A fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns, for every
// input {text, header}, exactly the answer csv-reader 1.0.0 returns: {columns, rows, errors}.
//
// Written from the published broken-CSV policy, not from the reference's code: the text is read once,
// left to right. A U+FEFF at its very start is dropped. A record ends at LF or CRLF, and a line left
// with no characters is no record. Outside quotes a CR not followed by LF is dropped (stray_cr). A field
// that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote, and each
// CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma or line
// break, is appended as it stands (quote_junk, when the field ends); a quote that never closes is a
// literal character, and the text after it is read again as unquoted (unterminated_quote). A quote inside
// an unquoted field is a literal character. Fields stay strings, never trimmed or converted. columns is
// the first record when header is true, else null; rows holds the records after it, each padded with
// empty strings (short_row, with fields: its field count) or cut (long_row, with extra: the cut fields)
// to the first record's width. Each error is {code, line, row}, in the order met; line is the 1-based
// line its record starts on, counting every LF, CRLF and lone CR inside quotes, and row its record's
// index in rows (null for the header).
//
// Speed: most records are plain (no quotes, no stray CRs) and are taken whole, one slice plus a split;
// the rest are read field by field, each field taken as one slice between delimiters found by a tight
// scan, with quoted fields closed by indexOf. Broken rows (stray CRs, junk, unterminated quotes,
// multi-line quoted fields) are rare, so they take a careful path that keeps the exact error order.

// How a field ended: at a comma (the record goes on), at a line break or at the end of the text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    // The record being read: the line it starts on and the index in rows it takes (null: the header).
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false; // whether the record's last field opened with a quote

    // Fast path: the whole record sits on one physical line and holds no quote and no stray CR,
    // so it is just its comma-split. A quote anywhere on the line, or a CR that is not the CRLF
    // ending it, falls through to the field-by-field path below.
    const eol = text.indexOf('\n', pos);
    let segEnd = eol === -1 ? len : eol;
    if (eol !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
    const q0 = text.indexOf('"', pos);
    if (q0 === -1 || q0 >= segEnd) {
      const r0 = text.indexOf('\r', pos);
      if (r0 === -1 || r0 >= segEnd) {
        fields = text.slice(pos, segEnd).split(',');
        pos = eol === -1 ? len : eol + 1;
        line += 1;
      }
    }

    if (fields === undefined) {
      // Field by field. Each field is one slice between delimiters; only broken fields pay more.
      fields = [];
      let ended = COMMA;
      do {
        let value = '';
        let needScan = true; // whether the unquoted scan below still has to run for this field
        let junkCase = false; // the field closed its quote and junk follows it
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          const open = pos;
          let v = '';
          let seg = pos + 1;
          let i = seg;
          let close = -1;
          for (;;) {
            const q = text.indexOf('"', i);
            if (q === -1) break;
            if (text.charCodeAt(q + 1) === 34) {
              // A doubled quote: one quote in the value, and the field runs on.
              if (q > seg) v += text.slice(seg, q);
              v += '"';
              i = q + 2;
              seg = i;
              continue;
            }
            close = q;
            break;
          }
          if (close === -1) {
            // The quote never closes: it is a literal character, and the text after it is read
            // again as unquoted (line is still the line the quote opened on: nothing above
            // counted a line break inside the field).
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            value = '"';
          } else {
            if (close > seg) v += text.slice(seg, close);
            if (/[\r\n]/.test(v)) {
              // A line break sits inside the quotes: walk the field once, turning each CRLF or
              // lone CR into one LF and counting every line break it crosses.
              v = '';
              let s2 = open + 1;
              let j = s2;
              while (j < close) {
                const c = text.charCodeAt(j);
                if (c === 34) {
                  if (j > s2) v += text.slice(s2, j);
                  v += '"';
                  j += 2;
                  s2 = j;
                } else if (c === 13) {
                  if (j > s2) v += text.slice(s2, j);
                  v += '\n';
                  line += 1;
                  j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
                  s2 = j;
                } else if (c === 10) {
                  if (j > s2) v += text.slice(s2, j);
                  v += '\n';
                  line += 1;
                  j += 1;
                  s2 = j;
                } else {
                  j += 1;
                }
              }
              if (close > s2) v += text.slice(s2, close);
            }
            pos = close + 1;
            if (pos >= len) {
              value = v;
              ended = END;
              needScan = false;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                value = v;
                ended = COMMA;
                needScan = false;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                value = v;
                ended = LINE_BREAK;
                needScan = false;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                value = v;
                ended = LINE_BREAK;
                needScan = false;
              } else {
                // What follows the closing quote is appended as it stands, up to the next comma
                // or line break: the unquoted scan below, onto the quoted value.
                value = v;
                junkCase = true;
              }
            }
          }
        }
        if (needScan) {
          // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
          // followed by LF is dropped (stray_cr). `added` counts the characters kept, so a junk
          // field reports quote_junk only when the junk added something.
          let added = 0;
          let seg = pos;
          let i = pos;
          for (;;) {
            while (i < len) {
              const c = text.charCodeAt(i);
              if (c === 44 || c === 10 || c === 13) break;
              i += 1;
            }
            if (i >= len) {
              if (i > seg) {
                value += text.slice(seg, i);
                added += i - seg;
              }
              pos = i;
              ended = END;
              break;
            }
            const c = text.charCodeAt(i);
            if (c === 44) {
              if (i > seg) {
                value += text.slice(seg, i);
                added += i - seg;
              }
              pos = i + 1;
              ended = COMMA;
              break;
            }
            if (c === 10) {
              if (i > seg) {
                value += text.slice(seg, i);
                added += i - seg;
              }
              pos = i + 1;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            if (text.charCodeAt(i + 1) === 10) {
              if (i > seg) {
                value += text.slice(seg, i);
                added += i - seg;
              }
              pos = i + 2;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (i > seg) {
              value += text.slice(seg, i);
              added += i - seg;
            }
            i += 1;
            seg = i;
          }
          if (junkCase && added > 0) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
        fields.push(value);
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
