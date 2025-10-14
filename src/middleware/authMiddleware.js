// middleware/authMiddleware.js

/**
 * Middleware to check if user is authenticated (for page routes)
 * Redirects to login page if not authenticated
 */
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login?message=Please login to access this page.');
    }
};

/**
 * Middleware to check authentication for API routes
 * Returns JSON error if not authenticated
 */
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ 
            success: false, 
            message: 'Authentication required' 
        });
    }
};

/**
 * Middleware to check if user has specific role
 * @param {string|string[]} roles - Required role(s)
 */
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.session.userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication required' 
            });
        }

        const userRole = req.session.userType;
        const allowedRoles = Array.isArray(roles) ? roles : [roles];

        if (allowedRoles.includes(userRole)) {
            return next();
        } else {
            return res.status(403).json({ 
                success: false, 
                message: `Access denied. Required role: ${allowedRoles.join(' or ')}` 
            });
        }
    };
};

/**
 * Middleware to check if user is a teacher (for page routes)
 */
const requireTeacher = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login?message=Please login to access this page.');
    }

    if (req.session.userType !== 'teacher') {
        return res.status(403).redirect('/login?message=Access denied. Teachers only.');
    }

    next();
};

/**
 * Middleware to check if user is a student (for page routes)
 */
const requireStudent = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login?message=Please login to access this page.');
    }

    if (req.session.userType !== 'student') {
        return res.status(403).redirect('/login?message=Access denied. Students only.');
    }

    next();
};

/**
 * Middleware to add user context to request
 */
const addUserContext = (req, res, next) => {
    if (req.session.userId) {
        req.user = {
            id: req.session.userId,
            name: req.session.userName,
            type: req.session.userType
        };
    }
    next();
};

module.exports = {
    isAuthenticated,
    requireAuth,
    requireRole,
    requireTeacher,
    requireStudent,
    addUserContext
};