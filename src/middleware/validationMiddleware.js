// middleware/validationMiddleware.js - Fixed to handle missing params

/**
 * Validate email format
 */
const validateEmail = (email) => {
    if (!email) return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

/**
 * Validate password strength
 */
const validatePassword = (password) => {
    if (!password || password.length < 6) {
        return { isValid: false, message: 'Password must be at least 6 characters long' };
    }
    return { isValid: true };
};

/**
 * Validate enrollment number format
 */
const validateEnrollmentNumber = (enrollment) => {
    if (!enrollment || enrollment.trim().length < 3) {
        return { isValid: false, message: 'Enrollment number must be at least 3 characters long' };
    }
    return { isValid: true };
};

/**
 * Validate quiz parameters
 */
const validateQuizParams = (durationMinutes, questionCount, isExamMode, examDurationMinutes) => {
    const errors = [];

    // Validate duration
    const duration = parseInt(durationMinutes);
    if (isNaN(duration) || duration < 2 || duration > 60) {
        errors.push('Quiz duration must be between 2 and 60 minutes');
    }

    // Validate question count
    const questions = parseInt(questionCount);
    if (isNaN(questions) || questions < 5 || questions > 30) {
        errors.push('Question count must be between 5 and 30');
    }

    // Validate exam mode parameters
    if (isExamMode === true || isExamMode === 'true') {
        const examDuration = parseInt(examDurationMinutes);
        if (isNaN(examDuration) || examDuration < 30 || examDuration > 480) {
            errors.push('Exam duration must be between 30 and 480 minutes');
        }
    }

    return {
        isValid: errors.length === 0,
        errors: errors,
        sanitized: {
            durationMinutes: Math.max(2, Math.min(60, duration || 15)),
            questionCount: Math.max(5, Math.min(30, questions || 10)),
            isExamMode: isExamMode === true || isExamMode === 'true',
            examDurationMinutes: isExamMode ? Math.max(30, Math.min(480, parseInt(examDurationMinutes) || 60)) : null
        }
    };
};

/**
 * Middleware to validate user registration data
 */
const validateRegistration = (req, res, next) => {
    const { userType, name, email, enrollment, password } = req.body;
    const errors = {};

    // Validate user type
    if (!userType || !['student', 'teacher'].includes(userType)) {
        errors.userType = 'Invalid user type';
    }

    // Validate name
    if (!name || name.trim().length < 2) {
        errors.name = 'Name must be at least 2 characters long';
    }

    // Validate email for teachers
    if (userType === 'teacher') {
        if (!email || !validateEmail(email)) {
            errors.email = 'Please enter a valid email address';
        }
    }

    // Validate enrollment for students
    if (userType === 'student') {
        const enrollmentValidation = validateEnrollmentNumber(enrollment);
        if (!enrollmentValidation.isValid) {
            errors.enrollment = enrollmentValidation.message;
        }
    }

    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
        errors.password = passwordValidation.message;
    }

    if (Object.keys(errors).length > 0) {
        return res.render('signup', { 
            errors: errors, 
            userType, 
            name, 
            email, 
            enrollment 
        });
    }

    // Sanitize data
    req.body.name = name.trim();
    if (email) {
        req.body.email = email.trim().toLowerCase();
    }
    if (enrollment) {
        req.body.enrollment = enrollment.trim().toUpperCase();
    }

    next();
};

/**
 * Middleware to validate login data
 */
const validateLogin = (req, res, next) => {
    const { userType, email, enrollment, password } = req.body;
    const errors = {};
    const oldInput = { userType, email, enrollment };

    // Validate user type
    if (!userType || !['student', 'teacher'].includes(userType)) {
        errors.userType = 'Invalid user type';
    }

    // Validate email for teachers
    if (userType === 'teacher' && (!email || !validateEmail(email))) {
        errors.email = 'Please enter a valid email address';
    }

    // Validate enrollment for students
    if (userType === 'student' && (!enrollment || enrollment.trim().length < 3)) {
        errors.enrollment = 'Please enter a valid enrollment number';
    }

    // Validate password
    if (!password || password.length < 1) {
        errors.password = 'Password is required';
    }

    if (Object.keys(errors).length > 0) {
        return res.render('login', { 
            errors: errors, 
            oldInput: oldInput 
        });
    }

    // Sanitize data
    if (email) {
        req.body.email = email.trim().toLowerCase();
    }
    if (enrollment) {
        req.body.enrollment = enrollment.trim().toUpperCase();
    }

    next();
};

/**
 * Middleware to validate class creation data
 */
const validateClass = (req, res, next) => {
    const { name, subject, description } = req.body;
    const errors = {};

    if (!name || name.trim().length < 2) {
        errors.name = 'Class name must be at least 2 characters long';
    }

    if (!subject || subject.trim().length < 2) {
        errors.subject = 'Subject must be at least 2 characters long';
    }

    if (Object.keys(errors).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }

    // Sanitize data
    req.body.name = name.trim();
    req.body.subject = subject.trim();
    req.body.description = description ? description.trim() : '';

    next();
};

/**
 * Middleware to validate quiz generation parameters
 */
const validateQuizGeneration = (req, res, next) => {
    const { durationMinutes, questionCount, isExamMode, examDurationMinutes } = req.body;
    
    const validation = validateQuizParams(durationMinutes, questionCount, isExamMode, examDurationMinutes);
    
    if (!validation.isValid) {
        return res.status(400).json({
            success: false,
            message: 'Invalid quiz parameters',
            errors: validation.errors
        });
    }

    // Replace request body with sanitized values
    Object.assign(req.body, validation.sanitized);
    
    next();
};

/**
 * Middleware to validate API input for common fields
 */
const validateCommonFields = (req, res, next) => {
    // Sanitize common string fields
    ['title', 'name', 'subject', 'description'].forEach(field => {
        if (req.body[field] && typeof req.body[field] === 'string') {
            req.body[field] = req.body[field].trim();
        }
    });

    // Sanitize numeric fields
    ['durationMinutes', 'questionCount', 'examDurationMinutes'].forEach(field => {
        if (req.body[field]) {
            const num = parseInt(req.body[field]);
            if (!isNaN(num)) {
                req.body[field] = num;
            }
        }
    });

    next();
};

/**
 * Sanitize input to prevent XSS
 */
const sanitizeInput = (req, res, next) => {
    const sanitizeString = (str) => {
        if (typeof str !== 'string') return str;
        return str
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    };

    // Recursively sanitize object
    const sanitizeObject = (obj) => {
        if (typeof obj === 'string') {
            return sanitizeString(obj);
        }
        if (Array.isArray(obj)) {
            return obj.map(sanitizeObject);
        }
        if (obj && typeof obj === 'object') {
            const sanitized = {};
            for (const key in obj) {
                sanitized[key] = sanitizeObject(obj[key]);
            }
            return sanitized;
        }
        return obj;
    };

    if (req.body) {
        req.body = sanitizeObject(req.body);
    }
    next();
};

module.exports = {
    validateEmail,
    validatePassword,
    validateEnrollmentNumber,
    validateQuizParams,
    validateRegistration,
    validateLogin,
    validateClass,
    validateQuizGeneration,
    validateCommonFields,
    sanitizeInput
};