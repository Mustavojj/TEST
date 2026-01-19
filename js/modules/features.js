const FEATURES_CONFIG = {
    TASK_VERIFICATION_DELAY: 10,
    REFERRAL_BONUS_TON: 0.005,
    REFERRAL_BONUS_GAMES: 1,
    TASK_GAME_BONUS: 1,
    REFERRALS_PER_PAGE: 10,
    PARTNER_TASK_REWARD: 0.001,
    SOCIAL_TASK_REWARD: 0.0005
};

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
                this.partnerTasks = cached.partnerTasks || [];
                this.socialTasks = cached.socialTasks || [];
                return;
            }
        }
        
        try {
            this.partnerTasks = [];
            this.socialTasks = [];
            
            if (this.app.db) {
                const tasksSnapshot = await this.app.db.ref('config/tasks').once('value');
                
                if (tasksSnapshot.exists()) {
                    tasksSnapshot.forEach(child => {
                        try {
                            const taskData = child.val();
                            const category = taskData.category || 'social';
                            
                            const fixedReward = category === 'partner' 
                                ? FEATURES_CONFIG.PARTNER_TASK_REWARD 
                                : FEATURES_CONFIG.SOCIAL_TASK_REWARD;
                            
                            const task = { 
                                id: child.key, 
                                name: taskData.name || 'Unknown Task',
                                url: taskData.url || '',
                                type: taskData.type || 'channel',
                                category: category,
                                reward: fixedReward,
                                currentCompletions: taskData.currentCompletions || 0,
                                maxCompletions: taskData.maxCompletions || 0,
                                status: taskData.status || 'active',
                                taskStatus: taskData.taskStatus || 'active',
                                description: taskData.description || 'Join & Get Reward'
                            };
                            
                            if (task.status === 'deleted') return;
                            if (task.taskStatus === 'finished') return;
                            if ((task.currentCompletions || 0) >= task.maxCompletions) return;
                            
                            if (task.type === 'channel' || task.type === 'group') {
                                task.isBotAdmin = false;
                            }
                            
                            if (!this.app.userCompletedTasks.has(task.id)) {
                                if (task.category === 'partner') {
                                    this.partnerTasks.push(task);
                                } else {
                                    this.socialTasks.push(task);
                                }
                            }
                        } catch (error) {
                        }
                    });
                }
            }
            
            this.app.cache.set(cacheKey, {
                partnerTasks: this.partnerTasks,
                socialTasks: this.socialTasks
            }, 30000);
            
        } catch (error) {
            this.partnerTasks = [];
            this.socialTasks = [];
        }
    }

    getPartnerTasks() {
        return this.partnerTasks;
    }

    getSocialTasks() {
        return this.socialTasks;
    }

    async checkBotAdminForTask(task) {
        try {
            if (!task.url) {
                task.isBotAdmin = false;
                return false;
            }
            
            const chatId = this.extractChatIdFromUrl(task.url);
            if (!chatId) {
                task.isBotAdmin = false;
                return false;
            }
            
            const response = await fetch('/api/telegram', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'getChatMember',
                    params: {
                        chat_id: chatId,
                        user_id: 8315477063
                    }
                })
            });
            
            if (!response.ok) {
                return false;
            }
            
            const data = await response.json();
            
            if (data.ok && data.result) {
                const status = data.result.status;
                task.isBotAdmin = (status === 'administrator' || status === 'creator');
                return task.isBotAdmin;
            } else {
                task.isBotAdmin = false;
                return false;
            }
            
        } catch (error) {
            task.isBotAdmin = false;
            return false;
        }
    }

    async checkUserMembership(url, taskType) {
        try {
            const chatId = this.extractChatIdFromUrl(url);
            if (!chatId) return false;
            
            const userId = this.app.tgUser.id;
            
            const response = await fetch('/api/telegram', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-User-ID': userId.toString()
                },
                body: JSON.stringify({
                    action: 'getChatMember',
                    params: {
                        chat_id: chatId,
                        user_id: userId
                    }
                })
            });
            
            if (!response.ok) {
                return false;
            }
            
            const data = await response.json();
            
            if (!data.ok || !data.result) return false;
            
            const userStatus = data.result.status;
            const isMember = (userStatus === 'member' || userStatus === 'administrator' || 
                            userStatus === 'creator' || userStatus === 'restricted');
            
            return isMember;
            
        } catch (error) {
            return false;
        }
    }

    async handleTask(taskId, url, taskType, reward, button) {
        if (this.app.userCompletedTasks.has(taskId)) {
            this.app.notificationManager.showNotification("Already Completed", "You have already completed this task", "info");
            return;
        }
        
        if (this.app.isProcessingTask) {
            this.app.notificationManager.showNotification("Busy", "Please complete current task first", "warning");
            return;
        }
        
        window.open(url, '_blank');
        
        this.disableAllTaskButtons();
        this.app.isProcessingTask = true;
        
        const originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Wait 10s';
        button.disabled = true;
        button.classList.remove('start');
        button.classList.add('counting');
        
        let secondsLeft = 10;
        const countdown = setInterval(() => {
            secondsLeft--;
            if (secondsLeft > 0) {
                button.innerHTML = `<i class="fas fa-clock"></i> ${secondsLeft}s`;
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
                    await this.handleCheckTask(taskId, url, taskType, reward, newButton);
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
                this.app.isProcessingTask = false;
            }
        }, 11000);
    }

    async handleCheckTask(taskId, url, taskType, reward, button) {
        if (button) {
            button.innerHTML = 'Checking...';
            button.disabled = true;
        }
        
        this.disableAllTaskButtons();
        this.app.isProcessingTask = true;
        
        try {
            let task = null;
            for (const t of [...this.partnerTasks, ...this.socialTasks]) {
                if (t.id === taskId) {
                    task = t;
                    break;
                }
            }
            
            if (!task) {
                throw new Error("Task not found");
            }
            
            const isBotAdmin = await this.checkBotAdminForTask(task);
            
            if (isBotAdmin) {
                const isSubscribed = await this.checkUserMembership(url, taskType);
                
                if (isSubscribed) {
                    await this.completeTask(taskId, taskType, task.reward, button);
                } else {
                    this.app.notificationManager.showNotification("Failed Check!", "You are not member in this channel!", "error");
                    
                    this.enableAllTaskButtons();
                    this.app.isProcessingTask = false;
                    
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
                            await this.handleTask(taskId, url, taskType, task.reward, newButton);
                        });
                    }
                }
            } else {
                await this.completeTask(taskId, taskType, task.reward, button);
            }
            
        } catch (error) {
            this.enableAllTaskButtons();
            this.app.isProcessingTask = false;
            
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
                    await this.handleTask(taskId, url, taskType, reward, newButton);
                });
            }
            
            this.app.notificationManager.showNotification("Error", "Failed to verify task completion", "error");
        }
    }

    async completeTask(taskId, taskType, reward, button) {
        try {
            if (!this.app.db) return false;
            
            let task = null;
            for (const t of [...this.partnerTasks, ...this.socialTasks]) {
                if (t.id === taskId) {
                    task = t;
                    break;
                }
            }
            
            if (!task) {
                throw new Error("Task not found");
            }
            
            const taskReward = task.category === 'partner' 
                ? FEATURES_CONFIG.PARTNER_TASK_REWARD 
                : FEATURES_CONFIG.SOCIAL_TASK_REWARD;
            
            const currentBalance = this.app.safeNumber(this.app.userState.balance);
            const totalEarned = this.app.safeNumber(this.app.userState.totalEarned);
            const totalTasks = this.app.safeNumber(this.app.userState.totalTasks);
            
            if (this.app.userCompletedTasks.has(taskId)) {
                this.app.notificationManager.showNotification("Already Completed", "This task was already completed", "info");
                return false;
            }
            
            const updates = {};
            updates.balance = currentBalance + taskReward;
            updates.totalEarned = totalEarned + taskReward;
            updates.totalTasks = totalTasks + 1;
            
            updates.dicePlays = (this.app.userState.dicePlays || 0) + FEATURES_CONFIG.TASK_GAME_BONUS;
            
            this.app.userCompletedTasks.add(taskId);
            updates.completedTasks = [...this.app.userCompletedTasks];
            
            await this.app.db.ref(`users/${this.app.tgUser.id}`).update(updates);
            
            const taskRef = this.app.db.ref(`config/tasks/${taskId}`);
            const taskSnapshot = await taskRef.once('value');
            
            if (taskSnapshot.exists()) {
                const taskData = taskSnapshot.val();
                const newCompletions = (taskData.currentCompletions || 0) + 1;
                await taskRef.update({ currentCompletions: newCompletions });
                
                if (newCompletions >= taskData.maxCompletions) {
                    await taskRef.update({ taskStatus: 'finished' });
                }
            }
            
            this.app.userState.balance = currentBalance + taskReward;
            this.app.userState.totalEarned = totalEarned + taskReward;
            this.app.userState.totalTasks = totalTasks + 1;
            this.app.userState.dicePlays = (this.app.userState.dicePlays || 0) + FEATURES_CONFIG.TASK_GAME_BONUS;
            this.app.userState.completedTasks = [...this.app.userCompletedTasks];
            
            this.app.totalTasksCompleted = totalTasks + 1;
            await this.app.updateTasksCompleted();
            
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
            
            this.app.notificationManager.showNotification(
                "Completed!", 
                `You received ${taskReward.toFixed(4)} TON + ${FEATURES_CONFIG.TASK_GAME_BONUS} GAME!`, 
                "success"
            );
            
            await this.app.updateAppStats('totalTasks', 1);
            
            this.app.updateHeader();
            this.app.renderDicePage();
            
            this.app.cache.delete(`tasks_${this.app.tgUser.id}`);
            this.app.cache.delete(`user_${this.app.tgUser.id}`);
            
            this.enableAllTaskButtons();
            this.app.isProcessingTask = false;
            
            return true;
            
        } catch (error) {
            this.enableAllTaskButtons();
            this.app.isProcessingTask = false;
            
            if (button) {
                button.innerHTML = 'Try Again';
                button.disabled = false;
                button.classList.remove('check', 'completed');
                button.classList.add('start');
                
                const newButton = button.cloneNode(true);
                button.parentNode.replaceChild(newButton, button);
                
                newButton.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.handleTask(taskId, url, taskType, reward, newButton);
                });
            }
            
            throw error;
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
}

class DiceManager {
    constructor(app) {
        this.app = app;
    }
    
    async handleDicePlay() {
        return this.app.playDice();
    }
}

class ReferralManager {
    constructor(app) {
        this.app = app;
        this.recentReferrals = [];
        this.currentPage = 1;
        this.itemsPerPage = FEATURES_CONFIG.REFERRALS_PER_PAGE;
        this.isLoading = false;
        this.hasMore = true;
    }

    async loadRecentReferrals() {
        try {
            if (!this.app.db) {
                this.recentReferrals = [];
                return;
            }
            
            const referralsRef = this.app.db.ref(`referrals/${this.app.tgUser.id}`);
            const snapshot = await referralsRef.once('value');
            
            this.recentReferrals = [];
            
            if (snapshot.exists()) {
                snapshot.forEach(child => {
                    const referralData = child.val();
                    if (referralData && typeof referralData === 'object') {
                        this.recentReferrals.push({
                            id: child.key,
                            userId: referralData.userId || child.key,
                            username: referralData.username || 'Unknown',
                            firstName: referralData.firstName || 'User',
                            joinedAt: referralData.joinedAt || Date.now(),
                            photoUrl: referralData.photoUrl || 'https://cdn-icons-png.flaticon.com/512/9131/9131529.png',
                            state: referralData.state || 'verified',
                            completedWelcomeTasks: referralData.completedWelcomeTasks || false
                        });
                    }
                });
                
                this.recentReferrals.sort((a, b) => b.joinedAt - a.joinedAt);
                this.hasMore = this.recentReferrals.length >= (this.currentPage * this.itemsPerPage);
            }
            
        } catch (error) {
            this.recentReferrals = [];
            this.hasMore = false;
        }
    }

    async handleReferralBonus(referralId) {
        try {
            if (!referralId || referralId == this.app.tgUser.id) return false;
            if (!this.app.db) return false;
            if (this.app.userState.referredBy) return false;
            
            const referrerRef = this.app.db.ref(`users/${referralId}`);
            const referrerSnapshot = await referrerRef.once('value');
            
            if (!referrerSnapshot.exists()) return false;
            
            const referrerData = referrerSnapshot.val();
            
            if (referrerData.status === 'ban') return false;
            
            await this.app.db.ref(`users/${this.app.tgUser.id}`).update({
                pendingReferral: referralId
            });
            
            this.app.pendingReferralAfterWelcome = referralId;
            
            this.app.notificationManager.showNotification(
                "Referral Registered!", 
                `Bonus will be activated after you complete welcome tasks!`, 
                "success"
            );
            
            return true;
            
        } catch (error) {
            return false;
        }
    }

    async renderReferralsPage() {
        const referralsPage = document.getElementById('referrals-page');
        if (!referralsPage) return;
        
        await this.loadRecentReferrals();
        
        const referralLink = `https://t.me/NinjaTONS_Bot/earn?startapp=${this.app.tgUser.id}`;
        const referrals = this.app.safeNumber(this.app.userState.referrals || 0);
        const referralEarnings = this.app.safeNumber(this.app.userState.referralEarnings || 0);
        const referralGames = referrals * FEATURES_CONFIG.REFERRAL_BONUS_GAMES;
        
        const last10Referrals = this.recentReferrals.slice(0, 10);
        
        referralsPage.innerHTML = `
            <div class="referrals-container">
                <div class="referral-link-section">
                    <div class="referral-link-box">
                        <p class="link-label">Your referral link:</p>
                        <div class="link-display" id="referral-link-text">${referralLink}</div>
                        <button class="copy-btn" id="copy-referral-link-btn">
                            <i class="far fa-copy"></i> Copy
                        </button>
                    </div>
                    
                    <div class="referral-instructions">
                        <p><i class="fas fa-info-circle"></i> <b>Earn ${FEATURES_CONFIG.REFERRAL_BONUS_TON} TON +${FEATURES_CONFIG.REFERRAL_BONUS_GAMES} GAME Per Referral</b></p>
                
                    </div>
                    
                    <button class="share-btn" id="share-referral-btn">
                        <i class="fas fa-share-alt"></i> <b>SHARE</b>
                    </button>
                </div>
                
                <div class="referral-stats-section">
                    <h3><i class="fas fa-chart-bar"></i> Referrals Statistics</h3>
                    <div class="stats-grid">
                        <div class="stat-card" style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.9), rgba(29, 78, 216, 0.9));">
                            <div class="stat-icon">
                                <i class="fas fa-users"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Referrals</h4>
                                <p class="stat-value">${referrals} User${referrals !== 1 ? 's' : ''}</p>
                            </div>
                        </div>
                        <div class="stat-card" style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.9), rgba(29, 78, 216, 0.9));">
                            <div class="stat-icon">
                                <i class="fas fa-coins"></i>
                            </div>
                            <div class="stat-info">
                                <h4>Total Earnings</h4>
                                <p class="stat-value">
                                    <span>${referralEarnings.toFixed(3)} TON</span>
                                    <span class="play-part">${referralGames} GAME${referralGames !== 1 ? 'S' : ''}</span>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
                
                ${last10Referrals.length > 0 ? `
                <div class="last-referrals-section">
                    <h3><i class="fas fa-history"></i> Last Referrals</h3>
                    <div class="referrals-list">
                        ${last10Referrals.map(referral => `
                            <div class="referral-item">
                                <div class="referral-avatar">
                                    <img src="${referral.photoUrl}" alt="${referral.firstName}" 
                                         oncontextmenu="return false;" 
                                         ondragstart="return false;">
                                </div>
                                <div class="referral-info">
                                    <p class="referral-username">${referral.username}</p>
                                </div>
                                <div class="referral-status">
                                    <span class="status-badge ${referral.state}">${referral.state === 'verified' ? 'Verified' : 'Pending'}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : `
                <div class="no-data">
                    <i class="fas fa-handshake"></i>
                    <p>No referrals yet</p>
                    <p class="hint">Share your link to earn free TON!</p>
                  
                </div>
                `}
            </div>
        `;
        
        this.setupReferralsPageEvents();
    }

    setupReferralsPageEvents() {
        const copyBtn = document.getElementById('copy-referral-link-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const referralLink = `https://t.me/NinjaTONS_Bot/earn?startapp=${this.app.tgUser.id}`;
                this.app.copyToClipboard(referralLink);
                
                copyBtn.classList.add('copied');
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = originalText;
                }, 2000);
            });
        }
        
        const shareBtn = document.getElementById('share-referral-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', async () => {
                const referralLink = `https://t.me/NinjaTONS_Bot/earn?startapp=${this.app.tgUser.id}`;
                const shareText = `🥷 Join Ninja TON and earn free TON!\n\n🖇 Use my referral link to get bonus rewards:\n\n${referralLink}\n\n🏆 Complete tasks and earn TON!\n💰 Let's earn together!`;
                
                const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;
                window.open(telegramShareUrl, '_blank');
            });
        }
    }
}

export { TaskManager, DiceManager, ReferralManager };
