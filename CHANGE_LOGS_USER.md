Path:CHANGE_LOGS_USER.md
## 2026-04-08 — keepalive remote stop giờ kết thúc hợp lệ với exit code 0

- Khi runner bị đổi owner hoặc nhận remote stop, `keepalive` giờ sẽ thoát với mã `0` theo mặc định để CI hiểu đây là dừng hợp lệ, không phải lỗi.
- Workflow smoke mẫu cũng đã đổi sang kiểm tra exit code `0`.
- Warning `The "i" variable is not set` trong workflow demo đã được loại bỏ bằng cách escape đúng biến shell trong `docker-compose.yml`.

## 2026-04-08 — log stop rõ nghĩa hơn và smoke test không còn gây hiểu nhầm

- Listener giờ phân biệt rõ giữa “mất ownership” và “explicit stop token” cho chính runner hiện tại.
- Workflow smoke không còn đổi value sang `stop-...`; giờ dùng `replacement-...` để nhìn log là biết ngay đang test mất ownership.
- Tài liệu đi kèm đã giải thích rõ 2 trường hợp này để tránh hiểu nhầm khi đọc log runtime.

## 2026-04-08 — workflow smoke đã kiểm tra thật việc keepalive tự dừng nhanh

- File workflow mẫu giờ không còn chỉ chạy `keepalive` rồi chờ thủ công.
- Workflow sẽ tự đổi owner trên Realtime Database, chờ keepalive dừng, rồi kiểm tra log và exit code.
- Nhờ vậy có thể nhìn rõ hơn việc stop có xảy ra nhanh hay không ngay trong smoke test.

## 2026-04-08 — keepalive stop nhanh hơn khi runner bị thay owner

- Runner keepalive giờ sẽ dừng nhanh hơn khi có runner mới giành quyền chạy.
- Không còn phụ thuộc duy nhất vào SSE; hệ thống có thêm polling để kiểm tra giá trị owner trực tiếp trên Realtime Database.
- Khi có tín hiệu stop, tiến trình keepalive sẽ ngắt luôn lệnh docker đang chạy thay vì chờ hết chu kỳ log hiện tại.
- Log stop đã rõ hơn: có nguồn stop, lý do, giá trị owner quan sát được và thời điểm trigger.
- Workflow smoke mẫu đã được chỉnh để không che mất độ trễ cancel do các bước `always()`.
