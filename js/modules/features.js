import { APP_CONFIG, FEATURES_CONFIG } from '../data.js';

class TaskManager {
    constructor(app) {
        this.app = app;
        this.mainTasks = [];
        this.partnerTasks = [];
        this.socialTasks = [];
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
                this.userCompletedTasks = new Set(cached.completedTasks || []);
                return;
            }
        }
        
        try {
            this.userCompletedTasks = new Set(this.app.userState.completedTasks || []);
            
            this.mainTasks = await this.loadTasksFromDatabase('main');
            this.partnerTasks = await this.loadTasksFromDatabase('partner');
            this.socialTasks = await this.loadTasksFromDatabase('social');
            
            this.app.cache.set(cacheKey, {
                mainTasks: this.mainTasks,
                partnerTasks: this.partnerTasks,
                socialTasks: this.socialTasks,
                completedTasks: Array.from(this.userCompletedTasks)
            }, 30000);
            
        } catch (error) {
            this.mainTasks = [];
            this.partnerTasks = [];
            this.socialTasks = [];
        }
    }

    async loadTasksFromDatabase(category) {
        try {
            if (!this.app.db) return [];
            
            const tasks = [];
            
            const tasksSnapshot = await this.app.db.ref('config/tasks').once('value');
            if (tasksSnapshot.exists()) {
                tasksSnapshot.forEach(child => {
                    try {
                        const taskData = child.val();
                        
                        if (taskData.status !== 'active') {
                            return;
                        }
                        
                        if (taskData.category !== category) {
                            return;
                        }
                        
                        const currentCompletions = taskData.currentCompletions || 0;
                        const maxCompletions = taskData.maxCompletions || 999999;
                        
                        let reward = this.app.safeNumber(taskData.reward || 0.0001);
                        let popReward = this.app.safeNumber(taskData.popReward || 1);
                        
                        if (category === 'social') {
                            reward = APP_CONFIG.SOCIAL_TASK_REWARD;
                            popReward = APP_CONFIG.SOCIAL_TASK_POP_REWARD;
                        }
                        
                        const task = {
                            id: child.key,
                            name: taskData.name || 'Unknown Task',
                            picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                            url: taskData.url || '',
                            type: taskData.type || 'channel',
                            category: category,
                            reward: reward,
                            popReward: popReward,
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
                            
                            if (taskData.status !== 'active') {
                                return;
                            }
                            
                            if (taskData.category !== category) {
                                return;
                            }
                            
                            const currentCompletions = taskData.currentCompletions || 0;
                            const maxCompletions = taskData.maxCompletions || 999999;
                            
                            let reward = this.app.safeNumber(taskData.reward || 0.0001);
                            let popReward = this.app.safeNumber(taskData.popReward || 1);
                            
                            if (category === 'social') {
                                reward = APP_CONFIG.SOCIAL_TASK_REWARD;
                                popReward = APP_CONFIG.SOCIAL_TASK_POP_REWARD;
                            }
                            
                            const task = {
                                id: taskSnapshot.key,
                                name: taskData.name || 'Unknown Task',
                                picture: taskData.picture || this.app.appConfig.BOT_AVATAR,
                                url: taskData.url || '',
                                type: taskData.type || 'channel',
                                category: category,
                                reward: reward,
                                popReward: popReward,
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
            
        } catch (error) {}
    }

    async checkReferralsVerification() {
        try {
            if (!this.app.db || !this.app.tgUser) return;
            
            const referralsRef = await this.app.db.ref(`referrals/${this.app.tgUser.id}`).once('value');
            if (!referralsRef.exists()) return;
            
            const referrals = referralsRef.val();
            let updated = false;
            const requiredTasks = APP_CONFIG.REFERRAL_REQUIRED_TASKS || 1;
            
            for (const referralId in referrals) {
                const referral = referrals[referralId];
                
                if (referral.state === 'pending' && !referral.bonusGiven) {
                    const newUserRef = await this.app.db.ref(`users/${referralId}`).once('value');
                    if (newUserRef.exists()) {
                        const newUserData = newUserRef.val();
                        const completedTasks = newUserData.completedTasksCount || 0;
                        
                        if (newUserData && newUserData.status !== 'ban' && completedTasks >= requiredTasks) {
                            await this.app.giveReferralBonus(this.app.tgUser.id, referralId, referral);
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
            
        } catch (error) {}
    }
    
    async checkUserCompletedTasksForReferral(userId) {
        try {
            if (!this.app.db) return;
            
            const userRef = await this.app.db.ref(`users/${userId}`).once('value');
            if (!userRef.exists()) return;
            
            const userData = userRef.val();
            const completedTasks = userData.completedTasksCount || 0;
            const requiredTasks = APP_CONFIG.REFERRAL_REQUIRED_TASKS || 1;
            
            if (completedTasks >= requiredTasks && userData.referredBy) {
                const referrerId = userData.referredBy;
                const referralRef = await this.app.db.ref(`referrals/${referrerId}/${userId}`).once('value');
                
                if (referralRef.exists()) {
                    const referralData = referralRef.val();
                    
                    if (referralData.state === 'pending' && !referralData.bonusGiven) {
                        await this.app.giveReferralBonus(referrerId, userId, referralData);
                        
                        this.app.cache.delete(`user_${referrerId}`);
                        this.app.cache.delete(`referrals_${referrerId}`);
                        
                        if (this.app.tgUser && referrerId == this.app.tgUser.id) {
                            await this.app.loadUserData(true);
                            if (document.getElementById('referrals-page')?.classList.contains('active')) {
                                this.app.renderReferralsPage();
                            }
                            this.app.updateHeader();
                        }
                    }
                }
            }
            
        } catch (error) {}
    }
}

export { TaskManager, ReferralManager };
