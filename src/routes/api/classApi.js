// routes/api/classApi.js - COMPLETE FIXED VERSION WITH ALL MISSING ROUTES
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

// ==================== UNIFIED CLASS MANAGEMENT APIs ====================

// Get classes based on user type
router.get('/', requireAuth, async (req, res) => {
    try {
        const userType = req.session.userType;
        const userId = req.session.userId;

        console.log('Unified classes API accessed:', {
            userType: userType,
            userId: userId,
            userName: req.session.userName
        });

        if (userType === 'teacher') {
            // Get teacher's classes
            const classes = await classCollection.find({
                teacherId: userId,
                isActive: true
            }).sort({ createdAt: -1 }).lean();

            console.log(`Found ${classes.length} classes for teacher ${req.session.userName}`);

            const formattedClasses = classes.map(classDoc => ({
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: classDoc.studentCount || 0,
                lectureCount: classDoc.lectureCount || 0,
                quizCount: classDoc.quizCount || 0,
                averageScore: classDoc.averageScore || 0,
                createdAt: classDoc.createdAt,
                updatedAt: classDoc.updatedAt
            }));

            res.json({
                success: true,
                classes: formattedClasses,
                totalClasses: formattedClasses.length,
                userType: 'teacher'
            });

        } else if (userType === 'student') {
            // Get student's enrolled classes
            const enrollments = await classStudentCollection.find({
                studentId: userId,
                isActive: true
            }).lean();

            if (enrollments.length === 0) {
                return res.json({
                    success: true,
                    classes: [],
                    totalClasses: 0,
                    userType: 'student',
                    message: 'No enrolled classes found.'
                });
            }

            const classIds = enrollments.map(e => e.classId);
            const classes = await classCollection.find({
                _id: { $in: classIds },
                isActive: true
            }).lean();

            // Get student's performance in each class
            const enrolledClasses = await Promise.all(
                classes.map(async (cls) => {
                    const enrollment = enrollments.find(e => 
                        e.classId.toString() === cls._id.toString()
                    );

                    const studentResults = await quizResultCollection.find({
                        studentId: userId,
                        classId: cls._id
                    }).lean();

                    const availableQuizzes = await quizCollection.countDocuments({
                        classId: cls._id,
                        isActive: true
                    });

                    const quizzesTaken = studentResults.length;
                    const averageScore = quizzesTaken > 0
                        ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / quizzesTaken)
                        : 0;

                    return {
                        id: cls._id,
                        name: cls.name,
                        subject: cls.subject,
                        description: cls.description,
                        enrolledAt: enrollment.enrolledAt,
                        quizzesTaken: quizzesTaken,
                        averageScore: parseFloat(averageScore.toFixed(1)),
                        availableQuizzes: availableQuizzes,
                        completionRate: availableQuizzes > 0 ? 
                            parseFloat(((quizzesTaken / availableQuizzes) * 100).toFixed(1)) : 0
                    };
                })
            );

            console.log(`Found ${enrolledClasses.length} enrolled classes for student ${req.session.userName}`);

            res.json({
                success: true,
                classes: enrolledClasses,
                totalClasses: enrolledClasses.length,
                userType: 'student'
            });

        } else {
            return res.status(403).json({
                success: false,
                message: 'Invalid user type'
            });
        }

    } catch (error) {
        console.error('Error in unified classes API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch classes: ' + error.message
        });
    }
});

// Create new class (teacher only)
router.post('/', requireTeacher, async (req, res) => {
    try {
        const { name, subject, description } = req.body;
        const teacherId = req.session.userId;
        const teacherName = req.session.userName;

        console.log('Creating new class:', {
            name: name,
            subject: subject,
            teacherId: teacherId,
            teacherName: teacherName
        });

        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        // Check if class name already exists for this teacher
        const existingClass = await classCollection.findOne({
            teacherId: teacherId,
            name: name.trim(),
            isActive: true
        });

        if (existingClass) {
            return res.status(400).json({
                success: false,
                message: 'You already have a class with this name.'
            });
        }

        // Create new class
        const newClass = await classCollection.create({
            name: name.trim(),
            subject: subject.trim(),
            description: description?.trim() || '',
            teacherId: teacherId,
            teacherName: teacherName,
            studentCount: 0,
            lectureCount: 0,
            quizCount: 0,
            averageScore: 0
        });

        console.log(`✅ New class created: ${newClass.name} by ${teacherName}`);

        res.json({
            success: true,
            message: 'Class created successfully!',
            class: {
                id: newClass._id,
                name: newClass.name,
                subject: newClass.subject,
                description: newClass.description,
                studentCount: 0,
                lectureCount: 0,
                quizCount: 0,
                averageScore: 0,
                createdAt: newClass.createdAt
            }
        });

    } catch (error) {
        console.error('Error creating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create class: ' + error.message
        });
    }
});

// Get specific class details
router.get('/:classId', requireAuth, async (req, res) => {
    try {
        const classId = req.params.classId;
        const userId = req.session.userId;
        const userType = req.session.userType;

        const classDoc = await classCollection.findOne({
            _id: classId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found.'
            });
        }

        // Check access permissions
        if (userType === 'teacher') {
            if (classDoc.teacherId.toString() !== userId.toString()) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You do not own this class.'
                });
            }
        } else if (userType === 'student') {
            const enrollment = await classStudentCollection.findOne({
                studentId: userId,
                classId: classId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You are not enrolled in this class.'
                });
            }
        }

        res.json({
            success: true,
            class: {
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: classDoc.studentCount || 0,
                lectureCount: classDoc.lectureCount || 0,
                quizCount: classDoc.quizCount || 0,
                averageScore: classDoc.averageScore || 0,
                createdAt: classDoc.createdAt,
                updatedAt: classDoc.updatedAt
            }
        });

    } catch (error) {
        console.error('Error fetching class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class: ' + error.message
        });
    }
});

// Update class information (teacher only)
router.put('/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { name, subject, description } = req.body;

        if (!name || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Class name and subject are required.'
            });
        }

        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        const updatedClass = await classCollection.findByIdAndUpdate(
            classId,
            {
                name: name.trim(),
                subject: subject.trim(),
                description: description?.trim() || '',
                updatedAt: new Date()
            },
            { new: true }
        ).lean();

        console.log(`Class updated: ${updatedClass.name}`);

        res.json({
            success: true,
            message: 'Class updated successfully!',
            class: {
                id: updatedClass._id,
                name: updatedClass.name,
                subject: updatedClass.subject,
                description: updatedClass.description,
                studentCount: updatedClass.studentCount || 0,
                lectureCount: updatedClass.lectureCount || 0,
                quizCount: updatedClass.quizCount || 0,
                averageScore: updatedClass.averageScore || 0,
                updatedAt: updatedClass.updatedAt
            }
        });

    } catch (error) {
        console.error('Error updating class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update class: ' + error.message
        });
    }
});

// Archive/Delete class
router.delete('/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        const existingClass = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        });

        if (!existingClass) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Soft delete - mark as inactive
        await classCollection.findByIdAndUpdate(classId, {
            isActive: false,
            updatedAt: new Date()
        });

        // Also mark class students as inactive
        await classStudentCollection.updateMany(
            { classId: classId },
            { isActive: false }
        );

        console.log(`✅ Class archived: ${existingClass.name}`);

        res.json({
            success: true,
            message: 'Class archived successfully!'
        });

    } catch (error) {
        console.error('Error archiving class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to archive class: ' + error.message
        });
    }
});

// ==================== MISSING ROUTES - NOW IMPLEMENTED ====================

// Get class overview for management page
router.get('/:classId/overview', requireTeacher, async (req, res) => {
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

        // Get class students and quiz results
        const classStudents = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        const allResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Calculate performance trend data for chart
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).sort({ generatedDate: 1 }).lean();

        const performanceTrend = quizzes.map(quiz => {
            const quizResults = allResults.filter(result =>
                result.quizId.toString() === quiz._id.toString()
            );

            const averageScore = quizResults.length > 0
                ? quizResults.reduce((sum, result) => sum + result.percentage, 0) / quizResults.length
                : 0;

            return {
                quizTitle: quiz.lectureTitle,
                score: formatPercentage(averageScore),
                attempts: quizResults.length,
                date: quiz.generatedDate
            };
        });

        // Calculate student performance map
        const studentPerformance = {};
        allResults.forEach(result => {
            const studentId = result.studentId.toString();
            if (!studentPerformance[studentId]) {
                studentPerformance[studentId] = {
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformance[studentId].scores.push(result.percentage);
            studentPerformance[studentId].totalQuizzes++;
        });

        // Calculate top performers with proper formatting
        const topPerformers = Object.values(studentPerformance)
            .map(student => ({
                studentName: student.studentName,
                averageScore: formatPercentage(student.scores.reduce((a, b) => a + b, 0) / student.scores.length),
                totalQuizzes: student.totalQuizzes
            }))
            .sort((a, b) => b.averageScore - a.averageScore)
            .slice(0, 5);

        // Get recent activity
        const recentActivity = allResults
            .sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate))
            .slice(0, 10)
            .map(result => ({
                studentName: result.studentName,
                score: formatPercentage(result.percentage),
                submissionDate: result.submissionDate.toLocaleDateString(),
                timeTaken: formatTime(result.timeTakenSeconds)
            }));

        console.log('Performance trend data:', performanceTrend.length, 'data points');

        res.json({
            success: true,
            classData: {
                ...classDoc,
                studentCount: classStudents.length,
                averageScore: formatPercentage(classDoc.averageScore || 0)
            },
            topPerformers: topPerformers,
            recentActivity: recentActivity,
            performanceTrend: performanceTrend
        });

    } catch (error) {
        console.error('Error fetching class overview:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class overview: ' + error.message
        });
    }
});

// Get students in a class
router.get('/:classId/students', requireTeacher, async (req, res) => {
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

        // Get students enrolled in this class
        const enrollments = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        console.log(`Found ${enrollments.length} active enrollments`);

        // Get quiz results for performance stats
        const studentsWithStats = await Promise.all(
            enrollments.map(async (enrollment) => {
                const studentResults = await quizResultCollection.find({
                    studentId: enrollment.studentId,
                    classId: classId
                }).lean();

                const totalQuizzes = studentResults.length;
                const averageScore = totalQuizzes > 0
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
                    : 0;

                const lastActivity = totalQuizzes > 0
                    ? studentResults[studentResults.length - 1].submissionDate
                    : enrollment.enrolledAt;

                return {
                    studentId: enrollment.studentId,
                    studentName: enrollment.studentName,
                    studentEnrollment: enrollment.studentEnrollment,
                    enrolledAt: enrollment.enrolledAt,
                    totalQuizzes: totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    lastActivity: lastActivity,
                    participationRate: totalQuizzes > 0 ? 100 : 0
                };
            })
        );

        console.log(`Students loaded with stats: ${studentsWithStats.length}`);

        res.json({
            success: true,
            students: studentsWithStats,
            totalStudents: studentsWithStats.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students: ' + error.message
        });
    }
});

// Add student to class
router.post('/:classId/students', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { enrollmentNumber } = req.body;

        if (!enrollmentNumber) {
            return res.status(400).json({
                success: false,
                message: 'Student enrollment number is required.'
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

        // Find student by enrollment number
        const student = await studentCollection.findOne({
            enrollment: enrollmentNumber.trim()
        });

        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student not found with this enrollment number.'
            });
        }

        // Check for ANY existing enrollment (active or inactive)
        const existingEnrollment = await classStudentCollection.findOne({
            classId: classId,
            studentId: student._id
        });

        if (existingEnrollment) {
            if (existingEnrollment.isActive) {
                return res.status(400).json({
                    success: false,
                    message: 'Student is already enrolled in this class.'
                });
            } else {
                // Reactivate enrollment instead of creating new one
                await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                    isActive: true,
                    enrolledAt: new Date(),
                    studentName: student.name,
                    studentEnrollment: student.enrollment
                });
                console.log('Student enrollment reactivated');
            }
        } else {
            // Create new enrollment
            const newEnrollment = await classStudentCollection.create({
                classId: classId,
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment
            });
            console.log('New student enrollment created:', newEnrollment._id);
        }

        // Update class student count
        const totalActiveStudents = await classStudentCollection.countDocuments({
            classId: classId,
            isActive: true
        });

        await classCollection.findByIdAndUpdate(classId, {
            studentCount: totalActiveStudents,
            updatedAt: new Date()
        });

        console.log(`Student ${student.name} (${student.enrollment}) added to class ${classDoc.name}`);

        res.json({
            success: true,
            message: `Student ${student.name} added to class successfully!`,
            student: {
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment,
                enrolledAt: new Date(),
                totalQuizzes: 0,
                averageScore: 0,
                lastActivity: new Date(),
                participationRate: 0
            }
        });

    } catch (error) {
        console.error('Error adding student to class:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add student: ' + error.message
        });
    }
});

// Get detailed class analytics
router.get('/:classId/analytics', requireTeacher, async (req, res) => {
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

        // Get all quiz results for this class
        const allResults = await quizResultCollection.find({
            classId: classId
        }).lean();

        // Get class quizzes
        const classQuizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        // Calculate detailed analytics with proper formatting
        const analytics = {
            totalParticipants: new Set(allResults.map(r => r.studentId.toString())).size,
            totalQuizAttempts: allResults.length,
            classAverage: allResults.length > 0
                ? formatPercentage(allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length)
                : 0,
            highestScore: allResults.length > 0
                ? formatPercentage(Math.max(...allResults.map(r => r.percentage)))
                : 0,
            lowestScore: allResults.length > 0
                ? formatPercentage(Math.min(...allResults.map(r => r.percentage)))
                : 0,

            // Performance distribution
            performanceDistribution: {
                excellent: allResults.filter(r => r.percentage >= 90).length,
                good: allResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                average: allResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                needsImprovement: allResults.filter(r => r.percentage < 50).length
            },

            // Quiz performance breakdown with proper formatting
            quizPerformance: classQuizzes.map(quiz => {
                const quizResults = allResults.filter(r => r.quizId.toString() === quiz._id.toString());
                return {
                    quizId: quiz._id,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0
                        ? formatPercentage(quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length)
                        : 0,
                    highestScore: quizResults.length > 0
                        ? formatPercentage(Math.max(...quizResults.map(r => r.percentage)))
                        : 0,
                    lowestScore: quizResults.length > 0
                        ? formatPercentage(Math.min(...quizResults.map(r => r.percentage)))
                        : 0
                };
            })
        };

        res.json({
            success: true,
            analytics: analytics
        });

    } catch (error) {
        console.error('Error fetching class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class analytics: ' + error.message
        });
    }
});

// ==================== MISSING ROUTE - LAST QUIZ RANKINGS ====================

// Get last quiz rankings for class - THIS WAS MISSING!
router.get('/:classId/last-quiz-rankings', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('Loading last quiz rankings for class:', classId);

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

        // Find the most recently taken quiz by students
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
            .sort((a, b) => b.points - a.points)
            .map((student, index) => ({
                ...student,
                rank: index + 1
            }));

        console.log(`✅ Last quiz rankings loaded: ${quiz.lectureTitle} with ${rankings.length} participants`);

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

// ==================== CLASS RANKINGS ROUTE ====================

// Get class rankings - FIXED: This was being called as /api/classes/:classId/rankings
router.get('/:classId/rankings', requireTeacher, async (req, res) => {
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

// Get join requests for a class - NEW ROUTE
router.get('/:classId/join-requests', requireTeacher, async (req, res) => {
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

        // Get join requests for this class
        const joinRequests = await classJoinRequestCollection.find({
            classId: classId
        }).sort({ requestedAt: -1 }).lean();

        const formattedRequests = joinRequests.map(request => ({
            _id: request._id,
            studentName: request.studentName,
            studentEnrollment: request.studentEnrollment,
            status: request.status,
            requestedAt: request.requestedAt,
            processedAt: request.processedAt,
            rejectionReason: request.rejectionReason
        }));

        console.log(`Found ${formattedRequests.length} join requests for class ${classDoc.name}`);

        res.json({
            success: true,
            joinRequests: formattedRequests,
            totalRequests: formattedRequests.length,
            pendingRequests: formattedRequests.filter(r => r.status === 'pending').length
        });

    } catch (error) {
        console.error('Error fetching join requests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch join requests: ' + error.message
        });
    }
});

// Get class quizzes - NEW ROUTE
router.get('/:classId/quizzes', requireAuth, async (req, res) => {
    try {
        const classId = req.params.classId;
        const userId = req.session.userId;
        const userType = req.session.userType;

        // Verify access to class
        if (userType === 'teacher') {
            const classDoc = await classCollection.findOne({
                _id: classId,
                teacherId: userId,
                isActive: true
            });

            if (!classDoc) {
                return res.status(404).json({
                    success: false,
                    message: 'Class not found or access denied.'
                });
            }
        } else if (userType === 'student') {
            const enrollment = await classStudentCollection.findOne({
                studentId: userId,
                classId: classId,
                isActive: true
            });

            if (!enrollment) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You are not enrolled in this class.'
                });
            }
        }

        // Get quizzes for this class
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).sort({ generatedDate: -1 }).lean();

        const formattedQuizzes = quizzes.map(quiz => ({
            _id: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.totalQuestions,
            durationMinutes: quiz.durationMinutes,
            generatedDate: quiz.generatedDate,
            isExamMode: quiz.isExamMode || false,
            examStatus: quiz.examStatus
        }));

        console.log(`Found ${formattedQuizzes.length} quizzes for class`);

        res.json({
            success: true,
            quizzes: formattedQuizzes,
            totalQuizzes: formattedQuizzes.length
        });

    } catch (error) {
        console.error('Error fetching class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quizzes: ' + error.message
        });
    }
});

// ==================== JOIN CODE MANAGEMENT APIs ====================

// Generate join code for class (teacher only)
router.post('/:classId/generate-join-code', requireTeacher, async (req, res) => {
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

        console.log('✅ Join code generated:', {
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
router.get('/:classId/active-join-code', requireTeacher, async (req, res) => {
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
router.get('/validate-join-code/:code', requireStudent, async (req, res) => {
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

        console.log('✅ Join code validated successfully:', {
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
router.post('/join-request', requireStudent, async (req, res) => {
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

        // Check for existing enrollment and handle reactivation
        const existingClassStudentEntry = await classStudentCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingClassStudentEntry) {
            if (existingClassStudentEntry.isActive) {
                return res.status(400).json({
                    success: false,
                    message: 'You are already enrolled in this class.'
                });
            } else {
                // Reactivate inactive enrollment
                await classStudentCollection.findByIdAndUpdate(existingClassStudentEntry._id, {
                    isActive: true,
                    enrolledAt: new Date(),
                    studentName: studentName,
                    studentEnrollment: student.enrollment
                });

                // Update join requests to approved
                await classJoinRequestCollection.updateMany(
                    { classId: codeDoc.classId, studentId: studentId, status: { $in: ['pending', 'rejected'] } },
                    { status: 'approved', processedAt: new Date() }
                );

                // Increment usage count
                await classJoinCodeCollection.findByIdAndUpdate(codeDoc._id, { $inc: { usageCount: 1 } });

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

        // Check for existing join requests
        const existingJoinRequest = await classJoinRequestCollection.findOne({
            classId: codeDoc.classId,
            studentId: studentId
        });

        if (existingJoinRequest) {
            if (existingJoinRequest.status === 'pending') {
                return res.status(400).json({
                    success: false,
                    message: 'You already have a pending request for this class. Please wait for the teacher\'s approval.'
                });
            } else if (existingJoinRequest.status === 'rejected') {
                // Delete previous rejected request to allow new one
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
        await classJoinCodeCollection.findByIdAndUpdate(codeDoc._id, { $inc: { usageCount: 1 } });

        console.log('✅ New join request created:', {
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

module.exports = router;