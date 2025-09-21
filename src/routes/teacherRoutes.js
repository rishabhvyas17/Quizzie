// routes/teacherRoutes.js
const express = require('express');
const router = express.Router();
const { isAuthenticated, requireTeacher } = require('../middleware/authMiddleware');

// Import database collections
const {
    teacherCollection,
    classCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    classStudentCollection
} = require('../mongodb');

// Teacher dashboard
router.get('/homeTeacher', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
        }

        const teacherId = req.session.userId;

        const teacher = await teacherCollection.findById(teacherId).lean();
        if (!teacher) {
            return res.redirect('/login?error=Teacher profile not found. Please login again.');
        }

        // Determine if email is unverified and present for the alert
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
});

// Teacher profile page
router.get('/profileTeacher', isAuthenticated, async (req, res) => {
    console.log('GET /profileTeacher route hit');
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?error=' + encodeURIComponent('Access denied. Not a teacher account.'));
        }

        // Fetch teacher with name, email, verification status, AND firstName, lastName
        const teacher = await teacherCollection.findById(req.session.userId)
                                .select('name email isVerified firstName lastName')
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
        console.error('Error loading teacher profile:', error);
        res.redirect('/homeTeacher?error=' + encodeURIComponent('Failed to load profile.'));
    }
});

// Update teacher profile
router.post('/profileTeacher', isAuthenticated, async (req, res) => {
    console.log('POST /profileTeacher route hit');
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

        console.log('Old teacher name:', teacher.firstName, teacher.lastName, 'New teacher name:', firstName, lastName);
        console.log('Old teacher email:', teacher.email, 'New teacher email (submitted):', email);

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
                console.log('New email already in use by another account.');
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('This email is already registered to another account.'));
            }
            emailChangeRequested = true;
            console.log('Teacher email change requested. Old:', teacher.email, 'New:', email);
        }

        // Handle Name Change Logic
        if (teacher.firstName !== firstName || teacher.lastName !== lastName) {
            if (!firstName || firstName.trim() === '') {
                return res.redirect('/profileTeacher?error=' + encodeURIComponent('First name is required.'));
            }
            nameChanged = true;
            console.log('Teacher name has changed.');
        }

        // Process Updates
        if (emailChangeRequested) {
            const newVerificationToken = crypto.randomBytes(32).toString('hex');
            const newVerificationTokenExpires = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);
            const verificationLink = `${process.env.BASE_URL}/verify-email/${newVerificationToken}`;

            console.log('Attempting to send verification email for PENDING teacher email...');
            console.log('Verification Link:', verificationLink);

            const emailUserName = firstName || teacher.name;
            const emailHtml = await renderEmailTemplate('verificationEmail', {
                username: emailUserName,
                verificationLink: verificationLink
            });
            console.log('Email HTML rendered.');

            const emailResult = await sendEmail({
                to: email, // Send to the PENDING email
                subject: 'Please Verify Your New Email for Quizzie',
                html: emailHtml,
                text: `Hello ${emailUserName}! Please verify your new email for Quizzie by clicking: ${verificationLink}. This link expires in 24 hours.`
            });

            if (emailResult.success) {
                // Store pendingEmail and token, but do NOT update 'email' field yet
                teacher.pendingEmail = email;
                teacher.isVerified = false;
                teacher.verificationToken = newVerificationToken;
                teacher.verificationTokenExpires = newVerificationTokenExpires;
                // Update name fields immediately if they changed
                if (nameChanged) {
                    teacher.firstName = firstName;
                    teacher.lastName = lastName;
                }
                await teacher.save();
                console.log('Teacher profile saved with pending email and new name (if changed).');
                return res.redirect('/profileTeacher?message=' + encodeURIComponent('A verification link has been sent to your new email address. Please click the link to confirm the change. Your profile name has been updated.'));
            } else {
                console.error('Failed to send verification email for pending teacher email:', emailResult.message);
                return res.redirect('/profileTeacher?error=' + encodeURIComponent(`Failed to send verification email to new address: ${emailResult.message}. Your email has not been changed.`));
            }
        } else if (nameChanged) {
            // If only name changed, update name and save
            teacher.firstName = firstName;
            teacher.lastName = lastName;
            await teacher.save();
            console.log('Only teacher name updated and saved.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('Profile updated successfully!'));
        } else {
            console.log('No changes detected for teacher profile.');
            return res.redirect('/profileTeacher?message=' + encodeURIComponent('No changes detected in profile.'));
        }

    } catch (error) {
        console.error('Error updating teacher profile:', error);
        res.redirect('/profileTeacher?error=' + encodeURIComponent('An unexpected error occurred while updating profile: ' + error.message));
    }
});

// Class management page
router.get('/class/manage/:classId', isAuthenticated, async (req, res) => {
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
});

// Student analytics page
router.get('/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const studentId = req.params.studentId;
        const classId = req.query.classId; // Optional class context
        const teacherId = req.session.userId;

        console.log('Loading student analytics page:', {
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
                    console.log('Class context verified:', classContext.className);
                } else {
                    console.log('Student not enrolled in specified class');
                    return res.status(403).send('Student is not enrolled in this class.');
                }
            } else {
                console.log('Class not found or access denied');
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

            console.log('Teacher access to student verified through class enrollment');
        }

        console.log(`Rendering analytics page for ${student.name}${classContext.className ? ` (${classContext.className})` : ''}`);

        // Pass complete class context to template
        res.render('studentAnalytics', {
            student: student,
            studentId: studentId,
            userName: req.session.userName,
            classContext: classContext // Pass class context
        });

    } catch (error) {
        console.error('Error rendering student analytics page:', error);
        res.status(500).send('Failed to load student analytics page.');
    }
});

// Class-specific student analytics route
router.get('/class/:classId/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const { classId, studentId } = req.params;
        const teacherId = req.session.userId;

        console.log('Class-context student analytics access:', {
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

        console.log(`Redirecting to analytics for ${enrollment.studentName} in ${classDoc.name}`);

        // Redirect to student analytics with class context
        res.redirect(`/teacher/student-analytics/${studentId}?classId=${classId}`);

    } catch (error) {
        console.error('Error accessing class student analytics:', error);
        res.status(500).redirect('/homeTeacher?message=Failed to access student analytics.');
    }
});

// Lecture results page
router.get('/lecture_results/:lectureId', isAuthenticated, async (req, res) => {
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
});

module.exports = router;