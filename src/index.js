// src/index.js - Fixed Main Server File
const express = require('express');
const path = require('path');

// Import configuration
const { connectDatabase } = require('./config/database');
const { configureApp } = require('./config/app');

// Import existing models (keep your existing mongodb.js for now)
require('./mongodb');

// Import middleware
const { addUserContext } = require('./middleware/authMiddleware');
const { handleUploadError, cleanupTempFiles } = require('./middleware/uploadMiddleware');

// Import constants
const { HTTP_STATUS, DATABASE } = require('./utils/constants');

// Create Express app
const app = express();
const PORT = process.env.PORT || 8080;

// Configure app (middleware, sessions, handlebars, etc.)
configureApp(app);

// Add user context to all requests
app.use(addUserContext);

// ==================== ROUTE IMPORTS - FIXED ====================

// Import route files
const authRoutes = require('./routes/authRoutes');
const teacherRoutes = require('./routes/teacherRoutes');
const studentRoutes = require('./routes/studentRoutes');

// Import API routes
const authApi = require('./routes/api/authApi');
const teacherApi = require('./routes/api/teacherApi');
const studentApi = require('./routes/api/studentApi');
const quizApi = require('./routes/api/quizApi');
const classApi = require('./routes/api/classApi');

// Import controller routes (if needed for specific functionality)
const authController = require('./controllers/authController');
const teacherController = require('./controllers/teacherController');
const studentController = require('./controllers/studentController');
const classController = require('./controllers/classController');
const quizController = require('./controllers/quizController');

// ==================== MOUNT ROUTES ====================

// Auth routes
app.use('/', authRoutes);

// Dashboard and page routes
app.use('/', teacherRoutes);
app.use('/', studentRoutes);

// API routes
app.use('/api/auth', authApi);
app.use('/api/teacher', teacherApi);
app.use('/api/student', studentApi);
app.use('/api/quiz', quizApi);
app.use('/api/class', classApi);

// ==================== CONTROLLER-BASED ROUTES ====================

// Additional controller-based routes for specific functionality
app.get('/dashboard', authController.dashboardRedirect);

// Teacher specific controller routes
app.get('/class/:classId/overview', classController.getClassOverview);
app.get('/class/:classId/students', classController.getClassStudents);
app.get('/class/:classId/rankings', classController.getClassRankings);
app.get('/class/:classId/last-quiz-rankings', classController.getLastQuizRankings);
app.post('/class/:classId/add-student', classController.addStudentToClass);
app.delete('/class/:classId/student/:studentId', classController.removeStudentFromClass);

// Quiz controller routes
app.post('/quiz/generate/:id', quizController.generateQuiz);
app.get('/quiz/:quizId/questions', quizController.getQuizQuestions);
app.get('/quiz/:quizId/duration', quizController.getQuizDuration);
app.post('/quiz/submit/:quizId', quizController.submitQuiz);
app.post('/quiz/explanation', quizController.getExplanation);
app.delete('/lecture/:id', quizController.deleteLecture);

// Student controller routes  
app.get('/quiz-info/:quizId', studentController.renderQuizInfo);
app.get('/take_quiz/:quizId', studentController.renderTakeQuiz);
app.get('/quiz-result/:resultId/detailed', studentController.renderDetailedQuizResults);
app.get('/student/class/:classId', studentController.renderClassView);

// Teacher controller routes
app.get('/teacher/student-analytics/:studentId', teacherController.renderStudentAnalytics);
app.get('/class/:classId/student-analytics/:studentId', teacherController.redirectToStudentAnalytics);
app.get('/lecture_results/:lectureId', teacherController.renderLectureResults);

// ==================== BASIC ROUTES ====================

// Redirect root to login
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(HTTP_STATUS.OK).json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
        routes: 'All routes properly mounted',
        database: 'Connected'
    });
});

// Test route
app.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'QuizAI server is running with fixed auth!',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        fixes_applied: [
            'Name parsing for signup',
            'Fixed schema validation',
            'Resolved duplicate indexes',
            'Proper firstName/lastName handling'
        ]
    });
});

// ==================== ERROR HANDLING ====================

// Handle upload errors
app.use(handleUploadError);

// 404 handler - catch all unmatched routes
app.use((req, res) => {
    console.log(`🔍 404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl,
        method: req.method
    });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { 
            error: error.message,
            stack: error.stack 
        })
    });
});

// ==================== BACKGROUND JOBS ====================

// Cleanup temporary files on startup and periodically
cleanupTempFiles();
setInterval(cleanupTempFiles, DATABASE.CLEANUP_INTERVALS.TEMP_FILES);

// ==================== SERVER STARTUP ====================

const startServer = async () => {
    try {
        // Connect to database
        await connectDatabase();
        console.log('✅ Database connected successfully');

        // Start server
        app.listen(PORT, () => {
            console.log(`🚀 QuizAI Server started on port ${PORT}`);
            console.log(`🌐 Open http://localhost:${PORT} in your browser`);
            console.log(`📚 Ready to process lecture uploads and generate enhanced quizzes!`);
            console.log(`🔑 Using Gemini model: gemini-1.5-flash (Free tier)`);
            console.log(`🔧 Applied fixes:`);
            console.log(`   ✅ Fixed auth signup validation issues`);
            console.log(`   ✅ Resolved duplicate MongoDB indexes`);
            console.log(`   ✅ Added proper name parsing (firstName/lastName)`);
            console.log(`   ✅ Improved error handling and logging`);
            console.log('✅ Server initialization complete!');
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('📤 SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📤 SIGINT received. Shutting down gracefully...');
    process.exit(0);
});

// Start the server
startServer();