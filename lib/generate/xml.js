'use strict';
// A small XML parser, enough for IP-XACT: elements, attributes, text, CDATA,
// comments, processing instructions, a DOCTYPE without an internal subset, the
// five predefined entities and character references. Namespaces are kept in
// the names ("ipxact:register"); localName() strips the prefix. No validation,
// no external entities (never fetched). No VS Code dependency.

const END_TAG = /<\/([^\s>]+)\s*>/y;
const START_TAG = /<([A-Za-z_:][-A-Za-z0-9_.:]*)/y;
const SPACE = /\s*/y;
const ATTR = /([A-Za-z_:][-A-Za-z0-9_.:]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

class XmlError extends Error {
  constructor(message, text, pos) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${col})`);
    this.line = line;
    this.column = col;
  }
}

function decode(s, text, pos) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(code >= 0 && code <= 0x10ffff)) throw new XmlError(`Bad character reference ${m}`, text, pos);
      return String.fromCodePoint(code);
    }
    if (!(e in ENTITIES)) throw new XmlError(`Unknown entity ${m}`, text, pos);
    return ENTITIES[e];
  });
}

/**
 * Parse XML text into its root element:
 * { name, attrs: {name: value}, children: [element | string], parent }.
 * Throws XmlError with the line and column of the first problem.
 */
function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let pos = 0;
  let root = null;
  const stack = [];
  const fail = (msg, where = pos) => { throw new XmlError(msg, text, where); };
  const at = (re) => { re.lastIndex = pos; return re.exec(text); };
  const addText = (s) => {
    if (!stack.length) { if (s.trim()) fail('Text outside the root element'); return; }
    const kids = stack[stack.length - 1].children;
    if (typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] += s;
    else kids.push(s);
  };
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) { addText(decode(text.slice(pos), text, pos)); break; }
    if (lt > pos) addText(decode(text.slice(pos, lt), text, pos));
    pos = lt;
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end < 0) fail('Unterminated comment');
      pos = end + 3;
    } else if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      if (end < 0) fail('Unterminated CDATA section');
      addText(text.slice(pos + 9, end));
      pos = end + 3;
    } else if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      if (end < 0) fail('Unterminated processing instruction');
      pos = end + 2;
    } else if (text.startsWith('<!DOCTYPE', pos)) {
      const end = text.indexOf('>', pos);
      if (end < 0) fail('Unterminated DOCTYPE');
      if (text.slice(pos, end).includes('[')) fail('DOCTYPE with an internal subset is not supported');
      pos = end + 1;
    } else if (text[pos + 1] === '/') {
      const m = at(END_TAG);
      if (!m) fail('Malformed end tag');
      const open = stack.pop();
      if (!open) fail(`End tag </${m[1]}> without a start tag`);
      if (open.name !== m[1]) fail(`End tag </${m[1]}> does not match <${open.name}>`);
      pos += m[0].length;
    } else {
      const nm = at(START_TAG);
      if (!nm) fail('Malformed start tag');
      const el = { name: nm[1], attrs: {}, children: [], parent: stack[stack.length - 1] || null };
      pos += nm[0].length;
      for (;;) {
        const ws = at(SPACE)[0];
        pos += ws.length;
        if (text.startsWith('/>', pos)) { pos += 2; el.selfClosed = true; break; }
        if (text[pos] === '>') { pos += 1; break; }
        if (pos >= text.length) fail(`Unterminated start tag <${el.name}>`);
        if (!ws) fail(`Expected whitespace before an attribute in <${el.name}>`);
        const am = at(ATTR);
        if (!am) fail(`Malformed attribute in <${el.name}>`);
        if (am[1] in el.attrs) fail(`Duplicate attribute ${am[1]} in <${el.name}>`);
        el.attrs[am[1]] = decode(am[3] !== undefined ? am[3] : am[4], text, pos);
        pos += am[0].length;
      }
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) fail('More than one root element');
      else root = el;
      if (!el.selfClosed) stack.push(el);
      delete el.selfClosed;
    }
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is not closed`, text.length);
  if (!root) fail('No root element', 0);
  return root;
}

const localName = (name) => name.slice(name.indexOf(':') + 1);

/** Child elements, optionally only those with this local name. */
function kids(el, local) {
  if (!el) return [];
  return el.children.filter((c) => typeof c !== 'string' && (local === undefined || localName(c.name) === local));
}

/** First child element with this local name, or undefined. */
const kid = (el, local) => kids(el, local)[0];

/** Text content of an element (all descendants), trimmed. */
function textOf(el) {
  if (!el) return undefined;
  let s = '';
  const walk = (e) => { for (const c of e.children) { if (typeof c === 'string') s += c; else walk(c); } };
  walk(el);
  return s.trim();
}

/** Text of the first child with this local name, or undefined. */
const childText = (el, local) => textOf(kid(el, local));

/** Attribute value by local name (ignores the prefix), or undefined. */
function attr(el, local) {
  if (!el) return undefined;
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return undefined;
}

module.exports = { parse, localName, kids, kid, textOf, childText, attr, XmlError };
