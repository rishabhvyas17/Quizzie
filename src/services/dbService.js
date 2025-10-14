// services/dbService.js
const {
    studentCollection,
    teacherCollection,
    lectureCollection,
    quizCollection,
    quizResultCollection,
    explanationCacheCollection,
    classCollection,
    classStudentCollection,
    classJoinCodeCollection,
    classJoinRequestCollection
} = require('../mongodb');

class DatabaseService {
    constructor() {
        this.collections = {
            student: studentCollection,
            teacher: teacherCollection,
            lecture: lectureCollection,
            quiz: quizCollection,
            quizResult: quizResultCollection,
            explanationCache: explanationCacheCollection,
            class: classCollection,
            classStudent: classStudentCollection,
            classJoinCode: classJoinCodeCollection,
            classJoinRequest: classJoinRequestCollection
        };
    }

    // ==================== USER OPERATIONS ====================

    /**
     * Find user by email (student or teacher)
     */
    async findUserByEmail(email) {
        try {
            let user = await studentCollection.findOne({ email: email });
            if (user) {
                return { user, type: 'student' };
            }

            user = await teacherCollection.findOne({ email: email });
            if (user) {
                return { user, type: 'teacher' };
            }

            return null;
        } catch (error) {
            console.error('Error finding user by email:', error);
            throw error;
        }
    }

    /**
     * Find student by enrollment number
     */
    async findStudentByEnrollment(enrollment) {
        try {
            return await studentCollection.findOne({ 
                enrollment: enrollment.toUpperCase() 
            });
        } catch (error) {
            console.error('Error finding student by enrollment:', error);
            throw error;
        }
    }

    /**
     * Create new user (student or teacher)
     */
    async createUser(userData, userType) {
        try {
            const collection = userType === 'student' ? studentCollection : teacherCollection;
            const newUser = await collection.create(userData);
            return newUser;
        } catch (error) {
            console.error('Error creating user:', error);
            throw error;
        }
    }

    // ==================== CLASS OPERATIONS ====================

    /**
     * Get teacher's classes with statistics
     */
    async getTeacherClasses(teacherId) {
        try {
            const classes = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).sort({ createdAt: -1 }).lean();

            // Enhance with detailed statistics
            const enhancedClasses = await Promise.all(
                classes.map(async (cls) => {
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
                        ...cls,
                        studentCount,
                        lectureCount,
                        quizCount,
                        averageScore: parseFloat(classAverageScore.toFixed(1))
                    };
                })
            );

            return enhancedClasses;
        } catch (error) {
            console.error('Error getting teacher classes:', error);
            throw error;
        }
    }

    /**
     * Get student's enrolled classes
     */
    async getStudentClasses(studentId) {
        try {
            const enrollments = await classStudentCollection.find({
                studentId: studentId,
                isActive: true
            }).lean();

            if (enrollments.length === 0) {
                return [];
            }

            const classIds = enrollments.map(e => e.classId);
            const classes = await classCollection.find({
                _id: { $in: classIds },
                isActive: true
            }).lean();

            // Enhance with student performance data
            const enhancedClasses = await Promise.all(
                classes.map(async (cls) => {
                    const enrollment = enrollments.find(e => 
                        e.classId.toString() === cls._id.toString()
                    );

                    // Get student's performance in this class
                    const studentResults = await quizResultCollection.find({
                        studentId: studentId,
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
                        ...cls,
                        enrolledAt: enrollment.enrolledAt,
                        quizzesTaken,
                        averageScore: parseFloat(averageScore.toFixed(1)),
                        availableQuizzes,
                        completionRate: availableQuizzes > 0 ? 
                            parseFloat(((quizzesTaken / availableQuizzes) * 100).toFixed(1)) : 0
                    };
                })
            );

            return enhancedClasses;
        } catch (error) {
            console.error('Error getting student classes:', error);
            throw error;
        }
    }

    /**
     * Check if student is enrolled in class
     */
    async isStudentEnrolled(studentId, classId) {
        try {
            const enrollment = await classStudentCollection.findOne({
                studentId: studentId,
                classId: classId,
                isActive: true
            });
            return !!enrollment;
        } catch (error) {
            console.error('Error checking student enrollment:', error);
            throw error;
        }
    }

    // ==================== QUIZ OPERATIONS ====================

    /**
     * Get available quizzes for student
     */
    async getAvailableQuizzes(studentId, classId = null) {
        try {
            let enrolledClassIds = [];

            if (classId) {
                // Check specific class enrollment
                const isEnrolled = await this.isStudentEnrolled(studentId, classId);
                if (!isEnrolled) {
                    return [];
                }
                enrolledClassIds = [classId];
            } else {
                // Get all enrolled classes
                const enrollments = await classStudentCollection.find({
                    studentId: studentId,
                    isActive: true
                }).lean();
                enrolledClassIds = enrollments.map(e => e.classId);
            }

            if (enrolledClassIds.length === 0) {
                return [];
            }

            // Get available quizzes from enrolled classes
            const availableQuizzes = await quizCollection.find({
                classId: { $in: enrolledClassIds },
                isActive: true
            }).sort({ generatedDate: -1 }).lean();

            // Get quizzes already taken by student
            const takenQuizIds = await quizResultCollection.find({
                studentId: studentId
            }).distinct('quizId');

            // Filter out taken quizzes and add class information
            const quizzesWithClassInfo = await Promise.all(
                availableQuizzes
                    .filter(quiz => !takenQuizIds.includes(quiz._id.toString()))
                    .map(async (quiz) => {
                        const classInfo = await classCollection.findById(quiz.classId)
                            .select('name subject').lean();
                        return {
                            ...quiz,
                            className: classInfo ? classInfo.name : 'Unknown Class',
                            classSubject: classInfo ? classInfo.subject : 'Unknown Subject'
                        };
                    })
            );

            return quizzesWithClassInfo;
        } catch (error) {
            console.error('Error getting available quizzes:', error);
            throw error;
        }
    }

    /**
     * Get quiz results with rankings
     */
    async getQuizResults(quizId, options = {}) {
        try {
            const {
                includeRankings = false,
                classId = null,
                studentId = null
            } = options;

            let query = { quizId: quizId };
            if (classId) query.classId = classId;
            if (studentId) query.studentId = studentId;

            const results = await quizResultCollection.find(query)
                .sort({ percentage: -1, timeTakenSeconds: 1 })
                .lean();

            if (includeRankings && results.length > 0) {
                return results.map((result, index) => ({
                    ...result,
                    rank: index + 1
                }));
            }

            return results;
        } catch (error) {
            console.error('Error getting quiz results:', error);
            throw error;
        }
    }

    /**
     * Calculate class rankings with participation weighting
     */
    async calculateClassRankings(classId) {
        try {
            const classStudents = await classStudentCollection.find({
                classId: classId,
                isActive: true
            }).lean();

            const classQuizzes = await quizCollection.find({
                classId: classId,
                isActive: true
            }).lean();

            const totalQuizzesAvailable = classQuizzes.length;

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
                            finalPoints: 0,
                            rank: 999
                        };
                    }

                    const averageScore = studentResults.reduce((sum, r) => sum + r.percentage, 0) / studentResults.length;

                    // Calculate time efficiency
                    const timeEfficiencies = studentResults.map(result => {
                        const quiz = classQuizzes.find(q => q._id.toString() === result.quizId.toString());
                        const quizDurationSeconds = quiz ? (quiz.durationMinutes || 15) * 60 : 900;
                        return this.calculateTimeEfficiency(result.timeTakenSeconds, quizDurationSeconds);
                    });

                    const averageTimeEfficiency = timeEfficiencies.length > 0
                        ? timeEfficiencies.reduce((sum, eff) => sum + eff, 0) / timeEfficiencies.length
                        : 0;

                    const participationRate = totalQuizzesAvailable > 0
                        ? (studentResults.length / totalQuizzesAvailable) * 100
                        : 0;

                    const finalPoints = this.calculateParticipationWeightedPoints(
                        averageScore, 
                        averageTimeEfficiency, 
                        participationRate
                    );

                    return {
                        studentId: student.studentId,
                        studentName: student.studentName,
                        totalQuizzes: studentResults.length,
                        averageScore: parseFloat(averageScore.toFixed(1)),
                        averageTimeEfficiency: parseFloat(averageTimeEfficiency.toFixed(1)),
                        participationRate: parseFloat(participationRate.toFixed(1)),
                        finalPoints: finalPoints
                    };
                })
            );

            // Sort by final points and assign ranks
            const rankedStudents = studentRankings
                .filter(student => student.totalQuizzes > 0)
                .sort((a, b) => b.finalPoints - a.finalPoints)
                .map((student, index) => ({
                    ...student,
                    rank: index + 1
                }));

            return rankedStudents;
        } catch (error) {
            console.error('Error calculating class rankings:', error);
            throw error;
        }
    }

    // ==================== ANALYTICS OPERATIONS ====================

    /**
     * Get teacher analytics data
     */
    async getTeacherAnalytics(teacherId) {
        try {
            const teacherClasses = await classCollection.find({
                teacherId: teacherId,
                isActive: true
            }).lean();

            if (teacherClasses.length === 0) {
                return this.getEmptyAnalyticsData();
            }

            const classIds = teacherClasses.map(c => c._id);

            const [allResults, allQuizzes] = await Promise.all([
                quizResultCollection.find({ classId: { $in: classIds } }).lean(),
                quizCollection.find({ classId: { $in: classIds }, isActive: true }).lean()
            ]);

            if (allResults.length === 0) {
                return this.getEmptyAnalyticsData();
            }

            // Calculate overall statistics
            const totalScore = allResults.reduce((sum, r) => sum + r.percentage, 0);
            const averageScore = parseFloat((totalScore / allResults.length).toFixed(1));

            // Performance distribution by quiz
            const performanceDistribution = this.calculatePerformanceDistribution(allResults, allQuizzes);

            // Student performance and rankings
            const studentPerformance = this.calculateStudentPerformance(allResults);
            const rankedStudents = this.rankStudentsByPerformance(studentPerformance);

            return {
                overallStats: {
                    totalStudents: Object.keys(studentPerformance).length,
                    totalQuizzes: allQuizzes.length,
                    classAverage: averageScore,
                    totalResults: allResults.length
                },
                performanceDistribution: performanceDistribution,
                rankedStudents: rankedStudents,
                topPerformers: rankedStudents.slice(0, 5)
            };

        } catch (error) {
            console.error('Error getting teacher analytics:', error);
            throw error;
        }
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Calculate time efficiency
     */
    calculateTimeEfficiency(timeTakenSeconds, quizDurationSeconds) {
        if (!timeTakenSeconds || !quizDurationSeconds || quizDurationSeconds <= 0) return 0;

        const timeRatio = timeTakenSeconds / quizDurationSeconds;

        if (timeRatio <= 0.5) {
            return 100;
        } else if (timeRatio <= 1.0) {
            return Math.round(100 - (timeRatio - 0.5) * 80);
        } else {
            return Math.max(10, Math.round(60 - (timeRatio - 1.0) * 50));
        }
    }

    /**
     * Calculate participation-weighted points
     */
    calculateParticipationWeightedPoints(averageScore, timeEfficiency, participationRate) {
        const basePoints = (parseFloat(averageScore) * 0.7) + (parseFloat(timeEfficiency) * 0.3);
        const participationMultiplier = 0.3 + (0.7 * (participationRate / 100));
        return parseFloat((basePoints * participationMultiplier).toFixed(1));
    }

    /**
     * Calculate performance distribution
     */
    calculatePerformanceDistribution(results, quizzes) {
        const quizMap = {};
        quizzes.forEach(quiz => {
            quizMap[quiz._id.toString()] = quiz;
        });

        const distribution = [];
        const quizPerformanceMap = {};

        results.forEach(result => {
            const quizId = result.quizId.toString();
            if (!quizPerformanceMap[quizId]) {
                quizPerformanceMap[quizId] = [];
            }
            quizPerformanceMap[quizId].push(result.percentage);
        });

        Object.keys(quizPerformanceMap).forEach(quizId => {
            const quiz = quizMap[quizId];
            const scores = quizPerformanceMap[quizId];

            if (quiz && scores.length > 0) {
                const avgScore = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));

                distribution.push({
                    quizId: quizId,
                    quizTitle: quiz.lectureTitle,
                    totalAttempts: scores.length,
                    averageScore: avgScore,
                    highestScore: parseFloat(Math.max(...scores).toFixed(1)),
                    lowestScore: parseFloat(Math.min(...scores).toFixed(1))
                });
            }
        });

        return distribution;
    }

    /**
     * Calculate student performance metrics
     */
    calculateStudentPerformance(results) {
        const studentPerformance = {};
        
        results.forEach(result => {
            const studentId = result.studentId.toString();
            if (!studentPerformance[studentId]) {
                studentPerformance[studentId] = {
                    studentId: studentId,
                    studentName: result.studentName,
                    totalScore: 0,
                    quizCount: 0,
                    totalTime: 0
                };
            }
            studentPerformance[studentId].totalScore += result.percentage;
            studentPerformance[studentId].quizCount++;
            studentPerformance[studentId].totalTime += result.timeTakenSeconds;
        });

        return studentPerformance;
    }

    /**
     * Rank students by performance
     */
    rankStudentsByPerformance(studentPerformance) {
        return Object.values(studentPerformance)
            .map(student => ({
                ...student,
                averageScore: student.quizCount > 0 ? 
                    parseFloat((student.totalScore / student.quizCount).toFixed(1)) : 0,
                averageTime: student.quizCount > 0 ? 
                    Math.round(student.totalTime / student.quizCount) : 0
            }))
            .sort((a, b) => b.averageScore - a.averageScore)
            .map((student, index) => ({ ...student, rank: index + 1 }));
    }

    /**
     * Get empty analytics data structure
     */
    getEmptyAnalyticsData() {
        return {
            overallStats: {
                totalStudents: 0,
                totalQuizzes: 0,
                classAverage: 0,
                totalResults: 0
            },
            performanceDistribution: [],
            rankedStudents: [],
            topPerformers: []
        };
    }

    /**
     * Generic cleanup method for old records
     */
    async cleanupOldRecords(collection, dateField, daysOld) {
        try {
            const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
            const result = await collection.deleteMany({
                [dateField]: { $lt: cutoffDate }
            });
            
            console.log(`Cleaned up ${result.deletedCount} old records from ${collection.modelName}`);
            return result.deletedCount;
        } catch (error) {
            console.error(`Error cleaning up old records from ${collection.modelName}:`, error);
            throw error;
        }
    }
}

// Export singleton instance
const dbService = new DatabaseService();
module.exports = dbService;