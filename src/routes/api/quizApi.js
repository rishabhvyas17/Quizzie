// routes/api/quizApi.js - COMPLETE FIXED VERSION WITH ALL MISSING ROUTES
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

// Import utility functions
const { formatTime } = require('../../utils/helpers');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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

// Helper function to format time
function formatExamTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
}

// ==================== EXAM STATUS AND SESSION ROUTES - CRITICAL MISSING ROUTES ====================

// 🆕 NEW: Check Exam Status Route (for students) - THIS WAS MISSING!
router.get('/:quizId/exam-status', requireAuth, async (req, res) => {
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

// Start exam session
router.post('/:quizId/start-exam', requireTeacher, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const { examDurationMinutes } = req.body;
        const teacherId = req.session.userId;

        console.log('🚨 Starting exam session:', { quizId, examDurationMinutes });

        // Get quiz and verify ownership
        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership through class
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
            examDurationMinutes: examDurationMinutes || 60
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
        console.error('❌ Error starting exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start exam session: ' + error.message
        });
    }
});

// End exam session
router.post('/:quizId/end-exam', requireTeacher, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const teacherId = req.session.userId;

        console.log('🛑 Ending exam session:', quizId);

        const quiz = await quizCollection.findById(quizId);
        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        // Verify ownership through class
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
        console.error('❌ Error ending exam session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end exam session: ' + error.message
        });
    }
});

// ==================== QUIZ TAKING APIs - FIXED ====================

// Get quiz for student (questions only, no answers) - FIXED PATH
router.get('/:quizId', requireStudent, async (req, res) => {
    try {
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

// Get quiz duration - FIXED PATH
router.get('/:quizId/duration', requireAuth, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🕐 DURATION API - Request for quiz:', quizId);

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

        console.log('🕐 DURATION API - Retrieved duration:', {
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

        console.log('🕐 DURATION API - Sending response:', responseData);

        res.json(responseData);

    } catch (error) {
        console.error('❌ Error fetching quiz duration:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quiz duration: ' + error.message
        });
    }
});

// Submit quiz - CRITICAL MISSING ROUTE FIXED!
router.post('/submit/:quizId', requireStudent, async (req, res) => {
    try {
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
            return res.status(404).json({ 
                success: false, 
                message: 'Quiz not found for scoring.' 
            });
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
        res.status(500).json({ 
            success: false, 
            message: 'Failed to submit quiz: ' + error.message 
        });
    }
});

// ==================== EXPLANATION ROUTES ====================

// Get enhanced explanation for wrong answers
router.post('/explanation', requireStudent, async (req, res) => {
    try {
        const { quizId, questionIndex, wrongAnswer } = req.body;

        console.log('Getting ENHANCED explanation for:', {
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

        console.log('Retrieved explanation:', {
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
        console.error('Error retrieving enhanced explanation:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve explanation: ' + error.message
        });
    }
});

// ==================== FILE UPLOAD & LECTURE MANAGEMENT ====================

// Upload lecture file and extract text
router.post('/upload_lecture', requireTeacher, upload.single('lectureFile'), validateUploadedFile, async (req, res) => {
    let tempFilePath = null;

    try {
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
        console.log('🗑️ Temporary file cleaned up after extraction.');

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
        console.error('❌ Error fetching lecture text:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        });
    }
});

// Delete lecture
router.post('/delete_lecture/:id', requireTeacher, async (req, res) => {
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

// ==================== QUIZ GENERATION ====================

// Generate quiz from lecture
router.post('/generate-quiz/:lectureId', requireTeacher, validateQuizGeneration, async (req, res) => {
    try {
        const lectureId = req.params.lectureId;
        const { durationMinutes, questionCount, isExamMode, examDurationMinutes } = req.body;

        console.log('🎯 QUIZ GENERATION REQUEST:', {
            lectureId: lectureId,
            durationMinutes: durationMinutes,
            questionCount: questionCount,
            isExamMode: isExamMode,
            examDurationMinutes: examDurationMinutes,
            requestedBy: req.session.userName
        });

        // Enhanced parameter validation
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

        // Handle exam mode settings
        if (isExamMode === true || isExamMode === 'true') {
            examMode = true;
            if (examDurationMinutes !== undefined && examDurationMinutes !== null) {
                const parsedExamDuration = parseInt(examDurationMinutes);
                if (!isNaN(parsedExamDuration) && parsedExamDuration >= 30 && parsedExamDuration <= 480) {
                    examWindowDuration = parsedExamDuration;
                }
            }
        }

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

        // AI prompt with exam mode context
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
            let generatedQuiz = null;
            try {
                quizContent = quizContent.trim();
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim();
                }

                generatedQuiz = JSON.parse(quizContent);

                // Strict validation
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array');
                }

                // Check if we got the right number of questions
                if (generatedQuiz.length !== questionsToGenerate) {
                    console.warn(`⚠️ AI generated ${generatedQuiz.length} questions, expected ${questionsToGenerate}`);
                    if (generatedQuiz.length > questionsToGenerate) {
                        generatedQuiz = generatedQuiz.slice(0, questionsToGenerate);
                        console.log(`✂️ Trimmed to ${questionsToGenerate} questions`);
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

                console.log('✅ ENHANCED quiz validated:', {
                    totalQuestions: generatedQuiz.length,
                    requestedQuestions: questionsToGenerate,
                    hasExplanations: !!generatedQuiz[0].explanations,
                    hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation,
                    actualDuration: customDuration,
                    questionsGenerated: generatedQuiz.length,
                    isExamMode: examMode
                });

            } catch (parseError) {
                console.error('❌ Failed to parse ENHANCED quiz JSON:', parseError);

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced AI response parsing failed: ' + parseError.message
                });

                return res.status(500).json({
                    success: false,
                    message: 'Failed to parse enhanced AI response. Please try again.'
                });
            }

            // Save quiz with exam mode settings
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
                // Exam mode fields
                isExamMode: examMode,
                examDurationMinutes: examMode ? examWindowDuration : null,
                examStatus: examMode ? 'scheduled' : null
            };

            console.log('💾 SAVING QUIZ WITH EXAM MODE SETTINGS:', {
                durationMinutes: newQuiz.durationMinutes,
                totalQuestions: newQuiz.totalQuestions,
                questionsArrayLength: newQuiz.questions.length,
                isExamMode: newQuiz.isExamMode,
                examDurationMinutes: newQuiz.examDurationMinutes
            });

            try {
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

                // Return comprehensive response with exam mode info
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
                    // Exam mode response data
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
                });

            } catch (saveError) {
                console.error('❌ Error saving ENHANCED quiz to MongoDB:', saveError);

                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced database save error: ' + saveError.message
                });

                return res.status(500).json({
                    success: false,
                    message: 'Failed to save enhanced quiz to database: ' + saveError.message
                });
            }

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

        if (req.params.lectureId) {
            await lectureCollection.findByIdAndUpdate(req.params.lectureId, {
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

// ==================== EXAM SESSIONS ROUTES ====================

// 🆕 NEW: Get active exam sessions for a class
router.get('/exam-sessions/active/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('🔥 Loading active exam sessions for class:', classId);

        // Verify class ownership
        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!classDoc) {
            return res.status(403).json({
                success: false,
                message: 'Access denied.'
            });
        }

        // Find all active exam sessions for this class
        const activeExams = await quizCollection.find({
            classId: classId,
            isExamMode: true,
            examStatus: 'active',
            examEndTime: { $gt: new Date() }, // Still has time remaining
            isActive: true
        }).select('_id lectureTitle examStartTime examEndTime examDurationMinutes').lean();

        console.log(`✅ Found ${activeExams.length} active exam sessions`);

        // Format sessions for response
        const sessions = activeExams.map(exam => ({
            quizId: exam._id,
            sessionId: exam._id, // Using quizId as sessionId for simplicity
            quizTitle: exam.lectureTitle,
            startsAt: exam.examStartTime,
            endsAt: exam.examEndTime,
            sessionDurationMinutes: exam.examDurationMinutes,
            timeRemaining: Math.max(0, Math.floor((new Date(exam.examEndTime) - new Date()) / 1000))
        }));

        res.json({
            success: true,
            sessions: sessions,
            totalActive: sessions.length
        });

    } catch (error) {
        console.error('❌ Error loading active exam sessions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load active exam sessions: ' + error.message
        });
    }
});

// ==================== EXAM SESSION MANAGEMENT ROUTES ====================

// 🚨 Start Exam Session API
router.post('/exam-session/start', requireTeacher, async (req, res) => {
    try {
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

// 🚨 End Exam Session API
router.post('/exam-session/end', requireTeacher, async (req, res) => {
    try {
        const { quizId } = req.body;
        const teacherId = req.session.userId;

        console.log('🛑 Ending exam session:', { quizId, teacherId });

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

        console.log('✅ Exam session ended successfully');

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

// 🚨 Get Exam Session Status API
router.get('/:quizId/exam-status', async (req, res) => {
    try {
        const quizId = req.params.quizId;

        console.log('📊 Getting exam status for quiz:', quizId);

        const quiz = await quizCollection.findById(quizId)
            .select('examSessionActive examSessionStartTime examSessionEndTime examSessionDuration lectureTitle')
            .lean();

        if (!quiz) {
            return res.status(404).json({
                success: false,
                message: 'Quiz not found.'
            });
        }

        const now = new Date();
        const isActive = quiz.examSessionActive && quiz.examSessionEndTime && new Date(quiz.examSessionEndTime) > now;
        const remainingSeconds = isActive ? Math.max(0, Math.floor((new Date(quiz.examSessionEndTime) - now) / 1000)) : 0;

        console.log('📊 Exam status:', {
            isActive,
            remainingSeconds,
            remainingMinutes: Math.floor(remainingSeconds / 60)
        });

        res.json({
            success: true,
            examSessionActive: isActive, // Field name expected by frontend
            remainingSeconds: remainingSeconds, // Field name expected by frontend
            examSession: {
                isActive: isActive,
                startTime: quiz.examSessionStartTime || null,
                endTime: quiz.examSessionEndTime || null,
                durationMinutes: quiz.examSessionDuration || null,
                quizTitle: quiz.lectureTitle,
                timeRemaining: remainingSeconds
            }
        });

    } catch (error) {
        console.error('❌ Error getting exam status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get exam status: ' + error.message
        });
    }
});

// Get quiz explanations status
router.get('/:quizId/explanations-status', requireAuth, async (req, res) => {
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

// Get enhanced explanation for a specific question/answer
router.post('/get', requireAuth, async (req, res) => {
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

// Get top 3 rankings for a specific quiz
router.get('/:quizId/rankings', requireAuth, async (req, res) => {
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

module.exports = router;