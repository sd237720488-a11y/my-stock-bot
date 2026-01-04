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
const safeFixed = (num, d=2) => (typeof num === 'number' && !isNaN(num)) ? num.toFixed(d) : 0;

// 网络请求封装 (带错误捕获)
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

// 发送飞书卡片报警
const sendFeishuAlert = async (symbol, price, signalType, detail) => {
    if (!CONFIG.FEISHU_WEBHOOK) return;
    const color = signalType.includes("击球") ? "green" : "blue"; // 击球区绿卡，启动蓝卡
    
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
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(cardContent)
        });
        console.log(`🔔 已推送报警: ${symbol}`);
    } catch (e) {
        console.error("报警发送失败", e);
    }
};

// ================= 3. 核心算法 (逻辑完整复刻) =================

// 3.1 智能增速判断
const getSmartGrowthInputs = (stock) => {
    const m = stock.metricRaw || {};
    const growthTTM = parseFloat(m.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const revG = parseFloat(m.revenueGrowthQuarterlyYoy) || 0;
    
    // 逻辑：亏损股看营收，盈利股看利润
    let val = 8;
    if (!stock.metricEPS || stock.metricEPS <= 0) {
        // 如果是亏损股，取营收增速，最大给到 50%
        val = revG > 0 ? Math.min(revG, 50) : 5; 
    } else {
        // 如果是盈利股，看近期是否加速
        if (growthTTM > 0 && growthTTM > pastG + 10) {
            // 近期爆发，取中间值防骗
            val = Math.min(growthTTM, 50);
        } else {
            // 否则取长期平均，但不低于 5%
            val = (pastG > -50 ? pastG : 5);
        }
    }
    return { defaultGrowthVal: val };
};

// 3.2 风险评级文案
const getRiskLevel = (score) => {
  if (!score && score !== 0) return "-";
  if (score <= 20) return "边际极高";
  if (score <= 40) return "边际充足";
  if (score <= 60) return "风险适中";
  if (score <= 80) return "估值脆弱";
  return "高波动";
};

// 3.3 估值引擎 (AlphaCore V5)
const calculateScenarios = (baseInputs, currentPrice) => {
  const { eps, growthRate, peRatio, riskFreeRate=4.5, roe=0 } = baseInputs; 
  let g = Math.min(Number(growthRate) || 0, 50); // 增速上限锁死 50%

  // A. 亏损股特判
  if (!eps || eps <= 0) {
    if (baseInputs.revenueGrowth > 25) {
        return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
    }
    return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
  }

  // B. 动态 PE 调整
  let targetPE = peRatio;
  // 1. 熔断机制：增速太低，强制杀估值
  if (g < 5 && targetPE > 15) targetPE = 12; 
  
  // 2. 高息压制：利息越高，估值打折越狠
  let valuationDrag = 1.0;
  if (targetPE * riskFreeRate > 100) {
      valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate)));
  }
  
  // 3. 质量加分：ROE高的给溢价
  let bearDisc = 0.8;
  if (roe > 25) bearDisc += 0.15; 

  // C. 计算三档价格
  const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (g * 0.3) / 100);
  const basePrice = eps * (targetPE * valuationDrag) * (1 + g / 100);
  const bullPrice = eps * (targetPE * 1.2 * valuationDrag) * (1 + (g * 1.3) / 100);
  
  // D. 计算 PEG
  const peg = targetPE / (g || 1);

  // E. 生成结论 (恢复了陷阱和透支判断！)
  let conclusion = "合理区间 (持有)";
  const isTrap = targetPE < 10 && g < 2;     // PE低但没增长 = 陷阱
  const isOverdraft = peg > 3.0 && g < 15;   // PEG高且增长慢 = 透支

  if (isTrap) conclusion = "☠️ 价值陷阱";
  else if (isOverdraft) conclusion = "🔴 估值透支";
  else if (currentPrice < bearPrice) conclusion = "🟢 黄金击球区";
  else if (currentPrice < basePrice * 0.95) conclusion = "🔵 长坡厚雪";
  else if (currentPrice > bullPrice) conclusion = "🔴 非理性繁荣";

  // F. 计算风险分 (0-100)
  let valScore = currentPrice < bearPrice ? 50 : (currentPrice > bullPrice ? 0 : 50 * (1 - ((currentPrice - bearPrice) / (bullPrice - bearPrice))));
  let qualityScore = Math.min(Math.max(roe, 0), 30);
  // PEG 越低分越高
  let growthScore = peg < 1.0 ? 20 : (peg > 3.0 ? 0 : 20 * ((3 - peg) / 2));
  
  let riskValue = 100 - (valScore + qualityScore + growthScore);

  return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// ================= 4. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem V5.1 (Full) 启动 ===");
    
    // 1. 飞书鉴权
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = auth.tenant_access_token;
    if (!token) { console.error("❌ 飞书 Token 获取失败"); return; }

    // 2. 获取股票列表
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const stocks = listRes.data?.items || [];
    console.log(`📡 扫描到 ${stocks.length} 只股票，开始分析...`);

    let count = 0;
   // 3. 循环处理每一只股票
    for (let s of stocks) {
        // [1. 标准化代码]
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;

        // [2. 精准增量判断]
        const now = Date.now();
        const lastUpdateTime = s.updated_time || 0; 
        const currentPrice = s.fields['现价'];

        // 逻辑：如果已经有价格，且距离上次更新不到 1 小时，就跳过
        if (currentPrice > 0 && (now - lastUpdateTime < 3600000)) {
            console.log(`⏩ 跳过 (1小时内已更新): ${symbol}`);
            continue; 
        }

        // [3. 频率控制] 为了防止 Finnhub 429 报错，开始请求前先打印日志
        console.log(`🚀 Processing: ${symbol}...`);

        try {
            // 这里开始你原来的 A. 获取 Finnhub 数据...
            // A. 获取 Finnhub 数据
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`);
            const m = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`);
            
            if (!q.c) { console.log(`   ⚠️ ${symbol}: 暂无价格数据`); continue; }
            
            const price = q.c;
            const metric = m.metric || {};
            
            // B. 准备计算参数
            const { defaultGrowthVal } = getSmartGrowthInputs({ metricRaw: metric, metricEPS: metric.epsTTM, metricGrowth5Y: metric.epsGrowth5Y });
            
            const inputs = {
                eps: metric.epsTTM, 
                growthRate: defaultGrowthVal, 
                peRatio: metric.peTTM || 20, 
                roe: parseFloat(metric.roeTTM)||0,
                revenueGrowth: parseFloat(metric.revenueGrowthQuarterlyYoy)||0
            };
            
            // C. 执行计算 (标准 + 压力测试)
            const norm = calculateScenarios(inputs, price);
            const stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);

            // D. 技术面择时信号
            const low52 = parseFloat(metric['52WeekLow']), high52 = parseFloat(metric['52WeekHigh']);
            let timing = "⏳ 盘整中";
            if (low52 && high52) {
                const pos = (price - low52)/(high52 - low52);
                const reb = (price - low52)/low52;
                
                if (pos < 0.05) timing = "🔪 左侧博弈";
                else if (reb > 0.05 && reb < 0.20) {
                     // 只有在基本面好的时候，才叫右侧启动；否则只是反弹
                     if (norm.conclusion.includes("击球") || norm.conclusion.includes("长坡")) timing = "🚀 右侧启动";
                     else timing = "📈 底部反弹";
                }
                else if (pos > 0.8) timing = "⚠️ 高位运行";
                else if (pos > 0.4 && pos < 0.6) timing = "😴 鱼身盘整";
            }

            // E. 报警逻辑 (策略B: 任意好信号触发)
            const prevConc = s.fields['评价'] || "";
            const prevTiming = s.fields['择时信号'] || "";
            
            const isValuationGood = norm.conclusion.includes("击球区");
            const isTimingGood = timing.includes("右侧启动");
            
            // 只有当状态变好时才报警
            if ((isValuationGood && !prevConc.includes("击球")) || (isTimingGood && !prevTiming.includes("右侧"))) {
                const signalName = isValuationGood ? "🟢 黄金击球区" : "🚀 右侧启动";
                await sendFeishuAlert(symbol, price, signalName, `${norm.conclusion} | ${timing}`);
                console.log(`   ⚡ 触发报警: ${symbol}`);
            }

            // F. 写入飞书 (三列估值 + 其他字段)
            await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.record_id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        "现价": price,
                        "性价比(PEG)": parseFloat(safeFixed(norm.peg)),
                        "评价": norm.conclusion,
                        "压力测试": `🛡️ ${stress.conclusion}`,
                        "择时信号": timing,
                        "风险": getRiskLevel(norm.riskValue),
                        
                        // 三色估值
                        "悲观估值": parseFloat(safeFixed(norm.bearPrice)),
                        "合理估值": parseFloat(safeFixed(norm.basePrice)),
                        "乐观估值": parseFloat(safeFixed(norm.bullPrice)),

                        "回本(PE)": parseFloat(safeFixed(metric.peTTM || 20, 1)),
                        "过往增速": parseFloat(safeFixed(metric.epsGrowth5Y, 2)) / 100,
                        "营收增速(季)": parseFloat(safeFixed(metric.revenueGrowthQuarterlyYoy, 2)) / 100
                    }
                })
            });
            console.log(`   ✅ 更新成功: ${symbol} (悲观: ${safeFixed(norm.bearPrice)} | 合理: ${safeFixed(norm.basePrice)})`);
            count++;

        } catch (e) {
            console.error(`   ❌ ${symbol} 处理出错:`, e.message);
        }
        
        // 稍微休息，防止 API 也就是每秒 5 次左右的频率
        await sleep(3000);
    }
    console.log(`=== 全部完成 (成功更新 ${count} 个) ===`);
};

main();
