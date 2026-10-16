# vocabulary

Kho từ vựng tiếng Anh học từ sách, kèm nhắc học hằng ngày qua Telegram.

- `data/*.json`: từ vựng, mỗi sách một file (hiện có `oracle-essentials.json`).
- `scripts/send_daily.py`: chọn từ của ngày (từ mới thêm từ hôm qua đến nay, cộng từ cũ để ôn) và gửi qua Telegram.
- `.github/workflows/daily-vocab.yml`: chạy 08:00 giờ Việt Nam mỗi ngày. Có thể chạy tay ở tab **Actions → Daily vocabulary → Run workflow**.

## Cài đặt Telegram

1. Trên Telegram, chat với **@BotFather**, gõ `/newbot` và làm theo hướng dẫn để lấy **bot token**.
2. Mở bot vừa tạo và gửi cho nó một tin nhắn bất kỳ (ví dụ `hi`).
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` trên trình duyệt, tìm `"chat":{"id": ...}` để lấy **chat id**.
4. Trong repo này: **Settings → Secrets and variables → Actions → New repository secret**, tạo:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. (Tuỳ chọn) Tab **Variables**: tạo `WORDS_PER_DAY` để đổi số từ mỗi ngày (mặc định 5).

Đổi giờ nhắc: sửa dòng `cron` trong workflow (giờ UTC, giờ Việt Nam = UTC + 7).

## Định dạng một từ

```json
{
  "word": "comprehend",
  "pos": "v",
  "ipa": "/ˌkɒmprɪˈhend/",
  "meaning": "hiểu thấu, lĩnh hội",
  "example": "It takes time to comprehend how Oracle manages memory.",
  "example_vi": "Cần thời gian để hiểu thấu cách Oracle quản lý bộ nhớ.",
  "source": "Chapter 1",
  "added": "2026-10-16",
  "family": [
    { "word": "comprehension", "pos": "n", "ipa": "/ˌkɒmprɪˈhenʃn/", "meaning": "sự hiểu", "example": "...", "note": "..." }
  ]
}
```

Xem thử tin nhắn mà không gửi: `DRY_RUN=1 python scripts/send_daily.py`

## Bot luyện từ tương tác

Thư mục `bot/` là bot Telegram dạng hỏi đáp (bot gửi nghĩa tiếng Việt, bạn gõ từ tiếng Anh), chạy trên Cloudflare Workers. Xem [bot/README.md](bot/README.md).
