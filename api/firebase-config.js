import crypto from 'crypto';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, get } from 'firebase/database';

const RATE_LIMIT = new Map();
const MAX_REQUESTS = 10;
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
        const { initData, userId, action, data } = req.body;
        
        // التحقق من وجود البيانات الأساسية
        if (!initData || !userId || !action) {
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
        
        // التحقق من تطابق userId مع initData
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) {
            const user = JSON.parse(userStr);
            if (user.id.toString() !== userId.toString()) {
                return res.status(403).json({ error: 'User ID mismatch' });
            }
        } else {
            return res.status(401).json({ error: 'Invalid user data' });
        }
        
        // تهيئة Firebase من البيئة (بدون إرسالها للعميل)
        const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
        if (!firebaseConfig.projectId) {
            return res.status(500).json({ error: 'Firebase not configured' });
        }
        
        const app = initializeApp(firebaseConfig, 'server-app-' + Date.now());
        const database = getDatabase(app);
        
        let result = null;
        
        // تنفيذ الإجراء المطلوب
        switch(action) {
            case 'getUserData':
                const userRef = ref(database, `users/${userId}`);
                const snapshot = await get(userRef);
                result = snapshot.exists() ? snapshot.val() : null;
                break;
                
            case 'getTasks':
                const tasksRef = ref(database, 'config/tasks');
                const tasksSnap = await get(tasksRef);
                result = tasksSnap.exists() ? tasksSnap.val() : {};
                break;
                
            case 'getReferrals':
                const referralsRef = ref(database, `referrals/${userId}`);
                const referralsSnap = await get(referralsRef);
                result = referralsSnap.exists() ? referralsSnap.val() : {};
                break;
                
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        // إرسال البيانات فقط (بدون أي معلومات عن Firebase)
        res.status(200).json({ 
            success: true, 
            data: result 
        });
        
    } catch (error) {
        console.error('Firebase API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}
