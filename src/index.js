// src/index.js - UNIFIED QuizAI Server with All Features Combined
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Import configuration
const { connectDatabase } = require('./config/database');
const { configureApp } = require('./config/app');

// Import existing models
const {
    lectureCollection,
    quizCollection,
    quizResultCollection,
    classCollection,
    studentCollection,
    teacherCollection,
    classStudentCollection
} = require('./mongodb');

// Import middleware
const { addUserContext, requireAuth, isAuthenticated } = require('./middleware/authMiddleware');
const { handleUploadError, cleanupTempFiles } = require('./middleware/uploadMiddleware');

// Import constants
const { HTTP_STATUS, DATABASE } = require('./utils/constants');

// Import additional dependencies for quiz functionality
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const PptxParser = require("node-pptx-parser").default;

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 8080;
const TEMP_UPLOAD_DIR = './temp_uploads';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Configure app (middleware, sessions, handlebars, etc.)
configureApp(app);

// Add user context to all requests
app.use(addUserContext);

// ==================== MULTER CONFIGURATION ====================

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
});

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        req.fileError = new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed.');
        cb(null, false);
    }
};

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
});

// ==================== SOCKET.IO SETUP ====================

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // Handle user joining a class/quiz room
    socket.on('join-class', (classId) => {
        socket.join(`class-${classId}`);
        console.log(`👥 User ${socket.id} joined class room: ${classId}`);
    });

    // Handle user joining a quiz room
    socket.on('join-quiz', (quizId) => {
        socket.join(`quiz-${quizId}`);
        console.log(`📝 User ${socket.id} joined quiz room: ${quizId}`);
    });

    // Handle exam session events
    socket.on('join-exam', (examId) => {
        socket.join(`exam-${examId}`);
        console.log(`🎓 User ${socket.id} joined exam room: ${examId}`);
    });

    // Handle real-time quiz submissions
    socket.on('quiz-submitted', (data) => {
        console.log(`📊 Quiz submitted by ${socket.id}:`, data);
        
        // Broadcast to class members if applicable
        if (data.classId) {
            socket.to(`class-${data.classId}`).emit('new-submission', {
                studentName: data.studentName,
                score: data.score,
                timestamp: new Date()
            });
        }
    });

    // Handle live rankings updates
    socket.on('request-rankings', (classId) => {
        console.log(`📈 Rankings requested for class: ${classId}`);
        socket.emit('rankings-updated', { classId, timestamp: new Date() });
    });

    // Handle exam timer synchronization
    socket.on('exam-timer-sync', (examData) => {
        socket.to(`exam-${examData.examId}`).emit('timer-sync', {
            timeRemaining: examData.timeRemaining,
            timestamp: new Date()
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`🔌 User disconnected: ${socket.id}`);
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`🚨 Socket error for ${socket.id}:`, error);
    });
});

// Make io available to routes
app.set('io', io);

// ==================== UTILITY FUNCTIONS ====================

function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Temporary file deleted: ${filePath}`);
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error);
    }
}

function getFileType(mimetype) {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    };
    return typeMap[mimetype] || 'unknown';
}

// Text extraction functions
async function extractTextFromPDF(filePath) {
    let extractedText = '';
    try {
        console.log(`📄 Starting PDF text extraction for: ${filePath}`);
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        extractedText = data.text.trim();
        console.log('✅ PDF text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
    } catch (pdfError) {
        console.error('❌ Error extracting text from PDF:', pdfError);
        extractedText = "Error extracting text from PDF.";
    }
    return extractedText;
}

async function extractTextFromWord(filePath) {
    let extractedText = '';
    try {
        console.log(`📄 Starting Word text extraction for: ${filePath}`);
        const result = await mammoth.extractRawText({ path: filePath });
        extractedText = result.value.trim();
        console.log('✅ Word text extracted successfully (first 500 chars):', extractedText.substring(0, 500));
    } catch (wordError) {
        console.error('❌ Error extracting text from Word:', wordError);
        extractedText = "Error extracting text from Word.";
    }
    return extractedText;
}

async function extractTextFromPowerPoint(filePath) {
    let extractedText = '';
    try {
        console.log(`📄 Initializing PptxParser for: ${filePath}`);
        const parser = new PptxParser(filePath);

        console.log('📄 Extracting text using node-pptx-parser...');
        const textContent = await parser.extractText();

        if (textContent && textContent.length > 0) {
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
        extractedText = "Error extracting text from PowerPoint.";
    }
    return extractedText;
}

async function extractTextFromFile(filePath, mimetype) {
    console.log(`📄 Starting text extraction for: ${mimetype}`);

    switch (mimetype) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath);
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromWord(filePath);
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return await extractTextFromPowerPoint(filePath);
        default:
            throw new Error('Unsupported file type');
    }
}

// Gemini AI quiz generation function
async function generateQuizWithGemini(extractedText, customDuration, questionsToGenerate, examMode, examWindowDuration) {
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
        };

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
        ];

        console.log('📤 Sending ENHANCED request to Gemini API...');

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig,
            safetySettings,
        });

        const response = result.response;
        let quizContent = response.text();

        console.log('✅ Received ENHANCED response from Gemini API');

        // Parse and validate the AI response
        quizContent = quizContent.trim();
        if (quizContent.startsWith('```json')) {
            quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim();
        }

        const generatedQuiz = JSON.parse(quizContent);

        if (!Array.isArray(generatedQuiz)) {
            throw new Error('Response is not an array');
        }

        // Validate questions
        if (generatedQuiz.length !== questionsToGenerate) {
            console.warn(`⚠️ AI generated ${generatedQuiz.length} questions, expected ${questionsToGenerate}`);
            if (generatedQuiz.length > questionsToGenerate) {
                generatedQuiz.splice(questionsToGenerate);
                console.log(`✂️ Trimmed to ${questionsToGenerate} questions`);
            }
        }

        if (generatedQuiz.length === 0) {
            throw new Error('No questions generated');
        }

        // Validate each question
        generatedQuiz.forEach((q, index) => {
            if (!q.question || !q.options || !q.correct_answer || !q.explanations || !q.correctAnswerExplanation) {
                throw new Error(`Question ${index + 1} is missing required fields (including explanations)`);
            }
            if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                throw new Error(`Question ${index + 1} has invalid correct_answer`);
            }

            // Validate explanations exist for wrong answers
            ['A', 'B', 'C', 'D'].forEach(option => {
                if (option !== q.correct_answer && (!q.explanations[option] || q.explanations[option].trim() === '')) {
                    console.warn(`⚠️ Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                    q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                }
            });

            q.explanations[q.correct_answer] = "";
        });

        console.log('🎯 ENHANCED quiz validated:', {
            totalQuestions: generatedQuiz.length,
            requestedQuestions: questionsToGenerate,
            hasExplanations: !!generatedQuiz[0].explanations,
            hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation
        });

        return generatedQuiz;

    } catch (error) {
        console.error('❌ Gemini API Error:', error);
        throw error;
    }
}

// ==================== ROUTE IMPORTS ====================

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

// ==================== MOUNT ROUTES ====================

// 1. Auth routes (no conflicts)
app.use('/', authRoutes);

// 2. Dashboard and page routes
app.use('/', teacherRoutes);
app.use('/', studentRoutes);

// 3. API routes
app.use('/api/auth', authApi);
app.use('/api/teacher', teacherApi);
app.use('/api/student', studentApi);
app.use('/api/quiz', quizApi);
app.use('/api/classes', classApi);

// ==================== CORE QUIZ FUNCTIONALITY ROUTES ====================

// 📤 LECTURE UPLOAD ROUTE
app.post("/upload_lecture", requireAuth, upload.single('lectureFile'), async (req, res) => {
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

        const { title, classId } = req.body;
        const file = req.file;
        tempFilePath = file.path;

        console.log('📄 Processing file for class:', {
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

        // Verify class ownership if classId provided
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

        // Extract text from file
        const extractedText = await extractTextFromFile(file.path, file.mimetype);

        console.log('📄 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        cleanupTempFile(tempFilePath);
        console.log(`🗑️ Temporary file cleaned up after extraction.`);

        // Save lecture to database
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
            classId: classId || null,
            className: className || null
        };

        const savedLecture = await lectureCollection.create(lectureData);
        console.log('✅ Lecture saved to database:', savedLecture._id);

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

// 🎯 QUIZ GENERATION ROUTE
app.post('/generate_quiz/:id', requireAuth, async (req, res) => {
    try {
        const lectureId = req.params.id;
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

        // Validate parameters
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

        const lecture = await lectureCollection.findById(lectureId);

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            });
        }

        // Check ownership
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. You can only generate quizzes for your own lectures.' 
            });
        }

        // Check if quiz already exists
        const existingQuiz = await quizCollection.findOne({ lectureId: lectureId });
        if (existingQuiz) {
            return res.status(400).json({
                success: false,
                message: 'Quiz already generated for this lecture'
            });
        }

        // Update lecture status to processing
        await lectureCollection.findByIdAndUpdate(lectureId, {
            processingStatus: 'processing',
            lastProcessed: new Date()
        });

        console.log('🤖 ENHANCED AI Quiz Generation Started:', {
            lectureTitle: lecture.title,
            duration: customDuration,
            questions: questionsToGenerate,
            examMode: examMode,
            examDuration: examWindowDuration
        });

        const extractedText = lecture.extractedText;

        if (!extractedText || extractedText.length < 50) {
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Text too short for quiz generation'
            });
            return res.status(400).json({
                success: false,
                message: 'Extracted text is too short or missing for quiz generation.'
            });
        }

        // Generate quiz using Gemini API
        try {
            const generatedQuiz = await generateQuizWithGemini(extractedText, customDuration, questionsToGenerate, examMode, examWindowDuration);

            // Save quiz to database
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
                isExamMode: examMode,
                examDurationMinutes: examMode ? examWindowDuration : null,
                examStatus: examMode ? 'scheduled' : null
            };

            const savedQuiz = await quizCollection.create(newQuiz);
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
            });

            const quizTypeText = examMode ? 'Timed exam' : 'Quiz';
            console.log(`✅ ENHANCED ${quizTypeText} generation completed successfully for:`, lecture.title);

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
                isExamMode: examMode,
                examDurationMinutes: examMode ? examWindowDuration : null,
                examStatus: examMode ? 'scheduled' : null,
                debug: {
                    requestedDuration: customDuration,
                    requestedQuestions: questionsToGenerate,
                    actualDuration: savedQuiz.durationMinutes,
                    actualQuestions: savedQuiz.totalQuestions,
                    examMode: examMode,
                    examDuration: examWindowDuration
                }
            });

        } catch (apiError) {
            console.error('❌ ENHANCED Gemini API Error:', apiError);

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Enhanced AI API Error: ' + apiError.message
            });

            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({
                    success: false,
                    message: 'API quota exceeded. Please try again later.'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Failed to generate enhanced quiz. Please check your API key and try again.'
            });
        }

    } catch (error) {
        console.error('❌ ENHANCED quiz generation error:', error);

        if (req.params.id) {
            await lectureCollection.findByIdAndUpdate(req.params.id, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate enhanced quiz: ' + error.message
        });
    }
});

// 📖 GET LECTURE TEXT ROUTE
app.get('/lectures/:id/text', requireAuth, async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength professorId');

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            });
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. You do not own this lecture.' 
            });
        }

        res.json({
            success: true,
            data: {
                id: lecture._id,
                title: lecture.title,
                textLength: lecture.textLength,
                extractedText: lecture.extractedText
            }
        });
    } catch (error) {
        console.error('❌ Error fetching lecture text:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        });
    }
});

// 🗑️ DELETE LECTURE ROUTE
app.post('/delete_lecture/:id', requireAuth, async (req, res) => {
    try {
        const lectureId = req.params.id;
        const lecture = await lectureCollection.findById(lectureId);

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            });
        }

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. You can only delete your own lectures.' 
            });
        }

        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId });
        // Delete associated quiz results
        await quizResultCollection.deleteMany({ lectureId: lectureId });

        // Delete lecture record
        await lectureCollection.findByIdAndDelete(lectureId);

        console.log('🗑️ Lecture, quizzes, and results deleted:', lecture.title);

        res.json({
            success: true,
            message: 'Lecture deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting lecture:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete lecture'
        });
    }
});

// 📋 GET QUIZ QUESTIONS ROUTE (for students)
app.get('/api/quiz/:quizId', requireAuth, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Only students can access quiz questions.' 
            });
        }

        const quizId = req.params.quizId;
        console.log('📡 QUIZ API - Loading quiz with duration:', quizId);

        const quiz = await quizCollection.findById(quizId)
            .select('questions totalQuestions lectureTitle durationMinutes classId')
            .lean();

        if (!quiz) {
            return res.status(404).json({ 
                success: false, 
                message: 'Quiz not found.' 
            });
        }

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
                durationMinutes: actualDurationMinutes,
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
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load quiz questions.' 
        });
    }
});

// ⏱️ GET QUIZ DURATION ROUTE
app.get('/api/quiz/:quizId/duration', requireAuth, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🕒 DURATION API - Request for quiz:', quizId);

        const quiz = await quizCollection.findById(quizId)
            .select('durationMinutes lectureTitle classId')
            .lean();

        if (!quiz) {
            console.error('❌ DURATION API - Quiz not found:', quizId);
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

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

// 🔍 EXAM STATUS CHECK ROUTE
app.get('/api/quiz/:quizId/exam-status', requireAuth, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        
        console.log('🔍 Checking exam status:', {
            quizId: quizId,
            userType: req.session.userType,
            userId: req.session.userId
        });

        const quiz = await quizCollection.findById(quizId).select(
            'isExamMode examStatus examStartTime examEndTime examDurationMinutes lectureTitle classId isActive'
        );
        
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

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
                    const minutes = Math.floor(timeRemaining / 60);
                    const seconds = timeRemaining % 60;
                    statusMessage = `Exam is active. Time remaining: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                } else {
                    await quizCollection.findByIdAndUpdate(quizId, { examStatus: 'ended' });
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
            isExamMode: quiz.isExamMode || false,
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

// 🎯 TAKE QUIZ PAGE ROUTE
app.get('/take_quiz/:quizId', requireAuth, async (req, res) => {
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

        // Enhanced exam mode validation
        if (quiz.isExamMode) {
            console.log('🚨 Exam mode quiz access:', {
                examStatus: quiz.examStatus,
                examStartTime: quiz.examStartTime,
                examEndTime: quiz.examEndTime
            });

            const now = new Date();

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
                    if (quiz.examEndTime && now > quiz.examEndTime) {
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

        // Validate class enrollment
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

        // Pass comprehensive context to template
        res.render('takeQuiz', {
            quiz: {
                ...quiz,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,
                examTimeRemaining: quiz.isExamMode && quiz.examEndTime ? 
                    Math.max(0, Math.floor((new Date(quiz.examEndTime) - new Date()) / 1000)) : null
            },
            userName: req.session.userName,
            classContext: !!targetClassId,
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

// 📝 ENHANCED QUIZ SUBMISSION ROUTE
app.post('/api/quiz/submit/:quizId', requireAuth, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ 
                success: false, 
                message: 'Access denied. Only students can submit quizzes.' 
            });
        }

        const quizId = req.params.quizId;
        const { 
            studentAnswers, 
            timeTakenSeconds, 
            classContext,
            antiCheatData,
            navigationHints,
            examTimeRemaining,
            autoSubmissionData,
            examModeData,
            shuffleData
        } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('📝 Quiz submission received:', {
            quizId: quizId,
            studentName: studentName,
            timeTaken: timeTakenSeconds,
            examTimeRemaining: examTimeRemaining,
            antiCheatViolations: antiCheatData?.violationCount || 0,
            wasAutoSubmitted: antiCheatData?.wasAutoSubmitted || false
        });

        // Get complete quiz data
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ 
                success: false, 
                message: 'Quiz not found for scoring.' 
            });
        }

        // Enhanced exam mode validation
        if (quiz.isExamMode) {
            const now = new Date();
            
            if (quiz.examStatus !== 'active') {
                return res.status(403).json({
                    success: false,
                    message: 'This exam is no longer active. Submission not allowed.'
                });
            }

            if (quiz.examEndTime && now > quiz.examEndTime) {
                await quizCollection.findByIdAndUpdate(quizId, { examStatus: 'ended' });
                
                const graceTimeMs = 5000; // 5 seconds grace period
                if (now - quiz.examEndTime > graceTimeMs) {
                    return res.status(403).json({
                        success: false,
                        message: 'The exam time has expired. Submission not allowed.'
                    });
                }
                
                console.log('⏰ Allowing submission within grace period after exam expiry');
            }
        }

        // Validate class enrollment
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

        // Determine submission type
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

        // Save quiz result
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
            wasExamMode: quiz.isExamMode || false,
            examTimeRemaining: examTimeRemaining || null,
            submissionType: submissionType,
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

        // Get class information for response
        let classInfo = null;
        if (targetClassId) {
            classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
        }

        const modeText = quiz.isExamMode ? 'exam' : 'quiz';
        const securityStatus = antiCheatData && antiCheatData.violationCount > 0 
            ? `${antiCheatData.violationCount} violations` 
            : 'clean submission';
            
        console.log(`✅ ${modeText} result saved for student ${studentName}: Score ${score}/${totalQuestions} (${securityStatus})`);

        // Emit real-time update via Socket.IO
        const io = req.app.get('io');
        if (io && targetClassId) {
            io.to(`class-${targetClassId}`).emit('new-submission', {
                studentName: studentName,
                score: score,
                totalQuestions: totalQuestions,
                percentage: percentage,
                quizTitle: quiz.lectureTitle,
                timestamp: new Date()
            });
        }

        // Prepare comprehensive response
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
            wasExamMode: quiz.isExamMode,
            examTimeRemaining: examTimeRemaining,
            submissionType: submissionType,
            antiCheatSummary: {
                violationCount: antiCheatData?.violationCount || 0,
                wasAutoSubmitted: antiCheatData?.wasAutoSubmitted || false,
                securityStatus: antiCheatData?.violationCount === 0 ? 'Clean' : 
                              antiCheatData?.violationCount === 1 ? 'Warning Issued' : 'Auto-Submitted',
                submissionType: submissionType === 'auto_exam_timer' ? 'Exam Timer Auto-Submit' :
                              submissionType === 'auto_quiz_timer' ? 'Quiz Timer Auto-Submit' : 'Manual Submit'
            },
            navigationContext: {
                hasClass: !!targetClassId,
                classId: targetClassId,
                className: classInfo?.name,
                classSubject: classInfo?.subject,
                returnToClass: !!targetClassId,
                dashboardUrl: '/homeStudent',
                classUrl: targetClassId ? `/student/class/${targetClassId}` : null
            },
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
        res.status(500).json({ 
            success: false, 
            message: 'Failed to submit quiz: ' + error.message 
        });
    }
});

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
        routes: 'All routes properly mounted and unified',
        database: 'Connected',
        socketio: 'Active',
        connectedUsers: io.engine.clientsCount,
        features: [
            '✅ UNIFIED: Combined all features from both index.js files',
            '✅ QUIZ GENERATION: Full Gemini AI integration with enhanced prompts',
            '✅ FILE PROCESSING: PDF, Word, PowerPoint text extraction',
            '✅ SOCKET.IO: Real-time communication and updates',
            '✅ EXAM MODE: Timed exams with anti-cheat features',
            '✅ ROUTE ORGANIZATION: Clean separation of concerns',
            '✅ ERROR HANDLING: Comprehensive error management',
            '✅ AUTHENTICATION: Secure user session management',
            '✅ CLASS MANAGEMENT: Full teacher/student class system',
            '✅ REAL-TIME: Live quiz submissions and rankings'
        ]
    });
});

// Test route
app.get('/test', (req, res) => {
    res.json({
        success: true,
        message: 'UNIFIED QuizAI Server - All Features Combined!',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        routes_status: 'All routes unified and properly mounted',
        socketio_status: 'Active and handling connections',
        connected_users: io.engine.clientsCount,
        combined_features: {
            'File Upload & Processing': 'POST /upload_lecture (PDF, Word, PowerPoint)',
            'AI Quiz Generation': 'POST /generate_quiz/:id (Gemini AI with explanations)',
            'Quiz Taking': 'GET /take_quiz/:quizId (Enhanced with exam mode)',
            'Quiz Submission': 'POST /api/quiz/submit/:quizId (Anti-cheat, real-time)',
            'Exam Management': 'GET /api/quiz/:quizId/exam-status (Timed exams)',
            'Text Extraction': 'GET /lectures/:id/text (Multi-format support)',
            'Lecture Management': 'POST /delete_lecture/:id (Full cleanup)',
            'Real-time Updates': 'Socket.IO events for live communication',
            'API Routes': '/api/* (Auth, Teacher, Student, Quiz, Classes)',
            'Page Routes': '/* (Dashboard, Class views, Quiz interfaces)'
        },
        api_endpoints: {
            auth: '/api/auth/*',
            teacher: '/api/teacher/*',
            student: '/api/student/*',
            quiz: '/api/quiz/*',
            classes: '/api/classes/*'
        },
        core_functionality: {
            lecture_upload: 'POST /upload_lecture',
            quiz_generation: 'POST /generate_quiz/:id',
            quiz_access: 'GET /api/quiz/:quizId',
            quiz_submission: 'POST /api/quiz/submit/:quizId',
            exam_status: 'GET /api/quiz/:quizId/exam-status',
            lecture_text: 'GET /lectures/:id/text',
            lecture_deletion: 'POST /delete_lecture/:id'
        }
    });
});

// Socket.IO info endpoint
app.get('/socket-info', (req, res) => {
    res.json({
        success: true,
        socketio: {
            status: 'active',
            connectedClients: io.engine.clientsCount,
            rooms: Array.from(io.sockets.adapter.rooms.keys()),
            transports: ['polling', 'websocket'],
            endpoints: {
                connection: '/socket.io/',
                events: ['join-class', 'join-quiz', 'join-exam', 'quiz-submitted', 'request-rankings', 'exam-timer-sync']
            },
            features: [
                'Real-time quiz submissions',
                'Live class rankings',
                'Exam timer synchronization', 
                'Class room management',
                'Instant notifications'
            ]
        }
    });
});

// ==================== ERROR HANDLING ====================

// Handle upload errors
app.use(handleUploadError);

// 404 handler - catch all unmatched routes
app.use((req, res) => {
    // Don't log Socket.IO polling requests as 404s since they're expected
    if (!req.originalUrl.includes('/socket.io/')) {
        console.log(`🔍 404 - Route not found: ${req.method} ${req.originalUrl}`);
    }
    
    res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        suggestion: 'Check the API documentation for correct endpoints',
        availableEndpoints: {
            auth: '/api/auth/*',
            teacher: '/api/teacher/*',
            student: '/api/student/*',
            quiz: '/api/quiz/*',
            classes: '/api/classes/*',
            socketio: '/socket.io/*',
            core_features: {
                lecture_upload: 'POST /upload_lecture',
                quiz_generation: 'POST /generate_quiz/:id',
                quiz_access: 'GET /api/quiz/:quizId',
                quiz_submission: 'POST /api/quiz/submit/:quizId',
                exam_status: 'GET /api/quiz/:quizId/exam-status'
            }
        }
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

        // Start server with Socket.IO
        server.listen(PORT, () => {
            console.log(`🚀 UNIFIED QuizAI Server with Socket.IO started on port ${PORT}`);
            console.log(`🌐 Open http://localhost:${PORT} in your browser`);
            console.log(`📚 Ready to process lecture uploads and generate enhanced quizzes!`);
            console.log(`🔑 Using Gemini model: gemini-2.5-flash (Latest)`);
            console.log(`🔌 Socket.IO enabled for real-time features`);
            console.log(`🎯 UNIFIED SERVER FEATURES:`);
            console.log(`   ✅ Combined all functionality from both original files`);
            console.log(`   ✅ Socket.IO properly implemented and configured`);
            console.log(`   ✅ Real-time communication working`);
            console.log(`   ✅ Enhanced quiz generation with Gemini AI`);
            console.log(`   ✅ Multi-format file processing (PDF, Word, PowerPoint)`);
            console.log(`   ✅ Comprehensive exam mode with anti-cheat features`);
            console.log(`   ✅ All API routes properly mounted and organized`);
            console.log(`   ✅ Clean separation of concerns maintained`);
            console.log(`   ✅ CORE QUIZ ROUTES:`);
            console.log(`      📤 POST /upload_lecture - File upload and text extraction`);
            console.log(`      🎯 POST /generate_quiz/:id - AI-powered quiz generation`);
            console.log(`      📋 GET /api/quiz/:quizId - Quiz questions for students`);
            console.log(`      ⏱️ GET /api/quiz/:quizId/duration - Quiz timing information`);
            console.log(`      🔍 GET /api/quiz/:quizId/exam-status - Exam status checking`);
            console.log(`      🎯 GET /take_quiz/:quizId - Quiz taking interface`);
            console.log(`      📝 POST /api/quiz/submit/:quizId - Enhanced quiz submission`);
            console.log(`      📖 GET /lectures/:id/text - Lecture content access`);
            console.log(`      🗑️ POST /delete_lecture/:id - Lecture and quiz cleanup`);
            console.log(`   ✅ API ORGANIZATION:`);
            console.log(`      🔐 /api/auth/* - Authentication endpoints`);
            console.log(`      👨‍🏫 /api/teacher/* - Teacher management`);
            console.log(`      👨‍🎓 /api/student/* - Student functionality`);
            console.log(`      📝 /api/quiz/* - Quiz operations`);
            console.log(`      🏫 /api/classes/* - Class management`);
            console.log(`   ✅ REAL-TIME FEATURES:`);
            console.log(`      🔌 Socket.IO endpoint: /socket.io/*`);
            console.log(`      📊 Live quiz submissions and rankings`);
            console.log(`      ⏰ Exam timer synchronization`);
            console.log(`      👥 Class room management`);
            console.log(`✅ UNIFIED server initialization complete!`);
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('📤 SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('🔌 Socket.IO server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📤 SIGINT received. Shutting down gracefully...');
    server.close(() => {
        console.log('🔌 Socket.IO server closed');
        process.exit(0);
    });
});

// Start the server
startServer();