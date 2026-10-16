"""Send today's vocabulary to Telegram.

New words (added since the previous day) always go first; the rest of the
daily quota is filled by rotating through older words for review.

Env:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  required
  WORDS_PER_DAY                         optional, default 5
  DRY_RUN=1                             print instead of sending
"""
import datetime as dt
import glob
import html
import json
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TZ = dt.timezone(dt.timedelta(hours=7))  # Vietnam time
MAX_LEN = 4000  # Telegram limit is 4096 characters per message


def load_words():
    words = []
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "*.json"))):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for w in data.get("words", []):
            w.setdefault("book", data.get("book", ""))
            words.append(w)
    return words


def pick(words, today, n):
    yesterday = (today - dt.timedelta(days=1)).isoformat()
    new = [w for w in words if w.get("added", "") >= yesterday]
    old = [w for w in words if w not in new]
    review = []
    if old and n > len(new):
        k = min(n - len(new), len(old))
        start = (today.toordinal() * k) % len(old)
        review = [old[(start + i) % len(old)] for i in range(k)]
    return new, review


def fmt_word(w, idx):
    e = html.escape
    lines = [f"<b>{idx}. {e(w['word'])}</b> ({e(w.get('pos', ''))}) {e(w.get('ipa', ''))}",
             f"➜ {e(w.get('meaning', ''))}"]
    if w.get("example"):
        lines.append(f"<i>{e(w['example'])}</i>")
    if w.get("example_vi"):
        lines.append(f"({e(w['example_vi'])})")
    fam = w.get("family") or []
    if fam:
        lines.append("Họ từ:")
        for f in fam:
            s = f"• <b>{e(f['word'])}</b> ({e(f.get('pos', ''))}) {e(f.get('ipa', ''))}: {e(f.get('meaning', ''))}"
            if f.get("example"):
                s += f". <i>{e(f['example'])}</i>"
            lines.append(s)
            if f.get("note"):
                lines.append(f"  ⚠️ {e(f['note'])}")
    return "\n".join(lines)


def build_messages(new, review, today):
    blocks = [f"📚 <b>Từ vựng ngày {today.strftime('%d/%m/%Y')}</b>"]
    i = 1
    if new:
        blocks.append("🆕 <b>Từ mới</b>")
        for w in new:
            blocks.append(fmt_word(w, i)); i += 1
    if review:
        blocks.append("🔁 <b>Ôn tập</b>")
        for w in review:
            blocks.append(fmt_word(w, i)); i += 1
    msgs, cur = [], ""
    for b in blocks:
        if cur and len(cur) + len(b) + 2 > MAX_LEN:
            msgs.append(cur); cur = ""
        cur = f"{cur}\n\n{b}" if cur else b
    if cur:
        msgs.append(cur)
    return msgs


def send(token, chat_id, text):
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text,
                                   "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.load(r)
    if not body.get("ok"):
        raise RuntimeError(body)


def main():
    today = dt.datetime.now(TZ).date()
    n = int(os.environ.get("WORDS_PER_DAY", "5"))
    words = load_words()
    if not words:
        print("No words yet."); return
    new, review = pick(words, today, n)
    msgs = build_messages(new, review, today)
    if os.environ.get("DRY_RUN") == "1":
        print("\n\n-----\n\n".join(msgs)); return
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        sys.exit("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret.")
    for m in msgs:
        send(token, chat_id, m)
    print(f"Sent {len(new)} new + {len(review)} review words in {len(msgs)} message(s).")


if __name__ == "__main__":
    main()
