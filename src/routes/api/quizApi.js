// routes/api/quizApi.js - UPDATED WITH MISSING ROUTES
const express = require('express');
const router = express.Router();
const fs = require('fs');
const { requireAuth, requireRole } = require('../../middleware/authMiddleware');
const { upload, validateUploadedFile, cleanupTempFile } = require('../../middleware/uploadMiddleware');
const { validateQuizGeneration } = require('../../middleware/validationMiddleware');

// Import database collections
const {
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    classCollection,
    classStudentCollection,
    explanationCacheCollection
} = require('../../mongodb');

// Import AI service
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Import file processing services
const fileService = require('../../services/fileService');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Middleware
const requireTeacher = requireRole('teacher');
const requireStudent = requireRole('student');

// Helper function to get file type
const getFileType = (mimetype) => {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    };
    return typeMap[mimetype] || 'unknown';
};

// Helper function to extract text from files
const extractTextFromFile = async (filePath, mimetype) => {
    return await fileService.extractTextFromFile(filePath, mimetype);
};

// ==================== EXAM SESSION ROUTES - ADDED ====================

// Get active exam sessions for a class
router.get('/exam-sessions/active/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('Fetching active exam sessions for class:', classId);

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
        const activeExamSessions = await quizCollection.find({
            classId: classId,
            isExamMode: true,
            examStatus: 'active',
            isActive: true
        }).lean();

        const formattedSessions = activeExamSessions.map(session => ({
            quizId: session._id,
            lectureTitle: session.lectureTitle,
            examStartTime: session.examStartTime,
            examEndTime: session.examEndTime,
            examDurationMinutes: session.examDurationMinutes,
            participantCount: session.examSessionParticipants ? session.examSessionParticipants.length : 0,
            timeRemaining: session.examEndTime ? Math.max(0, Math.floor((new Date(session.examEndTime) - new Date()) / 1000)) : 0
        }));

        console.log(`✅ Found ${formattedSessions.length} active exam sessions for class ${classDoc.name}`);

        res.json({
            success: true,
            activeSessions: formattedSessions,
            totalActiveSessions: formattedSessions.length
        });

    } catch (error) {
        console.error('Error fetching active exam sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch active exam sessions: ' + error.message
        });
    }
});

// Start exam session
router.post('/exam-sessions/start/:quizId', requireTeacher, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const { examDurationMinutes } = req.body;
        const teacherId = req.session.userId;

        console.log('Starting exam session:', { quizId, examDurationMinutes });

        // Get quiz and verify ownership
        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify class ownership
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

        // Start the exam session
        const examStartTime = new Date();
        const examEndTime = new Date(examStartTime.getTime() + (examDurationMinutes || 60) * 60 * 1000);

        await quizCollection.findByIdAndUpdate(quizId, {
            isExamMode: true,
            examStatus: 'active',
            examStartTime: examStartTime,
            examEndTime: examEndTime,
            examDurationMinutes: examDurationMinutes || 60,
            examSessionParticipants: []
        });

        console.log(`✅ Exam session started for quiz: ${quiz.lectureTitle}`);

        res.json({
            success: true,
            message: 'Exam session started successfully!',
            examStartTime: examStartTime,
            examEndTime: examEndTime,
            examDurationMinutes: examDurationMinutes || 60
        });

    } catch (error) {
        console.error('Error starting exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam session: ' + error.message
        });
    }
});

// End exam session
router.post('/exam-sessions/end/:quizId', requireTeacher, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        console.log('Ending exam session:', quizId);

        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify class ownership
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

        // End the exam session
        await quizCollection.findByIdAndUpdate(quizId, {
            examStatus: 'ended'
        });

        console.log(`✅ Exam session ended for quiz: ${quiz.lectureTitle}`);

        res.json({
            success: true,
            message: 'Exam session ended successfully!'
        });

    } catch (error) {
        console.error('Error ending exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end exam session: ' + error.message
        });
    }
});

// ==================== FILE UPLOAD & LECTURE MANAGEMENT ====================

// Upload lecture file and extract text - FIXED ROUTE
router.post('/upload_lecture', requireTeacher, upload.single('lectureFile'), validateUploadedFile, async (req, res) => {
    let tempFilePath = null;

    try {
        const { title, classId } = req.body;
        const file = req.file;
        tempFilePath = file.path;

        console.log('Processing file for class:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path,
            classId: classId
        });

        const professorId = req.session.userId;
        const professorName = req.session.userName;

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

        console.log('Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        cleanupTempFile(tempFilePath);
        console.log('Temporary file cleaned up after extraction.');

        // Include class information in lecture data
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

        // Return structured response for API usage
        res.json({
            success: true,
            message: `Lecture uploaded successfully${className ? ` to class ${className}` : ''}!`,
            lectureId: savedLecture._id,
            title: savedLecture.title,
            className: className
        });

    } catch (error) {
        console.error('Upload processing error:', error);

        if (tempFilePath && fs.existsSync(tempFilePath)) {
            cleanupTempFile(tempFilePath);
        }

        res.status(500).json({
            success: false,
            message: 'Failed to process uploaded file: ' + error.message
        });
    }
});

// Get lecture text
router.get('/lectures/:id/text', requireAuth, async (req, res) => {
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
        console.error('Error fetching lecture text:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        });
    }
});

// Delete lecture
router.delete('/lectures/:id', requireTeacher, async (req, res) => {
    try {
        const lectureId = req.params.id;
        const lecture = await lectureCollection.findById(lectureId);

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            });
        }

        if (!lecture.professorId.equals(req.session.userId)) {
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

        console.log('✅ Lecture, quizzes, and results deleted:', lecture.title);

        res.json({
            success: true,
            message: 'Lecture deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting lecture:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete lecture'
        });
    }
});

// ==================== QUIZ GENERATION ====================

// Generate quiz from lecture
router.post('/generate-quiz/:lectureId', requireTeacher, validateQuizGeneration, async (req, res) => {
    try {
        const lectureId = req.params.lectureId;
        const { durationMinutes, questionCount, isExamMode, examDurationMinutes } = req.body;

        console.log('QUIZ GENERATION REQUEST:', {
            lectureId: lectureId,
            durationMinutes: durationMinutes,
            questionCount: questionCount,
            isExamMode: isExamMode,
            examDurationMinutes: examDurationMinutes,
            requestedBy: req.session.userName
        });

        const lecture = await lectureCollection.findById(lectureId);

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            });
        }

        // Check ownership
        if (!lecture.professorId.equals(req.session.userId)) {
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

        console.log('AI Quiz Generation Started:', {
            lectureTitle: lecture.title,
            duration: durationMinutes,
            questions: questionCount,
            examMode: isExamMode,
            examDuration: examDurationMinutes
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

        // AI prompt with exam mode context
        const examModeText = isExamMode ? 
            `This quiz will be used as a timed exam with a ${examDurationMinutes}-minute window. Generate challenging but fair questions appropriate for an exam setting.` :
            `This quiz will be used for regular practice and learning.`;

        const prompt = `
        You are an expert quiz generator and educational content creator. Create a comprehensive multiple-choice quiz with detailed explanations based on the following lecture content.

        **QUIZ CONTEXT:** ${examModeText}

        **CRITICAL REQUIREMENTS - MUST FOLLOW EXACTLY:**
        1. Generate EXACTLY ${questionCount} multiple-choice questions (NO MORE, NO LESS)
        2. Quiz duration is EXACTLY ${durationMinutes} minutes
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

        CRITICAL: Generate EXACTLY ${questionCount} questions for a ${durationMinutes}-minute quiz.`;

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

            console.log('Sending request to Gemini API...');

            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings,
            });

            const response = result.response;
            let quizContent = response.text();

            console.log('✅ Received response from Gemini API');

            // Parse and validate the AI response
            let generatedQuiz = null;
            try {
                quizContent = quizContent.trim();
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim();
                }

                generatedQuiz = JSON.parse(quizContent);

                // Validate response
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array');
                }

                // Check if we got the right number of questions
                if (generatedQuiz.length !== questionCount) {
                    console.warn(`⚠️ AI generated ${generatedQuiz.length} questions, expected ${questionCount}`);
                    if (generatedQuiz.length > questionCount) {
                        generatedQuiz = generatedQuiz.slice(0, questionCount);
                        console.log(`✂️ Trimmed to ${questionCount} questions`);
                    }
                }

                if (generatedQuiz.length === 0) {
                    throw new Error('No questions generated');
                }

                // Validate each question WITH explanations
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

                console.log('✅ Quiz validated:', {
                    totalQuestions: generatedQuiz.length,
                    requestedQuestions: questionCount,
                    hasExplanations: !!generatedQuiz[0]?.explanations,
                    hasCorrectExplanation: !!generatedQuiz[0]?.correctAnswerExplanation
                });

            } catch (parseError) {
                console.error('❌ Failed to parse quiz JSON:', parseError);

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'AI response parsing failed: ' + parseError.message
                });

                return res.status(500).json({
                    success: false,
                    message: 'Failed to parse AI response. Please try again.'
                });
            }

            // Save quiz with exam mode settings
            const newQuiz = {
                lectureId: lectureId,
                lectureTitle: lecture.title,
                durationMinutes: durationMinutes,
                questions: generatedQuiz,
                totalQuestions: generatedQuiz.length,
                generatedDate: new Date(),
                createdBy: req.session.userId,
                classId: lecture.classId || null,
                className: lecture.className || null,
                isActive: true,
                // Exam mode fields
                isExamMode: isExamMode,
                examDurationMinutes: isExamMode ? examDurationMinutes : null,
                examStatus: isExamMode ? 'scheduled' : null
            };

            try {
                const savedQuiz = await quizCollection.create(newQuiz);
                console.log('✅ Quiz saved to database:', savedQuiz._id);

                // Update lecture status
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    quizGenerated: true,
                    processingStatus: 'completed',
                    quizzesCount: 1,
                    lastProcessed: new Date()
                });

                const quizTypeText = isExamMode ? 'Timed exam' : 'Quiz';
                console.log(`✅ ${quizTypeText} generation completed successfully for:`, lecture.title);

                // Return comprehensive response with exam mode info
                res.json({
                    success: true,
                    message: `${quizTypeText} generated successfully with ${generatedQuiz.length} questions, ${durationMinutes} minutes duration${isExamMode ? `, and ${examDurationMinutes}-minute exam window` : ''}, and detailed explanations!`,
                    quizId: savedQuiz._id,
                    totalQuestions: generatedQuiz.length,
                    durationMinutes: durationMinutes,
                    durationSeconds: durationMinutes * 60,
                    title: lecture.title,
                    className: lecture.className,
                    explanationsGenerated: true,
                    // Exam mode response data
                    isExamMode: isExamMode,
                    examDurationMinutes: isExamMode ? examDurationMinutes : null,
                    examStatus: isExamMode ? 'scheduled' : null
                });

            } catch (saveError) {
                console.error('❌ Error saving quiz to MongoDB:', saveError);

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Database save error: ' + saveError.message
                });

                return res.status(500).json({
                    success: false,
                    message: 'Failed to save quiz to database: ' + saveError.message
                });
            }

        } catch (apiError) {
            console.error('❌ Gemini API Error:', apiError);

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'AI API Error: ' + apiError.message
            });

            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({
                    success: false,
                    message: 'API quota exceeded. Please try again later.'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Failed to generate quiz. Please check your API key and try again.'
            });
        }

    } catch (error) {
        console.error('❌ Quiz generation error:', error);

        if (req.params.lectureId) {
            await lectureCollection.findByIdAndUpdate(req.params.lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate quiz: ' + error.message
        });
    }
});

// ==================== QUIZ TAKING APIs ====================

// Get quiz for student (questions only, no answers)
router.get('/quiz/:quizId', requireStudent, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('QUIZ API - Loading quiz:', quizId);

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

        console.log('QUIZ API - Retrieved quiz:', {
            quizId: quizId,
            durationMinutes: actualDurationMinutes,
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

        res.json(responseData);

    } catch (error) {
        console.error('Error fetching quiz for student:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load quiz questions.' 
        });
    }
});

// Get quiz duration
router.get('/quiz/:quizId/duration', requireAuth, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('DURATION API - Request for quiz:', quizId);

        const quiz = await quizCollection.findById(quizId)
            .select('durationMinutes lectureTitle classId')
            .lean();

        if (!quiz) {
            console.error('DURATION API - Quiz not found:', quizId);
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        const actualDurationMinutes = quiz.durationMinutes || 15;
        const actualDurationSeconds = actualDurationMinutes * 60;

        console.log('DURATION API - Retrieved duration:', {
            quizId: quizId,
            durationMinutes: actualDurationMinutes,
            durationSeconds: actualDurationSeconds,
            lectureTitle: quiz.lectureTitle
        });

        const responseData = {
            success: true,
            durationMinutes: actualDurationMinutes,
            durationSeconds: actualDurationSeconds,
            lectureTitle: quiz.lectureTitle,
            classId: quiz.classId || null
        };

        res.json(responseData);

    } catch (error) {
        console.error('Error fetching quiz duration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quiz duration: ' + error.message
        });
    }
});

// Submit quiz
router.post('/quiz/submit/:quizId', requireStudent, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const { 
            studentAnswers, 
            timeTakenSeconds, 
            classContext,
            antiCheatData,
            navigationHints,
            examTimeRemaining
        } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('Quiz submission received:', {
            quizId: quizId,
            studentId: studentId,
            timeTaken: timeTakenSeconds,
            hasAntiCheatData: !!antiCheatData
        });

        // Get complete quiz data
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ 
                success: false, 
                message: 'Quiz not found for scoring.' 
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

        // Determine submission type
        let submissionType = 'manual';
        if (antiCheatData?.wasAutoSubmitted) {
            submissionType = 'auto_quiz_timer';
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
            antiCheatMetadata: antiCheatData ? {
                violationCount: antiCheatData.violationCount || 0,
                wasAutoSubmitted: antiCheatData.wasAutoSubmitted || false,
                gracePeriodsUsed: antiCheatData.gracePeriodsUsed || 0,
                securityStatus: antiCheatData.violationCount === 0 ? 'Clean' : 
                              antiCheatData.violationCount === 1 ? 'Warning' : 'Violation',
                submissionSource: antiCheatData.wasAutoSubmitted ? 'Auto-Submit' : 'Manual'
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

        console.log(`✅ Quiz result saved for student ${studentName}: Score ${score}/${totalQuestions}`);

        // Prepare response
        const enhancedResponse = {
            success: true,
            message: antiCheatData && antiCheatData.wasAutoSubmitted 
                ? 'Quiz auto-submitted and scored successfully!'
                : 'Quiz submitted and scored successfully!',
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
            antiCheatSummary: {
                violationCount: antiCheatData?.violationCount || 0,
                wasAutoSubmitted: antiCheatData?.wasAutoSubmitted || false,
                securityStatus: antiCheatData?.violationCount === 0 ? 'Clean' : 
                              antiCheatData?.violationCount === 1 ? 'Warning Issued' : 'Auto-Submitted',
                submissionType: antiCheatData?.wasAutoSubmitted ? 'Auto-Submit' : 'Manual Submit'
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
        console.error('Error submitting quiz:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to submit quiz: ' + error.message 
        });
    }
});

// Get enhanced explanation for wrong answers
router.post('/quiz/explanation', requireStudent, async (req, res) => {
    try {
        const { quizId, questionIndex, wrongAnswer } = req.body;

        console.log('Getting explanation for:', {
            quizId: quizId,
            questionIndex: questionIndex,
            wrongAnswer: wrongAnswer
        });

        // Get the quiz with enhanced explanations
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ 
                success: false, 
                message: 'Quiz not found.' 
            });
        }

        const question = quiz.questions[questionIndex];
        if (!question) {
            return res.status(404).json({ 
                success: false, 
                message: 'Question not found.' 
            });
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

            console.log('Retrieved detailed explanation for wrong answer:', wrongAnswer);
        } else {
            // Fallback explanation if detailed ones aren't available
            explanationType = 'basic';
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}.\n\n${question.correctAnswerExplanation}`;
            } else {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}. Please review the lecture material for detailed understanding.`;
            }

            console.log('Using fallback explanation - detailed explanation not found');
        }

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
        console.error('Error retrieving explanation:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve explanation: ' + error.message
        });
    }
});

module.exports = router;