import { CORE_CONFIG, APP_CONFIG, REWARDS_CONFIG } from '../data.js';

class CacheManager {
    constructor() {
        this.cache = new Map();
        this.ttl = new Map();
        this.defaultTTL = CORE_CONFIG.CACHE_TTL;
    }

    set(key, value, ttl = this.defaultTTL) {
        const expiry = Date.now() + ttl;
        this.cache.set(key, value);
        this.ttl.set(key, expiry);
        this.cleanup();
        return true;
    }

    get(key) {
        const expiry = this.ttl.get(key);
        if (!expiry || Date.now() > expiry) {
            this.delete(key);
            return null;
        }
        return this.cache.get(key);
    }

    delete(key) {
        this.cache.delete(key);
        this.ttl.delete(key);
        return true;
    }

    cleanup() {
        const now = Date.now();
        for (const [key, expiry] of this.ttl.entries()) {
            if (now > expiry) this.delete(key);
        }
    }

    clear() {
        this.cache.clear();
        this.ttl.clear();
    }
}

class RateLimiter {
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
                @keyframes notifSlideIn {
                    0% { opacity: 0; transform: translateX(-50%) translateY(20px) scale(0.96); }
                    100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
                }
                @keyframes notifSlideOut {
                    0% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
                    100% { opacity: 0; transform: translateX(-50%) translateY(20px) scale(0.96); }
                }
                @keyframes notifProgress {
                    0% { width: 100%; }
                    100% { width: 0%; }
                }
                .notification {
                    position: fixed;
                    top: 70px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: calc(100% - 32px);
                    max-width: 340px;
                    background: rgba(26, 38, 58, 0.98);
                    backdrop-filter: blur(20px);
                    border-radius: 24px;
                    padding: 16px 18px;
                    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
                    z-index: 10000;
                    animation: notifSlideIn 0.28s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;
                    border: 1px solid rgba(255, 217, 102, 0.2);
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                }
                .notification.info { border-left: 3px solid #5dade2; }
                .notification.success { border-left: 3px solid #58d68d; }
                .notification.error { border-left: 3px solid #e67e7e; }
                .notification.warning { border-left: 3px solid #f7dc6f; }
                .notification-icon {
                    width: 44px;
                    height: 44px;
                    border-radius: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.25rem;
                    flex-shrink: 0;
                    background: rgba(0, 0, 0, 0.5);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                }
                .notification.info .notification-icon { color: #5dade2; }
                .notification.success .notification-icon { color: #58d68d; }
                .notification.error .notification-icon { color: #e67e7e; }
                .notification.warning .notification-icon { color: #f7dc6f; }
                .notification-content {
                    flex: 1;
                    min-width: 0;
                }
                .notification-title {
                    font-weight: 600;
                    color: var(--text-primary);
                    font-size: 0.95rem;
                    margin-bottom: 4px;
                    line-height: 1.3;
                    letter-spacing: -0.2px;
                }
                .notification-body {
                    color: rgba(224, 224, 224, 0.85);
                    font-size: 0.8rem;
                    line-height: 1.4;
                }
                .notification-progress {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    width: 100%;
                    height: 2px;
                    background: rgba(255, 255, 255, 0.1);
                }
                .notification-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, rgba(255, 217, 102, 0.7), rgba(255, 179, 71, 0.7));
                    animation: notifProgress 4s linear forwards;
                    border-radius: 2px;
                }
                .notification-close {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    width: 26px;
                    height: 26px;
                    background: rgba(0, 0, 0, 0.4);
                    border: none;
                    border-radius: 20px;
                    color: rgba(255, 255, 255, 0.5);
                    font-size: 0.7rem;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.5;
                    transition: all 0.2s;
                }
                .notification-close:hover {
                    opacity: 1;
                    background: rgba(255, 255, 255, 0.1);
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    async showNotification(title, message, type = 'info') {
        this.queue.push({ title, message, type, timestamp: Date.now() });
        if (this.queue.length > this.maxQueueSize) this.queue.shift();
        await this.processQueue();
    }
    
    async processQueue() {
        if (this.isShowing || this.queue.length === 0) return;
        
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
            <div class="notification-progress">
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
            setTimeout(() => this.processQueue(), 200);
        }
    }
    
    closeNotification(notificationId) {
        const notification = document.getElementById(notificationId);
        if (!notification) return;
        
        notification.style.animation = 'notifSlideOut 0.22s ease forwards';
        
        setTimeout(() => {
            if (notification.parentNode) notification.parentNode.removeChild(notification);
        }, 240);
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

class SecurityManager {
    constructor() {
        this.bannedCountries = [];
    }

    async initializeSecurity(tgId) {
        return true;
    }
}

export { CacheManager, RateLimiter, NotificationManager, SecurityManager };
