// routes/api/classApi.js
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../../middleware/authMiddleware');

// Import database collections
const {
    studentCollection,
    teacherCollection,
    classCollection,
    classStudentCollection,
    quizCollection,
    quizResultCollection,
    classJoinCodeCollection,
    classJoinRequestCollection
} = require('../../mongodb');

// Import utility functions
const { formatPercentage, calculateTimeEfficiency, calculateRankingPoints, calculateParticipationWeightedPoints, formatTime, getTimeAgo } = require('../../utils/helpers');

// Middleware to ensure teacher access
const requireTeacher = requireRole('teacher');
const requireStudent = requireRole('student');

// ==================== JOIN CODE MANAGEMENT APIs ====================

// Generate join code for class (teacher only)
router.post('/classes/:classId/generate-join-code', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('Generating join code for class:', {
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

        console.log('Join code generated:', {
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
        console.error('Error generating join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate join code: ' + error.message
        });
    }
});

// Get active join code for class (teacher only)
router.get('/classes/:classId/active-join-code', requireTeacher, async (req, res) => {
    try {
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
        console.error('Error fetching active join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch join code: ' + error.message
        });
    }
});

// Validate join code (student)
router.get('/classes/validate-join-code/:code', requireStudent, async (req, res) => {
    try {
        const joinCode = req.params.code.toUpperCase();
        const studentId = req.session.userId;

        console.log('Validating join code:', {
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

        console.log('Join code validated successfully:', {
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
        console.error('Error validating join code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to validate join code: ' + error.message
        });
    }
});

// ==================== JOIN REQUEST MANAGEMENT APIs ====================

// Submit join request (student)
router.post('/classes/join-request', requireStudent, async (req, res) => {
    try {
        const { joinCode } = req.body;
        const studentId = req.session.userId;
        const studentName = req.session.userName;

        console.log('Processing join request:', {
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

        // Check for ANY existing classStudentCollection entry (active or inactive)
        const existingClassStudentEntry = await classStudentCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingClassStudentEntry) {
            if (existingClassStudentEntry.isActive) {
                console.log('Student already actively enrolled in this class.');
                return res.status(400).json({
                    success: false,
                    message: 'You are already enrolled in this class.'
                });
            } else {
                // Reactivate inactive enrollment
                console.log('Reactivating inactive enrollment for student:', studentName, 'in class:', codeDoc.className);
                await classStudentCollection.findByIdAndUpdate(existingClassStudentEntry._id, {
                    isActive: true,
                    enrolledAt: new Date(),
                    studentName: studentName,
                    studentEnrollment: student.enrollment
                });

                // Update any pending/rejected join requests to 'approved'
                await classJoinRequestCollection.updateMany(
                    { classId: codeDoc.classId, studentId: studentId, status: { $in: ['pending', 'rejected'] } },
                    {
                        status: 'approved',
                        processedAt: new Date()
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

        // Check if student has ANY existing join request (pending or rejected)
        const existingJoinRequest = await classJoinRequestCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingJoinRequest) {
            console.log('Existing join request found (status:', existingJoinRequest.status, ')');
            if (existingJoinRequest.status === 'pending') {
                return res.status(400).json({
                    success: false,
                    message: 'You already have a pending request for this class. Please wait for the teacher\'s approval.'
                });
            } else if (existingJoinRequest.status === 'rejected') {
                // If a previous request was rejected, delete it to allow a new one
                console.log('Deleting previous rejected request to allow new submission.');
                await classJoinRequestCollection.deleteOne({ _id: existingJoinRequest._id });
            }
        }

        // Create new join request
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

        console.log('New join request created:', {
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
        console.error('Error submitting join request:', error);
        // Fallback for unexpected duplicate key errors
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'A request for this class already exists or you are already enrolled.'
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to submit join request: ' + error.message
        });
    }
});

// Get pending requests for class (teacher)
router.get('/classes/:classId/join-requests', requireTeacher, async (req, res) => {
    try {
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

        console.log(`Found ${pendingRequests.length} pending requests for class: ${classDoc.name}`);

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
        console.error('Error fetching join requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch join requests: ' + error.message
        });
    }
});

// Approve/reject join request (teacher)
router.post('/classes/:classId/join-requests/:requestId/:action', requireTeacher, async (req, res) => {
    try {
        const { classId, requestId, action } = req.params;
        const teacherId = req.session.userId;

        console.log('Processing join request action:', {
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
            // Check for ANY existing enrollment (active or inactive)
            const existingEnrollment = await classStudentCollection.findOne({
                classId: classId,
                studentId: joinRequest.studentId
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
                    // Reactivate existing inactive enrollment
                    console.log('Reactivating existing inactive enrollment for student:', joinRequest.studentName);

                    await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                        isActive: true,
                        enrolledAt: new Date(),
                        studentName: joinRequest.studentName,
                        studentEnrollment: joinRequest.studentEnrollment
                    });
                }
            } else {
                // No existing enrollment found, create new one
                console.log('Creating new enrollment for student:', joinRequest.studentName);

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

            console.log('Join request approved:', {
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

            console.log('Join request rejected:', {
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
        console.error('Error processing join request:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process join request: ' + error.message
        });
    }
});

// Get student's join request status
router.get('/student/join-request-status/:classId', requireStudent, async (req, res) => {
    try {
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
        console.error('Error fetching join request status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch request status: ' + error.message
        });
    }
});

// ==================== CLASS RANKINGS APIs ====================

// Get class rankings with participation weighting (teacher)
router.get('/classes/:classId/rankings', requireTeacher, async (req, res) => {
    try {
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

        // Calculate rankings with participation-weighted formula
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

                // Calculate participation rate
                const participationRate = totalQuizzesAvailable > 0
                    ? (studentResults.length / totalQuizzesAvailable) * 100
                    : 0;

                // Calculate base points and participation-weighted final points
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
                    basePoints: basePoints,
                    finalPoints: finalPoints,
                    averageTime: formatTime(averageTime),
                    rank: 0
                };
            })
        );

        // Sort by final points (participation-weighted)
        const rankedStudents = studentRankings
            .filter(student => student.totalQuizzes > 0)
            .sort((a, b) => b.finalPoints - a.finalPoints)
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        console.log(`Participation-weighted rankings generated: ${rankedStudents.length} students`);

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
        console.error('Error generating participation-weighted rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate rankings: ' + error.message
        });
    }
});

// Get last quiz rankings for class (teacher)
router.get('/classes/:classId/last-quiz-rankings', requireTeacher, async (req, res) => {
    try {
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

        // Find the most recently taken quiz by students (not created)
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

        // Get all student results for that specific quiz
        const quizResults = await quizResultCollection.find({
            quizId: latestResult.quizId,
            classId: classId
        }).lean();

        // Calculate rankings using the new points formula for that quiz
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

        console.log(`Last quiz rankings loaded: ${quiz.lectureTitle} with ${rankings.length} participants`);

        // Return quiz title and rankings
        res.json({
            success: true,
            data: {
                quizTitle: quiz.lectureTitle,
                quizDate: latestResult.submissionDate.toISOString().split('T')[0],
                rankings: rankings
            }
        });

    } catch (error) {
        console.error('Error loading last quiz rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load last quiz rankings: ' + error.message
        });
    }
});

// ==================== DEBUG ROUTES ====================

// Debug route to check active join codes
router.get('/debug/join-codes', requireTeacher, async (req, res) => {
    try {
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
        console.error('Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;