// utils/constants.js

// File upload constants
const FILE_UPLOAD = {
    MAX_SIZE: 100 * 1024 * 1024, // 100MB
    TEMP_DIR: './temp_uploads',
    ALLOWED_TYPES: [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ],
    TYPE_MAP: {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
};

// Quiz constants
const QUIZ = {
    MIN_DURATION: 2, // minutes
    MAX_DURATION: 60, // minutes
    DEFAULT_DURATION: 15, // minutes
    MIN_QUESTIONS: 5,
    MAX_QUESTIONS: 30,
    DEFAULT_QUESTIONS: 10,
    MIN_EXAM_DURATION: 30, // minutes
    MAX_EXAM_DURATION: 480, // minutes (8 hours)
    DEFAULT_EXAM_DURATION: 60 // minutes
};

// Time constants
const TIME = {
    MINUTE: 60, // seconds
    HOUR: 3600, // seconds
    DAY: 86400, // seconds
    WEEK: 604800, // seconds
    VERIFICATION_TOKEN_EXPIRY: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    PASSWORD_RESET_TOKEN_EXPIRY: 60 * 60 * 1000, // 1 hour in milliseconds
    SESSION_EXPIRY: 14 * 24 * 60 * 60 * 1000, // 14 days in milliseconds
    JOIN_CODE_EXPIRY: 10 * 60 * 1000 // 10 minutes in milliseconds
};

// User role constants
const USER_ROLES = {
    STUDENT: 'student',
    TEACHER: 'teacher',
    ADMIN: 'admin',
    SUPER_ADMIN: 'super_admin',
    INSTITUTE_ADMIN: 'institute_admin'
};

// Class constants
const CLASS = {
    MAX_JOIN_CODE_USAGE: 50,
    JOIN_CODE_LENGTH: 6,
    JOIN_CODE_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    MAX_STUDENTS_PER_CLASS: 100
};

// Security constants
const SECURITY = {
    MIN_PASSWORD_LENGTH: 6,
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION: 15 * 60 * 1000, // 15 minutes
    ANTI_CHEAT: {
        MAX_VIOLATIONS: 3,
        GRACE_PERIODS: 2,
        VIOLATION_TYPES: ['tab_switch', 'window_blur', 'focus_loss']
    }
};

// Exam session constants
const EXAM_SESSION = {
    MIN_DURATION: 5, // minutes
    MAX_DURATION: 180, // minutes (3 hours)
    DEFAULT_DURATION: 60, // minutes
    MAX_PARTICIPANTS: 200,
    GRACE_TIME: 5000 // 5 seconds grace period for submission
};

// Performance constants
const PERFORMANCE = {
    SCORE_RANGES: {
        EXCELLENT: 90,
        GOOD: 70,
        AVERAGE: 50,
        POOR: 0
    },
    RANKING: {
        SCORE_WEIGHT: 0.7,
        TIME_EFFICIENCY_WEIGHT: 0.3,
        PARTICIPATION_BASE: 0.3,
        PARTICIPATION_MULTIPLIER: 0.7
    }
};

// AI/Gemini constants
const AI = {
    MODEL: 'gemini-1.5-flash',
    MAX_TOKENS: 8192,
    TEMPERATURE: 0.3,
    TOP_P: 0.8,
    TOP_K: 40,
    SAFETY_SETTINGS: {
        HARASSMENT: 'BLOCK_MEDIUM_AND_ABOVE',
        HATE_SPEECH: 'BLOCK_MEDIUM_AND_ABOVE',
        SEXUALLY_EXPLICIT: 'BLOCK_MEDIUM_AND_ABOVE',
        DANGEROUS_CONTENT: 'BLOCK_MEDIUM_AND_ABOVE'
    }
};

// Database constants
const DATABASE = {
    CLEANUP_INTERVALS: {
        OLD_QUIZ_RESULTS: 24 * 60 * 60 * 1000, // 24 hours
        OLD_EXPLANATIONS: 16 * 24 * 60 * 60 * 1000, // 16 days
        TEMP_FILES: 60 * 60 * 1000, // 1 hour
        EXPIRED_SESSIONS: 30 * 1000 // 30 seconds
    },
    RETENTION_PERIODS: {
        QUIZ_RESULTS: 15 * 24 * 60 * 60 * 1000, // 15 days
        EXPLANATIONS: 30 * 24 * 60 * 60 * 1000, // 30 days
        TEMP_FILES: 24 * 60 * 60 * 1000 // 24 hours
    }
};

// Status constants
const STATUS = {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    EXPIRED: 'expired'
};

// Error messages
const ERROR_MESSAGES = {
    AUTH: {
        INVALID_CREDENTIALS: 'Invalid email/enrollment or password',
        ACCESS_DENIED: 'Access denied. Insufficient permissions',
        SESSION_EXPIRED: 'Your session has expired. Please login again',
        NOT_AUTHENTICATED: 'Authentication required'
    },
    VALIDATION: {
        INVALID_EMAIL: 'Please enter a valid email address',
        INVALID_ENROLLMENT: 'Please enter a valid enrollment number',
        PASSWORD_TOO_SHORT: 'Password must be at least 6 characters long',
        REQUIRED_FIELD: 'This field is required'
    },
    FILE: {
        NO_FILE: 'No file uploaded',
        INVALID_TYPE: 'Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed',
        FILE_TOO_LARGE: 'File too large. Maximum size is 100MB',
        PROCESSING_FAILED: 'Failed to process uploaded file'
    },
    QUIZ: {
        NOT_FOUND: 'Quiz not found',
        ALREADY_TAKEN: 'You have already completed this quiz',
        GENERATION_FAILED: 'Failed to generate quiz',
        INVALID_PARAMETERS: 'Invalid quiz parameters'
    },
    CLASS: {
        NOT_FOUND: 'Class not found',
        ACCESS_DENIED: 'You are not enrolled in this class',
        ALREADY_EXISTS: 'Class with this name already exists',
        JOIN_CODE_EXPIRED: 'Join code has expired'
    }
};

// Success messages
const SUCCESS_MESSAGES = {
    AUTH: {
        LOGIN_SUCCESS: 'Login successful',
        LOGOUT_SUCCESS: 'Logged out successfully',
        REGISTRATION_SUCCESS: 'Registration successful',
        PASSWORD_RESET: 'Password reset email sent',
        EMAIL_VERIFIED: 'Email verified successfully'
    },
    QUIZ: {
        GENERATED: 'Quiz generated successfully',
        SUBMITTED: 'Quiz submitted successfully',
        SCORED: 'Quiz scored successfully'
    },
    CLASS: {
        CREATED: 'Class created successfully',
        UPDATED: 'Class updated successfully',
        STUDENT_ADDED: 'Student added to class successfully',
        JOIN_REQUEST_SENT: 'Join request sent successfully'
    },
    FILE: {
        UPLOADED: 'File uploaded successfully',
        PROCESSED: 'File processed successfully'
    }
};

// HTTP status codes
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500
};

module.exports = {
    FILE_UPLOAD,
    QUIZ,
    TIME,
    USER_ROLES,
    CLASS,
    SECURITY,
    EXAM_SESSION,
    PERFORMANCE,
    AI,
    DATABASE,
    STATUS,
    ERROR_MESSAGES,
    SUCCESS_MESSAGES,
    HTTP_STATUS
};