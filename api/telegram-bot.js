import crypto from 'crypto';

const RATE_LIMIT = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60000; // دقيقة واحدة

function verifyTelegramData(initData, botToken) {
    if (!initData || !botToken) return false;
    
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        
        params.delete('hash');
        
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        const secret = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();
        
        const computedHash = crypto
            .createHmac('sha256', secret)
            .update(dataCheckString)
            .digest('hex');
        
        return computedHash === hash;
        
    } catch (error) {
        return false;
    }
}

function checkRateLimit(ip) {
    const now = Date.now();
    if (!RATE_LIMIT.has(ip)) {
        RATE_LIMIT.set(ip, []);
    }
    
    const requests = RATE_LIMIT.get(ip).filter(time => now - time < WINDOW_MS);
    RATE_LIMIT.set(ip, requests);
    
    if (requests.length >= MAX_REQUESTS) {
        return false;
    }
    
    requests.push(now);
    RATE_LIMIT.set(ip, requests);
    return true;
}

export default async function handler(req, res) {
    // السماح فقط بـ POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // التحقق من rate limit
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    
    try {
        const { action, params, initData } = req.body;
        
        // التحقق من وجود البيانات الأساسية
        if (!initData || !action || !params) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // التحقق من صحة بيانات Telegram
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            return res.status(500).json({ error: 'Server configuration error' });
        }
        
        const isValid = verifyTelegramData(initData, BOT_TOKEN);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid Telegram data' });
        }
        
        // تنفيذ الطلب إلى Telegram API
        let endpoint = '';
        switch(action) {
            case 'getChatMember':
                endpoint = 'getChatMember';
                break;
            case 'getChatAdministrators':
                endpoint = 'getChatAdministrators';
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        
        const data = await response.json();
        
        // إخفاء أي بيانات حساسة
        if (data.ok && data.result) {
            // إرسال فقط البيانات المطلوبة
            res.status(200).json({ ok: true, result: data.result });
        } else {
            res.status(200).json({ ok: false, error: 'Failed to verify' });
        }
        
    } catch (error) {
        console.error('Telegram API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
