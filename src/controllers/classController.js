// controllers/classController.js
const crypto = require('crypto');
const { 
    classCollection,
    classStudentCollection,
    classJoinCodeCollection,
    classJoinRequestCollection,
    studentCollection,
    quizCollection,
    quizResultCollection
} = require('../mongodb');

// Helper functions
const formatPercentage = (value, decimals = 1) => {
    const num = parseFloat(value) || 0;
    return parseFloat(num.toFixed(decimals));
};

const formatTime = (seconds) => {
    if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else {
        return `${minutes}m ${secs}s`;
    }
};

const calculateTimeEfficiency = (timeTakenSeconds, quizDurationSeconds) => {
    if (!timeTakenSeconds || !quizDurationSeconds || quizDurationSeconds <= 0) return 0;
    const timeRatio = timeTakenSeconds / quizDurationSeconds;
    if (timeRatio <= 0.5) {
        return 100;
    } else if (timeRatio <= 1.0) {
        return Math.round(100 - (timeRatio - 0.5) * 80);
    } else {
        return Math.max(10, Math.round(60 - (timeRatio - 1.0) * 50));
    }
};

const calculateRankingPoints = (averageScore, timeEfficiency) => {
    const score = parseFloat(averageScore) || 0;
    const efficiency = parseFloat(timeEfficiency) || 0;
    return parseFloat((score * 0.7 + efficiency * 0.3).toFixed(1));
};

const calculateParticipationWeightedPoints = (averageScore, timeEfficiency, participationRate) => {
    const basePoints = calculateRankingPoints(averageScore, timeEfficiency);
    const participationMultiplier = 0.3 + (0.7 * (participationRate / 100));
    const finalPoints = basePoints * participationMultiplier;
    return parseFloat(finalPoints.toFixed(1));
};

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

class ClassController {
    // Get all classes for a teacher
    static getTeacherClasses = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

            const teacherId = req.session.userId;

            const classes = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            })
                .sort({ createdAt: -1 })
                .lean();

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
                totalClasses: formattedClasses.length
            });

        } catch (error) {
            console.error('Error fetching classes:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch classes: ' + error.message
            });
        }
    };

    // Create new class
    static createClass = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

            const { name, subject, description } = req.body;
            const teacherId = req.session.userId;
            const teacherName = req.session.userName;

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
    };

    // Get specific class details
    static getClassDetails = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Update class information
    static updateClass = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Archive/Delete class
    static deleteClass = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Add student to class
    static addStudentToClass = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. Teachers only.'
                });
            }

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
    };

    // Get students in a class
    static getClassStudents = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Remove student from class
    static removeStudentFromClass = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Get class overview for management page
    static getClassOverview = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Get detailed class analytics
    static getClassAnalytics = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Get teacher-specific class rankings with participation weighting
    static getClassRankings = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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
    };

    // Get last quiz rankings for class
    static getLastQuizRankings = async (req, res) => {
        try {
            if (req.session.userType !== 'teacher') {
                return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
            }

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

            console.log(`Last quiz rankings loaded: ${quiz.lectureTitle} with ${rankings.length} participants`);

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
    };
}

module.exports = ClassController;