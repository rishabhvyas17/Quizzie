// utils/helpers.js

/**
 * Format time in seconds to readable format
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
const formatTime = (seconds) => {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return '0:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else {
        return `${minutes}m ${secs}s`;
    }
};

/**
 * Format exam time with hours, minutes, seconds
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted exam time
 */
const formatExamTime = (seconds) => {
    if (seconds <= 0) return '00:00:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
};

/**
 * Format percentage with specified decimal places
 * @param {number} value - Percentage value
 * @param {number} decimals - Number of decimal places (default: 1)
 * @returns {number} Formatted percentage
 */
const formatPercentage = (value, decimals = 1) => {
    const num = parseFloat(value) || 0;
    return parseFloat(num.toFixed(decimals));
};

/**
 * Safe number conversion with default value
 * @param {any} value - Value to convert
 * @param {number} defaultValue - Default value if conversion fails
 * @returns {number} Safe number
 */
const safeNumber = (value, defaultValue = 0) => {
    const num = Number(value);
    return isNaN(num) || !isFinite(num) ? defaultValue : num;
};

/**
 * Calculate time efficiency based on time taken vs allocated time
 * @param {number} timeTakenSeconds - Actual time taken
 * @param {number} quizDurationSeconds - Allocated quiz duration
 * @returns {number} Efficiency percentage (0-100)
 */
const calculateTimeEfficiency = (timeTakenSeconds, quizDurationSeconds) => {
    if (!timeTakenSeconds || !quizDurationSeconds || quizDurationSeconds <= 0) return 0;

    const timeRatio = timeTakenSeconds / quizDurationSeconds;

    if (timeRatio <= 0.5) {
        return 100; // Very fast completion
    } else if (timeRatio <= 1.0) {
        return Math.round(100 - (timeRatio - 0.5) * 80); // Scale from 100% to 60%
    } else {
        return Math.max(10, Math.round(60 - (timeRatio - 1.0) * 50)); // Overtime penalty
    }
};

/**
 * Calculate ranking points using weighted formula
 * @param {number} averageScore - Average quiz score percentage
 * @param {number} timeEfficiency - Time efficiency percentage
 * @returns {number} Calculated ranking points
 */
const calculateRankingPoints = (averageScore, timeEfficiency) => {
    const score = parseFloat(averageScore) || 0;
    const efficiency = parseFloat(timeEfficiency) || 0;
    return parseFloat((score * 0.7 + efficiency * 0.3).toFixed(1));
};

/**
 * Calculate participation-weighted ranking points
 * @param {number} averageScore - Average quiz score
 * @param {number} timeEfficiency - Time efficiency
 * @param {number} participationRate - Participation rate percentage
 * @returns {number} Final weighted points
 */
const calculateParticipationWeightedPoints = (averageScore, timeEfficiency, participationRate) => {
    const basePoints = calculateRankingPoints(averageScore, timeEfficiency);
    const participationMultiplier = 0.3 + (0.7 * (participationRate / 100));
    const finalPoints = basePoints * participationMultiplier;
    return parseFloat(finalPoints.toFixed(1));
};

/**
 * Get time ago string from date
 * @param {Date} date - Date to compare
 * @returns {string} Human readable time ago
 */
const getTimeAgo = (date) => {
    const now = new Date();
    const diffInMs = now - new Date(date);
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));

    if (diffInDays > 7) {
        return new Date(date).toLocaleDateString();
    } else if (diffInDays > 0) {
        return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
    } else if (diffInHours > 0) {
        return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
    } else if (diffInMinutes > 0) {
        return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
    } else {
        return 'Just now';
    }
};

/**
 * Create duration badge text based on quiz duration
 * @param {number} durationMinutes - Quiz duration in minutes
 * @returns {string} Badge text
 */
const createDurationBadge = (durationMinutes) => {
    if (durationMinutes <= 10) {
        return `⚡ ${durationMinutes}min Quick Quiz`;
    } else if (durationMinutes <= 30) {
        return `⏱️ ${durationMinutes}min Standard Quiz`;
    } else {
        return `🕐 ${durationMinutes}min Extended Quiz`;
    }
};

/**
 * Validate and clamp quiz duration
 * @param {any} durationMinutes - Duration to validate
 * @returns {number} Valid duration between 2-60 minutes
 */
const validateQuizDuration = (durationMinutes) => {
    const duration = parseInt(durationMinutes);
    if (isNaN(duration)) return 15; // Default fallback
    return Math.max(2, Math.min(60, duration)); // Clamp between 2-60 minutes
};

/**
 * Validate and clamp question count
 * @param {any} questionCount - Question count to validate
 * @returns {number} Valid question count between 5-30
 */
const validateQuestionCount = (questionCount) => {
    const count = parseInt(questionCount);
    if (isNaN(count)) return 10; // Default fallback
    return Math.max(5, Math.min(30, count)); // Clamp between 5-30 questions
};

/**
 * Calculate quiz statistics with duration context
 * @param {Array} results - Array of quiz results
 * @param {number} quizDurationMinutes - Quiz duration in minutes
 * @returns {Object} Calculated statistics
 */
const calculateQuizStats = (results, quizDurationMinutes = 15) => {
    if (!results || results.length === 0) {
        return {
            totalAttempts: 0,
            averageScore: 0,
            averageTime: 0,
            averageEfficiency: 0,
            fastestCompletion: 0,
            slowestCompletion: 0
        };
    }

    const quizDurationSeconds = quizDurationMinutes * 60;

    const stats = {
        totalAttempts: results.length,
        averageScore: formatPercentage(results.reduce((sum, r) => sum + r.percentage, 0) / results.length),
        averageTime: Math.round(results.reduce((sum, r) => sum + r.timeTakenSeconds, 0) / results.length),
        fastestCompletion: Math.min(...results.map(r => r.timeTakenSeconds)),
        slowestCompletion: Math.max(...results.map(r => r.timeTakenSeconds))
    };

    // Calculate average efficiency
    const efficiencies = results.map(r =>
        calculateTimeEfficiency(r.timeTakenSeconds, quizDurationSeconds)
    );
    stats.averageEfficiency = formatPercentage(efficiencies.reduce((sum, eff) => sum + eff, 0) / efficiencies.length);

    return stats;
};

/**
 * Generate unique identifier
 * @param {number} length - Length of identifier
 * @returns {string} Unique identifier
 */
const generateUniqueId = (length = 8) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

/**
 * Deep clone object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
const deepClone = (obj) => {
    if (obj === null || typeof obj !== "object") return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => deepClone(item));
    if (typeof obj === "object") {
        const clonedObj = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                clonedObj[key] = deepClone(obj[key]);
            }
        }
        return clonedObj;
    }
};

/**
 * Sanitize string for safe display
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
const sanitizeString = (str) => {
    if (typeof str !== 'string') return str;
    return str
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
};

module.exports = {
    formatTime,
    formatExamTime,
    formatPercentage,
    safeNumber,
    calculateTimeEfficiency,
    calculateRankingPoints,
    calculateParticipationWeightedPoints,
    getTimeAgo,
    createDurationBadge,
    validateQuizDuration,
    validateQuestionCount,
    calculateQuizStats,
    generateUniqueId,
    deepClone,
    sanitizeString
};