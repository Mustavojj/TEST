import { CORE_CONFIG, APP_CONFIG } from '../data.js';

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
                    background: var(--card-bg-solid);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 14px 16px;
                    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
                    z-index: 10000;
                    animation: notifSlideIn 0.32s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;
                    border: 1px solid rgba(255, 217, 102, 0.25);
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                }
                .notification.info { border-left: 4px solid #0ea5e9; }
                .notification.success { border-left: 4px solid #22c55e; }
                .notification.error { border-left: 4px solid #ef4444; }
                .notification.warning { border-left: 4px solid #f59e0b; }
                .notification-icon {
                    width: 42px;
                    height: 42px;
                    border-radius: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.25rem;
                    flex-shrink: 0;
                    background: rgba(0, 0, 0, 0.4);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .notification.info .notification-icon { color: #0ea5e9; }
                .notification.success .notification-icon { color: #22c55e; }
                .notification.error .notification-icon { color: #ef4444; }
                .notification.warning .notification-icon { color: #f59e0b; }
                .notification-content {
                    flex: 1;
                    min-width: 0;
                }
                .notification-title {
                    font-weight: 700;
                    color: var(--text-primary);
                    font-size: 0.95rem;
                    margin-bottom: 3px;
                    line-height: 1.3;
                }
                .notification-body {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    line-height: 1.35;
                }
                .notification-progress {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    width: 100%;
                    height: 3px;
                    background: rgba(255, 255, 255, 0.08);
                }
                .notification-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, var(--secondary-color), var(--accent-color));
                    animation: notifProgress 4s linear forwards;
                }
                .notification-close {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    width: 26px;
                    height: 26px;
                    background: rgba(0, 0, 0, 0.4);
                    border: none;
                    border-radius: 30px;
                    color: var(--text-light);
                    font-size: 0.7rem;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.6;
                    transition: all 0.2s;
                }
                .notification-close:hover {
                    opacity: 1;
                    background: rgba(255, 255, 255, 0.12);
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
            setTimeout(() => this.processQueue(), 300);
        }
    }
    
    closeNotification(notificationId) {
        const notification = document.getElementById(notificationId);
        if (!notification) return;
        
        notification.style.animation = 'notifSlideOut 0.25s ease forwards';
        
        setTimeout(() => {
            if (notification.parentNode) notification.parentNode.removeChild(notification);
        }, 280);
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
