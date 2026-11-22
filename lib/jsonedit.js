'use strict';
// Minimal position-aware JSON editing: change one value or add one property
// without reformatting the rest of the user's file. Input must be valid JSON.

function scan(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  function str() {
    const s = i;
    i++;
    while (text[i] !== '"') {
      if (i >= text.length) throw new Error('unterminated string in JSON');
      if (text[i] === '\\') i++;
      i++;
    }
    i++;
    return { type: 'string', start: s, end: i, value: JSON.parse(text.slice(s, i)) };
  }
  function val() {
    ws();
    const s = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const props = [];
      ws();
      if (text[i] === '}') { i++; return { type: 'object', start: s, end: i, props }; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error(`expected a property name at offset ${i}`);
        const k = str();
        ws();
        i++; // :
        const v = val();
        props.push({ key: k.value, keyStart: k.start, value: v });
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; // }
        break;
      }
      return { type: 'object', start: s, end: i, props };
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (text[i] === ']') { i++; return { type: 'array', start: s, end: i, items }; }
      for (;;) {
        items.push(val());
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; // ]
        break;
      }
      return { type: 'array', start: s, end: i, items };
    }
    if (c === '"') return str();
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
    return { type: 'literal', start: s, end: i };
  }
  return val();
}

function find(node, path) {
  for (const key of path) {
    if (!node) return undefined;
    if (node.type === 'object') {
      const p = node.props.find((x) => x.key === key);
      node = p && p.value;
    } else if (node.type === 'array') {
      node = node.items[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** Leading whitespace of the line that contains offset. */
function indentAt(text, offset) {
  const ls = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls, offset))[0];
}

/**
 * Set objPath[key] to the value produced by render(indent).
 * Returns {start, end, text}: replace text[start..end) with text. Throws when objPath is not an object.
 */
function setProperty(text, objPath, key, render) {
  const root = scan(text);
  const obj = find(root, objPath);
  if (!obj || obj.type !== 'object') throw new Error(`Cannot find object at ${objPath.join('.') || '(root)'}`);
  const existing = obj.props.find((p) => p.key === key);
  if (existing) {
    return { start: existing.value.start, end: existing.value.end, text: render(indentAt(text, existing.keyStart)) };
  }
  const unit = /\n(\t| +)\S/.exec(text);
  const step = unit ? (unit[1] === '\t' ? '\t' : unit[1]) : '  ';
  if (obj.props.length === 0) {
    const base = indentAt(text, obj.start);
    const ind = base + step;
    return { start: obj.start, end: obj.end, text: `{\n${ind}${JSON.stringify(key)}: ${render(ind)}\n${base}}` };
  }
  const last = obj.props[obj.props.length - 1];
  const ind = indentAt(text, last.keyStart) || indentAt(text, obj.start) + step;
  return { start: last.value.end, end: last.value.end, text: `,\n${ind}${JSON.stringify(key)}: ${render(ind)}` };
}

/** Indent step of a JSON text (tab or the first indentation found). */
function stepOf(text) {
  const unit = /\n(\t| +)\S/.exec(text);
  return unit ? (unit[1] === '\t' ? '\t' : unit[1]) : '  ';
}

/**
 * Like setProperty, but creates the objects of objPath that do not exist yet,
 * starting below objPath[0..keep). render(indent) gives the value text.
 * Throws when a part of objPath that exists is not an object.
 */
function setPropertyDeep(text, objPath, key, render, keep = 1) {
  const root = scan(text);
  let depth = objPath.length;
  for (; depth > keep; depth--) {
    const node = find(root, objPath.slice(0, depth));
    if (!node) continue;
    if (node.type !== 'object') throw new Error(`${objPath.slice(0, depth).join('.')} is not an object; fix it in the JSON file`);
    break;
  }
  if (depth === objPath.length) return setProperty(text, objPath, key, render);
  if (depth < keep || !find(root, objPath.slice(0, depth))) throw new Error(`${objPath.slice(0, keep).join('.')} does not exist`);
  const step = stepOf(text);
  const missing = objPath.slice(depth + 1).concat([key]);
  const nested = (keys, ind) => `{\n${ind}${step}${JSON.stringify(keys[0])}: ${keys.length === 1 ? render(ind + step) : nested(keys.slice(1), ind + step)}\n${ind}}`;
  return setProperty(text, objPath.slice(0, depth), objPath[depth], (ind) => nested(missing, ind));
}

/** Remove objPath[key], with its separating comma. Returns an edit or undefined if absent. */
function removeProperty(text, objPath, key) {
  const obj = find(scan(text), objPath);
  if (!obj || obj.type !== 'object') return undefined;
  const idx = obj.props.findIndex((p) => p.key === key);
  if (idx < 0) return undefined;
  const p = obj.props[idx];
  if (idx > 0) return { start: obj.props[idx - 1].value.end, end: p.value.end, text: '' };
  if (obj.props.length > 1) return { start: p.keyStart, end: obj.props[1].keyStart, text: '' };
  return { start: obj.start, end: obj.end, text: '{}' };
}

/** Render an array of flat objects, one per line. */
function renderRows(rows, indent, step = '  ') {
  if (rows.length === 0) return '[]';
  const one = (o) => '{ ' + Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + ' }';
  return '[\n' + rows.map((r) => indent + step + one(r)).join(',\n') + '\n' + indent + ']';
}

const apply = (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end);

module.exports = { scan, find, setProperty, setPropertyDeep, removeProperty, renderRows, apply, indentAt, stepOf };
