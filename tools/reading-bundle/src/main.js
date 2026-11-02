// LexiNote reading-view kernel: Markdown -> Obsidian-compatible preview DOM + post-processor chain.
// Bundled by build.mjs into rawfile/lexinote_reading.js. Not wired into any page yet.
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false
});
md.use(taskLists, { enabled: false, label: false });
md.use(footnote);

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/;

let current = null;
const postProcessors = [];

function createEl(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

// Obsidian mounts its DOM helpers on Element.prototype, and a plugin calls them on any
// element it can reach. Per-node patching can never cover what markdown-it built with
// innerHTML, so the helpers live on the prototype exactly like Obsidian's do.
const DOM_HELPER_FLAG = '__lexiDomHelpers';

// createEl options, Obsidian's shape: cls / text / attr / href / type / value / title / placeholder.
function applyCreateOptions(node, options) {
  if (typeof options === 'string') { node.className = options; return; }
  const opts = options || {};
  if (opts.cls) node.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : String(opts.cls);
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.type) node.setAttribute('type', String(opts.type));
  if (opts.href) node.setAttribute('href', String(opts.href));
  if (opts.title) node.setAttribute('title', String(opts.title));
  if (opts.placeholder) node.setAttribute('placeholder', String(opts.placeholder));
  if (opts.value != null) node.setAttribute('value', String(opts.value));
  if (opts.attr) {
    for (const key of Object.keys(opts.attr)) node.setAttribute(key, String(opts.attr[key]));
  }
}

const DOM_HELPERS = {
  find: function (selector) { return this.querySelector(selector); },
  // Obsidian semantics: an array of descendants, never the element itself.
  findAll: function (selector) { return Array.prototype.slice.call(this.querySelectorAll(selector)); },
  createEl: function (tag, options) {
    const child = document.createElement(tag);
    applyCreateOptions(child, options);
    this.appendChild(child);
    return child;
  },
  createDiv: function (options) { return this.createEl('div', options); },
  createSpan: function (options) { return this.createEl('span', options); },
  empty: function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  },
  addClass: function () {
    for (let i = 0; i < arguments.length; i++) if (arguments[i]) this.classList.add(arguments[i]);
    return this;
  },
  removeClass: function () {
    for (let i = 0; i < arguments.length; i++) if (arguments[i]) this.classList.remove(arguments[i]);
    return this;
  },
  hasClass: function (name) { return this.classList.contains(name); },
  setAttr: function (name, value) { this.setAttribute(name, String(value)); return this; },
  getAttr: function (name) { return this.getAttribute(name); },
  appendText: function (text) { this.appendChild(document.createTextNode(String(text))); return this; }
};

// Idempotent, and it never shadows an existing implementation: the plugin-view page
// installs its own copy of these names, so a second install must not fork the semantics.
function installDomHelpers() {
  if (typeof Element === 'undefined' || !Element.prototype) return null;
  const proto = Element.prototype;
  if (proto[DOM_HELPER_FLAG]) return proto;
  for (const name of Object.keys(DOM_HELPERS)) {
    if (typeof proto[name] === 'function') continue;
    Object.defineProperty(proto, name, { value: DOM_HELPERS[name], writable: true, configurable: true, enumerable: false });
  }
  Object.defineProperty(proto, DOM_HELPER_FLAG, { value: true, enumerable: false, configurable: true });
  return proto;
}

installDomHelpers();

function parseScalar(raw) {
  let value = String(raw).trim();
  if (!value) return '';
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(function (part) { return parseScalar(part); });
  }
  value = value.replace(/\s+#.*$/, '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function parseYamlBlock(text) {
  const result = {};
  let listKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const keyMatch = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/.exec(rawLine);
    if (keyMatch) {
      const key = keyMatch[1];
      const value = keyMatch[2].trim();
      if (value === '') {
        listKey = key;
        result[key] = [];
      } else {
        listKey = null;
        result[key] = parseScalar(value);
      }
      continue;
    }
    const itemMatch = /^[ \t]*-[ \t]+(.*)$/.exec(rawLine);
    if (itemMatch && listKey) result[listKey].push(parseScalar(itemMatch[1]));
  }
  return result;
}

function extractFrontmatter(source) {
  const text = String(source == null ? '' : source);
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { frontmatter: null, markdown: text };
  const blanked = match[0].replace(/[^\r\n]/g, '');
  return {
    frontmatter: parseYamlBlock(match[1]),
    markdown: blanked + text.slice(match[0].length)
  };
}

function headingText(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'inline' && i > 0 && tokens[i - 1].type === 'heading_open') {
      return tokens[i].content;
    }
  }
  return '';
}

function parseDocument(source) {
  const env = {};
  const tokens = md.parse(source, env);
  const sections = [];
  let section = null;
  for (const token of tokens) {
    if (token.type === 'heading_open') {
      section = { level: Number(token.tag.slice(1)), tokens: [], heading: '', lineStart: null, lineEnd: null, env: env };
      sections.push(section);
    } else if (!section) {
      section = { level: 0, tokens: [], heading: '', lineStart: null, lineEnd: null, env: env };
      sections.push(section);
    }
    section.tokens.push(token);
    if (token.map) {
      if (section.lineStart === null) section.lineStart = token.map[0];
      section.lineEnd = token.map[1];
    }
  }
  for (const entry of sections) entry.heading = headingText(entry.tokens);
  return { tokens: tokens, sections: sections, env: env };
}

function paintSection(section) {
  // 重绘会把 section 的 DOM 整个换掉:先让旧 children unload,否则每改一行泄漏一批组件。
  releaseChildren(contexts.get(section.el));
  section.renderCount += 1;
  section.el.setAttribute('data-heading-level', String(section.level));
  section.el.setAttribute('data-line-start', String(section.lineStart === null ? 0 : section.lineStart));
  section.el.setAttribute('data-line-end', String(section.lineEnd === null ? 0 : section.lineEnd));
  section.el.setAttribute('data-render-count', String(section.renderCount));
  section.el.innerHTML = md.renderer.render(section.tokens, md.options, section.env || {});
}

function sectionInfo(section) {
  if (!section) return null;
  return {
    lineStart: section.lineStart === null ? 0 : section.lineStart,
    lineEnd: section.lineEnd === null ? 0 : section.lineEnd,
    text: section.source,
    el: section.el
  };
}

// 按元素解析 section 归属(Obsidian 语义). 容器(.markdown-preview-view / .markdown-rendered /
// .markdown-preview-sizer)对 getSectionInfo 返回 null,绝不兜底成第一个 section; 归属只认 DOM
// 结构,容器上不挂任何标记。
const SECTION_CLASS = 'markdown-preview-section';

function isSectionElement(node) {
  return !!(node && node.nodeType === 1 && node.classList && node.classList.contains(SECTION_CLASS));
}

function sectionFor(node) {
  if (!node || node.nodeType !== 1 || typeof node.closest !== 'function') return null;
  const el = node.closest('.' + SECTION_CLASS);
  return el && el.__lexiSection ? el.__lexiSection : null;
}

function publicSection(section) {
  return {
    index: section.index,
    el: section.el,
    get heading() { return section.heading; },
    get level() { return section.level; },
    get lineStart() { return section.lineStart; },
    get lineEnd() { return section.lineEnd; },
    get renderCount() { return section.renderCount; },
    get source() { return section.source; },
    getSectionInfo: function () { return sectionInfo(section); }
  };
}

// ---------------------------------------------------------------- markdown child host
// A post-processor ctx is a Component in Obsidian: plugins write
//   const child = new MarkdownRenderChild(el); ctx.addChild(child);
// and the host owes them load() now plus unload() exactly once when the section it
// belongs to is repainted. Everything below is duck-typed on purpose: a third-party
// child only has to expose load/unload/containerEl, it is never checked against a class.
const contexts = new WeakMap();
const componentErrors = [];
const PLUGIN_FRAME_RE = /lexinote-plugin-([A-Za-z0-9_.-]+)\.js/;

function childLabel(child) {
  const ctor = child && child.constructor;
  const name = ctor && typeof ctor.name === 'string' ? ctor.name : '';
  return name || Object.prototype.toString.call(child);
}

function recordComponentError(pluginId, phase, child, error) {
  const entry = {
    pluginId: pluginId || 'unknown',
    phase: phase,
    child: typeof child === 'string' ? child : childLabel(child),
    message: error && error.message !== undefined ? String(error.message) : String(error)
  };
  componentErrors.push(entry);
  if (componentErrors.length > 50) componentErrors.shift();
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[LexiReading] ' + phase + ' failed: plugin=' + entry.pluginId + ' child=' + entry.child + ': ' + entry.message);
  }
  return entry;
}

// 插件注册链上没有 pluginId 可用(bridge 只转交 handler),就从调用栈里的
// lexinote-plugin-<id>.js 帧认领——插件加载器给每个插件包打了这个 sourceURL。
function resolvePluginId(host) {
  if (host.pluginId) return host.pluginId;
  if (host.pluginIdProbed) return '';
  host.pluginIdProbed = true;
  try {
    const m = PLUGIN_FRAME_RE.exec(String(new Error().stack || ''));
    if (m) host.pluginId = m[1];
  } catch (error) { /* 栈不可用:保持空,日志里落 unknown */ }
  return host.pluginId;
}

function attachContainer(host, child) {
  const container = child && child.containerEl;
  if (!container || container.nodeType !== 1 || container.parentNode) return;
  if (host.el && typeof host.el.appendChild === 'function') host.el.appendChild(container);
}

function detachContainer(child) {
  const container = child && child.containerEl;
  if (container && container.parentNode) container.parentNode.removeChild(container);
}

// unload 一次性:同一 host 上同一个 child 重复释放是幂等空操作。
function unloadChild(host, child) {
  if (host.unloaded.has(child)) return;
  host.unloaded.add(child);
  if (typeof child.unload !== 'function') return;
  try { child.unload(); } catch (error) { recordComponentError(host.pluginId, 'child.unload', child, error); }
}

function addChild(host, child) {
  if (!child) return child;
  if (host.children.indexOf(child) >= 0) return child;
  const pluginId = resolvePluginId(host);
  host.children.push(child);
  if (typeof child.load === 'function') {
    try { child.load(); } catch (error) { recordComponentError(pluginId, 'child.load', child, error); }
  }
  attachContainer(host, child);
  return child;
}

function removeChild(host, child) {
  const index = host.children.indexOf(child);
  if (index < 0) return child;
  host.children.splice(index, 1);
  detachContainer(child);
  unloadChild(host, child);
  return child;
}

function releaseChildren(host) {
  if (!host || host.children.length === 0) return;
  const list = host.children.slice();
  host.children.length = 0;
  for (const child of list) {
    detachContainer(child);
    unloadChild(host, child);
  }
}

function createContext(target, base, owner) {
  const host = {
    el: target,
    children: [],
    unloaded: new Set(),
    pluginId: typeof base.pluginId === 'string' ? base.pluginId : '',
    pluginIdProbed: false
  };
  host.addChild = function (child) { return addChild(host, child); };
  host.removeChild = function (child) { return removeChild(host, child); };
  // 省略参数 -> 当前 section; 传元素 -> 按 DOM 解析该元素所属 section (容器 -> null)。
  host.getSectionInfo = function (el) {
    return sectionInfo(el === undefined || el === null ? owner : sectionFor(el));
  };
  return host;
}

// ctx 身份按 section 稳定:同一 section 的多次后处理拿到同一个对象,addChild 累加到同一列表。
function contextFor(target, ctx) {
  const base = ctx || {};
  const owner = sectionFor(target);
  // 键就是被后处理的节点本身:paintSection 重绘前用同一个节点取回宿主,才能先 unload 旧 children。
  const key = target && typeof target === 'object' ? target : (owner || current);
  let context = key ? contexts.get(key) : null;
  if (!context) {
    context = createContext(target, base, owner);
    if (key) contexts.set(key, context);
  }
  context.el = target;
  context.sourcePath = base.sourcePath !== undefined ? base.sourcePath : (current ? current.sourcePath : '');
  context.frontmatter = base.frontmatter !== undefined ? base.frontmatter : (current ? current.frontmatter : null);
  if (typeof base.pluginId === 'string' && base.pluginId) context.pluginId = base.pluginId;
  return context;
}

function render(markdown, options) {
  const opts = options || {};
  const parsed = extractFrontmatter(markdown);
  const source = parsed.markdown;
  const doc = parseDocument(source);
  const lines = source.split(/\r?\n/);

  const containerEl = createEl('div', 'markdown-preview-view');
  const sizerEl = createEl('div', 'markdown-preview-sizer');
  const renderedEl = createEl('div', 'markdown-rendered');
  containerEl.appendChild(sizerEl);
  sizerEl.appendChild(renderedEl);

  const frontmatter = opts.frontmatter !== undefined ? opts.frontmatter : parsed.frontmatter;
  const sections = doc.sections.map(function (raw, index) {
    const lineStart = raw.lineStart === null ? 0 : raw.lineStart;
    const lineEnd = raw.lineEnd === null ? lineStart : raw.lineEnd;
    const section = {
      index: index,
      level: raw.level,
      heading: raw.heading,
      tokens: raw.tokens,
      env: raw.env,
      lineStart: lineStart,
      lineEnd: lineEnd,
      source: lines.slice(lineStart, lineEnd).join('\n'),
      renderCount: 0,
      el: createEl('div', 'markdown-preview-section')
    };
    section.el.__lexiSection = section;
    renderedEl.appendChild(section.el);
    paintSection(section);
    return section;
  });

  if (current) {
    for (const previousSection of current.sections) releaseChildren(contexts.get(previousSection.el));
    releaseChildren(contexts.get(current.containerEl));
  }

  current = {
    containerEl: containerEl,
    renderedEl: renderedEl,
    sections: sections,
    sourcePath: opts.sourcePath || '',
    frontmatter: frontmatter,
    source: source,
    env: doc.env
  };

  return {
    html: containerEl.outerHTML,
    sections: sections.map(publicSection),
    containerEl: containerEl,
    frontmatter: frontmatter
  };
}

// 后处理器按 section 逐个调用: 传容器时对其中每个 section 各一次(容器本身不再被当作 el),
// 传 section 或普通元素时只对该元素一次。同一次调用里一个 section 只会出现一次。
function postProcessorTargets(target) {
  if (!target || target.nodeType !== 1) return [];
  if (isSectionElement(target)) return [target];
  if (typeof target.querySelectorAll !== 'function') return [target];
  const found = Array.prototype.slice.call(target.querySelectorAll('.' + SECTION_CLASS));
  return found.length > 0 ? found : [target];
}

function pluginIdFromError(error) {
  const m = PLUGIN_FRAME_RE.exec(String((error && error.stack) || ''));
  return m ? m[1] : '';
}

function handlerLabel(entry) {
  return typeof entry.handler.name === 'string' && entry.handler.name ? entry.handler.name : 'anonymous';
}

async function applyPostProcessors(target, ctx) {
  const errors = [];
  for (const el of postProcessorTargets(target)) {
    const context = contextFor(el, ctx);
    for (const entry of postProcessors.slice()) {
      try {
        await entry.handler(el, context);
      } catch (error) {
        errors.push(error);
        recordComponentError(pluginIdFromError(error) || context.pluginId, 'post-processor', handlerLabel(entry), error);
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[LexiReading] post-processor failed: ' + (error && error.message ? error.message : error));
        }
      }
    }
  }
  return { errors: errors };
}

function registerPostProcessor(handler, sortOrder) {
  if (typeof handler !== 'function') throw new TypeError('registerPostProcessor expects a function');
  const entry = {
    handler: handler,
    sortOrder: typeof sortOrder === 'number' && isFinite(sortOrder) ? sortOrder : 0,
    order: postProcessors.length
  };
  postProcessors.push(entry);
  postProcessors.sort(function (a, b) { return a.sortOrder - b.sortOrder || a.order - b.order; });
  return function deregister() {
    const index = postProcessors.indexOf(entry);
    if (index >= 0) postProcessors.splice(index, 1);
  };
}

async function rerenderSection(index, nextSource) {
  if (!current) throw new Error('LexiReading.rerenderSection: no active render');
  const section = current.sections[index];
  if (!section) throw new Error('LexiReading.rerenderSection: unknown section index ' + index);
  if (typeof nextSource === 'string') {
    const parsed = extractFrontmatter(nextSource);
    const doc = parseDocument(parsed.markdown);
    if (doc.sections.length !== 1) {
      throw new Error('LexiReading.rerenderSection: expected exactly one section, got ' + doc.sections.length);
    }
    const next = doc.sections[0];
    section.level = next.level;
    section.heading = next.heading;
    section.tokens = next.tokens;
    section.env = doc.env;
    section.lineStart = next.lineStart === null ? 0 : next.lineStart;
    section.lineEnd = next.lineEnd === null ? section.lineStart : next.lineEnd;
    section.source = parsed.markdown.split(/\r?\n/).slice(section.lineStart, section.lineEnd).join('\n');
  }
  paintSection(section);
  await applyPostProcessors(section.el, {
    sourcePath: current.sourcePath,
    frontmatter: current.frontmatter
  });
  return publicSection(section);
}

const LexiReading = {
  version: '0.1.0',
  render: render,
  applyPostProcessors: applyPostProcessors,
  rerenderSection: rerenderSection,
  registerPostProcessor: registerPostProcessor,
  getComponentErrors: function () { return componentErrors.slice(); }
};

if (typeof window !== 'undefined') window.LexiReading = LexiReading;
