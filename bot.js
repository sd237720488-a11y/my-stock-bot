// bot.js - AlphaSystem 云端机器人 (V6.0 修正版)
const https = require('https');

// ================= 0. 配置区 (环境变量) =================
const CONFIG = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, 
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK, 
    FINNHUB_KEY: process.env.FINNHUB_KEY
};

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeFixed = (num, d=2) => (typeof num === 'number' && !isNaN(num)) ? num.toFixed(d) : 0;

const fetchJson = async (url, options) => {
    try {
        const res = await fetch(url, options);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.error(`⚠️ 请求异常: ${url.slice(0, 30)}...`, e.message);
        return {};
    }
};

const sendFeishuAlert = async (symbol, price, signalType, detail) => {
    if (!CONFIG.FEISHU_WEBHOOK) return;
    const color = signalType.includes("击球") ? "green" : "blue";
    const cardContent = {
        "msg_type": "interactive",
        "card": {
            "config": { "wide_screen_mode": true },
            "header": { "title": { "tag": "plain_text", "content": `🚨 机会报警: ${symbol}` }, "template": color },
            "elements": [
                { "tag": "div", "text": { "tag": "lark_md", "content": `**当前价格:** $${price}\n**触发信号:** ${signalType}\n**详细分析:** ${detail}` } },
                { "tag": "hr" }
            ]
        }
    };
    try {
        await fetch(CONFIG.FEISHU_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cardContent) });
    } catch (e) { console.error("报警发送失败", e); }
};

// ================= 3. 核心算法 =================
const getSmartGrowthInputs = (stock) => {
    const m = stock.metricRaw || {};
    const growthTTM = parseFloat(m.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const revG = parseFloat(m.revenueGrowthQuarterlyYoy) || 0;
    let val = 8;
    if (!stock.metricEPS || stock.metricEPS <= 0) {
        val = revG > 0 ? Math.min(revG, 50) : 5; 
    } else {
        if (growthTTM > 0 && growthTTM > pastG + 10) { val = Math.min(growthTTM, 50); }
        else { val = (pastG > -50 ? pastG : 5); }
    }
    return { defaultGrowthVal: val };
};

const getRiskLevel = (score) => {
    if (!score && score !== 0) return "-";
    if (score <= 20) return "边际极高";
    if (score <= 40) return "边际充足";
    if (score <= 60) return "风险适中";
    if (score <= 80) return "估值脆弱";
    return "高波动";
};

const calculateScenarios = (baseInputs, currentPrice) => {
    const { eps, growthRate, peRatio, riskFreeRate=4.5, roe=0 } = baseInputs; 
    let g = Math.min(Number(growthRate) || 0, 50);
    let targetPE = peRatio;
    if (g < 5 && targetPE > 15) targetPE = 12; 
    let valuationDrag = 1.0;
    if (targetPE * riskFreeRate > 100) { valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate))); }
    let bearDisc = 0.8;
    if (roe > 25) bearDisc += 0.15; 
    const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (g * 0.3) / 100);
    const basePrice = eps * (targetPE * valuationDrag) * (1 + g / 100);
    const bullPrice = eps * (targetPE * 1.2 * valuationDrag) * (1 + (g * 1.3) / 100);
    const peg = targetPE / (g || 1);
    let conclusion = "合理区间 (持有)";
    if (targetPE < 10 && g < 2) conclusion = "☠️ 价值陷阱";
    else if (peg > 3.0 && g < 15) conclusion = "🔴 估值透支";
    else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区";
    else if (currentPrice < basePrice * 0.95) conclusion = "🔵 长坡厚雪";
    else if (currentPrice > bullPrice) conclusion = "🔴 非理性繁荣";
    let valScore = currentPrice < bearPrice ? 50 : (currentPrice > bullPrice ? 0 : 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice))));
    let riskValue = 100 - (valScore + Math.min(roe, 30));
    return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 4. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem V6.0 启动 ===");
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = auth.tenant_access_token;
    if (!token) return;

// 修改后：
const listRes = await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500&field_names=true`, { headers: { 'Authorization': `Bearer ${token}` } });    const stocks = listRes.data?.items || [];

    for (let s of stocks) {
        // 1. 标准化代码
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;

       // 2. 增强版增量判断
// parseFloat 确保把飞书传回来的字符串或者数字正确转换
const currentPriceInTable = parseFloat(s.fields['现价']) || 0;
const now = Date.now();
// 飞书的系统字段有时在 root 级，有时在 fields 级，做一个兼容
const lastUpdate = (s.updated_time || s.fields?.updated_time || 0) * 1000;

if (currentPriceInTable > 0 && (now - lastUpdate < 43200000)) {
    console.log(`⏩ 跳过: ${symbol} (表内已有现价: ${currentPriceInTable})`);
    continue; 
}

        console.log(`🚀 Processing: ${symbol}...`);
        try {
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`);
            if (!q.c) { console.log(`  ⚠️ ${symbol}: 暂无价格`); continue; }
            
            const m = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`);
            const price = q.c;
            const metric = m.metric || {};
            
            const { defaultGrowthVal } = getSmartGrowthInputs({ metricRaw: metric, metricEPS: metric.epsTTM, metricGrowth5Y: metric.epsGrowth5Y });
            const inputs = { eps: metric.epsTTM, growthRate: defaultGrowthVal, peRatio: metric.peTTM || 20, roe: parseFloat(metric.roeTTM)||0, revenueGrowth: parseFloat(metric.revenueGrowthQuarterlyYoy)||0 };
            const norm = calculateScenarios(inputs, price);
            const stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);

            // 择时逻辑
            const low52 = parseFloat(metric['52WeekLow']), high52 = parseFloat(metric['52WeekHigh']);
            let timing = "⏳ 盘整中";
            if (low52 && high52) {
                const reb = (price - low52)/low52;
                if ((price - low52)/(high52 - low52) < 0.05) timing = "🔪 左侧博弈";
                else if (reb > 0.05 && reb < 0.20 && (norm.conclusion.includes("击球") || norm.conclusion.includes("长坡"))) timing = "🚀 右侧启动";
            }

            // 写入飞书
            await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.record_id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        "现价": price,
                        "性价比(PEG)": parseFloat(safeFixed(norm.peg)),
                        "评价": norm.conclusion,
                        "风险": getRiskLevel(norm.riskValue),
                        "悲观估值": parseFloat(safeFixed(norm.bearPrice)),
                        "合理估值": parseFloat(safeFixed(norm.basePrice)),
                        "乐观估值": parseFloat(safeFixed(norm.bullPrice)),
                        "回本(PE)": parseFloat(safeFixed(metric.peTTM, 1)),
                        "过往增速": parseFloat(safeFixed(metric.epsGrowth5Y / 100, 4)),
                        "营收增速(季)": parseFloat(safeFixed(metric.revenueGrowthQuarterlyYoy / 100, 4)),
                        "ROE": parseFloat(safeFixed(metric.roeTTM / 100, 4)),
                        "净利率": parseFloat(safeFixed(metric.netProfitMarginTTM / 100, 4)),
                        "股息率": parseFloat(safeFixed(metric.dividendYieldIndicatedAnnual / 100, 4)),
                        "EPS增速(季)": parseFloat(safeFixed(metric.epsGrowthQuarterlyYoy / 100, 4)),
                        "EPS增速(TTM)": parseFloat(safeFixed(metric.epsGrowthTTMYoy / 100, 4)),
                        "择时信号": timing,
                        "超链接": `https://finviz.com/quote.ashx?t=${symbol}`
                    }
                })
            });
            console.log(`  ✅ ${symbol} 更新完成`);
        } catch (e) { console.error(`  ❌ ${symbol} 出错:`, e.message); }
        await sleep(3000);
    }
    console.log("=== 任务完成 ===");
};

main();
