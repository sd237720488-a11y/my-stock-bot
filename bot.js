// bot.js - AlphaSystem 云端机器人 (V5.9 多维透视版)
// 功能：新增[缺口/趋势/量能]独立列、心跳报告、完整逻辑校验

const https = require('https');

// ================= 0. 环境自检 =================
if (!globalThis.fetch || !globalThis.AbortController) {
    console.error("❌ 错误: 请升级 Node 版本至 20+");
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

// ETF 名单 (走回撤策略)
const ETF_LIST = ['QQQ', 'TQQQ', 'VOO', 'SPY', 'IVV', 'SMH', 'SOXX', 'VGT', 'XLK', 'DIA', 'IWM'];

// ================= 2. 辅助函数 =================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchJson = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s超时
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`HTTP ${res.status} - ${txt.slice(0, 100)}`);
        }
        const text = await res.text();
        try { return text ? JSON.parse(text) : {}; } 
        catch (e) { console.warn("JSON解析失败"); return {}; }
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
};

const getVal = (val, d = 2) => {
    if (val === null || val === undefined || val === '') return 0;
    const num = parseFloat(val);
    return (isNaN(num) || !isFinite(num)) ? 0 : parseFloat(num.toFixed(d));
};

const getRiskLevel = (score) => {
    if (!score) return "-";
    if (score <= 20) return "边际极高";
    if (score <= 40) return "边际充足";
    if (score <= 60) return "风险适中";
    if (score <= 80) return "估值脆弱";
    return "高波动";
};

// 飞书报警 (个股机会)
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

// 💓 心跳报告 (任务总结)
const sendHeartbeat = async (total, updated, skipped, errors) => {
    if (!CONFIG.FEISHU_WEBHOOK) return;
    const isSilent = updated === 0 && errors === 0;
    if (isSilent) return;

    const color = errors > 0 ? "red" : "grey"; 
    const title = errors > 0 ? "AlphaSystem 运行有误" : "AlphaSystem 巡逻完成";

    const cardContent = {
        "msg_type": "interactive",
        "card": {
            "config": { "wide_screen_mode": true },
            "header": { "title": { "tag": "plain_text", "content": title }, "template": color },
            "elements": [
                { "tag": "div", "text": { "tag": "lark_md", "content": `📊 **扫描:** ${total} | ✅ **更新:** ${updated}\n⏭️ **跳过:** ${skipped} | ❌ **失败:** ${errors}` } }
            ]
        }
    };
    try { await fetch(CONFIG.FEISHU_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(cardContent) }); } 
    catch (e) { console.error("心跳发送失败", e.message); }
};

// ================= 3. 核心算法 =================

// 3.1 智能增速
const getSmartGrowthInputs = (stock) => {
    const m = stock.metricRaw || {};
    const growthTTM = parseFloat(m.epsGrowthTTMYoy) || 0;
    const pastG = parseFloat(stock.metricGrowth5Y) || 0;
    const qtrRevG = parseFloat(m.revenueGrowthQuarterlyYoy) || 0;
    const revTTM = parseFloat(m.revenueGrowthTTMYoy) || 0;
    const rev5Y = parseFloat(m.revenueGrowth5Y) || 0;

    const isLoss = !stock.metricEPS || stock.metricEPS <= 0;
    let val = 8;

    if (isLoss || m.epsGrowthTTMYoy === null) {
        const maxRev = Math.max(revTTM, qtrRevG);
        val = maxRev > 0 ? Math.min(maxRev, 50) : (rev5Y || 5);
    } else {
        if (growthTTM > 0 && growthTTM > pastG + 10) val = Math.min(growthTTM, 50);
        else val = (pastG > -50 ? pastG : 5);
    }
    return { defaultGrowthVal: val };
};

// 3.2 估值引擎
const calculateScenarios = (baseInputs, currentPrice) => {
    const { eps, growthRate, peRatio, riskFreeRate=4.5, roe=0, qtrEpsGrowth=0, pastGrowth=0 } = baseInputs; 
    let g = Math.min(Number(growthRate) || 0, 50);

    if (!eps || eps <= 0) {
        if (g > 25) return { conclusion: "🔥 困境反转", riskValue: 40, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
        return { conclusion: "☠️ 垃圾/亏损", riskValue: 99, peg: 0, bearPrice:0, basePrice:0, bullPrice:0 };
    }

    let targetPE = peRatio;
    let bullMult = 1.2;
    let bearDisc = 0.8;

    if (g < 5 && targetPE > 15) targetPE = 12; 
    if (qtrEpsGrowth > pastGrowth + 15) { bullMult += 0.3; g = Math.max(g, qtrEpsGrowth * 0.8); }

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
    let riskValue = 100 - (valScore + Math.min(Math.max(roe, 0), 30) + (peg < 1 ? 20 : 0));

    return { peg, riskValue, conclusion, bearPrice, basePrice, bullPrice };
};

// 3.3 ETF 策略
const analyzeETF = (price, metric) => {
    const high52 = parseFloat(metric['52WeekHigh']);
    if (!high52) return { conclusion: "数据不足", riskValue: 50 };
    
    const dd = (price - high52) / high52;
    let conc = "", risk = 50, sig = "", tip = "";
    
    if (dd > -0.03) { conc = "🔥 历史高位"; risk = 80; sig = "定投"; tip = "勿梭哈"; }
    else if (dd > -0.08) { conc = "📉 健康回调"; risk = 60; sig = "加码"; tip = "倒车接人"; }
    else if (dd > -0.15) { conc = "💰 黄金坑"; risk = 30; sig = "重仓"; tip = "捡钱机会"; }
    else { conc = "🐻 熊市区域"; risk = 20; sig = "越跌越买"; tip = "分批抄底"; }
    
    return { conclusion: `${conc} (${(dd*100).toFixed(1)}%)`, riskValue: risk, timing: sig, detail: tip, bearPrice: high52*0.8, basePrice: high52*0.9, bullPrice: high52, peg: 0 };
};

// ================= 4. 主程序 =================
const main = async () => {
    console.log("=== AlphaSystem V5.9 启动 ===");

    // 1. 鉴权
    if (!CONFIG.FINNHUB_KEY) throw new Error("缺少 FINNHUB_KEY");
    const auth = await fetchJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ "app_id": CONFIG.FEISHU_APP_ID, "app_secret": CONFIG.FEISHU_APP_SECRET })
    });
    const token = auth.tenant_access_token;
    if (!token) throw new Error("飞书鉴权失败");

    // 2. 扫表
    const listRes = await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records?page_size=500`, { headers: { 'Authorization': `Bearer ${token}` } });
    const stocks = listRes.data?.items || [];
    console.log(`📡 扫描 ${stocks.length} 只股票...`);

    let count = 0, skipped = 0, errors = 0;
    
    // 3. 循环
    for (let s of stocks) {
        const symbol = (s.fields['代码'] || s.fields.symbol || "").toUpperCase();
        if (!symbol) continue;

        // 跳过逻辑
        const lastMod = parseInt(s.last_modified_time || 0);
        if (s.fields['现价'] > 0 && (Date.now() - lastMod < 3600000)) {
            console.log(`   ⏭️ [跳过] ${symbol}`); skipped++; continue;
        }

        console.log(`Processing: ${symbol}...`);

        try {
            // A. 数据获取
            const q = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${CONFIG.FINNHUB_KEY}`);
            if (!q.c) { console.log("   ⚠️ 无价格"); continue; }
            const metricRes = await fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${CONFIG.FINNHUB_KEY}`);
            const metric = metricRes.metric || {};
            const price = q.c;

            // B. 基础计算
            let norm, stress, timing = "⏳ 盘整中", timingDetail = "";
            let tagGap = "-", tagMa = "-", tagVol = "-"; // 默认值

            const isETF = ETF_LIST.includes(symbol);

            if (isETF) {
                const etf = analyzeETF(price, metric);
                norm = etf; stress = { conclusion: etf.detail };
                timing = etf.timing; 
                timingDetail = etf.detail;
                tagGap = "N/A"; tagMa = "N/A"; tagVol = "N/A"; // ETF 暂不分析这三项细节
            } else {
                const { defaultGrowthVal } = getSmartGrowthInputs({ metricRaw: metric, metricGrowth5Y: metric.epsGrowth5Y });
                const inputs = {
                    eps: metric.epsTTM, growthRate: defaultGrowthVal, peRatio: metric.peTTM || 20, roe: metric.roeTTM,
                    pastGrowth: metric.epsGrowth5Y, qtrEpsGrowth: metric.epsGrowthQuarterlyYoy, revenueGrowth: metric.revenueGrowthQuarterlyYoy
                };
                norm = calculateScenarios(inputs, price);
                stress = calculateScenarios({...inputs, growthRate: inputs.growthRate*0.7, peRatio: inputs.peRatio*0.8}, price);
                
                // === C. 进阶择时 (多维计算) ===
                const low52 = parseFloat(metric['52WeekLow']);
                const high52 = parseFloat(metric['52WeekHigh']);
                
                const ma50 = parseFloat(metric['50DayAverage']); 
                const ma20 = parseFloat(metric['20DaySimpleMovingAverage']) || ma50;
                const avgVol10 = parseFloat(metric['10DayAverageTradingVolume']);
                const curVol = q.v;
                
                // 1. 缺口 (Gap)
                const gap = (q.o - q.pc) / q.pc;
                if(gap > 0.03) tagGap = "⚠️ 跳空"; 
                else if(gap < -0.02) tagGap = "📉 低开"; 
                else tagGap = "⚪️ 平开";
                
                // 2. 趋势 (Trend)
                if (price > ma20) tagMa = "✅ 站稳";
                else if (price < ma20) tagMa = "🚫 受制";
                else tagMa = "⏳ 纠结";
                
                // 3. 量能 (Vol)
                if(avgVol10) {
                    if(curVol > avgVol10 * 1.5) tagVol = "🔥 爆量";
                    else if(curVol > avgVol10 * 1.2) tagVol = "📈 放量";
                    else if(curVol < avgVol10 * 0.7) tagVol = "☁️ 缩量";
                    else tagVol = "⚪️ 平量";
                }

                if (low52 && high52) {
                    const pos = (price - low52)/(high52 - low52);
                    const reb = (price - low52)/low52;
                    const bias50 = ma50 ? (price - ma50) / ma50 : 0;

                    // 综合判定逻辑
                    if (gap > 0.03) {
                        timing = "✋ 暂缓"; timingDetail = "等待回补缺口";
                    }
                    else if (pos < 0.05) { timing = "🔪 左侧"; timingDetail = "深跌试错"; }
                    else if (pos > 0.8) { timing = "⚠️ 高位"; timingDetail = "止盈区间"; }
                    else if (reb > 0.05 && reb < 0.25) {
                        if (bias50 > 0.15) { timing = "✋ 暂缓"; timingDetail = "乖离过大"; }
                        else if (price < ma20) { timing = "📉 趋势弱"; timingDetail = "未站稳MA20"; }
                        else if (norm.conclusion.includes("击球")) { 
                            timing = "🚀 右侧启动"; timingDetail = "最佳买点"; 
                        } 
                        else { timing = "📈 反弹"; timingDetail = "仅做波段"; }
                    }
                }
            }

            // D. 写入飞书 (新增了 3 个独立字段)
            await fetchJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.FEISHU_APP_TOKEN}/tables/${CONFIG.FEISHU_TABLE_ID}/records/${s.record_id}`, {
                method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        "现价": price, 
                        "性价比(PEG)": getVal(norm.peg), 
                        "评价": norm.conclusion,
                        "压力测试": `🛡️ ${stress.conclusion}`, 
                        "择时信号": `${timing}`, // 简化主信号
                        
                        // ✨ 新增的独立列 (请在飞书添加这3列)
                        "缺口": tagGap,
                        "趋势": tagMa,
                        "量能": tagVol,
                        
                        "风险": getRiskLevel(norm.riskValue),
                        "悲观估值": getVal(norm.bearPrice), 
                        "合理估值": getVal(norm.basePrice), 
                        "乐观估值": getVal(norm.bullPrice),
                        "回本(PE)": getVal(metric.peTTM || 20, 1), 
                        "过往增速": getVal(metric.epsGrowth5Y)/100,
                        "ROE": getVal(metric.roeTTM)/100, 
                        "净利率": getVal(metric.netProfitMarginTTM)/100,
                        "股息率": (getVal(metric.dividendYieldIndicatedAnnual)||getVal(metric.currentDividendYieldTTM))/100,
                        "超链接": { "text": "👉 深度推演", "link": `${CONFIG.WEB_URL}/?symbol=${symbol}` }
                    }
                })
            });

            // 报警 (仅当出现新机会时)
            const prevConc = s.fields['评价'] || "";
            if (norm.conclusion.includes("击球区") && !prevConc.includes("击球")) {
                await sendFeishuAlert(symbol, price, "🟢 黄金击球区", norm.conclusion);
            }

            console.log(`   ✅ 更新成功: ${symbol}`);
            count++;

        } catch (e) {
            console.error(`   ❌ ${symbol} 失败:`, e.message);
            errors++;
        }
        await sleep(1200); // 间隔
    }
    
    // 4. 发送心跳
    await sendHeartbeat(stocks.length, count, skipped, errors);
    console.log(`=== 完成 ${count} ===`);
};

main().catch(e => { console.error(e); process.exit(1); });
