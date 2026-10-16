// Telegram vocabulary practice bot (Cloudflare Worker).
// The bot shows a Vietnamese meaning, you type the English word, it checks.
//
// Bindings (see wrangler.toml / README):
//   VOCAB_KV            KV namespace for session state and review schedule
//   TELEGRAM_BOT_TOKEN  secret
//   WEBHOOK_SECRET      secret, protects /webhook and /setup
//   ALLOWED_CHAT_ID     secret, only this chat may use the bot
//   WORDS_URLS          var, comma-separated raw JSON URLs
//   DAILY_COUNT         var, max words per day (default 15)
//   NEW_PER_DAY         var, max new words per day (default 5)

const TZ_OFFSET_MS = 7 * 3600 * 1000; // Vietnam time
const MAX_TRIES = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/setup") return setup(url, env);
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, env);
      } catch (e) {
        console.error(e);
      }
      return new Response("ok");
    }
    return new Response("vocab bot running");
  },

  async scheduled(event, env) {
    const words = await loadWords(env);
    if (!words.length) return;
    const today = todayVN();
    const srs = await getSrs(env, env.ALLOWED_CHAT_ID);
    const { newWords, reviews } = pickToday(words, srs, today, dailyCount(env), newPerDay(env));
    const total = newWords.length + reviews.length;
    if (!total) return;
    await send(env, env.ALLOWED_CHAT_ID,
      `📚 Hôm nay có <b>${total} từ</b> cần học (${reviews.length} ôn tập, ${newWords.length} mới).\n` +
      `Gõ /learn để bắt đầu.`,
      [["▶️ Học ngay", "/learn"], ["⏭ Bỏ qua hôm nay", "/skipday"]]);
  },
};

// ---------- setup ----------

async function setup(url, env) {
  if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const res = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "learn", description: "Bắt đầu / tiếp tục học từ hôm nay" },
      { command: "hint", description: "Gợi ý từ hiện tại" },
      { command: "skip", description: "Xem đáp án và qua từ tiếp" },
      { command: "today", description: "Danh sách từ hôm nay" },
      { command: "stats", description: "Xem tiến độ học" },
      { command: "more", description: "Học thêm từ mới (vd: /more 10)" },
      { command: "skipday", description: "Bỏ qua bài hôm nay" },
      { command: "stop", description: "Tạm dừng phiên học" },
    ],
  });
  return Response.json(res);
}

// ---------- words ----------

export async function loadWords(env) {
  const urls = (env.WORDS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const all = [];
  for (const u of urls) {
    const r = await fetch(u, { cf: { cacheTtl: 300 } });
    if (!r.ok) continue;
    const data = await r.json();
    for (const w of data.words || []) all.push(w);
  }
  return all;
}

export function todayVN(now = Date.now()) {
  return new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function dailyCount(env) {
  return parseInt(env.DAILY_COUNT || "15", 10);
}

function newPerDay(env) {
  return parseInt(env.NEW_PER_DAY || "5", 10);
}

export function addDays(isoDate, n) {
  return new Date(Date.parse(isoDate + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

// ---------- spaced repetition (SM-2) ----------
// Each word the learner has seen gets a record in srs[word]:
//   { reps, interval, ease, due, lapses, seen, correct, history: [[date, grade], ...] }
// Grades: 5 right first try, 4 one-letter typo, 3 right after 1 hint/miss,
// 2 right after 2 hints/misses, 1 skipped or revealed. Below 3 counts as forgotten.

export function review(rec, grade, today) {
  const r = rec ? { ...rec } : { reps: 0, interval: 0, ease: 2.5, lapses: 0, seen: 0, correct: 0, history: [] };
  if (grade < 3) {
    r.reps = 0;
    r.interval = 1;
    r.lapses += 1;
  } else {
    r.interval = r.reps === 0 ? 1 : r.reps === 1 ? 3 : Math.round(r.interval * r.ease);
    r.reps += 1;
    r.correct += 1;
  }
  r.ease = Math.max(1.3, r.ease + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
  r.ease = Math.round(r.ease * 100) / 100;
  r.seen += 1;
  r.due = addDays(today, r.interval);
  r.history = [...r.history, [today, grade]].slice(-20);
  return r;
}

// Due reviews first (most overdue, then hardest), then unseen words in the
// order they were added, at most NEW_PER_DAY new words and DAILY_COUNT total.
export function pickToday(words, srs, today, total, maxNew) {
  const due = words
    .filter((w) => srs[w.word] && srs[w.word].due <= today)
    .sort((a, b) => srs[a.word].due.localeCompare(srs[b.word].due) || srs[a.word].ease - srs[b.word].ease);
  const unseen = words.filter((w) => !srs[w.word]);
  const newWords = unseen.slice(0, Math.min(maxNew, total));
  const reviews = due.slice(0, Math.max(total - newWords.length, 0));
  return { newWords, reviews, dueTotal: due.length };
}

export function gradeFor(result, tries) {
  if (result === "exact" && tries === 0) return 5;
  if (tries === 0) return 4;
  if (tries === 1) return 3;
  return 2;
}

async function getSrs(env, chatId) {
  const raw = await env.VOCAB_KV.get(`srs:${chatId}`);
  return raw ? JSON.parse(raw) : {};
}

async function saveSrs(env, chatId, srs) {
  await env.VOCAB_KV.put(`srs:${chatId}`, JSON.stringify(srs));
}

// ---------- answer checking ----------

export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

// Returns "exact", "typo" or "wrong".
export function check(answer, word) {
  const a = normalize(answer);
  const w = normalize(word);
  if (a === w) return "exact";
  if (w.length >= 5 && editDistance(a, w) === 1) return "typo";
  return "wrong";
}

function hintText(w, tries) {
  const e = esc;
  if (tries === 1) {
    const pattern = w.word
      .split(" ")
      .map((part) => part[0] + " _".repeat(part.length - 1))
      .join("   ");
    return `💡 Gợi ý: <code>${e(pattern)}</code> (${w.word.replace(/ /g, "").length} chữ cái)`;
  }
  if (w.example) {
    const re = new RegExp(w.word.split(" ").map(escapeRe).join("\\s+(?:\\w+\\s+)?") + "\\w*", "i");
    const blanked = w.example.replace(re, "_____");
    if (blanked !== w.example) return `💡 Gợi ý: <i>${e(blanked)}</i>`;
  }
  return `💡 Gợi ý: bắt đầu bằng <b>${e(w.word.slice(0, 2))}</b>`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- formatting ----------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function promptText(w, idx, total) {
  let s = `📝 <b>Từ ${idx}/${total}</b>\n➜ <b>${esc(w.meaning)}</b> (${esc(w.pos)})`;
  if (w.example_vi) s += `\nVí dụ: <i>${esc(w.example_vi)}</i>`;
  s += `\n\nGõ từ tiếng Anh:`;
  return s;
}

export function card(w) {
  const lines = [`<b>${esc(w.word)}</b> (${esc(w.pos)}) ${esc(w.ipa || "")}`, `➜ ${esc(w.meaning)}`];
  if (w.example) lines.push(`<i>${esc(w.example)}</i>`);
  const fam = w.family || [];
  if (fam.length) {
    lines.push("Họ từ:");
    for (const f of fam) {
      let s = `• <b>${esc(f.word)}</b> (${esc(f.pos)})${f.ipa ? " " + esc(f.ipa) : ""}: ${esc(f.meaning)}`;
      if (f.note) s += `\n  ⚠️ ${esc(f.note)}`;
      lines.push(s);
    }
  }
  return lines.join("\n");
}

// ---------- session ----------

async function getSession(env, chatId) {
  const raw = await env.VOCAB_KV.get(`session:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(env, chatId, s) {
  await env.VOCAB_KV.put(`session:${chatId}`, JSON.stringify(s), { expirationTtl: 3 * 86400 });
}

async function newSession(env, chatId, today) {
  const words = await loadWords(env);
  const srs = await getSrs(env, chatId);
  const { newWords, reviews } = pickToday(words, srs, today, dailyCount(env), newPerDay(env));
  const list = [...reviews, ...newWords];
  return {
    date: today, queue: list, total: list.length, done: 0, tries: 0, correct: 0,
    missed: [], retried: [], graded: [], newCount: newWords.length, reviewCount: reviews.length,
  };
}

// Record the first result of a word in this session into its SM-2 schedule.
async function grade(env, chatId, s, w, g) {
  if (s.graded.includes(w.word)) return null;
  s.graded.push(w.word);
  const srs = await getSrs(env, chatId);
  srs[w.word] = review(srs[w.word], g, s.date);
  await saveSrs(env, chatId, srs);
  return srs[w.word];
}

function nextText(rec) {
  if (!rec) return "";
  return rec.interval === 1 ? "\n🗓 Ôn lại: ngày mai" : `\n🗓 Ôn lại sau ${rec.interval} ngày`;
}

export function statsText(words, srs, today) {
  const recs = Object.values(srs);
  const seen = recs.length;
  const due = recs.filter((r) => r.due <= today).length;
  const mature = recs.filter((r) => r.interval >= 21).length;
  const learning = seen - mature;
  const tries = recs.reduce((a, r) => a + r.seen, 0);
  const right = recs.reduce((a, r) => a + r.correct, 0);
  const hard = Object.entries(srs)
    .filter(([, r]) => r.lapses > 0)
    .sort((a, b) => b[1].lapses - a[1].lapses || a[1].ease - b[1].ease)
    .slice(0, 5)
    .map(([k, r]) => `<b>${esc(k)}</b> (quên ${r.lapses} lần)`);
  let t = `📊 <b>Tiến độ</b>\n` +
    `Tổng số từ trong kho: ${words.length}\n` +
    `Chưa học: ${Math.max(words.length - seen, 0)}\n` +
    `Đang học: ${learning}\n` +
    `Đã thuộc (ôn cách ≥ 21 ngày): ${mature}\n` +
    `Đến hạn ôn hôm nay: ${due}\n` +
    `Tỉ lệ đúng: ${tries ? Math.round((right / tries) * 100) : 0}% (${right}/${tries})`;
  if (hard.length) t += `\nTừ hay quên: ${hard.join(", ")}`;
  return t;
}

export async function handleUpdate(update, env) {
  let msg = update.message;
  if (update.callback_query) {
    const q = update.callback_query;
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    if (!q.message) return;
    msg = { chat: q.message.chat, text: q.data };
  }
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (env.ALLOWED_CHAT_ID && chatId !== String(env.ALLOWED_CHAT_ID)) {
    await send(env, chatId, `Bot này là bot riêng. Chat id của bạn: <code>${chatId}</code>`);
    return;
  }
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  const today = todayVN();
  let s = await getSession(env, chatId);

  if (cmd === "/start") {
    await send(env, chatId,
      "Chào bạn! Mỗi lượt mình gửi <b>nghĩa tiếng Việt</b>, bạn gõ <b>từ tiếng Anh</b>.\n" +
      "Từ nào bạn hay quên sẽ được nhắc lại dày hơn, từ đã thuộc sẽ giãn dần ra.\n\n" +
      "/learn bắt đầu học\n/hint gợi ý\n/skip xem đáp án\n/more học thêm từ mới (vd: /more 10)\n/skipday bỏ qua bài hôm nay\n/today danh sách từ hôm nay\n/stats tiến độ\n/stop tạm dừng");
    return;
  }

  if (cmd === "/stats") {
    await send(env, chatId, statsText(await loadWords(env), await getSrs(env, chatId), today));
    return;
  }

  if (cmd === "/today") {
    const fresh = s && s.date === today ? s : await newSession(env, chatId, today);
    if (!fresh.queue.length) {
      await send(env, chatId, "Hôm nay không còn từ nào cần học. 🎉");
      return;
    }
    const lines = fresh.queue.map((w, i) => `${i + 1}. <b>${esc(w.word)}</b>: ${esc(w.meaning)}`);
    await send(env, chatId, `📚 Từ còn lại hôm nay (${fresh.queue.length}):\n` + lines.join("\n"));
    return;
  }

  if (cmd === "/done") {
    await send(env, chatId, "Hẹn gặp lại bạn ngày mai! 👋");
    return;
  }

  if (cmd === "/skipday") {
    if (!s || s.date !== today) s = await newSession(env, chatId, today);
    const left = s.queue.length;
    s.queue = [];
    s.skipped = true;
    await saveSession(env, chatId, s);
    await send(env, chatId,
      left ? `Đã bỏ qua ${left} từ hôm nay. Từ đến hạn ôn sẽ dời sang mai, từ mới vẫn giữ nguyên chưa học.`
           : "Hôm nay không còn từ nào để bỏ qua.",
      [["▶️ Vẫn muốn học", "/learn"]]);
    return;
  }

  if (cmd === "/more") {
    const n = Math.min(Math.max(parseInt(text.split(/\s+/)[1], 10) || newPerDay(env), 1), 50);
    if (!s || s.date !== today) s = await newSession(env, chatId, today);
    const words = await loadWords(env);
    const srs = await getSrs(env, chatId);
    const inSession = new Set([...s.queue.map((w) => w.word), ...s.graded]);
    let extra = words.filter((w) => !srs[w.word] && !inSession.has(w.word)).slice(0, n);
    let label = "từ mới";
    if (!extra.length) {
      // No new words left: review the words whose next review is closest.
      extra = words
        .filter((w) => srs[w.word] && !inSession.has(w.word))
        .sort((a, b) => srs[a.word].due.localeCompare(srs[b.word].due))
        .slice(0, n);
      label = "từ ôn sớm (kho đã hết từ mới)";
    }
    if (!extra.length) {
      await send(env, chatId, "Kho từ đã hết, bạn đã học tất cả rồi. 🎉");
      return;
    }
    const wasIdle = !s.queue.length;
    s.queue.push(...extra);
    s.total += extra.length;
    s.newCount += extra.length;
    s.skipped = false;
    await saveSession(env, chatId, s);
    let t = `➕ Đã thêm ${extra.length} ${label}.`;
    if (wasIdle) t += `\n\n${promptText(s.queue[0], s.done + 1, s.total)}`;
    await send(env, chatId, t);
    return;
  }

  if (cmd === "/learn") {
    // A skipped day is rebuilt, so /learn after /skipday brings the words back.
    if (!s || s.date !== today || s.skipped) s = await newSession(env, chatId, today);
    if (!s.queue.length) {
      const t = s.skipped ? "Bạn đã bỏ qua bài hôm nay."
        : s.total ? "Hôm nay bạn học xong rồi. 🎉" : "Hôm nay không có từ nào đến hạn ôn. 🎉";
      await send(env, chatId, t, moreButtons(env));
      return;
    }
    await saveSession(env, chatId, s);
    const intro = s.done === 0 ? `Bắt đầu: ${s.reviewCount} từ ôn tập, ${s.newCount} từ mới.\n\n` : "";
    await send(env, chatId, intro + promptText(s.queue[0], s.done + 1, s.total));
    return;
  }

  if (!s || !s.queue.length) {
    await send(env, chatId, "Gõ /learn để bắt đầu học từ hôm nay.");
    return;
  }

  if (cmd === "/stop") {
    await send(env, chatId, `Đã tạm dừng. Bạn làm đúng ${s.correct}/${s.done} lượt. Gõ /learn để học tiếp các từ còn lại.`);
    return;
  }

  const w = s.queue[0];

  if (cmd === "/hint") {
    s.tries = Math.min(s.tries + 1, MAX_TRIES - 1);
    await saveSession(env, chatId, s);
    await send(env, chatId, hintText(w, s.tries));
    return;
  }

  if (cmd === "/skip") {
    await reveal(env, chatId, s, w, "⏭ Đáp án:");
    return;
  }

  if (cmd) {
    await send(env, chatId, "Lệnh không hợp lệ. Gõ /start để xem hướng dẫn.");
    return;
  }

  const result = check(text, w.word);
  if (result !== "wrong") {
    const rec = await grade(env, chatId, s, w, gradeFor(result, s.tries));
    s.correct += 1;
    s.queue.shift();
    s.done += 1;
    s.tries = 0;
    const head = result === "exact" ? "✅ Chính xác!" : `✅ Gần đúng! Viết đúng là: <b>${esc(w.word)}</b>`;
    await saveSession(env, chatId, s);
    await send(env, chatId, `${head}${nextText(rec)}\n\n${card(w)}`);
    await next(env, chatId, s);
    return;
  }

  s.tries += 1;
  if (s.tries >= MAX_TRIES) {
    await reveal(env, chatId, s, w, "❌ Chưa đúng. Đáp án:");
    return;
  }
  await saveSession(env, chatId, s);
  await send(env, chatId, `❌ Chưa đúng, thử lại nhé.\n${hintText(w, s.tries)}`);
}

// Show the answer; a missed word comes back once at the end of the queue.
async function reveal(env, chatId, s, w, head) {
  const rec = await grade(env, chatId, s, w, 1);
  s.queue.shift();
  s.tries = 0;
  if (!s.retried.includes(w.word)) {
    s.retried.push(w.word);
    s.queue.push(w);
    s.total += 1;
  }
  s.done += 1;
  if (!s.missed.includes(w.word)) s.missed.push(w.word);
  await saveSession(env, chatId, s);
  await send(env, chatId, `${head}${nextText(rec)}\n\n${card(w)}`);
  await next(env, chatId, s);
}

async function next(env, chatId, s) {
  if (s.queue.length) {
    await send(env, chatId, promptText(s.queue[0], s.done + 1, s.total));
    return;
  }
  let summary = `🎉 Xong bài hôm nay! Đúng ${s.correct}/${s.done} lượt.`;
  if (s.missed.length) summary += `\nTừ bị quên (sẽ nhắc lại ngày mai): ${s.missed.map((x) => `<b>${esc(x)}</b>`).join(", ")}`;
  summary += `\nGõ /stats để xem tiến độ. Muốn học thêm không?`;
  await send(env, chatId, summary, moreButtons(env));
}

// ---------- telegram ----------

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

function send(env, chatId, text, buttons) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (buttons) {
    body.reply_markup = { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: data }))] };
  }
  return tg(env, "sendMessage", body);
}

function moreButtons(env) {
  return [[`➕ Học thêm ${newPerDay(env)} từ`, "/more"], ["✅ Đủ rồi", "/done"]];
}
