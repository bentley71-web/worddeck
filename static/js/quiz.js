// Quiz building: turn cards into multiple-choice questions with distractors.
// Default distractors come from the selected decks (free, relevantly confusable);
// when a deck is too small we ask the backend for AI "smart" distractors.

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = (x || "").trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(x.trim());
    }
  }
  return out;
}

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

function sample(pool, n) {
  return shuffle(pool).slice(0, n);
}

export async function buildQuestions(cards, direction, getToken) {
  const questions = cards.map((c) => {
    let dir = direction;
    if (dir === "mixed") dir = Math.random() < 0.5 ? "en2zh" : "zh2en";
    const prompt = dir === "en2zh" ? c.english : c.chinese;
    const answer = dir === "en2zh" ? c.chinese : c.english;
    const answerLang = dir === "en2zh" ? "zh" : "en";
    return { cardId: c.id, dir, prompt, answer, answerLang, options: null };
  });

  const poolZh = uniq(cards.map((c) => c.chinese));
  const poolEn = uniq(cards.map((c) => c.english));
  const need = { zh: [], en: [] };

  questions.forEach((q) => {
    const base = q.answerLang === "zh" ? poolZh : poolEn;
    const pool = base.filter((x) => x.toLowerCase() !== q.answer.trim().toLowerCase());
    const picks = sample(pool, 3);
    if (picks.length >= 3) q.options = shuffle([q.answer, ...picks]);
    else need[q.answerLang].push(q);
  });

  for (const lang of ["zh", "en"]) {
    const qs = need[lang];
    if (!qs.length) continue;
    const answers = qs.map((q) => q.answer);
    let filled = false;
    try {
      const token = await getToken();
      const resp = await fetch("/api/smart-distractors", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ answers, lang }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const byI = {};
        (data.items || []).forEach((d) => (byI[d.i] = d.distractors));
        qs.forEach((q, k) => {
          const ds = uniq(byI[k] || []).filter((x) => x.toLowerCase() !== q.answer.toLowerCase()).slice(0, 3);
          if (ds.length >= 1) q.options = shuffle([q.answer, ...ds]);
        });
        filled = true;
      }
    } catch (e) {
      /* fall through to pool padding */
    }
    // final fallback: pad from whatever pool exists (may yield <4 options)
    qs.forEach((q) => {
      if (q.options) return;
      const base = q.answerLang === "zh" ? poolZh : poolEn;
      const pool = base.filter((x) => x.toLowerCase() !== q.answer.trim().toLowerCase());
      q.options = shuffle([q.answer, ...sample(pool, 3)]);
    });
  }

  return questions.filter((q) => q.options && q.options.length >= 2);
}

// New-word budget for a plan/session.
export function newWordBudget(plan, remainingNew) {
  if (!plan || plan.goal_type === "none") return remainingNew; // no scheduling → all
  if (plan.goal_type === "per_day") return plan.words_per_day || 20;
  if (plan.goal_type === "by_date" && plan.target_date) {
    const days = Math.max(1, Math.ceil((new Date(plan.target_date) - new Date()) / 86400000));
    return Math.ceil(remainingNew / days);
  }
  return 20;
}
