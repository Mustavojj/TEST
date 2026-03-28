import { APP_CONFIG, REWARDS_CONFIG, REQUIREMENTS_CONFIG, CORE_CONFIG, THEME_CONFIG } from './data.js';
import { CacheManager, NotificationManager, SecurityManager } from './modules/core.js';
import { TaskManager, ReferralManager } from './modules/features.js';

class TornadoApp {
    
    constructor() {
        this.darkMode = true;
        this.tg = null;
        this.db = null;
        this.auth = null;
        this.firebaseInitialized = false;
        
        this.currentUser = null;
        this.userState = {};
        this.appConfig = APP_CONFIG;
        this.rewardsConfig = REWARDS_CONFIG;
        this.requirementsConfig = REQUIREMENTS_CONFIG;
        this.themeConfig = THEME_CONFIG;
        
        this.userCompletedTasks = new Set();
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
            { id: 'tasks-page', name: 'Earn', icon: 'fa-coins', color: '#FFD966' },
            { id: 'referrals-page', name: 'Invite', icon: 'fa-user-plus', color: '#FFD966' },
            { id: 'profile-page', name: 'Profile', icon: 'user-photo', color: '#FFD966' }
        ];
        
        this.cache = new CacheManager();
        this.notificationManager = null;
        this.securityManager = new SecurityManager();
        this.isProcessingTask = false;
        
        this.tgUser = null;
        
        this.taskManager = null;
        this.referralManager = null;
        
        this.currentTasksTab = 'main';
        this.isCopying = false;
        this.pendingReferral = null;
        
        this.remoteConfig = null;
        this.configCache = null;
        this.configTimestamp = 0;
        
        this.pendingReferralAfterWelcome = null;
        this.rateLimiter = new (this.getRateLimiterClass())();
        
        this.inAppAdsInitialized = false;
        this.inAppAdsTimer = null;
        this.inAppAdInterval = 60000;
        this.nextAdInterval = 60000;
        
        this.serverTimeOffset = 0;
        this.timeSyncInterval = null;
        
        this.telegramVerified = false;
        
        this.botToken = null;
        
        this.userPOP = 0;
        this.userPopEarnings = 0;
        this.userTasksCompletedCount = 0;
        this.userCreatedTasks = [];
        this.lastDailyCheckin = 0;
        this.lastDailyCheckinDate = '';
        this.totalCheckins = 0;
        this.lastNewsTask = 0;
        
        this.deviceId = null;
        this.deviceRegistered = false;
        this.deviceOwnerId = null;
        
        this.newsTaskCompleted = false;
        this.newsTaskCooldown = 86400000;
        
        this.additionalRewards = [];
        
        this.loadingSteps = [
            { element: null, text: 'Connecting to Database...', icon: 'fa-spinner fa-pulse', completedText: 'Database Connected', completedIcon: 'fa-check-circle' },
            { element: null, text: 'Verifying Device...', icon: 'fa-spinner fa-pulse', completedText: 'Device Verified', completedIcon: 'fa-check-circle' },
            { element: null, text: 'Loading User Data...', icon: 'fa-spinner fa-pulse', completedText: 'User Data Loaded', completedIcon: 'fa-check-circle' },
            { element: null, text: 'Loading Tasks...', icon: 'fa-spinner fa-pulse', completedText: 'Tasks Loaded', completedIcon: 'fa-check-circle' },
            { element: null, text: 'Ready to Launch...', icon: 'fa-spinner fa-pulse', completedText: 'Ready to Launch', completedIcon: 'fa-check-circle' }
        ];
        this.currentLoadingStep = 0;
        this.loadingComplete = false;
    }

    startDailyResetCheck() {
        setInterval(() => {
            this.checkDailyReset();
        }, 60000);
        
        setTimeout(() => this.checkDailyReset(), 1000);
    }

    checkDailyReset() {
        const now = new Date();
        const today = now.toDateString();
        
        if (this.lastDailyCheckinDate && this.lastDailyCheckinDate !== today) {
            this.lastDailyCheckinDate = '';
            this.updateDailyCheckinButton();
        }
        
        if (this.lastNewsTask) {
            const timeSinceLastNews = this.getServerTime() - this.lastNewsTask;
            if (timeSinceLastNews >= this.newsTaskCooldown) {
                this.updateNewsTaskButton();
            }
        }
    }

    getRateLimiterClass() {
        return class RateLimiter {
            constructor() {
                this.requests = new Map();
                this.limits = CORE_CONFIG.RATE_LIMITS;
                this.loadRequests();
            }

            loadRequests() {
                try {
                    const saved = localStorage.getItem('rateLimiter_requests');
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        Object.keys(parsed).forEach(key => {
                            this.requests.set(key, parsed[key]);
                        });
                    }
                } catch (error) {}
            }

            saveRequests() {
                try {
                    const obj = {};
                    this.requests.forEach((value, key) => {
                        obj[key] = value;
                    });
                    localStorage.setItem('rateLimiter_requests', JSON.stringify(obj));
                } catch (error) {}
            }

            checkLimit(userId, action) {
                const key = `${userId}_${action}`;
                const now = this.getServerTime();
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
                
                return { allowed: true };
            }

            addRequest(userId, action) {
                const key = `${userId}_${action}`;
                const now = this.getServerTime();
                
                if (!this.requests.has(key)) this.requests.set(key, []);
                
                const userRequests = this.requests.get(key);
                userRequests.push(now);
                this.requests.set(key, userRequests);
                
                this.saveRequests();
            }

            getServerTime() {
                return Date.now() + (window.app?.serverTimeOffset || 0);
            }
        };
    }

    getServerTime() {
        return Date.now() + this.serverTimeOffset;
    }

    async syncServerTime() {
        try {
            const startTime = Date.now();
            const serverTime = await this.getFirebaseServerTime();
            const endTime = Date.now();
            const rtt = endTime - startTime;
            this.serverTimeOffset = serverTime - endTime + (rtt / 2);
            return true;
        } catch (error) {
            this.serverTimeOffset = 0;
            return false;
        }
    }

    async getFirebaseServerTime() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const ref = this.db.ref('.info/serverTimeOffset');
            ref.once('value')
                .then(snapshot => {
                    const offset = snapshot.val() || 0;
                    resolve(Date.now() + offset);
                })
                .catch(reject);
        });
    }

    updateLoadingStep(step, text, icon = 'fa-spinner fa-pulse', success = false) {
        if (step >= this.loadingSteps.length) return;
        
        const stepData = this.loadingSteps[step];
        if (!stepData.element) return;
        
        const finalIcon = success ? (stepData.completedIcon || 'fa-check-circle') : icon;
        const finalText = success ? (stepData.completedText || text) : text;
        const iconColor = success ? '#4CAF50' : (icon.includes('fa-pulse') ? '#FFD966' : '#f44336');
        
        stepData.element.innerHTML = `<i class="fas ${finalIcon}" style="color: ${iconColor}; margin-right: 12px; width: 20px;"></i><span>${finalText}</span>`;
        stepData.element.style.color = success ? '#4CAF50' : (icon.includes('fa-pulse') ? '#FFD966' : '#f44336');
        stepData.element.style.borderLeftColor = success ? '#4CAF50' : (icon.includes('fa-pulse') ? '#FFD966' : '#f44336');
        
        if (success && step === this.currentLoadingStep && step < this.loadingSteps.length - 1) {
            this.currentLoadingStep++;
            this.updateLoadingStep(this.currentLoadingStep, this.loadingSteps[this.currentLoadingStep].text, 'fa-spinner fa-pulse', false);
        }
        
        if (success && step === this.loadingSteps.length - 1) {
            this.loadingComplete = true;
            this.showLaunchButton();
        }
    }

    async initialize() {
        if (this.isInitializing || this.isInitialized) return;
        
        this.isInitializing = true;
        
        try {
            this.initLoadingElements();
            
            this.updateLoadingStep(0, "Connecting to Database...", 'fa-spinner fa-pulse', false);
            
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
            
            this.telegramVerified = await this.verifyTelegramUser();
            this.botToken = await this.getBotToken();
            
            this.tg.ready();
            this.tg.expand();
            
            this.setupTelegramTheme();
            
            this.notificationManager = new NotificationManager();
            
            const firebaseSuccess = await this.initializeFirebase();
            
            if (!firebaseSuccess) {
                this.showError("Failed to connect to database. Please try again later.");
                return;
            }
            
            this.updateLoadingStep(0, "Database Connected", 'fa-check-circle', true);
            
            this.updateLoadingStep(1, "Verifying Device...", 'fa-spinner fa-pulse', false);
            
            const deviceCheck = await this.checkDeviceAndRegister();
            if (!deviceCheck.allowed) {
                this.showDeviceBanPage();
                return;
            }
            
            this.updateLoadingStep(1, "Device Verified", 'fa-check-circle', true);
            
            this.updateLoadingStep(2, "Loading User Data...", 'fa-spinner fa-pulse', false);
            
            this.setupFirebaseAuth();
            
            await this.syncServerTime();
            
            if (this.timeSyncInterval) {
                clearInterval(this.timeSyncInterval);
            }
            this.timeSyncInterval = setInterval(() => this.syncServerTime(), 300000);
            
            await this.loadUserData();
            
            if (this.userState.status === 'ban') {
                this.showBannedPage();
                return;
            }
            
            this.updateLoadingStep(2, "User Data Loaded", 'fa-check-circle', true);
            
            this.updateLoadingStep(3, "Loading Tasks...", 'fa-spinner fa-pulse', false);
            
            this.taskManager = new TaskManager(this);
            this.referralManager = new ReferralManager(this);
            
            await this.referralManager.startReferralMonitor();
            
            try {
                await this.loadTasksData();
                await this.loadUserCreatedTasks();
                await this.loadAdditionalRewards();
                this.updateLoadingStep(3, "Tasks Loaded", 'fa-check-circle', true);
            } catch (taskError) {
                this.updateLoadingStep(3, "Tasks Loaded", 'fa-check-circle', true);
            }
            
            this.updateLoadingStep(4, "Ready to Launch...", 'fa-spinner fa-pulse', false);
            
            try {
                await this.loadHistoryData();
            } catch (historyError) {}
            
            this.renderUI();
            
            this.darkMode = true;
            this.applyTheme();
            
            this.isInitialized = true;
            this.isInitializing = false;
            
            this.updateLoadingStep(4, "Ready to Launch", 'fa-check-circle', true);
            
        } catch (error) {
            this.showError("Initialization failed: " + error.message);
            this.isInitializing = false;
        }
    }

    initLoadingElements() {
        const stepElements = document.querySelectorAll('.loading-step');
        for (let i = 0; i < stepElements.length && i < this.loadingSteps.length; i++) {
            this.loadingSteps[i].element = stepElements[i];
        }
    }

    showLaunchButton() {
        if (!this.loadingComplete) return;
        
        const loader = document.getElementById('app-loader');
        if (!loader) return;
        
        const existingLaunchBtn = loader.querySelector('.launch-btn');
        if (existingLaunchBtn) return;
        
        const steps = loader.querySelector('.loading-steps');
        if (steps) {
            steps.style.opacity = '0.9';
        }
        
        const launchBtn = document.createElement('button');
        launchBtn.className = 'launch-btn';
        launchBtn.innerHTML = '<i class="fas fa-rocket" style="margin-right: 8px;"></i> Let\'s Go!';
        launchBtn.onclick = () => {
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
            
            this.initializeInAppAds();
            this.showPage('tasks-page');
        };
        
        const container = loader.querySelector('.loading-container');
        if (container) {
            container.appendChild(launchBtn);
        }
    }

    generateUniqueComment() {
        return this.tgUser.id.toString();
    }

    async checkDeviceAndRegister() {
        try {
            if (!this.db) {
                return { allowed: false, message: "Database not available" };
            }
            
            const userAgent = navigator.userAgent;
            const screenRes = `${window.screen.width}x${window.screen.height}`;
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const language = navigator.language;
            
            const deviceComponents = [
                userAgent,
                screenRes,
                timezone,
                language
            ];
            
            const deviceString = deviceComponents.join('|');
            let deviceHash = 0;
            for (let i = 0; i < deviceString.length; i++) {
                const char = deviceString.charCodeAt(i);
                deviceHash = ((deviceHash << 5) - deviceHash) + char;
                deviceHash = deviceHash & deviceHash;
            }
            
            this.deviceId = 'dev_' + Math.abs(deviceHash).toString(16);
            
            const savedDeviceId = localStorage.getItem('device_fingerprint');
            if (savedDeviceId && savedDeviceId !== this.deviceId) {
                this.deviceId = savedDeviceId;
            } else {
                localStorage.setItem('device_fingerprint', this.deviceId);
            }
            
            const deviceRef = await this.db.ref(`devices/${this.deviceId}`).once('value');
            
            if (deviceRef.exists()) {
                const deviceData = deviceRef.val();
                this.deviceOwnerId = deviceData.ownerId;
                
                if (deviceData.ownerId && deviceData.ownerId !== this.tgUser.id && deviceData.banned !== true) {
                    const userRef = await this.db.ref(`users/${this.tgUser.id}`).once('value');
                    if (userRef.exists()) {
                        const userData = userRef.val();
                        if (userData.status === 'ban') {
                            return { allowed: false, message: "This account is banned" };
                        }
                    }
                }
                
                if (deviceData.banned === true) {
                    return { allowed: false, message: "This device is banned" };
                }
                
                await this.db.ref(`devices/${this.deviceId}`).update({
                    lastSeen: this.getServerTime(),
                    lastUserId: this.tgUser.id
                });
            } else {
                await this.db.ref(`devices/${this.deviceId}`).set({
                    ownerId: this.tgUser.id,
                    firstSeen: this.getServerTime(),
                    lastSeen: this.getServerTime(),
                    userAgent: navigator.userAgent,
                    screenResolution: screenRes,
                    timezone: timezone,
                    language: language,
                    banned: false
                });
                this.deviceOwnerId = this.tgUser.id;
            }
            
            return { allowed: true };
            
        } catch (error) {
            return { allowed: false, message: "Device verification failed" };
        }
    }

    showDeviceBanPage() {
        document.body.innerHTML = `
            <div class="banned-container">
                <div class="banned-content">
                    <div class="banned-header">
                        <div class="banned-icon">
                            <i class="fas fa-ban"></i>
                        </div>
                        <h2>Access Denied</h2>
                    </div>
                    
                    <div class="ban-reason">
                        <div class="ban-reason-icon">
                            <i class="fas fa-exclamation-circle"></i>
                        </div>
                        <p>This device has been blocked for security reasons. This block is permanent and cannot be reversed.</p>
                    </div>
                </div>
            </div>
        `;
    }

    async getBotToken() {
        try {
            const response = await fetch('/api/get-bot-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-telegram-user': this.tgUser?.id?.toString() || '',
                    'x-telegram-auth': this.tg?.initData || ''
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                return data.token;
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    async verifyTelegramUser() {
        try {
            if (!this.tg?.initData) {
                return false;
            }

            const params = new URLSearchParams(this.tg.initData);
            const hash = params.get('hash');
            
            if (!hash || hash.length < 10) {
                return false;
            }

            const user = this.tg.initDataUnsafe.user;
            if (!user || !user.id || user.id <= 0) {
                return false;
            }

            return true;
            
        } catch (error) {
            return false;
        }
    }

    async loadUserCreatedTasks() {
        try {
            if (!this.db) return;
            
            const tasksRef = await this.db.ref(`userTasks/${this.tgUser.id}`).once('value');
            if (tasksRef.exists()) {
                const tasks = [];
                tasksRef.forEach(child => {
                    tasks.push({
                        id: child.key,
                        ...child.val()
                    });
                });
                this.userCreatedTasks = tasks;
            } else {
                this.userCreatedTasks = [];
            }
        } catch (error) {
            this.userCreatedTasks = [];
        }
    }

    async loadAdditionalRewards() {
        try {
            if (!this.db) return;
            
            const rewardsRef = await this.db.ref('config/more').once('value');
            if (rewardsRef.exists()) {
                const rewards = [];
                rewardsRef.forEach(child => {
                    const rewardData = child.val();
                    if (rewardData.status === 'active') {
                        rewards.push({
                            id: child.key,
                            name: rewardData.name || 'Reward',
                            description: rewardData.description || '',
                            rewardType: rewardData.rewardType || 'ton',
                            rewardAmount: this.safeNumber(rewardData.rewardAmount || 0),
                            popAmount: this.safeNumber(rewardData.popAmount || 0),
                            icon: rewardData.icon || 'fa-gift',
                            action: rewardData.action || 'none',
                            actionUrl: rewardData.actionUrl || ''
                        });
                    }
                });
                this.additionalRewards = rewards;
            } else {
                this.additionalRewards = [];
            }
        } catch (error) {
            this.additionalRewards = [];
        }
    }

    async dailyCheckin() {
        try {
            const checkinBtn = document.getElementById('daily-checkin-btn');
            if (!checkinBtn) return;
            
            const today = new Date().toDateString();
            
            if (this.lastDailyCheckinDate === today) {
                const timeUntilMidnight = this.getTimeUntilMidnight();
                const hours = Math.floor(timeUntilMidnight / 3600000);
                const minutes = Math.floor((timeUntilMidnight % 3600000) / 60000);
                this.showNotification("Already Checked In", `Next check-in at 00:00 (${hours}h ${minutes}m)`, "info");
                return;
            }
            
            const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'daily_checkin');
            if (!rateLimitCheck.allowed) {
                const timeUntilMidnight = this.getTimeUntilMidnight();
                const hours = Math.floor(timeUntilMidnight / 3600000);
                const minutes = Math.floor((timeUntilMidnight % 3600000) / 60000);
                this.showNotification("Already Checked In", `Next check-in at 00:00 (${hours}h ${minutes}m)`, "info");
                return;
            }
            
            const originalText = checkinBtn.innerHTML;
            checkinBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Loading Ad...';
            checkinBtn.disabled = true;
            
            let adShown = false;
            
            if (typeof window.AdBlock2 !== 'undefined') {
                try {
                    await window.AdBlock2.show();
                    adShown = true;
                } catch (error) {}
            }
            
            if (!adShown) {
                this.showNotification("Ad Required", "Please watch the ad to claim daily reward", "info");
                checkinBtn.innerHTML = originalText;
                checkinBtn.disabled = false;
                return;
            }
            
            checkinBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Claiming...';
            
            const reward = this.rewardsConfig.DAILY_CHECKIN_REWARD;
            const popReward = this.rewardsConfig.DAILY_CHECKIN_POP_REWARD;
            const currentTime = this.getServerTime();
            
            this.rateLimiter.addRequest(this.tgUser.id, 'daily_checkin');
            
            try {
                const currentBalance = this.safeNumber(this.userState.balance);
                const currentPop = this.safeNumber(this.userState.pop);
                const currentPopEarnings = this.safeNumber(this.userState.popEarnings);
                const newBalance = currentBalance + reward;
                const newPop = currentPop + popReward;
                const newPopEarnings = currentPopEarnings + popReward;
                this.totalCheckins = (this.totalCheckins || 0) + 1;
                
                const updates = {
                    balance: newBalance,
                    pop: newPop,
                    popEarnings: newPopEarnings,
                    totalEarned: this.safeNumber(this.userState.totalEarned) + reward,
                    lastDailyCheckin: currentTime,
                    totalCheckins: this.totalCheckins,
                    lastUpdated: currentTime
                };
                
                if (this.db) {
                    await this.db.ref(`users/${this.tgUser.id}`).update(updates);
                }
                
                this.userState.balance = newBalance;
                this.userState.pop = newPop;
                this.userState.popEarnings = newPopEarnings;
                this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + reward;
                this.userState.lastDailyCheckin = currentTime;
                this.userState.totalCheckins = this.totalCheckins;
                
                this.lastDailyCheckin = currentTime;
                this.lastDailyCheckinDate = today;
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.updateDailyCheckinButton();
                
                this.showNotification("Daily Check-in", `+${reward.toFixed(3)} TON, +${popReward} POP`, "success");
                
            } catch (error) {
                this.showNotification("Error", "Failed to claim daily reward", "error");
                checkinBtn.innerHTML = originalText;
                checkinBtn.disabled = false;
            }
            
        } catch (error) {
            this.showNotification("Error", "Daily check-in failed", "error");
        }
    }

    getTimeUntilMidnight() {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        return midnight - now;
    }

    updateDailyCheckinButton() {
        const checkinBtn = document.getElementById('daily-checkin-btn');
        if (!checkinBtn) return;
        
        const today = new Date().toDateString();
        
        if (this.lastDailyCheckinDate === today) {
            const timeUntilMidnight = this.getTimeUntilMidnight();
            const hours = Math.floor(timeUntilMidnight / 3600000);
            const minutes = Math.floor((timeUntilMidnight % 3600000) / 60000);
            checkinBtn.innerHTML = `<i class="fas fa-clock"></i> ${hours}h ${minutes}m`;
            checkinBtn.classList.add('completed');
            checkinBtn.disabled = true;
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'daily_checkin');
        
        if (!rateLimitCheck.allowed) {
            const timeUntilMidnight = this.getTimeUntilMidnight();
            const hours = Math.floor(timeUntilMidnight / 3600000);
            const minutes = Math.floor((timeUntilMidnight % 3600000) / 60000);
            checkinBtn.innerHTML = `<i class="fas fa-clock"></i> ${hours}h ${minutes}m`;
            checkinBtn.classList.add('completed');
            checkinBtn.disabled = true;
        } else {
            checkinBtn.innerHTML = '<i class="fas fa-calendar-check"></i> CHECK-IN';
            checkinBtn.classList.remove('completed');
            checkinBtn.disabled = false;
        }
    }

    async showAddTaskModal() {
        const modal = document.createElement('div');
        modal.className = 'task-modal';
        
        const completionsOptions = [100, 250, 500, 1000, 5000, 10000];
        
        modal.innerHTML = `
            <div class="task-modal-content">
                <button class="task-modal-close" id="task-modal-close">
                    <i class="fas fa-times"></i>
                </button>
                
                <div class="task-modal-tabs-container">
                    <div class="task-modal-tabs">
                        <button class="task-modal-tab active" data-tab="add">Add Task</button>
                        <button class="task-modal-tab" data-tab="mytasks">My Tasks</button>
                    </div>
                </div>
                
                <div id="add-task-tab" class="task-modal-body" style="display: block;">
                    <form class="add-task-form" id="add-task-form">
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-tag"></i> Task Name
                            </label>
                            <input type="text" id="task-name" class="form-input" placeholder="Enter your task name *" maxlength="15" required>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-link"></i> Task Link
                            </label>
                            <input type="url" id="task-link" class="form-input" placeholder="https://t.me/..." required>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-shield-alt"></i> Verification Required
                            </label>
                            <div class="category-selector" id="verification-selector">
                                <div class="category-option active" data-verification="NO">NO</div>
                                <div class="category-option" data-verification="YES">YES</div>
                            </div>
                        </div>
                        
                        <div id="upgrade-admin-container" style="display: none;">
                            <button type="button" class="upgrade-admin-btn" id="upgrade-admin-btn">
                                <i class="fab fa-telegram"></i> Add @${this.appConfig.BOT_USERNAME} as admin
                            </button>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-chart-line"></i> Completions
                            </label>
                            <div class="completions-selector">
                                ${completionsOptions.map(opt => {
                                    const price = opt === 250 ? 250 : Math.floor(opt / 100) * this.appConfig.TASK_PRICE_PER_100_COMPLETIONS;
                                    return `
                                        <div class="completion-option ${opt === 100 ? 'active' : ''}" data-completions="${opt}" data-price="${price}">${opt}</div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                        
                        <div class="price-info">
                            <span class="price-label">Total Price:</span>
                            <span class="price-value" id="total-price">100 POP</span>
                        </div>
                        
                        <div class="task-message" id="task-message" style="display: none;"></div>
                        
                        <button type="button" class="pay-task-btn" id="pay-task-btn">
                            <i class="fas fa-coins"></i> Pay 100 POP
                        </button>
                    </form>
                </div>
                
                <div id="mytasks-tab" class="task-modal-body" style="display: none;">
                    <div class="my-tasks-list" id="my-tasks-list">
                        ${this.renderMyTasks()}
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const closeBtn = document.getElementById('task-modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.remove();
            });
        }
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        this.setupTaskModalEvents(modal, completionsOptions);
    }

    renderMyTasks() {
        if (!this.userCreatedTasks || this.userCreatedTasks.length === 0) {
            return `
                <div class="no-data">
                    <i class="fas fa-tasks"></i>
                    <p>No tasks created yet</p>
                    <p class="hint">Create your first task to earn POP!</p>
                </div>
            `;
        }
        
        return this.userCreatedTasks.map(task => {
            const currentCompletions = task.currentCompletions || 0;
            const maxCompletions = task.maxCompletions || 100;
            const progress = (currentCompletions / maxCompletions) * 100;
            const verification = task.verification === 'YES' ? '🔒' : '🔓';
            
            return `
                <div class="my-task-item" data-task-id="${task.id}">
                    <div class="my-task-header">
                        <div class="my-task-avatar">
                            <img src="${this.appConfig.BOT_AVATAR}" alt="Task">
                        </div>
                        <div class="my-task-info">
                            <div class="my-task-name">${task.name} ${verification}</div>
                            <div class="my-task-category">Verification: ${task.verification || 'NO'}</div>
                        </div>
                    </div>
                    
                    <div class="my-task-progress">
                        <div class="progress-header">
                            <span>Progress</span>
                            <span>${currentCompletions}/${maxCompletions}</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    setupTaskModalEvents(modal, completionsOptions) {
        const tabs = modal.querySelectorAll('.task-modal-tab');
        const addTab = modal.querySelector('#add-task-tab');
        const myTasksTab = modal.querySelector('#mytasks-tab');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                if (tab.dataset.tab === 'add') {
                    addTab.style.display = 'block';
                    myTasksTab.style.display = 'none';
                } else {
                    addTab.style.display = 'none';
                    myTasksTab.style.display = 'block';
                }
            });
        });
        
        const verificationOptions = modal.querySelectorAll('#verification-selector .category-option');
        const upgradeContainer = modal.querySelector('#upgrade-admin-container');
        const upgradeBtn = modal.querySelector('#upgrade-admin-btn');
        
        verificationOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                verificationOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                
                if (opt.dataset.verification === 'YES') {
                    upgradeContainer.style.display = 'block';
                } else {
                    upgradeContainer.style.display = 'none';
                }
            });
        });
        
        if (upgradeBtn) {
            upgradeBtn.addEventListener('click', () => {
                const url = `https://t.me/${this.appConfig.BOT_USERNAME}?startchannel=Commands&admin=invite_users`;
                window.open(url, '_blank');
            });
        }
        
        const completionOptions = modal.querySelectorAll('.completion-option');
        const totalPriceSpan = modal.querySelector('#total-price');
        const payBtn = modal.querySelector('#pay-task-btn');
        const messageDiv = modal.querySelector('#task-message');
        
        completionOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                completionOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                
                const price = parseInt(opt.dataset.price);
                totalPriceSpan.textContent = `${price} POP`;
                payBtn.innerHTML = `<i class="fas fa-coins"></i> Pay ${price} POP`;
                
                const userPOP = this.safeNumber(this.userState.pop);
                if (userPOP < price) {
                    payBtn.disabled = true;
                } else {
                    payBtn.disabled = false;
                }
            });
        });
        
        payBtn.addEventListener('click', async () => {
            await this.handleCreateTask(modal);
        });
        
        const taskLinkInput = modal.querySelector('#task-link');
        if (taskLinkInput) {
            taskLinkInput.addEventListener('input', () => {
                const value = taskLinkInput.value.trim();
                if (value && !value.startsWith('https://t.me/')) {
                    this.showMessage(modal, 'Task link must start with https://t.me/', 'error');
                } else {
                    messageDiv.style.display = 'none';
                }
            });
        }
    }

    showMessage(modal, text, type) {
        const messageDiv = modal.querySelector('#task-message');
        if (messageDiv) {
            messageDiv.textContent = text;
            messageDiv.className = `task-message ${type}`;
            messageDiv.style.display = 'block';
        }
    }

    async handleCreateTask(modal) {
        try {
            const taskName = modal.querySelector('#task-name').value.trim();
            const taskLink = modal.querySelector('#task-link').value.trim();
            const verification = modal.querySelector('#verification-selector .category-option.active').dataset.verification;
            const completions = parseInt(modal.querySelector('.completion-option.active').dataset.completions);
            
            if (!taskName || !taskLink) {
                this.showMessage(modal, 'Please fill all fields', 'error');
                return;
            }
            
            if (taskName.length > 15) {
                this.showMessage(modal, 'Task name must be 15 characters or less', 'error');
                return;
            }
            
            if (!taskLink.startsWith('https://t.me/')) {
                this.showMessage(modal, 'Task link must start with https://t.me/', 'error');
                return;
            }
            
            const price = completions === 250 ? 250 : Math.floor(completions / 100) * this.appConfig.TASK_PRICE_PER_100_COMPLETIONS;
            const userPOP = this.safeNumber(this.userState.pop);
            
            if (userPOP < price) {
                this.showMessage(modal, 'Insufficient POP balance', 'error');
                return;
            }
            
            const payBtn = modal.querySelector('#pay-task-btn');
            const originalText = payBtn.innerHTML;
            payBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Creating...';
            payBtn.disabled = true;
            
            try {
                if (verification === 'YES' && this.botToken) {
                    const chatId = this.taskManager.extractChatIdFromUrl(taskLink);
                    if (chatId) {
                        const isBotAdmin = await this.checkBotAdminStatus(chatId);
                        if (!isBotAdmin) {
                            this.showMessage(modal, 'Please add the bot as an admin first!', 'error');
                            payBtn.innerHTML = originalText;
                            payBtn.disabled = false;
                            return;
                        }
                    }
                }
                
                const currentTime = this.getServerTime();
                const taskData = {
                    name: taskName,
                    url: taskLink,
                    category: 'social',
                    type: 'channel',
                    verification: verification,
                    maxCompletions: completions,
                    currentCompletions: 0,
                    status: 'active',
                    taskStatus: 'active',
                    reward: 0.0001,
                    popReward: 1,
                    createdBy: this.tgUser.id,
                    owner: this.tgUser.id,
                    createdAt: currentTime,
                    picture: this.appConfig.BOT_AVATAR
                };
                
                if (this.db) {
                    const taskRef = await this.db.ref(`config/userTasks/${this.tgUser.id}`).push(taskData);
                    const taskId = taskRef.key;
                    
                    await this.db.ref(`userTasks/${this.tgUser.id}/${taskId}`).set({
                        ...taskData,
                        id: taskId
                    });
                    
                    const newPOP = userPOP - price;
                    await this.db.ref(`users/${this.tgUser.id}`).update({
                        pop: newPOP,
                        lastUpdated: currentTime
                    });
                    
                    this.userState.pop = newPOP;
                    
                    await this.loadUserCreatedTasks();
                    
                    const myTasksList = modal.querySelector('#my-tasks-list');
                    if (myTasksList) {
                        myTasksList.innerHTML = this.renderMyTasks();
                    }
                    
                    this.showMessage(modal, `Task created! Cost: ${price} POP`, 'success');
                    
                    setTimeout(() => {
                        const messageDiv = modal.querySelector('#task-message');
                        if (messageDiv) {
                            messageDiv.style.display = 'none';
                        }
                    }, 3000);
                    
                    this.updateHeader();
                }
                
            } catch (error) {
                this.showMessage(modal, 'Failed to create task', 'error');
            } finally {
                payBtn.innerHTML = originalText;
                payBtn.disabled = false;
            }
            
        } catch (error) {
            this.showMessage(modal, 'Failed to create task', 'error');
        }
    }

    async checkBotAdminStatus(chatId) {
        try {
            if (!this.botToken || !chatId) return false;
            
            const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getChatAdministrators`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId })
            });
            
            if (!response.ok) return false;
            
            const data = await response.json();
            if (data.ok && data.result) {
                const admins = data.result;
                const botUsername = this.appConfig.BOT_USERNAME.replace('@', '');
                const isBotAdmin = admins.some(admin => {
                    return admin.user?.is_bot && admin.user?.username === botUsername;
                });
                return isBotAdmin;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    initializeInAppAds() {
        if (this.inAppAdsInitialized) return;
        
        try {
            if (typeof window.AdBlock1 !== 'undefined') {
                this.inAppAdsInitialized = true;
                
                this.nextAdInterval = 60000;
                
                setTimeout(() => {
                    this.showInAppAd();
                    
                    if (this.inAppAdsTimer) {
                        clearInterval(this.inAppAdsTimer);
                    }
                    
                    const showNextAd = () => {
                        this.showInAppAd();
                        this.nextAdInterval *= 2;
                        setTimeout(showNextAd, this.nextAdInterval);
                    };
                    
                    setTimeout(showNextAd, this.nextAdInterval);
                    
                }, this.appConfig.INITIAL_AD_DELAY);
            }
        } catch (error) {}
    }
    
    showInAppAd() {
        if (typeof window.AdBlock1 !== 'undefined') {
            window.AdBlock1.show().catch(() => {});
        }
    }

    async initializeFirebase() {
        try {
            if (typeof firebase === 'undefined') {
                throw new Error('Firebase SDK not loaded');
            }
            
            const response = await fetch('/api/firebase-config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-telegram-user': this.tgUser?.id?.toString() || '',
                    'x-telegram-auth': this.tg?.initData || ''
                }
            });
            
            let firebaseConfig;
            
            if (response.ok) {
                const result = await response.json();
                if (result.encrypted) {
                    const decoded = atob(result.encrypted);
                    firebaseConfig = JSON.parse(decoded);
                } else {
                    firebaseConfig = result;
                }
            } else {
                throw new Error('Failed to fetch Firebase config');
            }
            
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
            
            try {
                await this.auth.signInAnonymously();
            } catch (authError) {
                const randomEmail = `user_${this.tgUser.id}_${Date.now()}@popbuzz.app`;
                const randomPassword = Math.random().toString(36).slice(-10) + Date.now().toString(36);
                
                await this.auth.createUserWithEmailAndPassword(randomEmail, randomPassword);
            }
            
            await new Promise((resolve, reject) => {
                const unsubscribe = this.auth.onAuthStateChanged((user) => {
                    if (user) {
                        unsubscribe();
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
            return false;
        }
    }

    setupFirebaseAuth() {
        if (!this.auth) return;
        
        this.auth.onAuthStateChanged(async (user) => {
            if (user) {
                this.currentUser = user;
                
                if (this.userState.firebaseUid !== user.uid) {
                    this.userState.firebaseUid = user.uid;
                    await this.syncUserWithFirebase();
                }
            } else {
                try {
                    await this.auth.signInAnonymously();
                } catch (error) {}
            }
        });
    }

    async syncUserWithFirebase() {
        try {
            if (!this.db || !this.auth.currentUser) {
                return;
            }
            
            const firebaseUid = this.auth.currentUser.uid;
            const telegramId = this.tgUser.id;
            
            const userRef = this.db.ref(`users/${telegramId}`);
            const userSnapshot = await userRef.once('value');
            
            if (!userSnapshot.exists()) {
                const userData = {
                    ...this.getDefaultUserState(),
                    firebaseUid: firebaseUid,
                    telegramId: telegramId,
                    deviceId: this.deviceId,
                    createdAt: this.getServerTime(),
                    lastUpdated: this.getServerTime()
                };
                
                await userRef.set(userData);
                
                if (this.pendingReferralAfterWelcome) {
                    await this.referralManager.registerReferral(telegramId, this.pendingReferralAfterWelcome);
                    this.pendingReferralAfterWelcome = null;
                }
            } else {
                await userRef.update({
                    firebaseUid: firebaseUid,
                    deviceId: this.deviceId,
                    lastUpdated: this.getServerTime()
                });
            }
            
        } catch (error) {}
    }

    async loadUserData(forceRefresh = false) {
        const cacheKey = `user_${this.tgUser.id}`;
        
        if (!forceRefresh) {
            const cachedData = this.cache.get(cacheKey);
            if (cachedData) {
                this.userState = cachedData;
                this.userPOP = this.safeNumber(cachedData.pop);
                this.userPopEarnings = this.safeNumber(cachedData.popEarnings);
                this.userTasksCompletedCount = this.safeNumber(cachedData.tasksCompletedCount);
                this.lastDailyCheckin = cachedData.lastDailyCheckin || 0;
                this.totalCheckins = cachedData.totalCheckins || 0;
                this.lastNewsTask = cachedData.lastNewsTask || 0;
                
                if (cachedData.lastDailyCheckin) {
                    const checkinDate = new Date(cachedData.lastDailyCheckin).toDateString();
                    const today = new Date().toDateString();
                    if (checkinDate === today) {
                        this.lastDailyCheckinDate = today;
                    }
                }
                
                this.updateHeader();
                return;
            }
        }
        
        try {
            if (!this.db || !this.firebaseInitialized || !this.auth?.currentUser) {
                throw new Error('Database not ready');
            }
            
            const telegramId = this.tgUser.id;
            
            const userRef = this.db.ref(`users/${telegramId}`);
            const userSnapshot = await userRef.once('value');
            
            let userData;
            
            if (userSnapshot.exists()) {
                userData = userSnapshot.val();
                userData = await this.updateExistingUser(userRef, userData);
            } else {
                userData = await this.createNewUser(userRef);
            }
            
            if (userData.firebaseUid !== this.auth.currentUser.uid) {
                await userRef.update({
                    firebaseUid: this.auth.currentUser.uid,
                    lastUpdated: this.getServerTime()
                });
                userData.firebaseUid = this.auth.currentUser.uid;
            }
            
            this.userState = userData;
            this.userPOP = this.safeNumber(userData.pop);
            this.userPopEarnings = this.safeNumber(userData.popEarnings);
            this.userTasksCompletedCount = this.safeNumber(userData.tasksCompletedCount);
            this.userCompletedTasks = new Set(userData.completedTasks || []);
            this.lastDailyCheckin = userData.lastDailyCheckin || 0;
            this.totalCheckins = userData.totalCheckins || 0;
            this.lastNewsTask = userData.lastNewsTask || 0;
            
            if (userData.lastDailyCheckin) {
                const checkinDate = new Date(userData.lastDailyCheckin).toDateString();
                const today = new Date().toDateString();
                if (checkinDate === today) {
                    this.lastDailyCheckinDate = today;
                }
            }
            
            this.cache.set(cacheKey, userData, 60000);
            this.updateHeader();
            
        } catch (error) {
            throw new Error('Failed to load user data');
        }
    }

    getDefaultUserState() {
        return {
            id: this.tgUser.id,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            telegramId: this.tgUser.id,
            firstName: this.getShortName(this.tgUser.first_name || 'User'),
            photoUrl: this.tgUser.photo_url || this.appConfig.DEFAULT_USER_AVATAR,
            balance: 0,
            pop: 0,
            popEarnings: 0,
            tasksCompletedCount: 0,
            referrals: 0,
            totalEarned: 0,
            totalWithdrawals: 0,
            totalTasksCompleted: 0,
            referralEarnings: 0,
            lastDailyCheckin: 0,
            totalCheckins: 0,
            lastNewsTask: 0,
            status: 'free',
            lastUpdated: this.getServerTime(),
            firebaseUid: this.auth?.currentUser?.uid || 'pending',
            totalWithdrawnAmount: 0,
            completedTasks: [],
            deviceId: this.deviceId
        };
    }

    async createNewUser(userRef) {
        let referralId = null;
        const startParam = this.tg?.initDataUnsafe?.start_param;
        
        if (startParam) {
            referralId = this.extractReferralId(startParam);
            
            if (referralId && referralId > 0 && referralId !== this.tgUser.id) {
                const referrerRef = this.db.ref(`users/${referralId}`);
                const referrerSnapshot = await referrerRef.once('value');
                if (referrerSnapshot.exists()) {
                    this.pendingReferralAfterWelcome = referralId;
                } else {
                    referralId = null;
                }
            } else {
                referralId = null;
            }
        }
        
        const currentTime = this.getServerTime();
        const firebaseUid = this.auth?.currentUser?.uid || 'pending';
        
        const userData = {
            id: this.tgUser.id,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            telegramId: this.tgUser.id,
            firstName: this.getShortName(this.tgUser.first_name || ''),
            photoUrl: this.tgUser.photo_url || this.appConfig.DEFAULT_USER_AVATAR,
            balance: 0,
            pop: 0,
            popEarnings: 0,
            tasksCompletedCount: 0,
            referrals: 0,
            referredBy: referralId,
            totalEarned: 0,
            totalWithdrawals: 0,
            totalTasksCompleted: 0,
            referralEarnings: 0,
            completedTasks: [],
            lastDailyCheckin: 0,
            totalCheckins: 0,
            lastNewsTask: 0,
            createdAt: currentTime,
            lastUpdated: currentTime,
            status: 'free',
            firebaseUid: firebaseUid,
            totalWithdrawnAmount: 0,
            deviceId: this.deviceId,
        };
        
        await userRef.set(userData);
        
        await this.db.ref(`devices/${this.deviceId}`).update({
            ownerId: this.tgUser.id,
            lastSeen: this.getServerTime()
        });
        
        try {
            await this.updateAppStats('totalUsers', 1);
        } catch (statsError) {}
        
        if (referralId) {
            await this.referralManager.registerReferral(this.tgUser.id, referralId);
        }
        
        return userData;
    }

    async updateExistingUser(userRef, userData) {
        const currentTime = this.getServerTime();
        const today = new Date().toDateString();
        
        await userRef.update({ 
            lastUpdated: currentTime,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            firstName: userData.firstName || this.getShortName(this.tgUser.first_name || 'User'),
            deviceId: this.deviceId
        });
        
        if (userData.completedTasks && Array.isArray(userData.completedTasks)) {
            this.userCompletedTasks = new Set(userData.completedTasks);
        } else {
            this.userCompletedTasks = new Set();
            userData.completedTasks = [];
            await userRef.update({ completedTasks: [] });
        }
        
        const defaultData = {
            lastDailyCheckin: userData.lastDailyCheckin || 0,
            totalCheckins: userData.totalCheckins || 0,
            lastNewsTask: userData.lastNewsTask || 0,
            status: userData.status || 'free',
            referralEarnings: userData.referralEarnings || 0,
            totalEarned: userData.totalEarned || 0,
            totalWithdrawals: userData.totalWithdrawals || 0,
            totalTasksCompleted: userData.totalTasksCompleted || 0,
            balance: userData.balance || 0,
            pop: userData.pop || 0,
            popEarnings: userData.popEarnings || 0,
            tasksCompletedCount: userData.tasksCompletedCount || 0,
            referrals: userData.referrals || 0,
            firebaseUid: this.auth?.currentUser?.uid || userData.firebaseUid || 'pending',
            totalWithdrawnAmount: userData.totalWithdrawnAmount || 0,
            deviceId: this.deviceId
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

    async processTaskCompletion(taskId, task, button) {
        try {
            if (!this.db) {
                throw new Error("Database not initialized");
            }
            
            if (this.userCompletedTasks.has(taskId)) {
                this.showNotification("Already Completed", "This task was already completed", "info");
                this.enableAllTaskButtons();
                this.isProcessingTask = false;
                return false;
            }
            
            const taskReward = this.safeNumber(task.reward);
            const taskPopReward = this.safeNumber(task.popReward || 1);
            
            const currentBalance = this.safeNumber(this.userState.balance);
            const currentPOP = this.safeNumber(this.userState.pop);
            const currentPopEarnings = this.safeNumber(this.userState.popEarnings);
            const totalEarned = this.safeNumber(this.userState.totalEarned);
            const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted);
            const tasksCompletedCount = this.safeNumber(this.userState.tasksCompletedCount);
            
            const updates = {
                balance: currentBalance + taskReward,
                pop: currentPOP + taskPopReward,
                popEarnings: currentPopEarnings + taskPopReward,
                totalEarned: totalEarned + taskReward,
                totalTasksCompleted: totalTasksCompleted + 1,
                tasksCompletedCount: tasksCompletedCount + 1,
                lastUpdated: this.getServerTime()
            };
            
            this.userCompletedTasks.add(taskId);
            updates.completedTasks = [...this.userCompletedTasks];
            
            await this.db.ref(`users/${this.tgUser.id}`).update(updates);
            
            if (task.owner) {
                const ownerRef = this.db.ref(`config/userTasks/${task.owner}/${taskId}`);
                const ownerSnapshot = await ownerRef.once('value');
                
                if (ownerSnapshot.exists()) {
                    const currentCompletions = ownerSnapshot.val().currentCompletions || 0;
                    const newCompletions = currentCompletions + 1;
                    
                    if (newCompletions >= task.maxCompletions) {
                        await ownerRef.update({
                            currentCompletions: newCompletions,
                            status: 'completed',
                            taskStatus: 'completed'
                        });
                    } else {
                        await ownerRef.update({
                            currentCompletions: newCompletions
                        });
                    }
                    
                    await this.db.ref(`userTasks/${task.owner}/${taskId}`).update({
                        currentCompletions: newCompletions
                    });
                }
            } else {
                const taskRef = this.db.ref(`config/tasks/${taskId}`);
                const taskSnapshot = await taskRef.once('value');
                
                if (taskSnapshot.exists()) {
                    const currentCompletions = taskSnapshot.val().currentCompletions || 0;
                    const newCompletions = currentCompletions + 1;
                    
                    if (newCompletions >= task.maxCompletions) {
                        await taskRef.update({
                            currentCompletions: newCompletions,
                            status: 'completed',
                            taskStatus: 'completed'
                        });
                    } else {
                        await taskRef.update({
                            currentCompletions: newCompletions
                        });
                    }
                }
            }
            
            this.userState.balance = currentBalance + taskReward;
            this.userState.pop = currentPOP + taskPopReward;
            this.userState.popEarnings = currentPopEarnings + taskPopReward;
            this.userState.totalEarned = totalEarned + taskReward;
            this.userState.totalTasksCompleted = totalTasksCompleted + 1;
            this.userState.tasksCompletedCount = tasksCompletedCount + 1;
            this.userState.completedTasks = [...this.userCompletedTasks];
            
            if (button) {
                const taskCard = document.getElementById(`task-${taskId}`);
                if (taskCard) {
                    const taskBtn = taskCard.querySelector('.task-btn');
                    if (taskBtn) {
                        taskBtn.innerHTML = '<i class="fas fa-check"></i>';
                        taskBtn.className = 'task-btn completed';
                        taskBtn.disabled = true;
                        taskCard.classList.add('task-completed');
                    }
                }
            }
            
            this.updateHeader();
            
            await this.updateAppStats('totalTasks', 1);
            
            this.cache.delete(`tasks_${this.tgUser.id}`);
            this.cache.delete(`user_${this.tgUser.id}`);
            
            if (task.owner && task.owner === this.tgUser.id) {
                await this.loadUserCreatedTasks();
            }
            
            if (this.userState.referredBy && this.rewardsConfig.REFERRAL_PERCENTAGE > 0) {
                await this.processReferralTaskBonus(this.userState.referredBy, taskReward);
            }
            
            this.enableAllTaskButtons();
            this.isProcessingTask = false;
            
            this.showNotification("Task Completed!", `+${taskReward.toFixed(4)} TON, +${taskPopReward} POP`, "success");
            
            return true;
            
        } catch (error) {
            this.enableAllTaskButtons();
            this.isProcessingTask = false;
            
            this.showNotification("Error", "Failed to complete task", "error");
            
            if (button) {
                button.innerHTML = '<i class="fas fa-arrow-right"></i>';
                button.disabled = false;
                button.classList.remove('check');
                button.classList.add('start');
            }
            
            throw error;
        }
    }

    async processReferralTaskBonus(referrerId, taskReward) {
        try {
            if (!this.db) return;
            if (!referrerId || referrerId === this.tgUser.id) return;
            if (this.rewardsConfig.REFERRAL_PERCENTAGE <= 0) return;
            
            const referrerRef = this.db.ref(`users/${referrerId}`);
            const referrerSnapshot = await referrerRef.once('value');
            
            if (!referrerSnapshot.exists()) return;
            
            const referrerData = referrerSnapshot.val();
            
            if (referrerData.status === 'ban') return;
            
            const referralPercentage = this.rewardsConfig.REFERRAL_PERCENTAGE;
            const referralBonus = (taskReward * referralPercentage) / 100;
            
            if (referralBonus <= 0) return;
            
            const newBalance = this.safeNumber(referrerData.balance) + referralBonus;
            const newReferralEarnings = this.safeNumber(referrerData.referralEarnings) + referralBonus;
            const newTotalEarned = this.safeNumber(referrerData.totalEarned) + referralBonus;
            
            await referrerRef.update({
                balance: newBalance,
                referralEarnings: newReferralEarnings,
                totalEarned: newTotalEarned,
                lastUpdated: this.getServerTime()
            });
            
            if (referrerId === this.tgUser.id) {
                this.userState.balance = newBalance;
                this.userState.referralEarnings = newReferralEarnings;
                this.userState.totalEarned = newTotalEarned;
                
                this.updateHeader();
            }
            
        } catch (error) {}
    }

    async handlePromoCode() {
        const promoInput = document.getElementById('promo-input');
        const promoBtn = document.getElementById('promo-btn');
        
        if (!promoInput || !promoBtn) return;
        
        const code = promoInput.value.trim().toUpperCase();
        if (!code) {
            this.showNotification("Promo Code", "Please enter a promo code", "warning");
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'promo_code');
        if (!rateLimitCheck.allowed) {
            this.showNotification("Rate Limit", `Please wait ${rateLimitCheck.remaining} seconds`, "warning");
            return;
        }
        
        let adShown = false;
        
        if (typeof window.AdBlock2 !== 'undefined') {
            try {
                await window.AdBlock2.show();
                adShown = true;
            } catch (error) {}
        }
        
        if (!adShown) {
            this.showNotification("Ad Required", "Please watch the ad to apply promo code", "info");
            return;
        }
        
        this.rateLimiter.addRequest(this.tgUser.id, 'promo_code');
        
        const originalText = promoBtn.innerHTML;
        promoBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Checking...';
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
                this.showNotification("Promo Code", "Invalid promo code", "error");
                promoBtn.innerHTML = originalText;
                promoBtn.disabled = false;
                return;
            }
            
            if (this.db) {
                const usedRef = await this.db.ref(`usedPromoCodes/${this.tgUser.id}/${promoData.id}`).once('value');
                if (usedRef.exists()) {
                    this.showNotification("Promo Code", "You have already used this code", "error");
                    promoBtn.innerHTML = originalText;
                    promoBtn.disabled = false;
                    return;
                }
            }
            
            let rewardType = promoData.rewardType || 'ton';
            let rewardAmount = this.safeNumber(promoData.reward || 0.01);
            
            const userUpdates = {};
            const currentTime = this.getServerTime();
            
            if (rewardType === 'ton') {
                const currentBalance = this.safeNumber(this.userState.balance);
                userUpdates.balance = currentBalance + rewardAmount;
                userUpdates.totalEarned = this.safeNumber(this.userState.totalEarned) + rewardAmount;
            } else if (rewardType === 'pop') {
                const currentPOP = this.safeNumber(this.userState.pop);
                const currentPopEarnings = this.safeNumber(this.userState.popEarnings);
                userUpdates.pop = currentPOP + rewardAmount;
                userUpdates.popEarnings = currentPopEarnings + rewardAmount;
            }
            
            userUpdates.totalPromoCodes = this.safeNumber(this.userState.totalPromoCodes) + 1;
            userUpdates.lastUpdated = currentTime;
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update(userUpdates);
                
                await this.db.ref(`usedPromoCodes/${this.tgUser.id}/${promoData.id}`).set({
                    code: code,
                    reward: rewardAmount,
                    rewardType: rewardType,
                    claimedAt: currentTime
                });
                
                await this.db.ref(`config/promoCodes/${promoData.id}/usedCount`).transaction(current => (current || 0) + 1);
            }
            
            if (rewardType === 'ton') {
                this.userState.balance = userUpdates.balance;
                this.userState.totalEarned = userUpdates.totalEarned;
            } else if (rewardType === 'pop') {
                this.userState.pop = userUpdates.pop;
                this.userState.popEarnings = userUpdates.popEarnings;
            }
            this.userState.totalPromoCodes = userUpdates.totalPromoCodes;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            promoInput.value = '';
            
            this.showNotification("Success", `Promo code applied! +${rewardAmount.toFixed(5)} ${rewardType === 'ton' ? 'TON' : 'POP'}`, "success");
            
        } catch (error) {
            this.showNotification("Error", "Failed to apply promo code", "error");
        } finally {
            promoBtn.innerHTML = originalText;
            promoBtn.disabled = false;
        }
    }

    async handleProfileWithdrawal(walletInput, amountInput, withdrawBtn) {
        if (!walletInput || !amountInput || !withdrawBtn) return;
        
        const originalBalance = this.safeNumber(this.userState.balance);
        
        const walletAddress = walletInput.value.trim();
        const amount = parseFloat(amountInput.value);
        const userBalance = this.safeNumber(this.userState.balance);
        const minimumWithdraw = this.requirementsConfig.MINIMUM_WITHDRAW;
        
        const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted || 0);
        const requiredTasks = this.requirementsConfig.REQUIRED_TASKS_FOR_WITHDRAWAL;
        const totalReferrals = this.safeNumber(this.userState.referrals || 0);
        const requiredReferrals = this.requirementsConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL;
        const totalPOP = this.safeNumber(this.userState.popEarnings || 0);
        const requiredPOP = this.requirementsConfig.REQUIRED_POP_FOR_WITHDRAWAL;
        
        if (!walletAddress || walletAddress.length < 20) {
            this.showNotification("Error", "Please enter a valid TON wallet address", "error");
            return;
        }
        
        if (!amount || amount < minimumWithdraw) {
            this.showNotification("Error", `Minimum withdrawal is ${minimumWithdraw.toFixed(3)} TON`, "error");
            return;
        }
        
        if (amount > userBalance) {
            this.showNotification("Error", "Insufficient balance", "error");
            return;
        }
        
        if (totalTasksCompleted < requiredTasks) {
            const tasksNeeded = requiredTasks - totalTasksCompleted;
            this.showNotification("Tasks Required", `You need to complete ${tasksNeeded} more tasks to withdraw`, "error");
            return;
        }
        
        if (totalReferrals < requiredReferrals) {
            const referralsNeeded = requiredReferrals - totalReferrals;
            this.showNotification("Referrals Required", `You need to invite ${referralsNeeded} more friend${referralsNeeded > 1 ? 's' : ''} to withdraw`, "error");
            return;
        }
        
        if (totalPOP < requiredPOP) {
            const popNeeded = requiredPOP - totalPOP;
            this.showNotification("POP Required", `You need to earn ${popNeeded} more POP to withdraw`, "error");
            return;
        }
        
        let adShown = false;
        
        if (typeof window.AdBlock2 !== 'undefined') {
            try {
                await window.AdBlock2.show();
                adShown = true;
            } catch (error) {}
        }
        
        if (!adShown) {
            this.showNotification("Ad Required", "Please watch the ad to process withdrawal", "info");
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'withdrawal');
        if (!rateLimitCheck.allowed) {
            this.showNotification("Rate Limit", "You can only withdraw once per day. Please try again tomorrow.", "warning");
            return;
        }
        
        this.rateLimiter.addRequest(this.tgUser.id, 'withdrawal');
        
        const originalText = withdrawBtn.innerHTML;
        withdrawBtn.disabled = true;
        withdrawBtn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Processing...';
        
        try {
            const newBalance = userBalance - amount;
            const newPopEarnings = totalPOP - requiredPOP;
            const newTasksCompletedCount = totalTasksCompleted - requiredTasks;
            const currentTime = this.getServerTime();
            const newTotalWithdrawnAmount = this.safeNumber(this.userState.totalWithdrawnAmount) + amount;
            const randomId = Math.random().toString(36).substring(2, 7).toUpperCase();
            const withdrawalId = `POP_${randomId}`;
            
            const withdrawalData = {
                id: withdrawalId,
                userId: this.tgUser.id,
                walletAddress: walletAddress,
                amount: amount,
                status: 'pending',
                timestamp: currentTime,
                userName: this.userState.firstName,
                username: this.userState.username
            };
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update({
                    balance: newBalance,
                    popEarnings: newPopEarnings,
                    tasksCompletedCount: newTasksCompletedCount,
                    totalWithdrawals: this.safeNumber(this.userState.totalWithdrawals) + 1,
                    totalWithdrawnAmount: newTotalWithdrawnAmount,
                    lastUpdated: currentTime
                });
                
                await this.db.ref(`withdrawals/pending/${this.tgUser.id}/${withdrawalId}`).set(withdrawalData);
                
                this.userState.balance = newBalance;
                this.userState.popEarnings = newPopEarnings;
                this.userState.tasksCompletedCount = newTasksCompletedCount;
                this.userState.totalWithdrawals = this.safeNumber(this.userState.totalWithdrawals) + 1;
                this.userState.totalWithdrawnAmount = newTotalWithdrawnAmount;
                
                this.userWithdrawals.unshift({
                    ...withdrawalData,
                    status: 'pending'
                });
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                await this.updateAppStats('totalWithdrawals', 1);
                await this.updateAppStats('totalPayments', amount);
                
                walletInput.value = '';
                amountInput.value = '';
                
                this.updateHeader();
                this.renderProfilePage();
                
                this.showNotification("Success", "Withdrawal request submitted!", "success");
            }
            
        } catch (error) {
            if (this.userState.balance !== originalBalance) {
                this.userState.balance = originalBalance;
            }
            
            this.showNotification("Error", "Failed to process withdrawal. No changes were made to your balance.", "error");
            
            withdrawBtn.disabled = false;
            withdrawBtn.innerHTML = originalText;
        }
    }

    async loadHistoryData() {
        try {
            if (!this.db || !this.auth?.currentUser) {
                this.userWithdrawals = [];
                return;
            }
            
            const telegramId = this.tgUser.id;
            
            const pendingWithdrawals = [];
            const pendingRef = await this.db.ref(`withdrawals/pending/${telegramId}`).once('value');
            if (pendingRef.exists()) {
                pendingRef.forEach(child => {
                    const withdrawal = child.val();
                    pendingWithdrawals.push({
                        id: child.key,
                        ...withdrawal,
                        status: 'pending'
                    });
                });
            }
            
            const completedWithdrawals = [];
            const completedRef = await this.db.ref(`withdrawals/completed/${telegramId}`).once('value');
            if (completedRef.exists()) {
                completedRef.forEach(child => {
                    const withdrawal = child.val();
                    completedWithdrawals.push({
                        id: child.key,
                        ...withdrawal,
                        status: 'completed'
                    });
                });
            }
            
            const rejectedWithdrawals = [];
            const rejectedRef = await this.db.ref(`withdrawals/rejected/${telegramId}`).once('value');
            if (rejectedRef.exists()) {
                rejectedRef.forEach(child => {
                    const withdrawal = child.val();
                    rejectedWithdrawals.push({
                        id: child.key,
                        ...withdrawal,
                        status: 'rejected'
                    });
                });
            }
            
            this.userWithdrawals = [
                ...pendingWithdrawals,
                ...completedWithdrawals,
                ...rejectedWithdrawals
            ].sort((a, b) => b.timestamp - a.timestamp);
            
        } catch (error) {
            this.userWithdrawals = [];
        }
    }

    renderWithdrawalsHistory() {
        if (!this.userWithdrawals || this.userWithdrawals.length === 0) {
            return `
                <div class="no-data">
                    <i class="fas fa-history"></i>
                    <p>No withdrawal history</p>
                    <p class="hint">Your withdrawals will appear here</p>
                </div>
            `;
        }
        
        return this.userWithdrawals.map(withdrawal => {
            const statusClass = withdrawal.status || 'pending';
            const statusText = (withdrawal.status || 'pending').toUpperCase();
            const amount = this.safeNumber(withdrawal.amount);
            const timestamp = withdrawal.timestamp || withdrawal.createdAt || Date.now();
            
            return `
                <div class="history-item">
                    <div class="history-icon">
                        <img src="https://cdn-icons-png.flaticon.com/512/12114/12114247.png" alt="TON">
                    </div>
                    <div class="history-content">
                        <div class="history-header">
                            <span class="history-amount">-${amount.toFixed(3)} TON</span>
                            <span class="history-status ${statusClass}">${statusText}</span>
                        </div>
                        <div class="history-details">
                            <div class="history-detail">
                                <i class="fas fa-id-card"></i>
                                <span class="history-id">ID: ${withdrawal.id}</span>
                            </div>
                            <div class="history-detail">
                                <i class="fas fa-clock"></i>
                                <span>${this.formatDateTime(timestamp)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async loadTasksData() {
        try {
            if (this.taskManager) {
                await this.taskManager.loadTasksData();
                this.taskManager.userCompletedTasks = this.userCompletedTasks;
            }
        } catch (error) {}
    }

    renderTaskCard(task) {
        const isCompleted = this.userCompletedTasks.has(task.id);
        const defaultIcon = this.appConfig.BOT_AVATAR;
        const verificationIcon = task.verification === 'YES' ? '🔒' : '🔓';
        
        let buttonIcon = 'fa-arrow-right';
        let buttonClass = 'start';
        let isDisabled = isCompleted || this.isProcessingTask;
        
        if (isCompleted) {
            buttonIcon = 'fa-check';
            buttonClass = 'completed';
            isDisabled = true;
        }
        
        return `
            <div class="referral-row ${isCompleted ? 'task-completed' : ''}" id="task-${task.id}">
                <div class="referral-row-avatar">
                    <img src="${task.picture || defaultIcon}" alt="Task" 
                         oncontextmenu="return false;" 
                         ondragstart="return false;">
                </div>
                <div class="referral-row-info">
                    <p class="referral-row-username">${task.name} ${verificationIcon}</p>
                    <p class="task-description">Join & Earn TON</p>
                    <div class="task-rewards">
                        <span class="reward-badge">
                            <img src="https://cdn-icons-png.flaticon.com/512/12114/12114247.png" class="reward-icon" alt="TON">
                            ${task.reward.toFixed(4)}
                        </span>
                        <span class="reward-badge">
                            <img src="https://cdn-icons-png.flaticon.com/512/8074/8074685.png" class="reward-icon" alt="POP">
                            ${task.popReward || 1}
                        </span>
                    </div>
                </div>
                <div class="referral-row-status">
                    <button class="task-btn ${buttonClass}" 
                            data-task-id="${task.id}"
                            data-task-url="${task.url}"
                            data-task-verification="${task.verification || 'NO'}"
                            data-task-reward="${task.reward}"
                            data-task-pop="${task.popReward || 1}"
                            ${isDisabled ? 'disabled' : ''}>
                        <i class="fas ${buttonIcon}"></i>
                    </button>
                </div>
            </div>
        `;
    }

    renderProfilePage() {
        const profilePage = document.getElementById('profile-page');
        if (!profilePage) return;
        
        const joinDate = new Date(this.userState.createdAt || this.getServerTime());
        const formattedDate = this.formatDate(joinDate);
        
        const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted || 0);
        const totalReferrals = this.safeNumber(this.userState.referrals || 0);
        const totalPOP = this.safeNumber(this.userState.popEarnings || 0);
        const totalCheckins = this.safeNumber(this.userState.totalCheckins || 0);
        
        const tasksRequired = this.requirementsConfig.REQUIRED_TASKS_FOR_WITHDRAWAL;
        const referralsRequired = this.requirementsConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL;
        const popRequired = this.requirementsConfig.REQUIRED_POP_FOR_WITHDRAWAL;
        
        const tasksProgress = Math.min(totalTasksCompleted, tasksRequired);
        const referralsProgress = Math.min(totalReferrals, referralsRequired);
        const popProgress = Math.min(totalPOP, popRequired);
        
        const tasksCompleted = totalTasksCompleted >= tasksRequired;
        const referralsCompleted = totalReferrals >= referralsRequired;
        const popCompleted = totalPOP >= popRequired;
        
        const canWithdraw = tasksCompleted && referralsCompleted && popCompleted;
        
        const maxBalance = this.safeNumber(this.userState.balance);
        
        const depositComment = this.tgUser.id.toString(); 
        const directPayUrl = `https://app.tonkeeper.com/transfer/${this.appConfig.BOT_WALLET}?text=${depositComment}`;
        
        profilePage.innerHTML = `
            <div class="profile-container">
                <div class="profile-tabs">
                    <button class="profile-tab active" data-profile-tab="deposit-tab">
                        <i class="fas fa-arrow-down"></i> Deposit
                    </button>
                    <button class="profile-tab" data-profile-tab="exchange-tab">
                        <i class="fas fa-exchange-alt"></i> Exchange
                    </button>
                    <button class="profile-tab" data-profile-tab="withdraw-tab">
                        <i class="fas fa-wallet"></i> Withdraw
                    </button>
                </div>
                
                <div id="deposit-tab" class="profile-tab-content active">
                    <div class="deposit-card">
                        <div class="card-header">
                            <div class="card-icon">
                                <i class="fas fa-arrow-down"></i>
                            </div>
                            <div class="card-title">Deposit TON</div>
                        </div>
                        <div class="card-divider"></div>
                        
                        <div class="deposit-info">
                            <div class="deposit-row">
                                <span class="deposit-label">Wallet:</span>
                                <span class="deposit-value" id="deposit-wallet">${this.truncateAddress(this.appConfig.DEPOSIT_WALLET)}</span>
                                <button class="deposit-copy-btn" data-copy="wallet">
                                    <i class="far fa-copy"></i>
                                </button>
                            </div>
                            <div class="deposit-row">
                                <span class="deposit-label">Comment:</span>
                                <span class="deposit-value" id="deposit-comment">${depositComment}</span>
                                <button class="deposit-copy-btn" data-copy="comment">
                                    <i class="far fa-copy"></i>
                                </button>
                            </div>
                            <div class="deposit-actions">
                                <a href="${directPayUrl}" target="_blank" class="direct-pay-btn" id="direct-pay-btn">
                                    <i class="fas fa-bolt"></i> Direct Pay
                                </a>
                            </div>
                            <div class="deposit-note">
                                <i class="fas fa-info-circle"></i>
                                <span>Deposits processed within 1-24 hour</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div id="exchange-tab" class="profile-tab-content">
                    <div class="exchange-card">
                        <div class="card-header">
                            <div class="card-icon">
                                <i class="fas fa-exchange-alt"></i>
                            </div>
                            <div class="card-title">Exchange TON to POP</div>
                        </div>
                        <div class="card-divider"></div>
                        
                        <div class="exchange-mini-balance">
                            <div class="mini-balance-item">
                                <img src="https://cdn-icons-png.flaticon.com/512/12114/12114247.png" alt="TON">
                                <span>${this.safeNumber(this.userState.balance).toFixed(3)} TON</span>
                            </div>
                            <div class="mini-balance-item">
                                <img src="https://cdn-icons-png.flaticon.com/512/8074/8074685.png" alt="POP">
                                <span>${Math.floor(this.safeNumber(this.userState.pop))} POP</span>
                            </div>
                        </div>
                        
                        <div class="exchange-input-group">
                            <div class="amount-input-container">
                                <input type="number" id="exchange-input" class="form-input" 
                                       placeholder="TON amount" step="0.01" min="${this.appConfig.MIN_EXCHANGE_TON}">
                                <span class="exchange-preview" id="exchange-preview">≈ 0 POP</span>
                                <button type="button" class="max-btn" id="exchange-max-btn">MAX</button>
                            </div>
                            <button class="exchange-btn" id="exchange-btn">
                                <i class="fas fa-coins"></i> Exchange
                            </button>
                        </div>
                    </div>
                </div>
                
                <div id="withdraw-tab" class="profile-tab-content">
                    <div class="withdraw-card">
                        <div class="card-header">
                            <div class="card-icon">
                                <i class="fas fa-wallet"></i>
                            </div>
                            <div class="card-title">Withdraw TON</div>
                        </div>
                        <div class="card-divider"></div>
                        
                        <div class="requirements-section">
                            ${!tasksCompleted ? `
                            <div class="requirement-item">
                                <div class="requirement-header">
                                    <span><i class="fas fa-tasks"></i> Complete Tasks</span>
                                    <span class="requirement-count">${tasksProgress}/${tasksRequired}</span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${(tasksProgress/tasksRequired)*100}%"></div>
                                </div>
                            </div>
                            ` : ''}
                            
                            ${!referralsCompleted ? `
                            <div class="requirement-item">
                                <div class="requirement-header">
                                    <span><i class="fas fa-users"></i> Invite Friends</span>
                                    <span class="requirement-count">${referralsProgress}/${referralsRequired}</span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${(referralsProgress/referralsRequired)*100}%"></div>
                                </div>
                            </div>
                            ` : ''}
                            
                            ${!popCompleted ? `
                            <div class="requirement-item">
                                <div class="requirement-header">
                                    <span><i class="fas fa-star"></i> Earn POP</span>
                                    <span class="requirement-count">${popProgress}/${popRequired}</span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${(popProgress/popRequired)*100}%"></div>
                                </div>
                            </div>
                            ` : ''}
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label" for="profile-wallet-input">
                                <i class="fas fa-wallet"></i> TON Wallet Address
                            </label>
                            <input type="text" id="profile-wallet-input" class="form-input" 
                                   placeholder="Enter your TON wallet address (UQ...)"
                                   required>
                        </div>
                        
                        <div class="form-group amount-group">
                            <label class="form-label" for="profile-amount-input">
                                <i class="fas fa-gem"></i> Withdrawal Amount
                            </label>
                            <div class="amount-input-container">
                                <input type="number" id="profile-amount-input" class="form-input" 
                                       step="0.00001" min="${this.requirementsConfig.MINIMUM_WITHDRAW}" 
                                       max="${maxBalance}"
                                       placeholder="Min: ${this.requirementsConfig.MINIMUM_WITHDRAW.toFixed(3)} TON"
                                       required>
                                <button type="button" class="max-btn" id="max-btn">MAX</button>
                            </div>
                        </div>
                        
                        <div class="withdraw-minimum-info">
                            <i class="fas fa-info-circle"></i>
                            <span>Minimum Withdrawal: <strong>${this.requirementsConfig.MINIMUM_WITHDRAW.toFixed(3)} TON</strong></span>
                        </div>
                        
                        <button id="profile-withdraw-btn" class="withdraw-btn" 
                                ${!canWithdraw || maxBalance < this.requirementsConfig.MINIMUM_WITHDRAW ? 'disabled' : ''}>
                            <i class="fas fa-paper-plane"></i> 
                            ${canWithdraw ? 'WITHDRAW NOW' : this.getWithdrawButtonText(tasksCompleted, referralsCompleted, popCompleted)}
                        </button>
                    </div>
                    
                    <div class="history-section">
                        <div class="history-list" id="withdrawals-list">
                            ${this.renderWithdrawalsHistory()}
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        this.setupProfilePageEvents();
        
        const profileTabs = document.querySelectorAll('.profile-tab');
        const profileTabContents = document.querySelectorAll('.profile-tab-content');
        
        profileTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabId = tab.getAttribute('data-profile-tab');
                
                profileTabs.forEach(t => t.classList.remove('active'));
                profileTabContents.forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                const targetTab = document.getElementById(tabId);
                if (targetTab) {
                    targetTab.classList.add('active');
                }
            });
        });
    }

    showError(message) {
        document.body.innerHTML = `
            <div class="error-container">
                <div class="error-content">
                    <div class="error-header">
                        <div class="error-icon">
                            <i class="fab fa-telegram"></i>
                        </div>
                        <h2>POP BUZZ</h2>
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
                        <h2>Access Denied</h2>
                    </div>
                    
                    <div class="ban-reason">
                        <div class="ban-reason-icon">
                            <i class="fas fa-exclamation-circle"></i>
                        </div>
                        <p>This account has been blocked for security reasons. This block is permanent and cannot be reversed.</p>
                    </div>
                </div>
            </div>
        `;
    }

    getWithdrawButtonText(tasksCompleted, referralsCompleted, popCompleted) {
        if (!tasksCompleted) {
            return `COMPLETE ${this.requirementsConfig.REQUIRED_TASKS_FOR_WITHDRAWAL} TASKS`;
        }
        if (!referralsCompleted) {
            return `INVITE ${this.requirementsConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL} FRIEND`;
        }
        if (!popCompleted) {
            return `EARN ${this.requirementsConfig.REQUIRED_POP_FOR_WITHDRAWAL} POP`;
        }
        return 'WITHDRAW NOW';
    }

    truncateAddress(address) {
        if (!address) return 'N/A';
        if (address.length <= 15) return address;
        return address.substring(0, 6) + '...' + address.substring(address.length - 4);
    }

    formatDateTime(timestamp) {
        const date = new Date(timestamp);
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
    }

    copyToClipboard(text) {
        if (!text || this.isCopying) return;
        
        this.isCopying = true;
        
        navigator.clipboard.writeText(text).then(() => {
            this.showNotification("Copied", "Text copied to clipboard", "success");
            setTimeout(() => {
                this.isCopying = false;
            }, 1000);
        }).catch(() => {
            this.showNotification("Error", "Failed to copy text", "error");
            setTimeout(() => {
                this.isCopying = false;
            }, 1000);
        });
    }

    formatDate(timestamp) {
        const date = new Date(timestamp);
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        return `${day}-${month}-${year}`;
    }

    safeNumber(value) {
        if (value === null || value === undefined) return 0;
        const num = Number(value);
        return isNaN(num) ? 0 : num;
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

    showNotification(title, message, type = 'info') {
        if (this.notificationManager) {
            this.notificationManager.showNotification(title, message, type);
        }
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
                    <h2>POP BUZZ</h2>
                    <p>Please open from Telegram Mini App</p>
                </div>
            </div>
        `;
        return;
    }
    
    window.app = new TornadoApp();
    
    setTimeout(() => {
        if (window.app && typeof window.app.initialize === 'function') {
            window.app.initialize();
        }
    }, 300);
});
