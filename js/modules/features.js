import { APP_CONFIG, FEATURES_CONFIG } from '../data.js';

class TaskManager {
    constructor(app) {
        this.app = app;
        this.mainTasks = [];
        this.partnerTasks = [];
        this.socialTasks = [];
        this.taskTimers = new Map();
    }

    async loadTasksData(forceRefresh = false) {
        const cacheKey = `tasks_${this.app.tgUser.id}`;
        
        if (!forceRefresh) {
            const cached = this.app.cache.get(cacheKey);
            if (cached) {
                this.mainTasks = cached.mainTasks || [];
                this.socialTasks = cached.socialTasks || [];
                return;
            }
        }
        
        try {
            this.mainTasks = await this.loadTasksFromDatabase('main');
            this.socialTasks = await this.loadTasksFromDatabase('social');
            
            this.app.cache.set(cacheKey, {
                mainTasks: this.mainTasks,
                socialTasks: this.socialTasks
            }, 30000);
            
        } catch (error) {
            this.app.showNotification("Warning", "Failed to load tasks", "warning");
            this.mainTasks = [];
            this.socialTasks = [];
        }
    }

    async loadTasksFromDatabase(category) {
        try {
            if (!this.app.db) return [];
            
            const tasks = [];
            const tasksSnapshot = await this.app.db.ref(`config/tasks`).once('value');
            
            if (tasksSnapshot.exists()) {
                tasksSnapshot.forEach(child => {
                    try {
                        const taskData = child.val();
                        
                        if (taskData.status !== 'active' && taskData.taskStatus !== 'active') {
                            return;
                        }
                        
                        if (taskData.category !== category) {
                            return;
                        }
                        
                        const currentCompletions = taskData.currentCompletions || 0;
                        const maxCompletions = taskData.maxCompletions || 999999;
                        
                        if (currentCompletions >= maxCompletions) {
                            this.app.db.ref(`config/tasks/${child.key}`).update({
                                status: 'completed',
                                taskStatus: 'completed'
                            });
                            return;
                        }
                        
                        const task = { 
                            id: child.key, 
                            name: taskData.name || 'Unknown Task',
                            description: taskData.description || 'Join & Get Reward',
                            picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                            url: taskData.url || '',
                            type: taskData.type || 'channel',
                            category: category,
                            reward: this.app.safeNumber(taskData.reward || 0.0001),
                            xpReward: this.app.safeNumber(taskData.xpReward || 1),
                            currentCompletions: currentCompletions,
                            maxCompletions: maxCompletions,
                            status: taskData.status || 'active',
                            createdBy: taskData.createdBy || null,
                            owner: taskData.owner || null
                        };
                        
                        if (!this.app.userCompletedTasks.has(task.id)) {
                            tasks.push(task);
                        }
                    } catch (error) {
                        // تجاهل الأخطاء
                    }
                });
            }
            
            return tasks;
            
        } catch (error) {
            return [];
        }
    }

    getMainTasks() {
        return this.mainTasks;
    }

    getSocialTasks() {
        return this.socialTasks;
    }

    async verifyTaskCompletion(taskId, chatId, userId, initData, botToken) {
        try {
            if (!botToken) {
                return { success: true, message: "Auto-verified (no bot token)" };
            }
            
            const isBotAdmin = await this.checkBotAdminStatus(chatId, botToken);
            
            if (!isBotAdmin) {
                return { success: true, message: "Auto-verified (bot not admin)" };
            }
            
            try {
                const response = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        chat_id: chatId,
                        user_id: parseInt(userId)
                    })
                });
                
                if (!response.ok) {
                    return { success: false, message: "Verification failed" };
                }
                
                const data = await response.json();
                if (data.ok === true && data.result) {
                    const status = data.result.status;
                    const validStatuses = ['member', 'administrator', 'creator', 'restricted'];
                    const isMember = validStatuses.includes(status);
                    
                    return { 
                        success: isMember, 
                        message: isMember ? "Verified successfully" : "Please join the channel/group first!"
                    };
                } else {
                    return { success: false, message: "Verification failed" };
                }
            } catch (apiError) {
                return { success: false, message: "Verification error" };
            }
            
        } catch (error) {
            return { success: false, message: "Verification error" };
        }
    }

    async checkBotAdminStatus(chatId, botToken) {
        try {
            if (!botToken) {
                return false;
            }
            
            const response = await fetch(`https://api.telegram.org/bot${botToken}/getChatAdministrators`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ chat_id: chatId })
            });
            
            if (!response.ok) {
                return false;
            }
            
            const data = await response.json();
            if (data.ok && data.result) {
                const admins = data.result;
                const isBotAdmin = admins.some(admin => {
                    const isBot = admin.user?.is_bot;
                    const isThisBot = admin.user?.username === this.app.appConfig.BOT_USERNAME.replace('@', '');
                    return isBot && isThisBot;
                });
                return isBotAdmin;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    extractChatIdFromUrl(url) {
        try {
            if (!url) return null;
            
            url = url.toString().trim();
            
            if (url.includes('t.me/')) {
                const match = url.match(/t\.me\/([^\/\?]+)/);
                if (match && match[1]) {
                    const username = match[1];
                    
                    if (username.startsWith('@')) return username;
                    
                    if (/^[a-zA-Z][a-zA-Z0-9_]{4,}$/.test(username)) return '@' + username;
                    
                    return username;
                }
            }
            
            return null;
            
        } catch (error) {
            return null;
        }
    }
}

class QuestManager {
    constructor(app) {
        this.app = app;
    }

    async loadQuestsData() {
        return;
    }

    async updateQuestsProgress() {
        return;
    }
}

class ReferralManager {
    constructor(app) {
        this.app = app;
        this.recentReferrals = [];
        this.currentPage = 1;
        this.itemsPerPage = 10;
        this.isLoading = false;
        this.hasMore = true;
    }

    async loadRecentReferrals(limit = 5) {
        try {
            if (!this.app.db) return [];
            
            const referralsRef = await this.app.db.ref(`referrals/${this.app.tgUser.id}`).once('value');
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
            
            this.recentReferrals = referralsList.sort((a, b) => b.joinedAt - a.joinedAt).slice(0, limit);
            
            return this.recentReferrals;
            
        } catch (error) {
            return [];
        }
    }

    async refreshReferralsList() {
        try {
            if (!this.app.db || !this.app.tgUser) return;
            
            const referralsRef = await this.app.db.ref(`referrals/${this.app.tgUser.id}`).once('value');
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
            
            this.app.userState.referrals = verifiedReferrals.length;
            
            await this.app.loadUserData(true);
            
            if (document.getElementById('referrals-page')?.classList.contains('active')) {
                this.app.renderReferralsPage();
            }
            
            this.app.updateHeader();
            
        } catch (error) {
            // تجاهل الأخطاء
        }
    }

    async checkReferralsVerification() {
        try {
            if (!this.app.db || !this.app.tgUser) return;
            
            const referralsRef = await this.app.db.ref(`referrals/${this.app.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return;
            
            const referrals = referralsRef.val();
            let updated = false;
            
            for (const referralId in referrals) {
                const referral = referrals[referralId];
                
                if (referral.state === 'pending') {
                    const newUserRef = await this.app.db.ref(`users/${referralId}`).once('value');
                    if (newUserRef.exists()) {
                        const newUserData = newUserRef.val();
                        
                        if (newUserData.welcomeTasksCompleted) {
                            await this.app.processReferralRegistrationWithBonus(this.app.tgUser.id, referralId);
                            updated = true;
                        }
                    }
                }
            }
            
            if (updated) {
                this.app.cache.delete(`user_${this.app.tgUser.id}`);
                this.app.cache.delete(`referrals_${this.app.tgUser.id}`);
                
                if (document.getElementById('referrals-page')?.classList.contains('active')) {
                    this.app.renderReferralsPage();
                }
            }
            
        } catch (error) {
            // تجاهل الأخطاء
        }
    }

    async handleReferralBonus(referralId) {
        return false;
    }

    async renderReferralsPage() {
        return;
    }

    setupReferralsPageEvents() {
        return;
    }
}

export { TaskManager, QuestManager, ReferralManager };
