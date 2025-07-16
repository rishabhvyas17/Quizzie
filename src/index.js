// QuizAI Server - Express.js Application
// Dependencies to install:
// npm i express hbs mongoose multer pdf-parse mammoth node-pptx-parser @google/generative-ai dotenv nodemon express-session connect-mongo
// Run with: nodemon src/index.js

/* 
    Deployment Essentials :- 

    gcloud run deploy quizai-service \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
--set-env-vars 'GEMINI_API_KEY=AIzaSyDaD6ki59Xh7dX8f4CpRGzcucgdVpLd9Q8,MONGODB_URI=mongodb+srv://rishabhvyas:faCWMxbu0XPPVwSe@quizziedb.jdvsntc.mongodb.net/?retryWrites=true&w=majority&appName=QuizzieDB,SESSION_SECRET=xKj8mP9$vL2@nQ5!rT7&wE3*uI6%oA1^sD4+fG8-hB0~xC99'

*/

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
const session = require('express-session');
const MongoStore = require('connect-mongo'); // ADD THIS LINE for persistent sessions
// Load environment variables from .env file
require('dotenv').config()
const crypto = require('crypto'); // NEW: For generating tokens
// --- NEW: Import your email service and template renderer ---
const { sendEmail } = require('./services/emailService');
const { renderEmailTemplate } = require('./utils/templateRenderer');



// Add the new import for node-pptx-parser
const PptxParser = require("node-pptx-parser").default; // Note the .default for CommonJS


// Import database collections
const {
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection,
    classCollection,           // 🆕 NEW
    classStudentCollection,     // 🆕 NEW
    classJoinCodeCollection,
    classJoinRequestCollection
} = require("./mongodb")

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai')
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

// Configuration
const PORT = process.env.PORT || 8080
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const templatePath = path.join(__dirname, '../tempelates')
const VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour // 🆕 NEW CONSTANT

// Express configuration
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(path.join(__dirname, '../public')))
app.set("view engine", "hbs")
app.set("views", templatePath)

// Configure and use express-session middleware with MongoStore
app.use(session({
    secret: process.env.SESSION_SECRET, // IMPORTANT: Ensure this env var is set in Render/GCP
    resave: false, // Prevents session from being saved back to the session store on every request
    saveUninitialized: false, // Prevents uninitialized sessions from being saved to the store
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI, // CRITICAL: Use your Atlas URI for session storage
        ttl: 14 * 24 * 60 * 60, // Session will expire after 14 days (in seconds)
        autoRemove: 'interval', // Auto-remove expired sessions
        autoRemoveInterval: 10 // In minutes. MongoStore will clean up expired sessions every 10 minutes.
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days in milliseconds
        secure: false, // IMPORTANT: Set to true in production (requires HTTPS, which Render/GCP provide)
        httpOnly: true, // Prevents client-side JavaScript from accessing the cookie
        sameSite: 'lax' // Recommended for security: 'strict', 'lax', or 'none'. 'lax' is often a good balance.
    },
    proxy: true // IMPORTANT: Trust the reverse proxy (Cloud Run)
}));

// ==================== HANDLEBARS HELPERS REGISTRATION ====================
// Register Handlebars helpers
hbs.registerHelper('eq', function (a, b) {
    return a === b;
});

hbs.registerHelper('add', function (a, b) {
    return a + b;
});

hbs.registerHelper('getScoreClass', function (percentage) {
    if (percentage >= 90) return 'excellent';
    if (percentage >= 70) return 'good';
    if (percentage >= 50) return 'average';
    return 'poor';
});

hbs.registerHelper('formatTime', function (seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
});

hbs.registerHelper('json', function (context) {
    return JSON.stringify(context);
});

// Enhanced ranking helper
hbs.registerHelper('getRankClass', function (index) {
    if (index === 0) return 'rank-1';
    if (index === 1) return 'rank-2';
    if (index === 2) return 'rank-3';
    return 'rank-other';
});

// Date formatting helper
hbs.registerHelper('formatDate', function (date) {
    return new Date(date).toLocaleDateString();
});

// Percentage formatting helper
hbs.registerHelper('toFixed', function (number, decimals) {
    return parseFloat(number).toFixed(decimals || 1);
});

console.log('✅ Handlebars helpers registered successfully!');

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login?message=Please login to access this page.');
    }
};

const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }
};

// ==================== FILE UPLOAD CONFIGURATION ====================

// Configure multer for temporary file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
            fs.mkdirSync(TEMP_UPLOAD_DIR)
        }
        cb(null, TEMP_UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname
        cb(null, uniqueName)
    }
})

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true)
    } else {
        req.fileError = new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed.');
        cb(null, false);
    }
}

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
})

// ==================== TEXT EXTRACTION FUNCTIONS ====================

async function extractTextFromPDF(filePath) {
    let extractedText = '';
    try {
        console.log(`🔌 Starting PDF text extraction for: ${filePath}`);
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        extractedText = data.text.trim();
        console.log('✅ PDF text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
    } catch (pdfError) {
        console.error('❌ Error extracting text from PDF:', pdfError);
        extractedText = "Error extracting text from PDF."; // Indicate extraction failure
    }
    return extractedText;
}

async function extractTextFromWord(filePath) {
    let extractedText = '';
    try {
        console.log(`🔌 Starting Word text extraction for: ${filePath}`);
        const result = await mammoth.extractRawText({ path: filePath });
        extractedText = result.value.trim(); // The raw text
        console.log('✅ Word text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
    } catch (wordError) {
        console.error('❌ Error extracting text from Word:', wordError);
        extractedText = "Error extracting text from Word."; // Indicate extraction failure
    }
    return extractedText;
}

async function extractTextFromPowerPoint(filePath) {
    let extractedText = '';
    try {
        console.log(`🔌 Initializing PptxParser for: ${filePath}`);
        const parser = new PptxParser(filePath); // Create a new parser instance

        console.log('🔄 Extracting text using node-pptx-parser...');
        // extractText() returns an array of SlideTextContent objects, each with a 'text' array
        const textContent = await parser.extractText();

        if (textContent && textContent.length > 0) {
            // Join all text from all slides and then join lines within each slide's text
            extractedText = textContent.map(slide => slide.text.join('\n')).join('\n\n').trim();
            console.log('✅ PPTX text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
        } else {
            console.warn('⚠️ node-pptx-parser extracted no text from the PPTX file.');
        }

        if (extractedText.length === 0) {
            console.warn('⚠️ PPTX extraction yielded empty content after processing.');
        }

    } catch (pptxError) {
        console.error('❌ Error extracting text from PowerPoint with node-pptx-parser:', pptxError);
        extractedText = "Error extracting text from PowerPoint."; // Indicate extraction failure
    }
    return extractedText;
}

async function extractTextFromFile(filePath, mimetype) {
    console.log(`🔄 Starting text extraction for: ${mimetype}`)

    switch (mimetype) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath)
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromWord(filePath)
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return await extractTextFromPowerPoint(filePath)
        default:
            throw new Error('Unsupported file type')
    }
}
// ==================== UTILITY FUNCTIONS ====================

function getFileType(mimetype) {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
    return typeMap[mimetype] || 'unknown'
}

function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`🗑️ Temporary file deleted: ${filePath}`)
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error)
    }
}

function cleanupTempFiles() {
    if (fs.existsSync(TEMP_UPLOAD_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOAD_DIR)
        files.forEach(file => {
            const filePath = path.join(TEMP_UPLOAD_DIR, file)
            try {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Cleaned up old temp file: ${file}`)
            } catch (error) {
                console.error(`⚠️ Could not clean up temp file ${file}:`, error)
            }
        })
    }
}

// ==================== AUTHENTICATION ROUTES ====================



app.get("/", (req, res) => {
    res.redirect("/login")
})

app.get("/login", (req, res) => {
    res.render("login", { message: req.query.message });
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

// 🔄 UPDATED: signup route to show errors on the same page
app.post("/signup", async (req, res) => {
    try {
        const { userType, name, email, enrollment, password } = req.body;
        const errors = {};

        if (userType === 'teacher') {
            // Check if teacher email already exists
            const existingTeacher = await teacherCollection.findOne({ email: email });
            if (existingTeacher) {
                errors.email = "User with this email already exists.";
            }

            if (Object.keys(errors).length > 0) {
                // If errors, re-render the signup page with errors and old input
                return res.render("signup", { errors: errors, userType, name, email, enrollment });
            }

            // If no errors, proceed with registration
            const teacherData = { name, email, password };
            await teacherCollection.insertMany([teacherData]);
            const newTeacher = await teacherCollection.findOne({ email: email });
            req.session.userId = newTeacher._id;
            req.session.userName = newTeacher.name;
            req.session.userType = userType;

            // Save the session before redirecting to avoid race conditions
            req.session.save((err) => {
                if (err) {
                    console.error("Error saving session:", err);
                    return res.render("signup", { errors: { general: "Error during registration." } });
                }
                res.redirect(`/homeTeacher?userName=${encodeURIComponent(newTeacher.name)}`);
            });

        } else { // Student
            const upperCaseEnrollment = enrollment.toUpperCase();
            // Check if student enrollment number already exists
            const existingStudent = await studentCollection.findOne({ enrollment: upperCaseEnrollment });
            if (existingStudent) {
                errors.enrollment = "User with this enrollment number already exists.";
            }

            if (Object.keys(errors).length > 0) {
                // If errors, re-render the signup page with errors and old input
                return res.render("signup", { errors: errors, userType, name, email, enrollment });
            }

            // If no errors, proceed with registration
            const studentData = { name, enrollment: upperCaseEnrollment, password };
            await studentCollection.insertMany([studentData]);
            const newStudent = await studentCollection.findOne({ enrollment: upperCaseEnrollment });
            req.session.userId = newStudent._id;
            req.session.userName = newStudent.name;
            req.session.userType = userType;

            // Save the session before redirecting to avoid race conditions
            req.session.save((err) => {
                if (err) {
                    console.error("Error saving session:", err);
                    return res.render("signup", { errors: { general: "Error during registration." } });
                }
                res.redirect(`/homeStudent?userName=${encodeURIComponent(newStudent.name)}`);
            });
        }
    } catch (error) {
        console.error('❌ Signup error:', error);
        res.render("signup", { errors: { general: "An unexpected error occurred during registration. Please try again." } });
    }
});

// 🔄 UPDATED: login route to show errors on the same page
app.post("/login", async (req, res) => {
    try {
        const { password, userType, email, enrollment } = req.body;
        let user;
        const errors = {};
        const oldInput = { userType, email, enrollment };

        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ email: email });
            if (!user) {
                errors.email = "No user found with this email.";
            }
        } else { // Student
            const upperCaseEnrollment = enrollment ? enrollment.toUpperCase() : null;
            user = await studentCollection.findOne({ enrollment: upperCaseEnrollment });
            if (!user) {
                errors.enrollment = "No user found with this enrollment number.";
            }
        }

        if (Object.keys(errors).length > 0) {
            // Re-render login page with an error message
            return res.render("login", { errors: errors, oldInput: oldInput });
        }

        // If user is found, check the password
        if (user.password === password) {
            req.session.userId = user._id;
            req.session.userName = user.name;
            req.session.userType = userType;

            // Save the session before redirecting to avoid a race condition
            req.session.save((err) => {
                if (err) {
                    console.error("Error saving session:", err);
                    return res.render("login", { errors: { general: "Login failed due to an internal error." }, oldInput: oldInput });
                }
                const redirectUrl = userType === 'teacher' ? '/homeTeacher' : '/homeStudent';
                res.redirect(`${redirectUrl}?userName=${encodeURIComponent(user.name)}`);
            });

        } else {
            // Password does not match
            errors.password = "Wrong password.";
            return res.render("login", { errors: errors, oldInput: oldInput });
        }
    } catch (error) {
        console.error('❌ Login error:', error);
        res.render("login", { errors: { general: "An unexpected error occurred during login. Please try again." } });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/login?message=You have been logged out.');
    });
})

// 🆕 NEW: GET route for Forgot Password page
app.get('/forgot-password', (req, res) => {
    res.render('forgotPassword', {
        message: req.query.message,
        error: req.query.error
    });
});

// 🆕 NEW: POST route to handle Forgot Password email submission
app.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.redirect('/forgot-password?error=' + encodeURIComponent('Please enter your email address.'));
        }

        // Find user (student or teacher) by email
        let user = await studentCollection.findOne({ email: email });
        if (!user) {
            user = await teacherCollection.findOne({ email: email });
        }

        // IMPORTANT: Always send a generic success message to prevent email enumeration
        if (!user) {
            console.log(`DEBUG: Password reset requested for non-existent email: ${email}`);
            return res.redirect('/forgot-password?message=' + encodeURIComponent('If an account with that email exists, a password reset link has been sent.'));
        }

        // Generate reset token and expiry
        user.resetPasswordToken = crypto.randomBytes(32).toString('hex');
        user.resetPasswordTokenExpires = new Date(Date.now() + PASSWORD_RESET_TOKEN_EXPIRY);
        await user.save();

        const resetLink = `${process.env.BASE_URL}/reset-password/${user.resetPasswordToken}`;

        const emailHtml = await renderEmailTemplate('resetPasswordEmail', {
            username: user.firstName || user.name, // Use firstName if available, fallback to full name
            resetLink: resetLink
        });

        const emailResult = await sendEmail({
            to: user.email,
            subject: 'Quizzie: Password Reset Request',
            html: emailHtml,
            text: `Hello ${user.firstName || user.name},\n\nYou have requested to reset your password for your Quizzie account. Please click the following link to set a new password: ${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you did not request a password reset, please ignore this email.\n\nBest regards,\nThe Quizzie Team`
        });

        if (emailResult.success) {
            return res.redirect('/forgot-password?message=' + encodeURIComponent('If an account with that email exists, a password reset link has been sent to your inbox.'));
        } else {
            console.error('❌ Error sending password reset email:', emailResult.message);
            return res.redirect('/forgot-password?error=' + encodeURIComponent('Failed to send password reset email. Please try again later.'));
        }

    } catch (error) {
        console.error('❌ Error in forgot password request:', error);
        return res.redirect('/forgot-password?error=' + encodeURIComponent('An unexpected error occurred. Please try again.'));
    }
});

// 🆕 NEW: GET route to render Reset Password page
app.get('/reset-password/:token', async (req, res) => {
    try {
        const { token } = req.params;

        // Find user (student or teacher) by token and check expiry
        let user = await studentCollection.findOne({
            resetPasswordToken: token,
            resetPasswordTokenExpires: { $gt: Date.now() }
        });
        if (!user) {
            user = await teacherCollection.findOne({
                resetPasswordToken: token,
                resetPasswordTokenExpires: { $gt: Date.now() }
            });
        }

        if (!user) {
            console.log('DEBUG: Invalid or expired password reset token provided.');
            return res.render('resetPassword', {
                error: 'The password reset link is invalid or has expired. Please request a new one.',
                token: '' // Don't pass the invalid token back
            });
        }

        res.render('resetPassword', {
            token: token, // Pass the valid token to the hidden field in the form
            message: req.query.message,
            error: req.query.error
        });

    } catch (error) {
        console.error('❌ Error rendering reset password page:', error);
        return res.render('resetPassword', {
            error: 'An unexpected error occurred. Please try again.',
            token: ''
        });
    }
});

// 🔄 UPDATED: POST route to handle Reset Password submission (renders resetPassword.hbs)
app.post('/reset-password/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { newPassword, confirmNewPassword } = req.body;

        // Find user (student or teacher) by token and check expiry
        let user = await studentCollection.findOne({
            resetPasswordToken: token,
            resetPasswordTokenExpires: { $gt: Date.now() }
        });
        if (!user) {
            user = await teacherCollection.findOne({
                resetPasswordToken: token,
                resetPasswordTokenExpires: { $gt: Date.now() }
            });
        }

        if (!user) {
            console.log('DEBUG: Invalid or expired password reset token during submission.');
            // Render resetPassword.hbs with error
            return res.render('resetPassword', {
                success: false,
                error: 'The password reset link is invalid or has expired. Please request a new one.',
                token: '' // Don't pass the invalid token back
            });
        }

        // Password validation
        if (newPassword !== confirmNewPassword) {
            return res.render('resetPassword', {
                success: false,
                error: 'Passwords do not match.',
                token: token // Pass token back so user can retry on the same page
            });
        }
        if (newPassword.length < 6) { // Basic strength check
            return res.render('resetPassword', {
                success: false,
                error: 'Password must be at least 6 characters long.',
                token: token // Pass token back so user can retry on the same page
            });
        }

        // ⚠️ WARNING: TEMPORARILY SKIPPING PASSWORD HASHING FOR TESTING PURPOSES.
        // This is a MAJOR security vulnerability and MUST be re-enabled for production.
        user.password = newPassword; // Directly saving plain text password for testing

        // Update password and clear token fields
        user.resetPasswordToken = undefined;
        user.resetPasswordTokenExpires = undefined;
        await user.save();

        console.log(`DEBUG: User ${user.email} password successfully reset (plain text for testing).`);
        // Render resetPassword.hbs with success
        return res.render('resetPassword', {
            success: true,
            message: 'Your password has been successfully reset! You can now log in with your new password.'
        });

    } catch (error) {
        console.error('❌ Error resetting password:', error);
        // Render resetPassword.hbs with generic error
        return res.render('resetPassword', {
            success: false,
            error: 'An unexpected error occurred while resetting password. Please try again.',
            token: req.params.token // Pass token back if possible, or clear if it caused the error
        });
    }
});


// 🆕 NEW: Smart dashboard redirect based on user type
app.get('/dashboard', isAuthenticated, (req, res) => {
    try {
        const userType = req.session.userType;
        const userName = req.session.userName;

        console.log('🔄 Dashboard redirect requested:', {
            userType: userType,
            userName: userName,
            sessionId: req.sessionID
        });

        // Redirect based on user type
        if (userType === 'teacher') {
            console.log('👨‍🏫 Redirecting teacher to homeTeacher');
            res.redirect('/homeTeacher');
        } else if (userType === 'student') {
            console.log('🎓 Redirecting student to homeStudent');
            res.redirect('/homeStudent');
        } else {
            console.log('❌ Invalid user type or session, redirecting to login');
            res.redirect('/login?message=Invalid session. Please login again.');
        }
    } catch (error) {
        console.error('❌ Error in dashboard redirect:', error);
        res.redirect('/login?message=Session error. Please login again.');
    }
});



app.get('/about-developers', (req, res) => {
    res.render('about-developers', {
        title: 'Meet Our Developers - Quizzie'
    });
});


// ==================== DASHBOARD ROUTES ====================

// 🔄 UPDATED: homeStudent route to support new class-focused design
app.get("/homeStudent", isAuthenticated, async (req, res) => {
    try {
        // Get class context from query params (when redirected from class routes)
        const classContext = {
            classId: req.query.class || null,
            className: req.query.className || null,
            message: req.query.message || null
        };

        console.log('🎓 Student dashboard loaded with class-focused design');

        res.render("homeStudent", {
            userType: req.session.userType || "student",
            userName: req.session.userName || "Student",
            classContext: classContext,
            message: req.query.message,
            // 🆕 NEW: Pass dashboard mode
            dashboardMode: 'class-focused'
        });
    } catch (error) {
        console.error('❌ Error loading student dashboard:', error);
        res.render("homeStudent", {
            userType: req.session.userType || "student",
            userName: req.session.userName || "Student",
            error: 'Failed to load dashboard'
        });
    }
});

// 🔄 REPLACE your existing /homeTeacher route with this:
app.get("/homeTeacher", isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
        }

        const teacherId = req.session.userId;

        const teacher = await teacherCollection.findById(teacherId).lean();
        if (!teacher) {
            return res.redirect('/login?error=Teacher profile not found. Please login again.');
        }

        // NEW: Determine if email is unverified and present for the alert
        const showEmailVerificationAlert = teacher.email && !teacher.isVerified;

        // Get teacher's classes
        const classes = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        }).sort({ createdAt: -1 }).lean();

        // Calculate overall stats (your existing logic)
        let totalStudents = 0;
        let totalLectures = 0;
        let totalQuizzes = 0;

        const formattedClasses = await Promise.all(classes.map(async (cls) => {
            const studentsInClass = await classStudentCollection.countDocuments({ classId: cls._id, isActive: true });
            const lecturesInClass = await lectureCollection.countDocuments({ classId: cls._id });
            const quizzesInClass = await quizCollection.countDocuments({ classId: cls._id });

            const quizResults = await quizResultCollection.find({ classId: cls._id }).lean();
            const classTotalScore = quizResults.reduce((sum, result) => sum + result.percentage, 0);
            const classAverageScore = quizResults.length > 0 ? (classTotalScore / quizResults.length) : 0;

            totalStudents += studentsInClass;
            totalLectures += lecturesInClass;
            totalQuizzes += quizzesInClass;

            return {
                id: cls._id,
                name: cls.name,
                subject: cls.subject,
                description: cls.description,
                studentCount: studentsInClass,
                lectureCount: lecturesInClass,
                quizCount: quizzesInClass,
                averageScore: parseFloat(classAverageScore.toFixed(1)),
                createdDate: cls.createdAt ? cls.createdAt.toLocaleDateString() : 'N/A'
            };
        }));

        res.render("homeTeacher", {
            userName: req.session.userName || "Professor",
            userType: req.session.userType || "teacher",
            userEmail: teacher.email,
            userEmailVerified: teacher.isVerified,
            showEmailVerificationAlert: showEmailVerificationAlert, // NEW: Pass this boolean to the template
            classes: formattedClasses,
            totalClasses: formattedClasses.length,
            totalStudents: totalStudents,
            totalLectures: totalLectures,
            totalQuizzes: totalQuizzes,
            message: req.query.message,
            uploadError: req.query.uploadError,
            createdClassName: req.query.className
        });
    } catch (error) {
        console.error('❌ Error loading teacher dashboard:', error);
        res.status(500).render("homeTeacher", {
            userType: req.session.userType || "teacher",
            userName: req.session.userName || "Teacher",
            totalClasses: 0,
            totalStudents: 0,
            totalLectures: 0,
            totalQuizzes: 0,
            classes: [],
            uploadError: true,
            message: 'Failed to load dashboard: ' + error.message,
            userEmail: '',
            userEmailVerified: false,
            showEmailVerificationAlert: false // Ensure this is false on error
        });
    }
});

// NEW: Get User Profile Page
// 🔄 UPDATED: GET User Profile Page for Students
// 🔄 UPDATED: GET User Profile Page for Students
app.get('/profileStudent', isAuthenticated, async (req, res) => {
    if (req.session.userType !== 'student') {
        return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Only students can view this profile.'));
    }

    try {
        // Fetch student with new firstName and lastName fields, AND enrollment
        const student = await studentCollection.findById(req.session.userId)
                                .select('name email isVerified firstName lastName enrollment') // 🆕 NEW: Added 'enrollment' here
                                .lean();
        if (!student) {
            return res.redirect('/login?error=' + encodeURIComponent('Student profile not found. Please log in again.'));
        }

        // Use firstName and lastName for the profile header if available, fallback to name
        const displayUserName = student.firstName ? `${student.firstName} ${student.lastName || ''}`.trim() : student.name;
        const initials = displayUserName ? displayUserName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().substring(0, 2) : '';

        res.render('profileStudent', {
            user: student, // Pass the entire student object including firstName, lastName, and enrollment
            userName: displayUserName, // For header display (student's actual name)
            userType: 'student',
            initials: initials,
            message: req.query.message,
            error: req.query.error
        });
    } catch (error) {
        console.error('❌ Error fetching student profile:', error);
        res.redirect('/homeStudent?error=' + encodeURIComponent('Error fetching profile data.'));
    }
});

// 🔄 UPDATED: POST route to update Student Profile (with pending email verification)
app.post('/profileStudent', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Only students can update this profile.'));
        }

        const userId = req.session.userId;
        const { email, firstName, lastName } = req.body;

        const student = await studentCollection.findById(userId);
        if (!student) {
            return res.redirect('/profileStudent?error=' + encodeURIComponent('Student not found for update. Please log in again.'));
        }

        console.log('DEBUG: Old student email:', student.email, 'New student email (submitted):', email);
        console.log('DEBUG: Old student name:', student.firstName, student.lastName, 'New student name:', firstName, lastName);

        let emailChangeRequested = false; // Flag for email change request
        let nameChanged = false;

        // --- Handle Email Change Logic ---
        if (student.email !== email) {
            if (!email || !/.+@.+\..+/.test(email)) {
                return res.redirect('/profileStudent?error=' + encodeURIComponent('Please enter a valid email address format.'));
            }

            // Check if new email already exists for another user (student or teacher)
            const existingStudentWithEmail = await studentCollection.findOne({ email: email, _id: { $ne: userId } });
            const existingTeacherWithEmail = await teacherCollection.findOne({ email: email });

            if (existingStudentWithEmail || existingTeacherWithEmail) {
                console.log('DEBUG: New email already in use by another account.');
                return res.redirect('/profileStudent?error=' + encodeURIComponent('This email is already registered to another account.'));
            }
            emailChangeRequested = true; // Email change requested, but not yet applied
            console.log('DEBUG: Student email change requested. Old:', student.email, 'New:', email);
        }

        // --- Handle Name Change Logic ---
        if (student.firstName !== firstName || student.lastName !== lastName) {
            if (!firstName || firstName.trim() === '') {
                return res.redirect('/profileStudent?error=' + encodeURIComponent('First name is required.'));
            }
            nameChanged = true;
            console.log('DEBUG: Student name has changed.');
        }

        // --- Process Updates ---
        if (emailChangeRequested) {
            // Generate token for the PENDING email
            const newVerificationToken = crypto.randomBytes(32).toString('hex');
            const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
            const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

            console.log('DEBUG: Attempting to send verification email for PENDING student email...');
            console.log('DEBUG: Verification Link:', verificationLink);

            const emailUserName = firstName || student.name;
            const emailHtml = await renderEmailTemplate('verificationEmail', {
                username: emailUserName,
                verificationLink: verificationLink
            });
            console.log('DEBUG: Email HTML rendered.');

            const emailResult = await sendEmail({
                to: email, // Send to the PENDING email
                subject: 'Please Verify Your New Email for Quizzie', // Updated subject
                html: emailHtml,
                text: `Hello ${emailUserName}! Please verify your new email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
            });

            if (emailResult.success) {
                // Store pendingEmail and token, but do NOT update 'email' field yet
                student.pendingEmail = email; // Store the new email as pending
                student.isVerified = false; // Mark as unverified (for the new pending email)
                student.verificationToken = newVerificationToken;
                student.verificationTokenExpires = newVerificationTokenExpires;
                // Update name fields immediately if they changed
                if (nameChanged) {
                    student.firstName = firstName;
                    student.lastName = lastName;
                }
                await student.save();
                console.log('DEBUG: Student profile saved with pending email and new name (if changed).');
                return res.redirect('/profileStudent?message=' + encodeURIComponent('A verification link has been sent to your new email address. Please click the link to confirm the change. Your profile name has been updated.'));
            } else {
                console.error('❌ Failed to send verification email for pending student email:', emailResult.message);
                // Do NOT save pendingEmail or token if sending failed. Keep old email.
                return res.redirect('/profileStudent?error=' + encodeURIComponent(`Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`));
            }
        } else if (nameChanged) {
            // If only name changed, update name and save
            student.firstName = firstName;
            student.lastName = lastName;
            await student.save();
            console.log('DEBUG: Only student name updated and saved.');
            return res.redirect('/profileStudent?message=' + encodeURIComponent('Profile updated successfully!'));
        } else {
            console.log('DEBUG: No changes detected for student profile.');
            return res.redirect('/profileStudent?message=' + encodeURIComponent('No changes detected in profile.'));
        }

    } catch (error) {
        console.error('❌ Error updating student profile:', error);
        res.redirect('/profileStudent?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
    }
});

// Email Verification Route (for new registrations and profile updates)
// 🔄 UPDATED: Email Verification Route (now renders emailVerificationSuccess.hbs)
app.get('/verify-email/:token', async (req, res) => {
    console.log('DEBUG: GET /verify-email/:token route hit');
    try {
        const { token } = req.params;
        console.log('DEBUG: Verification token received:', token);

        // Try to find user in studentCollection
        let user = await studentCollection.findOne({
            verificationToken: token,
            verificationTokenExpires: { $gt: Date.now() }
        });

        // If not found in studentCollection, try teacherCollection
        if (!user) {
            user = await teacherCollection.findOne({
                verificationToken: token,
                verificationTokenExpires: { $gt: Date.now() }
            });
        }

        if (!user) {
            console.log('DEBUG: Invalid or expired verification link provided.');
            return res.render('emailVerificationSuccess', {
                success: false,
                error: 'The verification link is invalid or has expired. Please try resending the verification email.'
            });
        }

        // Check if this is a pending email verification
        if (user.pendingEmail && user.verificationToken === token) {
            // This is a pending email change, apply it now
            user.email = user.pendingEmail; // CRITICAL: Update the main email field
            user.pendingEmail = undefined; // Clear pending email
            user.isVerified = true; // Mark as verified
            user.verificationToken = undefined; // Clear token
            user.verificationTokenExpires = undefined; // Clear expiry
            await user.save();
            console.log(`DEBUG: User ${user.email} (new) email successfully updated and verified.`);
            return res.render('emailVerificationSuccess', {
                success: true,
                message: 'Your email address has been successfully updated and verified!'
            });
        }
        // This handles initial registration verification
        else if (!user.isVerified && !user.pendingEmail && user.verificationToken === token) {
            user.isVerified = true;
            user.verificationToken = undefined;
            user.verificationTokenExpires = undefined;
            await user.save();
            console.log(`DEBUG: User ${user.email} (initial) email successfully verified.`);
            return res.render('emailVerificationSuccess', {
                success: true,
                message: 'Your email has been successfully verified! You can now log in.'
            });
        }
        // If already verified (and no pending email)
        else if (user.isVerified) {
            console.log(`DEBUG: User ${user.email} email already verified.`);
            return res.render('emailVerificationSuccess', {
                success: false, // Treat as a "failure" for this specific link click, as nothing changed
                error: 'Your email address is already verified. No action needed.'
            });
        }
        else {
            // Fallback for any other unexpected token state
            console.log('DEBUG: Unexpected verification state for token:', token);
            return res.render('emailVerificationSuccess', {
                success: false,
                error: 'An unexpected error occurred during verification. Please try again.'
            });
        }

    } catch (error) {
        console.error('❌ Error verifying email:', error);
        return res.render('emailVerificationSuccess', {
            success: false,
            error: 'An internal server error occurred during verification. Please try again later.'
        });
    }
});

// 🔄 UPDATED: POST route to update Teacher Profile (with pending email verification)
app.post('/profileTeacher', isAuthenticated, async (req, res) => {
    console.log('DEBUG: POST /profileTeacher route hit');
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Not a teacher account.'));
        }

        const { email, firstName, lastName } = req.body;
        const teacherId = req.session.userId;

        const teacher = await teacherCollection.findById(teacherId);
        if (!teacher) {
            return res.redirect('/profileTeacher?error=' + encodeURIComponent('Teacher not found. Please log in again.'));
        }

        console.log('DEBUG: Old teacher name:', teacher.firstName, teacher.lastName, 'New teacher name:', firstName, lastName);
        console.log('DEBUG: Old teacher email:', teacher.email, 'New teacher email (submitted):', email);

        let emailChangeRequested = false;
        let nameChanged = false;

        // --- Handle Email Change Logic ---
        if (teacher.email !== email) {
            if (!email || !/.+@.+\..+/.test(email)) {
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('Please enter a valid email address format.'));
            }

            const existingTeacherWithEmail = await teacherCollection.findOne({ email: email, _id: { $ne: teacherId } });
            const existingStudentWithEmail = await studentCollection.findOne({ email: email });

            if (existingTeacherWithEmail || existingStudentWithEmail) {
                console.log('DEBUG: New email already in use by another account.');
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('This email is already registered to another account.'));
            }
            emailChangeRequested = true;
            console.log('DEBUG: Teacher email change requested. Old:', teacher.email, 'New:', email);
        }

        // --- Handle Name Change Logic ---
        if (teacher.firstName !== firstName || teacher.lastName !== lastName) {
            if (!firstName || firstName.trim() === '') {
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('First name is required.'));
            }
            nameChanged = true;
            console.log('DEBUG: Teacher name has changed.');
        }

        // --- Process Updates ---
        if (emailChangeRequested) {
            const newVerificationToken = crypto.randomBytes(32).toString('hex');
            const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
            const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

            console.log('DEBUG: Attempting to send verification email for PENDING teacher email...');
            console.log('DEBUG: Verification Link:', verificationLink);

            const emailUserName = firstName || teacher.name;
            const emailHtml = await renderEmailTemplate('verificationEmail', {
                username: emailUserName,
                verificationLink: verificationLink
            });
            console.log('DEBUG: Email HTML rendered.');

            const emailResult = await sendEmail({
                to: email, // Send to the PENDING email
                subject: 'Please Verify Your New Email for Quizzie', // Updated subject
                html: emailHtml,
                text: `Hello ${emailUserName}! Please verify your new email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
            });

            if (emailResult.success) {
                // Store pendingEmail and token, but do NOT update 'email' field yet
                teacher.pendingEmail = email; // Store the new email as pending
                teacher.isVerified = false; // Mark as unverified (for the new pending email)
                teacher.verificationToken = newVerificationToken;
                teacher.verificationTokenExpires = newVerificationTokenExpires;
                // Update name fields immediately if they changed
                if (nameChanged) {
                    teacher.firstName = firstName;
                    teacher.lastName = lastName;
                }
                await teacher.save();
                console.log('DEBUG: Teacher profile saved with pending email and new name (if changed).');
                return res.redirect('/profileTeacher?message=' + encodeURIComponent('A verification link has been sent to your new email address. Please click the link to confirm the change. Your profile name has been updated.'));
            } else {
                console.error('❌ Failed to send verification email for pending teacher email:', emailResult.message);
                // Do NOT save pendingEmail or token if sending failed. Keep old email.
                return res.redirect('/profileTeacher?error=' + encodeURIComponent(`Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`));
            }
        } else if (nameChanged) {
            // If only name changed, update name and save
            teacher.firstName = firstName;
            teacher.lastName = lastName;
            await teacher.save();
            console.log('DEBUG: Only teacher name updated and saved.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('Profile updated successfully!'));
        } else {
            console.log('DEBUG: No changes detected for teacher profile.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('No changes detected in profile.'));
        }

    } catch (error) {
        console.error('❌ Error updating teacher profile:', error);
        res.redirect('/profileTeacher?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
    }
});

// ==================== TEACHER PROFILE ROUTES ====================

// GET route for Teacher Profile page
// 🔄 UPDATED: GET route for Teacher Profile page
app.get('/profileTeacher', isAuthenticated, async (req, res) => {
    console.log('DEBUG: GET /profileTeacher route hit');
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Not a teacher account.'));
        }

        // Fetch teacher with name, email, verification status, AND firstName, lastName
        const teacher = await teacherCollection.findById(req.session.userId)
                                .select('name email isVerified firstName lastName') // 🆕 NEW: Select firstName and lastName
                                .lean();
        if (!teacher) {
            return res.redirect('/login?error=' + encodeURIComponent('Teacher profile not found. Please log in again.'));
        }

        // For teacher, userName is the full name from the DB (or derived from firstName/lastName)
        const displayUserName = teacher.firstName ? `${teacher.firstName} ${teacher.lastName || ''}`.trim() : teacher.name;
        const initials = displayUserName ? displayUserName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().substring(0, 2) : '';

        res.render('profileTeacher', {
            user: teacher, // Pass the entire teacher object including firstName, lastName
            userName: displayUserName, // For header display
            userType: 'Professor', // Display role as Professor
            initials: initials,
            message: req.query.message,
            error: req.query.error
        });

    } catch (error) {
        console.error('❌ Error loading teacher profile:', error);
        res.redirect('/homeTeacher?error=' + encodeURIComponent('Failed to load profile.'));
    }
});
// POST route to update Teacher Profile
// 🔄 UPDATED: POST route to update Teacher Profile
app.post('/profileTeacher', isAuthenticated, async (req, res) => {
    console.log('DEBUG: POST /profileTeacher route hit');
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Not a teacher account.'));
        }

        const { name, email, firstName, lastName } = req.body; // Destructure all possible name fields
        const teacherId = req.session.userId;

        const teacher = await teacherCollection.findById(teacherId);
        if (!teacher) {
            return res.redirect('/profileTeacher?error=' + encodeURIComponent('Teacher not found. Please log in again.'));
        }

        console.log('DEBUG: Old teacher name:', teacher.firstName, teacher.lastName, 'New teacher name:', firstName, lastName);
        console.log('DEBUG: Old teacher email:', teacher.email, 'New teacher email:', email);

        let emailChanged = false;
        let nameChanged = false;
        let oldEmail = teacher.email;

        // --- Handle Email Change Logic ---
        if (teacher.email !== email) {
            if (!email || !/.+@.+\..+/.test(email)) {
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('Please enter a valid email address format.'));
            }

            const existingTeacherWithEmail = await teacherCollection.findOne({ email: email, _id: { $ne: teacherId } });
            const existingStudentWithEmail = await studentCollection.findOne({ email: email });

            if (existingTeacherWithEmail || existingStudentWithEmail) {
                console.log('DEBUG: New email already in use by another account.');
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('This email is already registered to another account.'));
            }
            emailChanged = true;
            console.log('DEBUG: Teacher email has changed. Old:', oldEmail, 'New:', email);
        }

        // --- Handle Name Change Logic ---
        // Prioritize firstName/lastName from form. If only 'name' was submitted (e.g., old form),
        // the pre-save hook will handle parsing it.
        if (teacher.firstName !== firstName || teacher.lastName !== lastName) {
            if (!firstName || firstName.trim() === '') {
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('First name is required.'));
            }
            nameChanged = true;
            console.log('DEBUG: Teacher name has changed.');
        }

        // --- IMPORTANT SECURITY CHANGE: Only update email/verification AFTER successful send ---
        if (emailChanged) {
            const newVerificationToken = crypto.randomBytes(32).toString('hex');
            const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
            const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

            console.log('DEBUG: Attempting to send verification email for new teacher email...');
            console.log('DEBUG: Verification Link:', verificationLink);

            const emailUserName = firstName || teacher.name; // Use new first name, fallback to current full name
            const emailHtml = await renderEmailTemplate('verificationEmail', {
                username: emailUserName,
                verificationLink: verificationLink
            });
            console.log('DEBUG: Email HTML rendered.');

            const emailResult = await sendEmail({
                to: email,
                subject: 'Please Verify Your Updated Email for Quizzie',
                html: emailHtml,
                text: `Hello ${emailUserName}! Please verify your updated email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
            });

            if (emailResult.success) {
                // ONLY update and save the database if email sent successfully
                teacher.email = email;
                teacher.isVerified = false;
                teacher.verificationToken = newVerificationToken;
                teacher.verificationTokenExpires = newVerificationTokenExpires;
                teacher.firstName = firstName; // Update firstName
                teacher.lastName = lastName;   // Update lastName
                // The 'name' field will be updated by the pre-save hook
                await teacher.save();
                console.log('DEBUG: Teacher email, name, and verification status saved after successful email send.');

                return res.redirect('/profileTeacher?message=' + encodeURIComponent('Profile updated. A new verification email has been sent to your updated address.'));
            } else {
                console.error('❌ Failed to send new verification email after teacher profile update:', emailResult.message);
                return res.redirect('/profileTeacher?error=' + encodeURIComponent(`Profile update failed: ${emailResult.message}. Please try again or contact support.`));
            }
        } else if (nameChanged) {
            // If email didn't change, but name did, update name and save
            teacher.firstName = firstName; // Update firstName
            teacher.lastName = lastName;   // Update lastName
            // The 'name' field will be updated by the pre-save hook
            await teacher.save();
            console.log('DEBUG: Only teacher name updated and saved.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('Profile updated successfully!'));
        } else {
            // If neither email nor name changed
            console.log('DEBUG: No changes detected for teacher profile.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('No changes detected in profile.'));
        }

    } catch (error) {
        console.error('❌ Error updating teacher profile:', error);
        res.redirect('/profileTeacher?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
    }
});
// ==================== CLASS CRUD ROUTES ====================

// 📋 Get all classes for a teacher
app.get('/api/classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const teacherId = req.session.userId;

        // Get teacher's classes with computed stats
        const classes = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        })
            .sort({ createdAt: -1 })
            .lean();

        console.log(`📋 Found ${classes.length} classes for teacher ${req.session.userName}`);

        // Format classes for response
        const formattedClasses = classes.map(classDoc => ({
            id: classDoc._id,
            name: classDoc.name,
            subject: classDoc.subject,
            description: classDoc.description,
            studentCount: classDoc.studentCount || 0,
            lectureCount: classDoc.lectureCount || 0,
            quizCount: classDoc.quizCount || 0,
            averageScore: classDoc.averageScore || 0,
            createdAt: classDoc.createdAt,
            updatedAt: classDoc.updatedAt
        }));

        res.json({
            success: true,
            classes: formattedClasses,
            totalClasses: formattedClasses.length
        });

    } catch (error) {
        console.error('❌ Error fetching classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch classes: ' + error.message
        });
    }
});

// ➕ Create new class
app.post('/api/classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const { name, subject, description } = req.body;
        const teacherId = req.session.userId;
        const teacherName = req.session.userName;

        // Validate required fields
        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        // Check if class name already exists for this teacher
        const existingClass = await classCollection.findOne({
            teacherId: teacherId,
            name: name.trim(),
            isActive: true
        });

        if (existingClass) {
            return res.status(400).json({
                success: false,
                message: 'You already have a class with this name.'
            });
        }

        // Create new class
        const newClass = await classCollection.create({
            name: name.trim(),
            subject: subject.trim(),
            description: description?.trim() || '',
            teacherId: teacherId,
            teacherName: teacherName,
            studentCount: 0,
            lectureCount: 0,
            quizCount: 0,
            averageScore: 0
        });

        console.log(`✅ New class created: ${newClass.name} by ${teacherName}`);

        res.json({
            success: true,
            message: 'Class created successfully!',
            class: {
                id: newClass._id,
                name: newClass.name,
                subject: newClass.subject,
                description: newClass.description,
                studentCount: 0,
                lectureCount: 0,
                quizCount: 0,
                averageScore: 0,
                createdAt: newClass.createdAt
            }
        });

    } catch (error) {
        console.error('❌ Error creating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create class: ' + error.message
        });
    }
});

// 📖 Get specific class details
app.get('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        res.json({
            success: true,
            class: {
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: classDoc.studentCount || 0,
                lectureCount: classDoc.lectureCount || 0,
                quizCount: classDoc.quizCount || 0,
                averageScore: classDoc.averageScore || 0,
                createdAt: classDoc.createdAt,
                updatedAt: classDoc.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ Error fetching class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class: ' + error.message
        });
    }
});

// ✏️ Update class information
app.put('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { name, subject, description } = req.body;

        // Validate required fields
        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        // Check if class exists and belongs to teacher
        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Update class
        const updatedClass = await classCollection.findByIdAndUpdate(
            classId,
            {
                name: name.trim(),
                subject: subject.trim(),
                description: description?.trim() || '',
                updatedAt: new Date()
            },
            { new: true }
        ).lean();

        console.log(`✅ Class updated: ${updatedClass.name}`);

        res.json({
            success: true,
            message: 'Class updated successfully!',
            class: {
                id: updatedClass._id,
                name: updatedClass.name,
                subject: updatedClass.subject,
                description: updatedClass.description,
                studentCount: updatedClass.studentCount || 0,
                lectureCount: updatedClass.lectureCount || 0,
                quizCount: updatedClass.quizCount || 0,
                averageScore: updatedClass.averageScore || 0,
                updatedAt: updatedClass.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ Error updating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update class: ' + error.message
        });
    }
});

// 🗄️ Archive/Delete class
app.delete('/api/classes/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Check if class exists and belongs to teacher
        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Soft delete - mark as inactive
        await classCollection.findByIdAndUpdate(classId, {
            isActive: false,
            updatedAt: new Date()
        });

        // Also mark class students as inactive
        await classStudentCollection.updateMany(
            { classId: classId },
            { isActive: false }
        );

        console.log(`🗄️ Class archived: ${existingClass.name}`);

        res.json({
            success: true,
            message: 'Class archived successfully!'
        });

    } catch (error) {
        console.error('❌ Error archiving class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive class: ' + error.message
        });
    }
});

// ==================== STUDENT MANAGEMENT ROUTES ====================

// ➕ Add student to class (ENHANCED DEBUG VERSION)
app.post('/api/classes/:classId/students', isAuthenticated, async (req, res) => {
    try {
        console.log('🔍 Add student request:', {
            userType: req.session.userType,
            userId: req.session.userId,
            userName: req.session.userName,
            classId: req.params.classId,
            body: req.body
        });

        if (req.session.userType !== 'teacher') {
            console.log('❌ Access denied - not a teacher:', req.session.userType);
            return res.status(403).json({
                success: false,
                message: 'Access denied. Teachers only.',
                debug: {
                    userType: req.session.userType,
                    expectedType: 'teacher',
                    sessionId: req.sessionID
                }
            });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { enrollmentNumber } = req.body;

        console.log('📝 Adding student to class:', {
            classId,
            teacherId,
            enrollmentNumber,
            userName: req.session.userName
        });

        if (!enrollmentNumber) {
            return res.status(400).json({
                success: false,
                message: 'Student enrollment number is required.'
            });
        }

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            console.log('❌ Class not found or access denied:', {
                classId,
                teacherId
            });
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('✅ Class verified:', classDoc.name);

        // Find student by enrollment number
        const student = await studentCollection.findOne({
            enrollment: enrollmentNumber.trim()
        });

        if (!student) {
            console.log('❌ Student not found:', enrollmentNumber);
            return res.status(404).json({
                success: false,
                message: 'Student not found with this enrollment number.'
            });
        }

        console.log('✅ Student found:', student.name);

        // 🔧 FIX: Check for ANY existing enrollment (active or inactive)
        const existingEnrollment = await classStudentCollection.findOne({
            classId: classId,
            studentId: student._id
            // 🔧 REMOVED: isActive: true condition to check ALL enrollments
        });

        if (existingEnrollment) {
            console.log('⚠️ Existing enrollment found:', {
                isActive: existingEnrollment.isActive,
                enrollmentId: existingEnrollment._id
            });

            if (existingEnrollment.isActive) {
                return res.status(400).json({
                    success: false,
                    message: 'Student is already enrolled in this class.'
                });
            } else {
                // 🔧 FIX: Reactivate enrollment instead of creating new one
                await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                    isActive: true,
                    enrolledAt: new Date(),
                    studentName: student.name, // Update name in case it changed
                    studentEnrollment: student.enrollment // Update enrollment number
                });
                console.log('✅ Student enrollment reactivated');
            }
        } else {
            // Create new enrollment
            const newEnrollment = await classStudentCollection.create({
                classId: classId,
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment
            });
            console.log('✅ New student enrollment created:', newEnrollment._id);
        }

        // Update class student count
        const totalActiveStudents = await classStudentCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        await classCollection.findByIdAndUpdate(classId, {
            studentCount: totalActiveStudents,
            updatedAt: new Date()
        });

        console.log(`✅ Student ${student.name} (${student.enrollment}) added to class ${classDoc.name}`);

        res.json({
            success: true,
            message: `Student ${student.name} added to class successfully!`,
            student: {
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment,
                enrolledAt: new Date(),
                totalQuizzes: 0,
                averageScore: 0,
                lastActivity: new Date(),
                participationRate: 0
            }
        });

    } catch (error) {
        console.error('❌ Error adding student to class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add student: ' + error.message,
            debug: {
                error: error.message,
                stack: error.stack
            }
        });
    }
});

// 👥 Get students in a class (MISSING ROUTE - ADD THIS)
app.get('/api/classes/:classId/students', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('👥 Loading students for class:', {
            classId: classId,
            teacherId: teacherId,
            requestedBy: req.session.userName
        });

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            console.log('❌ Class not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('✅ Class verified:', classDoc.name);

        // Get students enrolled in this class
        const enrollments = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        console.log(`📋 Found ${enrollments.length} active enrollments`);

        // Get quiz results for performance stats
        const studentsWithStats = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: enrollment.studentId,
                    classId: classId
                }).lean();

                const totalQuizzes = studentResults.length;
                const averageScore = totalQuizzes > 0
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
                    : 0;

                const lastActivity = totalQuizzes > 0
                    ? studentResults[studentResults.length - 1].submissionDate
                    : enrollment.enrolledAt;

                return {
                    studentId: enrollment.studentId,
                    studentName: enrollment.studentName,
                    studentEnrollment: enrollment.studentEnrollment,
                    enrolledAt: enrollment.enrolledAt,
                    totalQuizzes: totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    lastActivity: lastActivity,
                    participationRate: totalQuizzes > 0 ? 100 : 0 // Simple calculation
                };
            })
        );

        console.log(`✅ Students loaded with stats: ${studentsWithStats.length}`);

        res.json({
            success: true,
            students: studentsWithStats,
            totalStudents: studentsWithStats.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error fetching students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students: ' + error.message
        });
    }
});

// 🗑️ Remove student from class
app.delete('/api/classes/:classId/students/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const { classId, studentId } = req.params;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Find and remove enrollment
        const enrollment = await classStudentCollection.findOneAndUpdate(
            {
                classId: classId,
                studentId: studentId,
                isActive: true
            },
            {
                isActive: false
            },
            { new: true }
        );

        if (!enrollment) {
            return res.status(404).json({
                success: false,
                message: 'Student not found in this class.'
            });
        }

        console.log(`🗑️ Student ${enrollment.studentName} removed from class ${classDoc.name}`);

        res.json({
            success: true,
            message: 'Student removed from class successfully!'
        });

    } catch (error) {
        console.error('❌ Error removing student from class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove student: ' + error.message
        });
    }
});

// ==================== CLASS STATISTICS & ANALYTICS ROUTES ====================

// 📊 Get class overview for management page (FIXED VERSION WITH PERFORMANCE TREND)
app.get('/api/classes/:classId/overview', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get class students and quiz results
        const classStudents = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        const allResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // 🔧 FIX: Calculate performance trend data for chart
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).sort({ generatedDate: 1 }).lean(); // Sort by creation date

        const performanceTrend = quizzes.map(quiz => {
            const quizResults = allResults.filter(result =>
                result.quizId.toString() === quiz._id.toString()
            );

            const averageScore = quizResults.length > 0
                ? quizResults.reduce((sum, result) => sum + result.percentage, 0) / quizResults.length
                : 0;

            return {
                quizTitle: quiz.lectureTitle,
                score: formatPercentage(averageScore),
                attempts: quizResults.length,
                date: quiz.generatedDate
            };
        });

        // Calculate student performance map
        const studentPerformance = {};
        allResults.forEach(result => {
            const studentId = result.studentId.toString();
            if (!studentPerformance[studentId]) {
                studentPerformance[studentId] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformance[studentId].scores.push(result.percentage);
            studentPerformance[studentId].totalQuizzes++;
        });

        // Calculate top performers with proper formatting
        const topPerformers = Object.values(studentPerformance)
            .map(student => ({
                studentName: student.studentName,
                averageScore: formatPercentage(student.scores.reduce((a, b) => a + b, 0) / student.scores.length),
                totalQuizzes: student.totalQuizzes
            }))
            .sort((a, b) => b.averageScore - a.averageScore)
            .slice(0, 5);

        // Get recent activity
        const recentActivity = allResults
            .sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate))
            .slice(0, 10)
            .map(result => ({
                studentName: result.studentName,
                score: formatPercentage(result.percentage),
                submissionDate: result.submissionDate.toLocaleDateString(),
                timeTaken: formatTime(result.timeTakenSeconds)
            }));

        console.log('📊 Performance trend data:', performanceTrend.length, 'data points');

        res.json({
            success: true,
            classData: {
                ...classDoc,
                studentCount: classStudents.length,
                averageScore: formatPercentage(classDoc.averageScore || 0)
            },
            topPerformers: topPerformers,
            recentActivity: recentActivity,
            performanceTrend: performanceTrend // 🔧 FIX: Add performance trend data
        });

    } catch (error) {
        console.error('❌ Error fetching class overview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class overview: ' + error.message
        });
    }
});





// 📈 Get detailed class analytics
app.get('/api/classes/:classId/analytics', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get all quiz results for this class
        const allResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Get class quizzes
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // 🔧 FIX: Calculate detailed analytics with proper formatting
        const analytics = {
            totalParticipants: new Set(allResults.map(r => r.studentId.toString())).size,
            totalQuizAttempts: allResults.length,
            classAverage: allResults.length > 0
                ? formatPercentage(allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length) // 🔧 FIX
                : 0,
            highestScore: allResults.length > 0
                ? formatPercentage(Math.max(...allResults.map(r => r.percentage))) // 🔧 FIX
                : 0,
            lowestScore: allResults.length > 0
                ? formatPercentage(Math.min(...allResults.map(r => r.percentage))) // 🔧 FIX
                : 0,

            // Performance distribution
            performanceDistribution: {
                excellent: allResults.filter(r => r.percentage >= 90).length,
                good: allResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                average: allResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                needsImprovement: allResults.filter(r => r.percentage < 50).length
            },

            // 🔧 FIX: Quiz performance breakdown with proper formatting
            quizPerformance: classQuizzes.map(quiz => {
                const quizResults = allResults.filter(r => r.quizId.toString() === quiz._id.toString());
                return {
                    quizId: quiz._id,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0
                        ? formatPercentage(quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length) // 🔧 FIX
                        : 0,
                    highestScore: quizResults.length > 0
                        ? formatPercentage(Math.max(...quizResults.map(r => r.percentage))) // 🔧 FIX
                        : 0,
                    lowestScore: quizResults.length > 0
                        ? formatPercentage(Math.min(...quizResults.map(r => r.percentage))) // 🔧 FIX
                        : 0
                };
            })
        };

        res.json({
            success: true,
            analytics: analytics
        });

    } catch (error) {
        console.error('❌ Error fetching class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class analytics: ' + error.message
        });
    }
});



// ==================== PAGE ROUTES ====================

// 🏫 Render class management page
app.get('/class/manage/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Get class info
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).send('Class not found or access denied.');
        }

        console.log(`🏫 Rendering class management page for: ${classDoc.name}`);

        res.render('classManagement', {
            classId: classId,
            className: classDoc.name,
            classSubject: classDoc.subject,
            userName: req.session.userName,
            userType: req.session.userType
        });

    } catch (error) {
        console.error('❌ Error rendering class management page:', error);
        res.status(500).send('Failed to load class management page.');
    }
});


// ==================== LECTURE MANAGEMENT ROUTES ====================

app.post("/upload_lecture", isAuthenticated, upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null;

    try {
        if (req.fileError) {
            return res.status(400).json({
                success: false,
                message: req.fileError.message
            });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { title, classId } = req.body; // 🆕 NEW: classId parameter
        const file = req.file;
        tempFilePath = file.path;

        console.log('📁 Processing file for class:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path,
            classId: classId
        });

        const professorId = req.session.userId;
        const professorName = req.session.userName;

        if (!professorId || !professorName || req.session.userType !== 'teacher') {
            console.warn('⚠️ User not identified as a teacher in session for lecture upload.');
            return req.session.destroy(err => {
                res.status(401).json({
                    success: false,
                    message: 'Authentication required. Please log in as a teacher.'
                });
            });
        }

        // 🆕 NEW: Verify class ownership if classId provided
        let className = null;
        if (classId) {
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: professorId,
                isActive: true
            });

            if (!classDoc) {
                return res.status(403).json({
                    success: false,
                    message: 'Class not found or access denied.'
                });
            }
            className = classDoc.name;
        }

        const extractedText = await extractTextFromFile(file.path, file.mimetype);

        console.log('📝 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        cleanupTempFile(tempFilePath);
        console.log(`🗑️ Temporary file cleaned up after extraction.`);

        // 🔄 UPDATED: Include class information in lecture data
        const lectureData = {
            title: title,
            filePath: '',
            originalFileName: file.originalname,
            mimeType: file.mimetype,
            fileSize: file.size,
            extractedText: extractedText,
            textLength: extractedText.length,
            uploadDate: new Date(),
            fileType: getFileType(file.mimetype),
            quizGenerated: false,
            processingStatus: 'completed',
            professorName: professorName,
            professorId: professorId,
            // 🆕 NEW: Class association
            classId: classId || null,
            className: className || null
        };

        const savedLecture = await lectureCollection.create(lectureData);
        console.log('✅ Lecture saved to database:', savedLecture._id);

        // 🆕 NEW: Return structured response for API usage
        res.json({
            success: true,
            message: `Lecture uploaded successfully${className ? ` to class ${className}` : ''}!`,
            lectureId: savedLecture._id,
            title: savedLecture.title,
            className: className
        });

    } catch (error) {
        console.error('❌ Upload processing error:', error);

        if (tempFilePath && fs.existsSync(tempFilePath)) {
            cleanupTempFile(tempFilePath);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to process uploaded file: ' + error.message
        });
    }
});

app.get('/lectures/:id/text', isAuthenticated, async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength professorId')

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ success: false, message: 'Access denied. You do not own this lecture.' });
        }

        res.json({
            success: true,
            data: {
                id: lecture._id,
                title: lecture.title,
                textLength: lecture.textLength,
                extractedText: lecture.extractedText
            }
        })
    } catch (error) {
        console.error('❌ Error fetching lecture text:', error)
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        })
    }
})

// ==================== ENHANCED QUIZ GENERATION ROUTE ====================

app.post('/api/exam/:quizId/start', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        console.log('🚀 Starting exam:', {
            quizId: quizId,
            teacherId: teacherId,
            teacherName: req.session.userName
        });

        // Get the quiz and verify ownership
        const quiz = await quizCollection.findById(quizId);
        
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify teacher owns this quiz
        if (!quiz.createdBy.equals(teacherId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only start your own exams.'
            });
        }

        // Check if quiz is in exam mode
        if (!quiz.isExamMode) {
            return res.status(400).json({
                success: false,
                message: 'This quiz is not configured as an exam.'
            });
        }

        // Check if exam is already active
        if (quiz.examStatus === 'active') {
            return res.status(400).json({
                success: false,
                message: 'This exam is already active.'
            });
        }

        // Check if exam has already ended
        if (quiz.examStatus === 'ended') {
            return res.status(400).json({
                success: false,
                message: 'This exam has already ended.'
            });
        }

        // Start the exam
        const updatedQuiz = await quiz.startExam(teacherId);
        
        console.log('✅ Exam started successfully:', {
            quizId: quizId,
            examStartTime: updatedQuiz.examStartTime,
            examEndTime: updatedQuiz.examEndTime,
            examDuration: updatedQuiz.examDurationMinutes
        });

        res.json({
            success: true,
            message: 'Exam started successfully!',
            examStartTime: updatedQuiz.examStartTime.toISOString(),
            examEndTime: updatedQuiz.examEndTime.toISOString(),
            examDurationMinutes: updatedQuiz.examDurationMinutes,
            examStatus: updatedQuiz.examStatus
        });

    } catch (error) {
        console.error('❌ Error starting exam:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam: ' + error.message
        });
    }
});

// 🆕 NEW: End Exam Route
app.post('/api/exam/:quizId/end', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        console.log('🛑 Ending exam:', {
            quizId: quizId,
            teacherId: teacherId,
            teacherName: req.session.userName
        });

        // Get the quiz and verify ownership
        const quiz = await quizCollection.findById(quizId);
        
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify teacher owns this quiz
        if (!quiz.createdBy.equals(teacherId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only end your own exams.'
            });
        }

        // Check if quiz is in exam mode
        if (!quiz.isExamMode) {
            return res.status(400).json({
                success: false,
                message: 'This quiz is not configured as an exam.'
            });
        }

        // Check if exam is currently active
        if (quiz.examStatus !== 'active') {
            return res.status(400).json({
                success: false,
                message: 'This exam is not currently active.'
            });
        }

        // End the exam
        const updatedQuiz = await quiz.endExam();
        
        console.log('✅ Exam ended successfully:', {
            quizId: quizId,
            examEndedAt: new Date(),
            examStatus: updatedQuiz.examStatus
        });

        res.json({
            success: true,
            message: 'Exam ended successfully!',
            examStatus: updatedQuiz.examStatus,
            endedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error ending exam:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end exam: ' + error.message
        });
    }
});

// 🆕 NEW: Check Exam Status Route (for students)
app.get('/api/exam/:quizId/status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        
        console.log('🔍 Checking exam status:', {
            quizId: quizId,
            userType: req.session.userType,
            userId: req.session.userId
        });

        // Get the quiz
        const quiz = await quizCollection.findById(quizId).select(
            'isExamMode examStatus examStartTime examEndTime examDurationMinutes lectureTitle classId isActive'
        );
        
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Check if quiz is active
        if (!quiz.isActive) {
            return res.status(400).json({
                success: false,
                message: 'This quiz is no longer active.'
            });
        }

        // If it's not an exam, return normal quiz status
        if (!quiz.isExamMode) {
            return res.json({
                success: true,
                isExamMode: false,
                canTakeQuiz: true,
                quizTitle: quiz.lectureTitle,
                classId: quiz.classId
            });
        }

        // Check exam status
        const now = new Date();
        let canTakeQuiz = false;
        let timeRemaining = 0;
        let statusMessage = '';

        switch (quiz.examStatus) {
            case 'scheduled':
                canTakeQuiz = false;
                statusMessage = 'Exam has not started yet. Please wait for your teacher to start the exam.';
                break;
                
            case 'active':
                if (quiz.examEndTime && now <= quiz.examEndTime) {
                    canTakeQuiz = true;
                    timeRemaining = Math.max(0, Math.floor((quiz.examEndTime - now) / 1000));
                    statusMessage = `Exam is active. Time remaining: ${formatExamTime(timeRemaining)}`;
                } else {
                    // Exam has expired, auto-end it
                    await quiz.endExam();
                    canTakeQuiz = false;
                    statusMessage = 'Exam time has expired.';
                }
                break;
                
            case 'ended':
                canTakeQuiz = false;
                statusMessage = 'This exam has ended.';
                break;
                
            default:
                canTakeQuiz = false;
                statusMessage = 'Exam status unknown.';
        }

        // If student and quiz is active, check if they already took it
        if (req.session.userType === 'student' && canTakeQuiz) {
            const existingResult = await quizResultCollection.findOne({
                quizId: quizId,
                studentId: req.session.userId
            });

            if (existingResult) {
                canTakeQuiz = false;
                statusMessage = 'You have already completed this exam.';
            }
        }

        console.log('✅ Exam status checked:', {
            isExamMode: quiz.isExamMode,
            examStatus: quiz.examStatus,
            canTakeQuiz: canTakeQuiz,
            timeRemaining: timeRemaining
        });

        res.json({
            success: true,
            isExamMode: true,
            examStatus: quiz.examStatus,
            canTakeQuiz: canTakeQuiz,
            timeRemaining: timeRemaining,
            statusMessage: statusMessage,
            quizTitle: quiz.lectureTitle,
            classId: quiz.classId,
            examStartTime: quiz.examStartTime,
            examEndTime: quiz.examEndTime,
            examDurationMinutes: quiz.examDurationMinutes
        });

    } catch (error) {
        console.error('❌ Error checking exam status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check exam status: ' + error.message
        });
    }
});


app.post('/generate_quiz/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id

        
        // ✅ ENHANCED: Extract and validate parameters including exam mode
        const { durationMinutes, questionCount, isExamMode, examDurationMinutes } = req.body;
        

        console.log('🎯 QUIZ GENERATION REQUEST:', {
            lectureId: lectureId,
            requestBody: req.body,
            durationMinutes: durationMinutes,
            questionCount: questionCount,
            isExamMode: isExamMode,
            examDurationMinutes: examDurationMinutes,
            requestedBy: req.session.userName
        });

        // ✅ ENHANCED: Better parameter validation
        let customDuration = 15; // Default
        let questionsToGenerate = 10; // Default

        let examMode = false;
        let examWindowDuration = 60; // Default 60 minutes
        

        if (durationMinutes !== undefined && durationMinutes !== null) {
            const parsedDuration = parseInt(durationMinutes);
            if (!isNaN(parsedDuration) && parsedDuration >= 2 && parsedDuration <= 60) {
                customDuration = parsedDuration;
            }
        }

        if (questionCount !== undefined && questionCount !== null) {
            const parsedQuestions = parseInt(questionCount);
            if (!isNaN(parsedQuestions) && parsedQuestions >= 5 && parsedQuestions <= 30) {
                questionsToGenerate = parsedQuestions;
            }
        }

        // 🆕 NEW: Handle exam mode settings
        if (isExamMode === true || isExamMode === 'true') {
            examMode = true;
            if (examDurationMinutes !== undefined && examDurationMinutes !== null) {
                const parsedExamDuration = parseInt(examDurationMinutes);
                if (!isNaN(parsedExamDuration) && parsedExamDuration >= 30 && parsedExamDuration <= 480) {
                    examWindowDuration = parsedExamDuration;
                }
            }
        }

        console.log('✅ FINAL QUIZ SETTINGS:', {
            validDuration: customDuration,
            questionsToGenerate: questionsToGenerate,
            examMode: examMode,
            examWindowDuration: examWindowDuration
        });

        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Check ownership
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only generate quizzes for your own lectures.' });
        }

        // Check if quiz already exists
        const existingQuiz = await quizCollection.findOne({ lectureId: lectureId })
        if (existingQuiz) {
            return res.status(400).json({
                success: false,
                message: 'Quiz already generated for this lecture'
            })
        }

        // Update lecture status to processing
        await lectureCollection.findByIdAndUpdate(lectureId, {
            processingStatus: 'processing',
            lastProcessed: new Date()
        })

        console.log('🤖 ENHANCED AI Quiz Generation Started:', {
            lectureTitle: lecture.title,
            duration: customDuration,
            questions: questionsToGenerate,
            examMode: examMode,
            examDuration: examWindowDuration
        });

        const extractedText = lecture.extractedText

        if (!extractedText || extractedText.length < 50) {
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Text too short for quiz generation'
            })
            return res.status(400).json({
                success: false,
                message: 'Extracted text is too short or missing for quiz generation.'
            })
        }

        // ✅ ENHANCED: AI prompt with exam mode context
        const examModeText = examMode ? 
            `This quiz will be used as a timed exam with a ${examWindowDuration}-minute window. Generate challenging but fair questions appropriate for an exam setting.` :
            `This quiz will be used for regular practice and learning.`;

        const prompt = `
        You are an expert quiz generator and educational content creator. Create a comprehensive multiple-choice quiz with detailed explanations based on the following lecture content.

        **QUIZ CONTEXT:** ${examModeText}

        **CRITICAL REQUIREMENTS - MUST FOLLOW EXACTLY:**
        1. Generate EXACTLY ${questionsToGenerate} multiple-choice questions (NO MORE, NO LESS)
        2. Quiz duration is EXACTLY ${customDuration} minutes
        3. Each question must have exactly 4 options (A, B, C, D)
        4. Questions should test understanding, not just memorization
        5. Mix difficulty levels: 30% easy, 40% medium, 30% hard questions
        6. Ensure all questions are directly based on the lecture content
        7. Make wrong options plausible but clearly incorrect
        8. Provide detailed explanations for EACH wrong answer option
        9. Provide a comprehensive explanation for the correct answer
        10. Output must be valid JSON only, no extra text

        **LECTURE CONTENT:**
        ${extractedText.substring(0, 4000)}

        **REQUIRED JSON FORMAT - MUST INCLUDE EXPLANATIONS:**
        [
          {
            "question": "Clear, complete question text here?",
            "options": {
              "A": "First option",
              "B": "Second option", 
              "C": "Third option",
              "D": "Fourth option"
            },
            "correct_answer": "B",
            "correctAnswerExplanation": "Detailed explanation of why B is correct, referencing specific content from the lecture.",
            "explanations": {
              "A": "Explanation of why A is incorrect and what concept it might confuse with specific reference to lecture content",
              "B": "",
              "C": "Explanation of why C is incorrect and what the student might have misunderstood, with reference to lecture material",
              "D": "Explanation of why D is incorrect and how to avoid this mistake, connecting to lecture concepts"
            }
          }
        ]

        CRITICAL: Generate EXACTLY ${questionsToGenerate} questions for a ${customDuration}-minute quiz.`;

        try {
            const generationConfig = {
                temperature: 0.3,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
            }

            const safetySettings = [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
                },
            ]

            console.log('📤 Sending ENHANCED request to Gemini API...')

            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings,
            })

            const response = result.response
            let quizContent = response.text()

            console.log('✅ Received ENHANCED response from Gemini API')

            // Parse and validate the AI response
            let generatedQuiz = null
            try {
                quizContent = quizContent.trim()
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim()
                }

                generatedQuiz = JSON.parse(quizContent)

                // ✅ ENHANCED: Strict validation
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array')
                }

                // ✅ VALIDATE: Check if we got the right number of questions
                if (generatedQuiz.length !== questionsToGenerate) {
                    console.warn(`⚠️ AI generated ${generatedQuiz.length} questions, expected ${questionsToGenerate}`);
                    // Adjust the array to match requested count
                    if (generatedQuiz.length > questionsToGenerate) {
                        generatedQuiz = generatedQuiz.slice(0, questionsToGenerate);
                        console.log(`✂️ Trimmed to ${questionsToGenerate} questions`);
                    }
                }

                if (generatedQuiz.length === 0) {
                    throw new Error('No questions generated')
                }

                // Validate each question WITH explanations
                generatedQuiz.forEach((q, index) => {
                    if (!q.question || !q.options || !q.correct_answer || !q.explanations || !q.correctAnswerExplanation) {
                        throw new Error(`Question ${index + 1} is missing required fields (including explanations)`)
                    }
                    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                        throw new Error(`Question ${index + 1} has invalid correct_answer`)
                    }

                    // Validate explanations exist for wrong answers
                    ['A', 'B', 'C', 'D'].forEach(option => {
                        if (option !== q.correct_answer && (!q.explanations[option] || q.explanations[option].trim() === '')) {
                            console.warn(`⚠️ Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                            q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                        }
                    });

                    q.explanations[q.correct_answer] = "";
                })

                console.log('🎯 ENHANCED quiz validated:', {
                    totalQuestions: generatedQuiz.length,
                    requestedQuestions: questionsToGenerate,
                    hasExplanations: !!generatedQuiz[0].explanations,
                    hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation,
                    actualDuration: customDuration,
                    questionsGenerated: generatedQuiz.length,
                    isExamMode: examMode
                });

            } catch (parseError) {
                console.error('❌ Failed to parse ENHANCED quiz JSON:', parseError)

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced AI response parsing failed: ' + parseError.message
                })

                return res.status(500).json({
                    success: false,
                    message: 'Failed to parse enhanced AI response. Please try again.'
                })
            }

            // ✅ ENHANCED: Save quiz with exam mode settings
            const newQuiz = {
                lectureId: lectureId,
                lectureTitle: lecture.title,
                durationMinutes: customDuration,
                questions: generatedQuiz,
                totalQuestions: generatedQuiz.length,
                generatedDate: new Date(),
                createdBy: req.session.userId,
                classId: lecture.classId || null,
                className: lecture.className || null,
                isActive: true,
                // 🆕 NEW: Exam mode fields
                isExamMode: examMode,
                examDurationMinutes: examMode ? examWindowDuration : null,
                examStatus: examMode ? 'scheduled' : null
            }

            console.log('💾 SAVING QUIZ WITH EXAM MODE SETTINGS:', {
                durationMinutes: newQuiz.durationMinutes,
                totalQuestions: newQuiz.totalQuestions,
                questionsArrayLength: newQuiz.questions.length,
                isExamMode: newQuiz.isExamMode,
                examDurationMinutes: newQuiz.examDurationMinutes
            });

            try {
                const savedQuiz = await quizCollection.create(newQuiz)
                console.log('✅ ENHANCED quiz saved to database:', {
                    quizId: savedQuiz._id,
                    savedDuration: savedQuiz.durationMinutes,
                    savedQuestions: savedQuiz.totalQuestions,
                    title: lecture.title,
                    isExamMode: savedQuiz.isExamMode,
                    examDuration: savedQuiz.examDurationMinutes
                });

                // Update lecture status
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    quizGenerated: true,
                    processingStatus: 'completed',
                    quizzesCount: 1,
                    lastProcessed: new Date()
                })

                const quizTypeText = examMode ? 'Timed exam' : 'Quiz';
                console.log(`✅ ENHANCED ${quizTypeText} generation completed successfully for:`, lecture.title)

                // ✅ ENHANCED: Return comprehensive response with exam mode info
                res.json({
                    success: true,
                    message: `Enhanced ${quizTypeText} generated successfully with ${generatedQuiz.length} questions, ${customDuration} minutes duration${examMode ? `, and ${examWindowDuration}-minute exam window` : ''}, and detailed explanations!`,
                    quizId: savedQuiz._id,
                    totalQuestions: generatedQuiz.length,
                    durationMinutes: customDuration,
                    durationSeconds: customDuration * 60,
                    title: lecture.title,
                    className: lecture.className,
                    explanationsGenerated: true,
                    // 🆕 NEW: Exam mode response data
                    isExamMode: examMode,
                    examDurationMinutes: examMode ? examWindowDuration : null,
                    examStatus: examMode ? 'scheduled' : null,
                    // Debug info for verification
                    debug: {
                        requestedDuration: customDuration,
                        requestedQuestions: questionsToGenerate,
                        actualDuration: savedQuiz.durationMinutes,
                        actualQuestions: savedQuiz.totalQuestions,
                        examMode: examMode,
                        examDuration: examWindowDuration
                    }
                })

            } catch (saveError) {
                console.error('❌ Error saving ENHANCED quiz to MongoDB:', saveError)

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced database save error: ' + saveError.message
                })

                return res.status(500).json({
                    success: false,
                    message: 'Failed to save enhanced quiz to database: ' + saveError.message
                })
            }

        } catch (apiError) {
            console.error('❌ ENHANCED Gemini API Error:', apiError)

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Enhanced AI API Error: ' + apiError.message
            })

            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({
                    success: false,
                    message: 'API quota exceeded. Please try again later.'
                })
            }

            res.status(500).json({
                success: false,
                message: 'Failed to generate enhanced quiz. Please check your API key and try again.'
            })
        }

    } catch (error) {
        console.error('❌ ENHANCED quiz generation error:', error)

        if (req.params.id) {
            await lectureCollection.findByIdAndUpdate(req.params.id, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            })
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate enhanced quiz: ' + error.message
        })
    }
});



app.get('/api/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can access quiz questions.' });
        }

        const quizId = req.params.quizId;
        console.log('📡 QUIZ API - Loading quiz with duration:', quizId);

        // ✅ CRITICAL: Select durationMinutes explicitly
        const quiz = await quizCollection.findById(quizId).select('questions totalQuestions lectureTitle durationMinutes classId').lean();

        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // ✅ CRITICAL: Get actual duration from database
        const actualDurationMinutes = quiz.durationMinutes || 15;

        console.log('📡 QUIZ API - Retrieved quiz duration:', {
            quizId: quizId,
            databaseDuration: quiz.durationMinutes,
            actualDuration: actualDurationMinutes,
            lectureTitle: quiz.lectureTitle
        });

        // Only send question text and options to students (not correct answers)
        const questionsForClient = quiz.questions.map(q => ({
            question: q.question,
            options: q.options,
        }));

        const responseData = {
            success: true,
            quiz: {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                durationMinutes: actualDurationMinutes, // ✅ CRITICAL: Send actual duration
                durationSeconds: actualDurationMinutes * 60,
                classId: quiz.classId || null,
                questions: questionsForClient
            }
        };

        console.log('📡 QUIZ API - Sending response with duration:', {
            durationMinutes: responseData.quiz.durationMinutes,
            durationSeconds: responseData.quiz.durationSeconds,
            totalQuestions: responseData.quiz.totalQuestions
        });

        res.json(responseData);

    } catch (error) {
        console.error('❌ Error fetching quiz for student:', error);
        res.status(500).json({ success: false, message: 'Failed to load quiz questions.' });
    }
});
// 🆕 ENHANCED: API endpoint to get quiz duration (UPDATED VERSION)
app.get('/api/quiz/:quizId/duration', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🕒 DURATION API - Request for quiz:', quizId);

        // ✅ CRITICAL: Get duration from database
        const quiz = await quizCollection.findById(quizId).select('durationMinutes lectureTitle classId').lean();

        if (!quiz) {
            console.error('❌ DURATION API - Quiz not found:', quizId);
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // ✅ CRITICAL: Use actual database duration
        const actualDurationMinutes = quiz.durationMinutes || 15;
        const actualDurationSeconds = actualDurationMinutes * 60;

        console.log('🕒 DURATION API - Retrieved duration:', {
            quizId: quizId,
            databaseDuration: quiz.durationMinutes,
            actualDurationMinutes: actualDurationMinutes,
            actualDurationSeconds: actualDurationSeconds,
            lectureTitle: quiz.lectureTitle
        });

        const responseData = {
            success: true,
            durationMinutes: actualDurationMinutes,
            durationSeconds: actualDurationSeconds,
            lectureTitle: quiz.lectureTitle,
            classId: quiz.classId || null
        };

        console.log('🕒 DURATION API - Sending response:', responseData);

        res.json(responseData);

    } catch (error) {
        console.error('❌ Error fetching quiz duration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quiz duration: ' + error.message
        });
    }
});

// ==================== DELETE LECTURE ROUTE ====================

app.post('/delete_lecture/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own lectures.' });
        }

        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        // Delete associated quiz results
        await quizResultCollection.deleteMany({ lectureId: lectureId })

        // Delete lecture record
        await lectureCollection.findByIdAndDelete(lectureId)

        console.log('🗑️ Lecture, quizzes, and results deleted:', lecture.title)

        res.json({
            success: true,
            message: 'Lecture deleted successfully'
        })
    } catch (error) {
        console.error('❌ Error deleting lecture:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to delete lecture'
        })
    }
})

// ==================== STUDENT QUIZ ROUTES ====================

app.get('/api/student/available-quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;

        // Get all classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                quizzes: [],
                message: 'Not enrolled in any classes.'
            });
        }

        const enrolledClassIds = enrollments.map(e => e.classId);

        // Get all available quizzes from enrolled classes
        const availableQuizzes = await quizCollection.find({
            classId: { $in: enrolledClassIds },
            isActive: true
        })
            .select('lectureTitle totalQuestions classId generatedDate')
            .sort({ generatedDate: -1 })
            .lean();

        // Get quizzes already taken by student
        const takenQuizIds = await quizResultCollection.find({
            studentId: studentId
        }).distinct('quizId');

        // Filter out taken quizzes and add class information
        const quizzesWithClassInfo = await Promise.all(
            availableQuizzes
                .filter(quiz => !takenQuizIds.includes(quiz._id.toString()))
                .map(async (quiz) => {
                    const classInfo = await classCollection.findById(quiz.classId).select('name subject').lean();
                    return {
                        _id: quiz._id,
                        lectureTitle: quiz.lectureTitle,
                        totalQuestions: quiz.totalQuestions,
                        generatedDate: quiz.generatedDate,
                        classId: quiz.classId,
                        className: classInfo ? classInfo.name : 'Unknown Class',
                        classSubject: classInfo ? classInfo.subject : 'Unknown Subject'
                    };
                })
        );

        console.log(`🎯 Found ${quizzesWithClassInfo.length} available quizzes across all enrolled classes`);

        res.json({
            success: true,
            quizzes: quizzesWithClassInfo,
            totalQuizzes: quizzesWithClassInfo.length
        });

    } catch (error) {
        console.error('❌ Error fetching available quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load available quizzes: ' + error.message
        });
    }
});


app.get('/take_quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can take quizzes.');
        }

        const quizId = req.params.quizId;
        const classId = req.query.classId;

        console.log('🎯 Quiz access request:', {
            quizId: quizId,
            classId: classId,
            student: req.session.userName
        });

        // Get quiz details with exam mode information
        const quiz = await quizCollection.findById(quizId).select(
            'lectureTitle totalQuestions classId isExamMode examStatus examStartTime examEndTime examDurationMinutes durationMinutes'
        ).lean();

        if (!quiz) {
            return res.status(404).send('Quiz not found.');
        }

        // 🆕 NEW: Enhanced exam mode validation
        if (quiz.isExamMode) {
            console.log('🕐 Exam mode quiz access:', {
                examStatus: quiz.examStatus,
                examStartTime: quiz.examStartTime,
                examEndTime: quiz.examEndTime
            });

            const now = new Date();

            // Check exam status
            switch (quiz.examStatus) {
                case 'scheduled':
                    const message = 'This exam has not started yet. Please wait for your teacher to start the exam.';
                    const redirectUrl = classId ? 
                        `/student/class/${classId}?message=${encodeURIComponent(message)}` :
                        `/homeStudent?message=${encodeURIComponent(message)}`;
                    return res.status(403).redirect(redirectUrl);

                case 'ended':
                    const endedMessage = 'This exam has ended. You can no longer take this quiz.';
                    const endedRedirectUrl = classId ? 
                        `/student/class/${classId}?message=${encodeURIComponent(endedMessage)}` :
                        `/homeStudent?message=${encodeURIComponent(endedMessage)}`;
                    return res.status(403).redirect(endedRedirectUrl);

                case 'active':
                    // Check if exam time has expired
                    if (quiz.examEndTime && now > quiz.examEndTime) {
                        // Auto-end the exam
                        await quizCollection.findByIdAndUpdate(quizId, { examStatus: 'ended' });
                        const expiredMessage = 'The exam time has expired. You can no longer take this quiz.';
                        const expiredRedirectUrl = classId ? 
                            `/student/class/${classId}?message=${encodeURIComponent(expiredMessage)}` :
                            `/homeStudent?message=${encodeURIComponent(expiredMessage)}`;
                        return res.status(403).redirect(expiredRedirectUrl);
                    }
                    break;

                default:
                    const unknownMessage = 'This exam is not available for taking at this time.';
                    const unknownRedirectUrl = classId ? 
                        `/student/class/${classId}?message=${encodeURIComponent(unknownMessage)}` :
                        `/homeStudent?message=${encodeURIComponent(unknownMessage)}`;
                    return res.status(403).redirect(unknownRedirectUrl);
            }
        }

        // Rest of the existing validation logic...
        const targetClassId = classId || quiz.classId;
        let classInfo = null;

        if (targetClassId) {
            const enrollment = await classStudentCollection.findOne({
                studentId: req.session.userId,
                classId: targetClassId,
                isActive: true
            });

            if (!enrollment) {

                const errorMessage = 'You are not enrolled in this class.';
                const redirectUrl = `/homeStudent?message=${encodeURIComponent(errorMessage)}`;

                return res.status(403).redirect(redirectUrl);
            }

            classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
            console.log(`✅ Class enrollment verified for: ${classInfo?.name || 'Unknown Class'}`);
        }

        // Check if student has already taken this quiz
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: req.session.userId
        });

        if (existingResult) {

            const message = `You have already completed: ${quiz.lectureTitle}`;
            const redirectUrl = classId ? 
                `/student/class/${classId}?message=${encodeURIComponent(message)}` :
                `/quiz-results?alreadyTaken=true&quizTitle=${encodeURIComponent(quiz.lectureTitle)}`;

            return res.redirect(redirectUrl);
        }

        console.log(`🎯 Rendering take quiz page: ${quiz.lectureTitle} ${classInfo ? `(Class: ${classInfo.name})` : ''}`);

        // 🆕 ENHANCED: Pass comprehensive exam mode context to template
        res.render('takeQuiz', {
            quiz: {
                ...quiz,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,
                // 🆕 NEW: Exam mode data for template
                examTimeRemaining: quiz.isExamMode && quiz.examEndTime ? 
                    Math.max(0, Math.floor((new Date(quiz.examEndTime) - new Date()) / 1000)) : null
            },
            userName: req.session.userName,
            classContext: !!targetClassId,
            // 🆕 Enhanced navigation context with exam mode
            navigationContext: {
                hasClass: !!targetClassId,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,

                isExamMode: quiz.isExamMode,
                examStatus: quiz.examStatus,
                breadcrumbPath: targetClassId ? 

                    [
                        { label: 'Dashboard', url: '/homeStudent' },
                        { label: classInfo?.name || 'Class', url: `/student/class/${targetClassId}` },
                        { label: quiz.isExamMode ? 'Exam' : 'Quiz', url: null }
                    ] : [
                        { label: 'Dashboard', url: '/homeStudent' },
                        { label: quiz.isExamMode ? 'Exam' : 'Quiz', url: null }
                    ]
            }
        });

    } catch (error) {
        console.error('❌ Error rendering take quiz page:', error);
        res.status(500).send('Failed to load quiz page.');
    }
});

// 🔄 ENHANCED: Quiz questions API with duration info
app.get('/api/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can access quiz questions.' });
        }

        const quizId = req.params.quizId;
        console.log('📡 Loading quiz questions with duration info for:', quizId);

        const quiz = await quizCollection.findById(quizId).select('questions totalQuestions lectureTitle durationMinutes classId').lean();

        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // Only send question text and options to students (not correct answers or explanations)
        const questionsForClient = quiz.questions.map(q => ({
            question: q.question,
            options: q.options,
        }));

        // 🆕 ENHANCED: Include duration information in response
        const durationMinutes = quiz.durationMinutes || 15;

        console.log(`📡 Quiz loaded: "${quiz.lectureTitle}" - ${quiz.totalQuestions} questions, ${durationMinutes} minutes duration`);

        res.json({
            success: true,
            quiz: {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                durationMinutes: durationMinutes, // 🆕 NEW: Include duration
                durationSeconds: durationMinutes * 60, // 🆕 NEW: Include duration in seconds
                classId: quiz.classId || null,
                questions: questionsForClient
            }
        });

    } catch (error) {
        console.error('❌ Error fetching quiz for student:', error);
        res.status(500).json({ success: false, message: 'Failed to load quiz questions.' });
    }
});


// Enhanced quiz submission (class-aware)

app.post('/api/quiz/submit/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can submit quizzes.' });
        }

        const quizId = req.params.quizId;
        const {
            studentAnswers,
            timeTakenSeconds,
            classContext,

            antiCheatData,
            navigationHints,
            examTimeRemaining // 🆕 NEW: Time remaining in exam window

        } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('📝 Quiz submission:', {
            quizId: quizId,
            studentName: studentName,
            timeTaken: timeTakenSeconds,
            examTimeRemaining: examTimeRemaining,
            antiCheatViolations: antiCheatData?.violationCount || 0
        });

        // Get complete quiz data including exam mode information
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found for scoring.' });
        }

        // 🆕 NEW: Enhanced exam mode validation during submission
        if (quiz.isExamMode) {
            const now = new Date();
            
            // Check if exam is still active
            if (quiz.examStatus !== 'active') {
                return res.status(403).json({
                    success: false,
                    message: 'This exam is no longer active. Submission not allowed.'
                });
            }

            // Check if exam time has expired
            if (quiz.examEndTime && now > quiz.examEndTime) {
                // Auto-end the exam
                await quizCollection.findByIdAndUpdate(quizId, { examStatus: 'ended' });
                
                // Allow submission if it was submitted just as time expired (within 5 seconds grace period)
                const graceTimeMs = 5000; // 5 seconds
                if (now - quiz.examEndTime > graceTimeMs) {
                    return res.status(403).json({
                        success: false,
                        message: 'The exam time has expired. Submission not allowed.'
                    });
                }
                
                console.log('⏰ Allowing submission within grace period after exam expiry');
            }
        }

        // Rest of existing validation logic...
        const targetClassId = quiz.classId || (classContext && classContext.classId);

        if (targetClassId) {
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: targetClassId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).json({
                    success: false,
                    message: 'You are not enrolled in the class for this quiz.'
                });
            }
        }

        // Check for duplicate submission
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            return res.status(400).json({
                success: false,
                message: 'You have already submitted this quiz.'
            });
        }

        // Score the quiz (existing logic)
        let score = 0;
        const totalQuestions = quiz.totalQuestions;
        const detailedAnswers = [];
        const enhancedQuestionDetails = [];

        studentAnswers.forEach(sAnswer => {
            const correspondingQuestion = quiz.questions[sAnswer.questionIndex];
            if (correspondingQuestion) {
                const isCorrect = sAnswer.selectedOption === correspondingQuestion.correct_answer;
                if (isCorrect) {
                    score++;
                }

                detailedAnswers.push({
                    questionIndex: sAnswer.questionIndex,
                    question: sAnswer.question,
                    selectedOption: sAnswer.selectedOption,
                    correctOption: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });

                enhancedQuestionDetails.push({
                    questionIndex: sAnswer.questionIndex,
                    questionText: correspondingQuestion.question,
                    options: correspondingQuestion.options,
                    studentAnswer: sAnswer.selectedOption,
                    correctAnswer: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });
            }
        });

        const percentage = (totalQuestions > 0) ? (score / totalQuestions) * 100 : 0;

        // 🆕 NEW: Determine submission type for exam mode
        let submissionType = 'manual';
        if (quiz.isExamMode) {
            if (antiCheatData?.wasAutoSubmitted) {
                submissionType = 'auto_exam_timer';
            } else if (examTimeRemaining !== undefined && examTimeRemaining <= 0) {
                submissionType = 'auto_exam_timer';
            }
        } else {
            if (antiCheatData?.wasAutoSubmitted) {
                submissionType = 'auto_quiz_timer';
            }
        }

        // 🆕 ENHANCED: Save quiz result with exam mode metadata
        const newQuizResult = {
            quizId: quizId,
            lectureId: quiz.lectureId,
            classId: targetClassId || null,
            studentId: studentId,
            studentName: studentName,
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            submissionDate: new Date(),
            answers: detailedAnswers,
            // 🆕 NEW: Exam mode fields
            wasExamMode: quiz.isExamMode || false,
            examTimeRemaining: examTimeRemaining || null,
            submissionType: submissionType,
            // Enhanced anti-cheat metadata
            antiCheatMetadata: antiCheatData ? {
                violationCount: antiCheatData.violationCount || 0,
                wasAutoSubmitted: antiCheatData.wasAutoSubmitted || false,
                gracePeriodsUsed: antiCheatData.gracePeriodsUsed || 0,

                securityStatus: antiCheatData.violationCount === 0 ? 'Clean' : 
                              antiCheatData.violationCount === 1 ? 'Warning' : 'Violation',
                submissionSource: quiz.isExamMode && submissionType.includes('exam') ? 'Exam-Timer-Submit' : 
                                antiCheatData.wasAutoSubmitted ? 'Auto-Submit' : 'Manual'

            } : {
                violationCount: 0,
                wasAutoSubmitted: false,
                gracePeriodsUsed: 0,
                securityStatus: 'Clean',
                submissionSource: 'Manual'
            }
        };

        const savedResult = await quizResultCollection.create(newQuizResult);

        
        // Enhanced logging with exam mode context
        const modeText = quiz.isExamMode ? 'exam' : 'quiz';
        const securityStatus = antiCheatData && antiCheatData.violationCount > 0 
            ? `${antiCheatData.violationCount} violations` 
            : 'clean submission';
            
        console.log(`✅ ${modeText} result saved for student ${studentName}: Score ${score}/${totalQuestions} (${securityStatus})`);


        // Get class information for response
        let classInfo = null;
        if (targetClassId) {
            classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
        }

        // 🆕 ENHANCED: Prepare comprehensive response with exam mode context
        const enhancedResponse = {
            success: true,

            message: quiz.isExamMode ? 
                (antiCheatData && antiCheatData.wasAutoSubmitted 
                    ? 'Exam auto-submitted and scored successfully!'
                    : 'Exam submitted and scored successfully!') :
                (antiCheatData && antiCheatData.wasAutoSubmitted 
                    ? 'Quiz auto-submitted due to security violations and scored successfully!'
                    : 'Quiz submitted and scored successfully!'),

            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            quizResultId: savedResult._id,

            lectureId: quiz.lectureId,
            classId: targetClassId,
            className: classInfo?.name,
            classSubject: classInfo?.subject,
            quizTitle: quiz.lectureTitle,
            questionDetails: enhancedQuestionDetails,
            quizId: quizId,

            
            // 🆕 NEW: Exam mode response data
            wasExamMode: quiz.isExamMode,
            examTimeRemaining: examTimeRemaining,
            submissionType: submissionType,
            
            // Anti-cheating summary
            antiCheatSummary: {
                violationCount: antiCheatData?.violationCount || 0,
                wasAutoSubmitted: antiCheatData?.wasAutoSubmitted || false,
                securityStatus: antiCheatData?.violationCount === 0 ? 'Clean' : 
                              antiCheatData?.violationCount === 1 ? 'Warning Issued' : 'Auto-Submitted',
                submissionType: submissionType === 'auto_exam_timer' ? 'Exam Timer Auto-Submit' :
                              submissionType === 'auto_quiz_timer' ? 'Quiz Timer Auto-Submit' : 'Manual Submit'
            },
            
            // Navigation context

            navigationContext: {
                hasClass: !!targetClassId,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,
                returnToClass: !!targetClassId,
                dashboardUrl: '/homeStudent',
                classUrl: targetClassId ? `/student/class/${targetClassId}` : null
            },

            
            // Suggested redirect

            suggestedRedirect: {
                url: '/quiz-results',
                context: 'results_page',
                backUrl: targetClassId ? `/student/class/${targetClassId}` : '/homeStudent',
                backLabel: targetClassId ? `Back to ${classInfo?.name || 'Class'}` : 'Back to Dashboard'
            }
        };

        res.json(enhancedResponse);

    } catch (error) {
        console.error('❌ Error submitting quiz:', error);
        res.status(500).json({ success: false, message: 'Failed to submit quiz: ' + error.message });
    }
});


// 🆕 NEW: Enhanced quiz results page route with better class context handling
app.get('/quiz-results', isAuthenticated, (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can view quiz results.');
        }

        // 🆕 Enhanced: Handle query parameters for better context
        const queryContext = {
            alreadyTaken: req.query.alreadyTaken === 'true',
            quizTitle: req.query.quizTitle || null,
            error: req.query.error || null,
            message: req.query.message || null,
            classId: req.query.classId || null,
            className: req.query.className || null,
            returnTo: req.query.returnTo || null
        };

        console.log('📊 Quiz results page accessed with enhanced context:', {
            student: req.session.userName,
            queryContext: queryContext
        });

        // 🎯 ENHANCED: Pass enhanced context for better navigation
        res.render('quizResults', {
            userName: req.session.userName || 'Student',
            userType: req.session.userType || 'student',
            queryContext: queryContext, // Enhanced query parameters
            // Enhanced navigation hints
            navigationHints: {
                hasClassContext: !!queryContext.classId,
                classId: queryContext.classId,
                className: queryContext.className,
                dashboardUrl: '/homeStudent',
                classUrl: queryContext.classId ? `/student/class/${queryContext.classId}` : null
            }
        });

    } catch (error) {
        console.error('❌ Error rendering quiz results page:', error);
        res.status(500).send('Failed to load quiz results page.');
    }
});


// 🆕 NEW: Enhanced quiz results API with anti-cheat info
app.get('/api/quiz-result/:resultId/detailed', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const resultId = req.params.resultId;
        const studentId = req.session.userId;

        console.log('📊 Loading detailed quiz result with anti-cheat info:', {
            resultId: resultId,
            studentId: studentId,
            requestedBy: req.session.userName
        });

        // Get the quiz result
        const quizResult = await quizResultCollection.findById(resultId).lean();

        if (!quizResult) {
            return res.status(404).json({
                success: false,
                message: 'Quiz result not found.'
            });
        }

        // Verify ownership
        if (quizResult.studentId.toString() !== studentId.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own quiz results.'
            });
        }

        // Get the complete quiz data with questions and explanations
        const quiz = await quizCollection.findById(quizResult.quizId).lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Get class information if available
        let classInfo = null;
        if (quizResult.classId) {
            classInfo = await classCollection.findById(quizResult.classId).select('name subject teacherId').lean();
            if (classInfo) {
                const teacher = await teacherCollection.findById(classInfo.teacherId).select('name').lean();
                classInfo.teacherName = teacher ? teacher.name : 'Unknown Teacher';
            }
        }

        // Prepare detailed question results with explanations availability
        const detailedQuestions = quiz.questions.map((question, index) => {
            const studentAnswer = quizResult.answers[index];
            const hasDetailedExplanations = !!(question.explanations &&
                Object.keys(question.explanations).some(key =>
                    key !== question.correct_answer &&
                    question.explanations[key] &&
                    question.explanations[key].trim() !== ''
                ));

            return {
                questionIndex: index,
                questionText: question.question,
                options: question.options,
                correctAnswer: question.correct_answer,
                correctOption: question.options[question.correct_answer],
                studentAnswer: studentAnswer ? studentAnswer.selectedOption : null,
                studentOption: studentAnswer ? question.options[studentAnswer.selectedOption] : null,
                isCorrect: studentAnswer ? studentAnswer.isCorrect : false,
                hasExplanations: hasDetailedExplanations,
                hasCorrectExplanation: !!(question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '')
            };
        });

        // Calculate additional statistics with duration info
        const correctAnswers = detailedQuestions.filter(q => q.isCorrect).length;
        const incorrectAnswers = detailedQuestions.length - correctAnswers;
        const accuracyRate = ((correctAnswers / detailedQuestions.length) * 100).toFixed(1);
        const averageTimePerQuestion = (quizResult.timeTakenSeconds / detailedQuestions.length).toFixed(1);

        // 🆕 ENHANCED: Get actual quiz duration (with fallback)
        const quizDurationMinutes = quiz.durationMinutes || quizResult.quizDurationMinutes || 15;
        const quizDurationSeconds = quizDurationMinutes * 60;
        const timeEfficiency = quizResult.timeEfficiency || Math.max(0, 100 - ((quizResult.timeTakenSeconds / quizDurationSeconds) * 100));

        // Get class average for comparison
        let classAverage = null;
        if (quizResult.classId) {
            const classResults = await quizResultCollection.find({
                classId: quizResult.classId
            }).lean();

            if (classResults.length > 1) {
                const otherResults = classResults.filter(r => r.studentId.toString() !== studentId.toString());
                if (otherResults.length > 0) {
                    classAverage = (otherResults.reduce((sum, r) => sum + r.percentage, 0) / otherResults.length).toFixed(1);
                }
            }
        }

        console.log(`✅ Detailed quiz result loaded: ${quiz.lectureTitle} - ${quizResult.percentage}% (${quizDurationMinutes}min quiz)`);

        // 🆕 NEW: Include anti-cheat summary in detailed results
        const antiCheatSummary = quizResult.antiCheatMetadata || {
            violationCount: 0,
            wasAutoSubmitted: false,
            securityStatus: 'Clean',
            submissionType: 'Manual Submit'
        };

        res.json({
            success: true,
            data: {
                quizResult: {
                    resultId: quizResult._id,
                    quizId: quizResult.quizId,
                    lectureTitle: quiz.lectureTitle,
                    score: quizResult.score,
                    totalQuestions: quizResult.totalQuestions,
                    percentage: quizResult.percentage,
                    timeTakenSeconds: quizResult.timeTakenSeconds,
                    submissionDate: quizResult.submissionDate,
                    studentName: quizResult.studentName,
                    // 🆕 ENHANCED: Duration information
                    quizDurationMinutes: quizDurationMinutes,
                    quizDurationSeconds: quizDurationSeconds,
                    timeEfficiency: timeEfficiency
                },
                quizStats: {
                    correctAnswers: correctAnswers,
                    incorrectAnswers: incorrectAnswers,
                    accuracyRate: parseFloat(accuracyRate),
                    averageTimePerQuestion: parseFloat(averageTimePerQuestion),
                    classAverage: classAverage ? parseFloat(classAverage) : null,
                    performanceVsClass: classAverage ?
                        (quizResult.percentage > parseFloat(classAverage) ? 'above' :
                            quizResult.percentage < parseFloat(classAverage) ? 'below' : 'equal') : null,
                    // 🆕 ENHANCED: Duration-based stats
                    timeEfficiencyPercentage: parseFloat(timeEfficiency.toFixed(1)),
                    averageTimeVsAllocated: `${Math.round((quizResult.timeTakenSeconds / quizDurationSeconds) * 100)}%`
                },
                detailedQuestions: detailedQuestions,
                classInfo: classInfo,
                explanationsAvailable: detailedQuestions.some(q => q.hasExplanations),
                // 🆕 NEW: Anti-cheat summary for detailed results
                antiCheatSummary: antiCheatSummary
            }
        });

    } catch (error) {
        console.error('❌ Error loading detailed quiz result:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load detailed quiz result: ' + error.message
        });
    }
});

// 🆕 NEW: Get top 3 rankings for a specific quiz
app.get('/api/quiz/:quizId/rankings', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const quizId = req.params.quizId;
        const studentId = req.session.userId;

        console.log('🏆 Loading quiz rankings:', {
            quizId: quizId,
            requestedBy: req.session.userName
        });

        // Get quiz info
        const quiz = await quizCollection.findById(quizId).select('lectureTitle classId').lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Get all results for this quiz
        const allResults = await quizResultCollection.find({
            quizId: quizId
        })
            .select('studentId studentName score percentage timeTakenSeconds submissionDate')
            .lean();

        if (allResults.length === 0) {
            return res.json({
                success: true,
                data: {
                    topRankers: [],
                    currentStudentRank: null,
                    totalParticipants: 0,
                    quizTitle: quiz.lectureTitle
                }
            });
        }

        // Sort by percentage (desc), then by time taken (asc) for ties
        const sortedResults = allResults.sort((a, b) => {
            if (b.percentage !== a.percentage) {
                return b.percentage - a.percentage;
            }
            return a.timeTakenSeconds - b.timeTakenSeconds;
        });

        // Get top 3 rankers
        const topRankers = sortedResults.slice(0, 3).map((result, index) => ({
            rank: index + 1,
            studentName: result.studentName,
            score: result.score,
            percentage: result.percentage.toFixed(1),
            timeTaken: formatTime(result.timeTakenSeconds),
            submissionDate: result.submissionDate.toLocaleDateString(),
            isCurrentStudent: result.studentId.toString() === studentId.toString()
        }));

        // Find current student's rank
        const currentStudentIndex = sortedResults.findIndex(r => r.studentId.toString() === studentId.toString());
        const currentStudentRank = currentStudentIndex >= 0 ? currentStudentIndex + 1 : null;

        console.log(`🏆 Rankings loaded for quiz: ${quiz.lectureTitle} - Top 3 of ${allResults.length} participants`);

        res.json({
            success: true,
            data: {
                topRankers: topRankers,
                currentStudentRank: currentStudentRank,
                totalParticipants: allResults.length,
                quizTitle: quiz.lectureTitle,
                isInTop3: currentStudentRank && currentStudentRank <= 3
            }
        });

    } catch (error) {
        console.error('❌ Error loading quiz rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load quiz rankings: ' + error.message
        });
    }
});

// 🆕 NEW: Get simple quiz statistics
app.get('/api/quiz-result/:resultId/stats', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const resultId = req.params.resultId;
        const studentId = req.session.userId;

        // Get the quiz result
        const quizResult = await quizResultCollection.findById(resultId).lean();

        if (!quizResult) {
            return res.status(404).json({
                success: false,
                message: 'Quiz result not found.'
            });
        }

        // Verify ownership
        if (quizResult.studentId.toString() !== studentId.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own quiz statistics.'
            });
        }

        // Get quiz info
        const quiz = await quizCollection.findById(quizResult.quizId).select('lectureTitle totalQuestions classId').lean();

        // Get all results for this quiz for comparison
        const allQuizResults = await quizResultCollection.find({
            quizId: quizResult.quizId
        }).lean();

        // Calculate quiz statistics
        const quizStats = {
            // Basic quiz info
            quizTitle: quiz.lectureTitle,
            totalQuestions: quiz.totalQuestions,

            // Student performance
            studentScore: quizResult.score,
            studentPercentage: quizResult.percentage,
            timeTaken: formatTime(quizResult.timeTakenSeconds),
            averageTimePerQuestion: (quizResult.timeTakenSeconds / quiz.totalQuestions).toFixed(1),

            // Comparison statistics
            totalParticipants: allQuizResults.length,
            averageScore: allQuizResults.length > 0 ?
                (allQuizResults.reduce((sum, r) => sum + r.percentage, 0) / allQuizResults.length).toFixed(1) : 0,

            // Rankings
            betterThan: allQuizResults.filter(r => r.percentage < quizResult.percentage).length,
            rankPosition: allQuizResults
                .sort((a, b) => b.percentage - a.percentage || a.timeTakenSeconds - b.timeTakenSeconds)
                .findIndex(r => r._id.toString() === resultId.toString()) + 1
        };

        console.log(`📊 Quiz statistics loaded for: ${quiz.lectureTitle}`);

        res.json({
            success: true,
            data: quizStats
        });

    } catch (error) {
        console.error('❌ Error loading quiz statistics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load quiz statistics: ' + error.message
        });
    }
});

// 🆕 NEW: Detailed quiz results page route
app.get('/quiz-result/:resultId/detailed', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Students only.');
        }

        const resultId = req.params.resultId;
        const classId = req.query.classId; // Optional class context
        const studentId = req.session.userId;

        console.log('📊 Rendering detailed quiz results page:', {
            resultId: resultId,
            classId: classId,
            student: req.session.userName
        });

        // Basic verification - get quiz result to check ownership
        const quizResult = await quizResultCollection.findById(resultId).select('studentId quizId classId').lean();

        if (!quizResult) {
            return res.status(404).redirect('/homeStudent?message=Quiz result not found.');
        }

        // Verify ownership
        if (quizResult.studentId.toString() !== studentId.toString()) {
            return res.status(403).redirect('/homeStudent?message=Access denied. You can only view your own quiz results.');
        }

        // Get quiz info for breadcrumbs
        const quiz = await quizCollection.findById(quizResult.quizId).select('lectureTitle').lean();

        // Get class info if available
        let classInfo = null;
        const targetClassId = classId || quizResult.classId;

        if (targetClassId) {
            classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
        }

        console.log(`📊 Rendering detailed results for: ${quiz ? quiz.lectureTitle : 'Unknown Quiz'}`);

        // Render detailed results template
        res.render('detailedQuizResults', {
            resultId: resultId,
            quizTitle: quiz ? quiz.lectureTitle : 'Quiz Results',
            userName: req.session.userName,
            userType: req.session.userType,
            // Navigation context
            classContext: {
                hasClass: !!targetClassId,
                classId: targetClassId,
                className: classInfo ? classInfo.name : null,
                classSubject: classInfo ? classInfo.subject : null
            },
            // Breadcrumb data
            breadcrumbData: targetClassId && classInfo ? [
                { label: 'Dashboard', url: '/homeStudent' },
                { label: classInfo.name, url: `/student/class/${targetClassId}` },
                { label: 'Quiz Results', url: null }
            ] : [
                { label: 'Dashboard', url: '/homeStudent' },
                { label: 'Quiz Results', url: null }
            ]
        });

    } catch (error) {
        console.error('❌ Error rendering detailed quiz results page:', error);
        res.status(500).redirect('/homeStudent?message=Failed to load detailed quiz results.');
    }
});

// 🆕 NEW: Quick navigation endpoint for class context
app.get('/api/student/navigation-context', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;

        // Get student's enrolled classes for navigation
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        // Get class details
        const classIds = enrollments.map(e => e.classId);
        const classes = await classCollection.find({
            _id: { $in: classIds },
            isActive: true
        }).select('name subject').lean();

        const navigationClasses = classes.map(cls => ({
            classId: cls._id,
            className: cls.name,
            classSubject: cls.subject,
            url: `/student/class/${cls._id}`
        }));

        res.json({
            success: true,
            data: {
                enrolledClasses: navigationClasses,
                totalClasses: navigationClasses.length,
                dashboardUrl: '/homeStudent',
                studentName: req.session.userName
            }
        });

    } catch (error) {
        console.error('❌ Error getting navigation context:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get navigation context: ' + error.message
        });
    }
});

//  Get most recent quiz for a specific class
app.get('/api/student/class/:classId/recent-quiz', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student is enrolled in this class
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get the most recent quiz for this class
        const recentQuiz = await quizCollection.findOne({
            classId: classId,
            isActive: true
        })
            .select('lectureTitle totalQuestions generatedDate')
            .sort({ generatedDate: -1 }) // Most recent first
            .lean();

        if (!recentQuiz) {
            return res.json({
                success: true,
                quiz: null,
                message: 'No quizzes available for this class.'
            });
        }

        // Check if student has already taken this quiz
        const studentResult = await quizResultCollection.findOne({
            studentId: studentId,
            quizId: recentQuiz._id
        });

        // Calculate time ago
        const timeAgo = getTimeAgo(recentQuiz.generatedDate);

        console.log(`🎯 Found recent quiz for class ${classId}: ${recentQuiz.lectureTitle}`);

        res.json({
            success: true,
            quiz: {
                _id: recentQuiz._id,
                lectureTitle: recentQuiz.lectureTitle,
                totalQuestions: recentQuiz.totalQuestions,
                generatedDate: recentQuiz.generatedDate,
                timeAgo: timeAgo,
                status: studentResult ? 'taken' : 'available',
                score: studentResult ? studentResult.percentage : null,
                // 🆕 NEW: Include resultId for "View Results" functionality
                resultId: studentResult ? studentResult._id : null
            }
        });

    } catch (error) {
        console.error('❌ Error fetching recent quiz:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recent quiz: ' + error.message
        });
    }
});


//  Student class-specific page route (Step 3 - Full Implementation)
app.get('/student/class/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Students only.');
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        console.log(`🏫 Student class view access:`, {
            studentId: studentId,
            classId: classId,
            studentName: req.session.userName
        });

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).redirect('/homeStudent?message=You are not enrolled in this class.');
        }

        // Get class information
        const classInfo = await classCollection.findById(classId).lean();
        if (!classInfo) {
            return res.status(404).redirect('/homeStudent?message=Class not found.');
        }

        // Get teacher information
        const teacher = await teacherCollection.findById(classInfo.teacherId).select('name').lean();

        console.log(`✅ Rendering class view for: ${classInfo.subject} - ${classInfo.name}`);

        // Render the new class-specific template
        res.render('studentClassView', {
            classId: classId,
            className: classInfo.name,
            classSubject: classInfo.subject,
            classDescription: classInfo.description,
            teacherName: teacher ? teacher.name : 'Unknown Teacher',
            userName: req.session.userName,
            userId: req.session.userId, // For identifying current student in rankings
            userType: 'student',
            enrolledDate: enrollment.enrolledAt
        });

    } catch (error) {
        console.error('❌ Error accessing student class view:', error);
        res.status(500).redirect('/homeStudent?message=Failed to access class information.');
    }
});

// 🔄 UPDATED: Enhanced quiz loading with exam session status
app.get('/api/teacher/class/:classId/quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get quizzes with exam session info
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })

        .select('lectureTitle totalQuestions durationMinutes generatedDate isActive lectureId examSessionActive examSessionStartTime examSessionEndTime examSessionDuration')
        .sort({ generatedDate: -1 })
        .lean();

        // Enhance quiz data with performance stats and exam session info

        const enhancedQuizzes = await Promise.all(
            quizzes.map(async (quiz) => {
                const quizResults = await quizResultCollection.find({
                    quizId: quiz._id
                }).lean();

                // Check if exam session is expired and deactivate if needed
                let hasActiveExamSession = quiz.examSessionActive;
                let examEndTime = quiz.examSessionEndTime;
                
                if (hasActiveExamSession && examEndTime && new Date() > new Date(examEndTime)) {
                    await quizCollection.findByIdAndUpdate(quiz._id, {
                        examSessionActive: false
                    });
                    hasActiveExamSession = false;
                }

                return {
                    _id: quiz._id,
                    lectureId: quiz.lectureId,
                    lectureTitle: quiz.lectureTitle,
                    totalQuestions: quiz.totalQuestions,
                    durationMinutes: quiz.durationMinutes || 15,
                    generatedDate: quiz.generatedDate,
                    isActive: quiz.isActive,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0
                        ? (quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length).toFixed(1)
                        : 0,
                    highestScore: quizResults.length > 0
                        ? Math.max(...quizResults.map(r => r.percentage)).toFixed(1)
                        : 0,
                    // Exam session data
                    hasActiveExamSession: hasActiveExamSession,
                    examStartTime: quiz.examSessionStartTime,
                    examEndTime: quiz.examSessionEndTime,
                    examDuration: quiz.examSessionDuration
                };
            })
        );



        res.json({
            success: true,
            quizzes: enhancedQuizzes,
            totalQuizzes: enhancedQuizzes.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error fetching class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quizzes: ' + error.message
        });
    }
});

// 🆕 NEW: Helper function for formatting exam time
function formatExamTime(seconds) {
    if (seconds <= 0) return '00:00:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}


// enrolled classes API with new stats
app.get('/api/student/enrolled-classes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;

        // Get classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                classes: [],
                message: 'No enrolled classes found.'
            });
        }

        // Get class details and student's performance in each class
        const enrolledClasses = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get class details
                const classDetails = await classCollection.findById(enrollment.classId).lean();

                if (!classDetails) {
                    return null; // Skip if class doesn't exist
                }

                // Get teacher name
                const teacher = await teacherCollection.findById(classDetails.teacherId).select('name').lean();

                // Get available quizzes for this class
                const availableQuizzes = await quizCollection.countDocuments({
                    classId: enrollment.classId,
                    isActive: true
                });

                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: studentId,
                    classId: enrollment.classId
                }).lean();

                // Calculate student's stats for this class
                const quizzesTaken = studentResults.length;
                const averageScore = quizzesTaken > 0
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / quizzesTaken).toFixed(1)
                    : 0;

                return {
                    classId: classDetails._id,
                    className: classDetails.name,
                    classSubject: classDetails.subject,
                    classDescription: classDetails.description,
                    teacherName: teacher ? teacher.name : 'Unknown Teacher',
                    enrolledAt: enrollment.enrolledAt,
                    // Student's performance in this class
                    quizzesTaken: quizzesTaken,
                    averageScore: parseFloat(averageScore),
                    availableQuizzes: availableQuizzes,
                    // 🆕 NEW: Additional stats for dashboard
                    totalQuizScore: quizzesTaken > 0 ? studentResults.reduce((sum, result) => sum + result.percentage, 0) : 0,
                    hasRecentActivity: availableQuizzes > 0 || quizzesTaken > 0
                };
            })
        );

        // Filter out null values (deleted classes)
        const validClasses = enrolledClasses.filter(cls => cls !== null);

        console.log(`🏫 Found ${validClasses.length} enrolled classes for student ${req.session.userName}`);

        res.json({
            success: true,
            classes: validClasses,
            totalClasses: validClasses.length,
            // 🆕 NEW: Overall student stats across all classes
            overallStats: {
                totalClasses: validClasses.length,
                totalQuizAttempts: validClasses.reduce((sum, cls) => sum + cls.quizzesTaken, 0),
                overallAverage: validClasses.length > 0 ?
                    (validClasses.reduce((sum, cls) => sum + cls.totalQuizScore, 0) /
                        validClasses.reduce((sum, cls) => sum + cls.quizzesTaken, 0)).toFixed(1) : 0,
                activeClasses: validClasses.filter(cls => cls.hasRecentActivity).length
            }
        });

    } catch (error) {
        console.error('❌ Error fetching enrolled classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled classes: ' + error.message
        });
    }
});

// 🆕 UPDATED: Teacher-specific class rankings with participation weighting
app.get('/api/teacher/class/:classId/rankings', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get all students enrolled in this class
        const classStudents = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        if (classStudents.length === 0) {
            return res.json({
                success: true,
                data: {
                    rankings: [],
                    totalStudents: 0,
                    rankingSystem: {
                        formula: 'Final Points = Base Points × (0.3 + 0.7 × Participation Rate)',
                        description: 'Rankings reward both performance and participation. Base Points = (Score × 0.7) + (Time Efficiency × 0.3)'
                    }
                }
            });
        }

        // Get quiz information for participation calculation
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        const totalQuizzesAvailable = classQuizzes.length;

        // Calculate rankings with NEW PARTICIPATION-WEIGHTED FORMULA
        const studentRankings = await Promise.all(
            classStudents.map(async (student) => {
                const studentResults = await quizResultCollection.find({
                    studentId: student.studentId,
                    classId: classId
                }).lean();

                if (studentResults.length === 0) {
                    return {
                        studentId: student.studentId,
                        studentName: student.studentName,
                        totalQuizzes: 0,
                        averageScore: 0,
                        averageTimeEfficiency: 0,
                        participationRate: 0,
                        basePoints: 0,
                        finalPoints: 0,
                        averageTime: '0:00',
                        rank: 999
                    };
                }

                // Calculate average score
                const averageScore = studentResults.reduce((sum, r) => sum + r.percentage, 0) / studentResults.length;

                // Calculate time efficiency for each result
                const timeEfficiencies = studentResults.map(result => {
                    const quiz = classQuizzes.find(q => q._id.toString() === result.quizId.toString());
                    const quizDurationSeconds = quiz ? (quiz.durationMinutes || 15) * 60 : 900;
                    return calculateTimeEfficiency(result.timeTakenSeconds, quizDurationSeconds);
                });

                const averageTimeEfficiency = timeEfficiencies.length > 0
                    ? timeEfficiencies.reduce((sum, eff) => sum + eff, 0) / timeEfficiencies.length
                    : 0;

                // 🆕 NEW: Calculate participation rate
                const participationRate = totalQuizzesAvailable > 0
                    ? (studentResults.length / totalQuizzesAvailable) * 100
                    : 0;

                // 🆕 NEW: Calculate base points and participation-weighted final points
                const basePoints = calculateRankingPoints(averageScore, averageTimeEfficiency);
                const finalPoints = calculateParticipationWeightedPoints(averageScore, averageTimeEfficiency, participationRate);

                const averageTime = studentResults.reduce((sum, r) => sum + r.timeTakenSeconds, 0) / studentResults.length;

                return {
                    studentId: student.studentId,
                    studentName: student.studentName,
                    totalQuizzes: studentResults.length,
                    averageScore: formatPercentage(averageScore),
                    averageTimeEfficiency: formatPercentage(averageTimeEfficiency),
                    participationRate: formatPercentage(participationRate),
                    basePoints: basePoints, // 🆕 NEW: Show base points
                    finalPoints: finalPoints, // 🆕 NEW: Final weighted points
                    averageTime: formatTime(averageTime),
                    rank: 0 // Will be calculated after sorting
                };
            })
        );

        // 🆕 NEW: Sort by final points (participation-weighted)
        const rankedStudents = studentRankings
            .filter(student => student.totalQuizzes > 0)
            .sort((a, b) => b.finalPoints - a.finalPoints) // Sort by final points
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        console.log(`🏆 Participation-weighted rankings generated: ${rankedStudents.length} students`);

        res.json({
            success: true,
            data: {
                rankings: rankedStudents,
                totalStudents: rankedStudents.length,
                totalQuizzesAvailable: totalQuizzesAvailable,
                rankingSystem: {
                    formula: 'Final Points = Base Points × (0.3 + 0.7 × Participation Rate)',
                    baseFormula: 'Base Points = (Score × 0.7) + (Time Efficiency × 0.3)',
                    description: 'Rankings reward both performance and participation. Students with higher participation get bonus multiplier.',
                    participationWeight: '70% of final scoring depends on participation rate'
                }
            }
        });

    } catch (error) {
        console.error('❌ Error generating participation-weighted rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate rankings: ' + error.message
        });
    }
});

// 📊 Get class overview for student class view
app.get('/api/student/class/:classId/overview', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get class information
        const classInfo = await classCollection.findById(classId).lean();
        if (!classInfo) {
            return res.status(404).json({
                success: false,
                message: 'Class not found.'
            });
        }

        // Get teacher information
        const teacher = await teacherCollection.findById(classInfo.teacherId).select('name').lean();

        // Get total students in class
        const totalStudents = await classStudentCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        // Calculate student's progress in this class
        const availableQuizzes = await quizCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        const completedQuizzes = await quizResultCollection.countDocuments({
            studentId: studentId,
            classId: classId
        });

        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).lean();

        const averageScore = studentResults.length > 0
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / studentResults.length).toFixed(1)
            : 0;

        const completionRate = availableQuizzes > 0
            ? ((completedQuizzes / availableQuizzes) * 100).toFixed(1)
            : 0;

        console.log(`📊 Class overview generated for student ${req.session.userName} in ${classInfo.name}`);

        res.json({
            success: true,
            data: {
                classInfo: {
                    name: classInfo.name,
                    subject: classInfo.subject,
                    description: classInfo.description,
                    teacherName: teacher ? teacher.name : 'Unknown Teacher',
                    totalStudents: totalStudents
                },
                studentProgress: {
                    enrolledDate: enrollment.enrolledAt,
                    completedQuizzes: completedQuizzes,
                    totalQuizzes: availableQuizzes,
                    availableQuizzes: availableQuizzes - completedQuizzes,
                    averageScore: parseFloat(averageScore),
                    completionRate: parseFloat(completionRate)
                }
            }
        });

    } catch (error) {
        console.error('❌ Error generating class overview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate class overview: ' + error.message
        });
    }
});

// 🎯 Get all quizzes for a class (available + completed) for student
app.get('/api/student/class/:classId/all-quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get all quizzes for this class
        const allQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })
            .sort({ generatedDate: -1 })
            .lean();

        // Get student's results for this class
        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).lean();

        // Create a map of quiz results
        const resultMap = {};
        studentResults.forEach(result => {
            resultMap[result.quizId.toString()] = result;
        });

        // Categorize quizzes
        const availableQuizzes = [];
        const completedQuizzes = [];

        allQuizzes.forEach(quiz => {
            const timeAgo = getTimeAgo(quiz.generatedDate);
            const quizData = {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                generatedDate: quiz.generatedDate,
                timeAgo: timeAgo
            };

            if (resultMap[quiz._id.toString()]) {
                // Quiz completed
                const result = resultMap[quiz._id.toString()];
                completedQuizzes.push({
                    ...quizData,
                    status: 'completed',
                    studentResult: {
                        resultId: result._id, // 🆕 NEW: Include resultId
                        score: result.score,
                        percentage: result.percentage.toFixed(1),
                        timeTaken: formatTime(result.timeTakenSeconds),
                        submissionDate: result.submissionDate
                    }
                });
            } else {
                // Quiz available
                availableQuizzes.push({
                    ...quizData,
                    status: 'available'
                });
            }
        });

        console.log(`🎯 All quizzes loaded for class ${classId}: ${availableQuizzes.length} available, ${completedQuizzes.length} completed`);

        res.json({
            success: true,
            data: {
                allQuizzes: [...availableQuizzes, ...completedQuizzes],
                availableQuizzes: availableQuizzes,
                completedQuizzes: completedQuizzes,
                totalAvailable: availableQuizzes.length,
                totalCompleted: completedQuizzes.length
            }
        });

    } catch (error) {
        console.error('❌ Error loading all quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load quizzes: ' + error.message
        });
    }
});

// 🆕 NEW: API endpoint for teachers to view full quiz content
app.get('/api/teacher/quiz/:quizId/full', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        // Get quiz with full details including explanations
        const quiz = await quizCollection.findById(quizId).lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify teacher owns this quiz
        if (!quiz.createdBy.equals(teacherId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only view your own quizzes.'
            });
        }

        console.log(`👁️ Teacher viewing quiz: ${quiz.lectureTitle}`);

        res.json({
            success: true,
            quiz: {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                durationMinutes: quiz.durationMinutes || 15,
                questions: quiz.questions, // Full questions with correct answers and explanations
                generatedDate: quiz.generatedDate
            }
        });

    } catch (error) {
        console.error('❌ Error fetching full quiz:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quiz: ' + error.message
        });
    }
});

// 📈 Get detailed class analytics for student class view
app.get('/api/student/class/:classId/analytics', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }


        const studentId = req.session.userId;
        const classId = req.params.classId;

        console.log('📊 Loading student class analytics:', {
            studentId: studentId,
            classId: classId,
            student: req.session.userName
        });

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get student's results for this class
        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        })
        .sort({ submissionDate: -1 })
        .lean();

        // Get all class results for comparison
        const allClassResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Get class quizzes for quiz titles
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // Create quiz map for titles
        const quizMap = {};
        classQuizzes.forEach(quiz => {
            quizMap[quiz._id.toString()] = quiz.lectureTitle;
        });

        // Calculate averages
        const studentAverage = studentResults.length > 0 

            ? parseFloat((studentResults.reduce((sum, result) => sum + result.percentage, 0) / studentResults.length).toFixed(1))
            : 0;

        const classAverage = allClassResults.length > 0 
            ? parseFloat((allClassResults.reduce((sum, result) => sum + result.percentage, 0) / allClassResults.length).toFixed(1))
            : 0;

        // Prepare chart data
        const chartData = {
            // Score trends chart
            scoreTrends: {
                labels: studentResults.slice(0, 10).reverse().map(result => {
                    return new Date(result.submissionDate).toLocaleDateString();
                }),
                datasets: [{
                    label: 'Your Scores',
                    data: studentResults.slice(0, 10).reverse().map(result => result.percentage),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.4,
                    fill: true,
                    pointBackgroundColor: '#3b82f6',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6
                }, {
                    label: 'Class Average',
                    data: studentResults.slice(0, 10).reverse().map(() => classAverage),
                    borderColor: '#64748b',
                    backgroundColor: 'transparent',
                    borderDash: [5, 5],
                    tension: 0,
                    pointRadius: 0
                }]
            },

            // Performance breakdown pie chart
            performanceBreakdown: {
                labels: ['Excellent (90%+)', 'Good (70-89%)', 'Average (50-69%)', 'Needs Improvement (<50%)'],
                datasets: [{
                    data: [
                        studentResults.filter(r => r.percentage >= 90).length,
                        studentResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                        studentResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                        studentResults.filter(r => r.percentage < 50).length
                    ],
                    backgroundColor: [
                        '#10b981', // Green for excellent
                        '#3b82f6', // Blue for good
                        '#f59e0b', // Yellow for average
                        '#ef4444'  // Red for needs improvement
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },

            // Time analysis bar chart
            timeAnalysis: {
                labels: studentResults.slice(0, 8).reverse().map(result => {
                    const quizTitle = quizMap[result.quizId.toString()] || 'Quiz';
                    return quizTitle.length > 15 ? quizTitle.substring(0, 15) + '...' : quizTitle;
                }),
                datasets: [{
                    label: 'Time Taken (minutes)',
                    data: studentResults.slice(0, 8).reverse().map(result => Math.round(result.timeTakenSeconds / 60)),
                    backgroundColor: 'rgba(139, 92, 246, 0.6)',
                    borderColor: '#8b5cf6',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            }
        };

        console.log(`📊 Analytics prepared for ${req.session.userName}:`, {
            studentResultsCount: studentResults.length,
            studentAverage: studentAverage,
            classAverage: classAverage
        });

        res.json({
            success: true,
            data: {
                chartData: chartData,
                performanceMetrics: {
                    totalQuizzes: studentResults.length,
                    studentAverage: studentAverage,
                    classAverage: classAverage,
                    averageTime: studentResults.length > 0 
                        ? Math.round(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / studentResults.length)
                        : 0
                }
            }
        });

    } catch (error) {
        console.error('❌ Error generating student class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate analytics: ' + error.message
        });
    }
});


// 🏆 Get class rankings for student (UPDATED WITH PARTICIPATION WEIGHTING)
app.get('/api/student/class/:classId/rankings', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get all students and quizzes
        const classStudents = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        const totalQuizzesAvailable = classQuizzes.length;

        // 🆕 NEW: Calculate participation-weighted rankings
        const studentRankings = await Promise.all(
            classStudents.map(async (student) => {
                const studentResults = await quizResultCollection.find({
                    studentId: student.studentId,
                    classId: classId
                }).lean();

                if (studentResults.length === 0) {
                    return {
                        studentId: student.studentId,
                        studentName: student.studentName,
                        totalQuizzes: 0,
                        averageScore: 0,
                        averageTimeEfficiency: 0,
                        participationRate: 0,
                        finalPoints: 0,
                        averageTime: '0:00',
                        rank: 999
                    };
                }

                const averageScore = studentResults.reduce((sum, r) => sum + r.percentage, 0) / studentResults.length;

                const timeEfficiencies = studentResults.map(result => {
                    const quiz = classQuizzes.find(q => q._id.toString() === result.quizId.toString());
                    const quizDurationSeconds = quiz ? (quiz.durationMinutes || 15) * 60 : 900;
                    return calculateTimeEfficiency(result.timeTakenSeconds, quizDurationSeconds);
                });

                const averageTimeEfficiency = timeEfficiencies.length > 0
                    ? timeEfficiencies.reduce((sum, eff) => sum + eff, 0) / timeEfficiencies.length
                    : 0;

                // 🆕 NEW: Calculate participation rate and final points
                const participationRate = totalQuizzesAvailable > 0
                    ? (studentResults.length / totalQuizzesAvailable) * 100
                    : 0;

                const finalPoints = calculateParticipationWeightedPoints(averageScore, averageTimeEfficiency, participationRate);

                const averageTime = studentResults.reduce((sum, r) => sum + r.timeTakenSeconds, 0) / studentResults.length;

                return {
                    studentId: student.studentId,
                    studentName: student.studentName,
                    totalQuizzes: studentResults.length,
                    averageScore: formatPercentage(averageScore),
                    averageTimeEfficiency: formatPercentage(averageTimeEfficiency),
                    participationRate: formatPercentage(participationRate),
                    finalPoints: finalPoints,
                    averageTime: formatTime(averageTime),
                    rank: 0
                };
            })
        );

        // Sort by final points
        const rankedStudents = studentRankings
            .filter(student => student.totalQuizzes > 0)
            .sort((a, b) => b.finalPoints - a.finalPoints)
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        const currentStudent = rankedStudents.find(s => s.studentId.toString() === studentId.toString());

        res.json({
            success: true,
            data: {
                rankings: rankedStudents,
                currentStudent: currentStudent,
                totalStudents: rankedStudents.length,
                rankingSystem: {
                    formula: 'Final Points = Base Points × (0.3 + 0.7 × Participation Rate)',
                    description: 'Rankings encourage both performance and participation. Take more quizzes to improve your rank!'
                }
            }
        });

    } catch (error) {
        console.error('❌ Error generating rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate rankings: ' + error.message
        });
    }
});

// 📊 Get class performance data for student
app.get('/api/student/class/:classId/performance', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get student's results for this class
        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        })
            .sort({ submissionDate: -1 })
            .lean();

        // Get class average for comparison
        const allClassResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        const classAverage = allClassResults.length > 0
            ? (allClassResults.reduce((sum, result) => sum + result.percentage, 0) / allClassResults.length).toFixed(1)
            : 0;

        // Calculate student metrics
        const totalQuizzes = studentResults.length;
        const studentAverage = totalQuizzes > 0
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        const averageTime = totalQuizzes > 0
            ? Math.round(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / totalQuizzes)
            : 0;

        // Performance trend
        let trendIndicator = '→';
        if (totalQuizzes >= 3) {
            const recent = studentResults.slice(0, 2).reduce((sum, r) => sum + r.percentage, 0) / 2;
            const previous = studentResults.slice(2, 4).reduce((sum, r) => sum + r.percentage, 0) / 2;

            if (recent > previous + 5) trendIndicator = '↗️';
            else if (recent < previous - 5) trendIndicator = '↘️';
        }

        console.log(`📊 Performance data generated for student ${req.session.userName} in class ${classId}`);

        res.json({
            success: true,
            data: {
                performanceMetrics: {
                    totalQuizzes: totalQuizzes,
                    studentAverage: parseFloat(studentAverage),
                    classAverage: parseFloat(classAverage),
                    averageTime: averageTime,
                    trendIndicator: trendIndicator
                },
                recentResults: studentResults.slice(0, 10).map(result => ({
                    lectureTitle: result.quizId ? 'Quiz' : 'Unknown Quiz', // You might want to populate this
                    score: result.score,
                    totalQuestions: result.totalQuestions,
                    percentage: result.percentage,
                    timeTaken: result.timeTakenSeconds,
                    submissionDate: result.submissionDate
                }))
            }
        });

    } catch (error) {
        console.error('❌ Error generating performance data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate performance data: ' + error.message
        });
    }
});



// ==================== JOIN CODE MANAGEMENT ROUTES ====================

// 🆕 NEW: Generate join code for class (teacher only)
app.post('/api/classes/:classId/generate-join-code', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Teachers only.'
            });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('🔐 Generating join code for class:', {
            classId: classId,
            teacherId: teacherId,
            teacherName: req.session.userName
        });

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Deactivate any existing active codes for this class
        await classJoinCodeCollection.updateMany(
            {
                classId: classId,
                isActive: true
            },
            {
                isActive: false
            }
        );

        // Generate unique 6-digit code
        const joinCode = await classJoinCodeCollection.generateUniqueCode();

        // Set expiry to 10 minutes from now
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Create new join code
        const newJoinCode = await classJoinCodeCollection.create({
            classId: classId,
            teacherId: teacherId,
            className: classDoc.name,
            classSubject: classDoc.subject,
            teacherName: req.session.userName,
            joinCode: joinCode,
            expiresAt: expiresAt,
            isActive: true,
            usageCount: 0,
            maxUsage: 50
        });

        console.log('✅ Join code generated:', {
            joinCode: joinCode,
            expiresAt: expiresAt,
            className: classDoc.name
        });

        res.json({
            success: true,
            message: 'Join code generated successfully!',
            joinCode: joinCode,
            expiresAt: expiresAt,
            expiresInMinutes: 10,
            className: classDoc.name,
            classSubject: classDoc.subject,
            usageCount: 0,
            maxUsage: 50
        });

    } catch (error) {
        console.error('❌ Error generating join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate join code: ' + error.message
        });
    }
});

// 🆕 NEW: Get active join code for class (teacher only)
app.get('/api/classes/:classId/active-join-code', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Teachers only.'
            });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Find active join code
        const activeCode = await classJoinCodeCollection.findOne({
            classId: classId,
            isActive: true,
            expiresAt: { $gt: new Date() }
        });

        if (!activeCode) {
            return res.json({
                success: true,
                hasActiveCode: false,
                message: 'No active join code found.'
            });
        }

        res.json({
            success: true,
            hasActiveCode: true,
            joinCode: activeCode.joinCode,
            expiresAt: activeCode.expiresAt,
            usageCount: activeCode.usageCount,
            maxUsage: activeCode.maxUsage,
            remainingTime: Math.max(0, Math.floor((activeCode.expiresAt - new Date()) / 1000))
        });

    } catch (error) {
        console.error('❌ Error fetching active join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch join code: ' + error.message
        });
    }
});

// 🆕 NEW: Validate join code (student)
app.get('/api/classes/validate-join-code/:code', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Students only.'
            });
        }

        const joinCode = req.params.code.toUpperCase();
        const studentId = req.session.userId;

        console.log('🔍 Validating join code:', {
            joinCode: joinCode,
            studentId: studentId,
            studentName: req.session.userName
        });

        // Find the join code
        const codeDoc = await classJoinCodeCollection.findOne({
            joinCode: joinCode,
            isActive: true
        });

        if (!codeDoc) {
            return res.status(404).json({
                success: false,
                message: 'Invalid or expired join code.'
            });
        }

        // Check if code is expired
        if (codeDoc.isExpired()) {
            await classJoinCodeCollection.findByIdAndUpdate(codeDoc._id, { isActive: false });
            return res.status(400).json({
                success: false,
                message: 'This join code has expired.'
            });
        }

        // Check if code can still be used
        if (!codeDoc.canBeUsed()) {
            return res.status(400).json({
                success: false,
                message: 'This join code has reached its usage limit.'
            });
        }

        // Check if student is already enrolled in this class
        const existingEnrollment = await classStudentCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId,
            isActive: true
        });

        if (existingEnrollment) {
            return res.status(400).json({
                success: false,
                message: 'You are already enrolled in this class.'
            });
        }

        // Check if student already has a pending request for this class
        const existingRequest = await classJoinRequestCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId,
            status: 'pending'
        });

        if (existingRequest) {
            return res.status(400).json({
                success: false,
                message: 'You already have a pending request for this class.'
            });
        }

        console.log('✅ Join code validated successfully:', {
            className: codeDoc.className,
            teacherName: codeDoc.teacherName
        });

        res.json({
            success: true,
            valid: true,
            classInfo: {
                classId: codeDoc.classId,
                className: codeDoc.className,
                classSubject: codeDoc.classSubject,
                teacherName: codeDoc.teacherName,
                expiresAt: codeDoc.expiresAt,
                remainingTime: Math.max(0, Math.floor((codeDoc.expiresAt - new Date()) / 1000))
            }
        });

    } catch (error) {
        console.error('❌ Error validating join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to validate join code: ' + error.message
        });
    }
});

app.get('/debug/join-codes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ message: 'Teachers only' });
        }

        const activeCodes = await classJoinCodeCollection.find({
            isActive: true,
            expiresAt: { $gt: new Date() }
        }).sort({ generatedAt: -1 }).limit(10).lean();

        const formattedCodes = activeCodes.map(code => ({
            joinCode: code.joinCode,
            className: code.className,
            teacherName: code.teacherName,
            expiresAt: code.expiresAt,
            usageCount: code.usageCount,
            maxUsage: code.maxUsage,
            remainingTime: Math.max(0, Math.floor((code.expiresAt - new Date()) / 1000))
        }));

        res.json({
            success: true,
            activeCodes: formattedCodes,
            totalActive: activeCodes.length
        });

    } catch (error) {
        console.error('❌ Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== JOIN REQUEST MANAGEMENT ROUTES ====================

// 🔄 UPDATED: Submit join request (student) - Handles reactivating inactive enrollments
app.post('/api/classes/join-request', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Students only.'
            });
        }

        const { joinCode } = req.body;
        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('📝 Processing join request:', {
            joinCode: joinCode,
            studentId: studentId,
            studentName: studentName
        });

        if (!joinCode) {
            return res.status(400).json({
                success: false,
                message: 'Join code is required.'
            });
        }

        // Get student enrollment number
        const student = await studentCollection.findById(studentId).select('enrollment');
        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student record not found.'
            });
        }

        // Find and validate the join code
        const codeDoc = await classJoinCodeCollection.findOne({
            joinCode: joinCode.toUpperCase(),
            isActive: true
        });

        if (!codeDoc || codeDoc.isExpired() || !codeDoc.canBeUsed()) {
            return res.status(400).json({
                success: false,
                message: 'Invalid, expired, or overused join code.'
            });
        }

        // --- NEW/UPDATED: Comprehensive checks for existing enrollment or request ---

        // 1. Check for ANY existing classStudentCollection entry (active or inactive)
        const existingClassStudentEntry = await classStudentCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingClassStudentEntry) {
            if (existingClassStudentEntry.isActive) {
                console.log('⚠️ Student already actively enrolled in this class.');
                return res.status(400).json({
                    success: false,
                    message: 'You are already enrolled in this class.'
                });
            } else {
                // 🆕 NEW LOGIC: Reactivate inactive enrollment
                console.log('🔄 Reactivating inactive enrollment for student:', studentName, 'in class:', codeDoc.className);
                await classStudentCollection.findByIdAndUpdate(existingClassStudentEntry._id, {
                    isActive: true,
                    enrolledAt: new Date(), // Update enrollment date
                    studentName: studentName, // Update name in case it changed
                    studentEnrollment: student.enrollment // Update enrollment number
                });

                // Also update any pending/rejected join requests to 'approved' to clean up
                await classJoinRequestCollection.updateMany(
                    { classId: codeDoc.classId, studentId: studentId, status: { $in: ['pending', 'rejected'] } },
                    {
                        status: 'approved',
                        processedAt: new Date(),
                        // processedBy: 'system-reactivation' // ❌ REMOVE THIS LINE
                    }
                );

                // Increment usage count for the join code
                await classJoinCodeCollection.findByIdAndUpdate(codeDoc._id, {
                    $inc: { usageCount: 1 }
                });

                // Update class student count
                const totalActiveStudents = await classStudentCollection.countDocuments({
                    classId: codeDoc.classId,
                    isActive: true
                });
                await classCollection.findByIdAndUpdate(codeDoc.classId, {
                    studentCount: totalActiveStudents,
                    updatedAt: new Date()
                });

                return res.json({
                    success: true,
                    message: `You have successfully rejoined ${codeDoc.className}!`,
                    classInfo: {
                        className: codeDoc.className,
                        classSubject: codeDoc.classSubject,
                        teacherName: codeDoc.teacherName
                    }
                });
            }
        }

        // 2. Check if student has ANY existing join request (pending or rejected)
        // This is now only for cases where there's no classStudentEntry at all
        const existingJoinRequest = await classJoinRequestCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingJoinRequest) {
            console.log('⚠️ Existing join request found (status:', existingJoinRequest.status, ')');
            if (existingJoinRequest.status === 'pending') {
                return res.status(400).json({
                    success: false,
                    message: 'You already have a pending request for this class. Please wait for the teacher\'s approval.'
                });
            } else if (existingJoinRequest.status === 'rejected') {
                // If a previous request was rejected, delete it to allow a new one
                console.log('🗑️ Deleting previous rejected request to allow new submission.');
                await classJoinRequestCollection.deleteOne({ _id: existingJoinRequest._id });
            }
        }
        // --- END NEW/UPDATED CHECKS ---


        // If no existing enrollment (active/inactive) and no pending/rejected request, create new join request
        const joinRequest = await classJoinRequestCollection.create({
            classId: codeDoc.classId,
            studentId: studentId,
            studentName: studentName,
            studentEnrollment: student.enrollment,
            joinCode: joinCode.toUpperCase(),
            className: codeDoc.className,
            classSubject: codeDoc.classSubject,
            teacherId: codeDoc.teacherId,
            teacherName: codeDoc.teacherName,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent')?.substring(0, 500)
        });

        // Increment usage count
        await classJoinCodeCollection.findByIdAndUpdate(codeDoc._id, {
            $inc: { usageCount: 1 }
        });

        console.log('✅ New join request created:', {
            requestId: joinRequest._id,
            className: codeDoc.className,
            teacherName: codeDoc.teacherName
        });

        res.json({
            success: true,
            message: `Join request sent successfully! Waiting for ${codeDoc.teacherName} to approve your request.`,
            requestId: joinRequest._id,
            classInfo: {
                className: codeDoc.className,
                classSubject: codeDoc.classSubject,
                teacherName: codeDoc.teacherName
            }
        });

    } catch (error) {
        console.error('❌ Error submitting join request:', error);
        // Fallback for unexpected duplicate key errors (should be rare with new logic)
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'A request for this class already exists or you are already enrolled (duplicate key error).'
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to submit join request: ' + error.message
        });
    }
});

// 🆕 NEW: Get pending requests for class (teacher)
app.get('/api/classes/:classId/join-requests', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Teachers only.'
            });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get pending requests
        const pendingRequests = await classJoinRequestCollection.find({
            classId: classId,
            status: 'pending'
        }).sort({ requestedAt: -1 });

        console.log(`📋 Found ${pendingRequests.length} pending requests for class: ${classDoc.name}`);

        // Format requests for response
        const formattedRequests = pendingRequests.map(request => ({
            requestId: request._id,
            studentName: request.studentName,
            studentEnrollment: request.studentEnrollment,
            joinCode: request.joinCode,
            requestedAt: request.requestedAt,
            timeAgo: getTimeAgo(request.requestedAt)
        }));

        res.json({
            success: true,
            requests: formattedRequests,
            totalPending: formattedRequests.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('❌ Error fetching join requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch join requests: ' + error.message
        });
    }
});

// 🆕 NEW: Approve/reject join request (teacher) - UPDATED WITHOUT REJECTION REASON INPUT
app.post('/api/classes/:classId/join-requests/:requestId/:action', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Teachers only.'
            });
        }

        const { classId, requestId, action } = req.params;
        const teacherId = req.session.userId;

        console.log('⚖️ Processing join request action:', {
            classId: classId,
            requestId: requestId,
            action: action,
            teacherId: teacherId
        });

        // Validate action
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid action. Must be "approve" or "reject".'
            });
        }

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Find the join request
        const joinRequest = await classJoinRequestCollection.findOne({
            _id: requestId,
            classId: classId,
            status: 'pending'
        });

        if (!joinRequest) {
            return res.status(404).json({
                success: false,
                message: 'Join request not found or already processed.'
            });
        }

        if (action === 'approve') {
            // 🔧 FIX: Check for ANY existing enrollment (active or inactive)
            const existingEnrollment = await classStudentCollection.findOne({
                classId: classId,
                studentId: joinRequest.studentId
                // 🔧 REMOVED: isActive: true condition to check ALL enrollments
            });

            if (existingEnrollment) {
                if (existingEnrollment.isActive) {
                    // Student is already actively enrolled
                    await joinRequest.approve(teacherId);

                    return res.status(400).json({
                        success: false,
                        message: 'Student is already enrolled in this class.'
                    });
                } else {
                    // 🔧 FIX: Reactivate existing inactive enrollment instead of creating new one
                    console.log('🔄 Reactivating existing inactive enrollment for student:', joinRequest.studentName);

                    await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                        isActive: true,
                        enrolledAt: new Date(), // Update enrollment date
                        studentName: joinRequest.studentName, // Update name in case it changed
                        studentEnrollment: joinRequest.studentEnrollment // Update enrollment number
                    });
                }
            } else {
                // 🔧 No existing enrollment found, create new one
                console.log('➕ Creating new enrollment for student:', joinRequest.studentName);

                await classStudentCollection.create({
                    classId: classId,
                    studentId: joinRequest.studentId,
                    studentName: joinRequest.studentName,
                    studentEnrollment: joinRequest.studentEnrollment,
                    enrolledAt: new Date(),
                    isActive: true
                });
            }

            // Approve the request
            await joinRequest.approve(teacherId);

            // Update class student count
            const totalActiveStudents = await classStudentCollection.countDocuments({
                classId: classId,
                isActive: true
            });

            await classCollection.findByIdAndUpdate(classId, {
                studentCount: totalActiveStudents,
                updatedAt: new Date()
            });

            console.log('✅ Join request approved:', {
                studentName: joinRequest.studentName,
                className: classDoc.name,
                enrollmentMethod: existingEnrollment ? 'reactivated' : 'new'
            });

            res.json({
                success: true,
                message: `${joinRequest.studentName} has been added to the class successfully!`,
                action: 'approved',
                studentName: joinRequest.studentName,
                studentEnrollment: joinRequest.studentEnrollment
            });

        } else if (action === 'reject') {
            // Reject without asking for reason
            const defaultRejectionReason = 'Request rejected by teacher';

            // Reject the request
            await joinRequest.reject(teacherId, defaultRejectionReason);

            console.log('❌ Join request rejected:', {
                studentName: joinRequest.studentName,
                reason: defaultRejectionReason
            });

            res.json({
                success: true,
                message: `Join request from ${joinRequest.studentName} has been rejected.`,
                action: 'rejected',
                studentName: joinRequest.studentName,
                rejectionReason: defaultRejectionReason
            });
        }

    } catch (error) {
        console.error('❌ Error processing join request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process join request: ' + error.message
        });
    }
});

// 🆕 NEW: Get student's join request status
app.get('/api/student/join-request-status/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Students only.'
            });
        }

        const classId = req.params.classId;
        const studentId = req.session.userId;

        // Find the most recent request for this class
        const joinRequest = await classJoinRequestCollection.findOne({
            classId: classId,
            studentId: studentId
        }).sort({ requestedAt: -1 });

        if (!joinRequest) {
            return res.json({
                success: true,
                hasRequest: false,
                status: null
            });
        }

        res.json({
            success: true,
            hasRequest: true,
            status: joinRequest.status,
            requestedAt: joinRequest.requestedAt,
            processedAt: joinRequest.processedAt,
            rejectionReason: joinRequest.rejectionReason,
            className: joinRequest.className,
            teacherName: joinRequest.teacherName
        });

    } catch (error) {
        console.error('❌ Error fetching join request status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch request status: ' + error.message
        });
    }
});



// ==================== SIMPLE STUDENT CLASS REDIRECT  ====================

// 🎓 Simple redirect for student class view (breadcrumb navigation)
app.get('/student/class/:classId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Students only.');
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).redirect('/homeStudent?message=You are not enrolled in this class.');
        }

        // Get class name for context
        const classInfo = await classCollection.findById(classId).select('name').lean();
        const className = classInfo ? classInfo.name : 'Unknown Class';

        console.log(`🎓 Student ${req.session.userName} accessing class: ${className}`);

        // For now, redirect to student dashboard with class context
        // Later you can create a dedicated student class view page
        res.redirect(`/homeStudent?class=${classId}&className=${encodeURIComponent(className)}`);

    } catch (error) {
        console.error('❌ Error accessing student class:', error);
        res.status(500).redirect('/homeStudent?message=Failed to access class information.');
    }
});

// 🎯 Get available quizzes for a specific class (student enrolled)
app.get('/api/student/class/:classId/quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student is enrolled in this class
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get available quizzes for this class
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })
            .select('lectureTitle totalQuestions generatedDate')
            .sort({ generatedDate: -1 })
            .lean();

        // Check which quizzes the student has already taken
        const takenQuizIds = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).distinct('quizId');

        // Mark quizzes as taken or available
        const quizzesWithStatus = quizzes.map(quiz => ({
            _id: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.totalQuestions,
            generatedDate: quiz.generatedDate,
            status: takenQuizIds.includes(quiz._id.toString()) ? 'taken' : 'available'
        }));

        // Separate available and taken quizzes
        const availableQuizzes = quizzesWithStatus.filter(q => q.status === 'available');
        const takenQuizzes = quizzesWithStatus.filter(q => q.status === 'taken');

        console.log(`🎯 Found ${availableQuizzes.length} available quizzes for student in class ${classId}`);

        res.json({
            success: true,
            quizzes: availableQuizzes, // Only return available quizzes
            takenQuizzes: takenQuizzes, // Also return taken quizzes for reference
            totalAvailable: availableQuizzes.length,
            totalTaken: takenQuizzes.length
        });

    } catch (error) {
        console.error('❌ Error fetching class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class quizzes: ' + error.message
        });
    }
});


// ==================== UPDATED LECTURE RESULTS ROUTE ====================
app.get('/lecture_results/:lectureId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Only teachers can view lecture results.');
        }

        const lectureId = req.params.lectureId;

        // Get lecture details
        const lecture = await lectureCollection.findById(lectureId).lean();
        if (!lecture) {
            return res.status(404).send('Lecture not found.');
        }

        // Verify ownership
        if (!lecture.professorId.equals(req.session.userId)) {
            return res.status(403).send('Access denied. You can only view results for your own lectures.');
        }

        // Get quiz for this lecture
        const quiz = await quizCollection.findOne({ lectureId: lectureId }).lean();
        if (!quiz) {
            return res.render('lectureResults', {
                lectureTitle: lecture.title,
                className: lecture.className,
                subject: lecture.classSubject || 'Unknown Subject',
                quizResults: [],
                userName: req.session.userName || "Teacher",
                message: 'No quiz found for this lecture.'
            });
        }

        // Get quiz results
        const quizResults = await quizResultCollection.find({
            lectureId: lectureId
        })
            .sort({ percentage: -1, timeTakenSeconds: 1 }) // Sort by score desc, then time asc
            .lean();

        // Format results with rankings
        const formattedResults = quizResults.map((result, index) => ({
            ...result,
            rank: index + 1,
            submissionDate: result.submissionDate.toLocaleString(),
            rankInClass: index + 1 // For class context if needed
        }));

        // Get class information if available
        let classInfo = null;
        if (lecture.classId) {
            classInfo = await classCollection.findById(lecture.classId).select('name subject').lean();
        }

        console.log(`📊 Rendering lecture results for: ${lecture.title} (${formattedResults.length} results)`);

        res.render('lectureResults', {
            lectureTitle: lecture.title,
            className: classInfo ? classInfo.name : lecture.className,
            subject: classInfo ? classInfo.subject : (lecture.classSubject || 'Unknown Subject'),
            quizResults: formattedResults,
            userName: req.session.userName || "Teacher",
            totalStudents: formattedResults.length,
            quizId: quiz._id.toString()
        });

    } catch (error) {
        console.error('❌ Error fetching lecture results:', error);
        res.status(500).send('Failed to load quiz results: ' + error.message);
    }
});

// ==================== ANALYTICS ROUTES ====================

// Student Performance Analytics
// Student Performance Analytics
app.get('/api/student/performance-data', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;

        // Get all quiz results for this student
        const studentResults = await quizResultCollection.find({
            studentId: studentId
        }).sort({ submissionDate: -1 }).lean();

        // Get all results for comparison
        const allResults = await quizResultCollection.find({}).lean();

        // 🔧 FIX: Calculate statistics with proper formatting
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0
            ? formatPercentage(studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes) // 🔧 FIX
            : 0;

        // 🔧 FIX: Calculate overall class average with proper formatting
        const allScores = allResults.map(r => r.percentage);
        const classAverage = allScores.length > 0
            ? formatPercentage(allScores.reduce((sum, score) => sum + score, 0) / allScores.length) // 🔧 FIX
            : 0;

        // Calculate student performances map
        const studentPerformances = {};
        allResults.forEach(result => {
            const id = result.studentId.toString();
            if (!studentPerformances[id]) {
                studentPerformances[id] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformances[id].scores.push(result.percentage);
            studentPerformances[id].totalQuizzes++;
        });

        // 🔧 FIX: Calculate student performances with proper formatting
        const rankedStudents = Object.values(studentPerformances)
            .map(student => ({
                ...student,
                averageScore: formatPercentage(student.scores.reduce((sum, score) => sum + score, 0) / student.scores.length) // 🔧 FIX
            }))
            .sort((a, b) => b.averageScore - a.averageScore);

        const top3Performers = rankedStudents.slice(0, 3).map((student, index) => ({
            rank: index + 1,
            name: student.studentName,
            averageScore: student.averageScore, // Already formatted above
            totalQuizzes: student.totalQuizzes
        }));

        res.json({
            success: true,
            data: {
                studentStats: {
                    totalQuizzes: totalQuizzes,
                    averageScore: averageScore,
                    classAverage: classAverage
                },
                top3Performers: top3Performers,
                recentResults: studentResults.slice(0, 5).map(result => ({
                    score: formatPercentage(result.percentage), // 🔧 FIX
                    submissionDate: result.submissionDate,
                    timeTaken: result.timeTakenSeconds
                }))
            }
        });

    } catch (error) {
        console.error('❌ Error loading student performance data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load performance data: ' + error.message
        });
    }
});

// Helper functions for safe calculations
function safeNumber(value, defaultValue = 0) {
    const num = Number(value);
    return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

function safeToFixed(value, decimals = 2) {
    const num = safeNumber(value, 0);
    return num.toFixed(decimals);
}

function safePercentage(part, total) {
    const p = safeNumber(part, 0);
    const t = safeNumber(total, 1); // Avoid division by zero
    return t === 0 ? 0 : (p / t) * 100;
}

// 🎯 FIXED ANALYTICS ROUTE - USING YOUR COLLECTION NAMES
// 🎯 FIXED ANALYTICS ROUTE - USING YOUR COLLECTION NAMES
app.get('/api/teacher/class-analytics', requireAuth, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const teacherId = req.session.userId;

        // Get all teacher's classes
        const teacherClasses = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (teacherClasses.length === 0) {
            return res.json({
                success: true,
                data: getEmptyAnalyticsData()
            });
        }

        const classIds = teacherClasses.map(c => c._id);

        // Get all results for teacher's classes
        const results = await quizResultCollection.find({
            classId: { $in: classIds }
        }).lean();

        if (results.length === 0) {
            return res.json({
                success: true,
                data: getEmptyAnalyticsData()
            });
        }

        // Get quizzes
        const quizzes = await quizCollection.find({
            classId: { $in: classIds }
        }).lean();

        // Create quiz map for lookup
        const quizMap = {};
        quizzes.forEach(quiz => {
            quizMap[quiz._id.toString()] = quiz;
        });

        // 🔧 FIX: Calculate average score with proper formatting
        let totalScore = 0;
        let validScores = 0;

        results.forEach(result => {
            const score = safeNumber(result.percentage);
            if (score >= 0 && score <= 100) {
                totalScore += score;
                validScores++;
            }
        });

        const averageScore = validScores > 0 ? formatPercentage(totalScore / validScores) : 0; // 🔧 FIX

        // Calculate performance distribution
        const performanceDistribution = [];
        const quizPerformanceMap = {};

        results.forEach(result => {
            const quizId = result.quizId.toString();
            if (!quizPerformanceMap[quizId]) {
                quizPerformanceMap[quizId] = [];
            }
            quizPerformanceMap[quizId].push(result.percentage);
        });

        // 🔧 FIX: Calculate performance distribution with proper formatting
        Object.keys(quizPerformanceMap).forEach(quizId => {
            const quiz = quizMap[quizId];
            const scores = quizPerformanceMap[quizId];

            if (quiz && scores.length > 0) {
                const avgScore = formatPercentage(scores.reduce((a, b) => a + b, 0) / scores.length); // 🔧 FIX

                performanceDistribution.push({
                    quizId: quizId,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: scores.length,
                    averageScore: avgScore, // 🔧 FIX: Use formatted average
                    highestScore: formatPercentage(Math.max(...scores)), // 🔧 FIX
                    lowestScore: formatPercentage(Math.min(...scores)) // 🔧 FIX
                });
            }
        });

        // Calculate student performance and rankings
        const studentPerformance = {};
        results.forEach(result => {
            const studentId = result.studentId.toString();
            if (!studentPerformance[studentId]) {
                studentPerformance[studentId] = {
                    studentId: studentId,
                    studentName: result.studentName,
                    totalScore: 0,
                    quizCount: 0,
                    totalTime: 0
                };
            }
            studentPerformance[studentId].totalScore += result.percentage;
            studentPerformance[studentId].quizCount++;
            studentPerformance[studentId].totalTime += result.timeTakenSeconds;
        });

        const totalQuizzes = quizzes.length;

        // 🔧 FIX: Calculate student rankings with proper formatting
        const rankedStudents = Object.values(studentPerformance)
            .map((student, index) => ({
                rank: index + 1,
                studentId: student.studentId,
                studentName: student.studentName,
                averageScore: student.quizCount > 0 ?
                    formatPercentage(student.totalScore / student.quizCount) : 0, // 🔧 FIX
                totalQuizzes: student.quizCount,
                averageTime: student.quizCount > 0 ? formatTime(student.totalTime / student.quizCount) : '0:00',
                participationRate: formatPercentage(safePercentage(student.quizCount, totalQuizzes)) // 🔧 FIX
            }))
            .sort((a, b) => safeNumber(b.averageScore) - safeNumber(a.averageScore))
            .map((student, index) => ({ ...student, rank: index + 1 }));

        const topPerformers = rankedStudents.slice(0, 5);

        res.json({
            success: true,
            data: {
                overallStats: {
                    totalStudents: Object.keys(studentPerformance).length,
                    totalQuizzes: totalQuizzes,
                    classAverage: averageScore, // 🔧 FIX: Already formatted
                    totalResults: results.length
                },
                performanceDistribution: performanceDistribution,
                rankedStudents: rankedStudents,
                topPerformers: topPerformers
            }
        });

    } catch (error) {
        console.error('❌ Error in teacher class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load analytics: ' + error.message
        });
    }
});

// Helper functions for safe calculations
function safeNumber(value, defaultValue = 0) {
    const num = Number(value);
    return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

function safePercentage(part, total) {
    const p = safeNumber(part, 0);
    const t = safeNumber(total, 1); // Avoid division by zero
    return t === 0 ? 0 : (p / t) * 100;
}

function getEmptyAnalyticsData() {
    return {
        overallStats: {
            totalStudents: 0,
            totalQuizzes: 0,
            classAverage: 0,
            totalResults: 0
        },
        performanceDistribution: [],
        rankedStudents: [],
        topPerformers: []
    };
}

// Individual Student Analytics for Teachers
app.get('/api/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const studentId = req.params.studentId;
        const classId = req.query.classId; // Optional class filter
        const teacherId = req.session.userId;
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        console.log('📊 Loading student analytics API:', {
            studentId: studentId,
            classId: classId,
            teacherId: teacherId
        });

        // Get student info
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        // Build query filter based on class context
        let quizResultsFilter = {
            studentId: studentId,
            submissionDate: { $gte: fifteenDaysAgo }
        };

        let classAverageFilter = {
            submissionDate: { $gte: fifteenDaysAgo }
        };

        let totalQuizzesFilter = {};

        // Apply class filtering if specified
        if (classId) {
            // Verify teacher access to class
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: teacherId,
                isActive: true
            }).lean();

            if (!classDoc) {
                return res.status(403).json({
                    success: false,
                    message: 'Class not found or access denied.'
                });
            }

            // Verify student enrollment
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: classId,
                isActive: true
            }).lean();

            if (!enrollment) {
                return res.status(403).json({
                    success: false,
                    message: 'Student is not enrolled in this class.'
                });
            }

            // Filter by specific class
            quizResultsFilter.classId = classId;
            classAverageFilter.classId = classId;
            totalQuizzesFilter.classId = classId;

            console.log(`🏫 Filtering analytics for class: ${classDoc.name}`);
        } else {
            // Verify teacher has access to student through any class
            const teacherClasses = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).select('_id').lean();

            const teacherClassIds = teacherClasses.map(c => c._id);

            const studentEnrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: { $in: teacherClassIds },
                isActive: true
            }).lean();

            if (!studentEnrollment) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to this student\'s analytics.'
                });
            }

            // Filter by teacher's classes only
            classAverageFilter.classId = { $in: teacherClassIds };
            quizResultsFilter.classId = { $in: teacherClassIds };
            totalQuizzesFilter.classId = { $in: teacherClassIds };

            console.log('📊 Loading analytics across all teacher\'s classes');
        }

        // Get student's quiz results (filtered)
        const studentResults = await quizResultCollection
            .find(quizResultsFilter)
            .sort({ submissionDate: -1 })
            .lean();

        // Get class average for comparison (filtered)
        const allClassResults = await quizResultCollection
            .find(classAverageFilter)
            .lean();

        // 🆕 NEW: Get total available quizzes for participation calculation
        const totalAvailableQuizzes = await quizCollection.countDocuments({
            ...totalQuizzesFilter,
            isActive: true
        });

        // Enhanced: Get quiz details with class information
        const enhancedStudentResults = await Promise.all(
            studentResults.map(async (result) => {
                const quiz = await quizCollection.findById(result.quizId).select('lectureTitle classId').lean();
                const classInfo = quiz && quiz.classId ? await classCollection.findById(quiz.classId).select('name').lean() : null;

                return {
                    ...result,
                    quizTitle: quiz ? quiz.lectureTitle : 'Unknown Quiz',
                    className: classInfo ? classInfo.name : 'Unknown Class'
                };
            })
        );

        // Calculate statistics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        // Calculate class average (filtered by same criteria)
        const classScores = allClassResults.map(r => r.percentage);
        const classAverage = classScores.length > 0
            ? (classScores.reduce((sum, score) => sum + score, 0) / classScores.length).toFixed(1)
            : 0;

        // Calculate improvement trend
        let trendIndicator = '→';
        if (studentResults.length >= 6) {
            const recent3 = studentResults.slice(0, 3).reduce((sum, r) => sum + r.percentage, 0) / 3;
            const previous3 = studentResults.slice(3, 6).reduce((sum, r) => sum + r.percentage, 0) / 3;

            if (recent3 > previous3 + 5) trendIndicator = '↗️';
            else if (recent3 < previous3 - 5) trendIndicator = '↘️';
        }

        // Calculate average time
        const averageTime = totalQuizzes > 0
            ? Math.floor(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / totalQuizzes / 60)
            : 0;

        // 🆕 NEW: Calculate participation data
        const participationData = {
            attempted: totalQuizzes,
            totalAvailable: totalAvailableQuizzes,
            participationRate: totalAvailableQuizzes > 0
                ? ((totalQuizzes / totalAvailableQuizzes) * 100).toFixed(1)
                : 0
        };

        // Prepare trend data for charts
        const trendData = enhancedStudentResults.reverse().map(result => ({
            date: result.submissionDate.toLocaleDateString(),
            score: result.percentage,
            classAvg: parseFloat(classAverage)
        }));

        // Format detailed results (limit to 10 most recent)
        const detailedResults = enhancedStudentResults.slice(0, 10).map(result => ({
            quizTitle: result.quizTitle,
            score: result.score,
            totalQuestions: result.totalQuestions,
            percentage: result.percentage,
            timeTaken: result.timeTakenSeconds,
            submissionDate: result.submissionDate,
            className: result.className,
            answers: result.answers
        }));

        // Prepare time analysis data
        const timeAnalysisData = enhancedStudentResults.slice(0, 10).map(result => ({
            quiz: result.quizTitle,
            timeMinutes: Math.floor(result.timeTakenSeconds / 60)
        }));

        // 🆕 ENHANCED: Return class-aware analytics data with participation
        const analyticsData = {
            studentInfo: {
                name: student.name,
                enrollment: student.enrollment,
                studentId: studentId
            },
            performanceMetrics: {
                totalQuizzes,
                averageScore: parseFloat(averageScore),
                classAverage: parseFloat(classAverage),
                averageTime: averageTime + 'm',
                trendIndicator
            },
            // 🆕 NEW: Add participation data
            participationData: participationData,
            detailedResults,
            chartData: {
                scoresTrend: trendData,
                timeAnalysis: timeAnalysisData
            },
            // Include class context in response
            classContext: {
                hasClassFilter: !!classId,
                classId: classId,
                totalResultsFound: studentResults.length
            }
        };

        console.log(`📊 Analytics data prepared for ${student.name}:`, {
            totalQuizzes: analyticsData.performanceMetrics.totalQuizzes,
            averageScore: analyticsData.performanceMetrics.averageScore,
            participationRate: participationData.participationRate,
            classFiltered: !!classId
        });

        res.json({
            success: true,
            data: analyticsData
        });

    } catch (error) {
        console.error('❌ Error fetching student analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load student analytics.'
        });
    }
});

// Class-specific student analytics route
app.get('/class/:classId/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const { classId, studentId } = req.params;
        const teacherId = req.session.userId;

        console.log('🏫 Class-context student analytics access:', {
            classId: classId,
            studentId: studentId,
            teacherId: teacherId
        });

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(403).redirect('/homeTeacher?message=Class not found or access denied.');
        }

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        }).lean();

        if (!enrollment) {
            return res.status(403).redirect(`/class/manage/${classId}?message=Student not found in this class.`);
        }

        console.log(`✅ Redirecting to analytics for ${enrollment.studentName} in ${classDoc.name}`);

        // Redirect to student analytics with class context
        res.redirect(`/teacher/student-analytics/${studentId}?classId=${classId}`);

    } catch (error) {
        console.error('❌ Error accessing class student analytics:', error);
        res.status(500).redirect('/homeTeacher?message=Failed to access student analytics.');
    }
});

// Student Analytics Page for Teachers
app.get('/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const studentId = req.params.studentId;
        const classId = req.query.classId; // Optional class context
        const teacherId = req.session.userId;

        console.log('📊 Loading student analytics page:', {
            studentId: studentId,
            classId: classId,
            teacherId: teacherId,
            requestedBy: req.session.userName
        });

        // Get student info
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        if (!student) {
            return res.status(404).send('Student not found.');
        }

        // 🆕 NEW: Class context verification and data
        let classContext = {
            classId: null,
            className: null,
            hasAccess: false
        };

        if (classId) {
            // Verify teacher owns the class
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: teacherId,
                isActive: true
            }).lean();

            if (classDoc) {
                // Verify student is enrolled in this class
                const enrollment = await classStudentCollection.findOne({
                    studentId: studentId,
                    classId: classId,
                    isActive: true
                }).lean();

                if (enrollment) {
                    classContext = {
                        classId: classId,
                        className: classDoc.name,
                        hasAccess: true
                    };
                    console.log('✅ Class context verified:', classContext.className);
                } else {
                    console.log('⚠️ Student not enrolled in specified class');
                    return res.status(403).send('Student is not enrolled in this class.');
                }
            } else {
                console.log('⚠️ Class not found or access denied');
                return res.status(403).send('Class not found or access denied.');
            }
        } else {
            // 🔍 Check if teacher has access to student through any class
            const teacherClasses = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).select('_id').lean();

            const teacherClassIds = teacherClasses.map(c => c._id);

            const studentEnrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: { $in: teacherClassIds },
                isActive: true
            }).lean();

            if (!studentEnrollment) {
                return res.status(403).send('You do not have access to this student\'s analytics.');
            }

            console.log('✅ Teacher access to student verified through class enrollment');
        }

        console.log(`📊 Rendering analytics page for ${student.name}${classContext.className ? ` (${classContext.className})` : ''}`);

        // 🎯 ENHANCED: Pass complete class context to template
        res.render('studentAnalytics', {
            student: student,
            studentId: studentId,
            userName: req.session.userName,
            classContext: classContext // 🆕 NEW: Pass class context
        });

    } catch (error) {
        console.error('❌ Error rendering student analytics page:', error);
        res.status(500).send('Failed to load student analytics page.');
    }
});

// 🚨 NEW: Start Exam Session API
app.post('/api/quiz/exam-session/start', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const { quizId, sessionDurationMinutes, classId } = req.body;
        const teacherId = req.session.userId;

        console.log('🚨 Starting exam session:', {
            quizId,
            sessionDurationMinutes,
            classId,
            teacherId
        });

        // Validate inputs
        const duration = parseInt(sessionDurationMinutes);
        if (isNaN(duration) || duration < 5 || duration > 180) {
            return res.status(400).json({
                success: false,
                message: 'Session duration must be between 5 and 180 minutes.'
            });
        }

        // Get and verify quiz
        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership through class
        if (quiz.classId) {
            const classDoc = await classCollection.findOne({
                _id: quiz.classId,
                teacherId: teacherId,
                isActive: true
            });

            if (!classDoc) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You do not own this class.'
                });
            }
        }

        // Check if already has active session
        if (quiz.examSessionActive) {
            return res.status(400).json({
                success: false,
                message: 'An exam session is already active for this quiz.'
            });
        }

        // Start the exam session
        const startTime = new Date();
        const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

        await quizCollection.findByIdAndUpdate(quizId, {
            examSessionActive: true,
            examSessionStartTime: startTime,
            examSessionEndTime: endTime,
            examSessionDuration: duration,
            examSessionCreatedBy: teacherId,
            examSessionParticipants: []
        });

        console.log('✅ Exam session started:', {
            quizId,
            startTime,
            endTime,
            duration
        });

        res.json({
            success: true,
            message: `Exam session started successfully! Duration: ${duration} minutes`,
            sessionId: quizId, // Using quiz ID as session ID for simplicity
            startsAt: startTime,
            endsAt: endTime,
            durationMinutes: duration
        });

    } catch (error) {
        console.error('❌ Error starting exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam session: ' + error.message
        });
    }
});

// 🚨 NEW: End Exam Session API
app.post('/api/quiz/exam-session/end', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const { quizId } = req.body;
        const teacherId = req.session.userId;

        // Get and verify quiz
        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership
        if (quiz.classId) {
            const classDoc = await classCollection.findOne({
                _id: quiz.classId,
                teacherId: teacherId,
                isActive: true
            });

            if (!classDoc) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied.'
                });
            }
        }

        if (!quiz.examSessionActive) {
            return res.status(400).json({
                success: false,
                message: 'No active exam session to end.'
            });
        }

        // End the session
        await quizCollection.findByIdAndUpdate(quizId, {
            examSessionActive: false
        });

        console.log('🛑 Exam session ended:', { quizId, teacherId });

        res.json({
            success: true,
            message: 'Exam session ended successfully!'
        });

    } catch (error) {
        console.error('❌ Error ending exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end exam session: ' + error.message
        });
    }
});

// 🚨 NEW: Get Exam Session Status API
app.get('/api/quiz/:quizId/exam-status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;

        const quiz = await quizCollection.findById(quizId)
            .select('examSessionActive examSessionStartTime examSessionEndTime examSessionDuration lectureTitle')
            .lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        let remainingSeconds = 0;
        let canTakeQuiz = true;
        let statusMessage = 'Quiz available';

        if (quiz.examSessionActive) {
            const now = new Date();
            const endTime = new Date(quiz.examSessionEndTime);
            
            if (now > endTime) {
                // Session expired, deactivate it
                await quizCollection.findByIdAndUpdate(quizId, {
                    examSessionActive: false
                });
                canTakeQuiz = false;
                statusMessage = 'Exam session has ended';
            } else {
                remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
                statusMessage = `Exam session active - ${Math.floor(remainingSeconds / 60)}:${(remainingSeconds % 60).toString().padStart(2, '0')} remaining`;
            }
        }

        res.json({
            success: true,
            examSessionActive: quiz.examSessionActive,
            remainingSeconds,
            canTakeQuiz,
            statusMessage,
            quizTitle: quiz.lectureTitle,
            sessionStartTime: quiz.examSessionStartTime,
            sessionEndTime: quiz.examSessionEndTime
        });

    } catch (error) {
        console.error('❌ Error getting exam status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get exam status: ' + error.message
        });
    }
});

// 🚨 NEW: Start Exam Session
app.post('/api/quiz/:quizId/start-exam-session', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const quizId = req.params.quizId;
        const { sessionDurationMinutes } = req.body;
        const teacherId = req.session.userId;

        console.log('🚨 Starting exam session:', {
            quizId: quizId,
            sessionDurationMinutes: sessionDurationMinutes,
            teacherId: teacherId
        });

        // Validate duration
        const duration = parseInt(sessionDurationMinutes);
        if (isNaN(duration) || duration < 5 || duration > 180) {
            return res.status(400).json({
                success: false,
                message: 'Session duration must be between 5 and 180 minutes.'
            });
        }

        // Get the quiz
        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership
        if (!quiz.createdBy.equals(teacherId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only start sessions for your own quizzes.'
            });
        }

        // Check if session is already active
        if (quiz.examSessionActive) {
            return res.status(400).json({
                success: false,
                message: 'An exam session is already active for this quiz.'
            });
        }

        // Start the exam session
        await quiz.startExamSession(duration, teacherId);

        console.log('✅ Exam session started:', {
            quizId: quizId,
            duration: duration,
            startTime: quiz.examSessionStartTime,
            endTime: quiz.examSessionEndTime
        });

        res.json({
            success: true,
            message: `Exam session started! Duration: ${duration} minutes`,
            sessionData: {
                quizId: quiz._id,
                sessionActive: true,
                startTime: quiz.examSessionStartTime,
                endTime: quiz.examSessionEndTime,
                durationMinutes: duration,
                remainingSeconds: quiz.getSessionTimeRemaining()
            }
        });

    } catch (error) {
        console.error('❌ Error starting exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam session: ' + error.message
        });
    }
});

// 🚨 NEW: Get Exam Session Status
app.get('/api/quiz/:quizId/exam-session-status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;

        console.log('📊 Getting exam session status for quiz:', quizId);

        const quiz = await quizCollection.findById(quizId)
            .select('examSessionMode examSessionActive examSessionStartTime examSessionEndTime examSessionDuration examSessionParticipants lectureTitle')
            .lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Calculate remaining time
        let remainingSeconds = 0;
        let isExpired = false;

        if (quiz.examSessionActive && quiz.examSessionEndTime) {
            const now = new Date();
            const endTime = new Date(quiz.examSessionEndTime);
            remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
            isExpired = now > endTime;
        }

        // Get participant info
        const participantCount = quiz.examSessionParticipants ? quiz.examSessionParticipants.length : 0;
        const submittedCount = quiz.examSessionParticipants 
            ? quiz.examSessionParticipants.filter(p => p.hasSubmitted).length 
            : 0;

        console.log('📊 Session status:', {
            active: quiz.examSessionActive,
            remainingSeconds: remainingSeconds,
            participants: participantCount,
            submitted: submittedCount
        });

        res.json({
            success: true,
            sessionData: {
                quizId: quiz._id,
                quizTitle: quiz.lectureTitle,
                sessionMode: quiz.examSessionMode || false,
                sessionActive: quiz.examSessionActive || false,
                startTime: quiz.examSessionStartTime,
                endTime: quiz.examSessionEndTime,
                durationMinutes: quiz.examSessionDuration,
                remainingSeconds: remainingSeconds,
                isExpired: isExpired,
                participantCount: participantCount,
                submittedCount: submittedCount,
                participants: quiz.examSessionParticipants || []
            }
        });

    } catch (error) {
        console.error('❌ Error getting exam session status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get session status: ' + error.message
        });
    }
});

// 🚨 NEW: Join Exam Session (for students)
app.post('/api/quiz/:quizId/join-exam-session', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Students only.' 
            });
        }

        const quizId = req.params.quizId;
        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('🎓 Student joining exam session:', {
            quizId: quizId,
            studentId: studentId,
            studentName: studentName
        });

        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Check if session is active
        if (!quiz.examSessionActive) {
            return res.status(400).json({
                success: false,
                message: 'No active exam session for this quiz.'
            });
        }

        // Check if session has expired
        if (quiz.isSessionExpired()) {
            await quiz.endExamSession();
            return res.status(400).json({
                success: false,
                message: 'Exam session has expired.'
            });
        }

        // Check if student already submitted
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            return res.status(400).json({
                success: false,
                message: 'You have already submitted this quiz.'
            });
        }

        // Add student to session participants
        await quiz.addSessionParticipant(studentId, studentName);

        console.log('✅ Student joined exam session successfully');

        res.json({
            success: true,
            message: 'Successfully joined exam session!',
            sessionData: {
                quizId: quiz._id,
                sessionActive: true,
                remainingSeconds: quiz.getSessionTimeRemaining(),
                startTime: quiz.examSessionStartTime,
                endTime: quiz.examSessionEndTime
            }
        });

    } catch (error) {
        console.error('❌ Error joining exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to join exam session: ' + error.message
        });
    }
});

// 🚨 NEW: End Exam Session (teacher only)
app.post('/api/quiz/:quizId/end-exam-session', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Teachers only.' 
            });
        }

        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership
        if (!quiz.createdBy.equals(teacherId)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. You can only end sessions for your own quizzes.'
            });
        }

        if (!quiz.examSessionActive) {
            return res.status(400).json({
                success: false,
                message: 'No active exam session to end.'
            });
        }

        await quiz.endExamSession();

        console.log('🛑 Exam session ended by teacher:', {
            quizId: quizId,
            teacherId: teacherId
        });

        res.json({
            success: true,
            message: 'Exam session ended successfully!'
        });

    } catch (error) {
        console.error('❌ Error ending exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end exam session: ' + error.message
        });
    }
});

// 🚨 NEW: Auto-submit expired sessions (background job)
async function checkAndAutoSubmitExpiredSessions() {
    try {
        const expiredSessions = await quizCollection.find({
            examSessionActive: true,
            examSessionEndTime: { $lt: new Date() }
        });

        console.log(`🕐 Checking expired sessions: ${expiredSessions.length} found`);

        for (const quiz of expiredSessions) {
            // End the session
            await quiz.endExamSession();
            
            // Auto-submit for participants who haven't submitted
            const unsubmittedParticipants = quiz.examSessionParticipants.filter(p => !p.hasSubmitted);
            
            for (const participant of unsubmittedParticipants) {
                try {
                    // Check if they already submitted somehow
                    const existingResult = await quizResultCollection.findOne({
                        quizId: quiz._id,
                        studentId: participant.studentId
                    });

                    if (!existingResult) {
                        // Auto-submit with empty answers
                        const autoSubmissionData = {
                            quizId: quiz._id,
                            lectureId: quiz.lectureId,
                            classId: quiz.classId,
                            studentId: participant.studentId,
                            studentName: participant.studentName,
                            score: 0,
                            totalQuestions: quiz.totalQuestions,
                            percentage: 0,
                            timeTakenSeconds: quiz.examSessionDuration * 60, // Full session time
                            answers: quiz.questions.map((q, index) => ({
                                questionIndex: index,
                                question: q.question,
                                selectedOption: 'A', // Default to A for auto-submission
                                correctOption: q.correct_answer,
                                isCorrect: false
                            })),
                            examSessionData: {
                                wasExamSession: true,
                                sessionStartTime: quiz.examSessionStartTime,
                                sessionEndTime: quiz.examSessionEndTime,
                                sessionDurationMinutes: quiz.examSessionDuration,
                                joinedSessionAt: participant.joinedAt,
                                autoSubmittedBySession: true,
                                sessionTimeRemaining: 0,
                                sessionParticipantCount: quiz.examSessionParticipants.length
                            },
                            antiCheatMetadata: {
                                violationCount: 0,
                                wasAutoSubmitted: true,
                                submissionSource: 'Session-Auto-Submit',
                                securityStatus: 'Auto-Submit'
                            }
                        };

                        await quizResultCollection.create(autoSubmissionData);
                        await quiz.markParticipantSubmitted(participant.studentId, true);
                        
                        console.log(`📝 Auto-submitted for student: ${participant.studentName}`);
                    }
                } catch (autoSubmitError) {
                    console.error('❌ Error auto-submitting for participant:', participant.studentName, autoSubmitError);
                }
            }

            console.log(`✅ Processed expired session for quiz: ${quiz.lectureTitle}`);
        }
    } catch (error) {
        console.error('❌ Error checking expired sessions:', error);
    }
}

// Run expired session check every 30 seconds
setInterval(checkAndAutoSubmitExpiredSessions, 30000);

// 🚨 UPDATED: Enhanced quiz submission with exam session support
app.post('/api/quiz/submit/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can submit quizzes.' });
        }

        const quizId = req.params.quizId;
        const { 
            studentAnswers, 
            timeTakenSeconds, 
            classContext,
            antiCheatData,
            navigationHints 
        } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('📝 Quiz submission received:', {
            quizId: quizId,
            studentId: studentId,
            timeTaken: timeTakenSeconds,
            hasAntiCheatData: !!antiCheatData
        });

        // Get complete quiz data including exam session info
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found for scoring.' });
        }

        // 🚨 NEW: Handle exam session submissions
        let examSessionData = null;
        let wasAutoSubmittedBySession = false;

        if (quiz.examSessionMode && quiz.examSessionActive) {
            // Verify session hasn't expired
            if (quiz.examSessionEndTime && new Date() > new Date(quiz.examSessionEndTime)) {
                wasAutoSubmittedBySession = true;
                console.log('⏰ Session expired during submission - treating as auto-submit');
            }

            // Find participant
            const participant = quiz.examSessionParticipants?.find(
                p => p.studentId.toString() === studentId.toString()
            );

            if (participant) {
                const sessionRemainingSeconds = quiz.examSessionEndTime 
                    ? Math.max(0, Math.floor((new Date(quiz.examSessionEndTime) - new Date()) / 1000))
                    : 0;

                examSessionData = {
                    wasExamSession: true,
                    sessionStartTime: quiz.examSessionStartTime,
                    sessionEndTime: quiz.examSessionEndTime,
                    sessionDurationMinutes: quiz.examSessionDuration,
                    joinedSessionAt: participant.joinedAt,
                    autoSubmittedBySession: wasAutoSubmittedBySession,
                    sessionTimeRemaining: sessionRemainingSeconds,
                    sessionParticipantCount: quiz.examSessionParticipants.length
                };

                // Mark participant as submitted
                await quizCollection.findByIdAndUpdate(quizId, {
                    $set: {
                        'examSessionParticipants.$[participant].hasSubmitted': true,
                        'examSessionParticipants.$[participant].submittedAt': new Date(),
                        'examSessionParticipants.$[participant].autoSubmitted': wasAutoSubmittedBySession
                    }
                }, {
                    arrayFilters: [{ 'participant.studentId': studentId }]
                });

                console.log('🚨 Exam session submission processed:', {
                    remainingSeconds: sessionRemainingSeconds,
                    autoSubmitted: wasAutoSubmittedBySession
                });
            }
        }

        // Enhanced anti-cheat logging for exam sessions
        if (antiCheatData && antiCheatData.violationCount > 0) {
            console.log('🚨 SECURITY ALERT - Quiz submission with violations (Exam Session):', {
                studentId: studentId,
                studentName: studentName,
                quizId: quizId,
                violationCount: antiCheatData.violationCount,
                wasAutoSubmitted: antiCheatData.wasAutoSubmitted,
                isExamSession: !!examSessionData,
                sessionAutoSubmit: wasAutoSubmittedBySession,
                timestamp: new Date().toISOString(),
                classContext: classContext
            });
        }

        // Verify class enrollment if needed
        const targetClassId = quiz.classId || (classContext && classContext.classId);
        
        if (targetClassId) {
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: targetClassId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'You are not enrolled in the class for this quiz.' 
                });
            }
        }

        // Check for duplicate submission
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            return res.status(400).json({ 
                success: false, 
                message: 'You have already submitted this quiz.' 
            });
        }

        // Score the quiz
        let score = 0;
        const totalQuestions = quiz.totalQuestions;
        const detailedAnswers = [];
        const enhancedQuestionDetails = [];

        studentAnswers.forEach(sAnswer => {
            const correspondingQuestion = quiz.questions[sAnswer.questionIndex];
            if (correspondingQuestion) {
                const isCorrect = sAnswer.selectedOption === correspondingQuestion.correct_answer;
                if (isCorrect) {
                    score++;
                }
                
                detailedAnswers.push({
                    questionIndex: sAnswer.questionIndex,
                    question: sAnswer.question,
                    selectedOption: sAnswer.selectedOption,
                    correctOption: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });

                enhancedQuestionDetails.push({
                    questionIndex: sAnswer.questionIndex,
                    questionText: correspondingQuestion.question,
                    options: correspondingQuestion.options,
                    studentAnswer: sAnswer.selectedOption,
                    correctAnswer: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });
            }
        });

        const percentage = (totalQuestions > 0) ? (score / totalQuestions) * 100 : 0;

        // 🚨 NEW: Enhanced quiz result with exam session metadata
        const newQuizResult = {
            quizId: quizId,
            lectureId: quiz.lectureId,
            classId: targetClassId || null,
            studentId: studentId,
            studentName: studentName,
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            submissionDate: new Date(),
            answers: detailedAnswers,
            // 🚨 NEW: Exam session data
            examSessionData: examSessionData,
            // Enhanced anti-cheat metadata for exam sessions
            antiCheatMetadata: antiCheatData ? {
                violationCount: antiCheatData.violationCount || 0,
                wasAutoSubmitted: antiCheatData.wasAutoSubmitted || wasAutoSubmittedBySession,
                gracePeriodsUsed: antiCheatData.gracePeriodsUsed || 0,
                securityStatus: wasAutoSubmittedBySession ? 'Session-Auto-Submit' : 
                              (antiCheatData.violationCount === 0 ? 'Clean' : 
                               antiCheatData.violationCount === 1 ? 'Warning' : 'Violation'),
                submissionSource: wasAutoSubmittedBySession ? 'Session-Auto-Submit' : 
                                (antiCheatData.wasAutoSubmitted ? 'Auto-Submit' : 'Manual'),
                violationDetails: antiCheatData.violationDetails || [],
                monitoringStartTime: antiCheatData.monitoringStartTime,
                monitoringEndTime: new Date()
            } : {
                violationCount: 0,
                wasAutoSubmitted: wasAutoSubmittedBySession,
                gracePeriodsUsed: 0,
                securityStatus: wasAutoSubmittedBySession ? 'Session-Auto-Submit' : 'Clean',
                submissionSource: wasAutoSubmittedBySession ? 'Session-Auto-Submit' : 'Manual'
            }
        };

        const savedResult = await quizResultCollection.create(newQuizResult);
        
        // Enhanced logging with session context
        const securityStatus = antiCheatData && antiCheatData.violationCount > 0 
            ? `${antiCheatData.violationCount} violations` 
            : 'clean submission';
        const sessionStatus = examSessionData ? ' (exam session)' : '';
            
        console.log(`✅ Quiz result saved for student ${studentName} on quiz ${quiz.lectureTitle}: Score ${score}/${totalQuestions} (${securityStatus}${sessionStatus})`);

        // Get class information for comprehensive response
        let classInfo = null;
        if (targetClassId) {
            classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
        }

        // Enhanced response with exam session summary
        const enhancedResponse = {
            success: true,
            message: wasAutoSubmittedBySession 
                ? 'Quiz auto-submitted by exam session timer and scored successfully!'
                : (antiCheatData && antiCheatData.wasAutoSubmitted 
                    ? 'Quiz auto-submitted due to security violations and scored successfully!'
                    : 'Quiz submitted and scored successfully!'),
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            quizResultId: savedResult._id,
            
            // Enhanced response with class context
            lectureId: quiz.lectureId,
            classId: targetClassId,
            className: classInfo?.name,
            classSubject: classInfo?.subject,
            quizTitle: quiz.lectureTitle,
            questionDetails: enhancedQuestionDetails,
            quizId: quizId,
            
            // 🚨 NEW: Exam session summary
            examSessionSummary: examSessionData ? {
                wasExamSession: true,
                sessionDuration: examSessionData.sessionDurationMinutes,
                timeRemaining: examSessionData.sessionTimeRemaining,
                autoSubmittedBySession: wasAutoSubmittedBySession,
                participantCount: examSessionData.sessionParticipantCount
            } : {
                wasExamSession: false
            },
            
            // Enhanced anti-cheat summary
            antiCheatSummary: {
                violationCount: antiCheatData?.violationCount || 0,
                wasAutoSubmitted: antiCheatData?.wasAutoSubmitted || wasAutoSubmittedBySession,
                securityStatus: wasAutoSubmittedBySession ? 'Session Auto-Submit' :
                              (antiCheatData?.violationCount === 0 ? 'Clean' : 
                               antiCheatData?.violationCount === 1 ? 'Warning Issued' : 'Auto-Submitted'),
                submissionType: wasAutoSubmittedBySession ? 'Session Timer Auto-Submit' :
                              (antiCheatData?.wasAutoSubmitted ? 'Security Auto-Submit' : 'Manual Submit')
            },
            
            // Navigation context for frontend
            navigationContext: {
                hasClass: !!targetClassId,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,
                returnToClass: !!targetClassId,
                dashboardUrl: '/homeStudent',
                classUrl: targetClassId ? `/student/class/${targetClassId}` : null
            },
            
            // Suggested redirect based on context
            suggestedRedirect: {
                url: '/quiz-results',
                context: 'results_page',
                backUrl: targetClassId ? `/student/class/${targetClassId}` : '/homeStudent',
                backLabel: targetClassId ? `Back to ${classInfo?.name || 'Class'}` : 'Back to Dashboard'
            }
        };

        res.json(enhancedResponse);

    } catch (error) {
        console.error('❌ Error submitting or scoring quiz:', error);
        res.status(500).json({ success: false, message: 'Failed to submit quiz: ' + error.message });
    }
});

// 🚨 NEW: Get active exam sessions for class (teacher dashboard)
app.get('/api/teacher/class/:classId/active-sessions', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get active exam sessions for this class
        const activeSessions = await quizCollection.find({
            classId: classId,
            examSessionActive: true
        }).select('lectureTitle examSessionStartTime examSessionEndTime examSessionDuration examSessionParticipants').lean();

        const sessionSummaries = activeSessions.map(session => {
            const now = new Date();
            const endTime = new Date(session.examSessionEndTime);
            const remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
            
            return {
                quizId: session._id,
                quizTitle: session.lectureTitle,
                startTime: session.examSessionStartTime,
                endTime: session.examSessionEndTime,
                durationMinutes: session.examSessionDuration,
                remainingSeconds: remainingSeconds,
                participantCount: session.examSessionParticipants ? session.examSessionParticipants.length : 0,
                submittedCount: session.examSessionParticipants 
                    ? session.examSessionParticipants.filter(p => p.hasSubmitted).length 
                    : 0
            };
        });

        res.json({
            success: true,
            activeSessions: sessionSummaries,
            totalActiveSessions: sessionSummaries.length
        });

    } catch (error) {
        console.error('❌ Error getting active sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get active sessions: ' + error.message
        });
    }
});

// 🏆 Get class rankings for student
// 🏆 Get class rankings for student (UPDATED WITH NEW RANKING FORMULA)
app.get('/api/student/class/:classId/rankings', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get all students enrolled in this class
        const classStudents = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // Get quiz duration for time efficiency calculation
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // 🔧 STEP 2: Calculate rankings based on NEW POINTS FORMULA
        const studentRankings = await Promise.all(
            classStudents.map(async (student) => {
                const studentResults = await quizResultCollection.find({
                    studentId: student.studentId,
                    classId: classId
                }).lean();

                if (studentResults.length === 0) {
                    return {
                        studentId: student.studentId,
                        studentName: student.studentName,
                        totalQuizzes: 0,
                        averageScore: 0,
                        averageTimeEfficiency: 0,
                        totalPoints: 0,
                        averageTime: '0:00',
                        rank: 999
                    };
                }

                // Calculate average score
                const averageScore = studentResults.reduce((sum, r) => sum + r.percentage, 0) / studentResults.length;

                // 🔧 STEP 2: Calculate time efficiency for each result
                const timeEfficiencies = studentResults.map(result => {
                    // Find the quiz duration
                    const quiz = classQuizzes.find(q => q._id.toString() === result.quizId.toString());
                    const quizDurationSeconds = quiz ? (quiz.durationMinutes || 15) * 60 : 900; // Default 15 min

                    return calculateTimeEfficiency(result.timeTakenSeconds, quizDurationSeconds);
                });

                const averageTimeEfficiency = timeEfficiencies.length > 0
                    ? timeEfficiencies.reduce((sum, eff) => sum + eff, 0) / timeEfficiencies.length
                    : 0;

                // 🔧 STEP 2: Calculate ranking points using NEW FORMULA
                const totalPoints = calculateRankingPoints(averageScore, averageTimeEfficiency);

                const averageTime = studentResults.reduce((sum, r) => sum + r.timeTakenSeconds, 0) / studentResults.length;

                return {
                    studentId: student.studentId,
                    studentName: student.studentName,
                    totalQuizzes: studentResults.length,
                    averageScore: formatPercentage(averageScore),
                    averageTimeEfficiency: formatPercentage(averageTimeEfficiency),
                    totalPoints: totalPoints, // 🔧 STEP 2: NEW POINTS VALUE
                    averageTime: formatTime(averageTime),
                    participationRate: formatPercentage((studentResults.length / classQuizzes.length) * 100),
                    rank: 0 // Will be calculated after sorting
                };
            })
        );

        // 🔧 STEP 2: Sort by total points (NEW RANKING SYSTEM)
        const rankedStudents = studentRankings
            .filter(student => student.totalQuizzes > 0) // Only include students who took quizzes
            .sort((a, b) => b.totalPoints - a.totalPoints) // Sort by points descending
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        // Find current student's data
        const currentStudent = rankedStudents.find(s => s.studentId.toString() === studentId.toString());

        console.log(`🏆 NEW Rankings generated for class ${classId}: ${rankedStudents.length} students ranked by points`);

        res.json({
            success: true,
            data: {
                rankings: rankedStudents, // 🔧 STEP 2: ALL students, not just top X
                currentStudent: currentStudent,
                totalStudents: rankedStudents.length,
                rankingSystem: {
                    formula: 'Points = (Average Score × 0.7) + (Time Efficiency × 0.3)', // 🔧 STEP 2: NEW FORMULA
                    description: 'Rankings based on quiz performance and time efficiency. Only students who have taken quizzes are ranked.'
                }
            }
        });

    } catch (error) {
        console.error('❌ Error generating rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate rankings: ' + error.message
        });
    }
});



// 🆕 STEP 3: NEW API ENDPOINT - Get last quiz rankings for class
app.get('/api/classes/:classId/last-quiz-rankings', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // 🔧 STEP 3: Find the most recently taken quiz by students (not created)
        const latestResult = await quizResultCollection.findOne({
            classId: classId
        }).sort({ submissionDate: -1 }).lean();

        if (!latestResult) {
            return res.json({
                success: true,
                data: {
                    quizTitle: null,
                    quizDate: null,
                    rankings: []
                }
            });
        }

        // Get the quiz details
        const quiz = await quizCollection.findById(latestResult.quizId).lean();

        if (!quiz) {
            return res.json({
                success: true,
                data: {
                    quizTitle: 'Unknown Quiz',
                    quizDate: latestResult.submissionDate.toISOString().split('T')[0],
                    rankings: []
                }
            });
        }

        // 🔧 STEP 3: Get all student results for that specific quiz
        const quizResults = await quizResultCollection.find({
            quizId: latestResult.quizId,
            classId: classId
        }).lean();

        // 🔧 STEP 3: Calculate rankings using the new points formula for that quiz
        const quizDurationSeconds = (quiz.durationMinutes || 15) * 60;

        const rankings = quizResults.map(result => {
            // Calculate time efficiency for this specific quiz
            const timeEfficiency = calculateTimeEfficiency(result.timeTakenSeconds, quizDurationSeconds);

            // Calculate points using new formula
            const points = calculateRankingPoints(result.percentage, timeEfficiency);

            return {
                studentId: result.studentId,
                studentName: result.studentName,
                score: formatPercentage(result.percentage),
                timeTaken: formatTime(result.timeTakenSeconds),
                timeEfficiency: formatPercentage(timeEfficiency),
                points: points,
                submissionDate: result.submissionDate
            };
        })
            .sort((a, b) => b.points - a.points) // Sort by points descending
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        console.log(`🎯 Last quiz rankings loaded: ${quiz.lectureTitle} with ${rankings.length} participants`);

        // 🔧 STEP 3: Return quiz title and rankings
        res.json({
            success: true,
            data: {
                quizTitle: quiz.lectureTitle,
                quizDate: latestResult.submissionDate.toISOString().split('T')[0],
                rankings: rankings
            }
        });

    } catch (error) {
        console.error('❌ Error loading last quiz rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load last quiz rankings: ' + error.message
        });
    }
});

// ==================== AI EXPLANATIONS ROUTES ====================

// Enhanced explanation retrieval route
app.post('/api/explanation/get', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const { quizId, questionIndex, wrongAnswer } = req.body;

        console.log('🔍 Getting ENHANCED explanation for:', {
            quizId: quizId,
            questionIndex: questionIndex,
            wrongAnswer: wrongAnswer
        });

        // Get the quiz with enhanced explanations
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        const question = quiz.questions[questionIndex];
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found.' });
        }

        let explanation = null;
        let explanationType = 'detailed';

        // Get the detailed explanation for the wrong answer
        if (question.explanations && question.explanations[wrongAnswer] && question.explanations[wrongAnswer].trim() !== '') {
            explanation = question.explanations[wrongAnswer];

            // Also include context about the correct answer
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation += `\n\n💡 **Why ${question.correct_answer} is correct:** ${question.correctAnswerExplanation}`;
            }

            console.log('✅ Retrieved detailed explanation for wrong answer:', wrongAnswer);
        } else {
            // Fallback explanation if detailed ones aren't available
            explanationType = 'basic';
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}.\n\n${question.correctAnswerExplanation}`;
            } else {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}. Please review the lecture material for detailed understanding.`;
            }

            console.log('⚠️ Using fallback explanation - detailed explanation not found');
        }

        console.log('✅ Retrieved explanation:', {
            type: explanationType,
            length: explanation.length,
            preview: explanation.substring(0, 100) + '...'
        });

        res.json({
            success: true,
            explanation: explanation,
            cached: true,
            source: 'pre-generated-enhanced',
            explanationType: explanationType,
            questionDetails: {
                correctAnswer: question.correct_answer,
                correctOption: question.options[question.correct_answer],
                wrongOption: question.options[wrongAnswer],
                hasDetailedExplanations: !!(question.explanations && Object.keys(question.explanations).length > 0),
                hasCorrectExplanation: !!(question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '')
            }
        });

    } catch (error) {
        console.error('❌ Error retrieving enhanced explanation:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve explanation: ' + error.message
        });
    }
});

// Check explanation status for a quiz
app.get('/api/quiz/:quizId/explanations-status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('questions generatedDate').lean();

        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // Check if questions have enhanced explanations
        const questionsWithExplanations = quiz.questions.filter(q =>
            q.explanations && Object.keys(q.explanations).some(key => q.explanations[key] && q.explanations[key].trim() !== '')
        ).length;

        const questionsWithCorrectExplanations = quiz.questions.filter(q =>
            q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
        ).length;

        const hasEnhancedExplanations = questionsWithExplanations > 0;

        console.log('📊 Explanation status check:', {
            quizId: quizId,
            totalQuestions: quiz.questions.length,
            questionsWithExplanations: questionsWithExplanations,
            questionsWithCorrectExplanations: questionsWithCorrectExplanations,
            hasEnhancedExplanations: hasEnhancedExplanations
        });

        res.json({
            success: true,
            hasEnhancedExplanations: hasEnhancedExplanations,
            explanationStats: {
                totalQuestions: quiz.questions.length,
                questionsWithExplanations: questionsWithExplanations,
                questionsWithCorrectExplanations: questionsWithCorrectExplanations,
                enhancementLevel: questionsWithExplanations === quiz.questions.length ? 'full' :
                    questionsWithExplanations > 0 ? 'partial' : 'none'
            },
            generatedDate: quiz.generatedDate
        });

    } catch (error) {
        console.error('❌ Error checking explanation status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check explanation status: ' + error.message
        });
    }
});

// ==================== DEBUG ROUTES (Development Only) ====================

// Debug route to check quiz explanations structure
app.get('/debug/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🔍 DEBUG: Checking quiz explanations for:', quizId);

        const quiz = await quizCollection.findById(quizId).lean();

        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        // Check the structure of the first question
        const firstQuestion = quiz.questions[0];

        const debugInfo = {
            quizId: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.questions.length,
            generatedDate: quiz.generatedDate,

            // Check first question structure
            firstQuestionStructure: {
                hasQuestion: !!firstQuestion.question,
                hasOptions: !!firstQuestion.options,
                hasCorrectAnswer: !!firstQuestion.correct_answer,
                hasExplanations: !!firstQuestion.explanations,
                hasCorrectExplanation: !!firstQuestion.correctAnswerExplanation,

                // Show actual explanation data
                explanationsData: firstQuestion.explanations || 'NOT FOUND',
                correctExplanationData: firstQuestion.correctAnswerExplanation || 'NOT FOUND'
            },

            // Check all questions for explanations
            questionsWithExplanations: quiz.questions.filter(q =>
                q.explanations && Object.keys(q.explanations).length > 0
            ).length,

            questionsWithCorrectExplanations: quiz.questions.filter(q =>
                q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
            ).length,

            // Sample of explanations from first question
            sampleExplanations: firstQuestion.explanations ?
                Object.entries(firstQuestion.explanations).map(([key, value]) => ({
                    option: key,
                    explanation: value ? value.substring(0, 100) + '...' : 'EMPTY'
                })) : 'NO EXPLANATIONS FIELD'
        };

        console.log('📊 DEBUG Results:', debugInfo);

        res.json({
            success: true,
            debugInfo: debugInfo,
            recommendation: debugInfo.questionsWithExplanations === 0 ?
                'ISSUE FOUND: No questions have explanations. You need to generate a NEW quiz with the enhanced system.' :
                'Explanations found! Check the explanation retrieval route.'
        });

    } catch (error) {
        console.error('❌ Debug error:', error);
        res.json({ error: error.message });
    }
});

// Debug route to test a specific question's explanations
app.get('/debug/quiz/:quizId/question/:questionIndex', isAuthenticated, async (req, res) => {
    try {
        const { quizId, questionIndex } = req.params;

        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        const question = quiz.questions[parseInt(questionIndex)];
        if (!question) {
            return res.json({ error: 'Question not found' });
        }

        res.json({
            success: true,
            questionDebug: {
                questionText: question.question,
                options: question.options,
                correctAnswer: question.correct_answer,
                hasExplanations: !!question.explanations,
                explanations: question.explanations || 'NOT FOUND',
                hasCorrectExplanation: !!question.correctAnswerExplanation,
                correctExplanation: question.correctAnswerExplanation || 'NOT FOUND',

                // Test each wrong answer explanation
                explanationTests: ['A', 'B', 'C', 'D'].map(option => ({
                    option: option,
                    isCorrectAnswer: option === question.correct_answer,
                    hasExplanation: !!(question.explanations && question.explanations[option]),
                    explanationText: question.explanations && question.explanations[option] ?
                        question.explanations[option] : 'NO EXPLANATION'
                }))
            }
        });

    } catch (error) {
        console.error('❌ Question debug error:', error);
        res.json({ error: error.message });
    }
});

// ==================== QUIZ RESULTS PAGE ROUTE ====================
app.get('/quiz-results', isAuthenticated, (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can view quiz results.');
        }

        // 🆕 ENHANCED: Handle query parameters for better error handling
        const queryParams = {
            alreadyTaken: req.query.alreadyTaken === 'true',
            quizTitle: req.query.quizTitle || null,
            error: req.query.error || null,
            message: req.query.message || null
        };

        console.log('📊 Quiz results page accessed:', {
            student: req.session.userName,
            queryParams: queryParams
        });

        // 🎯 ENHANCED: Pass additional context for better error handling
        res.render('quizResults', {
            userName: req.session.userName || 'Student',
            userType: req.session.userType || 'student',
            queryParams: queryParams, // Pass query parameters to template
            // Note: Main quiz data comes from localStorage, set by takeQuiz.hbs
        });

    } catch (error) {
        console.error('❌ Error rendering quiz results page:', error);
        res.status(500).send('Failed to load quiz results page.');
    }
});

// ==================== DATA CLEANUP FUNCTIONS ====================

// Function to clean up old quiz results (older than 15 days)
async function cleanupOldQuizResults() {
    try {
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        const deleteResult = await quizResultCollection.deleteMany({
            submissionDate: { $lt: fifteenDaysAgo }
        });

        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} old quiz results (older than 15 days)`);

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    }
}

// Function to clean up old unused explanations (run monthly)
async function cleanupOldExplanations() {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Delete explanations that haven't been used in 30 days and have usage count of 1
        const deleteResult = await explanationCacheCollection.deleteMany({
            generatedDate: { $lt: thirtyDaysAgo },
            usageCount: 1
        });

        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} unused explanations`);

    } catch (error) {
        console.error('❌ Error during explanation cleanup:', error);
    }
}

// ==================== ERROR HANDLING ====================

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
            const message = encodeURIComponent('File too large. Maximum size is 100MB.');
            return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
        }
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent('File upload error: ' + error.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    if (req.fileError) {
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent(req.fileError.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    next(error)
})

// ==================== SERVER STARTUP ====================

app.listen(PORT, () => {
    console.log(`🚀 QuizAI Server started on port ${PORT}`)
    console.log(`📌 Open http://localhost:${PORT} in your browser`)

    // Run cleanup functions on server start
    cleanupTempFiles()
    cleanupOldQuizResults()

    console.log('✅ Server initialization complete!')
    console.log('📚 Ready to process lecture uploads and generate enhanced quizzes!')
    console.log(`🔑 Using Gemini model: gemini-1.5-flash (Free tier)`)
})

// Schedule cleanup functions to run periodically
setInterval(cleanupOldQuizResults, 24 * 60 * 60 * 1000); // Every 24 hours
setInterval(cleanupOldExplanations, 16 * 24 * 60 * 60 * 1000); // Every 16 days


// 🆕 ENHANCED: Helper function for formatting time with better accuracy
function formatTime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return '0:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else {
        return `${minutes}m ${secs}s`;
    }
}
// Utility function to format numbers to two decimal places
function formatToTwoDecimals(num) {
    if (typeof num !== 'number') {
        num = parseFloat(num);
    }
    if (isNaN(num)) {
        return '0.00'; // Default for non-numeric or invalid numbers
    }
    return num.toFixed(2);
}

function formatPercentage(value, decimals = 1) {
    const num = parseFloat(value) || 0;
    return parseFloat(num.toFixed(decimals));
}

// 🆕 NEW: Helper function to calculate time efficiency
function calculateTimeEfficiency(timeTakenSeconds, quizDurationSeconds) {
    if (!timeTakenSeconds || !quizDurationSeconds || quizDurationSeconds <= 0) return 0;

    // Calculate efficiency: faster completion = higher efficiency
    // But don't penalize too much for using more time
    const timeRatio = timeTakenSeconds / quizDurationSeconds;

    if (timeRatio <= 0.5) {
        // Very fast completion - 100% efficiency
        return 100;
    } else if (timeRatio <= 1.0) {
        // Normal completion - scale from 100% to 60%
        return Math.round(100 - (timeRatio - 0.5) * 80);
    } else {
        // Overtime - scale down further but don't go below 10%
        return Math.max(10, Math.round(60 - (timeRatio - 1.0) * 50));
    }
}

// 🆕 NEW: Helper function to calculate quiz statistics with duration
function calculateQuizStats(results, quizDurationMinutes = 15) {
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
        averageScore: (results.reduce((sum, r) => sum + r.percentage, 0) / results.length).toFixed(1),
        averageTime: Math.round(results.reduce((sum, r) => sum + r.timeTakenSeconds, 0) / results.length),
        fastestCompletion: Math.min(...results.map(r => r.timeTakenSeconds)),
        slowestCompletion: Math.max(...results.map(r => r.timeTakenSeconds))
    };



    // Calculate average efficiency
    const efficiencies = results.map(r =>
        calculateTimeEfficiency(r.timeTakenSeconds, quizDurationSeconds)
    );
    stats.averageEfficiency = (efficiencies.reduce((sum, eff) => sum + eff, 0) / efficiencies.length).toFixed(1);

    return stats;
}

// 🆕 NEW: Helper function to create duration badge text
function createDurationBadge(durationMinutes) {
    if (durationMinutes <= 10) {
        return `⚡ ${durationMinutes}min Quick Quiz`;
    } else if (durationMinutes <= 30) {
        return `⏱️ ${durationMinutes}min Standard Quiz`;
    } else {
        return `🕐 ${durationMinutes}min Extended Quiz`;
    }
}

// 🆕 NEW: Helper function to get quiz duration from database with fallback
async function getQuizDuration(quizId) {
    try {
        const quiz = await quizCollection.findById(quizId).select('durationMinutes').lean();
        return quiz ? (quiz.durationMinutes || 15) : 15;
    } catch (error) {
        console.error('❌ Error fetching quiz duration:', error);
        return 15; // Fallback to 15 minutes
    }
}

// 🆕 NEW: Enhanced quiz validation with duration check
async function validateQuizAccess(quizId, studentId, req) {
    try {
        // Get quiz details including duration
        const quiz = await quizCollection.findById(quizId).select('durationMinutes classId lectureTitle isActive').lean();

        if (!quiz) {
            return { valid: false, message: 'Quiz not found.' };
        }

        if (!quiz.isActive) {
            return { valid: false, message: 'This quiz is no longer active.' };
        }

        // Check if student already took this quiz
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            return {
                valid: false,
                message: 'You have already completed this quiz.',
                resultId: existingResult._id
            };
        }

        // Check class enrollment if quiz belongs to a class
        if (quiz.classId) {
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: quiz.classId,
                isActive: true
            });

            if (!enrollment) {
                return {
                    valid: false,
                    message: 'You are not enrolled in the class for this quiz.'
                };
            }
        }

        return {
            valid: true,
            quiz: {
                ...quiz,
                durationMinutes: quiz.durationMinutes || 15,
                durationSeconds: (quiz.durationMinutes || 15) * 60
            }
        };

    } catch (error) {
        console.error('❌ Error validating quiz access:', error);
        return { valid: false, message: 'Error validating quiz access.' };
    }
}

// 🆕 NEW: Helper function to validate question count
function validateQuestionCount(questionCount) {
    const count = parseInt(questionCount);
    if (isNaN(count)) return 10; // Default fallback

    return Math.max(5, Math.min(30, count)); // Clamp between 5-30 questions
}


// 🆕 NEW: Helper function to validate quiz duration
function validateQuizDuration(durationMinutes) {
    const duration = parseInt(durationMinutes);
    if (isNaN(duration)) return 15; // Default fallback

    return Math.max(2, Math.min(60, duration)); // Clamp between 2-60 minutes
}

// 🆕 NEW: Helper to update quiz metadata after completion
async function updateQuizMetadata(quizId, newResult) {
    try {
        // Get all results for this quiz
        const allResults = await quizResultCollection.find({ quizId: quizId }).lean();

        if (allResults.length === 0) return;

        // Calculate updated stats
        const totalAttempts = allResults.length;
        const averageScore = allResults.reduce((sum, r) => sum + r.percentage, 0) / totalAttempts;
        const highestScore = Math.max(...allResults.map(r => r.percentage));

        // Update quiz with new stats
        await quizCollection.findByIdAndUpdate(quizId, {
            totalAttempts: totalAttempts,
            averageScore: parseFloat(averageScore.toFixed(1)),
            highestScore: parseFloat(highestScore.toFixed(1))
        });

        console.log(`📊 Quiz metadata updated: ${totalAttempts} attempts, avg: ${averageScore.toFixed(1)}%`);

    } catch (error) {
        console.error('❌ Error updating quiz metadata:', error);
    }
}

// 🆕 NEW: Helper to get class context for quiz
async function getQuizClassContext(quizId) {
    try {
        const quiz = await quizCollection.findById(quizId).select('classId className lectureTitle').lean();

        if (!quiz) return null;

        if (quiz.classId) {
            const classInfo = await classCollection.findById(quiz.classId).select('name subject teacherId').lean();

            return {
                hasClass: true,
                classId: quiz.classId,
                className: classInfo ? classInfo.name : quiz.className,
                classSubject: classInfo ? classInfo.subject : null,
                quizTitle: quiz.lectureTitle
            };
        }

        return {
            hasClass: false,
            quizTitle: quiz.lectureTitle
        };

    } catch (error) {
        console.error('❌ Error getting quiz class context:', error);
        return null;
    }
}

// 🆕 NEW: Enhanced error response helper with duration context
function sendQuizError(res, message, statusCode = 400, context = {}) {
    console.error('❌ Quiz Error:', message, context);

    return res.status(statusCode).json({
        success: false,
        message: message,
        timestamp: new Date().toISOString(),
        context: context
    });
}

// 🆕 NEW: Helper to migrate old quiz results (if needed for backward compatibility)
async function migrateOldQuizResults() {
    try {
        const resultsWithoutDuration = await quizResultCollection.find({
            quizDurationMinutes: { $exists: false }
        }).lean();

        if (resultsWithoutDuration.length === 0) {
            console.log('✅ All quiz results already have duration information');
            return;
        }

        console.log(`🔄 Migrating ${resultsWithoutDuration.length} old quiz results...`);

        for (const result of resultsWithoutDuration) {
            try {
                // Get the quiz duration
                const quiz = await quizCollection.findById(result.quizId).select('durationMinutes').lean();
                const durationMinutes = quiz ? (quiz.durationMinutes || 15) : 15;
                const durationSeconds = durationMinutes * 60;

                // Calculate time efficiency
                const timeEfficiency = calculateTimeEfficiency(result.timeTakenSeconds, durationSeconds);

                // Update the result
                await quizResultCollection.findByIdAndUpdate(result._id, {
                    quizDurationMinutes: durationMinutes,
                    quizDurationSeconds: durationSeconds,
                    timeEfficiency: timeEfficiency
                });

            } catch (error) {
                console.error(`❌ Error migrating result ${result._id}:`, error);
            }
        }

        console.log('✅ Migration completed');

    } catch (error) {
        console.error('❌ Error during migration:', error);
    }
}

// Helper function to get time ago
function getTimeAgo(date) {
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
}

//Helper functions for proper percentage formatting and ranking calculations
function formatPercentage(value, decimals = 1) {
    const num = parseFloat(value) || 0;
    return parseFloat(num.toFixed(decimals));
}

//  Time efficiency calculation function
function calculateTimeEfficiency(timeTakenSeconds, quizDurationSeconds) {
    if (!timeTakenSeconds || !quizDurationSeconds || quizDurationSeconds <= 0) return 0;
    const efficiency = Math.max(0, (quizDurationSeconds - timeTakenSeconds) / quizDurationSeconds * 100);
    return Math.min(100, efficiency);
}

//  Points calculation function  
function calculateRankingPoints(averageScore, timeEfficiency) {
    const score = parseFloat(averageScore) || 0;
    const efficiency = parseFloat(timeEfficiency) || 0;
    return parseFloat((score * 0.7 + efficiency * 0.3).toFixed(1));
}


// 🆕 NEW: Enhanced ranking points calculation with participation weight
function calculateParticipationWeightedPoints(averageScore, timeEfficiency, participationRate) {
    // Base points from performance
    const basePoints = calculateRankingPoints(averageScore, timeEfficiency);

    // Participation multiplier: 30% base + 70% based on participation
    // This ensures even low participation gets some points, but rewards high participation
    const participationMultiplier = 0.3 + (0.7 * (participationRate / 100));

    const finalPoints = basePoints * participationMultiplier;

    console.log(`📊 Points calculation: Base=${basePoints.toFixed(1)}, Participation=${participationRate.toFixed(1)}%, Multiplier=${participationMultiplier.toFixed(2)}, Final=${finalPoints.toFixed(1)}`);

    return parseFloat(finalPoints.toFixed(1));
}

// 🛠️ HELPER FUNCTIONS (Add these at the bottom of your index.js file)

function getEmptyAnalyticsData() {
    return {
        overallStats: {
            totalStudents: 0,
            totalQuizzes: 0,
            classAverage: '0.0',
            totalResults: 0
        },
        performanceDistribution: [],
        engagementLevels: {
            highlyActive: 0,
            moderatelyActive: 0,
            lowActivity: 0,
            inactive: 0
        },
        insights: {
            classHealthScore: {
                engagement: '0.0',
                performance: '0.0',
                participation: '0.0'
            },
            topPerformers: [],
            studentsNeedingAttention: [],
            mostChallengingQuiz: null,
            bestPerformingQuiz: null
        },
        rankedStudents: [],
        recentActivity: [],
        quizPerformance: [],
        chartMetadata: {
            performanceChart: {
                title: '📊 Student Performance Distribution by Quiz',
                subtitle: 'No data available yet',
                colors: {
                    excellent: '#10b981',
                    good: '#3b82f6',
                    average: '#f59e0b',
                    needsHelp: '#ef4444'
                }
            },
            engagementChart: {
                title: '👥 Student Engagement Levels',
                subtitle: 'No data available yet',
                colors: {
                    highlyActive: '#10b981',
                    moderatelyActive: '#3b82f6',
                    lowActivity: '#f59e0b',
                    inactive: '#ef4444'
                }
            }
        }
    };
}

// Export helper functions (add to your existing exports if any)
module.exports = {
    formatTime,
    calculateTimeEfficiency,
    validateQuizDuration,
    validateQuestionCount,
    getQuizDuration,
    createDurationBadge,
    calculateQuizStats,
    validateQuizAccess,
    updateQuizMetadata,
    getQuizClassContext,
    sendQuizError,
    formatPercentage,
    migrateOldQuizResults
};

function formatTime(seconds) {
    const totalSeconds = safeNumber(seconds, 0);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 🆕 NEW: Quiz Info Page Route
app.get('/quiz-info/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can view quiz information.');
        }

        const quizId = req.params.quizId;
        const classId = req.query.classId; // Optional class context
        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('📋 Quiz info page requested:', {
            quizId: quizId,
            classId: classId,
            student: studentName
        });

        // Get quiz details
        const quiz = await quizCollection.findById(quizId)
            .select('lectureTitle totalQuestions durationMinutes classId')
            .lean();

        if (!quiz) {
            return res.status(404).redirect('/homeStudent?message=Quiz not found.');
        }

        // Determine the target class ID
        const targetClassId = classId || quiz.classId;
        let classInfo = null;

        if (targetClassId) {
            // Verify student enrollment in the class
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: targetClassId,
                isActive: true
            });

            if (!enrollment) {
                const errorMessage = 'You are not enrolled in this class.';
                const redirectUrl = `/homeStudent?message=${encodeURIComponent(errorMessage)}`;
                return res.status(403).redirect(redirectUrl);
            }

            // Get class information
            classInfo = await classCollection.findById(targetClassId)
                .select('name subject')
                .lean();
        }

        // Check if student has already taken this quiz
        const existingResult = await quizResultCollection.findOne({
            quizId: quizId,
            studentId: studentId
        });

        if (existingResult) {
            const message = `You have already completed: ${quiz.lectureTitle}`;
            const redirectUrl = targetClassId
                ? `/student/class/${targetClassId}?message=${encodeURIComponent(message)}`
                : `/quiz-results?alreadyTaken=true&quizTitle=${encodeURIComponent(quiz.lectureTitle)}`;

            return res.redirect(redirectUrl);
        }

        console.log(`📋 Rendering quiz info page: ${quiz.lectureTitle}`);

        // Render the quiz info page
        res.render('quizInfo', {
            quizId: quizId,
            classId: targetClassId || '',
            quizTitle: quiz.lectureTitle,
            classSubject: classInfo ? classInfo.subject : 'General Quiz',
            totalQuestions: quiz.totalQuestions,
            durationMinutes: quiz.durationMinutes || 15,
            studentName: studentName
        });

    } catch (error) {
        console.error('❌ Error rendering quiz info page:', error);
        res.status(500).redirect('/homeStudent?message=Failed to load quiz information.');
    }
});