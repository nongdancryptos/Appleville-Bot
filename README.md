# Appleville-Bot

Bot “spin” cho tính năng **Wheel Spin** của Appleville.  
Tập trung **học xác suất realtime** từ kết quả trả về của API và **đặt cược thông minh** dựa trên kỳ vọng (EV) + biên an toàn thống kê.  
**Không can thiệp hệ thống / RNG** – chỉ tối ưu quyết định theo dữ liệu hợp lệ.

> Repo gợi ý: `https://github.com/nongdancryptos/Appleville-Bot.git`  
> Các file chính trong thư mục gốc:
>
> - `spin-pro.js` – bot thông minh (1 file duy nhất).
> - `data.txt` – danh sách cookie đăng nhập, mỗi dòng 1 tài khoản.
> - `proxy.txt` *(tuỳ chọn)* – danh sách proxy, mỗi dòng 1 proxy.
> - `README.md` – tài liệu này.

---

## 1) Yêu cầu

- **Node.js 18+** (khuyến nghị 20+ hoặc 22+).
- Kết nối mạng ổn định.
- Tài khoản Appleville đang đăng nhập được (có cookie `session-token` hợp lệ).

> Kiểm tra phiên bản:
> ```bash
> node -v
> ```

---

## 2) Cài đặt

```bash
# Clone repo
git clone https://github.com/nongdancryptos/Appleville-Bot.git
cd Appleville-Bot

# Cài gói cần thiết (chỉ 1 gói)
npm i undici
```

> Repo này dùng ESM (`"type": "module"` trong `package.json`), vì vậy file chính là `spin-pro.js` (không dùng `require`).

---

## 3) Chuẩn bị cấu hình

### 3.1 `data.txt` (bắt buộc)

- Mỗi **dòng** là **cookie đầy đủ** của phiên Appleville (bao gồm `__Host-authjs...`, `session-token=...`).
- Không có tiêu đề, không khoảng trắng cuối dòng.
- Ví dụ (rút gọn minh hoạ – **đừng** copy y nguyên):
  ```
  __Host-authjs.csrf-token=...; __Secure-authjs.callback-url=https%3A%2F%2F0.0.0.0%3A3000; session-token=eyJhbGciOi...
  ```

> Cách nhanh để lấy cookie: đăng nhập Appleville trên trình duyệt → F12 **Network** → request bất kỳ đến `app.appleville.xyz` → tab **Headers** → **Request Headers** → **cookie** → copy toàn bộ.

### 3.2 `proxy.txt` (tuỳ chọn)

- Mỗi dòng một proxy:
  ```
  http://user:pass@host:port
  http://host:port
  ```
- Nếu không có file này, bot sẽ gọi trực tiếp (không proxy).

---

## 4) Chạy bot

```bash
node spin-pro
```

- Bot sẽ chạy **tuần tự** qua các tài khoản trong `data.txt`.  
- Mặc định **log từng lệnh** (mỗi vòng quay), ví dụ:

```
===== ACCOUNT #1 (pro) =====
[1] t=1 bet=1000 on GREEN → landed=GREEN | net=+150 | PnL=+150 | EV(G)~+1.25% EV(GREEN)~+1.25%
[1] t=2 bet=1100 on BLUE  → landed=BLUE  | net=+4400 | PnL=+4550 | EV(G)~-3.10% EV(BLUE)~+4.20% | anti
...
```

### Tốc độ & backoff

- Nhịp bình thường: ~**160–420ms**/lượt.
- Nếu gặp **429/5xx** (rate limit / server bận), bot **tự giãn nhịp** tạm thời rồi tiếp tục.

---

## 5) Cách hoạt động (tóm tắt)

- **Học realtime**:
  - Cửa sổ **ngắn (W1)** + **trung (W2)**, thêm **EMA** để nhạy mà vẫn ổn định.
  - Ước lượng xác suất rơi cho từng màu → tính EV = p × payout − 1.

- **Quyết định thông minh**:
  - **Ensemble** 4 “não”:  
    **EV-mean**, **EV-upper** (Wilson CI), **Thompson Sampling**, **Markov bậc-1**.
  - **Gate an toàn**: chỉ rời **GREEN** khi **EV_lcb(color)** > **EV(GREEN)** + **margin** (tránh lao vào RED/GOLD khi dữ liệu mỏng).
  - **Anti-green**: nếu EV(GREEN) âm kéo dài, bot ưu tiên BLUE (khi có edge).

- **Quản trị rủi ro**:
  - **Kelly 1/4** + **auto-ramp theo EV**, nắp bet `[MIN_BET, MAX_BET]`.
  - **Volatility targeting** (giảm bet khi biến động cao).
  - **Firewall** khi thua liên tiếp; **tilt-guard** khi drawdown ngắn hạn lớn (cooldown ngắn, co bet).

> **Lưu ý quan trọng**: Theo bảng odds **chính thức** (RED 0.5%, GOLD 4%, BLUE 15%, GREEN 80.5% với payout [150x, 20x, 5x, 1.15x]) thì **tất cả cửa đều âm EV**; nhỏ nhất là **GREEN (~-7.4%)**. Bot chỉ **tăng cược** khi dữ liệu quan sát cho thấy một cửa nào đó có **edge dương có ý nghĩa** (biên dưới Wilson vượt mốc hoà vốn). Nếu không có edge, bot sẽ duy trì **minbet** để giảm lỗ kỳ vọng.

---

## 6) Cấu trúc file

```
Appleville-Bot/
├─ spin-pro.js        # file chạy chính (ESM)
├─ data.txt           # cookie mỗi dòng 1 tài khoản
├─ proxy.txt          # (tuỳ chọn) proxy mỗi dòng 1 proxy
└─ README.md          # tài liệu này
```

---

## 7) Câu hỏi thường gặp

**Q1. Bot có “hack” hệ thống không?**  
Không. Bot chỉ đọc phản hồi hợp lệ từ API public của ứng dụng, học tần suất rơi thực tế và ra quyết định đặt cược dựa trên EV + thống kê.

**Q2. Vì sao vẫn có thể thua?**  
Vì house edge âm theo thiết kế trò chơi. Bot chỉ giúp **giảm thua kỳ vọng** và **tăng kỷ luật giao dịch**; không thể đảm bảo lợi nhuận dài hạn nếu xác suất thực đúng như bảng.

**Q3. Chạy nhiều tài khoản cùng lúc được không?**  
File hiện chạy tuần tự qua từng dòng trong `data.txt`. Bạn có thể mở nhiều tiến trình `node spin-pro` trên máy/VM/proxy khác nhau.

---

## 8) Giấy phép

Mã nguồn phục vụ mục đích học thuật và thử nghiệm. Sử dụng chịu rủi ro của bạn. Không chịu trách nhiệm cho các thiệt hại trực tiếp hoặc gián tiếp phát sinh.

---

## 9) Góp ý / Liên hệ

Tạo issue/pull request trên GitHub repo của bạn: `nongdancryptos/Appleville-Bot`.
<!-- Code display (SVG) -->
<p align="center">
  <img src="https://raw.githubusercontent.com/nongdancryptos/nongdancryptos/refs/heads/main/QR-Code/readme.svg" alt="Donation Wallets (SVG code card)" />
</p>
