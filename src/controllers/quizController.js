// controllers/quizController.js
const { 
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection,
    classCollection,
    classStudentCollection
} = require('../mongodb');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

class QuizController {
    // Generate quiz from lecture content
    static generateQuiz = async (req, res) => {
        try {
            const lectureId = req.params.id;
            const { durationMinutes, questionCount, isExamMode, examDurationMinutes } = req.body;

            console.log('QUIZ GENERATION REQUEST:', {
                lectureId: lectureId,
                requestBody: req.body,
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

            console.log('FINAL QUIZ SETTINGS:', {
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

            console.log('ENHANCED AI Quiz Generation Started:', {
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

                console.log('Sending ENHANCED request to Gemini API...');

                const result = await model.generateContent({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig,
                    safetySettings,
                });

                const response = result.response;
                let quizContent = response.text();

                console.log('Received ENHANCED response from Gemini API');

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
                        console.warn(`AI generated ${generatedQuiz.length} questions, expected ${questionsToGenerate}`);
                        if (generatedQuiz.length > questionsToGenerate) {
                            generatedQuiz = generatedQuiz.slice(0, questionsToGenerate);
                            console.log(`Trimmed to ${questionsToGenerate} questions`);
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
                                console.warn(`Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                                q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                            }
                        });

                        q.explanations[q.correct_answer] = "";
                    });

                    console.log('ENHANCED quiz validated:', {
                        totalQuestions: generatedQuiz.length,
                        requestedQuestions: questionsToGenerate,
                        hasExplanations: !!generatedQuiz[0].explanations,
                        hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation,
                        actualDuration: customDuration,
                        questionsGenerated: generatedQuiz.length,
                        isExamMode: examMode
                    });

                } catch (parseError) {
                    console.error('Failed to parse ENHANCED quiz JSON:', parseError);

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

                console.log('SAVING QUIZ WITH EXAM MODE SETTINGS:', {
                    durationMinutes: newQuiz.durationMinutes,
                    totalQuestions: newQuiz.totalQuestions,
                    questionsArrayLength: newQuiz.questions.length,
                    isExamMode: newQuiz.isExamMode,
                    examDurationMinutes: newQuiz.examDurationMinutes
                });

                try {
                    const savedQuiz = await quizCollection.create(newQuiz);
                    console.log('ENHANCED quiz saved to database:', {
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
                    console.log(`ENHANCED ${quizTypeText} generation completed successfully for:`, lecture.title);

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
                    console.error('Error saving ENHANCED quiz to MongoDB:', saveError);

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
                console.error('ENHANCED Gemini API Error:', apiError);

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
            console.error('ENHANCED quiz generation error:', error);

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
    };

    // Get quiz questions for students
    static getQuizQuestions = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Access denied. Only students can access quiz questions.' 
                });
            }

            const quizId = req.params.quizId;
            console.log('QUIZ API - Loading quiz with duration:', quizId);

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

            console.log('QUIZ API - Retrieved quiz duration:', {
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

            console.log('QUIZ API - Sending response with duration:', {
                durationMinutes: responseData.quiz.durationMinutes,
                durationSeconds: responseData.quiz.durationSeconds,
                totalQuestions: responseData.quiz.totalQuestions
            });

            res.json(responseData);

        } catch (error) {
            console.error('Error fetching quiz for student:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Failed to load quiz questions.' 
            });
        }
    };

    // Get quiz duration
    static getQuizDuration = async (req, res) => {
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

            console.log('DURATION API - Sending response:', responseData);

            res.json(responseData);

        } catch (error) {
            console.error('Error fetching quiz duration:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch quiz duration: ' + error.message
            });
        }
    };

    // Submit quiz and calculate score
    static submitQuiz = async (req, res) => {
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
                examTimeRemaining
            } = req.body;

            const studentId = req.session.userId;
            const studentName = req.session.userName;

            console.log('Quiz submission received:', {
                quizId: quizId,
                studentId: studentId,
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

            // Handle exam mode submissions
            let examSessionData = null;
            let wasAutoSubmittedBySession = false;

            if (quiz.isExamMode) {
                // Enhanced exam mode validation
                if (quiz.examStatus !== 'active') {
                    return res.status(403).json({
                        success: false,
                        message: 'This exam is no longer active. Submission not allowed.'
                    });
                }

                if (quiz.examEndTime && new Date() > quiz.examEndTime) {
                    await quizCollection.findByIdAndUpdate(quizId, { examStatus: 'ended' });
                    
                    const graceTimeMs = 5000; // 5 seconds grace period
                    if (new Date() - quiz.examEndTime > graceTimeMs) {
                        return res.status(403).json({
                            success: false,
                            message: 'The exam time has expired. Submission not allowed.'
                        });
                    }
                    
                    console.log('Allowing submission within grace period after exam expiry');
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

            // Determine submission type for exam mode
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

            // Save quiz result with exam mode metadata
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

            // Enhanced logging with exam mode context
            const modeText = quiz.isExamMode ? 'exam' : 'quiz';
            const securityStatus = antiCheatData && antiCheatData.violationCount > 0 
                ? `${antiCheatData.violationCount} violations` 
                : 'clean submission';
                
            console.log(`${modeText} result saved for student ${studentName}: Score ${score}/${totalQuestions} (${securityStatus})`);

            // Get class information for response
            let classInfo = null;
            if (targetClassId) {
                classInfo = await classCollection.findById(targetClassId).select('name subject').lean();
            }

            // Prepare comprehensive response with exam mode context
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
                // Exam mode response data
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
            console.error('Error submitting quiz:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Failed to submit quiz: ' + error.message 
            });
        }
    };

    // Get enhanced explanation for wrong answers
    static getExplanation = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).json({ 
                    success: false, 
                    message: 'Access denied. Students only.' 
                });
            }

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
    };

    // Delete lecture and associated quizzes
    static deleteLecture = async (req, res) => {
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

            console.log('Lecture, quizzes, and results deleted:', lecture.title);

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
    };
}

module.exports = QuizController;