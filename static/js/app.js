import * as db from "./db.js?v=5";
import { buildQuestions, newWordBudget } from "./quiz.js?v=5";

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
function toast(msg, ok = false) {
  const t = el("div", { class: `fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-white shadow-lg z-50 ${ok ? "bg-emerald-600" : "bg-slate-800"}` }, msg);
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

// ---------------- Shell header ----------------
function header() {
  return el("header", { class: "flex items-center justify-between mb-4" },
    el("h1", { class: "text-2xl font-bold cursor-pointer", onclick: boot }, "WordDeck"),
    el("span", { class: "text-xs text-slate-400" }, "本機模式 · 資料存在這台裝置"));
}

// two-tab nav; the 專案 tab shows a red badge = number of projects not done today
function navBar(active, todoCount = 0) {
  const tab = (label, key, onclick, badge) => {
    const b = el("button", { class: `px-4 py-1.5 rounded-lg text-sm font-medium ${active === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`, onclick }, label);
    if (badge) b.append(el("span", { class: "ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px]" }, String(badge)));
    return b;
  };
  return el("div", { class: "flex gap-2 mb-5" },
    tab("單字庫", "library", renderLibrary),
    tab("專案", "projects", renderProjects, todoCount));
}

// ---------------- Library ----------------
async function renderLibrary() {
  clear();
  const wrap = el("div", { class: "max-w-3xl mx-auto p-5" }, header());
  app().append(wrap);
  let todo = 0;
  try { todo = (await db.listProjects()).filter((p) => !p.doneToday).length; } catch {}
  wrap.append(navBar("library", todo));
  const list = el("div", { class: "space-y-3" }, el("p", { class: "text-slate-400" }, "載入中…"));
  wrap.append(
    el("div", { class: "flex justify-between items-center mb-4" },
      el("h2", { class: "text-lg font-semibold" }, "我的單字庫"),
      el("button", { class: "bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium", onclick: renderImport }, "+ 新增單字本")),
    list);

  let decks;
  try { decks = await db.listDecks(); }
  catch (e) { list.innerHTML = ""; list.append(el("p", { class: "text-red-500" }, "讀取失敗:" + e.message)); return; }
  list.innerHTML = "";
  if (!decks.length) { list.append(el("p", { class: "text-slate-400" }, "還沒有單字本。點右上角上傳或貼上一份吧。")); return; }

  state.selectedDecks = new Set();
  const startBtn = el("button", { class: "fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-600 text-white rounded-full px-6 py-3 font-medium shadow-lg hidden", onclick: () => renderStudySetup([...state.selectedDecks]) }, "用選取的單字本開始 →");
  wrap.append(startBtn);

  decks.forEach((d) => {
    const cb = el("input", { type: "checkbox", class: "w-5 h-5", onchange: () => {
      cb.checked ? state.selectedDecks.add(d.id) : state.selectedDecks.delete(d.id);
      startBtn.classList.toggle("hidden", state.selectedDecks.size === 0);
    } });
    list.append(el("div", { class: "flex items-center gap-3 border rounded-xl p-4 bg-white" },
      cb,
      el("div", { class: "flex-1", onclick: () => cb.click() },
        el("div", { class: "font-medium" }, d.name),
        el("div", { class: "text-sm text-slate-500" }, `${d.cardCount} 字`)),
      el("button", { class: "text-slate-300 hover:text-red-500", onclick: async () => {
        if (!confirm(`刪除「${d.name}」?`)) return;
        try { await db.deleteDeck(d.id); renderLibrary(); } catch (e) { toast(e.message); }
      } }, "🗑")));
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
  const wrap = el("div", { class: "max-w-3xl mx-auto p-5" }, header());
  app().append(wrap);
  let projects;
  try { projects = await db.listProjects(); }
  catch (e) { wrap.append(navBar("projects", 0), el("p", { class: "text-red-500" }, "讀取失敗:" + e.message)); return; }
  const todo = projects.filter((p) => !p.doneToday).length;
  wrap.append(navBar("projects", todo));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-4" }, "我的專案"));

  if (!projects.length) {
    wrap.append(el("div", { class: "text-slate-500 text-sm space-y-2 border rounded-xl p-4 bg-white" },
      el("p", { class: "font-medium text-slate-700" }, "還沒有專案"),
      el("p", {}, "專案 = 記住你選好的「單字本範圍 + 出題方向 + 目標」,下次一鍵繼續,還會提醒你今天做了沒。"),
      el("p", {}, "建立方式:到「單字庫」勾選單字本 → 開始 → 在練習設定填一個「專案名稱」即可。"),
      el("button", { class: "mt-1 bg-blue-600 text-white rounded-lg px-4 py-2", onclick: renderLibrary }, "去單字庫建立")));
    return;
  }

  // 今天還沒做的排前面
  projects.sort((a, b) => (a.doneToday === b.doneToday ? 0 : a.doneToday ? 1 : -1));
  const list = el("div", { class: "space-y-3" });
  wrap.append(list);

  projects.forEach((p) => {
    const scope = p.deckNames.length
      ? (p.deckNames.length <= 2 ? p.deckNames.join("、") : `${p.deckNames.length} 個單字本`)
      : "(單字本已刪除)";
    const status = p.doneToday
      ? el("div", { class: "text-sm text-emerald-600 mt-1 font-medium" }, "✅ 今天已完成")
      : el("div", { class: "text-sm text-red-500 mt-1 font-medium" }, `🔴 今天還沒做${p.dueCount ? ` · ${p.dueCount} 待複習` : ""}`);
    list.append(el("div", { class: "border rounded-xl p-4 bg-white" },
      el("div", { class: "flex items-start justify-between gap-3" },
        el("div", { class: "flex-1 min-w-0" },
          el("div", { class: "font-medium" }, p.name),
          el("div", { class: "text-xs text-slate-500 mt-0.5" }, `${scope} · ${DIR_LABEL[p.direction] || p.direction} · ${goalLabel(p)}`),
          status),
        el("button", { class: "text-slate-300 hover:text-red-500 shrink-0", onclick: async () => {
          if (!confirm(`刪除專案「${p.name}」?(不會刪到單字本)`)) return;
          try { await db.deleteProject(p.id); renderProjects(); } catch (e) { toast(e.message); }
        } }, "🗑")),
      el("button", { class: "mt-3 w-full bg-emerald-600 text-white rounded-lg py-2 font-medium", onclick: () => startSession({
        direction: p.direction, deckIds: p.deck_ids, goalType: p.goal_type,
        wordsPerDay: p.words_per_day, targetDate: p.target_date,
        quickCount: p.goal_type === "none" ? 20 : undefined, projectId: p.id,
      }) }, "繼續 →")));
  });
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
      const m = line.match(/[一-鿿]/); // first Chinese char
      if (m) { const i = line.indexOf(m[0]); eng = line.slice(0, i).trim(); zh = line.slice(i).trim(); }
      else { eng = line; zh = ""; }
    }
    if (eng || zh) items.push({ english: eng, chinese: zh, ai_filled: false, pos: "", example: "" });
  }
  return items;
}

function renderImport() {
  clear();
  const wrap = el("div", { class: "max-w-2xl mx-auto p-5" });
  app().append(wrap);
  wrap.append(el("button", { class: "text-slate-500 text-sm mb-4", onclick: renderLibrary }, "← 返回"));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-1" }, "新增單字本"));

  const paste = el("textarea", { class: "w-full border rounded-lg px-3 py-2 h-40", placeholder: "一行一個單字,英文和中文用空格/逗號/Tab 隔開,例如:\nresilient  有韌性的\nambiguous  模稜兩可的\n(只有英文也行,中文可之後補或用 AI)" });
  const fileInput = el("input", { type: "file", accept: "image/*,application/pdf", multiple: true, class: "block" });
  const camInput = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, class: "block" });
  const result = el("div", { class: "mt-4" });

  async function doExtract(form, count = 1) {
    result.innerHTML = "";
    result.append(el("p", { class: "text-slate-400" }, `AI 辨識 ${count} 個檔案中…(多檔或多頁 PDF 會久一點)`));
    try {
      const data = await api("/api/extract", { form });
      renderPreview(result, data.items);
      if (data.warnings && data.warnings.length) {
        result.insertBefore(
          el("div", { class: "text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded p-2 mb-2" }, "部分沒處理成功:" + data.warnings.join(";")),
          result.firstChild);
      }
    } catch (e) {
      result.innerHTML = "";
      result.append(el("p", { class: "text-red-500" }, "辨識失敗:" + e.message + "(純文字清單可改用上面「直接匯入」,不需金鑰)"));
    }
  }

  wrap.append(el("div", { class: "space-y-4" },
    el("div", {},
      el("div", { class: "font-medium mb-1" }, "① 貼上文字 / CSV(免 AI,最快)"),
      paste,
      el("div", { class: "flex gap-2 mt-2" },
        el("button", { class: "bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm", onclick: () => {
          const items = parsePastedText(paste.value);
          if (!items.length) return toast("先貼上一些單字");
          renderPreview(result, items);
        } }, "直接匯入"),
        el("button", { class: "border rounded-lg px-4 py-2 text-sm", onclick: () => {
          if (!paste.value.trim()) return toast("先貼上一些單字");
          const f = new FormData(); f.append("text", paste.value);
          doExtract(f);
        } }, "用 AI 整理(補中文/例句)"))),
    el("hr"),
    el("div", {},
      el("div", { class: "font-medium mb-1" }, "② 上傳檔案(PDF / 圖片 / GoodNotes,可一次選多個)— 用 AI 辨識"),
      el("p", { class: "text-xs text-slate-400 mb-1" }, "圖片/PDF 會傳給 Google Gemini 辨識,需先在 .env 設 Gemini 金鑰。"),
      fileInput,
      el("button", { class: "mt-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm", onclick: () => {
        if (!fileInput.files.length) return toast("先選一或多個檔案");
        const f = new FormData();
        for (const file of fileInput.files) f.append("files", file);
        doExtract(f, fileInput.files.length);
      } }, "辨識檔案")),
    el("hr"),
    el("div", {},
      el("div", { class: "font-medium mb-1" }, "③ 拍照 — 用 AI 辨識"),
      camInput,
      el("button", { class: "mt-2 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm", onclick: () => {
        if (!camInput.files.length) return toast("先拍照片");
        const f = new FormData();
        for (const file of camInput.files) f.append("files", file);
        doExtract(f, camInput.files.length);
      } }, "辨識照片")),
    result));
}

function renderPreview(container, items) {
  container.innerHTML = "";
  const rows = items.map((it) => ({ ...it }));
  const nameInput = el("input", { class: "border rounded-lg px-3 py-2 w-full", value: "單字本 " + new Date().toLocaleDateString() });
  const tbody = el("tbody");

  function draw() {
    tbody.innerHTML = "";
    rows.forEach((r, i) => {
      const eng = el("input", { class: "border rounded px-2 py-1 w-full", value: r.english, oninput: (e) => (r.english = e.target.value) });
      const zh = el("input", { class: `border rounded px-2 py-1 w-full ${r.ai_filled ? "bg-amber-50" : ""}`, value: r.chinese, oninput: (e) => (r.chinese = e.target.value) });
      tbody.append(el("tr", { class: "border-b" },
        el("td", { class: "p-1" }, eng),
        el("td", { class: "p-1" }, zh),
        el("td", { class: "p-1 text-center" }, r.ai_filled ? el("span", { class: "text-amber-600 text-xs", title: "AI 補的翻譯,請確認" }, "AI") : ""),
        el("td", { class: "p-1" }, el("button", { class: "text-slate-300 hover:text-red-500", onclick: () => { rows.splice(i, 1); draw(); } }, "✕"))));
    });
  }
  draw();

  container.append(
    el("div", { class: "flex items-center gap-2 mb-2 mt-2" }, el("span", { class: "text-sm font-medium whitespace-nowrap" }, "名稱"), nameInput),
    el("p", { class: "text-xs text-slate-400 mb-1" }, `共 ${rows.length} 字。只有英文、沒中文的列存檔時會略過(先補上中文)。`),
    el("table", { class: "w-full text-sm" },
      el("thead", {}, el("tr", { class: "text-left text-slate-400" },
        el("th", { class: "p-1 font-normal" }, "English"), el("th", { class: "p-1 font-normal" }, "中文"), el("th", { class: "p-1 font-normal w-8" }, ""), el("th", { class: "w-8" }, ""))),
      tbody),
    el("button", { class: "mt-4 w-full bg-emerald-600 text-white rounded-lg py-2.5 font-medium", onclick: async (e) => {
      const clean = rows.filter((r) => r.english.trim() && r.chinese.trim());
      if (!clean.length) return toast("沒有可存的單字(每列都要有英文+中文)");
      const btn = e.target;
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = "儲存中…"; btn.className += " opacity-60";
      try { await db.saveDeck(nameInput.value.trim() || "未命名", "text", clean); toast("已存入單字庫", true); renderLibrary(); }
      catch (err) { toast("存檔失敗:" + err.message); btn.disabled = false; btn.textContent = "存入單字庫"; }
    } }, "存入單字庫"));
}

// ---------------- Study setup ----------------
function renderStudySetup(deckIds) {
  clear();
  const wrap = el("div", { class: "max-w-md mx-auto p-5" });
  app().append(wrap);
  wrap.append(el("button", { class: "text-slate-500 text-sm mb-4", onclick: renderLibrary }, "← 返回"));
  wrap.append(el("h2", { class: "text-lg font-semibold mb-4" }, "設定這次的練習"));

  const nameInput = el("input", { class: "border rounded-lg px-3 py-2 w-full", placeholder: "例如:多益 Day1(選填)" });
  const perDay = el("input", { type: "number", value: "20", class: "border rounded px-2 py-1 w-24" });
  const byDate = el("input", { type: "date", class: "border rounded px-2 py-1" });
  const quickCount = el("input", { type: "number", value: "20", class: "border rounded px-2 py-1 w-24" });

  const dir = { v: "en2zh" };
  const md = { v: "scheduled" };
  let goalType = "per_day";

  function radioGroup(label, opts, current, onpick) {
    const btns = opts.map((o) => el("button", { class: "px-3 py-1.5 rounded-lg border text-sm",
      onclick: (e) => { current.v = o.v; onpick && onpick(o.v); [...e.target.parentElement.children].forEach((c) => c.className = "px-3 py-1.5 rounded-lg border text-sm"); e.target.className = "px-3 py-1.5 rounded-lg border text-sm bg-blue-600 text-white"; } }, o.t));
    btns[0].className += " bg-blue-600 text-white";
    return el("div", { class: "mb-5" }, el("div", { class: "text-sm font-medium mb-2" }, label), el("div", { class: "flex gap-2 flex-wrap" }, btns));
  }

  const schedBox = el("div", { class: "text-sm space-y-2" },
    el("label", { class: "flex items-center gap-2" }, el("input", { type: "radio", name: "goal", checked: true, onchange: () => (goalType = "per_day") }), "每天 ", perDay, " 個新字"),
    el("label", { class: "flex items-center gap-2" }, el("input", { type: "radio", name: "goal", onchange: () => (goalType = "by_date") }), "在 ", byDate, " 前複習完"));
  const quickBox = el("div", { class: "text-sm hidden" }, el("label", { class: "flex items-center gap-2" }, "這次考 ", quickCount, " 題"));

  wrap.append(
    el("div", { class: "mb-5" },
      el("div", { class: "text-sm font-medium mb-2" }, "專案名稱(選填 — 填了就存起來,下次在「專案」一鍵繼續)"),
      nameInput),
    radioGroup("出題方向", [{ v: "en2zh", t: "英→中" }, { v: "zh2en", t: "中→英" }, { v: "mixed", t: "混合" }], dir),
    radioGroup("模式", [{ v: "scheduled", t: "間隔複習排程" }, { v: "quick", t: "快速測驗" }], md, (v) => {
      schedBox.classList.toggle("hidden", v !== "scheduled");
      quickBox.classList.toggle("hidden", v !== "quick");
    }),
    schedBox, quickBox,
    el("button", { class: "mt-6 w-full bg-emerald-600 text-white rounded-lg py-2.5 font-medium", onclick: async (e) => {
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
        e.target.disabled = true;
        try {
          const proj = await db.saveProject(pname, deckIds, cfg.direction, cfg.goalType, cfg.wordsPerDay, cfg.targetDate);
          cfg.projectId = proj.id;
        } catch (err) { /* non-fatal: still start the session */ }
      }
      startSession(cfg);
    } }, "開始"));
}

// ---------------- Session / quiz runner ----------------
async function startSession(cfg) {
  clear();
  app().append(el("div", { class: "max-w-md mx-auto p-5 text-slate-400" }, "準備題目中…"));
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
      app().append(el("div", { class: "max-w-md mx-auto p-5 text-center mt-20" }, el("p", {}, "目前沒有要練習的單字 🎉"), el("button", { class: "mt-4 text-blue-600", onclick: renderLibrary }, "回單字庫")));
      return;
    }
    const questions = await buildQuestions(cards, cfg.direction, db.getToken);
    state.session = { questions, idx: 0, score: 0, attempts: [], answered: new Set(), requeue: {}, wrong: [], direction: cfg.direction, total: questions.length, projectId: cfg.projectId || null };
    renderQuestion();
  } catch (e) {
    clear();
    app().append(el("div", { class: "max-w-md mx-auto p-5 text-red-500" }, "無法開始:" + e.message));
  }
}

function renderQuestion() {
  const s = state.session;
  clear();
  if (s.idx >= s.questions.length) return renderResults();
  const q = s.questions[s.idx];
  const wrap = el("div", { class: "max-w-md mx-auto p-5" });
  app().append(wrap);

  wrap.append(el("div", { class: "flex justify-between text-sm text-slate-400 mb-6" },
    el("button", { onclick: renderLibrary }, "✕ 結束"),
    el("span", {}, `${s.idx + 1} / ${s.questions.length}`),
    el("span", {}, `${s.score} 分`)));
  wrap.append(el("div", { class: "text-center text-3xl font-bold my-10" }, q.prompt));

  const optWrap = el("div", { class: "space-y-3" });
  wrap.append(optWrap);
  q.options.forEach((opt) => {
    optWrap.append(el("button", { class: "w-full border rounded-xl py-3 text-lg hover:bg-slate-50", onclick: (e) => answer(opt, e.target, optWrap) }, opt));
  });
}

async function answer(chosen, btn, optWrap) {
  const s = state.session;
  const q = s.questions[s.idx];
  const correct = chosen.trim() === q.answer.trim();

  [...optWrap.children].forEach((b) => {
    b.disabled = true;
    if (b.textContent === q.answer) b.className = "w-full border rounded-xl py-3 text-lg bg-emerald-100 border-emerald-400";
    else if (b === btn) b.className = "w-full border rounded-xl py-3 text-lg bg-red-100 border-red-400";
    else b.className = "w-full border rounded-xl py-3 text-lg opacity-60";
  });

  if (!s.answered.has(q.cardId)) {
    s.answered.add(q.cardId);
    if (correct) s.score++;
    else s.wrong.push({ prompt: q.prompt, answer: q.answer });
    s.attempts.push({ cardId: q.cardId, wasCorrect: correct, chosen });
    try { await db.recordReview(q.cardId, correct); } catch (e) { /* local write, unlikely */ }
  }
  if (!correct && (s.requeue[q.cardId] || 0) < REQUEUE_CAP) {
    s.requeue[q.cardId] = (s.requeue[q.cardId] || 0) + 1;
    s.questions.push({ ...q });
  }

  const next = el("button", { class: "mt-6 w-full bg-blue-600 text-white rounded-lg py-2.5", onclick: () => { s.idx++; renderQuestion(); } }, s.idx + 1 >= s.questions.length ? "看結果" : "下一題 →");
  optWrap.parentElement.append(next);
}

async function renderResults() {
  const s = state.session;
  clear();
  try { await db.saveQuizResult(s.direction, s.score, s.total, s.attempts); } catch (e) { /* non-fatal */ }
  if (s.projectId) { try { await db.touchProjectStudied(s.projectId); } catch (e) { /* non-fatal */ } }
  const wrap = el("div", { class: "max-w-md mx-auto p-5 text-center" });
  app().append(wrap);
  const pct = s.total ? Math.round((s.score / s.total) * 100) : 0;
  wrap.append(
    el("div", { class: "text-6xl my-6" }, pct >= 80 ? "🎉" : pct >= 50 ? "💪" : "📚"),
    el("h2", { class: "text-2xl font-bold" }, `${s.score} / ${s.total}`),
    el("p", { class: "text-slate-500 mb-6" }, `答對 ${pct}%`));

  if (s.wrong.length) {
    const box = el("div", { class: "text-left border rounded-xl p-4 mb-6" }, el("div", { class: "font-medium mb-2 text-red-600" }, `錯題本(${s.wrong.length})`));
    s.wrong.forEach((w) => box.append(el("div", { class: "text-sm py-1 border-b last:border-0" }, `${w.prompt} → ${w.answer}`)));
    wrap.append(box);
  }
  wrap.append(s.projectId
    ? el("button", { class: "w-full bg-blue-600 text-white rounded-lg py-2.5 font-medium", onclick: renderProjects }, "完成,回專案")
    : el("button", { class: "w-full bg-blue-600 text-white rounded-lg py-2.5 font-medium", onclick: renderLibrary }, "完成,回單字庫"));
}

// ---------------- Boot (no login — straight into the app) ----------------
async function boot() {
  let hasProjects = false;
  try { hasProjects = (await db.listProjects()).length > 0; } catch {}
  hasProjects ? renderProjects() : renderLibrary();
}
boot();
