/**
 * A minimal DOM implementation for R8B static-UI tests.
 *
 * The UI modules take their `document` by injection, so tests can exercise the real component
 * code without a browser and without adding a dependency — the contract forbids new runtime
 * dependencies, and a headless-browser stack would be a large one.
 *
 * This is deliberately NOT a general DOM. It implements exactly what the components use:
 * element/text creation, attributes, class and dataset, children, a small query engine, and
 * a work-alike event dispatch. Anything a test needs beyond that should be added here rather
 * than worked around, so the fake stays honest about what the components actually touch.
 */

class FakeNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
      if (child.parentNode !== null) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  prepend(...nodes) {
    const list = nodes
      .filter((n) => n !== null && n !== undefined)
      .map((n) => (typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
    for (const child of list) {
      if (child.parentNode !== null) child.parentNode.removeChild(child);
      child.parentNode = this;
    }
    this.childNodes.unshift(...list);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  /**
   * Whether `other` is this node or a descendant of it.
   *
   * Needed because attachment matters: a detached `<input type="file">` cannot be activated by a
   * WebView's file-chooser path, so a test has to be able to prove the input is really in the tree
   * rather than merely constructed.
   *
   * @param {FakeNode|null} other - the candidate descendant.
   * @returns {boolean} true when `other` is contained here.
   */
  contains(other) {
    for (let node = other; node !== null && node !== undefined; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      this.append(this.ownerDocument.createTextNode(String(value)));
    }
  }

  /** Depth-first walk including self. */
  *walk() {
    yield this;
    for (const child of this.childNodes) {
      if (child.nodeType === 1) yield* child.walk();
    }
  }

  querySelectorAll(selector) {
    return [...this.walk()].filter((el) => el !== this && el.nodeType === 1 && matches(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Serialize without ever producing executable markup, for safety assertions. */
  get outerHTML() {
    return serialize(this);
  }
}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.value = '';
    this.disabled = false;
    // `id`, `className`, `type`, `rows` and `dataset` are accessors defined below so that
    // writing the property and writing the attribute stay the same fact. A plain own property
    // here would shadow the accessor and make `getAttribute` disagree with the property,
    // silently breaking both selectors and the attribute-scanning safety tests.
    this.dataset = makeDataset(this);
    this.classList = makeClassList(this);
  }

  get id() {
    return this.attributes.get('id') ?? '';
  }

  set id(value) {
    this.attributes.set('id', String(value));
  }

  get className() {
    return this.attributes.get('class') ?? '';
  }

  set className(value) {
    this.attributes.set('class', String(value));
  }

  get type() {
    return this.attributes.get('type') ?? '';
  }

  set type(value) {
    this.attributes.set('type', String(value));
  }

  get rows() {
    return Number(this.attributes.get('rows') ?? 0);
  }

  set rows(value) {
    this.attributes.set('rows', String(value));
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** Dispatch a work-alike event; returns the event object. */
  dispatch(type, event = {}) {
    const payload = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...event,
    };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
    return payload;
  }

  click() {
    return this.dispatch('click');
  }

  /** Focus tracking is enough for focus-return assertions. */
  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

/**
 * A `dataset` proxy that reads and writes the underlying `data-*` attributes.
 *
 * @param {FakeElement} element - the owning element.
 * @returns {object} the dataset proxy.
 */
function makeDataset(element) {
  const toAttribute = (key) => `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const value = element.attributes.get(toAttribute(key));
      return value === undefined ? undefined : value;
    },
    set(_target, key, value) {
      if (typeof key !== 'string') return false;
      element.attributes.set(toAttribute(key), String(value));
      return true;
    },
    has(_target, key) {
      return typeof key === 'string' && element.attributes.has(toAttribute(key));
    },
    ownKeys() {
      return [...element.attributes.keys()]
        .filter((k) => k.startsWith('data-'))
        .map((k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string' || !element.attributes.has(toAttribute(key))) return undefined;
      return { value: element.attributes.get(toAttribute(key)), enumerable: true, configurable: true, writable: true };
    },
  });
}

function makeClassList(element) {
  const read = () => String(element.className).split(/\s+/).filter((s) => s.length > 0);
  const write = (list) => { element.className = list.join(' '); };
  return {
    add: (...names) => write([...new Set([...read(), ...names])]),
    remove: (...names) => write(read().filter((n) => !names.includes(n))),
    contains: (name) => read().includes(name),
    toggle: (name) => (read().includes(name) ? (write(read().filter((n) => n !== name)), false) : (write([...read(), name]), true)),
  };
}

/**
 * Match a subset of CSS selectors: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, and
 * descendant combinations of those.
 *
 * @param {FakeElement} element - the element.
 * @param {string} selector - the selector.
 * @returns {boolean} true when it matches.
 */
function matches(element, selector) {
  return String(selector).trim().split(/\s+/).every((part) => matchesSimple(element, part));
}

function matchesSimple(element, part) {
  if (part.length === 0) return true;
  const attrMatch = /\[([^\]=]+)(?:="([^"]*)")?\]/.exec(part);
  const idMatch = /#([\w-]+)/.exec(part);
  const classMatches = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const tag = part.replace(/\[[^\]]*\]|#[\w-]+|\.[\w-]+/g, '').trim();

  if (tag.length > 0 && tag !== '*' && element.tagName !== tag.toUpperCase()) return false;
  if (idMatch !== null && element.getAttribute('id') !== idMatch[1]) return false;
  for (const cls of classMatches) if (!element.classList.contains(cls)) return false;
  if (attrMatch !== null) {
    const value = element.getAttribute(attrMatch[1]);
    if (value === null) return false;
    if (attrMatch[2] !== undefined && value !== attrMatch[2]) return false;
  }
  return true;
}

/** Serialize a subtree to markup text — used only to assert what is NOT present. */
function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  const attrs = [...node.attributes.entries()].map(([k, v]) => ` ${k}="${escapeText(v)}"`).join('');
  const inner = node.childNodes.map(serialize).join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${inner}</${node.tagName.toLowerCase()}>`;
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Create a fake document.
 *
 * @returns {object} a document with `createElement`, `createTextNode`, `getElementById` and
 *   `body`.
 */
export function createTestDocument() {
  const doc = {
    nodeType: 9,
    activeElement: null,
    listeners: new Map(),
    createElement(tagName) {
      return new FakeElement(doc, tagName);
    },
    createTextNode(data) {
      return new FakeText(doc, data);
    },
    getElementById(id) {
      return doc.body.querySelector(`#${id}`);
    },
    addEventListener(type, handler) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = doc.listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type) {
      for (const handler of doc.listeners.get(type) ?? []) handler({ type });
    },
  };
  doc.body = doc.createElement('body');
  doc.documentElement = doc.createElement('html');
  doc.documentElement.append(doc.body);
  return doc;
}

/**
 * Install a fake window-ish global for modules that read `location` or timers.
 *
 * @param {object} [options] - `hash`, `timers`.
 * @returns {object} the fake window, with a `restore`.
 */
export function createTestWindow(options = {}) {
  const saved = {
    location: globalThis.location,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const listeners = new Map();
  const window = {
    location: { hash: options.hash ?? '' },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) ?? []) handler({ type });
    },
    setTimeout: options.timers === false ? () => 0 : (fn) => globalThis.setTimeout(fn, 0),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    restore() {
      globalThis.location = saved.location;
      globalThis.addEventListener = saved.addEventListener;
      globalThis.removeEventListener = saved.removeEventListener;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
    },
  };
  globalThis.location = window.location;
  globalThis.addEventListener = window.addEventListener;
  globalThis.removeEventListener = window.removeEventListener;
  if (options.timers !== false) {
    globalThis.setTimeout = window.setTimeout;
    globalThis.clearTimeout = window.clearTimeout;
  }
  return window;
}
