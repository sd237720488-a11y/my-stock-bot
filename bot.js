// bot.js - AlphaSystem 云端机器人 (V5.3 深度同步版)
// 包含：React同款双核估值、NBIS/亏损股特判修复、超链接深度推演、智能跳过

const https = require('https');

// ================= 0. 配置区 =================
const CONFIG = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, 
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
    FINNHUB_KEY: process.env.FINNHUB_KEY,
    // 👇 请将此处替换为你部署后的网页地址 (如 https://my-alpha-app.vercel.app)
    WEB_URL: "http://localhost:5173" 
};

// ================= 1. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchJson = async (url, options) => {
    try {
        const res = await fetch(url, options);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`HTTP ${res.status} - ${errorText}`);
        }
        return await res.json();
    } catch (e) { throw e; }
};

const getVal = (val, d = 2) => {
    if (val === null || val === undefined || val === '') return 0;
    const num = parseFloat(val);
    if (isNaN(num) || !isFinite(num)) return 0;
    return parseFloat(num.toFixed(d));
};

const getRiskLevel = (score) => {
    if (!score && score !== 0) return "-";
    if (score <= 20) return "边际极高";
    if (score <= 40) return "边际充足";
    if (score <= 60) return "风险适中";
    if (score <= 80) return "估值脆弱";
    return "高波动";
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
                { "tag": "hr" },
                { "tag": "div", "text": { "tag": "lark_md", "content": `[👉 点击进入深度推演](${CONFIG.WEB_URL}/?symbol=${symbol})` } }
            ]
        }
    };
    try { await fetch(CONFIG.FEISHU_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cardContent) }); } 
    catch (e) { console.error("报警发送失败", e); }
};

// ================= 2. 核心算法 (完全复刻 React App 逻辑) =================

// 2.1 智能增速判断 (修复 NBIS 问题)
const getSmartGrowthInputs = (stock) => {
    const metric = stock.metricRaw || {};
    const growthTTM = parseFloat(metric.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const qtrRevGrowth = parseFloat(metric.revenueGrowthQuarterlyYoy) || 0;
    const revGrowthTTM = parseFloat(metric.revenueGrowthTTMYoy) || 0;
    const revGrowth5Y = parseFloat(metric.revenueGrowth5Y) || 0;

    // 亏损判断：没有EPS 或 EPS<=0
    const isLoss = !metric.epsTTM || metric.epsTTM <= 0;
    // 如果是亏损股，或者没有利润增速数据，强制看营收
    const showRevenueTrend = isLoss || (metric.epsGrowthTTMYoy === null);

    let defaultGrowthVal = 8;

    if (showRevenueTrend) {
        // ✅ 核心修复：取 TTM 和 季度营收 的最大值 (防止季度波动误判)
        const recentRevMax = Math.max(revGrowthTTM, qtrRevGrowth);
        if (recentRevMax > 0) {
            defaultGrowthVal = Math.min(recentRevMax, 50); // 锁死 50% 上限
        } else if (!isNaN(revGrowth5Y)) {
            defaultGrowthVal = revGrowth5Y;
        }
    } else {
        // 盈利股逻辑
        if (growthTTM > 0 && growthTTM > pastG + 10) {
            defaultGrowthVal = Math.min(growthTTM, 50);
        } else {
            defaultGrowthVal = (pastG > -50 ? pastG : 5);
        }
    }
    return { defaultGrowthVal, isLoss };
};

// 2.2 估值引擎 (AlphaCore v4.0 - 包含加速模型)
const calculateScenarios = (baseInputs, currentPrice) => {
    const { eps, growthRate, peRatio, riskFreeRate=4.5, roe=0, revenueGrowth=0, pastGrowth=0, qtrEpsGrowth=0 } = baseInputs; 
    let g = Math.min(Number(growthRate) || 0, 50);
    
    // --- A. 亏损股特判 (困境反转) ---
    if (!eps || eps <= 0) {
        // 如果营收增速 (季度或TTM中的代表值) > 25%，视为困境反转
        // 注意：这里用 g (即 defaultGrowthVal) 作为判定标准更准，因为它已经取了 Max(Qtr, TTM)
        if (g > 25) { 
            return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
        }
        return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
    }

    let targetPE = peRatio;
    let bullMult = 1.2;
    let bearDisc = 0.8;

    // --- B. 动态 PE 调整 ---
    // 1. 低增速熔断
    if (g < 5 && targetPE > 15) targetPE = 12;

    // 2. ✅ 核心同步：业绩加速模型 (React版独有逻辑)
    const isAccelerating = qtrEpsGrowth > (pastGrowth + 15);
    if (isAccelerating) {
        bullMult += 0.3;
        g = Math.max(g, qtrEpsGrowth * 0.8); // 上调预期增速
    }

    // 3. 高息压制
    let valuationDrag = 1.0;
    if (targetPE * riskFreeRate > 100) valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate)));

    // 4. 护城河修正
    if (roe > 25) bearDisc += 0.15;

    // --- C. 计算价格 ---
    const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (g * 0.3) / 100);
    const basePrice = eps * (targetPE * valuationDrag) * (1 + g / 100);
    const bullPrice = eps * (targetPE * bullMult * valuationDrag) * (1 + (g * 1.3) / 100);
    const peg = targetPE / (g || 1);

    // --- D. 结论判定 ---
    let conclusion = "合理区间 (持有)";
    const isTrap = targetPE < 10 && g < 2;     
    const isOverdraft = peg > 3.0 && g < 15;   

    if (isTrap) conclusion = "☠️ 价值陷阱";
    else if (isOverdraft) conclusion = "🔴 估值透支";
    else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区";
    else if (currentPrice < basePrice * 0.95) conclusion = "🔵 长坡厚雪";
    else if (currentPrice > bullPrice) conclusion = "🔴 非理性繁荣";

    // --- E. 风险评分 ---
    let valScore = currentPrice < bearPrice ? 50 : (currentPrice > bullPrice ? 0 : 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice))));
    let qualityScore = Math.min(Math.max(roe, 0), 30);
    let growthScore = peg < 1.0 ? 20 : (peg > 3.0 ? 0 : 20 * ((3 - peg) / 2));
    let riskValue = 100 - (valScore + qualityScore + growthScore);

    return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 3. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem V5.3 (React Sync) 启动 ===");
    
    // 1. 飞书鉴权
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    }).catch(e => { console.error("❌ 鉴权失败:", e.message); return {}; });
    
    const token = auth.tenant_access_token;
    if (!token) return;

    // 2. 获取股票列表
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } }).catch(e => ({}));
    const stocks = listRes.data?.items || [];
    console.log(`📡 扫描到 ${stocks.length} 只股票...`);

    let count = 0;
    
    // 3. 循环处理
    for (let s of stocks) {
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;

        // --- 智能跳过逻辑 (1小时) ---
        const lastModified = parseInt(s.last_modified_time || 0);
        const now = Date.now();
        const diffHours = (now - lastModified) / (1000 * 60 * 60);
        const currentPriceField = s.fields['现价']; 
        const hasPrice = currentPriceField !== undefined && currentPriceField !== null && Number(currentPriceField) > 0;
        
        if (hasPrice && diffHours < 1.0) {
            console.log(`   ⏭️ [跳过] ${symbol}: ${diffHours.toFixed(2)}h 前已更`);
            continue; 
        }

        console.log(`Processing: ${symbol}...`);

        try {
            // A. 获取 Finnhub 数据
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            const m = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            
            if (!q.c) { console.log(`   ⚠️ ${symbol}: 暂无价格`); await sleep(1000); continue; }
            
            const price = q.c;
            const metric = m.metric || {};
            
            // B. 准备数据 (对应 React handleSyncOne)
            // 修正：epsGrowth5Y 在 Finnhub metric 里通常叫 epsGrowth5Y
            const metricGrowth5Y = metric.epsGrowth5Y || 0;
            
            const { defaultGrowthVal } = getSmartGrowthInputs({ 
                metricRaw: metric, 
                metricGrowth5Y: metricGrowth5Y 
            });
            
            const inputs = {
                eps: metric.epsTTM, 
                growthRate: defaultGrowthVal, 
                peRatio: metric.peTTM || 20, 
                roe: parseFloat(metric.roeTTM)||0,
                // 下面这些参数主要用于加速模型判定
                pastGrowth: parseFloat(metricGrowth5Y) || 0,
                qtrEpsGrowth: parseFloat(metric.epsGrowthQuarterlyYoy) || 0,
                revenueGrowth: parseFloat(metric.revenueGrowthQuarterlyYoy) || 0
            };
            
            const norm = calculateScenarios(inputs, price);
            const stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);

            // C. 择时信号
            const low52 = parseFloat(metric['52WeekLow']), high52 = parseFloat(metric['52WeekHigh']);
            let timing = "⏳ 盘整中";
            if (low52 && high52) {
                const pos = (price - low52)/(high52 - low52);
                if (pos < 0.05) timing = "🔪 左侧博弈";
                else if (pos > 0.8) timing = "⚠️ 高位运行";
                else if (norm.conclusion.includes("击球")) timing = "🚀 右侧启动";
            }

            // D. 写入飞书
            const recordUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.record_id}`;
            
            await fetchJson(recordUrl, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        "现价": price,
                        "性价比(PEG)": getVal(norm.peg),
                        "评价": norm.conclusion,
                        "压力测试": `🛡️ ${stress.conclusion}`,
                        "择时信号": timing,
                        "风险": getRiskLevel(norm.riskValue),
                        
                        "悲观估值": getVal(norm.bearPrice),
                        "合理估值": getVal(norm.basePrice),
                        "乐观估值": getVal(norm.bullPrice),

                        "回本(PE)": getVal(metric.peTTM || 20, 1),
                        "过往增速": getVal(metricGrowth5Y) / 100,
                        "营收增速(季)": getVal(metric.revenueGrowthQuarterlyYoy) / 100,
                        
                        // ✅ ROE 核心修复：确保读取到 roeTTM，飞书百分比需 /100
                        "ROE": getVal(metric.roeTTM) / 100,
                        "净利率": getVal(metric.netProfitMarginTTM) / 100,
                        "股息率": (getVal(metric.dividendYieldIndicatedAnnual) || getVal(metric.currentDividendYieldTTM)) / 100,
                        
                        "EPS增速(季)": getVal(metric.epsGrowthQuarterlyYoy) / 100,
                        "EPS增速(TTM)": getVal(metric.epsGrowthTTMYoy) / 100,
                        
                        // ✅ 超链接修复：指向你的网页，文案改为“深度推演”
                        "超链接": { 
                            "text": "👉 深度推演", 
                            "link": `${CONFIG.WEB_URL}/?symbol=${symbol}` 
                        }
                    }
                })
            });
            
            // 报警 (仅当出现新机会时)
            const prevConc = s.fields['评价'] || "";
            if (norm.conclusion.includes("击球区") && !prevConc.includes("击球")) {
                await sendFeishuAlert(symbol, price, "🟢 黄金击球区", `${norm.conclusion}`);
            }

            console.log(`   ✅ 更新成功: ${symbol}`);
            count++;

        } catch (e) {
            console.error(`   ❌ ${symbol} 失败:`, e.message);
        }
        
        await sleep(1500);
    }
    console.log(`=== 全部完成 (成功 ${count} 个) ===`);
};

main();
