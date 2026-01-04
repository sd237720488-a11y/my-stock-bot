// bot.js - AlphaSystem 云端机器人 (Pro版：带监控报警)
// 包含：黄金击球区、择时信号、压力测试、变动报警 (Mode 3)
const https = require('https');

// ================= 0. 配置区 =================
const CONFIG = {
    // 飞书 App 配置 (用于读写表格)
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, 
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,
    
    // 👇 新增：飞书群机器人 Webhook (用于发报警)
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
    
    // Finnhub 配置
    FINNHUB_KEY: process.env.FINNHUB_KEY
};

// ================= 1. 核心模型参数 =================
const STRATEGIES = {
  moderate: { name: "适中 (GARP)", bullMult: 1.2, bearDisc: 0.8, basePegLimit: 1.8, drag: true },
};
const SECTOR_MODELS = { growth: { label: "科技/消费", defaultPE: 25, pegTolerance: 1.2, minRiskFreeImpact: true } };

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeFixed = (num, d=2) => (typeof num === 'number' && !isNaN(num)) ? num.toFixed(d) : 0;

const fetchJson = async (url, options) => {
    const res = await fetch(url, options);
    return await res.json();
};

// 👇 新增：发送飞书卡片报警
const sendFeishuAlert = async (symbol, price, signalType, detail) => {
    if (!CONFIG.FEISHU_WEBHOOK) return;
    
    const color = signalType.includes("击球") ? "green" : "blue"; // 击球区用绿色，右侧启动用蓝色
    
    const cardContent = {
        "msg_type": "interactive",
        "card": {
            "config": { "wide_screen_mode": true },
            "header": {
                "title": { "tag": "plain_text", "content": `🚨 机会报警: ${symbol}` },
                "template": color 
            },
            "elements": [
                {
                    "tag": "div",
                    "text": { "tag": "lark_md", "content": `**当前价格:** $${price}\n**触发信号:** ${signalType}\n**详细评价:** ${detail}` }
                },
                {
                    "tag": "action",
                    "actions": [{
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": "查看详情" },
                        "url": `https://www.google.com/search?q=${symbol}+stock`, // 也可以换成你的飞书表格链接
                        "type": "primary"
                    }]
                }
            ]
        }
    };

    try {
        await fetch(CONFIG.FEISHU_WEBHOOK, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(cardContent)
        });
        console.log(`🔔 已发送报警: ${symbol}`);
    } catch (e) {
        console.error("报警发送失败", e);
    }
};

// ================= 3. 核心算法复刻 =================

// 3.1 智能增速
const getSmartGrowthInputs = (stock) => {
    const metric = stock.metricRaw || {};
    const systemPastGrowth = stock.metricGrowth5Y || 0;
    const growthTTM = metric.epsGrowthTTMYoy ? parseFloat(metric.epsGrowthTTMYoy) : 0;
    const qtrRevGrowth = metric.revenueGrowthQuarterlyYoy ? parseFloat(metric.revenueGrowthQuarterlyYoy) : 0;
    const revGrowthTTM = metric.revenueGrowthTTMYoy ? parseFloat(metric.revenueGrowthTTMYoy) : 0;
    const revGrowth5Y = metric.revenueGrowth5Y ? parseFloat(metric.revenueGrowth5Y) : 0;
    const isLoss = !stock.metricEPS || stock.metricEPS <= 0;
    const showRevenueTrend = isLoss || (metric.epsGrowthTTMYoy === null || metric.epsGrowthTTMYoy === undefined);

    let defaultGrowthVal = 8;
    if (showRevenueTrend) {
       const recentRevMax = Math.max(parseFloat(revGrowthTTM) || 0, parseFloat(qtrRevGrowth) || 0);
       if (recentRevMax > 0) defaultGrowthVal = Math.min(recentRevMax, 50); 
       else if (!isNaN(parseFloat(revGrowth5Y))) defaultGrowthVal = parseFloat(revGrowth5Y);
    } else {
       const pastG = parseFloat(systemPastGrowth);
       const ttmG = parseFloat(growthTTM);
       if (!isNaN(ttmG) && ttmG > 0 && (!isNaN(pastG) && ttmG > pastG + 10)) defaultGrowthVal = Math.min(ttmG, 50); 
       else if (!isNaN(pastG) && pastG > -50 && pastG < 500) defaultGrowthVal = pastG;
    }
    return { defaultGrowthVal };
};

// 3.2 风险评级
const getRiskLevel = (score) => {
  if (score === null || score === undefined) return "-";
  if (score <= 20) return "边际极高";
  if (score <= 40) return "边际充足";
  if (score <= 60) return "风险适中";
  if (score <= 80) return "估值脆弱";
  return "高波动";
};

// 3.3 估值引擎
const calculateScenarios = (baseInputs, currentPrice, strategyKey = 'moderate') => {
  const { eps, growthRate, peRatio, riskFreeRate = 4.5, revenueGrowth = 0, pastGrowth = 0, qtrEpsGrowth = 0, roe = 0 } = baseInputs; 
  const strat = STRATEGIES[strategyKey];
  let adjustedGrowth = Number(growthRate) || 0;
  if (adjustedGrowth > 50) adjustedGrowth = 50; 

  if (!eps || eps <= 0) {
    if (revenueGrowth > 25) return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0 };
    return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0 };
  }

  let targetPE = peRatio; 
  let bullMult = strat.bullMult, bearDisc = strat.bearDisc;

  if (adjustedGrowth < 5 && targetPE > 15) targetPE = 12; 
  if (qtrEpsGrowth > (pastGrowth + 15)) { bullMult += 0.3; adjustedGrowth = Math.max(adjustedGrowth, qtrEpsGrowth * 0.8); }
  let valuationDrag = 1.0;
  if (strat.drag && targetPE * riskFreeRate > 100) valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate))); 
  if (roe > 25) bearDisc += 0.15; 

  const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (adjustedGrowth * 0.3) / 100);
  const basePrice = eps * (targetPE * valuationDrag) * (1 + adjustedGrowth / 100);
  const bullPrice = eps * (targetPE * bullMult * valuationDrag) * (1 + (adjustedGrowth * 1.3) / 100);
  const peg = targetPE / (adjustedGrowth || 1); 

  let valScore = currentPrice < bearPrice ? 50 : (currentPrice > bullPrice ? 0 : 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice))));
  let qualityScore = Math.min(Math.max(roe, 0), 30); 
  let growthScore = peg < 1.0 ? 20 : (peg > 3.0 ? 0 : 20 * ((3 - peg) / 2));
  const riskValue = 100 - (valScore + qualityScore + growthScore);

  let conclusion = "";
  const isTrap = targetPE < 10 && adjustedGrowth < 2;
  const isOverdraft = peg > 3.0 && adjustedGrowth < 15;

  if (isTrap) conclusion = "价值陷阱 (观望)";
  else if (isOverdraft) conclusion = "估值透支";
  else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区";
  else if (currentPrice < basePrice * 0.95) conclusion = "长坡厚雪 (买入)";
  else if (currentPrice < basePrice * 1.1) conclusion = "合理区间 (持有)";
  else conclusion = "非理性繁荣 (减仓)";

  return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 4. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem Bot 启动 ===");
    
    // 1. 获取 Token
    const authRes = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = authRes.tenant_access_token;
    if (!token) { console.error("❌ 飞书鉴权失败"); return; }

    // 2. 拉取股票 (包含旧状态！)
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!listRes.data?.items) { console.log("⚠️ 表格为空"); return; }

    const stocks = listRes.data.items.map(i => ({
        id: i.record_id,
        symbol: i.fields['代码'] || i.fields.symbol,
        price: i.fields['现价'] || 0,
        // 👇 关键：记录旧状态，用于对比
        prevConclusion: i.fields['评价'] || "",
        prevTiming: i.fields['择时信号'] || ""
    })).filter(s => s.symbol);

    console.log(`📡 扫描 ${stocks.length} 只股票...`);

    // 3. 循环处理
    for (let s of stocks) {
        if (s.symbol.includes('.') && !s.symbol.includes('.US')) continue;

        try {
            // A. 抓数据
            const qRes = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${s.symbol}&token=${CONFIG.FINNHUB_KEY}`);
            const mRes = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${s.symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`);
            if (!qRes.c || !mRes.metric) continue;

            const price = qRes.c;
            const m = mRes.metric;
            
            // B. 计算参数
            const stockObj = { metricRaw: m, metricEPS: m.epsTTM, metricGrowth5Y: m.epsGrowth5Y || m.epsGrowthTTMYoy, metricPE: m.peTTM };
            const { defaultGrowthVal } = getSmartGrowthInputs(stockObj);

            const baseInputs = {
                eps: m.epsTTM, growthRate: defaultGrowthVal, peRatio: m.peTTM || 20, riskFreeRate: 4.5,
                revenueGrowth: parseFloat(m.revenueGrowthQuarterlyYoy) || 0, pastGrowth: parseFloat(m.epsGrowth5Y) || 0,
                qtrEpsGrowth: parseFloat(m.epsGrowthQuarterlyYoy) || 0, roe: parseFloat(m.roeTTM) || 0
            };

            // C. 计算结果
            const norm = calculateScenarios(baseInputs, price);
            const stress = calculateScenarios({ ...baseInputs, growthRate: baseInputs.growthRate * 0.7, peRatio: baseInputs.peRatio * 0.8 }, price);

            // D. 择时逻辑
            const low52 = parseFloat(m['52WeekLow']), high52 = parseFloat(m['52WeekHigh']);
            let timingSignal = "⏳ 盘整中";
            if (low52 && high52) {
                const pos = (price - low52) / (high52 - low52);
                const rebound = (price - low52) / low52;
                if (pos < 0.05) timingSignal = "🔪 左侧博弈 (接飞刀)";
                else if (rebound > 0.05 && rebound < 0.20) {
                    if (norm.conclusion.includes("击球区") || norm.conclusion.includes("长坡")) timingSignal = "🚀 右侧启动 (最佳买点)"; 
                    else timingSignal = "📈 底部反弹";
                } else if (pos > 0.8) timingSignal = "⚠️ 高位运行";
                else if (pos > 0.4 && pos < 0.6) timingSignal = "😴 鱼身盘整";
            }

            // ==========================================
            // 🚨 核心报警逻辑 (Mode 3: 变动报警)
            // ==========================================
            const isGoodValuation = norm.conclusion.includes("击球区");
            const isGoodTiming = timingSignal.includes("右侧启动");
            
            // 策略 B: 任意好信号触发
            if (isGoodValuation || isGoodTiming) {
                // 检查是否是"新"信号 (对比飞书里的旧数据)
                const valuationChanged = !s.prevConclusion.includes("击球区") && isGoodValuation;
                const timingChanged = !s.prevTiming.includes("右侧启动") && isGoodTiming;
                
                // 只有当状态 *发生改变* 且 *变好* 时，才发报警
                if (valuationChanged || timingChanged) {
                    const alertType = valuationChanged ? "🟢 黄金击球区" : "🚀 右侧启动";
                    console.log(`⚡ 触发报警: ${s.symbol} -> ${alertType}`);
                    await sendFeishuAlert(s.symbol, price, alertType, `${norm.conclusion} | ${timingSignal}`);
                }
            }

            // E. 写回飞书
            await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        "现价": price,
                        "性价比(PEG)": parseFloat(safeFixed(norm.peg)),
                        "评价": norm.conclusion,
                        "压力测试": `🛡️ ${stress.conclusion}`,
                        "择时信号": timingSignal,
                        "风险": getRiskLevel(norm.riskValue),
                        // 👇👇👇【把这三行加进去】👇👇👇
                        "悲观估值": parseFloat(safeFixed(norm.bearPrice)),
                        "合理估值": parseFloat(safeFixed(norm.basePrice)),
                        "乐观估值": parseFloat(safeFixed(norm.bullPrice)),
                        // 👆👆👆【新增结束】👆👆👆
                        "回本(PE)": parseFloat(safeFixed(m.peTTM || 20, 1)),
                        "过往增速": parseFloat(safeFixed(m.epsGrowth5Y, 2)) / 100,
                        "营收增速(季)": parseFloat(safeFixed(m.revenueGrowthQuarterlyYoy, 2)) / 100
                    }
                })
            });

        } catch (e) { console.error(`❌ ${s.symbol}`, e.message); }
        await sleep(800);
    }
    console.log("=== 完成 ===");
};

main();
