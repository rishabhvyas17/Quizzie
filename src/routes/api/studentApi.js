// routes/api/studentApi.js
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../../middleware/authMiddleware');

// Import database collections
const {
    studentCollection,
    classCollection,
    classStudentCollection,
    quizCollection,
    quizResultCollection,
    classJoinCodeCollection,
    classJoinRequestCollection
} = require('../../mongodb');

// Middleware to ensure student access
const requireStudent = requireRole('student');

// ==================== DASHBOARD & PROFILE APIs ====================

// Get student performance data
router.get('/performance-data', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;

        // Get all quiz results for this student
        const studentResults = await quizResultCollection.find({
            studentId: studentId
        }).sort({ submissionDate: -1 }).lean();

        // Get all results for comparison
        const allResults = await quizResultCollection.find({}).lean();

        // Calculate statistics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0
            ? parseFloat((studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1))
            : 0;

        // Calculate overall class average
        const allScores = allResults.map(r => r.percentage);
        const classAverage = allScores.length > 0
            ? parseFloat((allScores.reduce((sum, score) => sum + score, 0) / allScores.length).toFixed(1))
            : 0;

        // Calculate student performances map
        const studentPerformances = {};
        allResults.forEach(result => {
            const id = result.studentId.toString();
            if (!studentPerformances[id]) {
                studentPerformances[id] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformances[id].scores.push(result.percentage);
            studentPerformances[id].totalQuizzes++;
        });

        // Calculate student performances with proper formatting
        const rankedStudents = Object.values(studentPerformances)
            .map(student => ({
                ...student,
                averageScore: parseFloat((student.scores.reduce((sum, score) => sum + score, 0) / student.scores.length).toFixed(1))
            }))
            .sort((a, b) => b.averageScore - a.averageScore);

        const top3Performers = rankedStudents.slice(0, 3).map((student, index) => ({
            rank: index + 1,
            name: student.studentName,
            averageScore: student.averageScore,
            totalQuizzes: student.totalQuizzes
        }));

        res.json({
            success: true,
            data: {
                studentStats: {
                    totalQuizzes: totalQuizzes,
                    averageScore: averageScore,
                    classAverage: classAverage
                },
                top3Performers: top3Performers,
                recentResults: studentResults.slice(0, 5).map(result => ({
                    score: parseFloat(result.percentage.toFixed(1)),
                    submissionDate: result.submissionDate,
                    timeTaken: result.timeTakenSeconds
                }))
            }
        });

    } catch (error) {
        console.error('Error loading student performance data:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load performance data: ' + error.message
        });
    }
});

// Get navigation context for student
router.get('/navigation-context', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;

        // Get student's enrolled classes for navigation
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        // Get class details
        const classIds = enrollments.map(e => e.classId);
        const classes = await classCollection.find({
            _id: { $in: classIds },
            isActive: true
        }).select('name subject').lean();

        const navigationClasses = classes.map(cls => ({
            classId: cls._id,
            className: cls.name,
            classSubject: cls.subject,
            url: `/student/class/${cls._id}`
        }));

        res.json({
            success: true,
            data: {
                enrolledClasses: navigationClasses,
                totalClasses: navigationClasses.length,
                dashboardUrl: '/homeStudent',
                studentName: req.session.userName
            }
        });

    } catch (error) {
        console.error('Error getting navigation context:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get navigation context: ' + error.message
        });
    }
});

// ==================== CLASS ENROLLMENT APIs ====================

// Get enrolled classes
router.get('/enrolled-classes', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;

        // Get classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                classes: [],
                message: 'No enrolled classes found.'
            });
        }

        // Get class details and student's performance in each class
        const enrolledClasses = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get class details
                const classDetails = await classCollection.findById(enrollment.classId).lean();

                if (!classDetails) {
                    return null; // Skip if class doesn't exist
                }

                // Get teacher name
                const teacher = await teacherCollection.findById(classDetails.teacherId).select('name').lean();

                // Get available quizzes for this class
                const availableQuizzes = await quizCollection.countDocuments({
                    classId: enrollment.classId,
                    isActive: true
                });

                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: studentId,
                    classId: enrollment.classId
                }).lean();

                // Calculate student's stats for this class
                const quizzesTaken = studentResults.length;
                const averageScore = quizzesTaken > 0
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / quizzesTaken).toFixed(1)
                    : 0;

                return {
                    classId: classDetails._id,
                    className: classDetails.name,
                    classSubject: classDetails.subject,
                    classDescription: classDetails.description,
                    teacherName: teacher ? teacher.name : 'Unknown Teacher',
                    enrolledAt: enrollment.enrolledAt,
                    // Student's performance in this class
                    quizzesTaken: quizzesTaken,
                    averageScore: parseFloat(averageScore),
                    availableQuizzes: availableQuizzes,
                    // Additional stats for dashboard
                    totalQuizScore: quizzesTaken > 0 ? studentResults.reduce((sum, result) => sum + result.percentage, 0) : 0,
                    hasRecentActivity: availableQuizzes > 0 || quizzesTaken > 0
                };
            })
        );

        // Filter out null values (deleted classes)
        const validClasses = enrolledClasses.filter(cls => cls !== null);

        console.log(`Found ${validClasses.length} enrolled classes for student ${req.session.userName}`);

        res.json({
            success: true,
            classes: validClasses,
            totalClasses: validClasses.length,
            // Overall student stats across all classes
            overallStats: {
                totalClasses: validClasses.length,
                totalQuizAttempts: validClasses.reduce((sum, cls) => sum + cls.quizzesTaken, 0),
                overallAverage: validClasses.length > 0 ?
                    (validClasses.reduce((sum, cls) => sum + cls.totalQuizScore, 0) /
                        validClasses.reduce((sum, cls) => sum + cls.quizzesTaken, 0)).toFixed(1) : 0,
                activeClasses: validClasses.filter(cls => cls.hasRecentActivity).length
            }
        });

    } catch (error) {
        console.error('Error fetching enrolled classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enrolled classes: ' + error.message
        });
    }
});

// ==================== QUIZ ACCESS APIs ====================

// Get available quizzes for student
router.get('/available-quizzes', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;

        // Get all classes the student is enrolled in
        const enrollments = await classStudentCollection.find({
            studentId: studentId,
            isActive: true
        }).lean();

        if (enrollments.length === 0) {
            return res.json({
                success: true,
                quizzes: [],
                message: 'Not enrolled in any classes.'
            });
        }

        const enrolledClassIds = enrollments.map(e => e.classId);

        // Get all available quizzes from enrolled classes
        const availableQuizzes = await quizCollection.find({
            classId: { $in: enrolledClassIds },
            isActive: true
        })
            .select('lectureTitle totalQuestions classId generatedDate')
            .sort({ generatedDate: -1 })
            .lean();

        // Get quizzes already taken by student
        const takenQuizIds = await quizResultCollection.find({
            studentId: studentId
        }).distinct('quizId');

        // Filter out taken quizzes and add class information
        const quizzesWithClassInfo = await Promise.all(
            availableQuizzes
                .filter(quiz => !takenQuizIds.includes(quiz._id.toString()))
                .map(async (quiz) => {
                    const classInfo = await classCollection.findById(quiz.classId).select('name subject').lean();
                    return {
                        _id: quiz._id,
                        lectureTitle: quiz.lectureTitle,
                        totalQuestions: quiz.totalQuestions,
                        generatedDate: quiz.generatedDate,
                        classId: quiz.classId,
                        className: classInfo ? classInfo.name : 'Unknown Class',
                        classSubject: classInfo ? classInfo.subject : 'Unknown Subject'
                    };
                })
        );

        console.log(`Found ${quizzesWithClassInfo.length} available quizzes across all enrolled classes`);

        res.json({
            success: true,
            quizzes: quizzesWithClassInfo,
            totalQuizzes: quizzesWithClassInfo.length
        });

    } catch (error) {
        console.error('Error fetching available quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load available quizzes: ' + error.message
        });
    }
});

// ==================== CLASS-SPECIFIC APIs ====================

// Get class overview for student
router.get('/class/:classId/overview', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get class information
        const classInfo = await classCollection.findById(classId).lean();
        if (!classInfo) {
            return res.status(404).json({
                success: false,
                message: 'Class not found.'
            });
        }

        // Get teacher information
        const teacher = await teacherCollection.findById(classInfo.teacherId).select('name').lean();

        // Get total students in class
        const totalStudents = await classStudentCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        // Calculate student's progress in this class
        const availableQuizzes = await quizCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        const completedQuizzes = await quizResultCollection.countDocuments({
            studentId: studentId,
            classId: classId
        });

        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).lean();

        const averageScore = studentResults.length > 0
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / studentResults.length).toFixed(1)
            : 0;

        const completionRate = availableQuizzes > 0
            ? ((completedQuizzes / availableQuizzes) * 100).toFixed(1)
            : 0;

        console.log(`Class overview generated for student ${req.session.userName} in ${classInfo.name}`);

        res.json({
            success: true,
            data: {
                classInfo: {
                    name: classInfo.name,
                    subject: classInfo.subject,
                    description: classInfo.description,
                    teacherName: teacher ? teacher.name : 'Unknown Teacher',
                    totalStudents: totalStudents
                },
                studentProgress: {
                    enrolledDate: enrollment.enrolledAt,
                    completedQuizzes: completedQuizzes,
                    totalQuizzes: availableQuizzes,
                    availableQuizzes: availableQuizzes - completedQuizzes,
                    averageScore: parseFloat(averageScore),
                    completionRate: parseFloat(completionRate)
                }
            }
        });

    } catch (error) {
        console.error('Error generating class overview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate class overview: ' + error.message
        });
    }
});

// Get all quizzes for a class (available + completed)
router.get('/class/:classId/all-quizzes', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;
        const classId = req.params.classId;

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get all quizzes for this class
        const allQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        })
            .sort({ generatedDate: -1 })
            .lean();

        // Get student's results for this class
        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        }).lean();

        // Create a map of quiz results
        const resultMap = {};
        studentResults.forEach(result => {
            resultMap[result.quizId.toString()] = result;
        });

        // Helper function to calculate time ago
        const getTimeAgo = (date) => {
            const now = new Date();
            const diffInMs = now - new Date(date);
            const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
            const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
            const diffInMinutes = Math.floor(diffInMs / (1000 * 60));

            if (diffInDays > 7) {
                return new Date(date).toLocaleDateString();
            } else if (diffInDays > 0) {
                return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
            } else if (diffInHours > 0) {
                return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
            } else if (diffInMinutes > 0) {
                return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
            } else {
                return 'Just now';
            }
        };

        // Helper function to format time
        const formatTime = (seconds) => {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
        };

        // Categorize quizzes
        const availableQuizzes = [];
        const completedQuizzes = [];

        allQuizzes.forEach(quiz => {
            const timeAgo = getTimeAgo(quiz.generatedDate);
            const quizData = {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                generatedDate: quiz.generatedDate,
                timeAgo: timeAgo
            };

            if (resultMap[quiz._id.toString()]) {
                // Quiz completed
                const result = resultMap[quiz._id.toString()];
                completedQuizzes.push({
                    ...quizData,
                    status: 'completed',
                    studentResult: {
                        resultId: result._id,
                        score: result.score,
                        percentage: result.percentage.toFixed(1),
                        timeTaken: formatTime(result.timeTakenSeconds),
                        submissionDate: result.submissionDate
                    }
                });
            } else {
                // Quiz available
                availableQuizzes.push({
                    ...quizData,
                    status: 'available'
                });
            }
        });

        console.log(`All quizzes loaded for class ${classId}: ${availableQuizzes.length} available, ${completedQuizzes.length} completed`);

        res.json({
            success: true,
            data: {
                allQuizzes: [...availableQuizzes, ...completedQuizzes],
                availableQuizzes: availableQuizzes,
                completedQuizzes: completedQuizzes,
                totalAvailable: availableQuizzes.length,
                totalCompleted: completedQuizzes.length
            }
        });

    } catch (error) {
        console.error('Error loading all quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load quizzes: ' + error.message
        });
    }
});

// Get class analytics for student
router.get('/class/:classId/analytics', requireStudent, async (req, res) => {
    try {
        const studentId = req.session.userId;
        const classId = req.params.classId;

        console.log('Loading student class analytics:', {
            studentId: studentId,
            classId: classId,
            student: req.session.userName
        });

        // Verify student enrollment
        const enrollment = await classStudentCollection.findOne({
            studentId: studentId,
            classId: classId,
            isActive: true
        });

        if (!enrollment) {
            return res.status(403).json({
                success: false,
                message: 'You are not enrolled in this class.'
            });
        }

        // Get student's results for this class
        const studentResults = await quizResultCollection.find({
            studentId: studentId,
            classId: classId
        })
        .sort({ submissionDate: -1 })
        .lean();

        // Get all class results for comparison
        const allClassResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Get class quizzes for quiz titles
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // Create quiz map for titles
        const quizMap = {};
        classQuizzes.forEach(quiz => {
            quizMap[quiz._id.toString()] = quiz.lectureTitle;
        });

        // Calculate averages
        const studentAverage = studentResults.length > 0 
            ? parseFloat((studentResults.reduce((sum, result) => sum + result.percentage, 0) / studentResults.length).toFixed(1))
            : 0;

        const classAverage = allClassResults.length > 0 
            ? parseFloat((allClassResults.reduce((sum, result) => sum + result.percentage, 0) / allClassResults.length).toFixed(1))
            : 0;

        // Prepare chart data
        const chartData = {
            // Score trends chart
            scoreTrends: {
                labels: studentResults.slice(0, 10).reverse().map(result => {
                    return new Date(result.submissionDate).toLocaleDateString();
                }),
                datasets: [{
                    label: 'Your Scores',
                    data: studentResults.slice(0, 10).reverse().map(result => result.percentage),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.4,
                    fill: true,
                    pointBackgroundColor: '#3b82f6',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6
                }, {
                    label: 'Class Average',
                    data: studentResults.slice(0, 10).reverse().map(() => classAverage),
                    borderColor: '#64748b',
                    backgroundColor: 'transparent',
                    borderDash: [5, 5],
                    tension: 0,
                    pointRadius: 0
                }]
            },

            // Performance breakdown pie chart
            performanceBreakdown: {
                labels: ['Excellent (90%+)', 'Good (70-89%)', 'Average (50-69%)', 'Needs Improvement (<50%)'],
                datasets: [{
                    data: [
                        studentResults.filter(r => r.percentage >= 90).length,
                        studentResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                        studentResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                        studentResults.filter(r => r.percentage < 50).length
                    ],
                    backgroundColor: [
                        '#10b981', // Green for excellent
                        '#3b82f6', // Blue for good
                        '#f59e0b', // Yellow for average
                        '#ef4444'  // Red for needs improvement
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },

            // Time analysis bar chart
            timeAnalysis: {
                labels: studentResults.slice(0, 8).reverse().map(result => {
                    const quizTitle = quizMap[result.quizId.toString()] || 'Quiz';
                    return quizTitle.length > 15 ? quizTitle.substring(0, 15) + '...' : quizTitle;
                }),
                datasets: [{
                    label: 'Time Taken (minutes)',
                    data: studentResults.slice(0, 8).reverse().map(result => Math.round(result.timeTakenSeconds / 60)),
                    backgroundColor: 'rgba(139, 92, 246, 0.6)',
                    borderColor: '#8b5cf6',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            }
        };

        console.log(`Analytics prepared for ${req.session.userName}:`, {
            studentResultsCount: studentResults.length,
            studentAverage: studentAverage,
            classAverage: classAverage
        });

        res.json({
            success: true,
            data: {
                chartData: chartData,
                performanceMetrics: {
                    totalQuizzes: studentResults.length,
                    studentAverage: studentAverage,
                    classAverage: classAverage,
                    averageTime: studentResults.length > 0 
                        ? Math.round(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / studentResults.length)
                        : 0
                }
            }
        });

    } catch (error) {
        console.error('Error generating student class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate analytics: ' + error.message
        });
    }
});

module.exports = router;