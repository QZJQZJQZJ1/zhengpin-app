const { MongoClient } = require('mongodb');

// 缓存数据库连接，防止无服务器函数每次请求都重新建立连接
let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) return cachedClient;
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    cachedClient = client;
    return client;
}

function formatBJTime(dateObj) {
    if (!dateObj) return '未知时间';
    const bjTime = new Date(new Date(dateObj).getTime() + 8 * 60 * 60 * 1000);
    return bjTime.toISOString().replace('T', ' ').substring(0, 19);
}

export default async function handler(req, res) {
    // 允许跨域请求 (CORS)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. 获取前端传来的防伪码 (增加 .trim() 防止URL里带有不可见的空格)
    const rawFWCode = req.query.FWCode;
    if (!rawFWCode) {
        return res.status(400).json({ status: 400, msg: '缺少防伪码参数' });
    }
    const FWCode = rawFWCode.trim();

    try {
        const client = await connectToDatabase();
        const db = client.db(process.env.DB_NAME);
        const collection = db.collection('fw_codes');

        // 获取用户 IP 用于记录查询历史
        const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '未知IP';

        // 2. 在数据库中查找该码，并同时执行更新操作
        const codeRecord = await collection.findOneAndUpdate(
            { code: FWCode },
            {
                $inc: { queryCount: 1 },
                $push: { queryHistory: { time: new Date(), ip: ip } }
            },
            { returnDocument: 'before' }
        );

        // 兼容最新版 MongoDB 驱动
        const doc = (codeRecord && codeRecord.value !== undefined) ? codeRecord.value : codeRecord;

        // 3. 查无此码 (假货)
        if (!doc) {
            return res.json({
                response: null,
                status: 200,
                success: true,
                msg: "抱歉，您查询的防伪码不存在，谨防假冒！如有疑问请与厂家联系"
            });
        }

        // 4. 判定防伪码状态
        const isFirstTime = doc.queryCount === 0;
        const currentCount = doc.queryCount + 1; // 加上本次查询

        let historyChecklists = [];
        historyChecklists.push({ time: formatBJTime(new Date()) });
        if (doc.queryHistory && doc.queryHistory.length > 0) {
            const prevHistory = doc.queryHistory.map(record => {
                return { time: formatBJTime(record.time) };
            }).reverse();
            historyChecklists = historyChecklists.concat(prevHistory);
        }

        let resultStatus, msg, contentHtml;

        if (isFirstTime) {
            // 首次查询：完美正品
            resultStatus = 1;
            msg = "验证成功";

            // 异步记录首次查询时间
            collection.updateOne({ code: FWCode }, { $set: { firstQueryTime: new Date() } });

        } else {
            // 被查过几次：给出黄字提示
            resultStatus = 2;
            msg = "验证成功";
            // 提取首次查询时间
            const firstTime = doc.firstQueryTime || (doc.queryHistory && doc.queryHistory[0] ? doc.queryHistory[0].time : new Date());

        }
        contentHtml = `<div style='text-align:center; padding: 20px;'><h2 style='color:#52c41a; font-size: 22px; font-weight: bold;'>正品验证通过</h2><p style='margin-top: 10px; color: #666; font-size: 14px;'>感谢您的查询，该防伪码为官方正品。</p></div>`;

        // 5. 返回前端 Vue 需要的数据结构
        res.json({
            response: {
                FWResultStatus: resultStatus,
                FwCheckReplayInfoList: [
                    {
                        VersionName: "正品验证",
                        UseVoice: false,
                        VoiceFileUrl: "",
                        WarnContent: resultStatus === 3 ? contentHtml : "",
                        Content: resultStatus !== 3 ? contentHtml : "",
                        IsNeedHideOtherContent: false,
                        OtherContent: ""
                    }
                ],
                checklists: historyChecklists,
                fid: FWCode
            },
            status: 200,
            success: true,
            msg: msg
        });

    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ status: 500, msg: "服务器内部错误" });
    }
}