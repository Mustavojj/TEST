const APP_CONFIG = {
    APP_NAME: "Ninja TON",
    BOT_USERNAME: "NinjaTONS_Bot",
    MINIMUM_WITHDRAW: 0.100,
    REFERRAL_BONUS_TON: 0.005,
    REFERRAL_BONUS_SPINS: 1,
    TASK_SPIN_BONUS: 1,
    MAX_DAILY_ADS: 999999,
    AD_COOLDOWN: 300000
};

import { CacheManager, NotificationManager, SecurityManager, AdManager } from './modules/core.js';
import { TaskManager, SpinManager, ReferralManager } from './modules/features.js';

class NinjaTONApp {
    
    constructor() {
        this.darkMode = true;
        this.tg = null;
        this.db = null;
        this.auth = null;
        this.firebaseInitialized = false;
        this.configLoaded = false;
        
        this.currentUser = null;
        this.userState = {};
        this.appConfig = APP_CONFIG;
        
        this.userCompletedTasks = new Set();
        this.partnerTasks = [];
        this.isInitialized = false;
        this.isInitializing = false;
        this.userWithdrawals = [];
        this.appStats = {
            totalUsers: 0,
            onlineUsers: 0,
            totalPayments: 0,
            totalWithdrawals: 0
        };
        
        this.pages = [
            { id: 'tasks-page', name: 'Earn', icon: 'fa-coins', color: '#3b82f6' },
            { id: 'spin-page', name: 'Spin', icon: 'fa-sync-alt', color: '#3b82f6' },
            { id: 'referrals-page', name: 'Invite', icon: 'fa-users', color: '#3b82f6' },
            { id: 'withdraw-page', name: 'Withdraw', icon: 'fa-wallet', color: '#3b82f6' }
        ];
        
        this.cache = new CacheManager();
        this.notificationManager = null;
        this.securityManager = new SecurityManager();
        this.adManager = null;
        this.isProcessingTask = false;
        
        this.tgUser = null;
        
        this.taskManager = null;
        this.spinManager = null;
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
        
        this.spinPrizes = [
            "Game over",
            "1 Spin",
            "3 Spin",
            "5 Spin",
            "0.0001 💎",
            "0.0005 💎",
            "0.001 💎",
            "0.005 💎",
            "0.01 💎",
            "0.05 💎"
        ];
        
        this.spinQuests = [
            { spins: 10, reward: 0.01, completed: false, claimed: false },
            { spins: 50, reward: 0.02, completed: false, claimed: false },
            { spins: 100, reward: 0.05, completed: false, claimed: false },
            { spins: 200, reward: 0.10, completed: false, claimed: false },
            { spins: 500, reward: 0.20, completed: false, claimed: false }
        ];
        
        this.totalSpinsCompleted = 0;
        
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
                    'ad_reward': { limit: 10, window: 300000 },
                    'spin': { limit: 10, window: 60000 }
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
            
            const firebaseSuccess = await this.initializeFirebase();
            
            if (firebaseSuccess) {
                this.setupFirebaseAuth();
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
            this.spinManager = new SpinManager(this);
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
                await this.loadHistoryData();
            } catch (historyError) {
                console.warn('History load failed:', historyError);
            }
            
            this.showLoadingProgress(80);
            
            try {
                await this.loadAppStats();
            } catch (statsError) {
                console.warn('Stats load failed:', statsError);
            }
            
            this.showLoadingProgress(85);
            
            try {
                await this.loadDailyAdsWatched();
            } catch (spinError) {
                console.warn('Spin data load failed:', spinError);
            }
            
            this.showLoadingProgress(90);
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

    async initializeFirebase() {
        try {
            if (typeof firebase === 'undefined') {
                throw new Error('Firebase SDK not loaded');
            }
            
            const firebaseConfig = {
                apiKey: "AIzaSyA0APJwsUQd1kTg3y8J-9yVukiZzUBdRos",
                authDomain: "neja-go.firebaseapp.com",
                databaseURL: "https://neja-go-default-rtdb.europe-west1.firebasedatabase.app",
                projectId: "neja-go",
                storageBucket: "neja-go.firebasestorage.app",
                messagingSenderId: "60526443918",
                appId: "1:60526443918:web:fca257ab5c782e0f1178df",
                measurementId: "G-SJGF6HVQRE"
            };
            
            let firebaseApp;
            
            try {
                firebaseApp = firebase.initializeApp(firebaseConfig);
            } catch (error) {
                if (error.code === 'app/duplicate-app') {
                    firebaseApp = firebase.app();
                } else {
                    throw error;
                }
            }
            
            this.db = firebaseApp.database();
            this.auth = firebaseApp.auth();
            
            console.log('Firebase initialized, attempting anonymous authentication...');
            
            try {
                await this.auth.signInAnonymously();
                console.log('Anonymous authentication successful');
            } catch (authError) {
                console.error('Anonymous authentication failed:', authError);
                
                try {
                    const randomEmail = `user_${this.tgUser.id}_${Date.now()}@ninjaton.app`;
                    const randomPassword = Math.random().toString(36).slice(-10) + Date.now().toString(36);
                    
                    await this.auth.createUserWithEmailAndPassword(randomEmail, randomPassword);
                    console.log('Created new anonymous user');
                } catch (createError) {
                    console.error('Failed to create anonymous user:', createError);
                    throw new Error('Firebase authentication failed');
                }
            }
            
            await new Promise((resolve, reject) => {
                const unsubscribe = this.auth.onAuthStateChanged((user) => {
                    if (user) {
                        unsubscribe();
                        console.log('User authenticated:', user.uid);
                        this.currentUser = user;
                        resolve(user);
                    }
                });
                
                setTimeout(() => {
                    unsubscribe();
                    reject(new Error('Authentication timeout'));
                }, 10000);
            });
            
            this.firebaseInitialized = true;
            
            return true;
            
        } catch (error) {
            console.error('Firebase initialization failed:', error);
            
            this.notificationManager?.showNotification(
                "Authentication Error",
                "Failed to connect to database. Some features may not work.",
                "error"
            );
            
            return false;
        }
    }

    setupFirebaseAuth() {
        if (!this.auth) return;
        
        this.auth.onAuthStateChanged(async (user) => {
            if (user) {
                console.log('User authenticated:', user.uid);
                this.currentUser = user;
                
                if (this.userState.firebaseUid !== user.uid) {
                    this.userState.firebaseUid = user.uid;
                    await this.syncUserWithFirebase();
                }
            } else {
                console.log('User signed out, attempting to sign in anonymously...');
                try {
                    await this.auth.signInAnonymously();
                } catch (error) {
                    console.error('Failed to re-authenticate:', error);
                }
            }
        });
        
        this.auth.onIdTokenChanged((user) => {
            if (user) {
                console.log('Token refreshed for user:', user.uid);
            }
        });
    }

    async syncUserWithFirebase() {
        try {
            if (!this.db || !this.auth.currentUser) {
                console.warn('Cannot sync: Firebase not ready');
                return;
            }
            
            const firebaseUid = this.auth.currentUser.uid;
            const telegramId = this.tgUser.id;
            
            console.log('Syncing user:', { firebaseUid, telegramId });
            
            const userRef = this.db.ref(`users/${telegramId}`);
            const userSnapshot = await userRef.once('value');
            
            if (!userSnapshot.exists()) {
                const userData = {
                    ...this.getDefaultUserState(),
                    firebaseUid: firebaseUid,
                    telegramId: telegramId,
                    createdAt: Date.now(),
                    lastSynced: Date.now()
                };
                
                await userRef.set(userData);
                console.log('New user created in Firebase');
            } else {
                await userRef.update({
                    firebaseUid: firebaseUid,
                    lastSynced: Date.now()
                });
                console.log('User UID updated in Firebase');
            }
            
        } catch (error) {
            console.error('User sync failed:', error);
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
            if (!this.db || !this.firebaseInitialized || !this.auth?.currentUser) {
                console.warn('Firebase auth not ready, using default data');
                this.userState = this.getDefaultUserState();
                this.updateHeader();
                
                if (this.auth && !this.auth.currentUser) {
                    setTimeout(() => {
                        this.initializeFirebase();
                    }, 2000);
                }
                
                return;
            }
            
            const telegramId = this.tgUser.id;
            console.log('Loading user data with Telegram ID:', telegramId);
            
            const userRef = this.db.ref(`users/${telegramId}`);
            const userSnapshot = await userRef.once('value');
            
            let userData;
            
            if (userSnapshot.exists()) {
                userData = userSnapshot.val();
                console.log('User found in Firebase:', userData.id);
                
                userData = await this.updateExistingUser(userRef, userData);
            } else {
                console.log('Creating new user in Firebase');
                userData = await this.createNewUser(userRef);
            }
            
            if (userData.firebaseUid !== this.auth.currentUser.uid) {
                await userRef.update({
                    firebaseUid: this.auth.currentUser.uid,
                    lastUpdated: Date.now()
                });
                userData.firebaseUid = this.auth.currentUser.uid;
            }
            
            this.userState = userData;
            this.cache.set(cacheKey, userData, 60000);
            this.updateHeader();
            
            console.log('User data loaded successfully from Firebase');
            
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
            id: this.tgUser.id,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            telegramId: this.tgUser.id,
            firstName: this.getShortName(this.tgUser.first_name || 'User'),
            photoUrl: this.tgUser.photo_url || 'https://cdn-icons-png.flaticon.com/512/9195/9195920.png',
            balance: 0,
            spins: 0,
            totalSpins: 0,
            referrals: 0,
            referralCode: this.generateReferralCode(),
            totalEarned: 0,
            totalTasks: 0,
            totalWithdrawals: 0,
            completedTasks: [],
            referralEarnings: 0,
            lastDailyCheckin: 0,
            status: 'free',
            lastUpdated: Date.now(),
            firebaseUid: this.auth?.currentUser?.uid || null,
            welcomeTasksCompleted: false
        };
    }

    async createNewUser(userRef) {
        const multiAccountAllowed = await this.checkMultiAccount(this.tgUser.id, false);
        if (!multiAccountAllowed) {
            return this.getDefaultUserState();
        }
        
        let referralId = null;
        const startParam = this.tg?.initDataUnsafe?.start_param;
        
        if (startParam) {
            referralId = this.extractReferralId(startParam);
            
            if (referralId && referralId > 0 && referralId !== this.tgUser.id) {
                const referrerRef = this.db.ref(`users/${referralId}`);
                const referrerSnapshot = await referrerRef.once('value');
                if (referrerSnapshot.exists()) {
                    this.pendingReferralAfterWelcome = referralId;
                    
                    await this.db.ref(`referrals/${referralId}/${this.tgUser.id}`).set({
                        userId: this.tgUser.id,
                        username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
                        firstName: this.getShortName(this.tgUser.first_name || ''),
                        photoUrl: this.tgUser.photo_url || 'https://cdn-icons-png.flaticon.com/512/9195/9195920.png',
                        joinedAt: Date.now(),
                        state: 'pending',
                        bonusGiven: false,
                        bonusAmount: this.appConfig.REFERRAL_BONUS_TON,
                        spinsBonus: this.appConfig.REFERRAL_BONUS_SPINS,
                        verifiedAt: null
                    });
                } else {
                    referralId = null;
                }
            } else {
                referralId = null;
            }
        }
        
        const userData = {
            id: this.tgUser.id,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            telegramId: this.tgUser.id,
            firstName: this.getShortName(this.tgUser.first_name || ''),
            photoUrl: this.tgUser.photo_url || 'https://cdn-icons-png.flaticon.com/512/9195/9195920.png',
            balance: 0,
            spins: 0,
            totalSpins: 0,
            referrals: 0,
            referredBy: referralId,
            referralCode: this.generateReferralCode(),
            totalEarned: 0,
            totalTasks: 0,
            totalWithdrawals: 0,
            referralEarnings: 0,
            completedTasks: [],
            lastWithdrawalDate: null,
            lastDailyCheckin: 0,
            createdAt: Date.now(),
            lastActive: Date.now(),
            status: 'free',
            referralState: referralId ? 'pending' : null,
            firebaseUid: this.auth?.currentUser?.uid || null,
            welcomeTasksCompleted: false,
            welcomeTasksCompletedAt: null
        };
        
        await userRef.set(userData);
        
        try {
            await this.updateAppStats('totalUsers', 1);
        } catch (statsError) {}
        
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
                    if (this.db) {
                        await this.db.ref(`users/${tgId}`).update({
                            status: 'ban',
                            banReason: 'Multiple accounts detected on same IP',
                            bannedAt: Date.now()
                        });
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

    async updateExistingUser(userRef, userData) {
        const now = new Date();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const todayKey = today.getTime();
        const lastAdReset = userData.lastAdResetDate || 0;
        
        if (lastAdReset < todayKey) {
            userData.dailyAdsWatched = 0;
            await userRef.update({
                dailyAdsWatched: 0,
                lastAdResetDate: todayKey
            });
            this.dailyAdsWatched = 0;
        } else {
            this.dailyAdsWatched = userData.dailyAdsWatched || 0;
        }
        
        await userRef.update({ 
            lastActive: Date.now(),
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            firstName: userData.firstName || this.getShortName(this.tgUser.first_name || 'User')
        });
        
        if (userData.completedTasks && Array.isArray(userData.completedTasks)) {
            this.userCompletedTasks = new Set(userData.completedTasks);
        } else {
            this.userCompletedTasks = new Set();
            userData.completedTasks = [];
            await userRef.update({ completedTasks: [] });
        }
        
        if (!userData.spins) {
            userData.spins = 0;
            await userRef.update({ spins: 0 });
        }
        
        const defaultData = {
            referralCode: userData.referralCode || this.generateReferralCode(),
            lastDailyCheckin: userData.lastDailyCheckin || 0,
            status: userData.status || 'free',
            referralState: userData.referralState || 'verified',
            referralEarnings: userData.referralEarnings || 0,
            totalEarned: userData.totalEarned || 0,
            totalTasks: userData.totalTasks || 0,
            totalWithdrawals: userData.totalWithdrawals || 0,
            balance: userData.balance || 0,
            referrals: userData.referrals || 0,
            spins: userData.spins || 0,
            totalSpins: userData.totalSpins || 0,
            dailyAdsWatched: this.dailyAdsWatched,
            lastAdResetDate: todayKey,
            firebaseUid: this.auth?.currentUser?.uid || userData.firebaseUid || null,
            welcomeTasksCompleted: userData.welcomeTasksCompleted || false,
            welcomeTasksCompletedAt: userData.welcomeTasksCompletedAt || null
        };
        
        const updates = {};
        Object.keys(defaultData).forEach(key => {
            if (userData[key] === undefined) {
                updates[key] = defaultData[key];
                userData[key] = defaultData[key];
            }
        });
        
        if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
        }
        
        return userData;
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
            if (!this.db) return;
            
            const referrerRef = this.db.ref(`users/${referrerId}`);
            const referrerSnapshot = await referrerRef.once('value');
            
            if (!referrerSnapshot.exists()) return;
            
            const referrerData = referrerSnapshot.val();
            
            if (referrerData.status === 'ban') return;
            
            const referralBonus = this.appConfig.REFERRAL_BONUS_TON;
            const spinsBonus = this.appConfig.REFERRAL_BONUS_SPINS;
            
            const newBalance = this.safeNumber(referrerData.balance) + referralBonus;
            const newSpins = (referrerData.spins || 0) + spinsBonus;
            const newReferrals = (referrerData.referrals || 0) + 1;
            const newReferralEarnings = this.safeNumber(referrerData.referralEarnings) + referralBonus;
            const newTotalEarned = this.safeNumber(referrerData.totalEarned) + referralBonus;
            
            await referrerRef.update({
                balance: newBalance,
                spins: newSpins,
                referrals: newReferrals,
                referralEarnings: newReferralEarnings,
                totalEarned: newTotalEarned
            });
            
            await this.db.ref(`referrals/${referrerId}/${newUserId}`).update({
                state: 'verified',
                bonusGiven: true,
                verifiedAt: Date.now(),
                bonusAmount: referralBonus,
                spinsBonus: spinsBonus
            });
            
            await this.db.ref(`users/${newUserId}`).update({
                referralState: 'verified'
            });
            
            await this.sendReferralNotification(referrerId, newUserId, referralBonus, spinsBonus);
            
            if (this.tgUser && referrerId === this.tgUser.id) {
                this.userState.balance = newBalance;
                this.userState.spins = newSpins;
                this.userState.referrals = newReferrals;
                this.userState.referralEarnings = newReferralEarnings;
                this.userState.totalEarned = newTotalEarned;
                
                this.updateHeader();
                
                this.notificationManager.showNotification(
                    "🎉 New Referral!", 
                    `+${this.appConfig.REFERRAL_BONUS_TON} TON + ${this.appConfig.REFERRAL_BONUS_SPINS} SPIN!`, 
                    "success"
                );
            }
            
            console.log(`Referral bonus processed for referrer ${referrerId}, new user ${newUserId}`);
            
            await this.refreshReferralsList();
            
        } catch (error) {
            console.error('Error in referral process:', error);
        }
    }

    async sendReferralNotification(referrerId, newUserId, tonBonus, spinsBonus) {
        try {
            const referrerRef = this.db.ref(`users/${referrerId}`);
            const referrerSnapshot = await referrerRef.once('value');
            const referrerData = referrerSnapshot.val();
            
            const newUserRef = this.db.ref(`users/${newUserId}`);
            const newUserSnapshot = await newUserRef.once('value');
            const newUserData = newUserSnapshot.val();
            
            if (!referrerData || !newUserData) {
                console.error('Referrer or new user data not found');
                return false;
            }
            
            const username = newUserData.username?.replace('@', '') || 'user';
            const firstName = newUserData.firstName || 'User';
            const referrerUsername = referrerData.username?.replace('@', '') || 'user';
            
            const message = `🎉 *NEW REFERRAL VERIFIED!*\n\n` +
                          `👤 *New User:* ${firstName} (@${username})\n` +
                          `💰 *Earned:* ${tonBonus.toFixed(3)} TON + ${spinsBonus} Spin(s)\n` +
                          `📊 *Total Referrals:* ${referrerData.referrals || 1}\n` +
                          `💎 *Total Earnings:* ${(referrerData.referralEarnings || 0).toFixed(3)} TON\n\n` +
                          `🥷 *Keep inviting to earn more!*`;
            
            console.log('Sending referral notification:', {
                referrerId,
                newUserId,
                message,
                tonBonus,
                spinsBonus
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

    async loadHistoryData() {
        try {
            if (!this.db) {
                this.userWithdrawals = [];
                return;
            }
            
            const statuses = ['pending', 'completed', 'rejected'];
            const withdrawalPromises = statuses.map(status => 
                this.db.ref(`withdrawals/${status}`).orderByChild('userId').equalTo(this.tgUser.id).once('value')
            );
            
            const withdrawalSnapshots = await Promise.all(withdrawalPromises);
            this.userWithdrawals = [];
            
            withdrawalSnapshots.forEach(snap => {
                snap.forEach(child => {
                    this.userWithdrawals.push({ id: child.key, ...child.val() });
                });
            });
            
            this.userWithdrawals.sort((a, b) => (b.createdAt || b.timestamp) - (a.createdAt || a.timestamp));
            
        } catch (error) {
            this.userWithdrawals = [];
        }
    }

    async loadAppStats() {
        try {
            if (!this.db) {
                this.appStats = {
                    totalUsers: 0,
                    onlineUsers: 0,
                    totalPayments: 0,
                    totalWithdrawals: 0
                };
                return;
            }
            
            const statsSnapshot = await this.db.ref('appStats').once('value');
            if (statsSnapshot.exists()) {
                const stats = statsSnapshot.val();
                const totalUsers = this.safeNumber(stats.totalUsers || 0);
                const minOnline = Math.floor(totalUsers * 0.05);
                const maxOnline = Math.floor(totalUsers * 0.20);
                const onlineUsers = Math.floor(Math.random() * (maxOnline - minOnline + 1)) + minOnline;
                
                this.appStats = {
                    totalUsers: totalUsers,
                    onlineUsers: Math.max(onlineUsers, Math.floor(totalUsers * 0.05)),
                    totalPayments: this.safeNumber(stats.totalPayments || 0),
                    totalWithdrawals: this.safeNumber(stats.totalWithdrawals || 0)
                };
            } else {
                this.appStats = {
                    totalUsers: 0,
                    onlineUsers: 0,
                    totalPayments: 0,
                    totalWithdrawals: 0
                };
                await this.db.ref('appStats').set(this.appStats);
            }
            
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
            if (!this.db) return;
            
            if (stat === 'totalUsers') {
                const newTotal = (this.appStats.totalUsers || 0) + value;
                const minOnline = Math.floor(newTotal * 0.05);
                const maxOnline = Math.floor(newTotal * 0.20);
                const onlineUsers = Math.floor(Math.random() * (maxOnline - minOnline + 1)) + minOnline;
                
                await this.db.ref('appStats/onlineUsers').set(Math.max(onlineUsers, Math.floor(newTotal * 0.05)));
            }
            
            await this.db.ref(`appStats/${stat}`).transaction(current => (current || 0) + value);
            this.appStats[stat] = (this.appStats[stat] || 0) + value;
            
            if (stat === 'totalUsers') {
                await this.loadAppStats();
            }
        } catch (error) {}
    }

    async showWelcomeTasksModal() {
        if (this.userState.welcomeTasksCompleted) {
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
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update({
                    balance: newBalance,
                    totalEarned: this.safeNumber(this.userState.totalEarned) + reward,
                    totalTasks: this.safeNumber(this.userState.totalTasks) + 4,
                    spins: (this.userState.spins || 0) + (this.appConfig.TASK_SPIN_BONUS * 4),
                    welcomeTasksCompleted: true,
                    welcomeTasksCompletedAt: Date.now(),
                    welcomeTasksVerifiedAt: Date.now()
                });
            }
            
            this.userState.balance = newBalance;
            this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + reward;
            this.userState.totalTasks = this.safeNumber(this.userState.totalTasks) + 4;
            this.userState.spins = (this.userState.spins || 0) + (this.appConfig.TASK_SPIN_BONUS * 4);
            this.userState.welcomeTasksCompleted = true;
            this.userState.welcomeTasksCompletedAt = Date.now();
            this.userState.welcomeTasksVerifiedAt = Date.now();
            
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
            if (!this.db || !this.tgUser) return;
            
            const referralsRef = await this.db.ref(`referrals/${this.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return;
            
            const referrals = referralsRef.val();
            let updated = false;
            
            for (const referralId in referrals) {
                const referral = referrals[referralId];
                
                if (referral.state === 'pending') {
                    const newUserRef = await this.db.ref(`users/${referralId}`).once('value');
                    if (newUserRef.exists()) {
                        const newUserData = newUserRef.val();
                        
                        if (newUserData.welcomeTasksCompleted) {
                            await this.processReferralRegistrationWithBonus(this.tgUser.id, referralId);
                            updated = true;
                        }
                    }
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
                        <p>${this.userState.banReason || 'Violation of terms'}</p>
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
            userPhoto.src = this.userState.photoUrl || 'https://cdn-icons-png.flaticon.com/512/9195/9195920.png';
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
        this.renderSpinPage();
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
            } else if (pageId === 'spin-page') {
                this.renderSpinPage();
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
                        <span class="game-bonus-blue">+${this.appConfig.TASK_SPIN_BONUS} SPIN</span>
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
            if (this.db) {
                const promoCodesRef = await this.db.ref('config/promoCodes').once('value');
                if (promoCodesRef.exists()) {
                    const promoCodes = promoCodesRef.val();
                    for (const id in promoCodes) {
                        if (promoCodes[id].code === code) {
                            promoData = { id, ...promoCodes[id] };
                            break;
                        }
                    }
                }
            }
            
            if (!promoData) {
                this.notificationManager.showNotification("Promo Code", "Invalid promo code", "error");
                promoBtn.innerHTML = originalText;
                promoBtn.disabled = false;
                return;
            }
            
            if (this.db) {
                const usedRef = await this.db.ref(`usedPromoCodes/${this.tgUser.id}/${promoData.id}`).once('value');
                if (usedRef.exists()) {
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
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update({
                    balance: newBalance,
                    totalEarned: this.safeNumber(this.userState.totalEarned) + reward
                });
                
                await this.db.ref(`usedPromoCodes/${this.tgUser.id}/${promoData.id}`).set({
                    code: code,
                    reward: reward,
                    claimedAt: Date.now()
                });
                
                await this.db.ref(`config/promoCodes/${promoData.id}/usedCount`).transaction(current => (current || 0) + 1);
            }
            
            this.userState.balance = newBalance;
            this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + reward;
            
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

    renderSpinPage() {
        const spinPage = document.getElementById('spin-page');
        if (!spinPage) return;
        
        const userSpins = this.userState.spins || 0;
        const currentTime = Date.now();
        const timeSinceLastAd = currentTime - this.lastAdWatchTime;
        const isAdButtonCooldown = timeSinceLastAd < this.adCooldown;
        const remainingCooldown = Math.max(0, this.adCooldown - timeSinceLastAd);
        const remainingMinutes = Math.ceil(remainingCooldown / 60000);
        
        spinPage.innerHTML = `
            <div class="spin-container">
                <div class="spin-game-section">
                    <div class="wheel-container" id="wheel-container">
                        <div class="wheel">
                            <div class="wheel-inner" id="wheel">
                                ${this.spinPrizes.map((prize, index) => `
                                    <div class="wheel-item" style="transform: rotate(${index * 36}deg);">
                                        <div class="wheel-item-content" style="transform: rotate(-${index * 36}deg);">
                                            ${prize}
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            <div class="wheel-center">
                                <i class="fas fa-gem"></i>
                            </div>
                            <div class="wheel-pointer">
                                <i class="fas fa-caret-down"></i>
                            </div>
                        </div>
                    </div>
                    
                    <button class="spin-play-btn ${userSpins > 0 ? '' : 'disabled'}" 
                            id="play-spin-btn" 
                            ${userSpins <= 0 ? 'disabled' : ''}>
                        <i class="fas fa-sync-alt"></i>
                        SPIN WHEEL (${userSpins})
                    </button>
                </div>
                
                <div class="get-spins-section">
                    <h3><i class="fas fa-plus-circle"></i> GET MORE SPINS</h3>
                    
                    <div class="get-method-card">
                        <div class="get-method-header">
                            <div class="get-method-icon">
                                <i class="fas fa-eye"></i>
                            </div>
                            <div class="get-method-title">WATCH ADS</div>
                        </div>
                        <div class="get-method-description">
                            Watch Ad every 5 minutes and earn +1 Spin
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
                            Complete tasks and earn TON + ${this.appConfig.TASK_SPIN_BONUS} Spin each
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
                            Invite friends and earn ${this.appConfig.REFERRAL_BONUS_TON} TON + ${this.appConfig.REFERRAL_BONUS_SPINS} Spin each
                        </div>
                        <button class="get-method-btn" id="go-referrals-btn">
                            GO
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        this.setupSpinEvents();
        this.setupGetSpinsEvents();
    }

    setupSpinEvents() {
        const spinBtn = document.getElementById('play-spin-btn');
        if (spinBtn) {
            spinBtn.addEventListener('click', () => {
                this.playSpin();
            });
        }
    }

    setupGetSpinsEvents() {
        const watchAdBtn = document.getElementById('watch-ad-btn');
        const gotoTasksBtn = document.getElementById('go-tasks-btn');
        const goReferralsBtn = document.getElementById('go-referrals-btn');
        
        if (watchAdBtn) {
            watchAdBtn.addEventListener('click', () => {
                this.watchAdForSpin();
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

    async watchAdForSpin() {
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
                
                const newSpins = (this.userState.spins || 0) + 1;
                this.userState.spins = newSpins;
                
                if (this.db) {
                    await this.db.ref(`users/${this.tgUser.id}`).update({
                        spins: newSpins,
                        lastAdWatchTime: this.lastAdWatchTime
                    });
                }
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.renderSpinPage();
                
                this.notificationManager.showNotification("Success", "+1 Spin! Ad watched successfully", "success");
                
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

    async playSpin() {
        if (this.userState.spins <= 0) {
            this.notificationManager.showNotification("No Spins", "You don't have any spins left", "info");
            return;
        }
        
        const wheel = document.getElementById('wheel');
        const spinBtn = document.getElementById('play-spin-btn');
        
        if (!wheel || !spinBtn) return;
        
        spinBtn.disabled = true;
        spinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Spinning...';
        
        const newSpins = this.userState.spins - 1;
        
        if (this.db) {
            await this.db.ref(`users/${this.tgUser.id}`).update({
                spins: newSpins,
                totalSpins: (this.userState.totalSpins || 0) + 1
            });
        }
        
        this.userState.spins = newSpins;
        this.userState.totalSpins = (this.userState.totalSpins || 0) + 1;
        this.cache.delete(`user_${this.tgUser.id}`);
        this.updateHeader();
        
        const spinDegrees = 3600 + Math.random() * 360;
        const prizeIndex = Math.floor(Math.random() * this.spinPrizes.length);
        const targetDegree = prizeIndex * 36;
        
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        
        setTimeout(() => {
            wheel.style.transition = 'transform 10s cubic-bezier(0.2, 0.8, 0.3, 1)';
            wheel.style.transform = `rotate(${spinDegrees}deg)`;
            
            let speed = 10;
            const slowDown = () => {
                if (speed > 0.1) {
                    speed *= 0.95;
                    const currentDegrees = parseFloat(wheel.style.transform.replace('rotate(', '').replace('deg)', '')) || 0;
                    wheel.style.transform = `rotate(${currentDegrees + speed}deg)`;
                    requestAnimationFrame(slowDown);
                } else {
                    wheel.style.transition = 'transform 2s ease-out';
                    const finalDegrees = spinDegrees - (spinDegrees % 36) + targetDegree;
                    wheel.style.transform = `rotate(${finalDegrees}deg)`;
                    
                    setTimeout(() => {
                        this.processSpinResult(prizeIndex);
                    }, 2000);
                }
            };
            
            setTimeout(() => {
                requestAnimationFrame(slowDown);
            }, 10000);
        }, 50);
    }

    async processSpinResult(prizeIndex) {
        const prize = this.spinPrizes[prizeIndex];
        const spinBtn = document.getElementById('play-spin-btn');
        
        if (spinBtn) {
            spinBtn.disabled = false;
            spinBtn.innerHTML = `<i class="fas fa-sync-alt"></i> SPIN WHEEL (${this.userState.spins})`;
        }
        
        setTimeout(() => {
            this.showSpinPrizeModal(prize, prizeIndex);
        }, 1000);
    }

    showSpinPrizeModal(prize, prizeIndex) {
        const modal = document.createElement('div');
        modal.className = 'spin-result-modal';
        modal.innerHTML = `
            <div class="spin-result-content">
                <button class="close-modal-btn" id="close-spin-modal">
                    <i class="fas fa-times"></i>
                </button>
                
                <div class="spin-result-header">
                    <i class="fas fa-trophy"></i>
                    <h3>Spin Result!</h3>
                </div>
                
                <div class="spin-result-display">
                    <div class="spin-prize-icon">
                        ${prize.includes('💎') ? '<i class="fas fa-gem"></i>' : 
                          prize.includes('Spin') ? '<i class="fas fa-sync-alt"></i>' : 
                          '<i class="fas fa-times"></i>'}
                    </div>
                    
                    <div class="spin-prize-amount">${prize}</div>
                    
                    <div class="spin-prize-description">
                        ${prize === 'Game over' ? 'Better luck next time!' : 
                          prize.includes('Spin') ? 'Spins added to your balance!' : 
                          'TON added to your balance!'}
                    </div>
                </div>
                
                <div class="spin-result-actions">
                    <button class="spin-result-claim" id="claim-spin-prize">
                        <i class="fas fa-gift"></i> CLAIM PRIZE
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const closeBtn = document.getElementById('close-spin-modal');
        closeBtn.addEventListener('click', () => {
            modal.remove();
            this.notificationManager.showNotification("Cancelled", "Prize not claimed", "info");
        });
        
        const claimBtn = document.getElementById('claim-spin-prize');
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
                
                if (prize === 'Game over') {
                    this.notificationManager.showNotification("Game Over", "No prize this time. Try again!", "info");
                } else if (prize.includes('Spin')) {
                    const spinCount = parseInt(prize.split(' ')[0]);
                    const newSpins = (this.userState.spins || 0) + spinCount;
                    this.userState.spins = newSpins;
                    
                    if (this.db) {
                        await this.db.ref(`users/${this.tgUser.id}`).update({
                            spins: newSpins
                        });
                    }
                    
                    this.notificationManager.showNotification("Success", `+${spinCount} Spin added to your balance!`, "success");
                } else if (prize.includes('💎')) {
                    const tonAmount = parseFloat(prize.split(' ')[0]);
                    const currentBalance = this.safeNumber(this.userState.balance);
                    const newBalance = currentBalance + tonAmount;
                    
                    if (this.db) {
                        await this.db.ref(`users/${this.tgUser.id}`).update({
                            balance: newBalance,
                            totalEarned: this.safeNumber(this.userState.totalEarned) + tonAmount
                        });
                    }
                    
                    this.userState.balance = newBalance;
                    this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + tonAmount;
                    
                    this.notificationManager.showNotification("Success", `+${tonAmount} TON added to your balance!`, "success");
                }
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.renderSpinPage();
                
                modal.remove();
                
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
            if (!this.db) return [];
            
            const referralsRef = await this.db.ref(`referrals/${this.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return [];
            
            const referralsList = [];
            referralsRef.forEach(child => {
                const referralData = child.val();
                if (referralData && typeof referralData === 'object') {
                    referralsList.push({
                        id: child.key,
                        ...referralData
                    });
                }
            });
            
            return referralsList.sort((a, b) => b.joinedAt - a.joinedAt);
        } catch (error) {
            console.error('Error loading referrals:', error);
            return [];
        }
    }

    async refreshReferralsList() {
        try {
            if (!this.db || !this.tgUser) return;
            
            const referralsRef = await this.db.ref(`referrals/${this.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return;
            
            const referrals = referralsRef.val();
            const verifiedReferrals = [];
            
            for (const referralId in referrals) {
                const referral = referrals[referralId];
                if (referral.state === 'verified' && referral.bonusGiven) {
                    verifiedReferrals.push({
                        id: referralId,
                        ...referral
                    });
                }
            }
            
            this.userState.referrals = verifiedReferrals.length;
            
            if (document.getElementById('referrals-page')?.classList.contains('active')) {
                this.renderReferralsPage();
            }
            
            console.log(`Referrals list refreshed: ${verifiedReferrals.length} verified referrals`);
            
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
            const date = new Date(transaction.createdAt || transaction.timestamp);
            const day = date.getDate().toString().padStart(2, '0');
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const year = date.getFullYear();
            const formattedDate = `${day}-${month}-${year}`;
            const formattedTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
            
            const amount = this.safeNumber(transaction.tonAmount || transaction.amount || 0);
            const status = transaction.status || 'pending';
            
            return `
                <div class="history-item">
                    <div class="history-info">
                        <div class="history-amount">${amount.toFixed(5)} TON</div>
                        <div class="history-details">
                            <div class="history-date">${formattedDate} ${formattedTime}</div>
                            <div class="history-wallet">${transaction.walletAddress?.substring(0, 12)}...${transaction.walletAddress?.substring(transaction.walletAddress.length - 6)}</div>
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
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update({
                    balance: newBalance,
                    totalWithdrawals: this.safeNumber(this.userState.totalWithdrawals) + 1,
                    lastWithdrawalDate: Date.now()
                });
                
                const requestData = {
                    userId: this.tgUser.id,
                    userName: this.userState.firstName,
                    username: this.userState.username,
                    walletAddress: walletAddress,
                    amount: amount,
                    status: 'pending',
                    createdAt: Date.now()
                };
                
                await this.db.ref('withdrawals/pending').push(requestData);
            }
            
            this.userState.balance = newBalance;
            this.userState.totalWithdrawals = this.safeNumber(this.userState.totalWithdrawals) + 1;
            this.userState.lastWithdrawalDate = Date.now();
            
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
