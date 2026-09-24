const GROUPS = 4;
const TOKEN_TTL = 12 * 60 * 60; // seconds
const MAX_SCORE = 999; // UI 的 score box 只有兩位數

const enc = new TextEncoder();

// ponytail: node test.mjs 解析不了 cloudflare:workers,補一個同形狀的 base class
let DurableObject = class {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
};
try {
    ({ DurableObject } = await import("cloudflare:workers"));
} catch {}

const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });

const ok = (extra) => json({ status: 1, msg: "success", ...extra });
const fail = (msg, status = 400) => json({ status: 0, msg }, status);

const emptyScores = () =>
    Object.fromEntries(Array.from({ length: GROUPS }, (_, i) => [String(i + 1), 0]));

const b64u = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

const unb64u = (s) =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret) =>
    crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
    ]);

// ponytail: 無狀態簽章 token，不存 KV。代價是 logout 無法主動撤銷，
// 想撤銷就換掉 AUTH_SECRET（所有 token 立即失效）。
async function issueToken(secret) {
    const exp = String(Math.floor(Date.now() / 1000) + TOKEN_TTL);
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(exp));
    return `${exp}.${b64u(sig)}`;
}

async function verifyToken(secret, token) {
    if (typeof token !== "string") return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    try {
        return await crypto.subtle.verify(
            "HMAC",
            await hmacKey(secret),
            unb64u(sig),
            enc.encode(exp),
        );
    } catch {
        return false;
    }
}

// 玩家 token 簽 "p." + payload，跟後台 token（只簽 exp）分開，兩種不能互用
async function issuePlayerToken(secret, group, name) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
    const payload = b64u(enc.encode(JSON.stringify({ g: group, n: name, exp })));
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`p.${payload}`));
    return `${payload}.${b64u(sig)}`;
}

async function verifyPlayerToken(secret, token) {
    if (typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    try {
        const valid = await crypto.subtle.verify(
            "HMAC",
            await hmacKey(secret),
            unb64u(sig),
            enc.encode(`p.${payload}`),
        );
        if (!valid) return null;
        const player = JSON.parse(new TextDecoder().decode(unb64u(payload)));
        return player.exp >= Date.now() / 1000 ? player : null;
    } catch {
        return null;
    }
}

const isGroup = (v) => Number.isInteger(v) && v >= 1 && v <= GROUPS;

// 每項可能拿到的分數：年份精準 3、差 3 年以內 1；歌手、歌名答對 1
const FIELD_POINTS = { year: [3, 1, 0], artist: [1, 0], title: [1, 0] };
const FIELDS = Object.keys(FIELD_POINTS);

// 忽略大小寫、全半形、空白和標點
const norm = (s) =>
    String(s)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, "");

const textOk = (ans, accepted) => norm(ans) !== "" && accepted.some((a) => norm(a) === norm(ans));

const yearPoints = (ans, year) => (ans === null ? 0 : ans === year ? 3 : Math.abs(ans - year) <= 3 ? 1 : 0);

// auto 是自動批改的分數，points 是套上人工改判後的最終分數
function grade(song, answers) {
    return Object.entries(answers).map(([player, a]) => {
        const auto = {
            year: yearPoints(a.year, song.year),
            artist: textOk(a.artist, song.artist) ? 1 : 0,
            title: textOk(a.title, song.title) ? 1 : 0,
        };
        return { player, ...a, auto, points: { ...auto, ...a.override } };
    });
}

// 每組每項只算一次：取組內該項最高分
const groupPoints = (graded) =>
    Object.fromEntries(
        Array.from({ length: GROUPS }, (_, i) => {
            const mine = graded.filter((a) => a.group === i + 1);
            const sum = FIELDS.reduce((t, f) => t + Math.max(0, ...mine.map((a) => a.points[f])), 0);
            return [String(i + 1), sum];
        }),
    );

// 跑馬燈用：各項最先拿到滿分的人（時間看最後一次送出）
function firstCorrect(graded) {
    const who = (a) => (a ? { group: a.group, name: a.name } : null);
    return Object.fromEntries(
        FIELDS.map((f) => {
            const full = graded.filter((a) => a.points[f] === FIELD_POINTS[f][0]);
            return [f, who(full.sort((x, y) => x.at - y.at)[0])];
        }),
    );
}

const toList = (v) => (Array.isArray(v) ? v : [v]).filter((s) => typeof s === "string" && s.trim() !== "");

function parseSongs(v) {
    if (!Array.isArray(v)) return null;
    const songs = v.map((s) => ({ year: s?.year, artist: toList(s?.artist), title: toList(s?.title) }));
    return songs.every((s) => Number.isInteger(s.year) && s.artist.length && s.title.length) ? songs : null;
}

// 單一 DO 序列化所有寫入：每個動作只改自己那組，多管理員同時操作不會互蓋。
// （舊版 KV read-modify-write 會把整包舊分數壓回去，造成別組分數突然倒退。）
export class Scores extends DurableObject {
    async read() {
        let scores = await this.ctx.storage.get("scores");
        if (!scores) {
            // ponytail: 一次性從舊 KV 資料 seed，部署當下分數不歸零；之後 KV 可整個拆掉
            scores = (await this.env.KV.get("scores", "json")) ?? emptyScores();
            await this.ctx.storage.put("scores", scores);
        }
        return scores;
    }

    async add(group, delta) {
        const scores = await this.read();
        await this.ctx.storage.put("scores", {
            ...scores,
            [group]: Math.min(MAX_SCORE, (scores[group] ?? 0) + delta),
        });
    }

    async set(group, score) {
        const scores = await this.read();
        await this.ctx.storage.put("scores", { ...scores, [group]: score });
    }

    // ===== 手機作答 =====
    // storage keys: songs（歌單+解答）、groupPw、round {songId, open}、
    // ans:<songId> {"<組>:<名字>": 答案}、awarded {songId: {組: 已加的分}}、
    // history [依收卷順序的 songId]、highlights {songId: 跑馬燈內容}

    async load(key, fallback) {
        return (await this.ctx.storage.get(key)) ?? fallback;
    }

    async checkGroupPassword(group, password) {
        const pw = (await this.load("groupPw", {}))[group];
        return typeof pw === "string" && pw !== "" && pw === password;
    }

    async setGroupPasswords(passwords) {
        await this.ctx.storage.put("groupPw", passwords);
    }

    // 只回題號和自己的答案，絕對不能帶到解答
    async playerState(group, name) {
        const round = await this.load("round", null);
        if (!round) return { round: null, answer: null };
        const a = (await this.load(`ans:${round.songId}`, {}))[`${group}:${name}`];
        return {
            round: { no: round.songId + 1, open: round.open },
            answer: a ? { year: a.year, artist: a.artist, title: a.title } : null,
            highlights: round.open ? null : ((await this.load("highlights", {}))[round.songId] ?? null),
        };
    }

    async submit(group, name, answer) {
        const round = await this.load("round", null);
        if (!round?.open) return false;
        const key = `ans:${round.songId}`;
        const answers = await this.load(key, {});
        // 改答案就清掉人工改判，因為那是針對舊答案判的
        answers[`${group}:${name}`] = { group, name, ...answer, at: Date.now(), override: {} };
        await this.ctx.storage.put(key, answers);
        return true;
    }

    async setSongs(songs) {
        if ((await this.load("round", null))?.open) return false;
        await this.ctx.storage.put("songs", songs);
        // 修正解答後重新批改已收卷的題目
        for (const id of Object.keys(await this.load("awarded", {}))) await this.settle(Number(id));
        return true;
    }

    async openRound(songId) {
        if ((await this.load("round", null))?.open) return "請先收卷";
        if (!(await this.load("songs", []))[songId]) return "沒有這首歌";
        await this.ctx.storage.put("round", { songId, open: true });
        return null;
    }

    async closeRound() {
        const round = await this.load("round", null);
        if (!round?.open) return false;
        await this.ctx.storage.put("round", { ...round, open: false });
        const history = await this.load("history", []);
        if (!history.includes(round.songId)) await this.ctx.storage.put("history", [...history, round.songId]);
        await this.settle(round.songId);
        return true;
    }

    async judge(songId, player, field, value) {
        const key = `ans:${songId}`;
        const answers = await this.load(key, {});
        const a = answers[player];
        if (!a) return false;
        if (value === null) delete a.override[field];
        else a.override[field] = value;
        await this.ctx.storage.put(key, answers);
        const round = await this.load("round", null);
        if (!(round?.open && round.songId === songId)) await this.settle(songId);
        return true;
    }

    // 重算這首歌每組該得幾分，跟上次加的分比較，只把差額加減到總分
    async settle(songId) {
        const song = (await this.load("songs", []))[songId];
        if (!song) return;
        const points = groupPoints(grade(song, await this.load(`ans:${songId}`, {})));
        const awarded = await this.load("awarded", {});
        const prev = awarded[songId] ?? {};
        const scores = await this.read();
        for (const g of Object.keys(points)) {
            const next = (scores[g] ?? 0) + points[g] - (prev[g] ?? 0);
            scores[g] = Math.max(0, Math.min(MAX_SCORE, next));
        }
        await this.ctx.storage.put("scores", scores);
        await this.ctx.storage.put("awarded", { ...awarded, [songId]: points });
        await this.refreshHighlights();
    }

    // 依收卷順序重算每首的跑馬燈；改判前面的歌也會影響後面的連續答對，所以整段重算
    async refreshHighlights() {
        const songs = await this.load("songs", []);
        const highlights = {};
        let streak = {}; // player -> {group, name, count}：連續答對歌名到目前這首
        for (const id of await this.load("history", [])) {
            if (!songs[id]) continue;
            const graded = grade(songs[id], await this.load(`ans:${id}`, {}));
            const next = {};
            for (const a of graded) {
                if (a.points.title !== 1) continue;
                next[a.player] = { group: a.group, name: a.name, count: (streak[a.player]?.count ?? 0) + 1 };
            }
            streak = next;
            highlights[id] = {
                first: firstCorrect(graded),
                streaks: Object.values(streak)
                    .filter((s) => s.count >= 2)
                    .sort((x, y) => y.count - x.count),
            };
        }
        await this.ctx.storage.put("highlights", highlights);
    }

    async adminState(songId) {
        const songs = await this.load("songs", []);
        const round = await this.load("round", null);
        const id = Number.isInteger(songId) ? songId : round?.songId;
        const song = songs[id];
        return {
            songs,
            round,
            groupPw: await this.load("groupPw", {}),
            songId: song ? id : null,
            answers: song ? grade(song, await this.load(`ans:${id}`, {})) : [],
            awarded: (await this.load("awarded", {}))[id] ?? null,
        };
    }
}

const scoresStub = (env) => env.SCORES.getByName("main");

async function requireAuth(env, body) {
    return verifyToken(env.AUTH_SECRET, body?.token);
}

async function handleLogin(env, request) {
    const form = await request.formData();
    if (form.get("username") !== env.USERNAME || form.get("password") !== env.PASSWORD) {
        return fail("帳號或密碼錯誤", 401);
    }
    return ok({ token: await issueToken(env.AUTH_SECRET) });
}

async function handleAddScore(env, body) {
    if (!(await requireAuth(env, body))) return fail("please login", 401);
    if (!isGroup(body.group)) return fail("unaccept group value");

    const delta = [body.year, body.name, body.sing, body.dance].filter((v) => v === true).length;
    await scoresStub(env).add(body.group, delta);
    return ok();
}

async function handleSetScore(env, body) {
    if (!(await requireAuth(env, body))) return fail("please login", 401);
    if (!isGroup(body.group)) return fail("unaccept group value");
    if (!Number.isInteger(body.score) || body.score < 0 || body.score > MAX_SCORE) {
        return fail("unaccept score value");
    }

    await scoresStub(env).set(body.group, body.score);
    return ok();
}

async function handleJoin(env, body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 20) return fail("名字要 1–20 個字");
    if (!isGroup(body.group)) return fail("unaccept group value");
    if (!(await scoresStub(env).checkGroupPassword(body.group, body.password))) {
        return fail("組別密碼錯誤", 401);
    }
    return ok({ token: await issuePlayerToken(env.AUTH_SECRET, body.group, name) });
}

async function handlePlay(env, action, body) {
    const player = await verifyPlayerToken(env.AUTH_SECRET, body.token);
    if (!player) return fail("please join", 401);
    const stub = scoresStub(env);

    if (action === "state") return ok(await stub.playerState(player.g, player.n));

    if (action === "answer") {
        const year = body.year ?? null;
        if (year !== null && !Number.isInteger(year)) return fail("年份要是整數");
        const text = (v) => (typeof v === "string" ? v.trim().slice(0, 50) : "");
        const answer = { year, artist: text(body.artist), title: text(body.title) };
        return (await stub.submit(player.g, player.n, answer)) ? ok() : fail("現在不能作答");
    }

    return fail("not found", 404);
}

async function handleAdmin(env, action, body) {
    if (!(await requireAuth(env, body))) return fail("please login", 401);
    const stub = scoresStub(env);

    if (action === "state") return ok(await stub.adminState(body.songId));

    if (action === "songs") {
        const songs = parseSongs(body.songs);
        if (!songs) return fail("歌單格式錯誤");
        return (await stub.setSongs(songs)) ? ok() : fail("作答中不能改歌單，請先收卷");
    }

    if (action === "open") {
        if (!Number.isInteger(body.songId)) return fail("沒有這首歌");
        const err = await stub.openRound(body.songId);
        return err ? fail(err) : ok();
    }

    if (action === "close") {
        return (await stub.closeRound()) ? ok() : fail("目前沒有作答中的題目");
    }

    if (action === "judge") {
        const { songId, player, field, value } = body;
        if (!Number.isInteger(songId) || typeof player !== "string") return fail("參數錯誤");
        if (!FIELDS.includes(field) || !(value === null || FIELD_POINTS[field].includes(value))) {
            return fail("參數錯誤");
        }
        return (await stub.judge(songId, player, field, value)) ? ok() : fail("找不到這份答案");
    }

    if (action === "passwords") {
        const passwords = Object.fromEntries(
            Array.from({ length: GROUPS }, (_, i) => [String(i + 1), body.passwords?.[i + 1]]),
        );
        if (!Object.values(passwords).every((v) => typeof v === "string")) return fail("密碼格式錯誤");
        await stub.setGroupPasswords(passwords);
        return ok();
    }

    return fail("not found", 404);
}

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);

        if (pathname === "/api/GetScore" && request.method === "GET") {
            return json(await scoresStub(env).read());
        }

        if (request.method !== "POST") return fail("not found", 404);

        if (pathname === "/api/login") return handleLogin(env, request);

        let body;
        try {
            body = await request.json();
        } catch {
            return fail("json decode error");
        }

        if (pathname === "/api/AddScore") return handleAddScore(env, body);
        if (pathname === "/api/SetScore") return handleSetScore(env, body);
        if (pathname === "/api/join") return handleJoin(env, body);
        if (pathname.startsWith("/api/play/")) return handlePlay(env, pathname.slice(10), body);
        if (pathname.startsWith("/api/admin/")) return handleAdmin(env, pathname.slice(11), body);

        return fail("not found", 404);
    },
};
