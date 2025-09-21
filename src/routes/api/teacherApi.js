// routes/api/teacherApi.js - FIXED VERSION WITH MISSING ROUTES
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../../middleware/authMiddleware');
const { upload, validateUploadedFile, cleanupTempFile } = require('../../middleware/uploadMiddleware');
const { validateClass, validateQuizGeneration } = require('../../middleware/validationMiddleware');

// Import database collections
const {
    teacherCollection,
    studentCollection,
    classCollection,
    classStudentCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    classJoinCodeCollection,
    classJoinRequestCollection
} = require('../../mongodb');

// Import utility functions
const { formatPercentage, calculateTimeEfficiency, calculateRankingPoints, calculateParticipationWeightedPoints, formatTime, getTimeAgo } = require('../../utils/helpers');

// Middleware to ensure teacher access
const requireTeacher = requireRole('teacher');

// ==================== CLASS MANAGEMENT APIs ====================

// Get all classes for a teacher
router.get('/classes', requireTeacher, async (req, res) => {
    try {
        const teacherId = req.session.userId;

        console.log('Teacher classes API accessed:', {
            teacherId: teacherId,
            teacherName: req.session.userName
        });

        // Get teacher's classes with computed stats
        const classes = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        }).sort({ createdAt: -1 }).lean();

        console.log(`Found ${classes.length} classes for teacher ${req.session.userName}`);

        // Calculate detailed statistics for each class
        const enhancedClasses = await Promise.all(
            classes.map(async (cls) => {
                // Get counts in parallel for better performance
                const [studentCount, lectureCount, quizCount] = await Promise.all([
                    classStudentCollection.countDocuments({ 
                        classId: cls._id, 
                        isActive: true 
                    }),
                    lectureCollection.countDocuments({ classId: cls._id }),
                    quizCollection.countDocuments({ classId: cls._id, isActive: true })
                ]);

                // Get class average score
                const quizResults = await quizResultCollection.find({ classId: cls._id }).lean();
                const classAverageScore = quizResults.length > 0 
                    ? (quizResults.reduce((sum, result) => sum + result.percentage, 0) / quizResults.length)
                    : 0;

                return {
                    id: cls._id,
                    name: cls.name,
                    subject: cls.subject,
                    description: cls.description,
                    studentCount: studentCount,
                    lectureCount: lectureCount,
                    quizCount: quizCount,
                    averageScore: parseFloat(classAverageScore.toFixed(1)),
                    createdAt: cls.createdAt,
                    updatedAt: cls.updatedAt,
                    createdDate: cls.createdAt ? cls.createdAt.toLocaleDateString() : 'N/A'
                };
            })
        );

        res.json({
            success: true,
            classes: enhancedClasses,
            totalClasses: enhancedClasses.length,
            totalStudents: enhancedClasses.reduce((sum, cls) => sum + cls.studentCount, 0),
            totalLectures: enhancedClasses.reduce((sum, cls) => sum + cls.lectureCount, 0),
            totalQuizzes: enhancedClasses.reduce((sum, cls) => sum + cls.quizCount, 0)
        });

    } catch (error) {
        console.error('Error fetching teacher classes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch classes: ' + error.message
        });
    }
});

// Create new class
router.post('/classes', requireTeacher, validateClass, async (req, res) => {
    try {
        const { name, subject, description } = req.body;
        const teacherId = req.session.userId;
        const teacherName = req.session.userName;

        console.log('Creating new class via teacher API:', {
            name: name,
            subject: subject,
            teacherId: teacherId,
            teacherName: teacherName
        });

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

        console.log(`✅ New class created via teacher API: ${newClass.name} by ${teacherName}`);

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
        console.error('Error creating class via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create class: ' + error.message
        });
    }
});

// Get specific class details
router.get('/classes/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        const classDoc = await classCollection.findOne({
            _id: classId,
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (!classDoc) {
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        // Get detailed statistics
        const [studentCount, lectureCount, quizCount] = await Promise.all([
            classStudentCollection.countDocuments({ 
                classId: classId, 
                isActive: true 
            }),
            lectureCollection.countDocuments({ classId: classId }),
            quizCollection.countDocuments({ classId: classId, isActive: true })
        ]);

        res.json({
            success: true,
            class: {
                id: classDoc._id,
                name: classDoc.name,
                subject: classDoc.subject,
                description: classDoc.description,
                studentCount: studentCount,
                lectureCount: lectureCount,
                quizCount: quizCount,
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

// Update class information
router.put('/classes/:classId', requireTeacher, validateClass, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { name, subject, description } = req.body;

        // Check if class exists and belongs to teacher
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

        // Update class
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

        console.log(`✅ Class updated: ${updatedClass.name}`);

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
router.delete('/classes/:classId', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        // Check if class exists and belongs to teacher
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

// ==================== MISSING ROUTES - FIXED ====================

// Get class rankings - FIXED: This was being called as /api/teacher/class/:classId/rankings
router.get('/class/:classId/rankings', requireTeacher, async (req, res) => {
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

        console.log(`Teacher API - Participation-weighted rankings generated: ${rankedStudents.length} students`);

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
        console.error('Error generating teacher API rankings:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate rankings: ' + error.message
        });
    }
});

// Get class quizzes - FIXED: This was being called as /api/teacher/class/:classId/quizzes
router.get('/class/:classId/quizzes', requireTeacher, async (req, res) => {
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

        // Get quizzes for this class
        const quizzes = await quizCollection.find({
            classId: classId,
            isActive: true
        }).sort({ generatedDate: -1 }).lean();

        // Get quiz results for each quiz to calculate statistics
        const quizzesWithStats = await Promise.all(
            quizzes.map(async (quiz) => {
                const quizResults = await quizResultCollection.find({
                    quizId: quiz._id
                }).lean();

                const totalAttempts = quizResults.length;
                const averageScore = totalAttempts > 0
                    ? formatPercentage(quizResults.reduce((sum, result) => sum + result.percentage, 0) / totalAttempts)
                    : 0;
                const highestScore = totalAttempts > 0
                    ? formatPercentage(Math.max(...quizResults.map(result => result.percentage)))
                    : 0;

                return {
                    _id: quiz._id,
                    lectureId: quiz.lectureId,
                    lectureTitle: quiz.lectureTitle,
                    totalQuestions: quiz.totalQuestions,
                    durationMinutes: quiz.durationMinutes,
                    generatedDate: quiz.generatedDate,
                    isExamMode: quiz.isExamMode || false,
                    examStatus: quiz.examStatus,
                    // Statistics
                    totalAttempts: totalAttempts,
                    averageScore: averageScore,
                    highestScore: highestScore
                };
            })
        );

        console.log(`Found ${quizzesWithStats.length} quizzes for teacher class ${classDoc.name}`);

        res.json({
            success: true,
            quizzes: quizzesWithStats,
            totalQuizzes: quizzesWithStats.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('Error fetching teacher class quizzes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch quizzes: ' + error.message
        });
    }
});

// ==================== STUDENT MANAGEMENT APIs ====================

// Add student to class
router.post('/classes/:classId/students', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { enrollmentNumber } = req.body;

        console.log('Add student request via teacher API:', {
            classId: classId,
            enrollmentNumber: enrollmentNumber,
            teacherId: teacherId,
            teacherName: req.session.userName
        });

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
            enrollment: enrollmentNumber.trim().toUpperCase()
        });

        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student not found with this enrollment number.'
            });
        }

        // Check for existing enrollment (active or inactive)
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
                // Reactivate enrollment
                await classStudentCollection.findByIdAndUpdate(existingEnrollment._id, {
                    isActive: true,
                    enrolledAt: new Date(),
                    studentName: student.name,
                    studentEnrollment: student.enrollment
                });
                console.log('✅ Student enrollment reactivated');
            }
        } else {
            // Create new enrollment
            await classStudentCollection.create({
                classId: classId,
                studentId: student._id,
                studentName: student.name,
                studentEnrollment: student.enrollment
            });
            console.log('✅ New student enrollment created');
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

        console.log(`✅ Student ${student.name} (${student.enrollment}) added to class ${classDoc.name}`);

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
        console.error('Error adding student to class via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add student: ' + error.message
        });
    }
});

// Get students in a class
router.get('/classes/:classId/students', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('Loading students for class via teacher API:', {
            classId: classId,
            teacherId: teacherId,
            requestedBy: req.session.userName
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

        // Get students enrolled in this class
        const enrollments = await classStudentCollection.find({
            classId: classId,
            isActive: true
        }).lean();

        console.log(`Found ${enrollments.length} active enrollments`);

        // Get quiz results for performance stats
        const studentsWithStats = await Promise.all(
            enrollments.map(async (enrollment) => {
                // Get student's quiz results for this class
                const studentResults = await quizResultCollection.find({
                    studentId: enrollment.studentId,
                    classId: classId
                }).lean();

                const totalQuizzes = studentResults.length;
                const averageScore = totalQuizzes > 0
                    ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes)
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
                    averageScore: parseFloat(averageScore.toFixed(1)),
                    lastActivity: lastActivity,
                    participationRate: totalQuizzes > 0 ? 100 : 0
                };
            })
        );

        console.log(`✅ Students loaded with stats: ${studentsWithStats.length}`);

        res.json({
            success: true,
            students: studentsWithStats,
            totalStudents: studentsWithStats.length,
            className: classDoc.name
        });

    } catch (error) {
        console.error('Error fetching students via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students: ' + error.message
        });
    }
});

// Remove student from class
router.delete('/classes/:classId/students/:studentId', requireTeacher, async (req, res) => {
    try {
        const { classId, studentId } = req.params;
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

        // Find and remove enrollment
        const enrollment = await classStudentCollection.findOneAndUpdate(
            {
                classId: classId,
                studentId: studentId,
                isActive: true
            },
            {
                isActive: false
            },
            { new: true }
        );

        if (!enrollment) {
            return res.status(404).json({
                success: false,
                message: 'Student not found in this class.'
            });
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

        console.log(`✅ Student ${enrollment.studentName} removed from class ${classDoc.name}`);

        res.json({
            success: true,
            message: 'Student removed from class successfully!'
        });

    } catch (error) {
        console.error('Error removing student from class via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to remove student: ' + error.message
        });
    }
});

// ==================== CLASS ANALYTICS APIs ====================

// Get class overview for management page
router.get('/classes/:classId/overview', requireTeacher, async (req, res) => {
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
                score: parseFloat(averageScore.toFixed(1)),
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

        // Calculate top performers
        const topPerformers = Object.values(studentPerformance)
            .map(student => ({
                studentName: student.studentName,
                averageScore: parseFloat((student.scores.reduce((a, b) => a + b, 0) / student.scores.length).toFixed(1)),
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
                score: parseFloat(result.percentage.toFixed(1)),
                submissionDate: result.submissionDate.toLocaleDateString(),
                timeTaken: Math.floor(result.timeTakenSeconds / 60) + 'm ' + (result.timeTakenSeconds % 60) + 's'
            }));

        console.log('✅ Performance trend data:', performanceTrend.length, 'data points');

        res.json({
            success: true,
            classData: {
                ...classDoc,
                studentCount: classStudents.length,
                averageScore: parseFloat((classDoc.averageScore || 0).toFixed(1))
            },
            topPerformers: topPerformers,
            recentActivity: recentActivity,
            performanceTrend: performanceTrend
        });

    } catch (error) {
        console.error('Error fetching class overview via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class overview: ' + error.message
        });
    }
});

// Get detailed class analytics
router.get('/classes/:classId/analytics', requireTeacher, async (req, res) => {
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

        // Calculate detailed analytics
        const analytics = {
            totalParticipants: new Set(allResults.map(r => r.studentId.toString())).size,
            totalQuizAttempts: allResults.length,
            classAverage: allResults.length > 0
                ? parseFloat((allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length).toFixed(1))
                : 0,
            highestScore: allResults.length > 0
                ? parseFloat(Math.max(...allResults.map(r => r.percentage)).toFixed(1))
                : 0,
            lowestScore: allResults.length > 0
                ? parseFloat(Math.min(...allResults.map(r => r.percentage)).toFixed(1))
                : 0,

            // Performance distribution
            performanceDistribution: {
                excellent: allResults.filter(r => r.percentage >= 90).length,
                good: allResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                average: allResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                needsImprovement: allResults.filter(r => r.percentage < 50).length
            },

            // Quiz performance breakdown
            quizPerformance: classQuizzes.map(quiz => {
                const quizResults = allResults.filter(r => r.quizId.toString() === quiz._id.toString());
                return {
                    quizId: quiz._id,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: quizResults.length,
                    averageScore: quizResults.length > 0
                        ? parseFloat((quizResults.reduce((sum, r) => sum + r.percentage, 0) / quizResults.length).toFixed(1))
                        : 0,
                    highestScore: quizResults.length > 0
                        ? parseFloat(Math.max(...quizResults.map(r => r.percentage)).toFixed(1))
                        : 0,
                    lowestScore: quizResults.length > 0
                        ? parseFloat(Math.min(...quizResults.map(r => r.percentage)).toFixed(1))
                        : 0
                };
            })
        };

        res.json({
            success: true,
            analytics: analytics
        });

    } catch (error) {
        console.error('Error fetching class analytics via teacher API:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class analytics: ' + error.message
        });
    }
});

// ==================== DASHBOARD STATS API ====================

// Get teacher dashboard statistics
router.get('/dashboard-stats', requireTeacher, async (req, res) => {
    try {
        const teacherId = req.session.userId;

        console.log('Fetching dashboard stats for teacher:', req.session.userName);

        // Get all teacher's classes
        const classes = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        }).lean();

        if (classes.length === 0) {
            return res.json({
                success: true,
                stats: {
                    totalClasses: 0,
                    totalStudents: 0,
                    totalLectures: 0,
                    totalQuizzes: 0,
                    overallAverage: 0
                },
                recentActivity: [],
                topPerformingClasses: []
            });
        }

        const classIds = classes.map(c => c._id);

        // Get overall statistics
        const [
            totalStudents,
            totalLectures,
            totalQuizzes,
            allResults
        ] = await Promise.all([
            classStudentCollection.countDocuments({ 
                classId: { $in: classIds }, 
                isActive: true 
            }),
            lectureCollection.countDocuments({ 
                classId: { $in: classIds } 
            }),
            quizCollection.countDocuments({ 
                classId: { $in: classIds }, 
                isActive: true 
            }),
            quizResultCollection.find({ 
                classId: { $in: classIds } 
            }).lean()
        ]);

        const overallAverage = allResults.length > 0
            ? parseFloat((allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length).toFixed(1))
            : 0;

        // Get recent activity (last 10 quiz submissions)
        const recentActivity = allResults
            .sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate))
            .slice(0, 10)
            .map(result => ({
                studentName: result.studentName,
                score: parseFloat(result.percentage.toFixed(1)),
                submissionDate: result.submissionDate.toLocaleDateString(),
                className: classes.find(c => c._id.toString() === result.classId.toString())?.name || 'Unknown Class'
            }));

        // Get top performing classes
        const classPerformance = classes.map(cls => {
            const classResults = allResults.filter(r => r.classId.toString() === cls._id.toString());
            const classAverage = classResults.length > 0
                ? classResults.reduce((sum, r) => sum + r.percentage, 0) / classResults.length
                : 0;

            return {
                className: cls.name,
                averageScore: parseFloat(classAverage.toFixed(1)),
                totalResults: classResults.length,
                studentCount: cls.studentCount || 0
            };
        }).sort((a, b) => b.averageScore - a.averageScore).slice(0, 5);

        res.json({
            success: true,
            stats: {
                totalClasses: classes.length,
                totalStudents: totalStudents,
                totalLectures: totalLectures,
                totalQuizzes: totalQuizzes,
                overallAverage: overallAverage
            },
            recentActivity: recentActivity,
            topPerformingClasses: classPerformance
        });

    } catch (error) {
        console.error('Error fetching teacher dashboard stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard stats: ' + error.message
        });
    }
});

module.exports = router;