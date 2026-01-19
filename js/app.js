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

class NinjaTONApp {
    
    constructor() {
        this.darkMode = true;
        this.tg = null;
        this.client = null;
        this.account = null;
        this.databases = null;
        this.auth = null;
        this.appwriteInitialized = false;
        this.configLoaded = false;
        
        this.currentUser = null;
        this.userState = {};
        this.appConfig = APP_CONFIG;
        
        this.userCompletedTasks = new Set();
        this.partnerTasks = [];
        this.isInitialized = false;
        this.isInitializing = false;
        this.userWithdrawals = [];
        this.questsState = {};
        this.appStats = {
            totalUsers: 0,
            onlineUsers: 0,
            totalPayments: 0,
            totalWithdrawals: 0
        };
        
        this.pages = [
            { id: 'tasks-page', name: 'Earnings', icon: 'fa-coins', color: '#3b82f6' },
            { id: 'dice-page', name: 'Dice', icon: 'fa-dice', color: '#3b82f6' },
            { id: 'quests-page', name: 'Quests', icon: 'fa-flag', color: '#3b82f6' },
            { id: 'referrals-page', name: 'Referrals', icon: 'fa-users', color: '#3b82f6' },
            { id: 'withdraw-page', name: 'Withdraw', icon: 'fa-wallet', color: '#3b82f6' }
        ];
        
        this.cache = new CacheManager();
        this.notificationManager = null;
        this.securityManager = new SecurityManager();
        this.adManager = null;
        this.isProcessingTask = false;
        
        this.tgUser = null;
        
        this.taskManager = null;
        this.diceManager = null;
        this.referralManager = null;
        
        this.currentTasksTab = 'main';
        this.isProcessingAd = false;
        this.isCopying = false;
        this.pendingReferral = null;
        
        this.referralBonusGiven = new Set();
        
        this.dailyAdsWatched = 0;
        this.maxDailyAds = this.appConfig.MAX_DAILY_ADS;
        this.lastAdWatchTime = 0;
        this.adCooldown = this.appConfig.AD_COOLDOWN;
        
        this.diceTotalPoints = 0;
        this.diceQuests = [
            { target: 1000, reward: 0.01, completed: false, claimed: false },
            { target: 2000, reward: 0.02, completed: false, claimed: false },
            { target: 4000, reward: 0.04, completed: false, claimed: false },
            { target: 8000, reward: 0.08, completed: false, claimed: false },
            { target: 16000, reward: 0.16, completed: false, claimed: false },
            { target: 32000, reward: 0.32, completed: false, claimed: false },
            { target: 64000, reward: 0.64, completed: false, claimed: false }
        ];
        
        this.tasksQuests = [
            { target: 50, reward: 0.03, completed: false, claimed: false },
            { target: 100, reward: 0.05, completed: false, claimed: false },
            { target: 500, reward: 0.15, completed: false, claimed: false },
            { target: 1000, reward: 0.20, completed: false, claimed: false },
            { target: 2000, reward: 0.30, completed: false, claimed: false },
            { target: 3000, reward: 0.35, completed: false, claimed: false },
            { target: 4000, reward: 0.40, completed: false, claimed: false },
            { target: 5000, reward: 0.50, completed: false, claimed: false },
            { target: 10000, reward: 1, completed: false, claimed: false }
        ];
        
        this.totalTasksCompleted = 0;
        
        this.referralMonitorInterval = null;
        this.adButtonCooldownTimer = null;
        
        this.autoAdTimer = null;
        this.autoAdInterval = null;
        this.autoAdEnabled = false;
        
        this.welcomeTasksShown = false;
        this.welcomeTasksCompleted = false;
        this.welcomeTasksVerified = {
            newsChannel: false,
            group: false
        };
        
        this.remoteConfig = null;
        this.configCache = null;
        this.configTimestamp = 0;
        
        this.pendingReferralAfterWelcome = null;
        this.rateLimiter = new (this.getRateLimiterClass())();
    }

    getRateLimiterClass() {
        return class RateLimiter {
            constructor() {
                this.requests = new Map();
                this.limits = {
                    'task_start': { limit: 1, window: 3000 },
                    'withdrawal': { limit: 1, window: 86400000 },
                    'ad_reward': { limit: 10, window: 300000 }
                };
            }

            checkLimit(userId, action) {
                try {
                    const key = `${userId}_${action}`;
                    const now = Date.now();
                    const limitConfig = this.limits[action] || { limit: 5, window: 60000 };
                    
                    if (!this.requests.has(key)) this.requests.set(key, []);
                    
                    const userRequests = this.requests.get(key);
                    const windowStart = now - limitConfig.window;
                    const recentRequests = userRequests.filter(time => time > windowStart);
                    this.requests.set(key, recentRequests);
                    
                    if (recentRequests.length >= limitConfig.limit) {
                        return {
                            allowed: false,
                            remaining: Math.ceil((recentRequests[0] + limitConfig.window - now) / 1000)
                        };
                    }
                    
                    recentRequests.push(now);
                    return { allowed: true };
                } catch (error) {
                    console.error("Rate limit check error:", error);
                    return { allowed: true };
                }
            }
        };
    }

    async initialize() {
        if (this.isInitializing || this.isInitialized) return;
        
        this.isInitializing = true;
        
        try {
            this.showLoadingProgress(5);
            
            if (!window.Telegram || !window.Telegram.WebApp) {
                this.showError("Please open from Telegram Mini App");
                return;
            }
            
            this.tg = window.Telegram.WebApp;
            
            if (!this.tg.initDataUnsafe || !this.tg.initDataUnsafe.user) {
                this.showError("User data not available");
                return;
            }
            
            this.tgUser = this.tg.initDataUnsafe.user;
            
            this.showLoadingProgress(8);
            const multiAccountAllowed = await this.checkMultiAccount(this.tgUser.id);
            if (!multiAccountAllowed) {
                this.isInitializing = false;
                return;
            }
            
            this.showLoadingProgress(12);
            
            this.tg.ready();
            this.tg.expand();
            
            this.showLoadingProgress(15);
            this.setupTelegramTheme();
            
            this.notificationManager = new NotificationManager();
            
            this.showLoadingProgress(20);
            
            const appwriteSuccess = await this.initializeAppWrite();
            if (!appwriteSuccess) {
                throw new Error("Failed to initialize AppWrite");
            }
            
            this.showLoadingProgress(40);
            
            await this.loadUserData();
            
            if (this.userState.status === 'ban') {
                this.showBannedPage();
                return;
            }
            
            this.showLoadingProgress(50);
            
            this.adManager = new AdManager(this);
            this.taskManager = new TaskManager(this);
            this.diceManager = new DiceManager(this);
            this.referralManager = new ReferralManager(this);
            
            this.startReferralMonitor();
            
            this.showLoadingProgress(60);
            
            try {
                await this.loadTasksData();
            } catch (taskError) {
                console.warn('Tasks load failed:', taskError);
            }
            
            this.showLoadingProgress(70);
            
            try {
                await this.loadQuestsData();
            } catch (questError) {
                console.warn('Quests load failed:', questError);
            }
            
            this.showLoadingProgress(80);
            
            try {
                await this.loadHistoryData();
            } catch (historyError) {
                console.warn('History load failed:', historyError);
            }
            
            this.showLoadingProgress(85);
            
            try {
                await this.loadAppStats();
            } catch (statsError) {
                console.warn('Stats load failed:', statsError);
            }
            
            this.showLoadingProgress(90);
            
            try {
                await this.loadDailyAdsWatched();
            } catch (diceError) {
                console.warn('Dice data load failed:', diceError);
            }
            
            this.showLoadingProgress(95);
            this.renderUI();
            
            this.darkMode = true;
            document.body.classList.add('dark-mode');
            
            this.isInitialized = true;
            this.isInitializing = false;
            
            this.showLoadingProgress(100);
            
            setTimeout(() => {
                const appLoader = document.getElementById('app-loader');
                const app = document.getElementById('app');
                
                if (appLoader) {
                    appLoader.style.opacity = '0';
                    appLoader.style.transition = 'opacity 0.5s ease';
                    
                    setTimeout(() => {
                        appLoader.style.display = 'none';
                    }, 500);
                }
                
                if (app) {
                    app.style.display = 'block';
                    setTimeout(() => {
                        app.style.opacity = '1';
                        app.style.transition = 'opacity 0.3s ease';
                    }, 50);
                }
                
                this.showWelcomeTasksModal();
                
            }, 500);
            
        } catch (error) {
            console.error('Initialization error:', error);
            
            if (this.notificationManager) {
                this.notificationManager.showNotification(
                    "Initialization Error",
                    "App loaded with limited functionality. Please refresh.",
                    "warning"
                );
            }
            
            try {
                this.userState = this.getDefaultUserState();
                this.renderUI();
                
                const appLoader = document.getElementById('app-loader');
                const app = document.getElementById('app');
                
                if (appLoader) appLoader.style.display = 'none';
                if (app) app.style.display = 'block';
                
            } catch (renderError) {
                this.showError("Failed to initialize app: " + error.message);
            }
            
            this.isInitializing = false;
        }
    }

    async initializeAppWrite() {
        try {
            if (typeof Client === 'undefined' || typeof Account === 'undefined' || typeof Databases === 'undefined') {
                throw new Error('AppWrite SDK not loaded');
            }
            
            this.client = new Client()
                .setEndpoint('https://fra.cloud.appwrite.io/v1')
                .setProject('696ea7200039a13fde62');
            
            this.account = new Account(this.client);
            this.databases = new Databases(this.client);
            
            console.log('AppWrite initialized, attempting anonymous authentication...');
            
            try {
                await this.account.createAnonymousSession();
                console.log('Anonymous authentication successful');
                this.appwriteInitialized = true;
                return true;
            } catch (authError) {
                console.error('Anonymous authentication failed:', authError);
                throw new Error('AppWrite authentication failed');
            }
            
        } catch (error) {
            console.error('AppWrite initialization failed:', error);
            
            this.notificationManager?.showNotification(
                "Authentication Error",
                "Failed to connect to database. Some features may not work.",
                "error"
            );
            
            return false;
        }
    }

    async loadUserData(forceRefresh = false) {
        const cacheKey = `user_${this.tgUser.id}`;
        
        if (!forceRefresh) {
            const cachedData = this.cache.get(cacheKey);
            if (cachedData) {
                this.userState = cachedData;
                this.updateHeader();
                return;
            }
        }
        
        try {
            if (!this.databases || !this.appwriteInitialized || !this.account) {
                console.warn('AppWrite not ready, using default data');
                this.userState = this.getDefaultUserState();
                this.updateHeader();
                
                if (!this.appwriteInitialized) {
                    setTimeout(() => {
                        this.initializeAppWrite();
                    }, 2000);
                }
                
                return;
            }
            
            const telegramId = this.tgUser.id;
            console.log('Loading user data with Telegram ID:', telegramId);
            
            let userData;
            
            try {
                const users = await this.databases.listDocuments(
                    'ninja',
                    'users',
                    [`telegram_id=${telegramId}`]
                );
                
                if (users.total > 0) {
                    userData = users.documents[0];
                    console.log('User found in AppWrite:', userData.telegram_id);
                    
                    userData = await this.updateExistingUser(userData);
                } else {
                    console.log('Creating new user in AppWrite');
                    userData = await this.createNewUser();
                }
                
                this.userState = userData;
                this.cache.set(cacheKey, userData, 60000);
                this.updateHeader();
                
                console.log('User data loaded successfully from AppWrite');
                
            } catch (error) {
                console.error('Error loading user data from AppWrite:', error);
                throw error;
            }
            
        } catch (error) {
            console.error('Error loading user data:', error);
            
            this.userState = this.getDefaultUserState();
            this.updateHeader();
            
            this.notificationManager?.showNotification(
                "Data Sync Error",
                "Using local data. Will sync when connection improves.",
                "warning"
            );
        }
    }

    getDefaultUserState() {
        return {
            telegram_id: this.tgUser.id.toString(),
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            first_name: this.getShortName(this.tgUser.first_name || 'User'),
            balance: 0,
            dice_plays: 0,
            referrals: 0,
            referral_code: this.generateReferralCode(),
            total_earned: 0,
            total_tasks: 0,
            status: 'free',
            welcome_completed: false
        };
    }

    async createNewUser() {
        const multiAccountAllowed = await this.checkMultiAccount(this.tgUser.id, false);
        if (!multiAccountAllowed) {
            return this.getDefaultUserState();
        }
        
        let referralId = null;
        const startParam = this.tg?.initDataUnsafe?.start_param;
        
        if (startParam) {
            referralId = this.extractReferralId(startParam);
            
            if (referralId && referralId > 0 && referralId !== this.tgUser.id) {
                this.pendingReferralAfterWelcome = referralId;
            } else {
                referralId = null;
            }
        }
        
        const userData = {
            telegram_id: this.tgUser.id.toString(),
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            first_name: this.getShortName(this.tgUser.first_name || ''),
            balance: 0,
            dice_plays: 0,
            referrals: 0,
            referred_by: referralId ? referralId.toString() : null,
            referral_code: this.generateReferralCode(),
            total_earned: 0,
            total_tasks: 0,
            status: 'free',
            created_at: new Date().toISOString(),
            last_active: new Date().toISOString(),
            welcome_completed: false,
            welcome_completed_at: null
        };
        
        try {
            const newUser = await this.databases.createDocument(
                'ninja',
                'users',
                'unique()',
                userData
            );
            
            return newUser;
        } catch (error) {
            console.error('Error creating user:', error);
            return userData;
        }
    }

    async updateExistingUser(userData) {
        const now = new Date();
        
        const updates = {
            last_active: new Date().toISOString(),
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            first_name: userData.first_name || this.getShortName(this.tgUser.first_name || 'User')
        };
        
        if (userData.completed_tasks && Array.isArray(userData.completed_tasks)) {
            this.userCompletedTasks = new Set(userData.completed_tasks);
        } else {
            this.userCompletedTasks = new Set();
        }
        
        const defaultData = {
            referral_code: userData.referral_code || this.generateReferralCode(),
            status: userData.status || 'free',
            referral_earnings: userData.referral_earnings || 0,
            total_earned: userData.total_earned || 0,
            total_tasks: userData.total_tasks || 0,
            balance: userData.balance || 0,
            referrals: userData.referrals || 0,
            dice_plays: userData.dice_plays || 0,
            welcome_completed: userData.welcome_completed || false
        };
        
        Object.keys(defaultData).forEach(key => {
            if (userData[key] === undefined) {
                updates[key] = defaultData[key];
                userData[key] = defaultData[key];
            }
        });
        
        try {
            await this.databases.updateDocument(
                'ninja',
                'users',
                userData.$id,
                updates
            );
            
            Object.assign(userData, updates);
        } catch (error) {
            console.error('Error updating user:', error);
        }
        
        return userData;
    }

    async checkMultiAccount(tgId, showBanPage = true) {
        try {
            const ip = await this.getUserIP();
            if (!ip) return true;
            
            const ipData = JSON.parse(localStorage.getItem("ip_records")) || {};
            
            if (ipData[ip] && ipData[ip] !== tgId) {
                if (showBanPage) {
                    this.showMultiAccountBanPage();
                }
                
                try {
                    if (this.databases) {
                        await this.databases.updateDocument(
                            'ninja',
                            'users',
                            `telegram_id=${tgId}`,
                            {
                                status: 'ban',
                                ban_reason: 'Multiple accounts detected on same IP',
                                banned_at: new Date().toISOString()
                            }
                        );
                    }
                } catch (error) {}
                
                return false;
            }
            
            if (!ipData[ip]) {
                ipData[ip] = tgId;
                localStorage.setItem("ip_records", JSON.stringify(ipData));
            }
            
            return true;
        } catch (error) {
            console.error('Multi account check error:', error);
            return true;
        }
    }

    showMultiAccountBanPage() {
        document.body.innerHTML = `
            <div style="
                background-color:#000000;
                color:#fff;
                height:100vh;
                display:flex;
                justify-content:center;
                align-items:center;
                font-family:-apple-system, BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                padding:20px;
            ">
                <div style="
                    background:#111111;
                    border-radius:22px;
                    padding:40px 30px;
                    width:85%;
                    max-width:330px;
                    text-align:center;
                    box-shadow:0 0 40px rgba(0,0,0,0.5);
                    border:1px solid rgba(255,255,255,0.08);
                    animation:fadeIn 0.6s ease-out;
                ">
                    <div style="margin-bottom:24px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="75" height="75" viewBox="0 0 24 24" fill="none" stroke="#ff4d4d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="animation:pulse 1.8s infinite ease-in-out;">
                            <circle cx="12" cy="12" r="10" stroke="#ff4d4d"/>
                            <line x1="15" y1="9" x2="9" y2="15" stroke="#ff4d4d"/>
                            <line x1="9" y1="9" x2="15" y2="15" stroke="#ff4d4d"/>
                        </svg>
                    </div>
                    <h2 style="
                        font-size:18px;
                        font-weight:600;
                        color:#fff;
                        letter-spacing:0.5px;
                    ">Multi accounts not allowed</h2>
                    <p style="
                        margin-top:10px;
                        color:#9da5b4;
                        font-size:14px;
                        line-height:1.5;
                    ">Access for this device has been blocked.<br>Multiple Telegram accounts detected on the same IP.</p>
                </div>
            </div>

            <style>
                @keyframes fadeIn {
                    from { opacity:0; transform:scale(0.97); }
                    to { opacity:1; transform:scale(1); }
                }
                @keyframes pulse {
                    0% { transform:scale(1); opacity:1; }
                    50% { transform:scale(1.1); opacity:0.8; }
                    100% { transform:scale(1); opacity:1; }
                }
            </style>
        `;
    }

    async getUserIP() {
        try {
            const res = await fetch("https://api.ipify.org?format=json");
            const data = await res.json();
            return data.ip;
        } catch (e) {
            console.error("Failed to fetch IP:", e);
            return null;
        }
    }

    extractReferralId(startParam) {
        if (!startParam) return null;
        
        if (!isNaN(startParam)) {
            return parseInt(startParam);
        } else if (startParam.includes('startapp=')) {
            const match = startParam.match(/startapp=(\d+)/);
            if (match && match[1]) {
                return parseInt(match[1]);
            }
        } else if (startParam.includes('=')) {
            const parts = startParam.split('=');
            if (parts.length > 1 && !isNaN(parts[1])) {
                return parseInt(parts[1]);
            }
        }
        
        return null;
    }

    async processReferralRegistrationWithBonus(referrerId, newUserId) {
        try {
            if (!this.databases) return;
            
            const referrers = await this.databases.listDocuments(
                'ninja',
                'users',
                [`telegram_id=${referrerId}`]
            );
            
            if (referrers.total === 0) return;
            
            const referrerData = referrers.documents[0];
            
            if (referrerData.status === 'ban') return;
            
            const referralBonus = this.appConfig.REFERRAL_BONUS_TON;
            const diceBonus = this.appConfig.REFERRAL_BONUS_GAMES;
            
            const newBalance = this.safeNumber(referrerData.balance) + referralBonus;
            const newDicePlays = (referrerData.dice_plays || 0) + diceBonus;
            const newReferrals = (referrerData.referrals || 0) + 1;
            const newReferralEarnings = this.safeNumber(referrerData.referral_earnings || 0) + referralBonus;
            const newTotalEarned = this.safeNumber(referrerData.total_earned) + referralBonus;
            
            await this.databases.updateDocument(
                'ninja',
                'users',
                referrerData.$id,
                {
                    balance: newBalance,
                    dice_plays: newDicePlays,
                    referrals: newReferrals,
                    referral_earnings: newReferralEarnings,
                    total_earned: newTotalEarned
                }
            );
            
            await this.databases.createDocument(
                'ninja',
                'referrals',
                'unique()',
                {
                    referrer_id: referrerId.toString(),
                    referred_id: newUserId.toString(),
                    status: 'verified',
                    bonus_given: true,
                    bonus_amount: referralBonus,
                    created_at: new Date().toISOString()
                }
            );
            
            const newUsers = await this.databases.listDocuments(
                'ninja',
                'users',
                [`telegram_id=${newUserId}`]
            );
            
            if (newUsers.total > 0) {
                await this.databases.updateDocument(
                    'ninja',
                    'users',
                    newUsers.documents[0].$id,
                    {
                        referral_state: 'verified'
                    }
                );
            }
            
            await this.sendReferralNotification(referrerId, newUserId, referralBonus, diceBonus);
            
            if (this.tgUser && referrerId === this.tgUser.id) {
                this.userState.balance = newBalance;
                this.userState.dice_plays = newDicePlays;
                this.userState.referrals = newReferrals;
                this.userState.referral_earnings = newReferralEarnings;
                this.userState.total_earned = newTotalEarned;
                
                this.updateHeader();
                
                this.notificationManager.showNotification(
                    "🎉 New Referral!", 
                    `+${this.appConfig.REFERRAL_BONUS_TON} TON + ${this.appConfig.REFERRAL_BONUS_GAMES} GAME!`, 
                    "success"
                );
            }
            
            console.log(`Referral bonus processed for referrer ${referrerId}, new user ${newUserId}`);
            
            await this.refreshReferralsList();
            
        } catch (error) {
            console.error('Error in referral process:', error);
        }
    }

    async sendReferralNotification(referrerId, newUserId, tonBonus, gamesBonus) {
        try {
            const referrers = await this.databases.listDocuments(
                'ninja',
                'users',
                [`telegram_id=${referrerId}`]
            );
            
            const newUsers = await this.databases.listDocuments(
                'ninja',
                'users',
                [`telegram_id=${newUserId}`]
            );
            
            if (referrers.total === 0 || newUsers.total === 0) {
                console.error('Referrer or new user data not found');
                return false;
            }
            
            const referrerData = referrers.documents[0];
            const newUserData = newUsers.documents[0];
            
            const username = newUserData.username?.replace('@', '') || 'user';
            const firstName = newUserData.first_name || 'User';
            const referrerUsername = referrerData.username?.replace('@', '') || 'user';
            
            const message = `🎉 *NEW REFERRAL VERIFIED!*\n\n` +
                          `👤 *New User:* ${firstName} (@${username})\n` +
                          `💰 *Earned:* ${tonBonus.toFixed(3)} TON + ${gamesBonus} Game(s)\n` +
                          `📊 *Total Referrals:* ${referrerData.referrals || 1}\n` +
                          `💎 *Total Earnings:* ${(referrerData.referral_earnings || 0).toFixed(3)} TON\n\n` +
                          `🥷 *Keep inviting to earn more!*`;
            
            console.log('Sending referral notification:', {
                referrerId,
                newUserId,
                message,
                tonBonus,
                gamesBonus
            });
            
            const response = await fetch('/api/telegram', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'sendMessage',
                    params: {
                        chat_id: referrerId,
                        text: message,
                        parse_mode: 'Markdown'
                    }
                })
            });
            
            const data = await response.json();
            
            if (data.ok) {
                console.log('Telegram notification sent successfully:', data);
                return true;
            } else {
                console.error('Failed to send Telegram notification:', data);
                return false;
            }
            
        } catch (error) {
            console.error('Failed to send referral notification:', error);
            return false;
        }
    }

    async loadTasksData() {
        try {
            if (this.taskManager) {
                return await this.taskManager.loadTasksData();
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    async loadQuestsData() {
        try {
            const referralQuestsData = [
                { target: 5, reward: 0.01, completed: false, claimed: false },
                { target: 10, reward: 0.02, completed: false, claimed: false },
                { target: 20, reward: 0.04, completed: false, claimed: false },
                { target: 40, reward: 0.08, completed: false, claimed: false },
                { target: 80, reward: 0.16, completed: false, claimed: false },
                { target: 160, reward: 0.32, completed: false, claimed: false },
                { target: 320, reward: 0.64, completed: false, claimed: false },
                { target: 640, reward: 1.28, completed: false, claimed: false },
                { target: 1000, reward: 2.56, completed: false, claimed: false },
                { target: 2000, reward: 5, completed: false, claimed: false }
            ];
            
            let savedReferralQuests = [];
            if (this.databases) {
                const userData = await this.getCurrentUserDocument();
                if (userData && userData.referral_quests) {
                    savedReferralQuests = userData.referral_quests;
                }
            }
            
            if (savedReferralQuests && savedReferralQuests.length > 0) {
                referralQuestsData.forEach((quest, index) => {
                    if (savedReferralQuests[index]) {
                        quest.completed = savedReferralQuests[index].completed || false;
                        quest.claimed = savedReferralQuests[index].claimed || false;
                    }
                });
            }
            
            const userReferrals = this.safeNumber(this.userState.referrals || 0);
            
            referralQuestsData.forEach((quest, index) => {
                if (!quest.claimed) {
                    quest.completed = userReferrals >= quest.target;
                }
            });
            
            let savedTasksQuests = [];
            if (this.databases) {
                const userData = await this.getCurrentUserDocument();
                if (userData && userData.tasks_quests) {
                    savedTasksQuests = userData.tasks_quests;
                }
            }
            
            if (savedTasksQuests && savedTasksQuests.length > 0) {
                this.tasksQuests.forEach((quest, index) => {
                    if (savedTasksQuests[index]) {
                        quest.completed = savedTasksQuests[index].completed || false;
                        quest.claimed = savedTasksQuests[index].claimed || false;
                    }
                });
            }
            
            const totalTasks = this.safeNumber(this.userState.total_tasks || 0);
            this.totalTasksCompleted = totalTasks;
            
            this.tasksQuests.forEach((quest, index) => {
                if (!quest.claimed) {
                    quest.completed = totalTasks >= quest.target;
                }
            });
            
            this.questsState = { 
                referralQuests: referralQuestsData, 
                tasksQuests: this.tasksQuests,
                userReferrals,
                totalTasksCompleted: totalTasks,
                currentReferralQuestIndex: referralQuestsData.findIndex(q => !q.claimed)
            };
            return this.questsState;
            
        } catch (error) {
            return { referralQuests: [], tasksQuests: [], userReferrals: 0, totalTasksCompleted: 0, currentReferralQuestIndex: -1 };
        }
    }

    async getCurrentUserDocument() {
        try {
            if (!this.databases || !this.tgUser) return null;
            
            const users = await this.databases.listDocuments(
                'ninja',
                'users',
                [`telegram_id=${this.tgUser.id}`]
            );
            
            if (users.total > 0) {
                return users.documents[0];
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    async loadHistoryData() {
        try {
            if (!this.databases) {
                this.userWithdrawals = [];
                return;
            }
            
            const withdrawals = await this.databases.listDocuments(
                'ninja',
                'withdrawals',
                [`user_id=${this.tgUser.id}`]
            );
            
            this.userWithdrawals = withdrawals.documents || [];
            this.userWithdrawals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
        } catch (error) {
            this.userWithdrawals = [];
        }
    }

    async loadAppStats() {
        try {
            if (!this.databases) {
                this.appStats = {
                    totalUsers: 0,
                    onlineUsers: 0,
                    totalPayments: 0,
                    totalWithdrawals: 0
                };
                return;
            }
            
            const users = await this.databases.listDocuments('ninja', 'users');
            const totalUsers = users.total || 0;
            
            const minOnline = Math.floor(totalUsers * 0.05);
            const maxOnline = Math.floor(totalUsers * 0.20);
            const onlineUsers = Math.floor(Math.random() * (maxOnline - minOnline + 1)) + minOnline;
            
            this.appStats = {
                totalUsers: totalUsers,
                onlineUsers: Math.max(onlineUsers, Math.floor(totalUsers * 0.05)),
                totalPayments: 0,
                totalWithdrawals: 0
            };
            
        } catch (error) {
            this.appStats = {
                totalUsers: 0,
                onlineUsers: 0,
                totalPayments: 0,
                totalWithdrawals: 0
            };
        }
    }

    async updateAppStats(stat, value = 1) {
        try {
            if (!this.databases) return;
            
            if (stat === 'totalUsers') {
                const newTotal = (this.appStats.totalUsers || 0) + value;
                const minOnline = Math.floor(newTotal * 0.05);
                const maxOnline = Math.floor(newTotal * 0.20);
                const onlineUsers = Math.floor(Math.random() * (maxOnline - minOnline + 1)) + minOnline;
                
                this.appStats.onlineUsers = Math.max(onlineUsers, Math.floor(newTotal * 0.05));
            }
            
            this.appStats[stat] = (this.appStats[stat] || 0) + value;
            
            if (stat === 'totalUsers') {
                await this.loadAppStats();
            }
        } catch (error) {}
    }

    async showWelcomeTasksModal() {
        if (this.userState.welcome_completed) {
            this.showPage('tasks-page');
            return;
        }
        
        const modal = document.createElement('div');
        modal.className = 'welcome-tasks-modal';
        
        modal.innerHTML = `
            <div class="welcome-tasks-content">
                <div class="welcome-header">
                    <div class="welcome-icon">
                        <i class="fas fa-gift"></i>
                    </div>
                    <h3>Welcome Tasks</h3>
                    <p>Join all channels to claim your bonus</p>
                </div>
                
                <div class="welcome-tasks-list">
                    <div class="welcome-task-item" id="welcome-task-news">
                        <div class="welcome-task-info">
                            <h4>Join our channel</h4>
                        </div>
                        <button class="welcome-task-btn" id="welcome-news-btn" 
                                data-url="https://t.me/NINJA_TONS" 
                                data-channel="@NINJA_TONS">
                            <i class="fas fa-external-link-alt"></i> Join
                        </button>
                    </div>
                    
                    <div class="welcome-task-item" id="welcome-task-group">
                        <div class="welcome-task-info">
                            <h4>Join our group</h4>
                        </div>
                        <button class="welcome-task-btn" id="welcome-group-btn" 
                                data-url="https://t.me/NEJARS" 
                                data-channel="@NEJARS">
                            <i class="fas fa-external-link-alt"></i> Join
                        </button>
                    </div>
                    
                    <div class="welcome-task-item" id="welcome-task-partner1">
                        <div class="welcome-task-info">
                            <h4>Join Partner 1</h4>
                        </div>
                        <button class="welcome-task-btn" id="welcome-partner1-btn" 
                                data-url="https://t.me/MONEYHUB9_69" 
                                data-channel="@MONEYHUB9_69">
                            <i class="fas fa-external-link-alt"></i> Join
                        </button>
                    </div>
                    
                    <div class="welcome-task-item" id="welcome-task-partner2">
                        <div class="welcome-task-info">
                            <h4>Join Partner 2</h4>
                        </div>
                        <button class="welcome-task-btn" id="welcome-partner2-btn" 
                                data-url="https://t.me/Crypto_al2" 
                                data-channel="@Crypto_al2">
                            <i class="fas fa-external-link-alt"></i> Join
                        </button>
                    </div>
                </div>
                
                <div class="welcome-footer">
                    <button class="check-welcome-btn" id="check-welcome-btn" disabled>
                        <i class="fas fa-check-circle"></i> Check & Get 0.01 TON
                    </button>
                    <p>
                        <i class="fas fa-info-circle"></i> Join all 4 channels then click CHECK
                    </p>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const app = this;
        const clickedTasks = {
            news: false,
            group: false,
            partner1: false,
            partner2: false
        };
        
        function updateCheckButton() {
            const checkBtn = document.getElementById('check-welcome-btn');
            const allClicked = clickedTasks.news && clickedTasks.group && 
                              clickedTasks.partner1 && clickedTasks.partner2;
            
            if (allClicked && checkBtn) {
                checkBtn.disabled = false;
            }
        }
        
        const taskButtons = [
            { id: 'welcome-news-btn', key: 'news', channel: '@NINJA_TONS' },
            { id: 'welcome-group-btn', key: 'group', channel: '@NEJARS' },
            { id: 'welcome-partner1-btn', key: 'partner1', channel: '@MONEYHUB9_69' },
            { id: 'welcome-partner2-btn', key: 'partner2', channel: '@Crypto_al2' }
        ];
        
        taskButtons.forEach(({ id, key, channel }) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', async () => {
                    const url = btn.getAttribute('data-url');
                    window.open(url, '_blank');
                    
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...';
                    btn.disabled = true;
                    
                    setTimeout(async () => {
                        try {
                            const isMember = await app.checkTelegramMembership(channel);
                            
                            if (isMember) {
                                btn.innerHTML = '<i class="fas fa-check"></i> Checked';
                                btn.classList.add('completed');
                                clickedTasks[key] = true;
                            } else {
                                btn.innerHTML = '<i class="fas fa-times"></i> Failed';
                                btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                                clickedTasks[key] = false;
                                
                                app.notificationManager.showNotification(
                                    "Join Required", 
                                    `Please join ${channel} first`, 
                                    "error"
                                );
                            }
                            
                            updateCheckButton();
                            
                        } catch (error) {
                            btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
                            btn.disabled = false;
                        }
                    }, 5000);
                });
            }
        });
        
        const checkBtn = document.getElementById('check-welcome-btn');
        if (checkBtn) {
            checkBtn.addEventListener('click', async () => {
                if (checkBtn.disabled) return;
                
                checkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
                checkBtn.disabled = true;
                
                try {
                    const verificationResult = await app.verifyWelcomeTasks();
                    
                    if (verificationResult.success) {
                        await app.completeWelcomeTasks();
                        modal.remove();
                        app.showPage('tasks-page');
                        app.notificationManager.showNotification("Success", "Welcome tasks completed! +0.01 TON", "success");
                    } else {
                        checkBtn.innerHTML = '<i class="fas fa-check-circle"></i> Check & Get 0.01 TON';
                        checkBtn.disabled = false;
                        
                        if (verificationResult.missing.length > 0) {
                            const missingItems = verificationResult.missing.map(item => {
                                if (item === '@NINJA_TONS') return 'our channel';
                                if (item === '@NEJARS') return 'our group';
                                if (item === '@MONEYHUB9_69') return 'Partner 1';
                                if (item === '@Crypto_al2') return 'Partner 2';
                                return item;
                            }).join(', ');
                            
                            app.notificationManager.showNotification(
                                "Verification Failed", 
                                `Please join: ${missingItems}`, 
                                "error"
                            );
                        }
                    }
                } catch (error) {
                    app.notificationManager.showNotification("Error", "Failed to verify tasks", "error");
                    checkBtn.innerHTML = '<i class="fas fa-check-circle"></i> Check & Get 0.01 TON';
                    checkBtn.disabled = false;
                }
            });
        }
        
        this.welcomeTasksShown = true;
    }
    
    async verifyWelcomeTasks() {
        try {
            const channelsToCheck = ['@NINJA_TONS', '@NEJARS', '@MONEYHUB9_69', '@Crypto_al2'];
            const missingChannels = [];
            const verifiedChannels = [];
            
            for (const channel of channelsToCheck) {
                const isMember = await this.checkTelegramMembership(channel);
                
                if (isMember) {
                    verifiedChannels.push(channel);
                } else {
                    missingChannels.push(channel);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            return {
                success: missingChannels.length === 0,
                verified: verifiedChannels,
                missing: missingChannels
            };
            
        } catch (error) {
            console.error("Verify welcome tasks error:", error);
            return {
                success: false,
                verified: [],
                missing: ['@NINJA_TONS', '@NEJARS', '@MONEYHUB9_69', '@Crypto_al2']
            };
        }
    }
    
    async checkTelegramMembership(channelUsername) {
        try {
            if (!this.tgUser || !this.tgUser.id) {
                return false;
            }
            
            const response = await fetch('/api/telegram', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-User-ID': this.tgUser.id.toString()
                },
                body: JSON.stringify({
                    action: 'getChatMember',
                    params: {
                        chat_id: channelUsername,
                        user_id: this.tgUser.id
                    }
                })
            });
            
            if (!response.ok) {
                return false;
            }
            
            const data = await response.json();
            
            if (data.ok && data.result) {
                const status = data.result.status;
                const isMember = (status === 'member' || status === 'administrator' || 
                                status === 'creator' || status === 'restricted');
                return isMember;
            }
            
            return false;
            
        } catch (error) {
            return false;
        }
    }
    
    async completeWelcomeTasks() {
        try {
            const reward = 0.01;
            const currentBalance = this.safeNumber(this.userState.balance);
            const newBalance = currentBalance + reward;
            
            if (this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            balance: newBalance,
                            total_earned: this.safeNumber(this.userState.total_earned) + reward,
                            total_tasks: this.safeNumber(this.userState.total_tasks) + 4,
                            dice_plays: (this.userState.dice_plays || 0) + (this.appConfig.TASK_GAME_BONUS * 4),
                            welcome_completed: true,
                            welcome_completed_at: new Date().toISOString()
                        }
                    );
                }
            }
            
            this.userState.balance = newBalance;
            this.userState.total_earned = this.safeNumber(this.userState.total_earned) + reward;
            this.userState.total_tasks = this.safeNumber(this.userState.total_tasks) + 4;
            this.userState.dice_plays = (this.userState.dice_plays || 0) + (this.appConfig.TASK_GAME_BONUS * 4);
            this.userState.welcome_completed = true;
            this.userState.welcome_completed_at = new Date().toISOString();
            
            if (this.pendingReferralAfterWelcome) {
                const referrerId = this.pendingReferralAfterWelcome;
                await this.processReferralRegistrationWithBonus(referrerId, this.tgUser.id);
                this.pendingReferralAfterWelcome = null;
            }
            
            this.cache.delete(`user_${this.tgUser.id}`);
            this.updateHeader();
            
            return true;
        } catch (error) {
            console.error("Complete welcome tasks error:", error);
            return false;
        }
    }

    startReferralMonitor() {
        if (this.referralMonitorInterval) {
            clearInterval(this.referralMonitorInterval);
        }
        
        this.referralMonitorInterval = setInterval(async () => {
            await this.checkReferralsVerification();
        }, 30000);
    }

    async checkReferralsVerification() {
        try {
            if (!this.databases || !this.tgUser) return;
            
            const referrals = await this.databases.listDocuments(
                'ninja',
                'referrals',
                [`referrer_id=${this.tgUser.id}`, `status=pending`]
            );
            
            if (referrals.total === 0) return;
            
            let updated = false;
            
            for (const referral of referrals.documents) {
                const newUsers = await this.databases.listDocuments(
                    'ninja',
                    'users',
                    [`telegram_id=${referral.referred_id}`, `welcome_completed=true`]
                );
                
                if (newUsers.total > 0) {
                    await this.processReferralRegistrationWithBonus(this.tgUser.id, referral.referred_id);
                    updated = true;
                }
            }
            
            if (updated) {
                this.cache.delete(`user_${this.tgUser.id}`);
                this.cache.delete(`referrals_${this.tgUser.id}`);
                
                if (document.getElementById('referrals-page')?.classList.contains('active')) {
                    this.renderReferralsPage();
                }
            }
            
        } catch (error) {
            console.error('Check referrals verification error:', error);
        }
    }

    async loadDailyAdsWatched() {
        try {
            const lastWatch = localStorage.getItem(`last_ad_watch_${this.tgUser.id}`);
            this.lastAdWatchTime = lastWatch ? parseInt(lastWatch) : 0;
            
            const storedAds = localStorage.getItem(`daily_ads_watched_${this.tgUser.id}`);
            this.dailyAdsWatched = storedAds ? parseInt(storedAds) : 0;
            
        } catch (error) {
            this.dailyAdsWatched = 0;
            this.lastAdWatchTime = 0;
        }
    }

    async loadDicePointsAndQuests() {
        try {
            if (!this.databases) return;
            
            const userDoc = await this.getCurrentUserDocument();
            if (userDoc) {
                this.diceTotalPoints = userDoc.dice_points || 0;
                this.totalTasksCompleted = userDoc.total_tasks || 0;
                
                if (userDoc.dice_quests) {
                    const savedQuests = userDoc.dice_quests;
                    this.diceQuests.forEach((quest, index) => {
                        if (savedQuests[index]) {
                            quest.completed = savedQuests[index].completed || false;
                            quest.claimed = savedQuests[index].claimed || false;
                        }
                    });
                }
                
                if (userDoc.tasks_quests) {
                    const savedQuests = userDoc.tasks_quests;
                    this.tasksQuests.forEach((quest, index) => {
                        if (savedQuests[index]) {
                            quest.completed = savedQuests[index].completed || false;
                            quest.claimed = savedQuests[index].claimed || false;
                        }
                    });
                }
            }
            
        } catch (error) {}
    }

    async updateDicePoints(points) {
        try {
            if (!this.databases) return;
            
            this.diceTotalPoints += points;
            
            const userDoc = await this.getCurrentUserDocument();
            if (userDoc) {
                await this.databases.updateDocument(
                    'ninja',
                    'users',
                    userDoc.$id,
                    {
                        dice_points: this.diceTotalPoints
                    }
                );
            }
            
            await this.checkDiceQuests();
            
        } catch (error) {}
    }

    async updateTasksCompleted() {
        try {
            if (!this.databases) return;
            
            this.totalTasksCompleted = this.userState.total_tasks || 0;
            await this.checkTasksQuests();
            
        } catch (error) {}
    }

    async checkDiceQuests() {
        try {
            let updated = false;
            
            this.diceQuests.forEach((quest, index) => {
                if (!quest.claimed && this.diceTotalPoints >= quest.target) {
                    quest.completed = true;
                    updated = true;
                }
            });
            
            if (updated && this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            dice_quests: this.diceQuests
                        }
                    );
                }
            }
            
            if (document.getElementById('quests-page')?.classList.contains('active')) {
                this.renderQuestsPage();
            }
            
        } catch (error) {}
    }

    async checkTasksQuests() {
        try {
            let updated = false;
            
            this.tasksQuests.forEach((quest, index) => {
                if (!quest.claimed && this.totalTasksCompleted >= quest.target) {
                    quest.completed = true;
                    updated = true;
                }
            });
            
            if (updated && this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            tasks_quests: this.tasksQuests
                        }
                    );
                }
            }
            
            if (document.getElementById('quests-page')?.classList.contains('active')) {
                this.renderQuestsPage();
            }
            
        } catch (error) {}
    }

    async claimDiceQuest(questIndex) {
        try {
            if (questIndex < 0 || questIndex >= this.diceQuests.length) return false;
            
            const quest = this.diceQuests[questIndex];
            
            if (!quest.completed || quest.claimed) return false;
            
            let adShown = false;
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                adShown = await new Promise((resolve) => {
                    window.AdBlock19345.show().then(() => {
                        resolve(true);
                    }).catch(() => {
                        resolve(false);
                    });
                });
            }
            
            if (!adShown) {
                this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim reward", "info");
                return false;
            }
            
            const rewardAmount = quest.reward;
            const currentBalance = this.safeNumber(this.userState.balance);
            const newBalance = currentBalance + rewardAmount;
            
            quest.claimed = true;
            
            if (this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            balance: newBalance,
                            total_earned: this.safeNumber(this.userState.total_earned) + rewardAmount,
                            dice_quests: this.diceQuests
                        }
                    );
                }
            }
            
            this.userState.balance = newBalance;
            this.userState.total_earned = this.safeNumber(this.userState.total_earned) + rewardAmount;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            this.renderQuestsPage();
            
            this.notificationManager.showNotification("Quest Claimed", `+${rewardAmount.toFixed(2)} TON!`, "success");
            return true;
            
        } catch (error) {
            return false;
        }
    }

    async claimTasksQuest(questIndex) {
        try {
            if (questIndex < 0 || questIndex >= this.tasksQuests.length) return false;
            
            const quest = this.tasksQuests[questIndex];
            
            if (!quest.completed || quest.claimed) return false;
            
            let adShown = false;
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                adShown = await new Promise((resolve) => {
                    window.AdBlock19345.show().then(() => {
                        resolve(true);
                    }).catch(() => {
                        resolve(false);
                    });
                });
            }
            
            if (!adShown) {
                this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim reward", "info");
                return false;
            }
            
            const rewardAmount = quest.reward;
            const currentBalance = this.safeNumber(this.userState.balance);
            const newBalance = currentBalance + rewardAmount;
            
            quest.claimed = true;
            
            if (this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            balance: newBalance,
                            total_earned: this.safeNumber(this.userState.total_earned) + rewardAmount,
                            tasks_quests: this.tasksQuests
                        }
                    );
                }
            }
            
            this.userState.balance = newBalance;
            this.userState.total_earned = this.safeNumber(this.userState.total_earned) + rewardAmount;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            this.renderQuestsPage();
            
            this.notificationManager.showNotification("Quest Claimed", `+${rewardAmount.toFixed(2)} TON!`, "success");
            return true;
            
        } catch (error) {
            return false;
        }
    }

    setupTelegramTheme() {
        if (!this.tg) return;
        
        this.darkMode = true;
        document.body.classList.add('dark-mode');
        
        this.tg.onEvent('themeChanged', () => {
            this.darkMode = true;
            document.body.classList.add('dark-mode');
        });
    }

    showLoadingProgress(percent) {
        const progressBar = document.querySelector('.loading-progress-bar');
        if (progressBar) {
            progressBar.style.width = percent + '%';
            progressBar.style.transition = 'width 0.3s ease';
        }
        
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) {
            loadingText.textContent = `Loading... ${percent}%`;
        }
    }

    showError(message) {
        document.body.innerHTML = `
            <div class="error-container">
                <div class="error-content">
                    <div class="error-header">
                        <div class="error-icon">
                            <i class="fab fa-telegram"></i>
                        </div>
                        <h2>Ninja TON</h2>
                    </div>
                    
                    <div class="error-message">
                        <div class="error-icon-wrapper">
                            <i class="fas fa-exclamation-triangle"></i>
                        </div>
                        <h3>Error</h3>
                        <p>${message}</p>
                    </div>
                    
                    <button onclick="window.location.reload()" class="reload-btn">
                        <i class="fas fa-redo"></i> Reload App
                    </button>
                </div>
            </div>
        `;
    }

    showBannedPage() {
        document.body.innerHTML = `
            <div class="banned-container">
                <div class="banned-content">
                    <div class="banned-header">
                        <div class="banned-icon">
                            <i class="fas fa-ban"></i>
                        </div>
                        <h2>Account Banned</h2>
                        <p>Your account has been suspended</p>
                    </div>
                    
                    <div class="ban-reason">
                        <div class="ban-reason-icon">
                            <i class="fas fa-exclamation-circle"></i>
                        </div>
                        <h3>Ban Reason</h3>
                        <p>${this.userState.ban_reason || 'Violation of terms'}</p>
                    </div>
                </div>
            </div>
        `;
    }

    updateHeader() {
        const userPhoto = document.getElementById('user-photo');
        const userName = document.getElementById('user-name');
        const telegramId = document.getElementById('telegram-id-text');
        const tonBalance = document.getElementById('header-ton-balance');
        
        if (userPhoto) {
            const photoUrl = this.tgUser.photo_url || 'https://cdn-icons-png.flaticon.com/512/9195/9195920.png';
            userPhoto.src = photoUrl;
            userPhoto.style.width = '60px';
            userPhoto.style.height = '60px';
            userPhoto.style.objectFit = 'cover';
            userPhoto.oncontextmenu = (e) => e.preventDefault();
            userPhoto.ondragstart = () => false;
        }
        
        if (userName) {
            const fullName = this.tgUser.first_name || 'User';
            userName.textContent = this.truncateName(fullName, 20);
        }
        
        if (telegramId) {
            telegramId.innerHTML = `
                <span>ID: ${this.tgUser.id || '123456789'}</span>
            `;
        }
        
        if (tonBalance) {
            const balance = this.safeNumber(this.userState.balance);
            tonBalance.textContent = `${balance.toFixed(5)} TON`;
            tonBalance.style.display = 'block';
        }
    }

    renderUI() {
        this.updateHeader();
        this.renderTasksPage();
        this.renderDicePage();
        this.renderQuestsPage();
        this.renderReferralsPage();
        this.renderWithdrawPage();
        this.setupNavigation();
        
        document.body.addEventListener('copy', (e) => {
            e.preventDefault();
            return false;
        });
        
        document.body.addEventListener('contextmenu', (e) => {
            if (e.target.tagName === 'IMG') {
                e.preventDefault();
                return false;
            }
        });
    }

    setupNavigation() {
        const bottomNav = document.querySelector('.bottom-nav');
        if (!bottomNav) return;
        
        const navButtons = bottomNav.querySelectorAll('.nav-btn');
        navButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const pageId = btn.getAttribute('data-page');
                if (pageId) {
                    this.showPage(pageId);
                }
            });
        });
    }

    showPage(pageId) {
        const pages = document.querySelectorAll('.page');
        const navButtons = document.querySelectorAll('.nav-btn');
        
        pages.forEach(page => page.classList.remove('active'));
        navButtons.forEach(btn => btn.classList.remove('active'));
        
        const targetPage = document.getElementById(pageId);
        const targetButton = document.querySelector(`[data-page="${pageId}"]`);
        
        if (targetPage) {
            targetPage.classList.add('active');
            
            if (targetButton) targetButton.classList.add('active');
            
            if (pageId === 'tasks-page') {
                this.renderTasksPage();
            } else if (pageId === 'dice-page') {
                this.renderDicePage();
            } else if (pageId === 'quests-page') {
                this.renderQuestsPage();
            } else if (pageId === 'referrals-page') {
                this.renderReferralsPage();
            } else if (pageId === 'withdraw-page') {
                this.renderWithdrawPage();
            }
        }
    }

    renderTasksPage() {
        const tasksPage = document.getElementById('tasks-page');
        if (!tasksPage) return;
        
        tasksPage.innerHTML = `
            <div id="tasks-content">
                <div class="promo-card-section">
                    <div class="promo-card">
                        <div class="promo-header">
                            <div class="promo-header-icon">
                                <i class="fas fa-gift"></i>
                            </div>
                            <h3>Promo Codes</h3>
                        </div>
                        <div class="promo-body">
                            <input type="text" id="promo-input" class="promo-input" 
                                   placeholder="Enter promo code" 
                                   maxlength="20">
                        </div>
                        <div class="promo-footer">
                            <button id="promo-btn" class="promo-btn">
                                <i class="fas fa-gift"></i> APPLY
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        setTimeout(() => {
            this.renderTasksContent();
        }, 100);
    }

    async renderTasksContent() {
        const tasksContent = document.getElementById('tasks-content');
        if (!tasksContent) return;
        
        try {
            await this.loadTasksData();
            
            let partnerTasksHTML = '';
            let socialTasksHTML = '';
            
            if (this.taskManager) {
                const partnerTasks = this.taskManager.getPartnerTasks();
                const socialTasks = this.taskManager.getSocialTasks();
                
                if (partnerTasks.length > 0) {
                    partnerTasksHTML = this.renderTasksSection('Partner Tasks', partnerTasks, 'fa-handshake');
                }
                
                if (socialTasks.length > 0) {
                    socialTasksHTML = this.renderTasksSection('Social Tasks', socialTasks, 'fa-users');
                } else {
                    socialTasksHTML = `
                        <div class="tasks-section">
                            <div class="section-header">
                                <div class="section-icon">
                                    <i class="fas fa-users"></i>
                                </div>
                                <h3>Social Tasks</h3>
                            </div>
                            <div class="no-tasks-message">
                                <p>No tasks available now</p>
                            </div>
                        </div>
                    `;
                }
            }
            
            tasksContent.innerHTML += `
                ${partnerTasksHTML}
                ${socialTasksHTML}
            `;
            
            this.setupPromoCodeEvents();
            this.setupTasksPageEvents();
            
        } catch (error) {
            tasksContent.innerHTML += `
                <div class="no-data">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Error loading tasks</p>
                </div>
            `;
        }
    }

    renderTasksSection(title, tasks, iconClass = 'fa-tasks') {
        if (tasks.length === 0) return '';
        
        const tasksHTML = tasks.map(task => this.renderTaskCard(task)).join('');
        
        return `
            <div class="tasks-section">
                <div class="section-header">
                    <div class="section-icon">
                        <i class="fas ${iconClass}"></i>
                    </div>
                    <h3>${title}</h3>
                </div>
                <div class="tasks-list">
                    ${tasksHTML}
                </div>
            </div>
        `;
    }

    renderTaskCard(task) {
        const isCompleted = this.userCompletedTasks.has(task.id);
        
        let buttonText = 'Start';
        let buttonClass = 'start';
        let isDisabled = isCompleted;
        
        if (isCompleted) {
            buttonText = 'COMPLETED';
            buttonClass = 'completed';
            isDisabled = true;
        }
        
        const botIcon = 'https://i.ibb.co/GvWFRrnp/ninja.png';
        
        return `
            <div class="task-card-simple ${isCompleted ? 'task-completed' : ''}" id="task-${task.id}">
                <div class="task-avatar-container">
                    <img src="${botIcon}" alt="Bot" class="task-bot-icon">
                </div>
                <div class="task-info">
                    <h4 class="task-name" style="font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${task.name}</h4>
                    <div class="task-reward-simple">
                        <img src="https://cdn-icons-png.flaticon.com/512/15208/15208522.png" alt="TON" class="ton-icon-small">
                        <span>${task.reward?.toFixed(4) || '0.0000'} TON</span>
                        <span class="game-bonus-blue">+${this.appConfig.TASK_GAME_BONUS} GAME</span>
                    </div>
                </div>
                <div class="task-action-simple">
                    <button class="task-btn ${buttonClass}" 
                            data-task-id="${task.id}"
                            data-task-url="${task.url}"
                            data-task-type="${task.type}"
                            data-task-reward="${task.reward}"
                            ${isDisabled || this.isProcessingTask ? 'disabled' : ''}>
                        ${buttonText}
                    </button>
                </div>
            </div>
        `;
    }

    setupPromoCodeEvents() {
        const promoBtn = document.getElementById('promo-btn');
        const promoInput = document.getElementById('promo-input');
        
        if (promoBtn) {
            promoBtn.addEventListener('click', () => {
                this.handlePromoCode();
            });
        }
        
        if (promoInput) {
            promoInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.handlePromoCode();
                }
            });
        }
    }

    async handlePromoCode() {
        const promoInput = document.getElementById('promo-input');
        const promoBtn = document.getElementById('promo-btn');
        
        if (!promoInput || !promoBtn) return;
        
        const code = promoInput.value.trim().toUpperCase();
        if (!code) {
            this.notificationManager.showNotification("Promo Code", "Please enter a promo code", "warning");
            return;
        }
        
        const originalText = promoBtn.innerHTML;
        promoBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
        promoBtn.disabled = true;
        
        try {
            let promoData = null;
            if (this.databases) {
                const promoCodes = await this.databases.listDocuments('ninja', 'promo_codes', [`code=${code}`]);
                if (promoCodes.total > 0) {
                    promoData = promoCodes.documents[0];
                }
            }
            
            if (!promoData) {
                this.notificationManager.showNotification("Promo Code", "Invalid promo code", "error");
                promoBtn.innerHTML = originalText;
                promoBtn.disabled = false;
                return;
            }
            
            if (this.databases) {
                const usedPromos = await this.databases.listDocuments(
                    'ninja',
                    'used_promo_codes',
                    [`user_id=${this.tgUser.id}`, `promo_id=${promoData.$id}`]
                );
                
                if (usedPromos.total > 0) {
                    this.notificationManager.showNotification("Promo Code", "You have already used this code", "error");
                    promoBtn.innerHTML = originalText;
                    promoBtn.disabled = false;
                    return;
                }
            }
            
            let adShown = false;
            if (window.AdBlock19344 && typeof window.AdBlock19344.show === 'function') {
                adShown = await new Promise((resolve) => {
                    window.AdBlock19344.show().then(() => {
                        resolve(true);
                    }).catch(() => {
                        resolve(false);
                    });
                });
            }
            
            if (!adShown) {
                this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim promo", "info");
                promoBtn.innerHTML = originalText;
                promoBtn.disabled = false;
                return;
            }
            
            const reward = this.safeNumber(promoData.reward || 0.01);
            const currentBalance = this.safeNumber(this.userState.balance);
            const newBalance = currentBalance + reward;
            
            if (this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            balance: newBalance,
                            total_earned: this.safeNumber(this.userState.total_earned) + reward
                        }
                    );
                    
                    await this.databases.createDocument(
                        'ninja',
                        'used_promo_codes',
                        'unique()',
                        {
                            user_id: this.tgUser.id.toString(),
                            promo_id: promoData.$id,
                            code: code,
                            reward: reward,
                            claimed_at: new Date().toISOString()
                        }
                    );
                    
                    await this.databases.updateDocument(
                        'ninja',
                        'promo_codes',
                        promoData.$id,
                        {
                            used_count: (promoData.used_count || 0) + 1
                        }
                    );
                }
            }
            
            this.userState.balance = newBalance;
            this.userState.total_earned = this.safeNumber(this.userState.total_earned) + reward;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            promoInput.value = '';
            
            this.notificationManager.showNotification("Success", `Promo code applied! +${reward.toFixed(3)} TON`, "success");
            
        } catch (error) {
            this.notificationManager.showNotification("Error", "Failed to apply promo code", "error");
        } finally {
            promoBtn.innerHTML = originalText;
            promoBtn.disabled = false;
        }
    }

    setupTasksPageEvents() {
        const startButtons = document.querySelectorAll('.task-btn.start:not(:disabled)');
        startButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (this.isProcessingTask) return;
                
                const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'task_start');
                if (!rateLimitCheck.allowed) {
                    this.notificationManager.showNotification(
                        "Rate Limit", 
                        `Please wait ${rateLimitCheck.remaining} seconds before starting another task`, 
                        "warning"
                    );
                    return;
                }
                
                const taskId = btn.getAttribute('data-task-id');
                const taskUrl = btn.getAttribute('data-task-url');
                const taskType = btn.getAttribute('data-task-type');
                const taskReward = parseFloat(btn.getAttribute('data-task-reward')) || 0;
                
                if (taskId && taskUrl) {
                    e.preventDefault();
                    await this.taskManager.handleTask(taskId, taskUrl, taskType, taskReward, btn);
                }
            });
        });
    }

    renderDicePage() {
        const dicePage = document.getElementById('dice-page');
        if (!dicePage) return;
        
        const userDicePlays = this.userState.dice_plays || 0;
        const currentTime = Date.now();
        const timeSinceLastAd = currentTime - this.lastAdWatchTime;
        const isAdButtonCooldown = timeSinceLastAd < this.adCooldown;
        const remainingCooldown = Math.max(0, this.adCooldown - timeSinceLastAd);
        const remainingMinutes = Math.ceil(remainingCooldown / 60000);
        
        dicePage.innerHTML = `
            <div class="dice-container">
                <div class="dice-game-section">
                    <div class="dice-container-wrapper" id="dice-container">
                        <div class="dice dice-1" id="dice-1">
                            <div class="dice-face">?</div>
                        </div>
                        <div class="dice dice-2" id="dice-2">
                            <div class="dice-face">?</div>
                        </div>
                        <div class="dice dice-3" id="dice-3">
                            <div class="dice-face">?</div>
                        </div>
                    </div>
                    
                    <button class="dice-play-btn ${userDicePlays > 0 ? '' : 'disabled'}" 
                            id="play-dice-btn" 
                            ${userDicePlays <= 0 ? 'disabled' : ''}>
                        <i class="fas fa-play"></i>
                        PLAY DICE
                    </button>
                    
                    <div class="available-games-info">
                        <i class="fas fa-dice"></i>
                        <span>Available Games: <strong>${userDicePlays}</strong></span>
                    </div>
                </div>
                
                <div class="get-games-section">
                    <h3><i class="fas fa-plus-circle"></i> GET MORE GAMES</h3>
                    
                    <div class="get-method-card">
                        <div class="get-method-header">
                            <div class="get-method-icon">
                                <i class="fas fa-eye"></i>
                            </div>
                            <div class="get-method-title">WATCH ADS</div>
                        </div>
                        <div class="get-method-description">
                            Watch Ad every 5 minutes and earn +1 Dice Game
                            ${isAdButtonCooldown ? `<div class="cooldown-timer">Available in: ${remainingMinutes}m</div>` : ''}
                        </div>
                        <button class="get-method-btn" id="watch-ad-btn"
                                ${isAdButtonCooldown ? 'disabled' : ''}>
                            ${isAdButtonCooldown ? 'COOLDOWN' : 'WATCH (+1)'}
                        </button>
                    </div>
                    
                    <div class="get-method-card">
                        <div class="get-method-header">
                            <div class="get-method-icon">
                                <i class="fas fa-tasks"></i>
                            </div>
                            <div class="get-method-title">COMPLETE TASKS</div>
                        </div>
                        <div class="get-method-description">
                            Complete tasks and earn TON + ${this.appConfig.TASK_GAME_BONUS} Games each
                        </div>
                        <button class="get-method-btn" id="go-tasks-btn">
                            GO
                        </button>
                    </div>
                    
                    <div class="get-method-card">
                        <div class="get-method-header">
                            <div class="get-method-icon">
                                <i class="fas fa-user-plus"></i>
                            </div>
                            <div class="get-method-title">INVITE FRIENDS</div>
                        </div>
                        <div class="get-method-description">
                            Invite friends and earn ${this.appConfig.REFERRAL_BONUS_TON} TON + ${this.appConfig.REFERRAL_BONUS_GAMES} Game each
                        </div>
                        <button class="get-method-btn" id="go-referrals-btn">
                            GO
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        this.setupDiceEvents();
        this.setupGetGamesEvents();
    }

    setupDiceEvents() {
        const diceBtn = document.getElementById('play-dice-btn');
        if (diceBtn) {
            diceBtn.addEventListener('click', () => {
                this.playDice();
            });
        }
    }

    setupGetGamesEvents() {
        const watchAdBtn = document.getElementById('watch-ad-btn');
        const gotoTasksBtn = document.getElementById('go-tasks-btn');
        const goReferralsBtn = document.getElementById('go-referrals-btn');
        
        if (watchAdBtn) {
            watchAdBtn.addEventListener('click', () => {
                this.watchAdForDicePlay();
            });
        }
        
        if (gotoTasksBtn) {
            gotoTasksBtn.addEventListener('click', () => {
                this.showPage('tasks-page');
            });
        }
        
        if (goReferralsBtn) {
            goReferralsBtn.addEventListener('click', () => {
                this.showPage('referrals-page');
            });
        }
    }

    async watchAdForDicePlay() {
        const currentTime = Date.now();
        const timeSinceLastAd = currentTime - this.lastAdWatchTime;
        
        if (timeSinceLastAd < this.adCooldown) {
            const remainingCooldown = this.adCooldown - timeSinceLastAd;
            const remainingMinutes = Math.ceil(remainingCooldown / 60000);
            this.notificationManager.showNotification("Cooldown", `Please wait ${remainingMinutes} minute(s) before watching another ad`, "info");
            return;
        }
        
        if (!this.adManager) {
            this.notificationManager.showNotification("Error", "Ad system not available", "error");
            return;
        }
        
        const watchAdBtn = document.getElementById('watch-ad-btn');
        if (watchAdBtn) {
            watchAdBtn.disabled = true;
            watchAdBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        }
        
        try {
            let adShown = false;
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                adShown = await new Promise((resolve) => {
                    window.AdBlock19345.show().then(() => {
                        resolve(true);
                    }).catch(() => {
                        resolve(false);
                    });
                });
            }
            
            if (adShown) {
                this.lastAdWatchTime = Date.now();
                
                const newPlays = (this.userState.dice_plays || 0) + 1;
                this.userState.dice_plays = newPlays;
                
                if (this.databases) {
                    const userDoc = await this.getCurrentUserDocument();
                    if (userDoc) {
                        await this.databases.updateDocument(
                            'ninja',
                            'users',
                            userDoc.$id,
                            {
                                dice_plays: newPlays
                            }
                        );
                    }
                }
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.renderDicePage();
                
                this.notificationManager.showNotification("Success", "+1 Game! Ad watched successfully", "success");
                
                this.startAdButtonCooldown();
                
            } else {
                this.notificationManager.showNotification("Error", "Failed to show ad", "error");
            }
            
        } catch (error) {
            this.notificationManager.showNotification("Error", "Failed to watch ad", "error");
        } finally {
            if (watchAdBtn && !this.isAdButtonCooldown) {
                watchAdBtn.disabled = false;
                watchAdBtn.innerHTML = 'WATCH (+1)';
            }
        }
    }

    startAdButtonCooldown() {
        if (this.adButtonCooldownTimer) {
            clearInterval(this.adButtonCooldownTimer);
        }
        
        const watchAdBtn = document.getElementById('watch-ad-btn');
        if (!watchAdBtn) return;
        
        watchAdBtn.disabled = true;
        
        let remainingTime = this.adCooldown;
        
        this.adButtonCooldownTimer = setInterval(() => {
            remainingTime -= 1000;
            
            if (remainingTime <= 0) {
                clearInterval(this.adButtonCooldownTimer);
                watchAdBtn.disabled = false;
                watchAdBtn.innerHTML = 'WATCH (+1)';
                
                const cooldownTimer = document.querySelector('.cooldown-timer');
                if (cooldownTimer) cooldownTimer.remove();
                
                return;
            }
            
            const remainingMinutes = Math.ceil(remainingTime / 60000);
            
            watchAdBtn.innerHTML = `COOLDOWN (${remainingMinutes}m)`;
            
            let cooldownTimer = document.querySelector('.cooldown-timer');
            if (!cooldownTimer) {
                cooldownTimer = document.createElement('div');
                cooldownTimer.className = 'cooldown-timer';
                const description = document.querySelector('.get-method-description');
                if (description) description.appendChild(cooldownTimer);
            }
            cooldownTimer.textContent = `Available in: ${remainingMinutes}m`;
            
        }, 1000);
    }

    
    async playDice() {
        if (this.userState.dice_plays <= 0) {
            this.notificationManager.showNotification("No Games", "You don't have any games left", "info");
            return;
        }
        
        const dice1 = document.getElementById('dice-1');
        const dice2 = document.getElementById('dice-2');
        const dice3 = document.getElementById('dice-3');
        const playBtn = document.getElementById('play-dice-btn');
        
        if (!dice1 || !dice2 || !dice3 || !playBtn) return;
        
        playBtn.disabled = true;
        playBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
        
        const newPlays = this.userState.dice_plays - 1;
        
        if (this.databases) {
            const userDoc = await this.getCurrentUserDocument();
            if (userDoc) {
                await this.databases.updateDocument(
                    'ninja',
                    'users',
                    userDoc.$id,
                    {
                        dice_plays: newPlays
                    }
                );
            }
        }
        
        this.userState.dice_plays = newPlays;
        this.cache.delete(`user_${this.tgUser.id}`);
        this.updateHeader();
        
        dice1.querySelector('.dice-face').textContent = '?';
        dice2.querySelector('.dice-face').textContent = '?';
        dice3.querySelector('.dice-face').textContent = '?';
        
        const diceResults = [];
        for (let i = 0; i < 3; i++) {
            diceResults.push(Math.floor(Math.random() * 6) + 1);
        }
        
        const rollDiceSequentially = async () => {
            dice1.classList.add('rolling');
            await this.delay(800);
            dice1.classList.remove('rolling');
            dice1.classList.add('stopping');
            dice1.querySelector('.dice-face').textContent = diceResults[0];
            await this.delay(500);
            dice1.classList.remove('stopping');
            
            dice2.classList.add('rolling');
            await this.delay(800);
            dice2.classList.remove('rolling');
            dice2.classList.add('stopping');
            dice2.querySelector('.dice-face').textContent = diceResults[1];
            await this.delay(500);
            dice2.classList.remove('stopping');
            
            dice3.classList.add('rolling');
            await this.delay(800);
            dice3.classList.remove('rolling');
            dice3.classList.add('stopping');
            dice3.querySelector('.dice-face').textContent = diceResults[2];
            await this.delay(500);
            dice3.classList.remove('stopping');
        };
        
        await rollDiceSequentially();
        
        const result = (diceResults[0] + diceResults[1]) * diceResults[2];
        const prizeInTON = (result / 100000).toFixed(8);
        
        playBtn.disabled = false;
        playBtn.innerHTML = '<i class="fas fa-play"></i> PLAY DICE';
        
        await this.updateDicePoints(result);
        
        const gamesInfo = document.querySelector('.available-games-info');
        if (gamesInfo) {
            gamesInfo.innerHTML = `
                <i class="fas fa-dice"></i>
                <span>Available Games: <strong>${newPlays}</strong></span>
            `;
        }
        
        setTimeout(() => {
            this.showDicePrizeModal(diceResults, result, prizeInTON);
        }, 1000);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    showDicePrizeModal(diceResults, result, prizeInTON) {
        const modal = document.createElement('div');
        modal.className = 'dice-result-modal';
        modal.innerHTML = `
            <div class="dice-result-content">
                <button class="close-modal-btn" id="close-dice-modal">
                    <i class="fas fa-times"></i>
                </button>
                
                <div class="dice-result-header">
                    <i class="fas fa-trophy"></i>
                    <h3>Dice Game Result!</h3>
                </div>
                
                <div class="dice-result-display">
                    <div class="dice-final-results">
                        <div class="final-dice">${diceResults[0]}</div>
                        <div class="final-dice">${diceResults[1]}</div>
                        <div class="final-dice">${diceResults[2]}</div>
                    </div>
                    
                    <div class="dice-equation">
                        ${diceResults[0]} + ${diceResults[1]} × ${diceResults[2]} = ${result}
                    </div>
                    
                    <div class="dice-prize-amount">${prizeInTON} TON</div>
                </div>
                
                <div class="dice-result-actions">
                    <button class="dice-result-claim" id="claim-dice-prize">
                        <i class="fas fa-gift"></i> CLAIM PRIZE
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const closeBtn = document.getElementById('close-dice-modal');
        closeBtn.addEventListener('click', () => {
            modal.remove();
            this.notificationManager.showNotification("Cancelled", "Prize not claimed", "info");
        });
        
        const claimBtn = document.getElementById('claim-dice-prize');
        claimBtn.addEventListener('click', async () => {
            claimBtn.disabled = true;
            claimBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            
            try {
                let adShown = false;
                if (window.AdBlock19344 && typeof window.AdBlock19344.show === 'function') {
                    adShown = await new Promise((resolve) => {
                        window.AdBlock19344.show().then(() => {
                            resolve(true);
                        }).catch(() => {
                            resolve(false);
                        });
                    });
                }
                
                if (!adShown) {
                    this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim your prize", "info");
                    claimBtn.disabled = false;
                    claimBtn.innerHTML = '<i class="fas fa-gift"></i> CLAIM PRIZE';
                    return;
                }
                
                const prizeAmount = parseFloat(prizeInTON);
                const currentBalance = this.safeNumber(this.userState.balance);
                const newBalance = currentBalance + prizeAmount;
                
                if (this.databases) {
                    const userDoc = await this.getCurrentUserDocument();
                    if (userDoc) {
                        await this.databases.updateDocument(
                            'ninja',
                            'users',
                            userDoc.$id,
                            {
                                balance: newBalance,
                                total_earned: this.safeNumber(this.userState.total_earned) + prizeAmount
                            }
                        );
                    }
                }
                
            this.userState.balance = newBalance;
            this.userState.total_earned = this.safeNumber(this.userState.total_earned) + prizeAmount;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            this.renderDicePage();
            
            modal.remove();
            this.notificationManager.showNotification("Prize Claimed", `+${prizeInTON} TON added to your balance!`, "success");
            
        } catch (error) {
            this.notificationManager.showNotification("Error", "Failed to claim prize", "error");
            claimBtn.disabled = false;
            claimBtn.innerHTML = '<i class="fas fa-gift"></i> CLAIM PRIZE';
        }
        });
        
        setTimeout(() => {
            if (modal.parentNode) {
                modal.remove();
                this.notificationManager.showNotification("Time Expired", "Prize claim window closed", "info");
            }
        }, 30000);
    }

    renderQuestsPage() {
        const questsPage = document.getElementById('quests-page');
        if (!questsPage) return;
        
        const referralQuests = this.questsState.referralQuests || [];
        const tasksQuests = this.questsState.tasksQuests || [];
        
        const currentReferralQuest = referralQuests.find(q => !q.claimed) || null;
        const currentTasksQuest = tasksQuests.find(q => !q.claimed) || null;
        const currentDiceQuest = this.diceQuests.find(q => !q.claimed) || null;
        
        let questsHTML = '';
        
        if (currentReferralQuest) {
            const userReferrals = this.questsState.userReferrals || 0;
            const progressPercent = Math.min((userReferrals / currentReferralQuest.target) * 100, 100);
            
            questsHTML += `
                <div class="quest-card ${currentReferralQuest.completed ? 'active' : ''}">
                    <div class="quest-card-header">
                        <div class="quest-type-badge">
                            <i class="fas fa-user-plus"></i>
                            Friends
                        </div>
                        <div class="quest-status ${currentReferralQuest.completed ? 'completed' : 'progress'}">
                            ${currentReferralQuest.completed ? 'Ready to Claim' : 'In Progress'}
                        </div>
                    </div>
                    
                    <div class="quest-card-body">
                        <h4 class="quest-title">Invite ${currentReferralQuest.target} Users</h4>
                        
                        <div class="quest-progress-container">
                            <div class="quest-progress-info">
                                <span>${userReferrals}/${currentReferralQuest.target}</span>
                                <span>${progressPercent.toFixed(0)}%</span>
                            </div>
                            <div class="quest-progress-bar">
                                <div class="quest-progress-fill" style="width: ${progressPercent}%"></div>
                            </div>
                        </div>
                        
                        <div class="quest-reward-display">
                            <div class="reward-icon">
                                <img src="https://cdn-icons-png.flaticon.com/512/15208/15208522.png" alt="TON" class="ton-reward-icon">
                            </div>
                            <div class="reward-amount">
                                <span class="reward-value">${currentReferralQuest.reward.toFixed(2)}</span>
                                <span class="reward-currency">TON</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="quest-card-footer">
                        <button class="quest-claim-btn ${currentReferralQuest.completed ? 'available' : 'disabled'}" 
                                data-quest-type="referral"
                                data-quest-target="${currentReferralQuest.target}"
                                data-quest-reward="${currentReferralQuest.reward}"
                                ${!currentReferralQuest.completed ? 'disabled' : ''}>
                            ${currentReferralQuest.completed ? 
                                '<i class="fas fa-gift"></i> Claim Reward' : 
                                '<i class="fas fa-spinner"></i> In Progress'}
                        </button>
                    </div>
                </div>
            `;
        }
        
        if (currentTasksQuest) {
            const totalTasks = this.safeNumber(this.userState.total_tasks || 0);
            const progressPercent = Math.min((totalTasks / currentTasksQuest.target) * 100, 100);
            
            questsHTML += `
                <div class="quest-card ${currentTasksQuest.completed ? 'active' : ''}">
                    <div class="quest-card-header">
                        <div class="quest-type-badge">
                            <i class="fas fa-tasks"></i>
                            Tasks
                        </div>
                        <div class="quest-status ${currentTasksQuest.completed ? 'completed' : 'progress'}">
                            ${currentTasksQuest.completed ? 'Ready to Claim' : 'In Progress'}
                        </div>
                    </div>
                    
                    <div class="quest-card-body">
                        <h4 class="quest-title">Complete ${currentTasksQuest.target} Tasks</h4>
                        
                        <div class="quest-progress-container">
                            <div class="quest-progress-info">
                                <span>${totalTasks}/${currentTasksQuest.target}</span>
                                <span>${progressPercent.toFixed(0)}%</span>
                            </div>
                            <div class="quest-progress-bar">
                                <div class="quest-progress-fill" style="width: ${progressPercent}%"></div>
                            </div>
                        </div>
                        
                        <div class="quest-reward-display">
                            <div class="reward-icon">
                                <img src="https://cdn-icons-png.flaticon.com/512/15208/15208522.png" alt="TON" class="ton-reward-icon">
                            </div>
                            <div class="reward-amount">
                                <span class="reward-value">${currentTasksQuest.reward.toFixed(2)}</span>
                                <span class="reward-currency">TON</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="quest-card-footer">
                        <button class="quest-claim-btn ${currentTasksQuest.completed ? 'available' : 'disabled'}" 
                                data-quest-type="tasks"
                                data-quest-index="${this.tasksQuests.indexOf(currentTasksQuest)}"
                                data-quest-target="${currentTasksQuest.target}"
                                data-quest-reward="${currentTasksQuest.reward}"
                                ${!currentTasksQuest.completed ? 'disabled' : ''}>
                            ${currentTasksQuest.completed ? 
                                '<i class="fas fa-gift"></i> Claim Reward' : 
                                '<i class="fas fa-spinner"></i> In Progress'}
                        </button>
                    </div>
                </div>
            `;
        }
        
        if (currentDiceQuest) {
            const progressPercent = Math.min((this.diceTotalPoints / currentDiceQuest.target) * 100, 100);
            
            questsHTML += `
                <div class="quest-card ${currentDiceQuest.completed ? 'active' : ''}">
                    <div class="quest-card-header">
                        <div class="quest-type-badge">
                            <i class="fas fa-dice"></i>
                            Dice
                        </div>
                        <div class="quest-status ${currentDiceQuest.completed ? 'completed' : 'progress'}">
                            ${currentDiceQuest.completed ? 'Ready to Claim' : 'In Progress'}
                        </div>
                    </div>
                    
                    <div class="quest-card-body">
                        <h4 class="quest-title">Earn ${currentDiceQuest.target.toLocaleString()} Points</h4>
                        
                        <div class="quest-progress-container">
                            <div class="quest-progress-info">
                                <span>${this.diceTotalPoints.toLocaleString()}/${currentDiceQuest.target.toLocaleString()}</span>
                                <span>${progressPercent.toFixed(0)}%</span>
                            </div>
                            <div class="quest-progress-bar">
                                <div class="quest-progress-fill" style="width: ${progressPercent}%"></div>
                            </div>
                        </div>
                        
                        <div class="quest-reward-display">
                            <div class="reward-icon">
                                <img src="https://cdn-icons-png.flaticon.com/512/15208/15208522.png" alt="TON" class="ton-reward-icon">
                            </div>
                            <div class="reward-amount">
                                <span class="reward-value">${currentDiceQuest.reward.toFixed(2)}</span>
                                <span class="reward-currency">TON</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="quest-card-footer">
                        <button class="quest-claim-btn ${currentDiceQuest.completed ? 'available' : 'disabled'}" 
                                data-quest-type="dice"
                                data-quest-index="${this.diceQuests.indexOf(currentDiceQuest)}"
                                data-quest-target="${currentDiceQuest.target}"
                                data-quest-reward="${currentDiceQuest.reward}"
                                ${!currentDiceQuest.completed ? 'disabled' : ''}>
                            ${currentDiceQuest.completed ? 
                                '<i class="fas fa-gift"></i> Claim Reward' : 
                                '<i class="fas fa-spinner"></i> In Progress'}
                        </button>
                    </div>
                </div>
            `;
        }
        
        if (!questsHTML) {
            questsHTML = `
                <div class="no-data">
                    <i class="fas fa-trophy"></i>
                    <h3>All Quests Completed!</h3>
                    <p>You have completed all available quests.</p>
                </div>
            `;
        }
        
        questsPage.innerHTML = `
            <div class="quests-container">
                ${questsHTML}
            </div>
        `;
        
        this.setupQuestsPageEvents();
    }

    setupQuestsPageEvents() {
        const claimBtns = document.querySelectorAll('.quest-claim-btn.available:not(:disabled)');
        claimBtns.forEach(btn => {
            btn.addEventListener('click', async () => {
                const questType = btn.getAttribute('data-quest-type');
                
                if (questType === 'referral') {
                    const target = parseInt(btn.getAttribute('data-quest-target'));
                    const reward = parseFloat(btn.getAttribute('data-quest-reward'));
                    await this.handleReferralQuest(target, reward, btn);
                } else if (questType === 'tasks') {
                    const questIndex = parseInt(btn.getAttribute('data-quest-index'));
                    await this.claimTasksQuest(questIndex);
                } else if (questType === 'dice') {
                    const questIndex = parseInt(btn.getAttribute('data-quest-index'));
                    await this.claimDiceQuest(questIndex);
                }
            });
        });
    }

    async handleReferralQuest(target, reward, button) {
        try {
            const originalText = button.innerHTML;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            button.disabled = true;
            
            let adShown = false;
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                adShown = await new Promise((resolve) => {
                    window.AdBlock19345.show().then(() => {
                        resolve(true);
                    }).catch(() => {
                        resolve(false);
                    });
                });
            }
            
            if (!adShown) {
                this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim reward", "info");
                button.innerHTML = originalText;
                button.disabled = false;
                return;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const questIndex = this.questsState.referralQuests.findIndex(q => q.target === target);
            if (questIndex !== -1) {
                this.questsState.referralQuests[questIndex].claimed = true;
                
                const currentBalance = this.safeNumber(this.userState.balance);
                this.userState.balance = currentBalance + reward;
                this.userState.total_earned = this.safeNumber(this.userState.total_earned) + reward;
                
                if (this.databases) {
                    const userDoc = await this.getCurrentUserDocument();
                    if (userDoc) {
                        await this.databases.updateDocument(
                            'ninja',
                            'users',
                            userDoc.$id,
                            {
                                balance: currentBalance + reward,
                                total_earned: this.safeNumber(this.userState.total_earned) + reward,
                                referral_quests: this.questsState.referralQuests
                            }
                        );
                    }
                }
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.renderQuestsPage();
                
                this.notificationManager.showNotification("Quest Completed", `+${reward.toFixed(2)} TON!`, "success");
            }
            
        } catch (error) {
            this.notificationManager.showNotification("Error", "Failed to claim reward", "error");
            if (button) {
                button.innerHTML = originalText;
                button.disabled = false;
            }
        }
    }

    async renderReferralsPage() {
        this.loadRecentReferrals().then(async (referrals) => {
            try {
                if (this.referralManager) {
                    await this.referralManager.loadRecentReferrals();
                    this.referralManager.renderReferralsPage();
                } else {
                    const referralsPage = document.getElementById('referrals-page');
                    if (referralsPage) {
                        referralsPage.innerHTML = `
                            <div class="no-data">
                                <i class="fas fa-exclamation-triangle"></i>
                                <h3>Error Loading Referrals</h3>
                                <p>Please try again later</p>
                            </div>
                        `;
                    }
                }
            } catch (error) {
                const referralsPage = document.getElementById('referrals-page');
                if (referralsPage) {
                    referralsPage.innerHTML = `
                        <div class="no-data">
                            <i class="fas fa-exclamation-triangle"></i>
                            <h3>Error Loading Referrals</h3>
                            <p>Please try again later</p>
                        </div>
                    `;
                }
            }
        });
    }

    async loadRecentReferrals() {
        try {
            if (!this.databases) return [];
            
            const referrals = await this.databases.listDocuments(
                'ninja',
                'referrals',
                [`referrer_id=${this.tgUser.id}`]
            );
            
            return referrals.documents || [];
        } catch (error) {
            console.error('Error loading referrals:', error);
            return [];
        }
    }

    async refreshReferralsList() {
        try {
            if (!this.databases || !this.tgUser) return;
            
            const referrals = await this.databases.listDocuments(
                'ninja',
                'referrals',
                [`referrer_id=${this.tgUser.id}`, `status=verified`, `bonus_given=true`]
            );
            
            this.userState.referrals = referrals.total || 0;
            
            if (document.getElementById('referrals-page')?.classList.contains('active')) {
                this.renderReferralsPage();
            }
            
            console.log(`Referrals list refreshed: ${referrals.total} verified referrals`);
            
        } catch (error) {
            console.error('Error refreshing referrals list:', error);
        }
    }

    renderWithdrawPage() {
        const withdrawPage = document.getElementById('withdraw-page');
        if (!withdrawPage) return;
        
        const userBalance = this.safeNumber(this.userState.balance);
        const minimumWithdraw = this.appConfig.MINIMUM_WITHDRAW;
        
        withdrawPage.innerHTML = `
            <div class="withdraw-container">
                <div class="withdraw-form">
                    <div class="form-row">
                        <div class="form-group compact">
                            <label for="wallet-address-input">
                                <i class="fas fa-wallet"></i> Wallet
                            </label>
                            <input type="text" id="wallet-address-input" class="form-input compact-input" 
                                   placeholder="Ex: UQCMATcdykmpWDSLdI5ob..."
                                   required>
                        </div>
                        
                        <div class="form-group compact">
                            <label for="withdraw-amount-input">
                                <i class="fas fa-gem"></i> Amount
                            </label>
                            <input type="number" id="withdraw-amount-input" class="form-input compact-input" 
                                   step="0.00001" min="${minimumWithdraw}" max="${userBalance}"
                                   placeholder="Ex: ${minimumWithdraw}"
                                   required>
                        </div>
                    </div>
                    
                    <div class="balance-info-compact">
                        <div class="minimum-withdraw">
                            <i class="fas fa-exclamation-circle"></i>
                            Minimum Withdrawal: ${minimumWithdraw.toFixed(3)} TON
                        </div>
                        <div class="current-balance-small">
                            <i class="fas fa-wallet"></i>
                            Available: ${userBalance.toFixed(3)} TON
                        </div>
                    </div>
                    
                    <button id="withdraw-submit-btn" class="withdraw-btn-compact">
                        <i class="fas fa-paper-plane"></i> Confirm Withdrawal
                    </button>
                </div>
                
                <div class="history-section">
                    <h3><i class="fas fa-history"></i> Withdrawal History</h3>
                    <div id="withdrawal-history" class="history-list">
                        ${this.userWithdrawals.length > 0 ? 
                            this.renderWithdrawalHistory() : 
                            '<div class="no-data"><i class="fas fa-history"></i><p>No withdrawal history</p></div>'
                        }
                    </div>
                </div>
            </div>
        `;
        
        this.setupWithdrawPageEvents();
    }

    renderWithdrawalHistory() {
        return this.userWithdrawals.map(transaction => {
            const date = new Date(transaction.created_at);
            const day = date.getDate().toString().padStart(2, '0');
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const year = date.getFullYear();
            const formattedDate = `${day}-${month}-${year}`;
            const formattedTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            
            const amount = this.safeNumber(transaction.amount || 0);
            const status = transaction.status || 'pending';
            
            return `
                <div class="history-item">
                    <div class="history-info">
                        <div class="history-amount">${amount.toFixed(5)} TON</div>
                        <div class="history-details">
                            <div class="history-date">${formattedDate} ${formattedTime}</div>
                            <div class="history-wallet">${transaction.wallet?.substring(0, 12)}...${transaction.wallet?.substring(transaction.wallet.length - 6)}</div>
                        </div>
                    </div>
                    <span class="history-status status-${status}">${status}</span>
                </div>
            `;
        }).join('');
    }

    setupWithdrawPageEvents() {
        const walletInput = document.getElementById('wallet-address-input');
        const amountInput = document.getElementById('withdraw-amount-input');
        const withdrawBtn = document.getElementById('withdraw-submit-btn');
        
        if (amountInput) {
            amountInput.addEventListener('input', () => {
                const max = this.safeNumber(this.userState.balance);
                const value = parseFloat(amountInput.value) || 0;
                
                if (value > max) {
                    amountInput.value = max.toFixed(5);
                }
            });
        }
        
        if (withdrawBtn) {
            withdrawBtn.addEventListener('click', async () => {
                await this.handleWithdrawal();
            });
        }
    }

    async handleWithdrawal() {
        const walletInput = document.getElementById('wallet-address-input');
        const amountInput = document.getElementById('withdraw-amount-input');
        const withdrawBtn = document.getElementById('withdraw-submit-btn');
        
        if (!walletInput || !amountInput || !withdrawBtn) return;
        
        const walletAddress = walletInput.value.trim();
        const amount = parseFloat(amountInput.value);
        const userBalance = this.safeNumber(this.userState.balance);
        const minimumWithdraw = this.appConfig.MINIMUM_WITHDRAW;
        
        if (!walletAddress) {
            this.notificationManager.showNotification("Error", "Please enter wallet address", "error");
            return;
        }
        
        if (!amount || amount < minimumWithdraw) {
            this.notificationManager.showNotification("Error", `Minimum withdrawal is ${minimumWithdraw} TON`, "error");
            return;
        }
        
        if (amount > userBalance) {
            this.notificationManager.showNotification("Error", "Insufficient balance", "error");
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'withdrawal');
        if (!rateLimitCheck.allowed) {
            this.notificationManager.showNotification(
                "Rate Limit", 
                `Please wait ${Math.ceil(rateLimitCheck.remaining / 3600)} hours before making another withdrawal`, 
                "warning"
            );
            return;
        }
        
        const originalText = withdrawBtn.innerHTML;
        withdrawBtn.disabled = true;
        withdrawBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        
        try {
            if (this.adManager) {
                const adShown = await this.adManager.showWithdrawalAd();
                if (!adShown) {
                    this.notificationManager.showNotification("Ad Required", "Please watch the ad to process withdrawal", "info");
                    withdrawBtn.disabled = false;
                    withdrawBtn.innerHTML = originalText;
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            const newBalance = userBalance - amount;
            
            if (this.databases) {
                const userDoc = await this.getCurrentUserDocument();
                if (userDoc) {
                    await this.databases.updateDocument(
                        'ninja',
                        'users',
                        userDoc.$id,
                        {
                            balance: newBalance,
                            total_withdrawals: this.safeNumber(this.userState.total_withdrawals || 0) + 1
                        }
                    );
                    
                    await this.databases.createDocument(
                        'ninja',
                        'withdrawals',
                        'unique()',
                        {
                            user_id: this.tgUser.id.toString(),
                            wallet: walletAddress,
                            amount: amount,
                            status: 'pending',
                            created_at: new Date().toISOString()
                        }
                    );
                }
            }
            
            this.userState.balance = newBalance;
            this.userState.total_withdrawals = this.safeNumber(this.userState.total_withdrawals || 0) + 1;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            await this.updateAppStats('totalWithdrawals', 1);
            await this.updateAppStats('totalPayments', amount);
            
            await this.loadHistoryData();
            
            walletInput.value = '';
            amountInput.value = '';
            
            this.updateHeader();
            this.renderWithdrawPage();
            
            this.notificationManager.showNotification("Success", "Withdrawal request submitted!", "success");
            
        } catch (error) {
            this.notificationManager.showNotification("Error", "Failed to process withdrawal", "error");
        } finally {
            withdrawBtn.disabled = false;
            withdrawBtn.innerHTML = originalText;
        }
    }

    copyToClipboard(text) {
        if (!text || this.isCopying) return;
        
        this.isCopying = true;
        
        navigator.clipboard.writeText(text).then(() => {
            this.notificationManager.showNotification("Copied", "Text copied to clipboard", "success");
            setTimeout(() => {
                this.isCopying = false;
            }, 1000);
        }).catch(() => {
            this.notificationManager.showNotification("Error", "Failed to copy text", "error");
            setTimeout(() => {
                this.isCopying = false;
            }, 1000);
        });
    }

    setupEventListeners() {
        const telegramIdElement = document.getElementById('user-telegram-id');
        if (telegramIdElement) {
            telegramIdElement.addEventListener('click', () => {
                if (this.tgUser?.id) {
                    this.copyToClipboard(this.tgUser.id.toString());
                }
            });
        }
    }

    generateReferralCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 7; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `NINJA${code}`;
    }

    safeNumber(value) {
        if (value === null || value === undefined) return 0;
        const num = Number(value);
        return isNaN(num) ? 0 : num;
    }

    safeLocaleString(value) {
        const num = this.safeNumber(value);
        try {
            return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
        } catch (error) {
            return num.toString();
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getShortName(name) {
        if (!name) return 'User';
        return name;
    }

    truncateName(name, maxLength = 20) {
        if (!name) return 'User';
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength) + '...';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!window.Telegram || !window.Telegram.WebApp) {
        document.body.innerHTML = `
            <div class="error-container">
                <div class="error-content">
                    <div class="error-icon">
                        <i class="fab fa-telegram"></i>
                    </div>
                    <h2>Ninja TON</h2>
                    <p>Please open from Telegram Mini App</p>
                </div>
            </div>
        `;
        return;
    }
    
    window.app = new NinjaTONApp();
    
    setTimeout(() => {
        if (window.app && typeof window.app.initialize === 'function') {
            window.app.initialize();
        }
    }, 300);
});
