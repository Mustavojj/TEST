export const APP_CONFIG = {
    APP_NAME: "RAMADAN BUX",
    BOT_USERNAME: "checatcbot",
    BOT_WALLET: "UQDgM0u7lPZ6HNmK5L9VHJdNxCyh3LDWq4b85PbJZzyaFLmO",
    MINIMUM_WITHDRAW: 0.20,
    REFERRAL_BONUS_TON: 0.01,
    REFERRAL_BONUS_XP: 10,
    REFERRAL_PERCENTAGE: 0,
    MAX_DAILY_ADS: 20,
    AD_COOLDOWN: 180000,
    WATCH_AD_REWARD: 0.001,
    REQUIRED_TASKS_FOR_WITHDRAWAL: 10,
    REQUIRED_REFERRALS_FOR_WITHDRAWAL: 1,
    REQUIRED_XP_FOR_WITHDRAWAL: 100,
    DEFAULT_USER_AVATAR: "https://i.ibb.co/gM8hnfwm/TORNADO-PIC.png",
    BOT_AVATAR: "https://i.ibb.co/gM8hnfwm/TORNADO-PIC.png",
    DEPOSIT_WALLET: "UQDgM0u7lPZ6HNmK5L9VHJdNxCyh3LDWq4b85PbJZzyaFLmO",
    ADMIN_ID: "1891231976",
    XP_PER_TON: 1000,
    MIN_EXCHANGE_TON: 0.01,
    TASK_PRICE_PER_100_COMPLETIONS: 100,
    IN_APP_AD_INTERVAL: 60000,
    INITIAL_AD_DELAY: 30000,
    WITHDRAWAL_LIMIT_PER_DAY: 1,
    NEWS_CHANNEL_LINK: "https://t.me/checatcbot",
    NEWS_TASK_REWARD: 0.001
};

export const CORE_CONFIG = {
    CACHE_TTL: 300000,
    RATE_LIMITS: {
        'task_start': { limit: 1, window: 3000 },
        'withdrawal': { limit: 1, window: 86400000 },
        'promo_code': { limit: 5, window: 300000 },
        'exchange': { limit: 3, window: 3600000 },
        'daily_checkin': { limit: 1, window: 86400000 },
        'news_task': { limit: 1, window: 86400000 }
    },
    NOTIFICATION_COOLDOWN: 2000,
    MAX_NOTIFICATION_QUEUE: 3,
    AD_COOLDOWN: 180000,
    INITIAL_AD_DELAY: 30000,
    INTERVAL_AD_DELAY: 60000
};

export const FEATURES_CONFIG = {
    TASK_VERIFICATION_DELAY: 10,
    REFERRAL_BONUS_TON: 0.01,
    REFERRAL_BONUS_XP: 10,
    REFERRAL_PERCENTAGE: 0,
    REFERRALS_PER_PAGE: 5,
    DAILY_CHECKIN_REWARD: 0.002,
    NEWS_TASK_REWARD: 0.001
};

export const THEME_CONFIG = {
    GOLDEN_THEME: {
        background: "#0a0a0a",
        cardBg: "rgba(26, 26, 26, 0.95)",
        cardBgSolid: "#1a1a1a",
        textPrimary: "#ffffff",
        textSecondary: "#e0e0e0",
        textLight: "#b0b0b0",
        primaryColor: "#FFD700",
        secondaryColor: "#FFC800",
        accentColor: "#FFB800",
        tonColor: "#FFD700",
        xpColor: "#FFA500"
    }
};
