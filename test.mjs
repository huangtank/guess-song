// ponytail: 一個檔案的煙霧測試，跑 `node test.mjs`。沒有測試框架。
import assert from "node:assert/strict";
import worker, { Scores } from "./src/index.js";

const mockKv = (map) => ({
    get: async (k, type) => {
        const v = map.get(k) ?? null;
        return v && type === "json" ? JSON.parse(v) : v;
    },
});

const mockCtx = () => {
    const store = new Map();
    return { storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) } };
};

const kv = new Map();
const env = {
    USERNAME: "admin",
    PASSWORD: "pw",
    AUTH_SECRET: "secret",
    KV: mockKv(kv),
};
const scoresDo = new Scores(mockCtx(), env);
env.SCORES = { getByName: () => scoresDo };

const call = (path, init) => worker.fetch(new Request("https://x" + path, init), env);

const post = (path, body) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const login = (username, password) => {
    const form = new FormData();
    form.append("username", username);
    form.append("password", password);
    return call("/api/login", { method: "POST", body: form });
};

const scores = async () => (await call("/api/GetScore")).json();

// 未初始化時回傳全 0
assert.deepEqual(await scores(), { 1: 0, 2: 0, 3: 0, 4: 0 });

// 密碼錯誤 -> 401
assert.equal((await login("admin", "wrong")).status, 401);

const { token } = await (await login("admin", "pw")).json();
assert.ok(token, "登入成功應該拿到 token");

// 沒有 token / 假 token 都要被擋
assert.equal((await post("/api/AddScore", { group: 1, year: true })).status, 401);
assert.equal((await post("/api/AddScore", { token: "1893456000.aaaa", group: 1, year: true })).status, 401);

// 加分：四個都勾 = +4（唱、跳分開算）
assert.equal(
    (await post("/api/AddScore", { token, group: 3, year: true, name: true, sing: true, dance: true })).status,
    200,
);
assert.equal((await scores())["3"], 4);

// 只勾一個 = +1，且累加
await post("/api/AddScore", { token, group: 3, name: true });
assert.equal((await scores())["3"], 5);

// 只唱沒跳 = +1
await post("/api/AddScore", { token, group: 3, sing: true });
assert.equal((await scores())["3"], 6);

// 組別越界要擋（原本 Flask 版允許 group=0，會寫出 NaN）
for (const group of [0, 5, "3", 1.5]) {
    assert.equal((await post("/api/AddScore", { token, group, year: true })).status, 400, `group=${group}`);
}

// 直接設定分數
assert.equal((await post("/api/SetScore", { token, group: 3, score: 10 })).status, 200);
assert.equal((await scores())["3"], 10);

// 分數越界要擋
for (const score of [-1, 1000, "10", null]) {
    assert.equal((await post("/api/SetScore", { token, group: 3, score })).status, 400, `score=${score}`);
}

// SetScore 也要驗 token（原本 Flask 版沒驗）
assert.equal((await post("/api/SetScore", { group: 3, score: 99 })).status, 401);

// 壞掉的 JSON
assert.equal((await call("/api/AddScore", { method: "POST", body: "{" })).status, 400);

// DO 首次啟動要從舊 KV 資料 seed（部署當下分數不歸零）
{
    const seeded = new Scores(mockCtx(), {
        KV: mockKv(new Map([["scores", JSON.stringify({ 1: 7, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 })]])),
    });
    assert.equal((await seeded.read())["1"], 7);
    // 改 group 2 不能動到 group 1（互蓋 regression）
    await seeded.set(2, 5);
    assert.equal((await seeded.read())["1"], 7);
}


// ===== 手機作答 =====
let clock = Date.now();
Date.now = () => (clock += 1000); // 每次呼叫前進 1 秒，讓「最先答對」的先後可預測

const admin = (action, body = {}) => post(`/api/admin/${action}`, { token, ...body });
const join = async (name, group, password) => post("/api/join", { name, group, password });
const joinToken = async (...args) => (await (await join(...args)).json()).token;
const answer = (t, a) => post("/api/play/answer", { token: t, ...a });
const playState = async (t) => (await post("/api/play/state", { token: t })).json();
const judge = (player, field, value, songId = 0) => admin("judge", { songId, player, field, value });

// 後台 API 都要驗 token
assert.equal((await post("/api/admin/state", {})).status, 401);

// 還沒設密碼的組不能加入
assert.equal((await join("小明", 1, "")).status, 401);

await admin("passwords", { passwords: { 1: "p1", 2: "p2", 3: "", 4: "" } });
assert.equal((await join("小明", 1, "p2")).status, 401);
assert.equal((await join("小明", 3, "")).status, 401); // 空密碼 = 不開放
assert.equal((await join("小明", 5, "p1")).status, 400); // 只有四組
assert.equal((await join("", 1, "p1")).status, 400);
const ming = await joinToken("小明", 1, "p1");
const hua = await joinToken("小華", 1, "p1");
const mei = await joinToken("小美", 2, "p2");

// 玩家 token 不能當後台 token，反之亦然
assert.equal((await post("/api/admin/state", { token: ming })).status, 401);
assert.equal((await post("/api/play/state", { token })).status, 401);

// 歌單格式要驗
assert.equal((await admin("songs", { songs: [{ year: "2003", artist: "周杰倫", title: "晴天" }] })).status, 400);
const songs = [
    { year: 2003, artist: ["周杰倫", "Jay Chou"], title: "晴天" },
    { year: 2010, artist: "五月天", title: "倔強" },
    { year: 2007, artist: "蔡依林", title: "日不落" },
];
assert.equal((await admin("songs", { songs })).status, 200);

// 還沒發題不能作答
assert.equal((await answer(ming, { year: 2003 })).status, 400);

assert.equal((await admin("open", { songId: 0 })).status, 200);
assert.equal((await admin("open", { songId: 1 })).status, 400); // 要先收卷
assert.equal((await admin("songs", { songs: [] })).status, 400); // 作答中不能改歌單

// 玩家看得到題號，看不到解答；作答中沒有跑馬燈
let st = await playState(ming);
assert.deepEqual(st.round, { no: 1, open: true });
assert.equal(st.highlights, null);
assert.ok(!JSON.stringify(st).includes("周杰倫"));

await answer(ming, { year: 2001, artist: "ＪＡＹ chou", title: "" }); // 年份差 2 → +1
await answer(hua, { year: 2003, artist: "", title: "晴 天" }); // 年份精準 → +3
await answer(mei, { year: 2007, artist: "", title: "" });
await answer(mei, { year: 2006, artist: "周杰倫", title: "晴天" }); // 以最後一次為準；年份差 3 → +1
assert.equal((await playState(mei)).answer.title, "晴天");

let before = await scores();
assert.equal((await admin("close")).status, 200);
assert.equal((await answer(ming, { year: 2003 })).status, 400); // 收卷後不能作答
let after = await scores();
// 每組每項取組內最高分：第 1 組 年份 3 + 歌手 1 + 歌名 1；第 2 組 1 + 1 + 1
assert.equal(after[1] - before[1], 5);
assert.equal(after[2] - before[2], 3);

// 跑馬燈：各項最先答對的人（時間看最後一次送出，年份只算精準）
st = await playState(ming);
assert.equal(st.round.open, false);
assert.deepEqual(st.highlights.first, {
    year: { group: 1, name: "小華" },
    artist: { group: 1, name: "小明" },
    title: { group: 1, name: "小華" },
});
assert.deepEqual(st.highlights.streaks, []);

// 人工改判：年份可以改成 3 / 1 / 0，還原後總分跟著回來
await judge("2:小美", "year", 3);
assert.equal((await scores())[2] - before[2], 5);
await judge("2:小美", "year", null);
assert.equal((await scores())[2] - before[2], 3);
await judge("1:小明", "artist", 0);
assert.equal((await scores())[1] - before[1], 4);
await judge("1:小明", "artist", null);
assert.equal((await scores())[1] - before[1], 5);
// 同組兩人都答對同一項只算一次
await judge("1:小華", "artist", 1);
assert.equal((await scores())[1] - before[1], 5);
await judge("1:小華", "artist", null);
assert.equal((await judge("1:小明", "sing", 1)).status, 400);
assert.equal((await judge("1:小明", "year", 2)).status, 400);
assert.equal((await judge("1:小明", "artist", 3)).status, 400);

const { answers } = await (await admin("state", { songId: 0 })).json();
assert.equal(answers.length, 3);

// 第 2 首：小美連續兩首答對歌名
await admin("open", { songId: 1 });
await answer(ming, { year: 2013, artist: "", title: "倔強" }); // 差 3 → +1
await answer(mei, { year: 2014, artist: "", title: "倔強" }); // 差 4 → 0
await answer(hua, { year: null, artist: "", title: "" });
before = await scores();
await admin("close");
after = await scores();
assert.equal(after[1] - before[1], 2);
assert.equal(after[2] - before[2], 1);
assert.deepEqual((await playState(hua)).highlights.streaks, [{ group: 2, name: "小美", count: 2 }]);

// 第 3 首：小美連續三首、小明連續兩首（第 1 首沒答對歌名），多的排前面
await admin("open", { songId: 2 });
await answer(ming, { year: 2007, artist: "", title: "日不落" });
await answer(mei, { year: 2000, artist: "", title: "日不落" });
await admin("close");
assert.deepEqual((await playState(mei)).highlights.streaks, [
    { group: 2, name: "小美", count: 3 },
    { group: 1, name: "小明", count: 2 },
]);

// 收卷後修正歌單會重新批改：第 2 首年份改成 2014，小美變精準 +3
before = await scores();
await admin("songs", { songs: songs.map((s, i) => (i === 1 ? { ...s, year: 2014 } : s)) });
after = await scores();
assert.equal(after[2] - before[2], 3);
assert.equal(after[1] - before[1], 0); // 小明 2013 仍在 ±3 內

console.log("ok");
