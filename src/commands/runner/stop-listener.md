Path:src/commands/runner/stop-listener.md
# Remote Stop Listener

Tính năng này cho phép **runner keepalive cũ tự dừng ngay** khi một runner mới ghi đè owner trên Firebase Realtime Database.

Từ bản cập nhật này, cơ chế stop không còn phụ thuộc duy nhất vào SSE. Module sẽ chạy **2 luồng song song**:

1. **SSE listener** để nhận thay đổi gần như realtime.
2. **Polling GET đúng node value** để đối chiếu owner định kỳ, dùng làm đường dự phòng khi SSE bị treo, miss event hoặc reconnect chậm.

Ngoài ra, `keepalive` giờ sẽ **abort ngay lệnh `docker compose logs` / `docker compose ps` đang chạy** khi nhận stop request, thay vì đợi cycle hiện tại tự kết thúc.

---

## Cơ chế hoạt động mới

```text
Runner A khởi động                  Firebase RTDB              Runner B khởi động
        │                                  │                           │
        │  PUT "runner-A"                  │                           │
        │ ────────────────────────────────►│                           │
        │                                  │                           │
        │  SSE subscribe + Poll GET        │                           │
        │ ────────────────────────────────►│                           │
        │                                  │  PUT "runner-B"           │
        │                                  │◄──────────────────────────│
        │                                  │                           │
        │  SSE nhận event hoặc Poll đọc thấy owner mới                 │
        │◄──────────────────────────────── │                           │
        │                                  │                           │
        │  owner mới ≠ own runner ID       │                           │
        │  → requestStop()                 │                  ✅ tiếp tục chạy
        │  → keepalive kill docker child   │
        │  → fire remote cancel (best-effort)
        │  → process thoát với exit code 130
```

**Quy tắc:** runner nào ghi owner sau cùng thì được chạy. Runner cũ phải tự thoát.

---

## Vì sao trước đây có thể stop chậm 5–10 phút?

Có 2 nguyên nhân chính:

1. `runCycle()` trước đây không abort lệnh docker đang chạy. Nếu stop tới giữa lúc `docker compose logs` hoặc `docker compose ps` đang treo/chưa trả về, keepalive vẫn có thể bị giữ lại trong cycle đó.
2. GitHub Actions khi cancel workflow sẽ gửi `SIGINT`, rồi `SIGTERM`, rồi mới kill process tree. Nếu process không chịu thoát, GitHub có thể đợi tới **5 phút cancellation timeout**. Đồng thời các step có `if: always()` vẫn có thể tiếp tục chạy khi workflow đang bị cancel. citeturn504918search0

Vì vậy, muốn stop nhanh thì phải xử lý ở **phía local process** trước: đánh dấu stop, abort child process đang chạy, rồi thoát tiến trình hiện tại ngay.

---

## Cấu hình

### Environment Variables

| Biến                         | Bắt buộc | Mặc định                  | Mô tả |
| ---------------------------- | -------- | ------------------------- | ----- |
| `STOP_LISTENER_ENABLED`      | ✅       | `false`                   | Phải set `"true"` để bật tính năng |
| `STOP_FIREBASE_URL`          | ✅       | —                         | URL Firebase REST đầy đủ, bao gồm path và auth secret |
| `STOP_RUNNER_ID`             | ✅       | —                         | Unique ID của runner này — set ở đầu CI flow |
| `STOP_POLL_INTERVAL_MS`      | ❌       | `5000`                    | Delay reconnect SSE khi đứt kết nối |
| `STOP_HEARTBEAT_MS`          | ❌       | `45000`                   | Timeout silence của SSE trước khi buộc reconnect |
| `STOP_VALUE_POLL_INTERVAL_MS`| ❌       | theo `STOP_POLL_INTERVAL_MS` | Chu kỳ polling GET để verify owner value |

> ⚠️ `STOP_FIREBASE_URL` chứa auth secret — luôn để trong CI secret, không hardcode.

### `STOP_RUNNER_ID` nên là gì?

| Platform        | Giá trị gợi ý                                    |
| --------------- | ------------------------------------------------ |
| GitHub Actions  | `${{ github.run_id }}-${{ github.run_attempt }}` |
| Azure Pipelines | `$(Build.BuildId)-$(System.JobAttempt)`          |
| Tự generate     | `Date.now().toString()` hoặc UUID                |

### Ví dụ URL Firebase

```text
https://my-project-default-rtdb.firebaseio.com/ci/runner-slot.json?auth=MY_DATABASE_SECRET
```

---

## Setup CI

### GitHub Actions

```yaml
jobs:
  run:
    permissions:
      actions: write
    steps:
      - name: Claim owner
        run: npx dotenvrtdb runner set-stoprunnerid
        env:
          STOP_FIREBASE_URL: ${{ secrets.STOP_FIREBASE_URL }}
          STOP_RUNNER_ID: "${{ github.run_id }}-${{ github.run_attempt }}"

      - name: Run keepalive
        env:
          STOP_LISTENER_ENABLED: "true"
          STOP_FIREBASE_URL: ${{ secrets.STOP_FIREBASE_URL }}
          STOP_RUNNER_ID: "${{ github.run_id }}-${{ github.run_attempt }}"
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx dotenvrtdb runner keepalive
```

> Với GitHub Actions, repo cần quyền `actions: write` để call cancel API. citeturn504918search1

### Azure Pipelines

```yaml
steps:
  - script: npx dotenvrtdb runner keepalive
    env:
      STOP_LISTENER_ENABLED: "true"
      STOP_FIREBASE_URL: $(STOP_FIREBASE_URL)
      STOP_RUNNER_ID: "$(Build.BuildId)-$(System.JobAttempt)"
    displayName: Run keepalive
```

> Azure: cần bật **Allow scripts to access OAuth token** để `SYSTEM_ACCESSTOKEN` có giá trị.

### Ghi ownership tách riêng

```bash
# ghi explicit value
npx dotenvrtdb runner set-stoprunnerid my-runner-id

# hoặc lấy từ env STOP_RUNNER_ID
STOP_RUNNER_ID=my-runner-id npx dotenvrtdb runner set-stoprunnerid
```

---

## Stop flow hiện tại

Khi phát hiện owner mới, module sẽ làm theo thứ tự:

1. `stop-listener` gọi `requestStop()` một lần duy nhất.
2. `keepalive` nhận shared stop state qua callback `onStopRequested(...)`.
3. `keepalive` clear timer và **kill ngay child process docker đang chạy**.
4. `keepalive` log rõ `source`, `reason`, `observedValue`, `requestedAt`.
5. Module bắn **remote cancel best-effort** tới GitHub/Azure nếu có đủ credential.
6. Process keepalive thoát bằng **exit code 130** để job hiện tại dừng nhanh.

---

## Bảo đảm chỉ trigger một lần

Dù stop đến từ SSE hay Poll, trạng thái stop được gom về một shared state duy nhất. Sau khi đã `requested=true`:

- không mở lại SSE;
- không schedule poll tiếp;
- không trigger stop callback lần 2;
- `runCycle()` sẽ không được schedule thêm.

---

## Xử lý lỗi & edge cases

| Tình huống | Hành động |
| --- | --- |
| SSE bị miss event hoặc treo | Polling GET vẫn đối chiếu owner và trigger stop |
| SSE chỉ gửi patch/path con | Module apply payload theo `path` + `data` trước khi so sánh owner value. Firebase streaming trả event `put`/`patch` theo cấu trúc này. citeturn120628search6turn120628search8 |
| Firebase trả về `null` hoặc owner rỗng | Bỏ qua, chưa trigger stop |
| Firebase trả về object thay vì scalar | Log warning vì node owner nên là scalar runner ID |
| `STOP_FIREBASE_URL` không set | Log warning, return, không throw |
| `STOP_RUNNER_ID` không set | Log warning, return, không throw |
| `STOP_LISTENER_ENABLED !== "true"` | Bỏ qua hoàn toàn |
| GitHub/Azure cancel API lỗi | Chỉ log warning, local stop vẫn tiếp tục |

---

## Lưu ý cho workflow GitHub Actions

Nếu bạn có step dùng `if: always()`, step đó vẫn có thể chạy tiếp khi workflow bị cancel. Đây là behavior chuẩn của GitHub Actions. citeturn504918search0

Với các flow mà mục tiêu là **stop thật nhanh**, tránh đặt các bước dài hoặc cleanup nặng dưới `if: always()` ngay sau bước keepalive.

---

## Cấu trúc file

```text
src/commands/runner/
├── keepalive.js
├── set-stoprunnerid.js
└── stop-listener.js
```
