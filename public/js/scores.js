// 計分板（/scoreboard）與後台共用：抓分數、更新四隊 score box、每秒輪詢（defer 載入，DOM 已就緒）
async function refreshScores() {
    try {
        const res = await fetch("/api/GetScore");
        const data = await res.json();
        for (let i = 1; i <= 4; i++) {
            document.querySelector(`#t${i} textarea`).value = data[i];
        }
    } catch {
        // ponytail: 輪詢失敗就等下一秒重試，不干擾畫面
    }
}

void refreshScores();
setInterval(refreshScores, 1000);
