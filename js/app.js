// app.js معدل مع اشعارات خطأ مفصلة
const APP_CONFIG = {
    APP_NAME: "Ninja TON",
    BOT_USERNAME: "NinjaTONS_Bot",
    MINIMUM_WITHDRAW: 0.100,
    REFERRAL_BONUS_TON: 0.005,
    REFERRAL_BONUS_GAMES: 1,
    TASK_GAME_BONUS: 1,
    MAX_DAILY_ADS: 999999,
    AD_COOLDOWN: 300000
};

import { CacheManager, NotificationManager, SecurityManager, AdManager } from './modules/core.js';
import { TaskManager, DiceManager, ReferralManager } from './modules/features.js';



// في app.js - أضف هذا في أعلى الملف بعد imports
class ErrorDisplay {
    constructor() {
        this.createErrorPanel();
    }
    
    createErrorPanel() {
        const panel = document.createElement('div');
        panel.id = 'error-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 70px;
            left: 10px;
            right: 10px;
            background: rgba(239, 68, 68, 0.95);
            color: white;
            padding: 10px;
            border-radius: 10px;
            z-index: 9999;
            display: none;
            font-family: monospace;
            font-size: 12px;
            max-height: 200px;
            overflow-y: auto;
            border: 2px solid #dc2626;
        `;
        document.body.appendChild(panel);
    }
    
    showError(title, details) {
        const panel = document.getElementById('error-panel');
        panel.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px;">❌ ${title}</div>
            <div style="font-size: 11px; word-break: break-all;">${details}</div>
        `;
        panel.style.display = 'block';
        
        // إخفاء تلقائي بعد 10 ثواني
        setTimeout(() => {
            panel.style.display = 'none';
        }, 10000);
    }
    
    showSuccess(message) {
        const panel = document.getElementById('error-panel');
        panel.style.background = 'rgba(34, 197, 94, 0.95)';
        panel.style.border = '2px solid #16a34a';
        panel.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px;">✅ ${message}</div>
        `;
        panel.style.display = 'block';
        
        setTimeout(() => {
            panel.style.display = 'none';
            panel.style.background = 'rgba(239, 68, 68, 0.95)';
            panel.style.border = '2px solid #dc2626';
        }, 3000);
    }
}

// في NinjaTONApp constructor
constructor() {
    // ... الكود الحالي ...
    this.errorDisplay = new ErrorDisplay();
}

// عدل initializeAppWrite
async initializeAppWrite() {
    try {
        this.errorDisplay.showError('AppWrite', 'جاري التحميل...');
        
        // 1. تحميل SDK
        if (typeof Client === 'undefined') {
            this.errorDisplay.showError('SDK Error', 'مكتبة AppWrite لم تحمل');
            throw new Error('AppWrite SDK not loaded');
        }
        
        // 2. الاتصال
        this.client = new Client()
            .setEndpoint('https://fra.cloud.appwrite.io/v1')
            .setProject('696ea7200039a13fde62');
        
        this.account = new Account(this.client);
        this.databases = new Databases(this.client);
        
        this.errorDisplay.showError('AppWrite', 'جاري تسجيل الدخول...');
        
        // 3. تسجيل الدخول
        await this.account.createAnonymousSession();
        
        this.errorDisplay.showError('AppWrite', 'جاري فحص قاعدة البيانات...');
        
        // 4. اختبار قاعدة البيانات
        const users = await this.databases.listDocuments('1891231976', 'users', [], 1);
        
        this.errorDisplay.showSuccess('✅ اتصال ناجح!');
        this.appwriteInitialized = true;
        return true;
        
    } catch (error) {
        const errorMsg = `فشل الاتصال: ${error.message}`;
        this.errorDisplay.showError('AppWrite Error', errorMsg);
        return false;
    }
}

// عدل createNewUser
async createNewUser() {
    try {
        const userData = {
            telegram_id: this.tgUser.id.toString(),
            username: 'test',
            first_name: 'test',
            balance: 0,
            status: 'active',
            created_at: new Date().toISOString()
        };
        
        this.errorDisplay.showError('Database', 'جاري إنشاء مستخدم...');
        
        const newUser = await this.databases.createDocument(
            '1891231976',
            'users',
            'unique()',
            userData
        );
        
        this.errorDisplay.showSuccess('✅ تم إنشاء المستخدم!');
        return newUser;
        
    } catch (error) {
        this.errorDisplay.showError('Create User Error', error.message);
        return this.getDefaultUserState();
    }
}

// أضف زر اختبار في واجهة التطبيق
function addTestButton() {
    const testBtn = document.createElement('button');
    testBtn.innerHTML = '🔧 اختبار الاتصال';
    testBtn.style.cssText = `
        position: fixed;
        bottom: 120px;
        right: 10px;
        background: #3b82f6;
        color: white;
        padding: 8px 12px;
        border-radius: 8px;
        border: none;
        z-index: 9998;
        font-size: 12px;
        font-weight: bold;
    `;
    
    testBtn.onclick = async () => {
        const app = window.app;
        app.errorDisplay.showError('Test', 'جاري اختبار الاتصال...');
        
        try {
            // اختبار 1: الجلسة
            await app.account.createAnonymousSession();
            app.errorDisplay.showError('Test', '✓ الجلسة ناجحة');
            
            // اختبار 2: قراءة قاعدة البيانات
            const users = await app.databases.listDocuments('1891231976', 'users', [], 1);
            app.errorDisplay.showError('Test', `✓ قراءة ناجحة: ${users.total} مستخدم`);
            
            // اختبار 3: إنشاء مستخدم
            const testUser = await app.databases.createDocument(
                '1891231976',
                'users',
                'unique()',
                {
                    telegram_id: 'test_' + Date.now(),
                    username: 'test',
                    first_name: 'Test',
                    balance: 0,
                    status: 'test',
                    created_at: new Date().toISOString()
                }
            );
            app.errorDisplay.showSuccess('✅ جميع الاختبارات نجحت!');
            
        } catch (error) {
            app.errorDisplay.showError('Test Failed', error.message);
        }
    };
    
    document.body.appendChild(testBtn);
}

// استدعاء في initialize
async initialize() {
    // ... الكود الحالي ...
    
    // أضف بعد this.notificationManager = new NotificationManager();
    addTestButton();
    }
