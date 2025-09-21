// controllers/teacherController.js
const crypto = require('crypto');
const { 
    teacherCollection,
    studentCollection,
    classCollection,
    classStudentCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection
} = require('../mongodb');
const { sendEmail } = require('../services/emailService');
const { renderEmailTemplate } = require('../utils/templateRenderer');

// Constants
const VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

class TeacherController {
    // Render teacher dashboard
    static renderDashboard = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
            }

            const teacherId = req.session.userId;

            const teacher = await teacherCollection.findById(teacherId).lean();
            if (!teacher) {
                return res.redirect('/login?error=Teacher profile not found. Please login again.');
            }

            // Check for email verification alert
            const showEmailVerificationAlert = teacher.email && !teacher.isVerified;

            // Get teacher's classes
            const classes = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).sort({ createdAt: -1 }).lean();

            // Calculate overall stats
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
                showEmailVerificationAlert: showEmailVerificationAlert,
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
            console.error('Error loading teacher dashboard:', error);
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
                showEmailVerificationAlert: false
            });
        }
    };

    // Render teacher profile page
    static renderProfile = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Not a teacher account.'));
            }

            const teacher = await teacherCollection.findById(req.session.userId)
                .select('name email isVerified firstName lastName')
                .lean();
            if (!teacher) {
                return res.redirect('/login?error=' + encodeURIComponent('Teacher profile not found. Please log in again.'));
            }

            const displayUserName = teacher.firstName ? `${teacher.firstName} ${teacher.lastName || ''}`.trim() : teacher.name;
            const initials = displayUserName ? displayUserName.split(' ').map(n => n.charAt(0)).join('').toUpperCase().substring(0, 2) : '';

            res.render('profileTeacher', {
                user: teacher,
                userName: displayUserName,
                userType: 'Professor',
                initials: initials,
                message: req.query.message,
                error: req.query.error
            });

        } catch (error) {
            console.error('Error loading teacher profile:', error);
            res.redirect('/homeTeacher?error=' + encodeURIComponent('Failed to load profile.'));
        }
    };

    // Update teacher profile
    static updateProfile = async (req, res) => {
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

            let emailChangeRequested = false;
            let nameChanged = false;

            // Handle Email Change Logic
            if (teacher.email !== email) {
                if (!email || !/.+@.+\..+/.test(email)) {
                    return res.redirect('/profileTeacher?error=' + encodeURIComponent('Please enter a valid email address format.'));
                }

                const existingTeacherWithEmail = await teacherCollection.findOne({ email: email, _id: { $ne: teacherId } });
                const existingStudentWithEmail = await studentCollection.findOne({ email: email });

                if (existingTeacherWithEmail || existingStudentWithEmail) {
                    return res.redirect('/profileTeacher?error=' + encodeURIComponent('This email is already registered to another account.'));
                }
                emailChangeRequested = true;
            }

            // Handle Name Change Logic
            if (teacher.firstName !== firstName || teacher.lastName !== lastName) {
                if (!firstName || firstName.trim() === '') {
                    return res.redirect('/profileTeacher?error=' + encodeURIComponent('First name is required.'));
                }
                nameChanged = true;
            }

            // Process Updates
            if (emailChangeRequested) {
                const newVerificationToken = crypto.randomBytes(32).toString('hex');
                const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
                const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

                const emailUserName = firstName || teacher.name;
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
                    teacher.pendingEmail = email;
                    teacher.isVerified = false;
                    teacher.verificationToken = newVerificationToken;
                    teacher.verificationTokenExpires = newVerificationTokenExpires;
                    if (nameChanged) {
                        teacher.firstName = firstName;
                        teacher.lastName = lastName;
                    }
                    await teacher.save();
                    return res.redirect('/profileTeacher?message=' + encodeURIComponent('A verification link has been sent to your new email address. Please click the link to confirm the change. Your profile name has been updated.'));
                } else {
                    console.error('Failed to send verification email for pending teacher email:', emailResult.message);
                    return res.redirect('/profileTeacher?error=' + encodeURIComponent(`Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`));
                }
            } else if (nameChanged) {
                teacher.firstName = firstName;
                teacher.lastName = lastName;
                await teacher.save();
                return res.redirect('/profileTeacher?message=' + encodeURIComponent('Profile updated successfully!'));
            } else {
                return res.redirect('/profileTeacher?message=' + encodeURIComponent('No changes detected in profile.'));
            }

        } catch (error) {
            console.error('Error updating teacher profile:', error);
            res.redirect('/profileTeacher?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
        }
    };

    // Render class management page
    static renderClassManagement = async (req, res) => {
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

            console.log(`Rendering class management page for: ${classDoc.name}`);

            res.render('classManagement', {
                classId: classId,
                className: classDoc.name,
                classSubject: classDoc.subject,
                userName: req.session.userName,
                userType: req.session.userType
            });

        } catch (error) {
            console.error('Error rendering class management page:', error);
            res.status(500).send('Failed to load class management page.');
        }
    };

    // Render lecture results page
    static renderLectureResults = async (req, res) => {
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
                .sort({ percentage: -1, timeTakenSeconds: 1 })
                .lean();

            // Format results with rankings
            const formattedResults = quizResults.map((result, index) => ({
                ...result,
                rank: index + 1,
                submissionDate: result.submissionDate.toLocaleString(),
                rankInClass: index + 1
            }));

            // Get class information if available
            let classInfo = null;
            if (lecture.classId) {
                classInfo = await classCollection.findById(lecture.classId).select('name subject').lean();
            }

            console.log(`Rendering lecture results for: ${lecture.title} (${formattedResults.length} results)`);

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
            console.error('Error fetching lecture results:', error);
            res.status(500).send('Failed to load quiz results: ' + error.message);
        }
    };

    // Render student analytics page
    static renderStudentAnalytics = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).redirect('/login?message=Access denied. Teachers only.');
            }

            const studentId = req.params.studentId;
            const classId = req.query.classId;
            const teacherId = req.session.userId;

            // Get student info
            const student = await studentCollection.findById(studentId).select('name enrollment').lean();
            if (!student) {
                return res.status(404).send('Student not found.');
            }

            // Class context verification and data
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
                    } else {
                        return res.status(403).send('Student is not enrolled in this class.');
                    }
                } else {
                    return res.status(403).send('Class not found or access denied.');
                }
            } else {
                // Check if teacher has access to student through any class
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
            }

            console.log(`Rendering analytics page for ${student.name}${classContext.className ? ` (${classContext.className})` : ''}`);

            res.render('studentAnalytics', {
                student: student,
                studentId: studentId,
                userName: req.session.userName,
                classContext: classContext
            });

        } catch (error) {
            console.error('Error rendering student analytics page:', error);
            res.status(500).send('Failed to load student analytics page.');
        }
    };

    // Redirect to student analytics with class context
    static redirectToStudentAnalytics = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).redirect('/login?message=Access denied. Teachers only.');
            }

            const { classId, studentId } = req.params;
            const teacherId = req.session.userId;

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

            console.log(`Redirecting to analytics for ${enrollment.studentName} in ${classDoc.name}`);

            res.redirect(`/teacher/student-analytics/${studentId}?classId=${classId}`);

        } catch (error) {
            console.error('Error accessing class student analytics:', error);
            res.status(500).redirect('/homeTeacher?message=Failed to access student analytics.');
        }
    };

    // Render about developers page
    static renderAboutDevelopers = (req, res) => {
        res.render('about-developers', {
            title: 'Meet Our Developers - Quizzie'
        });
    };
}

module.exports = TeacherController;