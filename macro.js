// macro.js - 宏观风控哨兵 (V2.1 日期增强版)
// 功能：每日抓取 宏观(衰退)+估值(泡沫)+情绪(恐慌) 三大维度，推送到飞书

const https = require('https');

// ================= 配置区 =================
if (!globalThis.fetch) { console.error("请使用 Node 20+"); process.exit(1); }

const CONFIG = {
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK, 
    ALPHAVANTAGE_KEY: process.env.ALPHAVANTAGE_KEY || "O0VQP18WF8I5N66X",
    DASHBOARD_URL: "https://sd237720488-a11y.github.io/my-stock-bot/" // 请替换为你的网页链接
};

// ================= 工具函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchJson = async (url) => {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 30000); // 30s 超时
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
};

// ================= 核心分析逻辑 =================
const runAnalysis = async () => {
    console.log("🕵️ 宏观哨兵启动...");
    
    let report = {
        sahm: { text: "⏳", color: "grey" },
        yield: { text: "⏳", color: "grey" },
        val: { text: "⏳", color: "grey" },   // 估值
        sent: { text: "⏳", color: "grey" },  // 情绪
        riskLevel: "LOW"
    };

    try {
        // --- 第一阶段：抓取宏观基础 (3次请求) ---
        console.log("1/2 正在抓取就业与利率...");
        const uRes = await fetchJson(`https://www.alphavantage.co/query?function=UNEMPLOYMENT&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000);
        const t10Res = await fetchJson(`https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=monthly&maturity=10year&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000);
        const t2Res = await fetchJson(`https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=monthly&maturity=2year&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);

        // 🛑 中场休息：Alpha Vantage 免费版每分钟限制 5 次，我们休息 65 秒确保配额重置
        console.log("☕️ 正在休眠 65秒 以避开 API 限流...");
        await sleep(65000); 

        // --- 第二阶段：抓取估值与情绪 (3次请求) ---
        console.log("2/2 正在抓取估值与情绪...");
        // 情绪 (RSI)
        const rsiRes = await fetchJson(`https://www.alphavantage.co/query?function=RSI&symbol=SPY&interval=daily&time_period=14&series_type=close&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000);
        // 估值 (现价)
        const priceRes = await fetchJson(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000);
        // 估值 (200日均线)
        const smaRes = await fetchJson(`https://www.alphavantage.co/query?function=SMA&symbol=SPY&interval=daily&time_period=200&series_type=close&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);

        // ================= 数据计算 =================

        // 1. 萨姆规则 (就业)
        if (uRes && uRes.data && uRes.data.length >= 24) {
            const d = uRes.data;
            const curMA = (parseFloat(d[0].value) + parseFloat(d[1].value) + parseFloat(d[2].value)) / 3;
            let minMA = 100;
            for(let i=0; i<12; i++) {
                const ma = (parseFloat(d[i].value) + parseFloat(d[i+1].value) + parseFloat(d[i+2].value)) / 3;
                if(ma < minMA) minMA = ma;
            }
            const diff = curMA - minMA;
            if (diff >= 0.5) { report.sahm = { text: `🔴 **衰退确认** (+${diff.toFixed(2)}%)`, color: "red" }; report.riskLevel = "HIGH"; }
            else if (diff >= 0.4) { report.sahm = { text: `🟠 **高危预警** (+${diff.toFixed(2)}%)`, color: "orange" }; if(report.riskLevel!=="HIGH") report.riskLevel="MEDIUM"; }
            else { report.sahm = { text: `🟢 **就业安全** (+${diff.toFixed(2)}%)`, color: "green" }; }
        }

        // 2. 美债利差 (信贷)
        if (t10Res?.data && t2Res?.data) {
            const spread = parseFloat(t10Res.data[0].value) - parseFloat(t2Res.data[0].value);
            if (spread < 0) { report.yield = { text: `⚠️ **倒挂中** (${spread.toFixed(2)}%)`, color: "orange" }; }
            else if (spread < 0.2) { report.yield = { text: `☠️ **危险回正** (${spread.toFixed(2)}%)`, color: "red" }; report.riskLevel = "HIGH"; }
            else { report.yield = { text: `🟢 **结构正常** (${spread.toFixed(2)}%)`, color: "green" }; }
        }

        // 3. 情绪 (RSI -> 恐慌贪婪平替)
        // RSI < 30: 极度恐慌 (买入) | RSI > 70: 极度贪婪 (卖出)
        if (rsiRes && rsiRes["Technical Analysis: RSI"]) {
            const date = Object.keys(rsiRes["Technical Analysis: RSI"])[0];
            const rsi = parseFloat(rsiRes["Technical Analysis: RSI"][date]["RSI"]);
            
            if (rsi > 70) { report.sent = { text: `🔥 **极度贪婪** (${rsi.toFixed(0)})`, color: "red" }; } // 风险高
            else if (rsi < 30) { report.sent = { text: `💎 **极度恐慌** (${rsi.toFixed(0)})`, color: "green" }; } // 机会好
            else { report.sent = { text: `⚖️ **情绪中性** (${rsi.toFixed(0)})`, color: "grey" }; }
        }

        // 4. 估值 (股价 vs 年线 -> 巴菲特平替)
        // 偏离 > 15%: 泡沫 | 偏离 < -10%: 低估
        if (priceRes && priceRes["Global Quote"] && smaRes && smaRes["Technical Analysis: SMA"]) {
            const price = parseFloat(priceRes["Global Quote"]["05. price"]);
            const date = Object.keys(smaRes["Technical Analysis: SMA"])[0];
            const sma = parseFloat(smaRes["Technical Analysis: SMA"][date]["SMA"]);
            const dev = ((price - sma) / sma) * 100;

            if (dev > 15) { report.val = { text: `🎈 **估值过热** (+${dev.toFixed(1)}%)`, color: "orange" }; }
            else if (dev < -10) { report.val = { text: `💰 **价值低估** (${dev.toFixed(1)}%)`, color: "green" }; }
            else { report.val = { text: `⚖️ **估值合理** (+${dev.toFixed(1)}%)`, color: "grey" }; }
        }
        
        return report;

    } catch (e) {
        console.error("宏观抓取失败:", e);
        return null;
    }
};

// ================= 发送飞书卡片 =================
const pushFeishu = async (data) => {
    if (!CONFIG.FEISHU_WEBHOOK || !data) return;

    // 获取当前日期 YYYY-MM-DD
    const dateStr = new Date().toISOString().split('T')[0];

    let headerColor = "green";
    let titleText = `🟢 宏观安全日报 (${dateStr})`;
    
    if (data.riskLevel === "HIGH") { headerColor = "red"; titleText = `🚨 红色警报：宏观恶化 (${dateStr})`; }
    else if (data.riskLevel === "MEDIUM") { headerColor = "orange"; titleText = `⚠️ 橙色预警：风险上升 (${dateStr})`; }

    const card = {
        "msg_type": "interactive",
        "card": {
            "config": { "wide_screen_mode": true },
            "header": { "title": { "tag": "plain_text", "content": titleText }, "template": headerColor },
            "elements": [
                {
                    "tag": "div",
                    "fields": [
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**萨姆规则 (衰退):**\n${data.sahm.text}` } },
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**美债利差 (信贷):**\n${data.yield.text}` } },
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**估值水位 (泡沫):**\n${data.val.text}` } },
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**市场情绪 (RSI):**\n${data.sent.text}` } }
                    ]
                },
                { "tag": "hr" },
                {
                    "tag": "action",
                    "actions": [{
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": "📲 查看详细仪表盘" },
                        "type": "primary",
                        "url": CONFIG.DASHBOARD_URL
                    }]
                },
                {
                    "tag": "note",
                    "elements": [{ "tag": "plain_text", "content": data.riskLevel==="HIGH" ? "🛑 建议：清空非核心资产，保留现金！" : "✅ 建议：环境温和，可正常定投。" }]
                }
            ]
        }
    };

    await fetch(CONFIG.FEISHU_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(card) });
    console.log("✅ 推送完成");
};

runAnalysis().then(pushFeishu);
