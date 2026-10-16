// Telegram vocabulary practice bot (Cloudflare Worker).
// The bot shows a Vietnamese meaning, you type the English word, it checks.
//
// Bindings (see wrangler.toml / README):
//   VOCAB_KV            KV namespace for session state
//   TELEGRAM_BOT_TOKEN  secret
//   WEBHOOK_SECRET      secret, protects /webhook and /setup
//   ALLOWED_CHAT_ID     secret, only this chat may use the bot
//   WORDS_URLS          var, comma-separated raw JSON URLs
//   DAILY_COUNT         var, words per day (default 15)

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
    const { newWords, review } = pickToday(words, today, dailyCount(env));
    const total = newWords.length + review.length;
    await send(env, env.ALLOWED_CHAT_ID,
      `📚 Hôm nay có <b>${total} từ</b> cần học (${newWords.length} mới, ${review.length} ôn tập).\n` +
      `Gõ /learn để bắt đầu.`);
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
    allowed_updates: ["message"],
  });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "learn", description: "Bắt đầu / tiếp tục học từ hôm nay" },
      { command: "hint", description: "Gợi ý từ hiện tại" },
      { command: "skip", description: "Xem đáp án và qua từ tiếp" },
      { command: "today", description: "Danh sách từ hôm nay" },
      { command: "stop", description: "Dừng phiên học" },
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

function dayNumber(isoDate) {
  return Math.floor(Date.parse(isoDate + "T00:00:00Z") / 86400000);
}

// New words (added since yesterday) first, then rotate through older words.
export function pickToday(words, today, n) {
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  const newWords = words.filter((w) => (w.added || "") >= yesterday);
  const old = words.filter((w) => !newWords.includes(w));
  const review = [];
  const k = Math.min(Math.max(n - newWords.length, 0), old.length);
  if (k > 0) {
    const start = (dayNumber(today) * k) % old.length;
    for (let i = 0; i < k; i++) review.push(old[(start + i) % old.length]);
  }
  return { newWords, review };
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
      let s = `• <b>${esc(f.word)}</b> (${esc(f.pos)})${f.ipa ? " " + esc(f.ipa) : ""}:${esc(f.meaning)}`;
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

async function newSession(env, today) {
  const words = await loadWords(env);
  const { newWords, review } = pickToday(words, today, dailyCount(env));
  const list = [...newWords, ...review];
  return { date: today, queue: list, total: list.length, done: 0, tries: 0, correct: 0, missed: [], retried: [] };
}

export async function handleUpdate(update, env) {
  const msg = update.message;
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
      "Chào bạn! Mỗi lượt mình gửi <b>nghĩa tiếng Việt</b>, bạn gõ <b>từ tiếng Anh</b>.\n\n" +
      "/learn bắt đầu học\n/hint gợi ý\n/skip xem đáp án\n/today danh sách từ hôm nay\n/stop dừng");
    return;
  }

  if (cmd === "/today") {
    const fresh = await newSession(env, today);
    const lines = fresh.queue.map((w, i) => `${i + 1}. <b>${esc(w.word)}</b>: ${esc(w.meaning)}`);
    await send(env, chatId, `📚 Từ hôm nay (${fresh.total}):\n` + lines.join("\n"));
    return;
  }

  if (cmd === "/learn") {
    if (!s || s.date !== today || !s.queue.length) s = await newSession(env, today);
    if (!s.queue.length) {
      await send(env, chatId, "Chưa có từ nào trong kho.");
      return;
    }
    await saveSession(env, chatId, s);
    await send(env, chatId, promptText(s.queue[0], s.done + 1, s.total));
    return;
  }

  if (!s || !s.queue.length) {
    await send(env, chatId, "Gõ /learn để bắt đầu học từ hôm nay.");
    return;
  }

  if (cmd === "/stop") {
    await env.VOCAB_KV.delete(`session:${chatId}`);
    await send(env, chatId, `Đã dừng. Bạn làm đúng ${s.correct}/${s.done} lượt. Gõ /learn để học lại.`);
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
    s.correct += 1;
    s.queue.shift();
    s.done += 1;
    s.tries = 0;
    const head = result === "exact" ? "✅ Chính xác!" : `✅ Gần đúng! Viết đúng là: <b>${esc(w.word)}</b>`;
    await saveSession(env, chatId, s);
    await send(env, chatId, `${head}\n\n${card(w)}`);
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
  await send(env, chatId, `${head}\n\n${card(w)}`);
  await next(env, chatId, s);
}

async function next(env, chatId, s) {
  if (s.queue.length) {
    await send(env, chatId, promptText(s.queue[0], s.done + 1, s.total));
    return;
  }
  let summary = `🎉 Xong bài hôm nay! Đúng ${s.correct}/${s.done} lượt.`;
  if (s.missed.length) summary += `\nCần ôn thêm: ${s.missed.map((x) => `<b>${esc(x)}</b>`).join(", ")}`;
  await send(env, chatId, summary);
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

function send(env, chatId, text) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}
