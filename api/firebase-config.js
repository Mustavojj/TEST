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
        
        const requestKey = `firebase_${userIp}`;
        const now = Date.now();
        
        if (!global.firebaseRequestStore) global.firebaseRequestStore = {};
        if (!global.firebaseRequestStore[requestKey]) global.firebaseRequestStore[requestKey] = [];
        
        global.firebaseRequestStore[requestKey] = global.firebaseRequestStore[requestKey].filter(
            time => now - time < 300000
        );
        
        if (global.firebaseRequestStore[requestKey].length >= 5) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        
        global.firebaseRequestStore[requestKey].push(now);
        
        const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
        
        const safeConfig = {
            apiKey: firebaseConfig.apiKey || "AIzaSyDefaultKey123",
            authDomain: firebaseConfig.authDomain || "tornado-default.firebaseapp.com",
            databaseURL: firebaseConfig.databaseURL || "https://tornado-default-rtdb.firebaseio.com",
            projectId: firebaseConfig.projectId || "tornado-default",
            storageBucket: firebaseConfig.storageBucket || "tornado-default.appspot.com",
            messagingSenderId: firebaseConfig.messagingSenderId || "987654321098",
            appId: firebaseConfig.appId || "1:987654321098:web:default1234567890",
            measurementId: firebaseConfig.measurementId || "G-DEFAULT123"
        };
        
        const encryptedConfig = Buffer.from(JSON.stringify(safeConfig)).toString('base64');
        
        res.status(200).json({
            encrypted: encryptedConfig
        });
        
    } catch (error) {
        const fallbackConfig = {
            apiKey: "AIzaSyDefaultKey123",
            authDomain: "tornado-default.firebaseapp.com",
            databaseURL: "https://tornado-default-rtdb.firebaseio.com",
            projectId: "tornado-default",
            storageBucket: "tornado-default.appspot.com",
            messagingSenderId: "987654321098",
            appId: "1:987654321098:web:default1234567890",
            measurementId: "G-DEFAULT123"
        };
        
        const encryptedFallback = Buffer.from(JSON.stringify(fallbackConfig)).toString('base64');
        res.status(200).json({ encrypted: encryptedFallback });
    }
}
