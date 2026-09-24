# 誰是猜歌王

Cloudflare Workers + KV 的計分板。前端靜態檔（`public/`）由 Workers Static Assets 直接送，
`/api/*` 交給 Worker（`src/index.js`）。

## 需要的設定

### 1. KV namespace

已經建好並寫進 `wrangler.jsonc` 了。要重建的話：

```shell
npx wrangler kv namespace create song-kv
```

把印出來的 `id` 填進 `wrangler.jsonc` 的 `kv_namespaces[0].id`（`binding` 保持 `KV`，程式碼用的是這個名字）。

分數存在單一 key `scores`，不用先建，第一次讀不到就當作全 0。

### 2. 環境變數（三個都是 secret，不要寫進 wrangler.jsonc）

| 名稱 | 用途 |
|---|---|
| `USERNAME` | 後台帳號 |
| `PASSWORD` | 後台密碼 |
| `AUTH_SECRET` | 簽 token 用的密鑰，隨機字串（`openssl rand -base64 32`）。換掉它 = 立刻登出所有人 |

正式環境：

```shell
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD
npx wrangler secret put AUTH_SECRET
```

本機開發：`cp .dev.vars.example .dev.vars` 後填值（`.dev.vars` 已 gitignore）。

## 開發 / 部署

```shell
node test.mjs            # 煙霧測試
npx wrangler dev         # 本機 http://localhost:8787
npx wrangler deploy
```

## 頁面

| 路徑 | 說明 |
|---|---|
| `/` | 玩家用手機作答（名字＋組別代碼，代碼決定組別），收卷後有跑馬燈，可切換看計分板 |
| `/scoreboard` | 投影用的大計分板，每秒更新 |
| `/login` | 後台登入 |
| `/dashboard` | 加分 / 改分、發題 / 收卷、作答狀況、組別代碼、歌單 |

## API

| 路徑 | Method | Body | 說明 |
|---|---|---|---|
| `/api/GetScore` | GET | — | 回 `{"1":0,...,"4":0}` |
| `/api/login` | POST | form: `username`, `password` | 回 `{status, msg, token}`，token 12 小時到期 |
| `/api/AddScore` | POST | json: `token`, `group`, `year`, `name`, `sing`, `dance` | 每個 `true` 加 1 分 |
| `/api/SetScore` | POST | json: `token`, `group`, `score` | 直接指定分數 |

| `/api/join` | POST | json: `name`, `code` | 用組別代碼加入（不分大小寫），回 `group` 和玩家 token |
| `/api/play/state` | POST | json: `token` | 目前題號、是否作答中、自己的答案（不含解答）、收卷後的跑馬燈內容 |
| `/api/play/answer` | POST | json: `token`, `year`, `artist`, `title` | 作答中可重複送出，以最後一次為準 |
| `/api/admin/{state,songs,open,close,judge,passwords}` | POST | json: `token`, ... | 後台作答管理，參數見 `src/index.js` 的 `handleAdmin` |

`group` 是 1–4 的整數，`score` 是 0–999 的整數。

## 歌單

歌單含解答，**不能進 git**：照 `songs.example.json` 的格式寫成 `songs.json`（`songs*.json` 已 gitignore），
在後台「歌單與解答」選檔上傳。解答只存在伺服器的 Durable Object，玩家端 API 拿不到。

計分：收卷時自動批改。年份精準 +3、差 3 年以內 +1；歌手、歌名答對各 +1。每組每項取組內最高分，
所以一組一首歌最多 +5。收卷後在後台改判或修正歌單，總分會自動加減差額。

跑馬燈：收卷後在玩家手機上每組顯示一則，例如「組1 玩家B [年份 + 歌名] 正確得 4 分」，
取該組這首個人得分最高的人，同分取最先送出的（看最後一次送出的時間）；整組沒拿分就顯示沒有人答對。認證失敗回 401，參數錯回 400。

登出是純前端行為（清掉 localStorage），沒有 `/api/logout`——token 是無狀態簽章，
要強制撤銷就換 `AUTH_SECRET`。
