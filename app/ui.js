// The page's logic (index.html is markup and style): renders the server's SSE snapshots, sends the user's actions.
const $ = s => document.querySelector(s);
// UI language: the server's setting (served in <html lang>), else the browser's. Text written in Chinese is looked up
// in EN (app/i18n.mjs): the static page once here, text built in JS through tx ({x} = a value filled in).
const LANG = document.documentElement.lang || (/^zh\b/i.test(navigator.language) ? 'zh' : 'en');
document.documentElement.lang = LANG;
const tx = (s, v = {}) => String(LANG === 'en' && EN[s] || String(s ?? '').replace(/^\w+\|/, '')).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
if (LANG === 'en') {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (n.parentElement.tagName !== 'SCRIPT') n.data = n.data.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, a, s, b) => a + tx(s) + b);
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]'))
    for (const a of ['title', 'placeholder', 'aria-label']) if (el.hasAttribute(a)) el.setAttribute(a, tx(el.getAttribute(a)));
}
// Reply language (S.language; '' = the UI's): Chinese, English, or any language typed in after "other".
$('#s-langpick').innerHTML = [['zh', tx('reply|中文')], ['en', tx('reply|英文')], ['other', tx('其他（请输入）')]]
  .map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
$('#s-language').placeholder = tx('例如 日本語');
const langPick = l => (!l ? LANG : /^(中文|汉语|简体中文|chinese|zh)$/i.test(l) ? 'zh' : /^(英文|英语|english|en)$/i.test(l) ? 'en' : 'other');
let langOther = false; // "other" picked, the language not typed in yet
function syncLang() {
  const l = S.settings.language, pick = langOther ? 'other' : langPick(l);
  $('#s-langpick').value = pick;
  $('#s-language').hidden = pick !== 'other';
  if (!langOther && document.activeElement !== $('#s-language')) $('#s-language').value = pick === 'other' ? l : '';
}
const setLang = language => { langOther = false; S.settings.language = language; syncLang(); post('/api/settings', { language }); };
$('#s-langpick').onchange = e => {
  if (e.target.value !== 'other') return setLang(e.target.value === 'zh' ? '中文' : 'English');
  langOther = true; syncLang(); $('#s-language').focus();
};
$('#s-language').onchange = e => { const v = e.target.value.trim(); if (v) setLang(v); };
// debate seats are stored as written in Chinese (正方一辩, 评委)
const seatName = s => (LANG === 'zh' ? s : s.replace(/^(正方|反方)(.)辩$/, (_, side, n) => `${tx(side)} ${'一二三四五六七八'.indexOf(n) + 1}`).replace(/^评委$/, tx('评委')));
// A shared link (/s/<code>) shows one discussion read-only.
const SHARED = location.pathname.match(/^\/s\/([\w-]+)/)?.[1];
if (SHARED) document.body.classList.add('viewer');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (url, body = {}) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
let messages = [], S = null, replyTo = null, clockSkew = 0, jumpTo = null;
const member = n => S?.members.find(m => m.name === n);
const label = n => n === 'user' ? tx('我') : n === 'system' ? tx('系统') : n === 'moderator' ? tx('主持人') : (member(n)?.label || n);
// Agent accents: used only for avatars, the message rail and mini-bars.
const color = n => member(n)?.color || 'var(--ink-3)';
// a member's avatar (its workspace's avatar.png, ?v = its mtime) or its initials
const avURL = n => `/avatar/${encodeURIComponent(n)}?v=${member(n).avatar}`;
const av = n => member(n)?.avatar ? `<a href="${avURL(n)}" target="_blank" rel="noopener" title="${tx('看大图')}"><img class="av" src="${avURL(n)}" alt="${esc(label(n))}"></a>`
  : `<span class="av" style="--c:${color(n)}">${esc(label(n).slice(0, 2))}</span>`;
const utc = s => new Date(s.replace(' ', 'T') + 'Z');
const hm = s => utc(s).toTimeString().slice(0, 5);
const when = s => { if (!s) return ''; const d = utc(s), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`; };
const pct = x => `${Math.round(x * 100)}%`;
const mini = (v, tick, c) => `<span class="mini" ${c ? `style="--c:${c}"` : ''}><i style="width:${v == null ? 0 : v * 100}%"></i>${tick != null ? `<b style="left:${tick}%"></b>` : ''}</span>`;

// Hovering a #N reference previews that message, so numbers can be followed without clicking.
const refTitle = id => { const m = messages.find(x => x.id === +id);
  return m ? esc(`#${id} ${label(m.sender)}${tx('：')}${m.text.replace(/\s+/g, ' ').slice(0, 90)}${m.text.length > 90 ? '…' : ''}`) : `#${id}`; };
const ref = id => `<a class="ref" data-id="${id}" title="${refTitle(id)}">#${id}</a>`;
function linkRefs(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/#(\d+)/g, (_, id) => ref(id));
}

// Messages are Markdown. Replies can quote web pages, so raw HTML is shown as text and only http(s)/mailto links survive.
const safeHref = h => /^(https?:|mailto:)/i.test(h || '');
window.marked?.use({ gfm: true, breaks: true, renderer: {
  html: ({ text }) => esc(text),
  link({ href, title, tokens }) { const t = this.parser.parseInline(tokens);
    return safeHref(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${t}</a>` : t; },
  // images from this server (/w/, /files/) show inline; others stay links (loading them would tell a third party who reads)
  image: ({ href, text }, u = URL.parse(href, location.href)) => u?.origin === location.origin && /^\/(w|files|avatar)\//.test(u.pathname)
    ? `<a href="${esc(href)}" target="_blank" rel="noopener"><img class="inl" src="${esc(href)}" alt="${esc(text)}" loading="lazy"></a>`
    : safeHref(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>` : esc(text),
} });
function md(t) {
  if (!window.marked) return linkRefs(t);
  const box = document.createElement('div'); box.innerHTML = marked.parse(t);
  // #N outside code and links becomes a reference
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), hits = [];
  for (let n; (n = walk.nextNode());) if (/#\d+/.test(n.data) && !n.parentElement.closest('code,pre,a')) hits.push(n);
  for (const n of hits) { const s = document.createElement('span'); s.innerHTML = esc(n.data).replace(/#(\d+)/g, (_, id) => ref(id)); n.replaceWith(...s.childNodes); }
  return box.innerHTML;
}

// Hovering a #N reference marks the referenced message (wherever the reference is: stream, panel, history).
for (const [ev, on] of [['mouseover', true], ['mouseout', false]])
  document.addEventListener(ev, e => { const r = e.target.closest?.('a.ref[data-id]'); if (r) $('#m' + r.dataset.id)?.classList.toggle('refhl', on); });

// A message's attachments: images inline (open full size), other files as links.
const fileUrl = f => `/files/${f.file.split('/').map(encodeURIComponent).join('/')}`;
const kb = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
function renderFiles(m) {
  const fs = m.files && JSON.parse(m.files);
  if (!fs?.length) return '';
  return `<div class="atts">${fs.map(f => f.type?.startsWith('image/')
    ? `<a href="${fileUrl(f)}" target="_blank" rel="noopener"><img src="${fileUrl(f)}" alt="${esc(f.name)}" loading="lazy"></a>`
    : `<a class="att-file" href="${fileUrl(f)}" target="_blank" rel="noopener">${esc(f.name)} <small>${kb(f.size)}</small></a>`).join('')}</div>`;
}

function renderMsg(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.kind}`; el.id = 'm' + m.id;
  if (m.kind === 'agent') el.style.setProperty('--c', color(m.sender));
  if (m.kind === 'system') { el.innerHTML = `<span>${linkRefs(m.text)}</span>`; el.title = `#${m.id}`; return el; }
  if (m.kind === 'moderator') { el.innerHTML = `<span>${linkRefs(m.text)}</span>`; el.title = `${tx('主持人')} ${when(m.created_at)}`; return el; }
  const talk = messages.filter(x => x.kind === 'user' || x.kind === 'agent');
  const idx = talk.findIndex(x => x.id === m.id);
  const between = m.based_on != null ? talk.slice(0, idx).filter(x => x.id > m.based_on) : [];
  // the same member right after itself: a compact header without the avatar
  const prev = messages[messages.findIndex(x => x.id === m.id) - 1], cont = m.kind === 'agent' && prev?.kind === 'agent' && prev.sender === m.sender;
  if (cont) el.classList.add('cont');
  const l1 = `<div class="l1"><span class="who">${esc(label(m.sender))}</span>
    <small>${hm(m.created_at)} <span class="num" title="${tx('消息编号，正文里的 #{id} 指的就是这条', { id: m.id })}">#${m.id}</span></small>
    <span class="rp" data-reply="${m.id}" title="${tx('引用回复 #{id}', { id: m.id })}">${tx('回复')}</span></div>`;
  const hd = [];
  // the name the member gave itself in this discussion: click to @ it
  if (m.nick) hd.unshift(`<button class="tag nick" data-at="${esc(m.nick)}" title="${tx('它在这场讨论里给自己取的名字，点一下 @ 它')}">${esc(m.nick)}</button>`);
  if (m.model) hd.push(`<span class="model" title="${esc(m.model)}">${esc(m.model)}</span>`);
  if (m.latency_ms) hd.push(`<span title="${tx('思考用时')}">${tx('想了 {s}s', { s: Math.round(m.latency_ms / 1000) })}</span>`);
  const st = m.stance && JSON.parse(m.stance);
  if (st) hd.push(`<span class="dim" title="${tx('立场：')}${esc(st.l ? `${st.l}：${st.t}` : st.t)}">${st.l ? `${esc(st.l)} ` : ''}${st.c}%</span>`);
  if (m.dm) hd.unshift(m.role === 'order' ? `<span class="tag warn" title="${tx('秘密指令：只有主持人看得到')}">${tx('🔒 秘密指令给 {who}', { who: esc(label(m.dm)) })}</span>`
    : `<span class="tag warn" title="${tx('私信：只有收信人看得到（你全都看得到）')}">${tx('🔒 私信给 {who}', { who: esc(label(m.dm)) })}</span>`);
  if (m.reply_to) hd.push(`<span class="tag">${tx('回复 {ref}', { ref: ref(m.reply_to) })}</span>`);
  if (m.based_on != null && between.length) hd.push(`<span class="dim" title="${tx('开始思考时看到的最后一条是 #{id}，之后又有 {n} 条', { id: m.based_on, n: between.length })}">${tx('基于 {ref} +{n}', { ref: ref(m.based_on), n: between.length })}</span>`);
  if (m.stale) hd.push(`<span class="tag warn" title="${tx('这条回复写于你的新消息之前')}">${tx('写于你的新消息之前')}</span>`);
  if (m.role === 'devil') hd.push(`<span class="tag devil" title="${tx('主持人请它站到对立面')}">${tx('唱反调')}</span>`);
  if (m.role === 'summary') hd.push(`<span class="tag summary">${tx('总结')}</span>`);
  if (m.role === 'outsider') hd.push(`<span class="tag" title="${tx('这位成员的模型开了一个新会话：只看你的提问和共享文件，先独立想，再读讨论记录，只带回没试过的方向')}">${tx('局外人')}</span>`);
  if (m.seat) hd.unshift(`<span class="tag${m.role === 'verdict' ? ' summary' : ''}">${esc(m.role === 'verdict' ? tx('{seat}评判', { seat: seatName(m.seat) }) : seatName(m.seat))}</span>`);
  const ops = m.note_ops && JSON.parse(m.note_ops);
  if (ops?.length) hd.push(`<span title="${tx('这条发言更新了本场讨论的笔记')}">${tx('笔记')} ${ops.map(o => `${{ add: '+', edit: '~', drop: '−' }[o.op]}N${o.n}`).join(' ')}</span>`);
  if (m.turn_no) hd.push(`<span class="dim" title="${tx('本讨论中的第 {n} 次发言', { n: m.turn_no })}">${tx('第 {n} 次', { n: m.turn_no })}</span>`);
  el.innerHTML = `<div class="hd">${m.kind === 'agent' && !cont ? av(m.sender) : ''}<div class="hl">${l1}<div class="meta">${hd.join('')}</div></div></div>`
    + `<div class="tx">${md(m.text)}</div>${renderFiles(m)}`;
  return el;
}

// One example per mode; picking one fills the input and switches the (empty) discussion to its mode.
// {host}: the game's host, the first enabled member.
const IDEAS = [
  ['research', '章鱼真的有九个“大脑”吗？查查资料，给出处。'],
  ['roundtable', '如果从明天起人人每周只上四天班，世界会变好还是更乱？'],
  ['debate', '辩题：AI 写的小说也应该能拿文学奖。'],
  ['story', '接龙：2049 年，最后一家人工咖啡馆的店长收到一封来自未来的差评。'],
  ['game', '{host} 主持一局“谁是卧底”，其他人都来玩。'],
];
function emptyState() {
  const names = S?.members.filter(m => m.enabled).map(m => m.name) || [];
  return `<div class="empty">
    <div class="members">${names.map(av).join('')}</div>
    <h1>${tx('开一场讨论')}</h1>
    <p>${names.length ? tx('提一个问题，{n} 位参与成员会各自给出观点、互相补充和反驳；主持人安排发言顺序，观点收敛时请人总结。你随时可以插话。', { n: names.length }) : tx('添加或启用一位成员，开始讨论。')}</p>
    <div class="ideas">${names.length ? IDEAS.map(([mode, t]) => { t = tx(t, { host: `@${member(names[0]).at}` });
      return `<button class="idea" data-idea="${esc(t)}" data-idea-mode="${mode}"><span class="idea-mode">${MODE_LABEL[mode]}</span>${esc(t)}</button>`; }).join('') : ''}</div>
  </div>`;
}
const thinkingEl = Object.assign(document.createElement('div'), { id: 'thinking' });
thinkingEl.onclick = e => e.target.closest('[data-go]') && post('/api/opening/go');
thinkingEl.setAttribute('aria-live', 'polite');
function renderThinking() {
  // after Jev picks the mode for a new discussion, a few seconds to switch it before anyone starts
  const open = S.opening ? `<span>⏳ ${tx('<span data-left="{t}"></span> 后按「{mode}」开始，不对就在顶栏换模式', { t: S.opening, mode: MODE_LABEL[S.discussionMode.effective] })}`
    + `<button class="rowbtn" data-go>${tx('现在开始')}</button></span>` : '';
  const html = open + S.members.filter(m => m.status === 'thinking').map(m => `<span style="--c:${color(m.name)}">`
    + `<span class="dot"></span><b>${esc(m.label)}</b><span class="pulse">${tx('正在思考')}</span><span data-since="${m.started}"></span></span>`).join('');
  if (thinkingEl.dataset.html !== html) { thinkingEl.innerHTML = thinkingEl.dataset.html = html; }
  if (messages.length && thinkingEl.parentNode !== $('#msgs')) $('#msgs').appendChild(thinkingEl);
}
function renderAll() {
  const box = $('#msgs'); box.innerHTML = '';
  if (!messages.length) box.innerHTML = emptyState();
  for (const m of messages) box.appendChild(renderMsg(m));
  if (messages.length) box.appendChild(thinkingEl);
  box.style.scrollBehavior = 'auto'; box.scrollTop = box.scrollHeight; box.style.scrollBehavior = '';
  if (jumpTo) { flash(jumpTo); jumpTo = null; }
}
function flash(id) {
  const el = $('#m' + id);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1700);
}

function fmtSecs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }

// Re-render only on change, so clicks and open dropdowns aren't swallowed by the 1s state tick.
const lastHTML = {};
const setHTML = (sel, html) => lastHTML[sel] !== html && ($(sel).innerHTML = lastHTML[sel] = html, true);
let modelLists = {};
function modelOptions(m) {
  const list = modelLists[m.name] || modelLists[m.harness] || [];
  const opts = list.some(x => x.id === m.model) ? list : [{ id: m.model, name: m.model || 'default' }, ...list];
  return opts.map(x => `<option value="${esc(x.id)}" ${x.id === m.model ? 'selected' : ''}>${esc(x.name === x.id ? x.id : `${tx(x.name)} (${x.id || 'default'})`)}</option>`).join('');
}

// ---------- history ----------
let searchQ = '', searchHits = null;
const ICON = {
  rename: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  export: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>',
  del: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};
function renderHistory() {
  if (searchHits) {
    const re = new RegExp(searchQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return setHTML('#history', `<section class="pane">${pane('hist:search', tx('搜索结果'), { count: searchHits.length, body: searchHits.length
      ? `<div>${searchHits.map(h => `<div class="hit" data-hit="${h.chat_id}:${h.id}">
      <div class="ht">${esc(chatTitle(h.title))}</div><div>${esc(label(h.sender))}${tx('：')}${esc(h.snippet).replace(re, '<mark>$&</mark>')}</div></div>`).join('')}</div>`
      : `<div class="memempty">${tx('没有找到匹配的讨论')}</div>` })}</section>`);
  }
  const day = c => { const d = utc(c.last || c.created_at), t = new Date(); t.setHours(0, 0, 0, 0);
    return tx(d >= t ? '今天' : d >= new Date(t - 864e5) ? '昨天' : d >= new Date(t - 6 * 864e5) ? '最近 7 天' : '更早'); };
  // Grouped by recency, or by mode (newest first within each); by recency each row names its mode. Each group is a
  // section like the right panel's, folded the same way.
  const KINDS = Object.keys(MODE_LABEL), byKind = histGroup === 'kind';
  const rank = c => (c.kind ? KINDS.indexOf(c.kind) : KINDS.length);
  const chats = byKind ? [...S.chats].sort((x, y) => rank(x) - rank(y)) : S.chats;
  const groups = new Map();
  for (const c of chats) {
    const gg = byKind ? MODE_LABEL[c.kind] || tx('未分类') : day(c);
    groups.set(gg, (groups.get(gg) || '') + `<div class="chat ${c.id === S.chatId ? 'on' : ''}" data-chat="${c.id}" title="${esc(c.title)}${c.preview ? `\n${esc(c.preview)}` : ''}\n${tx('{n} 条消息', { n: c.n })}">
      <span class="n" title="${tx('讨论编号：消息里写“讨论 {id}”，成员就能在存档里找到它', { id: c.id })}">${c.id}</span><span class="t">${esc(c.title)}</span>${!byKind && c.kind ? `<span class="k">${MODE_LABEL[c.kind]}</span>` : ''}<span class="m">${when(c.last || c.created_at)}</span>
      <span class="acts"><span data-rename="${c.id}" title="${tx('重命名')}">${ICON.rename}</span><span data-export="${c.id}" title="${tx('导出 Markdown')}">${ICON.export}</span><span data-del="${c.id}" title="${tx('删除')}">${ICON.del}</span></span>
    </div>`);
  }
  setHTML('#history', [...groups].map(([g, rows]) =>
    `<section class="pane">${pane(`hist:${g}`, g, { count: rows.split('data-chat=').length - 1, body: `<div>${rows}</div>` })}</section>`).join(''));
}
let histGroup = localStorage.histGroup || 'time';
$('#histGroup').value = histGroup;
$('#histGroup').onchange = e => { histGroup = localStorage.histGroup = e.target.value; renderHistory(); };
let searchTimer;
$('#search').addEventListener('input', e => {
  searchQ = e.target.value.trim(); clearTimeout(searchTimer);
  if (!searchQ) { searchHits = null; delete lastHTML['#history']; return renderHistory(); }
  searchTimer = setTimeout(async () => { searchHits = await (await fetch('/api/search?q=' + encodeURIComponent(searchQ))).json(); renderHistory(); }, 250);
});

// ---------- moderator ----------
function renderModerator() {
  const j = S.jev, mode = S.settings.scheduler, m = S.mod;
  const status = j.assessing ? `<span class="pulse">${tx('在评估谁有新观点')}</span>` : j.judging ? `<span class="pulse">${tx('在判断是否收敛')}</span>`
    : j.down ? tx('Jev 暂不可用，改用算法') : j.ms ? tx('上次判断 {ms}ms', { ms: j.ms }) : tx('待命');
  const row = (name, v, tick, hint) => `<div class="metric" title="${hint}"><span class="ml">${name}</span>${mini(v, tick)}<span class="mv">${v == null ? '–' : pct(v)}</span></div>`;
  const modeText = tx(mode === 'jev' ? '按新意请人发言' : mode === 'algorithm' ? '按算法调度' : '广播：每条唤醒所有人');
  const html = pane('moderator', tx('主持人 Jev'), { status, body: `<div class="lead">${flowText(modeText)}</div>${renderSeats()}
    ${m?.convergence != null ? row(tx('观点收敛'), m.convergence, S.settings.autoStop ? S.settings.convergeAt : null, tx('刻度是收尾阈值')) : ''}
    ${m?.convergence != null ? `<div class="quiet">${[
      `<span title="${tx('最近几条是否只在附和或复述')}">${tx('附和重复')} <b>${pct(m.stalling)}</b></span>`,
      S.settings.circlePause ? `<span title="${tx('同样的论点来回重复；到 70% 会暂停')}">${tx('原地打转')} <b>${pct(m.circling)}</b></span>` : '',
      m.debatable != null ? `<span title="${tx('问题是否见仁见智（不是有标准答案的事实题）')}">${tx('见仁见智')} <b>${pct(m.debatable)}</b></span>` : '',
      m.challenged != null ? `<span title="${tx('本轮有没有人认真反对过多数意见')}">${tx('有人反对')} <b>${pct(m.challenged)}</b></span>` : '',
    ].filter(Boolean).join('')}</div>` : ''}
    ${S.wrapped ? `<div class="wrapnote">${tx('本轮已收尾，发新消息可继续讨论。')}</div>` : ''}` });
  setHTML('#moderator', html);
  const line = $('#convline');
  line.classList.toggle('off', m?.convergence == null);
  if (m?.convergence != null) {
    line.querySelector('i').style.width = pct(m.convergence);
    line.querySelector('b').style.left = S.settings.autoStop ? `${S.settings.convergeAt}%` : '-10px';
    line.title = tx('观点收敛度 {p}', { p: pct(m.convergence) }) + (S.settings.autoStop ? tx('，到 {n}% 收尾', { n: S.settings.convergeAt }) : '');
  }
}

// How the room takes turns in the current mode.
const PHASE_LABEL = { opening: '开篇立论', rebuttal: '驳论', free: '自由辩', closing: '结辩', verdict: '评判' };
function flowText(schedulerText) {
  const d = S.debate, flow = S.discussionMode.rules.flow;
  if (flow === 'relay') return tx('故事接力：一人一段，按顺序或 @ 交棒');
  if (flow === 'debate') return d ? tx('辩论：{phase}（第 {step}/{steps} 步）', { phase: tx(PHASE_LABEL[d.phase] || '评判'), step: d.step, steps: d.steps }) : tx('辩论：你发出辩题后抽签分持方');
  const g = S.game;
  if (flow === 'game') return !g ? tx('博弈：@ 一位成员当主持人，说说玩什么，如“@claude 主持，我们玩狼人杀”')
    : g.over ? tx('博弈已结束，自由聊；点“再开一局”在这里接着玩')
    : tx('博弈 · {host} 主持 · 第 {r} 回合 · {phase}', { host: esc(label(g.host)), r: g.round + 1,
      phase: { host: tx('主持人结算'), talk: tx('轮流发言'), orders: tx('秘密行动（{a}/{b}）', { a: g.ordered.length, b: g.waiting.length }) }[g.phase] })
      + (g.turn === 'user' ? ` · <b>${tx(g.phase === 'talk' ? '轮到你发言' : '轮到你：下一条消息是只给主持人的秘密指令')}</b>` : '');
  return (d?.done ? tx('辩论已结束，自由讨论；') : '') + schedulerText + (S.settings.autoStop ? tx('，收敛后自动收尾') : '');
}
function renderSeats() {
  const d = S.debate, g = S.game;
  const who = n => (n === 'user' ? tx('你') : `<span style="color:${color(n)}">${esc(label(n))}</span>`);
  if (g && S.discussionMode.rules.flow === 'game') return `<div class="seats"><b>${tx('host|主持')}</b><span>${who(g.host)}</span>`
    + `<b>${tx('玩家')}</b><span>${g.players.map(who).join(tx('、'))}</span></div>`
    + (g.user && !g.over ? `<div class="form-help">${tx('你也在玩：别人之间的私信和主持人账本等游戏结束后再显示。私信某人：单独一行 [DM @某人]，后面写内容。')}</div>` : '')
    + (g.ledger ? `<div class="ledger" title="${tx('主持人的私密账本，只有它和你看得到')}">${esc(g.ledger)}</div>` : '')
    + (g.over ? `<button class="rowbtn" data-gamenew title="${tx('在这个讨论里接着玩：大家带着前面几局的记忆，你 @ 一位主持人说说玩什么')}">${tx('再开一局')}</button>`
      : `<button class="rowbtn" data-gameend title="${tx('主持人忘了宣布结束、或者不想玩了：这局到此为止，之后的消息是普通聊天')}">${tx('结束这局游戏')}</button>`);
  if (!d) return '';
  return `<div class="seats"><b>${tx('正方')}</b><span>${d.pro.map(who).join(tx('、'))}</span><b>${tx('反方')}</b><span>${d.con.map(who).join(tx('、'))}</span>`
    + `<b>${tx('评委')}</b><span>${who(d.judge)}</span></div>`;
}

// ---------- the right panel's sections ----------
// Every section has the same header: fold toggle, title, count, status on the right, action buttons. Folds are remembered;
// "about you" and the settings start folded (the old separate toggle is carried over once).
const folded = new Set(JSON.parse(localStorage.folded || '[]'));
if (!localStorage.foldV2) {
  if (localStorage.getItem('memory-collapsed') !== 'false') folded.add('memory');
  folded.add('settings'); localStorage.removeItem('memory-collapsed');
  localStorage.folded = JSON.stringify([...folded]); localStorage.foldV2 = '1';
}
const foldButton = (key, inner) => `<button class="memtoggle" data-fold="${key}" aria-expanded="${!folded.has(key)}" title="${tx('展开或收起')}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg>${inner}</button>`;
const pane = (key, title, { count, status = '', acts = '', body = '' } = {}) => `<div class="ph">${foldButton(key,
  `${title}${count ? `<span class="count">${count}</span>` : ''}`)}${status ? `<span class="st">${status}</span>` : ''}`
  + `${acts ? `<span class="pa">${acts}</span>` : ''}</div>${folded.has(key) ? '' : body}`;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-fold]');
  if (!b) return;
  const k = b.dataset.fold;
  folded.has(k) ? folded.delete(k) : folded.add(k);
  localStorage.folded = JSON.stringify([...folded]);
  renderState();
});

// ---------- the discussion's notes ----------
// Kept by the members with [NOTE] lines at the end of their replies, and seen by every turn; the user can edit them here.
function renderNotes() {
  const title = tx(S.discussionMode.rules.notesTitle);
  setHTML('#notes', pane('notes', esc(title), { count: S.notes.length, acts: `<button data-note-add>${tx('添加')}</button>`, body:
    S.notes.length ? `<ul class="notelist">${S.notes.map(x => `<li><span class="nn">N${x.n}</span><span class="nt clamp ${openNotes.has(x.n) ? 'open' : ''}" data-note-open="${x.n}">${linkRefs(x.text)}</span>`
      + `<span class="nm">${x.msg ? ref(x.msg) : x.by === 'user' ? tx('你') : ''}<button data-note-edit="${x.n}" title="${tx('修改')}" aria-label="${tx('修改 N{n}', { n: x.n })}">${ICON.rename}</button>`
      + `<button data-note-drop="${x.n}" title="${tx('删除')}" aria-label="${tx('删除 N{n}', { n: x.n })}">${ICON.del}</button></span></li>`).join('')}</ul>`
      : `<div class="memempty">${tx('成员发言时会把需要前后一致的内容记在这里（{title}），之后每一轮都会参考。你也可以自己添加或修改。', { title: esc(title) })}</div>` }));
}
// long notes show three lines; a click opens one (links inside still work)
const openNotes = new Set();
document.addEventListener('click', e => {
  const t = e.target.closest('[data-note-open]');
  if (!t || e.target.closest('a')) return;
  const n = +t.dataset.noteOpen;
  openNotes.has(n) ? openNotes.delete(n) : openNotes.add(n);
  t.classList.toggle('open');
});
// ---------- background jobs ([JOB] lines) ----------
// Shown only when there are any: running ones (stoppable) and this discussion's recent ones. Minutes, not seconds,
// so the list doesn't re-render every tick under the stop button.
const JOB_STATUS = { done: '完成', failed: '失败', stopped: '已停止', timeout: '超时', interrupted: '重启中断' };
const openJobLive = new Set();
function renderJobs() {
  const jobs = S.jobs || [];
  const mins = j => Math.max(0, Math.floor((Date.now() - clockSkew - Date.parse(j.started_at.replace(' ', 'T') + 'Z')) / 60e3));
  // J = a [JOB] command, T = a [TASK] coding session (its description; a running one shows its live output)
  const tagOf = j => `${j.kind === 'task' ? 'T' : 'J'}${j.id}`, short = s => (s.length > 60 ? s.slice(0, 60) + '…' : s);
  const running = jobs.filter(j => j.status === 'running').length;
  setHTML('#jobs', !jobs.length ? '' : pane('jobs', tx('后台任务'), { count: running, status: running ? '' : tx('都已结束'), body: `<ul class="notelist">${jobs.map(j => `<li><span class="nn">${tagOf(j)}</span>`
      + `<span class="nt"><span style="color:${color(j.agent)}">${esc(label(j.agent))}</span> `
      + (j.kind === 'task' ? `<span title="${esc(j.cmd)}">${esc(short(j.cmd))}</span>${j.branch ? ` <code>${esc(j.branch)}</code>` : ''}`
        : `<code title="${esc(j.cmd)}">${esc(short(j.cmd))}</code>`)
      + (j.live ? `<details data-job-live="${j.id}" ${openJobLive.has(j.id) ? 'open' : ''}><summary>${tx('实时输出')}</summary><pre>${esc(j.live)}</pre></details>` : '')
      + `</span><span class="nm">${j.status === 'running' ? `${tx('{n} 分钟', { n: mins(j) })}<button data-job-stop="${j.id}" data-tag="${tagOf(j)}" title="${tx('停止')}" aria-label="${tx('停止 {tag}', { tag: tagOf(j) })}">${ICON.del}</button>`
        : `${tx(JOB_STATUS[j.status] || j.status)}${j.code ? ` (${j.code})` : ''}`}</span></li>`).join('')}</ul>` }))
    && document.querySelectorAll('[data-job-live]').forEach(d => {
      d.ontoggle = () => d.open ? openJobLive.add(+d.dataset.jobLive) : openJobLive.delete(+d.dataset.jobLive);
      const pre = d.querySelector('pre'); pre.scrollTop = pre.scrollHeight;
    });
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-job-stop]');
  if (t && confirm(tx('停止后台任务 {tag}？', { tag: t.dataset.tag }))) post('/api/job/stop', { id: +t.dataset.jobStop });
});
// ---------- training window ----------
// Open: time left, each member's last measured win rate (the server's probes, not the members' word), stop button.
// Otherwise, when there are referees (_shared/referees/<name>) and executing code is on: the form to open one.
function renderArena() {
  const A = S.arena;
  if (!A) return setHTML('#arena', !S.referees?.length ? '' : pane('arena', tx('训练窗口'), { status: tx('每人独立做，到点循环赛'), body: `<form id="arena-form" class="settings arenaform">
      <textarea name="goal" rows="3" required placeholder="${tx('目标，原话交给每位成员，比如：写一个尽量强的 kore bot')}"></textarea>
      <label>${tx('裁判')} <select name="referee">${S.referees.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
      <label>${tx('时长（分钟）')} <input name="minutes" type="number" min="1" max="600" value="30"></label>
      <label>${tx('每隔几分钟评测')} <input name="every" type="number" min="1" value="10"></label>
      <button class="rowbtn">${tx('开始训练')}</button></form>` }));
  const left = Math.max(0, Math.ceil((A.until - Date.now() + clockSkew) / 60e3));
  setHTML('#arena', pane('arena', tx('训练窗口'), { status: A.phase === 'work' ? tx('还剩 {n} 分钟', { n: left }) : `<span class="pulse">${tx('循环赛中')}</span>`,
    acts: `<button id="arena-stop">${tx(A.phase === 'work' ? '结束' : '停止')}</button>`, body:
      `<div class="lead" title="${esc(A.goal)}">${esc(A.id)} · ${tx('裁判')} ${esc(A.referee)} · <a href="${esc(A.url)}" target="_blank" rel="noopener">${tx('文件')}</a></div>`
      + `<ul class="notelist">${A.members.map(m => `<li><span class="nt"><span style="color:${color(m.name)}">${esc(label(m.name))}</span> `
        + `${tx(A.probing === m.name ? '评测中…' : m.out ? '已退出' : A.phase !== 'work' ? '' : m.working ? '工作中' : '等待续上')}</span>`
        + `<span class="nm">${m.rate == null ? '—' : `${Math.round(m.rate * 100)}%${tx('（第 {n} 版）', { n: m.probes })}`}</span></li>`).join('')}</ul>` }));
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'arena-form') return;
  e.preventDefault();
  const r = await post('/api/arena/start', Object.fromEntries(new FormData(e.target)));
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || tx('请求失败'));
});
document.addEventListener('click', e => {
  if (e.target.id === 'arena-stop' && confirm(tx(S.arena.phase === 'work' ? '现在结束训练，用各人当前的 bot 打循环赛？' : '停止循环赛（没有结果）？'))) post('/api/arena/stop');
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-note-add],[data-note-edit],[data-note-drop]');
  if (!t) return;
  const title = tx(S.discussionMode.rules.notesTitle), note = n => S.notes.find(x => x.n === n);
  if ('noteAdd' in t.dataset) { const text = prompt(tx('添加一条{title}', { title })); if (text?.trim()) post('/api/notes', { chat_id: S.chatId, op: 'add', text }); }
  if (t.dataset.noteEdit) { const n = +t.dataset.noteEdit, text = prompt(tx('修改 N{n}', { n }), note(n)?.text || ''); if (text?.trim()) post('/api/notes', { chat_id: S.chatId, op: 'edit', n, text }); }
  if (t.dataset.noteDrop) { const n = +t.dataset.noteDrop; if (confirm(tx('删除 N{n}：{text}？', { n, text: note(n)?.text || '' }))) post('/api/notes', { chat_id: S.chatId, op: 'drop', n }); }
});

// Each member ends a message with its position and confidence; Jev judges whether a change was moved by a new argument.
function renderStances() {
  if (!S.discussionMode.rules.stance || !S.stances?.length) return setHTML('#stances', '');
  setHTML('#stances', pane('stances', `<span title="${tx('成员每条发言末尾给出当前立场和信心；立场变化时由 Jev 判断有没有新论据')}">${tx('立场')}</span>`,
    { count: S.stances.length, body: `<div class="stances">${S.stances.map(x => {
    const was = x.prev ? tx('之前：{t}（{c}%）', { t: x.prev.t, c: x.prev.c }) : '';
    const tag = x.role === 'devil' ? `<span class="tag devil">${tx('唱反调')}</span>`
      : x.changed >= 0.5 ? (x.evidence < 0.5 ? `<span class="tag warn" title="${esc(was)}">${tx('改了立场，但没有新论据')}</span>`
        : `<span class="tag" title="${esc(was)}">${tx('改了立场')}</span>`) : '';
    return `<div class="stance"><div class="sh"><span class="dot" style="--c:${color(x.name)}"></span>
      <a class="ref" data-id="${x.id}" title="${tx('跳到 #{id}', { id: x.id })}">${esc(label(x.name))}</a>${x.l ? `<span class="verdict">${esc(x.l)}</span>` : ''}<span class="mv" title="${tx('信心')}">${x.c}%</span></div>
      <div class="stx">${esc(x.t)}</div>${tag}</div>`;
  }).join('')}</div>` }));
}

// ---------- memory about the user ----------
// Facts the agents read at the start of each new discussion; the user can edit or refresh them.
let memEditing = false;
function renderMemory() {
  if (memEditing) return; // don't overwrite the textarea while the user edits
  const m = S.memory, items = (m.text || '').split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);
  const status = m.curating ? `<span class="pulse">${tx('整理中')}</span>`
    : m.error ? `<span style="color:var(--danger)" title="${esc(m.error)}">${tx('整理失败，10 分钟后重试')}</span>`
    : !S.settings.memory ? tx('已关闭') : '';
  // trailing "(#74, #80, 2026-10)" = where the fact came from and when the user last said it
  const SRC = /\s*[(（]\s*(#\d+(?:\s*[,，、]\s*#\d+)*)(?:\s*[,，、]\s*(\d{4}-\d{2}(?:-\d{2})?))?\s*[)）]\s*$/;
  const item = t => { const src = t.match(SRC);
    return `<li>${linkRefs(t.replace(SRC, ''))}${src ? ` <span class="src">${linkRefs(src[1])}${src[2] ? ` · ${src[2]}` : ''}</span>` : ''}</li>`; };
  setHTML('#memory', pane('memory', tx('关于你'), { count: items.length, status,
    acts: `<button data-mem-curate title="${tx('把你最近说的话整理进来')}">${tx('整理')}</button><button data-mem-edit title="${tx('修改或删除记忆')}">${tx('编辑')}</button>`,
    body: `<div><label class="username" title="${tx('朗读时，别人引用你的发言（如 #12）会念成这个称呼')}">${tx('朗读时称呼你')}
      <input data-user-name maxlength="20" placeholder="${tx('用户')}" value="${esc(S.settings.userName || '')}"></label>${items.length ? `<ul class="memlist">${items.map(item).join('')}</ul>`
      : `<div class="memempty">${tx('还没有关于你的记忆。每轮讨论安静下来后，会从你说过的话里整理出长期有用的信息，新讨论里的成员都会先读到。')}</div>`}</div>` }));
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-mem-curate]')) post('/api/memory/curate');
  if (e.target.closest('[data-mem-edit]')) {
    memEditing = true;
    $('#memory').innerHTML = `<div class="ph"><span class="memtoggle">${tx('关于你')}</span><span class="pa"><button data-mem-save>${tx('保存')}</button><button data-mem-cancel>${tx('取消')}</button></span></div>
      <textarea id="memedit" placeholder="${tx('每行一条，比如：- 主要写 Python')}"></textarea>`;
    $('#memedit').value = S.memory.text || ''; $('#memedit').focus();
  }
  if (e.target.closest('[data-mem-save]')) { post('/api/memory', { text: $('#memedit').value }); memEditing = false; delete lastHTML['#memory']; }
  if (e.target.closest('[data-mem-cancel]')) { memEditing = false; delete lastHTML['#memory']; renderMemory(); }
});

// ---------- members ----------
const openLive = new Set(), openMem = new Set();
let orderingMembers = false, savingMemberOrder = false;
// How to fix a member whose CLI is missing or logged out (the server runs CLIs as S.runAs when set).
const CLI_HELP = {
  claude: { install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login' },
  codex: { install: 'npm install -g @openai/codex', login: 'codex login --device-auth' },
  agy: { install: tx('安装 Google Antigravity（自带 agy 命令）'), login: 'agy' },
  opencode: { install: 'npm install -g opencode-ai', login: 'opencode auth login' },
};
function cliHelp(m) {
  const h = CLI_HELP[m.harness], cli = esc(m.harnessLabel), code = x => `<code>${esc(x)}</code>`;
  if (h && !m.installed) return tx('没有找到 {cli} 的 CLI。在服务器上安装：{cmd}，一分钟内自动识别。', { cli, cmd: code(h.install) });
  if (h && m.error === 'auth') return S.runAs
    ? tx('{cli} 没有登录。在服务器终端以 {user} 用户（{su}）运行 {cmd}，然后点“请发言”重试。', { cli, user: esc(S.runAs), su: code(`su - ${S.runAs}`), cmd: code(h.login) })
    : tx('{cli} 没有登录。在服务器终端运行 {cmd}，然后点“请发言”重试。', { cli, cmd: code(h.login) });
  if (m.error === 'quota') return tx('额度用完了：等额度恢复，或换一个模型。');
  if (m.error === 'bad-model') return tx('这个模型用不了：在上面换一个模型。');
  return esc(m.error);
}
function renderMembers() {
  return S.members.map((m, i) => {
    const qi = S.queue.findIndex(x => x.agent === m.name);
    let st = tx('空闲'), cls = '';
    if (!m.enabled) st = tx('未参与');
    else if (m.status === 'thinking') { st = `<span class="pulse">${tx('思考中')}</span> <span data-since="${m.started}"></span>`; cls = 'busy'; }
    else if (qi >= 0) { st = tx('已写好，排第 {n}', { n: qi + 1 }); cls = 'busy'; }
    else if (m.hand) { st = tx('举手：{why}', { why: esc(m.hand.why) }); cls = 'busy'; }
    else if (!m.installed) { st = tx('未安装'); cls = 'err'; }
    else if (m.error) { st = tx(m.error === 'auth' ? '未登录' : '出错'); cls = 'err'; }
    else if (m.note) st = esc(m.note);
    const right = S.settings.scheduler === 'jev' && m.nov != null
      ? `<span title="${tx('Jev 判断的新意 {p}（刻度是阈值）', { p: pct(m.nov) })}">${mini(m.nov, S.settings.noveltyMin, color(m.name))}</span>`
      : `<span title="${tx('本轮发言 / 上限')}">${m.sinceUser}/${S.settings.turnCap}</span>`;
    const open = !orderingMembers && openMem.has(m.name);
    return `<div class="mem ${m.enabled ? '' : 'off'} ${open ? 'open' : ''}">
      <div class="mrow" ${orderingMembers ? '' : `data-expand="${m.name}"`} title="${esc(orderingMembers ? tx('调整成员显示顺序') : m.hand ? tx('举手原因：{why}', { why: m.hand.why }) + (m.score != null ? tx('，得分 {s}', { s: m.score }) : '') : tx('点击查看模型、会话和实时输出'))}">
        ${av(m.name)}<div class="midentity"><div class="mheadline"><button class="mname" data-member-alias="${m.name}" title="${tx('编辑别名')} · @${esc(m.at)}">${esc(m.label)}</button><span class="mst ${cls}">${st}</span></div><span class="mmeta" title="${esc(m.harnessLabel || m.harness)} · ${esc(m.model || tx('CLI 默认模型'))}">${esc(m.harnessLabel || m.harness)} · ${esc(m.model || tx('CLI 默认模型'))}</span></div>
        <span class="mright">${right}</span>
        ${orderingMembers ? `<span class="member-move"><button data-move-member="${m.name}" data-step="-1" aria-label="${tx('上移 {name}', { name: esc(m.label) })}" ${i === 0 || savingMemberOrder ? 'disabled' : ''}>↑</button><button data-move-member="${m.name}" data-step="1" aria-label="${tx('下移 {name}', { name: esc(m.label) })}" ${i === S.members.length - 1 || savingMemberOrder ? 'disabled' : ''}>↓</button></span>` : ''}
      </div>
      <div class="mdetail">
        <div class="member-actions"><button class="floor-button" data-floor="${m.name}" title="${tx('让它马上发言')}">${tx('请发言')}</button>${m.hand && m.status !== 'thinking' ? `<button data-lower="${m.name}">${tx('放下手')}</button>` : ''}${m.configurable ? `<button data-member-edit="${m.name}">${tx('配置成员')}</button>` : ''}</div>
        <select data-model="${m.name}" title="${tx('模型（下一轮生效，会话保留）')}">${modelOptions(m)}<option value="__custom__">${tx('自定义模型…')}</option></select>
        ${S.speech?.on ? `<select data-voice="${m.name}" title="${tx('朗读声音：每位成员默认分到一个不同的 Azure 声音')}">${voiceOptions(m.name)}</select>` : ''}
        <div class="kv">
          <label class="switch"><input type="checkbox" data-enable="${m.name}" ${m.enabled ? 'checked' : ''}>${tx('参与')}</label>
          <span>${tx('本轮 {a}/{b}', { a: m.sinceUser, b: S.settings.turnCap })}</span><span>${tx('共 {n} 次', { n: m.turns })}</span>
          <span title="${esc(m.sid || '')}">${tx('会话 {sid}', { sid: m.sid ? esc(m.sid.slice(0, 8)) : tx('未开始') })}</span>
        </div>
        ${!m.installed || m.error ? `<div class="err">${cliHelp(m)}</div>` : ''}
        ${m.live ? `<details data-live="${m.name}" ${openLive.has(m.name) ? 'open' : ''}><summary>${tx('实时输出')}</summary><pre>${esc(m.live)}</pre></details>` : ''}
        <button class="member-remove" data-member-delete="${m.name}">${tx('移除成员')}</button>
      </div>
    </div>`;
  }).join('');
}

function renderState() {
  const now = Date.now() - clockSkew;
  if (!messages.length) setHTML('#msgs', emptyState());
  renderHistory(); renderModerator(); renderStances(); renderNotes(); renderJobs(); renderArena(); renderMemory(); renderMode(); renderTts(); renderThinking();
  for (const [k, el] of [['members', '#members'], ['settings', '#settings-body']]) {
    $(el).hidden = folded.has(k); $(`[data-fold=${k}]`).setAttribute('aria-expanded', !folded.has(k));
  }
  $('#s-exec').disabled = !S.sandboxed; $('#execrow').style.opacity = S.sandboxed ? '' : '.45';
  const cur = S.chats.find(c => c.id === S.chatId);
  $('#title').textContent = cur?.title || '';
  setHTML('#members', renderMembers()) && document.querySelectorAll('[data-live]').forEach(d => {
    d.ontoggle = () => d.open ? openLive.add(d.dataset.live) : openLive.delete(d.dataset.live);
    const pre = d.querySelector('pre'); pre.scrollTop = pre.scrollHeight;
  });
  // thinking timers tick without re-rendering the rows (keeps dropdowns and hover stable)
  document.querySelectorAll('[data-since]').forEach(s => (s.textContent = fmtSecs(now - +s.dataset.since)));
  document.querySelectorAll('[data-left]').forEach(s => (s.textContent = fmtSecs(+s.dataset.left - now)));
  setHTML('#ats', S.members.filter(m => m.enabled).map(m => `<button class="chip" data-at="${esc(m.nick || m.at)}" title="${tx('点名 @{at}', { at: esc(m.nick || m.at) })}"><span class="dot" style="--c:${color(m.name)}"></span>@${esc(m.nick || m.at)}</button>`).join(''));
  const p = $('#pause');
  setHTML('#pause', S.paused
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5Z"/></svg><span class="lbl">${tx('继续')}</span>`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg><span class="lbl">${tx('暂停')}</span>`);
  p.classList.toggle('paused', S.paused); p.title = tx(S.paused ? '继续：从暂停的地方接着进行' : '暂停：不再开始新的发言和发布，朗读也暂停；正在思考的会想完，回复留在队列');
  const info = [];
  if (S.paused) info.push(tx('已暂停'));
  if (S.queue.length) info.push(tx('待发布 {names}', { names: S.queue.map(x => label(x.agent)).join(tx('、')) }));
  if (tts.on && tts.blocked) info.push(tx('浏览器拦截了自动播放：点一下页面任意处，从这条接着朗读'));
  if (S.speaking) info.push(tx(tts.current ? '正在朗读，读完再放下一条（“下一条”可跳过）' : '有浏览器在朗读，读完再放下一条'));
  if (S.holding) info.push(tx('你在输入，暂缓发布'));
  else if (S.readLeft > 0 && S.queue.length) info.push(tx('阅读中，还剩 {t}', { t: fmtSecs(S.readLeft) }));
  $('#info').textContent = info.join(tx('，'));
  for (const k of ['autoStop', 'devil', 'circlePause', 'memory', 'exec', 'blind', 'outsider', 'userPlays']) $('#s-' + k).checked = S.settings[k];
  if (S.settings.uiLang && S.settings.uiLang !== LANG) location.reload(); // another window switched the language
  syncLang();
  for (const k of ['uiLang', 'turnCap', 'readSpeed', 'maxThinkers', 'scheduler', 'convergeAt', 'noveltyMin']) {
    const el = $('#s-' + k);
    if (document.activeElement !== el) el.value = S.settings[k];
  }
}

const es = new EventSource(SHARED ? `/events?s=${SHARED}` : `/events?lang=${LANG}`);
// The shared page gets only the discussion and who is thinking.
function renderShared() {
  $('#title').textContent = document.title = chatTitle(S.title);
  renderThinking();
  document.querySelectorAll('[data-since]').forEach(s => (s.textContent = fmtSecs(Date.now() - clockSkew - +s.dataset.since)));
}
// a discussion's default title ("讨论 3") is stored in the language of the moment
const chatTitle = t => (t || '').replace(/^讨论 (\d+)$/, (_, n) => tx('讨论 {n}', { n }));
es.onmessage = e => {
  const ev = JSON.parse(e.data);
  for (const c of (ev.state || ev).chats || []) c.title = chatTitle(c.title);
  if (SHARED && ev.type !== 'msg') {
    S = ev.type === 'init' ? ev.state : ev; clockSkew = Date.now() - S.now;
    if (ev.type === 'init') { messages = ev.messages; renderAll(); }
    return renderShared();
  }
  if (ev.type === 'init') {
    if (ev.state.profile) Object.assign($('#who'), { hidden: false, textContent: ev.state.profile });
    if (ev.modelLists && Object.keys(ev.modelLists).length) modelLists = ev.modelLists;
    if (ev.prompts) { savedPrompts = ev.prompts; renderPrompts(); }
    delete lastHTML['#members']; S = ev.state; clockSkew = Date.now() - S.now; messages = ev.messages; renderState(); renderAll();
  }
  if (ev.type === 'state') { S = ev; clockSkew = Date.now() - S.now; renderState(); }
  if (ev.type === 'msg') {
    if (!messages.length) $('#msgs').innerHTML = '';
    messages.push(ev.msg);
    const box = $('#msgs'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.insertBefore(renderMsg(ev.msg), thinkingEl.parentNode === box ? thinkingEl : null);
    if (thinkingEl.parentNode !== box) box.appendChild(thinkingEl);
    if (atEnd || ev.msg.kind === 'user') box.scrollTop = box.scrollHeight;
    if (ev.msg.kind === 'agent' && tts.on) { tts.queue.push(ev.msg.id); playNext(); } // read new replies aloud
  }
};

function rename(id) {
  const c = S.chats.find(x => x.id === id), t = prompt(tx('重命名讨论'), c?.title || '');
  if (t && t.trim()) post('/api/chat/rename', { id, title: t.trim() });
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-member-alias],[data-move-member]')) return;
  const t = e.target.closest('[data-id],[data-reply],[data-floor],[data-lower],[data-at],[data-chat],[data-hit],[data-rename],[data-export],[data-del],[data-idea],[data-expand]');
  if (!t) return;
  const d = t.dataset;
  if (d.rename) return rename(+d.rename);
  if (d.export) return void (location.href = '/api/export?id=' + d.export);
  if (d.del) {
    const c = S.chats.find(x => x.id === +d.del);
    if (confirm(tx('删除「{title}」？消息和决策记录会一起删除，无法恢复。', { title: c?.title }))) post('/api/chat/delete', { id: +d.del });
    return;
  }
  if (d.chat) { if (+d.chat !== S.chatId) post('/api/chat/switch', { id: +d.chat }); if (phone()) closeDrawers(); return; }
  if (d.hit) {
    const [c, id] = d.hit.split(':').map(Number);
    if (c === S.chatId) flash(id); else { jumpTo = id; post('/api/chat/switch', { id: c }); }
    if (phone()) closeDrawers();
    return;
  }
  if (d.idea) {
    if (!messages.length && S.discussionMode.mode !== d.ideaMode) post('/api/chat/mode', { id: S.chatId, mode: d.ideaMode });
    const i = $('#input'); i.value = d.idea; i.focus(); grow(); typing(); return;
  }
  if (d.expand) { openMem.has(d.expand) ? openMem.delete(d.expand) : openMem.add(d.expand); delete lastHTML['#members']; return renderState(); }
  if (d.id) flash(d.id);
  if (d.reply) setReply(+d.reply);
  if (d.floor) post('/api/floor', { agent: d.floor });
  if (d.lower) post('/api/lower', { agent: d.lower });
  if (d.at) { const i = $('#input'); i.value = (i.value + ` @${d.at} `).replace(/^ /, ''); i.focus(); grow(); typing(); }
});
const memberForm = $('#member-form');
$('#order-members').onclick = () => {
  orderingMembers = !orderingMembers;
  $('#order-members').textContent = tx(orderingMembers ? '完成' : '调整顺序');
  $('#members').classList.toggle('sorting', orderingMembers);
  $('#member-order-hint').hidden = !orderingMembers;
  $('#add-member').hidden = orderingMembers;
  delete lastHTML['#members']; renderState();
};
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-move-member]');
  if (!button || savingMemberOrder) return;
  const names = S.members.map(m => m.name), i = names.indexOf(button.dataset.moveMember), j = i + Number(button.dataset.step);
  if (i < 0 || j < 0 || j >= names.length) return;
  [names[i], names[j]] = [names[j], names[i]];
  savingMemberOrder = true; delete lastHTML['#members']; renderState();
  try { const res = await post('/api/member/order', { names }); const data = await res.json();
    if (!res.ok) throw new Error(data.error || tx('排序保存失败'));
  } catch (err) { alert(err.message); }
  finally { savingMemberOrder = false; delete lastHTML['#members']; renderState(); }
});
let aliasOnly = false;
const modelSelect = $('#member-model-select');
function populateMemberModels(selected = modelSelect.value) {
  const models = [...(modelLists.opencode || [])];
  if (selected && selected !== '__custom__' && !models.some(x => x.id === selected)) models.unshift({ id: selected });
  modelSelect.innerHTML = `<option value="">${tx('选择模型')}</option>` + models.map(x => `<option value="${esc(x.id)}">${esc(x.id)}</option>`).join('') + `<option value="__custom__">${tx('自定义模型…')}</option>`;
  modelSelect.value = selected;
  $('#model-list-status').textContent = models.length ? tx('{n} 个可用模型', { n: models.length }) : tx('尚未读取到模型，请刷新列表或填写自定义模型。');
}
$('#refresh-models').onclick = async () => {
  const b = $('#refresh-models'); b.disabled = true; b.textContent = tx('读取中…');
  try { const res = await post('/api/models/refresh'); const data = await res.json();
    if (!res.ok) throw new Error(data.error || tx('读取失败'));
    modelLists = data.modelLists; populateMemberModels();
  } catch (err) { $('#model-list-status').textContent = err.message; }
  finally { b.disabled = false; b.textContent = tx('刷新列表'); }
};
// A new member on another CLI uses its own login and default model (changed later from the member card).
function syncHarness() {
  const oc = aliasOnly || memberForm.elements.harness.value === 'opencode' || $('#harness-field').hidden;
  $('#opencode-section').hidden = aliasOnly || !oc;
  $('#harness-help').textContent = oc ? '' : tx('用这个 CLI 自己的登录和默认模型；添加后可在成员卡片里换模型。');
  syncMemberModel();
}
memberForm.elements.harness.onchange = syncHarness;
function syncMemberModel() {
  const custom = modelSelect.value === '__custom__';
  if ($('#opencode-section').hidden) { modelSelect.required = memberForm.elements.model.required = false; memberForm.elements.model.value = ''; return; }
  $('#custom-model-field').hidden = aliasOnly || !custom;
  modelSelect.required = !aliasOnly;
  memberForm.elements.model.required = !aliasOnly && custom;
  if (!custom) memberForm.elements.model.value = modelSelect.value;
}
modelSelect.onchange = syncMemberModel;
function editMember(name, onlyAlias = false) {
  aliasOnly = onlyAlias;
  const m = name ? member(name) : null;
  memberForm.reset();
  for (const key of ['name', 'label', 'model', 'color']) memberForm.elements[key].value = m?.[key] || (key === 'color' ? '#7c5cff' : '');
  memberForm.elements.label.value = m?.alias || '';
  memberForm.elements.label.placeholder = m?.defaultAlias || tx('默认使用 @ 标识');
  $('#alias-help').textContent = m ? tx('默认：{a}，留空恢复默认。不含空格时也用来 @。', { a: m.defaultAlias }) : tx('聊天中显示和 @ 用的名字，留空使用标识。');
  memberForm.querySelectorAll('[data-connection]').forEach(el => { el.hidden = onlyAlias; });
  populateMemberModels(m?.model || '');
  syncMemberModel();
  memberForm.elements.name.required = !onlyAlias;
  memberForm.querySelector('details').open = false;
  for (const key of ['baseURL', 'protocol', 'persona']) memberForm.elements[key].value = m?.config?.[key] || (key === 'protocol' ? 'responses' : '');
  memberForm.elements.name.readOnly = !!m;
  $('#harness-field').hidden = onlyAlias || !!m;
  memberForm.elements.harness.innerHTML = Object.entries(S.harnesses || {}).filter(([, x]) => x.installed)
    .map(([h, x]) => `<option value="${h}">${esc(x.label)}${tx(h === 'opencode' ? '（任意模型和 API Key）' : '（用它自己的登录）')}</option>`).join('')
    || '<option value="opencode">OpenCode</option>';
  memberForm.elements.harness.value = m?.harness || (S.harnesses?.opencode?.installed ? 'opencode' : memberForm.elements.harness.value);
  syncHarness();
  memberForm.elements.apiKey.placeholder = tx(m?.config?.hasKey ? '已配置；留空保留，输入新 Key 替换' : '留空使用 OpenCode 已有凭据');
  $('#member-title').textContent = tx(onlyAlias ? '编辑别名' : m ? '配置成员' : '邀请新成员');
  $('#member-subtitle').textContent = onlyAlias ? tx('给 @{name} 起个熟悉的名字。', { name: m.name }) : m ? `@${m.name} · OpenCode` : tx('给它一个名字，让新的视角加入讨论。');
  $('#member-help').textContent = tx(onlyAlias ? '别名可以随时修改，不影响 @ 标识和现有会话。' : '每位成员拥有独立会话。连接配置变更后，会开启新会话，历史消息保留。');
  memberForm.querySelector('[type="submit"]').textContent = tx(m ? '保存修改' : '添加成员');
  $('#member-error').textContent = '';
  $('#member-dialog').showModal();
  if (!onlyAlias && !(modelLists.opencode || []).length) $('#refresh-models').click();
}
$('#add-member').onclick = () => editMember();
$('#member-cancel').onclick = () => $('#member-dialog').close();
$('#member-close').onclick = () => $('#member-dialog').close();
$('#member-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.currentTarget.close(); } });
document.addEventListener('click', async e => {
  const alias = e.target.closest('[data-member-alias]'); if (alias) editMember(alias.dataset.memberAlias, true);
  const b = e.target.closest('[data-member-edit]'); if (b) editMember(b.dataset.memberEdit);
  const d = e.target.closest('[data-member-delete]');
  if (d && confirm(tx('移除 @{name}？历史消息保留。', { name: d.dataset.memberDelete }))) {
    try { const res = await post('/api/member/delete', { name: d.dataset.memberDelete });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || tx('移除失败'));
    } catch (err) { alert(err.message); }
  }
});
memberForm.onsubmit = async e => {
  e.preventDefault();
  const button = memberForm.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(memberForm)); body.clearKey = memberForm.elements.clearKey.checked;
    const res = await post(aliasOnly ? '/api/member/alias' : '/api/member/save', body);
    const data = await res.json(); if (!res.ok) throw new Error(data.error || tx('保存失败'));
    $('#member-dialog').close();
  } catch (err) { $('#member-error').textContent = err.message; }
  finally { button.disabled = false; }
};
document.addEventListener('change', e => {
  const d = e.target.dataset;
  if (d.enable) post('/api/settings', { enabled: { [d.enable]: e.target.checked } });
  if (d.voice) post('/api/settings', { ttsVoices: { [d.voice]: e.target.value } });
  if ('userName' in d) post('/api/settings', { userName: e.target.value });
  if (d.model) {
    let value = e.target.value;
    if (value === '__custom__') { value = prompt(tx('填写真实模型 ID（OpenCode 使用 provider/model）'), member(d.model)?.model || '');
      if (value === null || !value.trim()) { e.target.value = member(d.model)?.model || ''; return; } value = value.trim(); }
    post('/api/settings', { models: { [d.model]: value } });
  }
});
for (const k of ['autoStop', 'devil', 'circlePause', 'memory', 'exec', 'blind', 'outsider', 'userPlays']) $('#s-' + k).onchange = e => post('/api/settings', { [k]: e.target.checked });
document.addEventListener('click', e => { if (e.target.closest('[data-gamenew]')) post('/api/game/new'); });
document.addEventListener('click', e => { if (e.target.closest('[data-gameend]') && confirm(tx('结束这局游戏？之后的消息就是普通聊天。'))) post('/api/game/end'); });
$('#outsider-now').onclick = async () => { const r = await post('/api/outsider'); if (!r.ok) alert((await r.json().catch(() => ({}))).error || tx('请求失败')); };
for (const k of ['turnCap', 'readSpeed', 'maxThinkers', 'scheduler', 'convergeAt', 'noveltyMin'])
  $('#s-' + k).addEventListener('change', e => post('/api/settings', { [k]: e.target.value }));
$('#s-uiLang').options[0].textContent = LANG === 'en' ? 'Auto (English)' : '自动（中文）'; // which one Auto gave this browser
$('#s-uiLang').onchange = async e => { await post('/api/settings', { uiLang: e.target.value }); location.reload(); };

function setReply(id) {
  replyTo = id;
  const m = messages.find(x => x.id === id), q = $('#quote');
  q.style.display = id ? 'block' : 'none';
  if (id) q.innerHTML = `<span class="q"><span>${tx('回复 {ref}', { ref: `#${id}` })} ${esc(label(m?.sender))}${tx('：')}${esc((m?.text || '').slice(0, 80))}</span><button class="icon" id="unquote" style="width:20px;height:20px" aria-label="${tx('取消引用')}">✕</button></span>`;
  if (id) { $('#unquote').onclick = ev => { ev.stopPropagation(); setReply(null); }; $('#input').focus(); }
}

// The composer grows with its content.
const grow = () => { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 220) + 'px'; };
// Typing holds the publish queue; the server forgets the hold 15s after the last ping.
let lastPing = 0;
function typing() {
  const has = $('#input').value.trim() !== '';
  if (!has) { lastPing = 0; return post('/api/typing', { typing: false }); }
  if (Date.now() - lastPing > 5000) { lastPing = Date.now(); post('/api/typing', { typing: true }); }
}
$('#input').addEventListener('input', () => { grow(); typing(); });
setInterval(() => { if ($('#input').value.trim()) typing(); }, 5000);

async function sendMsg() {
  const text = $('#input').value.trim();
  if (pending.some(p => !p.file && !p.failed)) return alert(tx('附件还在上传，稍等一下再发送'));
  const files = pending.filter(p => p.file).map(({ file, name, size, type }) => ({ file, name, size, type }));
  if (!text && !files.length) return;
  const r = await post('/api/send', { text, reply_to: replyTo, chat_id: S.chatId, files });
  if (!r.ok) return alert((await r.json().catch(() => ({}))).error || tx('发送失败')); // keep the text for a retry
  $('#input').value = ''; grow(); lastPing = 0; setReply(null);
  pending.length = 0; renderPending();
}

// ---------- attachments ----------
// Uploaded as soon as they are picked, pasted or dropped; the next message carries them.
const pending = []; // {name, size, type, url (image preview), file (once uploaded) | failed}
async function attach(list) {
  for (const f of list) {
    if (f.size > 20e6) { alert(tx('{name} 超过 20MB，没有添加', { name: f.name })); continue; }
    const p = { name: f.name || 'image.png', size: f.size, type: f.type, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '' };
    pending.push(p); renderPending();
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(p.name)}`, { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream' } });
      if (!r.ok) throw new Error(r.status);
      Object.assign(p, await r.json());
    } catch { p.failed = true; }
    renderPending();
  }
}
function renderPending() {
  $('#atts').innerHTML = pending.map((p, i) => `<span class="att-chip${p.failed ? ' failed' : ''}">${p.url ? `<img src="${p.url}" alt="">` : ''}`
    + `<span>${esc(p.name)}${p.failed ? tx('（上传失败）') : p.file ? '' : tx('（上传中…）')}</span>`
    + `<button data-unattach="${i}" title="${tx('移除')}" aria-label="${tx('移除 {name}', { name: esc(p.name) })}">✕</button></span>`).join('');
}
$('#attach').onclick = () => $('#filepick').click();
$('#filepick').onchange = e => { attach([...e.target.files]); e.target.value = ''; };
$('#atts').addEventListener('click', e => { const b = e.target.closest('[data-unattach]'); if (b) { pending.splice(+b.dataset.unattach, 1); renderPending(); } });
$('#input').addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); attach(fs); } });
const mainEl = document.querySelector('main');
mainEl.addEventListener('dragover', e => { if (SHARED || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); mainEl.classList.add('dropping'); });
mainEl.addEventListener('dragleave', e => { if (!mainEl.contains(e.relatedTarget)) mainEl.classList.remove('dropping'); });
mainEl.addEventListener('drop', e => { mainEl.classList.remove('dropping'); if (SHARED || !e.dataTransfer.files.length) return; e.preventDefault(); attach([...e.dataTransfer.files]); });
$('#send').onclick = sendMsg;

// ---------- saved prompts ----------
// Kept on the server (any browser sees them). A prompt remembers the mode it was saved in: using it in an empty
// discussion, or "新讨论", starts that mode; it only fills the input, the user still sends it.
let savedPrompts = [];
function renderPrompts() {
  $('#plist').innerHTML = savedPrompts.map(p => `<div class="prow" data-puse="${p.id}" title="${esc(p.text.slice(0, 300))}">`
    + `<span class="pt">${esc(p.title)}</span>${p.mode ? `<span class="k">${MODE_LABEL[p.mode] || ''}</span>` : ''}`
    + `<button data-pnew="${p.id}" title="${tx(p.mode ? '开一场新讨论（{mode}模式），把它填进输入框' : '开一场新讨论，把它填进输入框', { mode: MODE_LABEL[p.mode] })}">${tx('新讨论')}</button>`
    + `<button data-pdel="${p.id}" title="${tx('删除这条收藏')}" aria-label="${tx('删除')}">✕</button></div>`).join('')
    || `<div class="memempty">${tx('还没有收藏。把 prompt 写进输入框，点“收藏当前输入”。')}</div>`;
}
const fill = p => { $('#input').value = p.text; grow(); $('#input').focus(); $('#prompts').hidden = true; };
$('#fav').onclick = () => { $('#prompts').hidden = !$('#prompts').hidden; };
document.addEventListener('click', e => { if (!$('#prompts').hidden && !e.target.closest('#prompts,#fav')) $('#prompts').hidden = true; });
$('#prompts').addEventListener('click', async e => {
  const b = e.target.closest('[data-psave],[data-puse],[data-pnew],[data-pdel]');
  if (!b) return;
  const p = savedPrompts.find(x => x.id === (b.dataset.puse || b.dataset.pnew || b.dataset.pdel));
  if (b.dataset.pdel) { if (confirm(tx('删除收藏「{title}」？', { title: p.title }))) post('/api/prompts/delete', { id: p.id }); return; }
  if (b.dataset.pnew) {
    const { id } = await (await post('/api/chat/new')).json();
    if (p.mode) await post('/api/chat/mode', { id, mode: p.mode });
    return fill(p);
  }
  if (b.dataset.puse) {
    if (p.mode && !messages.length && S.discussionMode.mode !== p.mode) await post('/api/chat/mode', { id: S.chatId, mode: p.mode });
    return fill(p);
  }
  const text = $('#input').value.trim();
  if (!text) return alert(tx('先把要收藏的 prompt 写进输入框'));
  const title = prompt(tx('给这个 prompt 起个名字'), text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 30))?.trim();
  if (!title || (savedPrompts.some(x => x.title === title) && !confirm(tx('已经有「{title}」，覆盖吗？', { title })))) return;
  const mode = S.discussionMode.mode !== 'auto' ? S.discussionMode.mode : null;
  const r = await post('/api/prompts/save', { title, text, mode });
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || tx('收藏失败'));
});
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); } });
$('#pause').onclick = () => post('/api/pause', { paused: !S.paused });
$('#stop').onclick = () => post('/api/stop');
$('#next').onclick = () => post('/api/next');
$('#title').onclick = () => SHARED || rename(S.chatId);
const more = $('#more'), moreBtn = $('#morebtn');
const showMore = open => { more.classList.toggle('open', open); moreBtn.setAttribute('aria-expanded', open); };
moreBtn.onclick = e => { e.stopPropagation(); showMore(!more.classList.contains('open')); };
document.addEventListener('click', e => { if (!more.contains(e.target) || e.target.closest('button')) showMore(false); });
more.addEventListener('change', () => showMore(false));
$('#share').onclick = async () => {
  const { share } = await (await post('/api/chat/share', { id: S.chatId })).json();
  const url = `${location.origin}/s/${share}`;
  try { await navigator.clipboard.writeText(url); alert(`${tx('已复制只读链接，打开的人只能看这场讨论：')}\n${url}`); }
  catch { prompt(tx('只读链接（打开的人只能看这场讨论）：'), url); }
};

// Discussion mode: Auto shows what Jev chose; picking a mode overrides it from the next turn.
const MODE_LABEL = { research: tx('研究'), roundtable: tx('圆桌'), debate: tx('辩论'), story: tx('故事'), game: tx('博弈') };
function renderMode() {
  const d = S.discussionMode;
  const auto = d.pending ? tx('自动 · 判断中…') : d.auto ? `${tx('自动')} · ${MODE_LABEL[d.auto]}` : tx('自动');
  setHTML('#mode', [['auto', auto], ...Object.entries(MODE_LABEL)]
    .map(([v, l]) => `<option value="${v}" ${v === d.mode ? 'selected' : ''}>${l}</option>`).join(''));
}
$('#mode').onchange = e => post('/api/chat/mode', { id: S.chatId, mode: e.target.value });
// on a phone the list drawer closes, as when picking a discussion, so the input is ready to type in
const newChat = () => { post('/api/chat/new'); if (phone()) closeDrawers(); $('#input').focus(); };
$('#newChat').onclick = newChat;
// Both side panels collapse; the choice is remembered, narrow windows start collapsed. On a phone they are drawers:
// closed on load, one at a time, and tapping outside closes them.
const phone = () => matchMedia('(max-width: 900px)').matches; // drawers (see the CSS)
const panel = (cls, key, wide) => {
  const set = show => { document.body.classList.toggle(cls, !show); if (!phone()) localStorage[key] = show ? '1' : '0'; };
  set(!phone() && (localStorage[key] ? localStorage[key] === '1' : innerWidth >= wide));
  return () => { const show = document.body.classList.contains(cls); if (show && phone()) closeDrawers(); set(show); };
};
const closeDrawers = () => document.body.classList.add('nohist', 'noroom');
const toggleHist = panel('nohist', 'hist', 1100), toggleRoom = panel('noroom', 'room', 1000);
$('#scrim').onclick = closeDrawers;
document.addEventListener('click', e => {
  if (e.target.closest('[data-toggle-hist]')) toggleHist();
  if (e.target.closest('[data-toggle-room]')) toggleRoom();
  if (e.target.closest('[data-new-chat]')) newChat();
});
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); toggleHist(); }
});

// ---------- read-aloud (TTS) and voice input (STT) via the server's LAN speech gateway ----------
function voiceOptions(name) {
  const cur = S.settings.ttsVoices?.[name] || '', def = S.speech.defaults[name];
  const defLabel = S.speech.models.find(t => t.id === def)?.label || def;
  return [{ id: '', label: tx('默认：{v}', { v: tx(defLabel) }) }, ...S.speech.models]
    .map(t => `<option value="${esc(t.id)}" ${t.id === cur ? 'selected' : ''}>${esc(tx(t.label))}</option>`).join('');
}

// Each browser decides for itself whether to read aloud. While it plays (or still has replies to play) it holds the
// server's publish queue, so the next reply appears when the current one has been heard.
// frozen: the room is paused, so the reply being read pauses too and resumes where it was.
const tts = { on: !SHARED && localStorage.tts === '1', queue: [], audio: null, current: null, ping: null, blocked: false, frozen: false, done: null };
function setSpeaking(active) {
  clearInterval(tts.ping); tts.ping = null;
  post('/api/speaking', { speaking: active });
  if (active) tts.ping = setInterval(() => post('/api/speaking', { speaking: true }), 5000);
}
function markSpeaking(id) {
  document.querySelectorAll('.msg.speaking').forEach(el => el.classList.remove('speaking'));
  if (id) $('#m' + id)?.classList.add('speaking');
}
async function playNext() {
  if (tts.current || !tts.on || tts.blocked || tts.frozen) return;
  const id = tts.queue.shift();
  if (!id) { markSpeaking(null); return setSpeaking(false); }
  tts.current = id; markSpeaking(id);
  if (!tts.ping) setSpeaking(true);
  try {
    const r = await fetch('/api/tts?id=' + id);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    const url = URL.createObjectURL(await r.blob());
    tts.audio = new Audio(url);
    const played = await new Promise(res => {
      const a = tts.audio;
      tts.done = () => res(true); // skipped ("next") or stopped
      a.onended = a.onerror = () => res(true);
      a.onpause = () => tts.frozen || res(true);
      if (!tts.frozen) a.play().catch(e => res(e.name !== 'NotAllowedError'));
    });
    tts.done = null;
    URL.revokeObjectURL(url);
    // Blocked by the browser's autoplay rule (no click or key press since the page loaded, e.g. after a refresh): keep
    // this reply first in line and don't hold the room; the next interaction resumes reading.
    if (!played) {
      tts.queue.unshift(id); tts.audio = null; tts.current = null; tts.blocked = true;
      markSpeaking(null); setSpeaking(false); renderTts(); return;
    }
  } catch (err) { console.warn('朗读失败', id, err); }
  tts.audio = null; tts.current = null;
  playNext();
}
function stopSpeaking() {
  tts.queue = [];
  if (tts.audio) tts.audio.pause();
  tts.done?.();
  markSpeaking(null); setSpeaking(false);
}
// While read-aloud is on, keep the screen awake so a phone can be left playing (Screen Wake Lock: HTTPS or localhost).
// The browser drops the lock when the tab is hidden; it is taken again when the tab comes back.
const wake = { lock: null, failedAt: 0 };
async function keepAwake(on) {
  if (!navigator.wakeLock) return;
  if (!on) return void (wake.lock?.release(), wake.lock = null);
  if (wake.lock || document.visibilityState !== 'visible' || Date.now() - wake.failedAt < 30e3) return;
  try { wake.lock = await navigator.wakeLock.request('screen'); wake.lock.onrelease = () => (wake.lock = null); }
  catch { wake.failedAt = Date.now(); }
}
document.addEventListener('visibilitychange', () => keepAwake(tts.on));

function renderTts() {
  keepAwake(tts.on);
  syncFrozen();
  const b = $('#tts');
  b.hidden = !S.speech?.on;
  b.classList.toggle('on', tts.on); b.classList.toggle('blocked', tts.blocked); b.setAttribute('aria-pressed', tts.on);
  b.title = tx(tts.blocked ? '浏览器拦截了自动播放：点一下继续朗读' : tts.on ? '正在朗读新发言（点击关闭）' : '朗读新发言（局域网语音服务）；朗读时暂缓发布下一条');
  const mic = $('#mic');
  mic.hidden = !S.speech?.on;
  // Browsers only allow the microphone on HTTPS or localhost.
  mic.disabled = !window.isSecureContext || !navigator.mediaDevices;
  if (mic.disabled) mic.title = tx('语音输入需要 HTTPS 或 localhost 访问：浏览器不允许在普通 http 局域网地址上使用麦克风');
}
const unblock = () => { tts.blocked = false; renderTts(); playNext(); };
for (const ev of ['pointerdown', 'keydown'])
  addEventListener(ev, e => { if (tts.blocked && !e.target.closest?.('#tts')) unblock(); }, true);
$('#tts').onclick = () => {
  if (tts.blocked) return unblock(); // the click that unblocks shouldn't also turn reading off
  tts.on = !tts.on; localStorage.tts = tts.on ? '1' : '0';
  if (!tts.on) stopSpeaking();
  renderTts();
};
// "Next" also skips the reply being read; "stop" ends reading.
$('#next').addEventListener('click', () => { tts.audio?.pause(); tts.done?.(); });
$('#stop').addEventListener('click', stopSpeaking);
// Pausing the room pauses the reply being read; resuming plays on from where it was (in every open browser).
function syncFrozen() {
  if (tts.frozen === !!S.paused) return;
  tts.frozen = !!S.paused;
  if (tts.frozen) tts.audio?.pause();
  else if (tts.audio) tts.audio.play().catch(() => {});
  else playNext();
}

// Voice input: record, convert to 16 kHz mono WAV in the browser (Azure STT rejects webm/ogg), transcribe on the server.
const rec = { media: null, chunks: [] };
async function toWav16k(blob) {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, 16000, true); buf.setUint32(28, 32000, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}
$('#mic').onclick = async () => {
  const mic = $('#mic');
  if (rec.media) { rec.media.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec.chunks = []; rec.media = new MediaRecorder(stream);
    rec.media.ondataavailable = e => rec.chunks.push(e.data);
    rec.media.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      mic.classList.remove('rec'); mic.disabled = true; rec.media = null;
      try {
        const r = await fetch('/api/stt', { method: 'POST', body: await toWav16k(new Blob(rec.chunks)) });
        const data = await r.json(); if (!r.ok) throw new Error(data.error || r.status);
        const i = $('#input'); i.value = (i.value ? i.value + ' ' : '') + data.text; i.focus(); grow(); typing();
      } catch (err) { alert(tx('语音识别失败：') + err.message); }
      mic.disabled = false;
    };
    rec.media.start(); mic.classList.add('rec'); typing();
  } catch (err) { alert(tx('无法使用麦克风：') + err.message); }
};
