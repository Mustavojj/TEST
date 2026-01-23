export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'] || '';
        
        const suspiciousPatterns = [
            'python', 'curl', 'wget', 'postman', 'insomnia',
            'bot', 'crawler', 'spider', 'scraper', 'hack',
            'sqlmap', 'nmap', 'burp', 'zap', 'metasploit',
            'hydra', 'nikto', 'gobuster', 'dirb', 'ffuf'
        ];
        
        const isSuspicious = suspiciousPatterns.some(pattern => 
            userAgent.toLowerCase().includes(pattern.toLowerCase())
        );
        
        if (isSuspicious) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const contentLength = parseInt(req.headers['content-length'] || '0');
        if (contentLength > 5000) {
            return res.status(413).json({ error: 'Payload too large' });
        }
        
        const telegramUserId = req.headers['x-telegram-user'];
        const telegramHash = req.headers['x-telegram-hash'];
        const telegramData = req.headers['x-telegram-data'];
        
        if (!telegramUserId || !telegramHash) {
            return res.status(401).json({ error: 'Telegram authentication required' });
        }
        
        const requestKey = `${userIp}_${telegramUserId}`;
        const now = Date.now();
        
        if (!global.requestStore) global.requestStore = {};
        if (!global.requestStore[requestKey]) global.requestStore[requestKey] = [];
        
        global.requestStore[requestKey] = global.requestStore[requestKey].filter(
            time => now - time < 60000
        );
        
        if (global.requestStore[requestKey].length >= 20) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        
        global.requestStore[requestKey].push(now);
        
        const { action, params } = req.body;
        
        if (!action || typeof action !== 'string') {
            return res.status(400).json({ error: 'Invalid action parameter' });
        }
        
        if (!params || typeof params !== 'object') {
            return res.status(400).json({ error: 'Invalid params' });
        }
        
        const BOT_TOKEN = process.env.BOT_TOKEN;
        
        if (!BOT_TOKEN) {
            return res.status(500).json({ error: 'Server configuration error' });
        }
        
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
            headers: { 
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(params)
        });
        
        const data = await response.json();
        
        res.status(200).json(data);
        
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
}
