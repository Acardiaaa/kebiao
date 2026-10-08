const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

// Local midnight is still the previous UTC date in Shanghai. Keep that real
// timezone behavior while freezing "today" to make regressions reproducible.
process.env.TZ = 'Asia/Shanghai';
const repo = path.resolve(__dirname, '..');
const html = process.env.SCHEDULE_BASELINE
  ? execFileSync('git', ['show', `${process.env.SCHEDULE_BASELINE}:index.html`], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/i)[1];

class Element {
  constructor(attributes = {}) {
    this.attributes = attributes;
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name); else classes.delete(name);
      }
    };
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(listener);
  }
  click() {
    for (const listener of this.listeners.get('click') || []) listener({ target: this });
  }
  querySelectorAll(selector) {
    if (selector !== '.mcell[data-d]') throw new Error(`Unexpected selector: ${selector}`);
    this.cells = [...this.innerHTML.matchAll(/<div class="mcell ([^"]*)" data-d="([^"]+)">([\s\S]*?)(?=<div class="mcell |$)/g)]
      .map(match => {
        const cell = new Element({ 'data-d': match[2] });
        cell.innerHTML = match[3];
        cell.classes = match[1];
        return cell;
      });
    return this.cells;
  }
}

function load({ now = '2026-10-08T12:00:00+08:00', sem } = {}) {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const tabs = ['today', 'week', 'month'].map(view => {
    const tab = new Element();
    tab.dataset.v = view;
    return tab;
  });
  const stored = new Map(sem === undefined ? [] : [['kb_semstart', sem]]);
  const writes = [];
  const timestamp = new Date(now).getTime();
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  }
  const context = vm.createContext({
    Date: FrozenDate,
    document: {
      querySelector(selector) {
        if (!selector.startsWith('#')) throw new Error(`Unexpected selector: ${selector}`);
        return node(selector.slice(1));
      },
      querySelectorAll(selector) {
        if (selector !== '.tab') throw new Error(`Unexpected selector: ${selector}`);
        return tabs;
      }
    },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem(key, value) { stored.set(key, String(value)); writes.push(['set', key, String(value)]); },
      removeItem(key) { stored.delete(key); writes.push(['remove', key]); }
    }
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  return {
    node, stored, writes,
    run: code => vm.runInContext(code, context),
    tab: view => tabs.find(tab => tab.dataset.v === view).click(),
    content: () => node('content').innerHTML,
    cell(date) {
      const cell = (node('content').cells || []).find(cell => {
        const d = new Date(cell.getAttribute('data-d'));
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === date;
      });
      assert.ok(cell, `Calendar must include ${date}`);
      return cell;
    }
  };
}

function occurrences(value, text) { return value.split(text).length - 1; }

test('week expressions include each comma-separated interval and exclude gaps', () => {
  const app = load({ sem: '2026-09-07' });
  const cases = [
    [['2-3,5-14'], [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]],
    [['2-4,6-14'], [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14]],
    [['2-3,5-16'], [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
    [['11'], [11]],
    [['1-18'], Array.from({ length: 18 }, (_, i) => i + 1)]
  ];
  for (const [specs, included] of cases) {
    for (let week = 0; week <= 19; week++) {
      assert.equal(app.run(`matchWeek(${JSON.stringify(specs)}, ${week})`), included.includes(week), `${specs}, week ${week}`);
    }
  }
});

test('today shows both split sessions in active weeks and hides them in week gaps', () => {
  const cases = [
    ['2026-09-14', '免疫药理学', 2],
    ['2026-09-28', '免疫药理学', 0],
    ['2026-10-05', '免疫药理学', 2],
    ['2026-09-16', '人工智能药物设计', 2],
    ['2026-10-07', '人工智能药物设计', 0],
    ['2026-10-14', '人工智能药物设计', 2],
    ['2026-10-01', '药物靶向传释系统', 0],
    ['2026-10-08', '药物靶向传释系统', 1]
  ];
  for (const [date, name, count] of cases) {
    const app = load({ now: `${date}T12:00:00+08:00`, sem: '2026-09-07' });
    assert.equal(occurrences(app.content(), name), count, `${date}: ${name}`);
  }
});

test('month uses each date\'s teaching week and clicking it opens that same local day', () => {
  const app = load({ sem: '2026-09-07' });
  app.tab('month');
  assert.match(app.cell('2026-10-05').innerHTML, /免疫药理/);
  assert.doesNotMatch(app.cell('2026-10-07').innerHTML, /AI药物设计/);
  assert.match(app.cell('2026-10-14').innerHTML, /AI药物设计/);
  assert.doesNotMatch(app.cell('2026-10-01').innerHTML, /靶向传释/);
  assert.match(app.cell('2026-10-08').innerHTML, /靶向传释/);
  app.cell('2026-10-05').click();
  assert.equal(app.node('navTitle').textContent, '10月5日 周一');
  assert.equal(occurrences(app.content(), '免疫药理学'), 2);
});

test('first visit leaves semester unset and explains the course overview in every view', () => {
  const app = load();
  assert.equal(app.run('new Date().getTimezoneOffset()'), -480);
  assert.equal(app.stored.has('kb_semstart'), false);
  assert.deepEqual(app.writes, []);
  assert.equal(app.node('hWk').textContent, '请设置学期起点');
  assert.match(app.content(), /课程总览/);
  for (const name of ['学术英语（医学）', '药物靶向传释系统', '药剂学交叉学科前沿问题追踪']) assert.ok(app.content().includes(name), name);
  app.tab('week');
  assert.match(app.content(), /课程总览/);
  app.tab('month');
  assert.match(app.content(), /课程总览/);
  assert.match(app.cell('2026-10-05').innerHTML, /免疫药理/);
});

test('opening and saving settings repeatedly preserves the local Monday date', () => {
  const app = load({ sem: '2026-09-07' });
  assert.deepEqual(app.writes, []);
  for (let i = 0; i < 5; i++) {
    app.node('gear').click();
    assert.equal(app.node('semStart').value, '2026-09-07');
    app.node('saveSem').click();
    assert.equal(app.stored.get('kb_semstart'), '2026-09-07');
    assert.equal(app.run('weekOf(new Date("2026-10-08T00:00:00"))'), 5);
  }
});

test('invalid previously saved dates are preserved for correction and do not hide courses', () => {
  for (const date of ['2026-09-06', '2026-02-30']) {
    const app = load({ sem: date });
    assert.equal(app.stored.get('kb_semstart'), date);
    assert.deepEqual(app.writes, []);
    assert.equal(app.run('getSem()'), null);
    assert.match(app.content(), /课程总览/);
    assert.match(app.content(), /药物靶向传释系统/);
  }
  const app = load({ sem: '2026-09-06' });
  app.node('gear').click();
  assert.equal(app.node('semStart').value, '2026-09-06');
  assert.match(app.node('semHint').textContent, /不是星期一/);
});

test('saving a non-Monday keeps settings open and preserves the existing valid date', () => {
  const app = load({ sem: '2026-09-07' });
  app.node('gear').click();
  app.node('semStart').value = '2026-09-08';
  app.node('saveSem').click();
  assert.equal(app.stored.get('kb_semstart'), '2026-09-07');
  assert.equal(app.node('sheet').classList.contains('on'), true);
  assert.match(app.node('semHint').textContent, /星期一/);
  app.node('semStart').value = '';
  app.node('saveSem').click();
  assert.equal(app.stored.has('kb_semstart'), false);
  assert.match(app.content(), /课程总览/);
});

test('AI drug design is offline while instrument analysis retains its scheduled online weeks', () => {
  const app = load({ sem: '2026-09-07' });
  const onlineWeeks = [6, 8, 10, 12, 14, 16, 18];
  for (let week = 1; week <= 18; week++) {
    assert.equal(app.run(`roomFor(COURSES.find(c => c.code === 'PHAR50002.01'), ${week})`), onlineWeeks.includes(week) ? '线上' : 'Z2202', `instrument analysis, week ${week}`);
  }
  for (const week of [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    assert.equal(app.run(`roomFor(COURSES.find(c => c.code === 'AIS310020.01'), ${week})`), 'Z2203', `AI drug design, week ${week}`);
  }
});

test('grouped animal laboratory classes show both rooms in the weekly table', () => {
  const app = load({ now: '2026-11-16T12:00:00+08:00', sem: '2026-09-07' });
  app.tab('week');
  assert.match(app.content(), /F2106 \/ F2304/);
  assert.doesNotMatch(app.content(), /undefined/);
});

test('monthly previews keep distinct courses visible despite split sessions', () => {
  const app = load({ now: '2026-11-16T12:00:00+08:00', sem: '2026-09-07' });
  app.tab('month');
  const preview = app.cell('2026-11-16').innerHTML;
  assert.equal(occurrences(preview, '实验动物'), 1);
  assert.equal(occurrences(preview, '近代仪器'), 1);
  assert.equal(occurrences(preview, '免疫药理'), 1);
  assert.doesNotMatch(preview, /\+2/);
});

test('month navigation from the 31st visits February without skipping it', () => {
  const app = load({ now: '2027-01-31T12:00:00+08:00', sem: '2026-09-07' });
  app.tab('month');
  assert.equal(app.node('navTitle').textContent, '2027年1月');
  app.node('next').click();
  assert.equal(app.node('navTitle').textContent, '2027年2月');
  app.node('prev').click();
  assert.equal(app.node('navTitle').textContent, '2027年1月');
});

test('weekly today highlight appears only for the actual calendar date', () => {
  const app = load({ sem: '2026-09-07' });
  app.tab('week');
  assert.equal(occurrences(app.content(), '<th class="today">'), 1);
  app.node('next').click();
  assert.equal(occurrences(app.content(), '<th class="today">'), 0);
});
