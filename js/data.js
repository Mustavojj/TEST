export const APP_CONFIG = {
    APP_NAME: "RAMADAN BUX",
    BOT_USERNAME: "Tornado_Rbot",
    MINIMUM_WITHDRAW: 0.20,
    REFERRAL_BONUS_TON: 0.01,
    REFERRAL_PERCENTAGE: 0,
    REFERRAL_BONUS_TASKS: 0,
    TASK_REWARD_BONUS: 0,
    MAX_DAILY_ADS: 20,
    AD_COOLDOWN: 180000,
    WATCH_AD_REWARD: 0.001,
    REQUIRED_ADS_FOR_WITHDRAWAL: 5,
    REQUIRED_TASKS_FOR_WITHDRAWAL: 10,
    REQUIRED_REFERRALS_FOR_WITHDRAWAL: 1,
    DEFAULT_USER_AVATAR: "https://i.ibb.co/gM8hnfwm/TORNADO-PIC.png",
    BOT_AVATAR: "https://i.ibb.co/gM8hnfwm/TORNADO-PIC.png",
    WELCOME_TASKS: [
        {
            name: "Join Official Channel",
            url: "https://t.me/TORNADO_CHNL",
            channel: "@TORNADO_CHNL"
        },
        {
            name: "Join Money Hub",
            url: "https://t.me/MONEYHUB9_69",
            channel: "@MONEYHUB9_69"
        },
        {
            name: "Join Crypto Al",
            url: "https://t.me/Crypto_al2",
            channel: "@Crypto_al2"
        }
    ],
    DEPOSIT_WALLET: "UQDgM0u7lPZ6HNmK5L9VHJdNxCyh3LDWq4b85PbJZzyaFLmO",
    ADMIN_ID: "1891231976",
    XP_PER_TON: 1000,
    MIN_EXCHANGE_TON: 0.10,
    TASK_PRICE_PER_100_COMPLETIONS: 100,
    TASK_XP_REWARD: 1
};

export const CORE_CONFIG = {
    CACHE_TTL: 300000,
    RATE_LIMITS: {
        'task_start': { limit: 1, window: 3000 },
        'withdrawal': { limit: 1, window: 1000 },
        'ad_reward': { limit: 10, window: 300000 },
        'promo_code': { limit: 5, window: 300000 },
        'exchange': { limit: 3, window: 3600000 },
        'daily_checkin': { limit: 1, window: 86400000 }
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
    REFERRAL_PERCENTAGE: 0,
    REFERRALS_PER_PAGE: 10,
    PARTNER_TASK_REWARD: 0.001,
    SOCIAL_TASK_REWARD: 0.001,
    DAILY_CHECKIN_REWARD: 0.002
};

export const THEME_CONFIG = {
    LIGHT_MODE: {
        background: "#f8fafc",
        cardBg: "#f1f5f9",
        cardBgSolid: "#e2e8f0",
        textPrimary: "#334155",
        textSecondary: "#475569",
        textLight: "#64748b",
        primaryColor: "#FBBF24",
        secondaryColor: "#F59E0B",
        accentColor: "#D97706",
        tonColor: "#FBBF24",
        xpColor: "#F59E0B"
    },
    DARK_MODE: {
        background: "#2e1b3c",
        cardBg: "rgba(58, 28, 74, 0.8)",
        cardBgSolid: "#3a1e4a",
        textPrimary: "#f1f5f9",
        textSecondary: "#cbd5e1",
        textLight: "#94a3b8",
        primaryColor: "#FBBF24",
        secondaryColor: "#F59E0B",
        accentColor: "#D97706",
        tonColor: "#FBBF24",
        xpColor: "#F59E0B"
    }
};
