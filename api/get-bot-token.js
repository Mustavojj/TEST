export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const userIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'] || '';
        
        const blockedAgents = [
            'python', 'curl', 'wget', 'postman', 'insomnia',
            'bot', 'crawler', 'spider', 'scraper',
            'sqlmap', 'nmap', 'burp', 'hydra',
            'nikto', 'gobuster', 'dirb', 'ffuf'
        ];
        
        const isBlocked = blockedAgents.some(agent => 
            userAgent.toLowerCase().includes(agent.toLowerCase())
        );
        
        if (isBlocked) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const telegramUserId = req.headers['x-telegram-user'];
        const telegramAuth = req.headers['x-telegram-auth'];
        
        if (!telegramUserId || !telegramAuth) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const requestKey = `bot_token_${userIp}`;
        const now = Date.now();
        
        if (!global.botTokenRequestStore) global.botTokenRequestStore = {};
        if (!global.botTokenRequestStore[requestKey]) global.botTokenRequestStore[requestKey] = [];
        
        global.botTokenRequestStore[requestKey] = global.botTokenRequestStore[requestKey].filter(
            time => now - time < 60000
        );
        
        if (global.botTokenRequestStore[requestKey].length >= 10) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        
        global.botTokenRequestStore[requestKey].push(now);
        
        const botToken = process.env.BOT_TOKEN;
        
        if (!botToken) {
            return res.status(500).json({ error: 'Bot token not configured' });
        }
        
        res.status(200).json({ token: botToken });
        
    } catch (error) {
        console.error('Error getting bot token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
