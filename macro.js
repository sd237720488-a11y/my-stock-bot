// macro.js - 宏观风控哨兵 (独立运行，不依赖 bot.js)
// 每天运行一次，计算萨姆规则和美债利差，推送飞书卡片

const https = require('https');

// ================= 配置区 =================
// 确保 Node 版本支持 fetch (GitHub Actions 默认 Node 20 支持)
if (!globalThis.fetch) { console.error("请使用 Node 20+"); process.exit(1); }

const CONFIG = {
    // 飞书 Webhook (直接读取你仓库里配好的 Secrets)
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK, 
    // Alpha Vantage Key (直接写死你的免费 Key 即可，或者配到 Secrets)
    ALPHAVANTAGE_KEY: process.env.ALPHAVANTAGE_KEY || "O0VQP18WF8I5N66X", 
    
    // 你的仪表盘链接 (推送卡片里的跳转链接)
    // ⚠️ 请替换为你实际的 GitHub Pages 或 Netlify 链接
    DASHBOARD_URL: "https://sd237720488-a11y.github.io/my-stock-bot/" 
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
    console.log("🕵️ 宏观哨兵启动：正在连接美联储数据库...");
    
    let report = {
        sahm: { text: "数据获取中...", color: "grey" },
        yield: { text: "数据获取中...", color: "grey" },
        riskLevel: "LOW" // LOW, MEDIUM, HIGH
    };

    try {
        // 1. 抓取失业率 (UNRATE)
        const uRes = await fetchJson(`https://www.alphavantage.co/query?function=UNEMPLOYMENT&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000); // 礼貌排队，防止 429

        // 2. 抓取美债 (10Y & 2Y)
        const t10Res = await fetchJson(`https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=monthly&maturity=10year&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);
        await sleep(2000);
        const t2Res = await fetchJson(`https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=monthly&maturity=2year&apikey=${CONFIG.ALPHAVANTAGE_KEY}`);

        // --- A. 萨姆规则计算 (3个月均线) ---
        if (uRes && uRes.data && uRes.data.length >= 24) {
            const d = uRes.data;
            // 计算当前3个月均值
            const curMA = (parseFloat(d[0].value) + parseFloat(d[1].value) + parseFloat(d[2].value)) / 3;
            // 找过去12个月最低均值
            let minMA = 100;
            for(let i=0; i<12; i++) {
                const ma = (parseFloat(d[i].value) + parseFloat(d[i+1].value) + parseFloat(d[i+2].value)) / 3;
                if(ma < minMA) minMA = ma;
            }
            
            const diff = curMA - minMA;
            // 萨姆判断逻辑
            if (diff >= 0.5) {
                report.sahm = { text: `🔴 **确认衰退** (反弹 +${diff.toFixed(2)}%)`, color: "red" };
                report.riskLevel = "HIGH";
            } else if (diff >= 0.4) {
                report.sahm = { text: `🟠 **高危预警** (反弹 +${diff.toFixed(2)}%)`, color: "orange" };
                if(report.riskLevel !== "HIGH") report.riskLevel = "MEDIUM";
            } else {
                report.sahm = { text: `🟢 **就业安全** (反弹 +${diff.toFixed(2)}%)`, color: "green" };
            }
        }

        // --- B. 美债利差计算 ---
        if (t10Res && t10Res.data && t2Res && t2Res.data) {
            const y10 = parseFloat(t10Res.data[0].value);
            const y2 = parseFloat(t2Res.data[0].value);
            const spread = y10 - y2;

            // 利差判断逻辑
            if (spread < 0) {
                report.yield = { text: `⚠️ **倒挂中** (${spread.toFixed(2)}%)`, color: "orange" };
                if(report.riskLevel !== "HIGH") report.riskLevel = "MEDIUM";
            } else if (spread < 0.2) {
                // 如果刚刚回正，非常危险 (衰退性陡峭)
                report.yield = { text: `☠️ **危险回正** (${spread.toFixed(2)}%)`, color: "red" };
                report.riskLevel = "HIGH";
            } else {
                report.yield = { text: `🟢 **结构正常** (${spread.toFixed(2)}%)`, color: "green" };
            }
        }
        
        return report;

    } catch (e) {
        console.error("宏观抓取失败:", e);
        return null;
    }
};

// ================= 发送飞书卡片 =================
const pushFeishu = async (data) => {
    if (!CONFIG.FEISHU_WEBHOOK || !data) {
        console.log("配置缺失或数据为空，跳过推送");
        return;
    }

    // 标题颜色逻辑
    let headerColor = "blue";
    let titleText = "📅 宏观风控日报";
    
    if (data.riskLevel === "HIGH") {
        headerColor = "red";
        titleText = "🚨 红色警报：宏观恶化";
    } else if (data.riskLevel === "MEDIUM") {
        headerColor = "orange";
        titleText = "⚠️ 橙色预警：风险上升";
    } else {
        headerColor = "green";
        titleText = "🟢 宏观安全日报";
    }

    const card = {
        "msg_type": "interactive",
        "card": {
            "config": { "wide_screen_mode": true },
            "header": { "title": { "tag": "plain_text", "content": titleText }, "template": headerColor },
            "elements": [
                {
                    "tag": "div",
                    "fields": [
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**萨姆规则:**\n${data.sahm.text}` } },
                        { "is_short": true, "text": { "tag": "lark_md", "content": `**美债利差:**\n${data.yield.text}` } }
                    ]
                },
                { "tag": "hr" },
                {
                    "tag": "action",
                    "actions": [{
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": "🛸 打开全景指挥台 (仪表盘)" },
                        "type": "primary",
                        "url": CONFIG.DASHBOARD_URL
                    }]
                },
                {
                    "tag": "note",
                    "elements": [{ "tag": "plain_text", "content": data.riskLevel === "HIGH" ? "🛑 建议：清空非核心资产，保留现金！" : "✅ 建议：环境温和，可正常执行定投策略。" }]
                }
            ]
        }
    };

    await fetch(CONFIG.FEISHU_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(card) });
    console.log("✅ 飞书日报推送完成");
};

// 执行
runAnalysis().then(pushFeishu);
