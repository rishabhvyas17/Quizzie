// routes/api/authApi.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/authMiddleware');

// Import database collections
const {
    studentCollection,
    teacherCollection
} = require('../../mongodb');

// Get user profile data (for current logged-in user)
router.get('/profile', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const userType = req.session.userType;

        let user;
        if (userType === 'student') {
            user = await studentCollection.findById(userId)
                .select('name email isVerified firstName lastName enrollment')
                .lean();
        } else if (userType === 'teacher') {
            user = await teacherCollection.findById(userId)
                .select('name email isVerified firstName lastName')
                .lean();
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Determine display name
        const displayName = user.firstName ? 
            `${user.firstName} ${user.lastName || ''}`.trim() : 
            user.name;

        res.json({
            success: true,
            user: {
                id: userId,
                name: displayName,
                email: user.email,
                userType: userType,
                isVerified: user.isVerified,
                firstName: user.firstName,
                lastName: user.lastName,
                enrollment: user.enrollment // Only for students
            }
        });

    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch profile: ' + error.message
        });
    }
});

// Check authentication status
router.get('/status', (req, res) => {
    if (req.session.userId) {
        res.json({
            success: true,
            authenticated: true,
            user: {
                id: req.session.userId,
                name: req.session.userName,
                type: req.session.userType
            }
        });
    } else {
        res.json({
            success: true,
            authenticated: false,
            user: null
        });
    }
});

// Validate session
router.post('/validate-session', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({
            success: true,
            valid: true,
            userType: req.session.userType,
            userName: req.session.userName
        });
    } else {
        res.status(401).json({
            success: false,
            valid: false,
            message: 'Session invalid or expired'
        });
    }
});

// Check if email exists (for registration validation)
router.post('/check-email', async (req, res) => {
    try {
        const { email, userType } = req.body;

        if (!email || !userType) {
            return res.status(400).json({
                success: false,
                message: 'Email and user type are required'
            });
        }

        let existingUser = null;

        if (userType === 'teacher') {
            existingUser = await teacherCollection.findOne({ 
                email: email.toLowerCase().trim() 
            });
        } else if (userType === 'student') {
            // Check both student and teacher collections for email conflicts
            existingUser = await studentCollection.findOne({ 
                email: email.toLowerCase().trim() 
            });
            
            if (!existingUser) {
                existingUser = await teacherCollection.findOne({ 
                    email: email.toLowerCase().trim() 
                });
            }
        }

        res.json({
            success: true,
            exists: !!existingUser,
            message: existingUser ? 'Email already registered' : 'Email available'
        });

    } catch (error) {
        console.error('Error checking email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check email availability'
        });
    }
});

// Check if enrollment number exists (for student registration)
router.post('/check-enrollment', async (req, res) => {
    try {
        const { enrollment } = req.body;

        if (!enrollment) {
            return res.status(400).json({
                success: false,
                message: 'Enrollment number is required'
            });
        }

        const upperCaseEnrollment = enrollment.toUpperCase().trim();
        const existingStudent = await studentCollection.findOne({ 
            enrollment: upperCaseEnrollment 
        });

        res.json({
            success: true,
            exists: !!existingStudent,
            message: existingStudent ? 'Enrollment number already registered' : 'Enrollment number available'
        });

    } catch (error) {
        console.error('Error checking enrollment:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check enrollment availability'
        });
    }
});

// Refresh session data
router.post('/refresh-session', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const userType = req.session.userType;

        let user;
        if (userType === 'student') {
            user = await studentCollection.findById(userId)
                .select('name firstName lastName')
                .lean();
        } else if (userType === 'teacher') {
            user = await teacherCollection.findById(userId)
                .select('name firstName lastName')
                .lean();
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Update session with latest user data
        const displayName = user.firstName ? 
            `${user.firstName} ${user.lastName || ''}`.trim() : 
            user.name;
            
        req.session.userName = displayName;

        res.json({
            success: true,
            message: 'Session refreshed successfully',
            user: {
                id: userId,
                name: displayName,
                type: userType
            }
        });

    } catch (error) {
        console.error('Error refreshing session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to refresh session'
        });
    }
});

// Get user navigation context
router.get('/navigation-context', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const userType = req.session.userType;

        const context = {
            userId: userId,
            userName: req.session.userName,
            userType: userType,
            dashboardUrl: userType === 'teacher' ? '/homeTeacher' : '/homeStudent',
            profileUrl: userType === 'teacher' ? '/profileTeacher' : '/profileStudent'
        };

        res.json({
            success: true,
            context: context
        });

    } catch (error) {
        console.error('Error getting navigation context:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get navigation context'
        });
    }
});

// Logout API endpoint
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({
                success: false,
                message: 'Could not log out'
            });
        }
        
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    });
});

module.exports = router;