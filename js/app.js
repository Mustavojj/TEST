import { APP_CONFIG, THEME_CONFIG, FEATURES_CONFIG } from './data.js';
import { CacheManager, NotificationManager, SecurityManager } from './modules/core.js';
import { TaskManager, QuestManager, ReferralManager } from './modules/features.js';

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
        this.themeConfig = THEME_CONFIG;
        
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
            { id: 'tasks-page', name: 'Earn', icon: 'fa-coins', color: '#FFD700' },
            { id: 'referrals-page', name: 'Invite', icon: 'fa-user-plus', color: '#FFD700' },
            { id: 'profile-page', name: 'Profile', icon: 'user-photo', color: '#FFD700' }
        ];
        
        this.cache = new CacheManager();
        this.notificationManager = null;
        this.securityManager = new SecurityManager();
        this.isProcessingTask = false;
        
        this.tgUser = null;
        
        this.taskManager = null;
        this.questManager = null;
        this.referralManager = null;
        
        this.currentTasksTab = 'main';
        this.isProcessingAd = false;
        this.isCopying = false;
        this.pendingReferral = null;
        
        this.referralBonusGiven = new Set();
        
        this.adTimers = {
            ad1: 0,
            ad2: 0
        };
        
        this.adCooldown = APP_CONFIG.AD_COOLDOWN;
        this.todayAds = 0;
        this.lastAdResetDate = null;
        
        this.referralMonitorInterval = null;
        
        this.welcomeTasksShown = false;
        this.welcomeTasksCompleted = false;
        
        this.remoteConfig = null;
        this.configCache = null;
        this.configTimestamp = 0;
        
        this.pendingReferralAfterWelcome = null;
        this.rateLimiter = new (this.getRateLimiterClass())();
        
        this.inAppAdsInitialized = false;
        this.inAppAdsTimer = null;
        
        this.serverTimeOffset = 0;
        this.timeSyncInterval = null;
        
        this.telegramVerified = false;
        
        this.botToken = null;
        
        this.userXP = 0;
        this.userCreatedTasks = [];
        this.lastDailyCheckin = 0;
        this.depositCheckInterval = null;
        this.checkedDeposits = new Set();
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
            console.error('Failed to get bot token:', error);
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
            console.error('Telegram verification error:', error);
            return false;
        }
    }

    getRateLimiterClass() {
        return class RateLimiter {
            constructor() {
                this.requests = new Map();
                this.limits = {
                    'task_start': { limit: 1, window: 3000 },
                    'withdrawal': { limit: 1, window: 86400000 },
                    'ad_reward': { limit: 10, window: 300000 },
                    'promo_code': { limit: 5, window: 300000 },
                    'exchange': { limit: 3, window: 3600000 },
                    'daily_checkin': { limit: 1, window: 86400000 }
                };
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
            
            this.showLoadingProgress(15);
            
            this.telegramVerified = await this.verifyTelegramUser();
            this.botToken = await this.getBotToken();
            
            this.showLoadingProgress(25);
            const multiAccountAllowed = await this.checkMultiAccount(this.tgUser.id);
            if (!multiAccountAllowed) {
                this.isInitializing = false;
                return;
            }
            
            this.showLoadingProgress(30);
            
            this.tg.ready();
            this.tg.expand();
            
            this.showLoadingProgress(35);
            this.setupTelegramTheme();
            
            this.notificationManager = new NotificationManager();
            
            this.showLoadingProgress(40);
            
            const firebaseSuccess = await this.initializeFirebase();
            
            if (firebaseSuccess) {
                this.setupFirebaseAuth();
            }
            
            this.showLoadingProgress(50);
            
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
            
            this.showLoadingProgress(60);
            
            this.taskManager = new TaskManager(this);
            this.questManager = new QuestManager(this);
            this.referralManager = new ReferralManager(this);
            
            this.startReferralMonitor();
            
            this.showLoadingProgress(70);
            
            try {
                await this.loadTasksData();
            } catch (taskError) {
                console.warn('Tasks loading error:', taskError);
            }
            
            this.showLoadingProgress(75);
            
            try {
                await this.loadHistoryData();
            } catch (historyError) {
                console.warn('History loading error:', historyError);
            }
            
            this.showLoadingProgress(80);
            
            try {
                await this.loadAppStats();
            } catch (statsError) {
                console.warn('Stats loading error:', statsError);
            }
            
            this.showLoadingProgress(85);
            
            try {
                await this.loadUserCreatedTasks();
                await this.startDepositMonitoring();
            } catch (adError) {
                console.warn('Additional data loading error:', adError);
            }
            
            this.showLoadingProgress(90);
            
            this.renderUI();
            
            this.darkMode = true;
            this.applyTheme();
            
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
                
                this.startAdTimers();
                
                this.initializeInAppAds();
                
                if (!this.userState.welcomeTasksCompleted) {
                    this.showWelcomeTasksModal();
                } else {
                    this.showPage('tasks-page');
                }
                
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
            console.warn('Load user created tasks error:', error);
            this.userCreatedTasks = [];
        }
    }

    async startDepositMonitoring() {
        if (this.depositCheckInterval) {
            clearInterval(this.depositCheckInterval);
        }
        
        this.depositCheckInterval = setInterval(async () => {
            await this.checkDeposits();
        }, 60000);
    }

    async checkDeposits() {
        try {
            if (!this.botToken || !this.appConfig.ADMIN_ID) return;
            
            const walletAddress = this.appConfig.DEPOSIT_WALLET;
            const response = await fetch(`https://tonscan.org/api/address/${walletAddress}/transactions`);
            
            if (!response.ok) return;
            
            const data = await response.json();
            if (!data.transactions || !Array.isArray(data.transactions)) return;
            
            for (const tx of data.transactions) {
                const txHash = tx.hash;
                
                if (this.checkedDeposits.has(txHash)) continue;
                
                if (tx.comment && !isNaN(tx.comment)) {
                    const userId = parseInt(tx.comment);
                    
                    const message = `
🔔 *New Deposit Detected!*

💰 *Amount:* ${tx.amount} TON
👤 *User ID:* ${userId}
📝 *Comment:* ${tx.comment}
🔗 *Transaction:* [View on Tonscan](https://tonscan.org/tx/${txHash})
                    `;
                    
                    await this.sendTelegramMessage(this.appConfig.ADMIN_ID, message, [
                        [{
                            text: "🔍 View Transaction",
                            url: `https://tonscan.org/tx/${txHash}`
                        }]
                    ]);
                    
                    this.checkedDeposits.add(txHash);
                }
            }
            
            const checked = Array.from(this.checkedDeposits);
            localStorage.setItem('checked_deposits', JSON.stringify(checked));
            
        } catch (error) {
            console.warn('Check deposits error:', error);
        }
    }

    async sendTelegramMessage(chatId, message, buttons = null) {
        try {
            if (!this.botToken) return false;
            
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            
            const payload = {
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            };
            
            if (buttons && buttons.length > 0) {
                payload.reply_markup = {
                    inline_keyboard: buttons
                };
            }
            
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            return response.ok;
        } catch (error) {
            console.warn('Send telegram message error:', error);
            return false;
        }
    }

    async dailyCheckin() {
        try {
            const checkinBtn = document.getElementById('daily-checkin-btn');
            if (!checkinBtn) return;
            
            const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'daily_checkin');
            if (!rateLimitCheck.allowed) {
                const timeLeft = rateLimitCheck.remaining;
                const hours = Math.floor(timeLeft / 3600);
                const minutes = Math.floor((timeLeft % 3600) / 60);
                this.notificationManager.showNotification(
                    "Already Checked In",
                    `Next check-in in ${hours}h ${minutes}m`,
                    "info"
                );
                return;
            }
            
            let adShown = false;
            
            if (typeof window.AdBlock19345 !== 'undefined') {
                try {
                    await window.AdBlock19345.show();
                    adShown = true;
                } catch (error) {
                    console.warn('Ad #1 error:', error);
                }
            }
            
            if (!adShown && typeof show_10558486 !== 'undefined') {
                try {
                    await show_10558486();
                    adShown = true;
                } catch (error) {
                    console.warn('Ad #2 error:', error);
                }
            }
            
            if (!adShown) {
                this.notificationManager.showNotification("Ad Required", "Please watch the ad to claim daily reward", "info");
                return;
            }
            
            const reward = FEATURES_CONFIG.DAILY_CHECKIN_REWARD;
            const currentTime = this.getServerTime();
            
            this.rateLimiter.addRequest(this.tgUser.id, 'daily_checkin');
            
            const originalText = checkinBtn.innerHTML;
            checkinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Claiming...';
            checkinBtn.disabled = true;
            
            try {
                const currentBalance = this.safeNumber(this.userState.balance);
                const newBalance = currentBalance + reward;
                
                const updates = {
                    balance: newBalance,
                    totalEarned: this.safeNumber(this.userState.totalEarned) + reward,
                    lastDailyCheckin: currentTime
                };
                
                if (this.db) {
                    await this.db.ref(`users/${this.tgUser.id}`).update(updates);
                }
                
                this.userState.balance = newBalance;
                this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + reward;
                this.userState.lastDailyCheckin = currentTime;
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                this.updateHeader();
                this.updateDailyCheckinButton();
                
                this.notificationManager.showNotification(
                    "Daily Check-in",
                    `+${reward.toFixed(3)} TON`,
                    "success"
                );
                
            } catch (error) {
                console.error('Daily checkin error:', error);
                this.notificationManager.showNotification("Error", "Failed to claim daily reward", "error");
                checkinBtn.innerHTML = originalText;
                checkinBtn.disabled = false;
            }
            
        } catch (error) {
            console.error('Daily checkin error:', error);
        }
    }

    updateDailyCheckinButton() {
        const checkinBtn = document.getElementById('daily-checkin-btn');
        if (!checkinBtn) return;
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'daily_checkin');
        
        if (!rateLimitCheck.allowed) {
            const timeLeft = rateLimitCheck.remaining;
            const hours = Math.floor(timeLeft / 3600);
            const minutes = Math.floor((timeLeft % 3600) / 60);
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
                
                <div class="task-modal-tabs">
                    <button class="task-modal-tab active" data-tab="add">Add Task</button>
                    <button class="task-modal-tab" data-tab="mytasks">My Tasks</button>
                </div>
                
                <div id="add-task-tab" class="task-modal-body" style="display: block;">
                    <form class="add-task-form" id="add-task-form">
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-tag"></i> Task Name
                            </label>
                            <input type="text" id="task-name" class="form-input" placeholder="Enter your task name *" required>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-link"></i> Task Link
                            </label>
                            <input type="url" id="task-link" class="form-input" placeholder="Enter your task link *" required>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-layer-group"></i> Category
                            </label>
                            <div class="category-selector">
                                <div class="category-option active" data-category="channel">Channel</div>
                                <div class="category-option" data-category="app">App/Bot</div>
                            </div>
                        </div>
                        
                        <div id="upgrade-admin-container" style="display: block;">
                            <button type="button" class="upgrade-admin-btn" id="upgrade-admin-btn">
                                <i class="fab fa-telegram"></i> Upgrade @${this.appConfig.BOT_USERNAME} to admin
                            </button>
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">
                                <i class="fas fa-chart-line"></i> Completions
                            </label>
                            <div class="completions-selector">
                                ${completionsOptions.map(opt => `
                                    <div class="completion-option ${opt === 100 ? 'active' : ''}" data-completions="${opt}">${opt}</div>
                                `).join('')}
                            </div>
                        </div>
                        
                        <div class="price-info">
                            <span class="price-label">Total Price:</span>
                            <span class="price-value" id="total-price">100 XP</span>
                        </div>
                        
                        <button type="button" class="pay-task-btn" id="pay-task-btn">
                            <i class="fas fa-coins"></i> Pay {100 XP}
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
                    <p class="hint">Create your first task to earn XP!</p>
                </div>
            `;
        }
        
        return this.userCreatedTasks.map(task => {
            const progress = (task.currentCompletions / task.maxCompletions) * 100;
            const isActive = task.status === 'active';
            
            return `
                <div class="my-task-item" data-task-id="${task.id}">
                    <div class="my-task-header">
                        <div class="my-task-avatar">
                            <img src="${this.appConfig.BOT_AVATAR}" alt="Task">
                        </div>
                        <div class="my-task-info">
                            <div class="my-task-name">${task.name}</div>
                            <div class="my-task-category">${task.category}</div>
                        </div>
                    </div>
                    
                    <div class="my-task-progress">
                        <div class="progress-header">
                            <span>Progress</span>
                            <span>${task.currentCompletions || 0}/${task.maxCompletions}</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progress}%"></div>
                        </div>
                        <div class="progress-stats">
                            <span>${((task.currentCompletions || 0) / task.maxCompletions * 100).toFixed(1)}%</span>
                        </div>
                    </div>
                    
                    <div class="my-task-actions">
                        <button class="my-task-action-btn ${isActive ? 'pause' : 'play'}" data-action="toggle">
                            <i class="fas fa-${isActive ? 'pause' : 'play'}"></i>
                            ${isActive ? 'Pause' : 'Start'}
                        </button>
                        <button class="my-task-action-btn delete" data-action="delete">
                            <i class="fas fa-trash-alt"></i> Delete
                        </button>
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
        
        const categoryOptions = modal.querySelectorAll('.category-option');
        const upgradeContainer = modal.querySelector('#upgrade-admin-container');
        const upgradeBtn = modal.querySelector('#upgrade-admin-btn');
        
        categoryOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                categoryOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                
                if (opt.dataset.category === 'channel') {
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
        
        completionOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                completionOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                
                const completions = parseInt(opt.dataset.completions);
                const priceInXP = Math.floor(completions / 100) * this.appConfig.TASK_PRICE_PER_100_COMPLETIONS;
                totalPriceSpan.textContent = `${priceInXP} XP`;
                
                const payBtn = modal.querySelector('#pay-task-btn');
                payBtn.innerHTML = `<i class="fas fa-coins"></i> Pay {${priceInXP} XP}`;
                
                const userXP = this.safeNumber(this.userState.xp);
                if (userXP < priceInXP) {
                    payBtn.disabled = true;
                } else {
                    payBtn.disabled = false;
                }
            });
        });
        
        const payBtn = modal.querySelector('#pay-task-btn');
        payBtn.addEventListener('click', async () => {
            await this.handleCreateTask(modal);
        });
        
        const myTasksItems = modal.querySelectorAll('.my-task-item');
        myTasksItems.forEach(item => {
            const taskId = item.dataset.taskId;
            const toggleBtn = item.querySelector('[data-action="toggle"]');
            const deleteBtn = item.querySelector('[data-action="delete"]');
            
            if (toggleBtn) {
                toggleBtn.addEventListener('click', async () => {
                    await this.toggleTaskStatus(taskId);
                });
            }
            
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async () => {
                    await this.confirmDeleteTask(taskId, modal);
                });
            }
        });
    }

    async handleCreateTask(modal) {
        try {
            const taskName = modal.querySelector('#task-name').value.trim();
            const taskLink = modal.querySelector('#task-link').value.trim();
            const category = modal.querySelector('.category-option.active').dataset.category;
            const completions = parseInt(modal.querySelector('.completion-option.active').dataset.completions);
            
            if (!taskName || !taskLink) {
                this.notificationManager.showNotification("Error", "Please fill all fields", "error");
                return;
            }
            
            const priceInXP = Math.floor(completions / 100) * this.appConfig.TASK_PRICE_PER_100_COMPLETIONS;
            const userXP = this.safeNumber(this.userState.xp);
            
            if (userXP < priceInXP) {
                this.notificationManager.showNotification("Error", "Insufficient XP balance", "error");
                return;
            }
            
            const payBtn = modal.querySelector('#pay-task-btn');
            const originalText = payBtn.innerHTML;
            payBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
            payBtn.disabled = true;
            
            try {
                const currentTime = this.getServerTime();
                const taskData = {
                    name: taskName,
                    url: taskLink,
                    category: category,
                    type: category === 'channel' ? 'channel' : 'app',
                    maxCompletions: completions,
                    currentCompletions: 0,
                    status: 'active',
                    reward: 0.0001,
                    xpReward: 1,
                    createdBy: this.tgUser.id,
                    createdAt: currentTime,
                    picture: this.appConfig.BOT_AVATAR
                };
                
                if (this.db) {
                    const taskRef = await this.db.ref('config/tasks').push(taskData);
                    const taskId = taskRef.key;
                    
                    await this.db.ref(`userTasks/${this.tgUser.id}/${taskId}`).set({
                        ...taskData,
                        id: taskId
                    });
                    
                    const newXP = userXP - priceInXP;
                    await this.db.ref(`users/${this.tgUser.id}`).update({
                        xp: newXP
                    });
                    
                    this.userState.xp = newXP;
                    
                    const adminMessage = `
📢 *New Task Created!*

📌 *Name:* ${taskName}
🔗 *Link:* ${taskLink}
📊 *Category:* ${category}
🎯 *Completions:* ${completions}
💰 *Price:* ${priceInXP} XP
👤 *Creator:* ${this.tgUser.id} (${this.userState.username})
                    `;
                    
                    await this.sendTelegramMessage(this.appConfig.ADMIN_ID, adminMessage);
                    
                    await this.loadUserCreatedTasks();
                    
                    const myTasksList = modal.querySelector('#my-tasks-list');
                    if (myTasksList) {
                        myTasksList.innerHTML = this.renderMyTasks();
                        this.setupTaskModalEvents(modal, []);
                    }
                    
                    this.notificationManager.showNotification(
                        "Success",
                        `Task created! Cost: ${priceInXP} XP`,
                        "success"
                    );
                    
                    this.updateHeader();
                    
                }
                
            } catch (error) {
                console.error('Create task error:', error);
                this.notificationManager.showNotification("Error", "Failed to create task", "error");
            } finally {
                payBtn.innerHTML = originalText;
                payBtn.disabled = false;
            }
            
        } catch (error) {
            console.error('Create task error:', error);
        }
    }

    async toggleTaskStatus(taskId) {
        try {
            const task = this.userCreatedTasks.find(t => t.id === taskId);
            if (!task) return;
            
            const newStatus = task.status === 'active' ? 'stopped' : 'active';
            
            if (this.db) {
                await this.db.ref(`config/tasks/${taskId}`).update({
                    status: newStatus,
                    taskStatus: newStatus
                });
                
                await this.db.ref(`userTasks/${this.tgUser.id}/${taskId}`).update({
                    status: newStatus
                });
                
                task.status = newStatus;
                
                const modal = document.querySelector('.task-modal');
                if (modal) {
                    const myTasksList = modal.querySelector('#my-tasks-list');
                    if (myTasksList) {
                        myTasksList.innerHTML = this.renderMyTasks();
                        this.setupTaskModalEvents(modal, []);
                    }
                }
                
                if (newStatus === 'active') {
                    await this.loadTasksData(true);
                    this.renderTasksPage();
                }
                
                this.notificationManager.showNotification(
                    "Success",
                    `Task ${newStatus === 'active' ? 'started' : 'stopped'}`,
                    "success"
                );
            }
            
        } catch (error) {
            console.error('Toggle task error:', error);
            this.notificationManager.showNotification("Error", "Failed to update task", "error");
        }
    }

    async confirmDeleteTask(taskId, modal) {
        const confirmModal = document.createElement('div');
        confirmModal.className = 'confirm-modal';
        confirmModal.innerHTML = `
            <div class="confirm-content">
                <div class="confirm-icon">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <h3>Delete Task</h3>
                <p>Are you sure you want to delete this task? This action cannot be undone.</p>
                <div class="confirm-actions">
                    <button class="confirm-cancel" id="cancel-delete">Cancel</button>
                    <button class="confirm-delete" id="confirm-delete">Delete</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(confirmModal);
        
        const cancelBtn = confirmModal.querySelector('#cancel-delete');
        const deleteBtn = confirmModal.querySelector('#confirm-delete');
        
        cancelBtn.addEventListener('click', () => {
            confirmModal.remove();
        });
        
        deleteBtn.addEventListener('click', async () => {
            try {
                if (this.db) {
                    await this.db.ref(`config/tasks/${taskId}`).remove();
                    await this.db.ref(`userTasks/${this.tgUser.id}/${taskId}`).remove();
                    
                    this.userCreatedTasks = this.userCreatedTasks.filter(t => t.id !== taskId);
                    
                    if (modal) {
                        const myTasksList = modal.querySelector('#my-tasks-list');
                        if (myTasksList) {
                            myTasksList.innerHTML = this.renderMyTasks();
                            this.setupTaskModalEvents(modal, []);
                        }
                    }
                    
                    this.notificationManager.showNotification("Success", "Task deleted", "success");
                }
            } catch (error) {
                console.error('Delete task error:', error);
                this.notificationManager.showNotification("Error", "Failed to delete task", "error");
            } finally {
                confirmModal.remove();
            }
        });
    }

    initializeInAppAds() {
        if (this.inAppAdsInitialized) return;
        
        try {
            if (typeof window.AdBlock2 !== 'undefined' || typeof show_10558486 !== 'undefined') {
                this.inAppAdsInitialized = true;
                
                setTimeout(() => {
                    this.showInAppAd();
                    this.inAppAdsTimer = setInterval(() => {
                        this.showInAppAd();
                    }, this.appConfig.IN_APP_AD_INTERVAL);
                }, this.appConfig.INITIAL_AD_DELAY);
            }
        } catch (error) {
            console.warn('In-app ads initialization error:', error);
        }
    }
    
    showInAppAd() {
        const random = Math.random();
        
        if (random < 0.5 && typeof window.AdBlock2 !== 'undefined') {
            window.AdBlock2.show().catch(() => {});
        } else if (typeof show_10558486 !== 'undefined') {
            try {
                show_10558486();
            } catch (error) {
                console.warn('Ad error:', error);
            }
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
                console.warn('Using fallback Firebase config');
                firebaseConfig = {
                    apiKey: "AIzaSyDefaultKey123",
                    authDomain: "tornado-default.firebaseapp.com",
                    databaseURL: "https://tornado-default-rtdb.firebaseio.com",
                    projectId: "tornado-default",
                    storageBucket: "tornado-default.appspot.com",
                    messagingSenderId: "987654321098",
                    appId: "1:987654321098:web:default1234567890",
                    measurementId: "G-DEFAULT123"
                };
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
                const randomEmail = `user_${this.tgUser.id}_${Date.now()}@ramadan.app`;
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
            console.error('Firebase initialization error:', error);
            
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
                this.currentUser = user;
                
                if (this.userState.firebaseUid !== user.uid) {
                    this.userState.firebaseUid = user.uid;
                    await this.syncUserWithFirebase();
                }
            } else {
                try {
                    await this.auth.signInAnonymously();
                } catch (error) {
                    console.warn('Anonymous auth error:', error);
                }
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
                    createdAt: this.getServerTime(),
                    lastSynced: this.getServerTime(),
                    isNewUser: true
                };
                
                await userRef.set(userData);
            } else {
                await userRef.update({
                    firebaseUid: firebaseUid,
                    lastSynced: this.getServerTime()
                });
            }
            
        } catch (error) {
            console.warn('Sync user with Firebase error:', error);
        }
    }

    async loadUserData(forceRefresh = false) {
        const cacheKey = `user_${this.tgUser.id}`;
        
        if (!forceRefresh) {
            const cachedData = this.cache.get(cacheKey);
            if (cachedData) {
                this.userState = cachedData;
                this.userXP = this.safeNumber(cachedData.xp);
                this.updateHeader();
                return;
            }
        }
        
        try {
            if (!this.db || !this.firebaseInitialized || !this.auth?.currentUser) {
                this.userState = this.getDefaultUserState();
                this.userXP = 0;
                this.updateHeader();
                
                if (this.auth && !this.auth.currentUser) {
                    setTimeout(() => {
                        this.initializeFirebase();
                    }, 2000);
                }
                
                return;
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
            this.userXP = this.safeNumber(userData.xp);
            this.userCompletedTasks = new Set(userData.completedTasks || []);
            this.todayAds = userData.todayAds || 0;
            this.lastDailyCheckin = userData.lastDailyCheckin || 0;
            
            this.cache.set(cacheKey, userData, 60000);
            this.updateHeader();
            
        } catch (error) {
            console.error('Load user data error:', error);
            this.userState = this.getDefaultUserState();
            this.userXP = 0;
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
            photoUrl: this.tgUser.photo_url || this.appConfig.DEFAULT_USER_AVATAR,
            balance: 0,
            xp: 0,
            referrals: 0,
            totalEarned: 0,
            totalTasks: 0,
            totalWithdrawals: 0,
            totalAds: 0,
            totalPromoCodes: 0,
            totalTasksCompleted: 0,
            referralEarnings: 0,
            lastDailyCheckin: 0,
            status: 'free',
            lastUpdated: this.getServerTime(),
            firebaseUid: this.auth?.currentUser?.uid || 'pending',
            welcomeTasksCompleted: false,
            isNewUser: false,
            totalWithdrawnAmount: 0,
            totalWatchAds: 0,
            theme: 'dark',
            completedTasks: [],
            todayAds: 0,
            lastAdResetDate: new Date().toDateString()
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
                        photoUrl: this.tgUser.photo_url || this.appConfig.DEFAULT_USER_AVATAR,
                        joinedAt: this.getServerTime(),
                        state: 'pending',
                        bonusGiven: false,
                        bonusAmount: this.appConfig.REFERRAL_BONUS_TON,
                        verifiedAt: null
                    });
                } else {
                    referralId = null;
                }
            } else {
                referralId = null;
            }
        }
        
        const currentTime = this.getServerTime();
        const today = new Date().toDateString();
        
        const userData = {
            id: this.tgUser.id,
            username: this.tgUser.username ? `@${this.tgUser.username}` : 'No Username',
            telegramId: this.tgUser.id,
            firstName: this.getShortName(this.tgUser.first_name || ''),
            photoUrl: this.tgUser.photo_url || this.appConfig.DEFAULT_USER_AVATAR,
            balance: 0,
            xp: 0,
            referrals: 0,
            referredBy: referralId,
            totalEarned: 0,
            totalTasks: 0,
            totalWithdrawals: 0,
            totalAds: 0,
            totalPromoCodes: 0,
            totalTasksCompleted: 0,
            referralEarnings: 0,
            completedTasks: [],
            lastWithdrawalDate: null,
            lastDailyCheckin: 0,
            createdAt: currentTime,
            lastActive: currentTime,
            status: 'free',
            referralState: referralId ? 'pending' : null,
            firebaseUid: this.auth?.currentUser?.uid || 'pending',
            welcomeTasksCompleted: false,
            welcomeTasksCompletedAt: null,
            isNewUser: true,
            totalWithdrawnAmount: 0,
            totalWatchAds: 0,
            todayAds: 0,
            lastAdResetDate: today,
            theme: 'dark'
        };
        
        await userRef.set(userData);
        
        try {
            await this.updateAppStats('totalUsers', 1);
        } catch (statsError) {
            console.warn('Update app stats error:', statsError);
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
                    if (this.db) {
                        await this.db.ref(`users/${tgId}`).update({
                            status: 'ban',
                            banReason: 'Multiple accounts detected on same IP',
                            bannedAt: this.getServerTime()
                        });
                    }
                } catch (error) {
                    console.warn('Ban user error:', error);
                }
                
                return false;
            }
            
            if (!ipData[ip]) {
                ipData[ip] = tgId;
                localStorage.setItem("ip_records", JSON.stringify(ipData));
            }
            
            return true;
        } catch (error) {
            console.warn('Check multi-account error:', error);
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
                    border:1px solid rgba(255,215,0,0.2);
                    animation:fadeIn 0.6s ease-out;
                ">
                    <div style="margin-bottom:24px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ff4d4d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="animation:pulse 1.8s infinite ease-in-out;">
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
            return null;
        }
    }

    async updateExistingUser(userRef, userData) {
        const currentTime = this.getServerTime();
        const today = new Date().toDateString();
        
        await userRef.update({ 
            lastActive: currentTime,
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
        
        const defaultData = {
            lastDailyCheckin: userData.lastDailyCheckin || 0,
            status: userData.status || 'free',
            referralState: userData.referralState || 'verified',
            referralEarnings: userData.referralEarnings || 0,
            totalEarned: userData.totalEarned || 0,
            totalTasks: userData.totalTasks || 0,
            totalWithdrawals: userData.totalWithdrawals || 0,
            totalAds: userData.totalAds || 0,
            totalPromoCodes: userData.totalPromoCodes || 0,
            totalTasksCompleted: userData.totalTasksCompleted || 0,
            balance: userData.balance || 0,
            xp: userData.xp || 0,
            referrals: userData.referrals || 0,
            firebaseUid: this.auth?.currentUser?.uid || userData.firebaseUid || null,
            welcomeTasksCompleted: userData.welcomeTasksCompleted || false,
            welcomeTasksCompletedAt: userData.welcomeTasksCompletedAt || null,
            isNewUser: userData.isNewUser || false,
            totalWithdrawnAmount: userData.totalWithdrawnAmount || 0,
            totalWatchAds: userData.totalWatchAds || 0,
            todayAds: userData.todayAds || 0,
            lastAdResetDate: userData.lastAdResetDate || today,
            theme: userData.theme || 'dark'
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
            
            const newBalance = this.safeNumber(referrerData.balance) + referralBonus;
            const newReferrals = (referrerData.referrals || 0) + 1;
            const newReferralEarnings = this.safeNumber(referrerData.referralEarnings) + referralBonus;
            const newTotalEarned = this.safeNumber(referrerData.totalEarned) + referralBonus;
            const currentTime = this.getServerTime();
            
            await referrerRef.update({
                balance: newBalance,
                referrals: newReferrals,
                referralEarnings: newReferralEarnings,
                totalEarned: newTotalEarned
            });
            
            await this.db.ref(`referrals/${referrerId}/${newUserId}`).update({
                state: 'verified',
                bonusGiven: true,
                verifiedAt: currentTime,
                bonusAmount: referralBonus
            });
            
            await this.db.ref(`users/${newUserId}`).update({
                referralState: 'verified'
            });
            
            if (this.tgUser && referrerId === this.tgUser.id) {
                this.userState.balance = newBalance;
                this.userState.referrals = newReferrals;
                this.userState.referralEarnings = newReferralEarnings;
                this.userState.totalEarned = newTotalEarned;
                
                this.updateHeader();
            }
            
            this.cache.delete(`user_${referrerId}`);
            this.cache.delete(`referrals_${referrerId}`);
            
            await this.refreshReferralsList();
            
        } catch (error) {
            console.warn('Process referral bonus error:', error);
        }
    }

    async processReferralTaskBonus(referrerId, taskReward) {
        try {
            if (!this.db) return;
            if (!referrerId || referrerId === this.tgUser.id) return;
            if (this.appConfig.REFERRAL_PERCENTAGE <= 0) return;
            
            const referrerRef = this.db.ref(`users/${referrerId}`);
            const referrerSnapshot = await referrerRef.once('value');
            
            if (!referrerSnapshot.exists()) return;
            
            const referrerData = referrerSnapshot.val();
            
            if (referrerData.status === 'ban') return;
            
            const referralPercentage = this.appConfig.REFERRAL_PERCENTAGE;
            const referralBonus = (taskReward * referralPercentage) / 100;
            
            if (referralBonus <= 0) return;
            
            const newBalance = this.safeNumber(referrerData.balance) + referralBonus;
            const newReferralEarnings = this.safeNumber(referrerData.referralEarnings) + referralBonus;
            const newTotalEarned = this.safeNumber(referrerData.totalEarned) + referralBonus;
            
            await referrerRef.update({
                balance: newBalance,
                referralEarnings: newReferralEarnings,
                totalEarned: newTotalEarned
            });
            
            await this.db.ref(`referralTasks/${referrerId}`).push({
                userId: this.tgUser.id,
                taskReward: taskReward,
                referralBonus: referralBonus,
                percentage: referralPercentage,
                createdAt: this.getServerTime()
            });
            
            if (referrerId === this.tgUser.id) {
                this.userState.balance = newBalance;
                this.userState.referralEarnings = newReferralEarnings;
                this.userState.totalEarned = newTotalEarned;
                
                this.updateHeader();
            }
            
        } catch (error) {
            console.warn('Process referral task bonus error:', error);
        }
    }

    async loadTasksData() {
        try {
            if (this.taskManager) {
                return await this.taskManager.loadTasksData();
            }
            return [];
        } catch (error) {
            console.warn('Load tasks data error:', error);
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
                    this.userWithdrawals.push({ 
                        id: child.key, 
                        ...child.val(),
                        transactionLink: child.val().transactionLink || null
                    });
                });
            });
            
            this.userWithdrawals.sort((a, b) => (b.createdAt || b.timestamp) - (a.createdAt || a.timestamp));
            
        } catch (error) {
            console.warn('Load history data error:', error);
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
            console.warn('Load app stats error:', error);
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
        } catch (error) {
            console.warn('Update app stats error:', error);
        }
    }

    async showWelcomeTasksModal() {
        if (this.userState.welcomeTasksCompleted) {
            this.showPage('tasks-page');
            return;
        }
        
        const modal = document.createElement('div');
        modal.className = 'welcome-tasks-modal';
        
        const welcomeTasksHTML = this.appConfig.WELCOME_TASKS.map((task, index) => `
            <div class="welcome-task-item" id="welcome-task-${index}">
                <div class="welcome-task-info">
                    <h4>${task.name}</h4>
                </div>
                <button class="welcome-task-btn" id="welcome-task-btn-${index}" 
                        data-url="${task.url}" 
                        data-channel="${task.channel}">
                    <i class="fas fa-external-link-alt"></i> Join
                </button>
            </div>
        `).join('');
        
        modal.innerHTML = `
            <div class="welcome-tasks-content">
                <div class="welcome-header">
                    <div class="welcome-icon">
                        <i class="fas fa-gift"></i>
                    </div>
                    <h3>Welcome Tasks</h3>
                </div>
                
                <div class="welcome-tasks-list">
                    ${welcomeTasksHTML}
                </div>
                
                <div class="welcome-footer">
                    <button class="check-welcome-btn" id="check-welcome-btn" disabled>
                        <i class="fas fa-check-circle"></i> Check & Get 0.01 TON
                    </button>
                    
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const app = this;
        const clickedTasks = {};
        
        this.appConfig.WELCOME_TASKS.forEach((task, index) => {
            clickedTasks[index] = false;
        });
        
        function updateCheckButton() {
            const checkBtn = document.getElementById('check-welcome-btn');
            const allClicked = Object.values(clickedTasks).every(v => v === true);
            
            if (allClicked && checkBtn) {
                checkBtn.disabled = false;
            }
        }
        
        this.appConfig.WELCOME_TASKS.forEach((task, index) => {
            const btn = document.getElementById(`welcome-task-btn-${index}`);
            if (btn) {
                btn.addEventListener('click', async () => {
                    const url = btn.getAttribute('data-url');
                    const channel = btn.getAttribute('data-channel');
                    
                    window.open(url, '_blank');
                    
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
                    btn.disabled = true;
                    
                    setTimeout(async () => {
                        if (app.botToken) {
                            const isMember = await app.checkTelegramMembership(channel);
                            
                            if (isMember) {
                                btn.innerHTML = '<i class="fas fa-check"></i> Verified';
                                btn.classList.add('completed');
                                clickedTasks[index] = true;
                                updateCheckButton();
                            } else {
                                btn.innerHTML = '<i class="fas fa-external-link-alt"></i> Join';
                                btn.disabled = false;
                                app.notificationManager.showNotification(
                                    "Not a Member", 
                                    `Please join ${task.name} first`, 
                                    "warning"
                                );
                            }
                        } else {
                            btn.innerHTML = '<i class="fas fa-check"></i> Verified';
                            btn.classList.add('completed');
                            clickedTasks[index] = true;
                            updateCheckButton();
                        }
                    }, 10000);
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
                        app.notificationManager.showNotification("Success", "Welcome bonus received!", "success");
                    } else {
                        checkBtn.innerHTML = '<i class="fas fa-check-circle"></i> Check & Get 0.01 TON';
                        checkBtn.disabled = false;
                        
                        if (verificationResult.missing.length > 0) {
                            const missingItems = verificationResult.missing.map(item => {
                                const task = app.appConfig.WELCOME_TASKS.find(t => t.channel === item);
                                return task ? task.name : item;
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
                    checkBtn.innerHTML = '<i class="fas fa-check-circle"></i> Check & Get 0.005 TON';
                    checkBtn.disabled = false;
                }
            });
        }
        
        this.welcomeTasksShown = true;
    }
    
    async verifyWelcomeTasks() {
        try {
            const missingChannels = [];
            
            for (const task of this.appConfig.WELCOME_TASKS) {
                if (this.botToken) {
                    const isMember = await this.checkTelegramMembership(task.channel);
                    if (!isMember) {
                        missingChannels.push(task.channel);
                    }
                }
            }
            
            return {
                success: missingChannels.length === 0,
                verified: [],
                missing: missingChannels
            };
            
        } catch (error) {
            console.warn('Verify welcome tasks error:', error);
            return {
                success: false,
                verified: [],
                missing: this.appConfig.WELCOME_TASKS.map(task => task.channel)
            };
        }
    }
    
    async checkTelegramMembership(channelUsername) {
        try {
            if (!this.tgUser || !this.tgUser.id || !this.botToken) {
                return false;
            }
            
            const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getChatMember`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    chat_id: channelUsername,
                    user_id: this.tgUser.id
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
            console.warn('Check Telegram membership error:', error);
            return false;
        }
    }
    
    async completeWelcomeTasks() {
        try {
            const reward = 0.01;
            const currentBalance = this.safeNumber(this.userState.balance);
            const newBalance = currentBalance + reward;
            const currentTime = this.getServerTime();
            
            const updates = {
                balance: newBalance,
                totalEarned: this.safeNumber(this.userState.totalEarned) + reward,
                totalTasks: this.safeNumber(this.userState.totalTasks) + 1,
                welcomeTasksCompleted: true,
                welcomeTasksCompletedAt: currentTime,
                welcomeTasksVerifiedAt: currentTime,
                referralState: 'verified',
                lastUpdated: currentTime,
                isNewUser: false
            };
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update(updates);
            }
            
            this.userState.balance = newBalance;
            this.userState.totalEarned = this.safeNumber(this.userState.totalEarned) + reward;
            this.userState.totalTasks = this.safeNumber(this.userState.totalTasks) + 1;
            this.userState.welcomeTasksCompleted = true;
            this.userState.welcomeTasksCompletedAt = currentTime;
            this.userState.welcomeTasksVerifiedAt = currentTime;
            this.userState.referralState = 'verified';
            this.userState.isNewUser = false;
            
            if (this.pendingReferralAfterWelcome && this.pendingReferralAfterWelcome !== this.tgUser.id) {
                await this.processReferralRegistrationWithBonus(this.pendingReferralAfterWelcome, this.tgUser.id);
                this.userState.referredBy = this.pendingReferralAfterWelcome;
                this.pendingReferralAfterWelcome = null;
            }
            
            await this.loadUserData(true);
            
            this.cache.delete(`user_${this.tgUser.id}`);
            this.updateHeader();
            
            if (this.referralManager) {
                await this.referralManager.refreshReferralsList();
            }
            
            if (this.userState.referredBy) {
                this.notificationManager.showNotification(
                    "Referral Bonus", 
                    "Your referrer received ref bonus", 
                    "success"
                );
            }
            
            return true;
        } catch (error) {
            console.warn('Complete welcome tasks error:', error);
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
            console.warn('Check referrals verification error:', error);
        }
    }

    async loadAdTimers() {
        try {
            if (this.db) {
                const timersRef = await this.db.ref(`userAdTimers/${this.tgUser.id}`).once('value');
                if (timersRef.exists()) {
                    const data = timersRef.val();
                    this.adTimers = {
                        ad1: data.ad1 || 0,
                        ad2: data.ad2 || 0
                    };
                    return;
                }
            }
            
            const savedTimers = localStorage.getItem(`ad_timers_${this.tgUser.id}`);
            if (savedTimers) {
                this.adTimers = JSON.parse(savedTimers);
            }
        } catch (error) {
            console.warn('Load ad timers error:', error);
            this.adTimers = {
                ad1: 0,
                ad2: 0
            };
        }
    }

    async saveAdTimers() {
        try {
            const currentTime = this.getServerTime();
            if (this.db) {
                await this.db.ref(`userAdTimers/${this.tgUser.id}`).set({
                    ad1: this.adTimers.ad1,
                    ad2: this.adTimers.ad2,
                    lastUpdated: currentTime
                });
            }
            
            localStorage.setItem(`ad_timers_${this.tgUser.id}`, JSON.stringify(this.adTimers));
        } catch (error) {
            console.warn('Save ad timers error:', error);
        }
    }

    setupTelegramTheme() {
        if (!this.tg) return;
        
        this.darkMode = true;
        this.applyTheme();
    }

    applyTheme() {
        const theme = this.themeConfig.GOLDEN_THEME;
        
        document.documentElement.style.setProperty('--background-color', theme.background);
        document.documentElement.style.setProperty('--card-bg', theme.cardBg);
        document.documentElement.style.setProperty('--card-bg-solid', theme.cardBgSolid);
        document.documentElement.style.setProperty('--text-primary', theme.textPrimary);
        document.documentElement.style.setProperty('--text-secondary', theme.textSecondary);
        document.documentElement.style.setProperty('--text-light', theme.textLight);
        document.documentElement.style.setProperty('--primary-color', theme.primaryColor);
        document.documentElement.style.setProperty('--secondary-color', theme.secondaryColor);
        document.documentElement.style.setProperty('--accent-color', theme.accentColor);
        document.documentElement.style.setProperty('--ton-color', theme.tonColor);
        document.documentElement.style.setProperty('--xp-color', theme.xpColor);
        
        document.body.classList.add('dark-mode');
        document.body.classList.remove('light-mode');
    }

    showLoadingProgress(percent) {
        const loadingPercentage = document.getElementById('loading-percentage');
        if (loadingPercentage) {
            loadingPercentage.textContent = `${percent}%`;
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
                        <h2>RAMADAN BUX</h2>
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
        const headerBalance = document.querySelector('.profile-left');
        
        if (userPhoto) {
            userPhoto.src = this.userState.photoUrl || this.appConfig.DEFAULT_USER_AVATAR;
            userPhoto.style.width = '60px';
            userPhoto.style.height = '60px';
            userPhoto.style.borderRadius = '50%';
            userPhoto.style.objectFit = 'cover';
            userPhoto.style.border = `2px solid #FFD700`;
            userPhoto.style.boxShadow = '0 4px 15px rgba(255, 215, 0, 0.3)';
            userPhoto.oncontextmenu = (e) => e.preventDefault();
            userPhoto.ondragstart = () => false;
        }
        
        if (userName) {
            const fullName = this.tgUser.first_name || 'User';
            userName.textContent = this.truncateName(fullName, 20);
            userName.style.fontSize = '1.2rem';
            userName.style.fontWeight = '800';
            userName.style.color = '#FFD700';
            userName.style.margin = '0 0 5px 0';
            userName.style.whiteSpace = 'nowrap';
            userName.style.overflow = 'hidden';
            userName.style.textOverflow = 'ellipsis';
            userName.style.lineHeight = '1.2';
        }
        
        if (headerBalance) {
            const existingBalanceCards = document.querySelector('.balance-cards');
            if (existingBalanceCards) {
                existingBalanceCards.remove();
            }
            
            const balanceCards = document.createElement('div');
            balanceCards.className = 'balance-cards';
            
            const tonBalance = this.safeNumber(this.userState.balance);
            const xpBalance = this.safeNumber(this.userState.xp);
            
            balanceCards.innerHTML = `
                <div class="balance-card">
                    <img src="https://cdn-icons-png.flaticon.com/512/12114/12114247.png" class="balance-icon" alt="TON">
                    <span class="balance-ton">${tonBalance.toFixed(3)}</span>
                </div>
                <div class="balance-card">
                    <img src="https://cdn-icons-png.flaticon.com/512/17301/17301413.png" class="balance-icon" alt="XP">
                    <span class="balance-xp">${Math.floor(xpBalance)}</span>
                </div>
            `;
            
            headerBalance.appendChild(balanceCards);
        }
        
        const bottomNavPhoto = document.getElementById('bottom-nav-user-photo');
        if (bottomNavPhoto && this.tgUser.photo_url) {
            bottomNavPhoto.src = this.tgUser.photo_url;
        }
    }

    renderUI() {
        this.updateHeader();
        this.renderTasksPage();
        this.renderReferralsPage();
        this.renderProfilePage();
        this.setupNavigation();
        this.setupEventListeners();
        
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
            } else if (pageId === 'referrals-page') {
                this.renderReferralsPage();
            } else if (pageId === 'profile-page') {
                this.renderProfilePage();
            }
        }
    }

    renderTasksPage() {
        const tasksPage = document.getElementById('tasks-page');
        if (!tasksPage) return;
        
        tasksPage.innerHTML = `
            <div id="tasks-content">
                <div class="tasks-tabs">
                    <button class="tab-btn active" data-tab="tasks-tab">
                        <i class="fas fa-tasks"></i> Tasks
                    </button>
                    <button class="tab-btn" data-tab="more-tab">
                        <i class="fas fa-ellipsis-h"></i> More
                    </button>
                </div>
                
                <div id="tasks-tab" class="tasks-tab-content active">
                    <div class="task-category">
                        <div class="task-category-header">
                            <h3 class="task-category-title">
                                <i class="fas fa-star"></i> Main Tasks
                            </h3>
                        </div>
                        <div id="main-tasks-list" class="referrals-list"></div>
                    </div>
                    
                    <div class="task-category">
                        <div class="task-category-header">
                            <h3 class="task-category-title">
                                <i class="fas fa-users"></i> Social Tasks
                            </h3>
                            <button class="add-task-btn" id="add-task-btn">
                                <i class="fas fa-plus"></i> Add Task
                            </button>
                        </div>
                        <div id="social-tasks-list" class="referrals-list"></div>
                    </div>
                </div>
                
                <div id="more-tab" class="tasks-tab-content">
                    <div class="more-grid">
                        <!-- Daily Check-in Card -->
                        <div class="daily-checkin-card">
                            <div class="checkin-header">
                                <div class="checkin-icon">
                                    <i class="fas fa-calendar-check"></i>
                                </div>
                                <div class="checkin-title">Daily Check-in</div>
                            </div>
                            <div class="checkin-reward">
                                <img src="https://cdn-icons-png.flaticon.com/512/15208/15208522.png" alt="TON">
                                <span>Reward: ${FEATURES_CONFIG.DAILY_CHECKIN_REWARD.toFixed(3)} TON</span>
                            </div>
                            <button class="checkin-btn" id="daily-checkin-btn">
                                <i class="fas fa-calendar-check"></i> CHECK-IN
                            </button>
                        </div>
                        
                        <!-- Promo Code Card -->
                        <div class="promo-card square-card">
                            <div class="promo-header">
                                <div class="promo-icon">
                                    <i class="fas fa-gift"></i>
                                </div>
                                <h3>Promo Codes</h3>
                            </div>
                            <input type="text" id="promo-input" class="promo-input" 
                                   placeholder="Enter promo code" maxlength="20">
                            <button id="promo-btn" class="promo-btn">
                                <i class="fas fa-gift"></i> APPLY
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        setTimeout(() => {
            this.setupTasksTabs();
            this.loadMainTasks();
            this.loadSocialTasks();
            this.setupPromoCodeEvents();
            this.setupMoreTabEvents();
            this.updateDailyCheckinButton();
        }, 100);
    }

    setupMoreTabEvents() {
        const checkinBtn = document.getElementById('daily-checkin-btn');
        if (checkinBtn) {
            checkinBtn.addEventListener('click', () => this.dailyCheckin());
        }
        
        const addTaskBtn = document.getElementById('add-task-btn');
        if (addTaskBtn) {
            addTaskBtn.addEventListener('click', () => {
                this.showAddTaskModal();
            });
        }
    }

    setupTasksTabs() {
        const tabButtons = document.querySelectorAll('.tasks-tabs .tab-btn');
        const tabContents = document.querySelectorAll('.tasks-tab-content');
        
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tabId = button.getAttribute('data-tab');
                
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                
                button.classList.add('active');
                const targetTab = document.getElementById(tabId);
                if (targetTab) {
                    targetTab.classList.add('active');
                }
            });
        });
    }

    async loadMainTasks() {
        const mainTasksList = document.getElementById('main-tasks-list');
        if (!mainTasksList) return;
        
        try {
            let mainTasks = [];
            if (this.taskManager) {
                mainTasks = await this.taskManager.loadTasksFromDatabase('main');
            }
            
            if (mainTasks.length > 0) {
                const tasksHTML = mainTasks.map(task => this.renderTaskCard(task)).join('');
                mainTasksList.innerHTML = tasksHTML;
                this.setupTaskButtons();
            } else {
                mainTasksList.innerHTML = `
                    <div class="no-tasks">
                        <i class="fas fa-star"></i>
                        <p>No main tasks available now</p>
                    </div>
                `;
            }
        } catch (error) {
            console.warn('Load main tasks error:', error);
            mainTasksList.innerHTML = `
                <div class="no-tasks">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Error loading main tasks</p>
                </div>
            `;
        }
    }

    async loadSocialTasks() {
        const socialTasksList = document.getElementById('social-tasks-list');
        if (!socialTasksList) return;
        
        try {
            let socialTasks = [];
            if (this.taskManager) {
                socialTasks = await this.taskManager.loadTasksFromDatabase('social');
            }
            
            socialTasks = socialTasks.filter(task => task.status !== 'stopped');
            
            if (socialTasks.length > 0) {
                const tasksHTML = socialTasks.map(task => this.renderTaskCard(task)).join('');
                socialTasksList.innerHTML = tasksHTML;
                this.setupTaskButtons();
            } else {
                socialTasksList.innerHTML = `
                    <div class="no-tasks">
                        <i class="fas fa-users"></i>
                        <p>No social tasks available now</p>
                    </div>
                `;
            }
        } catch (error) {
            console.warn('Load social tasks error:', error);
            socialTasksList.innerHTML = `
                <div class="no-tasks">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Error loading social tasks</p>
                </div>
            `;
        }
    }

    renderTaskCard(task) {
        const isCompleted = this.userCompletedTasks.has(task.id);
        const defaultIcon = this.appConfig.BOT_AVATAR;
        
        let buttonText = 'Start';
        let buttonClass = 'start';
        let isDisabled = isCompleted || this.isProcessingTask;
        
        if (isCompleted) {
            buttonText = 'COMPLETED';
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
                    <p class="referral-row-username">${task.name}</p>
                    <div class="task-rewards">
                        <span class="reward-badge">
                            <img src="https://cdn-icons-png.flaticon.com/512/12114/12114247.png" class="reward-icon" alt="TON">
                            ${task.reward?.toFixed(5) || '0.00000'}
                        </span>
                        <span class="reward-badge">
                            <img src="https://cdn-icons-png.flaticon.com/512/17301/17301413.png" class="reward-icon" alt="XP">
                            ${task.xpReward || 1}
                        </span>
                    </div>
                </div>
                <div class="referral-row-status">
                    <button class="task-btn ${buttonClass}" 
                            data-task-id="${task.id}"
                            data-task-url="${task.url}"
                            data-task-type="${task.type}"
                            data-task-reward="${task.reward}"
                            data-task-xp="${task.xpReward || 1}"
                            ${isDisabled ? 'disabled' : ''}>
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
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'promo_code');
        if (!rateLimitCheck.allowed) {
            this.notificationManager.showNotification(
                "Rate Limit", 
                `Please wait ${rateLimitCheck.remaining} seconds before using another promo code`, 
                "warning"
            );
            return;
        }
        
        let adShown = false;
        
        if (typeof window.AdBlock19345 !== 'undefined') {
            try {
                await window.AdBlock19345.show();
                adShown = true;
            } catch (error) {
                console.warn('Ad #1 error:', error);
            }
        }
        
        if (!adShown && typeof show_10558486 !== 'undefined') {
            try {
                await show_10558486();
                adShown = true;
            } catch (error) {
                console.warn('Ad #2 error:', error);
            }
        }
        
        if (!adShown) {
            this.notificationManager.showNotification("Ad Required", "Please watch the ad to apply promo code", "info");
            return;
        }
        
        this.rateLimiter.addRequest(this.tgUser.id, 'promo_code');
        
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
            
            let rewardType = promoData.rewardType || 'ton';
            let rewardAmount = this.safeNumber(promoData.reward || 0.01);
            
            const userUpdates = {};
            
            if (rewardType === 'ton') {
                const currentBalance = this.safeNumber(this.userState.balance);
                userUpdates.balance = currentBalance + rewardAmount;
                userUpdates.totalEarned = this.safeNumber(this.userState.totalEarned) + rewardAmount;
            } else {
                const currentXP = this.safeNumber(this.userState.xp);
                userUpdates.xp = currentXP + rewardAmount;
            }
            
            userUpdates.totalPromoCodes = this.safeNumber(this.userState.totalPromoCodes) + 1;
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update(userUpdates);
                
                await this.db.ref(`usedPromoCodes/${this.tgUser.id}/${promoData.id}`).set({
                    code: code,
                    reward: rewardAmount,
                    rewardType: rewardType,
                    claimedAt: this.getServerTime()
                });
                
                await this.db.ref(`config/promoCodes/${promoData.id}/usedCount`).transaction(current => (current || 0) + 1);
            }
            
            if (rewardType === 'ton') {
                this.userState.balance = userUpdates.balance;
                this.userState.totalEarned = userUpdates.totalEarned;
            } else {
                this.userState.xp = userUpdates.xp;
            }
            this.userState.totalPromoCodes = userUpdates.totalPromoCodes;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            this.updateHeader();
            promoInput.value = '';
            
            this.notificationManager.showNotification(
                "Success", 
                `Promo code applied! +${rewardAmount} ${rewardType === 'ton' ? 'TON' : 'XP'}`, 
                "success"
            );
            
        } catch (error) {
            console.error('Handle promo code error:', error);
            this.notificationManager.showNotification("Error", "Failed to apply promo code", "error");
        } finally {
            promoBtn.innerHTML = originalText;
            promoBtn.disabled = false;
        }
    }

    setupTaskButtons() {
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
                const taskXp = parseInt(btn.getAttribute('data-task-xp')) || 1;
                
                if (taskId && taskUrl) {
                    e.preventDefault();
                    await this.handleTask(taskId, taskUrl, taskType, taskReward, taskXp, btn);
                }
            });
        });
    }

    async handleTask(taskId, url, taskType, reward, xpReward, button) {
        if (this.userCompletedTasks.has(taskId)) {
            this.notificationManager.showNotification("Already Completed", "You have already completed this task", "info");
            return;
        }
        
        if (this.isProcessingTask) {
            this.notificationManager.showNotification("Busy", "Please complete current task first", "warning");
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'task_start');
        if (!rateLimitCheck.allowed) {
            this.notificationManager.showNotification(
                "Rate Limit", 
                `Please wait ${rateLimitCheck.remaining} seconds before starting another task`, 
                "warning"
            );
            return;
        }
        
        this.rateLimiter.addRequest(this.tgUser.id, 'task_start');
        
        window.open(url, '_blank');
        
        this.disableAllTaskButtons();
        this.isProcessingTask = true;
        
        const originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cheaking...';
        button.disabled = true;
        button.classList.remove('start');
        button.classList.add('counting');
        
        let secondsLeft = 10;
        const countdown = setInterval(() => {
            secondsLeft--;
            if (secondsLeft > 0) {
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cheaking...';
            } else {
                clearInterval(countdown);
                button.innerHTML = 'CHECK';
                button.disabled = false;
                button.classList.remove('counting');
                button.classList.add('check');
                
                const newButton = button.cloneNode(true);
                button.parentNode.replaceChild(newButton, button);
                
                newButton.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.handleCheckTask(taskId, url, taskType, reward, xpReward, newButton);
                });
            }
        }, 1000);
        
        setTimeout(() => {
            if (secondsLeft > 0) {
                clearInterval(countdown);
                button.innerHTML = originalText;
                button.disabled = false;
                button.classList.remove('counting');
                button.classList.add('start');
                this.enableAllTaskButtons();
                this.isProcessingTask = false;
            }
        }, 11000);
    }

    async handleCheckTask(taskId, url, taskType, reward, xpReward, button) {
        if (button) {
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
            button.disabled = true;
        }
        
        this.disableAllTaskButtons();
        this.isProcessingTask = true;
        
        try {
            let task = null;
            if (this.taskManager) {
                const allTasks = [...(this.taskManager.mainTasks || []), ...(this.taskManager.socialTasks || [])];
                for (const t of allTasks) {
                    if (t.id === taskId) {
                        task = t;
                        break;
                    }
                }
            }
            
            if (!task) {
                throw new Error("Task not found");
            }
            
            const chatId = this.taskManager.extractChatIdFromUrl(url);
            
            if (task.type === 'channel' || task.type === 'group') {
                if (chatId && this.botToken) {
                    const verificationResult = await this.taskManager.verifyTaskCompletion(
                        taskId, 
                        chatId, 
                        this.tgUser.id, 
                        this.tg?.initData || '',
                        this.botToken
                    );
                    
                    if (verificationResult.success) {
                        await this.completeTask(taskId, taskType, task.reward, task.xpReward || 1, button);
                    } else {
                        this.notificationManager.showNotification(
                            "Verification Failed", 
                            verificationResult.message || "Please join the channel/group first!", 
                            "error"
                        );
                        
                        this.enableAllTaskButtons();
                        this.isProcessingTask = false;
                        
                        if (button) {
                            button.innerHTML = 'Try Again';
                            button.disabled = false;
                            button.classList.remove('check');
                            button.classList.add('start');
                            
                            const newButton = button.cloneNode(true);
                            button.parentNode.replaceChild(newButton, button);
                            
                            newButton.addEventListener('click', async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                await this.handleTask(taskId, url, taskType, task.reward, task.xpReward || 1, newButton);
                            });
                        }
                    }
                } else {
                    this.notificationManager.showNotification(
                        "Verification Failed", 
                        "Unable to verify task. Please try again.", 
                        "error"
                    );
                    
                    this.enableAllTaskButtons();
                    this.isProcessingTask = false;
                    
                    if (button) {
                        button.innerHTML = 'Try Again';
                        button.disabled = false;
                        button.classList.remove('check');
                        button.classList.add('start');
                        
                        const newButton = button.cloneNode(true);
                        button.parentNode.replaceChild(newButton, button);
                        
                        newButton.addEventListener('click', async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            await this.handleTask(taskId, url, taskType, task.reward, task.xpReward || 1, newButton);
                        });
                    }
                }
            } else {
                await this.completeTask(taskId, taskType, task.reward, task.xpReward || 1, button);
            }
            
        } catch (error) {
            console.error('Error in handleCheckTask:', error);
            this.enableAllTaskButtons();
            this.isProcessingTask = false;
            
            this.notificationManager.showNotification("Error", "Failed to verify task", "error");
            
            if (button) {
                button.innerHTML = 'Try Again';
                button.disabled = false;
                button.classList.remove('check');
                button.classList.add('start');
                
                const newButton = button.cloneNode(true);
                button.parentNode.replaceChild(newButton, button);
                
                newButton.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.handleTask(taskId, url, taskType, reward, xpReward, newButton);
                });
            }
        }
    }

    async completeTask(taskId, taskType, reward, xpReward, button) {
        try {
            if (!this.db) {
                throw new Error("Database not initialized");
            }
            
            let task = null;
            if (this.taskManager) {
                const allTasks = [...(this.taskManager.mainTasks || []), ...(this.taskManager.socialTasks || [])];
                for (const t of allTasks) {
                    if (t.id === taskId) {
                        task = t;
                        break;
                    }
                }
            }
            
            if (!task) {
                throw new Error("Task not found");
            }
            
            const taskReward = this.safeNumber(reward);
            const taskXpReward = this.safeNumber(xpReward || 1);
            
            const currentBalance = this.safeNumber(this.userState.balance);
            const currentXP = this.safeNumber(this.userState.xp);
            const totalEarned = this.safeNumber(this.userState.totalEarned);
            const totalTasks = this.safeNumber(this.userState.totalTasks);
            const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted);
            
            if (this.userCompletedTasks.has(taskId)) {
                this.notificationManager.showNotification("Already Completed", "This task was already completed", "info");
                return false;
            }
            
            const currentTime = this.getServerTime();
            
            const updates = {};
            updates.balance = currentBalance + taskReward;
            updates.xp = currentXP + taskXpReward;
            updates.totalEarned = totalEarned + taskReward;
            updates.totalTasks = totalTasks + 1;
            updates.totalTasksCompleted = totalTasksCompleted + 1;
            
            this.userCompletedTasks.add(taskId);
            updates.completedTasks = [...this.userCompletedTasks];
            
            await this.db.ref(`users/${this.tgUser.id}`).update(updates);
            
            await this.db.ref(`config/tasks/${taskId}/currentCompletions`).transaction(current => {
                const newValue = (current || 0) + 1;
                
                if (newValue >= task.maxCompletions) {
                    this.db.ref(`config/tasks/${taskId}`).update({
                        status: 'completed',
                        taskStatus: 'completed'
                    });
                }
                
                return newValue;
            });
            
            this.userState.balance = currentBalance + taskReward;
            this.userState.xp = currentXP + taskXpReward;
            this.userState.totalEarned = totalEarned + taskReward;
            this.userState.totalTasks = totalTasks + 1;
            this.userState.totalTasksCompleted = totalTasksCompleted + 1;
            this.userState.completedTasks = [...this.userCompletedTasks];
            
            if (button) {
                const taskCard = document.getElementById(`task-${taskId}`);
                if (taskCard) {
                    const taskBtn = taskCard.querySelector('.task-btn');
                    if (taskBtn) {
                        taskBtn.innerHTML = 'COMPLETED';
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

            if (this.userState.referredBy && this.appConfig.REFERRAL_PERCENTAGE > 0) {
                await this.processReferralTaskBonus(this.userState.referredBy, taskReward);
            }
            
            this.enableAllTaskButtons();
            this.isProcessingTask = false;

            this.notificationManager.showNotification(
                "Task Completed!", 
                `+${taskReward.toFixed(5)} TON, +${taskXpReward} XP`, 
                "success"
            );
            
            return true;
            
        } catch (error) {
            console.error('Error in completeTask:', error);
            this.enableAllTaskButtons();
            this.isProcessingTask = false;
            
            this.notificationManager.showNotification("Error", "Failed to complete task", "error");
            
            if (button) {
                button.innerHTML = 'Try Again';
                button.disabled = false;
                button.classList.remove('check');
                button.classList.add('start');
            }
            
            throw error;
        }
    }

    disableAllTaskButtons() {
        document.querySelectorAll('.task-btn:not(.completed):not(.counting):not(:disabled)').forEach(btn => {
            btn.disabled = true;
        });
    }

    enableAllTaskButtons() {
        document.querySelectorAll('.task-btn:not(.completed):not(.counting)').forEach(btn => {
            btn.disabled = false;
        });
    }

    formatTime(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    isAdAvailable(adNumber) {
        return false;
    }

    getAdTimeLeft(adNumber) {
        return 0;
    }

    getAdButtonText(adNumber) {
        return '';
    }

    setupAdWatchEvents() {
    }

    async watchAd(adNumber) {
    }

    updateAdButtons() {
    }

    startAdTimers() {
    }

    async renderReferralsPage() {
        const referralsPage = document.getElementById('referrals-page');
        if (!referralsPage) return;
        
        const referralLink = `https://t.me/${this.appConfig.BOT_USERNAME}/app?startapp=${this.tgUser.id}`;
        const referrals = this.safeNumber(this.userState.referrals || 0);
        const referralEarnings = this.safeNumber(this.userState.referralEarnings || 0);
        
        const recentReferrals = await this.referralManager.loadRecentReferrals();
        
        referralsPage.innerHTML = `
            <div class="referrals-container">
                <div class="referral-link-section">
                    <div class="referral-link-box">
                        <p class="link-label">Your referral link:</p>
                        <div class="link-display" id="referral-link-text">${referralLink}</div>
                        <button class="copy-btn" id="copy-referral-link-btn">
                            <i class="far fa-copy"></i> Copy Link
                        </button>
                    </div>
                    
                    <div class="referral-info">
                        <div class="info-card">
                            <div class="info-icon">
                                <i class="fas fa-gift"></i>
                            </div>
                            <div class="info-content">
                                <h4>Get ${this.appConfig.REFERRAL_BONUS_TON} TON</h4>
                                <p>For each verified referral</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="referral-stats-section">
                    <h3><i class="fas fa-chart-bar"></i> Referrals Statistics</h3>
                    <div class="stats-grid-two">
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-users"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Referrals</h4>
                                <p class="stat-value">${referrals}</p>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-coins"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Earnings</h4>
                                <p class="stat-value">${referralEarnings.toFixed(5)} TON</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="last-referrals-section">
                    <h3><i class="fas fa-history"></i> Recent Referrals</h3>
                    <div class="referrals-list" id="referrals-list">
                        ${recentReferrals.length > 0 ? 
                            recentReferrals.map(referral => this.renderReferralRow(referral)).join('') : 
                            '<div class="no-data"><i class="fas fa-handshake"></i><p>No referrals yet</p><p class="hint">Share your link to earn free TON!</p></div>'
                        }
                    </div>
                </div>
            </div>
        `;
        
        this.setupReferralsPageEvents();
    }

    renderReferralRow(referral) {
        return `
            <div class="referral-row">
                <div class="referral-row-avatar">
                    <img src="${referral.photoUrl}" alt="${referral.firstName}" 
                         oncontextmenu="return false;" 
                         ondragstart="return false;">
                </div>
                <div class="referral-row-info">
                    <p class="referral-row-username">${referral.username}</p>
                </div>
                <div class="referral-row-status ${referral.state}">
                    ${referral.state === 'verified' ? 'COMPLETED' : 'PENDING'}
                </div>
            </div>
        `;
    }

    setupReferralsPageEvents() {
        const copyBtn = document.getElementById('copy-referral-link-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const referralLink = `https://t.me/${this.appConfig.BOT_USERNAME}/app?startapp=${this.tgUser.id}`;
                this.copyToClipboard(referralLink);
                
                copyBtn.classList.add('copied');
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = originalText;
                }, 2000);
            });
        }
    }

    async refreshReferralsList() {
        try {
            await this.referralManager.refreshReferralsList();
        } catch (error) {
            console.warn('Refresh referrals list error:', error);
        }
    }

    renderProfilePage() {
        const profilePage = document.getElementById('profile-page');
        if (!profilePage) return;
        
        const joinDate = new Date(this.userState.createdAt || this.getServerTime());
        const formattedDate = this.formatDate(joinDate);
        
        const totalWatchAds = this.safeNumber(this.userState.totalWatchAds || 0);
        const requiredAds = this.appConfig.REQUIRED_ADS_FOR_WITHDRAWAL;
        const adsProgress = Math.min(totalWatchAds, requiredAds);
        
        const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted || 0);
        const requiredTasks = this.appConfig.REQUIRED_TASKS_FOR_WITHDRAWAL;
        const tasksProgress = Math.min(totalTasksCompleted, requiredTasks);
        
        const totalReferrals = this.safeNumber(this.userState.referrals || 0);
        const requiredReferrals = this.appConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL;
        const referralsProgress = Math.min(totalReferrals, requiredReferrals);
        
        const canWithdraw = totalWatchAds >= requiredAds && 
                           totalTasksCompleted >= requiredTasks && 
                           totalReferrals >= requiredReferrals;
        
        const maxBalance = this.safeNumber(this.userState.balance);
        
        profilePage.innerHTML = `
            <div class="profile-container">
                <div class="profile-stats-section">
                    <h3><i class="fas fa-chart-line"></i> Statistics</h3>
                    <div class="profile-stats-grid compact">
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-coins"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Earnings</h4>
                                <p class="stat-value">${this.safeNumber(this.userState.totalEarned).toFixed(5)} TON</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-users"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Referrals</h4>
                                <p class="stat-value">${this.userState.referrals || 0}</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-tasks"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Tasks</h4>
                                <p class="stat-value">${totalTasksCompleted}</p>
                            </div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-icon">
                                <i class="fas fa-paper-plane"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Withdrawals</h4>
                                <p class="stat-value">${this.userState.totalWithdrawals || 0}</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Deposit Card -->
                <div class="deposit-card profile-card-item">
                    <div class="deposit-header">
                        <div class="deposit-icon">
                            <i class="fas fa-arrow-down"></i>
                        </div>
                        <div class="deposit-title">Deposit TON</div>
                    </div>
                    <div class="deposit-info">
                        <div class="deposit-row">
                            <span class="deposit-label">Wallet:</span>
                            <span class="deposit-value" id="deposit-wallet">${this.appConfig.DEPOSIT_WALLET}</span>
                            <button class="deposit-copy-btn" data-copy="wallet">
                                <i class="far fa-copy"></i> Copy
                            </button>
                        </div>
                        <div class="deposit-row">
                            <span class="deposit-label">Comment:</span>
                            <span class="deposit-value" id="deposit-comment">${this.tgUser.id}</span>
                            <button class="deposit-copy-btn" data-copy="comment">
                                <i class="far fa-copy"></i> Copy
                            </button>
                        </div>
                        <div class="deposit-note">
                            <i class="fas fa-info-circle"></i>
                            <span>Send exactly the amount with this comment</span>
                        </div>
                    </div>
                </div>
                
                <!-- Exchange Card -->
                <div class="exchange-card profile-card-item">
                    <div class="exchange-header">
                        <div class="exchange-icon">
                            <i class="fas fa-exchange-alt"></i>
                        </div>
                        <div class="exchange-title">Exchange</div>
                    </div>
                    <div class="exchange-rate">
                        <i class="fas fa-info-circle"></i>
                        <span>1 TON = <strong>${this.appConfig.XP_PER_TON} XP</strong> (Min: ${this.appConfig.MIN_EXCHANGE_TON} TON)</span>
                    </div>
                    <div class="exchange-input-group">
                        <input type="number" id="exchange-input" class="exchange-input" 
                               placeholder="TON amount" step="0.01" min="${this.appConfig.MIN_EXCHANGE_TON}">
                        <button class="exchange-btn" id="exchange-btn">
                            <i class="fas fa-coins"></i> Exchange
                        </button>
                    </div>
                </div>
                
                <div class="withdraw-card">
                    <div class="withdraw-info">
                        <h3><i class="fas fa-wallet"></i> Withdraw TON</h3>
                    </div>
                    
                    <div class="requirements-section">
                        <div class="requirement-item">
                            <div class="requirement-header">
                                <span><i class="fas fa-ad"></i> Watch Ads</span>
                                <span class="requirement-count">${adsProgress}/${requiredAds}</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${(adsProgress/requiredAds)*100}%"></div>
                            </div>
                        </div>
                        
                        <div class="requirement-item">
                            <div class="requirement-header">
                                <span><i class="fas fa-tasks"></i> Complete Tasks</span>
                                <span class="requirement-count">${tasksProgress}/${requiredTasks}</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${(tasksProgress/requiredTasks)*100}%"></div>
                            </div>
                        </div>
                        
                        <div class="requirement-item">
                            <div class="requirement-header">
                                <span><i class="fas fa-users"></i> Invite Friends</span>
                                <span class="requirement-count">${referralsProgress}/${requiredReferrals}</span>
                            </div>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${(referralsProgress/requiredReferrals)*100}%"></div>
                            </div>
                        </div>
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
                                   step="0.00001" min="${this.appConfig.MINIMUM_WITHDRAW}" 
                                   max="${maxBalance}"
                                   placeholder="Minimum: ${this.appConfig.MINIMUM_WITHDRAW.toFixed(3)} TON"
                                   required>
                            <button type="button" class="max-btn" id="max-btn">MAX</button>
                        </div>
                    </div>
                    
                    <div class="withdraw-minimum-info">
                        <i class="fas fa-info-circle"></i>
                        <span>Minimum Withdrawal: <strong>${this.appConfig.MINIMUM_WITHDRAW.toFixed(3)} TON</strong></span>
                    </div>
                    
                    <button id="profile-withdraw-btn" class="withdraw-btn" 
                            ${!canWithdraw || maxBalance < this.appConfig.MINIMUM_WITHDRAW ? 'disabled' : ''}>
                        <i class="fas fa-paper-plane"></i> 
                        ${canWithdraw ? 'WITHDRAW NOW' : this.getWithdrawButtonText(adsProgress, tasksProgress, referralsProgress)}
                    </button>
                </div>
            </div>
        `;
        
        this.setupProfilePageEvents();
    }

    getWithdrawButtonText(adsProgress, tasksProgress, referralsProgress) {
        const requiredAds = this.appConfig.REQUIRED_ADS_FOR_WITHDRAWAL;
        const requiredTasks = this.appConfig.REQUIRED_TASKS_FOR_WITHDRAWAL;
        const requiredReferrals = this.appConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL;
        
        if (adsProgress < requiredAds) {
            return `NEED ${requiredAds - adsProgress} MORE ADS`;
        }
        if (tasksProgress < requiredTasks) {
            return `NEED ${requiredTasks - tasksProgress} MORE TASKS`;
        }
        if (referralsProgress < requiredReferrals) {
            return `NEED ${requiredReferrals - referralsProgress} MORE FRIENDS`;
        }
        return 'WITHDRAW NOW';
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
        
        return this.userWithdrawals.map(withdrawal => `
            <div class="withdrawal-item">
                <div class="withdrawal-header">
                    <span class="withdrawal-amount">${withdrawal.amount?.toFixed(5)} TON</span>
                    <span class="withdrawal-status ${withdrawal.status}">${withdrawal.status.toUpperCase()}</span>
                </div>
                <div class="withdrawal-details">
                    <div class="withdrawal-detail">
                        <i class="fas fa-wallet"></i>
                        <span class="withdrawal-wallet">${this.truncateAddress(withdrawal.walletAddress)}</span>
                    </div>
                    <div class="withdrawal-detail">
                        <i class="fas fa-clock"></i>
                        <span>${this.formatDateTime(withdrawal.createdAt || withdrawal.timestamp)}</span>
                    </div>
                    ${withdrawal.status === 'completed' && withdrawal.transactionLink ? `
                        <div class="withdrawal-detail">
                            <i class="fas fa-link"></i>
                            <a href="${withdrawal.transactionLink}" target="_blank" class="transaction-link">View Transaction</a>
                        </div>
                    ` : ''}
                </div>
            </div>
        `).join('');
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

    setupProfilePageEvents() {
        const withdrawBtn = document.getElementById('profile-withdraw-btn');
        const walletInput = document.getElementById('profile-wallet-input');
        const amountInput = document.getElementById('profile-amount-input');
        const maxBtn = document.getElementById('max-btn');
        
        const copyButtons = document.querySelectorAll('[data-copy]');
        copyButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.copy;
                let text = '';
                
                if (type === 'wallet') {
                    text = this.appConfig.DEPOSIT_WALLET;
                } else if (type === 'comment') {
                    text = this.tgUser.id.toString();
                }
                
                if (text) {
                    this.copyToClipboard(text);
                    
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                    
                    setTimeout(() => {
                        btn.innerHTML = originalText;
                    }, 2000);
                }
            });
        });
        
        const exchangeBtn = document.getElementById('exchange-btn');
        if (exchangeBtn) {
            exchangeBtn.addEventListener('click', () => this.exchangeTonToXp());
        }
        
        const exchangeInput = document.getElementById('exchange-input');
        if (exchangeInput) {
            exchangeInput.addEventListener('input', () => {});
        }
        
        if (maxBtn) {
            maxBtn.addEventListener('click', () => {
                const max = this.safeNumber(this.userState.balance);
                amountInput.value = max.toFixed(5);
            });
        }
        
        if (withdrawBtn) {
            withdrawBtn.addEventListener('click', async () => {
                await this.handleProfileWithdrawal(walletInput, amountInput, withdrawBtn);
            });
        }
        
        if (amountInput) {
            amountInput.addEventListener('input', () => {
                const max = this.safeNumber(this.userState.balance);
                const value = parseFloat(amountInput.value) || 0;
                
                if (value > max) {
                    amountInput.value = max.toFixed(5);
                }
            });
        }
    }
    
    async handleProfileWithdrawal(walletInput, amountInput, withdrawBtn) {
        if (!walletInput || !amountInput || !withdrawBtn) return;
        
        const walletAddress = walletInput.value.trim();
        const amount = parseFloat(amountInput.value);
        const userBalance = this.safeNumber(this.userState.balance);
        const minimumWithdraw = this.appConfig.MINIMUM_WITHDRAW;
        const totalWatchAds = this.safeNumber(this.userState.totalWatchAds || 0);
        const requiredAds = this.appConfig.REQUIRED_ADS_FOR_WITHDRAWAL;
        const totalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted || 0);
        const requiredTasks = this.appConfig.REQUIRED_TASKS_FOR_WITHDRAWAL;
        const totalReferrals = this.safeNumber(this.userState.referrals || 0);
        const requiredReferrals = this.appConfig.REQUIRED_REFERRALS_FOR_WITHDRAWAL;
        
        if (!walletAddress || walletAddress.length < 20) {
            this.notificationManager.showNotification("Error", "Please enter a valid TON wallet address", "error");
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
        
        if (totalWatchAds < requiredAds) {
            const adsNeeded = requiredAds - totalWatchAds;
            this.notificationManager.showNotification("Ads Required", `You need to watch ${adsNeeded} more ads to withdraw`, "error");
            return;
        }
        
        if (totalTasksCompleted < requiredTasks) {
            const tasksNeeded = requiredTasks - totalTasksCompleted;
            this.notificationManager.showNotification("Tasks Required", `You need to complete ${tasksNeeded} more tasks to withdraw`, "error");
            return;
        }
        
        if (totalReferrals < requiredReferrals) {
            const referralsNeeded = requiredReferrals - totalReferrals;
            this.notificationManager.showNotification("Referrals Required", `You need to invite ${referralsNeeded} more friend${referralsNeeded > 1 ? 's' : ''} to withdraw`, "error");
            return;
        }
        
        let adShown = false;
        
        if (typeof window.AdBlock19345 !== 'undefined') {
            try {
                await window.AdBlock19345.show();
                adShown = true;
            } catch (error) {
                console.warn('Ad #1 error:', error);
            }
        }
        
        if (!adShown && typeof show_10558486 !== 'undefined') {
            try {
                await show_10558486();
                adShown = true;
            } catch (error) {
                console.warn('Ad #2 error:', error);
            }
        }
        
        if (!adShown) {
            this.notificationManager.showNotification("Ad Required", "Please watch the ad to process withdrawal", "info");
            return;
        }
        
        const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'withdrawal');
        if (!rateLimitCheck.allowed) {
            this.notificationManager.showNotification(
                "Rate Limit", 
                `Please wait ${rateLimitCheck.remaining} seconds before another withdrawal`, 
                "warning"
            );
            return;
        }
        
        this.rateLimiter.addRequest(this.tgUser.id, 'withdrawal');
        
        const originalText = withdrawBtn.innerHTML;
        withdrawBtn.disabled = true;
        withdrawBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        
        try {
            const newBalance = userBalance - amount;
            const currentTime = this.getServerTime();
            const newTotalWithdrawnAmount = this.safeNumber(this.userState.totalWithdrawnAmount) + amount;
            const newTotalWatchAds = this.safeNumber(this.userState.totalWatchAds) - requiredAds;
            const newTotalTasksCompleted = this.safeNumber(this.userState.totalTasksCompleted) - requiredTasks;
            
            if (this.db) {
                await this.db.ref(`users/${this.tgUser.id}`).update({
                    totalWatchAds: newTotalWatchAds,
                    totalTasksCompleted: newTotalTasksCompleted, 
                    balance: newBalance,
                    totalWithdrawals: this.safeNumber(this.userState.totalWithdrawals) + 1,
                    totalWithdrawnAmount: newTotalWithdrawnAmount,
                    lastWithdrawalDate: currentTime
                });
                
                const requestData = {
                    userId: this.tgUser.id,
                    userName: this.userState.firstName,
                    username: this.userState.username,
                    walletAddress: walletAddress,
                    amount: amount,
                    status: 'pending',
                    createdAt: currentTime,
                    timestamp: currentTime
                };
                
                await this.db.ref('withdrawals/pending').push(requestData);
            }
            this.userState.totalWatchAds = newTotalWatchAds;
            this.userState.totalTasksCompleted = newTotalTasksCompleted;
            this.userState.balance = newBalance;
            this.userState.totalWithdrawals = this.safeNumber(this.userState.totalWithdrawals) + 1;
            this.userState.totalWithdrawnAmount = newTotalWithdrawnAmount;
            this.userState.lastWithdrawalDate = currentTime;
            
            this.cache.delete(`user_${this.tgUser.id}`);
            
            await this.updateAppStats('totalWithdrawals', 1);
            await this.updateAppStats('totalPayments', amount);
            
            await this.loadHistoryData();
            
            walletInput.value = '';
            amountInput.value = '';
            
            this.updateHeader();
            this.renderProfilePage();
            
            this.notificationManager.showNotification("Success", "Withdrawal request submitted!", "success");
            
        } catch (error) {
            console.error('Handle withdrawal error:', error);
            this.notificationManager.showNotification("Error", `Failed to process withdrawal`, "error");
            withdrawBtn.disabled = false;
            withdrawBtn.innerHTML = originalText;
        }
    }

    async exchangeTonToXp() {
        try {
            const exchangeBtn = document.getElementById('exchange-btn');
            const exchangeInput = document.getElementById('exchange-input');
            
            if (!exchangeInput || !exchangeBtn) return;
            
            const tonAmount = parseFloat(exchangeInput.value);
            
            if (!tonAmount || tonAmount < this.appConfig.MIN_EXCHANGE_TON) {
                this.notificationManager.showNotification(
                    "Error",
                    `Minimum exchange is ${this.appConfig.MIN_EXCHANGE_TON} TON`,
                    "error"
                );
                return;
            }
            
            const tonBalance = this.safeNumber(this.userState.balance);
            
            if (tonAmount > tonBalance) {
                this.notificationManager.showNotification("Error", "Insufficient TON balance", "error");
                return;
            }
            
            const rateLimitCheck = this.rateLimiter.checkLimit(this.tgUser.id, 'exchange');
            if (!rateLimitCheck.allowed) {
                this.notificationManager.showNotification(
                    "Rate Limit",
                    `Please wait ${rateLimitCheck.remaining} seconds before another exchange`,
                    "warning"
                );
                return;
            }
            
            this.rateLimiter.addRequest(this.tgUser.id, 'exchange');
            
            const originalText = exchangeBtn.innerHTML;
            exchangeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            exchangeBtn.disabled = true;
            
            try {
                const xpAmount = Math.floor(tonAmount * this.appConfig.XP_PER_TON);
                const newTonBalance = tonBalance - tonAmount;
                const newXpBalance = this.safeNumber(this.userState.xp) + xpAmount;
                
                const updates = {
                    balance: newTonBalance,
                    xp: newXpBalance
                };
                
                if (this.db) {
                    await this.db.ref(`users/${this.tgUser.id}`).update(updates);
                }
                
                this.userState.balance = newTonBalance;
                this.userState.xp = newXpBalance;
                
                this.cache.delete(`user_${this.tgUser.id}`);
                
                exchangeInput.value = '';
                this.updateHeader();
                
                this.notificationManager.showNotification(
                    "Success",
                    `Exchanged ${tonAmount.toFixed(3)} TON to ${xpAmount} XP`,
                    "success"
                );
                
            } catch (error) {
                console.error('Exchange error:', error);
                this.notificationManager.showNotification("Error", "Failed to exchange", "error");
            } finally {
                exchangeBtn.innerHTML = originalText;
                exchangeBtn.disabled = false;
            }
            
        } catch (error) {
            console.error('Exchange error:', error);
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

    formatDate(timestamp) {
        const date = new Date(timestamp);
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const year = date.getFullYear();
        return `${day}-${month}-${year}`;
    }

    formatTime24(timestamp) {
        const date = new Date(timestamp);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
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
}

document.addEventListener('DOMContentLoaded', () => {
    if (!window.Telegram || !window.Telegram.WebApp) {
        document.body.innerHTML = `
            <div class="error-container">
                <div class="error-content">
                    <div class="error-icon">
                        <i class="fab fa-telegram"></i>
                    </div>
                    <h2>RAMADAN BUX</h2>
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
