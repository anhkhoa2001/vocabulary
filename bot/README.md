# Bot luyện từ trên Telegram

Bot gửi **nghĩa tiếng Việt**, bạn gõ **từ tiếng Anh**, bot chấm điểm.

- 08:00 mỗi sáng: "Hôm nay có N từ cần học". Gõ `/learn` để bắt đầu.
- Lịch ôn theo thuật toán **SM-2** (lặp lại ngắt quãng, giống Anki): mỗi ngày chỉ hỏi các từ **đến hạn ôn** cộng tối đa `NEW_PER_DAY` từ mới (mặc định 5), tổng không quá `DAILY_COUNT` (mặc định 15).
- Chấm điểm mỗi từ: đúng ngay 5, sai 1 chữ cái 4, đúng sau 1 gợi ý 3, sau 2 gợi ý 2, bỏ qua hoặc sai hết 1. Dưới 3 là "quên": từ đó được hỏi lại ngay ngày mai. Từ nhớ tốt được giãn dần: 1, 3, 8, 20... ngày.
- Lịch sử đúng sai của từng từ lưu trong KV. Gõ `/stats` để xem tiến độ và các từ hay quên.
- Mỗi từ có 3 lần thử: sai lần 1 gợi ý chữ cái đầu và độ dài, sai lần 2 gợi ý câu ví dụ có chỗ trống, sai lần 3 hiện đáp án.
- Từ bị sai sẽ được hỏi lại một lần ở cuối bài. Gõ sai một chữ cái vẫn tính đúng.
- Lệnh: `/learn`, `/hint`, `/skip`, `/today`, `/stats`, `/stop`.
- Từ vựng đọc trực tiếp từ `data/*.json` trên GitHub, nên thêm từ vào JSON là bot dùng ngay (không cần deploy lại).

## Deploy lên Cloudflare Workers (miễn phí)

Cần Node.js và một tài khoản Cloudflare.

```bash
cd bot
npx wrangler login
npx wrangler kv namespace create VOCAB_KV     # copy "id" vào wrangler.toml thay REPLACE_WITH_KV_ID
npx wrangler secret put TELEGRAM_BOT_TOKEN    # dán token của bot
npx wrangler secret put ALLOWED_CHAT_ID       # dán chat id của bạn
npx wrangler secret put WEBHOOK_SECRET        # tự đặt 1 chuỗi bất kỳ, chỉ gồm chữ, số, _ hoặc -
npx wrangler deploy                           # in ra địa chỉ https://vocab-bot.<tên>.workers.dev
```

Cuối cùng mở trình duyệt vào `https://vocab-bot.<tên>.workers.dev/setup?key=<WEBHOOK_SECRET>` để nối bot với Telegram. Thấy `"ok":true` là xong, vào Telegram gõ `/start`.

Đổi số từ mỗi ngày: sửa `DAILY_COUNT` và `NEW_PER_DAY` trong `wrangler.toml` rồi `npx wrangler deploy` (hoặc trong Settings → Variables trên trang Cloudflare).
