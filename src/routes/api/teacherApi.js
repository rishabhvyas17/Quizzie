// routes/api/teacherApi.js
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

// Middleware to ensure teacher access
const requireTeacher = requireRole('teacher');

// ==================== CLASS MANAGEMENT APIs ====================

// Get all classes for a teacher
router.get('/classes', requireTeacher, async (req, res) => {
    try {
        const teacherId = req.session.userId;

        // Get teacher's classes with computed stats
        const classes = await classCollection.find({
            teacherId: teacherId,
            isActive: true
        })
            .sort({ createdAt: -1 })
            .lean();

        console.log(`Found ${classes.length} classes for teacher ${req.session.userName}`);

        // Format classes for response
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
            totalClasses: formattedClasses.length
        });

    } catch (error) {
        console.error('Error fetching classes:', error);
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

        console.log(`New class created: ${newClass.name} by ${teacherName}`);

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

        console.log(`Class archived: ${existingClass.name}`);

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

// ==================== STUDENT MANAGEMENT APIs ====================

// Add student to class
router.post('/classes/:classId/students', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;
        const { enrollmentNumber } = req.body;

        console.log('Add student request:', {
            userType: req.session.userType,
            userId: req.session.userId,
            userName: req.session.userName,
            classId: classId,
            enrollmentNumber: enrollmentNumber
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
            console.log('Class not found or access denied:', {
                classId,
                teacherId
            });
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('Class verified:', classDoc.name);

        // Find student by enrollment number
        const student = await studentCollection.findOne({
            enrollment: enrollmentNumber.trim()
        });

        if (!student) {
            console.log('Student not found:', enrollmentNumber);
            return res.status(404).json({
                success: false,
                message: 'Student not found with this enrollment number.'
            });
        }

        console.log('Student found:', student.name);

        // Check for ANY existing enrollment (active or inactive)
        const existingEnrollment = await classStudentCollection.findOne({
            classId: classId,
            studentId: student._id
        });

        if (existingEnrollment) {
            console.log('Existing enrollment found:', {
                isActive: existingEnrollment.isActive,
                enrollmentId: existingEnrollment._id
            });

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

// Get students in a class
router.get('/classes/:classId/students', requireTeacher, async (req, res) => {
    try {
        const classId = req.params.classId;
        const teacherId = req.session.userId;

        console.log('Loading students for class:', {
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
            console.log('Class not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Class not found or access denied.'
            });
        }

        console.log('Class verified:', classDoc.name);

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

        console.log(`Student ${enrollment.studentName} removed from class ${classDoc.name}`);

        res.json({
            success: true,
            message: 'Student removed from class successfully!'
        });

    } catch (error) {
        console.error('Error removing student from class:', error);
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

        console.log('Performance trend data:', performanceTrend.length, 'data points');

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
        console.error('Error fetching class overview:', error);
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
        console.error('Error fetching class analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch class analytics: ' + error.message
        });
    }
});

module.exports = router;