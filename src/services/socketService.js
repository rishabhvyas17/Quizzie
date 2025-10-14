// src/services/socketService.js
class SocketService {
    constructor() {
        this.io = null;
        this.connectedUsers = new Map(); // Map socket.id to user info
        this.classRooms = new Map(); // Map classId to Set of socket.ids
        this.quizRooms = new Map(); // Map quizId to Set of socket.ids
        this.examRooms = new Map(); // Map examId to Set of socket.ids
    }

    /**
     * Initialize Socket.IO instance
     */
    initialize(io) {
        this.io = io;
        console.log('🔌 SocketService initialized');
    }

    /**
     * Add user to tracking
     */
    addUser(socketId, userInfo) {
        this.connectedUsers.set(socketId, userInfo);
        console.log(`👤 User added to tracking: ${userInfo.userName} (${socketId})`);
    }

    /**
     * Remove user from tracking
     */
    removeUser(socketId) {
        const userInfo = this.connectedUsers.get(socketId);
        if (userInfo) {
            console.log(`👤 User removed from tracking: ${userInfo.userName} (${socketId})`);
            this.connectedUsers.delete(socketId);
        }
        
        // Remove from all rooms
        this.removeFromAllRooms(socketId);
    }

    /**
     * Add user to class room
     */
    addToClassRoom(socketId, classId) {
        if (!this.classRooms.has(classId)) {
            this.classRooms.set(classId, new Set());
        }
        this.classRooms.get(classId).add(socketId);
        console.log(`📚 User ${socketId} joined class room: ${classId}`);
    }

    /**
     * Add user to quiz room
     */
    addToQuizRoom(socketId, quizId) {
        if (!this.quizRooms.has(quizId)) {
            this.quizRooms.set(quizId, new Set());
        }
        this.quizRooms.get(quizId).add(socketId);
        console.log(`📝 User ${socketId} joined quiz room: ${quizId}`);
    }

    /**
     * Add user to exam room
     */
    addToExamRoom(socketId, examId) {
        if (!this.examRooms.has(examId)) {
            this.examRooms.set(examId, new Set());
        }
        this.examRooms.get(examId).add(socketId);
        console.log(`🎓 User ${socketId} joined exam room: ${examId}`);
    }

    /**
     * Remove user from all rooms
     */
    removeFromAllRooms(socketId) {
        // Remove from class rooms
        for (const [classId, sockets] of this.classRooms.entries()) {
            if (sockets.has(socketId)) {
                sockets.delete(socketId);
                if (sockets.size === 0) {
                    this.classRooms.delete(classId);
                }
            }
        }

        // Remove from quiz rooms
        for (const [quizId, sockets] of this.quizRooms.entries()) {
            if (sockets.has(socketId)) {
                sockets.delete(socketId);
                if (sockets.size === 0) {
                    this.quizRooms.delete(quizId);
                }
            }
        }

        // Remove from exam rooms
        for (const [examId, sockets] of this.examRooms.entries()) {
            if (sockets.has(socketId)) {
                sockets.delete(socketId);
                if (sockets.size === 0) {
                    this.examRooms.delete(examId);
                }
            }
        }
    }

    /**
     * Broadcast to class members
     */
    broadcastToClass(classId, event, data) {
        if (this.io) {
            this.io.to(`class-${classId}`).emit(event, {
                ...data,
                timestamp: new Date(),
                classId: classId
            });
            console.log(`📡 Broadcasted '${event}' to class ${classId}`);
        }
    }

    /**
     * Broadcast to quiz participants
     */
    broadcastToQuiz(quizId, event, data) {
        if (this.io) {
            this.io.to(`quiz-${quizId}`).emit(event, {
                ...data,
                timestamp: new Date(),
                quizId: quizId
            });
            console.log(`📡 Broadcasted '${event}' to quiz ${quizId}`);
        }
    }

    /**
     * Broadcast to exam participants
     */
    broadcastToExam(examId, event, data) {
        if (this.io) {
            this.io.to(`exam-${examId}`).emit(event, {
                ...data,
                timestamp: new Date(),
                examId: examId
            });
            console.log(`📡 Broadcasted '${event}' to exam ${examId}`);
        }
    }

    /**
     * Broadcast quiz submission to class
     */
    broadcastQuizSubmission(classId, submissionData) {
        this.broadcastToClass(classId, 'quiz-submission', {
            type: 'new_submission',
            studentName: submissionData.studentName,
            score: submissionData.score,
            percentage: submissionData.percentage,
            quizTitle: submissionData.quizTitle,
            timeTaken: submissionData.timeTaken
        });
    }

    /**
     * Broadcast rankings update
     */
    broadcastRankingsUpdate(classId, rankings) {
        this.broadcastToClass(classId, 'rankings-updated', {
            type: 'rankings_update',
            rankings: rankings,
            totalStudents: rankings.length
        });
    }

    /**
     * Broadcast exam timer sync
     */
    broadcastExamTimerSync(examId, timeRemaining) {
        this.broadcastToExam(examId, 'timer-sync', {
            type: 'timer_sync',
            timeRemaining: timeRemaining,
            formatted: this.formatTime(timeRemaining)
        });
    }

    /**
     * Broadcast exam control (start/pause/end)
     */
    broadcastExamControl(examId, action, data = {}) {
        this.broadcastToExam(examId, 'exam-control', {
            type: 'exam_control',
            action: action,
            ...data
        });
    }

    /**
     * Send notification to specific user
     */
    sendToUser(socketId, event, data) {
        if (this.io) {
            this.io.to(socketId).emit(event, {
                ...data,
                timestamp: new Date()
            });
            console.log(`📬 Sent '${event}' to user ${socketId}`);
        }
    }

    /**
     * Get connected users count
     */
    getConnectedUsersCount() {
        return this.connectedUsers.size;
    }

    /**
     * Get users in class room
     */
    getClassRoomUsers(classId) {
        const sockets = this.classRooms.get(classId);
        if (!sockets) return [];

        return Array.from(sockets).map(socketId => {
            return this.connectedUsers.get(socketId);
        }).filter(Boolean);
    }

    /**
     * Get users in quiz room
     */
    getQuizRoomUsers(quizId) {
        const sockets = this.quizRooms.get(quizId);
        if (!sockets) return [];

        return Array.from(sockets).map(socketId => {
            return this.connectedUsers.get(socketId);
        }).filter(Boolean);
    }

    /**
     * Get users in exam room
     */
    getExamRoomUsers(examId) {
        const sockets = this.examRooms.get(examId);
        if (!sockets) return [];

        return Array.from(sockets).map(socketId => {
            return this.connectedUsers.get(socketId);
        }).filter(Boolean);
    }

    /**
     * Get statistics
     */
    getStatistics() {
        return {
            connectedUsers: this.connectedUsers.size,
            activeClassRooms: this.classRooms.size,
            activeQuizRooms: this.quizRooms.size,
            activeExamRooms: this.examRooms.size,
            totalRooms: this.classRooms.size + this.quizRooms.size + this.examRooms.size
        };
    }

    /**
     * Format time for display
     */
    formatTime(seconds) {
        if (seconds <= 0) return '00:00:00';
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }

    /**
     * Handle real-time class updates
     */
    handleClassUpdate(classId, updateType, data) {
        switch (updateType) {
            case 'student_joined':
                this.broadcastToClass(classId, 'class-update', {
                    type: 'student_joined',
                    studentName: data.studentName,
                    message: `${data.studentName} joined the class`
                });
                break;

            case 'quiz_created':
                this.broadcastToClass(classId, 'class-update', {
                    type: 'quiz_created',
                    quizTitle: data.quizTitle,
                    message: `New quiz available: ${data.quizTitle}`
                });
                break;

            case 'assignment_posted':
                this.broadcastToClass(classId, 'class-update', {
                    type: 'assignment_posted',
                    title: data.title,
                    message: `New assignment posted: ${data.title}`
                });
                break;

            default:
                this.broadcastToClass(classId, 'class-update', {
                    type: updateType,
                    ...data
                });
        }
    }

    /**
     * Handle real-time quiz events
     */
    handleQuizEvent(quizId, eventType, data) {
        switch (eventType) {
            case 'student_joined':
                this.broadcastToQuiz(quizId, 'quiz-event', {
                    type: 'student_joined',
                    studentName: data.studentName,
                    participantCount: data.participantCount
                });
                break;

            case 'submission_received':
                this.broadcastToQuiz(quizId, 'quiz-event', {
                    type: 'submission_received',
                    studentName: data.studentName,
                    score: data.score,
                    totalSubmissions: data.totalSubmissions
                });
                break;

            case 'quiz_ended':
                this.broadcastToQuiz(quizId, 'quiz-event', {
                    type: 'quiz_ended',
                    message: 'Quiz has ended',
                    results: data.results
                });
                break;

            default:
                this.broadcastToQuiz(quizId, 'quiz-event', {
                    type: eventType,
                    ...data
                });
        }
    }
}

// Export singleton instance
const socketService = new SocketService();
module.exports = socketService;