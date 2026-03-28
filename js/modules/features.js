import { APP_CONFIG, REWARDS_CONFIG, REQUIREMENTS_CONFIG } from '../data.js';

class TaskManager {
    constructor(app) {
        this.app = app;
        this.mainTasks = [];
        this.partnerTasks = [];
        this.socialTasks = [];
        this.dailyTasks = [];
        this.taskTimers = new Map();
        this.userCompletedTasks = new Set();
    }

    async loadTasksData(forceRefresh = false) {
        const cacheKey = `tasks_${this.app.tgUser.id}`;
        
        if (!forceRefresh) {
            const cached = this.app.cache.get(cacheKey);
            if (cached) {
                this.mainTasks = cached.mainTasks || [];
                this.partnerTasks = cached.partnerTasks || [];
                this.socialTasks = cached.socialTasks || [];
                this.dailyTasks = cached.dailyTasks || [];
                this.userCompletedTasks = new Set(cached.completedTasks || []);
                return;
            }
        }
        
        try {
            this.userCompletedTasks = new Set(this.app.userState.completedTasks || []);
            
            this.mainTasks = await this.loadTasksFromDatabase('main');
            this.partnerTasks = await this.loadTasksFromDatabase('partner');
            this.socialTasks = await this.loadTasksFromDatabase('social');
            this.dailyTasks = await this.loadDailyTasksFromDatabase();
            
            this.app.cache.set(cacheKey, {
                mainTasks: this.mainTasks,
                partnerTasks: this.partnerTasks,
                socialTasks: this.socialTasks,
                dailyTasks: this.dailyTasks,
                completedTasks: Array.from(this.userCompletedTasks)
            }, 30000);
            
        } catch (error) {
            this.mainTasks = [];
            this.partnerTasks = [];
            this.socialTasks = [];
            this.dailyTasks = [];
        }
    }

    async loadTasksFromDatabase(category) {
        try {
            if (!this.app.db) return [];
            
            const tasks = [];
            let taskReward = 0;
            let taskPopReward = REWARDS_CONFIG.TASK_POP_REWARD;
            
            if (category === 'main') {
                taskReward = REWARDS_CONFIG.MAIN_TASK_REWARD;
            } else if (category === 'partner') {
                taskReward = REWARDS_CONFIG.PARTNER_TASK_REWARD;
            } else {
                taskReward = REWARDS_CONFIG.SOCIAL_TASK_REWARD;
            }
            
            const tasksSnapshot = await this.app.db.ref('config/tasks').once('value');
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
                        
                        const task = {
                            id: child.key,
                            name: taskData.name || 'Unknown Task',
                            picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                            url: taskData.url || '',
                            type: taskData.type || 'channel',
                            category: category,
                            reward: this.app.safeNumber(taskReward),
                            popReward: taskPopReward,
                            currentCompletions: currentCompletions,
                            maxCompletions: maxCompletions,
                            status: taskData.status || 'active',
                            verification: taskData.verification || 'NO',
                            owner: null
                        };
                        
                        if (!this.userCompletedTasks.has(task.id)) {
                            tasks.push(task);
                        }
                    } catch (error) {}
                });
            }
            
            const userTasksSnapshot = await this.app.db.ref('config/userTasks').once('value');
            if (userTasksSnapshot.exists()) {
                userTasksSnapshot.forEach(ownerSnapshot => {
                    ownerSnapshot.forEach(taskSnapshot => {
                        try {
                            const taskData = taskSnapshot.val();
                            
                            if (taskData.status !== 'active' && taskData.taskStatus !== 'active') {
                                return;
                            }
                            
                            if (taskData.category !== category) {
                                return;
                            }
                            
                            const currentCompletions = taskData.currentCompletions || 0;
                            const maxCompletions = taskData.maxCompletions || 999999;
                            
                            const task = {
                                id: taskSnapshot.key,
                                name: taskData.name || 'Unknown Task',
                                picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                                url: taskData.url || '',
                                type: taskData.type || 'channel',
                                category: category,
                                reward: this.app.safeNumber(taskReward),
                                popReward: taskPopReward,
                                currentCompletions: currentCompletions,
                                maxCompletions: maxCompletions,
                                status: taskData.status || 'active',
                                verification: taskData.verification || 'NO',
                                owner: ownerSnapshot.key
                            };
                            
                            if (!this.userCompletedTasks.has(task.id)) {
                                tasks.push(task);
                            }
                        } catch (error) {}
                    });
                });
            }
            
            return tasks;
            
        } catch (error) {
            return [];
        }
    }

    async loadDailyTasksFromDatabase() {
        try {
            if (!this.app.db) return [];
            
            const dailyTasks = [];
            
            const dailySnapshot = await this.app.db.ref('config/dailyTasks').once('value');
            if (dailySnapshot.exists()) {
                dailySnapshot.forEach(child => {
                    try {
                        const taskData = child.val();
                        
                        if (taskData.status !== 'active') {
                            return;
                        }
                        
                        const task = {
                            id: child.key,
                            name: taskData.name || 'Daily Task',
                            picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                            url: taskData.url || '',
                            reward: this.app.safeNumber(taskData.reward || 0),
                            popReward: this.app.safeNumber(taskData.popReward || 0),
                            verification: taskData.verification || 'NO',
                            type: 'daily'
                        };
                        
                        dailyTasks.push(task);
                    } catch (error) {}
                });
            }
            
            return dailyTasks;
            
        } catch (error) {
            return [];
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

class ReferralManager {
    constructor(app) {
        this.app = app;
        this.recentReferrals = [];
        this.referralCheckInterval = null;
    }

    async startReferralMonitor() {
        if (this.referralCheckInterval) {
            clearInterval(this.referralCheckInterval);
        }
        
        this.referralCheckInterval = setInterval(async () => {
            await this.checkPendingReferrals();
        }, 30000);
        
        await this.checkPendingReferrals();
    }

    async checkPendingReferrals() {
        try {
            if (!this.app.db || !this.app.tgUser) return;
            
            const referralsRef = await this.app.db.ref(`referrals/${this.app.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return;
            
            const referrals = referralsRef.val();
            let updated = false;
            
            for (const referralId in referrals) {
                const referral = referrals[referralId];
                
                if (referral.referralStatus === false) {
                    const newUserRef = await this.app.db.ref(`users/${referralId}`).once('value');
                    if (newUserRef.exists()) {
                        const newUserData = newUserRef.val();
                        
                        if (newUserData.telegramId && newUserData.status !== 'ban') {
                            await this.giveReferralBonus(this.app.tgUser.id, referralId, newUserData);
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
                this.app.updateHeader();
            }
            
        } catch (error) {}
    }

    async giveReferralBonus(referrerId, newUserId, newUserData) {
        try {
            if (!this.app.db) return;
            
            const referrerRef = this.app.db.ref(`users/${referrerId}`);
            const referrerSnapshot = await referrerRef.once('value');
            
            if (!referrerSnapshot.exists()) return;
            
            const referrerData = referrerSnapshot.val();
            
            if (referrerData.status === 'ban') return;
            
            const referralBonusTon = REWARDS_CONFIG.REFERRAL_BONUS_TON;
            const referralBonusPop = REWARDS_CONFIG.REFERRAL_BONUS_POP;
            
            const newBalance = this.app.safeNumber(referrerData.balance) + referralBonusTon;
            const newPop = this.app.safeNumber(referrerData.pop) + referralBonusPop;
            const newPopEarnings = this.app.safeNumber(referrerData.popEarnings) + referralBonusPop;
            const newReferrals = (referrerData.referrals || 0) + 1;
            const newReferralEarnings = this.app.safeNumber(referrerData.referralEarnings) + referralBonusTon;
            const newTotalEarned = this.app.safeNumber(referrerData.totalEarned) + referralBonusTon;
            const currentTime = this.app.getServerTime();
            
            await referrerRef.update({
                balance: newBalance,
                pop: newPop,
                popEarnings: newPopEarnings,
                referrals: newReferrals,
                referralEarnings: newReferralEarnings,
                totalEarned: newTotalEarned,
                lastUpdated: currentTime
            });
            
            await this.app.db.ref(`referrals/${referrerId}/${newUserId}`).update({
                referralStatus: true,
                bonusGivenAt: currentTime,
                bonusTonAmount: referralBonusTon,
                bonusPopAmount: referralBonusPop
            });
            
            if (referrerId === this.app.tgUser.id) {
                this.app.userState.balance = newBalance;
                this.app.userState.pop = newPop;
                this.app.userState.popEarnings = newPopEarnings;
                this.app.userState.referrals = newReferrals;
                this.app.userState.referralEarnings = newReferralEarnings;
                this.app.userState.totalEarned = newTotalEarned;
                
                this.app.updateHeader();
            }
            
            this.app.cache.delete(`user_${referrerId}`);
            this.app.cache.delete(`referrals_${referrerId}`);
            
        } catch (error) {}
    }

    async registerReferral(newUserId, referrerId) {
        try {
            if (!this.app.db) return;
            
            const currentTime = this.app.getServerTime();
            
            const referralData = {
                userId: newUserId,
                username: this.app.tgUser.username ? `@${this.app.tgUser.username}` : 'No Username',
                firstName: this.app.getShortName(this.app.tgUser.first_name || ''),
                photoUrl: this.app.tgUser.photo_url || this.app.appConfig.DEFAULT_USER_AVATAR,
                joinedAt: currentTime,
                referralStatus: false,
                telegramId: newUserId
            };
            
            await this.app.db.ref(`referrals/${referrerId}/${newUserId}`).set(referralData);
            
            await this.app.db.ref(`users/${newUserId}`).update({
                referredBy: referrerId,
                lastUpdated: currentTime
            });
            
        } catch (error) {}
    }

    async loadRecentReferrals() {
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
            
            this.recentReferrals = referralsList.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0)).slice(0, 5);
            
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
                if (referral.referralStatus === true) {
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
            
        } catch (error) {}
    }
}

export { TaskManager, ReferralManager };
