# Remote Stop Listener

Tính năng cho phép **tự động dừng keepalive runner cũ** khi một runner mới khởi động, thông qua Firebase Realtime Database.

Mỗi runner "claim" quyền sở hữu bằng cách ghi unique ID của mình lên Firebase. Khi runner mới ghi đè, runner cũ nhận tín hiệu thay đổi và tự dừng.

---

## Cơ chế hoạt động

```
Runner A khởi động                  Firebase RTDB              Runner B khởi động
        │                                  │                           │
        │  PUT "runner-A"                  │                           │
        │ ────────────────────────────────►│                           │
        │                                  │                           │
        │  SSE subscribe                   │                           │
        │ ────────────────────────────────►│                           │
        │                                  │  PUT "runner-B"           │
        │                                  │◄──────────────────────────│
        │  event: data = "runner-B"        │  SSE subscribe            │
        │◄──────────────────────────────── │◄──────────────────────────│
        │                                  │                           │
        │  "runner-B" ≠ own ID "runner-A"  │                           │
        │  → executeStopSequence()         │                  ✅ tiếp tục chạy
        │  → docker compose down -v        │
        │  → cancel CI run                 │
        │  → process.exit(0)               │
```

**Quy tắc:** runner nào ghi đè Firebase sau cùng thì được chạy — runner trước tự dừng.

---

## Cấu hình

### Environment Variables

| Biến                    | Bắt buộc | Mặc định | Mô tả                                                 |
| ----------------------- | -------- | -------- | ----------------------------------------------------- |
| `STOP_LISTENER_ENABLED` | ✅       | `false`  | Phải set `"true"` để bật tính năng                    |
| `STOP_FIREBASE_URL`     | ✅       | —        | URL Firebase REST đầy đủ, bao gồm path và auth secret |
| `STOP_RUNNER_ID`        | ✅       | —        | Unique ID của runner này — set ở đầu CI flow          |
| `STOP_POLL_INTERVAL_MS` | ❌       | `5000`   | Thời gian chờ reconnect SSE khi mất kết nối (ms)      |

> ⚠️ `STOP_FIREBASE_URL` chứa auth secret — **luôn lưu trong CI secret**, không hardcode.

### `STOP_RUNNER_ID` nên là gì?

Bất kỳ giá trị nào đảm bảo **unique per run**. Gợi ý:

| Platform        | Giá trị gợi ý                                    |
| --------------- | ------------------------------------------------ |
| GitHub Actions  | `${{ github.run_id }}-${{ github.run_attempt }}` |
| Azure Pipelines | `$(Build.BuildId)-$(System.JobAttempt)`          |
| Tự generate     | `Date.now().toString()` hoặc UUID                |

### Ví dụ URL Firebase

```
https://my-project-default-rtdb.firebaseio.com/ci/runner-slot.json?auth=MY_DATABASE_SECRET
```

---

## Setup CI

### GitHub Actions

```yaml
jobs:
  run:
    steps:
      - name: Run keepalive
        env:
          STOP_LISTENER_ENABLED: "true"
          STOP_FIREBASE_URL: ${{ secrets.STOP_FIREBASE_URL }}
          STOP_RUNNER_ID: "${{ github.run_id }}-${{ github.run_attempt }}"
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx dotenvrtdb runner keepalive
```

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

> Azure: cần bật **"Allow scripts to access OAuth token"** trong pipeline settings để `SYSTEM_ACCESSTOKEN` có giá trị.

---

## Stop sequence

Khi phát hiện ownership bị lấy, runner chạy lần lượt 4 bước. **Mỗi bước có try/catch riêng — một bước lỗi không dừng các bước sau.**

| Bước       | Hành động                                          | Điều kiện                           |
| ---------- | -------------------------------------------------- | ----------------------------------- |
| **[1]**    | `docker compose down -v`                           | Luôn chạy                           |
| **[2a]**   | Cancel run qua GitHub Actions API                  | Chỉ khi `GITHUB_ACTIONS=true`       |
| **[2b]**   | Cancel build qua Azure Pipelines API               | Chỉ khi `TF_BUILD=true`             |
| **[3]**    | Kill toàn bộ process trong cgroup (Linux)          | Chỉ khi `/proc/self/cgroup` tồn tại |
| **[4]**    | SIGTERM → delay 2s → SIGKILL toàn bộ process group | Luôn chạy                           |
| **[exit]** | `process.exit(0)`                                  | Sau khi tất cả bước hoàn thành      |

---

## Bảo đảm "chỉ chạy một lần"

Dù SSE reconnect nhiều lần, stop sequence **chỉ được trigger đúng một lần** nhờ flag nội bộ `_stopSequenceTriggered`. Sau khi set, mọi SSE event tiếp theo đều bị bỏ qua.

---

## Xử lý lỗi & edge cases

| Tình huống                                 | Hành động                                             |
| ------------------------------------------ | ----------------------------------------------------- |
| SSE mất kết nối                            | Tự reconnect sau `STOP_POLL_INTERVAL_MS` (default 5s) |
| Firebase trả về HTTP 4xx                   | Retry sau **30 giây** + log warning                   |
| `STOP_FIREBASE_URL` không set              | Log warning, return, không throw                      |
| `STOP_RUNNER_ID` không set                 | Log warning, return, không throw                      |
| `STOP_LISTENER_ENABLED !== "true"`         | Bỏ qua hoàn toàn, không log, không kết nối            |
| Firebase ghi lỗi khi claim                 | Log warning, vẫn tiếp tục mở SSE listener             |
| `data: null` từ Firebase (initial connect) | Bỏ qua, không trigger stop                            |
| Node.js < 18 (không có `fetch`)            | Bỏ qua bước 2a & 2b, các bước khác vẫn chạy           |

---

## Cấu trúc file

```
src/commands/runner/
├── keepalive.js        # Gọi startStopListener() một lần khi khởi động
└── stop-listener.js    # Toàn bộ logic remote stop (module độc lập)
```

Thay đổi duy nhất trong `keepalive.js`:

```js
// import ở đầu file
const { startStopListener } = require("./stop-listener");

// trong runKeepalive(), sau khi log "Started"
startStopListener(); // non-blocking, fire-and-forget
```

---

## Firebase setup nhanh

1. Tạo Realtime Database tại [Firebase Console](https://console.firebase.google.com)
2. Vào **Project Settings → Service Accounts → Database secrets** → copy secret
3. Tạo node `/ci/runner-slot` với giá trị ban đầu `null`
4. Set Database Rules:

```json
{
  "rules": {
    "ci": {
      "runner-slot": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```
