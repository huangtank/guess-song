// defer 載入，DOM 已就緒
const PLAYER_KEY = "ntust_camp_player";
const PLAYER_LABEL_KEY = "ntust_camp_player_label";
const $ = (id) => document.getElementById(id);

let shownRound; // 目前畫面顯示的「題號:是否作答中」，變了才重畫，避免輪詢蓋掉正在打的字

async function api(url, payload) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { status: res.status, data: await res.json() };
}

function showView(view) {
    for (const v of ["join_view", "play_view", "score_view"]) $(v).hidden = v !== view;
}

function showJoin() {
    showView("join_view");
    $("marquee").hidden = true;
}

function showPlay() {
    showView("play_view");
    $("player_label").textContent = localStorage.getItem(PLAYER_LABEL_KEY) ?? "";
    shownRound = undefined;
    void refresh();
}

function leave() {
    localStorage.removeItem(PLAYER_KEY);
    localStorage.removeItem(PLAYER_LABEL_KEY);
    showJoin();
}

const summary = (a) =>
    a ? `已送出：${a.year ?? "—"}／${a.artist || "—"}／${a.title || "—"}` : "尚未作答";

async function join() {
    const name = $("player_name").value.trim();
    try {
        const { data } = await api("/api/join", { name, code: $("group_code").value });
        if (data.status !== 1) return alert(data.msg);
        localStorage.setItem(PLAYER_KEY, data.token);
        localStorage.setItem(PLAYER_LABEL_KEY, `第 ${data.group} 組・${name}`);
        showPlay();
    } catch {
        alert("網路錯誤，請再試一次");
    }
}

const FIELD_NAMES = { year: "年份", artist: "歌手", title: "歌名" };

// 每組一則：該組這首個人得分最高的人
const marqueeText = (highlights) =>
    highlights
        .map((h) =>
            h.name
                ? `組${h.group} ${h.name} [${h.fields.map((f) => FIELD_NAMES[f]).join(" + ")}] 正確得 ${h.points} 分`
                : `組${h.group} 這首沒有人答對`,
        )
        .join("　　　");

// 收卷後才有 highlights；文字沒變就不重設，避免動畫一直從頭跑
function renderMarquee(highlights) {
    // 舊版存的是 {first, streaks} 物件，不是陣列就當作沒有，避免整個畫面更新失敗
    if (!Array.isArray(highlights)) highlights = null;
    $("marquee").hidden = !highlights;
    if (!highlights) return;
    const text = marqueeText(highlights);
    const span = $("marquee_text");
    if (span.textContent === text) return;
    span.textContent = text;
    span.style.animationDuration = `${Math.max(10, text.length * 0.35)}s`;
}

function render({ round, answer, highlights }) {
    renderMarquee(highlights);
    const key = round ? `${round.no}:${round.open}` : "none";
    if (key === shownRound) return;
    shownRound = key;

    $("round_status").textContent = !round
        ? "等待發題…"
        : round.open
          ? `第 ${round.no} 首 作答中`
          : `第 ${round.no} 首 已收卷`;
    $("answer_form").hidden = !round?.open;
    $("ans_year").value = answer?.year ?? "";
    $("ans_artist").value = answer?.artist ?? "";
    $("ans_title").value = answer?.title ?? "";
    $("submitted").textContent = round ? summary(answer) : "";
}

async function refresh() {
    const token = localStorage.getItem(PLAYER_KEY);
    if (!token || document.hidden) return;
    try {
        const { status, data } = await api("/api/play/state", { token });
        if (status === 401) return leave();
        render(data);
    } catch {
        // ponytail: 輪詢失敗就等下一輪重試
    }
}

async function refreshScores() {
    if ($("score_view").hidden || document.hidden) return;
    try {
        const data = await (await fetch("/api/GetScore")).json();
        for (let i = 1; i <= 4; i++) $(`score_${i}`).textContent = data[i] ?? 0;
    } catch {
        // ponytail: 輪詢失敗就等下一輪重試
    }
}

async function submitAnswer() {
    const year = $("ans_year").valueAsNumber;
    const answer = {
        year: Number.isNaN(year) ? null : year,
        artist: $("ans_artist").value,
        title: $("ans_title").value,
    };
    try {
        const { status, data } = await api("/api/play/answer", {
            token: localStorage.getItem(PLAYER_KEY),
            ...answer,
        });
        if (status === 401) return leave();
        if (data.status !== 1) {
            alert(data.msg);
            shownRound = undefined; // 可能已收卷，強制重畫
            return refresh();
        }
        $("submitted").textContent = summary({ ...answer, artist: answer.artist.trim(), title: answer.title.trim() });
    } catch {
        alert("網路錯誤，請再試一次");
    }
}

$("join_btn").addEventListener("click", () => void join());
$("group_code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void join();
});
$("answer_btn").addEventListener("click", () => void submitAnswer());
$("leave_btn").addEventListener("click", leave);
$("scores_btn").addEventListener("click", () => {
    showView("score_view");
    void refreshScores();
});
$("back_btn").addEventListener("click", () => showView("play_view"));
document.addEventListener("visibilitychange", () => {
    void refresh();
    void refreshScores();
});

// ponytail: 50 多人每 3 秒輪詢一次；切到背景就不打 API，計分板只在打開時才抓
setInterval(() => {
    void refresh();
    void refreshScores();
}, 3000);

if (localStorage.getItem(PLAYER_KEY)) showPlay();
else showJoin();
