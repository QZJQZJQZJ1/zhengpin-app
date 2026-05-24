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

export default async function handler(req, res) {
    // 允许跨域请求 (CORS)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. 获取前端传来的防伪码
    const { FWCode } = req.query;
    if (!FWCode) {
        return res.status(400).json({ status: 400, msg: '缺少防伪码参数' });
    }

    try {
        const client = await connectToDatabase();
        const db = client.db(process.env.DB_NAME);
        const collection = db.collection('fw_codes');

        // 获取用户 IP 用于记录查询历史
        const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '未知IP';

        // 2. 在数据库中查找该码，并同时执行更新操作 (浏览次数+1，记录时间IP)
        // returnDocument: 'before' 会返回更新前的数据，方便我们判断是不是“首次查询”
// 2. 在数据库中查找该码，并同时执行更新操作
        const codeRecord = await collection.findOneAndUpdate(
            { code: FWCode },
            {
                $inc: { queryCount: 1 },
                $push: { queryHistory: { time: new Date(), ip: ip } }
            },
            { returnDocument: 'before' }
        );

        // 【关键修复】兼容最新版 MongoDB 驱动直接返回文档的特性
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

        // 4. 判定防伪码状态 (把原来的 codeRecord.value 改成 doc)
        const isFirstTime = doc.queryCount === 0;

        // 3. 查无此码 (假货)
        if (!codeRecord.value) {
            return res.json({
                response: null,
                status: 200,
                success: true,
                msg: "抱歉，您查询的防伪码不存在，谨防假冒！如有疑问请与厂家联系"
            });
        }

        // 4. 判定防伪码状态
        const currentCount = doc.queryCount + 1; // 加上本次查询

        let resultStatus, msg, contentHtml;

        if (isFirstTime) {
            // 首次查询：完美正品
            resultStatus = 1;
            msg = "验证成功";
            contentHtml = `<div style='text-align:center; padding: 20px;'><h2 style='color:#52c41a; font-size: 22px; font-weight: bold;'>正品验证通过</h2><p style='margin-top: 10px; color: #666; font-size: 14px;'>感谢您的查询，该防伪码为官方正品。<br/><span style='color:#52c41a;'>这是首次查询！</span></p></div>`;

            // 异步记录首次查询时间
            collection.updateOne({ code: FWCode }, { $set: { firstQueryTime: new Date() } });

        } else if (currentCount <= 5) {
            // 被查过几次：可能是用户自己查的，给出黄字提示
            resultStatus = 2;
            msg = "验证成功";
            // 提取首次查询时间（如果有 firstQueryTime 优先用，否则取历史记录的第一条）
            const firstTime = doc.firstQueryTime || (doc.queryHistory[0] ? doc.queryHistory[0].time : '未知');
            const formatTime = new Date(firstTime).toLocaleString('zh-CN');

            contentHtml = `<div style='text-align:center; padding: 20px;'><h2 style='color:#fa8c16; font-size: 22px; font-weight: bold;'>正品验证通过</h2><p style='margin-top: 10px; color: #666; font-size: 14px;'>该防伪码为官方正品。</p><p style='color: #fa8c16; font-size: 13px; margin-top:5px;'>注意：此码已被查询过 ${currentCount} 次。<br/>首次查询时间: ${formatTime}</p></div>`;

        } else {
            // 超过5次：极大概率是假货团伙复制了真码
            resultStatus = 3;
            msg = "异常防伪码";
            contentHtml = `<div style='text-align:center; padding: 20px;'><h2 style='color:#f5222d; font-size: 22px; font-weight: bold;'>谨防假冒</h2><p style='margin-top: 10px; color: #666; font-size: 14px;'>该防伪码已被多人多次查询（共 ${currentCount} 次），系统已停止该密码的验证！如有疑问请与厂家联系。</p></div>`;
        }

        // 5. 按照原前端 Vue 脚本预期的 JSON 结构返回数据
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
                // 返回查询历史（这里为了安全，前端其实只用到了[0].time，我们可以只返回最新的一条或长度）
                checklists: [{ time: new Date().toLocaleString('zh-CN') }],
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