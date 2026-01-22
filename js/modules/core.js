const CORE_CONFIG = {
    CACHE_TTL: 300000,
    RATE_LIMITS: {
        'withdrawal': { limit: 1, window: 86400000 },
        'ad_reward': { limit: 10, window: 300000 }
    },
    NOTIFICATION_COOLDOWN: 2000,
    MAX_NOTIFICATION_QUEUE: 3,
    AD_COOLDOWN: 60000
};

class CacheManager {
    constructor() {
        this.cache = new Map();
        this.ttl = new Map();
        this.defaultTTL = CORE_CONFIG.CACHE_TTL;
    }

    set(key, value, ttl = this.defaultTTl) {
        try {
            const expiry = Date.now() + ttl;
            this.cache.set(key, value);
            this.ttl.set(key, expiry);
            this.cleanup();
            return true;
        } catch (error) {
            console.error("Cache set error:", error);
            return false;
        }
    }

    get(key) {
        try {
            const expiry = this.ttl.get(key);
            if (!expiry || Date.now() > expiry) {
                this.delete(key);
                return null;
            }
            return this.cache.get(key);
        } catch (error) {
            console.error("Cache get error:", error);
            return null;
        }
    }

    delete(key) {
        try {
            this.cache.delete(key);
            this.ttl.delete(key);
            return true;
        } catch (error) {
            console.error("Cache delete error:", error);
            return false;
        }
    }

    cleanup() {
        try {
            const now = Date.now();
            for (const [key, expiry] of this.ttl.entries()) {
                if (now > expiry) this.delete(key);
            }
        } catch (error) {
            console.error("Cache cleanup error:", error);
        }
    }

    clear() {
        try {
            this.cache.clear();
            this.ttl.clear();
        } catch (error) {
            console.error("Cache clear error:", error);
        }
    }
}

class RateLimiter {
    constructor() {
        this.requests = new Map();
        this.limits = CORE_CONFIG.RATE_LIMITS;
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
}

class NotificationManager {
    constructor() {
        this.queue = [];
        this.isShowing = false;
        this.maxQueueSize = CORE_CONFIG.MAX_NOTIFICATION_QUEUE;
        this.cooldown = CORE_CONFIG.NOTIFICATION_COOLDOWN;
        
        this.addNotificationStyles();
    }
    
    addNotificationStyles() {
        if (!document.getElementById('notification-styles')) {
            const style = document.createElement('style');
            style.id = 'notification-styles';
            style.textContent = `
                @keyframes notificationSlideIn {
                    0% { opacity: 0; transform: translateX(-50%) translateY(20px) scale(0.9); }
                    70% { opacity: 1; transform: translateX(-50%) translateY(-5px) scale(1.02); }
                    100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
                }
                
                @keyframes notificationSlideOut {
                    0% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
                    100% { opacity: 0; transform: translateX(-50%) translateY(20px) scale(0.9); }
                }
                
                @keyframes notificationProgress {
                    from { width: 100%; }
                    to { width: 0%; }
                }
                
                .notification {
                    position: fixed;
                    top: 80px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 85%;
                    max-width: 320px;
                    background: var(--card-bg-solid);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 15px 18px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
                    z-index: 10000;
                    animation: notificationSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
                    border: 1px solid var(--card-border);
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                }
                
                .notification.info { border-left: 6px solid var(--info-color); }
                .notification.success { border-left: 6px solid var(--success-color); }
                .notification.error { border-left: 6px solid var(--error-color); }
                .notification.warning { border-left: 6px solid var(--warning-color); }
                
                .notification-icon {
                    width: 42px;
                    height: 42px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.1rem;
                    flex-shrink: 0;
                }
                
                .notification.info .notification-icon {
                    background: linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(59, 130, 246, 0.25));
                    color: var(--info-color);
                }
                
                .notification.success .notification-icon {
                    background: linear-gradient(135deg, rgba(74, 222, 128, 0.15), rgba(74, 222, 128, 0.25));
                    color: var(--success-color);
                }
                
                .notification.error .notification-icon {
                    background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.25));
                    color: var(--error-color);
                }
                
                .notification.warning .notification-icon {
                    background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.25));
                    color: var(--warning-color);
                }
                
                .notification-content {
                    flex: 1;
                    min-width: 0;
                }
                
                .notification-title {
                    font-weight: 700;
                    color: var(--text-primary);
                    font-size: 0.95rem;
                    margin-bottom: 3px;
                    line-height: 1.2;
                }
                
                .notification-body {
                    color: var(--text-secondary);
                    font-size: 0.85rem;
                    line-height: 1.3;
                }
                
                .notification-progress-bar {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    width: 100%;
                    height: 3px;
                    background: rgba(0, 0, 0, 0.05);
                }
                
                .notification-progress-fill {
                    height: 100%;
                    background: var(--primary-color);
                    animation: notificationProgress 4s linear forwards;
                }
                
                .notification-close {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    width: 22px;
                    height: 22px;
                    background: rgba(0, 0, 0, 0.05);
                    border: none;
                    border-radius: 50%;
                    color: var(--text-light);
                    font-size: 0.8rem;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.6;
                    transition: all 0.2s;
                }
                
                .notification-close:hover {
                    opacity: 1;
                    background: rgba(0, 0, 0, 0.1);
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    async showNotification(title, message, type = 'info') {
        try {
            this.queue.push({ title, message, type, timestamp: Date.now() });
            if (this.queue.length > this.maxQueueSize) this.queue.shift();
            await this.processQueue();
        } catch (error) {
            console.error("Show notification error:", error);
        }
    }
    
    async processQueue() {
        if (this.isShowing || this.queue.length === 0) return;
        
        try {
            this.isShowing = true;
            const notification = this.queue.shift();
        
            const notificationId = `notification-${Date.now()}`;
            const notificationEl = document.createElement('div');
            notificationEl.id = notificationId;
            notificationEl.className = `notification ${notification.type}`;
            
            let icon = 'fa-info-circle';
            if (notification.type === 'success') icon = 'fa-check-circle';
            if (notification.type === 'error') icon = 'fa-exclamation-circle';
            if (notification.type === 'warning') icon = 'fa-exclamation-triangle';
            
            notificationEl.innerHTML = `
                <div class="notification-icon">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="notification-content">
                    <div class="notification-title">${this.escapeHtml(notification.title)}</div>
                    <div class="notification-body">${this.escapeHtml(notification.message)}</div>
                </div>
                <button class="notification-close" data-notification-id="${notificationId}">
                    <i class="fas fa-times"></i>
                </button>
                <div class="notification-progress-bar">
                    <div class="notification-progress-fill"></div>
                </div>
            `;
            
            document.body.appendChild(notificationEl);
            
            const closeBtn = notificationEl.querySelector('.notification-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    this.closeNotification(notificationId);
                });
            }
            
            setTimeout(() => {
                this.closeNotification(notificationId);
            }, 4000);
            
            await this.delay(this.cooldown);
            this.isShowing = false;
            
            if (this.queue.length > 0) {
                setTimeout(() => this.processQueue(), 500);
            }
        } catch (error) {
            console.error("Process notification queue error:", error);
            this.isShowing = false;
        }
    }
    
    closeNotification(notificationId) {
        const notification = document.getElementById(notificationId);
        if (!notification) return;
        
        notification.style.animation = 'notificationSlideOut 0.3s ease forwards';
        notification.style.opacity = '0';
        
        setTimeout(() => {
            if (notification.parentNode) notification.parentNode.removeChild(notification);
        }, 300);
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    escapeHtml(text) {
        try {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        } catch (error) {
            return text || '';
        }
    }
}

class SecurityManager {
    constructor() {
        this.bannedCountries = [];
    }

    async initializeSecurity(tgId) {
        try {
            return true;
        } catch (error) {
            console.error("Initialize security error:", error);
            return true;
        }
    }
}

class AdManager {
    constructor(app) {
        this.app = app;
        this.lastAdTime = 0;
        this.adCooldown = CORE_CONFIG.AD_COOLDOWN;
        this.isAdPlaying = false;
    }
    
    async showDiceAd() {
        try {
            if (this.isAdPlaying) return false;
            
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                return new Promise((resolve) => {
                    this.isAdPlaying = true;
                    window.AdBlock19345.show().then((result) => {
                        this.isAdPlaying = false;
                        resolve(true);
                    }).catch((error) => {
                        console.error("Dice ad error:", error);
                        this.isAdPlaying = false;
                        resolve(false);
                    });
                });
            }
            
            return false;
        } catch (error) {
            console.error("Show dice ad error:", error);
            this.isAdPlaying = false;
            return false;
        }
    }
    
    async showDicePrizeAd() {
        try {
            if (this.isAdPlaying) return false;
            
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                return new Promise((resolve) => {
                    this.isAdPlaying = true;
                    window.AdBlock19345.show().then((result) => {
                        this.isAdPlaying = false;
                        resolve(true);
                    }).catch((error) => {
                        console.error("Dice prize ad error:", error);
                        this.isAdPlaying = false;
                        resolve(false);
                    });
                });
            }
            
            return false;
        } catch (error) {
            console.error("Show dice prize ad error:", error);
            this.isAdPlaying = false;
            return false;
        }
    }
    
    async showWithdrawalAd() {
        try {
            if (this.isAdPlaying) return false;
            
            if (window.AdBlock19344 && typeof window.AdBlock19344.show === 'function') {
                return new Promise((resolve) => {
                    this.isAdPlaying = true;
                    window.AdBlock19344.show().then((result) => {
                        this.isAdPlaying = false;
                        resolve(true);
                    }).catch((error) => {
                        console.error("Withdrawal ad error:", error);
                        this.isAdPlaying = false;
                        resolve(false);
                    });
                });
            }
            
            return false;
        } catch (error) {
            console.error("Show withdrawal ad error:", error);
            this.isAdPlaying = false;
            return false;
        }
    }
    
    async showQuestAd() {
        try {
            if (this.isAdPlaying) return false;
            
            if (window.AdBlock19345 && typeof window.AdBlock19345.show === 'function') {
                return new Promise((resolve) => {
                    this.isAdPlaying = true;
                    window.AdBlock19345.show().then((result) => {
                        this.isAdPlaying = false;
                        resolve(true);
                    }).catch((error) => {
                        console.error("Quest ad error:", error);
                        this.isAdPlaying = false;
                        resolve(false);
                    });
                });
            }
            
            return false;
        } catch (error) {
            console.error("Show quest ad error:", error);
            this.isAdPlaying = false;
            return false;
        }
    }
    
    canShowAd() {
        try {
            if (this.app.isProcessingTask || this.isAdPlaying) return false;
            return true;
        } catch (error) {
            console.error("Can show ad check error:", error);
            return false;
        }
    }
}

export { CacheManager, RateLimiter, NotificationManager, SecurityManager, AdManager };
