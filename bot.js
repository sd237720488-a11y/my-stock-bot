// bot.js - AlphaSystem 云端机器人 (完全同步 React v4.0 版)
// 包含：黄金击球区、择时信号、压力测试、ROE质量因子
const https = require('https');

// ================= 0. 配置区 (优先读取环境变量，用于 GitHub Actions) =================
const CONFIG = {
    // 飞书配置 (对应你的 React 代码)
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, // 链接里的 token
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,   // 链接里的 tableId
    
    // Finnhub 配置
    FINNHUB_KEY: process.env.FINNHUB_KEY
};

// ================= 1. 核心模型参数 (与 React 保持一致) =================
const STRATEGIES = {
  moderate: { name: "适中 (GARP)", bullMult: 1.2, bearDisc: 0.8, basePegLimit: 1.8, drag: true },
};

const SECTOR_MODELS = {
  growth: { label: "科技/消费", defaultPE: 25, pegTolerance: 1.2, minRiskFreeImpact: true }
};

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeFixed = (num, d=2) => (typeof num === 'number' && !isNaN(num)) ? num.toFixed(d) : 0;

// 网络请求封装
const fetchJson = async (url, options) => {
    const res = await fetch(url, options);
    return await res.json();
};

// ================= 3. 核心算法复刻 (The Brain) =================

// 3.1 智能增速判断 (复刻 getSmartGrowthInputs)
const getSmartGrowthInputs = (stock) => {
    const metric = stock.metricRaw || {};
    const systemPastGrowth = stock.metricGrowth5Y || 0;
    const growthTTM = metric.epsGrowthTTMYoy ? parseFloat(metric.epsGrowthTTMYoy) : 0;
    const qtrRevGrowth = metric.revenueGrowthQuarterlyYoy ? parseFloat(metric.revenueGrowthQuarterlyYoy) : 0;
    const revGrowthTTM = metric.revenueGrowthTTMYoy ? parseFloat(metric.revenueGrowthTTMYoy) : 0;
    const revGrowth5Y = metric.revenueGrowth5Y ? parseFloat(metric.revenueGrowth5Y) : 0;
    
    // Check if unprofitable
    const isLoss = !stock.metricEPS || stock.metricEPS <= 0;
    const showRevenueTrend = isLoss || (metric.epsGrowthTTMYoy === null || metric.epsGrowthTTMYoy === undefined);

    let defaultGrowthVal = 8;

    if (showRevenueTrend) {
       const recentRevMax = Math.max(parseFloat(revGrowthTTM) || 0, parseFloat(qtrRevGrowth) || 0);
       if (recentRevMax > 0) {
          defaultGrowthVal = Math.min(recentRevMax, 50); 
       } else if (!isNaN(parseFloat(revGrowth5Y))) {
          defaultGrowthVal = parseFloat(revGrowth5Y);
       }
    } else {
       const pastG = parseFloat(systemPastGrowth);
       const ttmG = parseFloat(growthTTM);
       if (!isNaN(ttmG) && ttmG > 0 && (!isNaN(pastG) && ttmG > pastG + 10)) {
          defaultGrowthVal = Math.min(ttmG, 50); 
       } else if (!isNaN(pastG) && pastG > -50 && pastG < 500) {
          defaultGrowthVal = pastG;
       }
    }
    return { defaultGrowthVal };
};

// 3.2 风险评级文案 (复刻 getRiskLevel - 敬畏市场版)
const getRiskLevel = (score) => {
  if (score === null || score === undefined) return "-";
  if (score <= 20) return "边际极高";  // Green
  if (score <= 40) return "边际充足";  // Emerald
  if (score <= 60) return "风险适中";  // Yellow
  if (score <= 80) return "估值脆弱";  // Orange
  return "高波动";                     // Red
};

// 3.3 核心估值引擎 (复刻 AlphaCore v4.0 Professional)
const calculateScenarios = (baseInputs, currentPrice, strategyKey = 'moderate') => {
  const { eps, growthRate, peRatio, riskFreeRate = 4.5, revenueGrowth = 0, pastGrowth = 0, qtrEpsGrowth = 0, roe = 0 } = baseInputs; 
  const strat = STRATEGIES[strategyKey];
  const sector = SECTOR_MODELS['growth'];
  
  let adjustedGrowth = Number(growthRate) || 0;
  if (adjustedGrowth > 50) adjustedGrowth = 50; 

  // --- 1. 亏损股特判 ---
  if (!eps || eps <= 0) {
    if (revenueGrowth > 25) {
      return {
        conclusion: "🔥 困境反转",
        riskValue: 40, peg: 0, bearPrice: 0, basePrice: 0, bullPrice: 0
      };
    }
    return {
      conclusion: "☠️ 垃圾/亏损",
      riskValue: 99, peg: 0, bearPrice: 0, basePrice: 0, bullPrice: 0
    };
  }

  // --- 2. 动态 PE 调整 ---
  let targetPE = peRatio; 
  let bullMult = strat.bullMult;
  let bearDisc = strat.bearDisc;

  // A. 低增速熔断
  if (adjustedGrowth < 5 && targetPE > 15) targetPE = 12; 
  // B. 业绩加速
  if (qtrEpsGrowth > (pastGrowth + 15)) { bullMult += 0.3; adjustedGrowth = Math.max(adjustedGrowth, qtrEpsGrowth * 0.8); }
  // C. 高息压制
  let valuationDrag = 1.0;
  if (strat.drag && targetPE * riskFreeRate > 100) {
    valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate))); 
  }
  // D. 护城河 (ROE > 25)
  if (roe > 25) bearDisc += 0.15; 

  // --- 3. 计算价格 ---
  const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (adjustedGrowth * 0.3) / 100);
  const basePrice = eps * (targetPE * valuationDrag) * (1 + adjustedGrowth / 100);
  const bullPrice = eps * (targetPE * bullMult * valuationDrag) * (1 + (adjustedGrowth * 1.3) / 100);
  const peg = targetPE / (adjustedGrowth || 1); 

  // --- 4. 风险评分 (Safety Score) ---
  let valScore = 0;
  if (currentPrice < bearPrice) valScore = 50;
  else if (currentPrice > bullPrice) valScore = 0;
  else valScore = 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice)));

  let qualityScore = Math.min(Math.max(roe, 0), 30); 
  let growthScore = peg < 1.0 ? 20 : (peg > 3.0 ? 0 : 20 * ((3 - peg) / 2));
  const riskValue = 100 - (valScore + qualityScore + growthScore);

  // --- 5. 生成评价文案 (你的最新版) ---
  let conclusion = "";
  // 陷阱/透支判定略...简化处理通用逻辑
  const isTrap = targetPE < 10 && adjustedGrowth < 2;
  const isOverdraft = peg > 3.0 && adjustedGrowth < 15;

  if (isTrap) conclusion = "价值陷阱 (观望)";
  else if (isOverdraft) conclusion = "估值透支";
  else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区"; // 核心文案
  else if (currentPrice < basePrice * 0.95) conclusion = "长坡厚雪 (买入)"; // 核心文案
  else if (currentPrice < basePrice * 1.1) conclusion = "合理区间 (持有)";
  else conclusion = "非理性繁荣 (减仓)";

  return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 4. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem Bot 启动 ===");
    
    // 1. 获取飞书 Token
    const authRes = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = authRes.tenant_access_token;
    if (!token) { console.error("❌ 飞书鉴权失败，请检查 AppID 和 Secret"); return; }

    // 2. 拉取股票列表
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    
    if (!listRes.data || !listRes.data.items) { console.log("⚠️ 飞书表格是空的"); return; }

    const stocks = listRes.data.items.map(i => ({
        id: i.record_id,
        symbol: i.fields['代码'] || i.fields.symbol,
        price: i.fields['现价'] || 0
    })).filter(s => s.symbol);

    console.log(`📡 发现 ${stocks.length} 只股票，开始分析...`);

    // 3. 循环处理 (复刻 handleSyncOne 逻辑)
    for (let s of stocks) {
        // 简单过滤非美股带点的 (除非是 .US)
        if (s.symbol.includes('.') && !s.symbol.includes('.US')) continue;

        try {
            // A. 抓 Finnhub 数据
            const qRes = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${s.symbol}&token=${CONFIG.FINNHUB_KEY}`);
            const mRes = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${s.symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`);
            
            if (!qRes.c || !mRes.metric) { console.log(`⏳ ${s.symbol}: 数据缺失，跳过`); continue; }

            const price = qRes.c;
            const m = mRes.metric;
            
            // 构造对象以复用 getSmartGrowthInputs
            const stockObj = {
                metricRaw: m,
                metricEPS: m.epsTTM,
                metricGrowth5Y: m.epsGrowth5Y || m.epsGrowthTTMYoy,
                metricPE: m.peTTM
            };
            const { defaultGrowthVal } = getSmartGrowthInputs(stockObj);

            // B. 准备参数 (包含 ROE!)
            const baseInputs = {
                eps: m.epsTTM, 
                growthRate: defaultGrowthVal, 
                peRatio: m.peTTM || 20,
                riskFreeRate: 4.5,
                revenueGrowth: parseFloat(m.revenueGrowthQuarterlyYoy) || 0,
                pastGrowth: parseFloat(m.epsGrowth5Y) || 0,
                qtrEpsGrowth: parseFloat(m.epsGrowthQuarterlyYoy) || 0,
                roe: parseFloat(m.roeTTM) || 0 // 核心：复刻 ROE 逻辑
            };

            // C. 跑双模计算 (标准 + 压力)
            const norm = calculateScenarios(baseInputs, price); // 标准
            const stressInputs = { ...baseInputs, growthRate: baseInputs.growthRate * 0.7, peRatio: baseInputs.peRatio * 0.8 };
            const stress = calculateScenarios(stressInputs, price); // 压力

            // D. 技术面择时逻辑 (Technical Timing)
            const low52 = parseFloat(m['52WeekLow']);
            const high52 = parseFloat(m['52WeekHigh']);
            let timingSignal = "⏳ 盘整中";
            
            if (low52 && high52) {
                const pos = (price - low52) / (high52 - low52);
                const rebound = (price - low52) / low52;

                if (pos < 0.05) {
                    timingSignal = "🔪 左侧博弈 (接飞刀)";
                } else if (rebound > 0.05 && rebound < 0.20) {
                    // 底部反弹 5%-20%
                    if (norm.conclusion.includes("击球区") || norm.conclusion.includes("长坡")) {
                       timingSignal = "🚀 右侧启动 (最佳买点)"; 
                    } else {
                       timingSignal = "📈 底部反弹";
                    }
                } else if (pos > 0.8) {
                    timingSignal = "⚠️ 高位运行";
                } else if (pos > 0.4 && pos < 0.6) {
                    timingSignal = "😴 鱼身盘整";
                }
            }

            // E. 构造飞书数据包
            const updateBody = {
                fields: {
                    "现价": price,
                    "性价比(PEG)": parseFloat(safeFixed(norm.peg)),
                    
                    "评价": norm.conclusion,       // 包含 "黄金击球区"
                    "压力测试": `🛡️ ${stress.conclusion}`, // 包含盾牌图标
                    "择时信号": timingSignal,      // 包含火箭/飞刀图标
                    "风险": getRiskLevel(norm.riskValue), // 包含 "边际极高/充足"
                    
                    "回本(PE)": parseFloat(safeFixed(m.peTTM || 20, 1)),
                    "过往增速": parseFloat(safeFixed(m.epsGrowth5Y, 2)) / 100,
                    "营收增速(季)": parseFloat(safeFixed(m.revenueGrowthQuarterlyYoy, 2)) / 100
                }
            };

            // F. 写入飞书
            await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(updateBody)
            });

            console.log(`✅ ${s.symbol}: ${norm.conclusion} | ${timingSignal}`);

        } catch (e) {
            console.error(`❌ ${s.symbol} 出错:`, e.message);
        }
        
        // 稍微休息，防 API 拥堵
        await sleep(800);
    }
    console.log("=== 全部同步完成 ===");
};

main();