import crypto from 'crypto';

const RATE_LIMIT = new Map();
const MAX_REQUESTS = 3;
const WINDOW_MS = 60000;

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
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    
    try {
        const { initData } = req.body;
        
        if (!initData) {
            return res.status(400).json({ error: 'Missing initData' });
        }
        
        const BOT_TOKEN = process.env.BOT_TOKEN;
        if (!BOT_TOKEN) {
            return res.status(500).json({ error: 'Server configuration error' });
        }
        
        const isValid = verifyTelegramData(initData, BOT_TOKEN);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid Telegram data' });
        }
        
        // إرسال التوكن فقط إذا كان التحقق ناجحًا
        res.status(200).json({ token: BOT_TOKEN });
        
    } catch (error) {
        console.error('Get bot token error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
