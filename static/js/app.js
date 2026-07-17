import * as db from "./db.js?v=7";
import { buildQuestions, newWordBudget } from "./quiz.js?v=7";
import { icon, brandMark, svgFromString } from "./icons.js?v=8";

const REQUEUE_CAP = 2; // a wrong word re-appears at most this many times per session
const app = () => document.getElementById("app");

const state = { session: null, selectedDecks: new Set() };

// ---------------- tiny DOM helpers ----------------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}
function clear() { app().innerHTML = ""; }
function page(maxW = "max-w-2xl") {
  const w = el("div", { class: `${maxW} mx-auto px-5 py-6 fade-in` });
  app().append(w);
  return w;
}
function toast(msg, ok = false) {
  const t = el("div", { class: "fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl text-white text-sm shadow-lg z-50 flex items-center gap-2" });
  t.style.background = ok ? "#059669" : "#27272a";
  if (ok) t.append(icon("check", "w-4 h-4"));
  t.append(el("span", {}, msg));
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, { method = "POST", body, form } = {}) {
  const headers = {};
  let payload = form;
  if (!form) { headers["Content-Type"] = "application/json"; payload = body ? JSON.stringify(body) : undefined; }
  const r = await fetch(path, { method, headers, body: payload });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return r.json();
}

// ---------------- component helpers ----------------
const SIZES = { sm: "text-sm px-3 py-1.5", md: "text-sm px-4 py-2.5", lg: "text-[15px] px-5 py-3" };
function btn(label, { variant = "primary", icon: ic, onclick, size = "md", cls = "" } = {}) {
  const b = el("button", { class: `btn btn-${variant} ${SIZES[size]} ${cls}`, onclick });
  if (ic) b.append(icon(ic, "w-4 h-4"));
  if (label) b.append(el("span", {}, label));
  return b;
}
function iconBtn(name, { onclick, variant = "ghost", title = "", cls = "" } = {}) {
  const b = el("button", { class: `btn btn-${variant} p-2 ${cls}`, onclick, title, "aria-label": title });
  b.append(icon(name, "w-[18px] h-[18px]"));
  return b;
}
function backBtn(onclick) {
  const b = el("button", { class: "btn btn-ghost text-sm pl-1.5 pr-3 py-1.5 -ml-1.5 mb-4", onclick });
  b.append(icon("arrow-left", "w-4 h-4"), el("span", {}, "返回"));
  return b;
}

// ---------------- Shell header + nav ----------------
function header() {
  return el("header", { class: "flex items-center justify-between mb-5" },
    el("div", { class: "flex items-center gap-2 cursor-pointer", onclick: boot },
      brandMark("w-7 h-7"),
      el("h1", { class: "text-xl font-bold" }, "WordDeck")),
    el("span", { class: "text-xs text-slate-400" }, "本機模式"));
}

// segmented control; the 專案 segment shows an amber dot + count when there are todos
function navBar(active, todoCount = 0) {
  const seg = (label, key, onclick, badge) => {
    const on = active === key;
    const s = el("button", { class: `flex-1 flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition ${on ? "bg-white text-[color:var(--text)] shadow-sm" : "text-slate-500 hover:text-slate-700"}`, onclick }, label);
    if (badge) s.append(el("span", { class: "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[11px] font-semibold" }, String(badge)));
    return s;
  };
  return el("div", { class: "flex gap-1 p-1 mb-6 rounded-xl bg-slate-100" },
    seg("單字庫", "library", renderLibrary),
    seg("專案", "projects", renderProjects, todoCount));
}

// ---------------- Library ----------------
async function renderLibrary() {
  clear();
  const wrap = page("max-w-2xl");
  wrap.append(header());
  let todo = 0;
  try { todo = (await db.listProjects()).filter((p) => !p.doneToday).length; } catch {}
  wrap.append(navBar("library", todo));
  wrap.append(el("div", { class: "flex justify-between items-center mb-4" },
    el("h2", { class: "text-lg font-semibold" }, "我的單字庫"),
    btn("新增單字本", { icon: "plus", onclick: renderImport, size: "sm" })));

  const list = el("div", { class: "space-y-2.5" }, el("p", { class: "text-slate-400 text-sm" }, "載入中…"));
  wrap.append(list);

  let decks;
  try { decks = await db.listDecks(); }
  catch (e) { list.innerHTML = ""; list.append(el("p", { class: "text-red-500 text-sm" }, "讀取失敗:" + e.message)); return; }
  list.innerHTML = "";
  if (!decks.length) {
    list.append(el("div", { class: "card p-8 text-center" },
      icon("layers", "w-10 h-10 mx-auto text-slate-300"),
      el("p", { class: "mt-3 text-slate-500 text-sm" }, "還沒有單字本"),
      el("p", { class: "mt-1 text-slate-400 text-xs" }, "上傳或貼上一份英文單字清單開始")));
    return;
  }

  state.selectedDecks = new Set();
  const startBtn = el("button", { class: "btn btn-primary lg fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full shadow-lg hidden text-[15px]", onclick: () => renderStudySetup([...state.selectedDecks]) });
  startBtn.append(el("span", {}, "開始練習"), icon("arrow-right", "w-4 h-4"));
  wrap.append(startBtn);

  decks.forEach((d) => {
    const cb = el("input", { type: "checkbox", class: "w-5 h-5 accent-indigo-500 shrink-0", onchange: () => {
      cb.checked ? state.selectedDecks.add(d.id) : state.selectedDecks.delete(d.id);
      row.classList.toggle("ring-2", cb.checked);
      row.classList.toggle("ring-indigo-400", cb.checked);
      startBtn.classList.toggle("hidden", state.selectedDecks.size === 0);
    } });
    const row = el("div", { class: "card p-3.5 flex items-center gap-3" },
      cb,
      el("div", { class: "flex-1 min-w-0 flex items-center gap-3 cursor-pointer", onclick: () => cb.click() },
        el("span", { class: "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-50 brand-text" }, icon("layers", "w-5 h-5")),
        el("div", { class: "min-w-0" },
          el("div", { class: "font-medium truncate" }, d.name),
          el("div", { class: "text-xs text-slate-400 mt-0.5" }, `${d.cardCount} 字`))),
      iconBtn("eye", { title: "查看單字", onclick: () => renderDeckDetail(d.id) }),
      iconBtn("trash", { variant: "danger", title: "刪除", onclick: async () => {
        if (!confirm(`刪除「${d.name}」?`)) return;
        try { await db.deleteDeck(d.id); renderLibrary(); } catch (e) { toast(e.message); }
      } }));
    list.append(row);
  });
}

// ---------------- Projects ----------------
const DIR_LABEL = { en2zh: "英→中", zh2en: "中→英", mixed: "混合" };
function goalLabel(p) {
  if (p.goal_type === "per_day") return `每天 ${p.words_per_day || 20} 字`;
  if (p.goal_type === "by_date") return `${p.target_date || ""} 前完成`;
  return "快速測驗";
}

async function renderProjects() {
  clear();
  const wrap = page("max-w-2xl");
  wrap.append(header());
  let projects;
  try { projects = await db.listProjects(); }
  catch (e) { wrap.append(navBar("projects", 0), el("p", { class: "text-red-500 text-sm" }, "讀取失敗:" + e.message)); return; }
  const todo = projects.filter((p) => !p.doneToday).length;
  wrap.append(navBar("projects", todo));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-4" }, "我的專案"));

  if (!projects.length) {
    wrap.append(el("div", { class: "card p-8 text-center" },
      icon("target", "w-10 h-10 mx-auto text-slate-300"),
      el("p", { class: "mt-3 text-slate-600 font-medium" }, "還沒有專案"),
      el("p", { class: "mt-1 text-slate-400 text-xs leading-relaxed" }, "專案會記住你選好的單字本範圍、方向與目標,還會提醒你今天做了沒。"),
      el("p", { class: "mt-1 text-slate-400 text-xs leading-relaxed" }, "到單字庫勾選單字本 → 開始 → 在練習設定填「專案名稱」即可建立。"),
      btn("去單字庫建立", { onclick: renderLibrary, size: "sm", cls: "mt-4 mx-auto" })));
    return;
  }

  projects.sort((a, b) => (a.doneToday === b.doneToday ? 0 : a.doneToday ? 1 : -1));
  const list = el("div", { class: "space-y-3" });
  wrap.append(list);

  projects.forEach((p) => {
    const scope = p.deckNames.length
      ? (p.deckNames.length <= 2 ? p.deckNames.join("、") : `${p.deckNames.length} 個單字本`)
      : "(單字本已刪除)";
    const status = p.doneToday
      ? el("span", { class: "chip bg-emerald-50 text-emerald-700" }, icon("check-circle", "w-3.5 h-3.5"), "今天已完成")
      : el("span", { class: "chip bg-amber-50 text-amber-700" }, icon("bell", "w-3.5 h-3.5"), `今天還沒做${p.dueCount ? ` · ${p.dueCount} 待複習` : ""}`);
    const cont = el("button", { class: "btn btn-primary flex-1 py-2.5 text-sm", onclick: () => startSession({
      direction: p.direction, deckIds: p.deck_ids, goalType: p.goal_type,
      wordsPerDay: p.words_per_day, targetDate: p.target_date,
      quickCount: p.goal_type === "none" ? 20 : undefined, projectId: p.id,
    }) });
    cont.append(icon("play", "w-4 h-4"), el("span", {}, "繼續"));
    list.append(el("div", { class: "card p-4" },
      el("div", { class: "flex items-start justify-between gap-3" },
        el("div", { class: "flex-1 min-w-0" },
          el("div", { class: "font-semibold truncate" }, p.name),
          el("div", { class: "text-xs text-slate-400 mt-0.5 truncate" }, `${scope} · ${DIR_LABEL[p.direction] || p.direction} · ${goalLabel(p)}`),
          el("div", { class: "mt-2" }, status)),
        iconBtn("trash", { variant: "danger", title: "刪除專案", onclick: async () => {
          if (!confirm(`刪除專案「${p.name}」?(不會刪到單字本)`)) return;
          try { await db.deleteProject(p.id); renderProjects(); } catch (e) { toast(e.message); }
        } })),
      el("div", { class: "mt-3 flex gap-2" }, cont,
        btn("查看單字", { variant: "secondary", icon: "eye", size: "sm", onclick: () => renderProjectDetail(p.id) }))));
  });
}

// ---------------- Detail views (查看單字) ----------------
function reviewChip(r) {
  if (!r) return el("span", { class: "chip bg-slate-100 text-slate-500 shrink-0" }, "新");
  const due = new Date(r.due_at);
  const overdue = due <= new Date();
  const md = `${due.getMonth() + 1}/${due.getDate()}`;
  return overdue
    ? el("span", { class: "chip bg-amber-50 text-amber-700 shrink-0" }, "待複習")
    : el("span", { class: "chip bg-emerald-50 text-emerald-700 shrink-0" }, icon("clock", "w-3 h-3"), md);
}

function renderCardsView(title, subtitle, cards, backFn) {
  clear();
  const wrap = page("max-w-2xl");
  wrap.append(backBtn(backFn));
  wrap.append(el("h2", { class: "text-lg font-semibold" }, title));
  if (subtitle) wrap.append(el("div", { class: "text-xs text-slate-400 mb-3" }, subtitle));
  if (!cards.length) { wrap.append(el("p", { class: "text-slate-400 text-sm mt-2" }, "這裡還沒有單字。")); return; }
  const list = el("div", { class: "card divide-y divide-slate-100 overflow-hidden" });
  cards.forEach((c) => {
    list.append(el("div", { class: "p-3.5 flex items-start gap-3" },
      el("div", { class: "flex-1 min-w-0" },
        el("div", { class: "flex items-center gap-2 flex-wrap" },
          el("span", { class: "font-semibold" }, c.english),
          c.pos ? el("span", { class: "text-xs text-slate-400" }, c.pos) : null,
          c.chinese_ai_filled ? el("span", { class: "chip bg-amber-50 text-amber-600" }, icon("sparkles", "w-3 h-3"), "AI") : null),
        el("div", { class: "text-sm text-slate-600 mt-0.5" }, c.chinese),
        c.example ? el("div", { class: "text-xs text-slate-400 mt-1 italic" }, c.example) : null),
      reviewChip(c.review)));
  });
  wrap.append(list);
}

async function renderDeckDetail(deckId) {
  const deck = await db.getDeck(deckId);
  const cards = await db.getCards([deckId]);
  renderCardsView(deck ? deck.name : "單字本", `${cards.length} 字`, cards, renderLibrary);
}

async function renderProjectDetail(projectId) {
  const proj = await db.getProject(projectId);
  if (!proj) return renderProjects();
  const cards = await db.getCards(proj.deck_ids);
  renderCardsView(proj.name, `${cards.length} 字 · ${DIR_LABEL[proj.direction] || proj.direction} · ${goalLabel(proj)}`, cards, renderProjects);
}

// ---------------- Import ----------------
function parsePastedText(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let eng = "", zh = "";
    const parts = line.split(/[\t,]|\s{2,}/);
    if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(" ").trim()) {
      eng = parts[0].trim();
      zh = parts.slice(1).join(" ").trim();
    } else {
      const m = line.match(/[一-鿿]/);
      if (m) { const i = line.indexOf(m[0]); eng = line.slice(0, i).trim(); zh = line.slice(i).trim(); }
      else { eng = line; zh = ""; }
    }
    if (eng || zh) items.push({ english: eng, chinese: zh, ai_filled: false, pos: "", example: "" });
  }
  return items;
}

function stepHead(n, iconName, title) {
  return el("div", { class: "flex items-center gap-2 mb-2" },
    el("span", { class: "inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-50 brand-text text-[11px] font-bold" }, String(n)),
    icon(iconName, "w-4 h-4 text-slate-400"),
    el("span", { class: "font-medium text-sm" }, title));
}

function renderImport() {
  clear();
  const wrap = page("max-w-2xl");
  wrap.append(backBtn(renderLibrary));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-4" }, "新增單字本"));

  const paste = el("textarea", { class: "w-full border border-slate-200 rounded-xl px-3 py-2.5 h-36 text-sm", placeholder: "一行一個單字,英文和中文用空格/逗號/Tab 隔開,例如:\nresilient  有韌性的\nambiguous  模稜兩可的\n(只有英文也行,中文可之後補或用 AI)" });
  const fileInput = el("input", { type: "file", accept: "image/*,application/pdf", multiple: true, class: "block w-full text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-200 file:text-sm file:bg-white file:text-slate-700" });
  const camInput = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, class: "block w-full text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-slate-200 file:text-sm file:bg-white file:text-slate-700" });
  const result = el("div", { class: "mt-5" });

  async function doExtract(form, count = 1) {
    result.innerHTML = "";
    result.append(el("div", { class: "flex items-center gap-2 text-slate-400 text-sm" }, icon("sparkles", "w-4 h-4"), `AI 辨識 ${count} 個檔案中…(多檔或多頁 PDF 會久一點)`));
    try {
      const data = await api("/api/extract", { form });
      renderPreview(result, data.items);
      if (data.warnings && data.warnings.length) {
        result.insertBefore(el("div", { class: "text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded-lg p-2 mb-2" }, "部分沒處理成功:" + data.warnings.join(";")), result.firstChild);
      }
    } catch (e) {
      result.innerHTML = "";
      result.append(el("p", { class: "text-red-500 text-sm" }, "辨識失敗:" + e.message + "(純文字清單可改用「直接匯入」,不需金鑰)"));
    }
  }

  const dropCls = "border border-dashed border-slate-300 rounded-xl p-4 bg-slate-50/50";
  wrap.append(el("div", { class: "space-y-6" },
    el("div", {},
      stepHead(1, "type", "貼上文字 / CSV(免 AI,最快)"),
      paste,
      el("div", { class: "flex gap-2 mt-2" },
        btn("直接匯入", { variant: "primary", size: "sm", onclick: () => {
          const items = parsePastedText(paste.value);
          if (!items.length) return toast("先貼上一些單字");
          renderPreview(result, items);
        } }),
        btn("用 AI 整理", { variant: "secondary", icon: "sparkles", size: "sm", onclick: () => {
          if (!paste.value.trim()) return toast("先貼上一些單字");
          const f = new FormData(); f.append("text", paste.value);
          doExtract(f);
        } }))),
    el("div", {},
      stepHead(2, "upload", "上傳檔案(PDF / 圖片 / GoodNotes,可一次多個)"),
      el("p", { class: "text-xs text-slate-400 mb-2" }, "圖片/PDF 會傳給 Google Gemini 辨識,需先設 Gemini 金鑰。"),
      el("div", { class: dropCls }, fileInput,
        btn("辨識檔案", { icon: "image", size: "sm", cls: "mt-3", onclick: () => {
          if (!fileInput.files.length) return toast("先選一或多個檔案");
          const f = new FormData();
          for (const file of fileInput.files) f.append("files", file);
          doExtract(f, fileInput.files.length);
        } }))),
    el("div", {},
      stepHead(3, "camera", "拍照 — 用 AI 辨識"),
      el("div", { class: dropCls }, camInput,
        btn("辨識照片", { icon: "camera", size: "sm", cls: "mt-3", onclick: () => {
          if (!camInput.files.length) return toast("先拍照片");
          const f = new FormData();
          for (const file of camInput.files) f.append("files", file);
          doExtract(f, camInput.files.length);
        } }))),
    result));
}

function renderPreview(container, items) {
  container.innerHTML = "";
  const rows = items.map((it) => ({ ...it }));
  const nameInput = el("input", { class: "border border-slate-200 rounded-lg px-3 py-2 w-full text-sm", value: "單字本 " + new Date().toLocaleDateString() });
  const tbody = el("tbody");

  function draw() {
    tbody.innerHTML = "";
    rows.forEach((r, i) => {
      const eng = el("input", { class: "border border-slate-200 rounded-lg px-2 py-1.5 w-full text-sm", value: r.english, oninput: (e) => (r.english = e.target.value) });
      const zh = el("input", { class: `border border-slate-200 rounded-lg px-2 py-1.5 w-full text-sm ${r.ai_filled ? "bg-amber-50" : ""}`, value: r.chinese, oninput: (e) => (r.chinese = e.target.value) });
      tbody.append(el("tr", {},
        el("td", { class: "py-1 pr-1.5" }, eng),
        el("td", { class: "py-1 pr-1.5" }, zh),
        el("td", { class: "py-1 pr-1 text-center w-8" }, r.ai_filled ? el("span", { class: "text-amber-500", title: "AI 補的翻譯,請確認" }, icon("sparkles", "w-4 h-4")) : ""),
        el("td", { class: "py-1 w-8" }, iconBtn("x", { variant: "danger", title: "刪除這列", onclick: () => { rows.splice(i, 1); draw(); }, cls: "p-1" }))));
    });
  }
  draw();

  container.append(
    el("div", { class: "flex items-center gap-2 mb-2 mt-2" }, el("span", { class: "text-sm font-medium whitespace-nowrap" }, "名稱"), nameInput),
    el("p", { class: "text-xs text-slate-400 mb-2" }, `共 ${rows.length} 字。只有英文、沒中文的列存檔時會略過(先補上中文)。`),
    el("div", { class: "card p-3" },
      el("table", { class: "w-full" },
        el("thead", {}, el("tr", { class: "text-left text-slate-400 text-xs" },
          el("th", { class: "pb-1 font-normal" }, "English"), el("th", { class: "pb-1 font-normal" }, "中文"), el("th", { class: "w-8" }, ""), el("th", { class: "w-8" }, ""))),
        tbody)),
    (() => {
      const save = btn("存入單字庫", { icon: "check", size: "lg", cls: "mt-4 w-full", onclick: async () => {
        const clean = rows.filter((r) => r.english.trim() && r.chinese.trim());
        if (!clean.length) return toast("沒有可存的單字(每列都要有英文+中文)");
        if (save.disabled) return;
        save.disabled = true; save.querySelector("span").textContent = "儲存中…";
        try { await db.saveDeck(nameInput.value.trim() || "未命名", "text", clean); toast("已存入單字庫", true); renderLibrary(); }
        catch (err) { toast("存檔失敗:" + err.message); save.disabled = false; save.querySelector("span").textContent = "存入單字庫"; }
      } });
      return save;
    })());
}

// ---------------- Study setup ----------------
function renderStudySetup(deckIds) {
  clear();
  const wrap = page("max-w-md");
  wrap.append(backBtn(renderLibrary));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-5" }, "設定這次的練習"));

  const nameInput = el("input", { class: "border border-slate-200 rounded-lg px-3 py-2 w-full text-sm", placeholder: "例如:多益 Day1(選填)" });
  const perDay = el("input", { type: "number", value: "20", class: "border border-slate-200 rounded-lg px-2 py-1 w-20 text-sm" });
  const byDate = el("input", { type: "date", class: "border border-slate-200 rounded-lg px-2 py-1 text-sm" });
  const quickCount = el("input", { type: "number", value: "20", class: "border border-slate-200 rounded-lg px-2 py-1 w-20 text-sm" });

  const dir = { v: "en2zh" };
  const md = { v: "scheduled" };
  let goalType = "per_day";

  function pillGroup(label, opts, current, onpick) {
    const mk = (o) => {
      const b = el("button", { class: "px-3.5 py-1.5 rounded-lg border border-slate-200 text-sm transition",
        onclick: (e) => {
          current.v = o.v; onpick && onpick(o.v);
          [...e.currentTarget.parentElement.children].forEach((c) => { c.className = "px-3.5 py-1.5 rounded-lg border border-slate-200 text-sm transition"; });
          e.currentTarget.className = "px-3.5 py-1.5 rounded-lg border brand-border brand-bg text-white text-sm transition";
        } }, o.t);
      return b;
    };
    const btns = opts.map(mk);
    btns[0].className = "px-3.5 py-1.5 rounded-lg border brand-border brand-bg text-white text-sm transition";
    return el("div", { class: "mb-5" }, el("div", { class: "text-sm font-medium mb-2" }, label), el("div", { class: "flex gap-2 flex-wrap" }, btns));
  }

  const schedBox = el("div", { class: "text-sm space-y-2" },
    el("label", { class: "flex items-center gap-2" }, el("input", { type: "radio", name: "goal", checked: true, class: "accent-indigo-500", onchange: () => (goalType = "per_day") }), "每天 ", perDay, " 個新字"),
    el("label", { class: "flex items-center gap-2" }, el("input", { type: "radio", name: "goal", class: "accent-indigo-500", onchange: () => (goalType = "by_date") }), "在 ", byDate, " 前複習完"));
  const quickBox = el("div", { class: "text-sm hidden" }, el("label", { class: "flex items-center gap-2" }, "這次考 ", quickCount, " 題"));

  wrap.append(
    el("div", { class: "mb-5" },
      el("div", { class: "text-sm font-medium mb-2" }, "專案名稱(選填 — 填了就存起來,下次在「專案」一鍵繼續)"),
      nameInput),
    pillGroup("出題方向", [{ v: "en2zh", t: "英→中" }, { v: "zh2en", t: "中→英" }, { v: "mixed", t: "混合" }], dir),
    pillGroup("模式", [{ v: "scheduled", t: "間隔複習排程" }, { v: "quick", t: "快速測驗" }], md, (v) => {
      schedBox.classList.toggle("hidden", v !== "scheduled");
      quickBox.classList.toggle("hidden", v !== "quick");
    }),
    schedBox, quickBox,
    btn("開始", { icon: "play", size: "lg", cls: "mt-6 w-full", onclick: async (e) => {
      const cfg = { direction: dir.v, deckIds };
      if (md.v === "scheduled") {
        cfg.goalType = goalType;
        cfg.wordsPerDay = goalType === "per_day" ? parseInt(perDay.value) || 20 : null;
        cfg.targetDate = goalType === "by_date" ? byDate.value || null : null;
      } else {
        cfg.goalType = "none";
        cfg.quickCount = parseInt(quickCount.value) || 20;
      }
      const pname = nameInput.value.trim();
      if (pname) {
        e.currentTarget.disabled = true;
        try { const proj = await db.saveProject(pname, deckIds, cfg.direction, cfg.goalType, cfg.wordsPerDay, cfg.targetDate); cfg.projectId = proj.id; }
        catch (err) { /* non-fatal */ }
      }
      startSession(cfg);
    } }));
}

// ---------------- Session / quiz runner ----------------
async function startSession(cfg) {
  clear();
  page("max-w-md").append(el("div", { class: "flex items-center gap-2 text-slate-400 text-sm mt-10 justify-center" }, icon("clock", "w-4 h-4"), "準備題目中…"));
  try {
    const plan = { goal_type: cfg.goalType, words_per_day: cfg.wordsPerDay, target_date: cfg.targetDate };
    const { due, fresh } = await db.getStudyBatch(cfg.deckIds);
    let cards;
    if (cfg.goalType === "none") {
      cards = [...due, ...fresh].slice(0, cfg.quickCount || 20);
    } else {
      const budget = newWordBudget(plan, fresh.length);
      cards = [...due, ...fresh.slice(0, Math.max(0, budget))];
    }
    if (!cards.length) {
      clear();
      const w = page("max-w-md");
      w.append(el("div", { class: "text-center mt-16" },
        el("div", { class: "inline-flex text-emerald-500" }, icon("check-circle", "w-12 h-12")),
        el("p", { class: "mt-3 text-slate-600" }, "目前沒有要練習的單字"),
        btn("回上一頁", { variant: "secondary", size: "sm", cls: "mt-4 mx-auto", onclick: cfg.projectId ? renderProjects : renderLibrary })));
      return;
    }
    const questions = await buildQuestions(cards, cfg.direction, db.getToken);
    state.session = { questions, idx: 0, score: 0, attempts: [], answered: new Set(), requeue: {}, wrong: [], direction: cfg.direction, total: questions.length, projectId: cfg.projectId || null };
    renderQuestion();
  } catch (e) {
    clear();
    page("max-w-md").append(el("p", { class: "text-red-500 text-sm mt-6" }, "無法開始:" + e.message));
  }
}

function renderQuestion() {
  const s = state.session;
  clear();
  if (s.idx >= s.questions.length) return renderResults();
  const q = s.questions[s.idx];
  const wrap = page("max-w-md");

  const pct = Math.round((s.idx / s.questions.length) * 100);
  wrap.append(el("div", { class: "flex items-center gap-3 mb-6" },
    iconBtn("x", { title: "結束", onclick: s.projectId ? renderProjects : renderLibrary, cls: "-ml-2" }),
    el("div", { class: "flex-1 h-2 rounded-full bg-slate-100 overflow-hidden" },
      el("div", { class: "h-full rounded-full brand-bg transition-all", style: `width:${pct}%` })),
    el("span", { class: "text-sm text-slate-400 tabular-nums" }, `${s.idx + 1}/${s.questions.length}`)));

  wrap.append(el("div", { class: "text-center text-3xl font-bold my-12 px-2 break-words" }, q.prompt));

  const optWrap = el("div", { class: "space-y-2.5" });
  wrap.append(optWrap);
  q.options.forEach((opt) => {
    optWrap.append(el("button", { class: "w-full card px-4 py-3.5 text-[15px] text-left hover:brand-border hover:bg-indigo-50/30 transition", onclick: (e) => answer(opt, e.currentTarget, optWrap) }, opt));
  });
}

async function answer(chosen, btnEl, optWrap) {
  const s = state.session;
  const q = s.questions[s.idx];
  const correct = chosen.trim() === q.answer.trim();

  [...optWrap.children].forEach((b) => {
    b.disabled = true;
    const isAns = b.textContent === q.answer;
    b.className = "w-full card px-4 py-3.5 text-[15px] text-left flex items-center justify-between transition";
    if (isAns) { b.classList.add("!border-emerald-400", "bg-emerald-50", "text-emerald-800"); b.append(icon("check", "w-5 h-5 text-emerald-500")); }
    else if (b === btnEl) { b.classList.add("!border-red-300", "bg-red-50", "text-red-700"); b.append(icon("x", "w-5 h-5 text-red-400")); }
    else b.classList.add("opacity-50");
  });

  if (!s.answered.has(q.cardId)) {
    s.answered.add(q.cardId);
    if (correct) s.score++;
    else s.wrong.push({ prompt: q.prompt, answer: q.answer });
    s.attempts.push({ cardId: q.cardId, wasCorrect: correct, chosen });
    try { await db.recordReview(q.cardId, correct); } catch (e) { /* local write */ }
  }
  if (!correct && (s.requeue[q.cardId] || 0) < REQUEUE_CAP) {
    s.requeue[q.cardId] = (s.requeue[q.cardId] || 0) + 1;
    s.questions.push({ ...q });
  }

  const last = s.idx + 1 >= s.questions.length;
  const next = btn(last ? "看結果" : "下一題", { icon: last ? "check" : "arrow-right", size: "lg", cls: "mt-6 w-full", onclick: () => { s.idx++; renderQuestion(); } });
  optWrap.parentElement.append(next);
}

function progressRing(pct) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" style="transform:rotate(-90deg)">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="#ececef" stroke-width="10"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="#5b5bd6" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
  </svg>`;
  return svgFromString(svg, "w-32 h-32");
}

async function renderResults() {
  const s = state.session;
  clear();
  try { await db.saveQuizResult(s.direction, s.score, s.total, s.attempts); } catch (e) { /* non-fatal */ }
  if (s.projectId) { try { await db.touchProjectStudied(s.projectId); } catch (e) { /* non-fatal */ } }
  const wrap = page("max-w-md");
  const pct = s.total ? Math.round((s.score / s.total) * 100) : 0;
  const resIcon = pct >= 80 ? "award" : pct >= 50 ? "flame" : "sprout";
  const resColor = pct >= 80 ? "text-amber-500" : pct >= 50 ? "text-orange-500" : "text-emerald-500";
  const msg = pct >= 80 ? "太強了!" : pct >= 50 ? "不錯,繼續加油" : "多練幾次就會了";

  const ring = el("div", { class: "relative w-32 h-32 mx-auto mt-8 mb-4" }, progressRing(pct));
  ring.append(el("div", { class: "absolute inset-0 flex flex-col items-center justify-center" },
    el("div", { class: "text-3xl font-bold tabular-nums" }, `${s.score}/${s.total}`),
    el("div", { class: "text-xs text-slate-400" }, `答對 ${pct}%`)));

  wrap.append(el("div", { class: "text-center" }, ring,
    el("div", { class: `inline-flex items-center gap-1.5 ${resColor} font-medium` }, icon(resIcon, "w-5 h-5"), msg)));

  if (s.wrong.length) {
    const box = el("div", { class: "card p-4 mt-6 text-left" },
      el("div", { class: "flex items-center gap-1.5 mb-2 text-red-500 font-medium text-sm" }, icon("bell", "w-4 h-4"), `錯題本(${s.wrong.length})`));
    s.wrong.forEach((w) => box.append(el("div", { class: "text-sm py-1.5 border-b border-slate-200 last:border-0 flex justify-between gap-3" },
      el("span", { class: "text-slate-700" }, w.prompt), el("span", { class: "text-slate-400" }, w.answer))));
    wrap.append(box);
  }
  wrap.append(btn(s.projectId ? "完成,回專案" : "完成,回單字庫", { size: "lg", cls: "mt-6 w-full", onclick: s.projectId ? renderProjects : renderLibrary }));
}

// ---------------- Boot (no login — straight into the app) ----------------
async function boot() {
  let hasProjects = false;
  try { hasProjects = (await db.listProjects()).length > 0; } catch {}
  hasProjects ? renderProjects() : renderLibrary();
}
boot();
