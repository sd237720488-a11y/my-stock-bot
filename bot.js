// bot.js - AlphaSystem 云端机器人 (V5.1 终极全功能版)
// 包含：三色估值写入、黄金击球区、价值陷阱/透支判断、报警推送、全市场支持、详细日志
const https = require('https');

// ================= 0. 配置区 (环境变量) =================
const CONFIG = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, 
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK, // 报警机器人Webhook
    FINNHUB_KEY: process.env.FINNHUB_KEY
};

// ================= 1. 核心模型参数 =================
const STRATEGIES = {
  moderate: { name: "适中 (GARP)", bullMult: 1.2, bearDisc: 0.8, basePegLimit: 1.8, drag: true },
};

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ... (保留上面的 CONFIG, STRATEGIES 和 sleep 函数)

// ============================================================
// 👇👇👇 从这里开始复制，覆盖掉原文件下方所有的代码 👇👇👇
// ============================================================

// 辅助函数：安全保留小数 (旧版兼容)
const safeFixed = (num, d=2) => (typeof num === 'number' && !isNaN(num)) ? num.toFixed(d) : 0;

// ================= 核心修复 1: 网络请求封装 (显式报错) =================
const fetchJson = async (url, options) => {
    try {
        const res = await fetch(url, options);
        if (!res.ok) {
            // 读取飞书返回的具体错误文本 (例如: "Field value is invalid")
            const errorText = await res.text(); 
            throw new Error(`HTTP ${res.status} - ${errorText}`);
        }
        return await res.json();
    } catch (e) {
        throw e; // 抛出错误，让主程序捕获并打印是哪只股票出错
    }
};

// ================= 核心修复 2: 强力数据清洗函数 (解决 NVDA 写入失败) =================
const getVal = (val, d = 2) => {
    // 1. 处理 null, undefined, 空字符串
    if (val === null || val === undefined || val === '') return 0;
    
    // 2. 尝试转数字
    const num = parseFloat(val);
    
    // 3. 处理 NaN (非数字) 和 Infinity (无穷大，比如除以0导致)
    if (isNaN(num) || !isFinite(num)) return 0;
    
    // 4. 正常返回
    return parseFloat(num.toFixed(d));
};

// 发送飞书卡片报警 (保持不变)
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
                { "tag": "div", "text": { "tag": "lark_md", "content": "💡 *请结合本地网页版进行压力测试复核*" } }
            ]
        }
    };
    try {
        await fetch(CONFIG.FEISHU_WEBHOOK, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cardContent)
        });
        console.log(`🔔 已推送报警: ${symbol}`);
    } catch (e) { console.error("报警发送失败", e); }
};

// ================= 3. 核心算法 (逻辑保持不变) =================

const getSmartGrowthInputs = (stock) => {
    const m = stock.metricRaw || {};
    const growthTTM = parseFloat(m.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const revG = parseFloat(m.revenueGrowthQuarterlyYoy) || 0;
    let val = 8;
    if (!stock.metricEPS || stock.metricEPS <= 0) {
        val = revG > 0 ? Math.min(revG, 50) : 5; 
    } else {
        if (growthTTM > 0 && growthTTM > pastG + 10) val = Math.min(growthTTM, 50);
        else val = (pastG > -50 ? pastG : 5);
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

  if (!eps || eps <= 0) {
    if (baseInputs.revenueGrowth > 25) return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
    return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
  }

  let targetPE = peRatio;
  if (g < 5 && targetPE > 15) targetPE = 12; 
  let valuationDrag = 1.0;
  if (targetPE * riskFreeRate > 100) valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate)));
  let bearDisc = 0.8;
  if (roe > 25) bearDisc += 0.15; 

  const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (g * 0.3) / 100);
  const basePrice = eps * (targetPE * valuationDrag) * (1 + g / 100);
  const bullPrice = eps * (targetPE * 1.2 * valuationDrag) * (1 + (g * 1.3) / 100);
  const peg = targetPE / (g || 1);

  let conclusion = "合理区间 (持有)";
  const isTrap = targetPE < 10 && g < 2;     
  const isOverdraft = peg > 3.0 && g < 15;   

  if (isTrap) conclusion = "☠️ 价值陷阱";
  else if (isOverdraft) conclusion = "🔴 估值透支";
  else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区";
  else if (currentPrice < basePrice * 0.95) conclusion = "🔵 长坡厚雪";
  else if (currentPrice > bullPrice) conclusion = "🔴 非理性繁荣";

  let valScore = currentPrice < bearPrice ? 50 : (currentPrice > bullPrice ? 0 : 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice))));
  let qualityScore = Math.min(Math.max(roe, 0), 30);
  let growthScore = peg < 1.0 ? 20 : (peg > 3.0 ? 0 : 20 * ((3 - peg) / 2));
  let riskValue = 100 - (valScore + qualityScore + growthScore);

  return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 4. 主程序 (核心修复版) =================
const main = async () => {
    console.log("=== AlphaSystem V5.1 (修复版) 启动 ===");
    
    // 1. 飞书鉴权
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    }).catch(e => { console.error("鉴权失败", e); return {}; });
    
    const token = auth.tenant_access_token;
    if (!token) return;

    // 2. 获取股票列表
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } }).catch(e => ({}));
    const stocks = listRes.data?.items || [];
    console.log(`📡 扫描到 ${stocks.length} 只股票，开始分析...`);

    let count = 0;
    
    // 3. 循环处理
    for (let s of stocks) {
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;
        
        console.log(`Processing: ${symbol}...`);

        try {
            // A. 获取数据 (增加 try-catch 避免单个失败卡死)
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            const m = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            
            if (!q.c) { console.log(`   ⚠️ ${symbol}: 暂无价格/API限制`); await sleep(1000); continue; }
            
            const price = q.c;
            const metric = m.metric || {};
            
            // B. 计算参数
            const { defaultGrowthVal } = getSmartGrowthInputs({ metricRaw: metric, metricEPS: metric.epsTTM, metricGrowth5Y: metric.epsGrowth5Y });
            
            const inputs = {
                eps: metric.epsTTM, 
                growthRate: defaultGrowthVal, 
                peRatio: metric.peTTM || 20, 
                roe: parseFloat(metric.roeTTM)||0,
                revenueGrowth: parseFloat(metric.revenueGrowthQuarterlyYoy)||0
            };
            
            const norm = calculateScenarios(inputs, price);
            const stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);

            // C. 技术面
            const low52 = parseFloat(metric['52WeekLow']), high52 = parseFloat(metric['52WeekHigh']);
            let timing = "⏳ 盘整中";
            if (low52 && high52) {
                const pos = (price - low52)/(high52 - low52);
                if (pos < 0.05) timing = "🔪 左侧博弈";
                else if (pos > 0.8) timing = "⚠️ 高位运行";
                else if (norm.conclusion.includes("击球")) timing = "🚀 右侧启动";
            }

            // D. 报警检测
            const prevConc = s.fields['评价'] || "";
            const isValuationGood = norm.conclusion.includes("击球区");
            if (isValuationGood && !prevConc.includes("击球")) {
                await sendFeishuAlert(symbol, price, "🟢 黄金击球区", `${norm.conclusion}`);
            }

            // E. 写入飞书 (修复了所有格式问题)
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
                        
                        // 估值
                        "悲观估值": getVal(norm.bearPrice),
                        "合理估值": getVal(norm.basePrice),
                        "乐观估值": getVal(norm.bullPrice),

                        // 核心指标
                        "回本(PE)": getVal(metric.peTTM || 20, 1),
                        // 飞书百分比列需要 /100
                        "过往增速": getVal(metric.epsGrowth5Y) / 100,
                        "营收增速(季)": getVal(metric.revenueGrowthQuarterlyYoy) / 100,
                        "ROE": getVal(metric.roeTTM) / 100,
                        "净利率": getVal(metric.netProfitMarginTTM) / 100,
                        
                        // 股息率 (修复: 增加备选字段)
                        "股息率": (getVal(metric.dividendYieldIndicatedAnnual) || getVal(metric.currentDividendYieldTTM)) / 100,
                        
                        "EPS增速(季)": getVal(metric.epsGrowthQuarterlyYoy) / 100,
                        "EPS增速(TTM)": getVal(metric.epsGrowthTTMYoy) / 100,
                        
                        // 超链接 (修复: 必须是对象结构)
                        "超链接": {
                            "text": "Finviz图表",
                            "link": `https://finviz.com/quote.ashx?t=${symbol}`
                        }
                    }
                })
            });
            
            console.log(`   ✅ 更新成功: ${symbol}`);
            count++;

        } catch (e) {
            // 这里会打印具体的飞书错误 (如 "Field value invalid")
            console.error(`   ❌ ${symbol} 失败:`, e.message);
        }
        
        // 稍微休息，Finnhub 免费版限制
        await sleep(1500);
    }
    console.log(`=== 全部完成 (成功 ${count} 个) ===`);
};

main();
