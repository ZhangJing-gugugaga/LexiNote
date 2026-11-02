'use strict';
// Markdown 渲染探针:只走产品面 API(MarkdownRenderer + 页面上的渲染内核),
// 结果两路输出 —— 门禁读 window.__mdRenderProbe,真机读 Notice(hilog tag LexiPlugin)。
const { Plugin, MarkdownRenderer, Notice } = require('obsidian');

const SOURCE_PATH = 'Notes/md-render-probe.md';
const MARKDOWN = [
  '## 渲染探针',
  '',
  '**粗体**与 `行内代码`',
  '',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |'
].join('\n');

function count(root, selector) {
  return root && typeof root.querySelectorAll === 'function' ? root.querySelectorAll(selector).length : 0;
}

function snapshot(root) {
  const taskItem = root.querySelector ? root.querySelector('li.task-list-item') : null;
  return {
    strong: count(root, 'strong'),
    preCode: count(root, 'pre > code'),
    taskItems: count(root, 'li.task-list-item'),
    checkboxes: count(root, 'input[type="checkbox"]'),
    tables: count(root, 'table'),
    taskListHtml: taskItem ? taskItem.outerHTML : ''
  };
}

module.exports = class MdRenderProbe extends Plugin {
  async onload() {
    const report = {
      errors: [],
      postProcessorRuns: 0,
      childLoads: 0,
      childUnloads: 0,
      sectionInfoInner: null,
      sectionInfoNonSection: null,
      render: null,
      renderMarkdown: null
    };
    window.__mdRenderProbe = report;

    const kernel = window.LexiReading;
    if (kernel && typeof kernel.registerPostProcessor === 'function') {
      kernel.registerPostProcessor(function (el, ctx) {
        report.postProcessorRuns += 1;
        const child = {
          containerEl: document.createElement('div'),
          load: function () { report.childLoads += 1; },
          unload: function () { report.childUnloads += 1; }
        };
        ctx.addChild(child);
        if (report.sectionInfoInner === null) {
          const inner = el.querySelector('strong') || el;
          report.sectionInfoInner = ctx.getSectionInfo(inner);
          // 渲染容器本身不是 section: 必须解析成 null,而不是"最近的那个 section"。
          report.sectionInfoNonSection = ctx.getSectionInfo(el.parentNode);
        }
      }, 0);
    }

    const hostEl = document.createElement('div');
    document.body.appendChild(hostEl);
    let pending = null;
    try {
      pending = MarkdownRenderer.render(this.app, MARKDOWN, hostEl, SOURCE_PATH, this);
      const isPromiseLike = !!pending && typeof pending.then === 'function';
      const resolved = await pending;
      report.render = { resolvedValue: typeof resolved, isPromiseLike: isPromiseLike, html: snapshot(hostEl) };
    } catch (error) {
      report.render = { isPromiseLike: !!pending && typeof pending.then === 'function', rejected: true };
      report.errors.push('render: ' + (error && error.message));
    }

    // 第二次渲染会换掉上一份容器:上一轮 addChild 的 child 必在这里被 unload。
    const secondEl = document.createElement('div');
    document.body.appendChild(secondEl);
    try {
      const html = await MarkdownRenderer.renderMarkdown(MARKDOWN, secondEl, SOURCE_PATH, this);
      report.renderMarkdown = {
        type: typeof html,
        length: typeof html === 'string' ? html.length : 0,
        hasStrong: typeof html === 'string' && html.indexOf('<strong>') >= 0,
        hasTaskItem: typeof html === 'string' && html.indexOf('task-list-item') >= 0
      };
      report.secondRender = snapshot(secondEl);
    } catch (error) {
      report.errors.push('renderMarkdown: ' + (error && error.message));
    }

    const first = report.render ? report.render.html : snapshot(hostEl);
    report.summary = {
      strong: first.strong,
      preCode: first.preCode,
      taskItems: first.taskItems,
      checkboxes: first.checkboxes,
      tables: first.tables,
      postProcessorRuns: report.postProcessorRuns,
      childLoads: report.childLoads,
      childUnloads: report.childUnloads
    };
    new Notice('MD_RENDER_PROBE ' + JSON.stringify(report.summary) + ' task=' + first.taskListHtml);
  }
};
