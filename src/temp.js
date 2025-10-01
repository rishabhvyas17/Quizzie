// ==================== ADD THESE ROUTES TO YOUR EXISTING index.js FILE ====================
// Add these routes AFTER your existing quiz routes but BEFORE the 404 handler

// 🔍 CRITICAL FIX: Exam Status Check Route - THIS WAS MISSING!
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

// 🎯 CRITICAL FIX: Take Quiz Page Route - ADD THIS IF MISSING
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

// 📝 CRITICAL FIX: Enhanced Quiz Submission Route - REPLACE YOUR EXISTING ONE
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

console.log('🔧 CRITICAL QUIZ ROUTES ADDED TO YOUR EXISTING INDEX.JS:');
console.log('   ✅ GET /api/quiz/:quizId/exam-status - Exam status checking (FIXED 404!)');
console.log('   ✅ GET /take_quiz/:quizId - Quiz page rendering');
console.log('   ✅ POST /api/quiz/submit/:quizId - Enhanced quiz submission (FIXED 404!)');
console.log('   🎯 All 404 errors should now be resolved with your existing structure!');

// ==================== END OF ROUTES TO ADD ====================