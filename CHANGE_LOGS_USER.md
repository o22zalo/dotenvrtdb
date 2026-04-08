Path:CHANGE_LOGS_USER.md
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
