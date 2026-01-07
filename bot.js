// bot.js - AlphaSystem 云端机器人 (V5.5 最终防崩版)
// 修复：兼容性检测增强、超时延长至30秒、JSON解析防御

const https = require('https');

// ================= 0. 环境自检 =================
// 核心修复：同时检查 fetch 和 AbortController
if (!globalThis.fetch || !globalThis.AbortController) {
    console.error("❌ 错误: 当前 Node 版本过低。请确保 main.yml 中使用 node-version: '20'");
    console.error("   提示: Node 18+ 才支持原生 fetch 和 AbortController");
    process.exit(1);
}

// ================= 1. 配置区 =================
const CONFIG = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID, 
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN, 
    FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID,
    FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK,
    FINNHUB_KEY: process.env.FINNHUB_KEY,
    WEB_URL: "http://localhost:5173" 
};
// ================= ETF 名单配置 =================
// 这些代码将走 "回撤交易策略"，不走 PEG 估值
const ETF_LIST = ['QQQ', 'TQQQ', 'VOO', 'SPY', 'IVV', 'SMH', 'SOXX', 'VGT', 'XLK', 'DIA', 'IWM'];

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 网络请求封装 (核心修复：30s超时 + JSON安全解析)
const fetchJson = async (url, options = {}) => {
    // 修复：延长超时时间到 30秒，防止 CI 环境网络波动导致的崩溃
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            const errorText = await res.text();
            // 截断错误信息，防止日志过长
            throw new Error(`HTTP ${res.status} - ${errorText.slice(0, 100)}`);
        }

        // 修复：防止 API 返回空内容或非 JSON 导致 crash
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch (e) {
            console.warn(`⚠️ 警告: 返回内容不是 JSON (${url.slice(0, 20)}...)`);
            return {};
        }
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error("请求超时 (30s)");
        throw e;
    }
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
    catch (e) { console.error("报警发送失败", e.message); }
};

// ================= 3. 核心算法 (同步 React 逻辑) =================

// 3.1 智能增速判断
const getSmartGrowthInputs = (stock) => {
    const metric = stock.metricRaw || {};
    const growthTTM = parseFloat(metric.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const qtrRevGrowth = parseFloat(metric.revenueGrowthQuarterlyYoy) || 0;
    const revGrowthTTM = parseFloat(metric.revenueGrowthTTMYoy) || 0;
    const revGrowth5Y = parseFloat(metric.revenueGrowth5Y) || 0;

    // 亏损判断
    const isLoss = !metric.epsTTM || metric.epsTTM <= 0;
    const showRevenueTrend = isLoss || (metric.epsGrowthTTMYoy === null);

    let defaultGrowthVal = 8;

    if (showRevenueTrend) {
        // 取 TTM 和 季度营收 的最大值
        const recentRevMax = Math.max(revGrowthTTM, qtrRevGrowth);
        if (recentRevMax > 0) {
            defaultGrowthVal = Math.min(recentRevMax, 50); 
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

// 3.2 估值引擎
const calculateScenarios = (baseInputs, currentPrice) => {
    const { eps, growthRate, peRatio, riskFreeRate=4.5, roe=0, pastGrowth=0, qtrEpsGrowth=0 } = baseInputs; 
    let g = Math.min(Number(growthRate) || 0, 50);
    
    // A. 亏损股特判
    if (!eps || eps <= 0) {
        if (g > 25) return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
        return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
    }

    let targetPE = peRatio;
    let bullMult = 1.2;
    let bearDisc = 0.8;

    // B. 动态调整
    if (g < 5 && targetPE > 15) targetPE = 12; // 熔断

    const isAccelerating = qtrEpsGrowth > (pastGrowth + 15);
    if (isAccelerating) {
        bullMult += 0.3;
        g = Math.max(g, qtrEpsGrowth * 0.8); 
    }

    let valuationDrag = 1.0;
    if (targetPE * riskFreeRate > 100) valuationDrag = Math.max(0.75, Math.sqrt(100 / (targetPE * riskFreeRate)));
    if (roe > 25) bearDisc += 0.15;

    const bearPrice = eps * (targetPE * bearDisc * valuationDrag) * (1 + (g * 0.3) / 100);
    const basePrice = eps * (targetPE * valuationDrag) * (1 + g / 100);
    const bullPrice = eps * (targetPE * bullMult * valuationDrag) * (1 + (g * 1.3) / 100);
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
// ================= ETF 专用分析引擎 (回撤交易法) =================
const analyzeETF = (price, metric) => {
    // 1. 获取关键技术位
    const high52 = parseFloat(metric['52WeekHigh']);
    const low52 = parseFloat(metric['52WeekLow']);
    const ma50 = parseFloat(metric['50DayAverage']); // Finnhub 免费版可能不一定有MA，如果没有就降级用回撤
    
    if (!high52) return { conclusion: "⚠️ 数据不足", riskValue: 50, signal: "观望" };

    // 2. 计算回撤幅度 (Drawdown)
    // 0 表示最高点，-0.1 表示跌了 10%
    const drawdown = (price - high52) / high52;
    const dropPercent = (Math.abs(drawdown) * 100).toFixed(1);

    // 3. 制定策略 (基于美股长牛特征)
    let conclusion = "";
    let riskValue = 50;
    let signal = "";
    let buyAdvice = "";

    if (drawdown > -0.03) {
        // 跌幅小于 3% (处于历史高位附近)
        conclusion = "🔥 历史高位 (强趋势)";
        riskValue = 80; // 追高有风险
        signal = "定投/持有";
        buyAdvice = "切勿一把梭，保持定投，警惕回调";
    } 
    else if (drawdown > -0.08) {
        // 跌幅 3% - 8% (正常呼吸回调)
        conclusion = "📉 健康回调";
        riskValue = 60;
        signal = "加码定投";
        buyAdvice = "倒车接人，适合加大定投倍数";
    } 
    else if (drawdown > -0.15) {
        // 跌幅 8% - 15% (黄金坑 - 往往是纳指的中期底)
        conclusion = "💰 黄金坑 (中期底)";
        riskValue = 30; // 风险释放了一大半
        signal = "重仓买入";
        buyAdvice = "难得的捡钱机会，大单买入";
    } 
    else if (drawdown > -0.25) {
        // 跌幅 15% - 25% (技术性熊市)
        conclusion = "🐻 熊市区域";
        riskValue = 20;
        signal = "越跌越买";
        buyAdvice = "分批抄底，每跌 3% 加一倍仓位";
    } 
    else {
        // 跌幅 > 25% (危机模式)
        conclusion = "☠️ 极度恐慌";
        riskValue = 10; // 遍地黄金
        signal = "全仓/杠杆";
        buyAdvice = "如果是标普/纳指，此时是改变命运的机会";
    }

    // 格式化输出，为了适配飞书那个三栏估值，我们伪造一下数据
    // 悲观 = 回撤20%的价格，合理 = 回撤10%的价格，乐观 = 前高
    return {
        conclusion: `${conclusion} (回撤-${dropPercent}%)`,
        riskValue: riskValue,
        timing: signal, // 借用择时字段
        detail: buyAdvice,
        // 伪造估值数据供显示
        bearPrice: high52 * 0.8,  // 跌20%是底
        basePrice: high52 * 0.9,  // 跌10%是合理
        bullPrice: high52,        // 前高是阻力
        peg: 0 // ETF 不看 PEG
    };
};
// ================= 4. 主程序 (带异常捕获) =================
const main = async () => {
    console.log("=== AlphaSystem V5.5 (Final Safe) 启动 ===");
    
    // 检查关键密钥
    if (!CONFIG.FINNHUB_KEY || !CONFIG.FEISHU_APP_ID) {
        throw new Error("❌ 缺失关键环境变量 (FINNHUB_KEY 或 FEISHU_APP_ID)，请在 Secrets 中配置");
    }

    // 1. 飞书鉴权
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = auth.tenant_access_token;
    if (!token) throw new Error("飞书鉴权失败，Token 为空");

    // 2. 获取股票列表
    const listUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`;
    const listRes = await fetchJson(listUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const stocks = listRes.data?.items || [];
    console.log(`📡 扫描到 ${stocks.length} 只股票...`);

    let count = 0;
    
    // 3. 循环处理
    for (let s of stocks) {
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;

        // 智能跳过 (1小时)
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
            // A. 获取 Finnhub
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            // 加速: 并行获取 metric
            const mPromise = fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`).catch(() => ({}));
            
            if (!q.c) { console.log(`   ⚠️ ${symbol}: 暂无价格`); await sleep(500); continue; }
            const m = await mPromise; // 等待 metric
            
            const price = q.c;
            const metric = m.metric || {};
            const metricGrowth5Y = metric.epsGrowth5Y || 0;
            
            // B. 计算
          // ================= 核心修改：区分个股与 ETF =================
            let norm, stress;
            
            // 检查是否在 ETF 名单中
            const isETF = ETF_LIST.includes(symbol);

            if (isETF) {
                console.log(`   📊 [ETF模式] 分析 ${symbol}...`);
                // 1. 运行 ETF 专用策略
                const etfResult = analyzeETF(price, metric);
                
                // 2. 格式对齐 (为了让下面的写入飞书逻辑通用)
                norm = {
                    peg: 0, // ETF不显示PEG
                    riskValue: etfResult.riskValue,
                    conclusion: etfResult.conclusion,
                    bearPrice: etfResult.bearPrice,
                    basePrice: etfResult.basePrice,
                    bullPrice: etfResult.bullPrice
                };
                // ETF 不需要压力测试，或者压力测试就是“再跌10%”
                stress = { conclusion: etfResult.detail }; // 把建议写在压力测试栏
                
                // 强制覆盖择时信号
                var customTiming = etfResult.timing; 
            } else {
                // === 原有个股逻辑 ===
                const { defaultGrowthVal } = getSmartGrowthInputs({ metricRaw: metric, metricGrowth5Y: metricGrowth5Y });
                const inputs = {
                    eps: metric.epsTTM, 
                    growthRate: defaultGrowthVal, 
                    peRatio: metric.peTTM || 20, 
                    roe: parseFloat(metric.roeTTM)||0,
                    pastGrowth: parseFloat(metricGrowth5Y) || 0,
                    qtrEpsGrowth: parseFloat(metric.epsGrowthQuarterlyYoy) || 0,
                    revenueGrowth: parseFloat(metric.revenueGrowthQuarterlyYoy) || 0
                };
                norm = calculateScenarios(inputs, price);
                stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);
            }
            
            // C. 择时

            const low52 = parseFloat(metric['52WeekLow']), high52 = parseFloat(metric['52WeekHigh']);
            let timing = "⏳ 盘整中";
            if (isETF) {
                timing = customTiming; // 使用 ETF 的“定投/加仓”信号
            } else {
                // 原有的个股择时逻辑
                if (low52 && high52) {
                    const pos = (price - low52)/(high52 - low52);
                    if (pos < 0.05) timing = "🔪 左侧博弈";
                    else if (pos > 0.8) timing = "⚠️ 高位运行";
                    else if (norm.conclusion.includes("击球")) timing = "🚀 右侧启动";
                }
            }

            // D. 写入
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
                        
                        "ROE": getVal(metric.roeTTM) / 100,
                        "净利率": getVal(metric.netProfitMarginTTM) / 100,
                        "股息率": (getVal(metric.dividendYieldIndicatedAnnual) || getVal(metric.currentDividendYieldTTM)) / 100,
                        
                        "EPS增速(季)": getVal(metric.epsGrowthQuarterlyYoy) / 100,
                        "EPS增速(TTM)": getVal(metric.epsGrowthTTMYoy) / 100,
                        
                        "超链接": { "text": "👉 深度推演", "link": `${CONFIG.WEB_URL}/?symbol=${symbol}` }
                    }
                })
            });
            
            // 报警
            const prevConc = s.fields['评价'] || "";
            if (norm.conclusion.includes("击球区") && !prevConc.includes("击球")) {
                await sendFeishuAlert(symbol, price, "🟢 黄金击球区", `${norm.conclusion}`);
            }

            console.log(`   ✅ 更新成功: ${symbol}`);
            count++;

        } catch (e) {
            console.error(`   ❌ ${symbol} 失败:`, e.message);
        }
        
        await sleep(1000); // 1秒间隔
    }
    console.log(`=== 全部完成 (成功 ${count} 个) ===`);
};

// 🌟 核心修复：捕获未处理的异常，确保 GitHub Action 变红
main().catch(error => {
    console.error("🔥 致命错误，脚本退出:", error);
    process.exit(1);
});
