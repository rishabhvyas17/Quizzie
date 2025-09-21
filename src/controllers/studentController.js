// controllers/studentController.js
const crypto = require('crypto');
const { 
    studentCollection,
    teacherCollection,
    classCollection,
    classStudentCollection,
    quizCollection,
    quizResultCollection
} = require('../mongodb');
const { sendEmail } = require('../services/emailService');
const { renderEmailTemplate } = require('../utils/templateRenderer');

// Constants
const VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

class StudentController {
    // Render student dashboard
    static renderDashboard = async (req, res) => {
        try {
            // Get class context from query params
            const classContext = {
                classId: req.query.class || null,
                className: req.query.className || null,
                message: req.query.message || null
            };

            console.log('Student dashboard loaded with class-focused design');

            res.render("homeStudent", {
                userType: req.session.userType || "student",
                userName: req.session.userName || "Student",
                classContext: classContext,
                message: req.query.message,
                dashboardMode: 'class-focused'
            });
        } catch (error) {
            console.error('Error loading student dashboard:', error);
            res.render("homeStudent", {
                userType: req.session.userType || "student",
                userName: req.session.userName || "Student",
                error: 'Failed to load dashboard'
            });
        }
    };

    // Render student profile page
    static renderProfile = async (req, res) => {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Only students can view this profile.'));
        }

        try {
            const student = await studentCollection.findById(req.session.userId)
                .select('name email isVerified firstName lastName enrollment')
                .lean();
            if (!student) {
                return res.redirect('/login?error=' + encodeURIComponent('Student profile not found. Please log in again.'));
            }

            const displayUserName = student.firstName ? `${student.firstName} ${student.lastName || ''}`.trim() : student.name;
            const initials = displayUserName ? displayUserName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().substring(0, 2) : '';

            res.render('profileStudent', {
                user: student,
                userName: displayUserName,
                userType: 'student',
                initials: initials,
                message: req.query.message,
                error: req.query.error
            });
        } catch (error) {
            console.error('Error fetching student profile:', error);
            res.redirect('/homeStudent?error=' + encodeURIComponent('Error fetching profile data.'));
        }
    };

    // Update student profile
    static updateProfile = async (req, res) => {
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

            let emailChangeRequested = false;
            let nameChanged = false;

            // Handle Email Change Logic
            if (student.email !== email) {
                if (!email || !/.+@.+\..+/.test(email)) {
                    return res.redirect('/profileStudent?error=' + encodeURIComponent('Please enter a valid email address format.'));
                }

                // Check if new email already exists for another user
                const existingStudentWithEmail = await studentCollection.findOne({ email: email, _id: { $ne: userId } });
                const existingTeacherWithEmail = await teacherCollection.findOne({ email: email });

                if (existingStudentWithEmail || existingTeacherWithEmail) {
                    return res.redirect('/profileStudent?error=' + encodeURIComponent('This email is already registered to another account.'));
                }
                emailChangeRequested = true;
            }

            // Handle Name Change Logic
            if (student.firstName !== firstName || student.lastName !== lastName) {
                if (!firstName || firstName.trim() === '') {
                    return res.redirect('/profileStudent?error=' + encodeURIComponent('First name is required.'));
                }
                nameChanged = true;
            }

            // Process Updates
            if (emailChangeRequested) {
                const newVerificationToken = crypto.randomBytes(32).toString('hex');
                const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
                const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

                const emailUserName = firstName || student.name;
                const emailHtml = await renderEmailTemplate('verificationEmail', {
                    username: emailUserName,
                    verificationLink: verificationLink
                });

                const emailResult = await sendEmail({
                    to: email,
                    subject: 'Please Verify Your New Email for Quizzie',
                    html: emailHtml,
                    text: `Hello ${emailUserName}! Please verify your new email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
                });

                if (emailResult.success) {
                    student.pendingEmail = email;
                    student.isVerified = false;
                    student.verificationToken = newVerificationToken;
                    student.verificationTokenExpires = newVerificationTokenExpires;
                    if (nameChanged) {
                        student.firstName = firstName;
                        student.lastName = lastName;
                    }
                    await student.save();
                    return res.redirect('/profileStudent?message=' + encodeURIComponent('A verification link has been sent to your new email address. Please click the link to confirm the change. Your profile name has been updated.'));
                } else {
                    console.error('Failed to send verification email for pending student email:', emailResult.message);
                    return res.redirect('/profileStudent?error=' + encodeURIComponent(`Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`));
                }
            } else if (nameChanged) {
                student.firstName = firstName;
                student.lastName = lastName;
                await student.save();
                return res.redirect('/profileStudent?message=' + encodeURIComponent('Profile updated successfully!'));
            } else {
                return res.redirect('/profileStudent?message=' + encodeURIComponent('No changes detected in profile.'));
            }

        } catch (error) {
            console.error('Error updating student profile:', error);
            res.redirect('/profileStudent?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
        }
    };

    // Render quiz info page
    static renderQuizInfo = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).redirect('/login?message=Access denied. Only students can view quiz information.');
            }

            const quizId = req.params.quizId;
            const classId = req.query.classId;
            const studentId = req.session.userId;
            const studentName = req.session.userName;

            console.log('Quiz info page requested:', {
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

            console.log(`Rendering quiz info page: ${quiz.lectureTitle}`);

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
            console.error('Error rendering quiz info page:', error);
            res.status(500).redirect('/homeStudent?message=Failed to load quiz information.');
        }
    };

    // Render quiz taking page
    static renderTakeQuiz = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).redirect('/login?message=Access denied. Only students can take quizzes.');
            }

            const quizId = req.params.quizId;
            const classId = req.query.classId;

            console.log('Quiz access request:', {
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

            console.log(`Rendering take quiz page: ${quiz.lectureTitle} ${classInfo ? `(Class: ${classInfo.name})` : ''}`);

            // Pass comprehensive exam mode context to template
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
            console.error('Error rendering take quiz page:', error);
            res.status(500).send('Failed to load quiz page.');
        }
    };

    // Render quiz results page
    static renderQuizResults = (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).redirect('/login?message=Access denied. Only students can view quiz results.');
            }

            // Handle query parameters for better context
            const queryContext = {
                alreadyTaken: req.query.alreadyTaken === 'true',
                quizTitle: req.query.quizTitle || null,
                error: req.query.error || null,
                message: req.query.message || null,
                classId: req.query.classId || null,
                className: req.query.className || null,
                returnTo: req.query.returnTo || null
            };

            console.log('Quiz results page accessed with enhanced context:', {
                student: req.session.userName,
                queryContext: queryContext
            });

            res.render('quizResults', {
                userName: req.session.userName || 'Student',
                userType: req.session.userType || 'student',
                queryContext: queryContext,
                navigationHints: {
                    hasClassContext: !!queryContext.classId,
                    classId: queryContext.classId,
                    className: queryContext.className,
                    dashboardUrl: '/homeStudent',
                    classUrl: queryContext.classId ? `/student/class/${queryContext.classId}` : null
                }
            });

        } catch (error) {
            console.error('Error rendering quiz results page:', error);
            res.status(500).send('Failed to load quiz results page.');
        }
    };

    // Render detailed quiz results page
    static renderDetailedQuizResults = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).redirect('/login?message=Access denied. Students only.');
            }

            const resultId = req.params.resultId;
            const classId = req.query.classId;
            const studentId = req.session.userId;

            console.log('Rendering detailed quiz results page:', {
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

            console.log(`Rendering detailed results for: ${quiz ? quiz.lectureTitle : 'Unknown Quiz'}`);

            res.render('detailedQuizResults', {
                resultId: resultId,
                quizTitle: quiz ? quiz.lectureTitle : 'Quiz Results',
                userName: req.session.userName,
                userType: req.session.userType,
                classContext: {
                    hasClass: !!targetClassId,
                    classId: targetClassId,
                    className: classInfo ? classInfo.name : null,
                    classSubject: classInfo ? classInfo.subject : null
                },
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
            console.error('Error rendering detailed quiz results page:', error);
            res.status(500).redirect('/homeStudent?message=Failed to load detailed quiz results.');
        }
    };

    // Render student class view
    static renderClassView = async (req, res) => {
        try {
            if (req.session.userType !== 'student') {
                return res.status(403).redirect('/login?message=Access denied. Students only.');
            }

            const studentId = req.session.userId;
            const classId = req.params.classId;

            console.log(`Student class view access:`, {
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

            console.log(`Rendering class view for: ${classInfo.subject} - ${classInfo.name}`);

            res.render('studentClassView', {
                classId: classId,
                className: classInfo.name,
                classSubject: classInfo.subject,
                classDescription: classInfo.description,
                teacherName: teacher ? teacher.name : 'Unknown Teacher',
                userName: req.session.userName,
                userId: req.session.userId,
                userType: 'student',
                enrolledDate: enrollment.enrolledAt
            });

        } catch (error) {
            console.error('Error accessing student class view:', error);
            res.status(500).redirect('/homeStudent?message=Failed to access class information.');
        }
    };

    // Simple redirect for student class view (breadcrumb navigation)
    static redirectToClassView = async (req, res) => {
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

            console.log(`Student ${req.session.userName} accessing class: ${className}`);

            res.redirect(`/homeStudent?class=${classId}&className=${encodeURIComponent(className)}`);

        } catch (error) {
            console.error('Error accessing student class:', error);
            res.status(500).redirect('/homeStudent?message=Failed to access class information.');
        }
    };
}

module.exports = StudentController;